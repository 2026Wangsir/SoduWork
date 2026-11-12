'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { snapshot } = require('../pi-session/mcp-process-tree');

async function attach(pid) {
  if (process.platform !== 'win32') return null;
  const identity = (await snapshot(pid)).find(row => row.pid === pid);
  if (!identity) throw Error('Runtime process exited before job assignment');
  const script = fs.readFileSync(path.join(__dirname, 'windows-process-job.ps1'), 'utf8');
  const child = spawn(path.join(process.env.SystemRoot || 'C:\\Windows',
    'System32/WindowsPowerShell/v1.0/powershell.exe'),
  ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, SODUWORK_JOB_PID: String(pid), SODUWORK_JOB_CREATED: String(identity.created) },
  });
  let output = '', errors = '', resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const timer = setTimeout(() => { rejectReady(Error('Runtime job assignment timed out')); child.kill(); }, 15000);
  child.stdout.on('data', data => {
    output = (output + data).slice(-1024);
    if (/^ready\r?$/m.test(output)) { clearTimeout(timer); resolveReady(); }
  });
  child.stderr.on('data', data => { errors = (errors + data).slice(-2048); });
  // EOF on this private pipe releases the job even if the desktop crashes.
  child.stdin.on('error', () => {});
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => code === 0 && /^stopped\r?$/m.test(output)
      ? resolve() : reject(Error('Runtime job cleanup failed: ' + (errors || String(code)))));
  });
  done.then(() => rejectReady(Error('Runtime job closed during startup')), rejectReady).finally(() => clearTimeout(timer));
  // A helper failure closes its job, so the existing runtime-exit listener also
  // interrupts sessions. Keep the rejected cleanup available for stop().
  done.catch(() => {});
  await ready;
  return { async stop() {
    child.stdin.end();
    let timeout;
    try { await Promise.race([done, new Promise((_, reject) => {
      timeout = setTimeout(() => reject(Error('Runtime job cleanup timed out')), 10000);
    })]); } finally { clearTimeout(timeout); }
  } };
}

module.exports = { attach };
