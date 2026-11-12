'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { create, source, assertPortable } = require('../main/conversation/cloud-handoff');
const catalog = require('../main/agent-runtime/runtime-catalog');

test('cloud handoff keeps a structured website service address for the result card', () => {
  const { _serviceUrlFromPage } = require('../main/conversation/cloud-handoff');
  assert.equal(_serviceUrlFromPage([{ kind: 'do', services: [{ url: 'http://localhost:4173/' }] }]), 'http://localhost:4173/');
  assert.equal(_serviceUrlFromPage([{ host: 'runner-fixture', port: 4173 }]), 'http://runner-fixture:4173/');
  assert.equal(_serviceUrlFromPage([{ text: 'localhost:4173' }]), '');
});

test('local model ownership blocks cloud handoff before target discovery or workspace inspection', async t => {
  const f = await fixture(t);
  const cloud = f.controller({ request: () => assert.fail('local model metadata must not reach Hub'),
    workspace: { scan: () => assert.fail('local workspace must not be inspected for an ineligible handoff') } });
  for (const selection of [
    { name: 'local:private:model' }, { name: 'private-model', model: { localOnly: true } },
    { name: 'image::private::local:private:model' },
  ]) {
    f.snapshot.modelSelection = selection;
    await assert.rejects(cloud.preview(f.handle), /本地模型只能在本机使用/);
    assert.equal(cloud.guard(f.handle), null);
  }
  f.snapshot.modelSelection = {};
  f.handle.model = { localOnly: true };
  await assert.rejects(cloud.preview(f.handle), /本地模型只能在本机使用/);
  f.snapshot.modelSelection = { name: 'managed-model', model: { id: 'managed-model' },
    activeName: 'local:private:model', activeModel: { localOnly: true }, pending: true };
  assert.doesNotThrow(() => assertPortable(f.handle));
  assert.equal(source(f.handle).modelName, 'managed-model');
});

function account(uid = 'alice') {
  const now = Math.floor(Date.now() / 1000);
  return { hub: 'http://127.0.0.1:18989', clientId: 'desktop', session: Buffer.from(JSON.stringify({
    typ: 'device', uid, cid: 'desktop', iat: now - 10, exp: now + 3600,
  })).toString('base64url') + '.' + 'a'.repeat(64) };
}
async function fixture(t, adapterId = 'pi') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'soduwork-cloud-test-'));
  const cwd = path.join(root, 'workspace'); await fs.mkdir(cwd); await fs.writeFile(path.join(cwd, 'report.md'), 'Original progress');
  const target = { id: 'runner:cloud-1:' + adapterId, name: 'Cloud / ' + adapterId, modelMode: 'managed' };
  let remotePage = null;
  let current = account(), remote = null, starts = 0, stops = 0, sends = 0, failCommit = false, failSend = false, observations = 0;
  const messages = [{ role: 'user', text: 'Finish report' }, { role: 'assistant', blocks: [{ kind: 'text', text: 'Draft ready' }], done: true }];
  const snapshot = { messages, queue: [], modelSelection: { name: 'test-model' }, status: 'idle' };
  const handle = { sessionId: crypto.randomUUID(), adapterId, ref: 'active-' + adapterId, cwd, ui: {}, running: false,
    snapshot: () => ({ ...snapshot, messages: messages.slice() }), inFlight() { return this.running; },
    historyRow: () => ({ title: 'Research' }), goalView: () => ({ goal: 'Finish report' }),
    cancel() { this.running = false; }, bindTask: async id => ({ ok: true, taskId: id }), close() {},
    appendTaskMessage(role, text, files, taskId, key) { if (!messages.some(row => row.taskOutputKey === key)) messages.push({ role, text, taskId, taskOutputKey: key }); },
    appendTaskTool() {}, selectModel: () => ({ ok: true }), setAccessPolicy: () => ({ ok: true }) };
  const request = async (identity, route, options = {}) => {
    assert.equal(identity.clientId, 'desktop');
    if (route.split('?')[0].endsWith('/targets')) return { ok: true, targets: [target] };
    if (route.includes('/ai-session?')) { observations++; return remotePage || { ok: true, ref: 'run-1', status: 'running', last: 2,
      items: [{ seq: 1, kind: 'say', text: 'Cloud continues' }, { seq: 2, kind: 'user', text: 'Remote followup' }] }; }
    if (route.endsWith('/ai-stop')) { stops++; return { ok: true }; }
    if (route.endsWith('/ai-say')) { sends++; const body = JSON.parse(options.body); if (failSend) throw Error('Connection lost');
      return { ok: true, messageId: body.messageId, queued: false }; }
    if (route.endsWith('/abort')) { remote = { ...remote, transferId: route.split('/').at(-2), phase: 'aborted' }; return remote; }
    if (route.endsWith('/commit')) {
      if (remote.phase !== 'committed') starts++;
      remote = { ...remote, phase: 'committed', ref: 'run-1' };
      if (failCommit) throw Error('Connection lost after commit'); return remote;
    }
    if (options.body instanceof FormData) {
      assert.equal(handle.running, false, 'the local executor must stop before any upload');
      const config = JSON.parse(options.body.get('options'));
      if (config.assigneeId) assert.equal(config.assigneeId, target.id);
      else assert.equal(config.agentId, adapterId, 'automatic routing must preserve the source Agent');
      assert.equal(config.sha256, crypto.createHash('sha256').update(Buffer.from(await options.body.get('file').arrayBuffer())).digest('hex'));
      remote = { ok: true, transferId: route.split('/').at(-1), taskId: 'cloud-task', phase: 'prepared', sha256: config.sha256, target };
      return remote;
    }
    if (!remote) { const error = Error('Missing'); error.status = 404; throw error; }
    return remote;
  };
  const controllers = [];
  const controller = (overrides = {}) => { const item = create({ app: { getPath: () => root }, identityOf: async () => current, request, interval: 60000,
    stopTimeout: 5, wait: async () => new Promise(resolve => setTimeout(resolve, 8)), ...overrides }); controllers.push(item); return item; };
  const cloud = controller();
  t.after(async () => { handle.close(); await fs.rm(root, { recursive: true, force: true }); });
  const input = async () => { const preview = await cloud.preview(handle); return { previewId: preview.previewId, assigneeId: target.id, instruction: 'Finish and verify', model: 'test-model' }; };
  return { cloud, controller, handle, snapshot, input, messages, root, request,
    get starts() { return starts; }, get stops() { return stops; }, get sends() { return sends; },
    get observations() { return observations; }, set account(value) { current = value; },
    set remotePage(value) { remotePage = value; },
    set failCommit(value) { failCommit = value; }, set failSend(value) { failSend = value; } };
}

test('all seven Agent adapters hand off actual files, stop locally and consume the existing remote stream', async t => {
  for (const adapter of catalog.runtimes()) await t.test(adapter.id, async t => {
    const f = await fixture(t, adapter.id); const input = await f.input(); f.handle.running = true;
    const localInventory = () => assert.fail('cloud artifacts must not scan the old local workspace');
    f.handle.outputSnapshotAsync = localInventory;
    const receipt = await f.cloud.confirm(f.handle, input);
    assert.equal(receipt.handoff.phase, 'committed'); assert.equal(f.starts, 1);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.messages.filter(row => row.text === 'Cloud continues').length, 1);
    assert.equal(f.handle.snapshot().cloudHandoff.phase, 'committed');
    assert.equal(f.handle.selectModel().ok, false);
    assert.deepEqual((await f.handle.outputSnapshotAsync()).files, []);
    const artifactView = await f.cloud.artifactSession(f.handle);
    assert.deepEqual((await artifactView.outputSnapshotAsync()).files, []);
    await f.cloud.recover(f.handle); assert.equal(f.starts, 1);
    assert.equal(f.messages.filter(row => row.text === 'Cloud continues').length, 1);
    f.handle.close(); assert.equal(f.stops, 0, 'closing the desktop must not stop cloud execution');
    assert.equal(f.handle.outputSnapshotAsync, localInventory);
  });
});
test('commit acknowledgement loss fences local execution and a new coordinator recovers the same task', async t => {
  const f = await fixture(t); const input = await f.input(); f.failCommit = true;
  await assert.rejects(f.cloud.confirm(f.handle, input), /Connection lost/);
  assert.equal(f.cloud.guard(f.handle).phase, 'committing'); assert.equal(f.starts, 1);
  const fresh = f.controller(); f.failCommit = false;
  const recovered = await fresh.recover(f.handle);
  assert.equal(recovered.handoff.taskId, 'cloud-task'); assert.equal(f.starts, 1);
});

test('automatic handoff leaves server selection to the Hub and records its actual receipt', async t => {
  const f = await fixture(t), input = await f.input(); delete input.assigneeId;
  const result = await f.cloud.confirm(f.handle, input);
  assert.equal(result.handoff.phase, 'committed');
  assert.equal(result.handoff.target.id, 'runner:cloud-1:pi');
  assert.equal(f.starts, 1);
  await f.cloud.recover(f.handle); assert.equal(f.starts, 1);
});
test('stop acknowledgement failure never starts cloud execution', async t => {
  const f = await fixture(t); const input = await f.input(); f.handle.running = true; f.handle.cancel = () => {};
  await assert.rejects(f.cloud.confirm(f.handle, input), /尚未停止/);
  assert.equal(f.starts, 0); assert.equal(f.cloud.guard(f.handle), null);
});

test('an unresolved adapter cancel promise is bounded before workspace transfer', { timeout: 2000 }, async t => {
  const f = await fixture(t); const input = await f.input(); f.handle.running = true;
  f.handle.cancel = () => new Promise(() => {});
  await assert.rejects(f.cloud.confirm(f.handle, input), /尚未停止/);
  assert.equal(f.starts, 0); assert.equal(f.cloud.guard(f.handle), null);
  assert.equal((await fs.readdir(path.join(f.root, 'conversation-handoffs'))).filter(x => x.endsWith('.zip') || x.endsWith('.view.json')).length, 0);
});

test('aborting an uncertain upload removes its private archive and temporary display snapshot', async t => {
  const f = await fixture(t);
  const cloud = f.controller({ request: async (...args) => {
    const result = await f.request(...args);
    if (args[2]?.body instanceof FormData) throw Error('Upload acknowledgement lost');
    return result;
  } });
  const preview = await cloud.preview(f.handle);
  await assert.rejects(cloud.confirm(f.handle, { previewId: preview.previewId,
    assigneeId: preview.targets[0].id, instruction: 'Continue' }), /acknowledgement lost/);
  const before = await fs.readdir(path.join(f.root, 'conversation-handoffs'));
  assert.ok(before.some(x => x.endsWith('.zip'))); assert.ok(before.some(x => x.endsWith('.view.json')));
  await cloud.abort(f.handle);
  const after = await fs.readdir(path.join(f.root, 'conversation-handoffs'));
  assert.equal(after.filter(x => x.endsWith('.zip') || x.endsWith('.view.json')).length, 0);
  assert.equal(f.starts, 0); assert.equal(cloud.guard(f.handle), null);
});

test('a reopened completed task drains full output pages promptly without a thirty-second pause', { timeout: 2000 }, async t => {
  const f = await fixture(t); let pages = 0;
  const cloud = f.controller({ request: async (...args) => {
    if (!args[1].includes('/ai-session?')) return f.request(...args);
    const since = Number(new URL('http://localhost' + args[1]).searchParams.get('since'));
    pages++;
    return { ref: 'run-1', status: 'done', last: since ? 401 : 400,
      items: Array.from({ length: since ? 1 : 400 }, (_, i) => ({ seq: since + i + 1, kind: 'say', text: 'Result ' + (since + i + 1) })) };
  } });
  const preview = await cloud.preview(f.handle);
  await cloud.confirm(f.handle, { previewId: preview.previewId, assigneeId: preview.targets[0].id, instruction: 'Continue' });
  for (let i = 0; i < 100 && pages < 2; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(pages, 2); assert.ok(f.messages.some(row => row.text === 'Result 401'));
  f.handle.close();
});
test('concurrent clicks cannot create two transfers and cannot switch the owning account', async t => {
  const f = await fixture(t); const input = await f.input();
  const first = f.cloud.confirm(f.handle, input);
  await assert.rejects(f.cloud.confirm(f.handle, input), /正在处理/); await first;
  f.account = account('bob');
  await assert.rejects(f.cloud.recover(f.handle), /其他账号/);
  await assert.rejects(f.cloud.send(f.handle, 'Continue', [], {}), /其他账号/);
  assert.equal(f.starts, 1); assert.equal(f.sends, 0);
});
test('queued inputs, explicit local skills, pending permissions and external attachments cannot silently disappear', async t => {
  const f = await fixture(t);
  for (const change of [() => { f.snapshot.queue = [{ text: 'Do not lose me' }]; },
    () => { f.snapshot.pendingUi = {}; }, () => { f.handle.ui.selectedSkills = ['local-skill']; },
    () => { f.handle.ui.inputAttachments = [{ path: path.join(f.root, 'outside.pdf') }]; }]) {
    f.snapshot.queue = []; f.snapshot.pendingUi = null; f.handle.ui = {}; change();
    assert.throws(() => assertPortable(f.handle));
  }
  assert.equal(f.starts, 0);
});
test('changed workspace requires another review before sending any file', async t => {
  const f = await fixture(t); const input = await f.input();
  await fs.writeFile(path.join(f.handle.cwd, 'new.txt'), 'new content');
  await assert.rejects(f.cloud.confirm(f.handle, input), /已变化/);
  assert.equal(f.starts, 0); assert.equal(f.cloud.guard(f.handle), null);
});
test('uncertain followup survives restart, blocks different text, and retries with its original message ID', async t => {
  const f = await fixture(t); await f.cloud.confirm(f.handle, await f.input());
  f.failSend = true;
  await assert.rejects(f.cloud.send(f.handle, 'Keep this instruction', [], { submissionId: 'stable-message' }), /Connection lost/);
  const fresh = f.controller();
  assert.equal((await fresh.send(f.handle, 'different text', [], {})).ok, false);
  f.failSend = false;
  const reply = await fresh.send(f.handle, 'Keep this instruction', [], { submissionId: 'new-ui-attempt' });
  assert.equal(reply.messageId, 'stable-message');
  assert.equal(fresh.guard(f.handle).pendingMessage, undefined);
});

test('an explicit pre-send refusal permits corrected input while an uncertain receipt retains its fence', async t => {
  const f = await fixture(t); await f.cloud.confirm(f.handle, await f.input());
  let outcome = 'rejected';
  const cloud = f.controller({ request: async (...args) => {
    if (!args[1].endsWith('/ai-say')) return f.request(...args);
    return { ok: false, delivery: outcome, messageId: JSON.parse(args[2].body).messageId,
      error: 'Not accepted', ...(outcome === 'uncertain' ? { pending: true, uncertain: true } : {}) };
  } });
  await assert.rejects(cloud.send(f.handle, 'Correctable message', [], {}), /Not accepted/);
  assert.equal(cloud.guard(f.handle).pendingMessage, undefined);
  outcome = 'uncertain';
  await assert.rejects(cloud.send(f.handle, 'Different corrected message', [], { submissionId: 'keep-id' }), /Not accepted/);
  assert.equal(cloud.guard(f.handle).pendingMessage.id, 'keep-id');
  assert.equal((await cloud.send(f.handle, 'Unrelated message', [], {})).ok, false);
});
test('source metadata uses the neutral snapshot contract', async t => {
  const f = await fixture(t);
  assert.equal(source(f.handle).modelName, 'test-model'); assert.equal(source(f.handle).goal, 'Finish report');
});

test('passive cloud replay preserves local token owners and refreshes a late native usage receipt', async t => {
  const f = await fixture(t);
  const prefixMetric = { fromMessage: 0, toMessage: 1, tokens: 17, elapsedMs: 2000 };
  const saved = { adapterId: 'harness2', snapshot: { messages: f.messages.slice(), turnMetrics: [prefixMetric] } };
  const view = await require('../main/conversation/cloud-conversation-view').create({ app: { getPath: () => f.root },
    ref: 'passive-usage', record: { transferId: 'token-owner-fixture', sessionId: 'token-owner', taskId: 'task' }, saved });
  t.after(() => view.close());
  view.appendTaskMessage('user', 'Remote request', [], 'task', 'remote-user');
  view.appendTaskRuntimeEvent({ kind: 'text', streamId: 'remote-answer', text: 'Remote answer', done: true, at: 4000 }, 'task', 'remote-text');
  let snap = view.snapshot();
  assert.deepEqual(snap.turnMetrics.map(row => [row.fromMessage, row.toMessage, row.tokens]), [[0, 1, 17], [2, 3, null]]);
  view.appendTaskRuntimeEvent({ kind: 'usage', usageScope: 'turn', usage: { input: 50, output: 29 }, at: 4000 }, 'task', 'remote-usage');
  snap = view.snapshot();
  assert.deepEqual(snap.turnMetrics.map(row => [row.fromMessage, row.toMessage, row.tokens]), [[0, 1, 17], [2, 3, 29]]);
  assert.deepEqual(prefixMetric, { fromMessage: 0, toMessage: 1, tokens: 17, elapsedMs: 2000 });
  assert.deepEqual(view.uiSnapshot({ messageLimit: 1 }).turnMetrics, snap.turnMetrics);
  view.close();
  const reopened = await require('../main/conversation/cloud-conversation-view').create({ app: { getPath: () => f.root },
    ref: 'passive-usage-reopened', record: { transferId: 'token-owner-fixture', sessionId: 'token-owner', taskId: 'task' }, saved });
  t.after(() => reopened.close());
  assert.deepEqual(reopened.snapshot().turnMetrics, snap.turnMetrics);
});

test('the production runtime facade observes transport changes and disposes its native handle once', async t => {
  const f = await fixture(t);
  const { createPiSessionBridge } = require('../main/agent-runtime/pi-session-bridge');
  let closed = 0;
  f.handle.close = () => { closed++; };
  f.handle.submit = () => ({ accepted: true });
  const bridge = createPiSessionBridge({ runnerAdapters: [], sessionModule: {
    probe: async () => ({ ok: true }), open: async () => ({ ok: true, session: f.handle }),
  } });
  const { session: facade } = await bridge.open({ ref: f.handle.ref, cwd: f.handle.cwd });
  // Warm the facade's bound-function cache before changing execution ownership.
  assert.equal(facade.snapshot().cloudHandoff, undefined);
  assert.equal(facade.selectModel().ok, true);
  assert.equal(facade.submit().accepted, true);
  const preview = await f.cloud.preview(facade);
  await f.cloud.confirm(facade, { previewId: preview.previewId,
    assigneeId: preview.targets[0].id, instruction: 'Continue remotely', model: 'test-model' });
  assert.equal(facade.snapshot().cloudHandoff.phase, 'committed');
  assert.equal(facade.selectModel().ok, false);
  assert.equal(facade.submit().accepted, false);
  assert.equal(bridge.runtimeSession(facade.ref).send('local replay').accepted, false);
  await facade.close(); await bridge.dispose();
  assert.equal(closed, 1, 'registry disposal invokes the original native close exactly once');
  assert.equal(f.stops, 0, 'disposing a local view must never cancel the cloud executor');
  assert.equal(bridge.get(facade.ref), null);
  // The fixture closes once more after this test; that is outside registry ownership.
});

test('reopening a committed cloud conversation needs no local SDK, model or Runner and preserves original messages', async t => {
  const f = await fixture(t, 'opencode'); await f.cloud.confirm(f.handle, await f.input());
  f.handle.close();
  const { createPiSessionBridge } = require('../main/agent-runtime/pi-session-bridge');
  const bridge = createPiSessionBridge({ runnerAdapters: [], sessionModule: {
    probe: () => assert.fail('must not probe a local Agent'), open: () => assert.fail('must not open a local Agent'),
  } });
  const fresh = f.controller(), raw = await fresh.reopen(f.handle.sessionId, 'cloud-view');
  assert.deepEqual(raw.outputs(), [], 'a cloud handoff must not scan the original local workspace');
  assert.deepEqual((await raw.outputSnapshotAsync()).files, []);
  const handle = bridge.attachView(raw);
  await new Promise(resolve => setImmediate(resolve));
  let messages = handle.snapshot().messages;
  assert.equal(messages[0].text, 'Finish report');
  assert.equal(messages[1].blocks[0].text, 'Draft ready');
  assert.equal(messages.filter(row => row.blocks?.[0]?.text === 'Cloud continues').length, 1);
  assert.equal(bridge.runtimeSession(handle.ref), null);
  assert.equal((await fresh.send(handle, 'Continue in the cloud', [], {})).ok, true);
  await handle.close();
  const again = await fresh.reopen(f.handle.sessionId, 'cloud-view-again');
  await new Promise(resolve => setImmediate(resolve));
  messages = again.snapshot().messages;
  assert.equal(messages.filter(row => row.blocks?.[0]?.text === 'Cloud continues').length, 1);
  assert.equal(messages.filter(row => row.text === 'Remote followup').length, 1);
  assert.equal(f.starts, 1); assert.equal(f.stops, 0);
  again.close(); await bridge.dispose();
});

test('a real Pi SDK archive hands off through its actual snapshot and releases cleanly', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const pi = await require('../e2e/fixtures/resumed-pi.cjs').create(path.join(f.root, 'native'));
  t.after(() => pi.close());
  const native = await pi.open();
  await fs.writeFile(path.join(native.cwd, 'verified.md'), '# Existing delivery\n');
  const { createPiSessionBridge } = require('../main/agent-runtime/pi-session-bridge');
  const bridge = createPiSessionBridge({ runnerAdapters: [], sessionModule: {
    probe: async () => ({ ok: true }), open: async () => ({ ok: true, session: native }),
  } });
  t.after(() => bridge.dispose());
  const opened = await bridge.open({ ref: native.ref, cwd: native.cwd });
  assert.equal(opened.ok, true, opened.reason);
  const projected = require('../main/conversation/portable-workspace').safeMetadata(source(opened.session));
  assert.ok(projected.messages.some(row => row.text === 'Previous report is preserved.'));
  const reviewed = await f.cloud.preview(opened.session);
  await f.cloud.confirm(opened.session, { previewId: reviewed.previewId, assigneeId: reviewed.targets[0].id,
    model: 'test-model', instruction: 'Continue with the preserved document' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(opened.session.snapshot().cloudHandoff.phase, 'committed');
  assert.ok(opened.session.snapshot().messages.some(row => row.blocks?.some(block => block.text === 'Cloud continues')));
  assert.equal(opened.session.submit('Do not execute locally').accepted, false);
  assert.equal(pi.requests.length, 0, 'handoff never replays the task into the local model');
  await opened.session.close(); assert.equal(f.stops, 0);
  const reopened = await f.controller().reopen(native.sessionId, 'passive-sdk-view');
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(reopened.snapshot().messages.some(row => row.blocks?.some(block => block.text === 'Previous report is preserved.')));
  reopened.close();
});


test('cloud handoff replaces stale local duration with remote turn timestamps', async t => {
  const f = await fixture(t);
  const start = Date.now() - 14000;
  f.snapshot.execution = { elapsedMs: 2700000000, stopKind:'agent-stall', turnQueue:{activeQueueId:'local'} };
  f.remotePage = {ok:true,ref:'run-1',status:'running',startedAt:new Date(start).toISOString(),round:1,last:0,items:[]};
  await f.cloud.confirm(f.handle, await f.input());
  for (let attempt = 0; attempt < 30 && !f.observations; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  const execution = f.handle.snapshot().execution;
  assert.equal(execution.startedAt, start);
  assert.ok(execution.elapsedMs >= 14000 && execution.elapsedMs < 20000);
  assert.equal(execution.cloud, true);
  assert.equal(execution.stopKind, undefined);
  assert.equal(execution.turnQueue, undefined);
});
