'use strict';

// Verify only launcher profile selection and native Electron bootstrap with synthetic data.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const crypto = require('node:crypto'), assert = require('node:assert/strict');
const electron = require('electron');

if (typeof electron !== 'string') {
  const { app, BrowserWindow } = electron;
  const config = JSON.parse(fs.readFileSync(process.env.SODUWORK_LAUNCHER_PROFILE_FIXTURE, 'utf8'));
  app.setPath('appData', config.appData);
  app.setAppPath(path.resolve(__dirname, '..'));
  app.disableHardwareAcceleration();
  let win;
  try {
    const directory = require('../main/userdata-path.cjs').initializeUserData(app,
      { SODUWORK_USER_DATA: config.profile });
    const locked = app.requestSingleInstanceLock();
    const marker = path.join(directory, 'bootstrap-fixture.json');
    const previous = fs.existsSync(marker) ? JSON.parse(fs.readFileSync(marker, 'utf8')) : null;
    if (locked && !previous) fs.writeFileSync(marker, JSON.stringify({ instance: config.instance }));
    process.send({ directory, locked, previous, packaged: app.isPackaged });
    if (!locked) app.exit(0);
    else {
      app.on('second-instance', () => {});
      process.on('message', value => { if (value === 'stop') { win?.destroy(); app.quit(); } });
      app.whenReady().then(async () => {
        win = new BrowserWindow({ show: false, width: 320, height: 240,
          webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
        await win.loadURL('data:text/html,<title>Source launcher bootstrap fixture</title>');
        process.send({ ready: true, window: !win.isDestroyed(), title: win.getTitle(), userData: app.getPath('userData') });
      }).catch(error => { process.send({ error: error.message }); app.exit(1); });
    }
  } catch (error) {
    process.send({ blocked: true, message: error.message });
    app.exit(0);
  }
} else {
  const { spawn, spawnSync } = require('node:child_process');
  const repository = path.resolve(__dirname, '../..'), output = process.argv[2], python = process.argv[3] || 'python3.12';
  assert.equal(process.platform, 'darwin', 'This fixture verifies the actual macOS reserved-profile contract');
  assert.equal(Number(process.versions.node.split('.')[0]), 22, 'Run this bootstrap fixture with Node.js 22');
  assert.ok(output && path.isAbsolute(output), 'Absolute evidence directory required');
  fs.mkdirSync(output, { recursive: true });
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-launcher-profile-')));
  const home = path.join(temporary, 'synthetic-home'), appData = path.join(home, 'Library/Application Support');
  const installed = path.join(appData, 'SoduWork'), lowerInstalled = path.join(appData, 'soduwork');
  const defaultState = path.join(installed, 'source-service'), nested = path.join(installed, 'local-model-verify');
  const secondState = path.join(lowerInstalled, 'another-source'), outside = path.join(temporary, 'outside-state');
  for (const state of [defaultState, nested, secondState, outside]) {
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, 'local-service.json'), JSON.stringify({ synthetic: true, state: path.basename(state) }));
  }
  const sentinel = path.join(installed, 'device-auth.json');
  fs.writeFileSync(sentinel, 'synthetic-installed-profile-must-remain-byte-identical');
  const children = new Set(), cases = [];
  const report = { ok: false, cases, node: process.versions.node, platform: process.platform,
    boundary: 'Real Python desktop_profile with a synthetic Path.home, actual macOS platform, production Electron initializeUserData, native single-instance locks, ready and hidden BrowserWindow. Disposable appData and sentinel files only; no full product startup, account, Hub, Runner, model, installed profile or real system-keychain validation.' };
  const env = { ...process.env, PYTHONDONTWRITEBYTECODE: '1' };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE',
    'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];

  function fingerprint(directory) {
    const rows = [];
    function visit(current) {
      for (const name of fs.readdirSync(current).sort()) {
        const file = path.join(current, name), stat = fs.lstatSync(file);
        rows.push({ name: path.relative(directory, file), mode: stat.mode,
          ...(stat.isSymbolicLink() ? { link: fs.readlinkSync(file) }
            : stat.isDirectory() ? { directory: true }
              : { sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') }) });
        if (stat.isDirectory() && !stat.isSymbolicLink()) visit(file);
      }
    }
    visit(directory); return rows;
  }
  const before = fingerprint(installed);
  function profile(state) {
    const script = [
      'import json, sys', 'from pathlib import Path', 'from unittest.mock import patch',
      'from tools.dev import start_local',
      'assert sys.version_info[:2] == (3, 12), "Python 3.12 is required"',
      'with patch.object(start_local.Path, "home", return_value=Path(sys.argv[1])):',
      '    try:',
      '        value = start_local.desktop_profile(Path(sys.argv[2]))',
      '        print(json.dumps({"profile": str(value), "python": sys.version.split()[0]}))',
      '    except start_local.StartupError as error:',
      '        print(json.dumps({"blocked": True, "message": str(error), "python": sys.version.split()[0]}))',
    ].join('\n');
    const result = spawnSync(python, ['-c', script, home, state], { cwd: repository, env, encoding: 'utf8', timeout: 15000 });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr);
    const value = JSON.parse(result.stdout); report.python = value.python; return value;
  }
  function expectedCustom(state) {
    const hash = crypto.createHash('sha256').update(fs.realpathSync(state)).digest('hex').slice(0, 20);
    return path.join(appData, 'SoduWork Development', 'source-service-desktop-' + hash);
  }
  function mark(value) { cases.push(value); console.log('PASS ' + value); }
  async function start(instance, selectedProfile) {
    const config = path.join(temporary, instance + '.json');
    fs.writeFileSync(config, JSON.stringify({ appData, instance, profile: selectedProfile }));
    const child = spawn(electron, [__filename], { env: { ...env, SODUWORK_LAUNCHER_PROFILE_FIXTURE: config },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
    children.add(child);
    let stderr = '';
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-6000); });
    child.once('exit', () => children.delete(child));
    return new Promise((resolve, reject) => {
      let result, settled = false;
      const timer = setTimeout(() => { settled = true; child.kill(); reject(Error('Electron bootstrap timed out: ' + instance + '\n' + stderr)); }, 25000);
      child.on('message', value => {
        if (value.error) { clearTimeout(timer); reject(Error(value.error)); return; }
        if (!value.ready) result = value;
        if (value.ready || value.blocked || value.locked === false) {
          settled = true; clearTimeout(timer); resolve({ child, result, ready: value.ready ? value : null });
        }
      });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => {
        clearTimeout(timer);
        if (!settled) reject(Error('Electron exited before readiness: ' + code + '\n' + stderr));
      });
    });
  }
  async function stop(child) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(Error('Electron did not stop cleanly')); }, 10000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      if (child.connected) child.send('stop'); else child.kill();
    });
  }
  function ready(instance, selectedProfile) {
    assert.equal(instance.result.packaged, false);
    assert.equal(instance.result.locked, true);
    assert.equal(instance.result.directory, selectedProfile);
    assert.equal(instance.ready?.window, true);
    assert.equal(instance.ready?.title, 'Source launcher bootstrap fixture');
    assert.equal(instance.ready?.userData, selectedProfile);
    assert.equal(fs.existsSync(path.join(selectedProfile, 'device-auth.json')), false);
  }
  (async () => {
    let failure = null;
    try {
      const legacy = profile(defaultState);
      assert.equal(legacy.profile, path.join(appData, 'SoduWork Development/source-service-desktop'));
      assert.equal(fs.existsSync(legacy.profile), false, 'profile selection itself must not write directories');
      const nestedProfile = profile(nested), secondProfile = profile(secondState), external = profile(outside);
      assert.equal(nestedProfile.profile, expectedCustom(nested));
      assert.equal(secondProfile.profile, expectedCustom(secondState));
      assert.notEqual(nestedProfile.profile, secondProfile.profile);
      assert.equal(external.profile, path.join(outside, 'desktop-profile'));
      const upperState = path.join(appData, 'SODUWORK/casefold-state');
      const upperExpected = path.join(appData, 'SoduWork Development', 'source-service-desktop-' +
        crypto.createHash('sha256').update(upperState).digest('hex').slice(0, 20));
      assert.equal(profile(upperState).profile, upperExpected);
      mark('Default source-service retains its legacy independent profile; nested custom and case-folded reserved paths receive stable isolated profiles');

      const alias = path.join(temporary, 'nested-alias'), defaultAlias = path.join(temporary, 'default-alias');
      fs.symlinkSync(nested, alias, 'dir'); fs.symlinkSync(defaultState, defaultAlias, 'dir');
      assert.equal(profile(alias).profile, nestedProfile.profile);
      assert.equal(profile(defaultAlias).profile, legacy.profile);
      assert.equal(profile(nested).profile, nestedProfile.profile);
      mark('Repeated selection and symlink aliases retain the resolved state identity without moving service data');

      const a = await start('default', legacy.profile), b = await start('nested', nestedProfile.profile);
      ready(a, legacy.profile); ready(b, nestedProfile.profile);
      assert.equal(a.result.previous, null); assert.equal(b.result.previous, null);
      mark('Two real source Electron processes hold separate native locks and create ready windows in their launcher-selected profiles');
      const duplicate = await start('alias-duplicate', profile(alias).profile);
      assert.equal(duplicate.result.locked, false); assert.equal(duplicate.result.directory, b.result.directory);
      await stop(a.child);
      const restarted = await start('default-restart', profile(defaultAlias).profile);
      ready(restarted, legacy.profile); assert.deepEqual(restarted.result.previous, { instance: 'default' });
      mark('The same resolved state keeps its native lock and restores only its own bootstrap marker after restart');

      for (const candidate of [installed, path.join(installed, 'forbidden-desktop')]) {
        const denied = await start('reserved-' + path.basename(candidate), candidate);
        assert.equal(denied.result.blocked, true); assert.match(denied.result.message, /独立数据目录/);
        assert.equal(denied.ready, null);
      }
      assert.equal(fs.existsSync(path.join(installed, 'forbidden-desktop')), false);
      mark('Production Electron guards reject direct installed and nested installed overrides before directory or window creation');

      const unsafeState = path.join(installed, 'unsafe-source');
      const unsafeProfile = path.join(appData, 'SoduWork Development', 'source-service-desktop-' +
        crypto.createHash('sha256').update(unsafeState).digest('hex').slice(0, 20));
      fs.symlinkSync(installed, unsafeProfile, 'dir');
      const denied = profile(unsafeState);
      assert.equal(denied.blocked, true); assert.match(denied.message, /existing data was not changed/);
      assert.equal(fs.existsSync(path.join(installed, 'hub-endpoint.json')), false);
      assert.equal(fs.existsSync(path.join(installed, 'chat-config.json')), false);
      assert.deepEqual(fingerprint(installed), before);
      mark('Launcher rejects a generated profile symlink back into installed data before writes; installed sentinels and directory contents remain unchanged');
    } catch (error) {
      failure = error;
      report.error = String(error.stack || error);
    } finally {
      const stopped = await Promise.allSettled([...children].map(stop));
      const cleanupErrors = stopped.filter(result => result.status === 'rejected')
        .map(result => String(result.reason?.stack || result.reason));
      try {
        assert.ok(path.basename(temporary).startsWith('soduwork-launcher-profile-'));
        fs.rmSync(temporary, { recursive: true, force: true });
      } catch (error) { cleanupErrors.push(String(error.stack || error)); }
      report.cleanup = { ok: cleanupErrors.length === 0, errors: cleanupErrors };
      report.ok = !failure && report.cleanup.ok;
      try {
        fs.writeFileSync(path.join(output, 'source-launcher-profile.json'), JSON.stringify(report, null, 2));
      } catch (error) {
        throw failure ? new AggregateError([failure, error], 'Bootstrap verification failed and its report could not be written') : error;
      }
    }
    console.log(JSON.stringify(report));
    if (failure) throw failure;
    if (!report.cleanup.ok) throw Error('Bootstrap fixture cleanup failed: ' + report.cleanup.errors.join('\n'));
  })().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
}
