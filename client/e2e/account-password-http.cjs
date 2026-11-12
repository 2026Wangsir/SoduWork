'use strict';
// Production password dialog -> API -> encrypted device IPC -> temporary Hub
// and local TLS SMTP. No real mailbox, user, database or running service.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const child = require('node:child_process').spawn(electron, [__filename, ...process.argv.slice(2)], { env, windowsHide: true, stdio: 'inherit' });
  const timer = setTimeout(() => child.kill(), 180000);
  child.on('exit', code => { clearTimeout(timer); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, ipcMain, safeStorage } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const { spawn, execFileSync } = require('node:child_process'), { pathToFileURL } = require('node:url'), assert = require('node:assert/strict');
  const sourceManifest = require('./fixtures/account-source-manifest.cjs');
  const client = path.resolve(__dirname, '..'), repo = path.dirname(client);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-account-http-'));
  const profile = path.join(temp, 'profile'); fs.mkdirSync(profile); app.setPath('userData', profile); app.disableHardwareAcceleration();
  const baseline = process.argv.includes('--baseline');
  const out = path.join(repo, 'outputs/password-change-20261024/' + (baseline ? 'baseline-red' : 'http-e2e')); fs.mkdirSync(out, { recursive: true });
  const report = { ok: false, cases: [], screenshots: [], errors: [], requests: [], boundary: 'Real Chromium input, production ClientAuth and AccountVerification, api.js, Electron device IPC and OS safeStorage, loopback FastAPI with temporary SQLite and actual local TLS SMTP. No production user, external SMTP, business service or model.' };
  report.sourcesAtStart = sourceManifest.snapshot();
  let win, server, serverErrors = '', connection;
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const record = name => { report.cases.push({ name, ok: true }); process.stdout.write('PASS ' + name + '\n'); };
  async function js(code) { return win.webContents.executeJavaScript(code, true); }
  async function until(expression, ms = 15000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) { if (await js(expression)) return; await delay(50); }
    throw Error('Wait: ' + expression + '\n' + await js('document.body.innerText'));
  }
  async function click(selector) {
    await js(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'})`); await delay(25);
    const point = await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect();if(e.disabled)throw Error('Disabled '+${JSON.stringify(selector)});return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
    for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, ...point, button: 'left', clickCount: 1 });
    await delay(35);
  }
  async function fill(selector, value) {
    await click(selector);
    assert.equal(await js(`document.activeElement===document.querySelector(${JSON.stringify(selector)})`), true, 'Typing must target the selected input');
    if (!win.webContents.debugger.isAttached()) win.webContents.debugger.attach('1.3');
    for (const type of ['keyDown', 'keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
      type, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2,
    });
    await win.webContents.debugger.sendCommand('Input.insertText', { text: value }); await delay(20);
    assert.equal(await js(`document.querySelector(${JSON.stringify(selector)}).value`), value);
  }
  async function shot(name) {
    await delay(150); // Let the offscreen compositor paint the translated DOM.
    const target = path.join(out, name + '.png'); const image = await win.webContents.capturePage();
    fs.writeFileSync(target, image.toPNG()); report.screenshots.push(target);
  }
  async function key(key, shift = false) {
    if (!win.webContents.debugger.isAttached()) win.webContents.debugger.attach('1.3');
    for (const type of ['keyDown', 'keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
      type, key, code: key === ' ' ? 'Space' : key, windowsVirtualKeyCode: key === 'Tab' ? 9 : 32, modifiers: shift ? 8 : 0,
    });
    await delay(30);
  }
  async function tabTo(selector, shift = false) {
    await key('Tab', shift);
    assert.equal(await js(`document.activeElement === document.querySelector(${JSON.stringify(selector)})`), true, 'Tab focus: ' + selector);
  }
  async function verifyAuthKeyboardOrder() {
    await loginReady();
    await click('[data-auth-mode="register"]'); await fill('#soduWorkAuthPassword', 'Keyboard-input');
    await tabTo('#acConfirmPassword'); await tabTo('[data-password-toggle]');
    await key(' '); assert.equal(await js('document.querySelector("#soduWorkAuthPassword").type'), 'text');
    await key(' '); assert.equal(await js('document.querySelector("#soduWorkAuthPassword").type'), 'password');
    await tabTo('#acConsent'); await tabTo('[data-password-toggle]', true);
    await tabTo('#acConfirmPassword', true); await tabTo('#soduWorkAuthPassword', true);
    record('registration tabs directly to confirmation and keeps password visibility keyboard-accessible in both directions');
    await click('.ac-auth-back'); await click('[data-auth-mode="resetPassword"]');
    await fill('#soduWorkAuthPassword', 'Keyboard-input');
    await tabTo('#acConfirmPassword'); await tabTo('[data-password-toggle]'); await tabTo('.soduwork-auth-submit');
    await tabTo('.ac-auth-back'); await tabTo('.soduwork-auth-submit', true); await tabTo('[data-password-toggle]', true);
    await tabTo('#acConfirmPassword', true); await tabTo('#soduWorkAuthPassword', true);
    record('password recovery keeps confirmation first and permits tabbing out of the form');
    await click('.ac-auth-back'); await fill('#soduWorkAuthPassword', 'Keyboard-input');
    await tabTo('[data-password-toggle]'); await tabTo('.soduwork-auth-submit');
    record('password login retains its existing keyboard order');
  }
  async function deliveredCode(challengeId) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const response = await fetch(connection.hub + '/__fixture__/mail/' + encodeURIComponent(challengeId), { headers: { 'X-Fixture-Key': connection.key } });
      const mail = await response.json();
      if (mail.ready) { assert.equal(mail.smtpDelivered, true); return mail.code; }
      await delay(100);
    }
    throw Error('Local SMTP did not deliver the isolated challenge');
  }
  async function fixtureRequest(method, route) {
    const response = await fetch(connection.hub + '/__fixture__/' + route, { method, headers: { 'X-Fixture-Key': connection.key } });
    assert.equal(response.status, 200); return response.json();
  }
  async function loginReady() { await until('ClientAuth.snapshot().policy?.mailReady===true && !document.querySelector(".soduwork-auth-submit").disabled'); }
  async function logout() {
    const loaded = armReload(); await js('void SoduWorkAPI.clientLogout().then(()=>location.reload());void 0;'); await loaded; await loginReady();
  }
  async function openPassword() {
    await js('AccountCenter.open("security");void 0;'); await until('!!document.querySelector("[data-password-change]")');
    await click('[data-password-change]'); await until('document.querySelector("#soduWorkPwdModal").classList.contains("is-open")');
  }
  async function newPassword(value) { await fill('#soduworkPwdNew', value); await fill('#soduworkPwdConfirm', value); await click('.soduwork-pwd-submit'); }
  async function assertSessionRevoked(token, scheme = 'Device') {
    const route = scheme === 'Bearer' ? '/__fixture__/bearer-profile' : '/api/v1/client-auth/me';
    const response = await fetch(connection.hub + route, { headers: { Authorization: scheme + ' ' + token, 'X-Fixture-Key': connection.key } });
    assert.ok([401, 403].includes(response.status), scheme + ' session issued before change must be invalid');
  }
  async function passwordLogin(account, value, id) {
    await click('[data-auth-mode="password"]'); await fill('#soduWorkAuthAccount', account); await fill('#soduWorkAuthPassword', value); await click('.soduwork-auth-submit');
    await until('ClientAuth.snapshot().user?.id === ' + JSON.stringify(id));
  }
  async function codeLogin(account, id) {
    await click('[data-auth-mode="emailCode"]'); await fill('#soduWorkAuthAccount', account); await click('[data-send-code]'); await until('!!lastChallenge');
    await fill('#acEmailCode', await deliveredCode(await js('lastChallenge'))); await click('.soduwork-auth-submit');
    await until('ClientAuth.snapshot().user?.id === ' + JSON.stringify(id));
  }
  async function emailProof({ wrongFirst = false } = {}) {
    await until('!!document.querySelector(".ac-verify")');
    assert.equal(await js('!!document.querySelector(".ac-verify [data-proof-password]").getClientRects().length'), false);
    assert.equal(await js('!!document.querySelector(".ac-verify .ac-segments").getClientRects().length'), false);
    await click('.ac-verify [data-proof-send]'); await until('!!lastSensitiveChallenge');
    const code = await deliveredCode(await js('lastSensitiveChallenge'));
    if (wrongFirst) {
      await fill('.ac-verify [name="code"]', code === '000000' ? '000001' : '000000'); await click('.ac-verify [type="submit"]');
      await until('!!document.querySelector(".ac-verify .ac-status").textContent && !document.querySelector(".ac-verify [type=submit]").disabled');
      assert.match(await js('document.querySelector(".ac-verify .ac-status").textContent'), /验证码|验证失败/);
      assert.ok(await js('!!SoduWorkAPI.clientAuthSnapshot().user && !!ClientAuth.snapshot().user'));
      record('incorrect email identity code keeps the signed-in account and password form available');
    }
    await fill('.ac-verify [name="code"]', code);
  }
  function armReload() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Expected production document reload did not finish')), 12000);
      win.webContents.once('did-finish-load', () => { clearTimeout(timer); resolve(); });
    });
  }
  app.whenReady().then(async () => {
    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Fixture startup timeout: ' + serverErrors)), 25000);
      server = spawn(path.join(repo, 'hub-backend/.venv/Scripts/python.exe'), ['-B', path.join(__dirname, 'fixtures/account_hub_fixture.py'), '--root', temp], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8' } });
      let stdout = ''; server.stdout.on('data', chunk => { stdout += chunk; const match = stdout.match(/ACCOUNT_FIXTURE_READY (\{[^\n]+\})/); if (match) { clearTimeout(timer); resolve(JSON.parse(match[1])); } });
      server.stderr.on('data', chunk => { serverErrors += chunk; }); server.on('error', reject);
    });
    const readyInfo = await ready; connection = { hub: 'http://127.0.0.1:' + readyInfo.port, key: readyInfo.key };
    const endpoint = require('../main/hub-endpoint.cjs'); endpoint.initialize(app, { SODUWORK_TEST_HUB_URL: connection.hub, SODUWORK_USER_DATA: profile });
    require('../main/device-auth.js').install({ app, ipcMain, safeStorage }); ipcMain.handle('fixture-connection', () => endpoint.current(app));
    const preload = path.join(temp, 'preload.cjs');
    fs.writeFileSync(preload, `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('soduWorkAPI',{
      getHubConnection:()=>ipcRenderer.invoke('fixture-connection'),deviceAuthLogin:r=>ipcRenderer.invoke('device-auth-login',r),
      deviceAccountAction:r=>ipcRenderer.invoke('device-account-action',r),deviceAuthBootstrap:r=>ipcRenderer.invoke('device-auth-bootstrap',r),
      deviceAuthLogout:r=>ipcRenderer.invoke('device-auth-logout',r),deviceAuthClearSession:r=>ipcRenderer.invoke('device-auth-clear-session',r),
      refreshAccountProfile:()=>ipcRenderer.invoke('account-profile-refresh'),deviceAuthStatus:()=>ipcRenderer.invoke('device-auth-status'),
      getAppVersion:async()=> 'e2e',getSysInfo:async()=>({username:'fixture',hostname:'isolated',platform:'win32'}),configureRunner:async()=>({ok:true})});`);
    const files = ['core/api-work-plugins.js', 'api.js', 'components/client-auth/account-ui.js', 'components/client-auth/email-auth.js', 'components/client-auth/account-verification.js', 'components/client-auth/account-center.js', 'components/client-auth/client-auth.js'];
    files.unshift(...JSON.parse(fs.readFileSync(path.join(client, 'core/locales/manifest.json'), 'utf8')).map(file => 'core/locales/' + file), 'core/i18n-dom.js', 'core/i18n.js');
    if (baseline) {
      const original = execFileSync('git', ['show', 'HEAD:client/components/client-auth/client-auth.js'], { cwd: repo, encoding: 'utf8' });
      const originalFile = path.join(temp, 'baseline-client-auth.js'); fs.writeFileSync(originalFile, original);
      files[files.length - 1] = pathToFileURL(originalFile).href;
      report.baseline = { commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(), file: 'client/components/client-auth/client-auth.js', sha256: require('node:crypto').createHash('sha256').update(original).digest('hex') };
    }
    const fixture = path.join(temp, 'fixture.html');
    fs.writeFileSync(fixture, '<!doctype html><html><head><meta charset="utf-8"><base href="' + pathToFileURL(client + path.sep).href + '">' + ['theme/variables.css', 'components/client-auth/client-auth.css', 'components/client-auth/account-center.css'].map(p => '<link rel="stylesheet" href="' + p + '">').join('') + '</head><body><script>window.errors=[];window.lastChallenge=null;window.lastSensitiveChallenge=null;if(!localStorage.getItem("soduwork_work_cfg_v5_locale"))localStorage.setItem("soduwork_work_cfg_v5_locale","zh-CN");addEventListener("error",e=>errors.push(e.message));addEventListener("unhandledrejection",e=>errors.push(String(e.reason)));</script>' + files.map(p => '<script src="' + p + '"></script>').join('') + '<script>const realAction=SoduWorkAPI.clientAccountAction.bind(SoduWorkAPI);SoduWorkAPI.clientAccountAction=async(...args)=>{const result=await realAction(...args);if(args[0]==="emailChallenge"&&result.ok)lastChallenge=result.challengeId;return result;};const realRequest=SoduWorkAPI.clientAccountRequest.bind(SoduWorkAPI);SoduWorkAPI.clientAccountRequest=async(...args)=>{const result=await realRequest(...args);if(args[0]==="challenge")lastSensitiveChallenge=result.challengeId;return result;};</script></body></html>');
    win = new BrowserWindow({ show: false, width: 1100, height: 860, webPreferences: { preload, contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } });
    win.webContents.on('console-message', (_event, details) => { if (details?.level === 'error') process.stderr.write('Renderer: ' + details.message + '\n'); });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (request, cb) => { const allowed = request.url.startsWith(connection.hub + '/'); if (!allowed) report.errors.push('Blocked nonfixture request'); else report.requests.push({ method: request.method, path: new URL(request.url).pathname }); cb({ cancel: !allowed }); });
    await win.loadFile(fixture);
    await verifyAuthKeyboardOrder();
    process.stdout.write('Fixture document loaded\n');
    await until('ClientAuth.snapshot().policy?.mailReady===true && !document.querySelector(".soduwork-auth-submit").disabled');
    for (const [locale, welcome, register, recover] of [
      ['ja-JP', 'おかえりなさい', 'アカウントを作成', 'パスワードを再設定'],
      ['ko-KR', '다시 오신 것을 환영합니다', '계정 만들기', '비밀번호 재설정'],
      ['en-US', 'Welcome back', 'Create your account', 'Reset password'],
      ['zh-CN', '欢迎回来', '创建你的账号', '找回密码'],
    ]) {
      await fill('#soduWorkAuthAccount', 'input-preserved@example.test'); await fill('#soduWorkAuthPassword', 'Untranslated-input');
      await js(`(()=>{const select=document.querySelector('[data-auth-language]');select.value=${JSON.stringify(locale)};select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
      await delay(150);
      assert.equal(await js('document.querySelector("h1").textContent'), welcome);
      assert.equal(await js('document.querySelector("#soduWorkAuthAccount").value'), 'input-preserved@example.test');
      assert.equal(await js('document.querySelector("#soduWorkAuthPassword").value'), 'Untranslated-input');
      await shot('login-' + locale);
      await click('[data-auth-mode="emailCode"]'); assert.equal(await js('document.querySelector("h1").textContent'), welcome);
      await click('[data-auth-mode="register"]'); assert.equal(await js('document.querySelector("h1").textContent'), register);
      await shot('registration-' + locale);
      await click('.ac-auth-back'); await click('[data-auth-mode="resetPassword"]');
      assert.equal(await js('document.querySelector("h1").textContent'), recover);
      const reloaded = armReload(); win.reload(); await reloaded; await loginReady();
      assert.equal(await js('SoduWorkI18n.getLocale()'), locale);
      assert.equal(await js('document.querySelector("h1").textContent'), welcome);
      record(locale + ' login, code login, registration and recovery localize; input stays unchanged and reload preserves locale');
    }
    await click('[data-auth-mode="register"]'); await fill('#soduWorkAuthAccount', 'password-e2e@example.test'); await click('[data-send-code]');
    await until('!!lastChallenge'); await fill('#acEmailCode', await deliveredCode(await js('lastChallenge')));
    assert.match(await js('document.querySelector("#acPasswordRequirements").textContent'), /8.*128/);
    assert.equal(await js('document.querySelector("#acPasswordRequirements").hidden'), false);
    await fill('#soduWorkAuthPassword', 'short12'); await fill('#acConfirmPassword', 'short12'); await click('#acConsent');
    await click('.soduwork-auth-submit');
    assert.match(await js('document.querySelector(".soduwork-auth-status").textContent'), /8.*128/);
    assert.equal(await js('document.activeElement.id'), 'soduWorkAuthPassword');
    assert.equal(report.requests.some(row => row.path.endsWith('/register')), false);
    await shot('registration-password-guidance');
    record('registration shows the password range and rejects seven characters before sending a registration request');
    const password = 'Register'; await fill('#soduWorkAuthPassword', password); await fill('#acConfirmPassword', password);
    await click('.soduwork-auth-submit');
    await until('ClientAuth.snapshot().user?.email === "password-e2e@example.test"');
    assert.equal(await js('ClientAuth.snapshot().user.hasPassword'), true); record('actual registration creates a verified email account with a password');
    const userId = await js('ClientAuth.snapshot().user.id');
    await logout();
    await click('[data-auth-mode="emailCode"]'); await fill('#soduWorkAuthAccount', 'password-e2e@example.test'); await click('[data-send-code]'); await until('!!lastChallenge');
    await fill('#acEmailCode', await deliveredCode(await js('lastChallenge')));
    await click('.soduwork-auth-submit');
    await until('ClientAuth.snapshot().user?.email === "password-e2e@example.test"'); record('same password-bearing account signs in through actual delivered email code');
    await openPassword();
    await shot('email-code-set-password');
    assert.equal(await js('!!document.querySelector("#soduworkPwdCurrent") && !!document.querySelector("#soduworkPwdCurrent").getClientRects().length'), false,
      'Verified email-code account must set a new password without an original-password field');
    record('verified email-code account opens production password dialog without an old-password field');
    if (baseline) throw Error('Baseline unexpectedly contains the password change fix');
    const probes = await fixtureRequest('POST', 'account/' + userId + '/session-probes');
    const oldSession = require('../main/device-auth').session(app);
    const bearerBefore = await fetch(connection.hub + '/__fixture__/bearer-profile', { headers: { Authorization: 'Bearer ' + probes.bearer, 'X-Fixture-Key': connection.key } });
    assert.equal(bearerBefore.status, 200);
    await newPassword('Changed-password-2026'); await emailProof({ wrongFirst: true }); await shot('email-identity-verification');
    const changedReload = armReload(); await click('.ac-verify [type="submit"]');
    await until('!!document.querySelector("#soduWorkPwdModal.is-open") && !document.querySelector(".soduwork-pwd-done").hidden');
    const maskPoint = await js('(()=>{const r=document.querySelector("#soduWorkPwdModal").getBoundingClientRect();return {x:Math.round(r.x+16),y:Math.round(r.y+16)}})()');
    for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, ...maskPoint, button: 'left', clickCount: 1 });
    await until('!document.querySelector("#soduWorkPwdModal").classList.contains("is-open")');
    await changedReload; await loginReady();
    record('closing the successful password dialog through its mask keeps the scheduled signout and login navigation');
    assert.equal(require('../main/device-auth').session(app), ''); assert.equal(await js('ClientAuth.snapshot().user'), null);
    await assertSessionRevoked(oldSession); await assertSessionRevoked(probes.deviceSession); await assertSessionRevoked(probes.bearer, 'Bearer');
    record('new password through authenticated mailbox proof revokes current device, second device and administrator bearer sessions');
    await fill('#soduWorkAuthAccount', 'password-e2e@example.test'); await fill('#soduWorkAuthPassword', password); await click('.soduwork-auth-submit');
    await until('document.querySelector(".soduwork-auth-status").classList.contains("is-error") && !document.querySelector(".soduwork-auth-submit").disabled');
    assert.equal(await js('SoduWorkAPI.clientAuthSnapshot().user'), null); record('old password is rejected after the email-authorized change');
    await passwordLogin('password-e2e@example.test', 'Changed-password-2026', userId); record('newly set password signs in to the same account');
    await logout(); await codeLogin('passwordless@example.test', 'fixture-passwordless-user');
    assert.equal(await js('ClientAuth.snapshot().user.hasPassword'), false); await openPassword();
    assert.equal(await js('!!document.querySelector("#soduworkPwdCurrent").getClientRects().length'), false); await shot('passwordless-set-password');
    await newPassword('Passwordless-first-password-2026'); await emailProof();
    const firstPasswordReload = armReload(); await click('.ac-verify [type="submit"]'); await firstPasswordReload; await loginReady();
    await passwordLogin('passwordless@example.test', 'Passwordless-first-password-2026', 'fixture-passwordless-user');
    assert.equal(await js('ClientAuth.snapshot().user.hasPassword'), true); record('truly passwordless verified-email account sets its first password and signs in with it');
    await logout(); await passwordLogin('legacy.email@example.test', 'Legacy-password-2026', 'fixture-legacy-email-user');
    await openPassword(); assert.equal(await js('!!document.querySelector("#soduworkPwdCurrent").getClientRects().length'), true);
    assert.match(await js('document.querySelector("#soduworkPwdTitle").textContent'), /修改密码/); await shot('legacy-change-password');
    await fill('#soduworkPwdCurrent', 'Wrong-legacy-password'); await newPassword('Legacy-changed-password-2026');
    await until('document.querySelector(".soduwork-pwd-msg").classList.contains("is-error") && !document.querySelector(".soduwork-pwd-submit").disabled');
    assert.equal(await js('ClientAuth.snapshot().user.id'), 'fixture-legacy-email-user');
    await fill('#soduworkPwdCurrent', 'Legacy-password-2026');
    const legacyReload = armReload(); await click('.soduwork-pwd-submit'); await legacyReload; await loginReady();
    await passwordLogin('legacy.email@example.test', 'Legacy-changed-password-2026', 'fixture-legacy-email-user'); record('legacy account without a verified mailbox retains current-password change and can use its new password');
    assert.equal(report.requests.some(row => row.path.endsWith('/password/reset')), false, 'Signed-in account change must never use the public reset-password endpoint');
    assert.equal(report.requests.filter(row => row.path.endsWith('/client-auth/change-password')).length, 4);
    await logout(); await click('[data-auth-mode="resetPassword"]');
    assert.match(await js('document.querySelector("#acPasswordRequirements").textContent'), /8.*128/);
    assert.equal(await js('document.querySelector("#acPasswordRequirements").hidden'), false);
    await fill('#soduWorkAuthAccount', 'password-e2e@example.test');
    await js('lastChallenge=null'); await click('[data-send-code]'); await until('!!lastChallenge');
    await fill('#acEmailCode', await deliveredCode(await js('lastChallenge')));
    await fill('#soduWorkAuthPassword', 'short12'); await fill('#acConfirmPassword', 'short12');
    await click('.soduwork-auth-submit');
    assert.match(await js('document.querySelector(".soduwork-auth-status").textContent'), /8.*128/);
    assert.equal(report.requests.some(row => row.path.endsWith('/password/reset')), false);
    await shot('recovery-password-guidance');
    await fill('#soduWorkAuthPassword', 'Recovery'); await fill('#acConfirmPassword', 'Recovery'); await click('.soduwork-auth-submit');
    await until('document.querySelector(".soduwork-auth-status").textContent.includes("密码已重置")');
    assert.equal(await js('document.querySelector("#acPasswordRequirements").hidden'), true);
    await passwordLogin('password-e2e@example.test', 'Recovery', userId);
    record('password recovery rejects seven characters, accepts eight, and the recovered password signs in');
    assert.deepEqual(await js('errors'), []); assert.deepEqual(report.errors, []);
    report.ok = true;
  }).catch(async error => {
    report.error = String(error.stack || error); report.fixtureErrors = serverErrors.slice(-3000);
    if (win && !win.isDestroyed()) { report.renderer = await js('({text:document.body.innerText,errors,user:ClientAuth.snapshot().user})').catch(() => null); await shot('failure').catch(() => {}); }
    process.stderr.write(report.error + '\n' + report.fixtureErrors + '\n' + JSON.stringify(report.renderer) + '\n');
  }).finally(() => {
    report.sourcesAtEnd = sourceManifest.snapshot(); report.sourceChangesDuringRun = sourceManifest.changed(report.sourcesAtStart, report.sourcesAtEnd);
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); if (win && !win.isDestroyed()) win.destroy(); if (server) server.kill();
    process.stdout.write(JSON.stringify({ ok: report.ok, cases: report.cases.length, report: path.join(out, 'report.json') }) + '\n'); app.exit(report.ok ? 0 : 1);
  });
}
