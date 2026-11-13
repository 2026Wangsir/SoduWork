const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../components/panels/panels-schedules-editor.js'),'utf8');
function setup(extra={}){
 const calls=[],menu={hidden:false},trigger={focus(){calls.push(['focus'])},setAttribute(k,v){this[k]=v}};
 const c={document:{getElementById:id=>id==='schNew'?trigger:menu},petSay:s=>calls.push(['notice',s]),closeSchedulePanel:()=>calls.push(['close']),...extra};
 vm.createContext(c);vm.runInContext(source,c);return{c,calls,menu,trigger};
}
test('creation menu has two accessible choices and no premature dialog',()=>{
 const {c}=setup(),h=c._schCreateMenuHtml();assert.match(h,/aria-haspopup="menu"/);assert.match(h,/aria-controls="schCreateMenu"/);assert.match(h,/role="menu"[^>]+hidden/);
 assert.equal((h.match(/role="menuitem"/g)||[]).length,2);assert.match(h,/对话创建/);assert.match(h,/手动配置/);assert.doesNotMatch(h,/onclick=|aria-haspopup="dialog"/);
});
test('dialogue creation routes a fresh built-in automation action without dispatching work',async()=>{
 const routed=[],{c,calls}=setup({openCreateEntry:p=>routed.push(p)});
 assert.equal(await c._schCreateFromChat(),true);
 assert.equal(routed.length,1);assert.equal(routed[0].pluginId,'work.automation.create');assert.equal(routed[0].tab,'chat');assert.equal(routed[0].newSession,true);
 assert.equal(Object.hasOwn(routed[0],'prefill'),false);assert.equal(routed[0].chatId,undefined);assert.equal(routed[0].taskId,undefined);
 assert.match(routed[0].contextPrompts[0],/确认配置后才创建/);assert.equal(calls.filter(x=>x[0]==='close').length,1);
});
test('void shared routing result is success, not failure',async()=>{
 const {c}=setup({openCreateEntry:()=>{}});assert.equal(await c._schCreateFromChat(),true);
});
test('standalone rendering can fall back to the same compose component',async()=>{
 let p;const {c}=setup({openComposePanel:q=>{p=q;return true}});assert.equal(await c._schCreateFromChat(),true);assert.equal(p.pluginId,'work.automation.create');
});
test('missing conversation module leaves automation page usable',async()=>{
 const {c,calls}=setup();assert.equal(await c._schCreateFromChat(),false);assert.equal(calls.some(x=>x[0]==='close'),false);assert.ok(calls.some(x=>x[0]==='focus'));
});
for(const [label,route] of [['false',()=>false],['throw',()=>{throw Error('secret must not be echoed')}],['reject',()=>Promise.reject(Error('secret'))]]){
 test('route '+label+' is recoverable without losing page or leaking details',async()=>{
 const {c,calls}=setup({openCreateEntry:route});assert.equal(await c._schCreateFromChat(),false);assert.equal(calls.some(x=>x[0]==='close'),false);assert.doesNotMatch(JSON.stringify(calls),/secret/);
 });
}
test('menu close updates only menu state and restores trigger focus on request',()=>{
 const {c,menu,trigger,calls}=setup();c._schCloseCreateMenu(true);assert.equal(menu.hidden,true);assert.equal(trigger['aria-expanded'],'false');assert.deepEqual(calls,[['focus']]);
});
