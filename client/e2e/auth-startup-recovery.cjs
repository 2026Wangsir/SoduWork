'use strict';
// Production authentication UI and CSS in Chromium; temporary profiles, synthetic
// bootstrap replies, and no access to the operating-system credential store.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const name of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE',
    'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[name];
  require('node:child_process').spawn(electron, [__filename], { env, stdio: 'inherit' })
    .on('error', error => { console.error(error); process.exitCode = 1; })
    .on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = electron;
  const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
  const { pathToFileURL } = require('node:url');
  const profile = require('./lib/isolated-profile.cjs').isolateProfile(app, 'auth-startup-recovery');
  const client = path.resolve(__dirname, '..');
  // Chromium cookie encryption is outside this renderer-only regression.
  app.commandLine.appendSwitch('use-mock-keychain');
  const failure = '无法访问系统安全存储。请解锁登录钥匙串并重新打开 SoduWork；原设备凭据已保留。';
  const report = { ok: false, checks: [], boundary: 'Production auth renderer/CSS; synthetic bootstrap failures; no OS keychain access' };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(win, script) {
    for (let i = 0; i < 100; i++) {
      if (await win.webContents.executeJavaScript(script)) return;
      await sleep(20);
    }
    throw Error('Authentication state did not settle');
  }
  const windows = [];
  app.on('window-all-closed', () => {});
  app.whenReady().then(async () => {
    for (const brokenMount of [false, true]) {
      const page = path.join(profile.root, brokenMount ? 'mount-failure.html' : 'keychain-cancel.html');
      const scripts = ['components/client-auth/account-ui.js', 'components/client-auth/email-auth.js'];
      fs.writeFileSync(page, '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><base href="' + pathToFileURL(client + path.sep).href + '">' +
        ['theme/variables.css', 'components/client-auth/client-auth.css', 'components/client-auth/account-center.css'].map(file => '<link rel="stylesheet" href="' + file + '">').join('') +
        '</head><body><div id="privateWorkspace">Private workspace fixture</div><script>' +
        'window.fixtureErrors=[];addEventListener("error",e=>fixtureErrors.push(e.message));addEventListener("unhandledrejection",e=>fixtureErrors.push(String(e.reason)));' +
        'window.SoduWorkAPI={hubBase:()=>"",hubConfig:()=>({editable:false}),registerClient:()=>new Promise(resolve=>{window.finishEnrollment=resolve}),clientAuthPolicy:async()=>({mailReady:false})};' +
        '</script>' + scripts.map(file => '<script src="' + file + '"></script>').join('') +
        (brokenMount ? '<script>EmailAuth.mount=()=>{throw Error("Synthetic mount failure")};</script>' : '') +
        '<script src="components/client-auth/client-auth.js"></script></body></html>');
      const win = new BrowserWindow({ show: false, width: 1080, height: 840,
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
      windows.push(win);
      win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_request, callback) => callback({ cancel: true }));
      await win.loadFile(page);
      await until(win, 'typeof finishEnrollment === "function"');
      assert.equal(await win.webContents.executeJavaScript('document.getElementById("soduWorkClientAuthGate").checkVisibility()'), true);
      await win.webContents.executeJavaScript('finishEnrollment(' + JSON.stringify({ ok: false, stored: false, code: 'DEVICE_KEYCHAIN_UNAVAILABLE', error: failure }) + ');void 0;');
      await until(win, 'document.querySelector(".soduwork-auth-status").textContent === ' + JSON.stringify(failure));
      const state = await win.webContents.executeJavaScript(`({
        visible: document.getElementById('soduWorkClientAuthGate').checkVisibility(),
        privateVisible: document.getElementById('privateWorkspace').checkVisibility({visibilityProperty:true}),
        pending: document.documentElement.classList.contains('soduwork-auth-pending'),
        errors: fixtureErrors,
        recovery: !!document.querySelector('[data-auth-reload]'),
        disabled: document.querySelector('.soduwork-auth-submit').disabled
      })`);
      assert.equal(state.visible, true);
      assert.equal(state.privateVisible, false);
      assert.equal(state.pending, true);
      assert.equal(state.recovery, brokenMount);
      assert.equal(state.disabled, false);
      assert.deepEqual(state.errors, []);
      if (brokenMount) {
        const reloaded = new Promise(resolve => win.webContents.once('did-finish-load', resolve));
        await win.webContents.executeJavaScript('document.querySelector("[data-auth-reload]").click();void 0;');
        await reloaded;
        await until(win, '!!document.querySelector("[data-auth-reload]")');
        report.checks.push('A partially mounted login surface becomes visible recovery with a working reload button; private workspace stays hidden');
      } else {
        report.checks.push('Keychain cancellation leaves a visible actionable login surface with its recovery message and no renderer exception');
      }
      win.destroy();
    }
    report.ok = true;
  }).catch(error => { report.error = error.stack; process.exitCode = 1; }).finally(() => {
    for (const win of windows) if (!win.isDestroyed()) win.destroy();
    console.log(JSON.stringify(report, null, 2));
    app.exit(report.ok ? 0 : 1);
  });
}
