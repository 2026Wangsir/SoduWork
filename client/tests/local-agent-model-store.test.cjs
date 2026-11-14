'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const store = require('../main/local-agent-model-store.cjs');
const { install } = require('../main/local-agent-model-ipc.cjs');
const scope = { hub: 'https://fixture.invalid', clientId: 'device', owner: 'owner-a' };
const model = 'local:model-0123456789abcdef0123456789abcdef';
const second = 'local:model-abcdef0123456789abcdef0123456789';
const managed = ['pi', 'qwen', 'opencode', 'dsh', 'kimi', 'harness2', 'codex-harness'];
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-agent-models-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const key = crypto.randomBytes(32);
  const safeStorage = { isEncryptionAvailable: () => true,
    encryptString(value) { const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]); },
    decryptString(value) { const decipher = crypto.createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(12, 28)); return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8'); },
  };
  const app = { getPath: () => root }, rows = [{ name: model, label: 'Private model', localOnly: true, modality: 'chat' },
    { name: second, label: 'Other model', localOnly: true, modality: 'chat' }];
  const modelStore = { get: () => ({ usable: rows }), resolve: name => rows.some(row => row.name === name)
    ? { name: 'private-wire', modelRef: name, baseUrl: 'http://private.invalid/v1', key: 'private-secret', provider: 'private-provider', modality: 'chat' } : null,
    test: async () => ({ ok: true }) };
  store.configure({ app, safeStorage, modelStore });
  let owner = { ...scope }, changes = 0;
  const handlers = new Map(), frame = { url: pathToFileURL(path.resolve(__dirname, '../desk.html')).href };
  const event = { senderFrame: frame, sender: { mainFrame: frame, getURL: () => frame.url } };
  install({ app, safeStorage, modelStore, ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    scopeOf: () => owner, changed: () => { changes++; } });
  return { root, app, safeStorage, rows, modelStore, event,
    changes: () => changes, owner: value => { owner = value; },
    call: (action, input = {}, selectedEvent = event) => handlers.get('local-agent-models-' + action)(selectedEvent, input) };
}

test('Agent defaults use authenticated Hub/device/account scopes and encrypted atomic storage', t => {
  const f = fixture(t);
  for (const id of managed) {
    const value = store.set({ ...scope, agentId: id, modelName: model });
    assert.equal(value.configured, true); assert.equal(value.unavailable, false); assert.equal(value.modelName, model);
  }
  for (const other of [{ ...scope, owner: 'owner-b' }, { ...scope, clientId: 'other-device' }, { ...scope, hub: 'https://other.invalid' }]) {
    assert.equal(store.get({ ...other, agentId: 'qwen' }).configured, false);
  }
  const file = path.join(f.root, 'agent-models.secure.json'), raw = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(raw, /local:model-|owner-a|fixture.invalid|private-wire|private-secret/);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(f.root), ['agent-models.secure.json']);
  assert.equal(store.remove({ ...scope, agentId: 'qwen' }).configured, false);
  assert.equal(store.get({ ...scope, agentId: 'pi' }).configured, true);
});

test('account runtimes, managed names, malformed scopes and stale writes cannot change local defaults', t => {
  fixture(t);
  for (const id of ['codex', 'claude']) assert.throws(() => store.set({ ...scope, agentId: id, modelName: model }), /账号型/);
  assert.throws(() => store.set({ ...scope, agentId: 'qwen', modelName: 'managed-model' }), /本地模型/);
  assert.throws(() => store.set({ ...scope, hub: 'https://fixture.invalid/private', agentId: 'qwen', modelName: model }), /作用域/);
  assert.throws(() => store.set({ ...scope, owner: '', agentId: 'qwen', modelName: model }), /作用域/);
  const saved = store.set({ ...scope, agentId: 'qwen', modelName: model, expectedRevision: 0 });
  assert.throws(() => store.set({ ...scope, agentId: 'qwen', modelName: second, expectedRevision: 0 }), error => error.code === 'LOCAL_AGENT_MODEL_CONFLICT');
  assert.throws(() => store.remove({ ...scope, agentId: 'qwen', expectedRevision: 0 }), error => error.code === 'LOCAL_AGENT_MODEL_CONFLICT');
  assert.equal(store.get({ ...scope, agentId: 'qwen' }).revision, saved.revision);
  assert.equal(store.get({ ...scope, agentId: 'qwen' }).modelName, model);
});

test('deleting a default model leaves its original reference explicitly unavailable until reselection', t => {
  const f = fixture(t);
  store.set({ ...scope, agentId: 'qwen', modelName: model });
  f.rows.splice(0, 1);
  const gone = store.get({ ...scope, agentId: 'qwen' });
  assert.equal(gone.modelName, model); assert.equal(gone.configured, true); assert.equal(gone.unavailable, true);
  assert.match(gone.label, /已删除或不可用/);
  assert.throws(() => store.set({ ...scope, agentId: 'qwen', modelName: model }), /已删除或不可用/);
  assert.equal(store.set({ ...scope, agentId: 'qwen', modelName: second }).modelName, second);
});

test('secure-store failure and corrupted ciphertext preserve the previous file and fail closed', t => {
  const f = fixture(t); store.set({ ...scope, agentId: 'qwen', modelName: model });
  const file = path.join(f.root, 'agent-models.secure.json'), before = fs.readFileSync(file);
  f.safeStorage.isEncryptionAvailable = () => false;
  assert.throws(() => store.get({ ...scope, agentId: 'qwen' }), /安全存储/);
  assert.throws(() => store.remove({ ...scope, agentId: 'qwen' }), /安全存储/);
  assert.deepEqual(fs.readFileSync(file), before);
  f.safeStorage.isEncryptionAvailable = () => true;
  fs.writeFileSync(file, JSON.stringify({ schema: 1, cipher: 'corrupted' }));
  assert.throws(() => store.get({ ...scope, agentId: 'qwen' }), /无法解密/);
  assert.throws(() => store.set({ ...scope, agentId: 'qwen', modelName: second }), /无法解密/);
});

test('runtime identity lookup shares the IPC owner fingerprint and ignores session renewal', t => {
  fixture(t);
  const identity = { hub: scope.hub, clientId: scope.clientId, session: '' };
  const now = Math.floor(Date.now() / 1000);
  const token = iat => Buffer.from(JSON.stringify({ typ: 'device', uid: 'account-a', cid: identity.clientId, iat, exp: now + 3600 })).toString('base64url') + '.' + 'a'.repeat(64);
  identity.session = token(now - 2);
  const owned = store.scopeFromIdentity(identity);
  store.set({ ...owned, agentId: 'qwen', modelName: model });
  identity.session = token(now - 1);
  assert.equal(store.fromIdentity(identity, 'qwen').modelName, model);
  assert.equal(owned.owner, require('../main/platform-connections/runtime.cjs').scope(identity));
});

test('IPC mutations require the current host-issued scope and reject subframes and foreign pages', t => {
  const f = fixture(t), snapshot = f.call('get');
  assert.throws(() => f.call('set', { agentId: 'qwen', modelName: model }), error => error.code === 'LOCAL_AGENT_MODEL_SCOPE_CHANGED');
  f.owner({ ...scope, owner: 'owner-b' });
  assert.throws(() => f.call('set', { scopeKey: snapshot.scopeKey, agentId: 'qwen', modelName: model }), error => error.code === 'LOCAL_AGENT_MODEL_SCOPE_CHANGED');
  assert.deepEqual(f.call('get').models, {});
  const foreign = { senderFrame: { url: f.event.senderFrame.url }, sender: f.event.sender };
  assert.throws(() => f.call('get', {}, foreign), /主工作台/);
  const page = { url: 'https://plugin.invalid/' };
  assert.throws(() => f.call('get', {}, { senderFrame: page, sender: { mainFrame: page } }), /主工作台/);
});

test('local probes use only the selected provider and never return private endpoint or error details', async t => {
  const f = fixture(t); store.set({ ...scope, agentId: 'qwen', modelName: model });
  const snapshot = f.call('get'), calls = [];
  f.modelStore.test = async (...args) => { calls.push(args); return { ok: false, detail: 'private-secret http://private.invalid/v1 private-wire' }; };
  const result = await f.call('probe', { scopeKey: snapshot.scopeKey, agentId: 'qwen' });
  assert.equal(result.probeKind, 'model-connectivity'); assert.equal(result.ok, false);
  assert.deepEqual(calls[0].slice(0, 2), ['private-provider', 'private-wire']);
  assert.doesNotMatch(JSON.stringify(result), /private-secret|private.invalid|private-wire/);
  f.rows.splice(0, 1);
  const missing = await f.call('probe', { scopeKey: snapshot.scopeKey, agentId: 'qwen' });
  assert.equal(missing.unavailable, true); assert.equal(calls.length, 1);
});

for (const change of ['account', 'default']) test('late local probe results cannot validate another ' + change, async t => {
  const f = fixture(t), wait = deferred(); store.set({ ...scope, agentId: 'qwen', modelName: model });
  f.modelStore.test = () => wait.promise;
  const pending = f.call('probe', { scopeKey: f.call('get').scopeKey, agentId: 'qwen' });
  if (change === 'account') f.owner({ ...scope, owner: 'owner-b' });
  else store.set({ ...scope, agentId: 'qwen', modelName: second });
  wait.resolve({ ok: true });
  await assert.rejects(pending, error => error.code === (change === 'account' ? 'LOCAL_AGENT_MODEL_SCOPE_CHANGED' : 'LOCAL_AGENT_MODEL_CONFLICT'));
  assert.equal(f.changes(), 0);
});

test('the existing local model probe reaches a real loopback provider without Hub or Runner traffic', async t => {
  const f = fixture(t), localModels = require('../main/local-model-store.cjs'), http = require('node:http');
  const requests = [], server = http.createServer((req, res) => {
    let body = ''; req.on('data', chunk => { body += chunk; }); req.on('end', () => {
      requests.push({ url: req.url, method: req.method, authorization: req.headers.authorization, body });
      if (req.url === '/v1/models') { res.writeHead(404); res.end('{}'); }
      else { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] })); }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  localModels.configure({ app: f.app, safeStorage: f.safeStorage });
  const catalog = localModels.save({ providers: [{ id: 'provider', name: 'Loopback', kind: 'openai-compat',
    baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1', authMode: 'key' }],
    models: [{ providerId: 'provider', name: 'loopback-wire', label: 'Loopback' }], keys: { provider: 'synthetic-private-key' } });
  const handlers = new Map();
  install({ app: f.app, safeStorage: f.safeStorage, modelStore: localModels, scopeOf: () => scope,
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) } });
  const call = (action, value) => handlers.get('local-agent-models-' + action)(f.event, value);
  const initial = call('get', {});
  call('set', { scopeKey: initial.scopeKey, agentId: 'qwen', modelName: catalog.usable[0].name, expectedRevision: initial.revision });
  const result = await call('probe', { scopeKey: initial.scopeKey, agentId: 'qwen' });
  assert.equal(result.ok, true); assert.match(result.detail, /未执行 Agent 任务/);
  assert.deepEqual(requests.map(row => row.url), ['/v1/models', '/v1/chat/completions']);
  assert.equal(JSON.parse(requests[1].body).model, 'loopback-wire');
  assert.equal(requests[1].authorization, 'Bearer synthetic-private-key');
  assert.doesNotMatch(JSON.stringify(result), /127\.0\.0\.1|synthetic-private-key|loopback-wire/);
});
