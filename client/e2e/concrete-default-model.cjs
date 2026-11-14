'use strict';
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE',
    'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  require('node:child_process').spawn(electron, [__filename, ...process.argv.slice(2)], { env, windowsHide: true, stdio: 'inherit' })
    .on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const assert = require('node:assert/strict');
  const out = path.resolve(process.argv[2] || path.join(__dirname, '../../outputs/concrete-default-model'));
  fs.mkdirSync(out, { recursive: true });
  app.disableHardwareAcceleration();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-default-picker-'));
  app.setPath('userData', profile);
  const report = { ok: false, cases: [], boundary: 'Actual Electron and production model controls with synthetic catalogs. No live model calls or business data.' };
  let win;
  const js = code => win.webContents.executeJavaScript(code, true).catch(error => { throw Error(error.message + '\nCode: ' + code.slice(0, 800)); });
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(code) {
    for (let i = 0; i < 150; i++) { if (await js(code)) return; await delay(20); }
    throw Error('Timeout: ' + code);
  }
  async function click(selector) {
    const p = await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect(),x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2);if(!e.contains(document.elementFromPoint(x,y)))throw Error('Occluded control');return{x,y}})()`);
    for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, ...p, button: 'left', clickCount: 1 });
    await delay(50);
  }
  async function run() {
    win = new BrowserWindow({ show: false, width: 1160, height: 850,
      webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_, done) => done({ cancel: true }));
    await win.loadFile(path.join(__dirname, 'fixtures/compact-chat-model.html'));
    await until('window.fixtureReady');
    // An old session has an empty preference but already knows its real model.
    await js("state.selection={name:'',model:{id:'vision',label:'GLM 5.3 Flash'}};controls.render();document.querySelector('#nchatInput').value='keep this draft';document.querySelector('#nchatInput').dispatchEvent(new Event('input',{bubbles:true}));");
    for (const adapter of ['pi', 'opencode', 'qwen', 'codex-harness', 'dsh', 'codex', 'claude']) {
      await js(`state.adapterId=${JSON.stringify(adapter)};soduWorkAPI.conversationSession.runtimeModels=async()=>({models:models.map(m=>({id:m.name,label:m.label}))});controls.render();void 0;`);
      await click('.nmodel-button');
      if (adapter === 'codex') {
        await until('!!document.querySelector("[data-native-list]")');
        await click('[data-native-list]');
      }
      await until('document.querySelectorAll("[data-model-name]").length===3');
      assert.equal(await js('document.querySelector("[data-model-name=vision]").getAttribute("aria-selected")'), 'true');
      assert.equal(await js(`document.querySelectorAll('[data-model-name=""]').length`), 0);
      await click('[data-model-close]');
    }
    assert.deepEqual(await js('selected'), [], 'opening old sessions must not mutate their model');
    assert.equal(await js('document.querySelector("#nchatInput").value'), 'keep this draft');
    await click('.nmodel-button'); await until('document.querySelectorAll("[data-model-name]").length===3');
    await click('[data-model-name=short]');
    assert.deepEqual(await js('selected'), [{ ref: 'isolated-chat', name: 'short' }]);
    assert.equal(await js('sent.length'), 0);
    report.cases.push('Seven runtime menus: resolved historical model checked; no empty choice; explicit switching and drafts preserved');

    await js(`window.originalModels=models;window.originalMyModels=SoduWorkAPI.myModels;
      models=[{name:'hub-first',label:'Hub 模型'},{name:'local:first',label:'本机优先模型',localOnly:true},
      {name:'local:second',label:'本机第二模型',localOnly:true}];
      state.adapterId='pi';state.selection={name:''};state.model=null;controls.render();void 0;`);
    await until("state.selection.name==='local:first'");
    assert.equal(await js('document.querySelector(".nmodel-button span").textContent'), '本机优先模型');
    await js("state.selection={name:'deleted-model',model:{id:'deleted-model'}};controls.render();void 0;");
    assert.equal(await js('controls.waitForAccess()'), true);
    assert.equal(await js('state.selection.name'), 'local:first');
    assert.equal(await js('document.querySelector(".nmodel-button span").textContent'), '本机优先模型');
    assert.equal(await js('document.querySelector("#nchatInput").value'), 'keep this draft');
    fs.writeFileSync(path.join(out, 'existing-chat-local-replacement.png'), (await win.webContents.capturePage()).toPNG());
    await js("state.selection={name:'local:second',model:models[2]};controls.render();void 0;");
    const selectedCount = await js('selected.length');
    assert.equal(await js('controls.waitForAccess()'), true);
    assert.equal(await js('selected.length'), selectedCount);
    await js("models=models.filter(row=>row.name!=='local:second');void 0;");
    assert.equal(await js('controls.waitForAccess()'), true);
    assert.equal(await js('state.selection.name'), 'local:first');
    await js("SoduWorkAPI.myModels=async()=>{throw Error('Secure storage unavailable')};void 0;");
    assert.equal(await js('controls.waitForAccess()'), false);
    assert.equal(await js('state.selection.name'), 'local:first');
    await js("state.selection={name:'hub-first',model:{id:'hub-first',label:'Hub 模型'}};SoduWorkAPI.myModels=async()=>({usable:models.filter(row=>row.localOnly),managedCatalogUnavailable:true});void 0;");
    assert.equal(await js('controls.waitForAccess()'), false);
    assert.equal(await js('state.selection.name'), 'hub-first');
    await js("state.selection={name:'local:first',model:models[1]};void 0;");
    assert.equal(await js('controls.waitForAccess()'), true);
    await js('models=originalModels;SoduWorkAPI.myModels=originalMyModels;void 0;');
    report.cases.push('Existing conversations replace confirmed deleted choices with first local; valid choices and drafts survive; storage errors and partial Hub catalogs never count as deletion');

    await js(`
      document.querySelector('main').style.display='none';
      document.body.insertAdjacentHTML('beforeend','<section class="compose-panel" style="display:block;position:static"><div class="cp-modelwrap" style="position:absolute;bottom:40px;left:160px"><button id="cpModelBtn" class="cp-modelbtn"><span id="cpModelName"></span></button><div id="cpModelPop" class="cp-modelpop"></div></div></section>');
      for(const file of ['workspace/workspace-shell.css','panels/panels-compose-model-picker.css']){const css=document.createElement('link');css.rel='stylesheet';css.href='../../components/'+file;document.head.append(css);}
      const style=document.createElement('style');style.textContent='#cpModelPop:not(.show){display:none}#cpModelPop.show{display:block}';document.head.append(style);
      window.adapter='pi';window.catalog={usable:models,defaultModel:'long-model',defaultModels:{pi:'vision',opencode:'short',qwen:'',dsh:'long-model','codex-harness':'short'},defaultModelErrors:{qwen:'Unavailable'},mediaUsable:{image:[{providerId:'image-service',name:'image-one',label:'Image One'}]}};
      window.changes=[];window.offline=false;window.slow=false;
      SoduWorkAPI.myModels=async()=>{if(offline)throw Error('Offline');if(slow)return new Promise(resolve=>window.finishCatalog=()=>resolve(structuredClone(catalog)));return structuredClone(catalog)};
      window.ComposeRuntime={value:()=>adapter,catalog:()=>[{id:adapter,modelMode:['codex','claude'].includes(adapter)?'account':'managed'}]};
      void 0;
    `);
    await js(fs.readFileSync(path.join(__dirname, '../core/model-choice.js'), 'utf8'));
    await js(fs.readFileSync(path.join(__dirname, '../components/panels/panels-compose-model-picker.js'), 'utf8'));
    await js("ComposeModelPicker.bind({api:()=>soduWorkAPI.conversationSession,onChange:x=>changes.push(x)});void 0;");
    await until("ComposeModelPicker.value().modelName==='long-model'");
    assert.equal(await js('document.querySelector("#cpModelName").textContent'), 'fixture-coding-large-model');
    await click('#cpModelBtn');
    assert.equal(await js(`document.querySelectorAll('[data-model=""]').length`), 0);
    assert.equal(await js('document.querySelector(".cp-mrow.on").dataset.model'), 'long-model');
    await click('[data-model=short]');
    await js('ComposeModelPicker.refresh(true)');
    assert.equal(await js('ComposeModelPicker.value().modelName'), 'short');
    await js("adapter='opencode';ComposeModelPicker.refresh()");
    assert.equal(await js('ComposeModelPicker.value().modelName'), 'long-model');
    await click('#cpModelBtn'); await click('[data-model=vision]');
    await js("adapter='codex-harness';ComposeModelPicker.refresh()");
    assert.equal(await js('ComposeModelPicker.value().modelName'), 'long-model');
    await js("adapter='dsh';ComposeModelPicker.refresh()");
    assert.equal(await js('ComposeModelPicker.value().modelName'), 'long-model');
    report.cases.push('New chats select the first available model regardless of Agent defaults and preserve manual selections across refresh and runtime switches');

    await js("adapter='qwen';ComposeModelPicker.refresh()");
    assert.equal(await js('ComposeModelPicker.ready()'), true);
    assert.equal(await js('ComposeModelPicker.value().modelName'), 'long-model');
    await click('#cpModelBtn'); await click('[data-model=vision]');
    assert.equal(await js('ComposeModelPicker.ready()'), true);
    await js('offline=true;ComposeModelPicker.refresh(true)');
    assert.equal(await js('ComposeModelPicker.value().modelName'), 'vision');
    await js("offline=false;adapter='pi';ComposeModelPicker.refresh()");
    await click('#cpModelBtn'); await click('[data-model="image::image-service::image-one"]');
    await js('ComposeModelPicker.refresh(true)');
    assert.equal(await js('ComposeModelPicker.value().modelName'), 'image::image-service::image-one');
    report.cases.push('Unavailable inherited defaults do not block a first model; failed lookup preserves selection; image choice remains modality-qualified');

    await js("slow=true;ComposeModelPicker.refresh(true);window.readyDone=false;ComposeModelPicker.ready().then(()=>readyDone=true);void 0;");
    await delay(100); assert.equal(await js('readyDone'), false);
    await js("slow=false;adapter='opencode';ComposeModelPicker.refresh();void 0;");
    await until('readyDone');
    await js('finishCatalog();void 0;');
    assert.equal(await js('ComposeModelPicker.value().modelName'), 'vision');
    await js("adapter='codex';ComposeModelPicker.refresh()");
    await click('#cpModelBtn');
    assert.equal(await js(`document.querySelectorAll('[data-native-model=""]').length`), 0);
    assert.equal(await js('ComposeModelPicker.value().modelName'), '', 'unknown account default must never become a managed model');
    await js("ComposeModelPicker.close();adapter='opencode';ComposeModelPicker.refresh()");
    await click('#cpModelBtn');
    report.cases.push('Send readiness waits for catalog; late previous-runtime response cannot overwrite current choice; native account isolation');
    assert.deepEqual(await js('errors'), []);
    report.ok = true;
  }
  app.whenReady().then(run).catch(error => { report.error = error.stack; }).finally(async () => {
    if (win && !win.isDestroyed()) {
      try { fs.writeFileSync(path.join(out, report.ok ? 'picker.png' : 'failure.png'), (await win.webContents.capturePage()).toPNG()); }
      catch (error) { report.captureError = error.message; }
      win.destroy();
    }
    try { fs.rmSync(profile, { recursive: true, force: true }); }
    catch (error) { report.cleanupError = error.message; report.ok = false; }
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report)); app.exit(report.ok ? 0 : 1);
  });
}
