'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const code=fs.readFileSync(path.join(__dirname,'../components/panels/library-transfer.js'),'utf8');
const tick=()=>new Promise(r=>setImmediate(r));
function harness(){
 let scope='alice';const events=[],calls=[],messages=[],sources=[],broadcasts=[];const h={upload:async()=>({ok:true,item:{id:'item'}})};
 const global={SoduWorkAPI:{taskStorageKey:()=>scope,uploadLibraryFile:async(file,folderId,storage,source)=>{calls.push(file);sources.push(source??null);return h.upload(file);},uploadLibraryOutput:async(ref,file,folderId,source)=>{calls.push({ref,file});sources.push(source??null);return h.upload(file);}},soduWorkAPI:{broadcast:(kind,payload)=>broadcasts.push({kind,payload})},
 dispatchEvent:e=>events.push(e),addEventListener(){},petSay:s=>messages.push(s)};
 vm.runInNewContext(code,{window:global,File,CustomEvent:class{constructor(type,options){this.type=type;this.detail=options?.detail;}}});
 return Object.assign(h,{global,api:global.LibraryTransfer,events,calls,messages,sources,broadcasts,switchScope:()=>{scope='bob';}});
}

test('task archive actions use the shared delivery manifest and reject stale or switched scopes',async()=>{
 const h=harness(),downloads=[];
 const node={dataset:{libraryBundle:'task',libraryBundleIds:'["html","css"]'},disabled:false,isConnected:true};
 let ids=['html','css'];
 h.global.SoduWorkAPI.taskTrace=async()=>({task:{title:'Website'},delivery:{artifact:{id:'version-2'},manifest:{files:ids.map(id=>({id}))}}});
 h.global.SoduWorkAPI.downloadArtifactsZip=async(...args)=>downloads.push(args);
 await h.api.downloadBundle(node);
 assert.deepEqual(downloads,[['task','Website','version-2']]);
 ids.push('new-file');
 await h.api.downloadBundle(node);
 assert.equal(downloads.length,1);
 assert.match(h.messages.at(-1),/交付版本已变化/);
 h.global.SoduWorkAPI.taskTrace=async()=>{h.switchScope();return{delivery:{artifact:{id:'another-user'}}};};
 await h.api.downloadBundle(node);
 assert.equal(downloads.length,1);
 assert.equal(node.disabled,false);
});

test('requirement bundles share compact library controls and never inherit another chat source',async()=>{
 const h=harness();h.api.bindSession(()=>({sessionId:'unrelated',conversationTitle:'Other chat'}));
 const file={deliveryBundle:true,taskId:'task',attachmentIds:['a','b'],artifactVersionId:'v2',name:'交付物.zip'};
 const html=h.api.button(file,'','data-rq-bundle-library');
 assert.match(html,/rq-library-save/);assert.match(html,/保存到本机资料库/);
 assert.equal(await h.api.saveOutput('',file),true);
 assert.equal(h.sources[0],null);
 assert.equal(await h.api.saveOutput('',{...file,attachmentIds:['b','a']}),true);
 assert.equal(h.calls.length,1);
});
test('automatic inputs retain bytes and the clipboard display name, deduplicate retries, and skip library imports/directories',async()=>{
 const h=harness(),file=new File([new Uint8Array([0,255,42])],'image.png',{type:'image/png'});
 const job=h.api.trackFile(file,{name:'粘贴图片-123.png',source:'paste'});
 assert.equal(job,h.api.trackFile(file,{source:'retry'}));await job.promise;
 assert.equal(job.status,'saved');assert.equal(h.calls.length,1);assert.equal(h.calls[0].name,'粘贴图片-123.png');
 assert.deepEqual(Buffer.from(await h.calls[0].arrayBuffer()),Buffer.from([0,255,42]));
 assert.equal(h.api.trackFile(new File(['existing'],'exists.txt'),{source:'library'}),null);
 assert.equal(h.api.trackFile(new File(['folder'],'folder'),{kind:'dir'}),null);
 assert.equal(h.events[0].type,'soduwork-library-changed');
 assert.equal(h.broadcasts[0].kind,'library');
});
test('automatic transfer failure is recoverable without rejecting or losing the selected File',async()=>{
 const h=harness();h.upload=async()=>{throw Error('offline');};
 const file=new File(['original'],'upload.md'),job=h.api.trackFile(file,{});await job.promise;
 assert.equal(job.status,'error');assert.equal(h.messages.length,1);
 h.upload=async()=>({ok:true});h.api.retry(job);await job.promise;
 assert.equal(job.status,'saved');assert.equal(await h.calls[1].text(),'original');
});
test('background transfers use bounded concurrency and never send queued files after identity change',async()=>{
 const h=harness(),releases=[];h.upload=()=>new Promise(r=>releases.push(r));
 const jobs=[0,1,2,3].map(i=>h.api.trackFile(new File(['private'],'file'+i+'.txt'),{}));
 await tick();assert.equal(h.calls.length,2);h.switchScope();releases.forEach(r=>r({ok:true}));await Promise.all(jobs.map(j=>j.promise));
 assert.equal(h.calls.length,2);assert.equal(h.events.length,0);assert.equal(h.messages.length,0);assert.ok(jobs.every(j=>j.status==='error'));
});
test('preview and chat saves share in-flight work, capture the session/file, and allow changed versions',async()=>{
 const h=harness();let finish;h.upload=()=>new Promise(r=>finish=r);
 const file={artifactId:'opaque',name:'report.html',at:1};
 const first=h.api.saveOutput('session-one',file),second=h.api.saveOutput('session-one',file);file.name='mutated';await tick();
 assert.equal(h.calls.length,1);assert.equal(h.calls[0].ref,'session-one');assert.equal(h.calls[0].file.name,'report.html');
 finish({ok:true});assert.equal(await first,true);assert.equal(await second,true);
 h.upload=async()=>({ok:true});await h.api.saveOutput('session-one',{...file,at:2});assert.equal(h.calls.length,2);
});
test('saved chat output keeps a visible library label and locates the receipt without reuploading', async () => {
 const h=harness(), opened=[];
 h.global.WorkspaceHost={open:(view,payload)=>{opened.push({view,...payload});return true;}};
 const file={artifactId:'preview-output',name:'report.html',at:1,size:12};
 const node={dataset:{libraryOutput:'preview-output',libraryRef:'chat',libraryVersion:'1:12'},classList:{toggle(){}},setAttribute(){},innerHTML:''};
 assert.equal(await h.api.saveOutput('chat',file,node),true);
 assert.match(node.innerHTML,/library-save-label/);
 assert.match(h.api.button(file,'chat'),/已保存到资料库/);
 assert.doesNotMatch(h.api.button(file,'chat'),/is-preview/);
 assert.equal(await h.api.saveOutput('chat',file,node),true);
 assert.equal(opened.length,1);assert.equal(opened[0].view,'library');assert.equal(opened[0].itemId,'item');
 assert.equal(opened[0].revealOnly,true);assert.equal(h.calls.length,1);
});
test('saved output preview keeps the workbench action and falls back to the library item', async () => {
 const h=harness(), library=[], workspace=[];
 h.global.LibraryDelivery={openItem:item=>{library.push(item.id);return true;}};
 h.global.ChatWorkbench={openOutput:id=>{workspace.push(id);return false;}};
 const file={artifactId:'library-preview',name:'report.html',at:1,size:12};
 const node={dataset:{wbLibraryUpload:'library-preview',libraryRef:'chat',libraryVersion:'1:12'},classList:{toggle(){}},setAttribute(){},innerHTML:''};
 assert.equal(await h.api.saveOutput('chat',file,node),true);
 assert.equal(await h.api.saveOutput('chat',file,node),true);
 assert.deepEqual(library,['item']);
 assert.deepEqual(workspace,['library-preview']);
});
test('failed manual save permits retry and an opaque artifact is savable without revealing a local path',async()=>{
 const h=harness();assert.equal(h.api.canSave({artifactId:'opaque'}),true);
 h.upload=async()=>({ok:false,reason:'failed'});assert.equal(await h.api.saveOutput('ref',{artifactId:'opaque'}),false);
 h.upload=async()=>({ok:true});assert.equal(await h.api.saveOutput('ref',{artifactId:'opaque'}),true);assert.equal(h.calls.length,2);
});

test('persisted output receipts hydrate cold buttons and share a task attachment across chat and pool', async () => {
 const h=harness(), key=JSON.stringify(['attachment','task','file']);
 h.global.SoduWorkAPI.libraryOutputKey=()=>key;
 let saved=null;
 h.global.SoduWorkAPI.getLibraryOutputStatus=async()=>({ok:true,item:saved});
 h.upload=async()=>{saved={id:'local-existing'};return {ok:true,item:saved};};
 const chat={cloudTaskId:'task',remoteAttachmentId:'file',artifactId:'opaque',at:999};
 const pool={taskId:'task',attachmentId:'file',at:1};
 await Promise.all([h.api.saveOutput('chat',chat),h.api.saveOutput('',pool)]);
 assert.equal(h.calls.length,1);
 const cold=harness();
 cold.global.SoduWorkAPI.libraryOutputKey=()=>key;
 cold.global.SoduWorkAPI.getLibraryOutputStatus=async()=>({ok:true,item:saved});
 cold.api.button(pool,'','data-rq-library');await tick();
 assert.match(cold.api.button(pool,'','data-rq-library'),/is-saved/);
 assert.equal(await cold.api.saveOutput('chat',chat),true);assert.equal(cold.calls.length,0);
});

test('requirement transfers update replacement buttons, show failure reasons and never borrow open-chat provenance',async()=>{
 const h=harness(),file={taskId:'task',attachmentId:'attachment',name:'output.md',at:1,size:3};
 h.api.bindSession(()=>({sessionId:'unrelated-chat'}));
 let finish;h.upload=()=>new Promise(r=>finish=r);
 const error={hidden:true,textContent:''};
 const replacement={dataset:{rqLibrary:'task:attachment',libraryRef:'',libraryVersion:'1:3'},
  classList:{toggle(){}},setAttribute(){},parentElement:{querySelector:()=>error}};
 h.global.document={querySelectorAll:()=>[replacement]};
 const pending=h.api.saveOutput('',file);await tick();
 assert.equal(replacement.disabled,true);assert.match(replacement.innerHTML,/正在保存/);
 assert.equal(h.sources[0],null);
 finish({ok:false,reason:'源文件已丢失 <private>'});assert.equal(await pending,false);
 assert.equal(replacement.disabled,false);assert.equal(error.hidden,false);assert.match(error.textContent,/源文件已丢失/);
 const failed=h.api.button(file,'','data-rq-library');assert.match(failed,/源文件已丢失 &lt;private&gt;/);
 h.upload=async()=>({ok:true,item:{id:'saved'}});assert.equal(await h.api.saveOutput('',file),true);
 assert.equal(error.hidden,true);assert.match(replacement.innerHTML,/已保存/);
 assert.match(h.api.button(file,'','data-rq-library'),/is-saved/);
 const count=h.calls.length;await h.api.saveOutput('',file);assert.equal(h.calls.length,count);
});
test('result card includes every current-turn primary output, even when the answer names only some files',()=>{
 const h=harness();
 const files=[
  {artifactId:'named',name:'named.md',changedInTurn:false},
  {artifactId:'new-a',name:'new-a.md',changedInTurn:true},
  {artifactId:'new-b',name:'new-b.md',changedInTurn:true,primary:true},
  {artifactId:'extra-doc',name:'extra-doc.md',kind:'document',changedInTurn:true,primary:false},
  {artifactId:'site',name:'index.html',kind:'website',changedInTurn:true,primary:false},
  {artifactId:'support',name:'support.md',changedInTurn:true,primary:false},
  {artifactId:'validation-shot',name:'homepage.png',kind:'image',changedInTurn:true,primary:false},
  {artifactId:'unmarked-shot',name:'capture.png',kind:'image',changedInTurn:true},
  {artifactId:'evidence',name:'trace.png',changedInTurn:true,processEvidence:true},
  {artifactId:'draft',name:'soduwork-plugin-draft.json',changedInTurn:true,pluginDraft:true},
  {artifactId:'legacy-skill',name:'soduwork-plugin-draft.json',changedInTurn:true,pluginDraft:true,skillPackage:true},
  {artifactId:'native-skill',name:'created.skill',changedInTurn:true,pluginDraft:true,skillPackage:true},
 ];
 const selected=h.api._selectOutputFiles(files,new Set(['named']),true,new Set());
 assert.deepEqual(selected.map(file=>file.artifactId),['native-skill','named','new-a','new-b']);
 assert.deepEqual(h.api._selectOutputFiles(files,new Set(['validation-shot']),false,new Set()).map(file=>file.artifactId),[]);
 assert.deepEqual(h.api._selectOutputFiles(files,new Set(),false,new Set()).map(file=>file.artifactId),[]);
});

test('delivery archives lead loose files regardless of index order without changing the source index', () => {
 const h = harness();
 const files = ['index.html', 'style.css', 'script.js', 'result.ZIP', 'readme.md'].map(name =>
  ({ artifactId: name, name, changedInTurn: true, primary: true }));
 const original = files.map(file => file.name);
 assert.deepEqual(h.api._selectOutputFiles(files, new Set(), true).map(file => file.name),
  ['result.ZIP', 'index.html', 'style.css', 'script.js', 'readme.md']);
 assert.deepEqual(files.map(file => file.name), original);
});
test('website result cards keep companion images out unless the answer explicitly links one',()=>{
 const h=harness();
 const files=[
  {artifactId:'site',name:'中国巨石-创意官网原型.html',kind:'website',changedInTurn:true},
  {artifactId:'asset',name:'c-hero.png',kind:'image',changedInTurn:true,primary:true},
  {artifactId:'asset2',name:'b-prods.png',kind:'task-file',changedInTurn:true,primary:true},
  {artifactId:'doc',name:'交付说明.md',kind:'document',changedInTurn:true},
 ];
 assert.deepEqual(h.api._selectOutputFiles(files,new Set(),true,new Set()).map(file=>file.artifactId),['site','doc']);
 assert.deepEqual(h.api._selectOutputFiles(files,new Set(['asset']),true,new Set()).map(file=>file.artifactId),['site','asset','doc']);
});
test('attachments and outputs record conversation provenance once a session is bound',async()=>{
 const h=harness();
 h.api.bindSession(()=>({ref:'ref-1',sessionId:'sess-abc-123',conversationTitle:'周报整理'}));
 const job=h.api.trackFile(new File(['data'],'note.md'),{source:'paste'});
 await job.promise;
 assert.equal(job.status,'saved');
 assert.deepEqual({ ...h.sources[0] },{type:'conversation',sessionId:'sess-abc-123',conversationTitle:'周报整理'});
 assert.equal(await h.api.saveOutput('ref-1',{artifactId:'a1',name:'out.md'}),true);
 assert.deepEqual({ ...h.sources[1] },{type:'conversation',sessionId:'sess-abc-123',conversationTitle:'周报整理'});
});
test('files captured before the conversation exists stay manual uploads and can be linked later by id',async()=>{
 const h=harness();
 const draft=new File(['a'],'a.txt');
 const job=h.api.trackFile(draft,{source:'paste'});
 await job.promise;
 assert.equal(job.status,'saved');
 assert.equal(h.sources[0],null);
 assert.deepEqual([...h.api.savedItemIds([draft])],['item']);
 assert.deepEqual([...h.api.savedItemIds([new File(['b'],'b.txt')])],[]);
 h.switchScope();
 assert.deepEqual([...h.api.savedItemIds([draft])],[]);
});

test('queued attachments and outputs retain enqueue-time provenance when the user changes conversations',async()=>{
 const h=harness(),releases=[];
 let current={ref:'ref-a',sessionId:'session-a',conversationTitle:'会话 A'};
 h.api.bindSession(()=>current);
 h.upload=()=>new Promise(resolve=>releases.push(resolve));
 const blockers=[0,1].map(i=>h.api.trackFile(new File(['busy'],'busy-'+i+'.txt'),{}));
 await tick(); assert.equal(h.calls.length,2);
 const queued=h.api.trackFile(new File(['queued'],'queued.txt'),{});
 const explicit={type:'conversation',sessionId:'explicit-a',conversationTitle:'原来源'};
 const explicitJob=h.api.trackFile(new File(['explicit'],'explicit.txt'),{librarySource:explicit});
 const output=h.api.saveOutput('ref-a',{artifactId:'queued-output',name:'output.txt'});
 current={ref:'ref-b',sessionId:'session-b',conversationTitle:'会话 B'};
 explicit.sessionId='explicit-b'; explicit.conversationTitle='后来修改';
 h.upload=async()=>({ok:true,item:{id:'saved'}});
 releases.forEach(resolve=>resolve({ok:true,item:{id:'blocker'}}));
 await Promise.all([...blockers.map(job=>job.promise),queued.promise,explicitJob.promise,output]);
 assert.equal(h.sources[2].sessionId,'session-a');
 assert.equal(h.sources[3].sessionId,'explicit-a');
 assert.equal(h.sources[3].conversationTitle,'原来源');
 assert.equal(h.sources[4].sessionId,'session-a');
 assert.equal(h.calls[4].ref,'ref-a');
});

test('an explicit draft source stays unassociated instead of inheriting the previously open chat',async()=>{
 const h=harness();
 h.api.bindSession(()=>({ref:'previous',sessionId:'previous-chat',conversationTitle:'之前的会话'}));
 const job=h.api.trackFile(new File(['draft'],'draft.txt'),{librarySource:null});
 await job.promise; assert.equal(h.sources[0],null);
});

// Persisted Hub deliveries and PC copies use different library routes.
test('saved item navigation retains the actual storage and resets preview-only navigation',async()=>{
 const h=harness(), routes=[];
 h.global.WorkspaceHost={open:async(view,payload)=>{routes.push({view,...payload});return true;}};
 for (const storage of ['nfs','minio']) await h.api.openSavedItem({id:'hub-'+storage,storage,filename:'课表.xlsx'},{remote:true});
 await h.api.openSavedItem({id:'local-copy',backend:'local',filename:'课表.xlsx'});
 await h.api.openSavedItem({id:'old-hub',storage:'local',filename:'课表.xlsx'},{remote:true});
 assert.deepEqual(routes.map(r=>r.storage),['nfs','minio','local','local']);
 assert.ok(routes.every(r=>r.revealOnly && r.query==='课表.xlsx'));
 assert.equal(routes[2].storageOrigin,undefined);
 assert.equal(routes[3].storageOrigin,'server-history');
 await h.api.openSavedItem({id:'local-copy',backend:'local',filename:'课表.xlsx'},{preview:true});
 assert.equal(routes[4].revealOnly,false);assert.equal(routes[4].storage,'local');
});
test('navigation failure keeps the saved receipt and does not upload another copy',async()=>{
 const h=harness();h.global.WorkspaceHost={open:async()=>{throw Error('SEARCH_LIBRARY_UNAVAILABLE');}};
 const file={artifactId:'saved',name:'课表.xlsx',at:1};
 await h.api.saveOutput('chat',file);
 await assert.rejects(()=>h.api.openSavedItem({id:'item'}),/可能已移动或删除/);
 const node={dataset:{libraryOutput:'saved'},classList:{toggle(){}},setAttribute(){}};
 await h.api.saveOutput('chat',file,node);
 assert.equal(h.calls.length,1);assert.match(h.api.button(file,'chat'),/已保存到资料库/);
 assert.match(h.messages.at(-1),/可能已移动或删除/);
});
