'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const runtime = require('../main/pi-session/shell-runtime');

test('Linux packages install the command tools required to start conversations', () => {
  const pkg = require('../package.json');
  const packages = { git: 'git', find: 'findutils', grep: 'grep', sed: 'sed', tar: 'tar' };
  for (const format of ['deb', 'rpm']) {
    const dependencies = pkg.build[format].depends;
    assert.ok(dependencies.includes('bash'), `${format} must install the system shell`);
    for (const tool of runtime.REQUIRED_TOOLS) {
      assert.ok(packages[tool], `Map the Linux package supplying ${tool}`);
      assert.ok(dependencies.includes(packages[tool]), `${format} must install ${tool}`);
    }
  }
});

function fixture(root, relative) {
  const file = path.join(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'fixture');
  return file;
}

test('packaged shell is preferred over machine and user settings', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-shell-'));
  try {
    const bundled = fixture(root, 'resources/shell/bin/bash.exe');
    const configured = fixture(root, 'custom/bash.exe');
    const resolved = runtime.resolve({
      resourceRoot: path.join(root, 'resources'), clientRoot: path.join(root, 'client'),
      configuredPath: configured, env: {}, probe: false,
    });
    assert.equal(resolved.shellPath, bundled);
    assert.equal(resolved.source, 'bundled');
    assert.equal(resolved.bundled, true);
    assert.deepEqual(resolved.tools, ['git', 'find', 'grep', 'sed', 'tar']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('configured shell remains a development fallback', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-shell-fallback-'));
  try {
    const configured = fixture(root, 'custom/bash.exe');
    const resolved = runtime.resolve({
      resourceRoot: '', clientRoot: path.join(root, 'client'), configuredPath: configured,
      env: {}, probe: false,
    });
    assert.equal(resolved.shellPath, configured);
    assert.equal(resolved.source, 'configured');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('installer prepares and embeds the verified shell runtime', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.prebuild,
    'npm run prepare:runner && npm run prepare:pi-cache && npm run prepare:pi-retry && npm run prepare:shell-runtime');
  assert.equal(pkg.scripts['prepare:pi-retry'], 'node scripts/patch-pi-retry-schedule.cjs');
  assert.equal(pkg.scripts['prebuild-portable'], pkg.scripts.prebuild);
  const script = fs.readFileSync(path.join(__dirname, '..', 'scripts',
    'prepare-shell-runtime.cjs'), 'utf8');
  assert.match(script, /PortableGit-2\.55\.0\.4-64-bit\.7z\.exe/);
  assert.match(script, /016e84230a3767f0c6b3788e79ba0c58a17377086801719d46700fca4f7b36b5/);
  assert.match(script, /selfTest\(runtimeRoot\)/);
  /* Shell runtime is copied by the afterPack hook, not extraResources: Git
     binaries carry upstream signatures and must not re-enter signtool. The
     bundling rules must also stay in platform sections: a root entry would
     copy the Windows binary and PortableGit into mac/linux bundles too. */
  for (const section of [pkg.build.extraResources, pkg.build.win?.extraResources,
    pkg.build.mac?.extraResources, pkg.build.linux?.extraResources]) {
    assert.equal(section?.find((item) => item.to === 'shell'), undefined);
  }
  assert.ok(!pkg.build.extraResources.some((item) => ['shell', 'runner'].includes(item.to)),
    'platform-specific resources must stay in their platform sections');
  const installer = fs.readFileSync(path.join(__dirname, '..', 'scripts',
    'prepare-installer.cjs'), 'utf8');
  assert.match(installer, /\.runtime', 'git/);
  assert.match(installer, /resources', 'shell/);
});

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-shell-async-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

const healthy = () => ({ status: 0, stdout: 'SODUWORK_SHELL_OK\n' });

test('async preparation prefers the bundle, hides its probe and does not launch discovery', async t => {
  const root = temporary(t);
  const bundled = fixture(root, 'resources/shell/bin/bash.exe');
  fixture(root, 'custom/bash.exe');
  const launches = [];
  const resolved = await runtime.resolveAsync({
    resourceRoot: path.join(root, 'resources'), clientRoot: path.join(root, 'client'),
    configuredPath: path.join(root, 'custom/bash.exe'), env: {}, platform: 'win32',
    run: async (command, args, options) => {
      launches.push(command);
      assert.deepEqual(args.slice(0, 1), ['-c']);
      assert.match(args[1], /command -v git/);
      assert.equal(options.windowsHide, true);
      assert.equal(options.shell, false);
      assert.equal(options.timeout, 10000);
      assert.equal(options.env.MSYS_NO_PATHCONV, '1');
      return healthy();
    },
  });
  assert.equal(resolved.source, 'bundled');
  assert.deepEqual(launches, [bundled]);
});

test('PATH candidates are discovered by file checks with Windows Path spelling and quoted directories', async t => {
  const root = temporary(t);
  const fallback = fixture(root, 'quoted folder/bash.exe');
  const opts = {
    resourceRoot: '', clientRoot: path.join(root, 'client'), platform: 'win32', cwd: root,
    env: { Path: '"' + path.dirname(fallback) + '"' }, run: async () => healthy(),
  };
  const resolved = await runtime.resolveAsync(opts);
  assert.equal(resolved.source, 'path');
  assert.equal(resolved.shellPath, fallback);
});

test('concurrent shell preparation shares the healthy probe and remains asynchronous', { timeout: 10000 }, async t => {
  const root = temporary(t);
  const shell = fixture(root, 'resources/shell/bin/bash.exe');
  let calls = 0;
  let release;
  let notifyStarted;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { notifyStarted = resolve; });
  const opts = { resourceRoot: path.join(root, 'resources'), clientRoot: root, env: {},
    run: async () => { calls++; notifyStarted(); await gate; return healthy(); } };
  const jobs = [runtime.resolveAsync(opts), runtime.resolveAsync(opts), runtime.resolveAsync(opts)];
  assert.equal(calls, 0, 'shell discovery must yield before launching the probe');
  // Filesystem scheduling under CI load is not bounded by a fixed sleep.
  await started;
  try { assert.equal(calls, 1); } finally { release(); }
  const results = await Promise.all(jobs);
  assert.ok(results.every(item => item.shellPath === shell));
  assert.equal((await runtime.resolveAsync(opts)).shellPath, shell);
  assert.equal(calls, 1);
});

test('success cache is invalidated by environment and executable replacement', async t => {
  const root = temporary(t);
  const shell = fixture(root, 'bash.exe');
  let calls = 0;
  const run = async () => { calls++; return healthy(); };
  const options = { env: { PATH: root, HOME: root }, run };
  assert.equal((await runtime.probeAsync(shell, options)).ok, true);
  await runtime.probeAsync(shell, options);
  assert.equal(calls, 1);
  await runtime.probeAsync(shell, { ...options, env: { ...options.env, PATH: root + path.delimiter + root } });
  await runtime.probeAsync(shell, { ...options, env: { ...options.env, HOME: root + '/other' } });
  assert.equal(calls, 3);
  fs.writeFileSync(shell, 'replacement with changed metadata');
  await runtime.probeAsync(shell, options);
  assert.equal(calls, 4);
});

test('failed and thrown probes can recover without restarting the client', async t => {
  const root = temporary(t);
  const shell = fixture(root, 'bash.exe');
  let attempts = 0;
  const options = { env: {}, run: async () => {
    attempts++;
    if (attempts === 1) throw Object.assign(new Error('spawn timeout'), { code: 'ETIMEDOUT' });
    if (attempts === 2) return { status: 31, stderr: 'missing required tool' };
    return healthy();
  } };
  assert.match((await runtime.probeAsync(shell, options)).reason, /timeout/);
  assert.match((await runtime.probeAsync(shell, options)).reason, /missing required tool/);
  assert.equal((await runtime.probeAsync(shell, options)).ok, true);
  await runtime.probeAsync(shell, options);
  assert.equal(attempts, 3);
});

test('failed preferred shell falls back while a repaired bundle wins on the next attempt', async t => {
  const root = temporary(t);
  const bundled = fixture(root, 'resources/shell/bin/bash.exe');
  const configured = fixture(root, 'custom/bash.exe');
  let broken = true;
  const opts = { resourceRoot: path.join(root, 'resources'), clientRoot: root,
    configuredPath: configured, env: {}, run: async command => command === bundled && broken
      ? { status: 31, stderr: 'missing git' } : healthy() };
  assert.equal((await runtime.resolveAsync(opts)).shellPath, configured);
  broken = false;
  assert.equal((await runtime.resolveAsync(opts)).shellPath, bundled);
});

test('replacing a shell during an in-flight probe does not cache its stale result', async t => {
  const root = temporary(t);
  const shell = fixture(root, 'bash.exe');
  let calls = 0;
  const options = { env: {}, run: async () => {
    calls++;
    if (calls === 1) fs.writeFileSync(shell, 'new executable replaced while checking');
    return healthy();
  } };
  await runtime.probeAsync(shell, options);
  await runtime.probeAsync(shell, options);
  assert.equal(calls, 2);
});

test('missing all shell candidates fails with an actionable error', async t => {
  const root = temporary(t);
  await assert.rejects(runtime.resolveAsync({ resourceRoot: '', clientRoot: root, env: {},
    platform: 'win32', cwd: root }), /SoduWork.*安装不完整/);
});
