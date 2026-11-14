'use strict';

// Real Electron safeStorage, utilityProcess and Pi SDK. Hub and inference are
// isolated loopback fixtures; no production account or paid model is used.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env, PI_TELEMETRY: '0' };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'CHROME_CRASHPAD_PIPE_NAME',
    'CHROME_CRASHPAD_PIPE_HANDLE', 'ELECTRON_NO_ATTACH_CONSOLE']) delete env[key];
  const args = [__filename, '--no-sandbox', '--disable-gpu'];
  if (process.platform === 'linux' && !env.DISPLAY) args.push('--ozone-platform=headless');
  const result = require('node:child_process').spawnSync(electron, args, {
    env, stdio: 'inherit', timeout: 180000,
  });
  process.exit(result.status ?? 1);
}
const { app, BrowserWindow, safeStorage } = electron;
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const http = require('node:http'), assert = require('node:assert/strict');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-private-model-e2e-')));
const profile = path.join(root, 'profile'), cwd = path.join(root, 'workspace');
fs.mkdirSync(profile); fs.mkdirSync(cwd);
app.setPath('userData', profile);
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const store = require('../main/local-model-store.cjs');
const report = { ok: false, platform: process.platform, cases: [], boundary: 'Real native Electron safeStorage, BrowserWindow, utilityProcess and Pi SDK. Synthetic authenticated identity, loopback Hub and provider; no production data or paid inference.' };
const privateModel = 'private-model-e2e-sentinel-739', privateLabel = 'Private label e2e sentinel 739';
const privateKey = require('node:crypto').randomBytes(24).toString('hex');
const providerId = 'private-e2e-sentinel';
const requests = [], hubRequests = [], serverErrors = [];
let runtime, bridge, handle, win, providerServer, hubServer, reporter, modelRef, providerUrl;
let mode = 'normal';
let expectedWireModel = privateModel;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(test, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await test()) return; await delay(30); }
  throw Error('Timed out: ' + label);
}
async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return 'http://127.0.0.1:' + server.address().port;
}
function stage(value) { console.log('[local-model-privacy] ' + value); report.stage = value; }
function assertHubBoundary() {
  for (const row of hubRequests) {
    assert.match(row.path, /^\/api\/v1\/conversations\/[^/]+\/media$/, 'Only ordinary media inventory may contact Hub');
    assert.equal(row.body, '');
    for (const value of [privateModel, privateLabel, privateKey, providerId, providerUrl, modelRef])
      assert.equal(JSON.stringify(row).includes(value), false);
    assert.doesNotMatch(JSON.stringify(row), /local:model-[a-f0-9]{32}/);
  }
}
function scan(file) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) { for (const name of fs.readdirSync(file)) scan(path.join(file, name)); return; }
  const data = fs.readFileSync(file);
  for (const sentinel of [privateModel, privateLabel, privateKey, providerId, providerUrl]) {
    assert.equal(data.includes(Buffer.from(sentinel)), false,
      'Private model metadata persisted in ' + path.relative(profile, file));
  }
}
async function turn(text) {
  const result = await handle.submit(text, [], { submissionId: require('node:crypto').randomUUID() });
  assert.equal(result.accepted, true, result.reason);
  const completed = await result.completion;
  await until(() => !handle.inFlight(), 'turn completion');
  return completed;
}
app.whenReady().then(async () => {
  stage('Prepare encrypted local catalog and strict loopback endpoints');
  assert.equal(safeStorage.isEncryptionAvailable(), true, 'Real OS encryption must be available');
  if (process.platform === 'linux') assert.notEqual(safeStorage.getSelectedStorageBackend(), 'basic_text');
  providerServer = http.createServer((req, res) => {
    let raw = '';
    req.on('data', part => { raw += part; });
    req.on('end', () => {
      try {
        assert.equal(req.url, '/private-endpoint-739/v1/chat/completions');
        const body = JSON.parse(raw);
        assert.equal(body.model, expectedWireModel, 'Provider receives the real model only on its private wire');
        assert.equal(req.headers.authorization, mode === 'no-key' ? undefined : 'Bearer ' + privateKey);
        assert.equal(req.headers['x-soduwork-secret'], undefined);
        requests.push({ model: body.model, mode });
        if (mode === 'error') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Rejected ' + privateModel + ' at ' + providerUrl + ' using ' + privateKey } }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const frame = (delta, finish_reason = null, usage) => res.write('data: ' + JSON.stringify({
          id: 'fixture', object: 'chat.completion.chunk', model: expectedWireModel,
          choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}),
        }) + '\n\n');
        frame({ role: 'assistant', content: 'Private inference completed.' });
        frame({}, 'stop', { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 });
        res.end('data: [DONE]\n\n');
      } catch (error) { serverErrors.push(error.message); res.writeHead(500); res.end(); }
    });
  });
  providerUrl = await listen(providerServer) + '/private-endpoint-739/v1';
  hubServer = http.createServer((req, res) => {
    let body = ''; req.on('data', part => { body += part; });
    req.on('end', () => { hubRequests.push({ path: req.url, body }); res.writeHead(403); res.end('{"detail":"blocked"}'); });
  });
  const hub = await listen(hubServer);
  const claims = { typ: 'device', uid: 'isolated-user', cid: 'isolated-device',
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 };
  const identity = { hub, clientId: claims.cid, secret: 'synthetic-device-secret',
    session: Buffer.from(JSON.stringify(claims)).toString('base64url') + '.' + 'a'.repeat(64) };
  store.configure({ app, safeStorage });
  const legacyRef = store.ref(providerId, privateModel);
  const legacyCatalog = { schema: 1, revision: 3,
    providers: [{ id: providerId, name: privateLabel, baseUrl: providerUrl }],
    models: [{ providerId, name: privateModel, label: privateLabel }], keys: { [providerId]: privateKey } };
  fs.writeFileSync(path.join(profile, 'local-models.secure.json'), JSON.stringify({ schema: 1,
    cipher: safeStorage.encryptString(JSON.stringify(legacyCatalog)).toString('base64') }), { mode: 0o600 });
  const saved = store.get();
  assert.equal(saved.revision, 4);
  modelRef = saved.myModels[0].id;
  assert.match(modelRef, /^local:model-[a-f0-9]{32}$/);
  const envelope = JSON.parse(fs.readFileSync(path.join(profile, 'local-models.secure.json')));
  assert.ok(safeStorage.decryptString(Buffer.from(envelope.cipher, 'base64')).includes(privateKey));
  const agentDir = path.join(profile, 'pi-agent'); fs.mkdirSync(agentDir);
  fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({ providers: { soduwork: {
    localOnly: true, localRef: legacyRef, baseUrl: providerUrl, apiKey: '$SODUWORK_PROXY_KEY',
    models: [{ id: privateModel, name: privateLabel, localRef: legacyRef }],
  } } }));
  fs.mkdirSync(path.join(profile, 'conversation-models'));
  fs.writeFileSync(path.join(profile, 'conversation-models', 'legacy-fixture.json'), JSON.stringify({ name: legacyRef }));
  fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({
    compaction: { enabled: false }, retry: { enabled: false }, enableInstallTelemetry: false,
  }));
  const { createHostAuth } = require('../main/agent-runtime/process-auth');
  runtime = require('../main/agent-runtime/process-session').createProcessSession({ authFactory: options =>
    createHostAuth({ ...options, identityOf: async () => identity,
      deviceAuth: { ensureSession: async () => identity.session } }) });
  bridge = require('../main/agent-runtime/pi-session-bridge').createPiSessionBridge({ app, sessionModule: runtime, runnerAdapters: [] });
  reporter = require('../main/agent-runtime/usage-reporter').createUsageReporter({ app,
    identityOf: async () => identity, fetchImpl: (url, init) => fetch(url, init) });
  win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true } });
  await win.loadURL('data:text/html,<title>Private model E2E</title><p>Isolated model test</p>');
  const options = { app, identity, cwd, skillDirs: [], noExtensions: true, modelName: modelRef,
    accessPolicy: { schema: 'soduwork.access-policy/v1', mode: 'readonly', revision: 1, workspaceRoot: cwd } };
  stage('Execute and persist a local turn while Hub rejects model operations');
  let opened = await bridge.open({ ...options, ref: 'privacy-first' });
  assert.equal(opened.ok, true, opened.reason); handle = opened.session;
  assert.notEqual(runtime.diagnostics(app).pid, process.pid);
  assert.equal((await turn('Reply with a short confirmation.')).ok, true);
  reporter.observe(handle, handle.snapshot()); await reporter.flush();
  assert.equal(requests.length, 1);
  assertHubBoundary();
  const archive = handle.resumeLocation(), sessionId = handle.sessionId;
  assert.ok(fs.readFileSync(archive, 'utf8').includes(modelRef));
  scan(profile);
  report.cases.push('Real safeStorage ciphertext, isolated runtime and direct provider request; no private configuration or model usage reaches the rejecting Hub.');

  stage('Restore the actual archive and keep local ownership');
  await handle.close();
  // Recreate the prior version's structured metadata in this closed fixture archive.
  const legacyArchive = fs.readFileSync(archive, 'utf8').split('\n').map(line => {
    if (!line) return line;
    const row = JSON.parse(line);
    if (row.type === 'custom' && row.customType === 'soduwork.model.selection') row.data.name = legacyRef;
    if (row.type === 'model_change') row.modelId = privateModel;
    if (row.type === 'message' && row.message?.role === 'assistant') {
      row.message.model = privateModel; row.message.responseModel = privateModel;
    }
    return JSON.stringify(row);
  }).join('\n');
  fs.writeFileSync(archive, legacyArchive);
  opened = await bridge.open({ ...options, modelName: undefined, ref: 'privacy-restored', resumePath: archive, resumeCwd: cwd });
  assert.equal(opened.ok, true, opened.reason); handle = opened.session;
  assert.equal(handle.sessionId, sessionId); assert.equal(requests.length, 1);
  assert.equal((await turn('Reply again after restoration.')).ok, true);
  reporter.observe(handle, handle.snapshot()); await reporter.flush();
  scan(profile); assertHubBoundary();
  report.cases.push('Legacy encrypted catalog, preferences, runtime config and actual SDK archive migrate; history resumes with the same private reference and no Hub model fallback.');

  stage('Sanitize provider error metadata and refresh no-key local configuration');
  mode = 'error';
  await turn('Exercise a provider failure.');
  scan(profile);
  mode = 'no-key';
  const current = store.get();
  store.save({ providers: current.providers.map(row => ({ ...row, authMode: 'none' })),
    keys: { [providerId]: '' }, expectedRevision: current.revision });
  const selected = await handle.selectModel(modelRef);
  assert.equal(selected.ok, true, selected.reason);
  assert.equal((await turn('Confirm a no-key local provider still works.')).ok, true);
  reporter.observe(handle, handle.snapshot()); await reporter.flush();
  assert.ok(requests.some(row => row.mode === 'error'));
  assert.ok(requests.some(row => row.mode === 'no-key'));
  scan(profile); assertHubBoundary(); assert.deepEqual(serverErrors, []);
  report.cases.push('An upstream error echoing private metadata leaves no sentinel on disk; no-key refresh sends no Authorization header.');

  stage('Delete the local model without rebinding history to Hub');
  await handle.close();
  store.save({ models: [], expectedRevision: store.get().revision });
  const before = requests.length;
  opened = await bridge.open({ ...options, ref: 'privacy-deleted', resumePath: archive, resumeCwd: cwd });
  assert.equal(opened.ok, true, opened.reason); handle = opened.session;
  assert.equal(handle.snapshot().modelSelection.activeModel.localOnly, true);
  const blocked = await turn('Try the removed local model.');
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason, /原本地模型已删除或不可用/);
  assert.equal(requests.length, before); assertHubBoundary();
  scan(profile);
  report.cases.push('A deleted private model opens as a historical placeholder, blocks sending until an explicit replacement, and never falls back to Hub or sends another provider request.');

  stage('Require explicit selection before the historical session can continue');
  expectedWireModel = privateModel + '-replacement';
  const replacement = store.save({ models: [{ providerId, name: expectedWireModel, label: privateLabel }],
    expectedRevision: store.get().revision }).myModels[0].id;
  assert.notEqual(replacement, modelRef);
  const stillBlocked = await turn('A new catalog entry must not replace a deleted selection automatically.');
  assert.equal(stillBlocked.ok, false);
  assert.equal(requests.length, before);
  const replaced = await handle.selectModel(replacement);
  assert.equal(replaced.ok, true, replaced.reason);
  assert.equal((await turn('Continue after choosing the replacement explicitly.')).ok, true);
  assert.equal(requests.length, before + 1);
  reporter.observe(handle, handle.snapshot()); await reporter.flush();
  assertHubBoundary(); scan(profile); assert.deepEqual(serverErrors, []);
  await handle.close();
  report.cases.push('Adding another local model cannot clear the historical placeholder; an explicit valid selection resumes the same history with no private Hub request.');
  report.requests = requests.length; report.hubRequests = hubRequests.length; report.ok = true;
}).catch(error => { report.error = String(error.stack || error); }).finally(async () => {
  await Promise.resolve(bridge?.dispose()).catch(error => { report.ok = false; report.cleanupError = error.message; });
  await Promise.resolve(runtime?.dispose()).catch(error => { report.ok = false; report.cleanupError = error.message; });
  win?.destroy();
  for (const server of [providerServer, hubServer]) if (server) {
    const ended = new Promise(resolve => server.close(resolve)); server.closeAllConnections(); await ended;
  }
  console.log(JSON.stringify(report, null, 2));
  fs.rmSync(root, { recursive: true, force: true });
  app.exit(report.ok ? 0 : 1);
});
