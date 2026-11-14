'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const config = require('../main/pi-session/model-config');
const { createRunnerRuntimeAdapter, getRunnerSessionDetails } = require('../main/agent-runtime/runner-adapter');
const runtimeCatalog = require('../main/agent-runtime/runtime-catalog');
const identity = { ...require('./helpers/platform-session-fixture.cjs').identity(), secret: 'fixture-only' };

test('gateway defaults and explicit selections are scoped by runtime in requests, cache and concurrent lookups', async () => {
  const original = global.fetch, calls = [];
  config.invalidate();
  global.fetch = async raw => {
    const url = new URL(raw); calls.push(url);
    await new Promise(resolve => setImmediate(resolve));
    return { ok: true, json: async () => ({ ok: true, key: 'fixture-ticket', expiresIn: 3600,
      model: url.searchParams.get('model') || url.searchParams.get('agent') + '-default',
      imageRouting: 'native', input: ['text', 'image'], maxOutputTokens: 8192,
      capabilityProfile: { vision: { state: 'supported' } } }) };
  };
  try {
    const agents = ['pi', 'opencode', 'qwen', 'codex-harness', 'dsh'];
    const results = await Promise.all(agents.flatMap(agent => [0, 1].map(() =>
      config.fetchModel(identity, '', 1000, global.fetch, false, agent))));
    assert.equal(calls.length, agents.length);
    agents.forEach((agent, index) => {
      assert.equal(results[index * 2].model.id, agent + '-default');
      assert.strictEqual(results[index * 2], results[index * 2 + 1]);
      assert.deepEqual(results[index * 2].model.input, ['text', 'image']);
      assert.equal(results[index * 2].model.maxOutputTokens, 8192);
    });
    assert.equal((await config.fetchSelection(identity)).model.id, 'pi-default');
    assert.equal(calls.length, 5);
    assert.equal((await config.fetchModel(identity, 'chosen model', 1000, global.fetch, false, 'local:qwen')).model.id, 'chosen model');
    assert.equal(calls.at(-1).searchParams.get('agent'), 'qwen');
    assert.equal((await config.fetchModel(identity, '', 1000, global.fetch, true, 'qwen')).model.id, 'qwen-default');
    assert.equal(calls.length, 7);
    await config.fetchModel(identity);
    assert.equal(calls.length, 7, 'forcing Qwen refresh must not evict Pi');
  } finally { global.fetch = original; config.invalidate(); }
});

test('historical model recovery can bypass a stale Agent preference without changing normal defaults', async () => {
  const original = global.fetch;
  const calls = [];
  config.invalidate();
  global.fetch = async raw => {
    const url = new URL(raw);
    calls.push(url);
    return { ok: true, json: async () => ({ ok: true, key: 'fixture-ticket', expiresIn: 3600,
      model: url.searchParams.get('ignore_preference') ? 'current-model' : 'stale-agent-model' }) };
  };
  try {
    const normal = await config.fetchModel(identity, '', 1000, global.fetch, false, 'pi');
    const recovered = await config.fetchModel(identity, '', 1000, global.fetch, false, 'pi',
      { ignoreAgentPreference: true });
    assert.equal(normal.model.id, 'stale-agent-model');
    assert.equal(recovered.model.id, 'current-model');
    assert.equal(calls.length, 2);
    assert.equal(calls[0].searchParams.has('ignore_preference'), false);
    assert.equal(calls[1].searchParams.get('ignore_preference'), '1');
  } finally { global.fetch = original; config.invalidate(); }
});

test('Pi and Runner resume never bypass an unavailable device-owned default', async t => {
  const failure = { ok: false, code: 'LOCAL_AGENT_DEFAULT_UNAVAILABLE', reason: 'Local Agent default is unavailable' };
  const calls = [];
  t.mock.method(require('../main/local-model-privacy.cjs'), 'prepare', async () => {});
  const pi = require('../main/pi-session/session-open').create({
    loadSdk: async () => ({ ok: true, sdk: {} }), _openTiming() {},
    goalContract: { normalize: () => ({ intent: 'chat' }) },
    modelConfig: { configuredModel: () => '', prepare: async (...args) => { calls.push(args); return failure; } },
  });
  const result = await pi.open({ app: {}, identity, modelName: '', resumedConversation: true });
  assert.equal(result.code, failure.code);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][3].ignoreAgentPreference, undefined);
  const adapter = createRunnerRuntimeAdapter({ runtimeSpec: runtimeCatalog.runtime('qwen'),
    runnerRuntime: { rpc: async () => { throw Error('Cannot launch an unavailable model'); } },
    modelConfig: { fetchModel: async (...args) => { calls.push(args); return failure; } } });
  await assert.rejects(adapter.resumeSession({ runtimeId: 'missing-default', identity,
    native: { runner: { openOptions: { ref: 'old-chat', resumePath: 'old-run', resumedConversation: true,
      cwd: os.tmpdir(), modelName: '' } } } }), /Local Agent default is unavailable/);
  assert.equal(calls.length, 2);
  assert.equal(calls[1][6].ignoreAgentPreference, undefined);
});

test('every Runner gateway adapter resolves its own default at open and after model changes; account runtimes bypass it', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-runtime-default-'));
  try {
    for (const cli of ['opencode', 'qwen', 'codex-harness', 'dsh', 'codex']) {
      const calls = [];
      const adapter = createRunnerRuntimeAdapter({ runtimeSpec: runtimeCatalog.runtime(cli),
        runnerRuntime: { rpc: async () => { throw new Error('opening must not execute a job'); } },
        modelConfig: { fetchModel: async (...args) => {
          calls.push(args); return { ok: true, model: { id: args[1] || cli + '-default', key: 'test', baseUrl: 'http://fixture.invalid' } };
        } } });
      const session = await adapter.createSession({ runtimeId: 'test-' + cli, identity,
        native: { runner: { openOptions: { ref: 'default-' + cli, cwd: root, identity } } } });
      try {
        if (['codex'].includes(cli)) { assert.equal(calls.length, 0); continue; }
        assert.equal(calls[0][5], cli); assert.equal(calls[0][1], '');
        const handle = getRunnerSessionDetails(session).handle;
        assert.equal((await handle.selectModel('chosen')).ok, true);
        assert.equal((await handle.selectModel('')).ok, true);
        assert.deepEqual(calls.map(args => args[5]), [cli, cli, cli]);
        assert.deepEqual(calls.map(args => args[1]), ['', 'chosen', '']);
      } finally { await session.dispose(); }
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Runner history preserves its saved choice when omitted and persists an explicit return to default', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-default-resume-'));
  const app = { getPath: () => root };
  const preference = require('../main/conversation/model-selection').preference(app, 'saved-archive');
  const calls = [];
  const adapter = createRunnerRuntimeAdapter({ app, runtimeSpec: runtimeCatalog.runtime('opencode'),
    runnerRuntime: { rpc: async () => ({ ok: true, data: { ok: true, status: 'done', items: [] } }) },
    modelConfig: { fetchModel: async (_, name) => {
      calls.push(name); return { ok: true, model: { id: name || 'opencode-default', key: 'fixture', baseUrl: 'http://fixture.invalid' } };
    } } });
  try {
    preference.write('saved-model');
    for (const options of [{}, { modelName: '' }, {}]) {
      const session = await adapter.resumeSession({ runtimeId: 'review', identity,
        native: { runner: { openOptions: { ref: 'alias', resumePath: 'saved-archive', cwd: root, ...options } } } });
      await session.dispose();
    }
    assert.deepEqual(calls, ['saved-model', '', '']);
    assert.equal(preference.read(), '');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a native task default resolves at its queue boundary without changing the current or already queued models', async () => {
  const { _uuidV5 } = require('../main/agent-runtime/runner-adapter');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-task-default-'));
  const alias = 'task-default', ref = _uuidV5('9af442c8-cd1d-4b91-a668-22da2b2635bf', 'chat:' + alias + ':opencode');
  const calls = []; let session, round = 0, release, signalStarted;
  const started = new Promise(resolve => { signalStarted = resolve; });
  const paused = new Promise(resolve => { release = resolve; });
  const runtime = { async rpc(op, payload) {
    if (op === 'job.dispatch' || op === 'job.comment') { calls.push(payload.cfg.llm.model); round++; return { ok: true, data: { ok: true, ref } }; }
    if (op === 'job.session') {
      if (round === 1) { signalStarted(); await paused; }
      return { ok: true, data: { ok: true, status: 'done', round, items: [{seq:round,kind:'say',text:'Complete'}] } };
    }
    if (op === 'job.stop') return { ok: true, data: { ok: true } };
    throw Error('Unexpected RPC ' + op);
  } };
  const adapter = createRunnerRuntimeAdapter({ runtimeSpec: runtimeCatalog.runtime('opencode'), runnerRuntime: runtime,
    modelConfig: { fetchModel: async (_, name) => ({ ok: true,
      model: { id: name || 'opencode-default', key: 'fixture', baseUrl: 'http://fixture.invalid' } }) } });
  try {
    session = await adapter.createSession({ runtimeId: 'review', identity,
      native: { runner: { openOptions: { ref: alias, cwd: root, modelName: 'prior-model' } } } });
    const current = session.send({ text: 'Current task', options: { taskId: 'current' } });
    await started;
    const oldQueued = session.send({ text: 'Already queued', options: { taskId: 'already-queued' } });
    const next = session.send({ text: 'Follow Agent default', options: { taskId: 'default-task', modelName: '' } });
    const ordinary = session.send({ text: 'Regular followup' });
    assert.deepEqual(calls, ['prior-model']);
    assert.equal(session.snapshot().modelSelection.name, 'prior-model');
    release();
    for (const sent of [current, oldQueued, next, ordinary]) assert.equal((await sent.completion).ok, true);
    assert.deepEqual(calls, ['prior-model', 'prior-model', 'opencode-default', 'prior-model']);
  } finally { release(); if (session) await session.dispose(); fs.rmSync(root, {recursive:true, force:true}); }
});
