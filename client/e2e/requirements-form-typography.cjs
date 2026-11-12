'use strict';
// Checks the approved creation/editing type scale in the real desktop renderer.
// Native desktop IPC and model execution are outside this renderer smoke test.
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const [output,hub]=process.argv.slice(2);
if(!path.isAbsolute(output||'')||!/^http:\/\/127\.0\.0\.1:\d+$/.test(hub||''))throw Error('Explicit isolated output and Hub required');
fs.mkdirSync(output,{recursive:true});app.setPath('userData',path.join(output,'profile'));
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const report={ok:false,scope:'Complete desk.html renderer, isolated Hub; no production IPC or model calls',checks:[]};
let win;
const stage=value=>{report.stage=value;fs.writeFileSync(path.join(output,'progress.json'),JSON.stringify(report,null,2));};
app.whenReady().then(async()=>{
 const watchdog=setTimeout(()=>{report.error='Typography test exceeded 90 seconds';fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));app.exit(1);},90000);
 try{
  stage('isolated-backend');
  const ready=await(await fetch(hub+'/ready',{signal:AbortSignal.timeout(5000)})).json();assert.equal(ready.isolated,true);
  stage('create-window');
  win=new BrowserWindow({width:1440,height:1000,show:false,webPreferences:{offscreen:true,sandbox:true,contextIsolation:true,partition:'requirements-form-typography-'+process.pid+'-'+Date.now()}});
  win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*','ws://*/*','wss://*/*']},(row,reply)=>reply({cancel:!row.url.startsWith(hub+'/')&&!row.url.startsWith(hub.replace('http:','ws:')+'/')}));
  await win.loadURL('about:blank');
  stage('debugger-page');
  win.webContents.debugger.attach('1.3');await win.webContents.debugger.sendCommand('Page.enable');
  stage('inject-isolated-identity');
  await win.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument',{source:`
   localStorage.setItem('soduwork_work_hub_environment_v1','development');
   localStorage.setItem('soduwork_work_development_hub_url_v1',${JSON.stringify(hub)});
   localStorage.setItem('soduwork_work_user_id','e2e-sender');
   // Emulate only the secure desktop enrollment bridge; call the real Hub route.
   window.soduWorkAPI={getHubConnection:async()=>({hub:${JSON.stringify(hub)},internalTest:true,editable:false}),deviceAuthBootstrap:async options=>{
    const response=await fetch(options.hub+'/api/v1/clients/enroll',{method:'POST',headers:{
     'Content-Type':'application/json','X-Device-Key':'isolated-requirements-fixture-key-never-production'
    },body:JSON.stringify({device:options.clientId,name:options.name,platform:options.platform,version:options.version})});
    const data=await response.json();if(!response.ok)throw Error(JSON.stringify(data));
    window.fixtureDeviceSession=data.session;
    return {...data,ok:!data.activationRequired,stored:true};
   }};
   window.fixtureErrors=[];
   window.addEventListener('error',event=>fixtureErrors.push(event.message));
   window.addEventListener('unhandledrejection',event=>fixtureErrors.push(String(event.reason)));
  `});
  const js=source=>win.webContents.executeJavaScript(source,true);
  const until=async source=>{for(let i=0;i<200;i++){if(await js(source))return;await delay(100);}throw Error('Timed out: '+source+'; errors='+JSON.stringify(await js('fixtureErrors')));};
  const click=async selector=>{
   // Wait for layout and hit-test the real pointer target; a freshly opened view can still be animating.
   let pos;
   for(let attempt=0;attempt<30;attempt++){
    pos=await js(`(async()=>{const n=[...document.querySelectorAll(${JSON.stringify(selector)})].find(n=>n.getClientRects().length&&!n.disabled);if(!n)return null;n.scrollIntoView({block:'nearest',behavior:'instant'});const a=n.getBoundingClientRect();await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const b=n.getBoundingClientRect();const x=Math.round(b.x+b.width/2),y=Math.round(b.y+b.height/2);const hit=document.elementFromPoint(x,y);return n.isConnected&&Math.abs(a.x-b.x)<1&&Math.abs(a.y-b.y)<1&&n.contains(hit)?{x,y}:null})()`);
    if(pos)break;await delay(50);
   }
   if(!pos){report.pointerTarget=await js(`([...document.querySelectorAll(${JSON.stringify(selector)})].map(n=>{const r=n.getBoundingClientRect();return {html:n.outerHTML.slice(0,500),rect:r.toJSON(),hit:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.outerHTML.slice(0,500)}}))`);throw Error('No stable visible pointer target: '+selector);}
   const zoom=win.webContents.getZoomFactor();pos={x:Math.round(pos.x*zoom),y:Math.round(pos.y*zoom)};
   win.webContents.sendInputEvent({type:'mouseMove',...pos});
   win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...pos});win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...pos});await delay(150);
  };
  const load=()=>win.loadFile(path.join(__dirname,'../desk.html'),{query:{panel:'workspace',view:'history'}});
  stage('load-complete-workspace');
  await load();stage('wait-for-store');await until('!!document.querySelector("[data-view=history]")&&typeof Store!=="undefined"&&Store.taskState==="ready"&&!document.documentElement.classList.contains("soduwork-auth-pending")');
  await js("SoduWorkI18n.setLocale('zh-CN')");
  await click('button[data-rail-view="history"]');await until('!!document.querySelector("#historyBoard.show")');
  assert.equal(await js('document.querySelectorAll("[data-view=workitems]").length'),0);
  assert.equal(await js('document.querySelector("#hbTitleText").textContent'),'需求池');

  const fonts=async selectors=>js(`Object.fromEntries(Object.entries(${JSON.stringify(selectors)}).map(([key,selector])=>{
    const node=document.querySelector(selector);if(!node)throw Error('Missing typography target: '+selector);
    return [key,getComputedStyle(node).fontSize];}))`);
  const layout=async(rootSelector,scrollSelector,buttonSelector)=>{
   const box=await js(`(()=>{const root=document.querySelector(${JSON.stringify(rootSelector)}),scroll=document.querySelector(${JSON.stringify(scrollSelector)}),button=document.querySelector(${JSON.stringify(buttonSelector)});
    const r=root.getBoundingClientRect(),b=button.getBoundingClientRect();return{left:r.left,right:r.right,bottom:b.bottom,top:b.top,
      width:innerWidth,height:innerHeight,scrollWidth:scroll.scrollWidth,clientWidth:scroll.clientWidth}})()`);
   assert.ok(box.left>=-1&&box.right<=box.width+1,JSON.stringify(box));
   assert.ok(box.top>=0&&box.bottom<=box.height+1,JSON.stringify(box));
   assert.ok(box.scrollWidth<=box.clientWidth+2,JSON.stringify(box));
   return box;
  };
  const cases=[{name:'desktop',width:1440,height:1000,zoom:1},{name:'compact',width:1024,height:768,zoom:1},
   {name:'zoomed',width:1000,height:850,zoom:1.25},{name:'narrow-zoomed',width:640,height:900,zoom:1.25}];
  report.samples=[];
  for(const sample of cases){
   stage(sample.name+'-create');win.setContentSize(sample.width,sample.height);win.webContents.setZoomFactor(sample.zoom);await delay(180);
   // Open the same form entry used by the board, independently of board overflow behavior.
   await js(`WorkEntrySheet.openTask({source:'需求池',requirement:true,saveOnly:true,triageStage:'intake'})`);
   await until('!!document.querySelector(".wes-layer.is-dialog #cpTitle")');
   const title='Type scale '+sample.name;
   await click('#cpTitle');await win.webContents.insertText(title);
   await click('#cpNote');await win.webContents.insertText('Readable requirement body');
   await click('#cpCkAdd');await click('.cp-ck-t');await win.webContents.insertText('Readable completion criterion');
   const createFonts=await fonts({header:'.wes-layer.is-dialog .wes-head h2',section:'.wes-layer.is-dialog .cp-sec-h',
    title:'#cpTitle',body:'#cpNote',criterion:'.cp-ck-t',select:'#cpKind',label:'.cp-field-label'});
   assert.deepEqual(createFonts,{header:'20px',section:'15px',title:'17px',body:'15px',criterion:'15px',select:'15px',label:'13px'});
   const createLayout=await layout('.wes-layer.is-dialog','.wes-layer.is-dialog .cp-form-scroll','#cpCreate');
   await js(`document.querySelector('.cp-form-scroll').scrollTo(0,0)`);await delay(80);
   fs.writeFileSync(path.join(output,sample.name+'-create.png'),(await win.webContents.capturePage()).toPNG());
   await click('#cpCreate');
   await until(`tasks.some(task=>task.title===${JSON.stringify(title)})`);
   await until(`SoduWorkAPI.getTask(tasks.find(task=>task.title===${JSON.stringify(title)}).id).then(()=>true,()=>false)`);
   const created=await js(`SoduWorkAPI.getTask(tasks.find(task=>task.title===${JSON.stringify(title)}).id)`);
   assert.equal(created.note,'Readable requirement body');assert.deepEqual(created.acceptanceCriteria,['Readable completion criterion']);
   if(await js('!!document.querySelector(".wes-result-dialog[open]")'))await click('.wes-result-dialog[open] .wes-result-close');
   if(await js('!!document.querySelector("[data-wes-close]")'))await click('[data-wes-close]');
   await until('!document.querySelector(".wes-layer.is-dialog")&&!document.querySelector(".wes-result-dialog[open]")');
   stage(sample.name+'-edit');await js(`RequirementsDetail.open(${JSON.stringify(created.id)})`);
   await click('[data-rq-edit]');await until('!!document.querySelector("#rqEditForm")');
   const editFonts=await fonts({header:'.rq-detail.is-editing .rq-detail-header h2',section:'.rq-edit-section>h3',
    title:'#rqEditForm [name=title]',body:'#rqEditForm [name=note]',criterion:'#rqEditForm [name=acceptance]',
    select:'#rqEditForm [name=kind]',label:'#rqEditForm label'});
   assert.deepEqual(editFonts,createFonts);
   const editLayout=await layout('.rq-detail','.rq-detail-content','.rq-detail-footer button[type=submit]');
   await click('#rqEditForm [name=note]');
   win.webContents.selectAll();
   await until(`(()=>{const n=document.querySelector('#rqEditForm [name=note]');return document.activeElement===n&&n.selectionStart===0&&n.selectionEnd===n.value.length})()`);
   await win.webContents.insertText('Edited readable body');
   await js(`document.querySelector('.rq-detail-content').scrollTo(0,0)`);await delay(80);
   fs.writeFileSync(path.join(output,sample.name+'-edit.png'),(await win.webContents.capturePage()).toPNG());
   await click('.rq-detail-footer button[type=submit]');await until('!document.querySelector("#rqEditForm")');
   const edited=await js(`SoduWorkAPI.getTask(${JSON.stringify(created.id)})`);
   assert.equal(edited.note,'Edited readable body');assert.deepEqual(edited.acceptanceCriteria,created.acceptanceCriteria);
   await click('[data-rq-dismiss]');await until('!document.querySelector(".rq-detail-backdrop")');
   report.samples.push({...sample,createFonts,editFonts,createLayout,editLayout});
   report.checks.push(sample.name+': matching approved type scale, bounded forms and reachable save actions; native creation/edit persist through HTTP');
  }
  assert.deepEqual(await js('fixtureErrors'),[]);report.ok=true;
 }catch(error){report.error=String(error.stack||error);if(win){report.runtimeErrors=await win.webContents.executeJavaScript('window.fixtureErrors||[]').catch(()=>[]);fs.writeFileSync(path.join(output,'failure.png'),(await win.webContents.capturePage()).toPNG());}}
 finally{clearTimeout(watchdog);fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));app.exit(report.ok?0:1);}
});
