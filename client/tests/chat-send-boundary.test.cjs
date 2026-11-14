'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../components/panels/panels-chat.js'), 'utf8');
const recovery = fs.readFileSync(path.join(__dirname, '../components/panels/chat-draft-recovery.js'), 'utf8');
const section = (start, end) => {
  const method = /function (\w+)/.exec(start)?.[1];
  if (['_sendCore', '_ensureOnce'].includes(method)) return require('./renderer-source.cjs')
    .factoryFunction('chat-session-controller.js', 'ChatSessionController', method);
  if (end.includes('function _awaitBounded')) end = '  async function refreshHistory';
  const i = source.indexOf(start); return source.slice(i, source.indexOf(end, i));
};
const flush = async () => { for (let i = 0; i < 35; i++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; };

test('first work-only send waits again for a model changed during attachment preparation', async () => {
  for (const outcome of ['saved', 'failed', 'navigated']) {
    const upload=deferred(), saved=deferred(), f=fixture({fresh:true,attachments:upload.promise});
    const opened=[], selections=[];
    f.ctx._sessionId='work-chat';f.ctx._draftKey='work-chat';f.ctx._snap.workOnly=true;
    f.ctx._sessionOptions={adapterId:'qwen',modelName:'initial'};
    f.ctx._composerControls={waitForAccess:async()=>true};
    f.ctx._workCards={capture(){},ensureDraftSelectionSaved:()=>{selections.push(f.ctx._sessionOptions.modelName);return saved.promise;}};
    f.ctx._ensureOnce=async()=>{opened.push({...f.ctx._sessionOptions});f.ctx._ref='work-ref';return true;};
    vm.runInContext(require('./renderer-source.cjs').factoryFunction('chat-session-controller.js','ChatSessionController','_ensure'),f.ctx);
    f.input.value='retain original text and attachment';const pending=f.ctx._sendCore();await flush();
    f.ctx._sessionOptions.modelName='latest';upload.resolve([{id:'attachment-a'}]);await flush();
    assert.deepEqual(selections,['latest']);assert.equal(opened.length,0);assert.equal(f.requests.length,0);
    const other=outcome==='navigated'?f.switchTo('b','other draft'):null;
    saved.resolve(outcome!=='failed');
    assert.equal(await pending,outcome==='saved');
    if (outcome==='saved') { assert.equal(opened[0].modelName,'latest');assert.equal(f.requests.length,1); }
    else {
      assert.equal(opened.length,0);assert.equal(f.requests.length,0);
      if (outcome==='failed') { assert.equal(f.input.value,'retain original text and attachment');assert.equal(f.added[0][0][0].name,'only-a.txt'); }
      else { assert.equal(f.input.value,'other draft');assert.equal(f.ctx._snap,other); }
    }
  }
});
function fixture({ fresh = false, attachments, send, files: initialFiles } = {}) {
  const requests = [], notices = [], added = [], plugins = [], timers = new Map(); let paints = 0;
  const input = { value: '', style: {}, focus() {}, dispatchEvent() {} };
  const bridge = { send: async (...args) => { requests.push(args); return send ? send(...args) : { ok: true }; } };
  const files = initialFiles || [{ name: 'only-a.txt', path: 'fixture-a.txt' }];
  const attachmentPicker = { names: () => ['only-a.txt'], files: () => files, refs: () => attachments || Promise.resolve([]),
    clear() {}, add: (...args) => added.push(args) };
  const ctx = { global: {}, Date, Promise, Event: class {}, document: { getElementById: () => input },
    _ref: fresh ? '' : 'ref-a', _sessionId: fresh ? '' : 'archive-a', _draftKey: fresh ? 'new' : 'archive-a',
    _viewEpoch: 1, _sessionOptions: { projectId: 'project-a' }, _composerControls: null, _activeCollabTaskId: '',
    _skillPicker: null, _messageAttachments: attachmentPicker, _pendingAttachmentNames: [],
    _pluginMention: { selected: () => [], clear() {}, restore: rows => plugins.push(rows) },
    _pluginResolveBusy: false, _pluginResolveSeq: 0, _submissionSeq: 0, _localQueueSeq: 0,
    _submitTail: Promise.resolve(), _localQueue: [], _pending: '', _pendingPlugins: [], _retryDraft: null,
    _snap: { status: 'idle', messages: [] }, _taskOpenPending: false, _submissionDrafts: new Map(), _taskAttachments: [],
    _conversationDrafts: new Map(), _failedConversationDrafts: new Map(), _draftScopeEpoch: 0, _draftStorageLoaded: true, _draftStorageTimer: 0,
    _mount: () => ({ querySelector: () => input }), _api: () => bridge, _runtimeBusy: () => ctx._snap?.status === 'streaming',
    _dismissProposal() {}, _render() { paints++; }, _rememberSubmission() {},
    _ensure: async () => !!ctx._ref, petSay: value => notices.push(value),
    setTimeout(fn) { const id = timers.size + 1; timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); },
  };
  ctx.window = ctx.global;
  ctx.ctx = ctx;
  vm.createContext(ctx);
  vm.runInContext(recovery, ctx); Object.assign(ctx, ctx.global.ChatDraftRecovery.create(ctx));
  vm.runInContext(section('  function _rememberSubmission(', '  function _cancelScheduledRender(') +
    section('  function _fail(', '  function _awaitBounded(') +
    section('  async function _sendCore(', '  function _cancel()'), ctx);
  function switchTo(id, text = '', status = 'idle') {
    ctx._viewEpoch++; ctx._ref = 'ref-' + id; ctx._sessionId = 'archive-' + id; ctx._draftKey = 'archive-' + id;
    ctx._sessionOptions = { projectId: 'project-' + id }; ctx._localQueue = []; ctx._activeCollabTaskId = '';
    ctx._snap = { status, messages: [{ role: 'user', text: id + ' history' }] }; input.value = text;
    ctx._retryDraft = null;
    return ctx._snap;
  }
  return { ctx, input, bridge, requests, notices, added, plugins, switchTo, paints: () => paints };
}

test('a deleted local model blocks sending and preserves the draft until a valid model is explicitly selected', async () => {
  const f = fixture(); f.input.value = 'Keep this original draft';
  f.ctx._snap.modelSelection = { name: 'local:deleted', model: {
    id: 'local:deleted', label: '原本地模型已删除或不可用', unavailable: true, historicalLocal: true,
  } };
  assert.equal(await f.ctx._sendCore(), false);
  assert.equal(f.requests.length, 0);
  assert.equal(f.input.value, 'Keep this original draft');
  assert.match(JSON.stringify(f.ctx._snap), /主动选择可用模型/);
  f.ctx._snap.modelSelection = { name: 'valid-model', model: { id: 'valid-model' } };
  assert.equal(await f.ctx._sendCore(), true);
  assert.equal(f.requests.length, 1);
});

test('folded original request reaches plugin inference, send and failure receipt intact', async () => {
  const original = '  #1 原始要求\r\n' + '按原文执行，不解析为另一个需求。'.repeat(130) + '\n\n';
  const suffix = '追加约束  ';
  for (const accepted of [true, false]) {
    const f = fixture({ send: async () => ({ ok: accepted, reason: 'fixture rejection' }) });
    f.input.value = suffix;
    f.ctx._messageAttachments.submissionText = text => original + text;
    let inferred;
    f.ctx._pluginMention.selected = () => [{ pluginId: 'workflow' }];
    f.ctx._pluginMention.resolve = async (_chat, _project, text) => {
      inferred = text;
      return { text: text + '\n\n插件参数：验证=true', items: [{ pluginId: 'workflow', inputValues: { goal: text } }] };
    };
    assert.equal(await f.ctx._sendCore(), accepted);
    assert.equal(inferred, original + suffix);
    assert.equal(f.requests[0][1], original + suffix + '\n\n插件参数：验证=true');
    assert.equal(f.requests[0][3].plugins[0].inputValues.goal, original + suffix);
    const draft = accepted ? [...f.ctx._submissionDrafts.values()][0]
      : f.ctx._failedConversationDrafts.get('archive-a').draft;
    assert.equal(draft.text, original + suffix, 'recovery retains the original request, not appended plugin parameters');
  }
});

test('folded composer text takes precedence over a task fallback and is not concatenated into direct initial sends', async () => {
  const f = fixture();
  const original = '原始正文'.repeat(400) + ' FINAL';
  f.ctx._messageAttachments.submissionText = text => original + text;
  assert.equal(await f.ctx._sendCore('任务兜底', { useComposer: true, taskId: 'todo' }), true);
  assert.equal(f.requests[0][1], original);
  assert.equal(await f.ctx._sendCore(original), true);
  assert.equal(f.requests[1][1], original);
});

test('annotation-only submissions retain an empty composer draft instead of the generated annotation payload', async () => {
  const f = fixture();
  f.ctx.ChatWorkbenchAnnotations = {format: () => 'Generated annotation instructions'};
  f.input.value = '';
  assert.equal(await f.ctx._sendCore(undefined, {annotationBatch: {notes: [{text: 'Adjust the page'}]}}), true);
  assert.equal(f.requests[0][1], 'Generated annotation instructions');
  assert.equal([...f.ctx._submissionDrafts.values()][0].text, '');
});

test('收到的未发送需求使用完整任务准备，不误标为后续追问', async () => {
  const f=fixture(); f.ctx._activeCollabTaskId='todo';
  f.ctx._collabTasks=new Map([['todo',{task:{id:'todo',status:'todo',note:'完整需求'},nativeTurn:false}]]);
  f.input.value='请开始';
  assert.equal(await f.ctx._sendCore(),true);
  assert.equal(f.requests[0][3].taskExecution.followUp,false);
});

test('从会话释放的需求不再被普通消息隐式执行', async () => {
  const f=fixture(); f.ctx._activeCollabTaskId='released';
  f.ctx._collabTasks=new Map([['released',{task:{id:'released',status:'todo',note:'旧需求'},queueRemoved:true}]]);
  f.input.value='另一件事';
  assert.equal(await f.ctx._sendCore(),true);
  assert.equal(f.requests[0][3].taskId,'');
  assert.equal(f.requests[0][3].taskExecution,undefined);
});

test('会话打开被拒绝后保留输入与附件，禁止误建新会话或向旧句柄发送', async () => {
  for (const fresh of [true, false]) {
    const f = fixture({fresh}); let opens = 0, cleared = 0;
    f.ctx._snap = {status:'unreachable', openBlocked:true, messages:[]};
    f.input.value = '只能发给原会话的修订';
    f.ctx._messageAttachments.clear = () => {cleared++;};
    f.ctx._ensure = async () => {opens++; f.ctx._ref = 'accidental-new-ref'; return true;};
    assert.equal(await f.ctx._sendCore(), false);
    assert.equal(opens, 0);
    assert.equal(f.requests.length, 0);
    assert.equal(cleared, 0);
    assert.equal(f.input.value, '只能发给原会话的修订');
    assert.equal(f.ctx._snap.openBlocked, true);
  }
});

test('首次通过输入框发送需求失败后仍保留任务归属和完整准备语义', async () => {
  const f=fixture({send:async()=>({ok:false,reason:'隔离失败'})});
  f.ctx._activeCollabTaskId='todo';
  f.ctx._collabTasks=new Map([['todo',{task:{id:'todo',status:'todo',note:'完整需求'}}]]);
  f.input.value='请开始';
  assert.equal(await f.ctx._sendCore(),false);
  const draft=f.ctx._failedConversationDrafts.get('archive-a').draft;
  assert.equal(draft.requirement.taskId,'todo');
  assert.equal(draft.requirement.taskExecution.followUp,false);
});

test('从新会话切换到底座后，首条消息仍携带创建页选择的附件', async () => {
  const refs = [{ name: '人才盘点封面.png', type: 'image/png', data: new Uint8Array([1, 2, 3]) }];
  const f = fixture({ fresh: true, attachments: Promise.resolve(refs) });
  f.ctx._ensure = async () => { f.ctx._ref = 'new-runner-ref'; return true; };
  assert.equal(await f.ctx._sendCore('分析下', { useComposer: false, attachments: refs }), true);
  assert.deepEqual(f.requests[0][2], refs);
});

test('发送需求按钮失败后从输入框重发仍准备完整需求材料', async () => {
  const f=fixture(); f.ctx._activeCollabTaskId='todo';
  f.ctx._collabTasks=new Map([['todo',{task:{id:'todo',status:'todo',note:'完整需求'},nativeTurn:true,queueState:'failed'}]]);
  f.input.value='重新开始';
  assert.equal(await f.ctx._sendCore(),true);
  assert.equal(f.requests[0][3].taskExecution.followUp,false);
});

test('发送需求按钮消费执行者本轮显式选择的插件和补充文字', async () => {
  const f=fixture(); f.input.value='执行者补充要求';
  f.ctx._pluginMention.selected=()=>[{pluginId:'chosen'}];
  f.ctx._pluginMention.resolve=async (_chat,_project,text)=>({items:[{pluginId:'chosen'}],text});
  assert.equal(await f.ctx._sendCore('需求原文',{taskId:'todo',useComposer:true}),true);
  assert.equal(f.requests[0][1],'执行者补充要求');
  assert.equal(f.requests[0][3].plugins[0].pluginId,'chosen');
});
for (const response of ['throw', 'rejected']) {
  test(`a late ${response} send belongs to A, preserves B, and restores A's complete draft on return`, async () => {
    const gate = deferred(), f = fixture({ send: () => gate.promise });
    f.input.value = '#skill-a original A';
    const pending = f.ctx._sendCore(null, { plugins: [{ pluginId: 'plugin-a' }] }); await flush();
    assert.equal(f.requests.length, 1);
    const snapshot = f.switchTo('b'), before = f.paints();
    if (response === 'throw') gate.reject(Error('fixture send failed'));
    else gate.resolve({ ok: false, reason: 'fixture send refused' });
    assert.equal(await pending, false);
    assert.equal(f.ctx._snap, snapshot); assert.equal(f.input.value, ''); assert.equal(f.ctx._retryDraft, null);
    assert.equal(f.paints(), before); assert.equal(f.added.length, 0);
    assert.equal(f.ctx._conversationDraftText('archive-a'), '#skill-a original A');
    f.switchTo('a'); f.ctx._restoreConversationDraft(); f.ctx._restoreRetainedConversationFailure();
    assert.equal(f.input.value, '#skill-a original A'); assert.equal(f.added[0][0][0].name, 'only-a.txt');
    assert.equal(f.plugins[0][0].pluginId, 'plugin-a'); assert.equal(f.requests.length, 1, 'recovery never resends automatically');
  });
}
test('A failure cannot overwrite A newer draft, and remains explicitly recoverable after clearing it', async () => {
  const gate = deferred(), f = fixture({ send: () => gate.promise, files: [] });
  const pending = f.ctx._sendCore('old A'); await flush();
  f.ctx._rememberConversationText('archive-a', 'new A draft'); f.switchTo('b');
  gate.reject(Error('fixture failure')); await pending;
  assert.equal(f.ctx._conversationDraftText('archive-a'), 'new A draft');
  f.switchTo('a'); f.ctx._restoreConversationDraft(); f.ctx._restoreRetainedConversationFailure();
  assert.equal(f.input.value, 'new A draft'); assert.equal(f.ctx._retryDraft.text, 'old A');
  f.input.value = ''; f.ctx._restoreRetryDraft(); assert.equal(f.input.value, 'old A');
});
test('restoring an unconfirmed send does not claim an executing native session stopped', async () => {
  const f = fixture({ files: [] }); f.ctx._retainFailedConversationDraft('archive-a', { text: 'uncertain A', files: [], plugins: [] }, 'lost receipt');
  const snapshot = f.switchTo('a', '', 'streaming'); f.ctx._restoreRetainedConversationFailure();
  assert.equal(f.ctx._snap, snapshot); assert.equal(f.input.value, 'uncertain A'); assert.equal(f.requests.length, 0);
  f.ctx._restoreRetryDraft(); assert.equal(f.ctx._snap, snapshot, 'manual recovery must not claim the live turn stopped');
});
test('an accepted retry clears its retained failure even if the user left before the receipt', async () => {
  const gate = deferred(), f = fixture({ send: () => gate.promise });
  f.ctx._retainFailedConversationDraft('archive-a', { text: 'retry A', files: [], plugins: [] }, 'old failure');
  const pending = f.ctx._sendCore('retry A'); await flush(); const snapshot = f.switchTo('b', 'B draft');
  gate.resolve({ ok: true, snapshot: { status: 'streaming' } }); assert.equal(await pending, true);
  assert.equal(f.ctx._snap, snapshot); assert.equal(f.input.value, 'B draft'); assert.equal(f.ctx._failedConversationDrafts.size, 0);
});
test('attachments preparing before a new session opens cannot send the old draft into a later conversation', async () => {
  const upload = deferred(), f = fixture({ fresh: true, attachments: upload.promise });
  f.input.value = 'new conversation A'; const pending = f.ctx._sendCore(); await flush();
  const snapshot = f.switchTo('b', 'B draft'); upload.resolve([{ id: 'attachment-a' }]);
  assert.equal(await pending, false); assert.equal(f.requests.length, 0); assert.equal(f.ctx._snap, snapshot);
  assert.equal(f.input.value, 'B draft'); assert.equal(f.ctx._conversationDraftText('new'), 'new conversation A');
});
test('a known background session keeps its original ref and project while attachments finish', async () => {
  const upload = deferred(), f = fixture({ attachments: upload.promise });
  f.input.value = 'A with attachment'; const pending = f.ctx._sendCore(); await flush();
  const snapshot = f.switchTo('b', 'B draft'); f.ctx._retryDraft = { text: 'B retry' };
  upload.resolve([{ id: 'attachment-a' }]); assert.equal(await pending, true);
  assert.equal(f.requests[0][0], 'ref-a'); assert.equal(f.requests[0][3].projectId, 'project-a');
  assert.equal(f.ctx._snap, snapshot); assert.equal(f.ctx._retryDraft.text, 'B retry'); assert.equal(f.input.value, 'B draft');
});
for (const waiting of ['attachments', 'prior-send']) {
  for (const taskId of ['', 'task-a']) {
    test(`a ${taskId ? 'task follow-up' : 'plain message'} retains its original task ownership while ${waiting} finish`, async () => {
      const gate = deferred(), f = fixture({ attachments: waiting === 'attachments' ? gate.promise : undefined });
      if (waiting === 'prior-send') f.ctx._submitTail = gate.promise;
      f.ctx._activeCollabTaskId = taskId;
      f.input.value = 'A original message'; const pending = f.ctx._sendCore(); await flush();
      assert.equal(f.requests.length, 0);
      const snapshot = f.switchTo('b', 'B unsent message'); f.ctx._activeCollabTaskId = 'task-b';
      gate.resolve([{ id: 'attachment-a' }]);
      assert.equal(await pending, true); assert.equal(f.requests.length, 1);
      const [ref, text, , options] = f.requests[0];
      assert.equal(ref, 'ref-a'); assert.equal(text, 'A original message');
      assert.equal(options.projectId, 'project-a'); assert.equal(options.taskId, taskId);
      if (taskId) {
        assert.equal(options.taskExecution.reuseConversation, true);
        assert.equal(options.taskExecution.followUp, true);
      } else assert.equal(options.taskExecution, undefined);
      assert.equal(f.ctx._snap, snapshot); assert.equal(f.input.value, 'B unsent message');
      assert.equal(f.ctx._activeCollabTaskId, 'task-b');
    });
  }
}
test('current conversation failures still show the reason and restore input', async () => {
  const f = fixture({ send: async () => { throw Error('fixture rejected'); }, files: [] });
  assert.equal(await f.ctx._sendCore('current A'), false);
  assert.equal(f.ctx._snap.status, 'unreachable'); assert.match(f.ctx._snap.statusText, /fixture rejected/);
  assert.equal(f.input.value, 'current A');
});
test('an earlier accepted send cannot erase a newer attachment failure with identical text', async () => {
  const gate = deferred(), f = fixture({ send: () => gate.promise });
  f.input.value = 'identical text'; const first = f.ctx._sendCore(); await flush();
  f.ctx._messageAttachments.refs = async () => { throw Error('second attachment failed'); };
  f.input.value = 'identical text'; assert.equal(await f.ctx._sendCore(), false);
  const retained = f.ctx._failedConversationDrafts.get('archive-a');
  assert.match(retained.reason, /second attachment/);
  gate.resolve({ ok: true }); assert.equal(await first, true);
  assert.equal(f.ctx._failedConversationDrafts.get('archive-a'), retained);
});
test('navigation during work-action routing cannot resume the old send in another conversation', async () => {
  const route = deferred(), f = fixture();
  f.ctx.global.ChatWorkActions = f.ctx.ChatWorkActions = { route: () => route.promise };
  Object.assign(f.ctx, { _openWorkAction() {}, _workModel() {}, _workConversationContext() {} });
  f.input.value = 'A routing'; const pending = f.ctx._sendCore(); await flush();
  const snapshot = f.switchTo('b', 'B draft'); route.resolve({ handled: false });
  assert.equal(await pending, false); assert.equal(f.requests.length, 0);
  assert.equal(f.input.value, 'B draft'); assert.equal(f.ctx._snap, snapshot);
});
test('late plugin resolution errors cannot disclose the old conversation error in the new view', async () => {
  const resolve = deferred(), f = fixture();
  f.ctx._pluginMention.selected = () => [{ pluginId: 'a' }]; f.ctx._pluginMention.resolve = () => resolve.promise;
  f.input.value = 'A plugin'; const pending = f.ctx._sendCore(); await flush();
  const snapshot = f.switchTo('b', 'B draft'); resolve.reject(Error('Only A private plugin error'));
  assert.equal(await pending, false); assert.equal(f.notices.length, 0); assert.equal(f.ctx._snap, snapshot);
});
test('a cancelled queue receipt cannot mutate a new view while its native cancellation settles', async () => {
  const send = deferred(), cancel = deferred(), f = fixture({ send: () => send.promise });
  f.ctx._snap.status = 'streaming'; f.bridge.cancelQueued = () => cancel.promise;
  f.input.value = 'queued A'; const pending = f.ctx._sendCore(); await flush();
  f.ctx._localQueue[0].cancelled = true; send.resolve({ ok: true, queueId: 'queue-a' }); await flush();
  const snapshot = f.switchTo('b', 'B draft'); cancel.resolve({ ok: true });
  assert.equal(await pending, false); assert.equal(f.ctx._snap, snapshot); assert.equal(f.input.value, 'B draft');
  assert.equal(f.ctx._taskAttachments.length, 0);
});
for (const result of ['throw', 'accepted']) {
  test(`identity invalidation clears only this window's draft cache and ignores a late ${result} receipt`, async () => {
    const gate = deferred(), f = fixture({ send: () => gate.promise }), stored = new Map([['unrelated', 'keep']]);
    f.ctx._draftStorageKey = 'soduwork.conversation-drafts.v1';
    f.ctx.global.sessionStorage = { removeItem: key => stored.delete(key), setItem: (key, value) => stored.set(key, value) };
    f.ctx._rememberConversationText('archive-old', 'old private draft'); f.ctx._flushConversationDrafts();
    f.input.value = 'A private send'; const pending = f.ctx._sendCore(); await flush();
    f.ctx._clearConversationDraftScope();
    assert.equal(f.ctx._conversationDrafts.size, 0); assert.equal(f.ctx._failedConversationDrafts.size, 0);
    assert.equal(f.ctx._retryDraft, null); assert.equal(f.input.value, '');
    assert.equal(stored.has('soduwork.conversation-drafts.v1'), false); assert.equal(stored.get('unrelated'), 'keep');
    const snapshot = f.switchTo('b', 'B draft');
    if (result === 'throw') gate.reject(Error('A private failure')); else gate.resolve({ ok: true });
    assert.equal(await pending, false); assert.equal(f.ctx._snap, snapshot); assert.equal(f.input.value, 'B draft');
    assert.equal(f.ctx._conversationDrafts.size, 0); assert.equal(f.ctx._failedConversationDrafts.size, 0);
  });
}
test('an environment change while attachments prepare cannot send using the previous identity', async () => {
  const upload = deferred(), f = fixture({ attachments: upload.promise }); let ownerScope = 'hub-a/user-a';
  f.ctx.global.SoduWorkAPI = { taskStorageKey: () => ownerScope };
  f.input.value = 'A draft'; const pending = f.ctx._sendCore(); await flush();
  ownerScope = 'hub-b/user-a'; upload.resolve([]);
  assert.equal(await pending, false); assert.equal(f.requests.length, 0); assert.equal(f.ctx._failedConversationDrafts.size, 0);
});
test('explicitly clearing a conversation draft also dismisses its retained failure', () => {
  const f = fixture(); f.ctx._retainFailedConversationDraft('archive-a', { text: 'old', files: [], plugins: [] }, 'old failure');
  f.ctx._clearConversationDraft('archive-a'); assert.equal(f.ctx._failedConversationDrafts.size, 0);
  assert.match(source, /addEventListener\('soduwork-data-scope-changed', _clearConversationDraftScope\)/);
});

for (const timedOut of [false, true]) {
  test(`obsolete conversation open ${timedOut ? 'timeout' : 'rejection'} cannot replace the active conversation`, async () => {
    const opened = deferred(), deadline = deferred(), released = [], failures = [];
    const ctx = { _viewEpoch: 1, _sessionOptions: {}, _api: () => ({ open: () => opened.promise, release: ref => released.push(ref) }),
      _awaitBounded: promise => timedOut ? deadline.promise : promise, OPEN_TIMEOUT_MS: 30000,
      _fail: (...args) => failures.push(args), Promise, global: {} };
    ctx.ctx = ctx;
    vm.createContext(ctx); vm.runInContext(section('  async function _ensureOnce(', '  async function _send('), ctx);
    const pending = ctx._ensureOnce('archive-a', 1); await flush(); ctx._viewEpoch++;
    if (timedOut) deadline.reject(Object.assign(Error('open timed out'), { code: 'SODUWORK_OPEN_TIMEOUT' }));
    else opened.reject(Error('open failed'));
    assert.equal(await pending, false); assert.deepEqual(failures, []);
    if (timedOut) {
      opened.resolve({ ok: true, ref: 'late-ref-a' }); await flush(); assert.deepEqual(released, ['late-ref-a']);
    }
  });
}

function requirementRecovery(f, { task, snapshot } = {}) {
  const starts = [];
  f.ctx._collabTasks = new Map([['req-a', { taskId: 'req-a', nativeTurn: true, queueState: 'failed' }]]);
  f.ctx.global.SoduWorkAPI = { taskStorageKey: () => '', getTask: async () => task || { id: 'req-a', title: 'Requirement A', status: 'todo' } };
  f.bridge.snapshot = async () => ({ ok: true, snapshot: snapshot || { status: 'idle', messages: [] } });
  f.ctx._startTask = async (item, options) => { starts.push({ item, options }); return true; };
  return starts;
}
const requirementOptions = () => ({ taskId: 'req-a', taskTitle: 'Requirement A',
  taskExecution: { reuseConversation: true, agentId: 'local:pi', model: 'same-model', repo: { id: 'repo-a' } } });

for (const failure of ['rejected', 'transport']) {
  test(`a ${failure} requirement send retains its identity and never becomes ordinary composer input`, async () => {
    const f = fixture({ send: async () => {
      if (failure === 'transport') throw Error('IPC receipt lost');
      return { ok: false, reason: 'not prepared' };
    } });
    const options = requirementOptions(); f.input.value = 'my next ordinary message';
    assert.equal(await f.ctx._sendCore('requirement instruction', options), false);
    assert.equal(f.input.value, 'my next ordinary message');
    assert.equal(f.ctx._conversationDraftText('archive-a'), '');
    const draft = f.ctx._retryDraft, id = f.requests[0][3].submissionId;
    assert.equal(draft.requirement.taskId, 'req-a');
    assert.equal(draft.requirement.submissionId, id);
    assert.equal(draft.requirement.deliveryState, failure === 'transport' ? 'uncertain' : 'rejected');
    options.taskExecution.repo.id = 'changed';
    assert.equal(draft.requirement.taskExecution.repo.id, 'repo-a', 'execution settings were captured, not aliased');
    const starts = requirementRecovery(f);
    assert.equal(await f.ctx._restoreRetryDraft(), true);
    assert.equal(starts.length, 1); assert.equal(starts[0].item.id, 'req-a');
    assert.equal(starts[0].options.taskExecution.reuseConversation, true);
    assert.equal(starts[0].options.instruction, 'requirement instruction');
    assert.equal(starts[0].options.submissionId, failure === 'transport' ? id : '');
    assert.equal(starts[0].options.retry, failure !== 'transport');
    assert.equal(f.input.value, 'my next ordinary message');
    assert.equal(f.ctx._retryDraft, null); assert.equal(f.ctx._failedConversationDrafts.size, 0);
  });
}

test('accepted requirement submission metadata retains its scoped identity for later retry-safe events', async () => {
  const f = fixture();
  assert.equal(await f.ctx._sendCore('instruction', requirementOptions()), true);
  const id = f.requests[0][3].submissionId, draft = f.ctx._submissionDrafts.get(id);
  assert.equal(draft.requirement.taskId, 'req-a'); assert.equal(draft.requirement.conversationId, 'archive-a');
  assert.equal(draft.requirement.taskExecution.reuseConversation, true);
  assert.match(require('./renderer-source.cjs').readFileSync(
    path.join(__dirname, '../components/panels/panels-chat.js'), 'utf8'),
  /canRestore \|\| submittedDraft\?\.requirement/);
});

test('returning to A restores a failed requirement as an action while preserving its unsent ordinary draft', async () => {
  const gate = deferred(), f = fixture({ send: () => gate.promise });
  const pending = f.ctx._sendCore('requirement instruction', requirementOptions()); await flush();
  f.ctx._rememberConversationText('archive-a', 'A unrelated draft');
  const snapshot = f.switchTo('b', 'B unrelated draft'); gate.reject(Error('lost receipt')); await pending;
  assert.equal(f.ctx._snap, snapshot); assert.equal(f.input.value, 'B unrelated draft');
  assert.equal(f.ctx._failedConversationDrafts.get('archive-a').draft.requirement.conversationId, 'archive-a');
  f.switchTo('a'); f.ctx._restoreConversationDraft(); f.ctx._restoreRetainedConversationFailure();
  assert.equal(f.input.value, 'A unrelated draft'); assert.equal(f.ctx._retryDraft.requirement.taskId, 'req-a');
  assert.equal(f.requests.length, 1, 'reopening never resends');
});

test('sending ordinary text identical to a failed requirement cannot discard the requirement recovery', async () => {
  let first = true;
  const f = fixture({ send: async () => { if (first) { first = false; throw Error('lost receipt'); } return { ok: true }; } });
  await f.ctx._sendCore('same words', requirementOptions());
  const retained = f.ctx._failedConversationDrafts.get('archive-a');
  f.input.value = 'same words'; assert.equal(await f.ctx._sendCore(), true);
  assert.equal(f.ctx._failedConversationDrafts.get('archive-a'), retained);
  assert.equal(f.requests[1][3].taskId, '', 'the new ordinary message remains ordinary');
});

for (const change of ['session', 'account', 'scope-reset']) {
  test(`a ${change} change during requirement recovery prevents any resend or stale UI change`, async () => {
    const f = fixture({ send: async () => { throw Error('lost receipt'); } });
    await f.ctx._sendCore('private requirement', requirementOptions());
    const starts = requirementRecovery(f), lookup = deferred();
    let owner = '';
    f.ctx.global.SoduWorkAPI.getTask = () => lookup.promise;
    f.ctx.global.SoduWorkAPI.taskStorageKey = () => owner;
    const pending = f.ctx._restoreRetryDraft(); await flush();
    if (change === 'session') f.switchTo('b', 'B draft');
    else if (change === 'account') owner = 'other-account';
    else f.ctx._clearConversationDraftScope();
    const snapshot = f.ctx._snap, before = f.paints();
    lookup.resolve({ id: 'req-a', status: 'todo' });
    assert.equal(await pending, false); assert.equal(starts.length, 0); assert.equal(f.ctx._snap, snapshot);
    assert.equal(f.paints(), before); assert.equal(f.notices.length, 0);
  });
}

test('a failed requirement from another account is neither displayed nor restored', async () => {
  const f = fixture({ send: async () => ({ ok: false }) });
  await f.ctx._sendCore('private requirement', requirementOptions());
  f.switchTo('a'); f.ctx.global.SoduWorkAPI = { taskStorageKey: () => 'other-account' };
  const snapshot = f.ctx._snap;
  f.ctx._restoreRetainedConversationFailure();
  assert.equal(f.ctx._snap, snapshot); assert.equal(f.ctx._retryDraft, null); assert.equal(f.input.value, '');
});

for (const state of ['queued', 'running', 'completed']) {
  test(`a lost requirement receipt already ${state} is reconciled without another send`, async () => {
    const f = fixture({ send: async () => { throw Error('lost receipt'); } });
    await f.ctx._sendCore('instruction', requirementOptions());
    const id = f.requests[0][3].submissionId;
    const snapshot = { status: state === 'running' ? 'streaming' : 'idle', messages: [], execution: {
      queue: state === 'queued' ? [{ taskId: 'req-a', submissionId: id }] : [],
      turnQueue: state === 'running' ? { activeTaskId: 'req-a', activeSubmissionId: id } : {},
    } };
    const starts = requirementRecovery(f, { snapshot, task: { id: 'req-a', status: 'doing',
      workRouting: { conversationTurn: { conversationId: 'archive-a', turnId: id, state } } } });
    assert.equal(await f.ctx._restoreRetryDraft(), true);
    assert.equal(starts.length, 0); assert.equal(f.ctx._snap, snapshot); assert.equal(f.ctx._retryDraft, null);
    assert.equal(f.ctx._failedConversationDrafts.size, 0);
  });
}

for (const status of ['idle', 'aborted', 'unreachable']) {
  for (const receiptState of ['queued', 'running', 'waiting']) {
    test(`a ${status} restored runtime checks the stale native ${receiptState} receipt in the main process`, async () => {
      const f = fixture({ send: async () => ({ ok: false, reason: 'duplicate active receipt' }) });
      await f.ctx._sendCore('continue the existing work', requirementOptions());
      const snapshot = { status, messages: [], execution: { turnQueue: {}, queue: [] } };
      const starts = requirementRecovery(f, { snapshot, task: { id: 'req-a', status: 'doing', workRouting: {
        conversationTurn: { executor: 'native', conversationId: 'archive-a', turnId: 'before-restart', state: receiptState },
      } } });
      assert.equal(await f.ctx._restoreRetryDraft(), true);
      assert.equal(starts.length, 1, 'the native main process must verify the prior execution instead of trusting a stale Hub state');
      assert.equal(starts[0].options.taskExecution.reuseConversation, true);
      assert.equal(starts[0].options.taskExecution.followUp, true);
      assert.equal(starts[0].options.instruction, 'continue the existing work');
      assert.equal(f.ctx._retryDraft, null);
    });
  }
}

test('restored rework recovery retains rework context and uses the saved receipt selection', async () => {
  const f = fixture({ send: async () => ({ ok: false, reason: 'duplicate active receipt' }) });
  await f.ctx._sendCore('finish the playable result', { ...requirementOptions(), taskExecution: {
    reuseConversation: true, reworkSession: true, followUp: false, executionChoice: 'native', submissionMode: 'manual',
  } });
  const starts = requirementRecovery(f, { task: { id: 'req-a', status: 'doing', workRouting: {
    conversationTurn: { executor: 'native', conversationId: 'archive-a', turnId: 'rework-before-restart', state: 'running' },
  } } });
  assert.equal(await f.ctx._restoreRetryDraft(), true);
  assert.equal(starts.length, 1);
  assert.equal(starts[0].options.taskExecution.reuseConversation, true);
  assert.equal(starts[0].options.taskExecution.reworkSession, true);
  assert.equal(starts[0].options.taskExecution.followUp, false);
  assert.equal(starts[0].options.taskExecution.submissionMode, 'manual');
  assert.equal(starts[0].options.taskExecution.executionChoice, undefined);
});

for (const activity of ['streaming', 'queued', 'execution-running', 'permission', 'pending-ui']) {
  test(`an existing ${activity} native execution is never duplicated by requirement recovery`, async () => {
    const f = fixture({ send: async () => ({ ok: false, reason: 'duplicate active receipt' }) });
    await f.ctx._sendCore('continue existing work', requirementOptions());
    const snapshot = { status: 'idle', messages: [], execution: {} };
    if (activity === 'streaming' || activity === 'queued') snapshot.status = activity;
    if (activity === 'execution-running') snapshot.execution.running = true;
    if (activity === 'permission') snapshot.pendingPermissions = [{ requestId: 'request-a' }];
    if (activity === 'pending-ui') snapshot.pendingUi = { method: 'permission' };
    const starts = requirementRecovery(f, { snapshot, task: { id: 'req-a', status: 'doing', workRouting: {
      conversationTurn: { executor: 'native', conversationId: 'archive-a', turnId: 'before-restart', state: 'running' },
    } } });
    assert.equal(await f.ctx._restoreRetryDraft(), true);
    assert.equal(starts.length, 0);
    assert.equal(f.ctx._retryDraft, null);
    assert.equal(f.ctx._failedConversationDrafts.size, 0);
  });
}

for (const outcome of ['refused', 'rpc-failed']) {
  test(`a restored native recovery ${outcome} keeps the original requirement draft`, async () => {
    const f = fixture({ send: async () => ({ ok: false, reason: 'duplicate active receipt' }) });
    await f.ctx._sendCore('continue existing work', requirementOptions());
    const starts = requirementRecovery(f, { task: { id: 'req-a', status: 'doing', workRouting: {
      conversationTurn: { executor: 'native', conversationId: 'archive-a', turnId: 'before-restart', state: 'running' },
    } } });
    const draft = f.ctx._retryDraft;
    f.ctx._startTask = async (...args) => {
      starts.push(args);
      if (outcome === 'rpc-failed') throw Error('Runner terminal confirmation unavailable');
      return false;
    };
    assert.equal(await f.ctx._restoreRetryDraft(), false);
    assert.equal(starts.length, 1);
    assert.equal(f.ctx._retryDraft, draft);
    assert.equal(f.ctx._failedConversationDrafts.get('archive-a').draft, draft);
  });
}

test('an exact failed requirement receipt permits a new attempt after an uncertain transport failure', async () => {
  const f = fixture({ send: async () => { throw Error('lost receipt'); } });
  await f.ctx._sendCore('instruction', requirementOptions());
  const starts = requirementRecovery(f, { task: { id: 'req-a', status: 'doing', workRouting: {
    conversationTurn: { conversationId: 'archive-a', turnId: f.requests[0][3].submissionId, state: 'failed' },
  } } });
  assert.equal(await f.ctx._restoreRetryDraft(), true);
  assert.equal(starts[0].options.retry, true); assert.equal(starts[0].options.submissionId, '');
});

test('unconfirmed requirement recovery is idempotent with the real native queue and retains the original submission id', async () => {
  const { createTurnQueue } = require('../main/pi-session/turn-queue');
  const queue = createTurnQueue(); let loseReceipt = true;
  const f = fixture({ send: async (ref, text, attachments, options) => {
    const item = queue.add({ text, attachments, options });
    if (loseReceipt) { loseReceipt = false; throw Error('IPC receipt lost after enqueue'); }
    return { ok: true, queueId: item.id };
  } });
  await f.ctx._sendCore('instruction', requirementOptions());
  const original = f.requests[0][3].submissionId;
  const lookup = deferred(); requirementRecovery(f);
  f.ctx.global.SoduWorkAPI.getTask = () => lookup.promise;
  f.ctx._startTask = (item, opts) => f.ctx._sendCore(opts.instruction, {
    taskId: item.id, taskExecution: opts.taskExecution, retry: opts.retry, submissionId: opts.submissionId,
  });
  // Simulate a snapshot arriving before the send's queue acknowledgement.
  const pending = f.ctx._restoreRetryDraft();
  assert.equal(await f.ctx._restoreRetryDraft(), false, 'double-click cannot create a second concurrent recovery');
  lookup.resolve({ id: 'req-a', status: 'todo' });
  assert.equal(await pending, true);
  assert.equal(f.requests.length, 2); assert.equal(f.requests[1][3].submissionId, original);
  assert.equal(f.requests[1][3].retry, false); assert.equal(queue.size(), 1);
  assert.equal(f.requests[1][3].taskExecution.reuseConversation, true);
});

for (const unavailable of ['unauthorized', 'snapshot-failed', 'other-conversation']) {
  test(`requirement recovery is fail-closed when ${unavailable}`, async () => {
    const f = fixture({ send: async () => { throw Error('lost receipt'); } });
    await f.ctx._sendCore('instruction', requirementOptions());
    const task = { id: 'req-a', status: 'todo' };
    if (unavailable === 'unauthorized') task.canViewExecution = false;
    if (unavailable === 'other-conversation') task.workRouting = { conversationTurn: {
      state: 'queued', conversationId: 'archive-b', turnId: 'other-attempt',
    } };
    const starts = requirementRecovery(f, { task });
    if (unavailable === 'snapshot-failed') f.bridge.snapshot = async () => ({ ok: false });
    const retained = f.ctx._retryDraft;
    assert.equal(await f.ctx._restoreRetryDraft(), false); assert.equal(starts.length, 0);
    assert.equal(f.ctx._retryDraft, retained); assert.equal(f.input.value, ''); assert.equal(f.notices.length, 1);
  });
}

test('sending consumes plugin chips before the receipt without clearing session capabilities or later picks', async () => {
  const gate = deferred(), f = fixture({ send: () => gate.promise });
  let picks = [{ pluginId: 'plugin-a', name: 'Meeting' }];
  f.ctx._pluginMention = {
    selected: () => picks.slice(),
    resolve: async (_ref, _project, text) => ({ text, items: picks.slice() }),
    consume: rows => { picks = picks.filter(item => !rows.some(row => row.pluginId === item.pluginId)); },
  };
  f.input.value = 'first meeting query';
  const sending = f.ctx._sendCore(); await flush();
  assert.deepEqual(picks, [], 'sent chip disappears while the native receipt is still pending');
  assert.equal(f.input.value, '');
  assert.equal(f.requests[0][3].plugins[0].pluginId, 'plugin-a');
  assert.notEqual(f.requests[0][3].clearPluginSelection, true, 'draft consumption must not revoke session plugins');
  picks = [{ pluginId: 'plugin-b' }]; gate.resolve({ ok: true });
  assert.equal(await sending, true);
  assert.equal(picks[0].pluginId, 'plugin-b', 'late receipt preserves the next draft selection');
  picks = []; f.input.value = 'another meeting query';
  assert.equal(await f.ctx._sendCore(), true);
  assert.equal(f.requests[1][3].plugins.length, 0, 'runtime inherits session plugins without composer refilling');
});

test('failed plugin sends restore the consumed plugin draft and resolved parameters for an explicit retry', async () => {
  const f = fixture({ send: async () => ({ ok: false, reason: 'fixture failure' }) });
  let picks = [{ pluginId: 'plugin-a', name: 'Meeting' }];
  let inputValues = {};
  f.ctx._pluginMention = {
    selected: () => picks.slice(),
    resolve: async (_ref, _project, text) => { inputValues = { roomId: 'room-123' }; return { text, items: picks.slice() }; },
    draft: () => picks.map(item => ({ ...item, inputValues: { ...inputValues } })),
    consume: () => { picks = []; inputValues = {}; },
    restore: rows => { picks = rows; },
  };
  f.input.value = 'meeting query';
  assert.equal(await f.ctx._sendCore(), false);
  assert.equal(f.input.value, 'meeting query');
  assert.equal(picks[0].pluginId, 'plugin-a');
  assert.equal(picks[0].inputValues.roomId, 'room-123', 'parameters resolved during send remain available for retry');
  assert.equal(f.requests[0][3].plugins[0].inputValues, undefined, 'private draft metadata is not part of plugin selection IPC');
});

/*
 * Task messages may be rewritten with requirement or rework context. Remove optimistic
 * bubbles once sending is accepted even when transcript text differs, preventing permanent
 * ghost turns.
 */
test('an accepted task send releases the optimistic bubble even when the echo text was rewritten', async () => {
  const gate = deferred();
  const f = fixture({ send: () => gate.promise });
  f.ctx._activeCollabTaskId = 'task-a';
  f.input.value = '调整';
  const pending = f.ctx._sendCore(null, {});
  await flush();
  assert.equal(f.ctx._pending, '调整', 'while the send is in flight the optimistic bubble is up');
  const options = f.requests[0][3];
  assert.equal(options.taskId, 'task-a', 'composer follow-up binds the active collaboration task');
  assert.equal(options.taskExecution && options.taskExecution.followUp, true);
  assert.equal(options.taskExecution && options.taskExecution.reuseConversation, true);
  gate.resolve({ ok: true });
  assert.equal(await pending, true);
  assert.equal(f.ctx._pending, '', 'accepted task send must not keep a bubble the transcript can never confirm');
  assert.equal(Array.isArray(f.ctx._pendingPlugins) && f.ctx._pendingPlugins.length, 0);
  assert.equal(f.ctx._pendingAttachmentNames.length, 0);
});

test('an ordinary send records its submission identity beside the optimistic baseline', async () => {
  const gate = deferred();
  const f = fixture({ send: () => gate.promise });
  f.input.value = 'stable echo identity';
  const pending = f.ctx._sendCore();
  await flush();
  assert.match(String(f.ctx._pendingBaseline?.submissionId || ''), /^ui-/);
  gate.resolve({ ok: true });
  assert.equal(await pending, true);
});

test('a cloud ACK retains the submitted bubble while its transcript echo is delayed', async () => {
  const gate = deferred(), f = fixture({ send: () => gate.promise });
  f.ctx._activeCollabTaskId = 'cloud-task';
  f.ctx._snap = { status: 'idle', messages: [], tools: [], cloudHandoff: { phase: 'committed' } };
  f.input.value = 'Cloud continuation awaiting echo';
  const pending = f.ctx._sendCore();
  await flush();
  assert.equal(f.requests[0][3].taskId, 'cloud-task');
  gate.resolve({ ok: true, snapshot: f.ctx._snap });
  assert.equal(await pending, true);
  assert.equal(f.ctx._pending, 'Cloud continuation awaiting echo');
  assert.ok(f.ctx._pendingBaseline.submissionId);
  assert.equal(f.input.value, '', 'the acknowledged message is not restored as an unsent draft');
});

test('an app turn forwards its explicit attachment references without consuming the native composer draft', async () => {
  const f = fixture(), refs = [{name:'app-reference.pdf',path:'fixture-app.pdf',size:12,sourceRef:'fixture-app-input'}];
  f.input.value = 'Keep native composer text';
  assert.equal(await f.ctx._sendCore('App task',{useComposer:false,attachments:refs}),true);
  assert.equal(f.requests.length,1);
  assert.equal(f.requests[0][1],'App task');
  assert.deepEqual(f.requests[0][2],refs);
  assert.equal(f.input.value,'Keep native composer text');
  assert.equal(f.added.length,0);
});
