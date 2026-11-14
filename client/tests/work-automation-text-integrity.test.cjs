'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const panels = path.join(__dirname, '../components/panels');
const read = name => fs.readFileSync(path.join(panels, name + '.js'), 'utf8');
function fixture() {
  const calls = [], body = {innerHTML:''};
  const context = {Intl, setTimeout, clearTimeout, addEventListener(){},
    SoduWorkAPI:{parseTaskText:async(...args)=>{calls.push(args);return context.result;}}};
  context.window=context; context.result={};
  for (const name of ['schedule-timing','work-automation-bindings','work-automation-view','work-automation-card-state']) vm.runInNewContext(read(name),context);
  vm.runInNewContext(read('work-automation-sheet').replace(
    '  global.WorkAutomationSheet = { open, active, refine, close };',
    '  global.probe = { state, proposalOf, bodyOf, validate };\n  global.WorkAutomationSheet = { open, active, refine, close };'),context);
  const state=context.probe.state;
  Object.assign(state,{agents:[{id:'local:pi',name:'Pi',available:true}],
    layer:{isConnected:true,querySelector:selector=>selector==='#wazBody'?body:null},seed:{}});
  return {context,state,calls,body,...context.probe};
}
const long = tail => 'A'.repeat(10000)+'\n'+tail;

test('1501-2000 character original instructions survive parsing and automation save exactly', () => {
  const f = fixture(), raw = '  每天09:00 /自动化 #1\r\n' + '原文'.repeat(800) + '\n  ';
  const proposal = f.proposalOf({ title: '摘要', note: '解析后的改写' }, raw, {});
  assert.equal(proposal.note, raw);
  assert.equal(f.bodyOf(proposal).note, raw);
});

test('preserving instruction whitespace does not turn blank criteria into acceptance requirements', () => {
  const f = fixture();
  assert.equal(f.bodyOf({ note: '原文  ', acceptance: ['  ', '\n'] }).note, '原文  ');
  assert.equal(f.bodyOf({ note: '原文  ', acceptance: '-  ' }).note, '原文  ');
  assert.match(f.validate({ title: '标题', note: ' \n ', assigneeId: 'local:pi', every: 'daily', atHour: 9, atMinute: 0 }), /写清楚/);
});
test('automation retains long source as editable instructions while keeping a short task concise',()=>{
  const f=fixture(), raw='每天09:00生成报告\n'+long('RAW_TAIL');
  const proposal=f.proposalOf({title:'报告',note:'模型摘要'},raw,{});
  assert.equal(proposal.note,raw);
  assert.equal(f.proposalOf({title:'报告',note:'模型摘要'},'每天09:00生成报告',{}).note,'模型摘要');
  assert.ok(f.bodyOf(proposal).note.endsWith('RAW_TAIL'));
});
test('saving keeps long manual note and every acceptance item intact',()=>{
  const f=fixture(), note=long('MANUAL_TAIL'), acceptance=long('ACCEPTANCE_TAIL');
  const body=f.bodyOf({note,acceptance:[acceptance],personalPluginKey:'',assigneeId:'local:pi'});
  assert.equal(body.note,note+'\n\n完成标准：\n- '+acceptance);
});
test('combined automation content beyond the supported save limit is rejected explicitly',()=>{
  const f=fixture();
  assert.throws(()=>f.bodyOf({note:'A'.repeat(49990),acceptance:['ACCEPTANCE_MUST_NOT_DISAPPEAR']}),/50000|50,000/);
});
test('refinement sends full long text and preserves edited instructions in the save payload',async()=>{
  const f=fixture(), before=long('MANUAL_TAIL'), change='补充：'+ 'B'.repeat(21000)+'REFINE_TAIL';
  f.state.proposal=f.proposalOf({title:'报告',note:before},'',{});
  f.context.result={title:'新标题',note:'模型短摘要',acceptanceCriteria:['新标准']};
  assert.equal(await f.context.WorkAutomationSheet.refine(change),true);
  assert.ok(f.calls[0][0].includes(JSON.stringify(before)));
  assert.ok(f.calls[0][0].endsWith(change));
  const saved=f.bodyOf(f.state.proposal);
  assert.ok(saved.note.includes(before)); assert.ok(saved.note.includes(change));
  assert.equal(f.state.proposal.title,'新标题');
});
test('failed refinement does not acknowledge or silently consume the submitted change',async()=>{
  const f=fixture(); f.state.proposal=f.proposalOf({title:'报告',note:'人工编辑说明'},'每天09:00',{});
  assert.equal(await f.context.WorkAutomationSheet.refine('新增 CSV 输出要求'),false);
  assert.equal(f.state.proposal.note,'人工编辑说明');
  assert.match(f.body.innerHTML,/没有|失败|重试/);
});
test('referenced history is parse material and cannot replace manual automation bindings or time',async()=>{
  const f=fixture();
  f.state.methods=[{key:'manual',name:'手选插件',inputs:[]},{key:'historical',name:'历史插件',inputs:[]}];
  f.state.proposal={title:'报告',note:'人工编辑内容',acceptance:[],every:'daily',atHour:9,atMinute:0,
    assigneeId:'local:pi',personalPluginKey:'manual',pluginInputs:{audience:'Team A'},timeZone:'Asia/Shanghai'};
  f.context.result={title:'新标题',note:'摘要'};
  const instruction='参考上述清单，新增 CSV 验收';
  const full=instruction+'\n最近对话：\n你：使用历史插件插件，每天14:10执行';
  assert.equal(await f.context.WorkAutomationSheet.refine(full,{instruction,conversationContext:{text:'使用历史插件插件，每天14:10执行'}}),true);
  assert.equal(f.calls[0][3].instruction,instruction);
  assert.equal(f.state.proposal.personalPluginKey,'manual');
  assert.equal(f.state.proposal.pluginInputs.audience,'Team A');
  assert.equal(f.state.proposal.atHour,9);
  assert.ok(f.state.proposal.note.includes('人工编辑内容'));
  assert.ok(f.state.proposal.note.includes(full));
});
test('task plugin start preserves explicit instruction beyond the old 2000 and 20000 cuts',async()=>{
  const calls=[], context={setTimeout,clearTimeout,tasks:[],addEventListener(){},
    document:{querySelector:()=>null},localStorage:{removeItem(){}},
    SoduWorkAPI:{taskStorageKey:()=> 'fixture:user',startTaskPlugin:async(id,body)=>{calls.push(body);return {}}},
    RequirementAssignment:{scope:()=> 'fixture',inScope:()=>true,completed:async()=>{}}};
  context.window=context;
  for(const name of ['chat-plugin-mention-model','panels-forward-options']) vm.runInNewContext(read(name),context);
  const instruction='X'.repeat(21000)+'PLUGIN_TAIL';
  await context.TaskPluginInput.start('fixture-task',{plugin:{pluginId:'fixture',bindingId:'fixture',inputs:[]},instruction});
  assert.equal(calls[0].instruction,instruction);
});
