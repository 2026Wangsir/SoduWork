'use strict';
// Run: SODUWORK_TEST_PYTHON=<isolated venv python> node e2e/quota-recovery.cjs
// Complete desktop main.js/desk.html -> Pi -> real TCP Hub and SQLite.
// The provider's semantic outputs are fixtures; no paid model or user profile is used.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const electron = require('electron');
const client = path.resolve(__dirname, '..');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await read(); if (value) return value; await delay(50); }
  throw Error('Timed out: ' + label);
}
async function json(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(15000) });
  const body = await response.json();
  return { status: response.status, body };
}
function stop(process) {
  if (!process || process.exitCode !== null || process.signalCode !== null) return;
  if (global.process.platform === 'win32') execFileSync('taskkill.exe', ['/PID', String(process.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  else process.kill('SIGKILL');
}
async function portClosed(url) {
  const net = require('node:net'), target = new URL(url);
  return new Promise(resolve => {
    const socket = net.connect({ host: target.hostname, port: Number(target.port) });
    socket.once('connect', () => { socket.destroy(); resolve(false); });
    socket.once('error', () => { socket.destroy(); resolve(true); });
    socket.setTimeout(500, () => { socket.destroy(); resolve(false); });
  });
}

if (typeof electron === 'string') {
  (async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-personal-quota-'));
    const log = fs.openSync(path.join(root, 'hub.log'), 'w');
    const python = process.env.SODUWORK_TEST_PYTHON || 'python';
    const hub = spawn(python, ['-B', path.join(client, '../hub-backend/tests/personal_model_quota_hub.py'), '--root', root],
      { cwd: root, windowsHide: true, stdio: ['pipe', log, log], env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    let native, nativeLog, ready, report = { ok: false, root, cases: [] };
    try {
      await until(() => {
        if (hub.exitCode !== null) throw Error('Hub fixture exited: ' + hub.exitCode);
        return fs.existsSync(path.join(root, 'ready.json'));
      }, 'isolated Hub readiness', 45000);
      ready = JSON.parse(fs.readFileSync(path.join(root, 'ready.json'), 'utf8'));
      const env = { ...process.env, SODUWORK_USER_DATA: path.join(root, 'profile'), SODUWORK_TEST_HUB_URL: ready.hub };
      for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE',
        'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
      nativeLog = fs.openSync(path.join(root, 'electron.log'), 'w');
      native = spawn(electron, [__filename, root], { cwd: client, windowsHide: true, env, stdio: ['ignore', nativeLog, nativeLog] });
      await until(() => native.exitCode !== null || native.signalCode !== null, 'Electron E2E completion', 300000);
      report = JSON.parse(fs.readFileSync(path.join(root, 'electron-report.json'), 'utf8'));
      assert.equal(native.exitCode, 0, report.error || 'Electron failed');
      assert.equal(report.ok, true, report.error);
    } catch (error) { report.ok = false; report.error = String(error.stack || error); }
    finally {
      try { stop(native); } catch (error) { report.ok = false; report.cleanupError = String(error); }
      if (nativeLog !== undefined) fs.closeSync(nativeLog);
      if (ready && hub.exitCode === null) {
        try { await json(ready.hub + '/__fixture__/shutdown', { method: 'POST', headers: { 'x-fixture-key': ready.controlKey } }); } catch {}
      }
      hub.stdin.end();
      try { await until(() => hub.exitCode !== null || hub.signalCode !== null, 'Hub shutdown', 10000); }
      catch (error) { stop(hub); report.ok = false; report.cleanupError = String(error); }
      fs.closeSync(log);
      report.cleanup = { hubExit: hub.exitCode, electronExit: native?.exitCode,
        hubPortClosed: ready ? await portClosed(ready.hub) : true,
        providerPortClosed: ready ? await portClosed(ready.provider) : true };
      const aliveOwned = () => (report.ownedElectronPids || []).filter(pid => {
        try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
      });
      try { await until(() => aliveOwned().length === 0, 'owned Electron processes exit', 10000); }
      catch (error) { report.ok = false; report.cleanupError = String(error); }
      report.cleanup.remainingOwnedElectronPids = aliveOwned();
      if (hub.exitCode !== 0 || !report.cleanup.hubPortClosed || !report.cleanup.providerPortClosed) report.ok = false;
      const hubLog = fs.readFileSync(path.join(root, 'hub.log'), 'utf8');
      if (/Traceback \(most recent call last\)|ERROR:.*Exception in ASGI/.test(hubLog)) {
        report.ok = false; report.hubError = 'Uncaught Hub error; inspect hub.log';
      }
      fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
      console.log(JSON.stringify({ ok: report.ok, cases: report.cases?.length || 0, root, error: report.error, cleanup: report.cleanup }));
      process.exitCode = report.ok ? 0 : 1;
    }
  })().catch(error => { console.error(error.stack); process.exitCode = 1; });
} else {
  const { app, BrowserWindow, webContents } = electron;
  const root = path.resolve(process.argv[2]);
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('soduwork-personal-quota-'));
  // The test artifact directory is not an application file-open argument.
  process.argv = process.argv.slice(0, 2);
  const ready = JSON.parse(fs.readFileSync(path.join(root, 'ready.json'), 'utf8'));
  const profile = path.join(root, 'profile'), workspace = path.join(root, 'workspace');
  assert.equal(path.resolve(process.env.SODUWORK_USER_DATA), profile);
  assert.equal(process.env.SODUWORK_TEST_HUB_URL, ready.hub);
  fs.mkdirSync(profile, { recursive: true }); fs.mkdirSync(workspace);
  // Isolate startup preferences and suppress OS login-item registration.
  fs.writeFileSync(path.join(profile, 'autostart-initialized'), '1');
  fs.writeFileSync(path.join(profile, 'desk-flags.json'), JSON.stringify({ pet: false, dock: false, tray: false }));
  app.disableHardwareAcceleration(); app.setAppPath(client);
  const report = { ok: false, cases: [], errors: [], boundary: 'Complete production desktop main.js and desk.html, native mouse/keyboard, real Hub HTTP/auth/admin quota, Pi process/SDK and SQLite; controlled model output, no production account.' };
  report.source = Object.fromEntries(['main.js', 'api.js', 'preload.js', 'main/conversation/quota-admission.cjs',
    'e2e/quota-recovery.cjs', '../hub-backend/tests/personal_model_quota_hub.py'].map(file => [file,
      require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(client, file))).digest('hex')]));
  let content, win, identity;
  const mark = name => { report.cases.push(name); console.log('PASS ' + name); };
  const control = (route = '/state', body) => json(ready.hub + '/__fixture__' + route, {
    method: body === undefined ? 'GET' : 'POST', headers: { 'x-fixture-key': ready.controlKey, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const quota = async limit => {
    const response = await json(ready.hub + '/api/v1/admin/users/' + ready.userId, {
      method: 'PATCH', headers: { Authorization: 'Bearer ' + ready.adminToken, 'content-type': 'application/json' },
      body: JSON.stringify({ tokenQuota: { mode: 'limited', limit } }) });
    assert.equal(response.status, 200);
  };
  const js = code => content.executeJavaScript(code, true);
  const visibleCard = () => js('!!document.querySelector("#cpChat .soduwork-quota-card:not([hidden])")');
  async function click(selector) {
    await content.capturePage();
    const point = await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing target: '+${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect(),x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2);if(!e.contains(document.elementFromPoint(x,y)))throw Error('Occluded target: '+${JSON.stringify(selector)});return{x,y}})()`);
    for (const type of ['mouseDown', 'mouseUp']) content.sendInputEvent({ type, ...point, button: 'left', clickCount: 1 });
    await delay(80);
  }
  async function send(text) {
    await click('#nchatInput');
    content.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: ['control'] });
    content.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: ['control'] });
    await content.insertText(text);
    await click('#nchatSend');
  }
  const snapshot = async () => {
    const info = await js('NativeChat.sessionInfo()');
    const handle = require('../main/agent-runtime/pi-session-bridge').findBySessionId(info.sessionId);
    return handle?.snapshot();
  };
  async function idle() {
    return until(async () => {
      const value = await snapshot();
      return value?.status === 'idle' && !await js('NativeChat.isBusy()') ? value : false;
    }, 'completed real Pi turn', 60000);
  }
  app.on('web-contents-created', (_event, page) => {
    page.on('console-message', (_event, level, message) => {
      if (level >= 3 && /ReferenceError|TypeError|SyntaxError|uncaught/i.test(message)) report.errors.push(String(message).slice(0, 300));
    });
  });
  require('../main.js');
  app.whenReady().then(async () => {
    const auth = require('../main/device-auth');
    await until(() => auth.identity(app, ready.hub), 'desktop device enrollment');
    content = await until(() => webContents.getAllWebContents().find(page => page.getURL().includes('/desk.html')), 'complete desktop');
    // Login after the ordinary first-run enrollment finishes, as the visible
    // login form does. The credential file exists before that HTTP call ends.
    await until(async () => { try { return await js('window.SoduWorkAPI?.clientAuthSnapshot().state === "pending"'); } catch { return false; } }, 'first-run login form');
    const enrolled = auth.identity(app, ready.hub);
    const logged = await auth.login(app, { hub: ready.hub, clientId: enrolled.clientId,
      account: ready.account, password: ready.password, name: 'Quota recovery E2E', workRoot: workspace });
    assert.equal(logged.ok, true, logged.error);
    identity = await auth.authenticatedIdentity(app, ready.hub, enrolled.clientId);
    const deviceHeaders = { Authorization: 'Device ' + identity.session, 'content-type': 'application/json' };
    const catalog = (await json(ready.hub + '/api/v1/my-models', { headers: deviceHeaders })).body;
    const saved = await json(ready.hub + '/api/v1/my-models', { method: 'PUT', headers: deviceHeaders,
      body: JSON.stringify({ expectedRevision: catalog.revision,
        providers: [{ id: 'custom-quota-personal', name: 'Personal fixture', kind: 'openai-compat', personal: true, baseUrl: ready.provider + '/v1' }],
        keys: { 'custom-quota-personal': ready.personalKey },
        models: [{ providerId: 'custom-quota-personal', name: 'personal-model', label: 'Personal fixture model' }] }) });
    assert.equal(saved.status, 200);
    await quota(10000);
    content.reload();
    await until(async () => { try { return await js('!!window.ClientAuth?.snapshot().user && !!window.NativeChat'); } catch { return false; } }, 'authenticated desktop');
    win = BrowserWindow.fromWebContents(content); win.setBounds({ x: 60, y: 60, width: 1200, height: 850 }); win.show(); win.focus();
    await js('SoduWorkI18n.setLocale("zh-CN"); WorkspaceHost.open("create")');
    assert.equal(await js('NativeChat.enter("",null,' + JSON.stringify({ adapterId: 'pi', modelName: 'platform-model', cwd: workspace, accessMode: 'standard' }) + ')'), true);
    await js('openChatPanel()');
    await send('quota fixture draft');
    await until(() => fs.existsSync(path.join(workspace, 'plugin-draft.txt')), 'actual draft write');
    await idle();
    const original = await js('NativeChat.sessionInfo()'); report.sessionId = original.sessionId;
    await until(async () => (await control()).body.quota.used >= 56, 'usage persisted');
    let state = (await control()).body;
    await quota(state.quota.used);
    const before = state.providerRequests.length;
    await send('quota fixture blocked');
    await until(visibleCard, 'quota card from actual denied turn');
    await delay(500);
    const denied = await snapshot();
    report.afterDenial = { session: await js('NativeChat.sessionInfo()'), busy: await js('NativeChat.isBusy()'),
      status: denied?.status, queue: denied?.execution?.turnQueue,
      runtime: require('../main/agent-runtime/process-session').diagnostics(app) };
    state = (await control()).body;
    assert.equal(state.providerRequests.length, before);
    assert.equal(await js('document.body.classList.contains("soduwork-client-auth-open")'), false);
    const oldQuota = state.quota;
    mark('Exhaustion denies the next turn, keeps the old conversation and saved draft, and does not call the provider');
    await quota(10000);
    await control('/provider', { hold: true });
    await send('quota fixture continue');
    await until(async () => (await control()).body.providerRequests.length > before, 'restored turn reaches real provider');
    report.duringRecovery = { cardVisible: await visibleCard(), quota: (await control()).body.quota,
      session: await js('NativeChat.sessionInfo()'), busy: await js('NativeChat.isBusy()') };
    assert.equal(report.duringRecovery.quota.exceeded, false);
    assert.equal(report.duringRecovery.session.sessionId, original.sessionId);
    await delay(700);
    fs.writeFileSync(path.join(root, 'recovery-running.png'), (await content.capturePage()).toPNG());
    assert.equal(await visibleCard(), false, 'B20: restored platform turn is running but the old exhausted quota card remains visible');
    mark('Administrator quota restoration clears the old warning while the same conversation is still generating');
    await js('window.quotaRecoveryShown=0;window.quotaRecoveryObserver=new MutationObserver(()=>{if(document.querySelector("#cpChat .soduwork-quota-card:not([hidden])"))quotaRecoveryShown++});quotaRecoveryObserver.observe(document.querySelector("#cpChat"),{attributes:true,subtree:true,attributeFilter:["hidden"]})');
    const readsBeforeLate = (await control()).body.http.filter(row => row.path === '/api/v1/client-auth/me').length;
    content.send('device-auth-quota-exceeded', { hub: ready.hub, clientId: identity.clientId, quota: oldQuota });
    await until(async () => (await control()).body.http.filter(row => row.path === '/api/v1/client-auth/me').length > readsBeforeLate, 'late notice reconciled');
    await delay(150);
    assert.equal(await visibleCard(), false, 'A late quota event must not reinstate an obsolete block');
    assert.equal(await js('quotaRecoveryObserver.disconnect();quotaRecoveryShown'), 0, 'A late notice must not flash an obsolete quota block');
    mark('A delayed old quota notification is reconciled against current Hub allowance');
    await control('/provider', { hold: false });
    await until(() => fs.existsSync(path.join(workspace, 'index.html')), 'continued actual file creation');
    await idle();
    assert.match(fs.readFileSync(path.join(workspace, 'plugin-draft.txt'), 'utf8'), /QUOTA_DRAFT_MARKER/);
    assert.match(fs.readFileSync(path.join(workspace, 'index.html'), 'utf8'), /PERSONAL_CONTINUATION_MARKER/);
    assert.equal((await js('NativeChat.sessionInfo()')).sessionId, original.sessionId);
    mark('The existing conversation finishes with its earlier history and generated files retained');
    await until(async () => (await control()).body.quota.used >= 140, 'restored platform usage persisted');
    state = (await control()).body;
    await quota(state.quota.used);
    const exhaustedUsage = state.quota.used, beforePersonal = state.providerRequests.length;
    await send('quota fixture second block');
    await until(visibleCard, 'platform blocked again');
    await delay(300);
    assert.equal((await control()).body.providerRequests.length, beforePersonal);
    await click('#cpChat .nmodel-button');
    await until(() => js('!!document.querySelector(\'[data-model-name="personal-model"]\')'), 'personal picker option');
    await click('[data-model-name="personal-model"]');
    await until(() => js('NativeChat.sessionInfo().model === "personal-model"'), 'actual personal model selection');
    assert.equal(await visibleCard(), false);
    assert.equal(await js('SoduWorkAPI.clientAuthSnapshot().quota.exceeded'), true, 'selecting personal must not restore platform budget');
    await send('quota fixture resume');
    await until(async () => (await control()).body.providerRequests.length > beforePersonal, 'personal continuation reaches provider');
    await idle();
    await until(async () => (await control()).body.daily.some(row => row.model === 'personal-model' && row.scope === 'personal'), 'personal accounting persisted');
    state = (await control()).body;
    assert.equal(state.quota.used, exhaustedUsage);
    assert.equal(state.quota.exceeded, true);
    assert.equal(state.providerRequests.at(-1).keyKind, 'personal');
    assert.equal((await js('NativeChat.sessionInfo()')).sessionId, original.sessionId);
    assert.match(await js('document.querySelector("#cpChat").innerText'), /RESUMED_CONTEXT_COMPLETE/);
    fs.writeFileSync(path.join(root, 'personal-continuation.png'), (await content.capturePage()).toPNG());
    mark('Complete desktop switches exhausted platform chat to a personal model and continues the same history without charging platform tokens');
    await quota(0);
    const protectedCount = state.providerRequests.length;
    await send('quota fixture paused');
    await until(visibleCard, 'explicit administrator pause');
    assert.match(await js('document.querySelector("#cpChat .soduwork-quota-card").innerText'), /暂停/);
    assert.equal((await control()).body.providerRequests.length, protectedCount);
    mark('Explicit administrator zero pause still blocks the personal model');
    await quota(10000);
    await control('/account', { active: false });
    const deniedIdentity = await js('SoduWorkAPI.clientAuthMe().then(()=>({ok:true}),e=>({ok:false,status:e.status}))');
    assert.equal(deniedIdentity.ok, false);
    assert.equal(deniedIdentity.status, 403);
    const deniedCalls = (await control()).body.http.filter(row => row.path.endsWith('/authorize-ai') && row.status === 403).length;
    await send('quota fixture disabled');
    await until(async () => (await control()).body.http.filter(row => row.path.endsWith('/authorize-ai') && row.status === 403).length > deniedCalls,
      'disabled account admission refused');
    assert.equal((await control()).body.providerRequests.length, protectedCount);
    mark('Disabled account remains blocked by real Hub admission with no provider request');
    await control('/account', { active: true });
    await js('SoduWorkAPI.clientLogout().catch(()=>null)');
    await until(async () => { try { return await js('SoduWorkAPI.clientAuthSnapshot().state === "pending"'); } catch { return false; } }, 'explicit logout');
    const revoked = await json(ready.hub + '/api/v1/client-auth/me', { headers: deviceHeaders });
    assert.equal(revoked.status, 403, 'logged-out device binding is inactive');
    const invalid = await json(ready.hub + '/api/v1/client-auth/me', { headers: { Authorization: 'Device invalid-session' } });
    assert.equal(invalid.status, 401);
    const oldRef = original.ref;
    const deniedSend = await js('soduWorkAPI.conversationSession.send(' + JSON.stringify(oldRef) + ',"must not run",[],{})');
    assert.equal(deniedSend.ok, false);
    assert.equal((await control()).body.providerRequests.length, protectedCount);
    mark('Explicit logout blocks the old conversation and old device binding; invalid tokens still return 401');
    assert.deepEqual(report.errors, []);
    report.ok = true;
  }).catch(async error => {
    report.error = String(error.stack || error);
    if (content && !content.isDestroyed()) {
      fs.writeFileSync(path.join(root, 'failure.png'), (await content.capturePage()).toPNG());
      report.visibleText = await js('document.body.innerText.slice(-6000)').catch(() => '');
      report.failureState = (await control()).body;
      report.failureRuntime = require('../main/agent-runtime/process-session').diagnostics(app);
      report.failureSession = await js('NativeChat.sessionInfo()').catch(() => null);
    }
  }).finally(async () => {
    try { await control('/provider', { hold: false }); } catch {}
    try {
      report.ownedElectronPids = app.getAppMetrics().map(row => row.pid);
      const diagnostics = require('../main/agent-runtime/process-session').diagnostics(app);
      if (diagnostics?.pid) report.ownedElectronPids.push(diagnostics.pid);
      await require('../main/agent-runtime/process-session').dispose();
    } catch (error) { report.ok = false; report.cleanupError = String(error.stack || error); }
    fs.writeFileSync(path.join(root, 'electron-report.json'), JSON.stringify(report, null, 2));
    app.exit(report.ok ? 0 : 1);
  });
}
