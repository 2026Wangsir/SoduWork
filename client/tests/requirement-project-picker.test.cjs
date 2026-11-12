'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),path=require('node:path');
const fs=require('./renderer-source.cjs');
const source=fs.readFileSync(path.join(__dirname,'../components/requirements/requirement-fields.js'),'utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve,reject;const promise=new Promise((ok,fail)=>{resolve=ok;reject=fail;});return{promise,resolve,reject};};
function fixture(load,extra={}){
  let identity='owner-a',editable=true,active=true,calls=0;
  const element=()=>({value:'',textContent:'',hidden:false,attributes:{},listeners:{},options:[],children:[],
    set innerHTML(_value){assert.fail('Project choices must use DOM text, not HTML writes');},
    replaceChildren(...nodes){this.options=nodes;},
    setAttribute(key,value){this.attributes[key]=value;},removeAttribute(key){delete this.attributes[key];},
    addEventListener(type,fn){this.listeners[type]=fn;}});
  const changed=[],scope={document:{createElement:element},SoduWorkAPI:{taskStorageKey:()=>identity,getProjects:()=>{calls++;return load();}}};
  scope.window=scope;vm.runInNewContext(source,scope);
  function host(){
    const nodes=new Map();
    return{isConnected:true,querySelector(selector){
      if(!nodes.has(selector))nodes.set(selector,element());
      return nodes.get(selector);
    }};
  }
  const picker=scope.RequirementFields.projectPicker({value:'business-a',current:()=>active,editable:()=>editable,
    onChange:value=>changed.push(value),...extra}),root=host();picker.bind(root);
  return{picker,root,host,changed,calls:()=>calls,select:()=>root.querySelector('[data-rq-project-select]'),
    options:()=>root.querySelector('[data-rq-project-select]').options,
    error:()=>root.querySelector('[data-rq-project-error]'),retry:()=>root.querySelector('[data-rq-project-retry]'),
    identity:value=>{identity=value;},editable:value=>{editable=value;},active:value=>{active=value;},
    choose(value){const select=root.querySelector('[data-rq-project-select]');select.value=value;select.listeners.change();}};
}
const rows=[{id:'business-a',name:'Business A'},{id:'business-b',name:'Business B'}];

test('project choices load once on entry and preserve the initial board project and explicit clearing',async()=>{
  const pending=deferred(),f=fixture(()=>pending.promise);
  assert.equal(f.calls(),1);assert.equal(f.select().value,'business-a');assert.equal(f.select().disabled,true);
  pending.resolve(rows);await tick();assert.equal(f.select().disabled,false);
  f.choose('business-b');assert.equal(f.picker.value(),'business-b');
  f.choose('');assert.equal(f.picker.value(),'');assert.deepEqual(f.changed,['business-b','']);
  const replacement=f.host();f.picker.bind(replacement);
  assert.equal(f.calls(),1);assert.equal(replacement.querySelector('[data-rq-project-select]').value,'');
  assert.equal(f.retry().hidden,true);
});

test('load failure retains the existing association and exposes retry only in the error state',async()=>{
  let fail=true;const f=fixture(async()=>{if(fail)throw Error('Unavailable');return rows;});
  await tick();assert.equal(f.picker.value(),'business-a');assert.equal(f.select().value,'business-a');
  assert.equal(f.select().disabled,true);assert.match(f.error().textContent,/当前关联已保留/);assert.equal(f.retry().hidden,false);
  fail=false;f.retry().listeners.click();await tick();
  assert.equal(f.select().value,'business-a');assert.equal(f.error().hidden,true);assert.equal(f.retry().hidden,true);
});

test('an empty successful list is distinct from failure and cannot silently clear an unavailable current project',async()=>{
  const f=fixture(async()=>[]);await tick();
  assert.equal(f.select().disabled,false);assert.equal(f.error().hidden,true);
  assert.equal(f.picker.value(),'business-a');assert.equal(f.options().at(-1).textContent,'当前关联项目（不可用）');
  f.choose('forged-project');assert.equal(f.picker.value(),'business-a');assert.equal(f.select().value,'business-a');
  f.choose('');assert.equal(f.picker.value(),'');
});

test('a successful authorized catalog supersedes a stale board name without losing its project ID',async()=>{
  const pending=deferred(),f=fixture(()=>pending.promise,{name:'Previously visible project'});
  assert.equal(f.options().at(-1).textContent,'Previously visible project');
  pending.resolve([]);await tick();
  assert.equal(f.picker.value(),'business-a');assert.equal(f.options().at(-1).textContent,'当前关联项目（不可用）');
  assert.equal(Object.hasOwn(f.options().at(-1).attributes,'data-user-content'),false);
});

test('failed refresh keeps the user selection while older replies cannot replace the latest catalog',async()=>{
  const requests=[];const f=fixture(()=>{const pending=deferred();requests.push(pending);return pending.promise;});
  requests[0].resolve(rows);await tick();f.choose('business-b');
  const old=f.picker.load(),latest=f.picker.load();
  requests[2].reject(Error('Offline'));await latest;
  requests[1].resolve([{id:'other-account-project',name:'Must not appear'}]);await old;
  assert.equal(f.picker.value(),'business-b');assert.equal(f.select().value,'business-b');
  assert.match(f.error().textContent,/当前关联已保留/);assert.equal(f.options().some(row=>row.textContent==='Must not appear'),false);
});

for(const boundary of ['identity','closed','disposed','detached'])test('project responses cannot mutate a '+boundary+' form',async()=>{
  const pending=deferred(),f=fixture(()=>pending.promise),before=JSON.stringify(f.options());
  if(boundary==='identity')f.identity('owner-b');
  if(boundary==='closed')f.active(false);
  if(boundary==='disposed')f.picker.dispose();
  if(boundary==='detached')f.root.isConnected=false;
  pending.resolve(rows);await tick();assert.equal(JSON.stringify(f.options()),before);assert.deepEqual(f.changed,[]);
});

test('permission or repository locking rejects selection changes without discarding the selected value',async()=>{
  const f=fixture(async()=>rows);await tick();f.editable(false);f.picker.paint();
  assert.equal(f.select().disabled,true);assert.ok(Object.hasOwn(f.select().attributes,'data-rq-locked'));
  f.choose('business-b');assert.equal(f.picker.value(),'business-a');assert.deepEqual(f.changed,[]);
  f.editable(true);f.picker.paint();assert.equal(f.select().disabled,false);
});

test('project names are escaped and marked as user content instead of becoming UI translations',async()=>{
  const f=fixture(async()=>[{id:'business-a',name:'<Project "A">'}]);await tick();
  const option=f.options().find(row=>row.value==='business-a');
  assert.equal(option.textContent,'<Project "A">');assert.equal(option.children.length,0);
  assert.ok(Object.hasOwn(option.attributes,'data-user-content'));
  assert.match(f.picker.html(),/&lt;Project &quot;A&quot;/);assert.doesNotMatch(f.picker.html(),/<Project/);
});
