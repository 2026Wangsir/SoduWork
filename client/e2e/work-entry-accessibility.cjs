'use strict';
// Real production DOM/scripts, synthetic API/IPC, isolated profile and no network.
const electron = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS']) delete env[key];
  const child = require('node:child_process').spawn(electron, [__filename, ...process.argv.slice(2)], { env, stdio: 'inherit', windowsHide: true });
  const timer = setTimeout(() => child.kill(), 120000);
  child.on('exit', code => { clearTimeout(timer); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, session, net } = electron;
  const { fileURLToPath } = require('node:url');
  const output = process.argv[2];
  if (!output || !path.isAbsolute(output)) throw Error('Absolute evidence directory required');
  fs.mkdirSync(output, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-entry-a11y-'));
  app.setPath('userData', profile); app.disableHardwareAcceleration();
  const client = path.resolve(__dirname, '..');
  const report = { ok: false, checks: [], boundary: 'Isolated Chromium DOM behavior; no live Hub, user profile or physical mouse assertions.' };
  let win;
  const js = code => win.webContents.executeJavaScript(code, true);
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(code) {
    for (let i = 0; i < 100; i++) { if (await js(code)) return; await wait(20); }
    throw Error('Timed out: ' + code);
  }
  async function check(name, code, value) { const ok=value??await js(code); report.checks.push({name,ok}); fs.writeFileSync(path.join(output,'partial.json'),JSON.stringify(report,null,2)); }
  app.whenReady().then(async () => {
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_r, cb) => cb({ cancel: true }));
    session.defaultSession.protocol.handle('file', request => {
      if (path.basename(fileURLToPath(request.url.split('?')[0])) !== 'desk.html') return net.fetch(request.url, { bypassCustomProtocolHandlers: true });
      const mock = fs.readFileSync(path.join(__dirname, 'fixtures/page-audit-api.js'), 'utf8');
      const html = fs.readFileSync(path.join(client, 'desk.html'), 'utf8')
        .replace('<head>', '<head><script>' + mock + '\nsoduWorkAPI.workPreview.onComposerRefresh=()=>()=>{};soduWorkAPI.workPreview.hide=async()=>({ok:true});soduWorkAPI.distributionInfo=()=>({hubOrigin:"http://127.0.0.1:19999"});soduWorkAPI.readAloud={onStop:()=>()=>{}};</script>')
        .replace('<script src="desk-boot.js"></script>', '<script>fixtureInstallApi();</script><script src="desk-boot.js"></script>');
      return new Response(html, { headers: { 'content-type': 'text/html;charset=utf-8' } });
    });
    win = new BrowserWindow({ show: false, width: 1440, height: 1000, webPreferences: { contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } });
    await win.loadFile(path.join(client, 'desk.html'), { query: { panel: 'workspace', view: 'settings' } });
    await until('Boolean(window.fixtureReady)');
    await js("SoduWorkI18n.setLocale('zh-CN');void 0;");

    await js(`window.trigger=document.getElementById('windowMenu-file');trigger.focus();WorkEntrySheet.openTask({saveOnly:true});void 0;`);
    await until('Boolean(document.querySelector("#cpTitle"))');await wait(80);
    await js("document.querySelector('#cpTitle').focus();void 0;");
    const escaped=[];
    for(let i=0;i<30;i++){
      win.webContents.sendInputEvent({type:'keyDown',keyCode:'Tab'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Tab'});await wait(8);
      if(!await js('document.querySelector("#workEntryLayer").contains(document.activeElement)'))escaped.push(await js('document.activeElement.id||document.activeElement.tagName'));
    }
    report.modalEscapes=escaped;
    await check('Requirement modal retains keyboard focus','true',escaped.length===0);

    await js(`document.querySelector('[data-wes-close]').focus();void 0;`);
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'Tab',modifiers:['shift']});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Tab',modifiers:['shift']});await wait(20);
    await check('Shift Tab wraps to the final modal action',`document.querySelector('#workEntryLayer').contains(document.activeElement)&&document.activeElement!==document.querySelector('[data-wes-close]')`);
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});await wait(20);
    await check('Escape closes the modal and restores its trigger',`!document.querySelector('#workEntryLayer')&&document.activeElement===trigger`);
    await js(`WorkEntrySheet.openTask({saveOnly:true});void 0;`);await until('Boolean(document.querySelector("#cpTitle"))');
    report.titleInput=await js(`({maxLength:document.querySelector('#cpTitle').maxLength,html:document.querySelector('#cpTitle').outerHTML})`);
    await js(`window.createdPayloads=[];window.save=()=>{};Store.persistTask=async id=>{const i=tasks.findIndex(t=>t.id===id);createdPayloads.push({...tasks[i]});tasks[i]={...tasks[i],...TaskSync.taskPayload(tasks[i])};return true};
      document.querySelector('#cpTitle').value='Long title '+ 'x'.repeat(481);document.querySelector('#cpTitle').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#cpCreate').click();void 0;`);
    await wait(400);
    report.longTitle=await js(`({requests:createdPayloads.length,input:createdPayloads[0]?.title.length,receipt:document.querySelector('#wesResultMessage')?.textContent.length,phase:ComposeDraft.capture()?.phase,text:document.querySelector('#workEntryLayer')?.textContent.slice(-250)})`);
    await check('Oversized title is rejected before persistence','createdPayloads.length===0');

    await check('Rejected title remains fully editable',`document.querySelector('#cpTitle').value.length===492&&document.querySelector('#cpTitle').getAttribute('aria-invalid')==='true'&&!document.querySelector('#cpTitle').disabled`);
    await js(`document.querySelector('#cpTitle').value='x'.repeat(200);document.querySelector('#cpTitle').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#cpCreate').click();void 0;`);await wait(80);
    await check('Exactly 200 characters save with an accurate receipt',`createdPayloads.length===1&&document.querySelector('#wesResultMessage').textContent==='x'.repeat(200)`);
    await js(`WorkEntrySheet.close();WorkEntrySheet.openTask({saveOnly:true});void 0;`);await until('Boolean(document.querySelector("#cpTitle"))');
    await js(`Store.persistTask=async id=>{const i=tasks.findIndex(t=>t.id===id);tasks[i]={...tasks[i],title:'Canonical receipt title'};return true};document.querySelector('#cpTitle').value='Original submitted title';document.querySelector('#cpCreate').click();void 0;`);await wait(80);
    await check('Receipts display the canonical saved title',`document.querySelector('#wesResultMessage').textContent==='Canonical receipt title'`);
    // Save assertions above use an in-memory persistence boundary; retire those rows before unrelated locale refreshes.
    await js('tasks.length=0;fixtureTasks.length=0;void 0;');
    for(const locale of ['en-US','ja-JP','ko-KR','zh-CN']){
      await js(`WorkEntrySheet.close();SoduWorkI18n.setLocale(${JSON.stringify(locale)},{persist:false,broadcast:false});WorkEntrySheet.openTask({saveOnly:true});void 0;`);await wait(120);
      const hint=await js(`document.querySelector('#cpTitleLimit').textContent`);
      await check('Title limit is localized: '+locale,'true',locale==='zh-CN'?hint.includes('200'):hint.includes('200')&&!hint.includes('\u9700\u6c42\u6807\u9898'));
    }
    await js(`WorkEntrySheet.close();SoduWorkI18n.setLocale('zh-CN');window.inlineHost=document.createElement('div');document.body.appendChild(inlineHost);WorkEntrySheet.openTask({host:inlineHost});void 0;`);await wait(40);
    await check('Inline forms do not claim modal semantics',`document.querySelector('.wes-sheet').getAttribute('role')==='region'&&!document.querySelector('.wes-sheet').hasAttribute('aria-modal')`);
    await js(`document.getElementById('windowMenu-file').focus();void 0;`);
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'Tab'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Tab'});await wait(20);
    await check('Inline forms do not trap workspace navigation',`!document.querySelector('#workEntryLayer').contains(document.activeElement)`);
    await js(`WorkEntrySheet.close();inlineHost.remove();document.documentElement.dataset.deskPanel='add';WorkEntrySheet.openTask({saveOnly:true});void 0;`);await wait(40);
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});await wait(20);
    await check('Standalone creation stays open on Escape and is not modal',`!!document.querySelector('#workEntryLayer')&&!document.querySelector('.wes-sheet').hasAttribute('aria-modal')`);
    await js(`WorkEntrySheet.close();document.documentElement.dataset.deskPanel='workspace';void 0;`);
    await js('WorkEntrySheet.close();document.querySelector(".wes-result-dialog")?.close();WorkspaceHost.open("create",{newSession:true});void 0;');await wait(100);
    await js(`document.documentElement.dataset.theme='vivid';WorkspaceHost.open('history',{});void 0;`);
    report.layouts=[];
    for(const [width,height] of [[1466,907],[1280,720],[960,640]]){
      win.setContentSize(width,height);await js(`WorkEntrySheet.openTask({saveOnly:true});void 0;`);await wait(350);
      const layout=await js(`(()=>{const r=document.querySelector('.wes-sheet').getBoundingClientRect(),b=document.querySelector('#cpCreate').getBoundingClientRect();return {width:innerWidth,height:innerHeight,left:r.left,right:r.right,top:r.top,bottom:r.bottom,buttonBottom:b.bottom,buttonTop:b.top,overflow:document.documentElement.scrollWidth>innerWidth}})()`);
      report.layouts.push(layout);fs.writeFileSync(path.join(output,'layout-'+width+'.png'),(await win.webContents.capturePage()).toPNG());
      await check('Creation form stays within viewport '+width,'true',layout.left>=0&&layout.right<=layout.width+1&&layout.buttonBottom<=layout.height&&layout.buttonTop>=0&&!layout.overflow);
      await js('WorkEntrySheet.close();void 0;');
    }
    const start=Date.now();
    for(let i=0;i<30;i++){
      await js(`WorkEntrySheet.openTask({saveOnly:true});WorkEntrySheet.close();void 0;`);
    }
    report.reopenStress={cycles:30,elapsedMs:Date.now()-start,layers:await js(`document.querySelectorAll('.wes-layer,.wes-result-dialog,.wes-plugin-surface').length`)};
    await check('Repeated creation open/close leaves no mounted layers','true',report.reopenStress.layers===0);
    report.rendererErrors=await js('fixtureErrors');
    await check('No unhandled renderer errors','fixtureErrors.length===0');
    report.ok = report.checks.every(c=>c.ok);
  }).catch(error => { report.error = String(error.stack || error); process.exitCode = 1; }).finally(() => {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
    win?.destroy(); app.quit();
  });
  app.on('will-quit', () => {
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
    app.exit(report.ok ? 0 : 1);
  });
}
