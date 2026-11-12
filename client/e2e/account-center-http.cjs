'use strict';
// Actual Chromium UI -> renderer API -> isolated Electron device credential IPC
// -> loopback FastAPI/SQLite -> actual TLS SMTP and account deletion worker.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const child = require('node:child_process').spawn(electron, [__filename, ...process.argv.slice(2)], { env, windowsHide: true, stdio: 'inherit' });
  const timer = setTimeout(() => child.kill(), 180000);
  child.on('exit', code => { clearTimeout(timer); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, ipcMain, safeStorage } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const { spawn } = require('node:child_process'), { pathToFileURL } = require('node:url'), assert = require('node:assert/strict');
  const sourceManifest = require('./fixtures/account-source-manifest.cjs');
  const client = path.resolve(__dirname, '..'), repo = path.dirname(client);
  const python = process.env.SODUWORK_TEST_PYTHON || path.join(repo, 'hub-backend/.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-account-http-'));
  const profile = path.join(temp, 'profile'); fs.mkdirSync(profile); app.setPath('userData', profile); app.disableHardwareAcceleration();
  const out = path.join(repo, 'outputs/account-center-20261023/client-http-e2e'); fs.mkdirSync(out, { recursive: true });
  const report = { ok: false, cases: [], errors: [], boundary: 'Actual Chromium inputs, api.js, Electron main/device-auth with OS safeStorage, isolated FastAPI/SQLite, local TLS SMTP delivery and account deletion. No production account, mail relay, business service or model.' };
  report.sourcesAtStart = sourceManifest.snapshot();
  let win, server, serverErrors = '', connection;
  const record = name => { report.cases.push({ name, ok: true }); process.stdout.write('PASS ' + name + '\n'); };
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function js(code) { try { return await win.webContents.executeJavaScript(code, true); } catch (error) { process.stderr.write('Renderer action: '+code.slice(0,260)+'\n'); throw error; } }
  async function until(expression, ms = 15000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) { if (await js(expression)) return; await delay(60); }
    throw Error('Wait: ' + expression + '\n' + await js('document.body.innerText'));
  }
  async function click(selector) {
    await js(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'})`); await delay(30);
    const point = await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect();if(e.disabled)throw Error('Disabled '+${JSON.stringify(selector)});return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
    for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, ...point, button: 'left', clickCount: 1 });
    await delay(40);
  }
  async function fill(selector, value) {
    await click(selector);
    assert.equal(await js(`document.activeElement===document.querySelector(${JSON.stringify(selector)})`), true, 'Typing must target the selected input');
    if (!win.webContents.debugger.isAttached()) win.webContents.debugger.attach('1.3');
    // Use the native editing command so hidden fixtures select reliably on every platform.
    win.webContents.selectAll();
    await win.webContents.debugger.sendCommand('Input.insertText', { text: value }); await delay(25);
    assert.equal(await js(`document.querySelector(${JSON.stringify(selector)}).value`), value, 'Typing must replace the selected input without corrupting Unicode');
  }
  async function fixtureRequest(method, route) {
    const response = await fetch(connection.hub + '/__fixture__/' + route, { method, headers: { 'X-Fixture-Key': connection.key } });
    assert.equal(response.status, 200, 'Isolated fixture control request must succeed');
    return response.json();
  }
  async function initializeRenderer() {
    await js(`(async()=>{window.errors=[];window.successes=[];window.gate=document.querySelector('#soduWorkClientAuthGate');window.lastChallenge=null;window.challengeRequests=[];
      addEventListener('error',e=>errors.push(e.message));addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));
      window.policy=await SoduWorkAPI.clientAuthPolicy();window.ClientAuth={updateIdentity:()=>{},changePassword:()=>{},logout:()=>SoduWorkAPI.clientLogout()};
      const realAction=SoduWorkAPI.clientAccountAction.bind(SoduWorkAPI);SoduWorkAPI.clientAccountAction=async(...args)=>{if(args[0]==='emailChallenge')challengeRequests.push({...args[1]});const result=await realAction(...args);if(args[0]==='emailChallenge'&&result.ok)lastChallenge=result.challengeId;return result;};
      document.documentElement.style.setProperty('--accent','#7955b8');})()`);
  }
  async function mount(mode) {
    await js(`window.view?.dispose();document.querySelectorAll('.ac-mask').forEach(e=>e.remove());gate.hidden=false;document.documentElement.classList.add('soduwork-auth-pending');successes.length=0;lastChallenge=null;
      window.view=EmailAuth.mount(gate,{api:()=>SoduWorkAPI,retry:()=>{},success:r=>{successes.push(r);gate.hidden=true;document.documentElement.classList.remove('soduwork-auth-pending')}});view.setPolicy(policy);void 0;`);
    if (mode) await click('[data-auth-mode="' + mode + '"]');
  }
  async function codeForChallenge() {
    await until('!!lastChallenge'); const id = await js('lastChallenge'); const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const response = await fetch(connection.hub + '/__fixture__/mail/' + encodeURIComponent(id), { headers: { 'X-Fixture-Key': connection.key } });
      const result = await response.json(); if (result.ready) { assert.equal(result.smtpDelivered, true); return result.code; }
      await delay(100);
    }
    throw Error('Local SMTP delivery did not complete: ' + serverErrors.slice(-1800));
  }
  app.whenReady().then(async () => {
    const ready = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(Error('Fixture startup timeout: ' + serverErrors)), 25000);
      server = spawn(python, ['-B', path.join(__dirname, 'fixtures/account_hub_fixture.py'), '--root', temp], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8' } });
      let stdout = ''; server.stdout.on('data', chunk => { stdout += chunk; const match = stdout.match(/ACCOUNT_FIXTURE_READY (\{[^\n]+\})/); if (match) { clearTimeout(timeout); resolve(JSON.parse(match[1])); } });
      server.stderr.on('data', chunk => { serverErrors += chunk; });
      server.on('error', error => { clearTimeout(timeout); reject(error); });
      server.on('exit', code => { if (code && !report.ok) { clearTimeout(timeout); reject(Error('Fixture exit ' + code + ': ' + serverErrors)); } });
    });
    const readyInfo = await ready; connection = { hub: 'http://127.0.0.1:' + readyInfo.port, key: readyInfo.key };
    const endpoint = require('../main/hub-endpoint.cjs'); endpoint.initialize(app, { SODUWORK_TEST_HUB_URL: connection.hub, SODUWORK_USER_DATA: profile });
    require('../main/device-auth.js').install({ app, ipcMain, safeStorage });
    ipcMain.handle('fixture-connection', () => endpoint.current(app));
    const preload = path.join(temp, 'preload.cjs');
    fs.writeFileSync(preload, `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('soduWorkAPI',{
      getHubConnection:()=>ipcRenderer.invoke('fixture-connection'),deviceAuthLogin:r=>ipcRenderer.invoke('device-auth-login',r),
      deviceAccountAction:r=>ipcRenderer.invoke('device-account-action',r),deviceAuthBootstrap:r=>ipcRenderer.invoke('device-auth-bootstrap',r),
      deviceAuthLogout:r=>ipcRenderer.invoke('device-auth-logout',r),deviceAuthClearSession:r=>ipcRenderer.invoke('device-auth-clear-session',r),
      refreshAccountProfile:()=>ipcRenderer.invoke('account-profile-refresh'),deviceAuthStatus:()=>ipcRenderer.invoke('device-auth-status'),
      getAppVersion:async()=> 'e2e',getSysInfo:async()=>({username:'fixture',hostname:'isolated',platform:'win32'}),configureRunner:async()=>({ok:true})});`);
    const files = ['core/api-work-plugins.js', 'api.js', 'components/client-auth/account-ui.js', 'components/client-auth/email-auth.js', 'components/client-auth/account-verification.js', 'components/client-auth/account-center.js'];
    const fixture = path.join(temp, 'fixture.html');
    fs.writeFileSync(fixture, '<!doctype html><html><head><meta charset="utf-8"><base href="' + pathToFileURL(client + path.sep).href + '">' + ['theme/variables.css', 'components/client-auth/client-auth.css', 'components/client-auth/account-center.css'].map(p => '<link rel="stylesheet" href="' + p + '">').join('') + '</head><body><div id="soduWorkClientAuthGate" class="soduwork-auth-gate"></div>' + files.map(p => '<script src="' + p + '"></script>').join('') + '</body></html>');
    win = new BrowserWindow({ show: false, width: 1100, height: 860, webPreferences: { preload, contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } });
    win.webContents.on('console-message', (_event, level, message) => { if (level === 3) process.stderr.write('Renderer: ' + message + '\n'); });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (request, cb) => { const allowed = request.url.startsWith(connection.hub + '/'); if (!allowed) report.errors.push('Blocked nonfixture request ' + request.url); cb({ cancel: !allowed }); });
    await win.loadFile(fixture);
    await initializeRenderer();
    assert.equal(await js('policy.mailReady'), true); record('live policy has actual configured local SMTP and legal documents');
    await mount('emailCode');
    const emptyMail = await fixtureRequest('GET', 'mail-counts');
    await fill('#soduWorkAuthAccount', 'not-an-email'); await click('[data-send-code]');
    assert.equal(await js('challengeRequests.length'), 0);
    assert.match(await js("document.querySelector('.soduwork-auth-status').textContent"), /有效的邮箱/);
    assert.equal(await js("document.querySelector('.ac-auth-tabs').hidden"), false);
    assert.deepEqual(await fixtureRequest('GET', 'mail-counts'), emptyMail);
    record('invalid email is rejected before requesting a code or changing the login mode');
    await fill('#soduWorkAuthAccount', 'invalid..address@example.test'); await click('[data-send-code]');
    await until("document.querySelector('.soduwork-auth-status').classList.contains('is-error') && !document.querySelector('[data-send-code]').disabled");
    assert.equal(await js('challengeRequests.length'), 1);
    assert.equal(await js("document.querySelector('.ac-auth-tabs').hidden"), false);
    assert.deepEqual(await fixtureRequest('GET', 'mail-counts'), emptyMail);
    record('server email validation rejects malformed local parts without a challenge or queued mail');
    await fill('#soduWorkAuthAccount', 'account-http@example.test');
    const unknownLoginRequestedAt = Date.now(); await click('[data-send-code]');
    await until("document.querySelector('h1').textContent==='创建你的账号' && !document.querySelector('[data-send-code]').disabled");
    assert.equal(await js("document.querySelector('#soduWorkAuthAccount').value"), 'account-http@example.test');
    assert.equal(await js('lastChallenge'), null);
    assert.equal(await js('challengeRequests.length'), 2, 'Navigation must not request a registration code automatically');
    assert.equal(await js("document.querySelector('#acEmailCode').value"), '');
    assert.equal(await js("document.querySelector('#acConsent').checked"), false);
    assert.equal(await js("document.querySelector('[data-auth-consent]').hidden"), false);
    assert.deepEqual(await fixtureRequest('GET', 'mail-counts'), emptyMail);
    record('unknown login email opens explicit registration with the same email and no code, consent or mail side effects');
    await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    report.registrationScreenshot = path.join(out, 'unregistered-email-registration.png');
    fs.writeFileSync(report.registrationScreenshot, (await win.webContents.capturePage()).toPNG());
    await click('[data-send-code]');
    assert.equal(await js('challengeRequests.at(-1).purpose'), 'register');
    await until("document.querySelector('.soduwork-auth-status').textContent.includes('邮件服务已发送验证码')");
    assert.doesNotMatch(await js("document.querySelector('.soduwork-auth-status').textContent"), /已送达|已入收件箱/);
    record('registration delivery feedback follows device-authenticated status after local SMTP sending');
    await fill('#acEmailCode', await codeForChallenge()); record('registration code delivered by actual TLS SMTP');
    const password = 'Fixture-password-2026'; await fill('#soduWorkAuthPassword', password); await fill('#acConfirmPassword', password); await click('#acConsent'); await click('[type="submit"]');
    await until('successes.length===1');
    const registered = await js('SoduWorkAPI.clientAuthMe().then(r=>r.user)'); assert.equal(registered.isActive, true); assert.equal(registered.orgId, 'fixture-default-org'); assert.equal(registered.emailVerified, true); record('explicit registration immediately active in configured default organization');
    assert.equal(await js('typeof soduWorkAPI.deviceKey'), 'undefined'); record('renderer never receives long-lived device key');
    await js('SoduWorkAPI.clientLogout().then(()=>{})'); await mount('password'); await fill('#soduWorkAuthAccount', 'legacy.email@example.test'); await fill('#soduWorkAuthPassword', 'Legacy-password-2026'); await click('[type="submit"]'); await until('successes.length===1');
    const legacy = await js('SoduWorkAPI.clientAuthMe().then(r=>r.user)');
    assert.equal(legacy.id, 'fixture-legacy-email-user'); assert.equal(legacy.emailVerified, false); record('email-shaped legacy username still logs in using its original password');
    await js('SoduWorkAPI.clientLogout().then(()=>{})'); await mount('emailCode'); await fill('#soduWorkAuthAccount', 'legacy.email@example.test');
    const mailBeforeLegacy = await fixtureRequest('GET', 'mail-counts'); await click('[data-send-code]');
    await until("document.querySelector('.soduwork-auth-status').textContent.includes('原密码') && !document.querySelector('[data-send-code]').disabled");
    assert.equal(await js('lastChallenge'), null);
    assert.deepEqual(await fixtureRequest('GET', 'mail-counts'), mailBeforeLegacy);
    assert.equal(await js('successes.length'), 0); assert.equal(await js('SoduWorkAPI.clientAuthSnapshot().user'), null);
    assert.equal(await js("document.querySelector('.ac-auth-tabs').hidden"), false);
    record('unverified legacy username cannot request a login code or enter registration in place of password authentication');
    await js('SoduWorkAPI.clientLogout().then(()=>{})'); await mount('password'); await fill('#soduWorkAuthAccount', 'account-http@example.test'); await fill('#soduWorkAuthPassword', password); await click('[type="submit"]'); await until('successes.length===1');
    assert.equal(await js('successes[0].user.id'), registered.id); record('password login returns the registered account');
    // The registration lookup consumes the shared login request budget even without sending mail.
    await delay(Math.max(0, unknownLoginRequestedAt + (await js('policy.codeRetryAfter')) * 1000 + 1000 - Date.now()));
    await js('SoduWorkAPI.clientLogout().then(()=>{})'); await mount('emailCode'); await fill('#soduWorkAuthAccount', 'account-http@example.test'); await click('[data-send-code]'); await fill('#acEmailCode', await codeForChallenge()); await click('[type="submit"]'); await until('successes.length===1');
    assert.equal(await js('successes[0].user.id'), registered.id); record('email-code login returns same account through actual mailbox delivery');
    await js('AccountCenter.open();void 0;'); await js('AccountCenter.openProfileEditor();void 0;');
    await fill('.ac-profile-editor [name="displayName"]', '邮箱集成用户'); await click('.ac-profile-editor [type="submit"]');
    await until("!document.querySelector('.ac-profile-editor') && SoduWorkAPI.clientAuthMe().then(r=>r.user.displayName==='邮箱集成用户')");
    assert.equal(await js('SoduWorkAPI.clientAuthMe().then(r=>r.user.displayName)'), '邮箱集成用户'); record('profile nickname persisted and read back from actual Hub');
    const deviceFixture = await fixtureRequest('POST', 'account/' + registered.id + '/devices');
    const deviceSelector = id => '[data-device-id="' + id + '"]';
    await click('[data-tab="devices"]'); await until("document.querySelectorAll('.ac-device-list .ac-setting-row').length===2");
    assert.match(await js("document.querySelector('.ac-device-list').innerText"), /当前设备/);
    assert.equal(await js(`document.querySelector(${JSON.stringify(deviceSelector(deviceFixture.currentId))}).querySelectorAll('button').length`), 0);
    assert.equal(await js(`document.querySelector(${JSON.stringify(deviceSelector(deviceFixture.historyId))})`), null);
    record('actual Hub devices show the signed-in device without an action and retain the active-device list contract');
    await click(deviceSelector(deviceFixture.otherId) + ' [data-device-remove]');
    await fill('.ac-verify [name="password"]', 'wrong-password'); await click('.ac-verify [type="submit"]');
    await until("document.querySelector('.ac-verify .ac-status').textContent.includes('身份验证失败') && !document.querySelector('.ac-verify [type=submit]').disabled");
    assert.equal(await js("document.querySelectorAll('.ac-device-list .ac-setting-row').length"), 2);
    assert.equal((await fixtureRequest('GET', 'device/' + deviceFixture.otherId)).userRef, registered.id);
    assert.equal(await js('SoduWorkAPI.clientAuthMe().then(r=>r.user.id)'), registered.id);
    record('incorrect device deletion proof leaves its database association and current account unchanged');
    await fill('.ac-verify [name="password"]', password); await click('.ac-verify [type="submit"]');
    await until("document.querySelectorAll('.ac-device-list .ac-setting-row').length===1 && !document.querySelector('.ac-verify')");
    assert.equal(await js(`document.querySelector(${JSON.stringify(deviceSelector(deviceFixture.otherId))})`), null);
    assert.deepEqual(await fixtureRequest('GET', 'device/' + deviceFixture.otherId), { userRef: null, authState: 'pending', authVersion: 4 });
    assert.deepEqual(await fixtureRequest('GET', 'device/' + deviceFixture.currentId), { userRef: registered.id, authState: 'active', authVersion: deviceFixture.currentAuthVersion });
    assert.equal(await js('SoduWorkAPI.clientAuthMe().then(r=>r.user.id)'), registered.id);
    record('device deletion unlinks only the selected device, increments its credential version and keeps the current session active');
    const protectedDelete = await js(`(async()=>{const proof=await SoduWorkAPI.clientAccountRequest('verification',{purpose:'devices',password:${JSON.stringify(password)}});
      let currentDenial=null;try{await SoduWorkAPI.clientAccountRequest('revokeDevice',{deviceId:${JSON.stringify(deviceFixture.currentId)},verificationToken:proof.verificationToken});}catch(error){currentDenial={status:error.status,code:error.code};}
      const removed=await SoduWorkAPI.clientAccountRequest('revokeDevice',{deviceId:${JSON.stringify(deviceFixture.historyId)},verificationToken:proof.verificationToken});return {currentDenial,removed};})()`);
    assert.deepEqual(protectedDelete.currentDenial, { status: 409, code: 'CURRENT_DEVICE_REMOVAL_FORBIDDEN' });
    assert.equal(protectedDelete.removed.ok, true); assert.equal(protectedDelete.removed.logoutRequired, false);
    assert.deepEqual(await fixtureRequest('GET', 'device/' + deviceFixture.currentId), { userRef: registered.id, authState: 'active', authVersion: deviceFixture.currentAuthVersion });
    record('actual API refuses current-device removal without invalidating its session or consuming the proof');
    assert.deepEqual(await fixtureRequest('GET', 'device/' + deviceFixture.historyId), { userRef: null, authState: 'revoked', authVersion: 6 });
    record('actual API also removes an already-revoked historical association without reactivating it');
    const sessionBeforeReload = require('../main/device-auth').session(app);
    assert.ok(sessionBeforeReload); assert.deepEqual(await js('errors'), []);
    await new Promise(resolve => { win.webContents.once('did-finish-load', resolve); win.reload(); });
    await initializeRenderer();
    assert.equal(await js('SoduWorkAPI.clientAuthMe().then(r=>r.user.id)'), registered.id);
    await js("gate.hidden=true;AccountCenter.open('devices');void 0;");
    await until("document.querySelectorAll('.ac-device-list .ac-setting-row').length===1");
    assert.equal(await js(`document.querySelector(${JSON.stringify(deviceSelector(deviceFixture.otherId))})`), null);
    assert.equal(await js(`document.querySelector(${JSON.stringify(deviceSelector(deviceFixture.currentId))}).querySelectorAll('button').length`), 0);
    const reloadedDevices = await js("SoduWorkAPI.clientAccountRequest('devices',{}).then(r=>r.items)");
    assert.deepEqual(reloadedDevices.map(item => item.id), [deviceFixture.currentId]);
    assert.ok(require('../main/device-auth').session(app));
    record('full renderer reload restores the signed-in account and reads only the retained current device from SQLite');
    if (!win.webContents.debugger.isAttached()) win.webContents.debugger.attach('1.3');
    const devicesImage = await win.webContents.debugger.sendCommand('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(out, 'actual-hub-devices-after-delete.png'), Buffer.from(devicesImage.data, 'base64'));
    await click('[data-tab="privacy"]'); await until("!!document.querySelector('[data-delete]')");
    assert.equal(await js("document.querySelector('.ac-consent-records')"), null);
    assert.equal(await js("document.querySelector('[data-export]')"), null);
    assert.match(await js("document.querySelector('.ac-data-note').textContent"), /注销.*撤销登录/);
    assert.doesNotMatch(await js("document.querySelector('.ac-data-note').textContent"), /导出|24小时/);
    record('privacy page removes redundant consent/export blocks while retaining deletion scope');
    const image = await win.webContents.debugger.sendCommand('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, 'actual-hub-privacy.png'), Buffer.from(image.data, 'base64'));
    const oldSession = require('../main/device-auth').session(app);
    assert.ok(oldSession);
    // The post-deletion document runs the production ClientAuth boot path,
    // rather than manually remounting a login form after the reload.
    fs.writeFileSync(fixture, fs.readFileSync(fixture, 'utf8')
      .replace('<div id="soduWorkClientAuthGate" class="soduwork-auth-gate"></div>', '')
      .replace('</body>', '<script>window.errors=[];addEventListener("error",e=>errors.push(e.message));addEventListener("unhandledrejection",e=>errors.push(String(e.reason)));</script><script src="components/client-auth/client-auth.js"></script></body>'));
    await click('[data-delete]'); await fill('.ac-deletion input', '注销账号'); await click('.ac-deletion [type="submit"]');
    await fill('.ac-verify [name="password"]', 'wrong-password'); await click('.ac-verify [type="submit"]');
    await until("document.querySelector('.ac-verify .ac-status').textContent.includes('身份验证失败') && !document.querySelector('.ac-verify [type=submit]').disabled");
    assert.equal((await js('SoduWorkAPI.clientAuthMe().then(r=>r.user.id)')), registered.id);
    record('incorrect deletion proof leaves the account active and allows correction');
    await fill('.ac-verify [name="password"]', password);
    const navigated = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(Error('Deletion did not return to the login document')), 20000);
      win.webContents.once('did-finish-load', () => { clearTimeout(timeout); resolve(); });
    });
    await click('.ac-verify [type="submit"]'); await navigated;
    await until("ClientAuth.snapshot().policy?.mailReady === true && !!document.querySelector('#soduWorkAuthAccount')");
    assert.equal(require('../main/device-auth').session(app), '');
    assert.equal(await js('SoduWorkAPI.clientAuthSnapshot().user'), null);
    assert.equal(await js("document.querySelector('.soduwork-auth-gate').hidden"), false);
    assert.equal(await js("document.querySelector('.ac-account-label').textContent"), '账号');
    assert.equal(await js("document.querySelector('[data-auth-password]').hidden"), false);
    record('confirmed deletion clears encrypted-device session cache and production ClientAuth boot displays account/password login');
    const oldSessionResponse = await fetch(connection.hub + '/api/v1/client-auth/me', { headers: { Authorization: 'Device ' + oldSession } });
    assert.ok([401, 403].includes(oldSessionResponse.status)); record('deleted account session cannot read its profile again');
    await fill('#soduWorkAuthAccount', 'account-http@example.test'); await fill('#soduWorkAuthPassword', password); await click('[type="submit"]');
    await until("document.querySelector('.soduwork-auth-status').classList.contains('is-error') && !document.querySelector('[type=submit]').disabled");
    assert.equal(await js('ClientAuth.snapshot().user'), null); assert.equal(await js('SoduWorkAPI.clientAuthSnapshot().user'), null);
    record('deleted account cannot sign in again with its previous password');
    let deletedState;
    const deletionDeadline = Date.now() + 25000;
    do {
      const response = await fetch(connection.hub + '/__fixture__/account/' + registered.id, { headers: { 'X-Fixture-Key': connection.key } });
      assert.equal(response.status, 200); deletedState = await response.json();
      if (deletedState.deletionStatus === 'completed') break;
      await delay(150);
    } while (Date.now() < deletionDeadline);
    assert.equal(deletedState.active, false); assert.equal(deletedState.deleted, true);
    assert.equal(deletedState.emailCleared, true); assert.equal(deletedState.passwordCleared, true);
    assert.equal(deletedState.deletionStatus, 'completed'); record('privacy worker completes account cleanup and clears email and password material');
    const errors = await js('errors'); assert.deepEqual(errors, []); assert.deepEqual(report.errors, []); report.ok = true;
  }).catch(error => { report.error = String(error.stack || error); report.fixtureErrors = serverErrors.slice(-4000); process.stderr.write(report.error + '\n' + report.fixtureErrors + '\n'); }).finally(() => {
    report.sourcesAtEnd = sourceManifest.snapshot(); report.sourceChangesDuringRun = sourceManifest.changed(report.sourcesAtStart, report.sourcesAtEnd);
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); if (win && !win.isDestroyed()) win.destroy(); if (server) server.kill();
    process.stdout.write(JSON.stringify({ ok: report.ok, cases: report.cases.length, report: path.join(out, 'report.json') }) + '\n'); app.exit(report.ok ? 0 : 1);
  });
}
