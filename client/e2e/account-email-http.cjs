'use strict';
// Production email-change dialog -> API -> encrypted device IPC -> temporary Hub
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
  const python = process.env.SODUWORK_TEST_PYTHON || path.join(repo, 'hub-backend/.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-account-http-'));
  const profile = path.join(temp, 'profile'); fs.mkdirSync(profile); app.setPath('userData', profile); app.disableHardwareAcceleration();
  const out = path.join(repo, 'outputs/email-change-20261024/http-e2e'); fs.mkdirSync(out, { recursive: true });
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
    // Use the native editing command so hidden fixtures select reliably on every platform.
    win.webContents.selectAll();
    await win.webContents.debugger.sendCommand('Input.insertText', { text: value }); await delay(20);
    assert.equal(await js(`document.querySelector(${JSON.stringify(selector)}).value`), value);
  }
  async function shot(name) {
    await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    if (!win.webContents.debugger.isAttached()) win.webContents.debugger.attach('1.3');
    const capture = await win.webContents.debugger.sendCommand('Page.captureScreenshot', { format: 'png' });
    const bytes = Buffer.from(capture.data, 'base64'), bitmap = electron.nativeImage.createFromBuffer(bytes).toBitmap();
    let visible = 0;
    for (let i = 0; i < bitmap.length; i += 4) if (bitmap[i] < 245 || bitmap[i + 1] < 245 || bitmap[i + 2] < 245) visible++;
    assert.ok(visible > 1000, 'Exported screenshot must contain rendered account controls');
    const target = path.join(out, name + '.png'); fs.writeFileSync(target, bytes); report.screenshots.push(target);
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
    await click('[data-auth-mode="emailCode"]'); await fill('#soduWorkAuthAccount', account);
    await until('!document.querySelector("[data-send-code]").disabled', 70000);
    await click('[data-send-code]'); await until('!!lastChallenge');
    await fill('#acEmailCode', await deliveredCode(await js('lastChallenge'))); await click('.soduwork-auth-submit');
    await until('ClientAuth.snapshot().user?.id === ' + JSON.stringify(id));
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
      server = spawn(python, ['-B', path.join(__dirname, 'fixtures/account_hub_fixture.py'), '--root', temp], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8' } });
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
    const fixture = path.join(temp, 'fixture.html');
    fs.writeFileSync(fixture, '<!doctype html><html><head><meta charset="utf-8"><base href="' + pathToFileURL(client + path.sep).href + '">' + ['theme/variables.css', 'components/client-auth/client-auth.css', 'components/client-auth/account-center.css'].map(p => '<link rel="stylesheet" href="' + p + '">').join('') + '</head><body><script>window.errors=[];window.lastChallenge=null;window.lastSensitiveChallenge=null;window.SoduWorkI18n={translateText:String,t:(_key,fallback)=>fallback};addEventListener("error",e=>errors.push(e.message));addEventListener("unhandledrejection",e=>errors.push(String(e.reason)));</script>' + files.map(p => '<script src="' + p + '"></script>').join('') + '<script>const realAction=SoduWorkAPI.clientAccountAction.bind(SoduWorkAPI);SoduWorkAPI.clientAccountAction=async(...args)=>{const result=await realAction(...args);if(args[0]==="emailChallenge"&&result.ok)lastChallenge=result.challengeId;return result;};const realRequest=SoduWorkAPI.clientAccountRequest.bind(SoduWorkAPI);SoduWorkAPI.clientAccountRequest=async(...args)=>{const result=await realRequest(...args);if(args[0]==="challenge")lastSensitiveChallenge=result.challengeId;return result;};</script></body></html>');
    win = new BrowserWindow({ show: false, width: 1100, height: 860, webPreferences: { preload, contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } });
    win.webContents.on('console-message', (_event, details) => { if (details?.level === 'error') process.stderr.write('Renderer: ' + details.message + '\n'); });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (request, cb) => { const allowed = request.url.startsWith(connection.hub + '/'); if (!allowed) report.errors.push('Blocked nonfixture request'); else report.requests.push({ method: request.method, path: new URL(request.url).pathname }); cb({ cancel: !allowed }); });
    await win.loadFile(fixture);
    process.stdout.write('Fixture document loaded\n');
    await until('ClientAuth.snapshot().policy?.mailReady===true && !document.querySelector(".soduwork-auth-submit").disabled');

    const oldEmail = 'email-change-old@example.test', newEmail = 'email-change-new@example.test', password = 'Original-password-2026';
    await click('[data-auth-mode="register"]'); await fill('#soduWorkAuthAccount', oldEmail); await click('[data-send-code]');
    await until('!!lastChallenge'); await fill('#acEmailCode', await deliveredCode(await js('lastChallenge')));
    await fill('#soduWorkAuthPassword', password); await fill('#acConfirmPassword', password); await click('#acConsent'); await click('.soduwork-auth-submit');
    await until('ClientAuth.snapshot().user?.email === ' + JSON.stringify(oldEmail));
    const userId = await js('ClientAuth.snapshot().user.id');
    const avatar = execFileSync(python, ['-c',
      'from PIL import Image; import io,base64; image=Image.new("RGB",(16,16),(52,144,222)); out=io.BytesIO(); image.save(out,format="PNG"); print("data:image/png;base64,"+base64.b64encode(out.getvalue()).decode())'], { encoding: 'utf8', windowsHide: true }).trim();
    await js('SoduWorkAPI.clientAccountRequest("profile", ' + JSON.stringify({displayName:'邮箱迁移验证用户',avatarDataUrl:avatar}) + ')');
    const before = await js('SoduWorkAPI.clientAuthMe().then(r=>r.user)');
    assert.equal(before.displayName, '邮箱迁移验证用户');
    assert.match(before.avatarUrl, /^data:image\/(?:png|jpeg|webp);base64,/);
    const consents = await js('SoduWorkAPI.clientAccountRequest("privacy",{}).then(r=>r.consents)');
    assert.ok(consents.length >= 2); record('registration and saved personal profile belong to the original account');
    await js('AccountCenter.open("security");void 0;'); await until('!!document.querySelector("[data-email-change]")');
    await click('[data-email-change]'); await until('!!document.querySelector(".ac-email-change")');
    await fill('.ac-email-change [name="email"]', newEmail); await click('.ac-email-change [data-send]');
    await until('!!lastSensitiveChallenge');
    const newMailboxChallenge = await js('lastSensitiveChallenge');
    await fill('.ac-email-change [name="code"]', await deliveredCode(newMailboxChallenge)); await shot('change-email-new-mailbox');
    const probes = await fixtureRequest('POST', 'account/' + userId + '/session-probes');
    const oldSession = require('../main/device-auth').session(app);
    await click('.ac-email-change [type="submit"]'); await until('!!document.querySelector(".ac-verify")');
    await click('.ac-verify [data-proof-mode="code"]'); await click('.ac-verify [data-proof-send]');
    await until('!!lastSensitiveChallenge && lastSensitiveChallenge !== ' + JSON.stringify(newMailboxChallenge));
    const currentCode = await deliveredCode(await js('lastSensitiveChallenge'));
    await fill('.ac-verify [name="code"]', currentCode === '000000' ? '000001' : '000000'); await click('.ac-verify [type="submit"]');
    await until('!!document.querySelector(".ac-verify .ac-status").textContent && !document.querySelector(".ac-verify [type=submit]").disabled');
    assert.equal(await js('SoduWorkAPI.clientAuthMe().then(r=>r.user.email)'), oldEmail);
    assert.equal(await js('ClientAuth.snapshot().user.id'), userId); record('incorrect current-mailbox proof preserves the original email and active account');
    await fill('.ac-verify [name="code"]', currentCode); await shot('change-email-current-mailbox-proof');
    const replaced = armReload(); await click('.ac-verify [type="submit"]'); await replaced; await loginReady();
    assert.equal(require('../main/device-auth').session(app), ''); assert.equal(await js('ClientAuth.snapshot().user'), null);
    await assertSessionRevoked(oldSession); await assertSessionRevoked(probes.deviceSession); await assertSessionRevoked(probes.bearer, 'Bearer');
    record('successful email replacement clears local secure session and revokes current, secondary and bearer sessions');
    await fill('#soduWorkAuthAccount', oldEmail); await fill('#soduWorkAuthPassword', password); await click('.soduwork-auth-submit');
    await until('document.querySelector(".soduwork-auth-status").classList.contains("is-error") && !document.querySelector(".soduwork-auth-submit").disabled');
    assert.equal(await js('SoduWorkAPI.clientAuthSnapshot().user'), null); record('the old mailbox and existing password cannot log into the former account');
    await click('[data-auth-mode="emailCode"]'); await fill('#soduWorkAuthAccount', oldEmail); await js('lastChallenge=null;void 0;');
    const mailBeforeOldAddress = await fixtureRequest('GET', 'mail-counts'); await click('[data-send-code]');
    await until("document.querySelector('.soduwork-auth-status').textContent.includes('原密码') && !document.querySelector('[data-send-code]').disabled");
    assert.equal(await js('lastChallenge'), null);
    assert.equal(await js("document.querySelector('#soduWorkAuthAccount').value"), oldEmail);
    assert.deepEqual(await fixtureRequest('GET', 'mail-counts'), mailBeforeOldAddress);
    assert.equal(await js('SoduWorkAPI.clientAuthSnapshot().user'), null);
    record('the old mailbox requests no login code and cannot recover the former account after email replacement');
    assert.equal(await js("document.querySelector('.ac-auth-tabs').hidden"), false);
    await js('lastChallenge=null;void 0;'); await codeLogin(newEmail, userId);
    const after = await js('SoduWorkAPI.clientAuthMe().then(r=>r.user)');
    for (const field of ['id','username','displayName','orgId','roleId','isActive','hasPassword','avatarUrl']) assert.deepEqual(after[field], before[field], 'Retain account field ' + field);
    assert.equal(after.email, newEmail); assert.equal(after.emailVerified, true);
    assert.deepEqual(await js('SoduWorkAPI.clientAccountRequest("privacy",{}).then(r=>r.consents)'), consents);
    record('new-mailbox code logs into the same user with unchanged profile, organization, role and consent records');
    await logout(); await passwordLogin(newEmail, password, userId);
    assert.equal(await js('SoduWorkAPI.clientAuthMe().then(r=>r.user.email)'), newEmail); record('new mailbox and the unchanged password log into the same account');
    const reloaded = armReload(); await js('location.reload();void 0;'); await reloaded;
    await until('ClientAuth.snapshot().user?.id === ' + JSON.stringify(userId));
    await js('AccountCenter.open("security");void 0;'); await until('!!document.querySelector("[data-email-change]")');
    assert.match(await js('document.querySelector(".ac-center-content").innerText'), /email-change-new@example\.test/);
    await shot('change-email-profile-after-login-and-reload'); record('renderer reload restores the same account and displays only its new login mailbox');
    assert.equal(report.requests.filter(row => row.path.endsWith('/me/email-change')).length, 1);
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
