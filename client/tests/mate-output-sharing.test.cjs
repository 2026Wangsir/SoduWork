const test=require('node:test'),assert=require('node:assert/strict'),fs=require('./renderer-source.cjs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const mate=require('../components/panels/chat-mate-mention');
test('collects only outputs in captured conversation, deduplicates task IDs and ignores inputs',async()=>{
 const calls=[];const context={ref:'a',api:{outputs:async ref=>{calls.push(ref);return{ok:true,artifacts:[{artifactId:'f',name:'report.pdf',size:2,at:1}]}}},taskIds:['t','t'],hub:{listAttachments:async id=>{calls.push(id);return[{id:'o',role:'output',filename:'result.pptx',size:3},{id:'i',role:'input',filename:'private.txt'}]}}};
 const rows=await mate.conversationOutputs(context);assert.equal(rows.length,2);assert.deepEqual(calls,['a','t']);
 const payload=await mate.outputPayload({...context,api:{artifactAction:async(ref,id,action)=>{assert.deepEqual([ref,id,action],['a','f','share']);return{ok:true,name:'report.pdf',data:'YWJj',size:3,at:1}}}},rows,'message');
 assert.deepEqual(payload.files,[{name:'report.pdf',data:'YWJj'},{attachmentId:'o'}]);assert.equal(payload.conversationId,'a');
});
test('websites share a complete related-file zip bundle and folders stay inline',async()=>{
 const context={ref:'site',api:{outputs:async()=>({ok:true,artifacts:[{artifactId:'index',name:'index.html',relative:'index.html',kind:'website',size:12,at:4}],}),artifactAction:async(ref,id,action)=>{
   assert.deepEqual([ref,id,action],['site','index','share-related']);
   return {ok:true,name:'site.zip',size:20,at:4,data:'UEsDBA==',preview:{status:'zip_only'}};
 }},taskIds:[],hub:{listAttachments:async()=>[]}};
 const rows=await mate.conversationOutputs(context);
 assert.deepEqual(rows.map(row=>row.name),['site.zip']);
 const payload=await mate.outputPayload(context,rows,'m');
 assert.deepEqual(payload.files,[{name:'site.zip',data:'UEsDBA=='}]);
 const folder={key:'folder:site.zip',name:'site.zip',size:20,inlineData:'UEsDBA=='};
 assert.deepEqual((await mate.outputPayload(context,[folder],'m')).files,[{name:'site.zip',data:'UEsDBA=='}]);
});

test('no conversation produces no files and local paths are never serialized',async()=>{
 assert.deepEqual(await mate.conversationOutputs(null),[]);
 const payload=await mate.outputPayload(null,[],'id');assert.deepEqual(payload.files,[]);
});
test('failed indexes reject while truncated indexes remain selectable',async()=>{
 await assert.rejects(mate.conversationOutputs({ref:'a',api:{outputs:async()=>({ok:false})}}));
 const rows=await mate.conversationOutputs({ref:'a',api:{outputs:async()=>({ok:true,truncated:true,artifacts:[{artifactId:'recent',name:'recent.md',size:2}]})}});
 assert.equal(rows.length,1);assert.equal(rows.truncated,true);
 await assert.rejects(mate.conversationOutputs({ref:'a',api:{outputs:async()=>({ok:true})},taskIds:['t'],hub:{listAttachments:async()=>{throw Error('offline')}}}));
});
test('limits and changed or missing outputs abort before sending',async()=>{
 await assert.rejects(mate.outputPayload({},Array(21).fill({}),'id'),/20/);
 await assert.rejects(mate.outputPayload({},[{size:25*1024*1024}],'id'),/24/);
 const context={ref:'a',api:{artifactAction:async()=>({ok:false,reason:'missing'})}};
 await assert.rejects(mate.outputPayload(context,[{artifactId:'f'}],'id'),/missing/);
 context.api.artifactAction=async()=>({ok:true,data:'eA==',at:2,size:1});
 await assert.rejects(mate.outputPayload(context,[{artifactId:'f',at:1}],'id'),/已更新/);
});
test('trusted main process exports exact binary bytes but refuses files outside the conversation',async()=>{
 const runtime=require('../main/conversation/artifact-runtime'),outputs=require('../main/pi-session/outputs');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'mate-share-'));
 try{
  const data=Buffer.from([0,1,255,128,13,10]);fs.writeFileSync(path.join(root,'result.pptx'),data);
  const session={cwd:root,outputSnapshot:()=>outputs.scan(root,0,0)};
  const item=session.outputSnapshot().delivery.items.find(x=>x.name==='result.pptx');
  const r=await runtime.action(session,'a',item.artifactId,'share',{});
  assert.equal(r.ok,true);assert.deepEqual(Buffer.from(r.data,'base64'),data);assert.equal(r.path,undefined);
  assert.equal((await runtime.action(session,'a','forged-id','share',{})).ok,false);
  const bad={cwd:root,outputSnapshot:()=>({delivery:{items:[{artifactId:'escape',path:path.join(root,'..','escape.txt')}]}})};
  assert.equal((await runtime.action(bad,'a','escape','share',{})).ok,false);
 }finally{fs.rmSync(root,{recursive:true,force:true})}
});

test('trusted website sharing awaits worker ZIP packaging and retains the transport payload', async () => {
 const runtime=require('../main/conversation/artifact-runtime'),outputs=require('../main/pi-session/outputs');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'soduwork-website-share-'));
 try {
  fs.writeFileSync(path.join(root,'index.html'),'<h1>Complete website</h1>');
  fs.writeFileSync(path.join(root,'style.css'),'h1 { color: red }');
  const session={cwd:root,outputSnapshot:()=>outputs.scan(root,0,0)};
  const item=session.outputSnapshot().delivery.items.find(x=>x.name==='index.html');
  const result=await runtime.action(session,'website-worker',item.artifactId,'share-related',{});
  assert.equal(result.ok,true);assert.equal(result.website,true);
  const bytes=Buffer.from(result.data,'base64');
  assert.equal(bytes.readUInt32LE(0),0x04034b50);
  assert.equal(result.size,bytes.length);assert.equal(result.path,undefined);
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});
test('notice persistence keeps only safe attachment metadata and deduplicates message IDs',()=>{
 const source=fs.readFileSync(path.join(__dirname,'../core/store.js'),'utf8');
 const start=source.indexOf('const LS_NOTICES='),end=source.indexOf('function noticeUnread()',start);
 const values=new Map();
 const ctx={Date,Math,_taskStorageKey:()=> 'fixture-notices',localStorage:{getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,value)}};
 ctx.window=ctx;vm.createContext(ctx);vm.runInContext(source.slice(start,end),ctx);
 const event={messageId:'id',attachments:[{id:'file',name:'result.pptx',size:4,url:'https://host/secret-ticket',data:'bytes'}]};
 ctx.logNotice('done',null,'mate_message',event);ctx.logNotice('done',null,'mate_message',event);
 const notices=vm.runInContext('notices',ctx);
 assert.equal(notices.length,1);assert.equal(notices[0].kind,'mate_message');assert.equal(notices[0].attachments[0].url,undefined);
 assert.equal(notices[0].attachments[0].data,undefined);
});

test('cancelling the native save dialog is not reported as a failed download',async()=>{
 const source=fs.readFileSync(path.join(__dirname,'../components/panels/panels-desk.js'),'utf8');
 const start=source.indexOf('async function _downloadNoticeFile('),end=source.indexOf('window.openNoticePanel',start);
 const messages=[],ctx={SoduWorkAPI:{mateMessageFile:async()=>({filename:'report.md'}),attachmentUrl:()=>'/safe'},window:{soduWorkAPI:{downloadAttachment:async()=>({ok:false,canceled:true})}},petSay:x=>messages.push(x)};
 vm.createContext(ctx);vm.runInContext(source.slice(start,end),ctx);const button={disabled:false,getAttribute:()=> 'file'};
 await ctx._downloadNoticeFile(button);assert.equal(button.disabled,false);assert.equal(messages.length,0);
});

test('notification save is explicit, blocks double clicks, and uses the library adapter',async()=>{
 const source=fs.readFileSync(path.join(__dirname,'../components/panels/panels-desk.js'),'utf8');
 const start=source.indexOf('async function _downloadNoticeFile('),end=source.indexOf('window.openNoticePanel',start);
 let release; const calls=[],messages=[],ctx={SoduWorkAPI:{taskStorageKey:()=> 'alice',saveMateMessageFileToLibrary:async id=>{calls.push(id);await new Promise(r=>release=r);return{ok:true}}},window:{},petSay:x=>messages.push(x)};
 vm.createContext(ctx);vm.runInContext(source.slice(start,end),ctx);
 const button={disabled:false,getAttribute:key=>key==='data-notice-action'?'save':'file'};
 assert.equal(calls.length,0);
 const pending=ctx._downloadNoticeFile(button);await ctx._downloadNoticeFile(button);
 assert.deepEqual(calls,['file']);assert.equal(button.disabled,true);
 release();await pending;assert.equal(button.disabled,false);assert.deepEqual(messages,['已保存到本机资料库']);
});

test('notice attachment rows expose save in both received and sent folders',()=>{
 const source=fs.readFileSync(path.join(__dirname,'../components/panels/panels-desk.js'),'utf8');
 const row=source.slice(source.indexOf('(files.length ?'),source.indexOf("(n.website && n.website.previewUrl"));
 assert.match(row,/data-notice-action=\"save\"/);
 assert.doesNotMatch(row,/_noticeFolder === 'received'/);
});
test('ZIP notification attachments use the ordinary file card without open',()=>{
 const source=fs.readFileSync(path.join(__dirname,'../components/panels/panels-desk.js'),'utf8');
 const start=source.indexOf('function _noticeFileIsZip('),end=source.indexOf('function _renderNoticePanel',start);
 const ctx={};vm.createContext(ctx);vm.runInContext(source.slice(start,end),ctx);
 assert.equal(ctx._noticeFileIsZip({name:'bundle.zip'}),true);assert.equal(ctx._noticeFileIsZip({name:'notes.md'}),false);
 const row=source.slice(source.indexOf('(files.length ?'),source.indexOf("(n.website && n.website.previewUrl"));
 const zipBranch=row.slice(row.indexOf('const fileCard = zip'),row.indexOf("\n            : '<button"));
 assert.match(row,/const name = String\(file\.name/);assert.match(row,/const fileCard = zip/);
 assert.match(row,/np-file np-file-static/);
 assert.doesNotMatch(zipBranch,/data-notice-action="open"/);
 assert.match(row,/: '<button type="button" class="np-file" data-notice-action="open"/);
 assert.match(row,/data-notice-action="download"/);assert.match(row,/data-notice-action="save"/);
});
test('ZIP notification actions align with ordinary attachment actions',()=>{
 const css=fs.readFileSync(path.join(__dirname,'../components/panels/notice-type-scale.css'),'utf8');
 assert.match(css,/\.notice-panel \.np-attachment\s*>\s*\.np-file-download:first-child\s*\{[^}]*margin-left\s*:\s*auto\s*;?\s*\}/);
});

test('a late notification save cannot announce success in the next account',async()=>{
 const source=fs.readFileSync(path.join(__dirname,'../components/panels/panels-desk.js'),'utf8');
 const start=source.indexOf('async function _downloadNoticeFile('),end=source.indexOf('window.openNoticePanel',start);
 let scope='alice',release;const messages=[],ctx={SoduWorkAPI:{taskStorageKey:()=>scope,saveMateMessageFileToLibrary:()=>new Promise(r=>release=r)},window:{},petSay:x=>messages.push(x)};
 vm.createContext(ctx);vm.runInContext(source.slice(start,end),ctx);
 const button={disabled:false,getAttribute:key=>key==='data-notice-action'?'save':'file'};
 const pending=ctx._downloadNoticeFile(button);scope='bob';release({ok:true});await pending;assert.deepEqual(messages,[]);
});


test('progress context keeps visible exchanges and excludes thoughts, tools and code blocks',()=>{
 const snapshot={status:'streaming',messages:[
 {role:'user',text:'制作一个原型'},{role:'assistant',blocks:[{kind:'thinking',text:'private thought'},{kind:'text',text:'已完成页面结构'}]},
 {role:'tool',text:'command and key'},{role:'assistant',blocks:[{kind:'text',text:'导出尚未验证'}]}]};
 const facts=mate.progressContext(snapshot,{files:[{name:'index.html'}]});
 assert.equal(facts.messages.length,3);assert.deepEqual(facts.outputs,['index.html']);
 assert.ok(!JSON.stringify(facts).includes('private thought'));assert.ok(!JSON.stringify(facts).includes('command and key'));
 assert.equal(facts.messages[2].text,'导出尚未验证');
});
test('large progress context is bounded while preserving the original request and newest update',()=>{
 const messages=Array.from({length:130},(_,i)=>({role:i%2?'assistant':'user',text:'message-'+i+' '+('x'.repeat(3000))}));
 const facts=mate.progressContext({messages});
 assert.ok(facts.messages.length<=60);assert.ok(facts.messages.reduce((n,m)=>n+m.text.length,0)<=24000);
 assert.ok(facts.messages[0].text.startsWith('message-0 '));assert.ok(facts.messages.at(-1).text.startsWith('message-129 '));
 assert.ok(facts.omittedMessages>0);
});
test('attachment open uses fresh authorization and the native preview action',async()=>{
 const source=fs.readFileSync(path.join(__dirname,'../components/panels/panels-desk.js'),'utf8');
 const start=source.indexOf('async function _downloadNoticeFile('),end=source.indexOf('window.openNoticePanel',start);
  const calls=[],ctx={SoduWorkAPI:{mateMessageFile:async id=>{calls.push(id);return{filename:'report.md'}},attachmentUrl:()=>'/fresh-ticket'},
  window:{soduWorkAPI:{previewAttachment:async p=>{calls.push(p);return{ok:true}},downloadAttachment:()=>{throw Error('wrong action')}}}};
 vm.createContext(ctx);vm.runInContext(source.slice(start,end),ctx);
 const button={disabled:false,getAttribute:key=>key==='data-notice-action'?'open':'file'};
  await ctx._downloadNoticeFile(button);assert.equal(calls[0],'file');assert.equal(calls[1].url,'/fresh-ticket');assert.equal(calls[1].filename,'report.md');assert.equal(button.disabled,false);
});
test('system attachment opening rejects programs and scripts while supporting office files',()=>{
 const {canOpenWithSystem}=require('../main/attachment-files');
 for(const name of ['report.pptx','Sheet.XLSX','index.html','brief.docx'])assert.equal(canOpenWithSystem(name),true);
 for(const name of ['report.pdf.exe','run.ps1','start.cmd','open.lnk','code.js','foo.msi'])assert.equal(canOpenWithSystem(name),false);
});

test('summary request uses the current UI locale and its own timeout without changing source facts',async()=>{
 const timers=[],calls=[],window={};const ctx={window,localStorage:{getItem:()=>null,setItem(){}},User:{id:'test'},navigator:{platform:'test'},console:{log(){},error(){}},
 AbortController:class{constructor(){this.signal={}}abort(){}},FormData:class{},WebSocket:class{},setTimeout:(_,ms)=>{timers.push(ms);return 0},clearTimeout(){},
 fetch:async(url,options)=>{calls.push({url,options});return{ok:true,status:200,text:async()=>JSON.stringify({text:'draft'})}}};
 vm.createContext(ctx);vm.runInContext(fs.readFileSync(path.join(__dirname,'../api.js'),'utf8'),ctx);
 const facts={messages:[{role:'user',text:'work'}]};await window.SoduWorkAPI.draftMateMessage(facts);
 assert.equal(timers.at(-1),30000);assert.ok(calls[0].url.endsWith('/team/message-draft'));assert.deepEqual(JSON.parse(calls[0].options.body),{...facts,locale:'zh-CN'});
 for(const locale of ['en-US','ja-JP','ko-KR','zh-CN']){
  window.SoduWorkI18n={getLocale:()=>locale};
  await window.SoduWorkAPI.draftMateMessage({...facts,locale:'stale'});
  assert.deepEqual(JSON.parse(calls.at(-1).options.body),{...facts,locale});
 }
 assert.deepEqual(facts,{messages:[{role:'user',text:'work'}]});
 await window.SoduWorkAPI.mateMessageFile('file');assert.equal(timers.at(-1),8000);
});

test('empty and fallback summaries translate only generated labels, preserving original user content',()=>{
 const translated={
  '您好，以下是我当前的工作进展：':'Hello, here is my current work progress:',
  '目前还没有可总结的工作内容，请补充后再发送。':'No work to summarize yet. Add details before sending.',
  '当前工作':'Current work','请补充已完成的进展和后续安排。':'Add completed progress and next steps.',
 };
 const seen=[],window={SoduWorkI18n:{translateText:value=>{seen.push(value);return translated[value]||value;}}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../components/panels/chat-mate-mention.js'),'utf8'),{window});
 assert.doesNotMatch(window.ChatMateMention.progressDraft(null),/[\u4e00-\u9fff]/);
 const original='保留我的原始描述';
 const text=window.ChatMateMention.progressDraft({messages:[{role:'user',text:original}]});
 assert.ok(text.includes(original));assert.ok(text.startsWith('Hello'));assert.ok(!seen.includes(original));
});
