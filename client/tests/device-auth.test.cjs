const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const auth = require('../main/device-auth');
const { createSafeStorage } = require('./helpers/device-safe-storage-fixture.cjs');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-device-auth-'));
  const handlers = new Map();
  const app = { getPath: (name) => name === 'userData' ? root : root };
  const ipcMain = { handle: (name, fn) => handlers.set(name, fn) };
  const safeStorage = createSafeStorage();
  return { root, handlers, app, ipcMain, safeStorage };
}

function windowsFixture(t) {
  const store = require('../main/device-credential-store.cjs'), create = store.create;
  t.mock.method(store, 'create', options => create({ ...options, platform: 'win32' }));
  return fixture();
}

for (const [name, previousUser, nextUser, migrate] of [
  ['same account legacy fingerprint', 'alice', 'alice', true],
  ['device rebound to a different account', 'alice', 'bob', false],
  ['legacy account without ownership proof', '', 'bob', false],
]) test('local memory renewal: ' + name, async t => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  delete require.cache[require.resolve('../main/device-auth')];
  const localAuth = require('../main/device-auth');
  localAuth.install({ app: f.app, ipcMain: f.ipcMain, safeStorage: f.safeStorage });
  const runtime = require('../main/platform-connections/runtime.cjs'), originalScope = runtime.scope;
  const oldOwner = '1'.repeat(32), oldDirectory = path.join(f.root, 'memory', 'accounts', oldOwner);
  fs.mkdirSync(oldDirectory, { recursive: true }); fs.writeFileSync(path.join(oldDirectory, 'private.md'), 'Alice private memory');
  let first = true, currentUser = previousUser;
  let clock = Date.now(); t.mock.method(Date, 'now', () => clock);
  t.mock.method(runtime, 'scope', id => first ? oldOwner : originalScope(id));
  t.mock.method(global, 'fetch', async (_url, options) => {
    const now = Math.floor(Date.now() / 1000), clientId = JSON.parse(options.body).device;
    const token = Buffer.from(JSON.stringify({ typ: 'device', uid: currentUser, cid: clientId,
      iat: now - 1, exp: now + 60 })).toString('base64url') + '.' + 'a'.repeat(64);
    return { ok: true, status: 200, text: async () => JSON.stringify({ session: token, expiresIn: 60,
      authState: 'active', user: { id: currentUser } }) };
  });
  const initial = await localAuth.enroll(f.app, { hub: 'http://memory-renewal.fixture.invalid' });
  first = false; currentUser = nextUser; clock += 3600000;
  const renewed = await localAuth.enroll(f.app, { hub: initial.hub, staleSession: initial.session });
  assert.equal(renewed.ok, true);
  const destination = path.join(f.root, 'memory', 'accounts', localAuth.localOwner(f.app), 'private.md');
  assert.equal(fs.existsSync(destination), migrate, 'only proven same-account memory may migrate');
  assert.equal(fs.existsSync(path.join(oldDirectory, 'private.md')), !migrate);
});

test('the installed main-process refresher renews the same account but never retries as a rebound user', async t => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  delete require.cache[require.resolve('../main/device-auth')];
  const localAuth = require('../main/device-auth'), requestAuth = require('../main/device-auth-request');
  localAuth.install({ app: f.app, ipcMain: f.ipcMain, safeStorage: f.safeStorage });
  t.after(() => requestAuth.setIdentityRefresher(null));
  let account = 'alice', enrollments = 0;
  t.mock.method(global, 'fetch', async (url, options) => {
    assert.ok(url.endsWith('/clients/enroll'), 'renewal uses only the established enrollment route');
    enrollments++;
    const now = Math.floor(Date.now() / 1000), cid = JSON.parse(options.body).device;
    const session = Buffer.from(JSON.stringify({ typ: 'device', uid: account, cid,
      iat: now, exp: now + 1800, jti: enrollments })).toString('base64url') + '.' + 'a'.repeat(64);
    return { ok: true, status: 200, text: async () => JSON.stringify({ session, expiresIn: 1800,
      authState: 'active', user: { id: account } }) };
  });
  await localAuth.enroll(f.app, { hub: 'http://renewal.fixture.invalid' });
  const original = await localAuth.authenticatedIdentity(f.app), calls = [];
  const fetch = async (_, options) => { calls.push(options); return { status: calls.length === 1 ? 401 : 200 }; };
  assert.equal((await requestAuth.fetchWithDeviceAuthRetry(original, original.hub + '/api/v1/tasks', {}, fetch)).status, 200);
  assert.equal(enrollments, 2); assert.equal(calls.length, 2);
  assert.equal(calls[1].headers.Authorization, 'Device ' + localAuth.session(f.app));
  assert.equal(calls[1].headers['X-Soduwork-Secret'], undefined);
  const rejected = await localAuth.authenticatedIdentity(f.app);
  assert.notEqual(await localAuth.ensureSession(f.app, { ...rejected, staleSession: rejected.session }), rejected.session);
  assert.equal(enrollments, 3, 'worker renewal cannot reuse the still-cached rejected token');
  const beforeRebind = await localAuth.authenticatedIdentity(f.app);
  account = 'bob'; calls.length = 0;
  assert.equal((await requestAuth.fetchWithDeviceAuthRetry(beforeRebind, original.hub + '/api/v1/tasks', {}, fetch)).status, 401);
  assert.equal(calls.length, 1, 'a different uid cannot receive the old account request');
});

test('trusted local ownership survives token expiry without network and clears on logout or account change', async t => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const freshPath = require.resolve('../main/device-auth');
  delete require.cache[freshPath];
  const localAuth = require('../main/device-auth');
  localAuth.install({ app: f.app, ipcMain: f.ipcMain, safeStorage: f.safeStorage });
  const realFetch = global.fetch, realNow = Date.now, base = realNow();
  let requests = 0, user = 'first-user', clock = base;
  Date.now = () => clock;
  global.fetch = async (_url, options) => {
    requests++;
    const cid = JSON.parse(options.body).device, now = Math.floor(clock / 1000);
    const token = Buffer.from(JSON.stringify({ typ: 'device', uid: user, cid,
      iat: now - 1, exp: now + 60 })).toString('base64url') + '.' + '0'.repeat(64);
    return { ok: true, status: 200, text: async () => JSON.stringify({
      session: token, expiresIn: 60, authState: 'active', activationRequired: false,
    }) };
  };
  t.after(() => { global.fetch = realFetch; Date.now = realNow; });
  const enrolled = await localAuth.enroll(f.app, { hub: 'http://local-owner.fixture.invalid' });
  assert.equal(enrolled.ok, true);
  const owner = localAuth.localOwner(f.app);
  assert.match(owner, /^[a-f0-9]{32}$/);
  assert.equal(owner, require('../main/platform-connections/runtime.cjs').scope({
    hub: enrolled.hub, clientId: enrolled.clientId, session: enrolled.session,
  }));
  const firstCount = requests;
  clock += 3600000;
  assert.equal(localAuth.session(f.app), '');
  assert.equal(localAuth.localOwner(f.app), owner);
  assert.equal(requests, firstCount, 'local owner must never renew API authentication');
  let finishLogout;
  global.fetch = () => new Promise(resolve => { finishLogout = resolve; });
  const loggingOut = localAuth.logout(f.app);
  assert.equal(localAuth.localOwner(f.app), '', 'logout invalidates before network acknowledgement');
  finishLogout({ ok: true, text: async () => '{}' }); await loggingOut;
  assert.equal(localAuth.localOwner(f.app), '');
  global.fetch = async (_url, options) => {
    const cid = JSON.parse(options.body).device, now = Math.floor(clock / 1000);
    return { ok: true, status: 200, text: async () => JSON.stringify({ authState: 'active',
      session: Buffer.from(JSON.stringify({ typ: 'device', uid: 'second-user', cid,
        iat: now - 1, exp: now + 60 })).toString('base64url') + '.' + '0'.repeat(64), expiresIn: 60 }) };
  };
  assert.equal((await localAuth.login(f.app, { hub: enrolled.hub, account: 'second-user', password: 'fixture-only' })).ok, true);
  assert.notEqual(localAuth.localOwner(f.app), owner);
  localAuth.selectHub(f.app, 'https://other-owner.fixture.invalid');
  assert.equal(localAuth.localOwner(f.app), '');
  localAuth.selectHub(f.app, enrolled.hub);
  assert.match(localAuth.localOwner(f.app), /^[a-f0-9]{32}$/);
  localAuth.clearSession(f.app);
  assert.equal(localAuth.localOwner(f.app), '');
});

test('device key migrates into safe storage and never crosses renderer IPC', async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const legacy = 'legacy-device-key-with-at-least-32-characters';
  const runnerDir = path.join(f.root, 'runner');
  fs.mkdirSync(runnerDir, { recursive: true });
  fs.writeFileSync(path.join(runnerDir, 'config.json'), JSON.stringify({
    hub: 'http://127.0.0.1:8989', clientId: 'device-test-1', secret: legacy,
    workRoot: 'C:/work',
  }));

  const requests = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    requests.push({ url, options });
    return {
      ok: true, status: 200,
      text: async () => JSON.stringify({
        authState: 'active', activationRequired: false,
        session: 'short-device-session', expiresIn: 1800,
        secret: 'must-not-cross-ipc', secretHash: 'must-not-cross-ipc',
      }),
    };
  };
  t.after(() => { global.fetch = originalFetch; });

  auth.install({ app: f.app, ipcMain: f.ipcMain, safeStorage: f.safeStorage });
  const bootstrap = f.handlers.get('device-auth-bootstrap');
  const result = await bootstrap(null, {
    hub: 'http://127.0.0.1:8989', clientId: 'device-test-1', legacySecret: legacy,
  });
  assert.equal(result.ok, true);
  assert.equal(result.session, 'short-device-session');
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'secret'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'secretHash'), false);

  const persisted = fs.readFileSync(path.join(f.root, 'device-auth.json'), 'utf8');
  assert.equal(persisted.includes(legacy), false);
  const runner = JSON.parse(fs.readFileSync(path.join(runnerDir, 'config.json'), 'utf8'));
  assert.equal(Object.prototype.hasOwnProperty.call(runner, 'secret'), false);
  assert.equal(auth.identity(f.app).secret, legacy);
  assert.equal(requests[0].options.headers['X-Device-Key'], legacy);

  const status = await f.handlers.get('device-auth-status')(
    null, 'http://127.0.0.1:8989', 'device-test-1');
  assert.deepEqual(Object.keys(status).sort(),
    ['clientId', 'hub', 'ready', 'secure', 'sessionReady'].sort());
  assert.equal(status.sessionReady, true);
});

test('reselecting an older Hub profile makes it the active identity for chat and updates', async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true, status: 200,
    text: async () => JSON.stringify({ authState: 'active', session: 'session', expiresIn: 1800 }),
  });
  t.after(() => { global.fetch = originalFetch; });
  auth.install({ app: f.app, ipcMain: f.ipcMain, safeStorage: f.safeStorage });
  const bootstrap = f.handlers.get('device-auth-bootstrap');

  await bootstrap(null, { hub: 'http://192.0.2.10:8989', clientId: 'legacy-renderer-id' });
  await bootstrap(null, { hub: 'http://127.0.0.1:9080', clientId: 'legacy-renderer-id' });
  assert.equal(auth.identity(f.app).hub, 'http://127.0.0.1:9080');

  /*
   * Choose the explicitly active production profile even when a development profile was
   * created more recently.
   */
  await bootstrap(null, { hub: 'http://192.0.2.10:8989', clientId: 'legacy-renderer-id' });
  assert.equal(auth.identity(f.app).hub, 'http://192.0.2.10:8989');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'device-auth.json'), 'utf8')).activeHub,
    'http://192.0.2.10:8989');

  /*
   * After module reload, use persisted activeHub rather than profile creation time.
   */
  const modulePath = require.resolve('../main/device-auth');
  delete require.cache[modulePath];
  const restartedAuth = require('../main/device-auth');
  restartedAuth.install({ app: f.app, ipcMain: f.ipcMain, safeStorage: f.safeStorage });
  assert.equal(restartedAuth.identity(f.app).hub, 'http://192.0.2.10:8989');
});

test('selecting an unenrolled Hub never falls back to another environment identity', async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true, status: 200,
    text: async () => JSON.stringify({ authState: 'active', session: 'session', expiresIn: 1800 }),
  });
  t.after(() => { global.fetch = originalFetch; });
  auth.install({ app: f.app, ipcMain: f.ipcMain, safeStorage: f.safeStorage });
  await f.handlers.get('device-auth-bootstrap')(null, {
    hub: 'http://192.0.2.10:8989', clientId: 'legacy-renderer-id',
  });
  assert.equal(auth.identity(f.app).hub, 'http://192.0.2.10:8989');

  const selected = await f.handlers.get('device-auth-select-hub')(null, 'http://127.0.0.1:9080');
  assert.deepEqual(selected, { ok: true, hub: 'http://127.0.0.1:9080', ready: false });
  assert.equal(auth.identity(f.app), null);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'device-auth.json'), 'utf8')).activeHub,
    'http://127.0.0.1:9080');
});

test('insecure operating-system storage fails closed', async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const unavailable = { ...f.safeStorage, isEncryptionAvailable: () => false };
  auth.install({ app: f.app, ipcMain: f.ipcMain, safeStorage: unavailable });
  const result = await f.handlers.get('device-auth-bootstrap')(null, {
    hub: 'http://127.0.0.1:8989', clientId: 'device-test-2',
  });
  assert.equal(result.ok, false);
  assert.equal(result.stored, false);
  assert.match(result.error, process.platform === 'linux' ? /Linux.*\u5bc6\u94a5\u73af/ : /\u5b89\u5168\u5b58\u50a8/);
});

test('a new installation gets an unpredictable device identity instead of reusing the user id', async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const requests = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    requests.push({ url, options });
    return { ok: true, status: 200, text: async () => JSON.stringify({
      authState: 'pending', activationRequired: true,
    }) };
  };
  t.after(() => { global.fetch = originalFetch; });
  auth.install({ app: f.app, ipcMain: f.ipcMain, safeStorage: f.safeStorage });

  const result = await f.handlers.get('device-auth-bootstrap')(null, {
    hub: 'http://127.0.0.1:8989', clientId: 'u-predictable-user-id',
  });
  const body = JSON.parse(requests[0].options.body);
  assert.equal(result.ok, true);
  assert.match(result.clientId, /^soduwork-[a-f0-9]{24}$/);
  assert.equal(result.clientId, body.device);
  assert.notEqual(result.clientId, 'u-predictable-user-id');
  assert.equal(auth.identity(f.app).clientId, result.clientId);
});

test('all renderer windows share one active device session', async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const originalFetch = global.fetch;
  let requests = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  global.fetch = async () => {
    requests += 1;
    await gate;
    return { ok: true, status: 200, text: async () => JSON.stringify({
      authState: 'active', session: 'shared-window-session', expiresIn: 1800,
    }) };
  };
  t.after(() => { global.fetch = originalFetch; });
  auth.install({ app: f.app, ipcMain: f.ipcMain, safeStorage: f.safeStorage });
  const bootstrap = f.handlers.get('device-auth-bootstrap');
  const payload = { hub: 'http://127.0.0.1:8991', clientId: 'renderer-shared-1',
    legacySecret: 'shared-device-key-with-at-least-32-characters', workRoot: 'C:/work' };

  const first = bootstrap(null, payload);
  const second = bootstrap(null, payload);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests, 1);
  release();
  const [a, b] = await Promise.all([first, second]);
  const third = await bootstrap(null, payload);
  assert.equal(requests, 1);
  assert.equal(a.session, 'shared-window-session');
  assert.equal(b.session, a.session);
  assert.equal(third.session, a.session);
  assert.ok(third.expiresIn <= 1800 && third.expiresIn > 1700);
});

test('a rejected session is renewed once and late windows reuse the replacement', async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const originalFetch = global.fetch;
  let requests = 0;
  global.fetch = async () => {
    requests += 1;
    return { ok: true, status: 200, text: async () => JSON.stringify({
      authState: 'active', session: 'renewed-session-' + requests, expiresIn: 1800,
    }) };
  };
  t.after(() => { global.fetch = originalFetch; });
  auth.install({ app: f.app, ipcMain: f.ipcMain, safeStorage: f.safeStorage });
  const bootstrap = f.handlers.get('device-auth-bootstrap');
  const payload = { hub: 'http://127.0.0.1:8992', clientId: 'renderer-renew-1',
    legacySecret: 'renew-device-key-with-at-least-32-characters' };
  const initial = await bootstrap(null, payload);
  assert.equal(requests, 1);

  const renewed = await bootstrap(null, { ...payload, staleSession: initial.session });
  const late = await bootstrap(null, { ...payload, staleSession: initial.session });
  assert.equal(requests, 2);
  assert.notEqual(renewed.session, initial.session);
  assert.equal(late.session, renewed.session);
});

test('authenticated send identity reuses a valid cached session without another enrollment', async t => {
  const f = fixture();
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; fs.rmSync(f.root, { recursive: true, force: true }); });
  let requests = 0;
  global.fetch = async () => {
    requests++;
    return { ok: true, status: 200, text: async () => JSON.stringify({
      authState: 'active', session: 'fixture-cached-session', expiresIn: 1800,
    }) };
  };
  auth.install(f);
  assert.equal((await auth.enroll(f.app, { hub: 'http://127.0.0.1:9' })).ok, true);
  const local = auth.identity(f.app);
  assert.equal(Object.hasOwn(local, 'session'), false);
  const identities = await Promise.all(Array.from({ length: 7 }, () => auth.authenticatedIdentity(f.app)));
  assert.equal(requests, 1, 'normal sends use the cached session, with no extra Hub round trip');
  assert.ok(identities.every(identity => identity.session === 'fixture-cached-session'));
  assert.ok(identities.every(identity => identity.clientId === local.clientId && identity.hub === local.hub));
});
test('renderer-to-runner configuration contains no long-lived secret', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'api.js'), 'utf8');
  const start = source.indexOf('async function syncRunnerConfig');
  const end = source.indexOf('function authHeaders', start);
  const block = source.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.equal(/\bsecret\s*:/.test(block), false);
  assert.equal(block.includes('!secret()'), false);
});

test('a Hub-confirmed runner clears stale configuration errors', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main', 'runner-runtime.js'), 'utf8');
  assert.match(source, /if \(_connectionState === 'online'\) _lastError = '';/);
});

test('sandboxed filesystems degrade rename to copy across credential and update writers', () => {
  const deviceAuth = fs.readFileSync(path.join(__dirname, '..', 'main', 'device-auth.js'), 'utf8');
  assert.match(deviceAuth, /_replaceFile\(next, file, backup\)/,
    'device credentials must keep a recovery copy when copy-over replaces an existing file');
  const runnerSource = fs.readFileSync(path.join(__dirname, '..', 'main', 'runner-runtime.js'), 'utf8');
  assert.match(runnerSource, /\.code === 'EXDEV'/,
    'runner config writes must degrade rename to copy on EXDEV');
});

test('Windows credentials persist when a sandboxed filesystem reports same-directory rename as EXDEV', async (t) => {
  const f = windowsFixture(t);
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const realRename = fs.renameSync;
  let exdevRenames = 0;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (String(from).endsWith('device-auth.json.next') ||
        String(from).endsWith('device-auth.json')) {
      exdevRenames += 1;
      const error = new Error("EXDEV: cross-device link not permitted, rename '" +
        from + "' -> '" + to + "'");
      error.code = 'EXDEV';
      throw error;
    }
    return realRename(from, to);
  });
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({
    authState: 'active', session: 'exdev-session', expiresIn: 1800,
  }) });
  t.after(() => { global.fetch = originalFetch; });
  auth.install({ app: f.app, ipcMain: f.ipcMain, safeStorage: f.safeStorage });

  /* On initial credential persistence, fall back to copying after EXDEV. */
  const enrolled = await f.handlers.get('device-auth-bootstrap')(null, {
    hub: 'http://192.0.2.10:8989', clientId: 'legacy-renderer-id',
  });
  assert.equal(enrolled.ok, true);
  assert.ok(exdevRenames >= 1, 'degradation must actually run in this fixture');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'device-auth.json'), 'utf8')).activeHub,
    'http://192.0.2.10:8989');
  assert.equal(fs.existsSync(path.join(f.root, 'device-auth.json.next')), false,
    'temporary file must be cleaned up');

  /* Replace existing credentials successfully when switching Hub without leaving stale files. */
  const selected = await f.handlers.get('device-auth-select-hub')(null, 'http://127.0.0.1:9080');
  assert.equal(selected.ok, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'device-auth.json'), 'utf8')).activeHub,
    'http://127.0.0.1:9080');
  assert.equal(fs.existsSync(path.join(f.root, 'device-auth.json.next')), false);
  assert.equal(fs.existsSync(path.join(f.root, 'device-auth.json.bak')), false,
    'recovery copy must be cleaned up after a successful copy fallback');
});

test('Windows in-place overwrite remains available when even copy is blocked', async (t) => {
  const f = windowsFixture(t);
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({
    authState: 'active', session: 'seed-session', expiresIn: 1800,
  }) });
  t.after(() => { global.fetch = originalFetch; });
  auth.install({ app: f.app, ipcMain: f.ipcMain, safeStorage: f.safeStorage });
  const seeded = await f.handlers.get('device-auth-bootstrap')(null, {
    hub: 'http://127.0.0.1:8989', clientId: 'legacy-renderer-id',
  });
  assert.equal(seeded.ok, true);

  /* Use in-place writing when both rename and copy are blocked. */
  const exdevError = (from, to) => Object.assign(
    new Error("EXDEV: cross-device link not permitted, rename '" + from + "' -> '" + to + "'"),
    { code: 'EXDEV' });
  t.mock.method(fs, 'renameSync', (from, to) => { throw exdevError(from, to); });
  t.mock.method(fs, 'copyFileSync', () => {
    throw Object.assign(new Error("EPERM: operation not permitted"), { code: 'EPERM' });
  });

  const overwritten = await f.handlers.get('device-auth-select-hub')(null, 'http://192.0.2.10:8989');
  assert.equal(overwritten.ok, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'device-auth.json'), 'utf8')).activeHub,
    'http://192.0.2.10:8989');
  assert.equal(fs.existsSync(path.join(f.root, 'device-auth.json.next')), false);
  assert.equal(fs.existsSync(path.join(f.root, 'device-auth.json.bak')), false,
    'successful in-place overwrite must clean its recovery copy');
});

test('Windows non-EXDEV rename failures fall through to the in-place overwrite instead of failing login', async (t) => {
  const f = windowsFixture(t);
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({
    authState: 'active', session: 'seed-session', expiresIn: 1800,
  }) });
  t.after(() => { global.fetch = originalFetch; });
  auth.install({ app: f.app, ipcMain: f.ipcMain, safeStorage: f.safeStorage });
  const seeded = await f.handlers.get('device-auth-bootstrap')(null, {
    hub: 'http://127.0.0.1:8989', clientId: 'legacy-renderer-id',
  });
  assert.equal(seeded.ok, true);

  t.mock.method(fs, 'renameSync', (from, to) => {
    throw Object.assign(new Error("EPERM: operation not permitted, rename '" + from + "'"),
      { code: 'EPERM' });
  });
  const blocked = await f.handlers.get('device-auth-select-hub')(null, 'http://192.0.2.10:8989');
  assert.equal(blocked.ok, true, 'in-place overwrite keeps login working when every rename is blocked');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'device-auth.json'), 'utf8')).activeHub,
    'http://192.0.2.10:8989');
  assert.equal(fs.existsSync(path.join(f.root, 'device-auth.json.next')), false);
});

test('Windows fully blocked filesystem still fails closed without corrupting existing credentials', async (t) => {
  const f = windowsFixture(t);
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({
    authState: 'active', session: 'seed-session', expiresIn: 1800,
  }) });
  t.after(() => { global.fetch = originalFetch; });
  auth.install({ app: f.app, ipcMain: f.ipcMain, safeStorage: f.safeStorage });
  const seeded = await f.handlers.get('device-auth-bootstrap')(null, {
    hub: 'http://127.0.0.1:8989', clientId: 'legacy-renderer-id',
  });
  assert.equal(seeded.ok, true);
  const before = fs.readFileSync(path.join(f.root, 'device-auth.json'), 'utf8');

  /* Simulate failure of rename, copy, and in-place write. */
  const exdevError = (from, to) => Object.assign(
    new Error("EXDEV: cross-device link not permitted, rename '" + from + "' -> '" + to + "'"),
    { code: 'EXDEV' });
  t.mock.method(fs, 'renameSync', (from, to) => { throw exdevError(from, to); });
  t.mock.method(fs, 'copyFileSync', () => {
    throw Object.assign(new Error("EPERM: operation not permitted"), { code: 'EPERM' });
  });
  const realWrite = fs.writeFileSync;
  t.mock.method(fs, 'writeFileSync', (target, data, options) => {
    if (String(target).endsWith('device-auth.json')) {
      throw Object.assign(new Error("EPERM: operation not permitted"), { code: 'EPERM' });
    }
    return realWrite(target, data, options);
  });

  const blocked = await f.handlers.get('device-auth-select-hub')(null, 'http://192.0.2.10:8989');
  assert.equal(blocked.ok, false, 'a fully blocked filesystem must fail closed, not fake success');
  assert.match(String(blocked.error || ''), /安全管控|白名单|重启/,
    'the login page must get an actionable message, not a raw EXDEV line');
  assert.doesNotMatch(String(blocked.error || ''), /EXDEV/,
    'raw filesystem jargon must not reach the login screen');
  assert.equal(fs.readFileSync(path.join(f.root, 'device-auth.json'), 'utf8'), before,
    'existing credentials must stay intact');
  assert.equal(fs.existsSync(path.join(f.root, 'device-auth.json.next')), false);
  assert.equal(fs.existsSync(path.join(f.root, 'device-auth.json.bak')), false);
});

test('Windows non-EXDEV write failures still fail closed without corrupting existing credentials', async (t) => {
  const f = windowsFixture(t);
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({
    authState: 'active', session: 'first-session', expiresIn: 1800,
  }) });
  t.after(() => { global.fetch = originalFetch; });
  auth.install({ app: f.app, ipcMain: f.ipcMain, safeStorage: f.safeStorage });
  const first = await f.handlers.get('device-auth-bootstrap')(null, {
    hub: 'http://127.0.0.1:8989', clientId: 'legacy-renderer-id',
  });
  assert.equal(first.ok, true);
  const before = fs.readFileSync(path.join(f.root, 'device-auth.json'), 'utf8');

  /* Report failure when every write path is blocked; never fabricate success. */
  t.mock.method(fs, 'renameSync', (from, to) => {
    throw Object.assign(new Error("EPERM: operation not permitted, rename '" + from + "'"),
      { code: 'EPERM' });
  });
  const realWrite = fs.writeFileSync;
  t.mock.method(fs, 'writeFileSync', (target, data, options) => {
    if (String(target).endsWith('device-auth.json')) {
      throw Object.assign(new Error("EPERM: operation not permitted"), { code: 'EPERM' });
    }
    return realWrite(target, data, options);
  });
  const blocked = await f.handlers.get('device-auth-select-hub')(null, 'http://192.0.2.10:8989');
  assert.equal(blocked.ok, false, 'when even the in-place overwrite is blocked, fail closed');
  assert.equal(fs.readFileSync(path.join(f.root, 'device-auth.json'), 'utf8'), before,
    'existing credentials must stay intact');
  assert.equal(fs.existsSync(path.join(f.root, 'device-auth.json.next')), false);
});

function healingFixture(t) {
  // Windows recovery remains supported. macOS synchronous Keychain errors are
  // ambiguous and must preserve the identity (covered by device-keychain tests).
  const store = require('../main/device-credential-store.cjs'), create = store.create;
  t.mock.method(store, 'create', options => create({ ...options, platform: 'win32' }));
  const base = fixture();
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from('cipher:' + value, 'utf8'),
    /* Simulate ciphertext that cannot be decrypted after safeStorage keys change. */
    decryptString: (value) => {
      const text = Buffer.from(value).toString('utf8');
      if (text.startsWith('broken:')) throw new Error('os_crypt key changed');
      return text.replace(/^cipher:/, '');
    },
    getSelectedStorageBackend: () => 'dpapi',
  };
  return { ...base, safeStorage };
}

function seedDoc(root, doc, suffix) {
  fs.writeFileSync(path.join(root, 'device-auth.json' + (suffix || '')), JSON.stringify(doc));
}

function slot(hub) {
  return require('node:crypto').createHash('sha256').update(hub).digest('hex').slice(0, 24);
}

const HUB = 'http://127.0.0.1:8989';

function brokenRow(hub) {
  return { hub, clientId: 'soduwork-oldrow', cipher: Buffer.from('broken:xxx', 'utf8').toString('base64'),
    createdAt: '2026-10-12T00:00:00.000Z' };
}

async function sessionResponseFixture(requests, user) {
  const now = Math.floor(Date.now() / 1000);
  const token = Buffer.from(JSON.stringify({ typ: 'device', uid: user, cid: 'x',
    iat: now - 1, exp: now + 60 })).toString('base64url') + '.' + '0'.repeat(64);
  requests.push('session');
  return { ok: true, status: 200, text: async () => JSON.stringify({
    authState: 'active', activationRequired: false, session: token, expiresIn: 60,
  }) };
}

test('Windows unreadable device rows self-heal from the .bak copy instead of blocking login', async (t) => {
  const f = healingFixture(t);
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const otherHub = 'http://other-hub.fixture.invalid';
  seedDoc(f.root, { v: 1, activeHub: HUB, profiles: {
    [slot(HUB)]: brokenRow(HUB),
    [slot(otherHub)]: { hub: otherHub, clientId: 'soduwork-keepme',
      cipher: Buffer.from('cipher:other-secret', 'utf8').toString('base64') },
  } });
  seedDoc(f.root, { v: 1, activeHub: HUB, profiles: {
    [slot(HUB)]: { hub: HUB, clientId: 'soduwork-goodrow',
      cipher: Buffer.from('cipher:good-secret', 'utf8').toString('base64') },
  } }, '.bak');
  const requests = [];
  const originalFetch = global.fetch;
  global.fetch = async (_url, options) => {
    requests.push({ key: options.headers['X-Device-Key'], device: JSON.parse(options.body).device });
    return sessionResponseFixture(requests, 'sample.user');
  };
  t.after(() => { global.fetch = originalFetch; });
  auth.install({ app: f.app, ipcMain: f.ipcMain, safeStorage: f.safeStorage });

  const result = await f.handlers.get('device-auth-bootstrap')(null, { hub: HUB });
  assert.equal(result.ok, true, 'recovery from .bak must succeed where the old code failed');
  assert.deepEqual(requests[0], { key: 'good-secret', device: 'soduwork-goodrow' },
    'the recovered identity must be reused, not replaced');

  const persisted = JSON.parse(fs.readFileSync(path.join(f.root, 'device-auth.json'), 'utf8'));
  assert.equal(persisted.profiles[slot(HUB)].clientId, 'soduwork-goodrow');
  assert.equal(auth.identity(f.app).secret, 'good-secret');
  assert.equal(persisted.profiles[slot(otherHub)].clientId, 'soduwork-keepme',
    'profiles of other hubs must not be touched by the recovery');
});

test('Windows unreadable device rows without a usable backup re-enroll a fresh identity and still log in', async (t) => {
  const f = healingFixture(t);
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  seedDoc(f.root, { v: 1, activeHub: HUB, profiles: { [slot(HUB)]: brokenRow(HUB) } });
  seedDoc(f.root, { v: 1, activeHub: HUB, profiles: { [slot(HUB)]: brokenRow(HUB) } }, '.bak');
  const requests = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    const body = JSON.parse(options.body), key = options.headers['X-Device-Key'];
    if (String(url).endsWith('/clients/enroll')) {
      assert.notEqual(body.device, 'soduwork-oldrow', 'the dead identity must not be reused');
      requests.push({ step: 'enroll', device: body.device, key });
      return { ok: true, status: 200, text: async () => JSON.stringify({
        authState: 'pending', activationRequired: true,
      }) };
    }
    if (String(url).endsWith('/client-auth/login')) {
      requests.push({ step: 'login', device: body.device, key });
      return { ok: true, status: 200, text: async () => JSON.stringify({
        session: 'fresh-session', expiresIn: 900, created: false,
      }) };
    }
    throw new Error('unexpected fixture url ' + url);
  };
  t.after(() => { global.fetch = originalFetch; });
  auth.install({ app: f.app, ipcMain: f.ipcMain, safeStorage: f.safeStorage });

  const result = await f.handlers.get('device-auth-login')(null, {
    hub: HUB, account: 'sample.user', password: 'pw',
  });
  assert.deepEqual(requests.map(r => r.step), ['enroll', 'login'],
    'login must register the fresh device first, then authenticate');
  assert.equal(result.ok, true, 'a fresh identity must heal the login with no admin action');
  assert.equal(result.session, 'fresh-session');
  const fresh = requests[0];
  assert.match(fresh.device, /^soduwork-[a-f0-9]{24}$/);
  assert.ok(fresh.key && fresh.key.length >= 32);
  const persisted = JSON.parse(fs.readFileSync(path.join(f.root, 'device-auth.json'), 'utf8'));
  assert.equal(persisted.profiles[slot(HUB)].clientId, fresh.device,
    'the fresh identity must be persisted for future launches');
  assert.equal(auth.identity(f.app).secret, fresh.key);
});
