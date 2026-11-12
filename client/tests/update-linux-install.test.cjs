'use strict';

/*
 * Test Linux installation planning, pkexec arguments, failure semantics, and state
 * transitions with injected executors; never invoke real authorization.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const fsp = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

const linuxInstall = require('../main/update-linux-install.cjs');

test('managed updates require the package registration selected by the local profile', async () => {
  const profile = { ...require('../main/distribution.cjs').current(), linuxPackageName: 'fixture-desktop' };
  for (const format of ['deb', 'rpm']) {
    const queries = [];
    const result = await linuxInstall.plan('SoduWork-1.13.3-linux.' + format, { profile,
      exec: async (file, args) => {
        if (file === 'which') return { stdout: '/usr/bin/' + args[0] };
        queries.push(args.at(-1));
        return { stdout: 'install ok installed' };
      } });
    assert.equal(result.kind, 'managed');
    assert.deepEqual(queries, [profile.linuxPackageName]);
    const missing = await linuxInstall.plan('SoduWork-1.13.3-linux.' + format, { profile,
      exec: async (_file, args) => args.at(-1) === 'soduwork'
        ? { stdout: 'install ok installed' } : { error: Error('not installed') } });
    assert.deepEqual(missing, { kind: 'manual' });
  }
});

function execScript(script) {
  return async (file, args) => {
    const handler = script[file] || script['*'];
    if (!handler) throw new Error('unexpected exec: ' + file);
    return handler(args);
  };
}

test('plan：产物后缀决定目标管理器，本机登记缺失一律回落 manual', async () => {
  assert.deepEqual(await linuxInstall.plan('SoduWork-1.2.13-linux-x64.tar.gz'), { kind: 'manual' });
  assert.deepEqual(await linuxInstall.plan('SoduWork-1.2.13-linux-x64.AppImage'), { kind: 'manual' });

  const owned = execScript({
    'dpkg-query': (args) => {
      assert.equal(args[0], '-W');
      return { error: null, stdout: 'install ok installed', stderr: '' };
    },
    rpm: () => ({ error: null, stdout: 'soduwork-1.2.12-1.x86_64\n', stderr: '' }),
    which: (args) => ({ error: null, stdout: '/usr/bin/' + args[0] + '\n', stderr: '' }),
  });
  const deb = await linuxInstall.plan('SoduWork-1.2.13-linux-x64.deb', { exec: execScript({
    'dpkg-query': () => ({ error: null, stdout: 'install ok installed', stderr: '' }),
    rpm: () => ({ error: new Error('not found'), stdout: '', stderr: '' }),
    which: (args) => ({ error: null, stdout: '/usr/bin/' + args[0] + '\n', stderr: '' }),
  }) });
  assert.equal(deb.kind, 'managed');
  assert.equal(deb.manager, 'apt-get');
  assert.equal(deb.programPath, '/usr/bin/apt-get');
  assert.equal(deb.pkexecPath, '/usr/bin/pkexec');

  const rpm = await linuxInstall.plan('SoduWork-1.2.13-linux-x64.rpm', { exec: execScript({
    'dpkg-query': () => ({ error: new Error('missing'), stdout: '', stderr: '' }),
    rpm: () => ({ error: null, stdout: 'soduwork-1.2.12-1.x86_64\n', stderr: '' }),
    which: (args) => ({ error: null, stdout: '/usr/bin/' + args[0] + '\n', stderr: '' }),
  }) });
  assert.equal(rpm.kind, 'managed');
  assert.equal(rpm.manager, 'dnf');
  assert.equal(rpm.programPath, '/usr/bin/dnf');

  /* Select manual handling when dpkg exists but the app is not registered. */
  const unowned = await linuxInstall.plan('SoduWork-1.2.13-linux-x64.deb', { exec: execScript({
    'dpkg-query': () => ({ error: new Error('not installed'), stdout: '', stderr: '' }),
    which: (args) => ({ error: null, stdout: '/usr/bin/' + args[0] + '\n', stderr: '' }),
  }) });
  assert.deepEqual(unowned, { kind: 'manual' });

  /* Missing pkexec requires manual fallback, never an unauthorized install path. */
  const noPkexec = await linuxInstall.plan('SoduWork-1.2.13-linux-x64.deb', { exec: execScript({
    'dpkg-query': () => ({ error: null, stdout: 'install ok installed', stderr: '' }),
    which: (args) => args[0] === 'pkexec'
      ? { error: new Error('which: no pkexec'), stdout: '', stderr: '' }
      : { error: null, stdout: '/usr/bin/' + args[0] + '\n', stderr: '' },
  }) });
  assert.deepEqual(noPkexec, { kind: 'manual' });
});

test('managed installation resolves new dependencies with the available distro package manager', async () => {
  for (const manager of ['apt-get', 'dnf', 'yum', 'zypper']) {
    const format = manager === 'apt-get' ? 'deb' : 'rpm';
    const probes = [];
    const result = await linuxInstall.plan('update.' + format, { exec: async (file, args, options) => {
      assert.equal(options.timeout, 5000);
      if (file !== 'which') return { stdout: 'install ok installed' };
      probes.push(args[0]);
      return args[0] === manager || args[0] === 'pkexec'
        ? { stdout: '/usr/bin/' + args[0] } : { error: Error('unavailable'), stdout: '' };
    } });
    assert.equal(result.kind, 'managed');
    assert.equal(result.manager, manager);
    assert.equal(result.programPath, '/usr/bin/' + manager);
    assert.ok(!probes.includes('rpm') && !probes.includes('dpkg'), 'never choose a dependency-blind installer');
  }
  for (const format of ['deb', 'rpm']) {
    const plan = await linuxInstall.plan('update.' + format, { exec: async (file, args) => {
      if (file !== 'which') return { stdout: 'install ok installed' };
      return ['pkexec', 'dpkg', 'rpm'].includes(args[0]) ? { stdout: '/usr/bin/' + args[0] }
        : { error: Error('unavailable') };
    } });
    assert.deepEqual(plan, { kind: 'manual' }, 'a registered package alone cannot resolve newly introduced dependencies');
  }
});

test('package-manager operands remain literal and repository verification is not bypassed', async () => {
  const expected = {
    'apt-get': ['-y', '--no-remove', '-o', 'Dpkg::Options::=--force-confdef', '-o', 'Dpkg::Options::=--force-confold', 'install', '--'],
    dnf: ['-y', 'install', '--'], yum: ['-y', 'localinstall', '--'],
    zypper: ['--non-interactive', 'install', '--'],
  };
  const installer = '/tmp/release with spaces;$(not-a-command).deb';
  for (const [manager, args] of Object.entries(expected)) {
    await linuxInstall.run({ manager, programPath: '/usr/bin/' + manager, pkexecPath: '/usr/bin/pkexec' }, installer, {
      exec: async (file, actual, options) => {
        assert.equal(file, '/usr/bin/pkexec');
        assert.deepEqual(actual, ['/usr/bin/' + manager, ...args, installer]);
        assert.notEqual(options.shell, true);
        assert.ok(!actual.some(value => /nogpg|allow-unauthenticated|allow-unsigned|nodeps/.test(value)));
        return { error: null };
      },
    });
  }
  assert.deepEqual(await linuxInstall.run({ manager: 'rpm' }, installer, {
    exec: () => assert.fail('legacy dependency-blind plans must not be executed'),
  }), { ok: false, fallback: true });
});

test('failed executable discovery never authorizes a stale or relative executable path', async () => {
  for (const result of [{ error: Error('failed'), stdout: '/usr/bin/apt-get' }, { stdout: 'relative/apt-get' }]) {
    const planned = await linuxInstall.plan('update.deb', { exec: async (file) =>
      file === 'which' ? result : { stdout: 'install ok installed' } });
    assert.deepEqual(planned, { kind: 'manual' });
  }
});

test('run：pkexec 参数按管理器组装，失败语义区分授权拒绝与依赖错误', async () => {
  const planInfo = { kind: 'managed', manager: 'apt-get', programPath: '/usr/bin/apt-get', pkexecPath: '/usr/bin/pkexec' };
  const ok = await linuxInstall.run(planInfo, '/tmp/SoduWork-1.2.13-linux-x64.deb', {
    exec: execScript({ '/usr/bin/pkexec': () => ({ error: null, stdout: '', stderr: '' }) }),
  });
  assert.deepEqual(ok, { ok: true });

  const argExec = async (file, args, options) => {
    assert.equal(file, '/usr/bin/pkexec');
    assert.deepEqual(args, ['/usr/bin/apt-get', '-y', '--no-remove', '-o', 'Dpkg::Options::=--force-confdef', '-o', 'Dpkg::Options::=--force-confold', 'install', '--', '/tmp/SoduWork-1.2.13-linux-x64.deb']);
    assert.equal(options.timeout, 10 * 60 * 1000);
    return { error: null, stdout: '', stderr: '' };
  };
  await linuxInstall.run(planInfo, '/tmp/SoduWork-1.2.13-linux-x64.deb', { exec: argExec });

  const rpmArgs = async (file, args) => {
    assert.deepEqual(args, ['/usr/bin/dnf', '-y', 'install', '--', '/tmp/SoduWork-1.2.13-linux-x64.rpm']);
    return { error: null, stdout: '', stderr: '' };
  };
  await linuxInstall.run(
    { kind: 'managed', manager: 'dnf', programPath: '/usr/bin/dnf', pkexecPath: '/usr/bin/pkexec' },
    '/tmp/SoduWork-1.2.13-linux-x64.rpm', { exec: rpmArgs });

  const denied = await linuxInstall.run(planInfo, '/tmp/x.deb', {
    exec: async () => ({ error: Object.assign(new Error('dismissed'), { code: 126 }), stdout: '', stderr: '' }),
  });
  assert.equal(denied.ok, false);
  assert.ok(!denied.fallback);
  assert.match(denied.message, /未获得系统授权/);

  const dependency = await linuxInstall.run(planInfo, '/tmp/x.deb', {
    exec: async () => ({ error: Object.assign(new Error('exit 1'), { code: 1 }), stdout: '', stderr: 'dpkg: error: dependency problems' }),
  });
  assert.equal(dependency_ok(dependency), true);
  function dependency_ok(result) {
    assert.equal(result.ok, false);
    assert.match(result.message, /安装更新失败/);
    assert.match(result.message, /dependency problems/);
    return true;
  }

  const fallback = await linuxInstall.run(planInfo, '/tmp/x.deb', {
    exec: async () => { throw Object.assign(new Error('spawn pkexec ENOENT'), { code: 'ENOENT' }); },
  });
  assert.deepEqual(fallback, { ok: false, fallback: true });
});

function buildCtx(over = {}) {
  const sets = [], reports = [], scheduled = [], pendings = [], relaunches = [];
  return {
    sets, reports, scheduled, pendings, relaunches,
    ctx: {
      attemptId: 'attempt-1',
      set: (patch) => { sets.push(patch); return patch; },
      report: async (state, progress, extra) => { reports.push({ state, progress, extra }); },
      publicState: () => Object.assign({}, ...sets),
      writePending: async (pending) => { pendings.push(pending); },
      installManual: async (installer, manifest) => ({ state: 'deferred', manual: true, installer, manifest }),
      binary: process.execPath,
      relaunch: options => relaunches.push(options),
      beforeExit: () => {},
      quit: () => {},
      forceExit: () => {},
      schedule: (fn, ms) => scheduled.push({ fn, ms }),
      exec: null,
      ...over,
    },
  };
}

const MANIFEST = { version: '1.2.13' };
const PLAN = { kind: 'managed', manager: 'apt-get', programPath: '/usr/bin/apt-get', pkexecPath: '/usr/bin/pkexec' };

test('installManaged：与 Windows 相同的 installing→restarting 状态机与退出调度', async () => {
  const { ctx, sets, reports, scheduled, pendings, relaunches } = buildCtx({ exec: execScript({ '/usr/bin/pkexec': () => ({ error: null, stdout: '', stderr: '' }) }) });
  const result = await linuxInstall.installManaged(ctx, PLAN, '/tmp/SoduWork-1.2.13-linux-x64.deb', MANIFEST);
  assert.equal(result.state, 'installing');
  assert.deepEqual(pendings.length, 1);
  assert.equal(pendings[0].targetVersion, '1.2.13');
  assert.equal(sets.at(-1).phase, 'restarting');
  assert.deepEqual(reports.map(r => r.state), ['installing']);
  assert.deepEqual(scheduled.map(s => s.ms), [100, 5000]);
  assert.deepEqual(relaunches, [{ execPath: process.execPath, args: [] }]);
});

test('installManaged schedules Electron relaunch before either graceful or forced exit, without starting a competing instance', async () => {
  for (const exitDelay of [100, 5000]) {
    const calls = [];
    const { ctx, scheduled } = buildCtx({
      exec: async () => ({ error: null }),
      relaunch: options => calls.push(['relaunch-after-exit', options]),
      quit: () => calls.push(['quit']),
      forceExit: () => calls.push(['exit']),
      spawnDetached: () => assert.fail('must not spawn before the old instance exits'),
    });
    await linuxInstall.installManaged(ctx, PLAN, '/tmp/update.deb', MANIFEST);
    assert.deepEqual(calls, [['relaunch-after-exit', { execPath: process.execPath, args: [] }]]);
    scheduled.find(item => item.ms === exitDelay).fn();
    assert.equal(calls[1][0], exitDelay === 100 ? 'quit' : 'exit');
  }
});

test('installManaged：安装失败清 pending、报 failed 并抛错', async () => {
  const { ctx, sets, reports, scheduled, pendings } = buildCtx({ exec: async () => ({
    error: Object.assign(new Error('exit 1'), { code: 1 }), stdout: '', stderr: 'boom' }) });
  await assert.rejects(
    linuxInstall.installManaged(ctx, PLAN, '/tmp/SoduWork-1.2.13-linux-x64.deb', MANIFEST),
    /安装更新失败.*boom/s);
  assert.equal(pendings.length, 2); /* Persist before clearing. */
  assert.equal(pendings[1], null);
  assert.equal(sets.at(-1).state, 'failed');
  assert.deepEqual(scheduled, []);
  assert.equal(reports.at(-1).state, 'failed');
});

test('installManaged：pkexec 缺失时回落 ctx.installManual，不破坏状态机', async () => {
  const { ctx, scheduled, pendings } = buildCtx({ exec: async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); } });
  const result = await linuxInstall.installManaged(ctx, PLAN, '/tmp/deb', MANIFEST);
  assert.equal(result.state, 'deferred');
  assert.equal(result.manual, true);
  assert.equal(pendings.length, 1);
  assert.deepEqual(scheduled, []);
});

test('relaunch 失败不回滚安装，仍走退出调度', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'soduwork-linux-install-'));
  try {
    /* Skip restart without throwing when the executable path does not exist. */
    const { ctx, scheduled } = buildCtx({
      binary: path.join(dir, 'missing-soduwork'),
      exec: execScript({ '/usr/bin/pkexec': () => ({ error: null, stdout: '', stderr: '' }) }),
    });
    const result = await linuxInstall.installManaged(ctx, PLAN, '/tmp/deb', MANIFEST);
    assert.equal(result.phase, 'restarting');
    assert.deepEqual(scheduled.map(s => s.ms), [100, 5000]);
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

test('Electron relaunch failure still allows exit and keeps the installed-version receipt', async () => {
  const { ctx, scheduled, pendings } = buildCtx({
    exec: async () => ({ error: null }),
    relaunch: () => { throw Error('relaunch unavailable'); },
  });
  const result = await linuxInstall.installManaged(ctx, PLAN, '/tmp/update.deb', MANIFEST);
  assert.equal(result.phase, 'restarting');
  assert.deepEqual(scheduled.map(item => item.ms), [100, 5000]);
  assert.equal(pendings.length, 1);
});
