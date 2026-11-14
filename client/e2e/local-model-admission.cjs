'use strict';

// Real Electron renderer IPC, device-auth, conversation guards, utilityProcess
// and Pi SDK. Authentication responses, quota and inference are loopback fixtures.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env, PI_TELEMETRY: '0' };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'CHROME_CRASHPAD_PIPE_NAME',
    'CHROME_CRASHPAD_PIPE_HANDLE', 'ELECTRON_NO_ATTACH_CONSOLE']) delete env[key];
  const args = [__filename, '--no-sandbox', '--disable-gpu'];
  if (process.platform === 'linux' && !env.DISPLAY) args.push('--ozone-platform=headless');
  const result = require('node:child_process').spawnSync(electron, args, { env, stdio: 'inherit', timeout: 180000 });
  process.exit(result.status ?? 1);
}

const { app, BrowserWindow, ipcMain, safeStorage, net } = electron;
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const http = require('node:http'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const client = path.resolve(__dirname, '..');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-local-admission-e2e-')));
const profile = path.join(root, 'profile'), cwd = path.join(root, 'workspace');
fs.mkdirSync(profile); fs.mkdirSync(cwd);
app.setAppPath(client); app.setPath('userData', profile); app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const report = { ok: false, cases: [], boundary: 'Real Electron renderer IPC, production device-auth login/session state, ownership guards, queue admission, utilityProcess and Pi SDK. Hub authentication/quota and model responses are synthetic TCP fixtures; no production account, paid model or product DOM acceptance.' };
const providerKey = require('node:crypto').randomBytes(24).toString('hex');
const wireModel = 'private-admission-wire-model';
const hubRequests = [], providerRequests = [], errors = [];
let hubServer, providerServer, win, bridge, hub, providerUrl, localRef, imageRef, account = '';
let quotaRequests = 0, managedRequests = 0, imageRequests = 0;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await read(); if (value) return value; await pause(30); }
  throw Error('Timed out: ' + label);
}
async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return 'http://127.0.0.1:' + server.address().port;
}
function reply(res, body, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body));
}
function session(device) {
  const now = Math.floor(Date.now() / 1000);
  const claims = { typ: 'device', uid: account, cid: device, iat: now - 1, exp: now + 3600 };
  return { authState: 'active', activationRequired: false,
    session: Buffer.from(JSON.stringify(claims)).toString('base64url') + '.' + 'a'.repeat(64),
    expiresIn: 3600, user: { id: account, name: account } };
}
function mark(value) { report.cases.push(value); console.log('[local-model-admission] PASS ' + value); }
const js = code => win.webContents.executeJavaScript(code, true);
const invoke = (channel, ...args) => js('admission.invoke(' + [channel, ...args].map(value => JSON.stringify(value)).join(',') + ')');

app.whenReady().then(async () => {
  assert.equal(safeStorage.isEncryptionAvailable(), true);
  if (process.platform === 'linux') assert.notEqual(safeStorage.getSelectedStorageBackend(), 'basic_text');
  providerServer = http.createServer((req, res) => {
    let raw = ''; req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      try {
        if (req.url === '/private-admission/v1/images/generations') {
          const body = JSON.parse(raw);
          assert.equal(body.model, 'private-image-wire');
          assert.equal(req.headers.authorization, 'Bearer ' + providerKey);
          imageRequests++;
          return reply(res, { data: [{ b64_json: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z8WQAAAAASUVORK5CYII=' }] });
        }
        assert.equal(req.url, '/private-admission/v1/chat/completions');
        const body = JSON.parse(raw);
        assert.equal(body.model, wireModel);
        assert.equal(req.headers.authorization, 'Bearer ' + providerKey);
        providerRequests.push({ model: body.model });
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        for (const [delta, finish, usage] of [
          [{ role: 'assistant', content: 'Local admission confirmed.' }, null],
          [{}, 'stop', { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 }],
        ]) res.write('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: wireModel,
          choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) }) + '\n\n');
        res.end('data: [DONE]\n\n');
      } catch (error) { errors.push(error.message); reply(res, { error: 'Provider fixture assertion failed' }, 500); }
    });
  });
  providerUrl = await listen(providerServer) + '/private-admission/v1';
  hubServer = http.createServer((req, res) => {
    let raw = ''; req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      try {
        const route = new URL(req.url, hub).pathname, body = raw ? JSON.parse(raw) : {};
        hubRequests.push({ route: req.url, body: raw, headers: req.headers });
        if (route === '/api/v1/clients/enroll') return reply(res, account ? session(body.device)
          : { authState: 'pending', activationRequired: true, expiresIn: 0 });
        if (route === '/api/v1/client-auth/login') { account = body.account; return reply(res, session(body.device)); }
        if (route === '/api/v1/client-auth/logout') { account = ''; return reply(res, { ok: true }); }
        if (route === '/api/v1/client-auth/authorize-ai') {
          quotaRequests++;
          return reply(res, { detail: { code: 'TOKEN_QUOTA_EXCEEDED', message: 'Synthetic account quota exhausted',
            quota: { enabled: true, exceeded: true, limit: 0, remaining: 0 } } }, 403);
        }
        if (route === '/api/v1/ai-proxy/config') return reply(res, { ok: true, model: 'managed-admission',
          key: 'synthetic-managed-ticket', label: 'Managed admission fixture', contextWindow: 32000,
          maxOutputTokens: 256, expiresIn: 3600, path: '/api/v1/ai-proxy/v1' });
        if (route === '/api/v1/ai-proxy/v1/chat/completions') {
          managedRequests++; return reply(res, { error: 'Managed inference must be rejected before transport' }, 500);
        }
        if (route === '/api/v1/account-conversations/sync') return reply(res, { ok: true,
          conversationId: 'directory-' + body.sourceSessionId, sourceRevision: body.sourceRevision });
        if (route === '/api/v1/usage/events') return reply(res, { ok: true });
        return reply(res, { ok: true, items: [], hasMore: false, cursor: 0 });
      } catch (error) { errors.push(error.message); reply(res, { error: 'Hub fixture assertion failed' }, 500); }
    });
  });
  hubServer.on('upgrade', (_req, socket) => socket.destroy());
  hub = await listen(hubServer);
  require('../main/hub-endpoint.cjs').initialize(app, { SODUWORK_TEST_HUB_URL: hub, SODUWORK_USER_DATA: profile });
  const auth = require('../main/device-auth');
  auth.install({ app, ipcMain, safeStorage });
  const identityOf = () => auth.authenticatedIdentity(app, hub);
  const store = require('../main/local-model-store.cjs');
  store.configure({ app, safeStorage });
  require('../main/local-agent-model-ipc.cjs').install({ app, ipcMain, safeStorage,
    scopeOf: () => {
      const id = auth.identity(app), owner = auth.localOwner(app);
      return id && owner ? { hub: id.hub, clientId: id.clientId, owner } : null;
    } });
  const catalog = store.save({ providers: [{ id: 'private-admission', name: 'Private admission provider', baseUrl: providerUrl }],
    models: [{ providerId: 'private-admission', name: wireModel },
      { providerId: 'private-admission', name: 'private-image-wire', modality: 'image' }], keys: { 'private-admission': providerKey } });
  localRef = catalog.myModels[0].id; imageRef = catalog.myModels[1].id;
  const agentDir = path.join(profile, 'pi-agent'); fs.mkdirSync(agentDir);
  fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({
    compaction: { enabled: false }, retry: { enabled: false }, enableInstallTelemetry: false,
  }));
  bridge = require('../main/pi-session/ipc').install({ app, ipcMain, BrowserWindow, identityOf,
    sendIdentityOf: identityOf, capabilityGrantsOf: () => [],
    authorizeAI: require('../main/conversation/quota-admission.cjs').create({ app, identityOf }) });
  const preload = path.join(root, 'preload.cjs');
  fs.writeFileSync(preload, "const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('admission',{invoke:(...args)=>ipcRenderer.invoke(...args),event:fn=>ipcRenderer.on('pi-session-event',(_event,value)=>fn(value))});");
  win = new BrowserWindow({ show: false, webPreferences: { preload, sandbox: true,
    contextIsolation: true, nodeIntegration: false, partition: 'local-admission-' + crypto.randomUUID() } });
  const desk = pathToFileURL(path.join(client, 'desk.html')).href;
  win.webContents.session.protocol.handle('file', request => request.url === desk
    ? new Response('<!doctype html><title>Local model admission fixture</title><script>window.admissionEvents=[];admission.event(value=>admissionEvents.push(value));window.ready=true;</script>',
      { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
    : net.fetch(request.url, { bypassCustomProtocolHandlers: true }));
  await win.loadURL(desk); await until(() => js('window.ready'), 'isolated renderer');
  const openOptions = { adapterId: 'pi', modelName: localRef, capabilities: [], skills: [], cwd, mode: 'readonly' };
  const denied = await invoke('pi-session-open', openOptions);
  assert.equal(denied.ok, false, 'local models do not remove the client login requirement');
  assert.equal(providerRequests.length, 0);
  mark('Logged-out production open IPC rejects local execution before provider transport');

  async function login(name) {
    const value = await auth.login(app, { hub, account: name, password: 'synthetic-login-only',
      workRoot: cwd, name: 'Local admission E2E', platform: process.platform });
    assert.equal(value.ok, true, value.error);
    assert.ok((await identityOf()).session);
  }
  await login('synthetic-owner-a');
  const defaults = await invoke('local-agent-models-get');
  assert.equal((await invoke('local-agent-models-set', { agentId: 'pi', modelName: localRef,
    scopeKey: defaults.scopeKey, expectedRevision: defaults.revision })).ok, true);
  const opened = await invoke('pi-session-open', { ...openOptions, modelName: '' });
  assert.equal(opened.ok, true, opened.reason);
  const native = require('../main/agent-runtime/pi-session-bridge').get(opened.ref);
  assert.ok(native);
  assert.equal(native.snapshot().modelSelection.name, localRef);
  mark('A real Electron IPC default resolves through the runtime host to the exact device-owned model');
  assert.notEqual(require('../main/agent-runtime/process-session').diagnostics(app).pid, process.pid);
  const first = await invoke('pi-session-send', opened.ref, 'Confirm local inference.', [], { submissionId: 'local-admission-turn' });
  assert.equal(first.ok, true, first.reason);
  await until(() => providerRequests.length === 1 && !native.inFlight(), 'local inference completion');
  assert.match(JSON.stringify(native.snapshot().messages), /Local admission confirmed/);
  const archivedSelections = fs.readFileSync(native.resumeLocation(), 'utf8').split('\n').filter(Boolean)
    .map(line => JSON.parse(line)).filter(row => row.type === 'custom' && row.customType === 'soduwork.model.selection');
  assert.equal(archivedSelections.at(-1)?.data?.name, localRef, 'The inherited default must be durably pinned to this conversation');
  assert.equal(quotaRequests, 0, 'ordinary local calls never query the Hub quota authorizer');
  await bridge.sync();
  assert.ok(hubRequests.some(row => row.route === '/api/v1/account-conversations/sync'));
  assert.equal(hubRequests.some(row => row.route.startsWith('/api/v1/ai-proxy/config')), false);
  mark('Signed-in production send reaches the local provider despite zero Hub allowance and retains directory sync');

  const selected = await invoke('pi-session-select-model', opened.ref, 'managed-admission');
  assert.equal(selected.ok, true, selected.reason);
  const next = await invoke('pi-session-send', opened.ref, 'Managed inference must be blocked.', [], { submissionId: 'managed-denied-turn' });
  assert.equal(next.ok, true, next.reason);
  await until(() => quotaRequests > 0 && !native.inFlight(), 'managed quota denial');
  await until(() => js('admissionEvents.some(row=>row.kind==="error" && row.submissionId==="managed-denied-turn")'), 'production error publication');
  assert.equal(managedRequests, 0); assert.equal(providerRequests.length, 1);
  mark('Same-conversation managed turn hits production quota admission and HTTP 403 prevents inference');

  const quotaBeforeImage = quotaRequests;
  const imageChoice = 'image::device:private-admission::' + imageRef;
  assert.equal((await invoke('pi-session-select-model', opened.ref, imageChoice)).ok, true);
  const readOnlyImage = await invoke('pi-session-send', opened.ref, 'A read-only session must not write an image.', [], { submissionId: 'readonly-image-turn' });
  assert.equal(readOnlyImage.ok, true, readOnlyImage.reason);
  await until(() => js('admissionEvents.some(row=>row.kind==="error" && row.submissionId==="readonly-image-turn" && /只读/.test(row.reason))'), 'read-only image denial');
  assert.equal(imageRequests, 0);
  mark('Local image selection retains the production read-only write restriction');
  const imageOpened = await invoke('pi-session-open', { ...openOptions, modelName: imageChoice, accessMode: 'standard' });
  assert.equal(imageOpened.ok, true, imageOpened.reason);
  const imageNative = require('../main/agent-runtime/pi-session-bridge').get(imageOpened.ref);
  const generated = await invoke('pi-session-send', imageOpened.ref, 'Generate a fixture image.', [], { submissionId: 'local-image-turn' });
  assert.equal(generated.ok, true, generated.reason);
  try { await until(() => imageRequests === 1 && !imageNative.inFlight(), 'local image completion'); }
  catch (error) {
    report.imageFailure = { imageRequests, providerErrors: errors,
      events: await js('admissionEvents.filter(row=>row.kind==="error").map(row=>({kind:row.kind,reason:row.reason,submissionId:row.submissionId}))'),
      selection: imageNative.snapshot().modelSelection, inFlight: imageNative.inFlight() };
    throw error;
  }
  assert.equal(quotaRequests, quotaBeforeImage);
  assert.ok(fs.readdirSync(path.join(cwd, 'outputs')).some(name => /^image-.*\.png$/.test(name)));
  await bridge.sync();
  mark('Production local image turn reaches only its provider, writes a local artifact and bypasses Hub quota');

  assert.equal((await invoke('pi-session-select-model', opened.ref, localRef)).ok, true);
  store.save({ models: [] });
  const gone = await invoke('local-agent-models-get', { agentId: 'pi' });
  assert.equal(gone.modelName, localRef); assert.equal(gone.unavailable, true);
  const blockedDefault = await invoke('pi-session-open', { ...openOptions, modelName: '' });
  assert.equal(blockedDefault.ok, false);
  assert.match(blockedDefault.reason, /原本地默认模型已删除或不可用/);
  assert.equal(providerRequests.length, 1);
  mark('Deleting a saved Agent default blocks a new session without choosing a Hub model');
  await login('synthetic-owner-b');
  const otherDefaults = await invoke('local-agent-models-get');
  assert.deepEqual(otherDefaults.models, {});
  mark('A second authenticated account cannot inherit the first account local Agent default');
  const wrongOwner = await invoke('pi-session-send', opened.ref, 'Do not reuse another account session.', [], {});
  assert.equal(wrongOwner.ok, false);
  assert.equal(providerRequests.length, 1); assert.equal(managedRequests, 0);
  mark('Production account switch rejects the previous account conversation reference');
  const signedOut = await auth.logout(app); assert.equal(signedOut.ok, true);
  assert.equal((await invoke('pi-session-open', openOptions)).ok, false);
  assert.equal(providerRequests.length, 1);
  mark('Explicit logout retains the local execution login gate');

  for (const value of [wireModel, 'private-image-wire', providerKey, providerUrl, localRef, imageRef])
    assert.equal(JSON.stringify(hubRequests).includes(value), false, 'Hub request leaked private model metadata');
  assert.equal(hubRequests.some(row => row.route === '/api/v1/usage/events'), false, 'local inference has no Hub usage event');
  assert.deepEqual(errors, []);
  report.providerRequests = providerRequests.length; report.imageRequests = imageRequests; report.quotaRequests = quotaRequests;
  report.managedRequests = managedRequests; report.ok = true;
}).catch(error => { report.error = String(error.stack || error); }).finally(async () => {
  try {
    app.emit('before-quit');
    await bridge?.dispose();
    await require('../main/agent-runtime/pi-session-bridge').dispose();
    await require('../main/agent-runtime/process-session').dispose();
  } catch (error) { report.ok = false; report.cleanupError = error.message; }
  win?.destroy();
  for (const server of [providerServer, hubServer]) if (server) {
    const closed = new Promise(resolve => server.close(resolve)); server.closeAllConnections(); await closed;
  }
  console.log(JSON.stringify(report, null, 2));
  fs.rmSync(root, { recursive: true, force: true });
  app.exit(report.ok ? 0 : 1);
});
