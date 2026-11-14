'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const localModels = require('../main/local-model-store.cjs');
const { prepare, request } = require('../main/pi-session/task-input');
const { create } = require('../main/pi-session/start-receipts.cjs');

function fixture(t, adapterId = 'pi') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-local-task-receipt-')));
  const app = { getPath: () => root };
  localModels.configure({ app, safeStorage: { isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(value), decryptString: value => Buffer.from(value).toString() } });
  const catalog = localModels.save({ providers: [{ id: 'private', baseUrl: 'http://127.0.0.1:8686/v1', authMode: 'none' }],
    models: [{ providerId: 'private', name: 'private-wire-model' }] });
  const ref = catalog.usable[0].name, now = Math.floor(Date.now() / 1000);
  const identity = { hub: 'http://fixture', clientId: 'device', session: Buffer.from(JSON.stringify({
    typ: 'device', uid: 'owner', cid: 'device', iat: now, exp: now + 3600 })).toString('base64url') + '.' + 'a'.repeat(64) };
  let selection = { name: ref, model: { id: ref, localOnly: true } }, online = true;
  const handle = { adapterId, sessionId: 'chat', cwd: root, usageIdentity: identity,
    snapshot: () => ({ modelSelection: selection }) };
  const task = { id: 'task', title: 'Local requirement', status: 'todo', ownerClientId: identity.clientId, workRouting: {} };
  const received = [];
  t.mock.method(global, 'fetch', async (url, options) => {
    if (url.endsWith('/attachments')) return Response.json([]);
    if (url.endsWith('/tasks/task')) return Response.json(task);
    assert.equal(url, 'http://fixture/api/v1/tasks/task/conversation-turn');
    const body = JSON.parse(options.body);
    if (!online) throw Error('offline fixture');
    received.push(body);
    if (body.executionChoice === 'native') task.workRouting = { selectedStrategy: 'direct', executionContext: {
      strategy: 'direct', agent: { id: body.agentId }, runner: { mode: 'local' }, model: body.model,
      ...(body.modelSource ? { modelSource: body.modelSource } : {}) } };
    const state = { prepare: 'queued', start: 'running', started: 'running', complete: 'completed' }[body.action];
    task.workRouting.conversationTurn = { ...body, state };
    return Response.json({ ok: true, turn: task.workRouting.conversationTurn, task });
  });
  t.mock.method(require('../main/pi-session/task-delivery.cjs'), 'capture', async () => null);
  const options = { app, identityOf: async () => identity, request, intervalMs: 0 };
  const receipts = create(options);
  t.after(() => { receipts.dispose(); localModels.configure(null); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, app, ref, identity, handle, task, received, receipts, options,
    runtime: { app, handle, startReceipts: receipts, identityOf: async () => identity },
    select: value => { selection = value; }, online: value => { online = value; } };
}

test('native preparation freezes the verified local model and sends only a generic source through its full lifecycle', async t => {
  const f = fixture(t);
  const input = await prepare(f.identity, 'task', 'chat', 'turn', 'Implement the requirement', {}, f.runtime);
  assert.equal(input.modelName, f.ref);
  f.select({ name: 'hub-model', model: { id: 'hub-model' } });
  await input.beforeTurn(); await input.onStarted(); await input.afterTurn('completed');
  assert.deepEqual(f.received.map(row => row.action), ['prepare', 'start', 'started', 'complete']);
  assert.ok(f.received.every(row => row.modelSource === 'device' && row.agentId === 'local:pi'));
  assert.doesNotMatch(JSON.stringify(f.received), /local:model-|private-wire-model|8686|"usage"/);
  assert.equal(input.modelName, f.ref, 'changing the future selection cannot change this queued turn');
  const next = await prepare(f.identity, 'task', 'chat', 'managed-next', 'Next turn', {}, f.runtime);
  assert.equal(next.modelName, '');
  assert.equal(f.received.at(-1).modelSource, undefined, 'a new Hub-model turn does not inherit device ownership');
});

test('every managed local runtime derives its device receipt from the actual handle and store', async t => {
  for (const agent of require('../main/agent-runtime/runtime-catalog').runtimes().filter(row => row.modelMode === 'managed')) {
    await t.test(agent.id, async child => {
      const f = fixture(child, agent.id);
      const input = await prepare(f.identity, 'task', 'chat', 'turn', 'Work', {}, f.runtime);
      assert.equal(input.modelName, f.ref);
      assert.equal(f.received[0].modelSource, 'device');
      assert.equal(f.received[0].agentId, 'local:' + agent.id);
      assert.doesNotMatch(JSON.stringify(f.received), /local:model-|private-wire-model/);
    });
  }
});

test('explicit native local choices persist only the device marker in Hub execution context', async t => {
  const f = fixture(t);
  const input = await prepare(f.identity, 'task', 'chat', 'turn', 'Implement the requirement',
    { executionChoice: 'native', agentId: 'local:pi', model: f.ref }, f.runtime);
  assert.equal(input.modelName, f.ref);
  assert.equal(f.received[0].model, '');
  assert.equal(f.received[0].modelSource, 'device');
  assert.equal(f.task.workRouting.executionContext.model, '');
  assert.equal(f.task.workRouting.executionContext.modelSource, 'device');
  assert.doesNotMatch(JSON.stringify(f.received), /local:model-|private-wire-model/);
});

test('a fresh handle can queue an explicit verified local model and retry with a newly selected Hub model', async t => {
  const f = fixture(t);
  f.select({ name: 'previous-hub-model', model: { id: 'previous-hub-model' } });
  const input = await prepare(f.identity, 'task', 'chat', 'turn', 'Work', { model: f.ref }, f.runtime);
  assert.equal(input.modelName, f.ref);
  assert.equal(f.received[0].modelSource, 'device');
  f.select({ name: 'new-hub-model', model: { id: 'new-hub-model' } });
  await input.beforeRetry();
  assert.notEqual(f.received.at(-1).turnId, 'turn');
  assert.equal(f.received.at(-1).modelSource, undefined);
  await input.beforeTurn();
  assert.equal(f.received.at(-1).modelSource, undefined);
  assert.doesNotMatch(JSON.stringify(f.received), /local:model-|private-wire-model/);
});

test('production recovery and queue application keep receipt ownership bound to the admitted retry model', async t => {
  for (const target of ['managed', 'device']) {
    await t.test(target, async child => {
      const f = fixture(child);
      const initial = target === 'managed' ? f.ref : 'hub-initial';
      const admitted = target === 'managed' ? 'hub-retry' : f.ref;
      const future = target === 'managed' ? f.ref : 'hub-future';
      const applied = [];
      const model = name => name.startsWith('local:')
        ? { id: name, modelRef: name, localOnly: true, wireModelId: localModels.resolve(name).name }
        : { id: name, localOnly: false };
      const selection = require('../main/conversation/model-selection').create({ name: initial, model: model(initial),
        resolve: async name => ({ ok: true, model: model(name) }),
        apply: async current => applied.push({ name: current.id, localOnly: current.localOnly === true,
          wireModel: current.wireModelId || current.id }) });
      f.handle.snapshot = () => ({ modelSelection: selection.view() });
      const input = await prepare(f.identity, 'task', 'chat', 'first', 'Work', { model: initial }, f.runtime);
      const queue = require('../main/pi-session/turn-queue').createTurnQueue();
      const recovery = require('../main/pi-session/model-recovery').create();
      const authorized = [];
      const beforeTurn = require('../main/conversation/quota-admission.cjs').beforeTurn(
        async (_identity, _scope, selected) => authorized.push(selected.model), f.identity, input.beforeTurn,
        { agent: 'pi', modelMode: 'managed', localModel: async name => localModels.resolve(name) });
      const failed = { ok: false, snapshot: { completion: { reason: 'error', retryable: true, error: 'HTTP 503' } } };
      const first = queue.add({ text: input.text, options: { ...input, beforeTurn, taskId: 'task', modelName: input.modelName } });
      await queue.run(queue.take(), async () => failed);
      recovery.remember(first, failed);
      await selection.select(admitted);
      let retried;
      // This is the production session-handle retry-model admission contract.
      recovery.take(first.id, payload => {
        payload.options.modelName = selection.capture();
        retried = queue.add(payload);
        return Boolean(retried);
      });
      assert.ok(retried);
      await selection.select(future);
      // session-open and Runner both apply the queue's captured model only
      // after its beforeTurn/recovery receipts have been admitted.
      const result = await queue.run(queue.take(), async () => {
        await selection.applyForTurn(retried.options.modelName);
        return { ok: true };
      });
      assert.equal(result.ok, true, result.reason);
      assert.equal(selection.capture(), future, 'the future picker remains independent of this retry');
      assert.equal(applied.at(-1).name, admitted);
      assert.equal(applied.at(-1).localOnly, target === 'device');
      assert.deepEqual(authorized, target === 'managed' ? [admitted] : [initial],
        'production quota admission observes the frozen queue choice rather than the future picker');
      const receipts = f.received.filter(row => row.turnId !== 'first');
      assert.deepEqual(receipts.map(row => row.action), ['prepare', 'start', 'complete']);
      assert.ok(receipts.every(row => (row.modelSource === 'device') === applied.at(-1).localOnly));
      assert.doesNotMatch(JSON.stringify(receipts), /local:model-|private-wire-model/);
    });
  }
});

test('raw source flags cannot exempt Hub or account runtimes and deleted selections stop before queue admission', async t => {
  const f = fixture(t);
  f.select({ name: 'hub-model', model: { id: 'hub-model' } });
  await prepare(f.identity, 'task', 'chat', 'hub-turn', 'Work', { modelSource: 'device' }, f.runtime);
  assert.equal(f.received[0].modelSource, undefined);
  f.select({ name: f.ref, model: { id: f.ref, localOnly: true } });
  f.handle.adapterId = 'codex';
  await assert.rejects(prepare(f.identity, 'task', 'chat', 'account-turn', 'Work', {}, f.runtime), /本轮本地模型无法确认/);
  f.handle.adapterId = 'pi'; localModels.save({ models: [] });
  await assert.rejects(prepare(f.identity, 'task', 'chat', 'deleted-turn', 'Work', {}, f.runtime), /已删除/);
  assert.equal(f.received.length, 1);
});

test('device-owned start and terminal receipts survive offline recreation without private model metadata', async t => {
  const f = fixture(t);
  const input = await prepare(f.identity, 'task', 'chat', 'turn', 'Work', {}, f.runtime);
  await input.beforeTurn(); f.online(false);
  assert.equal((await input.onStarted()).pending, true);
  assert.equal((await input.afterTurn('completed')).pending, true);
  const directory = path.join(f.root, 'task-start-receipts');
  const file = fs.readdirSync(directory).find(name => name.endsWith('.json'));
  const raw = fs.readFileSync(path.join(directory, file), 'utf8');
  assert.equal(JSON.parse(raw).modelSource, 'device');
  assert.equal(JSON.parse(raw).modelAgentId, 'local:pi');
  assert.doesNotMatch(raw, /local:model-|private-wire-model|8686|"usage"|"session"/);
  f.online(true); f.receipts.dispose();
  const restored = create(f.options); t.after(() => restored.dispose());
  await restored.flush();
  assert.deepEqual(f.received.map(row => row.action), ['prepare', 'start', 'started', 'complete']);
  assert.ok(f.received.every(row => row.modelSource === 'device'));
  assert.equal(fs.readdirSync(directory).filter(name => name.endsWith('.json')).length, 0);
});
