'use strict';

const runtime = require('../platform-connections/runtime.cjs');
const crypto = require('node:crypto');

// Handles outlive renderers and short-lived API tokens. Keep their authenticated
// provenance outside the handle so a later account cannot adopt a stale ref.
function create({ app, cachedIdentity, localOwner, enrollmentIdentity } = {}) {
  const auth = require('../device-auth');
  cachedIdentity ||= () => require('../conversation/requirement-context').cachedIdentity(app);
  localOwner ||= () => auth.localOwner(app);
  enrollmentIdentity ||= () => auth.identity(app);
  const owners = new WeakMap(), quarantined = new WeakSet(), disposed = new WeakSet();
  const cleanup = new Map(), captures = new WeakMap();
  const changed = () => Error('账号或服务已变化，请在当前账号重新打开会话');
  const pending = () => Error('上一次会话仍在清理，请重启 SoduWork 后再打开会话');
  function connection(identity) {
    if (!identity?.hub || !identity?.clientId) throw changed();
    return new URL(identity.hub).origin + '|' + String(identity.clientId);
  }
  function current() {
    let identity, owner = '';
    try { identity = cachedIdentity(); owner = runtime.scope(identity); } catch (_) {}
    if (!owner) {
      try { owner = String(localOwner() || ''); } catch (_) {}
      if (!/^[a-f0-9]{32}$/.test(owner)) owner = '';
    }
    if (!identity) {
      try { identity = enrollmentIdentity(); } catch (_) {}
    }
    return { identity, owner };
  }
  function expiredOwner(identity) {
    // A stale caller token alone is never offline authority. It must also be
    // the token currently retained by auth, and name the trusted offline owner.
    try {
      const [payload, signature, extra] = String(identity.session || '').split('.');
      if (extra !== undefined || !/^[A-Za-z0-9_-]+$/.test(payload) || !/^[a-f0-9]{64}$/.test(signature)) return '';
      const decoded = Buffer.from(payload, 'base64url');
      if (decoded.toString('base64url') !== payload) return '';
      const claims = JSON.parse(decoded.toString('utf8')), now = Math.floor(Date.now() / 1000);
      if (claims.typ !== 'device' || claims.cid !== identity.clientId || typeof claims.uid !== 'string' || !claims.uid.trim() ||
          !Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp) ||
          claims.exp > now || claims.iat > now + 60 || claims.exp <= claims.iat) return '';
      return crypto.createHash('sha256').update('soduwork-account\0' + claims.uid).digest('hex').slice(0, 32);
    } catch (_) { return ''; }
  }
  function provenance(identity) {
    const environment = connection(identity);
    let owner;
    try { owner = runtime.scope(identity); }
    catch (error) {
      const active = current();
      let enrolled;
      try { enrolled = enrollmentIdentity(); } catch (_) {}
      if (!active.owner || environment !== connection(enrolled) ||
          String(identity.secret || '') !== String(enrolled.secret || '')) throw error;
      if (identity.session && (expiredOwner(identity) !== active.owner ||
          (identity.session !== active.identity?.session && identity.session !== enrolled.session))) throw error;
      owner = active.owner;
    }
    return { owner, environment, session: String(identity.session || ''), secret: String(identity.secret || '') };
  }
  function capture(identity) {
    const token = Object.freeze({});
    captures.set(token, provenance(identity));
    return token;
  }
  function capturedOwner(identity, token) {
    const saved = captures.get(token);
    if (!saved || connection(identity) !== saved.environment) throw changed();
    try { if (runtime.scope(identity) === saved.owner) return saved; }
    catch (_) { /* Offline identity must still match the captured auth evidence. */ }
    if (String(identity.session || '') !== saved.session || String(identity.secret || '') !== saved.secret) throw changed();
    return saved;
  }
  function bind(handle, identity, options = {}) {
    if (!handle || (typeof handle !== 'object' && typeof handle !== 'function')) throw changed();
    const source = options.captured ? capturedOwner(identity, options.captured) : provenance(identity);
    const owner = source.owner, previous = owners.get(handle);
    const remote = options.connection === undefined ? Boolean(previous?.connection) : options.connection === true;
    const environment = remote ? connection(identity) : '';
    const hub = options.hub || previous?.hub ? new URL(identity.hub).origin : '';
    if (disposed.has(handle) || quarantined.has(handle) || previous &&
        (previous.owner !== owner || previous.connection !== environment || previous.hub !== hub)) throw changed();
    if (!previous) owners.set(handle, Object.freeze({ owner, connection: environment, hub }));
    return handle;
  }
  function canAccess(handle) {
    if (!handle || quarantined.has(handle) || disposed.has(handle)) return false;
    const registered = owners.get(handle);
    if (!registered) return false;
    const active = current();
    if (!active.owner || active.owner !== registered.owner) return false;
    try { return (!registered.connection || registered.connection === connection(active.identity)) &&
      (!registered.hub || registered.hub === new URL(active.identity?.hub).origin); }
    catch (_) { return false; }
  }
  function assert(handle) {
    if (!canAccess(handle)) throw changed();
    return handle;
  }
  function quarantine(handle) {
    if (!handle || disposed.has(handle)) return;
    quarantined.add(handle);
    // Unknown provenance blocks opening conservatively. Registered failures
    // block only their account, leaving other accounts' owned sessions usable.
    if (!cleanup.has(handle)) cleanup.set(handle, owners.get(handle)?.owner || '');
  }
  function closed(handle, confirmed) {
    if (!handle) return;
    if (confirmed !== true) { quarantine(handle); return; }
    disposed.add(handle);
    cleanup.delete(handle);
  }
  function assertOpen(options = {}) {
    const identity = options.identity || options;
    const token = capture(identity), { owner } = captures.get(token);
    if ([...cleanup.values()].some(blocked => !blocked || blocked === owner)) throw pending();
    return token;
  }
  return { bind, capture, canAccess, assert, quarantine, closed, assertOpen,
    isQuarantined: handle => Boolean(handle && quarantined.has(handle)) };
}

module.exports = { create };
