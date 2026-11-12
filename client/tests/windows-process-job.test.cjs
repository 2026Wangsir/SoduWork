'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const os = require('node:os');
const { spawn, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const { attach } = require('../main/agent-runtime/windows-process-job.cjs');
const { createProcessTreeGuard } = require('../main/agent-runtime/process-tree');

test('Windows job reaps real Git Bash descendants after their intermediary exits, preserving other processes',
  { skip: process.platform !== 'win32', timeout: 45000 }, async t => {
    const bash = require('../main/pi-session/shell-runtime').resolve({
      configuredPath: process.env.SODUWORK_TEST_BASH,
    }).shellPath;
    const root = spawn(process.execPath, ['-e',
      "process.stdin.once('data',()=>require('child_process').spawn(" + JSON.stringify(bash) +
      ",['-c',`sleep 30 & printf 'CHILD:%s\\n' \"$!\"; wait`],{stdio:['ignore','inherit','inherit'],windowsHide:true}));setInterval(()=>{},1000);"],
    { cwd: os.tmpdir(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const foreign = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true });
    let job;
    t.after(async () => {
      if (job) await job.stop().catch(() => {});
      for (const child of [root, foreign]) if (child.exitCode === null) child.kill();
    });
    job = await attach(root.pid);
    const output = once(root.stdout, 'data'); root.stdin.write('start\n');
    const [data] = await output, pid = Number(/CHILD:(\d+)/.exec(String(data))?.[1]);
    assert.ok(pid, 'Bash must report its real child identity');
    const rows = execFileSync(bash, ['-c', 'ps -l'], { encoding: 'utf8', windowsHide: true });
    const row = rows.split('\n').map(line => line.trim().split(/\s+/)).find(columns => Number(columns[0]) === pid);
    assert.ok(row, 'MSYS child must be observable before shutdown');
    const nativePid = Number(row[3]); assert.ok(nativePid > 1);
    assert.doesNotThrow(() => process.kill(nativePid, 0));
    const guard = createProcessTreeGuard({ pid: root.pid, intervalMs: 0 });
    await guard.start(); await guard.stop(); await job.stop();
    assert.throws(() => process.kill(nativePid, 0), { code: 'ESRCH' });
    assert.doesNotThrow(() => process.kill(foreign.pid, 0), 'unrelated process must remain alive');
  });
