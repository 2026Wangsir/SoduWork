'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createUsageReporter } = require('../main/agent-runtime/usage-reporter');
const store = require('../main/local-model-store.cjs');

const identity = { hub: 'http://hub.example', clientId: 'synthetic-device', session: 'synthetic-session' };
const localRef = 'local:synthetic-private:model';

function fixture(t) {
  const base = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(base, 'soduwork-local-reporting-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const requests = [], errors = [];
  const options = { app: { getPath: () => root }, identityOf: async () => identity,
    onError: error => errors.push(error.message),
    fetchImpl: async (url, request) => {
      requests.push({ url, method: request.method, body: JSON.parse(request.body) });
      return { ok: true, text: async () => '{"ok":true}' };
    } };
  return { root, file: path.join(root, 'usage-outbox.json'), requests, errors, options };
}

function secureStorage(t, app) {
  const key = crypto.randomBytes(32);
  const safeStorage = { isEncryptionAvailable: () => true,
    encryptString(value) {
      const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const bytes = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), bytes]);
    },
    decryptString(bytes) {
      const cipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      cipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8');
    } };
  store.configure({ app, safeStorage });
  t.after(() => store.configure(null));
  return safeStorage;
}

function handle(sessionId = 'synthetic-conversation') {
  return { sessionId, usageIdentity: identity, usageAgentKey: 'pi', model: { id: 'managed-model' } };
}

function receipt(model, total, at = '2026-11-11T01:00:00Z') {
  return { model, provider: 'synthetic-provider', usage: { input: total, total }, at: Date.parse(at) };
}

test('explicit local references cannot report usage when receipt ownership flags are missing', async t => {
  const f = fixture(t), reporter = createUsageReporter(f.options);
  reporter.observe(handle(), { usageReceipts: [receipt(localRef, 987654)] });
  await reporter.flush();
  assert.deepEqual(f.requests, [], 'local references must be rejected before any usage request');
  if (fs.existsSync(f.file)) assert.doesNotMatch(fs.readFileSync(f.file, 'utf8'), /synthetic-private|987654/);
});

test('mixed usage omits unmarked local receipts without changing acknowledged managed history', async t => {
  const f = fixture(t), reporter = createUsageReporter(f.options), active = handle();
  const first = receipt('managed-model', 12);
  reporter.observe(active, { usageReceipts: [first] });
  await reporter.flush();
  assert.equal(f.requests.length, 1);
  const acknowledged = JSON.stringify(f.requests[0]);

  const local = receipt('  ' + localRef + '  ', 987654);
  reporter.observe(active, { usageReceipts: [first, local] });
  await reporter.flush();
  assert.equal(f.requests.length, 1, 'a local turn cannot amend an acknowledged managed checkpoint');

  reporter.observe(active, { usageReceipts: [first, local, receipt('managed-next', 8, '2026-11-12T01:00:00Z')] });
  await reporter.flush();
  assert.deepEqual(f.requests.map(row => [row.body.model, row.body.usage.total]),
    [['managed-model', 12], ['managed-next', 20]]);
  assert.equal(JSON.stringify(f.requests[0]), acknowledged, 'the earlier acknowledged payload remains unchanged');
  assert.ok(f.requests.every(row => row.method === 'POST' && row.url.endsWith('/usage/events')));
  assert.doesNotMatch(JSON.stringify(f.requests), /synthetic-private|987654/);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file)).rows, {});
});

test('restored local checkpoints quarantine their contaminated scope before retry or high-water recovery', async t => {
  const f = fixture(t), scope = JSON.stringify([identity.hub, identity.clientId, '', 'restored']);
  const row = (model, total, sessionId = 'restored') => ({ ownershipVersion: 1,
    hub: identity.hub, clientId: identity.clientId,
    scope: sessionId === 'restored' ? scope : JSON.stringify([identity.hub, identity.clientId, '', sessionId]),
    bucket: model, payload: { idempotencyKey: sessionId, sourceType: 'chat',
      sourceId: sessionId, conversationId: sessionId, agent: 'pi', provider: 'synthetic-provider',
      model, usage: { input: total, total }, occurredAt: '2026-11-11T01:00:00Z' } });
  const rows = { local: row(localRef, 987654), contaminated: row('managed-model', 987666),
    independent: row('managed-model', 5, 'independent') };
  fs.writeFileSync(f.file, JSON.stringify({ v: 1, generation: 1, rows }));
  const reporter = createUsageReporter(f.options);
  reporter.observe(handle('restored'), { usageReceipts: [receipt(localRef, 987654), receipt('managed-model', 12)] });
  await reporter.flush();
  assert.deepEqual(f.requests.map(row => [row.body.idempotencyKey, row.body.usage.total]).sort(),
    [['independent', 5], ['restored', 12]]);
  assert.doesNotMatch(JSON.stringify(f.requests), /synthetic-private|987654|987666/);
  const saved = JSON.parse(fs.readFileSync(f.file));
  assert.deepEqual(saved.quarantined, { local: rows.local, contaminated: rows.contaminated });
  assert.deepEqual(saved.rows, {});
  const restarted = createUsageReporter(f.options);
  await restarted.flush();
  assert.equal(f.requests.length, 2, 'quarantined checkpoints never retry after restart');
});

test('pending and previously quarantined model references migrate through encrypted aliases without changing usage', async t => {
  for (const alreadyQuarantined of [false, true]) {
    const f = fixture(t);
    secureStorage(t, f.options.app);
    const payload = { idempotencyKey: 'retired-local', model: localRef,
      sourceTitle: 'Ordinary retained title', usage: { input: 987654, total: 987654 } };
    const row = { ownershipVersion: 1, hub: identity.hub, clientId: identity.clientId,
      scope: 'retired-local', payload,
      bucket: JSON.stringify(['2026-11-11', 'pi', 'soduwork', localRef, 'personal', 'direct', '']),
      signature: JSON.stringify({ ...payload, occurredAt: '' }) };
    fs.writeFileSync(f.file, JSON.stringify({ v: 1, generation: 1,
      rows: alreadyQuarantined ? {} : { local: row }, ...(alreadyQuarantined ? { quarantined: { local: row } } : {}) }));
    const reporter = createUsageReporter(f.options);
    await reporter.flush();
    assert.deepEqual(f.requests, []);
    assert.deepEqual(f.errors, []);
    const raw = fs.readFileSync(f.file, 'utf8'), saved = JSON.parse(raw);
    const alias = saved.quarantined.local.payload.model;
    assert.match(alias, /^local:model-[a-f0-9]{32}$/);
    assert.equal(alias, store.canonicalReference(localRef));
    assert.deepEqual(saved.quarantined.local.payload.usage, payload.usage);
    assert.equal(saved.quarantined.local.payload.sourceTitle, payload.sourceTitle);
    assert.equal(JSON.parse(saved.quarantined.local.bucket)[3], alias);
    assert.equal(JSON.parse(saved.quarantined.local.signature).model, alias);
    assert.deepEqual(JSON.parse(saved.quarantined.local.signature).usage, payload.usage);
    assert.deepEqual(saved.rows, {});
    assert.doesNotMatch(raw, /synthetic-private/);
    assert.doesNotMatch(fs.readFileSync(path.join(f.root, 'local-models.secure.json'), 'utf8'), /synthetic-private/);
    const restarted = createUsageReporter(f.options);
    await restarted.flush();
    assert.equal(fs.readFileSync(f.file, 'utf8'), raw, 'a migrated quarantine is not rewritten on every restart');
    assert.deepEqual(f.requests, []);
  }
});

test('unavailable encryption keeps pending evidence isolated and emits only a generic migration error', async t => {
  const f = fixture(t), safeStorage = secureStorage(t, f.options.app);
  safeStorage.isEncryptionAvailable = () => false;
  const row = { ownershipVersion: 1, hub: identity.hub, clientId: identity.clientId,
    payload: { idempotencyKey: 'retired-local', model: localRef, usage: { total: 987654 } },
    bucket: JSON.stringify(['2026-11-11', 'pi', 'soduwork', localRef]),
    signature: JSON.stringify({ model: localRef, usage: { total: 987654 } }) };
  fs.writeFileSync(f.file, JSON.stringify({ v: 1, generation: 1, rows: { local: row } }));
  const reporter = createUsageReporter(f.options);
  await reporter.flush();
  assert.deepEqual(f.requests, []);
  assert.deepEqual(f.errors, ['Local usage quarantine requires secure migration']);
  const saved = JSON.parse(fs.readFileSync(f.file));
  assert.deepEqual(saved.rows, {});
  assert.deepEqual(saved.quarantined, { local: row }, 'failed encryption cannot discard or partially replace evidence');
  assert.equal(fs.existsSync(path.join(f.root, 'local-models.secure.json')), false);
  safeStorage.isEncryptionAvailable = () => true;
  const restarted = createUsageReporter(f.options);
  await restarted.flush();
  assert.deepEqual(f.requests, []);
  assert.doesNotMatch(fs.readFileSync(f.file, 'utf8'), /synthetic-private/);
});

test('local model conversations retain authenticated directory sync without model metadata or error details', async t => {
  const session = Buffer.from(JSON.stringify({ typ: 'device', uid: 'synthetic-owner',
    cid: identity.clientId, exp: 9999999999 })).toString('base64url') + '.' + 'a'.repeat(64);
  const owner = { ...identity, session };
  const saved = new Map(), queued = new Map(), requests = [];
  const model = { localOnly: true, id: 'synthetic-private-id', modelRef: localRef,
    label: 'synthetic-private-label', baseUrl: 'http://provider.example/private-sentinel',
    key: 'synthetic-private-key', usage: { total: 987654 } };
  const snapshot = { status: 'error', messages: [
    { id: 'user-1', role: 'user', text: 'Ordinary synthetic request' },
    { id: 'reply-1', role: 'assistant', text: 'Ordinary synthetic reply', done: true,
      model: model.id, provider: 'synthetic-private-provider', usage: model.usage,
      errorMessage: 'synthetic-private-error ' + model.baseUrl },
  ], modelSelection: { name: localRef, activeName: localRef, model, activeModel: model },
  usageReceipts: [{ ...receipt(localRef, 987654), localOnly: true }],
  lastError: 'synthetic-private-error ' + model.key };
  const sync = require('../main/conversation/account-sync').create({ app: {}, metadataOnly: true,
    realtime: false, identityOf: async () => owner,
    store: { session: key => saved.get(key), setSession: (key, value) => saved.set(key, value),
      enqueue: job => queued.set(job.id, job), jobs: () => [...queued.values()],
      ack: id => queued.delete(id), fail() {} },
    fetch: async (current, url, request) => {
      assert.equal(current.session, owner.session, 'normal authenticated directory behavior is retained');
      const body = JSON.parse(request.body); requests.push({ url, body });
      return { ok: true, status: 200, json: async () => ({ ok: true,
        conversationId: 'synthetic-account-conversation', sourceRevision: body.sourceRevision }) };
    } });
  t.after(() => sync.close());
  assert.ok(sync.bind({ sessionId: 'synthetic-native-session', model, localOnly: true,
    snapshot: () => snapshot, historyRow: () => ({ title: 'Ordinary conversation', model, usage: model.usage }) }, owner));
  await sync.flush();
  assert.equal(requests.length, 1, 'local model use must not suppress ordinary conversation directory sync');
  const body = requests[0].body;
  assert.equal(requests[0].url, identity.hub + '/api/v1/account-conversations/sync');
  assert.equal(body.title, 'Ordinary conversation');
  assert.equal(body.state, 'failed');
  assert.equal(body.storageMode, 'endpoint');
  assert.equal(body.messageCount, 2);
  assert.deepEqual(body.messages, []);
  assert.deepEqual(Object.keys(body).sort(), ['archived', 'deleted', 'messageCount', 'messages', 'snapshotComplete',
    'sourceClientId', 'sourceEpoch', 'sourceRevision', 'sourceSessionId', 'state', 'storageMode', 'tailDigest',
    'taskProjectionId', 'title'].sort());
  assert.doesNotMatch(JSON.stringify(requests), /synthetic-private|987654|local:|Ordinary synthetic/);
  assert.equal(queued.size, 0);
});
