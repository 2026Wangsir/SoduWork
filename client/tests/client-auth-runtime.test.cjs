'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('./renderer-source.cjs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(
  path.resolve(__dirname, '..', 'api.js'),
  'utf8',
);

function runtime(loginResult) {
  const requests = [];
  const values = new Map([
    ['soduwork_work_hub_environment_v1', 'production'],
    ['soduwork_work_user_id', 'client-auth-runtime'],
  ]);
  const events = [], listeners = new Map();
  let cleared = 0, blockedNotice = false;
  let quotaExceeded;
  let quotaChanged, serverQuota = loginResult.quota, requestOverride;
  const localStorage = {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
  class CustomEvent {
    constructor(type, options) {
      this.type = type;
      this.detail = options && options.detail;
    }
  }
  const window = {
    SoduWorkQuotaNotice: { isBlocked: () => blockedNotice },
    soduWorkAPI: {
      onDeviceAuthQuotaExceeded(callback) { quotaExceeded = callback; },
      onDeviceAuthQuotaChanged(callback) { quotaChanged = callback; },
      async deviceAuthLogin() { return loginResult; },
      async deviceAuthClearSession() { cleared += 1; return { ok: true }; },
      async configureRunner() { return { ok: true }; },
      async getAppVersion() { return 'test'; },
      async getSysInfo() {
        return { username: 'employee', hostname: 'workstation',
          platform: 'win32', arch: 'x64' };
      },
    },
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(handler);
    },
    dispatchEvent(event) {
      events.push(event);
      for (const handler of listeners.get(event.type) || []) handler(event);
    },
  };
  const context = {
    window,
    localStorage,
    CustomEvent,
    URL,
    AbortController,
    setTimeout,
    clearTimeout,
    console,
    fetch: async (url, options) => {
      requests.push({ url, options });
      return requestOverride ? requestOverride(url, options) : new Response(JSON.stringify({ user: loginResult.user, quota: serverQuota }));
    },
  };
  vm.runInNewContext(source, context);
  return {
    api: window.SoduWorkAPI,
    emit: (type, detail) => window.dispatchEvent(new CustomEvent(type, { detail })),
    loadQuotaNotice() {
      window.SoduWorkQuota = require('../core/token-quota');
      window.ClientAuth = { updateIdentity: (user, quota) => window.SoduWorkQuotaNotice.update({ user, quota }) };
      vm.runInContext(fs.readFileSync(path.join(__dirname, '../components/client-auth/quota-notice.js'), 'utf8'), context);
      window.addEventListener('soduwork-device-auth', event => window.SoduWorkQuotaNotice.update(event.detail));
      return window.SoduWorkQuotaNotice;
    },
    events,
    requests,
    cleared: () => cleared,
    noticeBlocked: value => { blockedNotice = value; },
    exceed: detail => quotaExceeded(detail),
    changed: detail => quotaChanged(detail),
    quota: value => { serverQuota = value; },
    request: callback => { requestOverride = callback; },
    login: value => { loginResult = value; serverQuota = value.quota; },
  };
}

test('failed login requests the client auth gate without a scope error', async () => {
  const harness = runtime({
    ok: false,
    status: 401,
    code: 'ACCOUNT_OR_PASSWORD_INVALID',
    error: 'invalid account',
  });
  const result = await harness.api.clientLogin({
    account: 'employee',
    password: 'wrong password',
  });

  assert.equal(result.ok, false);
  assert.equal(harness.cleared(), 1);
  assert.equal(harness.events.at(-1).type, 'soduwork-client-auth-required');
  assert.equal(
    harness.events.at(-1).detail.code,
    'ACCOUNT_OR_PASSWORD_INVALID',
  );
});

test('quota exhaustion clears the short session and exposes quota state', async () => {
  const quota = { enabled: true, limit: 100, used: 100, exceeded: true };
  const harness = runtime({
    ok: false,
    status: 403,
    code: 'TOKEN_QUOTA_EXCEEDED',
    error: 'quota exhausted',
    quota,
  });
  const result = await harness.api.clientLogin({
    account: 'employee',
    password: 'password',
  });

  assert.equal(result.ok, false);
  assert.equal(harness.api.clientAuthSnapshot().state, 'quota');
  assert.equal(harness.api.clientAuthSnapshot().quota.used, 100);
  assert.equal(harness.events.at(-1).detail.state, 'quota');
});

test('successful login keeps only the short session and safe profile in renderer', async () => {
  const harness = runtime({
    ok: true,
    session: 'short-session',
    expiresIn: 1800,
    clientId: 'client-auth-runtime',
    user: { id: 'user-1', username: 'employee', displayName: 'Employee' },
    quota: { enabled: false },
  });
  const result = await harness.api.clientLogin({
    account: 'employee',
    password: 'password',
  });

  assert.equal(result.ok, true);
  assert.equal(harness.api.clientAuthSnapshot().state, 'active');
  assert.equal(harness.api.clientAuthSnapshot().user.id, 'user-1');
  assert.equal(harness.cleared(), 0);
});

test('exhaustion during an authenticated session preserves access to history', async () => {
  const harness = runtime({ ok: true, session: 'short-session', expiresIn: 1800,
    clientId: 'client-auth-runtime', user: { id: 'quota-user' }, quota: { enabled: false } });
  await harness.api.clientLogin({ account: 'employee', password: 'password' });
  harness.quota({ enabled: true, limit: 0, used: 0, exceeded: true });
  await harness.exceed({ quota: { enabled: true, limit: 0, used: 0, exceeded: true } });
  assert.equal(harness.cleared(), 0);
  assert.equal(harness.api.clientAuthSnapshot().state, 'active');
  assert.equal(harness.api.clientAuthSnapshot().quota.limit, 0);
  assert.equal(harness.events.at(-1).type, 'soduwork-device-auth');
  assert.equal(harness.events.at(-1).detail.user.id, 'quota-user');
  const count = harness.events.length;
  harness.exceed({ hub: 'http://another-local-hub', clientId: 'other-device', quota: { enabled: true, limit: 50 } });
  assert.equal(harness.events.length, count);
  assert.equal(harness.api.clientAuthSnapshot().quota.limit, 0);
});

test('successful admission refreshes restored account quota and a late denial cannot replace it', async () => {
  const old = { enabled: true, exceeded: true, limit: 100, used: 100 };
  const harness = runtime({ ok: true, session: 'short-session', expiresIn: 1800,
    clientId: 'client-auth-runtime', user: { id: 'quota-user' }, quota: old });
  await harness.api.clientLogin({ account: 'employee', password: 'password' });
  harness.quota({ ...old, exceeded: false, limit: 1000 });
  await harness.changed({ clientId: 'client-auth-runtime' });
  assert.equal(harness.api.clientAuthSnapshot().quota.exceeded, false);
  await harness.exceed({ clientId: 'client-auth-runtime', quota: old });
  assert.equal(harness.api.clientAuthSnapshot().quota.exceeded, false);
  assert.equal(harness.api.clientAuthSnapshot().quota.limit, 1000);
  assert.equal(harness.api.clientAuthSnapshot().state, 'active');
  assert.equal(harness.cleared(), 0);
});

test('personal model admission cannot mark the global platform budget restored', async () => {
  const quota = { enabled: true, exceeded: true, limit: 100, used: 100,
    quotaVersion: 2, personalModelsAllowed: true };
  const harness = runtime({ ok: true, session: 'short-session', expiresIn: 1800,
    clientId: 'client-auth-runtime', user: { id: 'quota-user' }, quota });
  await harness.api.clientLogin({ account: 'employee', password: 'password' });
  await harness.changed({ quota: { ...quota, exceeded: false }, quotaScope: 'personal' });
  assert.equal(harness.api.clientAuthSnapshot().quota.exceeded, true);
  assert.equal(harness.api.clientAuthSnapshot().quota.personalModelsAllowed, true);
  assert.equal(harness.cleared(), 0);
});

test('offline quota refresh retains the last confirmation while a real 401 still clears authentication', async () => {
  const harness = runtime({ ok: true, session: 'short-session', expiresIn: 1800,
    clientId: 'client-auth-runtime', user: { id: 'quota-user' }, quota: { enabled: true, exceeded: false } });
  await harness.api.clientLogin({ account: 'employee', password: 'password' });
  harness.request(async () => { throw Error('offline'); });
  await harness.exceed({ quota: { enabled: true, exceeded: true } });
  assert.equal(harness.api.clientAuthSnapshot().quota.exceeded, false);
  assert.equal(harness.cleared(), 0);
  harness.request(async () => new Response(JSON.stringify({ detail: { code: 'ACCOUNT_DISABLED', message: 'Account disabled' } }), { status: 401 }));
  await harness.exceed({ quota: { enabled: true, exceeded: true } });
  assert.equal(harness.api.clientAuthSnapshot().state, 'pending');
  assert.equal(harness.cleared(), 1);
});

test('a quota signal received during refresh requests the latest state before settling', async () => {
  const harness = runtime({ ok: true, session: 'short-session', expiresIn: 1800,
    clientId: 'client-auth-runtime', user: { id: 'quota-user' }, quota: { enabled: true, exceeded: true } });
  await harness.api.clientLogin({ account: 'employee', password: 'password' });
  let finish, reads = 0;
  harness.request(async () => {
    reads++;
    if (reads === 1) return new Promise(resolve => { finish = resolve; });
    return Response.json({ user: { id: 'quota-user' }, quota: { enabled: true, exceeded: false } });
  });
  const first = harness.exceed({});
  while (!finish) await new Promise(setImmediate);
  const second = harness.changed({});
  finish(Response.json({ user: { id: 'quota-user' }, quota: { enabled: true, exceeded: true } }));
  await Promise.all([first, second]);
  assert.equal(reads, 2);
  assert.equal(harness.api.clientAuthSnapshot().quota.exceeded, false);
});

test('an old account quota refresh cannot overwrite a later signed-in account', async () => {
  const harness = runtime({ ok: true, session: 'first-session', expiresIn: 1800,
    clientId: 'client-auth-runtime', user: { id: 'first-user' }, quota: { enabled: true, exceeded: true } });
  await harness.api.clientLogin({ account: 'first', password: 'password' });
  let finish;
  harness.request(async () => new Promise(resolve => { finish = resolve; }));
  const old = harness.exceed({});
  while (!finish) await new Promise(setImmediate);
  harness.login({ ok: true, session: 'next-session', expiresIn: 1800,
    clientId: 'client-auth-runtime', user: { id: 'next-user' }, quota: { enabled: true, exceeded: false, limit: 1000 } });
  await harness.api.clientLogin({ account: 'next', password: 'password' });
  finish(Response.json({ user: { id: 'first-user' }, quota: { enabled: true, exceeded: true, limit: 0 } }));
  await old;
  assert.equal(harness.api.clientAuthSnapshot().user.id, 'next-user');
  assert.equal(harness.api.clientAuthSnapshot().quota.limit, 1000);
  assert.equal(harness.api.clientAuthSnapshot().quota.exceeded, false);
  assert.equal(harness.cleared(), 0);
});

test('a new account restoration starts its own refresh and old cleanup cannot release that flight', async () => {
  const exhausted = { enabled: true, exceeded: true, limit: 10, used: 10 };
  const harness = runtime({ ok: true, session: 'first-session', expiresIn: 1800,
    clientId: 'client-auth-runtime', user: { id: 'first-user' }, quota: exhausted });
  await harness.api.clientLogin({ account: 'first', password: 'password' });
  let finishFirst, finishNext, reads = 0;
  const restored = () => Response.json({ user: { id: 'next-user' }, quota: { ...exhausted, exceeded: false, limit: 100 } });
  harness.request(async () => {
    reads++;
    if (reads === 1) return new Promise(resolve => { finishFirst = resolve; });
    if (reads === 2) return new Promise(resolve => { finishNext = resolve; });
    return restored();
  });
  const old = harness.exceed({});
  while (!finishFirst) await new Promise(setImmediate);
  harness.login({ ok: true, session: 'next-session', expiresIn: 1800,
    clientId: 'client-auth-runtime', user: { id: 'next-user' }, quota: exhausted });
  await harness.api.clientLogin({ account: 'next', password: 'password' });
  const next = harness.changed({});
  await new Promise(setImmediate);
  assert.equal(reads, 2, 'B must read its restored allowance while A is still waiting');
  finishFirst(Response.json({ user: { id: 'first-user' }, quota: exhausted }));
  await old;
  const repeat = harness.changed({});
  await new Promise(setImmediate);
  assert.equal(reads, 2, 'A cleanup must not release B and create a concurrent B refresh');
  finishNext(restored());
  await Promise.all([next, repeat]);
  assert.equal(reads, 3, 'a hint received during B refresh requests a trailing current read');
  assert.equal(harness.api.clientAuthSnapshot().user.id, 'next-user');
  assert.equal(harness.api.clientAuthSnapshot().quota.limit, 100);
  assert.equal(harness.api.clientAuthSnapshot().quota.exceeded, false);
  assert.equal(harness.cleared(), 0);
});

test('overlapping native and manual quota refreshes publish and return only the final account state', async () => {
  const old = { enabled: true, exceeded: true, planId: 'trial', limit: 10, used: 12855 };
  const restored = { enabled: true, exceeded: false, planId: 'custom', limit: 1000000000, used: 382955 };
  const harness = runtime({ ok: true, session: 'short-session', expiresIn: 1800,
    clientId: 'client-auth-runtime', user: { id: 'quota-user' }, quota: old });
  await harness.api.clientLogin({ account: 'employee', password: 'password' });
  const pending = [], before = harness.events.length;
  harness.request(() => new Promise(resolve => pending.push(resolve)));
  let returned = false;
  const first = harness.api.clientAuthMe().then(result => { returned = true; return result; });
  while (pending.length < 1) await new Promise(setImmediate);
  const signal = harness.changed({});
  const manual = harness.api.clientAuthMe();
  pending[0](Response.json({ user: { id: 'quota-user' }, quota: old }));
  while (pending.length < 2) await new Promise(setImmediate);
  assert.equal(returned, false, 'an older result must not be handed back to a renderer');
  assert.equal(harness.events.length, before, 'an older result must not be broadcast before the trailing read');
  pending[1](Response.json({ user: { id: 'quota-user' }, quota: restored }));
  const [initial, , latest] = await Promise.all([first, signal, manual]);
  assert.equal(pending.length, 2, 'concurrent callers share one trailing current read');
  for (const result of [initial, latest, harness.api.clientAuthSnapshot()]) {
    assert.equal(result.quota.exceeded, false);
    assert.equal(result.quota.planId, 'custom');
  }
  assert.equal(harness.events.length, before + 1);
});

test('a failed trailing refresh never returns the superseded quota to a caller', async () => {
  const confirmed = { enabled: true, exceeded: false, limit: 1000, used: 10 };
  const harness = runtime({ ok: true, session: 'short-session', expiresIn: 1800,
    clientId: 'client-auth-runtime', user: { id: 'quota-user' }, quota: confirmed });
  await harness.api.clientLogin({ account: 'employee', password: 'password' });
  let finish, reads = 0;
  harness.request(() => {
    if (++reads === 1) return new Promise(resolve => { finish = resolve; });
    throw Error('offline');
  });
  const first = harness.api.clientAuthMe();
  while (!finish) await new Promise(setImmediate);
  const second = harness.api.clientAuthMe();
  const settled = Promise.allSettled([first, second]);
  finish(Response.json({ user: { id: 'quota-user' }, quota: { ...confirmed, exceeded: true, limit: 10 } }));
  assert.deepEqual((await settled).map(result => result.status), ['rejected', 'rejected']);
  assert.equal(harness.api.clientAuthSnapshot().quota.limit, 1000);
  assert.equal(harness.api.clientAuthSnapshot().quota.exceeded, false);
});

test('successful admission refreshes a stale visible notice even when the API allowance is available', async () => {
  const quota = { enabled: true, exceeded: false, limit: 1000, used: 10 };
  const harness = runtime({ ok: true, session: 'short-session', expiresIn: 1800,
    clientId: 'client-auth-runtime', user: { id: 'quota-user' }, quota });
  await harness.api.clientLogin({ account: 'employee', password: 'password' });
  const before = harness.requests.length;
  harness.noticeBlocked(true);
  await harness.changed({ clientId: 'client-auth-runtime' });
  assert.equal(harness.requests.length, before + 1);
  assert.equal(harness.api.clientAuthSnapshot().quota.exceeded, false);
  await harness.changed({ hub: 'https://other-hub.example.test' });
  assert.equal(harness.requests.length, before + 1, 'an event from another Hub is ignored');
  harness.noticeBlocked(false);
  await harness.changed({ clientId: 'client-auth-runtime' });
  assert.equal(harness.requests.length, before + 1, 'normal unblocked turns do not query quota again');
});

test('a late authenticated HTTP quota error refreshes without overwriting restored state or opening login', async () => {
  const quota = { enabled: true, exceeded: false, limit: 1000, used: 10 };
  const harness = runtime({ ok: true, session: 'short-session', expiresIn: 1800,
    clientId: 'client-auth-runtime', user: { id: 'quota-user' }, quota });
  await harness.api.clientLogin({ account: 'employee', password: 'password' });
  const before = harness.events.length;
  let finish;
  harness.request(url => url.endsWith('/client-auth/me')
    ? new Promise(resolve => { finish = resolve; })
    : Response.json({ detail: { code: 'TOKEN_QUOTA_EXCEEDED', message: 'Old quota denial',
      quota: { enabled: true, exceeded: true, limit: 10, used: 10 } } }, { status: 403 }));
  await assert.rejects(harness.api.clientAccountRequest('privacy'), error => error.code === 'TOKEN_QUOTA_EXCEEDED');
  while (!finish) await new Promise(setImmediate);
  assert.equal(harness.api.clientAuthSnapshot().quota.exceeded, false);
  assert.equal(harness.events.length, before, 'the delayed denial must not publish stale account state');
  finish(Response.json({ user: { id: 'quota-user' }, quota }));
  await new Promise(setImmediate);
  assert.equal(harness.api.clientAuthSnapshot().state, 'active');
  assert.equal(harness.cleared(), 0);
  assert.equal(harness.events.at(-1).type, 'soduwork-device-auth');
});

test('a direct old account refresh rejects without returning its data to a renderer after sign-in changes', async () => {
  const harness = runtime({ ok: true, session: 'first-session', expiresIn: 1800,
    clientId: 'client-auth-runtime', user: { id: 'first-user' }, quota: { enabled: true, exceeded: true } });
  await harness.api.clientLogin({ account: 'first', password: 'password' });
  let finish;
  harness.request(() => new Promise(resolve => { finish = resolve; }));
  const old = harness.api.clientAuthMe();
  const rejected = assert.rejects(old, error => error.code === 'STALE_TASK_SCOPE');
  while (!finish) await new Promise(setImmediate);
  harness.login({ ok: true, session: 'next-session', expiresIn: 1800,
    clientId: 'client-auth-runtime', user: { id: 'next-user' }, quota: { enabled: true, exceeded: false, limit: 1000 } });
  await harness.api.clientLogin({ account: 'next', password: 'password' });
  finish(Response.json({ user: { id: 'first-user' }, quota: { enabled: true, exceeded: true, limit: 0 } }));
  await rejected;
  assert.equal(harness.api.clientAuthSnapshot().user.id, 'next-user');
  assert.equal(harness.api.clientAuthSnapshot().quota.limit, 1000);
});

for (const hint of ['domain', 'error']) test('a quota ' + hint + ' hint during a notice refresh queues a trailing authoritative read', async () => {
  const old = { enabled: true, exceeded: true, planId: 'trial', limit: 10, used: 12855 };
  const restored = { enabled: true, exceeded: false, planId: 'custom', limit: 1000000000, used: 382955 };
  const harness = runtime({ ok: true, session: 'short-session', expiresIn: 1800,
    clientId: 'client-auth-runtime', user: { id: 'quota-user' }, quota: old });
  await harness.api.clientLogin({ account: 'employee', password: 'password' });
  const notice = harness.loadQuotaNotice();
  notice.update(harness.api.clientAuthSnapshot());
  const pending = [];
  harness.request(() => new Promise(resolve => pending.push(resolve)));
  const refresh = notice.refresh();
  await new Promise(setImmediate);
  assert.equal(pending.length, 1);
  if (hint === 'domain') harness.emit('soduwork-domain-changed', { domain: 'quota' });
  else assert.equal(notice.show({ code: 'TOKEN_QUOTA_EXCEEDED', quota: old }), true);
  const confirmations = harness.events.filter(event => event.type === 'soduwork-device-auth').length;
  pending[0](Response.json({ user: { id: 'quota-user' }, quota: old }));
  await new Promise(setImmediate);
  assert.equal(pending.length, 2, 'the in-flight notice must forward the new hint to the shared API coordinator');
  assert.equal(harness.events.filter(event => event.type === 'soduwork-device-auth').length, confirmations,
    'the older response cannot be published before the requested recheck');
  pending[1](Response.json({ user: { id: 'quota-user' }, quota: restored }));
  await refresh;
  assert.equal(pending.length, 2);
  assert.equal(harness.api.clientAuthSnapshot().quota.planId, 'custom');
  assert.equal(notice.isBlocked(), false, 'the original notice refresh must finish with the restored allowance');
});
