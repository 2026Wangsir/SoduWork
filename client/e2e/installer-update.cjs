'use strict';
// Real Windows NSIS + Electron regression, isolated appId/profile/shortcuts/install directory.
// No production installation, registry key, process, or userData is touched.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { installerSpawnOptions } = require('./fixtures/installer-spawn-options.cjs');
const { createHash } = require('node:crypto');
const { build, createFixtureGuid, fixtureNames, readFixtureReuse, Platform, Arch } = require('./fixtures/isolated-installer-build.cjs');
const { getMakeNsisPath } = require('app-builder-lib/out/toolsets/windows');

const client = path.resolve(__dirname, '..');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function fileHash(file) {
  const hash = createHash('sha256');
  for await (const bytes of fs.createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
}
async function until(fn, ms = 30000) {
  const start = Date.now();
  while (Date.now() - start < ms) { if (await fn()) return; await delay(30); }
  throw Error('Timed out waiting for installer condition');
}
function run(file, args, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(file, args, { env, windowsHide: true, stdio: 'ignore', ...installerSpawnOptions(file, args) });
  child.done = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  return child;
}
async function main() {
  assert.ok(!process.env.SODUWORK_E2E_SETUP || process.env.SODUWORK_E2E_REUSE, 'Reused Setup requires its owned fixture root');
  const root = process.env.SODUWORK_E2E_REUSE || await fsp.mkdtemp(path.join(os.tmpdir(), 'soduwork-update-e2e-'));
  assert.equal(path.dirname(root), os.tmpdir());
  assert.ok(path.basename(root).startsWith('soduwork-update-e2e-'));
  const output = process.argv[2] ? path.resolve(process.argv[2]) : root;
  await fsp.mkdir(output, { recursive: true });
  const reused = process.env.SODUWORK_E2E_REUSE
    ? await readFixtureReuse(root, process.env.SODUWORK_E2E_SETUP, process.env.SODUWORK_E2E_GUID) : null;
  const id = reused?.id || 'com.soduwork.update.e2e.' + Date.now();
  const guid = reused?.guid || createFixtureGuid(process.env.SODUWORK_E2E_GUID);
  const { productName, executableName, shortcutName } = fixtureNames(guid);
  const executable = executableName + '.exe';
  // Preserve ownership evidence even if fixture construction or installation fails.
  await fsp.writeFile(path.join(output, 'report.json'), JSON.stringify({ root, id, guid, productName, executableName, shortcutName, ok: false }));
  const appDir = path.join(root, 'fixture');
  const dist = path.join(root, 'dist');
  const installed = path.join(root, '中文 ' + productName + ' ' + Date.now());
  await fsp.mkdir(appDir, { recursive: true });
  await fsp.writeFile(path.join(appDir, 'package.json'), JSON.stringify({
    name: 'soduwork-update-e2e', version: '1.0.1', main: 'index.js', description: 'Isolated updater regression',
  }));
  await fsp.writeFile(path.join(appDir, 'index.js'), [
    "const {app}=require('electron'),fs=require('fs'),path=require('path');",
    "app.setPath('userData',process.env.SODUWORK_UPDATE_E2E_PROFILE);",
    "app.whenReady().then(()=>{fs.writeFileSync(process.env.SODUWORK_UPDATE_E2E_OUTPUT,JSON.stringify({",
    "exe:process.execPath,version:app.getVersion(),args:process.argv,",
    "profile:app.getPath('userData')}));app.quit()});",
  ].join('\n'));
  const { longResource, zipBytes } = require('./fixtures/installer-prepare.cjs');
  console.log('Preparing real NSIS fixture:', root);
  const base = JSON.parse(await fsp.readFile(path.join(client, 'package.json'), 'utf8')).build;
  const result = process.env.SODUWORK_E2E_SETUP ? [process.env.SODUWORK_E2E_SETUP] : await build({
    targets: Platform.WINDOWS.createTarget(['nsis'], Arch.x64),
    projectDir: client,
    ...(process.env.SODUWORK_E2E_REUSE ? { prepackaged: path.join(dist, 'win-unpacked') } : {}),
    config: {
      appId: id, productName, copyright: 'Isolated regression only',
      directories: { app: appDir, output: dist, buildResources: path.join(client, 'build') },
      electronDist: path.dirname(require('electron')), electronVersion: require('electron/package.json').version,
      files: ['index.js', 'package.json', '!node_modules/**'], extraResources: [],
      afterPack: path.join(__dirname, 'fixtures/installer-prepare.cjs'),
      afterSign: path.join(__dirname, 'fixtures/installer-prepare.cjs'),
      win: { target: ['nsis'], icon: path.join(client, 'icon.ico'), executableName, signAndEditExecutable: false },
      nsis: { ...base.nsis, guid, shortcutName, artifactName: productName + '-${version}-Setup.exe', include: path.join(client, 'build/installer.nsh'),
        installerIcon: path.join(client, 'icon.ico'), uninstallerIcon: path.join(client, 'icon.ico'),
        // Compile production shortcut branches too without touching real links.
        // This option is build-only; ordinary native runs use an isolated .lnk below.
        createDesktopShortcut: !!process.env.SODUWORK_E2E_BUILD_ONLY, createStartMenuShortcut: !!process.env.SODUWORK_E2E_BUILD_ONLY, runAfterFinish: false },
      compression: 'store', npmRebuild: false,
    },
  });
  const setup = result.find(file => file.endsWith('.exe'));
  assert.ok(setup);
  if (process.env.SODUWORK_E2E_BUILD_ONLY) { console.log('Built fixture:', setup); return; }
  const env = { SODUWORK_UPDATE_E2E_PROFILE: path.join(root, 'profile'),
    SODUWORK_UPDATE_E2E_OUTPUT: path.join(root, 'launched.json') };
  await fsp.mkdir(env.SODUWORK_UPDATE_E2E_PROFILE, { recursive: true });
  await fsp.writeFile(path.join(env.SODUWORK_UPDATE_E2E_PROFILE, 'sentinel.txt'), 'keep user data');
  const tests = [];
  const fresh = path.join(root, '首次安装 ' + productName + ' ' + Date.now());
  const freshStarted = Date.now();
  assert.equal(await run(setup, ['/S', '/currentuser', '/D=' + fresh], env).done, 0);
  const freshDetails = JSON.parse(await fsp.readFile(path.join(fresh, '.soduwork-update-details.json'), 'utf8'));
  assert.equal(freshDetails.ok, true);assert.ok(freshDetails.fileCount > 0);
  assert.match(await fsp.readFile(path.join(fresh, '.soduwork-update.log'), 'utf8'), /verifying/);
  await fsp.rm(env.SODUWORK_UPDATE_E2E_OUTPUT, { force: true });
  assert.equal(await run(path.join(fresh, executable), [], env).done, 0);
  await until(() => fs.existsSync(env.SODUWORK_UPDATE_E2E_OUTPUT));
  const freshLaunch = JSON.parse(await fsp.readFile(env.SODUWORK_UPDATE_E2E_OUTPUT, 'utf8'));
  const freshActive = await fsp.readFile(path.join(fresh, '.soduwork-active'), 'utf8');
  assert.equal(freshLaunch.exe, path.join(fresh, '.soduwork-versions', freshActive, executable));
  const nativeRoot = path.join(fresh, '.soduwork-versions', freshActive);
  assert.equal(await fsp.readFile(path.join(nativeRoot, longResource), 'utf8'), 'deep native runtime resource');
  assert.ok(path.join(nativeRoot, longResource).length > 350);
  assert.deepEqual(await fsp.readFile(path.join(nativeRoot, 'resources/runner/_internal/base_library.zip')), zipBytes);
  tests.push({ name: 'native extraction preserves Python ZIP and deep Unicode paths', pathLength: path.join(nativeRoot, longResource).length });
  tests.push({ name: 'first install into an empty directory verifies payload and launches', elapsedMs: Date.now() - freshStarted, fileCount: freshDetails.fileCount });
  await fsp.cp(path.join(dist, 'win-unpacked'), installed, { recursive: true });
  const entry = path.join(installed, executable);
  const shortcut = path.join(root, 'SoduWork.lnk');
  const ps = "$w=New-Object -ComObject WScript.Shell;$s=$w.CreateShortcut($env:SODUWORK_E2E_LINK);$s.TargetPath=$env:SODUWORK_E2E_ENTRY;$s.Save()";
  const makeLink = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
    { windowsHide: true, env: { ...process.env, SODUWORK_E2E_LINK: shortcut, SODUWORK_E2E_ENTRY: entry } });
  assert.equal(makeLink.status, 0, String(makeLink.stderr || makeLink.error || 'shortcut creation failed'));
  const mode = process.env.SODUWORK_E2E_MODE === 'allusers' ? 'allusers' : 'currentuser';
  // Demonstrate the old ordering's broken-target interval without invoking a production uninstaller.
  await fsp.writeFile(path.join(installed, '.soduwork-e2e-owned'), 'isolated');
  await fsp.copyFile(entry, path.join(installed, executableName + '.pre-test.exe'));
  const compiler = await getMakeNsisPath();
  const baseline = path.join(root, 'baseline.exe');
  const compiled = spawnSync(compiler.path, ['/V2', '/INPUTCHARSET', 'UTF8',
    '/DSODUWORK_E2E_BASELINE_OUT=' + baseline, '/DSODUWORK_E2E_ROOT=' + installed, '/DSODUWORK_E2E_EXECUTABLE_NAME=' + executableName,
    path.join(client, 'e2e/fixtures/installer-legacy-gap.nsi')],
    { windowsHide: true, env: { ...process.env, ...compiler.env }, encoding: 'utf8' });
  assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
  const baselineHash = await fileHash(entry);
  let legacyMissing = 0;
  const legacyWatch = setInterval(() => { if (!fs.existsSync(entry)) legacyMissing++; }, 5);
  try { assert.equal(await run(baseline, [], env).done, 0); } finally { clearInterval(legacyWatch); }
  assert.ok(legacyMissing > 0, 'old delete-first sequence must reproduce a broken target');
  assert.ok(fs.existsSync(entry), 'legacy baseline fixture failed to restore the entry before upgrade');
  assert.equal(await fileHash(entry), baselineHash, 'legacy baseline fixture restored different or incomplete entry bytes');
  tests.push({ name: 'old delete-first sequence reproduces missing shortcut target', missingSamples: legacyMissing, restoredSha256: baselineHash });
  async function upgrade(name, options = {}) {
    assert.ok(fs.existsSync(entry), 'entry is already missing before upgrade: ' + name);
    const previous = fs.existsSync(path.join(installed, '.soduwork-active'))
      ? fs.readFileSync(path.join(installed, '.soduwork-active'), 'utf8') : '';
    let missing = 0, samples = 0;
    const missingDetails = []; let lastMissing;
    const start = Date.now();
    const versions = path.join(installed, '.soduwork-versions');
    const knownDirs = new Set(await fsp.readdir(versions).catch(() => []));
    let queued = null;
    await fsp.rm(path.join(installed, '.soduwork-update-progress'), { force: true });
    const progress = [];
    function sampleProgress() {
      try {
        const value = fs.readFileSync(path.join(installed, '.soduwork-update-progress'), 'ascii');
        const match = /^(\d+)\|(\d+)\|(\d+)$/.exec(value);
        if (!match || progress.at(-1)?.value === value) return;
        progress.push({ value, percent: Number(match[1]), elapsedMs: Date.now() - start,
          phase: fs.readFileSync(path.join(installed, '.soduwork-update-phase'), 'ascii') });
      } catch (_) { /* an atomic replacement can be briefly busy */ }
    }
    const progressWatch = setInterval(sampleProgress, 25);
    if (options.queueClick) await fsp.rm(env.SODUWORK_UPDATE_E2E_OUTPUT, { force: true });
    const watch = setInterval(() => {
      samples++;
      if (!fs.existsSync(entry)) {
        missing++;
        const detail = { elapsedMs: Date.now() - start };
        try { detail.statSize = fs.statSync(entry).size; } catch (error) { detail.code = error.code; }
        if (missingDetails.length < 8) missingDetails.push(detail);
        lastMissing = detail;
      }
    }, 2);
    const child = run(setup, ['/S', '/' + mode, ...(options.legacy ? [] : ['--updated']), '/D=' + installed], env);
    try {
      if (options.interrupt) {
        await until(() => fs.existsSync(versions) && fs.readdirSync(versions).some(name => {
          if (knownDirs.has(name)) return false;
          const dir = path.join(versions, name);
          // NSIS briefly creates/removes a temporary filename before its stage directory.
          // A disappearing directory between readdir/stat is not an installer failure.
          try { return fs.statSync(dir).isDirectory() && fs.readdirSync(dir).length > 4; }
          catch (error) { if (error.code === 'ENOENT') return false; throw error; }
        }), 60000);
        child.kill(); // exact isolated fixture PID, not an application-name kill
      }
      if (options.queueClick) {
        await until(() => fs.existsSync(versions) && fs.readdirSync(versions).some(name => !knownDirs.has(name)));
        queued = run(entry, ['--e2e-argument', '中文 argument'], env);
        await delay(100);
        assert.equal(fs.existsSync(env.SODUWORK_UPDATE_E2E_OUTPUT), false, 'click during update must wait for commit');
      }
      const code = await child.done;
      sampleProgress();
      for (let i = 0; i < progress.length; i++) {
        assert.ok(progress[i].percent >= (progress[i - 1]?.percent || 0), 'real installation progress went backwards');
        if (progress[i].percent === 100) assert.equal(progress[i].phase, 'committed');
      }
      if (queued) {
        await queued.done;
        await until(() => fs.existsSync(env.SODUWORK_UPDATE_E2E_OUTPUT));
        const clicked = JSON.parse(await fsp.readFile(env.SODUWORK_UPDATE_E2E_OUTPUT, 'utf8'));
        const active = await fsp.readFile(path.join(installed, '.soduwork-active'), 'utf8');
        assert.notEqual(active, previous, 'queued click ran before the new payload was committed');
        assert.equal(clicked.exe, path.join(installed, '.soduwork-versions', active, executable),
          'queued click must open the newly committed payload');
      }
      if (missing) await fsp.writeFile(path.join(output, 'missing-entry.json'), JSON.stringify({
        name, entry, code, previous, baselineHash, samples, missing, firstMissing: missingDetails, lastMissing,
      }, null, 2));
      assert.equal(missing, 0, 'stable shortcut target disappeared; see missing-entry.json');
      assert.ok(fs.existsSync(shortcut), 'shortcut was removed');
      if (options.fail || options.interrupt) {
        assert.ok(progress.every(item => item.percent < 100), 'failed/interrupted install claimed completion');
        const now = fs.existsSync(path.join(installed, '.soduwork-active')) ? fs.readFileSync(path.join(installed, '.soduwork-active'), 'utf8') : '';
        assert.equal(now, previous, 'failed update activated a new payload');
        if (options.fail) assert.notEqual(code, 0);
      } else {
        assert.equal(code, 0);
        assert.equal(progress.at(-1)?.percent, 100, 'successful install missing measured completion');
        assert.ok(progress.some(item => item.percent > 0 && item.percent <= 70), 'missing real extraction progress');
        assert.ok(progress.some(item => item.percent >= 70 && item.percent <= 98), 'missing real verification progress');
        assert.notEqual(fs.readFileSync(path.join(installed, '.soduwork-active'), 'utf8'), previous);
      }
      tests.push({ name, code, elapsedMs: Date.now() - start, samples, missing, progress });
      console.log('PASS:', mode, name, code, Date.now() - start, 'ms');
    } finally { clearInterval(watch); clearInterval(progressWatch); }
  }
  async function launch(name) {
    await fsp.rm(env.SODUWORK_UPDATE_E2E_OUTPUT, { force: true });
    const launch = run(entry, ['--e2e-argument', '中文 argument'], env);
    await launch.done;
    await until(() => fs.existsSync(env.SODUWORK_UPDATE_E2E_OUTPUT));
    const data = JSON.parse(fs.readFileSync(env.SODUWORK_UPDATE_E2E_OUTPUT, 'utf8'));
    assert.ok(data.args.includes('中文 argument'));
    assert.equal(data.profile, env.SODUWORK_UPDATE_E2E_PROFILE);
    const active = fs.readFileSync(path.join(installed, '.soduwork-active'), 'utf8');
    assert.equal(data.exe, path.join(installed, '.soduwork-versions', active, executable));
    tests.push({ name, ...data });
  }
  await upgrade('legacy helper /S migration', { legacy: true });
  await launch('stable launcher starts versioned Electron');
  // Reproduce the launcher shipped in 1.12.52. Its lock-error lookup lets a
  // shortcut launch the old payload during installation if the launcher is kept.
  const legacyRecovery = await fsp.readFile(path.join(installed, 'SoduWork.previous.exe'));
  const oldLauncher = path.join(root, 'launcher-1.12.52.exe');
  const oldCompiled = spawnSync(compiler.path, ['/V2', '/INPUTCHARSET', 'UTF8',
    '/DSODUWORK_LAUNCHER_OUT=' + oldLauncher, '/DSODUWORK_ICON=' + path.join(client, 'icon.ico'),
    path.join(client, 'e2e/fixtures/launcher-1.12.52.nsi')],
    { windowsHide: true, env: { ...process.env, ...compiler.env }, encoding: 'utf8' });
  assert.equal(oldCompiled.status, 0, oldCompiled.stdout + oldCompiled.stderr);
  const oldLauncherBytes = await fsp.readFile(oldLauncher);
  await fsp.copyFile(oldLauncher, entry);
  await upgrade('subsequent versioned update; click waits and opens automatically', { queueClick: true });
  assert.notDeepEqual(await fsp.readFile(entry), oldLauncherBytes);
  assert.deepEqual(await fsp.readFile(path.join(installed, '.soduwork-launcher.previous.exe')), oldLauncherBytes);
  assert.deepEqual(await fsp.readFile(path.join(installed, 'SoduWork.previous.exe')), legacyRecovery);
  tests.push({ name: '1.12.52 launcher refreshed before extraction; original recovery binary preserved' });
  await launch('entry still opens the active version');
  // A real Windows sharing violation must stop before changing the active
  // payload or losing the entry. The handle belongs only to this fixture.
  const lockReady = path.join(root, 'launcher-read-lock-ready');
  const lockCommand = '$ErrorActionPreference="Stop";$h=[IO.File]::Open($env:SODUWORK_TEST_LOCK_ENTRY,"Open","Read","ReadWrite");try{[IO.File]::WriteAllText($env:SODUWORK_TEST_LOCK_READY,"ready");[Console]::ReadLine()|Out-Null}finally{$h.Dispose()}';
  const lockedBytes = await fsp.readFile(entry);
  const lockProcess = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', lockCommand],
    { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'], env: { ...process.env,
      SODUWORK_TEST_LOCK_ENTRY: entry, SODUWORK_TEST_LOCK_READY: lockReady } });
  const lockExited = new Promise((resolve, reject) => {
    lockProcess.once('error', reject); lockProcess.once('exit', resolve);
  });
  try {
    await until(() => fs.existsSync(lockReady), 15000);
    await upgrade('launcher sharing violation keeps the existing entry and active payload', { fail: true });
    assert.deepEqual(await fsp.readFile(entry), lockedBytes);
    assert.deepEqual(await fsp.readFile(path.join(installed, 'SoduWork.previous.exe')), legacyRecovery);
    assert.match(await fsp.readFile(path.join(installed, '.soduwork-update.log'), 'utf8'), /launcher-swap-failed/);
  } finally { lockProcess.stdin.end('\n'); await lockExited; }
  await launch('existing version opens after launcher replacement was blocked');
  const badPointer = path.join(installed, '.soduwork-active.next');
  await fsp.mkdir(badPointer); // force a commit write failure without touching installed payloads
  await upgrade('commit failure retains old version', { fail: true });
  await fsp.rmdir(badPointer);
  await launch('previous version opens after failed commit');
  await upgrade('interrupted setup retains last active version', { interrupt: true });
  await launch('old version opens after interruption');
  await upgrade('manual silent reinstall repairs interrupted update', { legacy: true });
  assert.deepEqual(await fsp.readFile(path.join(installed, 'SoduWork.previous.exe')), legacyRecovery);
  await launch('repaired installation opens');
  assert.equal(await fsp.readFile(path.join(env.SODUWORK_UPDATE_E2E_PROFILE, 'sentinel.txt'), 'utf8'), 'keep user data');
  tests.push({ name: 'user data preserved', pass: true });
  // Exercise the real post-quit WSH handoff and its automatic relaunch.
  await fsp.rm(env.SODUWORK_UPDATE_E2E_OUTPUT, { force: true });
  const updater = require('../main/client-updater');
  const helper = path.join(root, 'install-update.vbs');
  await fsp.writeFile(helper, updater._updateHelperScript(), 'ascii');
  await updater._launchUpdateHelper(helper, {
    ...process.env, ...env, SODUWORK_OLD_PID: '2147483647',
    SODUWORK_INSTALLER: setup, SODUWORK_APP: entry, SODUWORK_INSTALL_DIR: installed,
    SODUWORK_HELPER_READY: path.join(root, require('node:crypto').randomUUID() + '.ready'),
    SODUWORK_INSTALL_MODE: fs.readFileSync(path.join(installed, '.soduwork-install-mode'), 'utf8'),
  });
  await until(() => fs.existsSync(env.SODUWORK_UPDATE_E2E_OUTPUT), 120000);
  const reopened = JSON.parse(await fsp.readFile(env.SODUWORK_UPDATE_E2E_OUTPUT, 'utf8'));
  assert.ok(reopened.args.includes('--updated'));
  assert.equal(reopened.exe, path.join(installed, '.soduwork-versions',
    fs.readFileSync(path.join(installed, '.soduwork-active'), 'utf8'), executable));
  tests.push({ name: 'real WSH handoff, install and automatic relaunch', ...reopened });

  await fsp.writeFile(path.join(output, 'report.json'), JSON.stringify({ root, fresh, installed, setup, id, guid,
    productName, executableName, shortcutName, mode, tests }, null, 2));
  console.log(JSON.stringify({ root, tests }, null, 2));
}
main().catch(error => { console.error(error); process.exit(1); });
