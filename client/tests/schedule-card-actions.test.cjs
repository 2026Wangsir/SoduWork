'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../components/panels/panels-schedules.js'),'utf8');
const editor=fs.readFileSync(path.join(__dirname,'../components/panels/panels-schedules-editor.js'),'utf8');
const cards=fs.readFileSync(path.join(__dirname,'../components/panels/panels-schedules-cards.js'),'utf8');
const runs=fs.readFileSync(path.join(__dirname,'../components/panels/panels-schedules-runs.js'),'utf8');
const css=fs.readFileSync(path.join(__dirname,'../components/panels/panels-schedules.css'),'utf8');
const automationCss=fs.readFileSync(path.join(__dirname,'../components/panels/automation-surface.css'),'utf8');
function context(){const c={esc:s=>String(s).replaceAll('"','&quot;'),window:{addEventListener(){}}};vm.createContext(c);vm.runInContext(source,c);return c;}
test('all four schedule actions are icon-only named native buttons with original actions',()=>{
  const c=context();
  for(const [act,label] of [['run','立刻跑一次'],['runs','执行记录'],['edit','编辑自动化'],['del','删除自动化']]){
    const html=c._schActionButton(act,label);
    assert.match(html,/type="button"/);assert.ok(html.includes('data-act="'+act+'"'));
    assert.ok(html.includes('aria-label="'+label+'"'));assert.ok(html.includes('title="'+label+'"'));
    assert.match(html,/<svg[^>]*aria-hidden="true"/);
    assert.equal(html.replace(/<[^>]*>/g,''),'');
    if(['runs','edit'].includes(act))assert.match(html,/aria-haspopup="dialog" aria-expanded="false"/);
  }
});
test('schedule status is an accessible enable/disable control and fired one-time plans stay terminal', () => {
  const c=context();
  c._schFindPlugin=()=>null; c._schmFind=()=>null; c._schAgents=[]; c._schRepos=[];
  vm.runInContext(cards,c);
  const base={id:'one',title:'Work',note:'',every:'daily',atHour:9,atMinute:0,weekday:1,
    enabled:true,assigneeId:'local:pi',pluginBindingId:'',personalPluginKey:'',repoId:'',flow:false};
  const enabled=c._schCardHtml(base);
  assert.match(enabled,/button[^>]+data-act="toggle"[^>]+aria-pressed="true"/);
  assert.match(enabled,/title="停用自动化"/);
  const disabled=c._schCardHtml({...base,enabled:false});
  assert.match(disabled,/button[^>]+data-act="toggle"[^>]+aria-pressed="false"/);
  assert.match(disabled,/title="启用自动化"/);
  const fired=c._schCardHtml({...base,every:'once',onceFired:true});
  assert.doesNotMatch(fired,/data-act="toggle"/);
  assert.match(fired,/本次预约已触发/);
});
test('pending execution keeps an icon and accessible busy state; restoring never returns visible text',()=>{
  const c=context(),attrs={},button={setAttribute:(k,v)=>attrs[k]=v};
  c._schSetRunBusy(button,true);assert.equal(button.disabled,true);assert.equal(attrs['aria-busy'],'true');
  assert.equal(attrs['aria-label'],'正在提交执行');assert.match(button.innerHTML,/<circle/);
  c._schSetRunBusy(button,false);assert.equal(button.disabled,false);assert.equal(attrs['aria-busy'],'false');
  assert.equal(button.title,'立刻跑一次');assert.equal(button.innerHTML,c._schActionIcon('run'));
});
test('repeated execution of an already disabled run button cannot submit again',async()=>{
  const c=context();vm.runInContext('_schRows=[{id:"one"}]',c);
  c.SoduWorkAPI={runSchedule:()=>{throw Error('must not dispatch')}};
  await c._schAct('run','one',{disabled:true});
});
test('enabled automation asks before disabling, while disabled automation enables directly', async () => {
  const c = context();
  vm.runInContext(cards, c);
  let enabled = true, asked = 0, updates = 0, reloads = 0;
  c.window.confirm = () => { asked++; return false; };
  c.SoduWorkAPI = { updateSchedule: async (_id, body) => { updates++; enabled = body.enabled; } };
  c._loadSch = async () => { reloads++; };
  vm.runInContext('_schRows=[{id:"one",title:"Work",enabled:true}]', c);
  const button = {disabled:false,isConnected:true,setAttribute(){},removeAttribute(){}};
  await c._schAct('toggle', 'one', button);
  assert.equal(asked, 1); assert.equal(updates, 0); assert.equal(enabled, true); assert.equal(button.disabled, false);
  c.window.confirm = () => { asked++; return true; };
  await c._schAct('toggle', 'one', button);
  assert.equal(asked, 2); assert.equal(updates, 1); assert.equal(enabled, false);
  vm.runInContext('_schRows=[{id:"one",title:"Work",enabled:false}]', c);
  await c._schAct('toggle', 'one', button);
  assert.equal(asked, 2); assert.equal(updates, 2); assert.equal(enabled, true); assert.equal(reloads, 2);
});
test('disable confirmation prefers the shared accessible dialog over native confirmation', async () => {
  const c = context(); let options;
  c.window.SoduWorkConfirmDialog = {open: async value => { options = value; return true; }};
  c.window.confirm = () => { throw Error('native confirmation must not be used'); };
  assert.equal(await c._schConfirmDisable({title:'Work'}), true);
  assert.equal(options.title, '停用自动化？');
  assert.equal(options.confirm, '停用自动化');
  assert.equal(options.cancel, '继续运行');
  assert.equal(options.danger, true);
});

test('enabled state is a confirmation action and persists the opposite state', async () => {
  assert.match(cards, /class="sch-i-state[\s\S]*data-act="toggle"/);
  assert.match(cards, /aria-pressed="\' \+ String\(Boolean\(s\.enabled\)\)/);
  const c=context(), handlers={}, calls=[]; let closed=0, loaded=0;
  vm.runInContext(cards,c);
  const cancel={addEventListener:(_name,fn)=>{handlers.cancel=fn}};
  const confirm={disabled:false,textContent:'停用',addEventListener:(_name,fn)=>{handlers.confirm=fn}};
  c.document={body:{}};
  c.window.AccountUI={modal:()=>({mask:{querySelector:selector=>selector.includes('cancel')?cancel:confirm},close:()=>{closed++}})};
  c.window.SoduWorkAPI={updateSchedule:async(sid,body)=>calls.push({sid,body})};
  c._loadSch=async()=>{loaded++};
  vm.runInContext('_schRows=[{id:"one",title:"Work",enabled:true}]',c);
  await c._schToggleEnabled('one',{});
  assert.equal(calls.length,0); handlers.cancel(); assert.equal(calls.length,0);
  await c._schToggleEnabled('one',{}); await handlers.confirm();
  assert.equal(JSON.stringify(calls),JSON.stringify([{sid:'one',body:{enabled:false}}]));
  vm.runInContext('_schRows=[{id:"one",title:"Work",enabled:false}]',c);
  await c._schToggleEnabled('one',{}); confirm.disabled=false; await handlers.confirm();
  assert.equal(JSON.stringify(calls),JSON.stringify([{sid:'one',body:{enabled:false}},{sid:'one',body:{enabled:true}}]));
  assert.equal(closed,3); assert.equal(loaded,2);
});

test('immediate execution opens the automation chat instead of opening run history', () => {
  assert.doesNotMatch(source, /await _schLaunchRunConversation/);
  assert.match(source, /Promise\.resolve\(_schLaunchRunConversation/);
  assert.doesNotMatch(source, /_schRunOpen\s*=\s*sid/);
  assert.match(source, /已开启自动化任务/);
  assert.doesNotMatch(source, /已开始创建普通对话|已安排，客户端将创建普通对话/);
});
test('immediate execution does not duplicate a Hub dispatch error prefix', async () => {
  const c = context(), notices = [];
  c.petSay = text => notices.push(text);
  c.SoduWorkAPI = { runSchedule: async () => { throw Error('没派出去：当前执行设备没有可用的普通会话执行端'); } };
  vm.runInContext('_schRows=[{id:"one",title:"获取天气"}]', c);
  const button = { disabled: false, isConnected: true, setAttribute() {}, removeAttribute() {} };
  await c._schAct('run', 'one', button);
  assert.deepEqual(notices, ['没派出去：当前执行设备没有可用的普通会话执行端']);
});
test('run entries open the ordinary automation conversation without task binding', async () => {
  const c={globalThis:null,closeSchedulePanel(){c.closed=true;},WorkspaceHost:{open:(...args)=>{c.opened=args;return true;}}};
  c.globalThis=c; vm.createContext(c); vm.runInContext(runs,c);
  await c._schOpenRunEntryConversation({conversationId:'chat-1',conversationTitle:'自动化 · Work · 2026-10-26 10:20'});
  assert.equal(c.closed,true);
  assert.equal(c.opened[0],'create');
  assert.equal(JSON.stringify(c.opened[1]),JSON.stringify({tab:'chat',chatId:'chat-1',chatTitle:'自动化 · Work · 2026-10-26 10:20',source:'schedule-run',sessionTitle:'自动化 · Work · 2026-10-26 10:20'}));
});

test('failed, cancelled and uncreated conversations cannot navigate even with stale ids', async () => {
  let opened = 0;
  const c = { WorkspaceHost: { open: () => { opened++; return true; } } };
  vm.createContext(c); vm.runInContext(runs, c);
  for (const row of [null, {}, { conversationId: '  ' }, { conversationId: {} },
    { state: 'failed', conversationId: 'chat-1' }, { state: 'cancelled', receipt: { conversationId: 'chat-1' } },
    { state: 'unexpected', conversationId: 'chat-1' }]) {
    assert.equal(await c._schOpenRunEntryConversation(row), false);
  }
  assert.equal(opened, 0);
  assert.equal(await c._schOpenRunEntryConversation({ state: 'running', receipt: { conversationId: ' chat-1 ' } }), true);
  assert.equal(opened, 1);
});

test('history click rechecks the current run, drawer and account before navigating', async () => {
  let opened = 0;
  const c = { _schScope: 2, _schRunOpen: 's', _schRunRows: { s: [{ id: 'run', state: 'running', conversationId: 'chat-1' }] },
    WorkspaceHost: { open: () => { opened++; return true; } } };
  vm.createContext(c); vm.runInContext(runs, c);
  assert.equal(await c._schOpenCachedRunConversation('s', 'run', 'chat-1', 2), true);
  c._schRunRows.s[0] = { id: 'run', state: 'failed', conversationId: 'chat-1' };
  assert.equal(await c._schOpenCachedRunConversation('s', 'run', 'chat-1', 2), false);
  c._schRunRows.s[0].state = 'succeeded';
  assert.equal(await c._schOpenCachedRunConversation('s', 'run', 'chat-1', 1), false);
  c._schRunOpen = '';
  assert.equal(await c._schOpenCachedRunConversation('s', 'run', 'chat-1', 2), false);
  c._schRunOpen = 's'; c._schRunRows.s = [];
  assert.equal(await c._schOpenCachedRunConversation('s', 'run', 'chat-1', 2), false);
  assert.equal(opened, 1);
});
test('automation editor persists an explicit model alongside the selected Agent', () => {
  assert.match(editor, /id="schModel"/);
  assert.match(source, /modelName:\s*mode === 'direct'/);
  assert.match(editor, /modelOptions|_schModelOptionsHtml/);
  assert.match(editor, /schModel/);
});
test('changing managed bases retains available explicit models while deleted models use the first replacement', () => {
  const c = context(); vm.runInContext(editor, c);
  let value = 'pi-model', markup = '';
  const select = { disabled: false, get value() { return value; }, set value(next) { value = next; },
    get innerHTML() { return markup; }, set innerHTML(html) {
      markup = html;
      const options = [...html.matchAll(/<option value="([^"]*)"([^>]*)>/g)];
      value = (options.find(row => /\bselected\b/.test(row[2])) || options[0])?.[1] || '';
    } };
  const who = { value: 'local:pi' };
  c.document = { getElementById: id => id === 'schModel' ? select : id === 'schWho' ? who : null };
  vm.runInContext(`_schAgents=[{id:'local:pi',cli:'pi',modelPick:true},{id:'local:qwen',cli:'qwen',modelPick:true}];
    _schModelOptions=[{name:'pi-model'},{name:'qwen-model'},{name:'manual-model'}];
    _schAgentDefaultModels={pi:'pi-model',qwen:'qwen-model'};_schEditing='new';`, c);
  c._schRefreshModelField(); assert.equal(select.value, 'pi-model');
  who.value = 'local:qwen';
  c._schRefreshModelField();
  assert.equal(select.value, 'pi-model', 'a managed substrate change preserves an available explicit model');
  select.value = 'manual-model'; c._schRefreshModelField();
  assert.equal(select.value, 'manual-model', 'a catalog repaint cannot replace a user-selected model');
  for (const removed of ['local:model-0123456789abcdef0123456789abcdef', 'local:unavailable']) {
    c.removed = removed;
    vm.runInContext(`_schEditing={id:'saved',modelName:removed};_schModelOptions=[{name:'qwen-model'}];`, c);
    select.value = removed; c._schRefreshModelField();
    const expected = removed === 'local:unavailable' ? removed : 'qwen-model';
    assert.equal(select.value, expected, 'only an unresolved ownership sentinel requires explicit recovery');
    assert.ok(select.innerHTML.includes('value="' + expected + '" selected'));
    if (removed === 'local:unavailable') assert.ok(select.innerHTML.includes(' selected disabled'));
  }
  vm.runInContext(`_schEditing='new';_schAgentDefaultModels={};_schAgentDefaultErrors={qwen:'No default'};`, c);
  select.value = ''; c._schRefreshModelField();
  assert.equal(select.value, 'qwen-model', 'a new empty draft selects its sole usable model');
  assert.match(source, /target\?\.nativeModelPick[\s\S]{0,200}document\.getElementById\('schModel'\)\?\.value/);
});
test('starting a run waits for and opens its ordinary conversation id', async () => {
  const c={globalThis:null,_schScope:0,_schRunRows:{},closeSchedulePanel(){c.closed=true;},setTimeout:fn=>{fn();return 0;},WorkspaceHost:{open:(...args)=>{c.opened=args;return true;}},SoduWorkAPI:{listScheduleRuns:async()=>[{id:'run-1',conversationId:'chat-1',conversationTitle:'自动化 · Work · 2026-10-26 10:20'}]}};
  c.globalThis=c; vm.createContext(c); vm.runInContext(runs,c);
  assert.equal(await c._schLaunchRunConversation('schedule-1',{scheduleRunId:'run-1'},0),true);
  assert.equal(c.closed,true);
  assert.equal(c.opened[0],'create');
  assert.equal(c.opened[1].chatId,'chat-1');
  assert.equal(c.opened[1].taskSession,undefined);
});

test('waiting for this launch never opens an older manual run and stops on failure', async () => {
  let opened = 0, reads = 0;
  const c = { _schScope: 0, _schRunRows: {}, setTimeout: fn => { fn(); return 0; },
    WorkspaceHost: { open: () => { opened++; return true; } },
    SoduWorkAPI: { listScheduleRuns: async () => { reads++; return [{ id: 'old', trigger: 'manual', conversationId: 'old-chat' }]; } } };
  vm.createContext(c); vm.runInContext(runs, c);
  assert.equal(await c._schLaunchRunConversation('s', { scheduleRunId: 'new' }, 0), false);
  assert.equal(reads, 30); assert.equal(opened, 0);
  c.SoduWorkAPI.listScheduleRuns = async () => { reads++; return [{ id: 'new', state: 'failed', conversationId: 'stale-chat' }]; };
  assert.equal(await c._schLaunchRunConversation('s', { scheduleRunId: 'new' }, 0), false);
  assert.equal(reads, 31); assert.equal(opened, 0);
  assert.equal(await c._schLaunchRunConversation('s', {}, 0), false);
  assert.equal(reads, 31);
});
test('immediate run opens the selected model and sends one ordinary prompt directly', async () => {
  const sent = [], acks = [];
  const c={globalThis:null,_schScope:0,setTimeout:()=>1,clearTimeout(){},closeSchedulePanel(){c.closed=true;},
    WorkspaceHost:{open:(...args)=>{c.opened=args;return true;}},
    soduWorkAPI:{conversationSession:{
      open:async options=>{c.openOptions=options;return {ok:true,ref:'ref-1',sessionId:'chat-direct'};},
      send:async(...args)=>{sent.push(args);return {ok:true};},
      onEvent:()=>()=>{},
    }},
    SoduWorkAPI:{acknowledgeScheduleRun:async(_id,body)=>{acks.push(body);return {ok:true};}}};
  c.globalThis=c; vm.createContext(c); vm.runInContext(runs,c);
  assert.equal(await c._schLaunchRunConversation('schedule-1',{
    scheduleRunId:'run-direct', instanceId:'ui-direct', conversationTitle:'自动化 · Work · 2026-10-26 10:20',
    conversationInput:{adapterId:'pi',modelName:'selected-model',text:'请生成一轮结果',attachments:[]}
  },0),true);
  assert.equal(c.closed,true);
  assert.equal(c.openOptions.modelName,'selected-model');
  assert.equal(sent.length,1); assert.equal(sent[0][0],'ref-1'); assert.equal(sent[0][1],'请生成一轮结果');
  assert.deepEqual(acks.map(item=>item.state),['starting','running']);
  assert.equal(c.opened[1].chatId,'chat-direct');
});
test('immediate run with a personal plugin uses the automation open bridge and sends the locked plugin', async () => {
  const sent = [], calls = [];
  const c={globalThis:null,_schScope:0,setTimeout:()=>1,clearTimeout(){},closeSchedulePanel(){c.closed=true;},
    WorkspaceHost:{open:(...args)=>{c.opened=args;return true;}},
    soduWorkAPI:{personalPlugins:{list:async()=>({items:[{
      key:'weekly-report', pluginId:'local:weekly-report', enabled:true,
      entrypoints:{automation:true}, version:'1.2.0', checksum:'a'.repeat(64),
    }]})},conversationSession:{
      open:async()=>{throw Error('ordinary bridge should not be used when automation bridge exists');},
      openAutomation:async options=>{calls.push(options);return {ok:true,ref:'ref-plugin',sessionId:'chat-plugin'};},
      send:async(...args)=>{sent.push(args);return {ok:true};}, onEvent:()=>()=>{},
    }},
    SoduWorkAPI:{acknowledgeScheduleRun:async()=>({ok:true})}};
  c.globalThis=c; vm.createContext(c); vm.runInContext(runs,c);
  assert.equal(await c._schLaunchRunConversation('schedule-plugin',{
    scheduleRunId:'run-plugin',instanceId:'ui-plugin',conversationTitle:'自动化 · 周报 · 2026-10-27 10:20',
    conversationInput:{adapterId:'pi',modelName:'selected-model',text:'整理本周工作',attachments:[],
      personalPlugin:{key:'weekly-report',versionPolicy:'pinned',version:'1.2.0',checksum:'a'.repeat(64)}}
  },0),true);
  assert.equal(calls.length,1);
  assert.equal(JSON.stringify(calls[0].pluginLock), JSON.stringify({
    pluginId:'local:weekly-report',version:'1.2.0',checksum:'a'.repeat(64)}));
  assert.equal(sent.length,1);
  assert.equal(JSON.stringify(sent[0][3].plugins), JSON.stringify([{pluginId:'local:weekly-report'}]));
  assert.equal(c.opened[1].chatId,'chat-plugin');
});
test('standalone run entries use the shared chat bridge when WorkspaceHost is absent', async () => {
  const c={globalThis:null,closeSchedulePanel(){c.closed=true;},openPiChatEntry:id=>{c.chatId=id;}};
  c.globalThis=c; vm.createContext(c); vm.runInContext(runs,c);
  assert.equal(await c._schOpenRunEntryConversation({conversationId:'chat-standalone'}),true);
  assert.equal(c.closed,true); assert.equal(c.chatId,'chat-standalone');
});

function directRunFixture({ send, acknowledge } = {}) {
  const acks = [], timers = new Map(), events = new Map(); let sequence = 0, listener = null, removed = 0;
  const c = { _schScope: 0,
    addEventListener: (name, listener) => events.set(name, listener),
    removeEventListener: name => events.delete(name),
    setTimeout: (fn, delay) => { const id = ++sequence; timers.set(id, { fn, delay }); return id; },
    clearTimeout: id => timers.delete(id),
    WorkspaceHost: { open: () => true },
    soduWorkAPI: { conversationSession: {
      open: async () => ({ ok: true, ref: 'ref', sessionId: 'chat' }),
      send: (...args) => send ? send(listener, ...args) : Promise.resolve({ ok: true }),
      onEvent: callback => { listener = callback; return () => { listener = null; removed++; }; },
    } },
    SoduWorkAPI: { acknowledgeScheduleRun: async (_id, body) => {
      acks.push(body); return acknowledge ? acknowledge(body) : { ok: true };
    } },
  };
  vm.createContext(c); vm.runInContext(runs, c);
  return { c, acks, timers, events, removed: () => removed,
    event: value => listener?.(value),
    start: () => c._schLaunchDirectConversation({ scheduleRunId: 'run', instanceId: 'ui',
      conversationInput: { text: 'run once' } }, 0),
    tick: async () => { const [id, task] = timers.entries().next().value; timers.delete(id); await task.fn(); },
  };
}

test('renderer-owned automation renews its active lease and stops on its terminal event', async () => {
  const f = directRunFixture();
  assert.equal(await f.start(), true);
  assert.equal(f.timers.size, 1); assert.equal([...f.timers.values()][0].delay, 60000);
  await f.tick();
  assert.deepEqual(f.acks.map(item => item.state), ['starting', 'running', 'running']);
  assert.equal(f.timers.size, 1, 'only one next renewal is pending');
  f.event({ ref: 'another', kind: 'settled' }); assert.equal(f.timers.size, 1);
  f.event({ ref: 'ref', kind: 'error', reason: 'stopped' });
  assert.equal(f.timers.size, 0); assert.equal(f.removed(), 1);
  assert.equal(f.events.size, 0);
  assert.deepEqual(f.acks.map(item => item.state), ['starting', 'running', 'running', 'failed']);
});

test('an account change immediately removes the renderer lease timer and subscription', async () => {
  const f = directRunFixture();
  await f.start(); f.c._schScope++;
  f.events.get('soduwork-data-scope-changed')();
  assert.equal(f.timers.size, 0); assert.equal(f.events.size, 0); assert.equal(f.removed(), 1);
  assert.deepEqual(f.acks.map(item => item.state), ['starting', 'running']);
});

test('renderer lease renewal stops on server terminal state or account replacement', async () => {
  for (const mode of ['terminal', 'account']) {
    let serverEnded = false;
    const f = directRunFixture({ acknowledge: () => ({ ok: true, state: serverEnded ? 'failed' : 'running' }) });
    await f.start();
    if (mode === 'terminal') serverEnded = true;
    else f.c._schScope++;
    await f.tick();
    assert.equal(f.timers.size, 0); assert.equal(f.removed(), 1);
    assert.equal(f.acks.length, mode === 'terminal' ? 3 : 2);
  }
});

test('completion received during send cannot be overwritten by a late running ack', async () => {
  const f = directRunFixture({ send: async listener => { listener({ ref: 'ref', kind: 'settled' }); return { ok: true }; } });
  await f.start();
  assert.deepEqual(f.acks.map(item => item.state), ['starting', 'succeeded']);
  assert.equal(f.timers.size, 0); assert.equal(f.removed(), 1);
});

test('slow lease renewal is serial and cannot restart after completion', async () => {
  let calls = 0, release;
  const f = directRunFixture({ acknowledge: () => ++calls === 3
    ? new Promise(resolve => { release = resolve; }) : { ok: true } });
  await f.start(); const pending = f.tick();
  assert.equal(f.timers.size, 0, 'no overlapping renewal while the acknowledgement is pending');
  f.event({ ref: 'ref', kind: 'settled' });
  release({ ok: true, state: 'running' }); await pending;
  assert.equal(f.timers.size, 0); assert.equal(f.events.size, 0);
  assert.deepEqual(f.acks.map(item => item.state), ['starting', 'running', 'running', 'succeeded']);
});

test('a terminal dispatch receipt prevents starting a renderer conversation turn', async () => {
  let sends = 0;
  const f = directRunFixture({ acknowledge: () => ({ ok: true, state: 'failed' }), send: async () => { sends++; return { ok: true }; } });
  assert.equal(await f.start(), false);
  assert.equal(sends, 0); assert.equal(f.timers.size, 0);
});

test('automation run history exposes only the four user-facing states', () => {
  const c={globalThis:null,SCH_RUN_STATE:{
    starting:['待执行','starting'], running:['执行中','running'], waiting:['执行中','running'],
    succeeded:['完成','succeeded'], failed:['失败','failed'], cancelled:['失败','failed']
  }};
  c.globalThis=c; vm.createContext(c); vm.runInContext(runs,c);
  assert.deepEqual(Array.from(c._schConversationRunState({state:'starting'})),['待执行','starting']);
  assert.deepEqual(Array.from(c._schConversationRunState({state:'waiting'})),['执行中','running']);
  assert.deepEqual(Array.from(c._schConversationRunState({state:'succeeded'})),['完成','succeeded']);
  assert.deepEqual(Array.from(c._schConversationRunState({state:'cancelled'})),['失败','failed']);
  const receipt = { executionMode: 'soduwork.automation-conversation/v1', phase: 'device' };
  assert.deepEqual(Array.from(c._schConversationRunState({state:'running',receipt})),['待执行','starting']);
  assert.deepEqual(Array.from(c._schConversationRunState({state:'waiting',receipt:{executionMode:receipt.executionMode}})),['待执行','starting']);
  assert.deepEqual(Array.from(c._schConversationRunState({state:'running',conversationId:'chat',receipt:{executionMode:receipt.executionMode}})),['执行中','running']);
  assert.deepEqual(Array.from(c._schConversationRunState({state:'failed',receipt})),['失败','failed']);
});

test('failed delete keeps the plan and reports failure, without a success notification',async()=>{
  const c=context(),handlers={},notices=[];let removed=false,reloads=0;
  const card={querySelector:()=>null,appendChild(){},classList:{add(){},remove(){}}};
  const bar={querySelector:key=>({addEventListener:(_name,fn)=>{handlers[key]=fn}}),remove(){removed=true}};
  c.document={querySelector:()=>card,createElement:()=>bar};
  c.petSay=text=>notices.push(text);c._loadSch=()=>reloads++;
  c.SoduWorkAPI={deleteSchedule:async()=>{throw Error('connection offline')}};
  vm.runInContext('_schRows=[{id:"one",title:"Work"}]',c);
  c._schConfirmDel('one',{title:'Work'});await handlers['[data-c="yes"]']();
  assert.equal(vm.runInContext('_schRows.length',c),1);assert.equal(reloads,0);
  assert.ok(removed);assert.equal(notices.length,1);assert.match(notices[0],/没删掉|删除失败/);
  assert.doesNotMatch(notices[0],/删掉了定时任务/);
});
test('scoped toolbar styles retain fixed geometry, theme colors, keyboard focus and reduced motion',()=>{
  assert.match(css,/\.sch-i-ops \.sch-icon-action\{[^}]*width:32px;height:32px/);
  assert.match(css,/\.sch-icon-action svg\{[^}]*stroke:currentColor/);
  assert.match(css,/\.sch-icon-action:focus-visible/);
  assert.match(css,/@media\(pointer:coarse\)[^\n]*width:44px;height:44px/);
  assert.match(css,/@media\(prefers-reduced-motion:reduce\)[^\n]*animation:none/);
  assert.doesNotMatch(css,/\.sch-i-ops \.btn-mini/);
  assert.match(source,/_schConfirmDel\(sid, s\)/);
});
test('automation configuration selects have a shared visible affordance and focus state', () => {
  assert.match(css, /select\.sch-in\{[\s\S]*appearance:none/);
  assert.match(css, /select\.sch-in:hover:not\(:disabled\)/);
  assert.match(css, /select\.sch-in:focus-visible/);
  assert.match(css, /select\.sch-in:disabled/);
  assert.match(css, /@media\(forced-colors:active\)[\s\S]*background-image:none/);
  assert.match(css, /@media\(max-width:480px\)[\s\S]*sch-when-pv/);
});

test('desktop automation cards use three columns and stretch each row to equal height', () => {
  const layoutCss = css + '\n' + automationCss;
  assert.match(layoutCss, /@container (?:automation-content )?\(min-width:1240px\)[^{]*\{[^}]*\.sch-list\{grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/,
    'wide automation lists should render three cards per row');
  assert.match(layoutCss, /#schPanel \.sch-list\{[\s\S]*align-items:stretch!important/,
    'grid rows should stretch their cards');
  assert.match(layoutCss, /#schPanel \.sch-item\{[\s\S]*height:100%!important/,
    'cards should fill the row height');
});


test('app-created cards show the app icon, name and optional character without source labels; ordinary plans have none',()=>{
 const c=context();c.esc=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');c._schmFind=()=>null;vm.runInContext(cards,c);
 const html=c._schAppIdentity({sourceApp:{name:'灵感扭蛋机',characterName:'阿奇',icon:'data:image/png;base64,aA=='}});
 assert.match(html,/<img/);assert.match(html,/灵感扭蛋机/);assert.match(html,/阿奇/);assert.doesNotMatch(html,/来源|开源|作者/);
 assert.equal(c._schAppIdentity({note:'用户创建的日常计划'}),'');
 const noCharacter=c._schAppIdentity({sourceApp:{name:'自定义即用'}});assert.match(noCharacter,/自定义即用/);assert.doesNotMatch(noCharacter,/undefined|未知|作者/);
 const historic=c._schAppIdentity({note:'任务\n\n即用任务上下文（数据）：\n'+JSON.stringify({appName:'旧即用'})+'\n\n执行说明'});assert.match(historic,/旧即用/);
 assert.doesNotMatch(c._schAppIdentity({sourceApp:{name:'<img onerror=evil>',icon:'javascript:evil'}}),/src="javascript|<img onerror/);
});
