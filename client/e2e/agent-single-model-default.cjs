'use strict';

// Real Electron UI and secure-store IPC; Hub and Runner responses are synthetic.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE',
    'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  const result = require('node:child_process').spawnSync(electron,
    [__filename, ...process.argv.slice(2)], { env, stdio: 'inherit', windowsHide: true, timeout: 120000 });
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
}

const { app, BrowserWindow, ipcMain, safeStorage, net } = electron;
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict'), { pathToFileURL } = require('node:url');
const client = path.resolve(__dirname, '..');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-single-agent-model-')));
const profile = path.join(root, 'profile');
const out = path.resolve(process.argv[2] || path.join(root, 'evidence'));
fs.mkdirSync(profile); fs.mkdirSync(out, { recursive: true });
app.setAppPath(client); app.setPath('userData', profile); app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const report = { ok: false, cases: [], errors: [], networkRequests: [],
  platform: process.platform, electron: process.versions.electron,
  boundary: 'Real Electron/Chromium, production Agent drawer/API, local model secure stores, renderer IPC and local-agent-probe. Hub inventory/jobs and Runner RPC receipts are synthetic. No real account, provider request, installed-runtime execution or installation changes.' };
const managed = ['pi', 'qwen', 'opencode', 'dsh', 'kimi', 'harness2', 'codex-harness'];
const scope = { hub: 'http://fixture-hub.invalid:8989', clientId: 'fixture-device', owner: 'fixture-owner' };
const provider = { id: 'private-fixture', name: 'Private fixture', baseUrl: 'http://model-fixture.invalid/v1', authMode: 'none' };
const model = { providerId: provider.id, name: 'private-wire-one', label: 'Private model one' };
const other = { providerId: provider.id, name: 'private-wire-two', label: 'Private model two' };
const rpcCalls = [];
let win, localRef, expectedWireModel = model.name;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const js = code => win.webContents.executeJavaScript(code, true);
async function until(code) {
  const end = Date.now() + 8000;
  while (Date.now() < end) { if (await js(code)) return; await pause(25); }
  throw Error('UI did not settle: ' + code);
}
async function click(selector) {
  const point = await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});
    if(!e)throw Error('Missing control');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();
    const x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2);
    if(e.disabled||!e.contains(document.elementFromPoint(x,y)))throw Error('Control is disabled or occluded');return{x,y};})()`);
  for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, ...point, button: 'left', clickCount: 1 });
  await pause(40);
}
async function drawer(key) {
  if (await js('!!document.querySelector("[data-adrawer-x]")')) await click('[data-adrawer-x]');
  await click('[data-atoggle="fixture-local~' + key + '"]');
  await until('!!document.querySelector(".ag-drawer")');
}
async function screenshot(name) {
  await js('Promise.all(document.getAnimations().filter(animation=>Number.isFinite(animation.effect?.getTiming().iterations))' +
    '.map(animation=>animation.finished.catch(()=>{})))');
  fs.writeFileSync(path.join(out, name + '.png'), (await win.webContents.capturePage(undefined,
    { stayHidden: true, stayAwake: true })).toPNG());
}
async function reload() { await js('_agLoad(true)'); await until('document.querySelectorAll(".ag-row").length===9'); }
function mark(name) { report.cases.push(name); console.log('[agent-single-model] PASS ' + name); }

app.whenReady().then(async () => {
  assert.equal(safeStorage.isEncryptionAvailable(), true, 'Native encrypted storage must be available');
  if (process.platform === 'linux') assert.notEqual(safeStorage.getSelectedStorageBackend(), 'basic_text');
  const models = require('../main/local-model-store.cjs');
  require('../main/local-model-ipc.cjs').install({ app, ipcMain, safeStorage });
  const defaults = require('../main/local-agent-model-store.cjs');
  const privateProbe = require('../main/local-agent-probe.cjs');
  require('../main/local-agent-model-ipc.cjs').install({ app, ipcMain, safeStorage,
    scopeOf: () => scope,
    probeAgent: options => privateProbe.run({ ...options, runner: { rpc: async (op, payload) => {
      rpcCalls.push({ op, payload });
      if (op === 'agent.probe') {
        assert.ok(managed.includes(payload.key));
        assert.equal(payload.llm.localOnly, true);
        assert.equal(payload.llm.model, expectedWireModel);
        assert.equal(payload.llm.base, provider.baseUrl);
        assert.equal(payload.llm.authMode, 'none');
        assert.doesNotMatch(JSON.stringify(payload), /local:model-/);
        return { ok: true, data: { jobId: 'fixture-' + payload.key, private: true } };
      }
      assert.equal(op, 'agent.job');
      const key = payload.jobId.slice('fixture-'.length);
      return { ok: true, data: { id: payload.jobId, key, action: 'probe', state: 'done', ok: true,
        detail: 'Synthetic Runner receipt', lines: ['Synthetic private runtime diagnostic'] } };
    } } }) });
  localRef = models.save({ providers: [provider], models: [model] }).myModels[0].id;
  const initialDefault = defaults.get(scope);
  assert.deepEqual(initialDefault.selections, {});
  const preload = path.join(root, 'preload.cjs');
  fs.writeFileSync(preload, `const {contextBridge,ipcRenderer}=require('electron');
    contextBridge.exposeInMainWorld('soduWorkAPI',{
      deviceAuthBootstrap:async()=>({ok:true,stored:true,clientId:'fixture-device',
        user:{id:'fixture-owner'},session:'synthetic-session',expiresIn:1800}),
      runnerStatus:async()=>({connected:true,running:true}),
      localModels:{get:()=>ipcRenderer.invoke('local-models-get')},
      localAgentModels:Object.fromEntries(['get','set','remove','probe'].map(action=>
        [action,input=>ipcRenderer.invoke('local-agent-models-'+action,input||{})]))
    });`);
  win = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: {
    preload, sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true,
    backgroundThrottling: false, partition: 'single-agent-model-fixture' } });
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (request, done) => {
    report.networkRequests.push(request.url); done({ cancel: true });
  });
  const desk = pathToFileURL(path.join(client, 'desk.html')).href;
  win.webContents.session.protocol.handle('file', request => request.url === desk
    ? new Response('<!doctype html><html data-desk-panel="agents"><meta charset="utf-8"><body></body></html>',
      { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
    : net.fetch(request.url, { bypassCustomProtocolHandlers: true }));
  await win.loadURL(desk);
  const entry = fs.readFileSync(path.join(client, 'desk.html'), 'utf8');
  for (const [, file] of entry.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)) {
    await js(`new Promise((resolve,reject)=>{const e=document.createElement('link');e.rel='stylesheet';
      e.href=${JSON.stringify(pathToFileURL(path.join(client, file)).href)};
      e.onload=()=>resolve(true);e.onerror=()=>reject(Error('Style failed'));document.head.append(e);})`);
  }
  await js(`window.errors=[];addEventListener('error',e=>errors.push(e.message));
    addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));
    window.esc=s=>String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
    window.petSay=()=>{};window.User={id:'fixture-device',name:'Fixture'};
    window.__SODUWORK_TEST_HUB_CONFIG__={allowSwitch:true};
    localStorage.setItem('soduwork_work_hub_url',${JSON.stringify(scope.hub)});
    window.hubCalls=[];window.allowHubProbe=false;window.hubModels=[];window.hubOverrides={};
    window.managedKeys=${JSON.stringify(managed)};
    window.fetch=async(url,options={})=>{
      const target=new URL(url),route=target.pathname,body=options.body?JSON.parse(options.body):{};
      hubCalls.push({route,method:options.method||'GET',body,url:String(url)});
      const runner={runnerId:'fixture-local',label:'Fixture device',scope:'current-instance',
        isCurrentDevice:true,online:true,execution:'runner'};
      let value;
      if(route.endsWith('/runners'))value={runners:[runner]};
      else if(route.endsWith('/agent-setup'))value={models:hubModels,modelCount:hubModels.length,machines:[{
        ...runner,env:{ok:true,node:'fixture',npm:'fixture'},agents:[...managedKeys,'codex','claude'].map(key=>({
          key,name:key==='dsh'?'DeepSeek Harness':key,installed:true,present:true,state:'ready',setupState:'ready',
          modelPick:managedKeys.includes(key),model:'',modelEffective:hubModels[0]?.name||'',...hubOverrides[key]}))}]};
      else if(route.endsWith('/agent-setup/probe')){
        if(!allowHubProbe)throw Error('Local probe leaked into Hub');
        if(JSON.stringify(body).includes('local:'))throw Error('Local model reference leaked into Hub');
        value={jobId:'fixture-hub-probe',model:hubModels[0]?.name||'',keyFrom:'company'};
      }else if(route.endsWith('/agent-setup/job/fixture-hub-probe'))value={state:'done',ok:true,lines:['Synthetic Hub receipt']};
      else throw Error('Unexpected Hub request: '+route);
      return new Response(JSON.stringify(value));};void 0;`);
  const scripts = ['core/api-work-plugins.js', 'api.js', ...Array.from(entry.matchAll(/<script\s+src=["']([^"']+)["']/g), m => m[1])
    .filter(file => /\/(?:agent-brand|panels-agents|panels-runners|codex-auth-dialog)\.js$/.test(file))];
  for (const file of scripts) await js(fs.readFileSync(path.join(client, file), 'utf8') + '\nvoid 0;');
  await js('SoduWorkAPI.registerClient()');
  await js('openAgentsPanel();void 0;');
  await until('document.querySelectorAll(".ag-row").length===9&&_agData.localModelCount===1');
  for (const key of managed) {
    await drawer(key);
    assert.equal(await js('document.querySelector(".ag-drawer [data-amodel]").value'), localRef);
    assert.match(await js('document.querySelector(".ag-drawer option:checked").textContent'), /Private model one/);
    assert.equal(await js(`_agData.agents.find(a=>a.key===${JSON.stringify(key)}).modelAutomatic`), true);
  }
  await drawer('dsh'); await screenshot('single-local-model');
  await click('[data-adrawer-x]'); await click('[data-aprobe="fixture-local~dsh"]');
  await until('_agJobs["fixture-local~dsh"]?.state==="done"');
  assert.equal(await js('_agJobs["fixture-local~dsh"].ok'), true);
  assert.equal(await js('_agJobs["fixture-local~dsh"].probeKind'), 'agent-execution');
  assert.deepEqual(rpcCalls.map(call => call.op), ['agent.probe', 'agent.job']);
  assert.deepEqual(defaults.get(scope), initialDefault, 'Automatic selection must not persist a preference');
  assert.equal(fs.existsSync(path.join(profile, 'agent-models.secure.json')), false);
  await screenshot('single-local-probe');
  mark('Seven managed drawers select the sole local model; clicking DeepSeek probe reaches real IPC and the private probe path without saving defaults');
  for (const key of ['codex', 'claude']) {
    await drawer(key);
    assert.equal(await js('document.querySelectorAll(".ag-drawer [data-amodel]").length'), 0);
    assert.match(await js('document.querySelector(".ag-drawer .ag-model").textContent'), /自己的账号与模型/);
  }
  mark('Codex and Claude retain their own accounts without managed model selectors');

  const multiple = models.save({ models: [model, other] });
  const otherRef = multiple.myModels.find(row => row.name === other.name).id;
  await js('hubModels=[{name:"hub-fixture-model",label:"Hub model fixture"}];void 0;');
  await reload(); await drawer('dsh');
  assert.equal(await js('_agData.localModelCount'), 2);
  assert.equal(await js('document.querySelector(".ag-drawer [data-amodel]").value'), localRef);
  assert.equal(await js('_agData.agents.find(a=>a.key==="dsh").modelAutomatic'), true);
  assert.equal(await js('_agData.models[0].name'), localRef);
  assert.deepEqual(defaults.get(scope), initialDefault);
  mark('Multiple choices select the first available local model before Hub models without saving a preference');

  await js(`{const select=document.querySelector('.ag-drawer [data-amodel="dsh"]');
    select.value=${JSON.stringify(otherRef)};select.dispatchEvent(new Event('change',{bubbles:true}));}void 0;`);
  await until(`document.querySelector('.ag-drawer [data-amodel="dsh"]')?.value===${JSON.stringify(otherRef)}&&
    !document.querySelector('.ag-drawer [data-amodel="dsh"]').disabled&&_agData.agents.find(a=>a.key==='dsh')?.model===${JSON.stringify(otherRef)}`);
  const selectedDefault = defaults.get(scope);
  assert.equal(selectedDefault.selections.dsh.modelName, otherRef);
  await reload(); await drawer('dsh');
  assert.equal(await js('document.querySelector(".ag-drawer [data-amodel]").value'), otherRef);
  assert.equal(await js('_agData.agents.find(a=>a.key==="dsh").modelAutomatic===true'), false);
  assert.deepEqual(defaults.get(scope), selectedDefault);
  mark('A valid explicit local selection survives refresh even when another model is first');

  models.save({ models: [model] }); const explicitDefault = defaults.get(scope);
  assert.equal(explicitDefault.selections.dsh.unavailable, true);
  // Keep the old drawer open: the click must resolve fresh state on its own.
  assert.equal(await js('document.querySelector(".ag-drawer [data-amodel]").value'), otherRef);
  assert.equal(await js('_agData.agents.find(a=>a.key==="dsh").model'), otherRef);
  const beforeDeletedProbe = rpcCalls.length;
  await click('[data-adrawer-x]'); await click('[data-aprobe="fixture-local~dsh"]');
  await until('_agJobs["fixture-local~dsh"]?.state==="done"');
  assert.equal(await js('_agJobs["fixture-local~dsh"].ok'), true);
  assert.equal(rpcCalls.length, beforeDeletedProbe + 2);
  assert.equal(rpcCalls[beforeDeletedProbe].payload.llm.model, model.name);
  assert.deepEqual(defaults.get(scope), explicitDefault);
  await reload(); await drawer('dsh');
  assert.equal(await js('document.querySelector(".ag-drawer [data-amodel]").value'), localRef);
  assert.equal(await js('_agData.agents.find(a=>a.key==="dsh").modelAutomatic'), true);
  await screenshot('deleted-local-preference');
  mark('Deleting a saved model behind an open drawer still probes its replacement without refreshing or rewriting the saved preference');
  defaults.remove({ ...scope, agentId: 'dsh', expectedRevision: explicitDefault.revision });
  await js('hubOverrides={dsh:{model:"removed-hub-model",modelGone:true,modelEffective:""}};void 0;');
  await reload(); await drawer('dsh');
  assert.equal(await js('document.querySelector(".ag-drawer [data-amodel]").value'), localRef);
  assert.equal(await js('_agData.agents.find(a=>a.key==="dsh").modelAutomatic'), true);
  mark('Deleted local and Hub selections use the first available local model without changing saved preferences');

  const beforeAutomatic = defaults.get(scope);
  const replacement = models.save({ models: [model, other] }).myModels.find(row => row.name === other.name).id;
  await js('hubOverrides={};void 0;'); await reload(); await drawer('dsh');
  assert.equal(await js('document.querySelector(".ag-drawer [data-amodel]").value'), localRef);
  assert.equal(await js('_agData.agents.find(a=>a.key==="dsh").modelAutomatic'), true);
  models.save({ models: [other] }); expectedWireModel = other.name;
  assert.equal(await js('_agData.agents.find(a=>a.key==="dsh").modelEffective'), localRef);
  const beforeAutomaticProbe = rpcCalls.length;
  await click('[data-adrawer-x]'); await click('[data-aprobe="fixture-local~dsh"]');
  await until('_agJobs["fixture-local~dsh"]?.state==="done"');
  assert.equal(await js('_agJobs["fixture-local~dsh"].ok'), true);
  assert.equal(rpcCalls.length, beforeAutomaticProbe + 2);
  assert.equal(rpcCalls[beforeAutomaticProbe].payload.llm.model, other.name);
  assert.deepEqual(defaults.get(scope), beforeAutomatic);
  await reload(); await drawer('dsh');
  assert.equal(await js('document.querySelector(".ag-drawer [data-amodel]").value'), replacement);
  await screenshot('deleted-automatic-model');
  mark('Deleting an automatic choice behind an open drawer probes the new first model without refreshing or saving a preference');

  models.save({ models: [] });
  await js('hubOverrides={};hubModels=[{name:"hub-fixture-model",label:"Hub model fixture"}];allowHubProbe=true;void 0;');
  await reload(); await drawer('dsh');
  assert.equal(await js('document.querySelector(".ag-drawer [data-amodel]").value'), 'hub-fixture-model');
  const beforeRpc = rpcCalls.length;
  await click('[data-adrawer-x]'); await click('[data-aprobe="fixture-local~dsh"]');
  await until('_agJobs["fixture-local~dsh"]?.state==="done"');
  assert.equal(await js('_agJobs["fixture-local~dsh"].ok'), true);
  assert.equal(rpcCalls.length, beforeRpc);
  assert.equal(await js('hubCalls.filter(call=>call.route.endsWith("/agent-setup/probe")).length'), 1);
  await screenshot('single-hub-probe');
  mark('A sole Hub model remains selected and uses the server probe without private IPC');
  await js('hubModels=[];allowHubProbe=false;void 0;'); await reload(); await drawer('dsh');
  assert.equal(await js('document.querySelectorAll(".ag-drawer [data-amodel]").length'), 0);
  assert.match(await js('document.querySelector(".ag-drawer .ag-model").textContent'), /还没有能用的模型/);
  mark('An empty catalog reports model unavailability instead of inventing a default');
  const hubCalls = await js('hubCalls');
  assert.doesNotMatch(JSON.stringify(hubCalls), /local:model-|private-wire-|model-fixture|Synthetic private/);
  assert.deepEqual(report.networkRequests, []);
  report.errors = await js('errors'); assert.deepEqual(report.errors, []);
  report.privateRpcOperations = rpcCalls.map(call => call.op);
  report.hubProbeCount = hubCalls.filter(call => call.route.endsWith('/agent-setup/probe')).length;
  report.ok = true;
}).catch(async error => {
  report.errors.push(String(error.stack || error));
  if (win && !win.isDestroyed()) await screenshot('failure').catch(() => {});
}).finally(() => {
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: report.ok, cases: report.cases.length, errors: report.errors, report: path.join(out, 'report.json') }));
  if (win && !win.isDestroyed()) win.destroy();
  app.exit(report.ok ? 0 : 1);
});
