'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('../main/local-model-store.cjs');
const modelConfig = require('../main/pi-session/model-config');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-local-model-'));
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(value, 'utf8'),
    decryptString: value => Buffer.from(value).toString('utf8'),
  };
  store.configure({ app: { getPath: () => root }, safeStorage });
  return { root, safeStorage };
}

test('local model configuration is encrypted and resolves without a Hub identity', async t => {
  const f = fixture();
  t.after(() => { store.configure(null); fs.rmSync(f.root, { recursive: true, force: true }); });
  const saved = store.save({ providers: [{ id: 'local', name: 'Local', baseUrl: 'http://127.0.0.1:8686/v1', authMode: 'none', localOnly: true }],
    models: [{ providerId: 'local', name: 'llama3', label: 'Llama 3', modality: 'chat', localOnly: true }], keys: {} });
  assert.match(saved.usable[0].name, /^local:model-[a-f0-9]{32}$/);
  assert.equal(store.canonicalReference('local:local:llama3'), saved.usable[0].name);
  assert.equal(fs.readFileSync(path.join(f.root, 'local-models.secure.json'), 'utf8').includes('llama3'), false);
  const resolved = store.resolve('local:local:llama3');
  assert.equal(resolved.baseUrl, 'http://127.0.0.1:8686/v1');
  const result = await modelConfig.fetchModel(null, 'local:local:llama3');
  assert.equal(result.ok, true);
  assert.equal(result.localOnly, true);
  assert.equal(result.model.baseUrl, resolved.baseUrl);
});

test('local provider URLs cannot embed credentials', async t => {
  const f = fixture();
  t.after(() => { store.configure(null); fs.rmSync(f.root, { recursive: true, force: true }); });
  assert.throws(() => store.save({ providers: [{
    id: 'local', name: 'Local', baseUrl: 'http://user:secret@127.0.0.1:8686/v1', authMode: 'none',
  }], models: [], keys: {} }), /API 地址/);
  assert.equal(fs.existsSync(path.join(f.root, 'local-models.secure.json')), false);
});

test('long Unicode local model references survive creation, selection and saved preferences', async t => {
  const f = fixture();
  t.after(() => { store.configure(null); fs.rmSync(f.root, { recursive: true, force: true }); });
  const providerId = 'p'.repeat(48), name = '模'.repeat(160), modelRef = store.ref(providerId, name);
  store.save({ providers: [{ id: providerId, baseUrl: 'http://127.0.0.1:8686/v1', authMode: 'none' }],
    models: [{ providerId, name, label: name }] });
  assert.ok(modelRef.length > 300 && modelRef.length < 1500);
  const spec = require('../main/conversation/session-spec').build({ modelName: modelRef }, {}, { cwd: f.root });
  assert.equal(spec.modelName, modelRef);
  const selection = require('../main/conversation/model-selection');
  const preference = selection.preference({ getPath: () => f.root }, 'long-local-ref');
  const opaque = store.canonicalReference(modelRef);
  const current = selection.create({ resolve: ref => modelConfig.fetchModel(null, ref),
    persist: ref => preference.write(ref), apply: model => {
      assert.equal(model.id, opaque);
      assert.equal(model.wireModelId, name);
    } });
  assert.equal((await current.select(spec.modelName)).ok, true);
  await current.applyForTurn();
  assert.equal(current.capture(), opaque);
  assert.equal(preference.read(), opaque);
  assert.equal(store.resolve(preference.read()).name, name);
  assert.equal((await current.select('x'.repeat(301))).ok, false);
  assert.equal((await current.select('local:' + 'x'.repeat(1500))).ok, false);
});

test('invalid local edits reject atomically instead of truncating or dropping stored configuration', t => {
  const f = fixture();
  t.after(() => { store.configure(null); fs.rmSync(f.root, { recursive: true, force: true }); });
  const provider = { id: 'local', name: 'Local', baseUrl: 'http://127.0.0.1:8686/v1', authMode: 'key' };
  const model = { providerId: 'local', name: 'qwen3' };
  store.save({ providers: [provider], models: [model], keys: { local: 'original-key' } });
  const target = path.join(f.root, 'local-models.secure.json'), before = fs.readFileSync(target, 'utf8');
  const edits = [
    { providers: null }, { providers: {} }, { providers: [null] }, { providers: [provider, provider] },
    { providers: [{ ...provider, id: 'p'.repeat(49) }] }, { providers: [{ ...provider, kind: 'anthropic' }] },
    { providers: [{ ...provider, baseUrl: 'not-a-url' }] }, { providers: [{ ...provider, baseUrl: provider.baseUrl + '?key=private' }] },
    { providers: [{ ...provider, authMode: 'unsupported' }] },
    { providers: Array.from({ length: 51 }, (_, index) => ({ ...provider, id: 'provider' + index })) },
    { models: null }, { models: [model, model] }, { models: [{ ...model, providerId: 'missing' }] },
    { models: [{ ...model, name: 'm'.repeat(161) }] }, { models: [{ ...model, name: 'invalid-\ud800' }] },
    { models: [{ ...model, modality: 'unsupported' }] },
    { models: Array.from({ length: 201 }, (_, index) => ({ ...model, name: 'model' + index })) },
    { keys: [] }, { keys: { local: 'k'.repeat(401) } }, { keys: { local: {} } }, { keys: { missing: 'private-key' } },
  ];
  for (const edit of edits) {
    assert.throws(() => store.save(edit), /本地模型配置无效/);
    assert.equal(fs.readFileSync(target, 'utf8'), before);
  }
  assert.equal(store.resolve('local:local:qwen3').key, 'original-key');
  assert.equal(store.get().revision, 1);
});

test('invalid encrypted snapshots are preserved and cannot be normalized into a destructive save', t => {
  const f = fixture();
  t.after(() => { store.configure(null); fs.rmSync(f.root, { recursive: true, force: true }); });
  const target = path.join(f.root, 'local-models.secure.json');
  for (const value of [
    { schema: 1 },
    { schema: 1, revision: 1, providers: [{ id: 'local', baseUrl: 'broken' }], models: [], keys: {} },
    { schema: 1, revision: 1, providers: [], models: [{ providerId: 'missing', name: 'saved-model' }], keys: {} },
  ]) {
    const before = JSON.stringify({ schema: 1, cipher: Buffer.from(JSON.stringify(value)).toString('base64') });
    fs.writeFileSync(target, before);
    assert.throws(() => store.get(), /本地模型配置无法读取/);
    assert.throws(() => store.save({ providers: [], models: [] }), /本地模型配置无法读取/);
    assert.equal(fs.readFileSync(target, 'utf8'), before);
  }
});

test('provider removal intentionally deletes only its models and credentials', t => {
  const f = fixture();
  t.after(() => { store.configure(null); fs.rmSync(f.root, { recursive: true, force: true }); });
  const providers = ['first', 'second'].map(id => ({ id, baseUrl: 'http://127.0.0.1:8686/v1' }));
  store.save({ providers, models: providers.map(provider => ({ providerId: provider.id, name: 'model' })),
    keys: { first: 'first-key', second: 'second-key' } });
  const saved = store.save({ providers: [providers[1]], expectedRevision: 1 });
  assert.equal(saved.revision, 2);
  assert.deepEqual(saved.myModels.map(model => model.providerId), ['second']);
  assert.deepEqual(Object.keys(store._readRaw().keys), ['second']);
  assert.equal(store.resolve('local:second:model').key, 'second-key');
  assert.equal(store.resolve('local:first:model'), null);
  assert.equal(store.resolve('local::model'), null);
  assert.equal(store.resolve('local:second:%E0%A4%A'), null);
});

test('prototype property names never masquerade as configured local credentials', t => {
  const f = fixture();
  t.after(() => { store.configure(null); fs.rmSync(f.root, { recursive: true, force: true }); });
  store.save({ providers: [{ id: 'constructor', baseUrl: 'http://127.0.0.1:8686/v1' }],
    models: [{ providerId: 'constructor', name: 'qwen3' }] });
  assert.equal(store.get().providers[0].keySet, false);
  assert.deepEqual(store.get().usable, []);
  assert.equal(store.resolve('local:constructor:qwen3'), null);
  store.save({ keys: { constructor: 'fixture-key' } });
  assert.equal(store.resolve('local:constructor:qwen3').key, 'fixture-key');
});

test('local connection test discovers OpenAI-compatible model IDs directly', async t => {
  const f = fixture();
  t.after(() => { store.configure(null); fs.rmSync(f.root, { recursive: true, force: true }); });
  store.save({ providers: [{ id: 'local', name: 'Local', baseUrl: 'http://127.0.0.1:8686/v1', authMode: 'none' }], models: [], keys: {} });
  const calls = [];
  const result = await store.test('local', '', async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ data: [{ id: 'qwen3' }, { id: 'llama3' }] }), { status: 200 });
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.models, ['qwen3', 'llama3']);
  assert.equal(calls[0].url, 'http://127.0.0.1:8686/v1/models');
  assert.equal('Authorization' in calls[0].options.headers, false);
});

test('model discovery merges with a concurrent local edit', async t => {
  const f = fixture();
  t.after(() => { store.configure(null); fs.rmSync(f.root, { recursive: true, force: true }); });
  store.save({ providers: [{ id: 'local', name: 'Before', baseUrl: 'http://127.0.0.1:8686/v1', authMode: 'none' }],
    models: [], keys: {} });
  let release;
  const pending = store.test('local', '', async () => new Promise(resolve => { release = resolve; }));
  await new Promise(resolve => setImmediate(resolve));
  store.save({ providers: [{ id: 'local', name: 'After', baseUrl: 'http://127.0.0.1:8686/v1', authMode: 'none' }],
    models: [], keys: {} });
  release(new Response(JSON.stringify({ data: [{ id: 'qwen3' }] }), { status: 200 }));
  assert.equal((await pending).ok, true);
  const current = store._readRaw();
  assert.equal(current.providers[0].name, 'After');
  assert.equal(current.models[0].name, 'qwen3');
});

test('discovery cannot validate or populate a provider after its credential changes', async t => {
  const f = fixture();
  t.after(() => { store.configure(null); fs.rmSync(f.root, { recursive: true, force: true }); });
  store.save({ providers: [{ id: 'local', baseUrl: 'http://127.0.0.1:8686/v1', authMode: 'key' }],
    models: [], keys: { local: 'old-key' } });
  let release;
  const pending = store.test('local', '', async (url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer old-key');
    return new Promise(resolve => { release = resolve; });
  });
  await new Promise(resolve => setImmediate(resolve));
  store.save({ keys: { local: 'new-key' }, expectedRevision: 1 });
  release(new Response(JSON.stringify({ data: [{ id: 'old-account-model' }] }), { status: 200 }));
  const result = await pending;
  assert.equal(result.ok, false);
  assert.match(result.detail, /已变化/);
  assert.deepEqual(store.get().myModels, []);
  assert.equal(store.get().revision, 2);
  assert.equal(store._readRaw().keys.local, 'new-key');
});

test('discovery filters invalid IDs and preserves the complete existing catalog at capacity', async t => {
  const f = fixture();
  t.after(() => { store.configure(null); fs.rmSync(f.root, { recursive: true, force: true }); });
  const existing = Array.from({ length: 199 }, (_, index) => ({ providerId: 'local', name: 'existing-' + index }));
  store.save({ providers: [{ id: 'local', baseUrl: 'http://127.0.0.1:8686/v1', authMode: 'none' }], models: existing });
  const longId = 'valid-'.repeat(20);
  const result = await store.test('local', '', async () => new Response(JSON.stringify({ data: [
    { id: { invalid: true } }, { id: 'invalid\nmodel' }, { id: 'm'.repeat(161) },
    { id: longId }, { id: longId }, { id: 'another-new-model' },
  ] }), { status: 200 }));
  assert.equal(result.ok, true);
  assert.match(result.detail, /200/);
  assert.deepEqual(result.models, [longId, 'another-new-model']);
  const current = store.get();
  assert.equal(current.myModels.length, 200);
  assert.deepEqual(current.myModels.slice(0, 199).map(model => model.name), existing.map(model => model.name));
  assert.equal(current.myModels[199].name, longId);
  assert.equal(current.myModels[199].label, longId.slice(0, 80));
  const target = path.join(f.root, 'local-models.secure.json'), before = fs.readFileSync(target, 'utf8');
  await store.test('local', '', async () => new Response(JSON.stringify({ data: [{ id: 'new-model' }] }), { status: 200 }));
  assert.equal(fs.readFileSync(target, 'utf8'), before);
});

test('chat fallback does not report an outdated credential as a successful connection', async t => {
  const f = fixture();
  t.after(() => { store.configure(null); fs.rmSync(f.root, { recursive: true, force: true }); });
  store.save({ providers: [{ id: 'local', baseUrl: 'http://127.0.0.1:8686/v1' }],
    models: [{ providerId: 'local', name: 'qwen3' }], keys: { local: 'old-key' } });
  const result = await store.test('local', 'qwen3', async url => {
    if (url.endsWith('/models')) return new Response('{}', { status: 404 });
    store.save({ keys: { local: 'new-key' } });
    return new Response('{}', { status: 200 });
  });
  assert.equal(result.ok, false);
  assert.match(result.detail, /已变化/);
  assert.equal(store.resolve('local:local:qwen3').key, 'new-key');
});

test('local sessions prepare without Hub identity or MCP configuration', async t => {
  const f = fixture();
  const oldProxyKey = process.env.SODUWORK_PROXY_KEY, oldMcpKey = process.env.SODUWORK_MCP_KEY,
    oldMcpServers = process.env.SODUWORK_MCP_SERVERS, oldHubOrigin = process.env.SODUWORK_HUB_ORIGIN;
  process.env.SODUWORK_PROXY_KEY = 'stale-hub-key';
  process.env.SODUWORK_MCP_KEY = 'stale-mcp-key';
  process.env.SODUWORK_MCP_SERVERS = '/tmp/stale-mcp.json';
  process.env.SODUWORK_HUB_ORIGIN = 'https://stale-hub.example.test';
  t.after(() => {
    store.configure(null); fs.rmSync(f.root, { recursive: true, force: true });
    if (oldProxyKey == null) delete process.env.SODUWORK_PROXY_KEY; else process.env.SODUWORK_PROXY_KEY = oldProxyKey;
    if (oldMcpKey == null) delete process.env.SODUWORK_MCP_KEY; else process.env.SODUWORK_MCP_KEY = oldMcpKey;
    if (oldMcpServers == null) delete process.env.SODUWORK_MCP_SERVERS; else process.env.SODUWORK_MCP_SERVERS = oldMcpServers;
    if (oldHubOrigin == null) delete process.env.SODUWORK_HUB_ORIGIN; else process.env.SODUWORK_HUB_ORIGIN = oldHubOrigin;
  });
  store.save({ providers: [{ id: 'local', name: 'Local', baseUrl: 'http://127.0.0.1:8686/v1', authMode: 'none' }],
    models: [{ providerId: 'local', name: 'qwen3' }], keys: {} });
  const result = await modelConfig.prepare({ getPath: () => f.root }, null, 'local:local:qwen3');
  assert.equal(result.ok, true);
  assert.equal(result.mcpServers, '');
  assert.equal(result.model.localOnly, true);
  assert.equal(result.model.id, store.canonicalReference('local:local:qwen3'));
  assert.equal(result.model.wireModelId, 'qwen3');
  assert.equal(modelConfig.configuredModel({ getPath: () => f.root }), store.canonicalReference('local:local:qwen3'));
  assert.equal(process.env.SODUWORK_PROXY_KEY, undefined);
  assert.equal(process.env.SODUWORK_MCP_KEY, undefined);
  assert.equal(process.env.SODUWORK_MCP_SERVERS, undefined);
  assert.equal(process.env.SODUWORK_HUB_ORIGIN, undefined);
  const models = JSON.parse(fs.readFileSync(path.join(f.root, 'pi-agent', 'models.json'), 'utf8'));
  assert.equal(models.providers.soduwork.apiKey, 'soduwork-local-no-key');
  store.save({ providers: [], models: [], keys: {} });
  assert.equal(modelConfig.configuredModel({ getPath: () => f.root }), '');
});

test('agent runtime resolves local credentials through the trusted desktop host', async t => {
  const f = fixture();
  const runtimeContext = require('../main/agent-runtime/process-context');
  const previous = runtimeContext.current;
  t.after(() => { runtimeContext.current = previous; store.configure(null); fs.rmSync(f.root, { recursive: true, force: true }); });
  store.save({ providers: [{ id: 'local', name: 'Local', baseUrl: 'http://127.0.0.1:8686/v1', authMode: 'key' }],
    models: [{ providerId: 'local', name: 'qwen3' }], keys: { local: 'secret' } });
  let calls = 0;
  runtimeContext.current = () => ({ localModel: async ref => {
    calls++;
    assert.equal(ref, 'local:local:qwen3');
    return store.resolve(ref);
  } });
  const result = await modelConfig.fetchModel(null, 'local:local:qwen3');
  assert.equal(result.ok, true);
  assert.equal(result.model.key, 'secret');
  assert.equal(calls, 1);
});
