'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { create } = require('../main/agent-runtime/usage-outbox');
const { usageFromSnapshot, micro } = require('../main/agent-runtime/usage-values');
const { createUsageReporter } = require('../main/agent-runtime/usage-reporter');

function fixture(t) {
  const base = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(base, 'soduwork-accounting-'));
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(root)), base);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, file: path.join(root, 'usage-outbox.json'), app: { getPath: () => root } };
}
const row = (scope, total, bucket = 'day-A') => ({ scope, bucket, hub: 'http://fixture', clientId: 'device',
  payload: { idempotencyKey: scope, usage: { total, costMicrousd: 0 }, occurredAt: '2026-10-22T00:00:00Z' } });

test('unacknowledged usage survives 501 sessions and process restart without eviction', async t => {
  const { file } = fixture(t), queue = create(file);
  for (let i = 0; i < 501; i++) queue.enqueue(row('session-' + i, i + 1));
  await queue.persist();
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(file)).rows).length, 501);
  const restored = create(file), sent = [];
  await restored.drain(async value => sent.push(value.payload.idempotencyKey), 1000);
  assert.equal(sent.length, 501); assert.equal(sent[0], 'session-0');
  assert.equal(restored.pending(), 0);
});

test('failed checkpoints preserve session order while another session can upload', async t => {
  const { file } = fixture(t), queue = create(file), sent = [];
  queue.enqueue(row('A', 100, 'model-A')); queue.enqueue(row('A', 300, 'model-B'));
  queue.enqueue(row('B', 50)); await queue.persist();
  await queue.drain(async value => { sent.push(value.payload.idempotencyKey); if (value.scope === 'A') throw Error('offline'); });
  assert.deepEqual(sent, ['A', 'B']); assert.equal(queue.pending(), 2);
  const replay = [];
  await queue.drain(async value => replay.push([value.bucket, value.payload.usage.total]));
  assert.deepEqual(replay, [['model-A', 100], ['model-B', 300]]);
});

test('an observation during an in-flight upload is retained even in the same millisecond', async t => {
  const { file } = fixture(t), queue = create(file);
  queue.enqueue(row('A', 10)); await queue.persist();
  let release, started;
  const ready = new Promise(resolve => { started = resolve; });
  const sending = queue.drain(async () => { started(); await new Promise(resolve => { release = resolve; }); });
  await ready; queue.enqueue(row('A', 20)); release(); await sending;
  assert.equal(queue.pending(), 1);
  const totals = []; await queue.drain(async value => totals.push(value.payload.usage.total));
  assert.deepEqual(totals, [20]);
});

test('many unavailable old accounts cannot starve a valid account behind the batch limit', async t => {
  const { file } = fixture(t), queue = create(file), accepted = [];
  for (let i = 0; i < 35; i++) queue.enqueue(row('old-' + i, 10));
  queue.enqueue(row('current', 20)); await queue.persist();
  const post = async value => { if (value.scope.startsWith('old-')) throw Error('old account'); accepted.push(value.scope); };
  await queue.drain(post); await queue.drain(post);
  assert.deepEqual(accepted, ['current']); assert.equal(queue.pending(), 35);
});

test('malformed queue evidence is preserved instead of silently replaced', async t => {
  const { file } = fixture(t), failures = [];
  fs.writeFileSync(file, '{broken');
  const queue = create(file, error => failures.push(error));
  assert.equal(queue.enqueue(row('A', 10)), false);
  await assert.rejects(queue.persist(), /recovery/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken'); assert.equal(failures.length, 1);
});

test('a valid JSON document with corrupt checkpoint rows cannot crash startup or overwrite evidence', async t => {
  const { file } = fixture(t), raw = JSON.stringify({ v: 1, rows: { invalid: null } });
  fs.writeFileSync(file, raw);
  const queue = create(file);
  assert.equal(queue.pending(), 0); assert.equal(queue.enqueue(row('A', 10)), false);
  assert.equal(fs.readFileSync(file, 'utf8'), raw);
});

test('successful HTTP without an accounting acknowledgement leaves the record pending', async t => {
  const { app, file } = fixture(t);
  const reporter = createUsageReporter({ app, identityOf: async () => ({ hub: 'http://fixture', clientId: 'device' }),
    fetchImpl: async () => ({ ok: true, text: async () => '<html>login</html>' }) });
  reporter.observe({ sessionId: 'A', usageIdentity: { hub: 'http://fixture', clientId: 'device' } }, { usage: { input: 10 } });
  await reporter.flush();
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(file)).rows).length, 1);
});

test('integer micro-USD rounds receipts consistently and does not invent missing cost', () => {
  assert.equal(micro(0.0000005), 1); assert.equal(micro('1e-6'), 1);
  const usage = usageFromSnapshot({ messages: [
    { role: 'assistant', done: true, usage: { input: 10, cost: 0.0000015 } },
    { role: 'assistant', done: true, usage: { input: 20, cost: 0.0000015 } },
    { role: 'assistant', done: true, usage: { input: 30 } },
    { role: 'assistant', done: true, usage: { input: 0, output: 0 } },
  ] });
  // Sum exact receipts before rounding the cumulative micro-USD ledger.
  assert.equal(usage.costMicrousd, 3); assert.equal(usage.costUsd, '0.000003000000'); assert.equal(usage.costKnown, false);
  assert.equal(usage.total, 60); assert.equal(usage.requests, 3);
  assert.equal(usageFromSnapshot({ usage: { input: 10, cost: 0 } }).costKnown, true);
});

test('raw receipts retain hidden usage, model and Beijing day boundaries when replayed offline', async t => {
  const { file, app } = fixture(t), sent = [];
  const reporter = createUsageReporter({ app,
    identityOf: async () => ({ hub: 'http://fixture', clientId: 'device', session: 'fixture' }),
    fetchImpl: async (_url, options) => { sent.push(JSON.parse(options.body)); return { ok: true, text: async () => '{"ok":true}' }; },
  });
  const receipts = [
    { usage: { input: 100, output: 10, cost: 0.0000015 }, model: 'model-A', at: Date.parse('2026-10-21T15:59:00Z') },
    { usage: { input: 200, output: 20, cost: 0.0000015 }, model: 'model-B', at: Date.parse('2026-10-21T16:01:00Z') },
  ];
  const handle = { sessionId: 'conversation', model: 'model-B', usageIdentity: { hub: 'http://fixture', clientId: 'device' } };
  reporter.observe(handle, { messages: [{ role: 'user' }], usageReceipts: receipts });
  await reporter.persist(); assert.equal(Object.keys(JSON.parse(fs.readFileSync(file)).rows).length, 2);
  await reporter.flush();
  assert.deepEqual(sent.map(value => [value.model, value.usage.total, value.usage.costMicrousd]), [['model-A', 110, 2], ['model-B', 330, 3]]);
  assert.deepEqual(sent.map(value => value.occurredAt), receipts.map(receipt => new Date(receipt.at).toISOString()));
  // Replaying the same historical receipts does not create another upload.
  reporter.observe(handle, { usageReceipts: receipts }); await reporter.flush(); assert.equal(sent.length, 2);
});

test('cloud execution projections are not billed a second time by the desktop', async t => {
  const { app } = fixture(t), sent = [];
  const reporter = createUsageReporter({ app, identityOf: async () => ({ hub: 'http://fixture', clientId: 'device' }),
    fetchImpl: async (_url, options) => { sent.push(options); return { ok: true, text: async () => '{"ok":true}' }; } });
  reporter.observe({ sessionId: 'cloud', usageIdentity: { hub: 'http://fixture', clientId: 'device' } },
    { cloudHandoff: { phase: 'committed' }, usage: { input: 100, output: 20, cost: 1 } });
  await reporter.flush(); assert.equal(sent.length, 0);
});

test('accounting receipts include tool-only answers and remain cached during token deltas', () => {
  const accumulator = require('../main/pi-session/event-stream').create();
  accumulator.push({ type: 'message_start', message: { role: 'assistant' } });
  accumulator.push({ type: 'message_end', message: { role: 'assistant', model: 'A', provider: 'fixture',
    completedAt: Date.parse('2026-10-22T01:00:00Z'), content: [], usage: { input: 10, output: 5 } } });
  const first = accumulator.snapshot();
  assert.equal(first.usageReceipts.length, 1);
  assert.equal(first.usageReceipts[0].model, 'A');
  accumulator.push({ type: 'message_start', message: { role: 'assistant' } });
  const second = accumulator.snapshot();
  accumulator.push({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'next' } });
  assert.equal(accumulator.snapshot().usageReceipts, second.usageReceipts);
  assert.equal(accumulator.uiSnapshot({ messageLimit: 80 }).usageReceipts, undefined);
});

test('legacy Pi outbox scopes are quarantined before upload or managed high-water initialization', async t => {
  const { app, file } = fixture(t), sent = [];
  const identity = { hub: 'http://fixture', clientId: 'device', session: 'fixture' };
  const scope = id => JSON.stringify([identity.hub, identity.clientId, '', id]);
  const checkpoint = (id, total, agent, provider, extra = {}) => ({ hub: identity.hub, clientId: identity.clientId,
    scope: scope(id), bucket: provider, ...extra,
    payload: { idempotencyKey: id, sourceType: 'chat', sourceId: id, conversationId: id,
      agent, provider, model: provider === 'soduwork' ? 'private-local-model' : 'managed-model',
      ...(provider === 'managed' ? { quotaUsageToken: 'trusted-fixture-token' } : {}),
      usage: { input: total, total }, occurredAt: '2026-10-22T00:00:00Z' } });
  const rows = {
    local: checkpoint('mixed', 1000, 'pi', 'soduwork'),
    contaminatedManaged: checkpoint('mixed', 1100, 'pi', 'managed'),
    external: checkpoint('external', 20, 'custom-fixture', 'external'),
    current: checkpoint('current', 30, 'pi', 'managed', { ownershipVersion: 1 }),
  };
  fs.writeFileSync(file, JSON.stringify({ v: 1, generation: 1, rows }));
  const options = { app, identityOf: async () => identity,
    fetchImpl: async (_url, request) => { sent.push(JSON.parse(request.body)); return { ok: true, text: async () => '{"ok":true}' }; } };
  const reporter = createUsageReporter(options);
  reporter.observe({ sessionId: 'mixed', model: 'managed-model', usageAgentKey: 'pi', usageIdentity: identity }, {
    usageReceipts: [{ localOnly: true, model: 'private-local-model', usage: { input: 1000 } },
      { model: 'managed-model', provider: 'managed', quotaUsageToken: 'trusted-fixture-token', usage: { input: 10 } }],
  });
  await reporter.flush();
  assert.deepEqual(sent.map(value => [value.idempotencyKey, value.usage.total]).sort(),
    [['current', 30], ['external', 20], ['mixed', 10]]);
  assert.doesNotMatch(JSON.stringify(sent), /private-local-model|ownershipVersion/);
  assert.ok(sent.filter(value => value.provider === 'managed').every(value => value.quotaUsageToken === 'trusted-fixture-token'));
  const saved = JSON.parse(fs.readFileSync(file));
  assert.deepEqual(saved.quarantined, { local: rows.local, contaminatedManaged: rows.contaminatedManaged });
  assert.deepEqual(saved.rows, {});
  const restarted = createUsageReporter(options);
  await restarted.flush(); assert.equal(sent.length, 3, 'quarantine remains excluded after restart');
});

test('outbox recovery preserves a quarantine staged before atomic replacement', async t => {
  const { app, file } = fixture(t), sent = [];
  const legacy = { hub: 'http://fixture', clientId: 'device', scope: 'legacy',
    payload: { idempotencyKey: 'legacy', agent: 'pi', provider: 'soduwork', usage: { input: 1000 } } };
  fs.writeFileSync(file, JSON.stringify({ v: 1, generation: 1, rows: { legacy } }));
  fs.writeFileSync(file + '.tmp', JSON.stringify({ v: 1, generation: 2, rows: {}, quarantined: { legacy } }));
  const identity = { hub: 'http://fixture', clientId: 'device' };
  const reporter = createUsageReporter({ app, identityOf: async () => identity,
    fetchImpl: async (_url, request) => { sent.push(JSON.parse(request.body)); return { ok: true, text: async () => '{"ok":true}' }; } });
  reporter.observe({ sessionId: 'current', model: 'managed', usageIdentity: identity }, { usage: { input: 10 } });
  await reporter.flush();
  assert.deepEqual(sent.map(value => value.usage.total), [10]);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)).quarantined, { legacy });
});
