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
      ...(options.localRequirementParse ? { conversationSession: { localRequirementParse: options.localRequirementParse } } : {}) },
    fetch: async (url, options) => { requests.push({ url, body: options?.body && JSON.parse(options.body) });
      return new Response(JSON.stringify({ ok: true })); },
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

test('non-Pi runtimes cannot resolve local credentials or forward their reference', async t => {
  const store = require('../main/local-model-store.cjs');
  const modelConfig = require('../main/pi-session/model-config');
  t.mock.method(store, 'resolve', () => { throw Error('Must not read local credentials'); });
  const fetchImpl = () => { throw Error('Must not contact Hub'); };
  for (const agent of ['harness2', 'codex', 'custom-example']) {
    const result = await modelConfig.fetchModel(null, 'local:private:model', 1000, fetchImpl, false, agent);
    assert.equal(result.ok, false);
    assert.match(result.reason, /本机 Pi/);
  }
  assert.equal(store.resolve.mock.callCount(), 0);
});

test('legacy or malformed local references use an on-device parser and never reach remote plans or schedules', async () => {
  const f = fixture(undefined, { localRequirementParse: async params => ({ ok: true,
    text: JSON.stringify({ title: 'Local draft', note: params.input, checklist: ['Keep local'], kind: 'requirement',
      priority: 'normal', due: '', tags: ['local'] }) }) });
  for (const model of ['local:private:model', 'image::private::local:private:model']) {
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

test('an opaque local model can be saved only for the local Pi automation seat', async () => {
  const model = 'local:model-' + 'a'.repeat(32);
  const f = fixture();
  await f.api.createSchedule({ modelName: model, assigneeId: 'local:pi' });
  assert.deepEqual(f.requests[0].body, { modelName: model, assigneeId: 'local:pi' });
  await assert.rejects(f.api.createSchedule({ modelName: model, assigneeId: 'runner:desk:pi' }), /\u672c\u5730\u6a21\u578b/);
  assert.equal(f.requests.length, 1);
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
