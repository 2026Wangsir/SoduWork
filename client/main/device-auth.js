/* Long-lived SoduWork device identity.
   The renderer never receives the device key. Electron safeStorage protects it
   with the operating-system credential facility; each Hub origin has its own key. */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

let _credentials = null;
let _activeHub = '';
let _selectionVersion = 0;
const _sessions = new Map();
const _enrollments = new Map();
const _authVersions = new Map();
const _authChanges = new Map();
const DEVICE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,63}$/;
const TEXT = {
  badHub: '\u540e\u53f0\u5730\u5740\u5fc5\u987b\u662f\u4e0d\u5e26\u8def\u5f84\u7684 http:// \u6216 https:// \u5730\u5740',
  noStore: '\u7cfb\u7edf\u5b89\u5168\u5b58\u50a8\u4e0d\u53ef\u7528\uff0c\u5df2\u62d2\u7edd\u4fdd\u5b58\u8bbe\u5907\u5bc6\u94a5',
  badDevice: '\u8bbe\u5907\u6807\u8bc6\u8fd8\u6ca1\u51c6\u5907\u597d',
  writeBlocked: '这台电脑的安全管控拦截了 SoduWork 保存设备凭据。请让 IT 确认已放开 SoduWork.exe 的加密管控并重启电脑，然后重新登录',
  timeout: '\u8fde\u63a5\u8d85\u65f6',
  sessionFailed: '\u8bbe\u5907\u4f1a\u8bdd\u5efa\u7acb\u5931\u8d25',
  pending: '\u8fd9\u53f0 SoduWork \u6b63\u5728\u7b49\u5f85\u7ba1\u7406\u5458\u6fc0\u6d3b',
  noSession: '\u540e\u53f0\u6ca1\u6709\u7b7e\u53d1\u8bbe\u5907\u4f1a\u8bdd',
  changed: '账号或服务已变化，请重新打开这条对话',
};

function _file(app) { return path.join(app.getPath('userData'), 'device-auth.json'); }
function _origin(raw) {
  let url;
  try { url = new URL(String(raw || '').trim()); } catch (_) { throw new Error(TEXT.badHub); }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash ||
      (url.pathname && url.pathname !== '/')) throw new Error(TEXT.badHub);
  return url.origin;
}
function _slot(hub) { return crypto.createHash('sha256').update(hub).digest('hex').slice(0, 24); }
function _sessionSlot(hub, clientId) { return _slot(hub) + ':' + String(clientId || ''); }
function _activate(hub, previousHub) {
  if ((_activeHub || previousHub || '') !== hub) {
    _selectionVersion++;
    // Old requests keep their own completion, but cannot refill a newer cache
    // or be reused after switching back to the same environment.
    _enrollments.clear();
    _authChanges.clear();
  }
  _activeHub = hub;
}
function _generation(id) {
  const slot = _sessionSlot(id.hub, id.clientId);
  return { slot, version: _authVersions.get(slot) || 0, selection: _selectionVersion };
}
function _current(generation) {
  return generation.version === (_authVersions.get(generation.slot) || 0) &&
    generation.selection === _selectionVersion;
}
function _invalidate(id) {
  const slot = _sessionSlot(id.hub, id.clientId);
  _authVersions.set(slot, (_authVersions.get(slot) || 0) + 1);
  _sessions.delete(slot);
  _enrollments.delete(slot);
  _authChanges.delete(slot);
  return _generation(id);
}
function _changed(id) {
  return { ok: false, stored: true, hub: id.hub, clientId: id.clientId, error: TEXT.changed };
}
function _newDeviceId() { return 'soduwork-' + crypto.randomBytes(12).toString('hex'); }
function _available() {
  return !!_credentials?.available();
}
function _readDoc(app) {
  const file = _file(app);
  let unreadable = false;
  for (const candidate of [file, file + '.bak']) {
    try {
      const data = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      if (data && data.v === 1 && data.profiles &&
          (_credentials?.platform !== 'linux' || typeof data.profiles === 'object' && !Array.isArray(data.profiles))) return data;
      unreadable = true;
    } catch (error) { if (error.code !== 'ENOENT') unreadable = true; /* try the recovery copy */ }
  }
  if (unreadable && _credentials?.platform === 'linux')
    throw new Error('设备凭据文件暂时无法读取，原文件已保留，请检查文件权限或恢复备份');
  return { v: 1, profiles: {} };
}
function _replaceFile(next, file, backup) {
  /*
   * Managed Windows filesystem filters may reject same-directory rename with EXDEV. Copying
   * is a non-atomic fallback; preserve the supplied backup before overwriting existing
   * credentials.
   */
  try {
    fs.renameSync(next, file);
    return;
  } catch (error) {
    if (!error || error.code !== 'EXDEV') throw error;
  }
  if (backup) {
    try { fs.rmSync(backup, { force: true });
      if (fs.existsSync(file)) fs.copyFileSync(file, backup); } catch (_) {}
  }
  fs.copyFileSync(next, file);
  fs.rmSync(next, { force: true });
  if (backup) { try { fs.rmSync(backup, { force: true }); } catch (_) {} }
}
function _writeDoc(app, doc, suffix = '') {
  const file = _file(app) + suffix, next = file + '.next', backup = file + '.bak';
  if (_credentials?.platform === 'linux') {
    // Never overwrite a readable identity in-place when Linux persistence fails.
    const temporary = file + '.next-' + crypto.randomUUID();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    try {
      let stat;
      try { stat = fs.lstatSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new Error('Invalid credential file');
      const fd = fs.openSync(temporary, 'wx', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(doc), 'utf8'); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      fs.renameSync(temporary, file);
    } catch (_) { throw new Error('无法安全保存设备凭据，原记录已保留，请检查用户配置目录的写入权限'); }
    finally { try { fs.unlinkSync(temporary); } catch (_) {} }
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(next, JSON.stringify(doc), { encoding: 'utf8', mode: 0o600 });
  try { _replaceFile(next, file, backup); }
  catch (error) {
    /*
     * Move existing credentials to a recoverable backup before replacement so failures retain
     * a readable identity copy.
     */
    try {
      fs.rmSync(backup, { force: true });
      if (fs.existsSync(file)) _replaceFile(file, backup);
      _replaceFile(next, file);
      fs.rmSync(backup, { force: true });
    } catch (_) {
      try { if (!fs.existsSync(file) && fs.existsSync(backup)) _replaceFile(backup, file); } catch (_) {}
      try { fs.rmSync(next, { force: true }); } catch (_) {}
      /*
       * If replacement fails, preserve a backup and fall back to in-place writing; damaged
       * writes can recover from .bak.
       */
      try { fs.rmSync(backup, { force: true });
        if (fs.existsSync(file)) fs.copyFileSync(file, backup); } catch (_) {}
      try {
        fs.writeFileSync(file, JSON.stringify(doc), { encoding: 'utf8', mode: 0o600 });
        try { fs.rmSync(backup, { force: true }); } catch (_) {}
        return;
      } catch (_) {}



      throw new Error(TEXT.writeBlocked);
    }
  }
}
function _decrypt(app, row) {
  return _credentials.decrypt(_file(app), row);
}
function _recoverRow(app, hub) {
  /*
   * Restore same-environment backup records only when current safeStorage keys can decrypt
   * them. Reject ciphertext copied from incompatible data directories.
   */
  try {
    const bak = JSON.parse(fs.readFileSync(_file(app) + '.bak', 'utf8'));
    const row = bak && bak.v === 1 && bak.profiles ? bak.profiles[_slot(hub)] : null;
    if (!row || !DEVICE_ID.test(String(row.clientId || '').trim())) return null;
    return _decrypt(app, row) ? row : null;
  } catch (_) { return null; }
}
function _legacyRunner(app, hub, clientId) {
  try {
    const file = path.join(app.getPath('userData'), 'runner', 'config.json');
    const row = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
    if (_origin(row.hub) !== hub || String(row.clientId || '') !== clientId) return '';
    return String(row.secret || '').trim();
  } catch (_) { return ''; }
}
function _scrubRunner(app) {
  try {
    const file = path.join(app.getPath('userData'), 'runner', 'config.json');
    const row = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
    if (!Object.prototype.hasOwnProperty.call(row, 'secret')) return;
    delete row.secret;
    const next = file + '.next';
    fs.writeFileSync(next, JSON.stringify(row), { encoding: 'utf8', mode: 0o600 });
    try { _replaceFile(next, file); }
    catch (_) { fs.rmSync(file, { force: true }); _replaceFile(next, file); }
  } catch (_) { /* runner runtime also sanitizes its config on configure */ }
}
function _ensure(app, raw, allowLegacy = false) {
  if (!_available()) throw _credentials?.error() || new Error(TEXT.noStore);
  const hub = _origin(raw && raw.hub);
  if (!require('./hub-endpoint.cjs').accepts(app, hub)) throw new Error('此客户端使用固定的 SoduWork 服务');
  const requestedId = String(raw && raw.clientId || '').trim();
  if (requestedId && !DEVICE_ID.test(requestedId)) throw new Error(TEXT.badDevice);
  const doc = _readDoc(app), key = _slot(hub);
  let row = doc.profiles[key] || null;
  let changed = false;
  let clientId = row && String(row.clientId || '').trim();
  if (row && _credentials.platform === 'linux' &&
      (!DEVICE_ID.test(clientId) || row.hub !== hub))
    throw new Error('设备凭据记录无效，已保留原记录，请联系支持人员检查');
  const legacyKey = _credentials.legacySecret?.(row);
  if (legacyKey) {
    if (!allowLegacy) throw new Error('设备凭据需要安全升级，请重新登录；原设备身份已保留');
    // Only an explicit account flow may use plaintext-patch or native-v10
    // credentials. Re-encrypt only after the original Hub accepts the login.
    _activate(hub, doc.activeHub);
    return { hub, clientId, secret: legacyKey, pendingMigration: row.cipher };
  }
  let secret = row ? _decrypt(app, row) : '';
  if (row && !DEVICE_ID.test(clientId) && process.platform === 'darwin')
    throw new Error('设备凭据记录无效，已保留原记录，请联系支持人员检查');
  if (row && (!DEVICE_ID.test(clientId) || !secret)) {
    /*
     * Recover undecryptable credentials from a compatible backup first, then rebuild device
     * identity if necessary. Normal account login can activate the replacement pending device.
     */
    const recovered = _recoverRow(app, hub);
    if (recovered) {
      doc.profiles[key] = recovered;
      row = recovered;
      clientId = String(row.clientId || '').trim();
      secret = _decrypt(app, row);
    } else {
      delete doc.profiles[key];
      row = null;
      clientId = '';
      secret = '';
    }
    changed = true;
  }
  if (!row) {
    const legacy = String(raw && raw.legacySecret || '').trim() ||
      (requestedId ? _legacyRunner(app, hub, requestedId) : '');
    /*
     * Generate an unpredictable installation-specific device ID. Reuse legacy caller IDs only
     * with an existing device key, keeping account and device identities distinct.
     */
    clientId = legacy ? requestedId : _newDeviceId();
    if (!DEVICE_ID.test(clientId)) throw new Error(TEXT.badDevice);
    secret = legacy || crypto.randomBytes(32).toString('base64url');
    row = { hub, clientId, cipher: _credentials.encrypt(secret).toString('base64'),
      createdAt: new Date().toISOString(), ...(_credentials.platform === 'linux' ? { storage: 'electron-safe-storage' } : {}) };
    doc.profiles[key] = row;
    changed = true;
  }
  /*
   * Persist the selected Hub as a secret-free index so main-process services can resolve
   * existing identity before renderer registration after restart.
   */
  const previousHub = doc.activeHub;
  if (doc.activeHub !== hub) { doc.activeHub = hub; changed = true; }
  if (changed) _writeDoc(app, doc);
  _activate(hub, previousHub);
  _scrubRunner(app);
  return { hub, clientId, secret };
}

function _completeCredentialMigration(app, id) {
  if (_credentials.platform !== 'linux') return;
  const doc = _readDoc(app), key = _slot(id.hub), row = doc.profiles[key];
  if (!row || row.clientId !== id.clientId || row.hub !== id.hub ||
      id.pendingMigration && row.cipher !== id.pendingMigration)
    throw new Error(TEXT.changed);
  // Upgrade a matching plaintext/v10 backup first. If the primary write fails,
  // both copies still hold the same identity and the backup is already safer.
  let backup;
  try { backup = JSON.parse(fs.readFileSync(_file(app) + '.bak', 'utf8')); }
  catch (error) { if (error.code && error.code !== 'ENOENT') throw error; }
  const oldBackup = backup?.v === 1 && backup.profiles?.[key];
  let backupSecret = '';
  if (oldBackup && oldBackup.hub === id.hub && oldBackup.clientId === id.clientId) {
    // An unreadable auxiliary copy cannot invalidate the authenticated primary
    // identity. Preserve it untouched; migrate only a proven matching secret.
    try { backupSecret = _credentials.legacySecret(oldBackup); } catch (_) {}
  }
  if (backupSecret && backupSecret === id.secret) {
    backup.profiles[key] = { ...oldBackup, cipher: _credentials.encrypt(id.secret).toString('base64'), storage: 'electron-safe-storage' };
    _writeDoc(app, backup, '.bak');
  }
  if (!id.pendingMigration) return;
  const cipher = _credentials.encrypt(id.secret).toString('base64');
  doc.profiles[key] = { ...row, cipher, storage: 'electron-safe-storage' };
  doc.activeHub = id.hub;
  _writeDoc(app, doc);
}

function identity(app, hub = '', clientId = '') {
  if (!_credentials) return null;
  try {
    const fixed = require('./hub-endpoint.cjs').current(app);
    if (fixed) {
      if (hub && _origin(hub) !== fixed.hub) return null;
      hub = fixed.hub;
    }
    const doc = _readDoc(app);
    let preferred = hub ? _origin(hub) : _activeHub;
    if (!preferred && doc.activeHub) {
      try { preferred = _origin(doc.activeHub); } catch (_) { preferred = ''; }
    }
    let row = preferred ? doc.profiles[_slot(preferred)] || null : null;
    /* An explicit environment selection is a hard trust boundary. If that Hub
       has not enrolled this installation yet, report "no identity" and let the
       renderer enroll it. Falling back to the newest profile here silently sent
       chat, update and Runner traffic to a different environment. */
    if (!row && preferred) return null;
    if (!row) row = Object.values(doc.profiles).sort((a, b) =>
      String(b.createdAt || '').localeCompare(String(a.createdAt || '')))[0] || null;
    if (!row || (clientId && row.clientId !== clientId)) return null;
    // Passive startup services must not initialize native secure storage before
    // the renderer is ready when this profile has no device credential to read.
    const secret = _decrypt(app, row);
    return secret ? { hub: row.hub, clientId: row.clientId, secret } : null;
  } catch (_) { return null; }
}

function selectHub(app, rawHub) {
  if (!_available()) return { ok: false, error: _credentials?.error()?.message || TEXT.noStore };
  try {
    // hub-endpoint decides: editable local-code runs persist a new endpoint,
    // fixed installs only ever accept their own hub.
    const prepared = require('./hub-endpoint.cjs').prepare(app, rawHub);
    if (!prepared.ok) return prepared;
    const hub = _origin(prepared.hub || rawHub);
    const doc = _readDoc(app);
    const previousHub = doc.activeHub;
    if (doc.activeHub !== hub) {
      doc.activeHub = hub;
      _writeDoc(app, doc);
    }
    _activate(hub, previousHub);
    const row = doc.profiles[_slot(hub)] || null;
    return { ok: true, hub, ready: !!(row && _decrypt(app, row)) };
  } catch (error) {
    return { ok: false, error: String(error && error.message || error) };
  }
}

function _validSessionRow(app, hub = '', clientId = '') {
  const id = identity(app, hub, clientId);
  if (!id) return null;
  const row = _sessions.get(_sessionSlot(id.hub, id.clientId));
  return row && row.expiresAt > Date.now() + 15000 ? { id, row } : null;
}

function profiles(app) {
  // Expose read-only registered Hub and client identifiers without keys for same-account environment migration.
  // Use enrollment history to recognize conversation fingerprints written before Hub migration.
  try {
    const doc = _readDoc(app);
    return Object.values(doc.profiles || {})
      .map(row => ({ hub: String(row.hub || ''), clientId: String(row.clientId || '') }))
      .filter(row => row.hub && row.clientId);
  } catch (_) { return []; }
}

function _advanceOwner(app, previous, id, token) {
  // Migrate memory directories when session refresh upgrades the ownership fingerprint formula.
  const next = _localOwner(id, token);
  try {
    const old = String(previous && previous.localOwner || '');
    // These tokens were accepted from Hub and retained in the main process.
    // The old token may be expired, but migration still requires the same uid;
    // a device being rebound to another account is never a memory migration.
    const account = value => require('./device-auth-request').accountId({ ...id, session: value });
    const previousUser = account(previous && previous.token);
    if (app && old && next && old !== next && previousUser && previousUser === account(token))
      require('./conversation/local-memory').migrateAccount(app, old, next);
  } catch (_) { /* Memory migration is best effort and must not block login. */ }
  return next;
}

function session(app, hub = '', clientId = '') {
  const current = _validSessionRow(app, hub, clientId);
  return current ? current.row.token : '';
}

function _localOwner(id, token) {
  // Capture account provenance only when Hub has returned a valid session.
  // Keeping this non-credential hash allows already-owned local files to stay
  // usable offline after the short-lived API token expires.
  try { return require('./platform-connections/runtime.cjs').scope({ ...id, session: token }); }
  catch { return ''; }
}
function localOwner(app) {
  const id = identity(app);
  if (!id || _authChanges.has(_sessionSlot(id.hub, id.clientId))) return '';
  const row = _sessions.get(_sessionSlot(id.hub, id.clientId));
  return row && row.authState === 'active' && !row.activationRequired ? row.localOwner || '' : '';
}

// Registered by this desktop's trusted bootstrap, never supplied by a mobile request.
function libraryWorkRoot(app) {
  const id = identity(app);
  if (!id || !localOwner(app)) throw new Error('请先登录这台电脑');
  const profile = _readDoc(app).profiles[_slot(id.hub)];
  return String(profile?.workRoot || '').trim() || require('node:path').join(
    require('node:os').homedir(), require('./distribution.cjs').current().workspaceName);
}

function _sessionResult(id, row) {
  return {
    ok: true, stored: true, hub: id.hub, clientId: id.clientId,
    authState: String(row.authState || 'active'), activationRequired: !!row.activationRequired,
    session: row.token,
    expiresIn: Math.max(30, Math.ceil((row.expiresAt - Date.now()) / 1000)),
    user: row.user || null,
    quota: row.quota || null,
  };
}

function _workRoot(raw) {
  return String(raw && raw.workRoot || '').trim().slice(0, 400);
}

function _failure(data, status) {
  const detail = data && data.detail;
  const meta = detail && typeof detail === 'object' && !Array.isArray(detail) ? detail : {};
  return {
    status: Number(status) || 0,
    code: String(meta.code || ''),
    error: String(meta.message || detail || ('HTTP ' + status)),
    quota: meta.quota || null,
  };
}

async function _requestEnrollment(id, raw, app = null, generation = _generation(id), cache = true) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    const body = { device: id.clientId };
    for (const field of ['name', 'platform', 'version', 'workRoot']) {
      const value = String(raw && raw[field] || '').trim();
      if (value) body[field] = value.slice(0, field === 'workRoot' ? 400 : 64);
    }
    const res = await fetch(id.hub + '/api/v1/clients/enroll', {
      method: 'POST', signal: ctl.signal,
      headers: { 'Content-Type': 'application/json', 'X-Device-Key': id.secret },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch (_) {}
    if (!_current(generation)) return _changed(id);
    if (!res.ok) return { ok: false, stored: true, hub: id.hub, clientId: id.clientId,
      ..._failure(data, res.status) };
    const safe = {
      ok: true, stored: true, hub: id.hub, clientId: id.clientId,
      authState: String(data.authState || ''), activationRequired: !!data.activationRequired,
      user: data.user || null, quota: data.quota || null,
    };
    if (data.session) {
      safe.session = String(data.session);
      safe.expiresIn = Math.max(30, Number(data.expiresIn) || 0);
      const workRoot = _workRoot(raw);
      if (cache) _sessions.set(_sessionSlot(id.hub, id.clientId), {
        token: safe.session, expiresAt: Date.now() + safe.expiresIn * 1000,
        localOwner: _advanceOwner(app, _sessions.get(_sessionSlot(id.hub, id.clientId)), id, safe.session),
        authState: safe.authState, activationRequired: safe.activationRequired,
        workRoot,
        user: safe.user, quota: safe.quota,
      });
    } else if (cache) {
      _sessions.delete(_sessionSlot(id.hub, id.clientId));
    }
    return safe;
  } catch (error) {
    return { ok: false, stored: true, hub: id.hub, clientId: id.clientId,
      error: error && error.name === 'AbortError' ? TEXT.timeout : String(error.message || error) };
  } finally { clearTimeout(timer); }
}

async function enroll(app, raw = {}) {
  let id;
  try { id = _ensure(app, raw); }
  catch (error) { return { ok: false, stored: false, error: String(error.message || error) }; }

  const slot = _sessionSlot(id.hub, id.clientId);
  if (_authChanges.has(slot)) return _changed(id);
  const current = _validSessionRow(app, id.hub, id.clientId);
  const staleSession = String(raw.staleSession || '');
  const requestedRoot = _workRoot(raw);
  if (current && (!staleSession || current.row.token !== staleSession) &&
      (!requestedRoot || requestedRoot === String(current.row.workRoot || ''))) {
    return _sessionResult(id, current.row);
  }

  /* Every renderer owns isolated memory, but enrollment is a device-level action.
     Collapse concurrent window bootstraps in the trusted main process. A 401 sends
     the rejected token as `staleSession`: only the request that still owns that
     token renews it; later windows reuse the newer session instead of renewing it
     again. */
  const running = _enrollments.get(slot);
  if (running) return running;
  const job = _requestEnrollment(id, raw, app).finally(() => {
    if (_enrollments.get(slot) === job) _enrollments.delete(slot);
  });
  _enrollments.set(slot, job);
  return job;
}

async function login(app, raw = {}, action = 'legacy') {
  let id;
  try { id = _ensure(app, raw, true); }
  catch (error) { return { ok: false, stored: false, error: String(error.message || error) }; }
  const generation = _invalidate(id);
  _authChanges.set(generation.slot, generation);
  const ctl = new AbortController();
  let timer;
  try {
    // Enrollment may still report the previous account. Never expose that
    // intermediate session while an explicit account change is in flight.
    const enrolled = await _requestEnrollment(id, raw, app, generation, false);
    if (!enrolled.ok && !enrolled.status) return enrolled;
    if (!_current(generation)) return _changed(id);
    timer = setTimeout(() => ctl.abort(), 12000);
    const body = {
      device: id.clientId,
      account: String(raw.account || '').trim(),
      password: String(raw.password || ''),
      displayName: String(raw.displayName || '').trim().slice(0, 64),
    };
    for (const field of ['name', 'platform', 'version', 'workRoot']) {
      const value = String(raw[field] || '').trim();
      if (value) body[field] = value.slice(0, field === 'workRoot' ? 400 : 64);
    }
    const request = action === 'legacy' ? { path: '/api/v1/client-auth/login', body }
      : require('./account-auth-contract.cjs').request(action, raw, id.clientId);
    const res = await fetch(id.hub + request.path, {
      method: 'POST', signal: ctl.signal,
      headers: { 'Content-Type': 'application/json', 'X-Device-Key': id.secret },
      body: JSON.stringify(request.body),
    });
    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch (_) {}
    if (!_current(generation)) return _changed(id);
    if (!res.ok) return { ok: false, stored: true, hub: id.hub, clientId: id.clientId,
      ..._failure(data, res.status) };
    _completeCredentialMigration(app, id);
    const expiresIn = Math.max(30, Number(data.expiresIn) || 0);
    const safe = {
      ok: true, stored: true, hub: id.hub, clientId: id.clientId,
      authState: 'active', activationRequired: false,
      session: String(data.session || ''), expiresIn,
      created: !!data.created, user: data.user || null, quota: data.quota || null,
    };
    _sessions.set(_sessionSlot(id.hub, id.clientId), {
      token: safe.session, expiresAt: Date.now() + expiresIn * 1000,
      localOwner: _advanceOwner(app, _sessions.get(_sessionSlot(id.hub, id.clientId)), id, safe.session),
      authState: 'active', activationRequired: false,
      workRoot: _workRoot(raw), user: safe.user, quota: safe.quota,
    });
    return safe;
  } catch (error) {
    return { ok: false, stored: true, hub: id.hub, clientId: id.clientId,
      error: error && error.name === 'AbortError' ? TEXT.timeout : String(error.message || error) };
  } finally {
    clearTimeout(timer);
    if (_authChanges.get(generation.slot) === generation) _authChanges.delete(generation.slot);
  }
}

async function accountAction(app, raw = {}) {
  const action = String(raw.action || '');
  let spec;
  try { spec = require('./account-auth-contract.cjs').request(action, raw, ''); }
  catch (error) { return { ok: false, error: error.message }; }
  if (spec.session) return login(app, raw, action);
  let id;
  try { id = _ensure(app, raw, true); }
  catch (error) { return { ok: false, error: error.message }; }
  const generation = spec.reset ? _invalidate(id) : _generation(id);
  if (spec.reset) _authChanges.set(generation.slot, generation);
  else if (_authChanges.has(generation.slot)) return _changed(id);
  const ctl = new AbortController();
  let timer;
  try {
    if (spec.method !== 'GET') {
      const enrolled = await _requestEnrollment(id, raw, app, generation, false);
      if (!enrolled.ok && !enrolled.status) return enrolled;
    }
    if (!_current(generation)) return _changed(id);
    timer = setTimeout(() => ctl.abort(), 15000);
    const request = require('./account-auth-contract.cjs').request(action, raw, id.clientId);
    const response = await fetch(id.hub + request.path, {
      method: request.method || 'POST', signal: ctl.signal,
      headers: { 'Content-Type': 'application/json', 'X-Device-Key': id.secret },
      ...(request.body ? { body: JSON.stringify(request.body) } : {}),
    });
    let data = {};
    try { data = await response.json(); } catch (_) {}
    if (!_current(generation)) return _changed(id);
    if (!response.ok) return { ok: false, ..._failure(data, response.status) };
    if (action === 'emailChallengeStatus') return { ok: true,
      challengeId: String(data.challengeId || ''), deliveryState: String(data.deliveryState || ''),
      errorCode: String(data.errorCode || '') };
    return action === 'emailChallenge'
      ? { ok: true, challengeId: String(data.challengeId || ''),
          queued: data.queued === true, deliveryState: String(data.deliveryState || ''),
          expiresIn: Number(data.expiresIn) || 300, retryAfter: Number(data.retryAfter) || 60 }
      : { ok: true, logoutRequired: true };
  } catch (error) {
    return { ok: false, error: error.name === 'AbortError' ? TEXT.timeout : String(error.message || error) };
  } finally {
    clearTimeout(timer);
    if (spec.reset && _authChanges.get(generation.slot) === generation) _authChanges.delete(generation.slot);
  }
}

function clearSession(app, raw = {}) {
  const id = identity(app, raw.hub || '', raw.clientId || '');
  if (!id) return { ok: true, cleared: false };
  _invalidate(id);
  return { ok: true, cleared: true, hub: id.hub, clientId: id.clientId };
}

async function logout(app, raw = {}) {
  const id = identity(app, raw.hub || '', raw.clientId || '');
  if (!id) return { ok: true, cleared: false };
  const generation = _invalidate(id);
  _authChanges.set(generation.slot, generation);
  // Local sign-out is immediate, even when the server has already revoked this
  // account or the logout request cannot reach it. Include the initiating window
  // so no renderer keeps showing authenticated state while the network is pending.
  notifySessionChanged(app, null, { ok: true });
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    const res = await fetch(id.hub + '/api/v1/client-auth/logout', {
      method: 'POST', signal: ctl.signal,
      headers: { 'Content-Type': 'application/json', 'X-Device-Key': id.secret },
      body: JSON.stringify({ device: id.clientId }),
    });
    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch (_) {}
    if (!_current(generation)) return _changed(id);
    if (!res.ok) return { ok: false, ..._failure(data, res.status) };
    return { ok: true, cleared: true, hub: id.hub, clientId: id.clientId, activationRequired: true };
  } catch (error) {
    return { ok: false, error: error && error.name === 'AbortError' ?
      TEXT.timeout : String(error.message || error) };
  } finally {
    clearTimeout(timer);
    if (_authChanges.get(generation.slot) === generation) _authChanges.delete(generation.slot);
  }
}

async function ensureSession(app, raw = {}) {
  const id = identity(app, raw.hub || '', raw.clientId || '');
  if (id && _authChanges.has(_sessionSlot(id.hub, id.clientId))) throw new Error(TEXT.changed);
  const current = session(app, raw.hub || '', raw.clientId || '');
  if (current && (!raw.staleSession || current !== raw.staleSession)) return current;
  const result = await enroll(app, raw);
  if (!result.ok) throw new Error(result.error || TEXT.sessionFailed);
  if (!result.session) throw new Error(result.activationRequired ? TEXT.pending : TEXT.noSession);
  return String(result.session);
}

async function authenticatedIdentity(app, hub = '', clientId = '') {
  const id = identity(app, hub, clientId);
  if (!id) return null;
  // Ownership includes the signed account id, not just this device's id.
  // ensureSession reuses the in-memory token and coalesces expired-token renewal.
  // Keep renewal failures intact so offline/quota errors aren't called a logout.
  const generation = _generation(id);
  const token = await ensureSession(app, id);
  const current = identity(app, hub, clientId);
  if (!_current(generation) || !current || current.hub !== id.hub || current.clientId !== id.clientId ||
      _authChanges.has(generation.slot) || session(app, id.hub, id.clientId) !== token) {
    throw new Error(TEXT.changed);
  }
  return { ...id, session: token };
}

async function refreshProfile(app) {
  const id = await authenticatedIdentity(app);
  if (!id) return { ok: false, error: '请重新登录' };
  const generation = _generation(id);
  const response = await fetch(id.hub + '/api/v1/client-auth/me', {
    headers: { Authorization: 'Device ' + id.session }, signal: AbortSignal.timeout(10000),
  });
  let data = {}; try { data = await response.json(); } catch (_) {}
  if (!_current(generation) || _authChanges.has(generation.slot) || session(app) !== id.session) return _changed(id);
  if (!response.ok) return { ok: false, ..._failure(data, response.status) };
  const row = _sessions.get(generation.slot);
  if (!row || !data.user || (row.user?.id && row.user.id !== data.user.id)) return _changed(id);
  row.user = data.user;
  const result = { ok: true, hub: id.hub, clientId: id.clientId, user: data.user };
  try {
    for (const win of require('electron').BrowserWindow?.getAllWindows?.() || [])
      if (!win.isDestroyed()) win.webContents.send('account-profile-changed', result);
  } catch (_) {}
  return result;
}

function notifySessionChanged(app, sender, result) {
  if (!result?.ok) return;
  const id = identity(app);
  if (!id) return;
  try {
    for (const win of require('electron').BrowserWindow?.getAllWindows?.() || [])
      if (!win.isDestroyed() && win.webContents.id !== sender?.id)
        win.webContents.send('account-session-changed', { hub: id.hub, clientId: id.clientId });
  } catch (_) {}
}

function install({ app, ipcMain, safeStorage }) {
  _credentials = require('./device-credential-store.cjs').create({ safeStorage, app });
  require('./device-auth-request').setIdentityRefresher(async previous => {
    const before = identity(app);
    if (!before || before.hub !== previous.hub || before.clientId !== previous.clientId) return null;
    const result = await enroll(app, { hub: before.hub, clientId: before.clientId, staleSession: previous.session });
    const after = identity(app);
    if (!result.ok || !result.session || !after || after.hub !== before.hub || after.clientId !== before.clientId ||
        session(app, after.hub, after.clientId) !== result.session) return null;
    return { ...after, session: result.session };
  });
  ipcMain.handle('device-auth-select-hub', (_event, hub) => selectHub(app, hub));
  ipcMain.handle('device-auth-bootstrap', (_event, raw) => enroll(app, raw || {}));
  ipcMain.handle('device-auth-login', async (event, raw) => { const result = await login(app, raw || {}); notifySessionChanged(app, event?.sender, result); return result; });
  ipcMain.handle('device-account-action', async (event, raw) => { const result = await accountAction(app, raw || {}); if (!['emailChallenge', 'emailChallengeStatus'].includes(raw?.action)) notifySessionChanged(app, event?.sender, result); return result; });
  ipcMain.handle('account-profile-refresh', () => refreshProfile(app));
  ipcMain.handle('device-auth-logout', (_event, raw) => logout(app, raw || {}));
  ipcMain.handle('device-auth-clear-session', (_event, raw) => clearSession(app, raw || {}));
  ipcMain.handle('device-auth-status', (_event, hub, clientId) => {
    const id = identity(app, hub, clientId);
    return { ready: !!id, hub: id ? id.hub : '', clientId: id ? id.clientId : '',
      sessionReady: !!session(app, hub, clientId), secure: !!id && _available() };
  });
}

module.exports = { install, identity, session, localOwner, libraryWorkRoot, profiles, enroll, login, logout, clearSession,
  historyEpoch: id => JSON.stringify(id?.hub && id?.clientId ? _generation(id) : { selection: _selectionVersion }),
  ensureSession, authenticatedIdentity, selectHub, accountAction, refreshProfile };
