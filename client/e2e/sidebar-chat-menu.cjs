'use strict';
// Real Electron IPC/Session/SDK -> TCP Hub -> deterministic OpenAI provider.
// The provider's semantic outputs are fixtures; no paid model or user profile is used.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const electron = require('electron');
const client = path.resolve(__dirname, '..');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await read(); if (value) return value; await delay(50); }
  throw Error('Timed out: ' + label);
}
async function json(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(15000) });
  const body = await response.json();
  return { status: response.status, body };
}
function stop(process) {
  if (!process || process.exitCode !== null || process.signalCode !== null) return;
  if (global.process.platform === 'win32') execFileSync('taskkill.exe', ['/PID', String(process.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  else process.kill('SIGKILL');
}
async function portClosed(url) {
  const net = require('node:net'), target = new URL(url);
  return new Promise(resolve => {
    const socket = net.connect({ host: target.hostname, port: Number(target.port) });
    socket.once('connect', () => { socket.destroy(); resolve(false); });
    socket.once('error', () => { socket.destroy(); resolve(true); });
    socket.setTimeout(500, () => { socket.destroy(); resolve(false); });
  });
}

if (typeof electron === 'string') {
  (async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-personal-quota-'));
    const log = fs.openSync(path.join(root, 'hub.log'), 'w');
    const python = process.env.SODUWORK_TEST_PYTHON || 'python';
    const hub = spawn(python, ['-B', path.join(client, '../hub-backend/tests/personal_model_quota_hub.py'), '--root', root],
      { cwd: root, windowsHide: true, stdio: ['pipe', log, log], env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    let native, nativeLog, ready, report = { ok: false, root, cases: [] };
    try {
      await until(() => {
        if (hub.exitCode !== null) throw Error('Hub fixture exited: ' + hub.exitCode);
        return fs.existsSync(path.join(root, 'ready.json'));
      }, 'isolated Hub readiness', 45000);
      ready = JSON.parse(fs.readFileSync(path.join(root, 'ready.json'), 'utf8'));
      const env = { ...process.env };
      for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE',
        'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
      nativeLog = fs.openSync(path.join(root, 'electron.log'), 'w');
      native = spawn(electron, [__filename, root], { cwd: client, windowsHide: true, env, stdio: ['ignore', nativeLog, nativeLog] });
      await until(() => native.exitCode !== null || native.signalCode !== null, 'Electron E2E completion', 300000);
      report = JSON.parse(fs.readFileSync(path.join(root, 'electron-report.json'), 'utf8'));
      assert.equal(native.exitCode, 0, report.error || 'Electron failed');
      assert.equal(report.ok, true, report.error);
    } catch (error) { report.ok = false; report.error = String(error.stack || error); }
    finally {
      try { stop(native); } catch (error) { report.ok = false; report.cleanupError = String(error); }
      if (nativeLog !== undefined) fs.closeSync(nativeLog);
      if (ready && hub.exitCode === null) {
        try { await json(ready.hub + '/__fixture__/shutdown', { method: 'POST', headers: { 'x-fixture-key': ready.controlKey } }); } catch {}
      }
      hub.stdin.end();
      try { await until(() => hub.exitCode !== null || hub.signalCode !== null, 'Hub shutdown', 10000); }
      catch (error) { stop(hub); report.ok = false; report.cleanupError = String(error); }
      fs.closeSync(log);
      report.cleanup = { hubExit: hub.exitCode, electronExit: native?.exitCode,
        hubPortClosed: ready ? await portClosed(ready.hub) : true,
        providerPortClosed: ready ? await portClosed(ready.provider) : true };
      const aliveOwned = () => (report.ownedElectronPids || []).filter(pid => {
        try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
      });
      try { await until(() => aliveOwned().length === 0, 'owned Electron processes exit', 10000); }
      catch (error) { report.ok = false; report.cleanupError = String(error); }
      report.cleanup.remainingOwnedElectronPids = aliveOwned();
      if (hub.exitCode !== 0 || !report.cleanup.hubPortClosed || !report.cleanup.providerPortClosed) report.ok = false;
      const hubLog = fs.readFileSync(path.join(root, 'hub.log'), 'utf8');
      if (/Traceback \(most recent call last\)|ERROR:.*Exception in ASGI/.test(hubLog)) {
        report.ok = false; report.hubError = 'Uncaught Hub error; inspect hub.log';
      }
      fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
      console.log(JSON.stringify({ ok: report.ok, cases: report.cases?.length || 0, root, error: report.error, cleanup: report.cleanup }));
      process.exitCode = report.ok ? 0 : 1;
    }
  })().catch(error => { console.error(error.stack); process.exitCode = 1; });
 } else {
  const { app, BrowserWindow, ipcMain, session } = electron;
  const root = path.resolve(process.argv[2]);
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('soduwork-personal-quota-'));
  const ready = JSON.parse(fs.readFileSync(path.join(root, 'ready.json'), 'utf8'));
  const appRoot = path.join(root, 'soduwork-account-five-b29');
  const profile = path.join(appRoot, 'profile'), workspace = path.join(appRoot, 'workspace');
  for (const dir of [profile, workspace, path.join(appRoot, 'home')]) fs.mkdirSync(dir, {recursive:true});
  process.env.SODUWORK_USER_DATA=profile; process.env.SODUWORK_TEST_HUB_URL=ready.hub;
  app.setPath('userData',profile);app.setPath('home',path.join(appRoot,'home'));
  app.setPath('documents',workspace);app.setPath('downloads',path.join(appRoot,'home'));
  for (const key of ['appData','sessionData','temp','desktop','logs']) {
    const dir=path.join(appRoot,key);fs.mkdirSync(dir,{recursive:true});app.setPath(key,dir);
  }
  app.disableHardwareAcceleration();app.setAppPath(client);
  fs.writeFileSync(path.join(profile,'autostart-initialized'),'isolated B29 QA');
  fs.writeFileSync(path.join(profile,'chat-config.json'),JSON.stringify({workDir:workspace,mode:'readonly'}));
  fs.writeFileSync(path.join(profile,'desk-flags.json'),JSON.stringify({dock:false,pet:false,tray:false}));
  const report={ok:false,root,cases:[],errors:[],screenshots:[],requests:[],geometry:[],
    boundary:'Unmodified production main.js, preload.js and desk.html; real auth, conversation IPC and original Pi engine/SDK and TCP Hub with isolated SQLite. Deterministic model provider, synthetic account and temporary profile. OS startup, shortcuts, computer-use, Runner and update installation disabled in test entry only. Native mouse/keyboard events drive menus and rename; no replaced renderer HTML or chat handlers.'};
  report.sources=Object.fromEntries(['main.js','preload.js','desk.html','components/workspace/workspace-chat-list.js','components/workspace/workspace-navigation.css','e2e/sidebar-chat-menu.cjs'].map(file=>[file,require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(client,file))).digest('hex')]));
  report.runtime={electron:process.versions.electron,platform:process.platform};
  let win;
  const flush=()=>fs.writeFileSync(path.join(root,'electron-report.json'),JSON.stringify(report,null,2));
  const mark=name=>{report.cases.push(name);flush();console.log('PASS '+name);};
  const js=async code=>{const r=await win.webContents.executeJavaScript(`(async()=>{try{return {ok:true,value:await eval(${JSON.stringify(code)})}}catch(error){return {ok:false,error:String(error.stack||error)}}})()`,true);if(!r.ok)throw Error(r.error);return r.value;};
  const wait=(code,label=code,ms=30000)=>until(()=>js(code),label,ms);
  const nativePoint=p=>({x:Math.round(p.x*win.webContents.getZoomFactor()),y:Math.round(p.y*win.webContents.getZoomFactor())});
  async function click(selector){
    await wait(`!!document.querySelector(${JSON.stringify(selector)})`);
    await js(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'nearest'})`);
    await win.webContents.capturePage();
    const hover=await js(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
    win.webContents.sendInputEvent({type:'mouseMove',...nativePoint(hover)});await delay(100);await win.webContents.capturePage();
    const point=await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect();const x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2);if(!e.contains(document.elementFromPoint(x,y)))throw Error('Obscured '+${JSON.stringify(selector)});return{x,y}})()`);
    win.webContents.sendInputEvent({type:'mouseMove',...nativePoint(point)});
    for(const type of ['mouseDown','mouseUp'])win.webContents.sendInputEvent({type,...nativePoint(point),button:'left',clickCount:1});
    await delay(80);
  }
  function key(keyCode,modifiers=[]){for(const type of ['keyDown','keyUp'])win.webContents.sendInputEvent({type,keyCode,modifiers});}
  async function fill(selector,value){for(let attempt=0;attempt<3;attempt++){await click(selector);await wait(`document.activeElement===document.querySelector(${JSON.stringify(selector)})`,'input focus');key('A',['control']);await win.webContents.insertText(value);await delay(100);if(await js(`document.querySelector(${JSON.stringify(selector)})?.value===${JSON.stringify(value)}`))return;}throw Error('Input did not retain text: '+selector);}
  async function shot(name){await win.webContents.capturePage();await delay(100);const file=path.join(root,name+'.png');fs.writeFileSync(file,(await win.webContents.capturePage()).toPNG());report.screenshots.push(file);flush();}
  async function menuGeometry(name){
    const value=await js(`(()=>{const menu=document.querySelector('.ws-chat-menu:not([hidden])'),r=menu.getBoundingClientRect();const points=[...menu.querySelectorAll('[role=menuitem]:not([hidden])')].flatMap(e=>{const b=e.getBoundingClientRect();return [b.left+3,b.left+b.width/2,b.right-3].map(x=>({x,y:b.top+b.height/2,hit:e.contains(document.elementFromPoint(x,b.top+b.height/2))}))});return{rect:{left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height},viewport:{width:innerWidth,height:innerHeight},points,focused:menu.contains(document.activeElement)}})()`);
    report.geometry.push({name,...value});flush();return value;
  }
  async function openMenu(id){const selector=`.ws-chat-row:has([data-chat-id="${id}"]) .ws-chat-more`;await click(selector);await wait(`!!document.querySelector('.ws-chat-menu:not([hidden])')`);return selector;}
  function visibleGeometry(value){return value.rect.left>=0&&value.rect.top>=0&&value.rect.right<=value.viewport.width&&value.rect.bottom<=value.viewport.height&&value.points.every(p=>p.hit);}
  async function resizeSidebar(width){
    const r=await js(`(()=>{const e=document.querySelector('#wsResizer'),r=e.getBoundingClientRect();return{x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),width:document.querySelector('.ws-side').getBoundingClientRect().width}})()`);
    win.webContents.sendInputEvent({type:'mouseMove',x:r.x,y:r.y});win.webContents.sendInputEvent({type:'mouseDown',x:r.x,y:r.y,button:'left',clickCount:1});
    win.webContents.sendInputEvent({type:'mouseMove',x:Math.round(r.x+width-r.width),y:r.y});win.webContents.sendInputEvent({type:'mouseUp',x:Math.round(r.x+width-r.width),y:r.y,button:'left',clickCount:1});await delay(100);
  }
  (async()=>{
    require('./fixtures/full-client-isolation.cjs').install({app,electron,root:appRoot,workspace,client,report});
    require('./fixtures/full-client-inprocess-runtime.cjs').install({client,report});
    app.setLoginItemSettings=()=>{throw Error('Autostart disabled in isolated QA')};
    electron.globalShortcut.register=()=>false;electron.shell.openExternal=async()=>{throw Error('External navigation disabled')};
    require('../main/runner-runtime').install=()=>{
      ipcMain.handle('runner-status',()=>({running:false,connected:false,state:'stopped',capabilityGrants:[]}));
      for(const channel of ['runner-configure','runner-capability-set','runner-component-confirm'])ipcMain.handle(channel,()=>({ok:false,state:'stopped'}));
    };
    require('../main/client-updater').install=()=>{
      ipcMain.handle('client-update-status',()=>({state:'idle',phase:'idle',currentVersion:app.getVersion()}));
      for(const channel of ['client-update-check','client-update-install','client-update-resolve'])ipcMain.handle(channel,()=>({ok:false,error:'disabled in isolated QA'}));
    };
    app.on('browser-window-created',(_event,w)=>{
      w.show=()=>{};w.showInactive=()=>{};w.focus=()=>{};w.webContents.setBackgroundThrottling(false);
      w.webContents.on('console-message',(_e,details)=>{if(details?.level==='error')report.errors.push(details.message);});
    });
    await app.whenReady();
    session.defaultSession.webRequest.onCompleted({urls:['http://*/*','https://*/*']},r=>report.requests.push({path:new URL(r.url).pathname,status:r.statusCode}));
    process.argv=[process.argv[0],client];
    require('../main.js');
    ipcMain.removeHandler('work-root-default');ipcMain.handle('work-root-default',()=>workspace);
    await until(()=>{win=BrowserWindow.getAllWindows().find(w=>/\/desk\.html(?:[?#]|$)/.test(w.webContents.getURL()));return win;},'production desk window',60000);
    win.setContentSize(1100,760);
    await wait(`document.querySelector('#soduWorkClientAuthGate')?.checkVisibility()`, 'production login gate',45000);
    await click('[data-auth-mode=password]');await delay(600);await fill('#soduWorkAuthAccount',ready.account);await fill('#soduWorkAuthPassword',ready.password);await click('#soduWorkClientAuthGate [type=submit]');
    await wait(`!document.querySelector('#soduWorkClientAuthGate')?.checkVisibility() && !!document.querySelector('#wsProjectAdd')`,'authenticated production workspace',45000);
    mark('full production desktop login to isolated real Hub');
    const opened=await js(`soduWorkAPI.conversationSession.open({adapterId:'pi',modelName:'platform-model',cwd:${JSON.stringify(workspace)}})`);
    assert.equal(opened.ok,true,JSON.stringify(opened));
    const sent=await js(`soduWorkAPI.conversationSession.send(${JSON.stringify(opened.ref)},'B29 sidebar menu verification',[],{})`);assert.equal(sent.ok,true,JSON.stringify(sent));
    await wait(`document.querySelectorAll('.ws-chat-row').length>0`,'real session history row',60000);
    await js(`soduWorkAPI.conversationSession.renameHistory(${JSON.stringify(opened.sessionId)},'B29 original conversation')`);
    await delay(300);report.chatId=opened.sessionId;mark('original Pi session and persistent conversation history');
    for(let i=0;i<10;i++){
      await click('#wsProjectAdd');await fill('#wsProjectName','B29 project '+String(i).padStart(2,'0'));await click('.ws-project-save');await wait(`!document.querySelector('.ws-project-dialog[open]')`);
    }
    await openMenu(opened.sessionId);await click('.ws-chat-menu:not([hidden]) .ws-chat-move');
    await wait(`!!document.querySelector('.ws-project-move-dialog[open]')`);
    await js(`(()=>{const e=[...document.querySelectorAll('.ws-move-option')].find(e=>e.textContent.includes('B29 project 09'));if(!e)throw Error('Missing project');e.dataset.b29Target='move'})()`);
    await click('[data-b29-target=move]');await wait(`!!document.querySelector('#wsProjectsList .ws-chat-row')`);
    mark('conversation moved into a project with real sidebar controls');
    await resizeSidebar(168);await openMenu(opened.sessionId);
    const initial=await menuGeometry('narrow-sidebar-bottom');await shot('menu-narrow-bottom');
    if(process.env.SODUWORK_B29_EXPECT_FAILURE==='1'){
      assert.equal(visibleGeometry(initial),false,'Baseline must reproduce clipped menu');mark('baseline reproduces clipped native menu hit targets');report.ok=true;return;
    }
    assert.ok(visibleGeometry(initial),JSON.stringify(initial));assert.equal(initial.focused,true);mark('minimum sidebar bottom menu visible and all actions hit-testable');
    key('Escape');await wait(`!document.querySelector('.ws-chat-menu:not([hidden])')`);assert.equal(await js(`document.activeElement.matches('.ws-chat-more')`),true);mark('Escape dismisses menu and restores trigger focus');
    await openMenu(opened.sessionId);await click('#wsGlobalSearch');await wait(`!document.querySelector('.ws-chat-menu:not([hidden])')`);key('Escape');await delay(100);mark('outside click dismisses menu');
    await openMenu(opened.sessionId);await click('.ws-chat-menu:not([hidden]) .ws-chat-rename');
    await wait(`!!document.querySelector('.ws-chat-rename-dialog[open],.nchat-rename-dialog[open]')`);
    await fill('.ws-chat-rename-input,.nchat-rename-input','B29 renamed successfully');await click('.ws-chat-rename-form [type=submit],.nchat-rename-form [type=submit]');
    await wait(`!document.querySelector('.ws-chat-rename-dialog[open],.nchat-rename-dialog[open]')`);
    const history=await js('soduWorkAPI.conversationSession.history()');assert.equal(history.chats.find(c=>(c.id||c.sessionId)===opened.sessionId)?.title,'B29 renamed successfully');mark('native menu rename commits through production IPC and history');
    for(const [name,width,height,side]of[['normal',1100,760,240],['narrow-window',840,600,168],['wide-sidebar',1280,820,440]]){
      win.setContentSize(width,height);await delay(100);await resizeSidebar(side);await openMenu(opened.sessionId);const value=await menuGeometry(name);assert.ok(visibleGeometry(value),JSON.stringify(value));await shot('menu-'+name);key('Escape');await delay(80);
    }
    mark('normal, narrow window and maximum sidebar geometry');
    win.setFullScreen(true);await delay(300);await openMenu(opened.sessionId);const full=await menuGeometry('fullscreen');assert.ok(visibleGeometry(full),JSON.stringify(full));await shot('menu-fullscreen');key('Escape');win.setFullScreen(false);await delay(200);mark('fullscreen menu geometry');
    win.webContents.setZoomFactor(1.25);await delay(150);await openMenu(opened.sessionId);assert.ok(visibleGeometry(await menuGeometry('zoom-125-percent')));await shot('menu-zoom-125');key('Escape');win.webContents.setZoomFactor(1);await delay(100);mark('125 percent zoom menu remains within viewport');
    await openMenu(opened.sessionId);win.setContentSize(1050,730);await wait(`!document.querySelector('.ws-chat-menu:not([hidden])')`);assert.equal(await js(`!!document.querySelector('.ws-chat-more[aria-expanded=true]')`),false);mark('window resize dismisses menu and clears expanded state');
    await openMenu(opened.sessionId);await js(`document.querySelector('#wsSideScroll').scrollTop=0`);await delay(100);assert.equal(await js(`!!document.querySelector('.ws-chat-menu:not([hidden])')`),false);mark('scroll closes anchored menu instead of leaving stale hit targets');
    await openMenu(opened.sessionId);
    win.webContents.reload();await wait(`!!document.querySelector('.ws-chat-row')`,'production renderer reload',45000);
    assert.equal(await js(`[...document.querySelectorAll('.ws-chat-title')].some(e=>e.textContent==='B29 renamed successfully')`),true);assert.equal(await js(`!!document.querySelector('.ws-chat-menu:not([hidden]),.ws-chat-more[aria-expanded=true]')`),false);await openMenu(opened.sessionId);assert.ok(visibleGeometry(await menuGeometry('reopened-after-reload')));key('Escape');await wait(`!document.querySelector('.ws-chat-menu:not([hidden])')`);mark('renamed conversation persists and menu reopens cleanly after renderer reload');
    report.ok=true;
  })().catch(async error=>{report.error=String(error.stack||error);await shot('failure').catch(()=>{});console.error(report.error);}).finally(async()=>{
    await require('../main/agent-runtime/process-session.js').dispose().catch(error=>{report.ok=false;report.cleanupError=String(error)});
    report.ownedElectronPids=[process.pid,...app.getAppMetrics().map(m=>m.pid)];
    for(const w of BrowserWindow.getAllWindows())if(!w.isDestroyed())w.destroy();flush();
    app.exit(report.ok?0:1);
  });
}
