'use strict';

/*
 * Linux update executor uses polkit authorization and the matching package manager, then
 * schedules client restart. Unsupported or failed managed-install paths fall back to
 * opening the package manually.
 */

const { execFile } = require('child_process');
const fs = require('fs');
const { current } = require('./distribution.cjs');

const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
const PROBE_TIMEOUT_MS = 5000;
const INSTALL_ARGS = {
  'apt-get': ['-y', '--no-remove', '-o', 'Dpkg::Options::=--force-confdef', '-o', 'Dpkg::Options::=--force-confold', 'install', '--'],
  dnf: ['-y', 'install', '--'],
  yum: ['-y', 'localinstall', '--'],
  zypper: ['--non-interactive', 'install', '--'],
};

function _exec(file, args, options) {
  return new Promise((resolve) => {
    execFile(file, args, { encoding: 'utf8', ...options }, (error, stdout, stderr) => {
      resolve({ error, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

/*
 * Require package-manager registration for managed deb or rpm updates; copied and tarball
 * installations use manual handling.
 */
function _probeManager(manager, exec, packageName) {
  const run = exec || _exec;
  if (manager === 'dpkg') {
    return run('dpkg-query', ['-W', '-f=${Status}', packageName], { timeout: PROBE_TIMEOUT_MS }).then((r) =>
      !r.error && /ok installed/.test(r.stdout), () => false);
  }
  return run('rpm', ['-q', packageName], { timeout: PROBE_TIMEOUT_MS }).then((r) => !r.error, () => false);
}

async function _resolveProgram(name, exec) {
  const run = exec || _exec;
  try {
    const r = await run('which', [name], { timeout: PROBE_TIMEOUT_MS });
    const resolved = String(r.stdout || '').trim().split('\n')[0];
    return !r.error && resolved.startsWith('/') ? resolved : '';
  } catch (_) { return ''; }
}

/*
 * Match artifact suffix to the installed package manager before selecting managed
 * installation.
 */
async function plan(artifactName, deps = {}) {
  const exec = deps.exec || null;
  const name = String(artifactName || '').toLowerCase();
  const registry = name.endsWith('.deb') ? 'dpkg'
    : name.endsWith('.rpm') ? 'rpm' : null;
  if (!registry) return { kind: 'manual' };
  const owned = await _probeManager(registry, exec, (deps.profile || current()).linuxPackageName);
  if (!owned) return { kind: 'manual' };
  const pkexecPath = await _resolveProgram('pkexec', exec);
  if (!pkexecPath) return { kind: 'manual' };
  // Upgrades can introduce dependencies (including the desktop keyring).
  // Raw dpkg/rpm cannot resolve them and can leave an unpacked, unusable app.
  for (const manager of registry === 'dpkg' ? ['apt-get'] : ['dnf', 'yum', 'zypper']) {
    const programPath = await _resolveProgram(manager, exec);
    if (programPath) return { kind: 'managed', manager, programPath, pkexecPath };
  }
  return { kind: 'manual' };
}

function _failMessage(result) {
  const code = result.error ? result.error.code : null;
  if (code === 'ENOENT') return '系统缺少 pkexec，无法自动安装更新';
  /* pkexec uses 126 for canceled authorization and 127 for authorization failure. */
  if (result.error && (result.error.code === 126 || result.error.code === 127)) {
    return '未获得系统授权，已取消安装更新';
  }
  const detail = String(result.stderr || result.stdout || '').trim()
    .split('\n').slice(-4).join('\n').slice(0, 400);
  return '安装更新失败' + (detail ? '：' + detail : '');
}

/*
 * Run installation through pkexec and return structured success or failure; missing pkexec
 * requests manual fallback.
 */
async function run(planInfo, installer, deps = {}) {
  const exec = deps.exec || _exec;
  if (!Object.hasOwn(INSTALL_ARGS, planInfo.manager)) return { ok: false, fallback: true };
  // Keep the verified package as one literal operand, never a shell command or option.
  const args = [planInfo.programPath, ...INSTALL_ARGS[planInfo.manager], installer];
  let result;
  try { result = await exec(planInfo.pkexecPath, args, { timeout: INSTALL_TIMEOUT_MS }); }
  catch (error) { result = { error }; }
  if (!result.error) return { ok: true };
  if (result.error.code === 'ENOENT') return { ok: false, fallback: true };
  return { ok: false, message: _failMessage(result) };
}

/*
 * Use the shared pending, installing, and restarting lifecycle through caller-provided
 * state, reporting, and exit hooks; this module owns no runtime singleton.
 */
async function installManaged(ctx, planInfo, installer, manifest) {
  await ctx.writePending({
    schema: 1, attemptId: ctx.attemptId, targetVersion: manifest.version,
    createdAt: new Date().toISOString(), installer: require('path').basename(installer),
  });
  ctx.set({ state: 'installing', phase: 'preparing', phaseProgress: null, progress: 100 });
  await ctx.report('installing', 100);
  const result = await run(planInfo, installer, { exec: ctx.exec });
  if (!result.ok) {
    if (result.fallback) return ctx.installManual(installer, manifest);
    await ctx.writePending(null);
    ctx.set({ state: 'failed', error: result.message });
    await ctx.report('failed', 100, { error: result.message });
    throw new Error(result.message);
  }
  const binary = ctx.binary;
  if (binary && fs.existsSync(binary)) {
    // Electron waits for this instance to exit, including releasing its lock.
    // Spawning now races requestSingleInstanceLock in the new instance.
    try { ctx.relaunch({ execPath: binary, args: [] }); }
    catch (_) { /* Do not undo installation if restart fails; the user can launch the app manually. */ }
  }
  ctx.set({ state: 'installing', phase: 'restarting', phaseProgress: null });
  ctx.schedule(() => {
    try { ctx.beforeExit('update-install'); } catch (_) { /* diagnostics are best effort */ }
    ctx.quit();
  }, 100);
  ctx.schedule(() => {
    try { ctx.beforeExit('update-force-exit'); } catch (_) { /* diagnostics are best effort */ }
    ctx.forceExit();
  }, 5000);
  return ctx.publicState();
}

module.exports = { plan, run, installManaged };
