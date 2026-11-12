'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const credentials = require('../main/device-credential-store.cjs');
const hub = 'http://127.0.0.1:18989';
const slot = crypto.createHash('sha256').update(hub).digest('hex').slice(0, 24);

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-linux-credentials-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'device-auth.json'), handlers = new Map();
  const app = { getPath: () => root, isReady: () => true };
  const state = { available: true, backend: 'gnome_libsecret', login: true, requests: [] };
  const key = crypto.randomBytes(32);
  // Test-only cipher models a fixed-password v10 and protected-key v11. The
  // application always delegates both formats to Electron's native API.
  const basicKey = crypto.createHash('sha256').update('fixture-public-basic-password').digest();
  function encode(secret, prefix, material) {
    const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', material, iv);
    const bytes = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    return Buffer.concat([Buffer.from(prefix), iv, cipher.getAuthTag(), bytes]);
  }
  const legacyCipher = secret => encode(secret, 'v10', basicKey);
  const safeStorage = {
    isEncryptionAvailable: () => state.available,
    getSelectedStorageBackend: () => state.backend,
    encryptString: secret => encode(secret, 'v11', key),
    decryptString(bytes) {
      const prefix = bytes.subarray(0, 3).toString();
      assert.ok(['v10', 'v11'].includes(prefix));
      const decipher = crypto.createDecipheriv('aes-256-gcm', prefix === 'v10' ? basicKey : key, bytes.subarray(3, 15));
      decipher.setAuthTag(bytes.subarray(15, 31));
      return Buffer.concat([decipher.update(bytes.subarray(31)), decipher.final()]).toString('utf8');
    },
  };
  const create = credentials.create;
  t.mock.method(credentials, 'create', options => create({ ...options, platform: 'linux' }));
  t.mock.method(global, 'fetch', async (url, options) => {
    state.requests.push({ url, key: options.headers['X-Device-Key'], body: JSON.parse(options.body) });
    const denied = url.endsWith('/login') && !state.login;
    return { ok: !denied, status: denied ? 401 : 200, text: async () => JSON.stringify(denied
      ? { detail: { code: 'ACCOUNT_OR_PASSWORD_INVALID', message: 'Wrong password' } }
      : { session: 'fixture-session', expiresIn: 1800, authState: 'active', user: { id: 'fixture-user' } }) };
  });
  delete require.cache[require.resolve('../main/device-auth')];
  const auth = require('../main/device-auth');
  const install = () => auth.install({ app, safeStorage, ipcMain: { handle: (name, fn) => handlers.set(name, fn) } });
  install();
  const seed = row => fs.writeFileSync(file, JSON.stringify({ v: 1, activeHub: hub, profiles: { [slot]: row } }));
  const login = () => auth.login(app, { hub, account: 'fixture', password: 'fixture' });
  return { root, file, app, auth, state, safeStorage, legacyCipher, handlers, seed, login, install };
}

test('Linux fresh login uses native encryption and retains identity after storage reinitialization', async t => {
  const f = fixture(t);
  const result = await f.login();
  assert.equal(result.ok, true, JSON.stringify(result));
  const id = f.auth.identity(f.app), doc = JSON.parse(fs.readFileSync(f.file));
  assert.equal(doc.profiles[slot].storage, 'electron-safe-storage');
  assert.equal(f.safeStorage.decryptString(Buffer.from(doc.profiles[slot].cipher, 'base64')), id.secret);
  assert.ok(!fs.readFileSync(f.file, 'utf8').includes(id.secret));
  f.install();
  assert.deepEqual(f.auth.identity(f.app), id);
  assert.equal(f.handlers.get('device-auth-status')(null).secure, true);
});

for (const backend of ['basic_text', 'unknown', '', 'dpapi', 'unrecognized']) test('Linux refuses unsafe backend ' + JSON.stringify(backend), async t => {
  const f = fixture(t); f.state.backend = backend;
  const previous = process.env.SODUWORK_ALLOW_INSECURE_KEYSTORE;
  process.env.SODUWORK_ALLOW_INSECURE_KEYSTORE = '1';
  t.after(() => { if (previous === undefined) delete process.env.SODUWORK_ALLOW_INSECURE_KEYSTORE;
    else process.env.SODUWORK_ALLOW_INSECURE_KEYSTORE = previous; });
  assert.equal((await f.login()).ok, false);
  assert.equal(f.state.requests.length, 0);
  assert.equal(fs.existsSync(f.file), false);
});

for (const damage of ['cipher', 'missing-cipher', 'device', 'json']) test('Linux preserves unreadable existing identity: ' + damage, async t => {
  const f = fixture(t);
  f.seed({ hub, clientId: damage === 'device' ? '!' : 'soduwork-existing',
    cipher: damage === 'missing-cipher' ? '' : Buffer.from('v11-corrupt').toString('base64') });
  if (damage === 'json') fs.writeFileSync(f.file, '{broken');
  const before = fs.readFileSync(f.file);
  assert.equal((await f.login()).ok, false);
  assert.deepEqual(fs.readFileSync(f.file), before);
  assert.equal(f.state.requests.length, 0);
});

test('Linux keyring availability can recover without latching a permanent failure', t => {
  const f = fixture(t), store = credentials.create({ app: f.app, safeStorage: f.safeStorage });
  const row = { hub, clientId: 'fixture', cipher: f.safeStorage.encryptString('fixture-key').toString('base64') };
  f.state.available = false;
  assert.throws(() => store.decrypt(f.file, row), /Linux/);
  f.state.available = true;
  assert.equal(store.decrypt(f.file, row), 'fixture-key');
});

test('known Linux plaintext patch migrates only after successful original-Hub login without changing identity', async t => {
  const f = fixture(t), secret = crypto.randomBytes(32).toString('base64url');
  const row = { hub, clientId: 'soduwork-existing', cipher: Buffer.from(secret).toString('base64'), createdAt: 'fixture' };
  f.seed(row); const before = fs.readFileSync(f.file);
  fs.writeFileSync(f.file + '.bak', before);
  assert.equal(f.handlers.get('device-auth-status')(null).secure, false);
  assert.equal((await f.auth.enroll(f.app, { hub })).ok, false);
  assert.equal(f.state.requests.length, 0);
  f.state.login = false;
  assert.equal((await f.login()).ok, false);
  assert.deepEqual(fs.readFileSync(f.file), before);
  assert.deepEqual(fs.readFileSync(f.file + '.bak'), before);
  f.state.login = true;
  const result = await f.login();
  assert.equal(result.ok, true, JSON.stringify(result));
  const saved = JSON.parse(fs.readFileSync(f.file)).profiles[slot];
  assert.equal(saved.clientId, row.clientId); assert.equal(saved.createdAt, row.createdAt);
  assert.equal(saved.storage, 'electron-safe-storage');
  const backup = JSON.parse(fs.readFileSync(f.file + '.bak')).profiles[slot];
  assert.equal(backup.storage, 'electron-safe-storage');
  assert.equal(f.safeStorage.decryptString(Buffer.from(backup.cipher, 'base64')), secret);
  assert.equal(f.safeStorage.decryptString(Buffer.from(saved.cipher, 'base64')), secret);
  assert.ok(f.state.requests.every(request => request.key === secret && request.body.device === row.clientId));
  assert.equal(f.auth.identity(f.app).secret, secret);
});

for (const failure of ['encrypt', 'roundtrip', 'rename']) test('Linux migration preserves original on ' + failure + ' failure', async t => {
  const f = fixture(t), secret = crypto.randomBytes(32).toString('base64url');
  f.seed({ hub, clientId: 'soduwork-existing', cipher: Buffer.from(secret).toString('base64') });
  const before = fs.readFileSync(f.file);
  if (failure === 'encrypt') t.mock.method(f.safeStorage, 'encryptString', () => { throw Error('locked'); });
  if (failure === 'roundtrip') t.mock.method(f.safeStorage, 'decryptString', () => 'wrong-key');
  if (failure === 'rename') t.mock.method(fs, 'renameSync', () => { throw Error('write denied'); });
  assert.equal((await f.login()).ok, false);
  assert.deepEqual(fs.readFileSync(f.file), before);
  assert.deepEqual(fs.readdirSync(f.root), ['device-auth.json']);
});

test('legacy recognition never accepts marked rows, arbitrary plaintext or malformed Base64', t => {
  const f = fixture(t), store = credentials.create({ app: f.app, safeStorage: f.safeStorage });
  const valid = Buffer.from(crypto.randomBytes(32).toString('base64url')).toString('base64');
  for (const row of [{ cipher: valid, storage: 'electron-safe-storage' }, { cipher: valid, storage: '' }, { cipher: valid + '!' },
    { cipher: Buffer.from('v11-broken-native-ciphertext').toString('base64') }, { cipher: Buffer.from('password').toString('base64') }])
    assert.equal(store.legacySecret(row), '');
});

test('Linux migration refuses to overwrite an identity changed while login was in flight', async t => {
  const f = fixture(t), secret = crypto.randomBytes(32).toString('base64url');
  const row = { hub, clientId: 'soduwork-existing', cipher: Buffer.from(secret).toString('base64') };
  f.seed(row);
  const request = global.fetch;
  t.mock.method(global, 'fetch', async (url, options) => {
    const response = await request(url, options);
    if (url.endsWith('/login')) f.seed({ ...row, clientId: 'soduwork-replaced' });
    return response;
  });
  assert.equal((await f.login()).ok, false);
  const saved = JSON.parse(fs.readFileSync(f.file)).profiles[slot];
  assert.equal(saved.clientId, 'soduwork-replaced');
  assert.equal(saved.cipher, row.cipher);
});

test('Linux backup migration failure preserves both copies for a safe retry', async t => {
  const f = fixture(t), secret = crypto.randomBytes(32).toString('base64url');
  f.seed({ hub, clientId: 'soduwork-existing', cipher: Buffer.from(secret).toString('base64') });
  const before = fs.readFileSync(f.file); fs.writeFileSync(f.file + '.bak', before);
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === f.file + '.bak') throw Error('backup denied');
    return rename(from, to);
  });
  assert.equal((await f.login()).ok, false);
  assert.deepEqual(fs.readFileSync(f.file), before);
  assert.deepEqual(fs.readFileSync(f.file + '.bak'), before);
});

for (const marked of [false, true]) test('Linux v10 ' + (marked ? 'marked' : 'unmarked') + ' identity migrates only after explicit original-Hub login', async t => {
  const f = fixture(t), secret = crypto.randomBytes(32).toString('base64url');
  const row = { hub, clientId: 'soduwork-v10', cipher: f.legacyCipher(secret).toString('base64'),
    createdAt: 'fixture', ...(marked ? { storage: 'electron-safe-storage' } : {}) };
  f.seed(row); const before = fs.readFileSync(f.file); fs.writeFileSync(f.file + '.bak', before);
  // Native decrypt succeeds after the system keyring recovers, but v10 is
  // still fixed-password ciphertext and must not count as a secure identity.
  assert.equal(f.safeStorage.decryptString(Buffer.from(row.cipher, 'base64')), secret);
  assert.equal(f.auth.identity(f.app), null);
  assert.equal(f.handlers.get('device-auth-status')(null).secure, false);
  assert.equal((await f.auth.enroll(f.app, { hub })).ok, false);
  assert.equal(f.state.requests.length, 0);
  f.state.login = false;
  assert.equal((await f.login()).ok, false);
  assert.deepEqual(fs.readFileSync(f.file), before);
  assert.deepEqual(fs.readFileSync(f.file + '.bak'), before);
  f.state.login = true;
  assert.equal((await f.login()).ok, true);
  for (const file of [f.file, f.file + '.bak']) {
    const saved = JSON.parse(fs.readFileSync(file)).profiles[slot];
    assert.equal(saved.clientId, row.clientId); assert.equal(saved.createdAt, row.createdAt);
    assert.equal(saved.storage, 'electron-safe-storage');
    assert.equal(Buffer.from(saved.cipher, 'base64').subarray(0, 3).toString(), 'v11');
    assert.equal(f.safeStorage.decryptString(Buffer.from(saved.cipher, 'base64')), secret);
  }
  assert.ok(f.state.requests.every(request => request.key === secret && request.body.device === row.clientId));
  assert.equal(f.handlers.get('device-auth-status')(null).secure, true);
  f.install(); assert.equal(f.auth.identity(f.app).secret, secret);
});

test('Linux rejects damaged v10 instead of treating the ciphertext as plaintext or replacing the device', async t => {
  const f = fixture(t), cipher = f.legacyCipher(crypto.randomBytes(32).toString('base64url'));
  cipher[cipher.length - 1] ^= 1;
  f.seed({ hub, clientId: 'soduwork-v10', cipher: cipher.toString('base64') });
  const before = fs.readFileSync(f.file);
  assert.equal((await f.login()).ok, false);
  assert.equal(f.state.requests.length, 0);
  assert.deepEqual(fs.readFileSync(f.file), before);
});

for (const version of ['v10', 'v11']) test('Linux rejects unknown storage markers even for readable ' + version, async t => {
  const f = fixture(t), secret = crypto.randomBytes(32).toString('base64url');
  const cipher = version === 'v10' ? f.legacyCipher(secret) : f.safeStorage.encryptString(secret);
  f.seed({ hub, clientId: 'soduwork-unknown', cipher: cipher.toString('base64'), storage: 'future-or-unknown' });
  const before = fs.readFileSync(f.file);
  assert.equal(f.auth.identity(f.app), null);
  assert.equal((await f.login()).ok, false);
  assert.equal(f.state.requests.length, 0);
  assert.deepEqual(fs.readFileSync(f.file), before);
});

test('Linux refuses native encryption that unexpectedly returns v10 under a secure backend label', async t => {
  const f = fixture(t);
  t.mock.method(f.safeStorage, 'encryptString', secret => f.legacyCipher(secret));
  assert.equal((await f.login()).ok, false);
  assert.equal(fs.existsSync(f.file), false);
  assert.equal(f.state.requests.length, 0);
});

test('Linux upgrades a matching v10 backup even when the main identity is already v11', async t => {
  const f = fixture(t);
  assert.equal((await f.login()).ok, true);
  const id = f.auth.identity(f.app), backup = JSON.parse(fs.readFileSync(f.file));
  backup.profiles[slot].cipher = f.legacyCipher(id.secret).toString('base64');
  fs.writeFileSync(f.file + '.bak', JSON.stringify(backup));
  const before = fs.readFileSync(f.file);
  assert.equal((await f.login()).ok, true);
  assert.deepEqual(fs.readFileSync(f.file), before);
  const saved = JSON.parse(fs.readFileSync(f.file + '.bak')).profiles[slot];
  assert.equal(Buffer.from(saved.cipher, 'base64').subarray(0, 3).toString(), 'v11');
  assert.equal(f.safeStorage.decryptString(Buffer.from(saved.cipher, 'base64')), id.secret);
});

test('Linux healthy v11 login preserves an unreadable v10 backup without blocking the account', async t => {
  const f = fixture(t);
  assert.equal((await f.login()).ok, true);
  const id = f.auth.identity(f.app), backup = JSON.parse(fs.readFileSync(f.file));
  const damaged = f.legacyCipher(id.secret); damaged[damaged.length - 1] ^= 1;
  backup.profiles[slot].cipher = damaged.toString('base64');
  fs.writeFileSync(f.file + '.bak', JSON.stringify(backup));
  const before = fs.readFileSync(f.file), backupBefore = fs.readFileSync(f.file + '.bak');
  assert.equal((await f.login()).ok, true);
  assert.deepEqual(fs.readFileSync(f.file), before);
  assert.deepEqual(fs.readFileSync(f.file + '.bak'), backupBefore);
  assert.deepEqual(f.auth.identity(f.app), id);
});

test('Linux resumes v10 migration after the backup commits but the primary rename fails', async t => {
  const f = fixture(t), secret = crypto.randomBytes(32).toString('base64url');
  f.seed({ hub, clientId: 'soduwork-v10', cipher: f.legacyCipher(secret).toString('base64') });
  const before = fs.readFileSync(f.file); fs.writeFileSync(f.file + '.bak', before);
  const rename = fs.renameSync;
  const intercepted = t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === f.file) throw Error('primary denied');
    return rename(from, to);
  });
  assert.equal((await f.login()).ok, false);
  assert.deepEqual(fs.readFileSync(f.file), before);
  const backup = JSON.parse(fs.readFileSync(f.file + '.bak')).profiles[slot];
  assert.equal(Buffer.from(backup.cipher, 'base64').subarray(0, 3).toString(), 'v11');
  assert.equal(f.safeStorage.decryptString(Buffer.from(backup.cipher, 'base64')), secret);
  intercepted.mock.restore();
  assert.equal((await f.login()).ok, true);
  assert.equal(f.auth.identity(f.app).clientId, 'soduwork-v10');
  assert.equal(f.auth.identity(f.app).secret, secret);
});
