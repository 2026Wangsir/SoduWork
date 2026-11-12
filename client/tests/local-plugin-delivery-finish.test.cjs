const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const picker=require('../main/plugin-package-picker'),personal=require('../main/personal-plugins');
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'soduwork-picker-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir}
const draft={key:'local-template',name:'本机模板',version:'1.0.0',template:'method',description:'模板验证',instructions:'读取随包模板。'};
test('native import collects adjacent templates and examples and portable export preserves bytes',async t=>{
 const dir=fixture(t);fs.mkdirSync(path.join(dir,'templates'));fs.mkdirSync(path.join(dir,'examples'));
 fs.writeFileSync(path.join(dir,'templates','报告.md'),'# 测试模板\n');fs.writeFileSync(path.join(dir,'examples','示例.json'),'{"title":"示例"}');
 const file=path.join(dir,'draft.json');fs.writeFileSync(file,JSON.stringify({...draft,resources:[{path:'templates/报告.md',kind:'template'},{path:'examples/示例.json',kind:'example'}]}));
 const selected=await picker.choose({showOpenDialog:async()=>({filePaths:[file]})});
 assert.equal(selected.kind,'draft');assert.equal(selected.body.resources.length,2);
 const app={getPath:()=>path.join(dir,'store')},installed=personal.create(app,selected.body).plugin;
 const exported=personal.exportDraft(app,installed.pluginId);
 assert.equal(Buffer.from(exported.resources.find(x=>x.kind==='template').content,'base64').toString(),'# 测试模板\n');
 assert.equal(JSON.stringify(selected).includes(dir.replaceAll('\\','\\\\')),false,'Absolute source paths are not returned');
});
test('native selection cancel reads nothing; archives preserve exact bytes',async t=>{
 assert.deepEqual(await picker.choose({showOpenDialog:async()=>({canceled:true})}),{canceled:true});
 const dir=fixture(t),file=path.join(dir,'test.zip'),bytes=Buffer.from([0,80,75,255]);fs.writeFileSync(file,bytes);
 const x=await picker.choose({showOpenDialog:async()=>({filePaths:[file]})});assert.equal(x.content,bytes.toString('base64'));
});
test('native import rejects missing files and junction escapes instead of dropping resources',async t=>{
 const dir=fixture(t),other=fixture(t),file=path.join(dir,'draft.json');
 fs.writeFileSync(file,JSON.stringify({...draft,resources:[{path:'templates/data.txt',kind:'template'}]}));
 await assert.rejects(picker.choose({showOpenDialog:async()=>({filePaths:[file]})}),/ENOENT/);
 fs.writeFileSync(path.join(other,'data.txt'),'outside');fs.symlinkSync(other,path.join(dir,'templates'),'junction');
 await assert.rejects(picker.choose({showOpenDialog:async()=>({filePaths:[file]})}),/链接|联接/);
});
const compose=fs.readFileSync(path.join(__dirname,'../components/panels/panels-compose-draft.js'),'utf8');
test('collapsed ordinary draft does not lose hidden acceptance criteria',()=>{
 const start=compose.indexOf('function _sync()'),end=compose.indexOf('\n  /*',start);
 const state={_d:{title:'Title',check:['A','B']},_projectPicker:null,document:{getElementById:()=>null,querySelectorAll:()=>[]}};
 vm.runInNewContext(compose.slice(start,end)+'\n_sync()',state);assert.deepEqual(state._d.check,['A','B']);
});
test('an actually empty visible checklist can still be cleared',()=>{
 const start=compose.indexOf('function _sync()'),end=compose.indexOf('\n  /*',start);
 const state={_d:{check:['A']},_projectPicker:null,document:{getElementById:id=>id==='cpCheck'?{}:null,querySelectorAll:()=>[]}};
 vm.runInNewContext(compose.slice(start,end)+'\n_sync()',state);assert.equal(state._d.check.length,0);
});
test('receipt close does not reuse composer toolbar ID and workspace yields Escape to plugins',()=>{
 const submit=fs.readFileSync(path.join(__dirname,'../components/panels/panels-compose-submit.js'),'utf8');
 assert.doesNotMatch(submit,/id="cpMore"/);assert.match(submit,/data-cp-receipt-close/);
 const boot=fs.readFileSync(path.join(__dirname,'../desk-boot.js'),'utf8');
 assert.ok(boot.indexOf("document.querySelector('.pui-layer.is-visible')")<boot.indexOf("const popover = document.querySelector"));
});

const makerUtils=fs.readFileSync(path.join(__dirname,'../components/panels/panels-plugin-maker-utils.js'),'utf8');
function importHarness(error){
 const errors=[],inputs=[];
 const input={addEventListener(){},click(){this.clicked=true}};
 const state={window:{soduWorkAPI:{personalPlugins:{choosePackage:async()=>{throw error}}}},
  document:{createElement:()=>{inputs.push(input);return input}}};
 vm.runInNewContext(makerUtils,state);
 return {errors,inputs,run:()=>state.window.SoduWorkPluginMakerUtils.choosePackage({}, {error:e=>errors.push(e)})};
}
test('source renderer reload can fall back when the main import handler is not loaded yet',async()=>{
 const x=importHarness(new Error("Error invoking remote method 'personal-plugin-choose-package': Error: No handler registered for 'personal-plugin-choose-package'"));
 await x.run();assert.equal(x.inputs.length,1);assert.equal(x.inputs[0].clicked,true);assert.equal(x.errors.length,0);
});
test('native import validation errors are shown, not bypassed with another file chooser',async()=>{
 const error=new Error('资源路径不能越过插件目录'),x=importHarness(error);
 await x.run();assert.equal(x.inputs.length,0);assert.equal(x.errors[0],error);
});
