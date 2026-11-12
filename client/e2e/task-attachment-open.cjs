// Real task attachment cards -> production preload/IPC -> loopback download -> viewer/save.
// Only OS application handoff and save-dialog choices are captured; no business Hub is used.
const {app,BrowserWindow,ipcMain,net,session}=require('electron');
const {pathToFileURL}=require('node:url');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const assert=require('node:assert/strict');
const client=path.resolve(__dirname,'..'),out=process.argv[2];
if(!out||!path.isAbsolute(out))throw Error('Absolute evidence directory required');
fs.mkdirSync(out,{recursive:true});
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'soduwork-attachment-test-'));
app.setPath('userData',profile);
const report={ok:false,mode:'requirements-drawer',checks:[],requests:[]};
const files=[
  {id:'html0001',filename:'05_指标模块验证报告.html',contentType:'text/html',body:Buffer.from('<!doctype html><meta charset="utf-8"><h1>HTML 附件验收</h1>')},
  {id:'mark0001',filename:'测试执行报告.md',contentType:'text/markdown',body:Buffer.from('# Markdown 附件验收\n\n修复后可以查看。')},
  {id:'text0001',filename:'说明.txt',contentType:'text/plain',body:Buffer.from('Text 附件验收')},
  {id:'csv00001',filename:'数据.csv',contentType:'text/csv',body:Buffer.from('name,value\nexample,1')},
  {id:'json0001',filename:'资料.json',contentType:'application/json',body:Buffer.from('{"example":true}')},
  {id:'pdf00001',filename:'验收.pdf',contentType:'application/pdf',body:Buffer.from('%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Count 0/Kids[]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF')},
  {id:'word0001',filename:'资料.docx',contentType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',body:Buffer.from('isolated document bytes: test OS handoff only')},
  {id:'png00001',filename:'图片.png',contentType:'image/png',isImage:true,body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6+0sAAAAASUVORK5CYII=','base64')},
];
const ticket='attachment-fixture-ticket-1234567890';
const bundleRoot=path.join(profile,'bundle-input');fs.mkdirSync(bundleRoot);
for(const file of files.slice(0,3))fs.writeFileSync(path.join(bundleRoot,file.filename),file.body);
const bundleBytes=require('../main/conversation/zip-archive').createZip(bundleRoot).data;
let server,win,base,saveCanceled=false,openError='',status=200,ticketExpired=false;
let saveGate=null,dialogCalls=0,missingSource=false;
const opened=[],saves=[],viewers=[],errors=[];
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const js=code=>win.webContents.executeJavaScript(code,true);
async function until(fn,label){for(let i=0;i<120;i++){if(await fn())return;await delay(50)}throw Error('Timed out: '+label)}
async function click(selector){const point=await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});for(let p=e.parentElement;p;p=p.parentElement){if(p.tagName==='DETAILS')p.open=true;}e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);for(const type of ['mouseDown','mouseUp'])win.webContents.sendInputEvent({type,button:'left',clickCount:1,...point});await delay(120)}
function fixtureHtml(){
  const list=files.map(({body,...f})=>({...f,taskId:'fixture-task',artifactVersionId:'version-1',size:body.length,url:'/api/v1/attachments/'+f.id+'?ticket='+ticket,canDelete:false}));
  // Use the production generic error mapper, which originally hid the type failure.
  const human=fs.readFileSync(path.join(client,'components/pet/pet-ui.js'),'utf8').split('let bubbleTimer =')[0];
  return `<!doctype html><meta charset="utf-8"><title>Task attachments fixture</title>
  <link rel="stylesheet" href="/theme/variables.css">
  <link rel="stylesheet" href="/components/requirements/requirements-board.css">
  <link rel="stylesheet" href="/components/panels/conversation-attachments.css">
  <style>body{font:14px sans-serif;padding:24px}.rq-material{display:flex;gap:12px;padding:8px}.rq-material-actions{display:flex;gap:8px}.rq-material-actions svg{width:16px;height:16px}button{min-height:28px}</style>
  <div id="toast"></div>
  <script>window.User={id:'fixture',name:'Fixture'};window.fixtureErrors=[];window.toasts=[];addEventListener('error',e=>fixtureErrors.push(e.message));addEventListener('unhandledrejection',e=>fixtureErrors.push(String(e.reason)));</script>
  <script src="/core/api-work-plugins.js"></script><script src="/api-library-local.js"></script><script src="/api.js"></script><script>${human}
  window.petSay=m=>{toasts.push(m);document.querySelector('#toast').textContent=m};
  window.esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));window._fmtSize=n=>n+' B';window._fileIcon=()=>'';
  window.librarySaves=[];
  window.SoduWorkAPI={downloadArtifactsZip:SoduWorkAPI.downloadArtifactsZip,artifactZipFilename:SoduWorkAPI.artifactZipFilename,
    libraryOutputKey:SoduWorkAPI.libraryOutputKey,uploadLibraryOutput:SoduWorkAPI.uploadLibraryOutput,taskStorageKey:SoduWorkAPI.taskStorageKey,
    getLibraryOutputStatus:async key=>({ok:true,item:librarySaves.some(row=>row.source.outputKey===key)?{id:'saved-bundle'}:null}),
    uploadLibraryFile:async(file,folder,storage,source)=>{librarySaves.push({name:file.name,bytes:Array.from(new Uint8Array(await file.arrayBuffer())),source});return{ok:true,item:{id:'saved-bundle'}}},
    getTask:async id=>({id,title:'Attachment acceptance',status:'done',canEditRequirement:false,canViewExecution:true}),listAttachments:async()=>${JSON.stringify(list)},attachmentUrl:a=>${JSON.stringify(base)}+a.url};
  </script><script src="/core/requirements.js"></script><script src="/components/panels/conversation-attachments.js"></script><script src="/components/panels/library-transfer.js"></script><script src="/components/requirements/requirements-detail.js"></script><script>RequirementsDetail.open('fixture-task')</script>`;
}
app.whenReady().then(async()=>{
  server=http.createServer((req,res)=>{
    const url=new URL(req.url,'http://127.0.0.1');
    if(url.pathname==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(fixtureHtml());return}
    if(url.pathname==='/api/v1/tasks/fixture-task/artifacts.zip'){
      const authorized=req.headers.authorization==='Device isolated-bundle-session'&&url.searchParams.get('artifactVersionId')==='version-2';
      report.requests.push({bundle:true,authorized,version:url.searchParams.get('artifactVersionId')});
      res.writeHead(authorized?status:403,{'Content-Type':'application/zip','X-Artifact-SHA256':require('node:crypto').createHash('sha256').update(bundleBytes).digest('hex')});res.end(bundleBytes);return;
    }
    const file=files.find(f=>url.pathname==='/api/v1/attachments/'+f.id);
    const access=files.find(f=>url.pathname==='/api/v1/attachments/'+f.id+'/access');
    if(access){const authorized=req.headers.authorization==='Device isolated-bundle-session'&&req.method==='POST';report.requests.push({refresh:access.id,authorized});res.writeHead(authorized?status:401,{'Content-Type':'application/json'});res.end(JSON.stringify({attachmentId:access.id,url:base+'/api/v1/attachments/'+access.id+'?ticket=renewed-'+ticket}));return}
    if(file){const token=url.searchParams.get('ticket'),code=token==='renewed-'+ticket||(!ticketExpired&&token===ticket)?(missingSource?404:status):401;report.requests.push({id:file.id,mode:url.searchParams.get('mode')||'download',status:code});res.writeHead(code,{'Content-Type':missingSource?'application/json':file.contentType,'X-Content-Type-Options':'nosniff'});res.end(missingSource?JSON.stringify({detail:'附件文件已丢失'}):file.body);return}
    const allowed=['/core/api-work-plugins.js','/api-library-local.js','/api.js','/components/panels/library-transfer.js','/components/panels/conversation-attachments.js','/components/panels/conversation-attachments.css','/core/requirements.js','/components/requirements/requirements-detail.js','/components/requirements/requirements-board.css','/theme/variables.css'];
    if(allowed.includes(url.pathname)){res.setHeader('Content-Type',url.pathname.endsWith('.js')?'text/javascript':'text/css');res.end(fs.readFileSync(path.join(client,url.pathname)));return}res.writeHead(404);res.end();
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+server.address().port;
  ipcMain.on('client-distribution-info',event=>{event.returnValue={hubOrigin:base};});
  function PreviewWindow(options){const w=new BrowserWindow({...options,show:false,webPreferences:{...options.webPreferences,offscreen:true}});w.show=()=>{};const record={win:w,title:options.title,loaded:false,failed:null};viewers.push(record);w.webContents.once('did-finish-load',()=>record.loaded=true);w.webContents.on('did-fail-load',(_e,code,reason)=>record.failed={code,reason});return w}
  PreviewWindow.fromWebContents=BrowserWindow.fromWebContents;
  require('../main/attachment-files').install({app,net,ipcMain,BrowserWindow:PreviewWindow,
    identityOf:()=>({hub:base,clientId:'fixture'}),
    authenticatedIdentityOf:async()=>({hub:base,clientId:'fixture',session:'isolated-bundle-session'}),
    shell:{openPath:async target=>{opened.push(target);return openError}},dialog:{showSaveDialog:async(_parent,options)=>{dialogCalls++;if(saveGate)await saveGate;if(saveCanceled)return{canceled:true};const target=path.join(profile,path.basename(options.defaultPath));saves.push(target);return{filePath:target}},showErrorBox:(title,reason)=>errors.push({title,reason})}});
  // Production preload only exposes the desktop bridge to the trusted workspace URL.
  const desk=pathToFileURL(path.join(client,'desk.html')).href;
  const isolated=session.fromPartition('task-attachments-'+Date.now());
  isolated.protocol.handle('file',request=>request.url===desk
    ? new Response(fixtureHtml().replace(/(?:src|href)="\//g,match=>match.slice(0,-1)+base+'/'),{headers:{'content-type':'text/html; charset=utf-8'}})
    : net.fetch(request,{bypassCustomProtocolHandlers:true}));
  win=new BrowserWindow({show:false,width:1280,height:800,webPreferences:{preload:path.join(client,'preload.js'),session:isolated,offscreen:true,nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false}});
  await win.loadURL(desk);await until(()=>js("document.querySelectorAll('[data-rq-file]').length===8"),'cards rendered');
  files.find(f=>f.id==='pdf00001').body=await win.webContents.printToPDF({pageSize:'A4'});
  for(const f of files){
    await js('toasts.length=0');const o=opened.length,v=viewers.length;
    await click(`[data-rq-file="${f.id}"]`);
    if(/\.(html|docx)$/.test(f.filename)){await until(()=>opened.length>o,'system handoff');assert.deepEqual(fs.readFileSync(opened.at(-1)),f.body);assert.equal(path.basename(opened.at(-1)),f.filename);report.checks.push({filename:f.filename,systemHandoff:true,downloadedBytesMatch:true})}
    else if(f.isImage){await until(()=>js("!!document.querySelector('.catt-preview-body img')?.naturalWidth"),'image decoded');report.checks.push({filename:f.filename,imageDecoded:true});await click('[data-catt-preview-close]')}
    else{await until(()=>viewers.length>v,'native viewer created');const viewer=viewers.at(-1);await until(()=>viewer.loaded||viewer.failed,'native viewer load');assert.equal(viewer.failed,null);assert.ok(viewer.loaded);if(f.contentType!=='application/pdf'){const dbg=viewer.win.webContents.debugger;dbg.attach('1.3');const tree=await dbg.sendCommand('DOM.getDocument');const body=(await dbg.sendCommand('DOM.getOuterHTML',{nodeId:tree.root.nodeId})).outerHTML;dbg.detach();const firstLine=f.body.toString('utf8').split('\n')[0];const renderedLine=f.contentType==='text/markdown'?firstLine.replace(/^#{1,6}\s+/,''):firstLine;assert.ok(body.includes(renderedLine),f.filename+' rendered body readable')};report.checks.push({filename:f.filename,nativeLoaded:true});viewer.win.destroy()}
    assert.deepEqual(await js('toasts'),[]);
  }
  {
    for(const f of files){const n=saves.length;await js('toasts.length=0');await click(`[data-rq-download="${f.id}"]`);await until(()=>saves.length===n+1&&fs.existsSync(saves.at(-1))&&fs.readFileSync(saves.at(-1)).equals(f.body),'save success');assert.equal(saves.length,n+1);assert.deepEqual(fs.readFileSync(saves.at(-1)),f.body);await until(()=>js(`document.querySelector('[data-rq-file-id="${f.id}"] [data-rq-download-status]').textContent.includes('文件已保存')`),'row save receipt');report.checks.push({filename:f.filename,downloadSaved:true})}
    let releaseSave;saveGate=new Promise(resolve=>{releaseSave=resolve});const initialDialogs=dialogCalls;
    await click('[data-rq-download="html0001"]');
    assert.equal(await js("document.querySelector('[data-rq-download=html0001]').disabled"),true);
    assert.match(await js("document.querySelector('[data-rq-file-id=html0001] [data-rq-download-status]').textContent"),/正在准备下载/);
    await click('[data-rq-download="html0001"]');assert.equal(dialogCalls,initialDialogs+1);
    releaseSave();saveGate=null;
    await until(()=>js("document.querySelector('[data-rq-file-id=html0001] [data-rq-download-status]').textContent.includes('文件已保存')"),'pending save completed');
    assert.deepEqual(fs.readFileSync(saves.at(-1)),files[0].body);
    report.checks.push('Pending native saves expose row progress and reject repeated physical clicks');
    fs.unlinkSync(saves.at(-1));missingSource=true;
    await click('[data-rq-download="html0001"]');
    await until(()=>js("document.querySelector('[data-rq-file-id=html0001] [data-rq-download-status]').textContent.includes('源文件已丢失')"),'row recovery message');
    assert.equal(fs.existsSync(saves.at(-1)),false);
    assert.equal(await js("document.querySelector('[data-rq-download=html0001]').disabled"),false);
    assert.equal(await js("(()=>{const s=document.querySelector('[data-rq-file-id=html0001] [data-rq-download-status]'),r=s.getBoundingClientRect();return !s.hidden&&r.width>0&&r.top>=0&&r.bottom<=innerHeight})()"),true);
    fs.writeFileSync(path.join(out,'missing-source-row.png'),(await win.webContents.capturePage()).toPNG());
    missingSource=false;await click('[data-rq-download="html0001"]');
    await until(()=>js("document.querySelector('[data-rq-file-id=html0001] [data-rq-download-status]').textContent.includes('文件已保存')"),'row retry receipt');
    assert.deepEqual(fs.readFileSync(saves.at(-1)),files[0].body);
    report.checks.push('A missing source creates no phantom download, reports recovery beside the file, and retries to exact bytes');
    ticketExpired=true;
    const oldOpened=opened.length,oldSaves=saves.length,oldRequests=report.requests.length;
    await click('[data-rq-file="html0001"]');await until(()=>opened.length===oldOpened+1,'renewed ticket preview');
    await click('[data-rq-download="html0001"]');await until(()=>saves.length===oldSaves+1&&fs.readFileSync(saves.at(-1)).equals(files[0].body),'renewed ticket download');
    assert.deepEqual(fs.readFileSync(opened.at(-1)),files[0].body);
    assert.equal(report.requests.slice(oldRequests).filter(r=>r.refresh&&r.authorized).length,2);
    ticketExpired=false;report.checks.push('Expired ordinary attachments renew through account ACL for both open and exact-byte download');
    status=500;await js('toasts.length=0');await click('[data-rq-download="html0001"]');await until(()=>js("document.querySelector('[data-rq-error]').textContent.includes('HTTP 500')"),'failed download feedback');assert.deepEqual(await js('toasts'),[]);status=200;report.checks.push('Failed download reports HTTP status without a success toast');
    saveCanceled=true;await js('toasts.length=0');await click('[data-rq-download="html0001"]');assert.deepEqual(await js('toasts'),[]);assert.equal(await js("document.querySelector('[data-rq-file-id=html0001] [data-rq-download-status]').hidden"),true);saveCanceled=false;report.checks.push('Cancel save is silent and clears the preceding row status');
    for(const code of [401,403,404,500]){status=code;await js("toasts.length=0;document.querySelector('[data-rq-error]').textContent=''");await click('[data-rq-file="html0001"]');await until(()=>js("document.querySelector('[data-rq-error]').textContent.length>0"),'HTTP failure feedback');const toast=await js("document.querySelector('[data-rq-error]').textContent");assert.match(toast,code===401||code===403?/凭证.*失效/:code===404?/不存在|权限/:/HTTP 500/);report.checks.push({http:code,toast})}status=200;
    openError='No application is associated';await js("toasts.length=0;document.querySelector('[data-rq-error]').textContent=''");await click('[data-rq-file="html0001"]');await until(()=>js("document.querySelector('[data-rq-error]').textContent.length>0"),'system association failure');assert.match(await js("document.querySelector('[data-rq-error]').textContent"),/没有可打开.*应用/);openError='';report.checks.push('Missing system app produces a specific error');
    await js('toasts.length=0');await click('[data-rq-download="html0001"]');await until(()=>fs.readFileSync(saves.at(-1)).equals(files[0].body),'download after open failure');report.checks.push('Download still works after system app failure');
    assert.deepEqual(await js('fixtureErrors'),[]);assert.deepEqual(errors,[]);
  }
  await js(`SoduWorkAPI.listAttachments=async()=>[{id:'html0001',filename:'index.html',role:'output'},{id:'mark0001',filename:'README.md',role:'output'},{id:'text0001',filename:'说明.txt',role:'output'}];
    SoduWorkAPI.taskTrace=async()=>({delivery:{artifact:{id:'version-2'},manifest:{files:[{id:'html0001'},{id:'mark0001'},{id:'text0001'}]}}});
    RequirementsDetail.close();RequirementsDetail.open('fixture-task')`);
  await until(()=>js("!!document.querySelector('[data-rq-bundle-download]')"),'automatic bundle card');
  const count=saves.length;
  await click('.rq-material-download[data-rq-bundle-download]');
  await until(()=>saves.length===count+1&&fs.existsSync(saves.at(-1))&&fs.readFileSync(saves.at(-1)).equals(bundleBytes),'native bundle save');
  assert.equal(path.extname(saves.at(-1)),'.zip');assert.equal(report.requests.at(-1).authorized,true);
  assert.equal(await js("document.querySelector('.rq-material-name[data-rq-bundle-download]')?.textContent || document.querySelector('[data-rq-bundle-download]')?.textContent"),path.basename(saves.at(-1)));
  await until(()=>js("document.querySelector('[data-rq-bundle-status]').textContent.includes('文件已保存')"),'visible bundle save receipt');
  assert.deepEqual(await js('fixtureErrors'),[]);
  report.checks.push('Automatic ZIP card -> production API/preload/IPC -> authenticated pinned download -> exact archive saved');
  const downloaded=saves.length,requested=report.requests.length;
  saveCanceled=true;
  await click('.rq-material-download[data-rq-bundle-download]');
  assert.equal(saves.length,downloaded);assert.equal(report.requests.length,requested);
  assert.equal(await js("document.querySelector('[data-rq-error]').textContent"),'');
  assert.equal(await js("document.querySelector('[data-rq-bundle-status]').hidden"),true);
  saveCanceled=false;
  status=500;
  await click('.rq-material-download[data-rq-bundle-download]');
  await until(()=>js("document.querySelector('[data-rq-error]').textContent.includes('HTTP 500')"),'bundle failure feedback');
  assert.match(await js("document.querySelector('[data-rq-bundle-status]').textContent"),/HTTP 500/);
  assert.deepEqual(fs.readFileSync(saves.at(-1)),bundleBytes);
  status=200;
  report.checks.push('ZIP cancellation is silent and HTTP failure preserves the previous saved archive');
  await click('.rq-material-download[data-rq-bundle-download]');
  await until(()=>js("document.querySelector('[data-rq-bundle-status]').textContent.includes('文件已保存')"),'retry save receipt');
  assert.equal(await js("document.querySelector('[data-rq-error]').textContent"),'');
  assert.deepEqual(fs.readFileSync(saves.at(-1)),bundleBytes);
  report.checks.push('Successful retry clears the old error and confirms the actual saved bytes');
  await click('[data-rq-bundle-library]');
  await until(()=>js('librarySaves.length===1'),'bundle library transfer');
  const savedLibrary=await js('librarySaves[0]');
  assert.deepEqual(Buffer.from(savedLibrary.bytes),bundleBytes);
  assert.equal(path.extname(savedLibrary.name),'.zip');
  assert.equal(savedLibrary.source.sessionId,undefined);
  assert.equal(report.requests.at(-1).version,'version-2');
  await until(()=>js("document.querySelector('[data-rq-bundle-library]').title.includes('已保存')"),'saved button state');
  await click('[data-rq-bundle-library]');
  assert.equal(await js('librarySaves.length'),1);
  assert.deepEqual(await js('fixtureErrors'),[]);
  report.checks.push('ZIP library button uses shared transfer/API and authenticated bytes; repeat clicks keep one saved copy');
  const storedBundle={id:'zip00001',filename:'完整产出-review.zip',contentType:'application/zip',body:bundleBytes};
  files.push(storedBundle);
  await js(`RequirementsDetail.close();SoduWorkAPI.listAttachments=async()=>[{id:'zip00001',filename:'完整产出-review.zip',role:'output',taskId:'fixture-task',artifactVersionId:'version-2',url:'/api/v1/attachments/zip00001?ticket=${ticket}'}];RequirementsDetail.open('fixture-task')`);
  await until(()=>js("!!document.querySelector('[data-rq-download=zip00001]')"),'stored ZIP card');
  assert.equal(await js("!!document.querySelector('[data-rq-bundle-download]')"),false);
  await click('[data-rq-download=zip00001]');
  await until(()=>js("document.querySelector('[data-rq-file-id=zip00001] [data-rq-download-status]').textContent.includes('文件已保存')"),'stored ZIP receipt');
  assert.deepEqual(fs.readFileSync(saves.at(-1)),bundleBytes);
  assert.equal(report.requests.at(-1).id,'zip00001');
  report.checks.push('Stored Runner ZIP uses its exact attachment route and confirms byte-identical save beside its unchanged filename');
  const textFile=files.find(file=>file.id==='text0001');
  const serialized={id:textFile.id,taskId:'fixture-task',artifactVersionId:'version-1',filename:textFile.filename,
    role:'output',size:textFile.body.length,url:'/api/v1/attachments/'+textFile.id+'?ticket='+ticket};
  await js(`RequirementsDetail.close();SoduWorkAPI.listAttachments=async()=>[${JSON.stringify(serialized)}];
    SoduWorkAPI.getTask=async id=>({id,title:'Archived work',status:'done',archivedAt:1,reviewedAt:1,canViewExecution:true});
    SoduWorkAPI.taskTrace=async()=>({});RequirementsDetail.open('fixture-task')`);
  await until(()=>js("!!document.querySelector('[data-rq-download=\"text0001\"]')"),'archived output card');
  const archivedSaves=saves.length;
  await click('[data-rq-download="text0001"]');
  await until(()=>saves.length===archivedSaves+1&&fs.existsSync(saves.at(-1)),'archived output saved');
  assert.deepEqual(fs.readFileSync(saves.at(-1)),textFile.body);
  report.checks.push('Archived task output with task/version metadata saves the original TXT, not a generated bundle');
  await js("RequirementsDetail.close();document.body.innerHTML='<main id=receipt></main>'");
  for(const file of ['plugin-ui-host.js','work-entry-sheet.js'])await js(fs.readFileSync(path.join(client,'components/panels',file),'utf8'));
  // Start at a successful creation receipt; the saved-material UI and all download IPC stay real.
  await js(`window.ComposeDraft={clear(){},openWith(proposal,bridge){bridge.box().textContent=proposal.title;
    bridge.onReceiptRendered('fixture-task',proposal.title,{attachments:[${JSON.stringify(serialized)}]});}};
    WorkEntrySheet.openTask({host:document.querySelector('#receipt'),proposal:{title:'Created and assigned requirement'}})`);
  await until(()=>js("!!document.querySelector('[data-wes-material=download]')"),'creation receipt materials');
  const receiptSaves=saves.length;
  ticketExpired=true;
  await click('[data-wes-material="download"]');
  await until(()=>saves.length===receiptSaves+1&&fs.existsSync(saves.at(-1)),'creation receipt download');
  assert.deepEqual(fs.readFileSync(saves.at(-1)),textFile.body);
  assert.equal(await js("document.querySelector('.wes-material-status').textContent"),'');
  report.checks.push('Creation receipt downloads full attachment metadata through production preload/IPC, including ticket renewal');
  assert.deepEqual(await js('fixtureErrors'),[]);
  report.ok=true;
}).catch(async e=>{report.error=e.stack;report.nativeErrors=errors;report.viewers=viewers.map(({win,...v})=>v);report.ui=await js('({bridge:typeof soduWorkAPI?.previewAttachment,error:document.querySelector("[data-rq-error]")?.textContent,errors:fixtureErrors,toasts})').catch(String)})
.finally(()=>{fs.writeFileSync(path.join(out,'after-ui.json'),JSON.stringify(report,null,2));for(const v of viewers)if(!v.win.isDestroyed())v.win.destroy();win?.destroy();server?.close();app.emit('before-quit');app.exit(report.ok?0:1)});
