'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http');
const localModels = require('../main/local-model-store.cjs'), defaults = require('../main/local-agent-model-store.cjs');
const config = require('../main/pi-session/model-config');
const { createRunnerRuntimeAdapter, getRunnerSessionDetails, _uuidV5 } = require('../main/agent-runtime/runner-adapter');
const first = 'local:model-' + '1'.repeat(32), second = 'local:model-' + '2'.repeat(32);
function identity() {
  const now = Math.floor(Date.now() / 1000);
  return { hub: 'http://fixture.invalid', clientId: 'fixture-device', session:
    Buffer.from(JSON.stringify({ typ: 'device', uid: 'fixture-owner', cid: 'fixture-device', iat: now - 1, exp: now + 3600 })).toString('base64url') + '.' + 'a'.repeat(64) };
}
function directory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-default-persistence-'));
  const cwd = path.join(root, 'work'); fs.mkdirSync(cwd);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, cwd, app: { isPackaged: false, getPath: () => root } };
}

for (const input of ['omitted', 'empty']) test('Runner pins an ' + input + ' local default across default edits, removal and archive recovery', async t => {
  const f = directory(t), calls = [], rpc = [];
  let currentDefault = first, deleted = false;
  const adapter = createRunnerRuntimeAdapter({ app: f.app,
    runtimeSpec: require('../main/agent-runtime/runtime-catalog').runtime('qwen'),
    runnerRuntime: { rpc: async (op, value) => { rpc.push({ op, value }); return { ok: true, data: { ok: true, status: 'done', items: [] } }; } },
    modelConfig: { fetchModel: async (_, name) => {
      calls.push(name); const ref = name || currentDefault;
      return { ok: true, model: { id: ref, modelRef: ref, wireModelId: deleted ? ref : 'private-wire',
        localOnly: true, key: '', baseUrl: 'http://127.0.0.1:11434/v1',
        ...(deleted && ref === first ? { historicalLocal: true } : {}) } };
    } } });
  const alias = 'default-' + input, ref = _uuidV5('9af442c8-cd1d-4b91-a668-22da2b2635bf', 'chat:' + alias + ':qwen');
  const opts = { ref: alias, cwd: f.cwd, ...(input === 'empty' ? { modelName: '' } : {}) };
  const created = await adapter.createSession({ runtimeId: alias, identity: identity(), native: { runner: { openOptions: opts } } });
  assert.equal(created.snapshot().modelSelection.name, first);
  assert.equal(require('../main/conversation/model-selection').preference(f.app, ref).read(), first);
  await created.dispose();
  for (const change of ['different', 'cleared', 'deleted']) {
    currentDefault = change === 'different' ? second : ''; deleted = change === 'deleted';
    const resumed = await adapter.resumeSession({ runtimeId: alias, identity: identity(),
      native: { runner: { openOptions: { ref: alias, resumePath: ref, cwd: f.cwd } } } });
    assert.equal(calls.at(-1), first, change);
    assert.equal(resumed.snapshot().modelSelection.name, first, change);
    if (deleted) {
      assert.equal(resumed.snapshot().modelSelection.model.unavailable, true);
      const rejected = await resumed.send({ text: 'Do not silently change this model' }).completion;
      assert.equal(rejected.ok, false); assert.match(rejected.reason, /已删除或不可用/);
      assert.equal(rpc.some(row => row.op === 'job.dispatch' || row.op === 'job.comment'), false);
    }
    await resumed.dispose();
  }
});

for (const input of ['omitted', 'empty']) test('real Pi SDK persists an ' + input + ' local default with its first turn and restores the same unavailable choice', { timeout: 30000 }, async t => {
  const f = directory(t), sdk = await import('../node_modules/@earendil-works/pi-coding-agent/dist/index.js');
  const requests = [], server = http.createServer((req, res) => {
    let raw = ''; req.on('data', value => raw += value);
    req.on('end', () => {
      const body = JSON.parse(raw); requests.push(body.model);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: body.model,
        choices: [{ index: 0, delta: { role: 'assistant', content: 'Finished.' }, finish_reason: null }] }) + '\n\n');
      res.end('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = 'http://127.0.0.1:' + server.address().port + '/v1';
  const actor = identity(), safeStorage = { isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(value), decryptString: value => value.toString() };
  localModels.configure({ app: f.app, safeStorage }); defaults.configure({ app: f.app, safeStorage });
  const catalog = localModels.save({ providers: [{ id: 'private', baseUrl, authMode: 'none' }],
    models: [{ providerId: 'private', name: 'private-one' }, { providerId: 'private', name: 'private-two' }] });
  const a = catalog.usable[0].name, b = catalog.usable[1].name, owned = defaults.scopeFromIdentity(actor);
  defaults.set({ ...owned, agentId: 'pi', modelName: a });
  config.writeModels(config.agentDir(f.app), (await config.fetchModel(actor, b, 8000, fetch, false, 'pi', { app: f.app })).model);
  const create = sdk.ModelRuntime.create, sessions = require('../main/pi-session/session');
  const envKeys = ['PI_CODING_AGENT_DIR', 'SODUWORK_PROXY_KEY', 'SODUWORK_MCP_KEY', 'SODUWORK_MCP_SERVERS', 'SODUWORK_HUB_ORIGIN'];
  const environment = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  sdk.ModelRuntime.create = () => create.call(sdk.ModelRuntime, { modelsPath: path.join(config.agentDir(f.app), 'models.json'),
    authPath: path.join(config.agentDir(f.app), 'auth.json'), modelsStorePath: path.join(config.agentDir(f.app), 'models.db') });
  let handle;
  const actualFetch = global.fetch;
  t.mock.method(global, 'fetch', async (url, options) => {
    assert.ok(String(url).startsWith(baseUrl + '/'), 'only the configured loopback provider may be called');
    return actualFetch(url, options);
  });
  t.after(async () => {
    await handle?.close(); sdk.ModelRuntime.create = create;
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    for (const key of envKeys) if (environment[key] === undefined) delete process.env[key]; else process.env[key] = environment[key];
  });
  const opened = await sessions.open({ app: f.app, identity: actor, cwd: f.cwd, ref: 'pi-' + input, noExtensions: true,
    ...(input === 'empty' ? { modelName: '' } : {}) });
  assert.equal(opened.ok, true, opened.reason); handle = opened.session;
  assert.equal(handle.snapshot().modelSelection.name, a);
  assert.equal((await handle.submit('Use the original local default.', []).completion).ok, true);
  const archive = handle.resumeLocation();
  assert.equal(sdk.SessionManager.open(archive).getEntries().findLast(row => row.customType === 'soduwork.model.selection').data.name, a);
  await handle.close(); handle = null;
  // Keep entry IDs and parent links while reproducing both older selection formats.
  fs.writeFileSync(archive, fs.readFileSync(archive, 'utf8').split('\n').map(line => {
    if (!line) return line;
    const row = JSON.parse(line);
    if (row.customType === 'soduwork.model.selection') {
      if (input === 'omitted') row.customType = 'fixture.legacy-selection';
      else row.data.name = '';
    }
    return JSON.stringify(row);
  }).join('\n'));
  for (const change of ['different', 'cleared', 'deleted']) {
    if (change === 'different') { defaults.set({ ...owned, agentId: 'pi', modelName: b });
      config.writeModels(config.agentDir(f.app), (await config.fetchModel(actor, b, 8000, fetch, false, 'pi', { app: f.app })).model); }
    else defaults.remove({ ...owned, agentId: 'pi' });
    if (change === 'deleted') localModels.save({ models: localModels.get().myModels.filter(row => row.id !== a) });
    const restored = await sessions.open({ app: f.app, identity: actor, cwd: f.cwd, ref: 'restored-' + input,
      resumePath: archive, resumeCwd: f.cwd, noExtensions: true });
    assert.equal(restored.ok, true, restored.reason); handle = restored.session;
    assert.equal(handle.snapshot().modelSelection.name, a, change);
    if (change === 'deleted') {
      assert.equal(handle.snapshot().modelSelection.model.unavailable, true);
      const rejected = await handle.submit('Keep the deleted model blocked', []).completion;
      assert.equal(rejected.ok, false); assert.match(rejected.reason, /已删除或不可用/);
    }
    await handle.close(); handle = null;
  }
  const unknown = sdk.SessionManager.create(f.cwd, path.join(f.root, 'unknown-history'));
  unknown.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'Older local result.' }],
    model: 'unowned-private-name', provider: 'soduwork', usageLocalOnly: true, timestamp: Date.now() });
  const denied = await sessions.open({ app: f.app, identity: actor, cwd: f.cwd, ref: 'unowned-' + input,
    resumePath: unknown.getSessionFile(), resumeCwd: f.cwd, noExtensions: true });
  assert.equal(denied.ok, false); assert.equal(denied.code, 'LOCAL_HISTORY_MODEL_UNAVAILABLE');
  assert.deepEqual(requests, ['private-one']);
});
