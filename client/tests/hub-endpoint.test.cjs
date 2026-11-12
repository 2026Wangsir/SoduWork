'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const endpoint = require('../main/hub-endpoint.cjs');
const { createSafeStorage } = require('./helpers/device-safe-storage-fixture.cjs');
const production = endpoint.PRODUCTION_HUB;
function appAt(profile, packaged = false, appData = path.dirname(profile)) {
  return { isPackaged: packaged, getPath: name => name === 'userData' ? profile : appData };
}

test('packaged and source clients default to a local Hub and allow explicit configuration', () => {
  for (const packaged of [false, true]) {
    const app = appAt(path.resolve('fixture-profile'), packaged);
    assert.deepEqual(endpoint.initialize(app, { SODUWORK_HUB_URL: 'http://localhost:9080' }), { hub: production, internalTest: false, editable: true });
    assert.equal(endpoint.accepts(app, 'http://localhost:9080'), false);
  }
  const app = appAt(path.resolve('fixture-profile'), true);
  assert.equal(endpoint.initialize(app, { SODUWORK_TEST_HUB_URL: 'http://localhost:9080', SODUWORK_USER_DATA: app.getPath('userData') }).hub, production);
});

test('internal loopback override requires unpackaged execution and a separate profile', () => {
  const root = path.resolve('fixture-only'), profile = path.join(root, 'isolated');
  const app = appAt(profile, false, root);
  assert.deepEqual(endpoint.initialize(app, { SODUWORK_TEST_HUB_URL: 'http://127.0.0.1:54321', SODUWORK_USER_DATA: profile }),
    { hub: 'http://127.0.0.1:54321', internalTest: true, editable: false });
  for (const url of ['https://remote.example.com', 'http://user:pass@localhost:54321', 'http://localhost:54321/api', 'file:///C:/']) {
    assert.throws(() => endpoint.initialize(app, { SODUWORK_TEST_HUB_URL: url, SODUWORK_USER_DATA: profile }));
  }
  assert.throws(() => endpoint.initialize(app, { SODUWORK_TEST_HUB_URL: 'http://localhost:54321' }));
  assert.throws(() => endpoint.initialize(app, { SODUWORK_TEST_HUB_URL: 'http://localhost:54321', SODUWORK_USER_DATA: root }));
  for (const name of ['SoduWork', 'soduwork']) {
    const installed = path.join(root, name);
    assert.throws(() => endpoint.initialize(appAt(installed, false, root), { SODUWORK_TEST_HUB_URL: 'http://localhost:54321', SODUWORK_USER_DATA: installed }));
  }
});

test('main identity isolates legacy Hub credentials until explicit selection, including packaged restarts', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-fixed-hub-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = appAt(root, true), handlers = new Map(), requests = [];
  const auth = require('../main/device-auth');
  auth.install({ app, ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, safeStorage: createSafeStorage() });
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => { requests.push({ url, options }); return { ok: true, status: 200,
    text: async () => JSON.stringify({ authState: 'pending', activationRequired: true }) }; };
  t.after(() => { global.fetch = originalFetch; });
  await auth.enroll(app, { hub: production });
  const productIdentity = auth.identity(app);
  await auth.enroll(app, { hub: 'http://localhost:18989', clientId: 'old-local-device', legacySecret: 'old-local-secret' });
  const oldIdentity = auth.identity(app), file = path.join(root, 'device-auth.json');
  const before = fs.readFileSync(file, 'utf8'), calls = requests.length;
  assert.notEqual(productIdentity.secret, oldIdentity.secret);
  endpoint.initialize(app, {});
  assert.deepEqual(auth.identity(app), productIdentity);
  assert.equal(auth.identity(app, oldIdentity.hub), null);
  assert.equal((await handlers.get('device-auth-bootstrap')(null, { hub: oldIdentity.hub })).ok, false);
  assert.equal((await handlers.get('device-auth-login')(null, { hub: oldIdentity.hub, account: 'fixture', password: 'fixture' })).ok, false);
  assert.equal(requests.length, calls); assert.equal(fs.readFileSync(file, 'utf8'), before);
  const empty = appAt(path.join(root, 'empty'), true);
  const legacyDoc = JSON.parse(before);
  for (const [key, row] of Object.entries(legacyDoc.profiles)) if (row.hub === production) delete legacyDoc.profiles[key];
  fs.mkdirSync(empty.getPath('userData'));
  fs.writeFileSync(path.join(empty.getPath('userData'), 'device-auth.json'), JSON.stringify(legacyDoc));
  endpoint.initialize(empty, {}); assert.equal(auth.identity(empty), null);
  assert.equal(auth.selectHub(app, oldIdentity.hub).ok, true);
  assert.equal(endpoint.current(app).hub, oldIdentity.hub);
  assert.deepEqual(auth.identity(app), oldIdentity);
  const restarted = appAt(root, true);
  assert.equal(endpoint.initialize(restarted, {}).hub, oldIdentity.hub);
  assert.deepEqual(auth.identity(restarted), oldIdentity);
});


test('current branded test overrides retain isolation and cannot override a packaged Hub', () => {
  const root = path.resolve('soduwork-fixture-only'), profile = path.join(root, 'isolated');
  const env = { SODUWORK_TEST_HUB_URL: 'http://127.0.0.1:54321', SODUWORK_USER_DATA: profile };
  assert.equal(endpoint.initialize(appAt(profile, false, root), env).hub, 'http://127.0.0.1:54321');
  assert.equal(endpoint.initialize(appAt(profile, true, root), env).hub, production);
  assert.throws(() => endpoint.initialize(appAt(profile, false, root), { ...env, SODUWORK_TEST_HUB_URL: 'https://remote.invalid' }));
});
