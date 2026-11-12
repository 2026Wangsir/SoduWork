'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createProcessTreeGuard } = require('./process-tree');
const ROOT = 410001, CHILD = 410002, GRANDCHILD = 410003, FOREIGN = 410004;
const row = (pid, parent, created = 100, startToken = '') => ({ pid, parent, created, startToken });

function fixture(options = {}) {
  let rows = [row(ROOT, 40), row(CHILD, ROOT, 101), row(GRANDCHILD, CHILD, 102), row(FOREIGN, 40)];
  const killed = [], snapshots = [];
  const guard = createProcessTreeGuard({ pid: ROOT, intervalMs: 0, settleTimeoutMs: 0,
    snapshot: async pid => { snapshots.push(pid); return rows.map(item => ({ ...item })); },
    terminate: async value => { killed.push(value.pid); rows = rows.filter(item => item.pid !== value.pid); },
    ...options });
  return { guard, killed, snapshots, get rows() { return rows; }, set rows(value) { rows = value; } };
}

test('cleanup kills verified descendants before their root and excludes unrelated processes', async () => {
  const f = fixture();
  assert.deepEqual(await f.guard.start(), { rootFound: true, tracked: 3 });
  const report = await f.guard.stop();
  assert.deepEqual(f.killed, [GRANDCHILD, CHILD, ROOT]);
  assert.deepEqual(report, { terminated: [GRANDCHILD, CHILD, ROOT], skipped: [], remaining: [] });
  assert.deepEqual(f.rows.map(item => item.pid), [FOREIGN]);
  assert.ok(f.snapshots.includes(GRANDCHILD), 'each target must have a fresh identity check');
  assert.equal(f.guard.trackedCount, 0);
});

test('known descendants remain owned after their root exits and they are reparented', async () => {
  const f = fixture(); await f.guard.start();
  f.rows = [row(CHILD, 1, 101), row(GRANDCHILD, CHILD, 102), row(FOREIGN, 40)];
  await f.guard.refresh();
  await f.guard.stop();
  assert.deepEqual(f.killed, [GRANDCHILD, CHILD]);
});

test('PID reuse cannot acquire a new subtree and cannot kill its replacement', async () => {
  const f = fixture(); await f.guard.start();
  f.rows = [row(ROOT, 40, 200), row(CHILD, ROOT, 201), row(GRANDCHILD, CHILD, 202), row(FOREIGN, ROOT, 203)];
  await f.guard.refresh();
  assert.equal(f.guard.trackedCount, 1, 'only the original root tombstone remains');
  const report = await f.guard.stop();
  assert.deepEqual(f.killed, []);
  assert.deepEqual(report.skipped, [{ pid: ROOT, reason: 'identity-changed' }]);
});

test('failed cleanup retries fresh identities and never signals a reused PID', async () => {
  let failOnce = true;
  const f = fixture({ terminate: async value => {
    if (failOnce) throw Error('Temporary termination failure');
    f.killed.push(value.pid); f.rows = f.rows.filter(item => item.pid !== value.pid);
  } });
  await f.guard.start();
  await assert.rejects(f.guard.stop(), /cleanup was incomplete/);
  assert.equal(f.guard.trackedCount, 3);
  failOnce = false;
  f.rows = [row(ROOT, 40), row(CHILD, 40, 201), row(GRANDCHILD, 1, 102), row(FOREIGN, 40)];
  const first = f.guard.stop(), second = f.guard.stop();
  assert.equal(first, second);
  const report = await first;
  assert.deepEqual(f.killed, [GRANDCHILD, ROOT]);
  assert.deepEqual(f.rows.map(item => item.pid), [CHILD, FOREIGN]);
  assert.equal(f.guard.lastError, null);
  assert.equal(await f.guard.stop(), report);
});

test('Linux start tokens distinguish PID reuse within the same wall-clock second', async () => {
  const f = fixture();
  f.rows = [row(ROOT, 40, 100, 'linux:1000'), row(CHILD, ROOT, 100, 'linux:1001')];
  await f.guard.start();
  f.rows = [row(ROOT, 40, 100, 'linux:2000'), row(CHILD, ROOT, 100, 'linux:2001')];
  await f.guard.stop();
  assert.deepEqual(f.killed, []);
});

test('stable kernel start tokens retain ownership when wall-clock creation timestamps shift', async () => {
  const f = fixture();
  f.rows = [row(ROOT, 40, 100, 'linux:1000'), row(CHILD, ROOT, 101, 'linux:1001')];
  await f.guard.start();
  f.rows = [row(ROOT, 40, 200, 'linux:1000'), row(CHILD, ROOT, 201, 'linux:1001')];
  const report = await f.guard.stop();
  assert.deepEqual(report.terminated, [CHILD, ROOT]);
  assert.deepEqual(report.remaining, []);
});

test('a last-moment identity change is checked again immediately before signalling', async () => {
  const killed = [];
  const guard = createProcessTreeGuard({ pid: ROOT, intervalMs: 0, settleTimeoutMs: 0,
    snapshot: async selected => selected === ROOT ? [row(ROOT, 40, 900)] : [row(ROOT, 40)],
    terminate: value => killed.push(value.pid) });
  await guard.start();
  const report = await guard.stop();
  assert.deepEqual(killed, []);
  assert.equal(report.skipped[0].reason, 'identity-changed');
});

test('shutdown skips verified exited root tombstones without redundant OS queries', async () => {
  const f = fixture(); await f.guard.start();
  f.rows = [];
  const before = f.snapshots.length;
  const report = await f.guard.stop();
  assert.deepEqual(f.snapshots.slice(before), [undefined]);
  assert.deepEqual(report.skipped, [{ pid: ROOT, reason: 'exited' }]);
  assert.deepEqual(report.terminated, []);
  assert.deepEqual(report.remaining, []);
});

test('missing root baseline stays closed even if that PID appears later', async () => {
  const f = fixture(); f.rows = [row(CHILD, ROOT)];
  assert.deepEqual(await f.guard.start(), { rootFound: false, tracked: 0 });
  f.rows = [row(ROOT, 40), row(CHILD, ROOT)];
  await f.guard.refresh();
  await assert.rejects(f.guard.stop(), error => {
    assert.deepEqual(error.report.remaining, [ROOT]);
    return /cleanup was incomplete/.test(error.message);
  });
  assert.deepEqual(f.killed, []);
});

test('a missing root that is still absent at shutdown needs no signal', async () => {
  const f = fixture(); f.rows = [];
  await f.guard.start();
  assert.deepEqual(await f.guard.stop(), { terminated: [], skipped: [], remaining: [] });
  assert.deepEqual(f.killed, []);
});

test('unverifiable and ambiguous identities never become owned', async () => {
  const f = fixture();
  f.rows = [row(ROOT, 40), row(CHILD, ROOT, 101), row(CHILD, ROOT, 102),
    { pid: GRANDCHILD, parent: ROOT }, row(FOREIGN, ROOT, 90), row(process.pid, ROOT, 105)];
  await f.guard.start(); await f.guard.stop();
  assert.deepEqual(f.killed, [ROOT]);
});

test('stop is idempotent, waits for in-flight sampling, and prevents later polling', async () => {
  let release, rows = [row(ROOT, 40)], calls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const guard = createProcessTreeGuard({ pid: ROOT, intervalMs: 1, settleTimeoutMs: 0,
    snapshot: async () => { if (++calls === 1) await gate; return rows; },
    terminate: () => { rows = []; } });
  const first = guard.refresh(), second = guard.refresh();
  assert.equal(first, second);
  const stopping = guard.stop(); assert.equal(stopping, guard.stop());
  release(); await first; await stopping;
  const before = calls;
  await new Promise(resolve => setTimeout(resolve, 10));
  await guard.start(); await guard.refresh();
  assert.equal(calls, before);
});

test('dispose pauses sampling while preserving ownership for a later cleanup', async () => {
  const f = fixture(); await f.guard.start(); f.guard.dispose();
  const before = f.snapshots.length;
  await f.guard.refresh(); assert.equal(f.snapshots.length, before);
  await f.guard.stop(); assert.equal(f.killed.length, 3);
});

test('periodic sampling discovers new descendants without overlapping snapshots', async () => {
  let rows = [row(ROOT, 40)], active = 0, maximum = 0, sampled;
  const observed = new Promise(resolve => { sampled = resolve; });
  const guard = createProcessTreeGuard({ pid: ROOT, intervalMs: 1,
    snapshot: async () => {
      maximum = Math.max(maximum, ++active);
      await new Promise(resolve => setTimeout(resolve, 2));
      active--;
      if (rows.length > 1) sampled();
      return rows;
    }, terminate: () => true });
  try {
    await guard.start(); rows = [row(ROOT, 40), row(CHILD, ROOT, 101)];
    // Sampling is intentionally unref'ed in production. This deadline keeps
    // the isolated test alive and gives failures a useful bound.
    let timer;
    try { await Promise.race([observed, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error('sampling did not run')), 1000);
    })]); } finally { clearTimeout(timer); }
    await guard.refresh();
    assert.equal(guard.trackedCount, 2); assert.equal(maximum, 1);
  } finally { guard.dispose(); }
});

test('failed identity snapshots are reported without signalling stale PID records', async () => {
  let failed = false, kills = 0;
  const guard = createProcessTreeGuard({ pid: ROOT, intervalMs: 0,
    snapshot: async () => { if (failed) throw Error('snapshot unavailable'); return [row(ROOT, 40)]; },
    terminate: () => { kills++; } });
  await guard.start(); failed = true;
  await assert.rejects(guard.stop(), error => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.report.terminated, []); return true;
  });
  assert.equal(kills, 0); assert.ok(guard.lastError);
});

test('a delivered signal does not certify exit and remaining work is reported', async () => {
  const f = fixture({ terminate: () => true }); await f.guard.start();
  await assert.rejects(f.guard.stop(), error => {
    assert.deepEqual(error.report.remaining.sort(), [ROOT, CHILD, GRANDCHILD]);
    return /cleanup was incomplete/.test(error.message);
  });
});

test('invalid root identities and interval configuration are rejected', () => {
  for (const pid of [0, 1, -10, '42', process.pid]) assert.throws(() => createProcessTreeGuard({ pid }), TypeError);
  assert.throws(() => createProcessTreeGuard({ pid: ROOT, intervalMs: -1 }), TypeError);
  assert.throws(() => createProcessTreeGuard({ pid: ROOT, settleIntervalMs: 0 }), TypeError);
});

test('failed cleanup can retry fresh identity checks without killing a reused PID', async () => {
  const f = fixture({ terminate: () => true }); await f.guard.start();
  await assert.rejects(f.guard.stop(), /cleanup was incomplete/);
  f.rows = [row(ROOT, 40, 200), row(CHILD, ROOT, 201), row(FOREIGN, 40)];
  const report = await f.guard.stop();
  assert.deepEqual(report.terminated, []);
  assert.deepEqual(report.remaining, []);
  assert.equal(f.guard.trackedCount, 0);
});

test('cleanup retry still rejects live processes and unavailable snapshots', async () => {
  let unavailable = false, live = true, signals = 0;
  const guard = createProcessTreeGuard({ pid: ROOT, intervalMs: 0, settleTimeoutMs: 0,
    snapshot: async () => { if (unavailable) throw Error('snapshot unavailable'); return live ? [row(ROOT, 40)] : []; },
    terminate: () => { signals++; return true; } });
  await guard.start();
  await assert.rejects(guard.stop(), /cleanup was incomplete/);
  unavailable = true;
  await assert.rejects(guard.stop(), /cleanup was incomplete/);
  assert.equal(signals, 1, 'unavailable evidence cannot authorize another signal');
  unavailable = false;
  await assert.rejects(guard.stop(), /cleanup was incomplete/);
  assert.equal(signals, 2, 'a fresh verified live identity may be reclaimed again');
  live = false;
  assert.deepEqual((await guard.stop()).remaining, []);
});

test('real isolated Node descendants are reclaimed after their parent crashes', { timeout: 45000 }, async t => {
  if (process.platform === 'win32') {
    // This Node-only fixture is reaped by libuv on Windows. Native children
    // such as Git Bash can escape that job; windows-process-job.test.cjs
    // covers them with a job that retains every descendant.
    return t.skip('POSIX reparenting fixture; native Windows job tested separately');
  }
  const worker = 'setInterval(() => {}, 1000)';
  const source = 'const {spawn}=require("node:child_process");' +
    'const child=spawn(process.execPath,["-e",' + JSON.stringify(worker) + '],{stdio:"ignore"});' +
    'console.log(child.pid);setInterval(()=>{},1000);';
  const root = spawn(process.execPath, ['-e', source], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let descendant, cleaned = false;
  t.after(() => {
    if (cleaned) return;
    for (const pid of [descendant, root.pid]) {
      if (Number.isInteger(pid)) { try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
    }
  });
  const [data] = await once(root.stdout, 'data'); descendant = Number(data.toString().trim());
  assert.ok(Number.isInteger(descendant));
  const guard = createProcessTreeGuard({ pid: root.pid, intervalMs: 0 });
  const started = await guard.start(); assert.ok(started.tracked >= 2);
  const exit = once(root, 'exit'); root.kill('SIGKILL'); await exit;
  await guard.refresh();
  const report = await guard.stop();
  assert.ok(report.terminated.includes(descendant),
    'reparented child must still be cleaned; report=' + JSON.stringify(report));
  assert.deepEqual(report.remaining, []);
  cleaned = true;
});
