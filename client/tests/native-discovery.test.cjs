'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { create: createPoller } = require('../main/native-discovery-polling.cjs');
const { create: createDiscovery } = require('../main/native-discovery.cjs');
const flush = () => new Promise(resolve => setImmediate(resolve));

function clock() {
  let now = 1000, sequence = 0;
  const timers = new Map();
  const next = () => [...timers.values()].sort((a, b) => a.at - b.at)[0];
  return {
    now: () => now, pending: () => timers.size, delay: () => next()?.at - now,
    setTimeout(fn, ms) { const timer = { id: ++sequence, at: now + ms, fn, unref() {} }; timers.set(timer.id, timer); return timer; },
    clearTimeout(timer) { timers.delete(timer.id); },
    async advance(ms) {
      const end = now + ms;
      await flush();
      while (next()?.at <= end) {
        const timer = next(); now = timer.at; timers.delete(timer.id); timer.fn(); await flush();
      }
      now = end; await flush();
    },
  };
}
function identity(owner = 'alice', hub = 'http://hub', clientId = 'pc') {
  return { hub, clientId, session: Buffer.from(JSON.stringify({ typ: 'device', cid: clientId, uid: owner })).toString('base64url') + '.test' };
}

for (const random of [0, 1]) test(`20-minute idle discovery has a bounded request budget (jitter=${random})`, async () => {
  for (const idle of [20000, 60000]) {
    const time = clock(); let calls = 0;
    const poller = createPoller({ ...time, random: () => random, idleMs: () => idle,
      tick: () => { calls++; return { state: 'idle', scope: 'alice' }; } });
    poller.start(); poller.start();
    await time.advance(1200000);
    assert.ok(calls <= (idle === 20000 ? 77 : 29), String(calls));
    assert.ok(calls >= (idle === 20000 ? 59 : 20), String(calls));
    assert.equal(time.pending(), 1);
    poller.stop(); assert.equal(time.pending(), 0);
  }
});

test('requests never overlap and a push burst coalesces to one follow-up', async () => {
  const time = clock(); let resolve, calls = 0;
  const poller = createPoller({ ...time, random: () => 1,
    tick: () => { calls++; return new Promise(done => { resolve = done; }); } });
  poller.start(); await time.advance(5000);
  const a = poller.run(), b = poller.run(); assert.equal(a, b);
  for (let i = 0; i < 1000; i++) poller.wake();
  await time.advance(120000); assert.equal(calls, 1); assert.equal(time.pending(), 0);
  resolve({ state: 'idle' }); await flush(); assert.equal(time.delay(), 1000);
  await time.advance(1000); assert.equal(calls, 2);
  poller.stop(); resolve({ state: 'idle' }); await flush(); assert.equal(time.pending(), 0);
});

test('authentication failures back off despite repeated wake-ups and recover on scope change', async () => {
  const time = clock(); let state = 'blocked', scope = 'alice', calls = 0;
  const poller = createPoller({ ...time, random: () => 1,
    tick: () => { calls++; return { state, scope }; } });
  poller.start(); await time.advance(5000); assert.equal(time.delay(), 60000);
  for (let i = 0; i < 1000; i++) poller.wake();
  await time.advance(59000); assert.equal(calls, 1);
  scope = 'bob'; state = 'idle'; await time.advance(1000); assert.equal(time.delay(), 10000);
  poller.stop();
});

test('network failures exponentially back off, while stop prevents rescheduling', async () => {
  const time = clock();
  const poller = createPoller({ ...time, random: () => 1, tick: () => Promise.reject(Error('offline')) });
  poller.start(); await time.advance(5000);
  for (const delay of [10000, 20000, 40000, 60000]) {
    assert.equal(time.delay(), delay); await time.advance(delay);
  }
  poller.stop(); await time.advance(120000); assert.equal(time.pending(), 0);
});

test('a continuous push stream cannot postpone the pending discovery timer', async () => {
  const time = clock(); let calls = 0;
  const poller = createPoller({ ...time, random: () => 1,
    tick: () => { calls++; return { state: 'idle' }; } });
  poller.start(); poller.wake();
  for (let i = 0; i < 20; i++) { await time.advance(100); poller.wake(); }
  assert.ok(calls >= 2); poller.stop();
});

test('legacy presence polling budgets request duration inside the 20-second interval', async () => {
  const time = clock(); const starts = [];
  const poller = createPoller({ ...time, random: () => 1, maxStartGapMs: () => 20000,
    tick: () => { starts.push(time.now()); return new Promise(resolve => time.setTimeout(() => resolve({ state: 'idle' }), 12000)); } });
  poller.start(); await time.advance(120000);
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - starts[i - 1] <= 20000);
  poller.stop();
});

test('only authenticated, same-account/device/Hub push wakes native discovery', async () => {
  const time = clock(), discovery = createDiscovery(time);
  let current = identity(), wakes = 0;
  const sent = [], socket = { readyState: 1, send: value => sent.push(JSON.parse(value)) };
  const remove = discovery.register('personal-relay', () => wakes++);
  const connection = discovery.attach(socket, current, async () => current);
  assert.equal(discovery.confirmed(current), false);
  connection.message({ type: 'ready' }); await flush();
  assert.deepEqual(sent[0], { t: 'native-discovery', protocol: 1, topics: ['personal-relay'] });
  connection.message({ type: 'native-discovery-ready', protocol: 1 }); await flush();
  assert.equal(discovery.confirmed(current), true);
  assert.equal(discovery.confirmed(identity('bob')), false);
  assert.equal(discovery.confirmed(identity('alice', 'http://other')), false);
  assert.equal(discovery.confirmed(identity('alice', 'http://hub', 'other-pc')), false);
  connection.message({ type: 'native-discovery', topic: 'personal-relay' }); await flush();
  assert.equal(wakes, 1);
  connection.message({ type: 'native-discovery', topic: 'remote-screen' }); await flush();
  assert.equal(wakes, 1);
  current = identity('bob');
  connection.message({ type: 'native-discovery', topic: 'personal-relay' }); await flush();
  // One lifecycle wake discovers the new identity, not the old-account event.
  assert.equal(wakes, 2); assert.equal(discovery.confirmed(current), false);
  connection.message({ type: 'native-discovery', topic: 'personal-relay' }); await flush();
  assert.equal(wakes, 2); remove(); connection.close();
});

test('a missed WS heartbeat confirmation promptly restores HTTP discovery', async () => {
  const time = clock(), discovery = createDiscovery(time), id = identity();
  let wakes = 0, sends = 0;
  const remove = discovery.register('personal-relay', () => wakes++);
  const connection = discovery.attach({ readyState: 1, send() { sends++; } }, id, async () => id);
  connection.message({ type: 'ready' }); await flush();
  connection.message({ type: 'native-discovery-ready', protocol: 1 }); await flush();
  await time.advance(15000); assert.equal(sends, 2);
  await time.advance(5000); assert.equal(wakes, 1); assert.equal(discovery.confirmed(id), false);
  connection.close(); remove(); assert.equal(time.pending(), 0);
});

test('old Hubs never confirm the new protocol and socket replacement fences late messages', async () => {
  const time = clock(), discovery = createDiscovery(time), id = identity();
  let wakes = 0;
  const remove = discovery.register('remote-screen', () => wakes++);
  const old = discovery.attach({ readyState: 1, send() {} }, id, async () => id);
  old.message({ type: 'ready' }); await flush(); await time.advance(5000);
  assert.equal(discovery.confirmed(id), false); assert.equal(wakes, 1);
  const current = discovery.attach({ readyState: 1, send() {} }, id, async () => id);
  const before = wakes;
  old.message({ type: 'native-discovery-ready', protocol: 1 });
  old.message({ type: 'native-discovery', topic: 'remote-screen' }); await flush();
  assert.equal(wakes, before); assert.equal(discovery.confirmed(id), false);
  remove(); old.close(); current.close(); assert.equal(time.pending(), 0);
});

test('v2 topics never contaminate legacy heartbeats and require an explicit topic acknowledgement', async () => {
  const time = clock(), discovery = createDiscovery(time), id = identity();
  const sent = [], events = [];
  discovery.register('personal-relay', () => {});
  discovery.register('remote-screen', () => {});
  discovery.register('automation-inbox', value => events.push(value));
  const connection = discovery.attach({ readyState: 1, send: raw => sent.push(JSON.parse(raw)) }, id, async () => id);
  connection.message({ type: 'ready' }); await flush();
  assert.deepEqual(sent, [
    { t: 'native-discovery', protocol: 1, topics: ['personal-relay', 'remote-screen'] },
    { t: 'native-discovery', protocol: 2, topics: ['automation-inbox'] },
  ]);
  connection.message({ type: 'native-discovery-ready', protocol: 1 }); await flush();
  assert.equal(discovery.confirmed(id), true);
  assert.equal(discovery.confirmed(id, 'automation-inbox'), false, 'old Hub cannot confirm new writes');
  connection.message({ type: 'native-discovery-ready', protocol: 2, topics: [] }); await flush();
  assert.equal(discovery.confirmed(id, 'automation-inbox'), false, 'mixed Hub must preserve fallback');
  connection.message({ type: 'native-discovery-ready', protocol: 2, topics: ['automation-inbox', 'cloud-execution-sync'] }); await flush();
  assert.equal(discovery.confirmed(id, 'automation-inbox'), true);
  assert.equal(discovery.confirmed(id, 'cloud-execution-sync'), false, 'unrequested capabilities are not trusted');
  const event = { type: 'native-discovery', topic: 'automation-inbox', runId: 'hint-only' };
  connection.message(event); await flush(); assert.equal(events.at(-1), event);
  const before = events.length;
  connection.message({ type: 'native-discovery-ready', protocol: 2, topics: [] }); await flush();
  assert.equal(events.length, before + 1, 'a rolling deployment losing support wakes bounded reconciliation');
  connection.close(); assert.equal(time.pending(), 0);
});

test('extended reconnect and lost capability acknowledgement trigger reconciliation, not a new socket', async () => {
  const time = clock(), discovery = createDiscovery(time), id = identity();
  let wakes = 0;
  discovery.register('automation-inbox', () => wakes++);
  const socket = { readyState: 1, send() {} };
  const connection = discovery.attach(socket, id, async () => id);
  connection.message({ type: 'native-discovery', topic: 'automation-inbox' }); await flush();
  assert.equal(wakes, 0, 'transport open alone is not authenticated');
  connection.message({ type: 'ready' }); await flush(); assert.equal(wakes, 1);
  connection.message({ type: 'native-discovery-ready', protocol: 2, topics: ['automation-inbox'] }); await flush();
  assert.equal(discovery.confirmed(id, 'automation-inbox'), true);
  await time.advance(20000);
  assert.equal(discovery.confirmed(id, 'automation-inbox'), false);
  const afterLoss = wakes;
  await time.advance(60000);
  assert.equal(wakes, afterLoss, 'unsupported/old Hub does not repeatedly defeat idle backoff');
  connection.close();
  const next = discovery.attach(socket, id, async () => id);
  next.message({ type: 'ready' }); await flush();
  assert.equal(wakes, afterLoss + 2, 'disconnect and authenticated reconnect both repair gaps');
  next.close();
});

test('quota changes use an authenticated v2 subscription and obsolete connections cannot deliver them', async () => {
  const time = clock(), discovery = createDiscovery(time), id = identity();
  const frames = [], wakes = [];
  discovery.register('quota', value => wakes.push(value));
  const socket = {readyState: 1, send: value => frames.push(JSON.parse(value))};
  const connection = discovery.attach(socket, id, async () => id);
  const hint = {type: 'native-discovery', topic: 'quota'};
  connection.message(hint); await flush(); assert.equal(wakes.length, 0);
  connection.message({type: 'ready'}); await flush();
  assert.deepEqual(frames, [{t: 'native-discovery', protocol: 2, topics: ['quota']}]);
  connection.message({type: 'native-discovery-ready', protocol: 2, topics: ['quota']}); await flush();
  assert.equal(discovery.confirmed(id, 'quota'), true);
  connection.message(hint); await flush(); assert.equal(wakes.at(-1), hint);
  const replacement = discovery.attach(socket, identity('bob'), async () => identity('bob'));
  const before = wakes.length;
  connection.message(hint); await flush(); assert.equal(wakes.length, before);
  replacement.close();
});
