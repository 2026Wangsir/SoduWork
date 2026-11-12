'use strict';

const { accountId, fetchWithDeviceAuthRetry } = require('./device-auth-request');
const { scopeOf } = require('./native-discovery.cjs');
const DOMAINS = {
  'conversation-projects': { path: '/conversation-projects', legacyMs: 10000, valid: value => Array.isArray(value?.items) },
  models: { path: '/my-models', legacyMs: 0, valid: value => Array.isArray(value?.usable) && Array.isArray(value?.providers) },
  config: { path: '/config', legacyMs: 0, valid: value => value && typeof value === 'object' && !Array.isArray(value) },
  'team-messages-received': { path: '/team/messages?folder=received&limit=200', topic: 'team-messages', requirePush: true, revalidate: true,
    legacyMs: 0, valid: value => Array.isArray(value?.items) },
  'team-messages-sent': { path: '/team/messages?folder=sent&limit=200', topic: 'team-messages', requirePush: true, revalidate: true,
    legacyMs: 0, valid: value => Array.isArray(value?.items) },
};
const SAME_SCOPE = '当前账号或设备已切换，请重新打开后再操作';
function actor(identity) {
  return { hub: String(identity?.hub || '').replace(/\/+$/, ''),
    clientId: String(identity?.clientId || ''), userId: accountId(identity) };
}
function matches(expected, identity) {
  const value = actor(identity);
  return Boolean(expected && value.userId && value.hub === expected.hub &&
    value.clientId === expected.clientId && value.userId === expected.userId);
}
function stale() { return Object.assign(Error(SAME_SCOPE), { code: 'STALE_TASK_SCOPE' }); }

// One authoritative HTTP snapshot per domain and signed account/device scope.
// Existing renderer stores retain local edits, dismissal markers and folders.
function create({ identityOf, fetch = fetchWithDeviceAuthRetry, discovery = require('./native-discovery.cjs'),
  changed = () => {}, now = Date.now, setTimeout: later = setTimeout, clearTimeout: cancel = clearTimeout,
  reconcileMs = 120000, idleMs = 300000 } = {}) {
  const entries = new Map(), notifications = new Map(), subscriptions = [];
  let currentScope = '', closed = false;
  async function capture(expected) {
    const identity = await identityOf();
    if (closed || !matches(expected, identity)) throw stale();
    const scope = scopeOf(identity);
    if (scope !== currentScope) {
      for (const entry of entries.values()) if (entry.timer) cancel(entry.timer);
      for (const timer of notifications.values()) cancel(timer);
      notifications.clear();
      entries.clear(); currentScope = scope;
    }
    return { identity, scope, expected: actor(identity) };
  }
  async function guard(captured) {
    const identity = await identityOf();
    if (closed || captured.scope !== currentScope || captured.scope !== scopeOf(identity) || !matches(captured.expected, identity)) throw stale();
    return identity;
  }
  function notify(domain, captured) {
    if (notifications.has(domain)) return;
    const timer = later(() => {
      notifications.delete(domain);
      guard(captured).then(() => changed(domain, captured.expected)).catch(() => {});
    }, 50);
    timer?.unref?.(); notifications.set(domain, timer);
  }
  function schedule(domain, entry, captured) {
    if (closed || entries.get(domain) !== entry) return;
    const backedOff = entry.errorUntil > now(), dirty = entry.loadedVersion !== entry.version;
    const delay = backedOff ? entry.errorUntil - now() : dirty ? 1000 : reconcileMs;
    if (entry.timer && (entry.due === now() + delay || !backedOff && dirty && entry.due < now() + delay)) return;
    if (entry.timer) cancel(entry.timer);
    entry.due = now() + delay;
    entry.timer = later(async () => {
      entry.timer = null;
      if (closed || now() - entry.usedAt > idleMs) return;
      try {
        const identity = await guard(captured);
        if (DOMAINS[domain].requirePush && !discovery.confirmed(identity, DOMAINS[domain].topic || domain)) return;
        await load(domain, entry, captured);
      } catch (_) { /* A failed read leaves the last snapshot invalid for the next caller. */ }
      schedule(domain, entry, captured);
    }, delay);
    entry.timer?.unref?.();
  }
  async function load(domain, entry, captured) {
    if (entry.running) return entry.running;
    if (entry.error && entry.errorUntil > now()) throw entry.error;
    const work = (async () => {
      let value, version, reads = 0;
      do {
        reads++;
        const identity = await guard(captured);
        version = entry.version;
        let response;
        try { response = await fetch(identity, captured.expected.hub + '/api/v1' + DOMAINS[domain].path,
          { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15000) }); }
        catch (error) { error.networkOnline = false; throw error; }
        let raw;
        try { raw = await response.text(); } catch (error) { error.networkOnline = true; throw error; }
        let body;
        try { body = raw ? JSON.parse(raw) : null; }
        catch (_) { if (response.ok) throw Object.assign(Error('后台返回格式无效'), {code: 'BAD_JSON', status: 0, networkOnline: true}); }
        await guard(captured);
        if (!response.ok) throw Object.assign(Error('HTTP ' + response.status),
          { status: response.status, httpBody: body, networkOnline: true });
        if (!DOMAINS[domain].valid(body)) throw Object.assign(Error('同步目录返回无效'), {networkOnline: true});
        value = body;
        // A push or successful local write during the request requires a trailing read.
      } while (version !== entry.version && reads < 2);
      // Inbox revisions include authorization/receipt changes and periodic
      // preview-ticket renewal. A newly signed URL alone must not cause a
      // changed -> explicit read -> freshly signed URL refresh loop.
      const revisioned = DOMAINS[domain].revalidate &&
        typeof entry.value?.revision === 'string' && entry.value.revision.trim().length > 0 &&
        typeof value?.revision === 'string' && value.revision.trim().length > 0;
      const different = entry.value !== undefined && (revisioned
        ? entry.value.revision !== value.revision
        : JSON.stringify(entry.value) !== JSON.stringify(value));
      entry.value = value; entry.at = now(); entry.loadedVersion = version;
      entry.error = null; entry.errorUntil = 0; entry.failures = 0;
      // Continuous invalidations must not starve the waiting UI or produce a
      // tight HTTP loop. Retain the dirty generation for a bounded retry.
      entry.retryAt = version !== entry.version ? now() + 1000 : 0;
      if (different) notify(domain, captured);
      return value;
    })();
    entry.running = work;
    try { return await work; }
    catch (error) {
      entry.error = error; entry.failures = (entry.failures || 0) + 1;
      entry.errorUntil = now() + Math.min(60000, 5000 * 2 ** Math.min(entry.failures - 1, 4));
      if ([401, 403].includes(error.status)) entry.value = undefined;
      throw error;
    }
    finally { if (entry.running === work) entry.running = null; schedule(domain, entry, captured); }
  }
  async function read(domain, expected, report = () => {}) {
    if (!Object.hasOwn(DOMAINS, domain)) throw Error('不支持的同步目录');
    const captured = await capture(expected);
    const confirmed = discovery.confirmed(captured.identity, DOMAINS[domain].topic || domain);
    if (DOMAINS[domain].requirePush && !confirmed) throw Object.assign(Error('Use legacy polling'), {code: 'DOMAIN_POLL_FALLBACK'});
    let entry = entries.get(domain);
    if (!entry) { entry = { version: 0, loadedVersion: -1, usedAt: now(), at: 0, timer: null, running: null }; entries.set(domain, entry); }
    entry.usedAt = now();
    if (entry.error && entry.errorUntil > now()) throw entry.error;
    const ttl = confirmed ? reconcileMs : DOMAINS[domain].legacyMs;
    // Inbox authorization can change without an account/device change or push.
    // Revalidate explicit message reads before their revision is used to prune
    // company-scoped notices; keep shared in-flight reads and bounded backoff.
    const cached = entry.value !== undefined && (entry.retryAt > now() ||
      !DOMAINS[domain].revalidate && entry.loadedVersion === entry.version && now() - entry.at < ttl);
    try {
      const value = cached ? entry.value : await load(domain, entry, captured);
      await guard(captured);
      if (!cached) report(true);
      return structuredClone(value);
    } catch (error) {
      await guard(captured);
      if (typeof error.networkOnline === 'boolean') report(error.networkOnline);
      throw error;
    }
  }
  async function invalidate(domain, expected) {
    if (!Object.hasOwn(DOMAINS, domain)) return;
    const captured = await capture(expected), entry = entries.get(domain);
    if (entry) { entry.version++; schedule(domain, entry, captured); }
    notify(domain, captured);
  }
  for (const topic of new Set(Object.entries(DOMAINS).map(([domain, value]) => value.topic || domain))) subscriptions.push(discovery.register(topic, () => {
    Promise.resolve(identityOf()).then(identity => {
      if (closed || !accountId(identity) || scopeOf(identity) !== currentScope) return;
      return Promise.all(Object.entries(DOMAINS).filter(([domain, value]) => (value.topic || domain) === topic)
        .map(([domain]) => invalidate(domain, actor(identity))));
    }).catch(() => {});
  }));
  return { read, invalidate, close() {
    closed = true;
    for (const off of subscriptions) off();
    for (const entry of entries.values()) if (entry.timer) cancel(entry.timer);
    for (const timer of notifications.values()) cancel(timer);
    entries.clear();
  } };
}

function install({ app, ipcMain, webContents, deviceAuth, modelsChanged = () => {} }) {
  const { isTrusted } = require('./access-control/preferences');
  const cache = create({ identityOf: () => deviceAuth.authenticatedIdentity(app), changed(domain, scope) {
    if (domain === 'models') modelsChanged();
    for (const sender of webContents.getAllWebContents()) {
      try { if (isTrusted({ sender, senderFrame: sender.mainFrame })) sender.send('client-domain-changed', { domain, scope }); } catch (_) {}
    }
  } });
  for (const action of ['read', 'invalidate']) ipcMain.handle('client-domain-' + action, async (event, domain, expected) => {
    if (!isTrusted(event)) return { ok: false, reason: '不允许的读取来源' };
    let online;
    try { const value = await cache[action](domain, expected, value => { online = value; }); return { ok: true, value, online }; }
    catch (error) { return { ok: false, reason: error.message, status: error.status, code: error.code, body: error.httpBody, online }; }
  });
  app.once('will-quit', () => cache.close());
  return cache;
}
module.exports = { create, install, actor, matches };
