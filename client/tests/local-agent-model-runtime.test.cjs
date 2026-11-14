'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const defaults = require('../main/local-agent-model-store.cjs');
const localModels = require('../main/local-model-store.cjs');
const config = require('../main/pi-session/model-config');
const probe = require('../main/local-agent-probe.cjs');
const reference = 'local:model-0123456789abcdef0123456789abcdef';
const model = { name: 'private-wire-model', modelRef: reference, runtimeId: reference,
  baseUrl: 'http://127.0.0.1:11434/v1', key: '', authMode: 'none', provider: 'private',
  label: 'Local model', modality: 'chat', localOnly: true };

test('all local managed runtimes inherit device defaults without sending them to Hub', async t => {
  t.mock.method(defaults, 'configured', () => true);
  const selections = [];
  t.mock.method(defaults, 'fromIdentity', (_, agent) => { selections.push(agent); return { configured: true, modelName: reference }; });
  t.mock.method(localModels, 'resolve', name => name === reference ? model : null);
  const network = () => { throw Error('Must not contact Hub'); };
  for (const agent of ['pi', 'qwen', 'opencode', 'dsh', 'kimi', 'harness2', 'codex-harness']) {
    const result = await config.fetchModel(null, '', 1000, network, false, agent, { allowLocal: true });
    assert.equal(result.ok, true, agent);
    assert.equal(result.model.id, reference, agent);
    assert.equal(result.model.localOnly, true, agent);
  }
  assert.equal(selections.length, 7);
});

test('deleted or unreadable local defaults cannot fall back to a Hub model', async t => {
  t.mock.method(defaults, 'configured', () => true);
  t.mock.method(defaults, 'fromIdentity', () => ({ configured: true, unavailable: true, modelName: reference }));
  t.mock.method(localModels, 'resolve', () => { throw Error('Deleted model must not resolve'); });
  const result = await config.fetchModel(null, '', 1000, () => { throw Error('Hub must not be called'); }, false, 'qwen', { allowLocal: true });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'LOCAL_AGENT_DEFAULT_UNAVAILABLE');
  assert.match(result.reason, /已删除或不可用/);
  t.mock.method(defaults, 'fromIdentity', () => { throw Error('Encrypted store is damaged'); });
  const damaged = await config.fetchModel(null, '', 1000, undefined, false, 'pi', { app: {} });
  assert.equal(damaged.ok, false);
  assert.equal(damaged.code, 'LOCAL_AGENT_DEFAULT_UNAVAILABLE');
  assert.match(damaged.reason, /无法读取/);
});

test('cloud and account model resolution never reads local Agent defaults', async t => {
  t.mock.method(defaults, 'configured', () => true);
  const read = t.mock.method(defaults, 'fromIdentity', () => { throw Error('Must not read device defaults'); });
  for (const agent of ['pi', 'qwen', 'codex', 'claude']) {
    const options = ['codex', 'claude'].includes(agent) ? { allowLocal: true, app: {} } : {};
    const result = await config.fetchModel(null, '', 1000, undefined, false, agent, options);
    assert.equal(result.ok, false);
  }
  assert.equal(read.mock.callCount(), 0);
});

test('archived sessions retain an unavailable local default as a read-only placeholder', async t => {
  t.mock.method(defaults, 'configured', () => true);
  t.mock.method(defaults, 'fromIdentity', () => ({ configured: true, unavailable: true, modelName: reference }));
  t.mock.method(localModels, 'resolve', () => { throw Error('Deleted model must not resolve'); });
  const app = { getPath: () => require('node:path').join(__dirname, 'missing-history-fixture') };
  for (const agent of ['pi', 'qwen']) {
    const result = await config.fetchModel(null, '', 1000, () => { throw Error('Hub must not be called'); },
      false, agent, { allowLocal: true, allowHistorical: true, app });
    assert.equal(result.ok, true);
    assert.equal(result.model.id, reference);
    assert.equal(result.model.historicalLocal, true);
    assert.equal(result.model.localOnly, true);
    assert.equal(result.model.key, '');
  }
});

test('local Agent probe sends credentials only through the private Runner pipe and returns a clean result', async () => {
  const calls = [];
  const runner = { rpc: async (op, value) => {
    calls.push({ op, value });
    return op === 'agent.probe' ? { ok: true, data: { jobId: 'private-job', private: true } } :
      { ok: true, data: { id: 'private-job', key: 'qwen', action: 'probe', state: 'done', ok: true,
        detail: 'private-wire-model and provider diagnostic', lines: ['secret-provider-detail'] } };
  } };
  const result = await probe.run({ runner, agentId: 'qwen', model });
  assert.equal(result.ok, true);
  assert.equal(result.probeKind, 'agent-execution');
  assert.equal(calls[0].value.llm.model, model.name);
  assert.equal(calls[0].value.llm.localOnly, true);
  assert.equal(calls[0].value.llm.authMode, 'none');
  assert.doesNotMatch(JSON.stringify(calls), /local:model-/);
  assert.doesNotMatch(JSON.stringify(result), /private-wire-model|secret-provider|127\.0\.0\.1/);
});

test('local Agent probe refuses a legacy receipt, foreign job, account runtime and changed scope', async () => {
  await assert.rejects(probe.run({ runner: { rpc: async () => ({ ok: true, data: { jobId: 'job' } }) },
    agentId: 'qwen', model }), /未接受私有模型测试/);
  await assert.rejects(probe.run({ runner: { rpc: async op => op === 'agent.probe'
    ? { ok: true, data: { jobId: 'job', private: true } } : { ok: true, data: { id: 'other' } } },
    agentId: 'qwen', model }), /回执不完整/);
  await assert.rejects(probe.run({ runner: { rpc() { throw Error('Must not run'); } }, agentId: 'codex', model }), /受管型/);
  let current = true, calls = 0;
  await assert.rejects(probe.run({ runner: { rpc: async () => { calls++; current = false;
    return { ok: true, data: { jobId: 'job', private: true } }; } }, agentId: 'qwen', model,
    assertCurrent() { if (!current) throw Error('Scope changed'); } }), /Scope changed/);
  assert.equal(calls, 1);
});
