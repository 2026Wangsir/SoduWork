'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createRunnerRuntimeAdapter, getRunnerSessionDetails, _uuidV5 } = require('../main/agent-runtime/runner-adapter');
const catalog = require('../main/agent-runtime/runtime-catalog');
const models = require('../main/pi-session/model-config');
const localStore = require('../main/local-model-store.cjs');
const { createUsageReporter } = require('../main/agent-runtime/usage-reporter');
const reference = 'local:model-' + 'a'.repeat(32);
const until = async check => { for (let i = 0; i < 300; i++) {
  if (check()) return; await new Promise(resolve => setTimeout(resolve, 10));
} throw Error('Runner fixture timeout'); };

for (const agent of catalog.runnerRuntimes().filter(row => row.modelMode === 'managed').map(row => row.id)) {
  test(agent + ': local wire IDs, signed Hub funding and deleted selections stay isolated', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-runner-local-'));
    const app = { getPath: () => root }, calls = [], fetches = [], receipts = [];
    const identity = { hub: 'https://fixture.invalid', clientId: 'fixture' };
    const alias = 'local-runner', ref = _uuidV5('9af442c8-cd1d-4b91-a668-22da2b2635bf', 'chat:' + alias + ':' + agent);
    let turn = 0, missing = false, accepted;
    const original = localStore.resolve;
    localStore.resolve = name => !missing && name === reference ? { localOnly: true, modelRef: reference,
      runtimeId: reference, name: 'private-wire', baseUrl: 'http://127.0.0.1:11434/v1', key: '', authMode: 'none' } : null;
    t.after(() => { localStore.resolve = original; fs.rmSync(root, { recursive: true, force: true }); });
    const adapter = createRunnerRuntimeAdapter({ app, runtimeSpec: catalog.runtime(agent),
      modelConfig: { async fetchModel(...args) {
        fetches.push(args[1]);
        if (args[1].startsWith('local:')) return models.fetchModel(...args);
        return { ok: true, model: { id: 'managed', baseUrl: 'https://fixture.invalid/proxy', key: 'fixture-ticket',
          quotaVersion: 2, quotaProvider: 'hub-provider', quotaUsageToken: 'signed-' + agent } };
      } }, runnerRuntime: { async rpc(op, input) {
        calls.push({ op, input });
        if (op === 'job.dispatch' || op === 'job.comment') {
          turn++;
          accepted = { agentId: agent, modelName: input.cfg.llm.model };
          const local = input.cfg.llm.localOnly === true;
          receipts.push({ at: Date.now(), usage: { input: 2, output: 1, total: 3 },
            localOnly: local, reportable: !local, model: local ? '' : input.cfg.llm.model,
            agent, provider: local ? '' : input.cfg.llm.quotaProvider,
            ...(local ? {} : { quotaUsageToken: input.cfg.llm.quotaUsageToken }) });
          return { ok: true, data: { ok: true, ref, acceptedSelection: accepted } };
        }
        if (op === 'job.session') return { ok: true, data: { ok: true, status: 'done', ref,
          usage: { input: turn * 2, output: turn, total: turn * 3 }, usageReceipts: receipts.slice(),
          activeExecutionSelection: accepted, round: turn,
          items: [{ seq: turn, kind: 'say', text: 'Finished ' + turn }] } };
        return { ok: true, data: { ok: true } };
      } } });
    const request = { identity, native: { runner: { openOptions: { app, cwd: root, ref: alias, modelName: reference } } } };
    let session = await adapter.createSession(request);
    t.after(() => session?.dispose());
    let handle = getRunnerSessionDetails(session).handle;
    for (const text of ['First local', 'Same local']) assert.equal((await handle.submit(text, []).completion).ok, true);
    const dispatch = calls.find(row => row.op === 'job.dispatch').input;
    assert.equal(dispatch.cfg.llm.model, 'private-wire');
    assert.equal(dispatch.cfg.llm.key, '');
    assert.equal(calls.find(row => row.op === 'job.comment').input.executionSelection, undefined);
    assert.doesNotMatch(JSON.stringify(dispatch), /local:model-/);
    assert.equal((await handle.selectModel('managed')).ok, true);
    assert.equal((await handle.submit('Use Hub', []).completion).ok, true);
    const changed = calls.filter(row => row.op === 'job.comment').at(-1).input;
    assert.equal(changed.executionSelection.modelName, 'managed');
    assert.equal(changed.cfg.llm.quotaUsageToken, 'signed-' + agent);
    assert.doesNotMatch(JSON.stringify(handle.uiSnapshot()), /quotaUsageToken|signed-/);
    const sent = [];
    handle.usageIdentity = identity;
    const reporter = createUsageReporter({ app, identityOf: async () => identity,
      fetchImpl: async (_url, options) => { sent.push(JSON.parse(options.body)); return Response.json({ ok: true }); } });
    reporter.observe(handle, handle.snapshot()); await reporter.flush();
    assert.equal(sent.at(-1).usage.total, 3, 'only the Hub-funded call can leave this device');
    assert.equal(sent.at(-1).quotaUsageToken, 'signed-' + agent);
    assert.doesNotMatch(JSON.stringify(sent), /private-wire|local:model-/);
    assert.equal((await handle.selectModel(reference)).ok, true);
    await session.dispose();
    missing = true; fetches.length = 0;
    session = await adapter.resumeSession({ ...request, native: { runner: { openOptions: {
      app, cwd: root, ref: alias, resumePath: ref,
    } } } });
    handle = getRunnerSessionDetails(session).handle;
    await until(() => handle.status() === 'idle');
    assert.deepEqual(fetches, [reference]);
    assert.equal(handle.snapshot().modelSelection.model.unavailable, true);
    assert.match(handle.snapshot().modelSelection.model.label, /本地模型已删除或不可用/);
    const before = calls.filter(row => ['job.dispatch', 'job.comment'].includes(row.op)).length;
    const rejected = await handle.submit('Must choose again', []).completion;
    assert.equal(rejected.ok, false); assert.match(rejected.reason, /先选择/);
    assert.equal(calls.filter(row => ['job.dispatch', 'job.comment'].includes(row.op)).length, before);
    assert.equal((await handle.selectModel('managed')).ok, true);
    assert.equal((await handle.submit('Explicit selection', []).completion).ok, true);
  });
}

for (const agent of ['codex', 'claude']) test(agent + ' cannot receive local references through open options', async () => {
  const adapter = createRunnerRuntimeAdapter({ runtimeSpec: catalog.runtime(agent), runnerRuntime: { rpc: async () => ({ ok: true }) } });
  for (const modelName of [reference, 'image::private::' + reference]) {
    await assert.rejects(adapter.createSession({ native: { runner: { openOptions: {
      cwd: os.tmpdir(), modelName,
    } } } }), /账号型底座不能使用本地模型/);
  }
});
