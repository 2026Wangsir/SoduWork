'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const credentials = require('../main/device-credential-store.cjs');
const hub = 'http://127.0.0.1:8989';
const slot = crypto.createHash('sha256').update(hub).digest('hex').slice(0, 24);
const row = { hub, clientId: 'soduwork-fixture', cipher: Buffer.from('fixture-key').toString('base64') };

function storage() {
  const calls = { available: 0, decrypt: 0, encrypt: 0 };
  return { calls, safeStorage: {
    isEncryptionAvailable() { calls.available++; return true; },
    decryptString(value) { calls.decrypt++; return value.toString(); },
    encryptString(value) { calls.encrypt++; return Buffer.from(value); },
  } };
}

test('successful reads reuse a device key only for the same profile, hub, device and ciphertext', () => {
  const f = storage(), store = credentials.create({ ...f, platform: 'darwin' });
  assert.equal(store.decrypt('/profile-a/device-auth.json', row), 'fixture-key');
  for (let i = 0; i < 20; i++) store.decrypt('/profile-a/device-auth.json', { ...row });
  assert.equal(f.calls.decrypt, 1);
  store.decrypt('/profile-b/device-auth.json', row);
  store.decrypt('/profile-a/device-auth.json', { ...row, hub: 'http://other.fixture' });
  store.decrypt('/profile-a/device-auth.json', { ...row, clientId: 'soduwork-replaced' });
  assert.equal(store.decrypt('/profile-a/device-auth.json', {
    ...row, cipher: Buffer.from('rotated-key').toString('base64'),
  }), 'rotated-key');
  assert.equal(f.calls.decrypt, 5);
});

for (const failure of ['unavailable', 'availability-throws', 'decrypt-denied', 'empty', 'missing-cipher', 'encrypt-denied']) {
  test('macOS ' + failure + ' stops further automatic key access until restart', () => {
    const f = storage();
    if (failure === 'unavailable') f.safeStorage.isEncryptionAvailable = () => { f.calls.available++; return false; };
    if (failure === 'availability-throws') f.safeStorage.isEncryptionAvailable = () => { f.calls.available++; throw Error('native detail'); };
    if (failure === 'decrypt-denied') f.safeStorage.decryptString = () => { f.calls.decrypt++; throw Error('private native detail'); };
    if (failure === 'empty') f.safeStorage.decryptString = () => { f.calls.decrypt++; return ''; };
    if (failure === 'encrypt-denied') f.safeStorage.encryptString = () => { f.calls.encrypt++; throw Error('native detail'); };
    const store = credentials.create({ ...f, platform: 'darwin' });
    const check = error => error.code === 'DEVICE_KEYCHAIN_UNAVAILABLE' &&
      error.message.includes('原设备凭据已保留') && !error.message.includes('native detail');
    assert.throws(() => failure === 'encrypt-denied' ? store.encrypt('new-key') :
      store.decrypt('/profile', failure === 'missing-cipher' ? { ...row, cipher: '' } : row), check);
    const count = { ...f.calls };
    for (let i = 0; i < 10; i++) {
      assert.equal(store.available(), false);
      assert.throws(() => store.decrypt('/profile', row), check);
      assert.throws(() => store.encrypt('new-key'), check);
    }
    assert.deepEqual(f.calls, count, 'background polling must not call the OS again');
    const restarted = credentials.create({ ...storage(), platform: 'darwin' });
    assert.equal(restarted.decrypt('/profile', row), 'fixture-key');
  });
}

test('a call before app readiness does not latch a Keychain failure', () => {
  let ready = false;
  const f = storage(), store = credentials.create({ ...f, platform: 'darwin', app: { isReady: () => ready } });
  assert.equal(store.available(), false);
  assert.equal(store.error(), null);
  assert.equal(f.calls.available, 0);
  ready = true;
  assert.equal(store.decrypt('/profile', row), 'fixture-key');
});

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-keychain-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'device-auth.json');
  fs.writeFileSync(file, JSON.stringify({ v: 1, activeHub: hub, profiles: { [slot]: row } }));
  const app = { getPath: () => root }, handlers = new Map();
  delete require.cache[require.resolve('../main/device-auth')];
  const auth = require('../main/device-auth');
  const create = credentials.create;
  t.mock.method(credentials, 'create', options => create({ ...options, platform: 'darwin' }));
  return { root, file, app, handlers, auth, install(safeStorage) {
    auth.install({ app, ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, safeStorage });
  } };
}

test('passive identity and status reads do not open secure storage without an applicable profile', async t => {
  const f = fixture(t), native = storage();
  f.install(native.safeStorage);
  fs.unlinkSync(f.file);
  for (let i = 0; i < 5; i++) {
    assert.equal(f.auth.identity(f.app), null);
    assert.equal(f.auth.localOwner(f.app), '');
    assert.equal(f.auth.session(f.app), '');
    assert.equal(f.handlers.get('device-auth-status')(null).ready, false);
  }
  assert.deepEqual(native.calls, { available: 0, decrypt: 0, encrypt: 0 });
  fs.writeFileSync(f.file, JSON.stringify({ v: 1, profiles: { [slot]: row } }));
  assert.equal(f.auth.identity(f.app, 'http://127.0.0.1:9090'), null);
  assert.deepEqual(native.calls, { available: 0, decrypt: 0, encrypt: 0 });
  assert.equal(f.auth.identity(f.app, hub).secret, 'fixture-key');
  assert.equal(native.calls.decrypt, 1);
});

for (const entry of ['identity', 'bootstrap', 'login']) test('macOS denied access during ' + entry + ' preserves primary and backup bytes', async t => {
  const f = fixture(t), native = storage();
  const before = fs.readFileSync(f.file, 'utf8');
  fs.writeFileSync(f.file + '.bak', before);
  native.safeStorage.decryptString = () => { native.calls.decrypt++; throw Error('access denied'); };
  f.install(native.safeStorage);
  t.mock.method(global, 'fetch', () => assert.fail('must not enroll a replacement identity'));
  if (entry === 'identity') assert.equal(f.auth.identity(f.app), null);
  else {
    const result = await f.handlers.get('device-auth-' + entry)(null, { hub, account: 'fixture', password: 'fixture' });
    assert.equal(result.ok, false);
    assert.match(result.error, /原设备凭据已保留/);
  }
  const status = f.handlers.get('device-auth-status')(null, hub, row.clientId);
  assert.equal(status.ready, false);
  assert.equal(status.sessionReady, false);
  assert.equal(status.secure, false);
  for (const action of ['device-auth-bootstrap', 'device-auth-login']) {
    const result = await f.handlers.get(action)(null, { hub, account: 'fixture', password: 'fixture' });
    assert.equal(result.ok, false);
    assert.match(result.error, /原设备凭据已保留/);
  }
  assert.equal(native.calls.decrypt, 1);
  assert.equal(native.calls.encrypt, 0);
  assert.equal(fs.readFileSync(f.file, 'utf8'), before);
  assert.equal(fs.readFileSync(f.file + '.bak', 'utf8'), before);
  assert.deepEqual(fs.readdirSync(f.root).sort(), ['device-auth.json', 'device-auth.json.bak']);
  f.install(storage().safeStorage); // A new main-process lifetime after unlocking.
  assert.equal(f.auth.identity(f.app).clientId, row.clientId);
  assert.equal(f.auth.identity(f.app).secret, 'fixture-key');
});

test('identity consumers share successful decryption and observe on-disk credential rotation', async t => {
  const f = fixture(t), native = storage();
  f.install(native.safeStorage);
  t.mock.method(global, 'fetch', async () => ({ ok: true, text: async () => JSON.stringify({
    session: 'fixture-session', expiresIn: 900, authState: 'active', activationRequired: false,
  }) }));
  const result = await f.auth.enroll(f.app, { hub });
  assert.equal(result.ok, true);
  for (let i = 0; i < 10; i++) {
    assert.equal(f.auth.identity(f.app).secret, 'fixture-key');
    assert.equal(f.auth.session(f.app), 'fixture-session');
    f.auth.localOwner(f.app);
    assert.equal(f.handlers.get('device-auth-status')(null, hub, row.clientId).ready, true);
  }
  assert.equal(native.calls.decrypt, 1);
  const doc = JSON.parse(fs.readFileSync(f.file));
  doc.profiles[slot] = { ...row, clientId: 'soduwork-replacement', cipher: Buffer.from('rotated-key').toString('base64') };
  fs.writeFileSync(f.file, JSON.stringify(doc));
  assert.equal(f.auth.identity(f.app).secret, 'rotated-key');
  assert.equal(f.auth.session(f.app), '', 'a replacement device cannot inherit the previous session');
  assert.equal(native.calls.decrypt, 2);
  fs.unlinkSync(f.file);
  assert.equal(f.auth.identity(f.app), null, 'deleted credentials must not be resurrected from memory');
});
