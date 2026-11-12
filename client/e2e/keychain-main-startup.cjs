'use strict';

// Exercise production main.js, preload, and renderer using isolated profiles.
// Fault injection lives in this fixture; no production startup bypass is added.
const electron = require('electron');
if (process.platform !== 'darwin') {
  console.log(JSON.stringify({ skipped: true, reason: 'macOS Keychain startup regression' }));
} else if (typeof electron === 'string') {
  const { spawn } = require('node:child_process');
  const env = { ...process.env };
  for (const name of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE',
    'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[name];
  (async () => {
    for (const scenario of ['missing', 'unavailable', 'cancelled']) {
      await new Promise((resolve, reject) => {
        const child = spawn(electron, [__filename, scenario], { env, stdio: 'inherit' });
        const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(Error(scenario + ' timed out')); }, 30000);
        child.once('error', error => { clearTimeout(timeout); reject(error); });
        child.once('exit', code => {
          clearTimeout(timeout);
          if (code === 0) resolve(); else reject(Error(scenario + ' exited with ' + code));
        });
      });
    }
  })().catch(error => { console.error(error); process.exitCode = 1; });
} else {
  const { app, BrowserWindow } = electron;
  const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
  const scenario = process.argv[2];
  assert.ok(['missing', 'unavailable', 'cancelled'].includes(scenario));
  const client = path.resolve(__dirname, '..');
  const profile = require('./lib/isolated-profile.cjs').isolateProfile(app, 'keychain-main-' + scenario);
  process.env.SODUWORK_USER_DATA = profile.userData;
  // Native Chromium encryption must not access or mutate the real OS Keychain.
  app.commandLine.appendSwitch('use-mock-keychain');
  let availabilityCalls = 0, encryptionCalls = 0, openCalls = 0, quitCalls = 0;
  const errors = [];
  const report = { ok: false, scenario, boundary: 'Production main/preload/renderer; synthetic Keychain failures; isolated data; native mock Keychain' };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(check) {
    for (let i = 0; i < 200; i++) {
      const value = await check();
      if (value) return value;
      await sleep(25);
    }
    throw Error('Startup did not reach the expected visible recovery state');
  }
  // The guard sees the synthetic probe result while native Chromium retains
  // its mock flag. This allows coverage of the real early-return path safely.
  const commandLine = new Proxy(app.commandLine, { get(target, key) {
    if (key === 'hasSwitch') return name => name === 'use-mock-keychain' ? false : target.hasSwitch(name);
    return typeof target[key] === 'function' ? target[key].bind(target) : target[key];
  } });
  const mockedApp = new Proxy(app, { get(target, key) {
    if (key === 'commandLine') return commandLine;
    if (key === 'getLocale') return () => 'en-US';
    if (key === 'quit') return () => { quitCalls++; };
    if (key === 'setLoginItemSettings') return () => {};
    if (key === 'getLoginItemSettings') return () => ({ openAtLogin: false });
    return typeof target[key] === 'function' ? target[key].bind(target) : target[key];
  } });
  const injectedElectron = { ...electron, app: mockedApp,
    safeStorage: {
      isEncryptionAvailable() { availabilityCalls++; return scenario === 'cancelled'; },
      encryptString() { encryptionCalls++; throw Error('Synthetic Keychain cancellation'); },
      decryptString() { throw Error('The synthetic profile must not contain credentials'); },
    },
    shell: { ...electron.shell,
      async openPath(target) {
        assert.equal(path.basename(target), 'Keychain Access.app'); openCalls++; return '';
      },
      async openExternal() { throw Error('External navigation is blocked in this fixture'); },
    },
    globalShortcut: { ...electron.globalShortcut, register: () => false },
  };
  const Module = require('node:module'), originalLoad = Module._load;
  Module._load = function (name, ...args) {
    return name === 'electron' ? injectedElectron : originalLoad.call(this, name, ...args);
  };
  require('../main/macos-keychain.cjs').inspect = () => scenario === 'missing' ? { code: 'KEYCHAIN_DEFAULT_MISSING' } : null;
  app.on('web-contents-created', (_event, contents) => {
    contents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
    contents.on('render-process-gone', (_event, detail) => errors.push('Renderer exited: ' + detail.reason));
  });
  let server;
  (async () => {
    server = require('node:http').createServer((request, response) => {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(request.url.includes('policy') ?
        { mailReady: false, allowSelfRegistration: false } : { ok: false, detail: 'Unauthenticated fixture' }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const hub = 'http://127.0.0.1:' + server.address().port;
    process.env.SODUWORK_TEST_HUB_URL = hub;
    const fetch = global.fetch;
    global.fetch = (url, ...args) => {
      if (new URL(typeof url === 'string' ? url : url.url).origin !== hub) throw Error('External request blocked');
      return fetch(url, ...args);
    };
    app.on('session-created', session => session.webRequest.onBeforeRequest(
      { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
      (request, callback) => callback({ cancel: !request.url.startsWith(hub + '/') })));
    if (scenario !== 'missing') {
      // These unrelated integrations may discover files or start native helpers.
      // Authentication, sessions, preload, and renderer remain production code.
      require('../main/computer-use/index.cjs').install = () => ({ ready: Promise.resolve(), cancel() {} });
      require('../main/conversation/office-engine').syncManagedOfficeCliEnv = () => {};
      require('../main/conversation/skill-roots').discoverAsync = async () => [];
      require('../main/agent-runtime/process-session').prewarmResources = async () => {};
    }
    require('../main.js');
    const win = await until(() => BrowserWindow.getAllWindows().find(window =>
      scenario === 'missing' ? window.webContents.getURL().startsWith('data:') :
        window.webContents.getURL().includes('desk.html')));
    const iconPath = path.join(client, 'icon.png');
    const icon = electron.nativeImage.createFromPath(iconPath);
    assert.equal(icon.isEmpty(), false, 'Product artwork must decode with Electron, not only permissive OS image tools');
    assert.deepEqual(icon.getSize(), { width: 1024, height: 1024 });
    assert.doesNotThrow(() => app.dock.setIcon(iconPath));
    const contents = win.webContents;
    if (scenario === 'missing') {
      await until(() => contents.executeJavaScript('!!document.querySelector("nav a")'));
      assert.equal(BrowserWindow.getAllWindows().length, 1);
      assert.equal(contents.session.getStoragePath(), null);
      assert.equal(availabilityCalls, 0);
      assert.equal(encryptionCalls, 0);
      assert.match(await contents.executeJavaScript('document.body.innerText'), /System Keychain needs attention/);
      for (const action of ['open', 'quit']) {
        const point = await contents.executeJavaScript(`(() => {
          const button = document.querySelector('[href="soduwork-keychain:${action}"]');
          if (!button.checkVisibility()) throw Error('Recovery action is hidden');
          const bounds = button.getBoundingClientRect();
          return { x: Math.round(bounds.x + bounds.width / 2), y: Math.round(bounds.y + bounds.height / 2) };
        })()`);
        for (const type of ['mouseDown', 'mouseUp']) contents.sendInputEvent({ type, ...point, button: 'left', clickCount: 1 });
        await until(() => action === 'open' ? openCalls === 1 : quitCalls === 1);
      }
      report.check = 'Missing default Keychain opens a nonpersistent recovery window with working Open and Quit actions before credentials are accessed';
    } else {
      await until(() => contents.executeJavaScript('document.querySelector(".soduwork-auth-status")?.textContent.includes("系统安全存储")'));
      const state = await contents.executeJavaScript(`({
        visible: document.getElementById('soduWorkClientAuthGate').checkVisibility(),
        pending: document.documentElement.classList.contains('soduwork-auth-pending'),
        enabled: !document.querySelector('.soduwork-auth-submit').disabled
      })`);
      assert.deepEqual(state, { visible: true, pending: true, enabled: true });
      assert.equal(availabilityCalls, 1);
      assert.equal(encryptionCalls, scenario === 'cancelled' ? 1 : 0);
      report.check = 'Secure storage failure leaves a visible login gate with a recovery message and enabled controls';
    }
    assert.equal(fs.existsSync(path.join(profile.userData, 'device-auth.json')), false);
    assert.deepEqual(errors, []);
    report.ok = true;
  })().catch(error => { report.error = error.stack; }).finally(() => {
    server?.close();
    console.log(JSON.stringify(report, null, 2));
    app.exit(report.ok ? 0 : 1);
  });
}
