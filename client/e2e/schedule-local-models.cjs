'use strict';

// Exercise the real editor, API partitioning and encrypted IPC with a disposable profile.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const child = require('node:child_process').spawn(electron, [__filename, ...process.argv.slice(2)],
    { env, windowsHide: true, stdio: 'inherit' });
  const timer = setTimeout(() => child.kill(), 120000);
  child.on('exit', code => { clearTimeout(timer); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, ipcMain, safeStorage, net } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http');
  const assert = require('node:assert/strict'), { pathToFileURL } = require('node:url');
  const client = path.resolve(__dirname, '..'), output = process.argv[2];
  const modelLabel = process.argv[3] || 'custom-medium';
  const privateModelName = 'private-schedule-wire-model';
  assert.ok(output && path.isAbsolute(output), 'Absolute evidence directory required');
  fs.mkdirSync(output, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-schedule-models-'));
  app.setPath('userData', profile); app.disableHardwareAcceleration();
  if (process.platform === 'darwin') app.commandLine.appendSwitch('use-mock-keychain');
  let win, server, hub, ref, catalogScenario = 'mixed';
  const currentDevice = 'fixture-current-device', otherDevice = 'fixture-other-device', account = 'fixture-owner';
  const managedAgents = ['pi', 'qwen', 'opencode', 'dsh', 'kimi', 'harness2', 'codex-harness'];
  const accountAgents = ['codex', 'claude'], rows = [], requests = [], privatePreflights = [], fixtureErrors = [];
  const managedModel = { name: 'managed-model', label: 's1', providerId: 'fixture-managed', keyFrom: 'org' };
  const options = { substrates: managedAgents.concat(accountAgents).map(cli => ({
    key: 'local:' + cli, cli, name: cli, modelMode: accountAgents.includes(cli) ? 'native' : 'managed',
    modelPick: !accountAgents.includes(cli), nativeModelPick: accountAgents.includes(cli), available: true,
    locations: [
      { assigneeId: 'runner:' + currentDevice + ':' + cli, mode: 'local', label: '本机', clientId: currentDevice },
      { assigneeId: 'runner:' + otherDevice + ':' + cli, mode: 'remote', label: '远程 Runner', clientId: otherDevice },
    ],
  })), modelOptions: [managedModel], defaultModel: managedModel.name };
  const identity = () => {
    const now = Math.floor(Date.now() / 1000);
    return { hub, clientId: currentDevice, session: Buffer.from(JSON.stringify({ typ: 'device', uid: account,
      cid: currentDevice, iat: now - 1, exp: now + 3600 })).toString('base64url') + '.' + 'a'.repeat(64) };
  };
  const js = async code => {
    try { return await win.webContents.executeJavaScript(code, true); }
    catch (error) { throw Error(error.message + '\nRenderer expression: ' + code, { cause: error }); }
  };
  const report = { ok: false, checks: [],
    boundary: 'Real Electron editor, production api.js, local-model and owner-checked automation-model IPC, and safeStorage encryption API. macOS uses the Chromium test keychain. Hub HTTP, authentication and local preflight are synthetic fixtures; no real account, provider request, Runner execution or system-keychain permission validation.' };
  async function until(code) {
    for (let i = 0; i < 100; i++) {
      if (await js(code)) return;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    throw Error('Timed out: ' + code);
  }
  function mark(value) { report.checks.push(value); console.log('PASS ' + value); }
  async function chooseAgent(cli, remote = false) {
    const id = 'runner:' + (remote ? otherDevice : currentDevice) + ':' + cli;
    await js(`schWho.value=${JSON.stringify(id)};schWho.dispatchEvent(new Event('change',{bubbles:true}));void 0;`);
    await until(`schWho.value===${JSON.stringify(id)} && !_schEditorPending`);
    if (!remote && accountAgents.includes(cli)) await until(`Array.from(schModel.options).some(o=>o.value===${JSON.stringify('native-' + cli)})`);
    return id;
  }
  async function newEditor() {
    await js('_schPrepareEditor("new")');
    await until('document.querySelector("#schModel") && !_schEditorPending');
  }
  async function saveEditor(updated = false) {
    const count = requests.filter(row => row.method === (updated ? 'PUT' : 'POST') && /^\/api\/v1\/schedules(?:\/[^/]+)?$/.test(row.path)).length;
    await js('schSave.click();void 0;');
    for (let i = 0; i < 200; i++) {
      const saved = requests.filter(row => row.method === (updated ? 'PUT' : 'POST') && /^\/api\/v1\/schedules(?:\/[^/]+)?$/.test(row.path));
      if (saved.length > count && await js('!document.querySelector("#schEditorLayer.show")')) return saved.at(-1);
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    throw Error('Save did not complete: ' + await js('window.notice'));
  }
  app.whenReady().then(async () => {
    assert.equal(safeStorage.isEncryptionAvailable(), true, 'Encryption must be available; no plaintext fallback');
    if (process.platform === 'linux') assert.notEqual(safeStorage.getSelectedStorageBackend(), 'basic_text');
    server = http.createServer(async (request, response) => {
      response.setHeader('Access-Control-Allow-Origin', '*'); response.setHeader('Access-Control-Allow-Headers', '*');
      response.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
      response.setHeader('Content-Type', 'application/json');
      if (request.method === 'OPTIONS') { response.end('{}'); return; }
      let raw = ''; for await (const chunk of request) raw += chunk;
      const route = new URL(request.url, hub).pathname, body = raw ? JSON.parse(raw) : {};
      requests.push({ method: request.method, path: route, raw, body });
      const reply = value => response.end(JSON.stringify(value));
      try {
        assert.equal(raw.includes('local:model-'), false, 'Hub must never receive an opaque local model reference');
        assert.equal(raw.includes(privateModelName), false, 'Hub must never receive the private model name');
        assert.equal(raw.includes('unavailable:'), false, 'UI placeholders must never enter Hub requests');
        if (route === '/api/v1/my-models') return reply({ providers: [{ id: 'fixture-managed', name: 'Managed' }],
          usable: catalogScenario.startsWith('local') ? [] : [managedModel], myModels: [], mediaUsable: {}, defaultModels: {},
          defaultModelErrors: catalogScenario.endsWith('no-default') || catalogScenario === 'hub-only'
            ? Object.fromEntries(managedAgents.map(id => [id, 'No Hub default is configured'])) : {} });
        if (route === '/api/v1/task-execution-options') return reply(options);
        if (route === '/api/v1/schedules/preflight') return reply({ state: 'ready', message: 'Synthetic preflight ready', checks: [] });
        if (route === '/api/v1/schedules' && request.method === 'POST') {
          const row = { ...body, id: 'fixture-schedule-' + (rows.length + 1), onceFired: false, nextRunAt: null };
          rows.push(row); return reply(row);
        }
        if (route === '/api/v1/schedules' && request.method === 'GET') return reply(rows);
        if (/^\/api\/v1\/schedules\/fixture-schedule-\d+$/.test(route) && request.method === 'PUT') {
          const row = rows.find(item => item.id === route.split('/').at(-1)); assert.ok(row);
          Object.assign(row, body); return reply(row);
        }
        if (route === '/api/v1/schedules/templates' || route === '/api/v1/repos') return reply([]);
        if (route.includes('/plugins')) return reply({ items: [] });
        throw Error('Unexpected Hub fixture request: ' + request.method + ' ' + route);
      } catch (error) { fixtureErrors.push(error.message); response.writeHead(500); reply({ detail: error.message }); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    hub = 'http://127.0.0.1:' + server.address().port;
    require('../main/local-model-ipc.cjs').install({ app, ipcMain, safeStorage });
    require('../main/local-automation-model-ipc.cjs').install({ app, ipcMain, safeStorage,
      identityOf: async () => identity(), currentIdentityOf: identity });
    ipcMain.handle('fixture-schedule-preflight', (_event, input) => {
      privatePreflights.push(input);
      if (input.localModelName) assert.equal(input.localModelName, ref);
      return input.server;
    });
    const store = require('../main/local-model-store.cjs');
    const catalog = store.save({ providers: [{ id: 'fixture-local', name: 'Fixture local service',
      baseUrl: 'http://127.0.0.1:1/v1', kind: 'openai-compat', authMode: 'none' }],
    models: [{ providerId: 'fixture-local', name: privateModelName, label: modelLabel }] });
    ref = catalog.usable[0].name;
    const preload = path.join(profile, 'fixture-preload.cjs');
    fs.writeFileSync(preload, `const {contextBridge,ipcRenderer}=require('electron');
      contextBridge.exposeInMainWorld('soduWorkAPI',{
        getHubConnection:async()=>({hub:${JSON.stringify(hub)},internalTest:true}),
        deviceAuthBootstrap:async()=>({ok:true,stored:true,clientId:${JSON.stringify(currentDevice)},
          session:${JSON.stringify(identity().session)},expiresIn:3600,user:{id:${JSON.stringify(account)}}}),
        localModels:{get:()=>ipcRenderer.invoke('local-models-get')},
        automationModels:Object.fromEntries(['get','set','remove'].map(action=>[action,input=>ipcRenderer.invoke('automation-models-'+action,input)])),
        automationPreflight:input=>ipcRenderer.invoke('fixture-schedule-preflight',input),
        conversationSession:{runtimeModels:async id=>({models:[{id:'native-'+id,label:'Account '+id}]})}});`);
    let html = fs.readFileSync(path.join(__dirname, 'fixtures/schedule-once-editor.html'), 'utf8')
      .replaceAll('href="../../', 'href="').replaceAll('src="../../', 'src="')
      .replace('openSchedulePanel();</script>', 'SoduWorkAPI.registerClient().then(()=>{window.fixtureReady=true;openSchedulePanel();});</script>');
    const stubStart = html.indexOf('window.SoduWorkAPI={'), stubEnd = html.indexOf('\n};', stubStart);
    assert.ok(stubStart >= 0 && stubEnd > stubStart, 'Shared fixture must contain its explicit API stub');
    html = html.slice(0, stubStart) + `window.User={id:${JSON.stringify(currentDevice)}};` + html.slice(stubEnd + 3);
    html = html.replace('<script src="components/panels/schedule-timing.js">',
      '<script src="core/api-work-plugins.js"></script><script src="api.js"></script><script src="components/panels/schedule-timing.js">');
    win = new BrowserWindow({ show: false, width: 1280, height: 1100,
      webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true,
        offscreen: true, backgroundThrottling: false } });
    const desk = pathToFileURL(path.join(client, 'desk.html')).href;
    win.webContents.session.protocol.handle('file', request => request.url === desk
      ? new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })
      : net.fetch(request.url, { bypassCustomProtocolHandlers: true }));
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] },
      (request, done) => done({ cancel: new URL(request.url).origin !== hub }));
    await win.loadURL(desk);
    await until('window.fixtureReady && !!document.querySelector("#schPanel.show")');
    await newEditor();
    report.options = await js('[...schModel.options].map(o=>({value:o.value,label:o.textContent}))');
    assert.ok(report.options.some(row => row.value === ref && row.label.includes(modelLabel) && row.label.includes('本机')));
    assert.ok(report.options.some(row => row.label === 's1'));
    assert.equal(await js('schWho.value'), 'runner:' + currentDevice + ':pi');
    mark('Opening a concrete current-device Runner lists the shared Hub and encrypted device catalogs');
    assert.equal(await js('schModel.value'), ref, 'new managed forms choose the first local model');
    await js('schModel.value="managed-model";schModel.dispatchEvent(new Event("change",{bubbles:true}));void 0;');
    await chooseAgent('qwen');
    assert.equal(await js('schModel.value'), 'managed-model', 'changing managed substrates preserves an available explicit model');
    await chooseAgent('pi');
    mark('Managed substrate changes preserve an explicit available model independently of Agent defaults');
    for (const cli of managedAgents) {
      if (cli !== 'pi') await newEditor();
      const assignee = await chooseAgent(cli);
      assert.equal(await js(`[...schModel.options].some(o=>o.value===${JSON.stringify(ref)})`), true, cli);
      assert.equal(await js('[...schModel.options].some(o=>o.value==="managed-model")'), true, cli);
      await js(`schModel.value=${JSON.stringify(ref)};schModel.dispatchEvent(new Event('change',{bubbles:true}));
        schTitle.value=${JSON.stringify('Synthetic local automation ')}+${JSON.stringify(cli)};
        schNote.value='Synthetic validation only';schModel.scrollIntoView({block:'center'});void 0;`);
      assert.match(await js('schModel.selectedOptions[0].textContent'), new RegExp(modelLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      if (cli === 'pi') {
        await new Promise(resolve => setTimeout(resolve, 100));
        fs.writeFileSync(path.join(output, 'schedule-local-model-selected.png'), (await win.webContents.capturePage()).toPNG());
      }
      await js('schReloadAgents.click();void 0;'); await until('!schReloadAgents.disabled');
      assert.equal(await js('schModel.value'), ref, cli + ' refresh must retain the chosen local model');
      assert.equal(await js('schWho.value'), assignee, cli + ' refresh must retain the concrete device');
      const saved = await saveEditor();
      assert.equal(saved.body.assigneeId, assignee); assert.equal(saved.body.modelName, ''); assert.equal(saved.body.modelSource, 'device');
      const row = rows.at(-1), scope = { hub, clientId: currentDevice, owner: 'account:' + account, scheduleId: row.id };
      assert.equal(require('../main/local-automation-model-store.cjs').get(scope).modelName, ref);
      const hydrated = await js(`SoduWorkAPI.listSchedules().then(items=>items.find(row=>row.id===${JSON.stringify(row.id)}))`);
      assert.equal(hydrated.modelName, ref); assert.equal(hydrated.assigneeId, assignee);
      await js(`_schPrepareEditor(${JSON.stringify(hydrated)})`); await until('!_schEditorPending && !!document.querySelector("#schModel")');
      assert.equal(await js('schModel.value'), ref, cli + ' editing must restore the private selection');
      await js('schNote.value="Updated synthetic validation";void 0;');
      const edited = await saveEditor(true);
      assert.equal(edited.body.modelName, ''); assert.equal(edited.body.modelSource, 'device');
      assert.equal(require('../main/local-automation-model-store.cjs').get(scope).modelName, ref);
      mark(cli + ' local selection survives refresh, create, encrypted persistence and edit without entering Hub requests');
      await newEditor(); await chooseAgent(cli, true);
      assert.equal(await js('[...schModel.options].some(o=>o.value.startsWith("local:"))'), false, cli);
      assert.equal(await js('[...schModel.options].some(o=>o.value==="managed-model")'), true, cli);
      const rejected = await js(`SoduWorkAPI.createSchedule({assigneeId:${JSON.stringify('runner:' + otherDevice + ':' + cli)},
        assigneeMode:'remote',assigneeClientId:${JSON.stringify(otherDevice)},modelName:${JSON.stringify(ref)}}).then(()=>'',e=>e.message)`);
      assert.match(rejected, /本机/); mark(cli + ' remote Runner hides and rejects device-owned models');
    }
    for (const cli of accountAgents) {
      await newEditor(); await chooseAgent(cli);
      const native = await js('[...schModel.options].map(o=>o.value)');
      assert.ok(native.includes('native-' + cli), cli); assert.equal(native.includes('managed-model'), false, cli);
      assert.equal(native.some(value => value.startsWith('local:')), false, cli);
      const rejected = await js(`SoduWorkAPI.createSchedule({assigneeId:${JSON.stringify('runner:' + currentDevice + ':' + cli)},
        assigneeMode:'local',assigneeClientId:${JSON.stringify(currentDevice)},modelName:${JSON.stringify(ref)}}).then(()=>'',e=>e.message)`);
      assert.match(rejected, /本机/);
      await chooseAgent(cli, true);
      assert.equal(await js('schModel.disabled'), true, cli + ' remote account models stay managed by that account');
      mark(cli + ' account catalogs remain separate from Hub and device catalogs');
    }
    store.save({ models: [] });
    const old = await js('SoduWorkAPI.listSchedules().then(items=>items[0])');
    await js(`_schPrepareEditor(${JSON.stringify(old)})`);
    await until('!_schEditorPending && !!document.querySelector("#schModel")');
    assert.equal(await js('schModel.value'), managedModel.name, 'a deleted model falls back to the first available Hub model');
    const replaced = await saveEditor(true);
    assert.equal(replaced.body.modelName, managedModel.name);
    assert.equal(replaced.body.modelSource, 'managed');
    mark('Deleting a model selects the first usable replacement and saves the displayed effective model');
    for (const scenario of ['hub-only', 'local-only', 'local-no-default']) {
      catalogScenario = scenario;
      if (scenario !== 'hub-only') ref = store.save({ models: [
        { providerId: 'fixture-local', name: privateModelName, label: modelLabel },
      ] }).usable[0].name;
      options.modelOptions = scenario === 'hub-only' ? [managedModel] : [];
      options.defaultModel = scenario === 'local-only' ? '' : 'unavailable:default';
      await newEditor(); await chooseAgent('qwen');
      const expected = scenario === 'hub-only' ? managedModel.name : ref;
      assert.equal(await js('schModel.value'), expected, scenario + ' must choose its only usable model');
      assert.equal(await js('[...schModel.options].some(o=>o.value.startsWith("unavailable:"))'), false);
      await js(`schTitle.value=${JSON.stringify('Single model ')}+${JSON.stringify(scenario)};schNote.value='Synthetic validation only';void 0;`);
      const saved = await saveEditor();
      assert.equal(saved.body.modelName, scenario === 'hub-only' ? expected : '');
      assert.equal(saved.body.modelSource, scenario === 'hub-only' ? 'managed' : 'device');
      mark(scenario + ' new automation automatically pins its sole usable model and saves without a default sentinel');
    }
    const originalGet = store.get;
    store.get = () => { throw new Error('Synthetic secure store read failure'); };
    try {
      catalogScenario = 'mixed'; options.modelOptions = [managedModel]; options.defaultModel = managedModel.name;
      await newEditor();
      assert.equal(await js('_schModelCatalogError'), true);
      assert.equal(await js('schModel.value'), '', 'unreadable local catalogs cannot select a Hub fallback');
      await js('schTitle.value="Unreadable catalog fixture";schNote.value="Synthetic test";void 0;');
      const beforeFailure = requests.filter(row=>row.method==='POST'||row.method==='PUT').length;
      await js('schSave.click();void 0;');
      await new Promise(resolve=>setTimeout(resolve,550));
      assert.equal(requests.filter(row=>row.method==='POST'||row.method==='PUT').length,beforeFailure,
        'neither preflight nor save may treat unreadable secure storage as model deletion');
      assert.match(await js('window.notice'), /配置暂时无法读取/);
      mark('Secure storage read failures block local preflight and save instead of selecting a Hub model');
    } finally { store.get = originalGet; }
    const encrypted = fs.readFileSync(path.join(profile, 'automation-models.secure.json'), 'utf8');
    assert.equal(typeof JSON.parse(encrypted).cipher, 'string'); assert.equal(encrypted.includes(ref), false);
    assert.equal(JSON.stringify(requests).includes(ref), false); assert.equal(JSON.stringify(requests).includes(privateModelName), false);
    assert.ok(privatePreflights.some(row => row.localModelName === ref));
    assert.deepEqual(fixtureErrors, []);
    assert.deepEqual(await js('errors'), []);
    mark('Opaque references exist only in the encrypted owner-scoped mapping and private IPC, including mandatory save preflight');
    report.ok = true;
    console.log(JSON.stringify(report));
  }).catch(error => { report.error = String(error.stack || error); console.error(report.error); process.exitCode = 1; })
    .finally(() => { fs.writeFileSync(path.join(output, 'schedule-local-models.json'), JSON.stringify(report, null, 2));
      win?.destroy(); server?.closeAllConnections(); server?.close(); app.exit(report.ok ? 0 : 1); });
}
