'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const config = require('../main/pi-session/model-config');
const auth = require('../main/device-auth');

test('local Pi sessions stay local through resume, expiration and managed model switches', { timeout: 30000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-local-pi-'));
  const cwd = path.join(root, 'work'), agentDir = path.join(root, 'agent');
  fs.mkdirSync(cwd); fs.mkdirSync(agentDir);
  const requests = [], selections = [], renewals = [];
  const localRef = 'local:model-' + '2'.repeat(32);
  const server = http.createServer((req, res) => {
    let raw = ''; req.on('data', value => { raw += value; });
    req.on('end', () => {
      const body = JSON.parse(raw); requests.push({ model: body.model, authorization: req.headers.authorization });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: body.model,
        choices: [{ index: 0, delta: { role: 'assistant', content: 'Finished.' }, finish_reason: null }] }) + '\n\n');
      res.end('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }) + '\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const sdk = await import('../node_modules/@earendil-works/pi-coding-agent/dist/index.js');
  const sessions = require('../main/pi-session/session');
  const recovery = require('../main/pi-session/model-recovery');
  const original = { create: sdk.ModelRuntime.create, prepare: config.prepare, fetch: config.fetchSelection,
    ensureSession: auth.ensureSession, now: Date.now, recoveryCreate: recovery.create };
  const envKeys = ['SODUWORK_PROXY_KEY', 'SODUWORK_MCP_KEY', 'SODUWORK_MCP_SERVERS', 'SODUWORK_HUB_ORIGIN'];
  const savedEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  for (const key of envKeys) delete process.env[key];
  let modelPath, session, beforeRetry, missing = false;
  recovery.create = options => { beforeRetry = options.beforeRetry; return original.recoveryCreate(options); };
  const makeModel = name => ({ id: 'shared-id', label: 'Fixture model', input: ['text'], contextWindow: 32000,
    baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1',
    ...(name === localRef ? { id: localRef, wireModelId: 'shared-id', localOnly: true, modelRef: localRef, key: '', proxyExpiresAt: 0 }
      : { key: 'fixture-managed', mcpKey: 'fixture-mcp', quotaProvider: 'fixture-provider', proxyExpiresAt: Date.now() + 3600000 }) });
  config.prepare = async (_, _identity, name, options = {}) => {
    selections.push(name);
    if (missing && name === localRef && options.allowHistorical) {
      const model = makeModel(name);
      model.historical = true; model.historicalLocal = true; model.modelRef = localRef;
      model.wireModelId = localRef; model.localOnly = true; model.key = '';
      modelPath = config.writeModels(agentDir, model);
      return { ok: true, historical: true, provider: 'soduwork', agentDir, model };
    }
    if (missing && name === localRef) return { ok: false, reason: 'Local model is unavailable' };
    const model = makeModel(name); modelPath = config.writeModels(agentDir, model);
    return { ok: true, provider: 'soduwork', agentDir, model };
  };
  config.fetchSelection = async (_, name, _timeout, _fetch, force) => {
    selections.push(name);
    assert.ok(name === localRef || name === 'managed', 'local runtime IDs must never be resolved through Hub');
    return { ok: true, model: makeModel(name) };
  };
  auth.ensureSession = async () => { renewals.push('renewed'); return 'fixture-session'; };
  sdk.ModelRuntime.create = () => original.create.call(sdk.ModelRuntime,
    { modelsPath: modelPath, authPath: path.join(agentDir, 'auth.json'), modelsStorePath: path.join(agentDir, 'models.db') });
  t.after(async () => {
    Date.now = original.now;
    if (session) await session.close();
    config.prepare = original.prepare; config.fetchSelection = original.fetch;
    auth.ensureSession = original.ensureSession; sdk.ModelRuntime.create = original.create;
    recovery.create = original.recoveryCreate;
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key];
    }
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const archive = sdk.SessionManager.create(cwd, path.join(root, 'sessions'));
  archive.appendCustomEntry('soduwork.model.selection', { name: localRef });
  archive.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'Earlier local result.' }],
    api: 'openai-completions', provider: 'soduwork', model: localRef, usageLocalOnly: true,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: Date.now() });
  const options = { app: { isPackaged: false, getPath: () => root }, identity: { hub: 'http://fixture.invalid', clientId: 'fixture' },
    cwd, ref: 'local-pi-isolation', resumePath: archive.getSessionFile(), resumeCwd: cwd, noExtensions: true };
  const opened = await sessions.open(options);
  assert.equal(opened.ok, true, opened.reason); session = opened.session;
  assert.equal(session.snapshot().modelSelection.name, localRef);
  assert.equal(session.snapshot().modelSelection.activeModel.localOnly, true);
  // Cross the managed ticket refresh window without spending ten minutes in a test.
  Date.now = () => original.now() + 11 * 60 * 1000;
  assert.equal((await session.submit('Use the local model.', []).completion).ok, true);
  Date.now = original.now;
  assert.deepEqual(selections, [localRef]); assert.deepEqual(renewals, []);
  await beforeRetry({ authExpired: true });
  assert.deepEqual(selections, [localRef, localRef], 'forced retries resolve the local reference rather than its raw runtime ID');
  assert.deepEqual(renewals, [], 'forced local credential reload never renews a Hub session');
  assert.equal((await session.selectModel('managed')).ok, true);
  assert.equal((await session.submit('Use the managed model.', []).completion).ok, true);
  assert.equal(process.env.SODUWORK_MCP_SERVERS, path.join(agentDir, 'mcp/servers.json'));
  assert.equal(process.env.SODUWORK_MCP_KEY, 'fixture-mcp');
  const renewed = renewals.length;
  assert.equal((await session.selectModel(localRef)).ok, true);
  assert.equal((await session.submit('Return to the local model.', []).completion).ok, true);
  assert.equal(renewals.length, renewed, 'local selection and local execution never renew a Hub session');
  assert.equal(process.env.SODUWORK_MCP_SERVERS, undefined);
  assert.equal(process.env.SODUWORK_MCP_KEY, undefined);
  assert.equal(process.env.SODUWORK_PROXY_KEY, undefined);
  assert.deepEqual(requests.map(row => row.authorization), [undefined, 'Bearer fixture-managed', undefined]);
  assert.deepEqual(session.snapshot().usageReceipts.map(row => row.localOnly === true), [true, true, false, true]);
  await session.close(); session = null;
  missing = true;
  const unavailable = await sessions.open(options);
  assert.equal(unavailable.ok, true, unavailable.reason);
  session = unavailable.session;
  const blocked = await session.submit('Try the removed local model.', []).completion;
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason, /原本地模型已删除或不可用/);
  assert.equal((await session.selectModel('managed')).ok, true);
  assert.equal((await session.submit('Continue with the managed model.', []).completion).ok, true);
  await session.close(); session = null;
  assert.equal(selections.includes(localRef), true);
});
