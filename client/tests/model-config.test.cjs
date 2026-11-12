'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('./renderer-source.cjs');
const path = require('node:path');
const vm = require('node:vm');
const os = require('node:os');
const fsNode = require('node:fs');
const root = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

async function fetchDeclaredModel(metadata) {
  return require('../main/pi-session/model-config').fetchModel(
    { hub: 'https://hub.example.test', clientId: 'device-1', session: 'device-session' },
    'managed-alias', 8000,
    async () => new Response(JSON.stringify({ ok: true, key: 'fixture', model: 'managed-alias', ...metadata }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }),
    false, 'harness2');
}

test('model configuration deadline recognizes runtime RPC cancellation without reporting quota exhaustion', async t => {
  const { MessageChannel } = require('node:worker_threads');
  const { createRpcPeer } = require('../main/agent-runtime/process-rpc');
  const { port1, port2 } = new MessageChannel();
  const caller = createRpcPeer({ send: packet => port1.postMessage(packet) });
  const host = createRpcPeer({ send: packet => port2.postMessage(packet), handlers: {
    authRequest() { return new Promise(resolve => this.signal.addEventListener('abort', () => resolve(null), { once: true })); },
  } });
  port1.on('message', packet => caller.receive(packet));
  port2.on('message', packet => host.receive(packet));
  t.after(() => { caller.close(); host.close(); port1.close(); port2.close(); });
  const result = await require('../main/pi-session/model-config').fetchModel(
    { hub: 'https://hub.example.test', clientId: 'device-timeout', session: 'device-session' },
    'managed-alias', 30, (_url, options) => caller.call('authRequest', [], { signal: options.signal }));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'MODEL_CONFIG_TIMEOUT');
  assert.equal(result.reason, '服务响应超时，可稍后重试');
  assert.equal(require('../core/token-quota').detail(result), null);
  assert.equal(Object.hasOwn(result, 'quota'), false);
  assert.doesNotMatch(result.reason, /Runtime request aborted/);
});

test('only the configuration deadline is a timeout; independent cancellation and quota refusals remain distinct', async () => {
  const { fetchModel } = require('../main/pi-session/model-config');
  const identity = { hub: 'https://hub.example.test', clientId: 'device-errors', session: 'device-session' };
  const cancelled = await fetchModel(identity, 'managed-alias', 1000, async () => {
    throw Object.assign(Error('Runtime caller cancelled the request'), { name: 'RpcError', code: 'RPC_ABORTED' });
  });
  assert.equal(cancelled.ok, false);
  assert.notEqual(cancelled.code, 'MODEL_CONFIG_TIMEOUT');
  assert.equal(require('../core/token-quota').detail(cancelled), null);
  const quota = { enabled: true, exceeded: true, limit: 10, used: 10 };
  const denied = await fetchModel(identity, 'managed-alias', 1000, async () => new Response(JSON.stringify({
    detail: { code: 'TOKEN_QUOTA_EXCEEDED', message: '当前 AI 使用额度暂不可用，请查看额度详情', quota },
  }), { status: 403, headers: { 'Content-Type': 'application/json' } }));
  assert.equal(denied.status, 403);
  assert.equal(denied.code, 'TOKEN_QUOTA_EXCEEDED');
  assert.deepEqual(denied.quota, quota);
});

test('Hub reasoning declarations survive model normalization and the runner boundary', async () => {
  const { create } = require('../main/agent-runtime/runner-config.cjs');
  for (const declaration of [
    { thinkingMode: 'always', thinkingAlwaysOn: true },
    { thinkingMode: 'always' },
    { thinkingMode: 'controllable', thinkingAlwaysOn: false },
    { thinkingMode: 'controllable' },
    { thinkingMode: 'none', thinkingAlwaysOn: false },
    { reasoning: true, thinkingAlwaysOn: true },
  ]) {
    const result = await fetchDeclaredModel({ ...declaration, thinkingFormat: 'zai',
      supportsReasoningEffort: true, thinkingLevelMap: { low: 'low', high: 'high' } });
    assert.equal(result.ok, true);
    assert.equal(result.model.reasoning, declaration.thinkingMode !== 'none');
    const runner = create(result.model, 'harness2').llm;
    for (const model of [result.model, runner]) {
      assert.equal(model.thinkingMode, declaration.thinkingMode);
      assert.equal(model.thinkingAlwaysOn, declaration.thinkingAlwaysOn);
      assert.equal(Object.hasOwn(model, 'thinkingMode'), Object.hasOwn(declaration, 'thinkingMode'));
      assert.equal(Object.hasOwn(model, 'thinkingAlwaysOn'), Object.hasOwn(declaration, 'thinkingAlwaysOn'));
      assert.equal(Object.hasOwn(model, 'thinkingLevel'), false);
    }
    if (declaration.thinkingMode === 'always' || declaration.thinkingAlwaysOn === true) {
      assert.equal(result.model.thinkingLevelMap.off, null);
      assert.equal(runner.thinkingLevelMap.off, null);
    } else if (declaration.thinkingMode === 'controllable') {
      assert.equal(Object.hasOwn(result.model.thinkingLevelMap, 'off'), false);
      assert.equal(Object.hasOwn(runner.thinkingLevelMap, 'off'), false);
    } else {
      assert.equal(Object.hasOwn(runner, 'reasoning'), false);
    }
  }
});

test('Hub model metadata does not invent thinking policy or accept malformed declarations', async () => {
  const ordinary = await fetchDeclaredModel({ reasoning: false });
  assert.equal(ordinary.ok, true);
  assert.equal(ordinary.model.reasoning, false);
  for (const field of ['thinkingMode', 'thinkingAlwaysOn', 'thinkingLevel']) {
    assert.equal(Object.hasOwn(ordinary.model, field), false, field);
  }
  for (const invalid of [null, '', 'AUTO', 'controllable ', 1, {}, []]) {
    const result = await fetchDeclaredModel({ thinkingMode: invalid, thinkingAlwaysOn: invalid,
      thinkingLevel: invalid });
    assert.equal(result.ok, true);
    for (const field of ['thinkingMode', 'thinkingAlwaysOn', 'thinkingLevel']) {
      assert.equal(Object.hasOwn(result.model, field), false, field);
    }
  }
});

test('Hub explicit thinking level remains explicit through the runner boundary', async () => {
  const { create } = require('../main/agent-runtime/runner-config.cjs');
  for (const thinkingLevel of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
    const result = await fetchDeclaredModel({ thinkingMode: 'controllable', thinkingAlwaysOn: false,
      thinkingFormat: 'zai', thinkingLevel });
    assert.equal(result.ok, true);
    assert.equal(result.model.thinkingLevel, thinkingLevel);
    assert.equal(create(result.model, 'harness2').llm.thinkingLevel, thinkingLevel);
  }
});

test('模型中心支持个人地址覆盖与任意自定义服务', () => {
  const panel = read('components', 'panels', 'panels-models.js');
  const api = read('api.js');
  assert.match(panel, /添加模型服务/);
  assert.match(panel, /data-purl=/);
  assert.match(panel, /data-pname=/);
  assert.match(panel, /OpenAI 兼容/);
  assert.match(panel, /本地服务无需密钥/);
  assert.match(panel, /providers, models: _mdMyModels, keys: _mdKeyEdits/);
  assert.match(api, /async saveMyModels\(body\)[\s\S]*?jfetch\('\/my-models', \{ method: 'PUT'/);
});

test('saving personal models keeps local services out of the Hub payload', async () => {
  const values = new Map(), calls = [], localCalls = [];
  const response = { ok: true, providers: [{ id: 'company-provider', hasKey: false }] };
  const window = { dispatchEvent() {}, soduWorkAPI: {
    getHubConnection: async () => ({ ok: true, hub: 'https://hub.example.test', editable: true }),
    deviceAuthBootstrap: async () => ({ ok: true, stored: true, clientId: 'device-1',
      user: { id: 'alice' }, session: 'fixture-session', expiresIn: 1800 }),
    localModels: {
      get: async () => ({ revision: 7, providers: [{ id: 'custom-local', localOnly: true }], myModels: [], usable: [], mediaUsable: {} }),
      save: async body => { localCalls.push(body); return { ok: true, revision: 8 }; },
    },
  } };
  vm.runInNewContext(read('api.js'), {
    window, User: { id: 'device-1', name: 'Fixture' }, navigator: { platform: 'test' },
    localStorage: { getItem: key => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) },
    fetch: async (url, options) => { calls.push({ url, options }); return new Response(JSON.stringify(response)); },
    URL, URLSearchParams, Response, AbortController, CustomEvent: class {},
    console: { log() {}, error() {} }, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0,
  }, { filename: 'api.js' });
  const api = window.SoduWorkAPI;
  await api.registerClient();
  const body = {
    providers: [
      { id: 'company-provider', baseUrl: 'https://personal.example.test/v1' },
      { id: 'custom-local', name: 'Local service', baseUrl: 'http://127.0.0.1:12345/v1', kind: 'openai-compat', personal: true, authMode: 'none', localOnly: true },
    ],
    models: [
      { name: 'company-model', providerId: 'company-provider', label: 'Company model' },
      { name: 'custom-model', providerId: 'custom-local', label: 'Custom model', localOnly: true },
    ],
    keys: { 'company-provider': null, 'custom-local': 'local-secret' },
    localProviders: [{ id: 'custom-local', name: 'Local service', baseUrl: 'http://127.0.0.1:12345/v1', kind: 'openai-compat', personal: true, authMode: 'none', localOnly: true }],
    localModels: [{ name: 'custom-model', providerId: 'custom-local', label: 'Custom model', localOnly: true }],
    localKeys: { 'custom-local': 'local-secret' },
    localRevision: 7,
    expectedRevision: 7,
  };
  assert.deepEqual(JSON.parse(JSON.stringify(await api.saveMyModels(body))), response);
  assert.equal(localCalls.length, 1);
  assert.equal(localCalls[0].expectedRevision, 7);
  assert.equal(localCalls[0].keys['custom-local'], 'local-secret');
  const hubCalls = calls.filter(call => call.url === 'https://hub.example.test/api/v1/my-models');
  assert.equal(hubCalls.length, 1);
  assert.equal(hubCalls[0].options.method, 'PUT');
  assert.equal(hubCalls[0].options.headers.Authorization, 'Device fixture-session');
  const hubBody = JSON.parse(hubCalls[0].options.body);
  assert.deepEqual(hubBody.providers, [{ id: 'company-provider', baseUrl: 'https://personal.example.test/v1' }]);
  assert.deepEqual(hubBody.models, [{ name: 'company-model', providerId: 'company-provider', label: 'Company model' }]);
  assert.deepEqual(hubBody.keys, { 'company-provider': null });
  assert.equal(JSON.stringify(hubBody).includes('custom-local'), false);
});

test('saving only local models does not require a Hub connection', async () => {
  const values = new Map(), calls = [], localCalls = [];
  const window = { dispatchEvent() {}, soduWorkAPI: { localModels: {
    get: async () => ({ revision: 2, providers: [], myModels: [], usable: [], mediaUsable: {} }),
    save: async body => { localCalls.push(body); return { ok: true }; },
  } } };
  vm.runInNewContext(read('api.js'), {
    window, User: {}, navigator: { platform: 'test' },
    localStorage: { getItem: key => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) },
    fetch: async (url, options) => { calls.push({ url, options }); throw Error('Hub must not be contacted'); },
    URL, URLSearchParams, Response, AbortController, CustomEvent: class {},
    console: { log() {}, error() {} }, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0,
  }, { filename: 'api.js' });
  await window.SoduWorkAPI.saveMyModels({
    localProviders: [{ id: 'custom-local', localOnly: true, baseUrl: 'http://127.0.0.1:12345/v1' }],
    localModels: [{ providerId: 'custom-local', name: 'custom-model', localOnly: true }],
    localKeys: {}, localRevision: 2,
  });
  assert.equal(localCalls.length, 1);
  assert.equal(calls.length, 0);
});

test('local capability checks stay in the desktop process', async () => {
  const values = new Map(), calls = [], probes = [];
  const window = { dispatchEvent() {}, soduWorkAPI: { localModels: {
    get: async () => ({ providers: [{ id: 'custom-local', localOnly: true }],
      myModels: [{ providerId: 'custom-local', name: 'qwen3', localOnly: true }], usable: [], mediaUsable: {} }),
    test: async (providerId, model) => { probes.push({ providerId, model }); return { ok: true, detail: 'direct' }; },
  } } };
  vm.runInNewContext(read('api.js'), {
    window, User: {}, navigator: { platform: 'test' },
    localStorage: { getItem: key => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) },
    fetch: async (url, options) => { calls.push({ url, options }); throw Error('Hub must not be contacted'); },
    URL, URLSearchParams, Response, AbortController, CustomEvent: class {},
    console: { log() {}, error() {} }, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0,
  }, { filename: 'api.js' });
  const report = await window.SoduWorkAPI.checkMyModelCapabilities({ providerId: 'custom-local', model: 'qwen3', checks: ['connection', 'streaming'] });
  assert.equal(report.ok, true);
  assert.deepEqual(probes, [{ providerId: 'custom-local', model: 'qwen3' }]);
  assert.equal(report.checks.connection.status, 'passed');
  assert.equal(report.checks.streaming.status, 'inconclusive');
  assert.equal(calls.length, 0);
});

test('a managed-only save does not erase existing local model definitions', async () => {
  const values = new Map(), localCalls = [], hubCalls = [];
  const window = { dispatchEvent() {}, soduWorkAPI: { localModels: {
    get: async () => ({ revision: 4, providers: [{ id: 'custom-local', localOnly: true,
      baseUrl: 'http://127.0.0.1:12345/v1', authMode: 'none' }],
      myModels: [{ providerId: 'custom-local', name: 'qwen3', localOnly: true }], usable: [], mediaUsable: {} }),
    save: async body => { localCalls.push(body); return { ok: true }; },
  } } };
  vm.runInNewContext(read('api.js'), {
    window, User: {}, navigator: { platform: 'test' },
    localStorage: { getItem: key => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) },
    fetch: async (url, options) => { hubCalls.push({ url, options }); return new Response(JSON.stringify({ ok: true })); },
    URL, URLSearchParams, Response, AbortController, CustomEvent: class {},
    console: { log() {}, error() {} }, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0,
  }, { filename: 'api.js' });
  await window.SoduWorkAPI.saveMyModels({
    providers: [{ id: 'company-provider', baseUrl: '' }], keys: { 'custom-local': 'ignored-by-hub' },
  });
  assert.equal(localCalls.length, 0);
  assert.equal(hubCalls.length, 1);
  assert.equal(JSON.stringify(JSON.parse(hubCalls[0].options.body)).includes('custom-local'), false);
});

test('a missing local bridge cannot forward local-looking keys to the Hub', async () => {
  const values = new Map(), hubCalls = [];
  const window = { dispatchEvent() {} };
  vm.runInNewContext(read('api.js'), {
    window, User: {}, navigator: { platform: 'test' },
    localStorage: { getItem: key => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) },
    fetch: async (url, options) => {
      hubCalls.push({ url, options });
      return new Response(JSON.stringify({ ok: true }));
    },
    URL, URLSearchParams, Response, AbortController, CustomEvent: class {},
    console: { log() {}, error() {} }, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0,
  }, { filename: 'api.js' });
  await window.SoduWorkAPI.saveMyModels({
    providers: [{ id: 'company-provider', baseUrl: '' }],
    keys: { 'local-service': 'must-not-forward' },
  });
  assert.equal(hubCalls.length, 1);
  assert.equal(JSON.stringify(JSON.parse(hubCalls[0].options.body)).includes('must-not-forward'), false);
  assert.equal(JSON.stringify(JSON.parse(hubCalls[0].options.body)).includes('local-service'), false);
});

test('模型配置保留就地真实探测与组织地址恢复能力', () => {
  const panel = read('components', 'panels', 'panels-models.js');
  assert.match(panel, /保存并测试/);
  assert.match(panel, /SoduWorkAPI\.testMyModel/);
  assert.match(panel, /恢复组织默认地址/);
  assert.match(panel, /连接设置/);
  assert.match(panel, /访问凭据/);
  assert.match(panel, /模型清单/);
});

test('额度耗尽时历史会话仍可使用本地模型元数据打开', async t => {
  const modelConfig = require('../main/pi-session/model-config');
  const rootDir = fsNode.mkdtempSync(path.join(os.tmpdir(), 'soduwork-history-quota-'));
  t.after(() => fsNode.rmSync(rootDir, { recursive: true, force: true }));
  const app = { getPath: () => rootDir };
  modelConfig.writeModels(path.join(rootDir, 'pi-agent'), {
    baseUrl: 'https://hub.example.test/api/v1/ai-proxy/v1', id: 'saved-model', label: 'Saved model',
    input: ['text'], contextWindow: 128000, maxOutputTokens: 4096,
  });
  const result = await modelConfig.fetchModel(
    { hub: 'https://hub.example.test', clientId: 'device-1', session: 'device-session' },
    'saved-model', 8000,
    async () => new Response(JSON.stringify({ detail: {
      code: 'TOKEN_QUOTA_EXCEEDED', quota: { enabled: true, exceeded: true },
    } }), { status: 403, headers: { 'Content-Type': 'application/json' } }),
    false, 'pi', { app, allowHistorical: true });
  assert.equal(result.ok, true);
  assert.equal(result.historical, true);
  assert.equal(result.model.id, 'saved-model');
  assert.equal(result.model.key, 'history-only');
  const denied = await modelConfig.fetchModel(
    { hub: 'https://hub.example.test', clientId: 'device-1', session: 'device-session' },
    'saved-model', 8000,
    async () => new Response(JSON.stringify({ detail: {
      code: 'TOKEN_QUOTA_EXCEEDED', quota: { enabled: true, exceeded: true },
    } }), { status: 403, headers: { 'Content-Type': 'application/json' } }));
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'TOKEN_QUOTA_EXCEEDED');
});
