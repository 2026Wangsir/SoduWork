'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../components/panels/panels-capability-mcp.js'),'utf8');
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return{promise,resolve,reject}};
function fixture(){
 const node=()=>({dataset:{},children:[],disabled:false,hidden:false,textContent:'',innerHTML:'',value:'company',checked:true,
  classList:{add(){},toggle(){}},append(n){this.children.push(n)},querySelector(s){return this.nodes.get(s)||this.nodes.set(s,node()).get(s)},nodes:new Map()});
 const document={createElement:node},window={},layer=node();layer.isConnected=true;
 let revision=0,owner='alice',bar,share,inspect;
 const edit=node();edit.dataset.editMcp='personal';edit.parentElement={insertBefore:s=>share=s};
 const company=node();company.dataset.companyMcp='company';company.replaceWith=w=>{Object.defineProperty(w,'latest',{get:()=>w.children.at(-1)});inspect=w};
 const content={prepend:b=>bar=b,querySelectorAll:s=>s==='[data-edit-mcp]'?[edit]:s==='[data-company-mcp]'?[company]:[]};
 const api={taskStorageKey:()=>owner,shareMyMcp:async()=>({item:{status:'pending'}}),myMcpSubmissions:async()=>({items:[]}),probeCompanyMcp:async()=>({ok:true,tools:['read']})};
 const ctx={api,h:String,errorText:e=>e.message,say(){},viewRevision:()=>revision,
  openModal(){revision++;layer.hidden=false;layer.nodes=new Map();return layer},closeModal(){revision++;layer.hidden=true},
  mcp:{personal:[{id:'personal',name:'test',headers:{Authorization:'masked'}}],company:[{id:'company',name:'company',type:'stdio'}]}};
 vm.runInNewContext(source,{window,document});window.SoduWorkMcpManagement.enhance(content,ctx);
 return{api,layer,ctx,openShare:()=>share.onclick(),openHistory:()=>bar.querySelector('[data-mcp-submissions]').onclick(),
  openCompany:()=>inspect.latest.onclick(),replace:()=>ctx.openModal(),switchOwner:()=>{owner='bob'},
  notice:()=>layer.querySelector('[data-mcp-feedback]').textContent,
  submit:()=>{const b=layer.querySelector('[data-mcp-share-do]');b.disabled=false;return b.onclick()}};
}
for(const ending of ['success','error'])for(const leave of ['replace','switchOwner'])test('late shared configuration '+ending+' after '+leave+' cannot alter current modal',async()=>{
 const f=fixture(),wait=deferred();f.api.shareMyMcp=()=>wait.promise;f.openShare();const pending=f.submit();f[leave]();
 if(ending==='success')wait.resolve({item:{status:'pending'}});else wait.reject(Error('old-error'));
 await pending;assert.equal(f.notice(),'');
});
test('sharing confirmation changes cannot duplicate an in-flight request',async()=>{
 const f=fixture(),wait=deferred();let count=0;f.api.shareMyMcp=()=>{count++;return wait.promise};f.openShare();const one=f.submit();
 f.layer.querySelector('[data-mcp-share-consent]').onchange({target:{checked:true}});await f.submit();assert.equal(count,1);
 wait.resolve({item:{status:'pending'}});await one;assert.match(f.notice(),/已提交/);
});
test('late history response cannot fill replacement dialog',async()=>{
 const f=fixture(),wait=deferred();f.api.myMcpSubmissions=()=>wait.promise;const pending=f.openHistory();f.replace();
 wait.resolve({items:[{name:'private-old-account',status:'pending'}]});await pending;
 assert.equal(f.layer.querySelector('[data-mcp-history]').innerHTML,'');
});
test('company connector discovery does not claim authenticated business access',async()=>{
 const f=fixture();f.api.probeCompanyMcp=async()=>({ok:true,authenticationTested:false,tools:['read'],runOn:'runner'});
 f.openCompany();await f.layer.querySelector('[data-mcp-company-probe]').onclick();
 assert.match(f.notice(),/业务授权待验证/);assert.doesNotMatch(f.notice(),/连接通过/);
});
test('late company discovery does not replace current tools or reenable its controls',async()=>{
 const f=fixture(),wait=deferred();f.api.probeCompanyMcp=()=>wait.promise;f.openCompany();
 const pending=f.layer.querySelector('[data-mcp-company-probe]').onclick();f.replace();
 const current=f.layer.querySelector('[data-mcp-company-probe]');current.disabled=true;
 wait.resolve({ok:true,tools:['private-old-tool']});await pending;
 assert.equal(current.disabled,true);assert.equal(f.layer.querySelector('[data-mcp-tools]').innerHTML,'');assert.equal(f.notice(),'');
});


function importFixture() {
 const node=()=>({disabled:false,checked:false,hidden:false,textContent:'',innerHTML:'',
  classList:{add(){}},nodes:new Map(),
  querySelector(s){return this.nodes.get(s)||this.nodes.set(s,node()).get(s)}});
 const layer=node(),window={};layer.isConnected=true;
 let revision=0,imports=0,owner='alice';
 const preview=deferred();
 const api={taskStorageKey:()=>owner,previewMyMcpImport:()=>preview.promise,
  importMyMcp:async()=>{imports++;return {imported:['fixture']}}};
 const ctx={api,h:String,errorText:e=>e.message,say(){},viewRevision:()=>revision,
  openModal(){revision++;layer.hidden=false;layer.nodes=new Map();return layer},
  closeModal(){revision++;layer.hidden=true},load:async()=>{}};
 vm.runInNewContext(source,{window});window.SoduWorkMcpManagement.openImport(ctx);
 const submit=layer.querySelector('[data-mcp-import-do]'),consent=layer.querySelector('[data-mcp-import-consent]');
 const choose=()=>layer.querySelector('[data-mcp-file]').onchange({target:{files:[{name:'fixture.json',size:20}]}});
 const approve=()=>{consent.checked=true;consent.onchange()};
 return {layer,ctx,submit,consent,choose,approve,preview,imports:()=>imports,switchOwner:()=>{owner='bob'}};
}

test('connector import enables after a preview finishes with consent already checked',async()=>{
 const f=importFixture();
 const pending=f.choose();f.approve();assert.equal(f.submit.disabled,true);
 f.preview.resolve({summary:{total:1,importable:1},servers:[{name:'fixture',target:'https://example.invalid/mcp',importable:true}]});
 await pending;assert.equal(f.submit.disabled,false);
 await f.submit.onclick();assert.equal(f.imports(),1);assert.equal(f.layer.hidden,true);
});

test('connector import stays disabled without a file or with no importable connection',async()=>{
 const f=importFixture();f.approve();assert.equal(f.submit.disabled,true);
 await f.submit.onclick();assert.equal(f.imports(),0);
 const pending=f.choose();f.approve();
 f.preview.resolve({summary:{total:1,importable:0},servers:[]});await pending;
 assert.equal(f.submit.disabled,true);await f.submit.onclick();assert.equal(f.imports(),0);
});

for(const leave of ['replace','switchOwner'])test('late connector import preview cannot enable submission after '+leave,async()=>{
 const f=importFixture(),pending=f.choose();f.approve();
 if(leave==='replace')f.ctx.openModal();else f.switchOwner();
 f.preview.resolve({summary:{total:1,importable:1},servers:[]});await pending;
 assert.equal(f.submit.disabled,true);await f.submit.onclick();assert.equal(f.imports(),0);
});
