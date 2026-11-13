'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../components/panels/task-trace-approval.js'), 'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));

test('manual-only fixed deliveries keep analysis and manual confirmation while disabling automatic review', () => {
  const f = fixture({ action: 'review', gate: { readiness: { requiresHumanConfirmation: true } } });
  const html = f.api.html([f.item], { variant: 'task', taskId: 'task-1' });
  assert.match(html, /value="auto" disabled/);
  assert.match(html, /value="manual" checked/);
  assert.match(html, /本轮没有可自动核验的交付物/);
  assert.match(html, /data-tfd-acceptance-session="1"/);
  assert.match(html, /data-tfd-approval-action="approve"/);
});

function fixture(approval = {}, decide = async () => ({ok: true, request: {status: 'approved'}})) {
  const notices = [], handlers = {}, calls = [], events = {};
  const item = {id: 'gate-1', status: 'pending', action: 'baseline', ...approval};
  const state = {trace: {approvals: [item]}, refresh: async () => {}};
  const note = {value: '', focus() { this.focused = true; }}, details = {open: false};
  const proof = {open: false}, proofBody = {innerHTML: ''};
  const error = {hidden: true}, verify = {checked: false};
  const block = {dataset: {}, hidden: false, isConnected: true, removed: false,
    getAttribute: () => item.id, setAttribute() {}, removeAttribute() {},
    remove() { this.removed = true; this.isConnected = false; },
    querySelector(selector) { return ({'[data-tfd-approval-note]': note, '.tfd-inline-approval-form': details,
      '[data-tfd-approval-error]': error, '[data-tfd-approval-verify]': verify,
      '.tfd-inline-proof': proof, '[data-tfd-proof-body]': proofBody})[selector]; },
    querySelectorAll: () => [approve, reject]};
  const button = action => ({disabled: false, getAttribute: () => action,
    closest: selector => selector === '.tfd-inline-approval' ? block : (action === 'approve' ? approve : reject)});
  const approve = button('approve'), reject = button('reject');
  const root = {contains: () => true, querySelectorAll: () => [], addEventListener: (type, handler) => { handlers[type] = handler; }};
  const apiImpl = {
    decideApproval: (...args) => { calls.push(args); return decide(...args); },
    getAcceptanceContext: async () => ({artifactVersionId:'fixed-v1', criteria:[{id:'c1', label:'Reviewable result'}]}),
  };
  const context = {window: {petSay: text => notices.push(text), SoduWorkAPI: apiImpl,
    addEventListener: (name, handler) => { events[name] = handler; }}};
  vm.runInNewContext(source, context);
  const api = context.window.TaskTraceApproval;
  api.bind(root, state);
  return {api, item, state, block, note, details, proof, proofBody, error, approve, reject, verify, calls, notices, root, events, window: context.window,
    click(target) { handlers.click({target, preventDefault() {}, stopPropagation() {}}); },
    selectMode(value, disabled = false) { handlers.change({target: {value, disabled,
      matches: s => s === '[data-tfd-acceptance-mode]', closest: () => block}}); },
    change() { handlers.change({target: {...verify, matches: s => s.includes('verify'), closest: () => block}}); }};
}

test('交付验收明确选择手动或自动，自动验收交给独立会话而非证据门禁接口', () => {
  const f = fixture({action: 'review'});
  const html = f.api.html([f.item], {variant: 'task', taskId: 'task-1'});
  assert.match(html, /data-tfd-acceptance-mode/);
  assert.match(html, /手动验收/);
  assert.match(html, /自动验收/);
  assert.match(html, /开始自动验收/);
  assert.match(html, /本次固定版本/);
  assert.match(html, /原交付物不重新执行或修改/);
  assert.doesNotMatch(html, /批准后继续下一步，退回则暂停并修改/);
  assert.doesNotMatch(html, /选择插件或直接使用 Agent/);
  assert.match(html, /data-tfd-rework-file/);
  assert.doesNotMatch(html, /data-tfd-auto-review|自动验收当前证据/);
  assert.doesNotMatch(html, /data-tfd-acceptance-files-panel/);
  assert.doesNotMatch(html, /选择过程文件|可选，默认不带入/);
  const deploy = f.api.html([{...f.item, action: 'deploy'}], {variant: 'task', taskId: 'task-1'});
  assert.doesNotMatch(deploy, /data-tfd-acceptance-mode/);
  assert.doesNotMatch(deploy, /data-tfd-rework-file/);
});

test('approval card disappears after this user submits a decision', () => {
  const f = fixture({action: 'review', myDecision: {decision: 'approve'}});
  assert.equal(f.api.html([f.item], {variant: 'task', taskId: 'task-1'}), '');
});

test('chat can replace a successful approval with a read-only receipt before refresh', async () => {
  const f=fixture({action:'review'}); const outcomes=[];
  f.state.opts={onAcceptanceClosed(block,outcome){assert.equal(block,f.block);outcomes.push(outcome);return true;}};
  f.state.refresh=async()=>{throw Error('refresh unavailable');};
  f.note.value='Verified delivery';
  f.click(f.approve); await settle();
  assert.equal(outcomes.length,1);
  assert.equal(outcomes[0].decision,'approve'); assert.equal(outcomes[0].note,'Verified delivery');
  assert.equal(outcomes[0].status,'approved'); assert.equal(f.block.removed,false);
  assert.equal(f.block.dataset.approvalSubmitted,'true');
  f.click(f.approve); await settle(); assert.equal(f.calls.length,1);
});

test('creator direct acceptance card keeps its actions enabled without a hub approval', () => {
  const f = fixture({action: 'review'});
  f.block.getAttribute = name => name === 'data-tfd-approval-id' ? 'direct:task-1' : '';
  f.state.trace.approvals = [];
  f.state.directApi = {approve: async () => ({ok: true}), reject: async () => ({ok: true})};
  f.root.querySelectorAll = () => [f.block];
  f.api.bind(f.root, f.state);
  assert.equal(f.approve.disabled, false);
  assert.equal(f.reject.disabled, false);
});

test('独立验收会话携带模式与审批票，打开失败可重试且不关闭详情', async () => {
  const f = fixture({action: 'review'}), calls = [];
  f.window.openTaskConversation = async (...args) => { calls.push(args); return false; };
  let closed = 0;
  const task = {id: 'task-1', title: '交付结果'};
  await assert.rejects(f.api.openAcceptance(task, {acceptanceMode: 'auto', approvalId: 'gate-1', onOpened: () => closed++}), /会话.*打开/);
  assert.equal(closed, 0);
  assert.equal(calls[0][2].acceptanceMode, 'auto');
  assert.equal(calls[0][2].approvalId, 'gate-1');
  assert.equal(calls[0][2].acceptanceSession, true);
  assert.equal(calls[0][2].forceNew, false);
  f.window.openTaskConversation = async () => true;
  assert.equal(await f.api.openAcceptance(task, {onOpened: () => closed++}), true);
  assert.equal(closed, 1);
});

test('automatic review checks frozen criteria and version before opening or dismissing details', async () => {
  for (const context of [
    {artifactVersionId:'fixed-v1', criteria:[]},
    {artifactVersionId:'fixed-v1'},
    {artifactVersionId:'fixed-v1', criteria:'Not an itemized list'},
    {criteria:[{id:'c1', label:'Reviewable result'}]},
    {artifactVersionId:'', criteria:[{id:'c1', label:'Reviewable result'}]},
    null,
  ]) {
    const f = fixture({action:'review'});
    let opened = 0, dismissed = 0;
    f.window.SoduWorkAPI.getAcceptanceContext = async () => context;
    f.window.openTaskConversation = async () => { opened++; return true; };
    const options = {approvalId:'gate-1', acceptanceMode:'auto', onOpened:()=>dismissed++};
    await assert.rejects(f.api.openAcceptance({id:'task-1'}, options), /验收标准和固定交付版本/);
    assert.equal(opened, 0); assert.equal(dismissed, 0);
    assert.equal(await f.api.openAcceptance({id:'task-1'}, {...options, acceptanceMode:'manual'}), true);
    assert.equal(opened, 1); assert.equal(dismissed, 1, 'manual review remains available after failed automatic preflight');
  }
});

test('automatic preflight uses frozen approval criteria and allows retry after criteria are supplied', async () => {
  const f = fixture({action:'review'}), calls = [];
  let context = {artifactVersionId:'fixed-v1', criteria:[]};
  f.window.SoduWorkAPI.getTask = async () => ({id:'task-1', acceptanceCriteria:[]});
  f.window.SoduWorkAPI.getAcceptanceContext = async () => context;
  f.window.openTaskConversation = async (...args) => { calls.push(args); return true; };
  await assert.rejects(f.api.openAcceptance({id:'task-1'}, {acceptanceMode:'auto'}), /验收标准/);
  assert.equal(calls.length, 0);
  context = {artifactVersionId:'fixed-v1', criteria:[{id:'c1', label:'Frozen review criterion'}]};
  assert.equal(await f.api.openAcceptance({id:'task-1'}, {acceptanceMode:'auto'}), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][2].acceptanceMode, 'auto');
});

test('unavailable automatic preflight never navigates and manual review remains usable', async () => {
  for (const available of [false, true]) {
    const f = fixture({action:'review'});
    let opened = 0;
    if (available) f.window.SoduWorkAPI.getAcceptanceContext = async () => { throw Error('Acceptance service unavailable'); };
    else delete f.window.SoduWorkAPI.getAcceptanceContext;
    f.window.openTaskConversation = async () => { opened++; return true; };
    await assert.rejects(f.api.openAcceptance({id:'task-1'}, {acceptanceMode:'auto'}),
      available ? /Acceptance service unavailable/ : /无法读取验收条件/);
    assert.equal(opened, 0);
    assert.equal(await f.api.openAcceptance({id:'task-1'}, {acceptanceMode:'manual'}), true);
    assert.equal(opened, 1);
  }
});

test('同一执行人与验收人优先复用原执行会话，原会话缺失时由导航层回退新会话', async () => {
  const f = fixture({action: 'review'}), calls = [];
  f.window.Requirements = require('../core/requirements.js');
  f.window.__teamCap = {meId: 'u-1'};
  f.window.SoduWorkAPI.getTask = async () => ({id: 'task-1', title: '交付结果', status: 'done',
    createdBy: 'u-1', canReview: true,
    assigneeUserId: 'u-1', workRouting: {conversationTurn: {conversationId: 'execution-chat'}}});
  f.window.SoduWorkAPI.approvalDetail = async () => ({item: {id: 'gate-1', action: 'review', status: 'pending',
    assignment: {userId: 'u-1'}}});
  f.window.openTaskConversation = async (...args) => { calls.push(args); return true; };
  assert.equal(await f.api.openAcceptance({id: 'task-1', title: '交付结果'}, {approvalId: 'gate-1'}), true);
  assert.equal(calls[0][2].reuseExecutionSession, true);
  assert.equal(calls[0][2].acceptanceExecutionSession, true);
  assert.equal(calls[0][2].acceptanceSession, false);
});

test('创建人与执行人同一人时，创建人直验也复用原执行会话', async () => {
  const f = fixture({action: 'review'}), calls = [];
  f.window.Requirements = require('../core/requirements.js');
  f.window.__teamCap = {meId: 'u-1'};
  f.window.SoduWorkAPI.getTask = async () => ({id: 'task-1', title: '交付结果', status: 'done',
    createdBy: 'u-1', assigneeUserId: 'u-1',
    workRouting: {conversationTurn: {conversationId: 'execution-chat'}}});
  f.window.openTaskConversation = async (...args) => { calls.push(args); return true; };
  assert.equal(await f.api.openAcceptance({id: 'task-1', title: '交付结果'}, {approvalId: 'direct:task-1'}), true);
  assert.equal(calls[0][2].reuseExecutionSession, true);
  assert.equal(calls[0][2].acceptanceExecutionSession, true);
  assert.equal(calls[0][2].acceptanceSession, false);
});

test('快速点击验收时等待团队身份加载，仍复用同一人的原执行会话', async () => {
  const f = fixture({action: 'review'}), calls = [];
  let resolveCapability;
  f.window.Requirements = require('../core/requirements.js');
  f.window.__teamCap = undefined;
  f.window.SoduWorkAPI.getTeamCapability = () => new Promise(resolve => { resolveCapability = resolve; });
  f.window.SoduWorkAPI.getTask = async () => ({id: 'task-1', title: '交付结果', status: 'done',
    createdBy: 'u-1', assigneeUserId: 'u-1',
    workRouting: {conversationTurn: {conversationId: 'execution-chat'}}});
  f.window.openTaskConversation = async (...args) => { calls.push(args); return true; };
  const opening = f.api.openAcceptance({id: 'task-1', title: '交付结果'}, {
    acceptanceMode: 'auto', approvalId: 'direct:task-1',
  });
  await new Promise(setImmediate);
  assert.equal(calls.length, 0);
  resolveCapability({meId: 'u-1'});
  assert.equal(await opening, true);
  assert.equal(calls[0][2].acceptanceMode, 'auto');
  assert.equal(calls[0][2].reuseExecutionSession, true);
  assert.equal(calls[0][2].acceptanceExecutionSession, true);
  assert.equal(calls[0][2].acceptanceSession, false);
});

test('验收卡选择的过程文件随同一验收会话传递，需求详情与聊天入口共用参数', async () => {
  const f = fixture({action: 'review'}), calls = [];
  f.window.openTaskConversation = async (...args) => { calls.push(args); return true; };
  const task = {id: 'task-1', title: '交付结果'};
  assert.equal(await f.api.openAcceptance(task, {acceptanceMode: 'manual', approvalId: 'gate-1', acceptanceAttachmentIds: ['process-a']}), true);
  assert.deepEqual([...calls[0][2].acceptanceAttachmentIds], ['process-a']);
  assert.equal(calls[0][2].acceptanceSession, true);
});

test('重复点击验收入口只打开一个会话，失败后仍可重试', async () => {
  const f = fixture({action: 'review'}), calls = [];
  let finish;
  f.window.openTaskConversation = (...args) => {
    calls.push(args);
    return new Promise(resolve => { finish = resolve; });
  };
  const task = {id: 'task-dedupe', title: '交付结果'};
  const first = f.api.openAcceptance(task, {acceptanceMode: 'auto', approvalId: 'gate-1'});
  const second = f.api.openAcceptance(task, {acceptanceMode: 'manual', approvalId: 'gate-1'});
  assert.strictEqual(first, second);
  await settle();
  assert.equal(calls.length, 1);
  finish(true);
  assert.equal(await first, true);
  await new Promise(resolve => setTimeout(resolve, 2100));
  f.window.openTaskConversation = async (...args) => { calls.push(args); return true; };
  assert.equal(await f.api.openAcceptance(task, {acceptanceMode: 'auto', approvalId: 'gate-1'}), true);
  assert.equal(calls.length, 2);
});

test('待验收入口仅向实际验收人开放，不受执行设备归属限制', () => {
  const f = fixture(); f.window.Requirements = require('../core/requirements.js'); f.window.__teamCap = {meId: 'creator'};
  const task = {id: 't', status: 'done', createdBy: 'creator', ownerClientId: 'other-device'};
  assert.equal(f.api.canAcceptTask(task, {}), true);
  assert.equal(f.api.canAcceptTask({...task, canViewExecution: false}, {}), false);
  assert.equal(f.api.canAcceptTask({...task, reviewedAt: 1}, {}), false);
  assert.equal(f.api.canAcceptTask({...task, status: 'doing'}, {}), false);
  assert.equal(f.api.canAcceptTask(task, {waiting: new Map([['t', ['指定验收人']]])}), false);
  assert.equal(f.api.canAcceptTask({...task, createdBy: 'other'}, {approvals: new Map([['t', {id:'review', action:'review', status:'pending'}]])}), false);
});

test('验收方式在同一审批刷新后保留，但新版本或无权限切换不会复用', () => {
  const f = fixture({action: 'review'});
  f.block.getAttribute = name => name === 'data-tfd-approval-id' ? 'gate-1' : 'v1';
  f.selectMode('auto');
  assert.equal(f.block.dataset.tfdAcceptanceChoice, 'auto');
  assert.match(f.api.html([{...f.item, artifactVersionId:'v1'}], {variant:'task', taskId:'t'}), /data-tfd-acceptance-choice="auto"/);
  assert.match(f.api.html([{...f.item, artifactVersionId:'v2'}], {variant:'task', taskId:'t'}), /data-tfd-acceptance-choice="manual"/);
  f.selectMode('manual', true);
  assert.equal(f.block.dataset.tfdAcceptanceChoice, 'auto');
});

test('验收会话打开前重新核对审批人和最新状态', async () => {
  const f = fixture(), task = {id:'t', status:'done'}, calls=[];
  f.window.Requirements = require('../core/requirements.js');
  f.window.openTaskConversation = async () => {calls.push('open'); return true;};
  f.window.SoduWorkAPI.getTask = async () => ({...task, reviewedAt:1});
  await assert.rejects(f.api.openAcceptance(task), /状态或验收权限/);
  f.window.SoduWorkAPI.getTask = async () => task;
  f.window.SoduWorkAPI.approvalDetail = async () => ({item:{id:'r',status:'pending',action:'review',assignment:null}});
  await assert.rejects(f.api.openAcceptance(task, {approvalId:'r'}), /不由你确认/);
  assert.equal(calls.length,0);
});

test('切换账号后，迟到的验收权限查询不能再打开会话', async () => {
  const events = {}, calls = []; let finish;
  const window = {addEventListener:(name, listener)=>{events[name]=listener;},
    SoduWorkAPI:{getTask:()=>new Promise(resolve=>{finish=resolve;})},
    openTaskConversation:async()=>{calls.push('open');return true;}};
  vm.runInNewContext(source,{window});
  const open=window.TaskTraceApproval.openAcceptance({id:'t'});
  await settle();
  events['soduwork-data-scope-changed'](); finish({id:'t',status:'done'});
  await assert.rejects(open,/账号或服务/);
  assert.equal(calls.length,0);
});

test('approval actions are visible outside folded evidence, with escaped task identity', () => {
  const f = fixture();
  const html = f.api.html([f.item], {variant: 'task', taskTitle: '<test>'}, f.item.id);
  assert.ok(html.indexOf('</details>') < html.indexOf('data-tfd-approval-action="approve"'));
  assert.match(html, /&lt;test&gt;/);
  assert.match(html, /role="alert" hidden/);
  assert.match(html, /批准并继续/);
  assert.equal(f.api.current([f.item], 'stale-gate'), null);
  assert.equal(f.api.html([f.item], {variant: 'task'}, 'stale-gate'), '');
});
test('reject without a note opens the explanation and does not submit', async () => {
  const f = fixture(); f.click(f.reject); await settle();
  assert.equal(f.details.open, true); assert.equal(f.note.focused, true);
  assert.equal(f.error.hidden, false); assert.equal(f.calls.length, 0);
});
test('evidence and verification are enforced again before submitting', async () => {
  for (const item of [{action: 'deploy'}, {gate: {readiness: {canApprove: false}}}]) {
    const f = fixture(item); f.click(f.approve); await settle();
    assert.equal(f.calls.length, 0); assert.equal(f.error.hidden, false);
  }
});
test('repeated clicks and checkbox changes cannot resubmit a pending request', async () => {
  let finish; const f = fixture({}, () => new Promise(resolve => { finish = resolve; }));
  f.click(f.approve); f.change(); f.click(f.approve);
  assert.equal(f.calls.length, 1); assert.equal(f.approve.disabled, true);
  finish({ok: true, request: {status: 'approved'}}); await settle();
  f.click(f.approve); assert.equal(f.calls.length, 1);
});
test('one vote in a multi-person gate never announces that execution is released', async () => {
  const f = fixture({required: 2}, async () => ({ok: true, request: {status: 'pending'}}));
  assert.match(f.api.html([f.item], {variant: 'task'}), /需 2 人批准/);
  f.click(f.approve); await settle();
  assert.match(f.notices[0], /流程暂不继续/);
  assert.doesNotMatch(f.notices[0], /审批已通过/);
});
test('successful submission followed by refresh failure does not enable a duplicate decision', async () => {
  const f = fixture(); f.state.refresh = async () => { throw Error('offline'); };
  f.click(f.approve); await settle();
  assert.match(f.error.textContent, /无需重复提交/); assert.equal(f.approve.disabled, true);
  assert.equal(f.block.hidden, true);
});
test('each manual acceptance choice closes the card after the server accepts it', async () => {
  const approved = fixture(); approved.click(approved.approve); await settle();
  assert.equal(approved.block.hidden, true);
  const rejected = fixture(); rejected.note.value = '请补充交付证据'; rejected.click(rejected.reject); await settle();
  assert.equal(rejected.block.hidden, true);
});
test('request failure restores buttons without bypassing unmet evidence', async () => {
  const f = fixture({gate: {readiness: {canApprove: false}}}, async () => { throw Error('offline'); });
  f.note.value = '补充截图'; f.click(f.reject); await settle();
  assert.equal(f.reject.disabled, false); assert.equal(f.approve.disabled, true);
  assert.equal(f.error.hidden, false);
});
test('delegated events use the latest state after a card refresh', async () => {
  const f = fixture(); f.api.bind(f.root, {trace: {approvals: []}});
  f.click(f.approve); await settle();
  assert.equal(f.calls.length, 0); assert.match(f.error.textContent, /已变化/);
});
test('post-delivery acceptance does not promise to start another execution', () => {
  const f = fixture({action: 'review'});
  const html = f.api.html([f.item], {variant: 'task', blocksExecution: false});
  assert.match(html, /确认验收/); assert.doesNotMatch(html, /批准并继续|下一步/);
});
test('unchanged server markup retains mutable form DOM across chat polling', () => {
  const f = fixture(), root = {outerHTML: '<section>gate</section>'};
  f.api.remember(root);
  root.outerHTML = '<section data-chat-bound="1">expanded form with draft</section>';
  assert.equal(f.api.patch(root, {outerHTML: '<section>gate</section>'}), root);
});

test('permission lookup keeps decisions disabled until authoritative assignment is known', async () => {
  let resolve; const f=fixture(); f.block.isConnected=true;
  f.root.querySelectorAll=()=>[f.block];
  f.window.SoduWorkAPI.approvalDetail=()=>new Promise(r=>{resolve=r;});
  f.api.bind(f.root,f.state);
  assert.equal(f.approve.disabled,true);assert.equal(f.reject.disabled,true);
  resolve({item:{...f.item,assignment:{userId:'me',reasons:[]}}});await settle();
  assert.equal(f.approve.disabled,false);assert.equal(f.block.dataset.approvalAccess,'allowed');
});

test('detail hydration shares verified identity with its current card binding without another request', async () => {
  const f = fixture({action: 'review'}), seen = [];
  let calls = 0;
  const detail = {...f.item, taskId: 'task-1', assignment: {userId: 'me'}};
  f.root.querySelectorAll = () => [f.block];
  f.window.SoduWorkAPI.approvalDetail = async () => { calls++; return {item: detail}; };
  f.state.opts = {onApprovalDetails: (id, item) => seen.push([id, item])};
  f.api.bind(f.root, f.state); await settle();
  assert.deepEqual(seen, [[f.item.id, detail]]);
  f.api.bind(f.root, f.state);
  assert.equal(seen.length, 2);
  assert.equal(calls, 1);
  f.events['soduwork-data-scope-changed']();
  f.api.bind(f.root, f.state);
  assert.equal(seen.length, 2, 'cached details from the prior account must not be shared');
});

test('late detail hydration never shares a detached card or a prior account response', async () => {
  for (const change of ['detached', 'account']) {
    const f = fixture(), seen = [];
    let finish;
    f.root.querySelectorAll = () => [f.block];
    f.window.SoduWorkAPI.approvalDetail = () => new Promise(resolve => { finish = resolve; });
    f.state.opts = {onApprovalDetails: (...args) => seen.push(args)};
    f.api.bind(f.root, f.state);
    if (change === 'detached') f.block.isConnected = false;
    else f.events['soduwork-data-scope-changed']();
    finish({item: {...f.item, taskId: 'task-1', assignment: {userId: 'me'}}});
    await settle();
    assert.equal(seen.length, 0, change);
  }
});

test('detail callbacks distinguish denied access from transient or mismatched responses', async () => {
  for (const failure of ['ineligible', 'forbidden', 'offline', 'mismatched']) {
    const f = fixture(), seen = [];
    f.root.querySelectorAll = () => [f.block];
    f.state.opts = {onApprovalDetails: (...args) => seen.push(args)};
    if (failure === 'ineligible') f.window.SoduWorkAPI.listApprovals = async () => ({pendingTasks: []});
    f.window.SoduWorkAPI.approvalDetail = async () => {
      if (failure === 'mismatched') return {item: {...f.item, id: 'another'}};
      const error = new Error('Isolated evidence failure');
      if (failure === 'forbidden') error.status = 403;
      throw error;
    };
    f.api.bind(f.root, f.state); await settle();
    const denied = ['ineligible', 'forbidden'].includes(failure);
    assert.deepEqual(seen, denied ? [[f.item.id, null]] : [], failure);
    assert.equal(f.block.dataset.approvalAccess, denied ? 'denied' : 'error', failure);
  }
});

test('executor trace facts do not request private approval details without a pending assignment', async () => {
  const f = fixture({action: 'review'}), calls = [];
  f.root.querySelectorAll = () => [f.block];
  f.window.SoduWorkAPI.listApprovals = async () => ({pendingTasks: [], items: [{...f.item, taskId: 'task-1'}]});
  f.window.SoduWorkAPI.approvalDetail = async id => { calls.push(id); return {item: {...f.item, assignment: null}}; };
  f.api.bind(f.root, f.state); await settle();
  assert.deepEqual(calls, []);
  assert.equal(f.block.removed, true);
  assert.equal(f.block.dataset.approvalAccess, 'denied');
  assert.equal(f.state.trace.approvals[0].status, 'pending');
});

test('complete pending references admit a reviewer outside the paginated inbox items', async () => {
  const f = fixture(), calls = [];
  f.root.querySelectorAll = () => [f.block];
  f.window.SoduWorkAPI.listApprovals = async () => ({pendingTasks: [{id: f.item.id, taskId: 'task-1'}], items: []});
  f.window.SoduWorkAPI.approvalDetail = async id => {
    calls.push(id); return {item: {...f.item, assignment: {userId: 'me', reasons: []}}};
  };
  f.api.bind(f.root, f.state); await settle();
  assert.deepEqual(calls, [f.item.id]);
  assert.equal(f.block.dataset.approvalAccess, 'allowed');
  assert.equal(f.approve.disabled, false);
});

test('account changes discard in-flight approval eligibility before loading details', async () => {
  const events = {}, calls = []; let finish;
  const window = {addEventListener: (name, listener) => { events[name] = listener; },
    SoduWorkAPI: {listApprovals: () => new Promise(resolve => { finish = resolve; }),
      approvalDetail: async id => { calls.push(id); return {item: {id, assignment: {userId: 'old-user'}}}; }}};
  vm.runInNewContext(source, {window});
  const block = {dataset: {}, isConnected: true, getAttribute: () => 'gate-old',
    querySelector: () => null, querySelectorAll: () => [], remove() { this.isConnected = false; }};
  const root = {querySelectorAll: () => [block], addEventListener() {}};
  window.TaskTraceApproval.bind(root, {trace: {approvals: [{id: 'gate-old', status: 'pending'}]}});
  await settle(); events['soduwork-data-scope-changed']();
  assert.equal(typeof finish, 'function');
  finish({pendingTasks: [{id: 'gate-old', taskId: 'task-1'}]}); await settle();
  assert.deepEqual(calls, []);
  assert.notEqual(block.dataset.approvalAccess, 'allowed');
});

test('concurrent cards share only the in-flight eligibility query and a later assignment is rechecked', async () => {
  const f = fixture(), calls = []; let finish, lists = 0;
  const second = {...f.block, dataset: {}, getAttribute: () => 'gate-2'};
  f.root.querySelectorAll = () => [f.block, second];
  f.window.SoduWorkAPI.listApprovals = () => {
    lists++; return new Promise(resolve => { finish = resolve; });
  };
  f.window.SoduWorkAPI.approvalDetail = async id => {
    calls.push(id); return {item: {...f.item, assignment: {userId: 'me', reasons: []}}};
  };
  f.api.bind(f.root, f.state); await settle();
  assert.equal(lists, 1);
  finish({pendingTasks: []}); await settle();
  assert.deepEqual(calls, []);
  const refreshed = {...f.block, dataset: {}, removed: false, isConnected: true};
  f.root.querySelectorAll = () => [refreshed];
  f.api.bind(f.root, f.state); await settle();
  assert.equal(lists, 2);
  finish({pendingTasks: [{id: f.item.id, taskId: 'task-1'}]}); await settle();
  assert.deepEqual(calls, [f.item.id]);
  assert.equal(refreshed.dataset.approvalAccess, 'allowed');
});

test('approval notifications invalidate denied-card markup without resetting an unchanged authorized form', async () => {
  const events = {}; let candidates = [];
  const window = {addEventListener: (name, listener) => { events[name] = listener; },
    TaskApprovalInbox: {snapshot: () => candidates},
    SoduWorkAPI: {listApprovals: async () => ({pendingTasks: []}), approvalDetail: async () => { throw Error('Must not fetch'); }}};
  vm.runInNewContext(source, {window, document: {activeElement: null}});
  const api = window.TaskTraceApproval;
  events['soduwork-approvals-changed']?.();
  const block = {dataset: {}, isConnected: true, getAttribute: () => 'gate-1',
    querySelector: () => null, querySelectorAll: () => [], remove() { this.isConnected = false; }};
  const root = {outerHTML: '<section>gate</section>', querySelectorAll: () => block.isConnected ? [block] : [],
    addEventListener() {}, replaceWith() { this.replaced = true; }};
  const wanted = {outerHTML: root.outerHTML, querySelectorAll: () => []};
  const authorized = {outerHTML: '<section>authorized draft</section>'};
  api.remember(root); api.remember(authorized);
  api.bind(root, {trace: {approvals: [{id: 'gate-1', status: 'pending'}]}}); await settle();
  assert.equal(api.patch(root, wanted), root, 'ordinary polling does not query denied cards repeatedly');
  events['soduwork-approvals-changed']?.();
  assert.equal(api.patch(root, wanted), root, 'an unchanged inbox refresh preserves the denied result');
  candidates = [{id: 'gate-1', taskId: 'task-1'}];
  events['soduwork-approvals-changed']?.();
  assert.equal(api.patch(root, wanted), wanted, 'new assignments must recreate and recheck the hidden card');
  assert.equal(root.replaced, true);
  assert.equal(api.patch(authorized, {outerHTML: authorized.outerHTML}), authorized, 'permission notices preserve active drafts');
});

test('another approver or a prior vote never exposes an actionable decision', async () => {
  for(const extra of [{assignment:null},{assignment:{userId:'me'},myDecision:{decision:'approve'}}]) {
    const f=fixture();f.block.isConnected=true;f.root.querySelectorAll=()=>[f.block];
    f.window.SoduWorkAPI.approvalDetail=async()=>({item:{...f.item,...extra}});
    f.api.bind(f.root,f.state);await settle();f.click(f.approve);await settle();
    assert.equal(f.approve.disabled,true);assert.equal(f.reject.disabled,true);assert.equal(f.calls.length,0);
    assert.equal(f.block.removed, !extra.myDecision);
  }
});

test('服务端确认非验收人后移除验收卡，不留下可弹出的入口', async () => {
  const f = fixture(); f.block.isConnected = true; f.root.querySelectorAll = () => [f.block];
  const error = new Error('这项审批没有分配给你'); error.status = 403;
  f.window.SoduWorkAPI.approvalDetail = async () => { throw error; };
  f.api.bind(f.root, f.state); await settle();
  assert.equal(f.block.removed, true);
  assert.equal(f.block.dataset.approvalAccess, 'denied');
});

test('permission or evidence fetch failure fails closed with a retry explanation', async () => {
  const f=fixture();f.block.isConnected=true;f.root.querySelectorAll=()=>[f.block];
  f.window.SoduWorkAPI.approvalDetail=async()=>{throw Error('offline')};
  f.api.bind(f.root,f.state);await settle();
  assert.equal(f.approve.disabled,true);assert.equal(f.reject.disabled,true);
  assert.equal(f.block.dataset.approvalAccess,'error');assert.match(f.error.textContent,/重试/);
});

test('transient evidence failures reveal the retry control inside the proof disclosure', async () => {
  const f = fixture(); f.block.isConnected = true; f.root.querySelectorAll = () => [f.block];
  f.window.SoduWorkAPI.approvalDetail = async () => { throw Error('offline'); };
  f.api.bind(f.root, f.state); await settle();
  assert.equal(f.block.dataset.approvalAccess, 'error');
  assert.equal(f.proof.open, true);
  assert.match(f.proofBody.innerHTML, /data-tfd-proof-retry/);
});

test('inline evidence is an in-place disclosure without exposing internal version labels', () => {
  const f=fixture({action:'deploy',artifactVersionId:'v-id',artifact:{seq:3,commit:'abc123'},gate:{subject:{environmentName:'生产'}}});
  const html=f.api.html([f.item],{variant:'task'});
  assert.doesNotMatch(html,/本次确认|v3 · abc123/);assert.match(html,/tfd-inline-proof/);
  assert.doesNotMatch(html,/data-tfd-action="approval"/);
});

test('blocked review gate explains the gap instead of offering a dead button', () => {
  const f = fixture();
  const item = {id: 'g1', status: 'pending', action: 'review',
    gate: {readiness: {canApprove: false, blockers: ['可复核的固定成果']},
           requirements: [{id: 'deliverable', oneOf: ['file', 'url', 'commit']}]}};
  const html = f.api.html([item], {variant: 'task'});
  assert.match(html, /还需补充证据/);
  assert.match(html, /退回修改/);
  assert.doesNotMatch(html, /data-tfd-approval-file|上传截图/);
});

test('review falls back to the hub title so every surface speaks one language', () => {
  const f = fixture({action: 'review'});
  const html = f.api.html([f.item], {variant: 'task', blocksExecution: false, taskTitle: '写一篇作文'}, f.item.id);
  assert.match(html, /验收交付结果/);
  assert.doesNotMatch(html, /业务审阅/);
  /* Post-delivery cards with blocksExecution=false use acceptance-review wording. */
  assert.match(html, /确认验收/);
});

test('detail load does not expose internal version identifiers in the card', async () => {
  const f = fixture({action: 'review'});
  assert.doesNotMatch(f.api.html([f.item], {variant: 'task'}), /本次确认/);
  f.block.isConnected = true;
  f.root.querySelectorAll = () => [f.block];
  const inserted = [];
  const name = {insertAdjacentHTML: (position, markup) => inserted.push({position, markup})};
  const body = {querySelector: selector =>
    selector === ':scope > .tfd-inline-task-name' ? name : null};
  f.block.querySelector = selector => selector === '.tfd-inline-approval-body' ? body : null;
  f.window.SoduWorkAPI.approvalDetail = async () => ({item: {...f.item,
    assignment: {userId: 'me', reasons: []},
    confirmation: {lockedArtifact: {seq: 3, checksum: 'cd1c2331a19848abcdef'}}}});
  f.api.bind(f.root, f.state); await settle();
  assert.equal(inserted.length, 0);
});

test('an existing internal version line is left untouched when details refresh', async () => {
  const f = fixture({action: 'review',
    confirmation: {lockedArtifact: {seq: 2, checksum: 'old-version-hash'}}});
  assert.match(f.api.html([f.item], {variant: 'task'}), /v2 · old-version-ha/);
  f.block.isConnected = true;
  f.root.querySelectorAll = () => [f.block];
  let replaced = '';
  const existing = {get outerHTML() { return '<p class="tfd-inline-subject">old</p>'; },
    set outerHTML(value) { replaced = value; }};
  const body = {querySelector: selector =>
    selector === ':scope > .tfd-inline-subject' ? existing : null};
  f.block.querySelector = selector => selector === '.tfd-inline-approval-body' ? body : null;
  f.window.SoduWorkAPI.approvalDetail = async () => ({item: {...f.item,
    assignment: {userId: 'me', reasons: []},
    confirmation: {lockedArtifact: {seq: 3, checksum: 'cd1c2331a19848new'}}}});
  f.api.bind(f.root, f.state); await settle();
  assert.equal(replaced, '');
});

test('image gates keep the in-place upload remedy', () => {
  const f = fixture();
  const item = {id: 'g2', status: 'pending', action: 'uat',
    gate: {readiness: {canApprove: false, blockers: ['环境验收截图']},
           requirements: [{id: 'screenshot', oneOf: ['image'], satisfied: false}]}};
  const html = f.api.html([item], {variant: 'task'});
  assert.match(html, /data-tfd-approval-file/);
  assert.doesNotMatch(html, /accept="image\/(?:png|jpeg|webp|gif)/);
  assert.match(html, /上传截图/);
});

test('detail load surfaces the evidence gate that render-time data lacked', async () => {
  const f = fixture({action: 'review'});
  assert.doesNotMatch(f.api.html([f.item], {variant: 'task'}), /还需补充证据/);
  f.block.isConnected = true;
  f.root.querySelectorAll = () => [f.block];
  const inserted = [];
  const rule = {insertAdjacentHTML: (position, markup) => inserted.push({position, markup})};
  const body = {querySelector: selector =>
    selector === ':scope > .tfd-inline-rule' ? rule : null};
  f.block.querySelector = selector => selector === '.tfd-inline-approval-body' ? body : null;
  f.window.SoduWorkAPI.approvalDetail = async () => ({item: {...f.item,
    assignment: {userId: 'me', reasons: []},
    gate: {readiness: {canApprove: false, blockers: ['可复核的固定成果']},
           requirements: [{id: 'deliverable', oneOf: ['file', 'url', 'commit']}]}}});
  f.api.bind(f.root, f.state); await settle();
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].position, 'afterend');
  assert.match(inserted[0].markup, /还需补充证据/);
  assert.match(inserted[0].markup, /可复核的固定成果/);
  assert.match(inserted[0].markup, /退回修改/);
  assert.doesNotMatch(inserted[0].markup, /上传截图/);
  assert.equal(f.approve.disabled, true);
  assert.equal(f.reject.disabled, false);
});

test('a satisfied gate in authoritative detail removes the stale blocked notice', async () => {
  const f = fixture({action: 'review', gate: {readiness: {canApprove: false, blockers: ['可复核的固定成果']}}});
  assert.match(f.api.html([f.item], {variant: 'task'}), /还需补充证据/);
  f.block.isConnected = true;
  f.root.querySelectorAll = () => [f.block];
  let removed = false;
  const existingGate = {outerHTML: '<div class="tfd-inline-approval-gate is-blocked">old</div>',
    remove: () => { removed = true; }};
  const body = {querySelector: selector =>
    selector === ':scope > .tfd-inline-approval-gate' ? existingGate : null};
  f.block.querySelector = selector => selector === '.tfd-inline-approval-body' ? body : null;
  f.window.SoduWorkAPI.approvalDetail = async () => ({item: {...f.item,
    assignment: {userId: 'me', reasons: []},
    gate: {readiness: {canApprove: true}, requirements: []}}});
  f.api.bind(f.root, f.state); await settle();
  assert.equal(removed, true);
  assert.equal(f.approve.disabled, false);
});
