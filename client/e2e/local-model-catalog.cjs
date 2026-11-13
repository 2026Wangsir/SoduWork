'use strict';

// Real model settings, API partitioning, desktop IPC and encryption use only a
// temporary profile and synthetic Hub. macOS uses Chromium's test keychain.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS']) delete env[key];
  const child = require('node:child_process').spawn(electron, [__filename, ...process.argv.slice(2)],
    { env, windowsHide: true, stdio: 'inherit' });
  const timer = setTimeout(() => child.kill(), 120000);
  child.on('exit', code => { clearTimeout(timer); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, ipcMain, safeStorage, net } = electron;
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const http = require('node:http'), assert = require('node:assert/strict');
  const { pathToFileURL } = require('node:url');
  const client = path.resolve(__dirname, '..'), output = process.argv[2];
  assert.ok(output && path.isAbsolute(output), 'Absolute evidence directory required');
  fs.mkdirSync(output, { recursive: true });
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-local-catalog-'));
  const profile = path.join(temp, 'profile'); fs.mkdirSync(profile);
  app.setPath('userData', profile); app.disableHardwareAcceleration();
  if (process.platform === 'darwin') app.commandLine.appendSwitch('use-mock-keychain');
  const report = { ok: false, cases: [], screenshots: [],
    keychain: process.platform === 'darwin' ? 'Chromium test keychain' : 'Platform safeStorage backend',
    boundary: 'Actual Electron model page, api.js, production local-model IPC and safeStorage encryption API; macOS test keychain, synthetic loopback Hub, native pointer clicks and Chromium typing. No real account, user profile, provider or model call; no system keychain permission validation.' };
  const key = 'synthetic-local-model-key', hubWrites = [], blocked = [], requests = [];
  const managed = { revision: 'fixture-1', providers: ['company-first', 'company-second'].map(id => ({
    id, name: id, baseUrl: 'https://fixture.invalid/v1', kind: 'openai-compat', keySet: true,
    modelNames: ['shared-model'], modelDefs: [{ name: 'shared-model', label: 'Shared model', modality: 'chat' }],
  })), myModels: [], usable: ['company-first', 'company-second'].map(providerId => ({
    providerId, name: 'shared-model', label: 'Shared model', keyFrom: 'org' })), mediaUsable: {} };
  let win, server, hub, localId;
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const js = code => win.webContents.executeJavaScript(code, true);
  const record = name => { report.cases.push(name); console.log('PASS ' + name); };
  async function until(expression) {
    for (let i = 0; i < 200; i++) { if (await js(expression)) return; await delay(40); }
    throw Error('Timed out: ' + expression);
  }
  async function click(selector) {
    await js(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'})`);
    await delay(30);
    const point = await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect();
      const x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2);
      if(e.disabled||!e.contains(document.elementFromPoint(x,y)))throw Error('Target is not clickable');return{x,y};})()`);
    for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, ...point, button: 'left', clickCount: 1 });
    await delay(40);
  }
  async function fill(selector, value) {
    await click(selector);
    assert.equal(await js(`document.activeElement===document.querySelector(${JSON.stringify(selector)})`), true);
    win.webContents.selectAll();
    await win.webContents.debugger.sendCommand('Input.insertText', { text: value });
    assert.equal(await js(`document.querySelector(${JSON.stringify(selector)}).value`), value);
  }
  async function shot(name) {
    const file = path.join(output, name + '.png');
    fs.writeFileSync(file, (await win.webContents.capturePage()).toPNG()); report.screenshots.push(file);
  }
  async function assertLocalCount(count) {
    assert.equal(await js('document.querySelectorAll(".md-model-row").length'), count);
    assert.equal(await js(`document.querySelector('[data-mdselect="${localId}"] .cfg-nav-meta em').textContent`), count + ' 模型');
    assert.equal(await js('document.querySelectorAll("[data-mdedit]").length'), count);
    assert.equal(await js('document.querySelector(".cfg-detail").innerText.includes("组织管理")'), false);
  }
  async function saved(revision) {
    await until(`_mdLoadState==='ready'&&!_mdDirty&&_mdData.localRevision>=${revision}`);
    await assertLocalCount(1);
  }
  async function startHub() {
    server = http.createServer(async (request, response) => {
      response.setHeader('Access-Control-Allow-Origin', '*');
      response.setHeader('Access-Control-Allow-Headers', '*');
      response.setHeader('Access-Control-Allow-Methods', 'GET,PUT,OPTIONS');
      response.setHeader('Content-Type', 'application/json');
      if (request.method === 'OPTIONS') { response.end('{}'); return; }
      requests.push({ method: request.method, path: request.url });
      if (request.url !== '/api/v1/my-models') { response.writeHead(404); response.end('{}'); return; }
      if (request.method === 'PUT') {
        let data = ''; for await (const chunk of request) data += chunk;
        hubWrites.push(JSON.parse(data));
        response.end('{"ok":true}'); return;
      }
      response.end(JSON.stringify(managed));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    hub = 'http://127.0.0.1:' + server.address().port;
  }
  app.whenReady().then(async () => {
    assert.equal(safeStorage.isEncryptionAvailable(), true, 'Encryption must be available; no plaintext fallback');
    await startHub();
    require('../main/local-model-ipc.cjs').install({ app, ipcMain, safeStorage });
    const store = require('../main/local-model-store.cjs');
    const preload = path.join(temp, 'preload.cjs');
    fs.writeFileSync(preload, `const {contextBridge,ipcRenderer}=require('electron'); let closeDeskWindowCalls=0;
      contextBridge.exposeInMainWorld('soduWorkAPI',{
        getHubConnection:async()=>({hub:${JSON.stringify(hub)},internalTest:true}),
        localModels:{get:()=>ipcRenderer.invoke('local-models-get'),save:input=>ipcRenderer.invoke('local-models-save',input),
          test:(id,name)=>ipcRenderer.invoke('local-models-test',id,name)},
        closeDeskWindow:()=>{closeDeskWindowCalls++},
        getCloseDeskWindowCalls:()=>closeDeskWindowCalls});`);
    const styles = ['theme/variables.css', 'components/panels/panels-schedules.css', 'components/panels/panels-agents.css',
      'components/panels/panels-connections.css', 'components/panels/model-capabilities.css',
      'components/workspace/workspace-shell.css', 'components/workspace/workspace-page-layout.css', 'desk-window.css',
      'theme/workspace-experience.css', 'theme/workspace-page-heads.css'];
    const scripts = ['core/api-work-plugins.js', 'api.js', 'components/panels/model-capabilities.js',
      'components/panels/model-catalog-editor.js', 'components/panels/panels-models.js'];
    const html = '<!doctype html><html data-desk-panel="workspace" data-workspace-view="models" data-theme="azure" data-skin="flat"><head><meta charset="utf-8">' +
      styles.map(file => '<link rel="stylesheet" href="' + file + '">').join('') + '</head><body><script>' +
      'window.errors=[];window.notice="";window.notices=[];window.pickerRefreshFailures=0;addEventListener("error",e=>errors.push(e.message));addEventListener("unhandledrejection",e=>errors.push(String(e.reason)));' +
      'const esc=v=>String(v??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(String.fromCharCode(34),"&quot;");' +
      'window.petSay=m=>{notice=m;notices.push(m)};window._humanErr=e=>e.message;window.ComposeModelPicker={refresh:async()=>{if(window.pickerRefreshFailures)throw Error("picker refresh failed")}};</script>' +
      scripts.map(file => '<script src="' + file + '"></script>').join('') + '<script>openModelsPanel();</script></body></html>';
    win = new BrowserWindow({ show: false, width: 1500, height: 1000, webPreferences: {
      preload, sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false,
      partition: 'local-model-catalog-' + require('node:crypto').randomUUID() } });
    const desk = pathToFileURL(path.join(client, 'desk.html')).href;
    win.webContents.session.protocol.handle('file', request => request.url === desk
      ? new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })
      : net.fetch(request.url, { bypassCustomProtocolHandlers: true }));
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (request, done) => {
      const allowed = new URL(request.url).origin === hub;
      if (!allowed) blocked.push(request.url);
      done({ cancel: !allowed });
    });
    await win.loadURL(desk); await until('_mdLoadState==="ready"');
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    await click('#mdAddInline'); localId = await js('document.querySelector("[data-pname]").dataset.pname');
    await fill('[data-pname]', 'Synthetic local service'); await fill('[data-purl]', 'http://127.0.0.1:1/v1');
    await fill('[data-pkey]', key); await click('[data-mdeditor] summary');
    await fill('[data-padd]', 'shared-model'); await fill('[data-mdlabel]', 'Local model'); await click('[data-madd]');
    await assertLocalCount(1); await js('window.pickerRefreshFailures=1'); await click('#mdSave'); await saved(1);
    assert.equal(await js('notices.some(message=>message.includes("模型配置已保存"))'), true);
    assert.equal(await js('notices.some(message=>message.includes("没存上"))'), false);
    await js('window.pickerRefreshFailures=0');
    assert.equal(store.get().myModels.length, 1);
    assert.equal(store.get().providers[0].modelDefs.length, 1, 'public execution catalog retains its definitions');
    assert.equal(store.get().usable.length, 1);
    const raw = fs.readFileSync(path.join(profile, 'local-models.secure.json'), 'utf8');
    assert.ok(JSON.parse(raw).cipher); assert.equal(raw.includes(key), false); assert.equal(raw.includes('shared-model'), false);
    record('Adding one local model saves one encrypted record and renders one editable row and count');

    await win.loadURL(desk); await until('_mdLoadState==="ready"');
    await click('[data-mdselect="' + localId + '"]'); await assertLocalCount(1);
    assert.equal(await js('document.querySelector("[data-pkey]").value'), '');
    await click('[data-mdedit]'); await fill('[data-mdlabel]', 'Edited local label'); await click('[data-madd]');
    assert.equal(await js('_mdMyModels.find(row=>row.localOnly).label'), 'Edited local label');
    await click('#mdSave'); await saved(2);
    assert.equal(store.get().myModels[0].label, 'Edited local label');
    record('Reload and same-ID editing retain one local row without treating its mirror as a duplicate');

    await click('[data-mdedit]'); await fill('[data-padd]', 'renamed-local-model'); await click('[data-madd]');
    await assertLocalCount(1);
    assert.equal(await js('document.querySelector(".md-model-list").textContent.includes("shared-model")'), false);
    await click('#mdSave'); await saved(3);
    assert.equal(store.get().myModels[0].name, 'renamed-local-model');
    await js('document.querySelector(".md-model-row").scrollIntoView({block:"center"})'); await delay(80);
    await shot('local-model-single-row');
    record('Renaming replaces the visible and persisted local ID without a stale organization row');

    for (const id of ['company-first', 'company-second']) {
      await click('[data-mdselect="' + id + '"]');
      assert.equal(await js('document.querySelectorAll(".md-model-row").length'), 1);
      assert.equal(await js('document.querySelectorAll("[data-mdedit]").length'), 0);
      assert.equal(await js('document.querySelector(".md-model-list").textContent.includes("Shared model")'), true);
    }
    record('Identical model names from separate Hub providers remain visible and organization-managed');

    await click('[data-mdselect="' + localId + '"]'); await click('[data-mdedit]');
    await fill('[data-mdlabel]', 'Draft for removed model');
    await js('window.removedEditor=document.querySelector("[data-mdeditor]");window.removedApply=removedEditor.querySelector("[data-madd]");');
    await click('[data-mdel]');
    assert.equal(await js('removedEditor.isConnected'), false);
    assert.equal(await js('_mdDrafts.size'), 0);
    await js('removedApply.click();removedEditor.querySelector("[data-padd]").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}));');
    assert.equal(await js('_mdMyModels.length'), 0, 'detached callbacks cannot reinsert a removed model during save');
    await until('_mdLoadState==="ready"&&!_mdDirty&&_mdData.localRevision>=4'); await assertLocalCount(0);
    assert.equal(store.get().myModels.length, 0);
    assert.equal(store.get().providers.length, 1);
    assert.equal(store.get().providers[0].keySet, true, 'model removal preserves its provider credential');
    await js(`closeModelsPanel();openModelsPanel({editor:true,providerId:${JSON.stringify(localId)}});`);
    await until('_mdLoadState==="ready"'); await assertLocalCount(0);
    assert.equal(await js('document.querySelector("[data-padd]").value'), '');
    await win.loadURL(desk); await until('_mdLoadState==="ready"');
    await click('[data-mdselect="' + localId + '"]'); await assertLocalCount(0);
    record('Deleting the edited model clears its draft, rejects detached callbacks during save and stays removed after reopening');

    for (const name of ['retained-model', 'removed-sibling']) {
      await click('[data-mdeditor] summary'); await fill('[data-padd]', name); await click('[data-madd]');
    }
    await click('#mdSave'); await until('_mdLoadState==="ready"&&!_mdDirty&&_mdData.localRevision>=5');
    await assertLocalCount(2);
    await click('[data-mdedit="' + localId + '|0"]'); await fill('[data-mdlabel]', 'Retained unsaved label');
    await click('[data-mdel="' + localId + '|1"]'); await saved(6);
    assert.equal(await js('document.querySelector("[data-padd]").value'), 'retained-model');
    assert.equal(await js('document.querySelector("[data-mdlabel]").value'), 'Retained unsaved label');
    assert.equal(await js(`_mdDrafts.get(${JSON.stringify(localId)}).original`), 'retained-model');
    await click('[data-madd]'); await click('#mdSave'); await saved(7);
    assert.equal(store.get().myModels[0].label, 'Retained unsaved label');
    record('Deleting another row preserves the current edit draft and its unsaved fields through save and reload');

    await click('[data-mdedit]'); await fill('[data-mdlabel]', 'Draft for removed provider');
    await click('[data-pdelete]');
    await js('window.providerEditor=document.querySelector("[data-mdeditor]");window.providerApply=providerEditor.querySelector("[data-madd]");');
    await click('[data-pdelete]');
    assert.equal(await js('providerEditor.isConnected'), false);
    assert.equal(await js(`_mdDrafts.has(${JSON.stringify(localId)})`), false);
    await js('providerApply.click()');
    assert.equal(await js('_mdMyModels.length'), 0);
    await until('_mdLoadState==="ready"&&!_mdDirty&&_mdData.localRevision>=8');
    assert.equal(store.get().providers.length, 0); assert.equal(store.get().myModels.length, 0);
    assert.equal(await js(`!!document.querySelector('[data-mdselect="${localId}"]')`), false);
    assert.equal(await js('window.soduWorkAPI.getCloseDeskWindowCalls()'), 0, 'confirmed provider removal must not close the workspace window');
    record('Confirmed provider removal clears its editor and credentials before persistence completes');

    assert.equal(hubWrites.length, 0, 'local-only changes must not write the Hub catalog');
    for (const body of hubWrites) {
      assert.equal(JSON.stringify(body).includes(key), false);
      assert.equal(JSON.stringify(body).includes(localId), false);
      assert.deepEqual(body.models, []); assert.deepEqual(body.keys, {});
      assert.deepEqual(body.providers.map(provider => provider.id), ['company-first', 'company-second']);
      assert.ok(!Object.keys(body).some(name => name.startsWith('local')));
    }
    assert.deepEqual(blocked, []); assert.deepEqual(await js('errors'), []);
    assert.ok(requests.every(request => request.path === '/api/v1/my-models'));
    record('Production API keeps local-only records out of Hub requests');
    report.ok = true; report.hubRequests = requests; report.hubWrites = hubWrites.length;
  }).catch(async error => {
    report.error = String(error.stack || error);
    if (win && !win.isDestroyed()) {
      report.renderer = await js('({errors,notice,state:typeof _mdLoadState==="string"?_mdLoadState:"missing"})').catch(() => null);
      await shot('failure').catch(() => {});
    }
  }).finally(async () => {
    win?.destroy();
    if (server) await new Promise(resolve => server.close(resolve));
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    fs.rmSync(temp, { recursive: true, force: true });
    console.log(JSON.stringify({ ok: report.ok, cases: report.cases.length, output, error: report.error }));
    app.exit(report.ok ? 0 : 1);
  });
}
