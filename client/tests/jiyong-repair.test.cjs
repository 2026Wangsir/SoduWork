'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
function fixture(early=false){
  const timers=new Map(),listeners=new Set(),messages=[],notices=[];let reads=0,imports=0;
  const node=()=>({children:[],dataset:{},textContent:'',setAttribute(){},appendChild(n){this.children.push(n);return n;},replaceChildren(){this.children=[];}});
  const card=node(),error=node(),button={disabled:false,textContent:'检查并安装',isConnected:true,closest:()=>card};
  card.querySelector=selector=>selector==='.nplugin-draft-error'?error:card.children.find(n=>n.className==='nplugin-checks');
  const api={pluginDraft:async()=>({ok:true,body:{key:'idea',version:++reads===1?'1.0.0':'1.0.1'}}),onEvent:callback=>{listeners.add(callback);return()=>listeners.delete(callback);},send:async(ref,text,files,options)=>{messages.push({ref,text,files,options});if(early)for(const listener of [...listeners])listener({ref,kind:'settled',submissionId:options.submissionId});return{ok:true,queued:!early};}};
  const window={document:{createElement:node},soduWorkAPI:{conversationSession:api},SoduWorkAPI:{preflightPluginDraft:async body=>({ok:body.version==='1.0.1',checks:[{ok:true,label:'资源清单完整'},{ok:body.version==='1.0.1',label:'入口有效'}]})},SoduWorkCapabilityPlugins:{openLocalImport(){imports++;}}};
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname,'../components/panels/panels-plugin-maker-utils.js'),'utf8'),{window,setTimeout:fn=>{const id=timers.size+1;timers.set(id,fn);return id;},clearTimeout:id=>timers.delete(id)});
  return{window,button,card,messages,notices,listeners,timers,reads:()=>reads,imports:()=>imports,open:()=>window.SoduWorkPluginMakerUtils.openConversationDraft('ref-original','artifact-draft',button,{say:s=>notices.push(s)}),emit:kind=>{for(const listener of [...listeners])listener({ref:'ref-original',kind,submissionId:messages[0].options.submissionId});}};
}
const flush=async()=>{for(let n=0;n<5;n++)await new Promise(r=>setImmediate(r));};
test('failed checks show passes and a repair action; queued repair is sent once to its source and rechecks changed bytes',async()=>{
  const f=fixture();await f.open();const report=f.card.children[0],repair=report.children.at(-1);
  assert.ok(report.children.some(n=>n.dataset.state==='passed'));assert.ok(report.children.some(n=>n.dataset.state==='failed'));assert.equal(repair.textContent,'立即修复');
  await Promise.all([repair.onclick(),repair.onclick()]);assert.equal(f.messages.length,1);assert.equal(f.messages[0].ref,'ref-original');assert.match(f.messages[0].text,/读取实际文件/);assert.equal(f.imports(),0);
  for(const listener of f.listeners)listener({ref:'another',kind:'settled',submissionId:f.messages[0].options.submissionId});assert.equal(f.reads(),1);
  f.emit('settled');await flush();assert.equal(f.reads(),2);assert.equal(f.imports(),1);assert.equal(f.timers.size,0);
});
test('completion racing the send receipt is not lost, and an errored repair remains retryable',async()=>{
  const early=fixture(true);await early.open();await early.card.children[0].children.at(-1).onclick();await flush();assert.equal(early.imports(),1);assert.equal(early.listeners.size,0);
  const f=fixture();await f.open();const button=f.card.children[0].children.at(-1);await button.onclick();f.emit('error');assert.equal(button.disabled,false);assert.equal(button.textContent,'立即修复');assert.equal(f.imports(),0);assert.equal(f.timers.size,0);
});


test('runtime failure preserves specific diagnostics, does not install, and sends them to the repair turn',async()=>{
 const f=fixture();
 f.window.SoduWorkAPI.preflightPluginDraft=async()=>({ok:false,runtime:{executed:true},checks:[
  {ok:true,label:'原生桥已注入'}, {ok:true,label:'SQLite读写通过'},
  {ok:false,label:'首屏启动失败：TypeError: soduWorkApp.connect is not a function at ui/app.js:520'},
  {ok:null,state:'pending',label:'真实AI未执行'}]});
 await f.open();const report=f.card.children[0];
 assert.equal(f.imports(),0);assert.ok(report.children.some(row=>row.dataset.state==='pending'&&row.textContent.includes('真实AI未执行')));
 await report.children.at(-1).onclick();
 assert.match(f.messages[0].text,/soduWorkApp\.connect is not a function/);
 assert.match(f.messages[0].text,/ui\/app\.js:520/);assert.match(f.messages[0].text,/提升版本号/);
 f.emit('error');
});


test('a startup check finishing after its chat card is removed cannot open installation in another chat',async()=>{
 const f=fixture();let finish;
 f.window.SoduWorkAPI.preflightPluginDraft=()=>new Promise(resolve=>{finish=resolve;});
 const checking=f.open();await flush();f.button.isConnected=false;
 finish({ok:true,checks:[{ok:true,label:'首屏通过'}]});await checking;
 assert.equal(f.imports(),0);assert.equal(f.messages.length,0);assert.equal(f.button.disabled,false);
});

test('a malformed skill requests a skill repair in its original conversation', async () => {
  const f = fixture();
  f.card.dataset.skillPackage = 'true';
  f.window.soduWorkAPI.conversationSession.pluginDraft = async () => ({ ok: false, reason: 'Invalid skill ZIP' });
  await f.open();
  await f.card.children[0].children.at(-1).onclick();
  assert.equal(f.messages[0].options.source, 'skill-repair');
  assert.match(f.messages[0].text, /SKILL\.md/);
  assert.match(f.messages[0].text, /\.skill/);
  assert.doesNotMatch(f.messages[0].text, /即用|validate\.cjs/);
  f.emit('error');
});
