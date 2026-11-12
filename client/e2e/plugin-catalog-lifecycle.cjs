'use strict';
// Exercise production renderer scripts with isolated data and synthetic IPC.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const electron = require('electron');
if (typeof electron === 'string') {
  const env = require('../scripts/start-client.cjs').cleanEnvironment(process.env);
  const child = require('node:child_process').spawn(electron, [__filename, ...process.argv.slice(2)],
    { env, windowsHide: true, stdio: 'inherit' });
  const timer = setTimeout(() => child.kill(), 90000);
  child.on('exit', code => { clearTimeout(timer); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, session, net } = electron;
  const { fileURLToPath } = require('node:url');
  const output = process.argv[2];
  if (!output || !path.isAbsolute(output)) throw Error('Absolute evidence directory required');
  fs.mkdirSync(output, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-plugin-lifecycle-'));
  app.setPath('userData', profile); app.disableHardwareAcceleration();
  const client = path.resolve(__dirname, '..');
  const report = { ok: false, checks: [], observations: {},
    boundary: 'Production desktop renderer and plugin API; synthetic plugin storage, isolated profile, no network or live model.' };
  let win;
  const js = code => win.webContents.executeJavaScript('(async()=>{' + code + '})()', true);
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(code) {
    for (let i = 0; i < 150; i++) { if (await js('return (' + code + ')')) return; await pause(20); }
    throw Error('Timed out: ' + code);
  }
  async function check(name, code) {
    const actual = await js('return (' + code + ')');
    report.checks.push({ name, ok: actual === true, actual });
  }
  app.whenReady().then(async () => {
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
      (_request, done) => done({ cancel: true }));
    session.defaultSession.protocol.handle('file', request => {
      if (path.basename(fileURLToPath(request.url.split('?')[0])) !== 'desk.html') {
        return net.fetch(request.url, { bypassCustomProtocolHandlers: true });
      }
      const mock = fs.readFileSync(path.join(__dirname, 'fixtures/page-audit-api.js'), 'utf8');
      const html = fs.readFileSync(path.join(client, 'desk.html'), 'utf8')
        .replace('<head>', '<head><script>' + mock + '\nsoduWorkAPI.workPreview.onComposerRefresh=()=>()=>{};soduWorkAPI.workPreview.hide=async()=>({ok:true});soduWorkAPI.distributionInfo=()=>({hubOrigin:"http://127.0.0.1:19999"});soduWorkAPI.readAloud={onStop:()=>()=>{}};</script>')
        .replace('<script src="desk-boot.js"></script>',
          '<script>window.lifecycleApi=SoduWorkAPI;fixtureInstallApi();</script><script src="desk-boot.js"></script>');
      return new Response(html, { headers: { 'content-type': 'text/html;charset=utf-8' } });
    });
    win = new BrowserWindow({ show: false, width: 1400, height: 1000,
      webPreferences: { contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } });
    await win.loadFile(path.join(client, 'desk.html'), { query: { panel: 'workspace', view: 'create' } });
    await until('Boolean(window.fixtureReady)');
    await js(`
      window.pluginRows=[]; window.pluginEvents=[]; window.pickers=[]; window.savedPluginDrafts=[];
      addEventListener('soduwork:plugins-changed',e=>pluginEvents.push(structuredClone(e.detail)));
      soduWorkAPI.personalPlugins.create=async body=>{
        const plugin={pluginId:'local:lifecycle-fixture',name:'Lifecycle fixture',personal:true,enabled:true,inputs:[],...body};
        pluginRows.push(plugin);return {ok:true,plugin};
      };
      soduWorkAPI.personalPlugins.setEnabled=async(id,enabled)=>{
        const plugin=pluginRows.find(row=>row.pluginId===id);plugin.enabled=enabled;return {ok:true,plugin};
      };
      soduWorkAPI.personalPlugins.remove=async id=>{
        if(window.failPluginDelete)throw Error('Synthetic deletion failed');
        pluginRows=pluginRows.filter(row=>row.pluginId!==id);return {ok:true};
      };
      fixtureOverrides.pluginCatalog=async()=>({items:structuredClone(pluginRows),personalComplete:true});
      window.makePicker=(catalog=()=>SoduWorkAPI.pluginCatalog())=>{
        const host=document.createElement('div'),input=document.createElement('textarea');
        host.className='cp-box';host.append(input);document.body.append(host);
        input.value='Keep my ordinary message';
        const index=pickers.length;
        const picker=ChatPluginMention.create({input,host,catalog,
          onChange:()=>{if(pickers[index])savedPluginDrafts[index]=pickers[index].picker.draft();}});
        pickers.push({picker,host,input});return picker;
      };
      fixtureErrors.length=0;
      await lifecycleApi.createPluginDraft({});
      await lifecycleApi.setPersonalPluginEnabled('local:lifecycle-fixture',false);
      await lifecycleApi.setPersonalPluginEnabled('local:lifecycle-fixture',true);
      await makePicker().select('local:lifecycle-fixture',()=>true,{keepText:true});
      await makePicker().select('local:lifecycle-fixture',()=>true,{keepText:true});
      window.savedBeforeDelete=pickers[0].picker.draft();
      await lifecycleApi.deletePersonalPlugin('local:lifecycle-fixture');
    `);
    await pause(80);
    report.observations.lifecycleErrors = await js('return fixtureErrors.slice()');
    await check('plugin mutations do not call an undefined shell renderer',
      '!fixtureErrors.some(message=>message.includes("renderApps"))');
    await check('successful deletion clears both mounted composer selections and chips',
      'pickers.every(row=>row.picker.selected().length===0&&!row.host.querySelector(".nplugin-chip[data-kind=plugin]"))');
    await check('plugin deletion persists clean drafts while retaining ordinary text',
      'pickers.every((row,i)=>row.input.value==="Keep my ordinary message"&&savedPluginDrafts[i]?.length===0)');
    await check('deleted plugin does not reach the next ordinary turn',
      '(await pickers[0].picker.resolve("conversation","","Keep my ordinary message")).items.length===0');
    await js('makePicker().restore(savedBeforeDelete);');
    await pause(60);
    await check('restoring a stale draft does not resurrect the deleted plugin',
      'pickers[2].picker.selected().length===0');
    await js(`await lifecycleApi.createPluginDraft({pluginId:'local:retained-fixture',name:'Retained fixture'});
      await pickers[0].picker.select('local:retained-fixture',()=>true,{keepText:true});
      window.failPluginDelete=true;
      try{await lifecycleApi.deletePersonalPlugin('local:retained-fixture');}catch(_){}
      window.failPluginDelete=false;`);
    await check('a failed deletion keeps the selected plugin and draft',
      'pickers[0].picker.selected().some(row=>row.pluginId==="local:retained-fixture")');
    await js(`await lifecycleApi.setPersonalPluginEnabled('local:retained-fixture',false);`);
    await pause(30);
    await check('disabled plugins remain visible and cannot be silently submitted as ordinary text',
      `pickers[0].picker.selected().length===1 && await pickers[0].picker.resolve('chat','','text').then(()=>false,()=>true)`);
    await js(`await lifecycleApi.setPersonalPluginEnabled('local:retained-fixture',true);`);
    await pause(30);
    await check('re-enabled plugins remain usable with their selected identity',
      `(await pickers[0].picker.resolve('chat','','text')).items[0]?.pluginId==='local:retained-fixture'`);
    await js(`fixtureOverrides.pluginCatalog=async()=>({items:[],personalComplete:false});
      dispatchEvent(new CustomEvent('soduwork:plugins-changed',{detail:{}}));`);
    await pause(30);
    await check('partial catalogs do not erase saved personal plugin selections',
      'pickers[0].picker.selected().length===1 && savedPluginDrafts[0].length===1');
    await js(`window.mixedRestorePicker=makePicker(async()=>({personalComplete:false,
      items:[{pluginId:'enterprise-a',name:'Enterprise A',installed:true,organizationWide:true}]}));
      mixedRestorePicker.restore([{pluginId:'enterprise-a'},
        {pluginId:'local:offline-fixture',inputValues:{retained:'value'}}]);`);
    await pause(30);
    await check('mixed draft restoration retains personal parameters through a partial catalog',
      `mixedRestorePicker.draft().length===2 &&
        mixedRestorePicker.draft().find(row=>row.pluginId==='local:offline-fixture')?.inputValues.retained==='value' &&
        mixedRestorePicker.selected().find(row=>row.pluginId==='enterprise-a')?.name==='Enterprise A'`);
    await js(`fixtureOverrides.pluginCatalog=async()=>{throw Error('Synthetic catalog unavailable');};
      dispatchEvent(new CustomEvent('soduwork:plugins-changed',{detail:{}}));`);
    await pause(30);
    await check('failed catalogs preserve drafts for retry', 'pickers[0].picker.selected().length===1');
    await js(`fixtureOverrides.pluginCatalog=async()=>({items:structuredClone(pluginRows),personalComplete:true});
      window.latePicker=makePicker(()=>new Promise(resolve=>window.finishLateCatalog=resolve));
      window.lateSelection=latePicker.select('local:retained-fixture',()=>true,{keepText:true}).catch(()=>null);`);
    await until('typeof finishLateCatalog === "function"');
    await js(`window.oldPluginRows=structuredClone(pluginRows);
      await lifecycleApi.deletePersonalPlugin('local:retained-fixture');
      finishLateCatalog({items:oldPluginRows,personalComplete:true});await lateSelection;`);
    await check('a delayed pre-deletion catalog cannot reselect a removed plugin',
      'latePicker.selected().length===0 && pickers[0].picker.selected().length===0');
    await js(`window.destroyedPicker=makePicker(()=>new Promise(resolve=>window.finishDestroyedCatalog=resolve));
      window.destroyedSelection=destroyedPicker.select('local:late-fixture',()=>true,{keepText:true}).catch(()=>null);`);
    await until('typeof finishDestroyedCatalog === "function"');
    await js(`destroyedPicker.destroy();window.savedAfterDestroy=JSON.stringify(savedPluginDrafts);
      finishDestroyedCatalog({items:[{pluginId:'local:late-fixture',personal:true,enabled:true}],personalComplete:true});
      await destroyedSelection;`);
    await check('destroyed composers reject late catalog publication',
      'destroyedPicker.selected().length===0 && JSON.stringify(savedPluginDrafts)===savedAfterDestroy');
    await js(`window.ordinaryReads=0;window.ordinaryPicker=makePicker(()=>{ordinaryReads++;throw Error('Unexpected ordinary catalog read');});`);
    await check('ordinary text sends do not wait for the plugin catalog',
      `(await ordinaryPicker.resolve('chat','','Ordinary text')).items.length===0 && ordinaryReads===0`);
    await js(`pickers.forEach(row=>row.picker.destroy());
      window.burstReads=0;window.holdBurst=false;window.pendingBurst=[];
      window.burstItem={pluginId:'local:burst-fixture',name:'Burst fixture',personal:true,enabled:true};
      window.burstPicker=makePicker(()=>{burstReads++;
        return holdBurst?new Promise((resolve,reject)=>pendingBurst.push({resolve,reject})):
          Promise.resolve({items:[burstItem],personalComplete:true});});
      await burstPicker.select(burstItem.pluginId,()=>true,{keepText:true});
      holdBurst=true;burstReads=0;
      for(let i=0;i<100;i++)dispatchEvent(new CustomEvent('soduwork:plugins-changed',{detail:{}}));`);
    await until('pendingBurst.length===1');
    await check('a hundred catalog notifications coalesce into one active request', 'burstReads===1');
    await js(`dispatchEvent(new CustomEvent('soduwork:plugins-changed',{detail:{}}));
      pendingBurst.shift().reject(Error('Catalog invalidated while pending'));`);
    await until('pendingBurst.length===1 && burstReads===2');
    await js(`pendingBurst.shift().resolve({items:[burstItem],personalComplete:true});`);
    await pause(30);
    await check('one invalidated request retries once without losing the selected plugin',
      'burstReads===2 && burstPicker.selected()[0]?.pluginId===burstItem.pluginId');
    await js('fixtureErrors.length=0;document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));');
    report.observations.syntheticEscapeErrors = await js('return fixtureErrors.slice()');
    await check('non-Element Escape does not throw from read-aloud controls',
      '!fixtureErrors.some(message=>message.includes("closest"))');
    await js('fixtureErrors.length=0;pickers.at(-1).input.focus();');
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'ESC' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'ESC' });
    await pause(30);
    await check('real keyboard Escape remains error-free', 'fixtureErrors.length===0');
    report.ok = report.checks.every(row => row.ok);
  }).catch(async error => {
    report.error = String(error.stack || error);
    if (win && !win.isDestroyed()) report.rendererErrors = await js('return window.fixtureErrors || []').catch(() => []);
  }).finally(() => {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
    if (win && !win.isDestroyed()) win.destroy();
    app.exit(report.ok ? 0 : 1);
  });
}
