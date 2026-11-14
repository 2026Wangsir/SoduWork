'use strict';

// Real Electron preload, production parser IPC, api.js and safeStorage. The Hub
// identity and OpenAI-compatible provider are isolated loopback fixtures.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'CHROME_CRASHPAD_PIPE_NAME',
    'CHROME_CRASHPAD_PIPE_HANDLE', 'ELECTRON_NO_ATTACH_CONSOLE']) delete env[key];
  const result = require('node:child_process').spawnSync(electron,
    [__filename, ...process.argv.slice(2), '--no-sandbox', '--disable-gpu'],
    { env, stdio: 'inherit', timeout: 90000 });
  process.exit(result.status ?? 1);
}

const { app, BrowserWindow, ipcMain, safeStorage, net } = electron;
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const http = require('node:http'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const output = process.argv[2];
assert.ok(output && path.isAbsolute(output), 'Absolute evidence directory required');
fs.mkdirSync(output, { recursive: true });
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-local-parser-e2e-')));
const client = path.resolve(__dirname, '..'), profile = path.join(root, 'profile');
fs.mkdirSync(profile);
app.setAppPath(client); app.setPath('userData', profile); app.disableHardwareAcceleration();
if (process.platform === 'darwin') app.commandLine.appendSwitch('use-mock-keychain');
app.on('window-all-closed', () => {});
const report = { ok: false, cases: [], boundary: 'Real Electron process, production preload, parser IPC, api.js, model resolver and safeStorage. macOS uses the Chromium test keychain. Authentication and non-streaming inference use synthetic TCP fixtures; the renderer is a minimal test page, not product-modal or production-model acceptance.' };
const hubRequests = [], providerRequests = [], fixtureErrors = [];
const privateKey = crypto.randomBytes(24).toString('hex');
let win, hubServer, providerServer, hub, providerUrl, responseMode = 'success', account = '';
const js = async code => {
  try { return await win.webContents.executeJavaScript(code, true); }
  catch (error) { throw Error(error.message + '\nRenderer expression: ' + code); }
};
const mark = name => { report.cases.push(name); console.log('[local-requirement-parse] PASS ' + name); };
const reply = (response, body, status = 200) => {
  response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body));
};
async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return 'http://127.0.0.1:' + server.address().port;
}
function session(device) {
  const now = Math.floor(Date.now() / 1000);
  return { authState: 'active', activationRequired: false, expiresIn: 3600,
    session: Buffer.from(JSON.stringify({ typ: 'device', uid: account, cid: device, iat: now - 1,
      exp: now + 3600 })).toString('base64url') + '.' + 'a'.repeat(64), user: { id: account, name: account } };
}
async function parse(model, kind = 'requirement') {
  return js(`SoduWorkAPI.parseTaskText('Keep every original requirement.',${JSON.stringify(model)},[],{kind:${JSON.stringify(kind)}})`);
}

app.whenReady().then(async () => {
  assert.equal(safeStorage.isEncryptionAvailable(), true);
  if (process.platform === 'linux') assert.notEqual(safeStorage.getSelectedStorageBackend(), 'basic_text');
  providerServer = http.createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    try {
      const body = JSON.parse(raw);
      assert.equal(request.url, '/private-parser/v1/chat/completions');
      assert.equal(body.stream, false); assert.equal(Array.isArray(body.messages), true);
      assert.equal(body.messages[0].role, 'system'); assert.equal(body.messages[1].role, 'user');
      assert.equal(Object.hasOwn(body, 'tools'), false);
      assert.ok(['private-parser-wire', 'private-parser-keyed-wire'].includes(body.model));
      assert.equal(request.headers.authorization, body.model === 'private-parser-wire' ? undefined : 'Bearer ' + privateKey);
      providerRequests.push({ model: body.model, mode: responseMode });
      if (responseMode === 'timeout') return;
      if (responseMode === 'error') return reply(response, { error: {
        message: 'private-parser-wire ' + privateKey + ' ' + providerUrl } }, 503);
      const text = responseMode === 'invalid' ? '{"unexpected":"not a requirement"}' : JSON.stringify({
        title: 'Local parsed draft', note: body.messages[1].content, checklist: ['Keep local constraints'],
        priority: 'normal', kind: 'requirement', due: '', tags: ['local'] });
      return reply(response, { choices: [{ message: { content: text },
        finish_reason: responseMode === 'truncated' ? 'length' : 'stop' }],
        usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } });
    } catch (error) { fixtureErrors.push(error.message); reply(response, { error: 'Provider fixture failed' }, 500); }
  });
  providerUrl = await listen(providerServer) + '/private-parser/v1';
  hubServer = http.createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const route = new URL(request.url, hub).pathname, body = raw ? JSON.parse(raw) : {};
    hubRequests.push({ route, body: raw });
    if (route === '/api/v1/clients/enroll') return reply(response, account ? session(body.device)
      : { authState: 'pending', activationRequired: true, expiresIn: 0 });
    if (route === '/api/v1/client-auth/login') { account = body.account; return reply(response, session(body.device)); }
    if (route === '/api/v1/client-auth/authorize-ai') return reply(response, {
      detail: { code: 'TOKEN_QUOTA_EXCEEDED', message: 'Synthetic platform allowance exhausted' } }, 403);
    return reply(response, { ok: true, items: [], hasMore: false, cursor: 0 });
  });
  hubServer.on('upgrade', (_request, socket) => socket.destroy());
  hub = await listen(hubServer);
  require('../main/hub-endpoint.cjs').initialize(app, { SODUWORK_TEST_HUB_URL: hub, SODUWORK_USER_DATA: profile });
  const auth = require('../main/device-auth'); auth.install({ app, ipcMain, safeStorage });
  const identityOf = () => auth.authenticatedIdentity(app, hub);
  const store = require('../main/local-model-store.cjs'); store.configure({ app, safeStorage });
  const catalog = store.save({ providers: [
    { id: 'private-parser', baseUrl: providerUrl, authMode: 'none' },
    { id: 'private-keyed', baseUrl: providerUrl, authMode: 'key' }],
  models: [{ providerId: 'private-parser', name: 'private-parser-wire' },
    { providerId: 'private-keyed', name: 'private-parser-keyed-wire' }], keys: { 'private-keyed': privateKey } });
  const [localRef, keyedRef] = catalog.myModels.map(row => row.id);
  require('../main/pi-session/ipc').install({ app, ipcMain, BrowserWindow, identityOf, sendIdentityOf: identityOf,
    capabilityGrantsOf: () => [], authorizeAI: require('../main/conversation/quota-admission.cjs').create({ app, identityOf }) });
  win = new BrowserWindow({ show: false, webPreferences: { preload: path.join(client, 'preload.js'),
    sandbox: true, contextIsolation: true, nodeIntegration: false, partition: 'private-parser-' + crypto.randomUUID() } });
  win.webContents.on('console-message', event => {
    if (event.level === 'error') console.error('[parser-renderer]', event.message);
  });
  win.webContents.on('preload-error', (_event, _file, error) => console.error('[parser-preload]', error.message));
  const desk = pathToFileURL(path.join(client, 'desk.html')).href;
  win.webContents.session.protocol.handle('file', request => request.url === desk
    ? new Response('<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; connect-src \'none\'; object-src \'none\'"><title>Private requirement parser</title><script src="core/api-work-plugins.js"></script><script src="api.js"></script>',
      { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
    : net.fetch(request.url, { bypassCustomProtocolHandlers: true }));
  await win.loadURL(desk);
  assert.equal(await js('typeof soduWorkAPI.conversationSession.localRequirementParse'), 'function');
  const denied = await parse(localRef);
  assert.match(denied._parseError, /登录.*原文已保留/); assert.equal(providerRequests.length, 0);
  mark('Production preload and parser IPC retain the account login gate');
  assert.equal((await auth.login(app, { hub, account: 'synthetic-parser-owner', password: 'synthetic-password',
    workRoot: root, name: 'Private parser E2E', platform: process.platform })).ok, true);
  for (const kind of ['requirement', 'automation']) {
    const result = await parse(localRef, kind);
    assert.equal(result.title, 'Local parsed draft', JSON.stringify(result));
    assert.match(result.note, /Keep every original requirement/);
    assert.deepEqual(result.checklist, ['Keep local constraints']);
    mark('Production api.js ' + kind + ' parsing reaches the keyless private provider through real IPC');
  }
  assert.equal((await parse(keyedRef)).title, 'Local parsed draft');
  mark('Key-authenticated private parsing sends the credential only to its configured provider');
  responseMode = 'truncated';
  assert.match((await parse(localRef))._parseError, /长度上限.*原文已保留/);
  responseMode = 'invalid';
  assert.match((await parse(localRef))._parseError, /格式无效.*原文已保留/);
  responseMode = 'error';
  const failed = await parse(localRef);
  assert.match(failed._parseError, /本地模型服务返回错误.*原文已保留/);
  for (const privateValue of [privateKey, providerUrl, 'private-parser-wire']) assert.equal(JSON.stringify(failed).includes(privateValue), false);
  mark('Truncated, malformed and provider-error responses remain explicit without exposing private diagnostics');
  responseMode = 'timeout';
  const timed = await js(`soduWorkAPI.conversationSession.localRequirementParse({model:${JSON.stringify(localRef)},
    input:'Original requirement',instructions:'Only JSON',requestId:'private-parser-timeout',timeoutMs:1000})`);
  assert.equal(timed.code, 'APP_AI_RESULT_UNKNOWN'); assert.equal(timed.uncertain, true);
  mark('Real IPC timeout aborts private inference without retrying or fabricating a draft');
  const beforeDelete = providerRequests.length;
  store.save({ models: [] });
  assert.match((await parse(localRef))._parseError, /本地文字模型已删除.*原文已保留/);
  assert.equal(providerRequests.length, beforeDelete);
  mark('A deleted private selection fails before transport and never falls back to a Hub model');
  for (const privateValue of [privateKey, providerUrl, localRef, keyedRef, 'private-parser-wire', 'private-parser-keyed-wire'])
    assert.equal(JSON.stringify(hubRequests).includes(privateValue), false, 'Hub received private model metadata');
  assert.equal(hubRequests.some(row => /\/tasks\/parse|\/authorize-ai|\/ai-proxy|\/usage\/events/.test(row.route)), false);
  assert.deepEqual(fixtureErrors, []);
  mark('No parsing, model configuration, platform-quota or usage request reaches Hub');
  report.providerRequests = providerRequests.length; report.hubRoutes = hubRequests.map(row => row.route);
  report.ok = true;
}).catch(error => { report.error = String(error.stack || error); console.error(report.error); })
  .finally(() => {
    fs.writeFileSync(path.join(output, 'local-requirement-parse.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    win?.destroy();
    for (const server of [hubServer, providerServer]) { server?.closeAllConnections(); server?.close(); }
    fs.rmSync(root, { recursive: true, force: true });
    app.exit(report.ok ? 0 : 1);
  });
