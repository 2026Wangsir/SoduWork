'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { create, beforeTurn } = require('../main/conversation/quota-admission.cjs');
const { createTurnQueue } = require('../main/pi-session/turn-queue');

function identity(uid = 'owner', lifetime = 3600) {
  const now = Math.floor(Date.now() / 1000);
  const claims = { typ: 'device', uid, cid: 'quota-device', iat: now - 10, exp: now + lifetime };
  return { hub: 'https://quota.example.test', clientId: claims.cid,
    session: Buffer.from(JSON.stringify(claims)).toString('base64url') + '.' + 'a'.repeat(64) };
}
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status });
const allowed = () => reply({ ok: true, quota: { enabled: true, exceeded: false, remaining: 10 } });
const exceeded = () => reply({ detail: { code: 'TOKEN_QUOTA_EXCEEDED', message: 'Quota exhausted',
  quota: { exceeded: true, remaining: 0 } } }, 403);

test('model setup preserves quota guidance and never retries an exhausted account', async () => {
  const { fetchModel } = require('../main/pi-session/model-config');
  let requests = 0;
  const result = await fetchModel(identity(), '', 1000, async () => { requests++; return exceeded(); });
  assert.equal(requests, 1);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'TOKEN_QUOTA_EXCEEDED');
  assert.equal(result.reason, 'Quota exhausted');
  assert.equal(result.status, 403);
  assert.equal(result.quota.remaining, 0);
});

test('cached credentials perform one fresh check per native turn', async () => {
  const current = identity();
  let requests = 0;
  const authorize = create({ identityOf: async () => current, fetchImpl: async (url, options) => {
    requests++;
    assert.equal(url, current.hub + '/api/v1/client-auth/authorize-ai');
    assert.equal(options.headers.Authorization, 'Device ' + current.session);
    return allowed();
  } });
  await authorize(current); await authorize(current);
  assert.equal(requests, 2);
});

test('successful admission emits only a refresh hint, never a model grant as global quota', async () => {
  const current = identity(), events = [];
  const authorize = create({ identityOf: async () => current, fetchImpl: async () => allowed(),
    onQuotaChanged: value => events.push(value) });
  await authorize(current);
  assert.deepEqual(events, [{ hub: current.hub, clientId: current.clientId }]);
  const denied = create({ identityOf: async () => current, fetchImpl: async () => exceeded(),
    onQuotaChanged: value => events.push(value) });
  await assert.rejects(denied(current));
  assert.equal(events.length, 1);
});

test('quota changes during queue wait block execution and preserve existing lifecycle checks', async () => {
  const current = identity();
  let exhausted = false, executions = 0, lifecycles = 0, notifications = 0;
  const authorize = create({ identityOf: async () => current,
    fetchImpl: async () => exhausted ? exceeded() : allowed(), onQuotaExceeded: () => notifications++ });
  const queue = createTurnQueue();
  queue.add({ text: 'first', options: { beforeTurn: beforeTurn(authorize, current, () => lifecycles++) } });
  queue.add({ text: 'queued', options: { beforeTurn: beforeTurn(authorize, current, () => lifecycles++) } });
  await queue.run(queue.take(), async () => { executions++; return { ok: true }; });
  exhausted = true;
  const result = await queue.run(queue.take(), async () => { executions++; return { ok: true }; });
  assert.equal(executions, 1);
  assert.equal(lifecycles, 1);
  assert.equal(notifications, 1);
  assert.equal(result.ok, false);
  assert.match(result.reason, /Quota exhausted/);
});

test('a renewed token for the same account remains valid for an already queued turn', async () => {
  let current = identity();
  const authorize = create({ identityOf: async () => current, fetchImpl: async () => allowed() });
  let executed = false;
  const hook = beforeTurn(authorize, current, () => { executed = true; });
  current.session = identity('owner', -1).session;
  current = identity('owner', 7200);
  await hook();
  assert.equal(executed, true);
});

test('an account switch prevents a stale quota denial from logging out the new account', async () => {
  let current = identity(), resolve;
  let notifications = 0;
  const started = current;
  const authorize = create({ identityOf: async () => current,
    fetchImpl: () => new Promise(done => { resolve = done; }), onQuotaExceeded: () => notifications++ });
  const pending = authorize(started);
  await new Promise(setImmediate);
  current = identity('another-account');
  resolve(exceeded());
  await assert.rejects(pending, /账号或连接环境已变化/);
  assert.equal(notifications, 0);
});

test('offline, malformed and older Hub responses never start work', async () => {
  const current = identity();
  for (const fetchImpl of [async () => { throw Error('Offline'); }, async () => new Response('<html/>'),
    async () => reply({}, 404), async () => reply({}), async () => reply({ ok: true }),
    async () => reply({ ok: true, quota: { enabled: true, exceeded: true } })]) {
    let executed = false;
    const authorize = create({ identityOf: async () => current, fetchImpl });
    await assert.rejects(beforeTurn(authorize, current, () => { executed = true; }));
    assert.equal(executed, false);
  }
});
