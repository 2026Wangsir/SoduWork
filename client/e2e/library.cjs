'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict'), { spawn } = require('node:child_process');
const output = process.argv[2], python = process.argv[3];
if (!output || !path.isAbsolute(output) || !python) throw Error('Usage: electron e2e/library.cjs ABS_OUTPUT PYTHON');
fs.mkdirSync(output, { recursive:true });
const temporary = fs.mkdtempSync(path.join(os.tmpdir(),'soduwork-library-e2e-'));
app.setPath('userData',path.join(temporary,'profile'));
const client = path.resolve(__dirname,'..'), backend = path.resolve(client,'../hub-backend');
const report = {ok:false,boundary:'Production library UI and Hub HTTP APIs against an isolated loopback store; PC-local routing is covered separately.',cases:[],screenshots:[],errors:[]};
let win, server, logs = '';
const read = file => fs.readFileSync(path.join(client,file),'utf8');
const js = code => win.webContents.executeJavaScript(code.trim().startsWith('(await ') ? '(async()=>('+code+'))()' : code, true);
const sleep = ms => new Promise(resolve=>setTimeout(resolve,ms));
async function until(code) {
  for(let i=0;i<140;i++) { if(await js(code)) return; await sleep(40); }
  throw Error('Timed out: '+code);
}
async function click(selector) {
  // Grid names and list buttons can use display:contents. Click the visible
  // box belonging to the requested control, never the zero-size wrapper at 0,0.
  const p = await js(`(()=>{const control=document.querySelector(${JSON.stringify(selector)});if(!control)throw Error('Missing '+${JSON.stringify(selector)});const el=[control.querySelector('.library-card-name'),control].find(node=>{const r=node?.getBoundingClientRect();return r&&r.width>0&&r.height>0});if(!el)throw Error('No visible box '+${JSON.stringify(selector)});el.scrollIntoView({block:'nearest'});const r=el.getBoundingClientRect(),point={x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)},hit=document.elementFromPoint(point.x,point.y);if(!hit||!control.contains(hit))throw Error('Click target is obscured '+${JSON.stringify(selector)});return point})()`);
  for(const type of ['mouseDown','mouseUp']) win.webContents.sendInputEvent({type,button:'left',clickCount:1,...p});
  await sleep(90);
  if (selector === '[data-preview-close]') await until('!document.querySelector(".library-preview-pane")');
}
async function type(selector,text) {
  await click(selector);
  // Use the native edit action; Control+A is not Select All on macOS.
  win.webContents.selectAll();
  await until(`(() => { const input = document.querySelector(${JSON.stringify(selector)}); return input === document.activeElement && input.selectionStart === 0 && input.selectionEnd === input.value.length; })()`);
  await win.webContents.insertText(text);
}
async function menu(id) { await click('[data-library-menu-toggle="item-'+id+'"]'); }
async function loaded() { await until('!document.querySelector(".library-spinner") && document.querySelector("[data-library-title]")'); await sleep(90); }
async function shot(name) {
  const file=path.join(output,name+'.png');fs.writeFileSync(file,(await win.webContents.capturePage()).toPNG());report.screenshots.push(file);
}
async function createDoc(title,content) {
  assert.equal(await js('document.querySelector("[data-library-create-kind=document]")'), null);
  await js(`(() => { const input=document.querySelector('[data-library-upload]'), data=new DataTransfer();
    data.items.add(new File([${JSON.stringify(content)}],${JSON.stringify(title+'.txt')},{type:'text/plain'}));
    input.files=data.files;input.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  await until(`document.querySelector('[data-library-content]').textContent.includes(${JSON.stringify(title)})`);
  await loaded();
}
async function startServer() {
  const probe=require('node:net').createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));
  const port=probe.address().port;await new Promise(r=>probe.close(r));
  server=spawn(python,['-m','uvicorn','tests.library_browser_server:app','--host','127.0.0.1','--port',String(port)],{cwd:backend,windowsHide:true,env:{...process.env,SODUWORK_LIBRARY_E2E_ROOT:temporary},stdio:['ignore','pipe','pipe']});
  server.stdout.on('data',d=>logs+=d);server.stderr.on('data',d=>logs+=d);
  server.on('error',e=>logs+=e.message);
  const url='http://127.0.0.1:'+port;
  for(let i=0;i<200;i++) { try{if((await fetch(url+'/ready')).ok)return url;}catch{} if(server.exitCode!==null)break; await sleep(100); }
  throw Error('Fixture server failed: '+logs);
}
async function verifyPreviewHttp() {
  const html='<!doctype html><html><head><style>body{background:rgb(3,70,50)}</style></head><body><h1>保存网页预览</h1></body></html>';
  const definitions=[
    {name:'说明.txt',type:'text/plain',text:'上传的中文内容\r\n原文保留'},
    {name:'网页.html',type:'text/html',text:html},
    {name:'配置.cjs',type:'application/octet-stream',text:'module.exports = { title: "中文配置" };'},
    {name:'编码.txt',type:'text/plain',bytes:[0xd6,0xd0,0xce,0xc4]},
    {name:'图片.png',type:'image/png',base64:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKk0AAAAASUVORK5CYII='},
  ];
  await js(`(()=>{const dt=new DataTransfer();for(const f of ${JSON.stringify(definitions)})dt.items.add(new File([f.bytes?new Uint8Array(f.bytes):f.base64?Uint8Array.from(atob(f.base64),c=>c.charCodeAt(0)):f.text],f.name,{type:f.type}));const el=document.querySelector('[data-library-upload]');el.files=dt.files;el.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await until('document.querySelectorAll(".library-file-card").length===5');await loaded();
  const rows=await js('(await SoduWorkAPI.listLibrary({scope:"all",storage:"local"})).items');
  await click('[data-library-view=list]');
  for (const file of definitions) {
    const row=rows.find(item=>item.filename===file.name);assert.ok(row);
    if (await js('!!document.querySelector("[data-preview-close]")')) await click('[data-preview-close]');
    await click('[data-library-file-preview="'+row.id+'"]');
    if(file.base64) { await until('document.querySelector("[data-preview-body] img")?.naturalWidth>0'); }
    else if(file.type==='text/html') {
      await until('!!document.querySelector("[data-preview-body] iframe")?.srcdoc');
      assert.equal(await js('document.querySelector("[data-preview-body] iframe").getAttribute("sandbox")'),'allow-scripts');
      assert.equal(await js('document.querySelectorAll("[data-preview-tab], [data-preview-title], [data-preview-body] pre").length'), 0);
      assert.equal(await js('new DOMParser().parseFromString(document.querySelector("[data-preview-body] iframe").srcdoc,"text/html").querySelector("h1").textContent'), '保存网页预览');
    } else {
      await until('!!document.querySelector("[data-preview-body] pre")');
      assert.equal(await js('document.querySelector("[data-preview-body] pre").textContent'),file.bytes?'中文':file.text);
      if(file.bytes)assert.match(await js('document.querySelector("[data-preview-status]").textContent'),/GB18030/);
    }
    report.cases.push('Multipart upload, storage, real HTTP content read and modal preview: '+file.name);
  }
  await shot('preview-http-image');await click('[data-preview-close]');
  assert.equal(await js('document.querySelectorAll(".library-preview-pane").length'),0);
  report.cases.push('Close removes the preview while retaining the stored file list');
  const zipFiles = {
    'empty/': '',
    '资料/说明.txt': '压缩包内的中文原文\r\n保留换行',
    'site/index.html': '<!doctype html><html><head><link rel="stylesheet" href="site.css"></head><body><h1>Stored ZIP HTML</h1><script>window.httpZipFixture=true</script></body></html>',
    'site/site.css': 'body{background:rgb(20,65,45);color:white}',
  };
  const packed = require('node:child_process').spawnSync(python, ['-c', 'import base64,io,json,sys,zipfile; b=io.BytesIO(); z=zipfile.ZipFile(b,"w",zipfile.ZIP_DEFLATED); [z.writestr(p,c) for p,c in json.loads(sys.stdin.buffer.read().decode("utf-8")).items()]; z.close(); print(base64.b64encode(b.getvalue()).decode())'], { input: JSON.stringify(zipFiles), encoding: 'utf8', windowsHide: true });
  assert.equal(packed.status, 0, packed.stderr);
  const zip = await js(`(async()=>{const bytes=Uint8Array.from(atob(${JSON.stringify(packed.stdout.trim())}),c=>c.charCodeAt(0));return (await SoduWorkAPI.uploadLibraryFile(new File([bytes],'资料预览.zip',{type:'application/zip'}))).item})()`);
  await js('openLibraryPanel();void 0;'); await loaded();
  await click('[data-library-file-preview="'+zip.id+'"]');
  await until('!!document.querySelector("[data-archive-folder]")');
  const listing = await js(`(async()=>await SoduWorkAPI.getLibraryArchive(${JSON.stringify(zip.id)}))()`);
  assert.ok(listing.archive.files.some(member=>member.path==='资料/说明.txt'));
  assert.ok(listing.archive.files.some(member=>member.path.replace(/\/$/,'')==='empty'&&member.isDirectory));
  const folderSelector = async memberPath => js(`(()=>{const e=[...document.querySelectorAll('[data-archive-folder]')].find(e=>e.dataset.archiveFolder.replace(/\\/$/,'')===${JSON.stringify(memberPath)});if(!e)throw Error('Missing folder');return '[data-archive-folder='+JSON.stringify(e.dataset.archiveFolder)+']'})()`);
  await click(await folderSelector('资料')); await click('[data-archive-file="资料/说明.txt"]');
  await until('document.querySelector("[data-preview-body] pre")?.textContent.includes("压缩包内的中文原文")');
  assert.equal(await js('document.querySelector("[data-preview-body] pre").textContent'), zipFiles['资料/说明.txt']);
  const member = await js(`(async()=>{const blob=await SoduWorkAPI.readLibraryArchiveFile(${JSON.stringify(zip.id)},'资料/说明.txt');return{content:await blob.text(),size:blob.size}})()`);
  assert.equal(member.content, zipFiles['资料/说明.txt']); assert.equal(member.size, Buffer.byteLength(member.content));
  report.cases.push('Actual ZIP multipart upload and storage expose folders and exact Chinese member bytes through production archive HTTP routes');
  await click('[data-archive-root]'); await click(await folderSelector('site')); await click('[data-archive-file="site/index.html"]');
  await until('!!document.querySelector("[data-preview-body] iframe")?.srcdoc');
  let archiveFrame;
  for (let attempt=0;attempt<140&&!archiveFrame;attempt++) {
    for (const frame of win.webContents.mainFrame.frames) if(!frame.isDestroyed()&&await frame.executeJavaScript('Boolean(window.httpZipFixture)').catch(()=>false)) {archiveFrame=frame;break;}
    if(!archiveFrame)await sleep(40);
  }
  assert.ok(archiveFrame,'Stored ZIP HTML executes only inside its preview sandbox');
  assert.equal(await archiveFrame.executeJavaScript('getComputedStyle(document.body).backgroundColor'),'rgb(20, 65, 45)');
  assert.equal(await archiveFrame.executeJavaScript('document.querySelector("h1").textContent'), 'Stored ZIP HTML');
  assert.equal(await js('document.querySelectorAll("[data-preview-tab], [data-preview-title]").length'), 0);
  await shot('preview-http-zip'); await click('[data-preview-close]');
  report.cases.push('Stored ZIP HTML renders directly with relative CSS through authenticated member reads');
  assert.deepEqual(report.errors,[]);report.ok=true;
}
async function verifyComposer() {
  for (const file of ['components/panels/panels-base.css','components/panels/agent-brand.css','components/panels/panels-chat.css','components/panels/conversation-attachments.css','components/panels/work-composer.css','components/panels/work-intent.css']) {
    await js(`(()=>{const style=document.createElement('style');style.textContent=${JSON.stringify(read(file))};document.head.appendChild(style);})()`);
  }
  await js(`window.sent=[];window.soduWorkAPI={conversationSession:{workdir:async()=>({ok:true,dir:'C:/isolated'}),setMode:async()=>({ok:true,mode:'full'}),capabilities:async()=>({ok:true,items:[]}),probe:async()=>({ok:true}),runtimes:async()=>({ok:true,runtimes:[{id:'pi',displayName:'Pi'}]})}};SoduWorkAPI.myModels=async()=>({usable:[]});window.NativeChat={hasSession:()=>false,reset:()=>{},enter:async(text,id,options)=>{sent.push({text,id,options});return true;}};void 0;`);
  for (const file of ['agent-brand.js','work-composer.js','work-intent.js','conversation-attachments.js','panels-compose-runtime.js','panels-compose-capabilities.js','panels-compose-work-actions.js','compose-surface.js','panels-compose.js']) await js(read('components/panels/'+file)+'\nvoid 0;');
  await js(`WorkspaceHost.open=(view,payload)=>{closeLibraryPanel();document.documentElement.dataset.workspaceView='create';openComposePanel(payload);};void 0;`);
  const upload=await js('(await SoduWorkAPI.listLibrary({scope:"all",storage:"local"})).items.find(x=>x.filename==="上传.txt").id');
  await menu(upload);await click('[data-library-chat="'+upload+'"]');
  await until('!!document.querySelector("#cpAtts .catt-item")');
  assert.equal(await js('document.querySelector("#cpAtts .catt-copy b").textContent'),'上传.txt');
  assert.match(await js('document.querySelector("#cpInput").value'),/上传.txt/);
  await shot('library-to-composer-en');
  await click('#cpGo');await until('sent.length===1');
  assert.equal(await js('new TextDecoder().decode(sent[0].options.attachments[0].data)'),'上传的中文内容');
  assert.equal(await js('sent[0].options.attachments[0].name'),'上传.txt');
  assert.ok(await js('sent[0].options.contextPrompts.length>0'));
  report.cases.push('Library action opens the production composer with a visible attachment; Send passes original bytes and context to the agent boundary (model is isolated)');
  await js(`closeComposePanel();document.documentElement.dataset.workspaceView='library';openLibraryPanel();`);await loaded();
}
app.whenReady().then(async()=>{
  const url=await startServer();
  win=new BrowserWindow({show:false,width:1200,height:850,webPreferences:{contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  win.webContents.on('console-message',(_e,level,message)=>{if(level>=3)report.errors.push(message);});
  win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(r,cb)=>cb({cancel:!r.url.startsWith(url+'/')}));
  await win.loadFile(path.join(__dirname,'fixtures/library.html'));
  await js(`localStorage.setItem('soduwork_work_hub_environment_v1','development');localStorage.setItem('soduwork_work_development_hub_url_v1',${JSON.stringify(url)});localStorage.setItem('soduwork_work_user_id','e2e-alice');window.notices=[];window.petSay=m=>notices.push(m);window.handoffs=[];window.WorkspaceHost={open:(view,payload)=>{handoffs.push({view,payload});}};void 0;`);
  // This fixture exercises the Hub HTTP library store, including its historical
  // storage=local rows. Keep the HTTP facade here; PC-local routing and real IPC
  // are covered by library-client-local.cjs and generated-output-library-roundtrip.cjs.
  await js('window.__SODUWORK_TEST_HUB_CONFIG__ = { allowSwitch: true }; window.SoduWorkLocalLibraryAPI = { install() {} }; void 0;');
  for(const file of JSON.parse(read('core/locales/manifest.json')))await js(read('core/locales/'+file));
  for(const file of ['core/i18n-dom.js','core/i18n.js','core/api-work-plugins.js', 'api.js','components/panels/library-file-icons.js','components/panels/panels-library-dialogs.js','components/panels/library-delivery.js','components/panels/library-preview-html.js','components/panels/library-preview-archive.js','components/panels/library-preview-pane.js','components/panels/panels-library.js'])await js(read(file)+'\nvoid 0;');
  await js('SoduWorkI18n.setLocale("zh-CN");openLibraryPanel()');await loaded();
  win.webContents.debugger.attach('1.3');await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});
  await until('document.querySelector("[data-library-storage=remote]").disabled');
  if(process.env.SODUWORK_LIBRARY_E2E_SCOPE==='preview') { await verifyPreviewHttp(); return; }
  await createDoc('保存','原始资料：保存，不翻译业务内容。');
  const id=await js('(await SoduWorkAPI.listLibrary({scope:"all",storage:"local"})).items[0].id');
  assert.equal(await js(`(await SoduWorkAPI.readLibraryContent(${JSON.stringify(id)})).content`),'原始资料：保存，不翻译业务内容。');
  report.cases.push('Upload a text document through the production API and read exact saved bytes; no document creation entry');
  await click('[data-library-menu-toggle="create"]');await click('[data-library-menu="create"] [data-library-create-kind="folder"]');
  await type('[data-library-folder-name]','删除');await click('.library-folder-editor-save');await until('!document.querySelector(".library-folder-dialog")');await loaded();
  await menu(id);await click('[data-library-move="'+id+'"]');await until('!!document.querySelector(".library-move-dialog")');
  await click('[data-library-move-folder]:not([data-library-move-folder=""])');await loaded();
  const listed=await js('(await SoduWorkAPI.listLibrary({scope:"all",storage:"local"}))');
  const folder=listed.folders.find(x=>x.name==='删除');assert.ok(folder);
  await click('[data-library-scope=all]');await loaded();
  await click('[data-library-folder="'+folder.id+'"]');await loaded();
  await menu(id);await click('[data-library-rename="'+id+'"]');await type('[data-library-folder-name]','保存（新版）');await click('.library-folder-editor-save');await loaded();
  await menu(id);await click('[data-library-favorite="'+id+'"]');await loaded();
  assert.equal(await js(`(await SoduWorkAPI.listLibrary({scope:'favorites',storage:'local'})).items.find(x=>x.id===${JSON.stringify(id)}).favorite`),true);
  report.cases.push('Create a folder, move and rename a document, and favorite it through visible controls');
  await menu(id);await click('[data-library-chat="'+id+'"]');await until('handoffs.length===1');
  assert.equal(await js('handoffs[0].payload.initialFiles[0].text()'),'原始资料：保存，不翻译业务内容。');
  assert.match(await js('handoffs[0].payload.prefill'),/保存（新版）/);
  report.cases.push('Discuss action passes an actual File with original bytes and the correct title');
  await js(`window.realReadLibraryBinary=SoduWorkAPI.readLibraryBinary;SoduWorkAPI.readLibraryBinary=async()=>{throw Error('Isolated read failure');};void 0;`);
  await menu(id);await click('[data-library-chat="'+id+'"]');await sleep(100);
  assert.equal(await js('handoffs.length'),1);assert.equal(await js('notices.at(-1)'),'Isolated read failure');
  await js('SoduWorkAPI.readLibraryBinary=realReadLibraryBinary;void 0;');
  report.cases.push('A failed file read keeps the library open and never sends an empty or imaginary attachment');
  const savePath=path.join(output,'downloaded.txt');
  const downloaded=new Promise((resolve,reject)=>win.webContents.session.once('will-download',(_e,item)=>{item.setSavePath(savePath);item.once('done',(_e,state)=>state==='completed'?resolve():reject(Error(state)));}));
  await menu(id);await click('[data-library-download="'+id+'"]');await downloaded;
  assert.equal(fs.readFileSync(savePath,'utf8'),'原始资料：保存，不翻译业务内容。');
  report.cases.push('Download from the menu preserves exact Unicode file content');
  await menu(id);await click('[data-library-delete="'+id+'"]');await until('!!document.querySelector(".library-confirm-dialog")');await click('.library-confirm-submit');await loaded();
  await click('[data-library-trash]');await loaded();
  await click('[data-library-restore="'+id+'"]');await loaded();await click('[data-library-root]');await loaded();
  const restored=await js(`(await SoduWorkAPI.listLibrary({scope:'all',storage:'local',folderId:${JSON.stringify(folder.id)}})).items`);assert.ok(restored.some(x=>x.id===id));
  report.cases.push('Soft-delete, trash navigation and restore preserve the original folder');
  // Browser file input boundary: File objects come from the renderer, then the
  // actual multipart upload, storage and preview paths are used.
  await js(`(()=>{const dt=new DataTransfer();dt.items.add(new File(['上传的中文内容'],'上传.txt',{type:'text/plain'}));dt.items.add(new File([Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKk0AAAAASUVORK5CYII='),c=>c.charCodeAt(0))],'图片.png',{type:'image/png'}));const el=document.querySelector('[data-library-upload]');el.files=dt.files;el.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await until('document.querySelectorAll(".library-file-card").length===2');await loaded();
  await click('[data-library-view=grid]');await until('Array.from(document.querySelectorAll("[data-library-image]")).some(x=>x.complete&&x.naturalWidth>0)');
  await js('window.gridClickEvents=[];for(const name of ["mousedown","mouseup","click"]){document.addEventListener(name,event=>{gridClickEvents.push({type:event.type,trusted:event.isTrusted,x:event.clientX,y:event.clientY,target:event.target.tagName+"."+event.target.className,previewId:event.target.closest?.("[data-library-file-preview]")?.dataset.libraryFilePreview});if(gridClickEvents.length>30)gridClickEvents.shift()},true)}void 0;');
  report.gridClickBefore=await js('(()=>{const button=document.querySelector(".kind-image [data-library-file-preview]"),name=button.querySelector(".library-card-name")||button,r=name.getBoundingClientRect(),b=button.getBoundingClientRect(),hit=document.elementFromPoint(b.x+b.width/2,b.y+b.height/2);return{nameDisplay:getComputedStyle(name).display,nameRect:{x:r.x,y:r.y,width:r.width,height:r.height},buttonRect:{x:b.x,y:b.y,width:b.width,height:b.height},hit:hit?.tagName+"."+hit?.className,hitBelongsToButton:button.contains(hit),viewport:{width:innerWidth,height:innerHeight}}})()');
  await click('.kind-image [data-library-file-preview]');
  report.gridClickAfter=await js('(()=>{const button=document.querySelector(".kind-image [data-library-file-preview]"),r=button.getBoundingClientRect();return{rect:{x:r.x,y:r.y,width:r.width,height:r.height},events:gridClickEvents,preview:!!document.querySelector(".library-preview-pane")}})()');
  await until('!!document.querySelector(".library-preview-pane img")?.naturalWidth');
  await js('document.documentElement.setAttribute("data-window-menu","")');
  const imageDialog=await js('(()=>{const e=document.querySelector(".library-preview-pane"),r=e.getBoundingClientRect();return{top:r.top,bottom:r.bottom,height:innerHeight,modal:e.matches(":modal")}})()');
  assert.ok(imageDialog.modal && imageDialog.top>=0 && imageDialog.bottom<=imageDialog.height,JSON.stringify(imageDialog));
  await js('document.documentElement.removeAttribute("data-window-menu")');
  await shot('library-image-zh');await click('[data-preview-close]');
  report.cases.push('Multipart text/image upload, grid thumbnail and full-size image preview use stored content');
  const textId=await js('(await SoduWorkAPI.listLibrary({scope:"all",storage:"local"})).items.find(x=>x.filename==="上传.txt").id');
  await click('[data-library-file-preview="'+textId+'"]');await until('document.querySelector("[data-preview-body] pre")?.textContent==="上传的中文内容"');
  assert.match(await js('document.querySelector("[data-preview-status]").textContent'), /UTF-8/);
  await click('[data-preview-close]');
  const rawHtml='<!doctype html><html><head><style>body{background:rgb(3,70,50)}</style></head><body><h1>保存网页预览</h1></body></html>';
  const htmlItem=await js(`(await SoduWorkAPI.uploadLibraryFile(new File([${JSON.stringify(rawHtml)}],'网页.html',{type:'text/html'}))).item`);
  await js('openLibraryPanel();void 0;');await loaded();
  await click('[data-library-file-preview="'+htmlItem.id+'"]');await until('!!document.querySelector("[data-preview-body] iframe")?.srcdoc');
  assert.equal(await js('document.querySelector("[data-preview-body] iframe").getAttribute("sandbox")'), 'allow-scripts');
  assert.equal(await js('document.querySelectorAll("[data-preview-tab], [data-preview-title], [data-preview-body] pre").length'), 0);
  assert.equal(await js('new DOMParser().parseFromString(document.querySelector("[data-preview-body] iframe").srcdoc,"text/html").querySelector("h1").textContent'), '保存网页预览');
  await shot('library-html-http');await click('[data-preview-close]');
  report.cases.push('Stored plain text remains literal and HTML renders directly through real HTTP preview=true reads');
  if (process.env.SODUWORK_LIBRARY_E2E_SCOPE === 'preview') { report.ok=true; return; }
  for (const action of ['purge','empty']) {
    await createDoc('临时回收站验证-'+action,'Only isolated test content');
    const trashId=await js(`(await SoduWorkAPI.listLibrary({scope:'all',storage:'local'})).items.find(x=>x.title===${JSON.stringify('临时回收站验证-'+action)}).id`);
    await menu(trashId);await click('[data-library-delete="'+trashId+'"]');await click('.library-confirm-submit');await loaded();
    await click('[data-library-trash]');await loaded();
    await click(action==='purge'?'[data-library-purge="'+trashId+'"]':'[data-library-empty-trash]');await click('.library-confirm-submit');await loaded();
    assert.equal(await js('(await SoduWorkAPI.listLibrary({scope:"trash",storage:"local"})).items.length'),0);
    await click('[data-library-root]');await loaded();
  }
  await click('[data-library-view=grid]');
  report.cases.push('Permanent delete and empty-trash confirmations remove only the isolated disposable documents');
  await shot('library-zh');
  await js('SoduWorkI18n.setLocale("en-US")');await sleep(150);await shot('library-en');
  assert.equal(await js('document.querySelector("[data-library-title]").textContent'),'Library');
  assert.ok((await js('document.querySelector("[data-library-content]").innerText')).includes('删除'));
  assert.equal(await js('document.querySelector("[data-library-create-kind=document]")'), null);
  const namedId=await js('(await SoduWorkAPI.listLibrary({scope:"all",storage:"local"})).items.find(x=>x.filename==="上传.txt").id');
  await menu(namedId);await click('[data-library-rename="'+namedId+'"]');
  await type('[data-library-folder-name]','删除');
  await js('SoduWorkI18n.setLocale("zh-CN");SoduWorkI18n.setLocale("en-US")');await sleep(100);
  assert.equal(await js('document.querySelector("[data-library-folder-name]").value'),'删除');
  await shot('library-rename-en');await click('[data-library-folder-cancel]');
  report.cases.push('Language changes translate library/dialog controls while preserving names and unsaved text');
  await menu(namedId);await click('[data-library-rename="'+namedId+'"]');await type('[data-library-folder-name]','保存 & 删除');await click('.library-folder-editor-save');await loaded();
  await menu(namedId);await click('[data-library-delete="'+namedId+'"]');
  const confirmation=await js('document.querySelector(".library-confirm-description").textContent');
  assert.ok(confirmation.includes('保存 & 删除.txt'),confirmation);assert.match(confirmation,/trash|restor/i);
  await click('.library-confirm-cancel');
  await menu(namedId);await click('[data-library-rename="'+namedId+'"]');await type('[data-library-folder-name]','上传');await click('.library-folder-editor-save');await loaded();
  for(const kind of ['image','spreadsheet','presentation']) {
    await click('[data-library-menu-toggle=create]');await click('[data-library-menu=create] [data-library-create-kind='+kind+']');
    assert.equal(await js('/[\\u3400-\\u9fff]/.test(handoffs.at(-1).payload.prefill+handoffs.at(-1).payload.contextPrompts.join(""))'),false);
  }
  report.cases.push('English confirmations preserve Chinese names and punctuation; image, spreadsheet and presentation creation prompts follow the selected language');
  report.libraryMissing=await js('SoduWorkI18n.getMissing()');
  assert.deepEqual(report.libraryMissing,[]);
  win.setSize(760,700);await sleep(180);await shot('library-en-small');
  const box=await js(`(()=>{const e=document.querySelector('#libraryPanel'),r=e.getBoundingClientRect();return{left:r.left,top:r.top,bottom:r.bottom,width:e.clientWidth,scroll:e.scrollWidth,height:innerHeight};})()`);
  assert.ok(box.left>=50&&box.top>=0&&box.bottom<=box.height,JSON.stringify(box));assert.ok(box.scroll<=box.width+1,JSON.stringify(box));
  report.cases.push('Small-screen English layout stays inside the workspace and keeps the rail accessible');
  // A slow folder walk must never reopen private data after navigation.
  const rootItem=await js('(await SoduWorkAPI.listLibrary({scope:"all",storage:"local"})).items[0].id');
  await js(`window.realListLibrary=SoduWorkAPI.listLibrary;window.releaseFolderList=null;SoduWorkAPI.listLibrary=filters=>filters.scope==='folders'?new Promise(resolve=>{releaseFolderList=()=>resolve({folders:[{id:'old-private-folder',name:'Private old folder'}]});}):realListLibrary.call(SoduWorkAPI,filters);void 0;`);
  await menu(rootItem);await click('[data-library-move="'+rootItem+'"]');await until('!!releaseFolderList');
  await js(`closeLibraryPanel();releaseFolderList();SoduWorkAPI.listLibrary=realListLibrary;void 0;`);await sleep(150);
  assert.equal(await js('document.querySelectorAll(".library-move-dialog").length'),0);
  assert.equal(await js('getComputedStyle(document.querySelector("#libraryPanel")).display'),'none');
  report.cases.push('Pending folder walks stop after leaving; no stale dialog or invisible panel overlays the next page');
  await js('openLibraryPanel()');await loaded();
  win.setSize(1200,850);await sleep(100);await verifyComposer();
  await js(`localStorage.setItem('soduwork_work_user_id','e2e-bob');dispatchEvent(new CustomEvent('soduwork-data-scope-changed'))`);await loaded();
  assert.equal(await js('document.querySelectorAll(".library-card").length'),0);
  report.cases.push('Account change clears the old list, previews and dialogs before loading the new owner');
  report.missing=await js('SoduWorkI18n.getMissing()');assert.deepEqual(report.missing,[]);report.ok=true;
}).catch(async e=>{report.error=e.stack;if(win&&!win.isDestroyed()){report.previewState=await js('({title:document.querySelector("[data-preview-title]")?.textContent,body:document.querySelector("[data-preview-body]")?.textContent,notice:window.notices})').catch(()=>null);await shot('failure').catch(()=>{});}}).finally(async()=>{
  if(!report.ok)report.backendLog=logs;
  fs.writeFileSync(path.join(output,'library-report.json'),JSON.stringify(report,null,2));
  win?.destroy();server?.kill();app.exit(report.ok?0:1);
});
