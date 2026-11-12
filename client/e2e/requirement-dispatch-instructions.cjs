'use strict';
// Native assignment and detail UI through production controllers and authenticated Hub persistence.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict');
const {spawn, spawnSync} = require('node:child_process');
const electron = require('electron');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const client = path.resolve(__dirname, '..');

if (typeof electron === 'string') {
  (async () => {
    const output = process.argv[2], python = process.argv[3] || process.env.SODUWORK_TEST_PYTHON;
    if (!path.isAbsolute(output || '') || !python) throw Error('Absolute evidence directory and test Python are required');
    fs.mkdirSync(output, {recursive: true});
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'soduwork-collab-e2e-'));
    const probe = require('node:net').createServer();
    await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
    const hub = 'http://127.0.0.1:' + port, log = fs.openSync(path.join(output, 'hub.log'), 'w');
    const server = spawn(python, ['-m', 'uvicorn', 'tests.unified_requirements_browser_server:app', '--host', '127.0.0.1', '--port', String(port)],
      {cwd: path.join(client, '../hub-backend'), env: {...process.env, SODUWORK_COLLAB_E2E_ROOT: root}, stdio: ['ignore', log, log]});
    try {
      let ready = false;
      for (let i = 0; i < 150; i++) {
        try {ready = (await (await fetch(hub + '/ready')).json()).isolated === true;} catch {}
        if (ready || server.exitCode !== null) break;
        await wait(100);
      }
      if (!ready) throw Error('Isolated dispatch Hub failed to start; inspect hub.log');
      const env = {...process.env};
      for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
      const result = spawnSync(electron, [__filename, output, hub], {env, encoding: 'utf8', timeout: 150000});
      fs.writeFileSync(path.join(output, 'electron.log'), (result.stdout || '') + (result.stderr || '') + (result.error?.message || ''));
      const report = JSON.parse(fs.readFileSync(path.join(output, 'report.json'), 'utf8'));
      console.log(JSON.stringify(report));
      if (result.status !== 0 || !report.ok) throw Error('Dispatch instructions E2E failed');
    } finally {
      server.kill(); await Promise.race([new Promise(resolve => server.once('exit', resolve)), wait(3000)]);
      fs.closeSync(log);
    }
  })().catch(error => {console.error(error); process.exitCode = 1;});
} else {
  const {app, BrowserWindow, ipcMain} = electron;
  const [output, hub] = process.argv.slice(2);
  if (!path.isAbsolute(output || '') || !/^http:\/\/127\.0\.0\.1:\d+$/.test(hub || '')) throw Error('Isolated Hub required');
  app.setPath('userData', path.join(output, 'profile')); app.disableHardwareAcceleration();
  const report = {ok:false, checks:[], boundary:'Native Electron text/click input, production assignment, ChatTaskStart, main task-input, authenticated HTTP and SQLite. Conversation navigation and queue transport are fixture boundaries; admitted turns are canceled before inference. No real model or production account.'};
  let win, identity, viewer, submitted = 0;
  const taskId = 'dispatch-instructions-e2e';
  async function api(route, body, who = identity, method = body ? 'POST' : 'GET') {
    const response = await fetch(hub + '/api/v1' + route, {method, headers:{'Content-Type':'application/json', Authorization:'Device '+who.session}, ...(body ? {body:JSON.stringify(body)} : {})});
    return {status:response.status, data:await response.json()};
  }
  async function request(route, body, who = identity, method) {
    const result = await api(route,body,who,method); assert.equal(result.status,200,route+': '+JSON.stringify(result.data)); return result.data;
  }
  const js = code => win.webContents.executeJavaScript(code,true);
  async function until(code) {
    for(let i=0;i<160;i++){if(await js(code))return;await wait(50);}
    throw Error('Timed out: '+code);
  }
  async function click(selector) {
    let point;
    for(let i=0;i<30;i++) {
      point=await js(`(async()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n||n.disabled)return null;
        n.scrollIntoView({block:'nearest',behavior:'instant'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
        const b=n.getBoundingClientRect(),x=Math.round(b.x+b.width/2),y=Math.round(b.y+b.height/2);
        return b.width&&b.height&&n.contains(document.elementFromPoint(x,y))?{x,y}:null})()`);
      if(point)break;await wait(50);
    }
    assert.ok(point,'Visible stable control: '+selector);
    for(const type of ['mouseDown','mouseUp'])win.webContents.sendInputEvent({type,...point,button:'left',clickCount:1});
    await wait(75);
  }
  async function records() {
    const result=await request('/tasks/'+taskId+'/events');return result.events.filter(row=>row.kind==='execution.instructions');
  }
  async function enroll(name) {
    const response=await fetch(hub+'/api/v1/clients/enroll',{method:'POST',headers:{'Content-Type':'application/json','X-Device-Key':'isolated-requirements-fixture-key-never-production'},body:JSON.stringify({device:'e2e-'+name,name:'Dispatch instructions fixture'})});
    assert.equal(response.status,200);return {hub,clientId:'e2e-'+name,session:(await response.json()).session};
  }
  async function openDetail() {
    await js(`RequirementsDetail.open(${JSON.stringify(taskId)})`);
    await until('!!document.querySelector("[data-rq-dispatch-instructions]")');
    await click('[data-rq-dispatch-instructions]>summary');
    await until('document.querySelectorAll(".rq-dispatch-record").length>=3');
  }
  async function assign(note,manual) {
    await js(`RequirementsDetail.close(true);RequirementAssignment.open(${JSON.stringify(taskId)})`);
    await until('!!document.querySelector("#fwdConfirm")&&!document.querySelector("#fwdConfirm").disabled');
    await click('#fwdNote');await win.webContents.insertText(note);
    if(manual) await js(`(()=>{const n=document.querySelector('#fwdSubmissionMode');n.value='manual';n.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    const previous=submitted;await click('#fwdConfirm');
    for(let i=0;i<160&&submitted===previous;i++)await wait(50);
    assert.equal(submitted,previous+1,await js('JSON.stringify(window.fixtureNotices)'));
    await until('!document.querySelector(".rq-assignment-backdrop")');
  }
  app.whenReady().then(async()=>{
    try {
      identity=await enroll('recipient');viewer=await enroll('other');
      const route='/tasks/'+taskId;
      await request(route,{title:'派发说明端到端验证',note:'公开需求正文',status:'todo',triageStage:'ready',kind:'requirement',visibility:'organization'},identity,'PUT');
      const legacy={conversationId:'legacy-dispatch',turnId:'legacy-turn',executor:'native'};
      await request(route+'/conversation-turn',{...legacy,action:'prepare'});
      await request(route+'/conversation-turn',{...legacy,action:'cancel'});
      const preload=path.join(output,'preload.cjs');
      fs.writeFileSync(preload,"const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('fixtureDispatch',{submit:body=>ipcRenderer.invoke('dispatch-instructions-submit',body)});");
      ipcMain.handle('dispatch-instructions-submit',async(event,body)=>{
        assert.equal(event.sender,win.webContents);assert.equal(event.senderFrame,event.sender.mainFrame);assert.equal(body.taskId,taskId);
        const turnId='dispatch-'+(submitted+1), conversationId='instructions-chat-'+(submitted+1);
        const requested=body.taskExecution;
        const input=await require('../main/pi-session/task-input').prepare(identity,taskId,conversationId,turnId,body.instruction,requested);
        assert.equal(input.executor,'native');
        await request(route+'/conversation-turn',{action:'cancel',conversationId,turnId,executor:input.executor});
        submitted++;return {ok:true};
      });
      win=new BrowserWindow({show:false,width:1360,height:1050,webPreferences:{offscreen:true,sandbox:true,contextIsolation:true,preload,backgroundThrottling:false}});
      win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*','ws://*/*','wss://*/*']},(row,done)=>done({cancel:!row.url.startsWith(hub+'/')}));
      await win.loadFile(path.join(__dirname,'fixtures/requirements-integration.html'),{query:{hub,identity:'recipient'}});
      assert.equal(await js('fixtureReady'),'ready');
      for(const file of ['panels-icons','chat-task-start','panels-forward-select','panels-forward-plugin','panels-forward-picker','panels-forward-options','panels-forward'])
        await js(fs.readFileSync(path.join(client,'components/panels',file+'.js'),'utf8')+'\nvoid 0;');
      for(const file of ['core/requirement-session-context.js','components/requirements/requirement-session-choice.js','components/requirements/requirement-assignment.js'])
        await js(fs.readFileSync(path.join(client,file),'utf8')+'\nvoid 0;');
      const styles=[...fs.readFileSync(path.join(client,'desk.html'),'utf8').matchAll(/<link\b[^>]*href=["']([^"']+\.css)["'][^>]*>/g)].map(m=>require('node:url').pathToFileURL(path.join(client,m[1])).href);
      await js(`Promise.all(${JSON.stringify(styles)}.map(href=>new Promise((resolve,reject)=>{const n=document.createElement('link');n.rel='stylesheet';n.href=href;n.onload=resolve;n.onerror=reject;document.head.append(n)}))).then(()=>true)`);
      await js(`(()=>{
        window._humanErr=(e,f)=>e.message||f;window.workRoot=()=>'';
        window.ChatTaskController={isPickableTask:ChatTaskStart.isPickableTask};
        window.openTaskConversation=async()=>true;
        window.soduWorkAPI.conversationSession={history:async()=>({ok:true,chats:[]}),runtimes:async()=>({ok:true,runtimes:[]}),probe:async()=>({ok:true})};
        const ctx=window.dispatchContext={_collabStarts:new Set(),_collabTasks:new Map(),_sessionOptions:{adapterId:'pi',modelName:'deterministic'},_sessionId:'',_ref:'',
          _ensure:async()=>true,_workModel(){return this._sessionOptions.modelName},_render(){},refreshHistory(){},sessionInfo(){return {adapterId:'pi'}},
          _send:async(instruction,opts)=>{const result=await fixtureDispatch.submit({instruction,taskId:opts.taskId,taskExecution:opts.taskExecution});return result.ok}};
        window.NativeChat=ChatTaskStart.create(ctx,{_viewGuard:()=>()=>true,_sessionContext:()=>({}),_collabEntryStatus:entry=>entry.status||'',
          _persistTaskBinding:async()=>true,_bindCollaborationTask:id=>ctx._collabTasks.set(id,{}),_setCollabEntryStatus:(entry,status)=>{if(entry)entry.status=status},
          _openTaskPicker:async()=>{},_openTask:async(id,title,opts)=>{ctx._sessionId='renderer-'+Date.now();ctx._sessionOptions={...ctx._sessionOptions,...opts.sessionOptions};return true}});
        NativeChat.sessionInfo=()=>({});
      })()`);
      const first='请保留这段完整补充说明。'+ '原始内容不截断。'.repeat(45) + '<img src=x onerror="window.injected=true">';
      await assign(first,true);
      let saved=await records();assert.equal(saved.length,1);assert.equal(saved[0].detail.note,first);assert.equal(saved[0].detail.submissionMode,'manual');
      const second='请以第二轮要求为准；上一轮说明仍应可查。';await assign(second,false);
      saved=await records();assert.equal(saved.length,2);assert.ok(saved.some(row=>row.detail.note===first));assert.ok(saved.some(row=>row.detail.note===second&&row.detail.submissionMode==='default'));
      report.checks.push('Native form input and confirm clicks flow through production ChatTaskStart and task-input into authenticated immutable snapshots; a second dispatch preserves the full first note beyond 300 characters');
      await openDetail();
      const text=await js('document.querySelector("[data-rq-dispatch-records]").textContent');
      assert.ok(text.includes(first));assert.ok(text.includes(second));assert.match(text,/未记录/);assert.match(text,/手动提交/);
      assert.equal(await js('Boolean(window.injected)||Boolean(document.querySelector("[data-rq-dispatch-records] img"))'),false);
      assert.ok(text.indexOf(second)<text.indexOf(first),'Newest instructions appear first');
      fs.writeFileSync(path.join(output,'dispatch-instructions.png'),(await win.webContents.capturePage()).toPNG());
      for(const [width,height,zoom] of [[820,900,1.25],[480,900,1]]) {
        win.setContentSize(width,height);win.webContents.setZoomFactor(zoom);await wait(100);
        const layout=await js(`(()=>{const n=document.querySelector('[data-rq-dispatch-records]');return {scroll:n.scrollWidth,client:n.clientWidth}})()`);
        assert.ok(layout.scroll<=layout.client+1,'Instructions wrap at narrow width');
      }
      report.checks.push('The detail displays separate historical records, marks legacy missing fields unrecorded, escapes markup, and wraps at narrow windows and 125% zoom');
      win.setContentSize(1360,1050);win.webContents.setZoomFactor(1);
      await request('/tasks/dispatch-instructions-other',{title:'另一条需求',status:'todo',triageStage:'ready',kind:'requirement'},identity,'PUT');
      await js(`RequirementsDetail.close(true);window.originalGetEvents=SoduWorkAPI.getTaskEvents;
        SoduWorkAPI.getTaskEvents=async id=>{const rows=await originalGetEvents.call(SoduWorkAPI,id);
          if(id===${JSON.stringify(taskId)}){window.eventsHeld=true;await new Promise(resolve=>window.releaseEvents=resolve);}return rows};
        RequirementsDetail.open(${JSON.stringify(taskId)})`);
      await until('!!document.querySelector("[data-rq-dispatch-instructions]")');
      await click('[data-rq-dispatch-instructions]>summary');await until('window.eventsHeld===true');
      await js(`RequirementsDetail.close(true);RequirementsDetail.open('dispatch-instructions-other')`);
      await until('!!document.querySelector("[data-rq-dispatch-instructions]")');
      await click('[data-rq-dispatch-instructions]>summary');
      await until('document.querySelector("[data-rq-dispatch-records]").textContent.includes("暂无派发记录")');
      await js('releaseEvents();SoduWorkAPI.getTaskEvents=originalGetEvents;void 0');await wait(100);
      assert.equal(await js('document.querySelectorAll(".rq-dispatch-record").length'),0);
      report.checks.push('A delayed authenticated event response for a closed task cannot populate a different task detail');
      const unauthorized=await api(route+'/events',undefined,viewer);assert.equal(unauthorized.status,404);
      const shared=await request(route,undefined,viewer);assert.equal(shared.canViewExecution,false);
      await js(`RequirementsDetail.close(true);window.soduWorkAPI.deviceAuthBootstrap=async()=>(${JSON.stringify({...viewer,ok:true,stored:true})});SoduWorkAPI.registerClient()`);
      await js(`RequirementsDetail.open(${JSON.stringify(taskId)})`);await until('!!document.querySelector(".rq-detail")');
      assert.equal(await js('!!document.querySelector("[data-rq-dispatch-instructions]")'),false);
      assert.deepEqual(await js('fixtureErrors'),[]);
      report.checks.push('A shared requirement viewer cannot fetch execution events or see private dispatch instructions');
      report.ok=true;
    } catch(error) {
      report.error=String(error.stack||error);
      if(win&&!win.isDestroyed())fs.writeFileSync(path.join(output,'failure.png'),(await win.webContents.capturePage()).toPNG());
    } finally {
      fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));win?.destroy();app.exit(report.ok?0:1);
    }
  });
}
