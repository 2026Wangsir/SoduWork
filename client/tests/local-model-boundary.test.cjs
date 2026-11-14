'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('./renderer-source.cjs');
const path = require('node:path');
const vm = require('node:vm');

function fixture(get = async () => ({ providers: [], myModels: [], revision: 1 }), options = {}) {
  const requests = [], saves = [], values = new Map();
  const box = { URL, URLSearchParams, AbortController, Response, console,
    navigator: { platform: 'test' }, CustomEvent: class {}, dispatchEvent() {},
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0,
    localStorage: { getItem: key => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) },
    soduWorkAPI: { localModels: { get, save: async value => { saves.push(value); return { ok: true }; } },
      ...(options.authenticated ? { deviceAuthBootstrap: async () => ({ ok: true, stored: true,
        clientId: 'fixture-device', user: { id: 'alice' }, session: 'fixture-session', expiresIn: 1800 }) } : {}),
      ...(options.localRequirementParse ? { conversationSession: { localRequirementParse: options.localRequirementParse } } : {}),
      ...(options.automationModels ? { automationModels: options.automationModels } : {}) },
    fetch: async (url, options) => { const body = options?.body && JSON.parse(options.body);
      requests.push({ url, body });
      return new Response(JSON.stringify({ ok: true, id: 'schedule', modelSource: body?.modelSource || 'managed' })); },
  };
  box.window = box;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../api.js'), 'utf8'), box);
  return { api: box.SoduWorkAPI, requests, saves };
}

test('desktop model references never reach remote Agent defaults or probes', async () => {
  const f = fixture();
  await assert.rejects(f.api.setAgentModel('pi', 'local:private:model'), /本地模型/);
  await assert.rejects(f.api.agentProbe('pi', 'local:private:model', 'remote-runner'), /本地模型/);
  await assert.rejects(f.api.setAgentModel('pi', 'image::private::local:private:model'), /本地模型/);
  await assert.rejects(f.api.agentProbe('pi', 'image::private::local:private:model', 'remote-runner'), /本地模型/);
  assert.equal(f.requests.length, 0);
  await f.api.setAgentModel('pi', 'managed-model');
  await f.api.agentProbe('pi', 'managed-model', 'remote-runner');
  assert.equal(f.requests.length, 2);
});

test('legacy requirement dispatch refuses device models before making a Hub request', async () => {
  const f = fixture();
  await assert.rejects(f.api.dispatchToAI('requirement', { id: 'local:qwen' }, '', {}, 'local:model-0123456789abcdef0123456789abcdef'), /本地模型/);
  assert.equal(f.requests.length, 0);
});

test('calls without an explicit local execution context cannot resolve or forward local credentials', async t => {
  const store = require('../main/local-model-store.cjs');
  const modelConfig = require('../main/pi-session/model-config');
  t.mock.method(store, 'resolve', () => { throw Error('Must not read local credentials'); });
  const fetchImpl = () => { throw Error('Must not contact Hub'); };
  for (const agent of ['pi', 'harness2', 'codex', 'custom-example']) {
    const result = await modelConfig.fetchModel(null, 'local:private:model', 1000, fetchImpl, false, agent);
    assert.equal(result.ok, false);
    assert.match(result.reason, /本机受管底座调用/);
  }
  assert.equal(store.resolve.mock.callCount(), 0);
});

test('managed local runtimes resolve the on-device model without contacting Hub', async t => {
  const store = require('../main/local-model-store.cjs');
  t.mock.method(store, 'resolve', () => ({
    name: 'qwen-local-wire', modelRef: 'local:private:model', runtimeId: 'local:private:model',
    baseUrl: 'http://127.0.0.1:11434/v1', key: '', authMode: 'none',
    provider: 'ollama', providerName: 'Ollama', localOnly: true,
  }));
  const fetchImpl = () => { throw Error('Hub must not receive local model requests'); };
  for (const agent of ['harness2', 'qwen', 'opencode', 'dsh', 'kimi']) {
    const result = await require('../main/pi-session/model-config').fetchModel(
      null, 'local:private:model', 1000, fetchImpl, false, agent, { allowLocal: true });
    assert.equal(result.ok, true, agent);
    assert.equal(result.model.localOnly, true);
    assert.equal(result.model.wireModelId, 'qwen-local-wire');
    assert.equal(result.model.key, '');
  }
});

test('legacy or malformed local references use an on-device parser and never reach remote plans or schedules', async () => {
  const f = fixture(undefined, { localRequirementParse: async params => ({ ok: true,
    text: JSON.stringify({ title: 'Local draft', note: params.input, checklist: ['Keep local'], kind: 'requirement',
      priority: 'normal', due: '', tags: ['local'] }) }) });
  for (const model of ['local:private:model', 'image::private::local:private:model', 'image::device:private::local:private:model']) {
    const parsed = await f.api.parseTaskText('Retain this draft.', model);
    assert.equal(parsed.title, 'Local draft');
    assert.match(parsed.note, /Retain this draft/);
    await assert.rejects(f.api.aiPlan('task', { model }), /本地模型/);
    await assert.rejects(f.api.preflightSchedule({ modelName: model }), /本地模型/);
    await assert.rejects(f.api.createSchedule({ modelName: model }), /本地模型/);
    await assert.rejects(f.api.updateSchedule('schedule', { modelName: model }), /本地模型/);
  }
  assert.equal(f.requests.length, 0);
  await f.api.createSchedule({ modelName: 'managed-model' });
  assert.equal(f.requests.length, 1);
});

test('local automation model selections stay on the device and are cleared when replaced', async () => {
  const model = 'local:model-0123456789abcdef0123456789abcdef';
  const saved = [], removed = [];
  const f = fixture(undefined, { authenticated: true, automationModels: {
    set: async input => { saved.push(input); return { ok: true, modelName: input.modelName }; },
    remove: async input => { removed.push(input); return { ok: true, modelName: '' }; },
  } });
  await f.api.registerClient();
  await f.api.createSchedule({ title: 'local', assigneeId: 'local:pi', modelName: model });
  assert.equal(f.requests[0].body.modelName, '');
  assert.equal(saved[0].modelName, model);
  await assert.rejects(f.api.createSchedule({ title: 'local runner', assigneeId: 'runner:desk:pi', assigneeMode: 'local',
    assigneeClientId: 'another-device', modelName: model }), /本地模型只能选择本机托管型/);
  await f.api.updateSchedule('schedule', { assigneeId: 'local:pi', modelName: 'managed-model' });
  assert.equal(removed.length, 1);
  await assert.rejects(f.api.updateSchedule('schedule', { assigneeId: 'runner:desk:pi', modelName: model }), /本地模型只能选择本机托管型/);
  assert.equal(f.requests.length, 2);
});

test('local automation creation and editing fail closed without native validation or storage', async () => {
  const model = 'local:model-0123456789abcdef0123456789abcdef';
  const f = fixture();
  await assert.rejects(f.api.preflightSchedule({ assigneeId: 'local:pi', modelName: model }), /无法验证本地模型/);
  await assert.rejects(f.api.updateSchedule('schedule', { assigneeId: 'local:pi', modelName: model }), /无法保存自动化本地模型选择/);
  assert.equal(f.requests.length, 0);
});

test('unavailable automation placeholders never reach Hub or mutate device selections', async () => {
  const mutations = [];
  const f = fixture(undefined, { authenticated: true, automationModels: {
    set: async input => { mutations.push(input); return { ok: true }; },
    remove: async input => { mutations.push(input); return { ok: true }; },
  } });
  await f.api.registerClient();
  for (const modelName of ['unavailable:default', ' unavailable:default ', 'local:unavailable']) {
    const request = { assigneeId: 'local:pi', modelName };
    for (const call of [() => f.api.preflightSchedule(request), () => f.api.createSchedule(request),
      () => f.api.updateSchedule('schedule', request)]) {
      await assert.rejects(call, error => {
        assert.equal(error.code, 'MODEL_SELECTION_REQUIRED');
        assert.match(error.message, modelName.trim() === 'local:unavailable'
          ? /请重新选择可验证的本地模型/ : /请选择可用模型/);
        assert.doesNotMatch(error.message, /unavailable:/);
        return true;
      });
    }
  }
  assert.equal(f.requests.length, 0);
  assert.deepEqual(mutations, []);
});

test('opaque automation references stay local for every managed runtime and verified current-device Runner seat', async () => {
  const model = 'local:model-' + 'a'.repeat(32);
  for (const runtime of ['pi', 'qwen', 'opencode', 'dsh', 'kimi', 'harness2', 'codex-harness']) {
    const writes = [];
    const f = fixture(undefined, { authenticated: true, automationModels: {
      set: async input => { writes.push(input); return { ok: true }; },
    } });
    await f.api.registerClient();
    await f.api.createSchedule({ modelName: model, assigneeId: 'local:' + runtime });
    await f.api.createSchedule({ modelName: model, assigneeId: 'runner:this-device:' + runtime,
      assigneeMode: 'local', assigneeClientId: 'fixture-device' });
    assert.deepEqual(f.requests.map(row => row.body.modelName), ['', '']);
    assert.deepEqual(f.requests.map(row => row.body.modelSource), ['device', 'device']);
    assert.deepEqual(writes.map(row => row.modelName), [model, model]);
    assert(writes.every(row => row.owner === 'account:alice' && row.clientId === 'fixture-device'));
    assert.doesNotMatch(JSON.stringify(f.requests), /local:model-/);
    await assert.rejects(f.api.createSchedule({ modelName: 'image::device:private::' + model,
      assigneeId: 'local:' + runtime }), /当前设备可验证的本地模型/);
    await assert.rejects(f.api.createSchedule({ modelName: model, assigneeId: 'runner:other-device:' + runtime }), /本地模型/);
    await assert.rejects(f.api.createSchedule({ modelName: model, assigneeId: 'runner:other-device:' + runtime,
      assigneeMode: 'local', assigneeClientId: 'other-device' }), /本地模型/);
    assert.equal(f.requests.length, 2);
  }
  const account = fixture();
  for (const runtime of ['codex', 'claude'])
    await assert.rejects(account.api.createSchedule({ modelName: model, assigneeId: 'local:' + runtime }), /本地模型/);
  assert.equal(account.requests.length, 0);
});

test('a failed local parser preserves the original requirement for manual editing', async () => {
  const f = fixture(undefined, { localRequirementParse: async () => ({ ok: false, code: 'APP_AI_NOT_SENT' }) });
  const parsed = await f.api.parseTaskText('Keep this exact text.', 'local:private:model');
  assert.match(parsed._parseError, /原文已保留/);
  assert.equal(f.requests.length, 0);
});

test('managed key patches never replace omitted provider or model lists', async () => {
  const f = fixture();
  await f.api.saveMyModels({ keys: { 'custom-managed': 'fixture-key' } });
  assert.equal(f.saves.length, 0);
  assert.deepEqual(f.requests[0].body, { keys: { 'custom-managed': 'fixture-key' } });
});

test('explicit managed clears survive an accompanying local save', async () => {
  const f = fixture();
  await f.api.saveMyModels({ providers: [], models: [], expectedRevision: 'hub-revision',
    localProviders: [], localModels: [], localRevision: 1 });
  assert.equal(f.saves.length, 1);
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.requests[0].body, { providers: [], models: [], expectedRevision: 'hub-revision', keys: {} });
});

test('legacy local-only rows cannot clear Hub models even when carrying a Hub revision', async () => {
  const provider = { id: 'custom-private', localOnly: true };
  const model = { providerId: provider.id, name: 'private-model', localOnly: true };
  for (const models of [[model], []]) {
    const f = fixture();
    await f.api.saveMyModels({ providers: [provider], models, expectedRevision: 'hub-revision',
      keys: { [provider.id]: 'fixture-private-key' } });
    assert.equal(f.saves.length, 1);
    assert.equal(f.requests.length, 0);
  }
});

test('a merged replacement can remove the last managed rows while retaining local rows', async () => {
  const f = fixture();
  const provider = { id: 'custom-private', localOnly: true };
  const model = { providerId: provider.id, name: 'private-model', localOnly: true };
  await f.api.saveMyModels({ providers: [provider], models: [model], expectedRevision: 'hub-revision',
    localProviders: [provider], localModels: [model], localRevision: 1 });
  assert.equal(f.saves.length, 1);
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.requests[0].body, { providers: [], models: [], expectedRevision: 'hub-revision', keys: {} });
});

for (const method of ['myModels', 'saveMyModels', 'testMyModel', 'checkMyModelCapabilities']) {
  test(`${method} never treats an unreadable local catalog as permission to contact Hub`, async () => {
    for (const get of [async () => { throw Error('Keychain denied'); }, async () => ({ ok: false })]) {
      const f = fixture(get);
      const input = method === 'testMyModel' ? 'custom-private' : {
        keys: { 'custom-private': 'fixture-private-key' }, providerId: 'custom-private', model: 'private-model',
      };
      await assert.rejects(f.api[method](input));
      assert.equal(f.requests.length, 0);
      assert.equal(f.saves.length, 0);
    }
  });
}

function owner() {
  const now = Math.floor(Date.now() / 1000);
  return { hub: 'https://fixture.invalid', clientId: 'fixture-device', session:
    Buffer.from(JSON.stringify({ typ: 'device', uid: 'fixture-owner', cid: 'fixture-device',
      iat: now, exp: now + 3600 })).toString('base64url') + '.' + 'a'.repeat(64) };
}

test('mixed queued local and managed turns apply admission to the captured choice', async () => {
  const { beforeTurn } = require('../main/conversation/quota-admission.cjs');
  const { createTurnQueue } = require('../main/pi-session/turn-queue');
  const calls = [], executed = [], lifecycle = [];
  const gate = beforeTurn(async (_owner, _scope, choice) => calls.push(choice.model), owner(), function () {
    lifecycle.push(this.modelName);
  }, { agent: 'pi', modelMode: 'managed', localModel: async name =>
    name === 'local:fixture:model' ? { localOnly: true } : null });
  const queue = createTurnQueue();
  for (const modelName of ['managed-first', 'local:fixture:model', 'managed-last']) {
    queue.add({ text: 'fixture', options: { modelName, beforeTurn: gate } });
  }
  for (let i = 0; i < 3; i++) {
    const item = queue.take();
    await queue.run(item, async () => { executed.push(item.options.modelName); return { ok: true }; });
  }
  assert.deepEqual(calls, ['managed-first', 'managed-last']);
  assert.deepEqual(executed, ['managed-first', 'local:fixture:model', 'managed-last']);
  assert.deepEqual(lifecycle, executed);
  await gate.call({ modelName: 'legacy local' }, { modelName: '  local:fixture:model  ' });
  await assert.rejects(gate({ modelName: 'local:missing:model' }));
  assert.equal(calls.length, 2);
});

test('local model references cannot bypass managed dispatch or native runtime admission', async () => {
  const { beforeTurn } = require('../main/conversation/quota-admission.cjs');
  for (const runtime of [{ agent: 'pi', modelMode: 'managed', controlled: true },
    { agent: 'codex', modelMode: 'account' }]) {
    await assert.rejects(beforeTurn(() => assert.fail('local reference disclosed to Hub'), owner(), undefined,
      { ...runtime, localModel: () => ({ localOnly: true }) })({ modelName: 'local:fixture:model' }));
  }
});

test('wrapped local image references never reach Hub quota admission', async () => {
  const { beforeTurn } = require('../main/conversation/quota-admission.cjs');
  for (const agent of ['pi', 'qwen', 'codex', 'claude']) {
    await assert.rejects(beforeTurn(() => assert.fail('local reference disclosed to Hub'), owner(), undefined,
      { agent, modelMode: agent === 'codex' || agent === 'claude' ? 'account' : 'managed' })({
      modelName: 'image::private::local:model-' + 'a'.repeat(32),
    }));
  }
});

test('managed Runner local turns skip Hub quota admission', async () => {
  const { beforeTurn } = require('../main/conversation/quota-admission.cjs');
  for (const agent of ['qwen', 'opencode', 'codex-harness']) {
    let called = false;
    const hook = beforeTurn(() => { called = true; }, owner(), undefined,
      { agent, modelMode: 'managed', localModel: async () => ({ localOnly: true }) });
    await hook({ modelName: 'local:fixture:model' });
    assert.equal(called, false, agent);
  }
});
