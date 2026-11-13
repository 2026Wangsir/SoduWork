const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const { EventEmitter } = require('node:events');
const source = fs.readFileSync(path.join(__dirname, '../components/panels/conversation-attachments.js'), 'utf8');
function renderer() { const context = {window:{}}; vm.runInNewContext(source, context); return context.window.ConversationAttachments; }
const url = 'http://127.0.0.1:9999/api/v1/attachments/12345678?ticket=abcdefghijklmnopqrstuvwx';
function harness(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-attachment-runtime-'));
  const app = new EventEmitter(); app.getPath = () => root;
  const state = {status:200, type:'text/html', data:Buffer.from('中文附件'), fetched:[], opened:[], windows:[], cancel:false,
    owner:'alice', identity:{hub:'http://127.0.0.1:9999',clientId:'device'},parentClosed:false};
  const parent={isDestroyed:()=>state.parentClosed};
  class Window extends EventEmitter {
    static fromWebContents() { return parent; }
    constructor(options) { super();this.options=options;this.webContents=new EventEmitter();this.webContents.session=new EventEmitter();Object.assign(this.webContents.session,{setPermissionRequestHandler:()=>{},setPermissionCheckHandler:()=>{}});this.webContents.setWindowOpenHandler=()=>{};state.windows.push(this); }
    isDestroyed() { return !!this.closed; }
    close() { this.closed=true;this.emit('closed'); }
    show() { this.shown=true; }
    async loadURL(target) { this.url=target;if(state.loadError)throw Error('synthetic load failure');await state.waitLoad?.();this.emit('ready-to-show'); }
  }
  const handlers = {};
  const modulePath=require.resolve('../main/attachment-files');delete require.cache[modulePath];
  require(modulePath).install({app,BrowserWindow:Window,identityOf:()=>state.identity,ownerOf:()=>state.owner,ipcMain:{handle:(name,fn)=>handlers[name]=fn},
    authenticatedIdentityOf:async()=>{await state.waitAuth?.();return {...state.identity,session:'current-account-session'}},
    fetchAuthenticated:async(identity,target,options)=>{state.fetched.push({target,options,identity});await state.waitFetch?.();return state.response?.() || new Response(state.data,{status:state.status,headers:{'Content-Type':state.type}})},
    net:{fetch:async(target,options)=>{state.fetched.push({target,options});await state.waitFetch?.();return state.ticketResponse?.(target) || new Response(state.data,{status:state.status,headers:{'Content-Type':state.type}})}},
    shell:{openPath:async target=>{state.opened.push(target);return state.openError||''}},
    dialog:{showSaveDialog:async()=>{await state.waitDialog?.();return{canceled:state.cancel,filePath:state.savePath||path.join(root,'saved.bin')}}}});
  const api={previewAttachment:p=>handlers['attachment-preview']({sender:{id:1}},p),downloadAttachment:p=>handlers['attachment-download']({sender:{id:1}},p),readAttachmentBinary:p=>handlers['attachment-read-binary']({sender:{id:1}},p)};
  t.after(()=>{app.emit('before-quit');assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep+'soduwork-attachment-runtime-'));fs.rmSync(root,{recursive:true,force:true})});
  return {state,root,api,open:filename=>renderer().openTaskAttachment({url,filename,contentType:state.type},{api})};
}

test('shared task preview routes documents separately from raster images, including metadata-free delivery files', async()=>{
  for(const [filename,contentType,image] of [['报告.html','text/html',false],['报告.md','text/markdown',false],['文件.pdf','application/pdf',false],['资料.docx','',false],['图片.JPG','',true],['图片.png','application/octet-stream',true],['download','IMAGE/PNG; charset=binary',true],['伪装.png','image/svg+xml',false],['脚本.svg','image/svg+xml',false]]){
    let payload;await renderer().openTaskAttachment({url,filename,contentType},{api:{previewAttachment:async p=>{payload=p;return{ok:true,native:true}}}});
    assert.equal(payload.inlineImage,image,filename);assert.equal(payload.url,url);
  }
});

test('HTML and Office documents download once to a contained Unicode path before system handoff', async t=>{
  const h=harness(t);
  for(const filename of ['05_指标模块验证报告.html','资料.docx','表格.xlsx','演示.pptx']){
    assert.equal((await h.open(filename)).external,true);
    const target=h.state.opened.at(-1);assert.equal(path.basename(target),filename);assert.equal(path.basename(path.dirname(target)),'12345678');assert.deepEqual(fs.readFileSync(target),h.state.data);
  }
  assert.equal(h.state.fetched.length,4);
});

test('long attachment names preserve their file type for system and Markdown previews', async t=>{
  const h=harness(t);
  const stem='a'.repeat(180);
  h.state.type='application/octet-stream';
  assert.equal((await h.open(stem+'.docx')).external,true);
  const target=h.state.opened.at(-1);
  assert.equal(path.extname(target),'.docx');
  assert.equal(path.basename(target).length,180);
  assert.deepEqual(fs.readFileSync(target),h.state.data);

  h.state.data=Buffer.from('# Long filename');
  assert.equal((await h.open(stem+'.md')).native,true);
  const html=Buffer.from(h.state.windows.at(-1).url.split(',')[1],'base64').toString();
  assert.match(html,/<h1>Long filename<\/h1>/);
});

test('Markdown renders as a safe native preview while CSV, JSON and plain text stay literal', async t=>{
  const h=harness(t);
  for(const [filename,type] of [['报告.md','text/markdown'],['说明.txt','text/plain'],['数据.csv','text/csv'],['资料.json','application/json']]){
    h.state.type=type;assert.equal((await h.open(filename)).native,true);
    const w=h.state.windows.at(-1);
    if (/\.md$/i.test(filename)) {
      assert.ok(w.url.startsWith('data:text/html;charset=utf-8;base64,'));
      const html=Buffer.from(w.url.split(',')[1],'base64').toString();
      assert.match(html,/data-user-content/);assert.match(html,/仅显示|<main/);
    } else {
      assert.ok(w.url.startsWith('data:text/plain;charset=utf-8;base64,'));assert.deepEqual(Buffer.from(w.url.split(',')[1],'base64'),h.state.data);
    }
    assert.equal(w.options.webPreferences.javascript,false);assert.equal(w.options.webPreferences.sandbox,true);assert.equal(w.options.webPreferences.nodeIntegration,false);
  }
  h.state.type='text/plain; charset="windows-1252"';await h.open('latin.txt');assert.match(h.state.windows.at(-1).url,/charset=windows-1252/);
});

test('Markdown filename preview is independent of a generic server MIME and strips active content', async t=>{
  const h=harness(t);h.state.type='application/octet-stream';h.state.data=Buffer.from('# 标题\n\n<script>alert(1)</script>\n\n![远程图片](https://evil.example/x.png)');
  assert.equal((await h.open('说明.md')).native,true);
  const html=Buffer.from(h.state.windows.at(-1).url.split(',')[1],'base64').toString();
  assert.ok(html.includes('<h1>标题</h1>'));assert.doesNotMatch(html,/<script>/);assert.doesNotMatch(html,/evil\.example\/x\.png/);
});

test('native preview load failure rejects instead of reporting success', async t=>{
  const h=harness(t);h.state.type='text/plain';h.state.loadError=true;
  await assert.rejects(h.open('报告.txt'),/预览窗口加载失败.*下载/);assert.equal(h.state.windows.at(-1).isDestroyed(),true);
});

test('wrong origin, missing ticket and wrong path never download or open', async t=>{
  const h=harness(t);
  for(const target of [url.replace('127.0.0.1','evil.example'),url.split('?')[0],url.replace('/attachments/','/tasks/')])await assert.rejects(h.api.previewAttachment({url:target,filename:'报告.html'}));
  assert.equal(h.state.fetched.length,0);assert.equal(h.state.opened.length,0);
});

test('HTTP authorization, missing file, server and redirect failures preserve a useful error', async t=>{
  const h=harness(t),ui=renderer();
  for(const [status,expected] of [[401,/凭证.*失效/],[403,/凭证.*失效/],[404,/不存在|权限/],[500,/HTTP 500/],[302,/跳转/]]){
    h.state.status=status;await assert.rejects(h.open('报告.html'),error=>{assert.match(ui.taskAttachmentError(new Error("Error invoking remote method 'attachment-preview': Error: "+error.message),'fallback'),expected);return true});
  }
  assert.equal(h.state.opened.length,0);
});

test('downloads preserve bytes, cancellation is silent, and missing system apps do not prevent saving', async t=>{
  const h=harness(t);h.state.openError='No association';await assert.rejects(h.open('报告.html'),/系统没有可打开/);
  assert.equal((await h.api.downloadAttachment({url,filename:'报告.html'})).ok,true);assert.deepEqual(fs.readFileSync(path.join(h.root,'saved.bin')),h.state.data);
  const count=h.state.fetched.length;h.state.cancel=true;assert.deepEqual(await h.api.downloadAttachment({url,filename:'报告.html'}),{ok:false,canceled:true});assert.equal(h.state.fetched.length,count);
});

test('permission and disk failures have actionable messages without exposing local paths',()=>{
  const ui=renderer();
  for(const code of ['EPERM','EACCES','EBUSY'])assert.match(ui.taskAttachmentError(new Error(code+': open C:/private/file'),'fallback'),/目录权限|其他位置/);
  assert.match(ui.taskAttachmentError(new Error('ENOSPC: C:/private/file'),'fallback'),/磁盘空间/);
  assert.equal(ui.taskAttachmentError(new Error('private stack and path'),'fallback'),'fallback');
});

test('delivery bundles share native save and binary reads with exact Hub version routing', async t => {
  const h = harness(t), payload = {deliveryBundle:true, taskId:'task-one', artifactVersionId:'version-two', filename:'交付物.zip'};
  h.state.data = Buffer.from([80,75,3,4,0,255,42]); h.state.type = 'application/zip';
  assert.equal((await h.api.downloadAttachment(payload)).ok, true);
  assert.deepEqual(fs.readFileSync(path.join(h.root,'saved.bin')), h.state.data);
  assert.equal(h.state.fetched[0].target,'http://127.0.0.1:9999/api/v1/tasks/task-one/artifacts.zip?artifactVersionId=version-two');
  assert.equal(h.state.fetched[0].identity.clientId,'device');
  assert.equal(h.state.fetched[0].identity.session,'current-account-session');
  const binary = await h.api.readAttachmentBinary(payload);
  assert.deepEqual(Buffer.from(binary.data,'base64'),h.state.data);
  assert.equal(binary.name,'交付物.zip');
  const count = h.state.fetched.length;
  for (const forged of [{...payload,taskId:'../other'}, {...payload,artifactVersionId:'v?redirect=1'}, {...payload,url:'https://other.test'}])
    await assert.rejects(h.api.downloadAttachment(forged),/交付/);
  h.state.cancel = true;
  assert.equal((await h.api.downloadAttachment(payload)).canceled,true);
  assert.equal(h.state.fetched.length,count);
});

test('serialized task attachments keep their own route despite task and artifact metadata', async t => {
  const h = harness(t);
  for (const filename of ['autumn.txt', '元旦新年贺词.txt', '作品.zip']) {
    const file = {id:'12345678',taskId:'assigned-task',artifactVersionId:'v1',role:'output',
      filename,contentType:'application/octet-stream',size:h.state.data.length,url};
    h.state.fetched.length = 0;
    assert.equal((await h.api.downloadAttachment(file)).ok, true);
    assert.deepEqual(fs.readFileSync(path.join(h.root,'saved.bin')), h.state.data);
    const binary = await h.api.readAttachmentBinary(file);
    assert.deepEqual(Buffer.from(binary.data,'base64'), h.state.data);
    assert.equal(h.state.fetched.length, 2);
    for (const request of h.state.fetched) {
      assert.equal(request.target, url);
      assert.equal(request.identity, undefined, 'ordinary signed URLs must not receive account credentials');
    }
    await assert.rejects(h.api.downloadAttachment({...file,url:url.replace('127.0.0.1','external.invalid')}));
    await assert.rejects(h.api.downloadAttachment({...file,url:''}));
    assert.equal(h.state.fetched.length, 2);
  }
});

test('expired attachment tickets renew through the signed account for previews, downloads and library reads', async t => {
  const h = harness(t), refreshed = url.replace('abcdefghijklmnopqrstuvwx', 'renewedabcdefghijklmnopq');
  h.state.type = 'text/markdown';
  h.state.ticketResponse = target => new Response(target.includes('renewed') ? h.state.data : 'expired', {
    status: target.includes('renewed') ? 200 : 401, headers: {'Content-Type': h.state.type},
  });
  h.state.response = () => Response.json({ok:true,attachmentId:'12345678',url:refreshed});
  for (const action of [() => h.open('说明.md'), () => h.api.downloadAttachment({url,filename:'说明.md'}),
    () => h.api.readAttachmentBinary({url,filename:'说明.md'})]) {
    h.state.fetched.length = 0;
    assert.equal((await action()).ok, true);
    assert.equal(h.state.fetched.length, 3);
    const renewal = h.state.fetched[1];
    assert.equal(renewal.target, 'http://127.0.0.1:9999/api/v1/attachments/12345678/access');
    assert.equal(renewal.options.method, 'POST');
    assert.equal(renewal.identity.session, 'current-account-session');
  }
  assert.deepEqual(fs.readFileSync(path.join(h.root,'saved.bin')),h.state.data);
});

test('attachment renewal cannot change the attachment or leak a result across accounts', async t => {
  const h = harness(t);
  h.state.ticketResponse = () => new Response('expired', {status:401});
  for (const target of [url.replace('127.0.0.1','external.invalid'),url.replace('12345678','87654321')]) {
    h.state.response = () => Response.json({ok:true,attachmentId:'12345678',url:target});
    await assert.rejects(h.open('说明.md'), /不属于|不匹配/);
  }
  h.state.waitAuth = () => {h.state.owner = 'bob';};
  await assert.rejects(h.api.downloadAttachment({taskId:'task-1',filename:'作品.zip'}), /已切换/);
  assert.equal(fs.existsSync(path.join(h.root,'saved.bin')), false);
});

test('bundle writes reject account changes during the authenticated download', async t => {
  const h = harness(t);
  h.state.waitFetch = async () => { h.state.owner = 'bob'; };
  await assert.rejects(h.api.downloadAttachment({taskId:'task',artifactVersionId:'v1',filename:'file.zip'}),/已取消/);
  assert.equal(fs.existsSync(path.join(h.root,'saved.bin')),false);
});

test('native bundle downloads stream beyond the IPC binary limit and verify all bytes', async t => {
  const h = harness(t), crypto = require('node:crypto');
  const chunk = Buffer.alloc(1024 * 1024, 42), hash = crypto.createHash('sha256');
  for (let i = 0; i < 65; i++) hash.update(chunk);
  const expected = hash.digest('hex');
  let count = 0;
  h.state.response = () => new Response(new ReadableStream({pull(controller) {
    if (count++ < 65) controller.enqueue(chunk); else controller.close();
  }}), {headers:{'X-Artifact-SHA256':expected}});
  assert.equal((await h.api.downloadAttachment({taskId:'task',artifactVersionId:'v2',filename:'large.zip'})).ok,true);
  const saved = path.join(h.root,'saved.bin');
  assert.equal(fs.statSync(saved).size,65 * chunk.length);
  const actual = crypto.createHash('sha256');
  for await (const bytes of fs.createReadStream(saved)) actual.update(bytes);
  assert.equal(actual.digest('hex'),expected);
  assert.deepEqual(fs.readdirSync(h.root),['saved.bin']);
});

test('failed or invalid bundle streams preserve the destination and remove partial files', async t => {
  for (const failure of ['digest','empty','network','account','size']) {
    const h = harness(t), saved = path.join(h.root,'saved.bin');
    fs.writeFileSync(saved,'existing delivery');
    let reads = 0;
    h.state.response = () => new Response(new ReadableStream({pull(controller) {
      if (failure === 'empty') return controller.close();
      if (reads++ === 0) return controller.enqueue(Buffer.from('partial ZIP'));
      if (failure === 'network') return controller.error(new Error('connection interrupted'));
      if (failure === 'account') h.state.owner = 'bob';
      controller.close();
    }}), {headers: failure === 'size' ? {'Content-Length':String(2 ** 31 + 1)} :
      failure === 'digest' ? {'X-Artifact-SHA256':'0'.repeat(64)} : {}});
    await assert.rejects(h.api.downloadAttachment({taskId:'task',artifactVersionId:'v2',filename:'file.zip'}),
      /校验失败|connection interrupted|已取消|下载上限/,failure);
    assert.equal(fs.readFileSync(saved,'utf8'),'existing delivery',failure);
    assert.deepEqual(fs.readdirSync(h.root),['saved.bin'],failure);
  }
});

test('missing stored objects explain recovery while other 404 bodies stay private', async t=>{
  const h=harness(t);h.state.status=404;h.state.type='application/json';
  h.state.data=Buffer.from(JSON.stringify({detail:'附件文件已丢失'}));
  await assert.rejects(h.api.readAttachmentBinary({url,filename:'output.md'}),/源文件已丢失.*原执行电脑/);
  for(const data of ['<html>private proxy error</html>',JSON.stringify({detail:'附件不存在'}),'x'.repeat(17000)]){
    h.state.data=Buffer.from(data);
    await assert.rejects(h.api.readAttachmentBinary({url,filename:'output.md'}),/^Error: 附件不存在或你没有查看权限$/);
  }
});

test('missing bundle sources report recovery and never create a phantom downloaded file', async t => {
  const h=harness(t);h.state.status=502;h.state.type='application/json';
  h.state.data=Buffer.from(JSON.stringify({detail:'当前固定版本的源文件已丢失，拒绝返回不完整压缩包'}));
  await assert.rejects(h.api.downloadAttachment({taskId:'task',artifactVersionId:'v2',filename:'作品.zip'}),/源文件已丢失.*原执行电脑/);
  assert.deepEqual(fs.readdirSync(h.root),[]);
});

test('active SVG or executable attachments cannot use the passive-image path or launch via the OS', async t=>{
  const h=harness(t);h.state.type='image/svg+xml';
  assert.equal((await h.api.previewAttachment({url,filename:'fake.png',inlineImage:true})).ok,false);
  for(const filename of ['script.svg','program.exe','script.cmd'])await assert.rejects(h.open(filename),/不支持直接打开/);
  assert.equal(h.state.opened.length,0);assert.equal((await h.api.downloadAttachment({url,filename:'script.svg'})).ok,true);
});

test('图片预览读取迟到时遵守宿主有效性，不再创建旧弹层', async()=>{
  let current=true,resolve;
  const pending=renderer().openTaskAttachment({url,filename:'图片.png',contentType:'image/png'},
    {isCurrent:()=>current,api:{previewAttachment:()=>new Promise(done=>{resolve=done})}});
  current=false;resolve({ok:true,mimeType:'image/png',data:'cG5n'});
  const result=await pending;assert.equal(result.ok,false);assert.equal(result.canceled,true);
});

test('附件读取期间账号、Hub、设备或父窗口变化都阻止打开旧内容', async t=>{
  for(const mutation of [s=>s.owner='bob',s=>s.identity.hub='http://different.invalid',s=>s.identity.clientId='new-device',s=>s.parentClosed=true]){
    const h=harness(t);let release;h.state.waitFetch=()=>new Promise(done=>{release=done});
    const pending=h.open('报告.html');await new Promise(done=>setImmediate(done));mutation(h.state);release();
    await assert.rejects(pending,/账号|服务|窗口|设备/);assert.equal(h.state.opened.length,0);assert.equal(h.state.windows.length,0);
  }
});

test('保存对话框和文件下载等待后重新核对账号，拒绝写入旧附件', async t=>{
  for(const wait of ['waitDialog','waitFetch']){
    const h=harness(t);let release;h.state[wait]=()=>new Promise(done=>{release=done});
    const pending=h.api.downloadAttachment({url,filename:'报告.html'});await new Promise(done=>setImmediate(done));h.state.owner='bob';release();
    await assert.rejects(pending,/账号|服务/);assert.equal(fs.existsSync(path.join(h.root,'saved.bin')),false);
    if(wait==='waitDialog')assert.equal(h.state.fetched.length,0);
  }
});

test('原生预览加载期间切换账号，不显示新建的旧附件窗口', async t=>{
  const h=harness(t);h.state.type='text/plain';let release;h.state.waitLoad=()=>new Promise(done=>{release=done});
  const pending=h.open('说明.txt');await new Promise(done=>setImmediate(done));h.state.owner='bob';release();
  await assert.rejects(pending,/账号|服务/);assert.equal(h.state.windows[0].isDestroyed(),true);assert.notEqual(h.state.windows[0].shown,true);
});

test('已失效宿主不发起附件读取', async()=>{
  let called=false;
  const result=await renderer().openTaskAttachment({url,filename:'图片.png'},
    {isCurrent:()=>false,api:{previewAttachment:async()=>{called=true;return{ok:true}}}});
  assert.equal(result.canceled,true);assert.equal(called,false);
});

test('图片、文本和附件原件读取迟到时都不得把旧账号数据交给渲染进程', async t=>{
  for(const [method,payload] of [['previewAttachment',{inlineImage:true}],['previewAttachment',{inlineText:true}],['readAttachmentBinary',{}]]){
    const h=harness(t);h.state.type=payload.inlineImage?'image/png':'text/markdown';let release;
    h.state.waitFetch=()=>new Promise(done=>{release=done});
    const pending=h.api[method]({url,filename:payload.inlineImage?'图片.png':'说明.md',...payload});
    await new Promise(done=>setImmediate(done));h.state.owner='bob';release();
    await assert.rejects(pending,/账号|服务/);assert.equal(h.state.opened.length,0);assert.equal(h.state.windows.length,0);
  }
});
