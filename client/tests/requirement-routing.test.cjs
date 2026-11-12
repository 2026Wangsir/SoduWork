'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('./renderer-source.cjs'), path = require('node:path'), vm = require('node:vm');
const directory = path.join(__dirname, '../components/panels');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const flush = () => new Promise(resolve => setImmediate(resolve));
const mate = { id: 'gao', name: '高示例成员', org: '研发', hasBox: true };
const flow = { bindingId: 'bug-binding', key: 'bug-trial', name: 'Bug修复·上线trial', runnable: true,
  workflow: { nodes: [{ type: 'ai', route: { agentSource: 'plugin', agentKind: 'local:codex' } }] } };
const options = { substrates: [{ key: 'local:codex', name: 'Codex', available: true }], workflows: [flow], repos: [] };
const explicit = name => ({ assignee: name, assigneeExplicit: true, assigneeSource: 'instruction' });
function fixture({ parsed = {}, mates = { mates: [mate] }, execution = options } = {}) {
  const fields = new Map(), handlers = {}, calls = [], alerts = [], checks = [], serverEvents = []; let html = '';
  const decode = s => String(s || '').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const node = value => ({ value, disabled: false, attributes: new Map(), listeners:{},
    addEventListener(type,fn) { this.listeners[type]=fn; },
    setAttribute(name, next) { this.attributes.set(name, String(next)); },
    getAttribute(name) { return this.attributes.get(name) ?? null; },
    removeAttribute(name) { this.attributes.delete(name); }, focus() { this.focused = true; },
    replaceChildren(...options) { this.options=options; } });
  const box = { classList: { add() {}, remove() {} }, addEventListener: (type, fn) => { handlers[type] = fn; },
    querySelector: s => fields.get(s === '[data-rq-project-select]' ? 'cpProjectId' : s.replace(/^#/, '')) || null,
    querySelectorAll: s => s === '[data-rq-tag-editor]' ? [{querySelector: child =>
      child === '[data-rq-tag-value]' ? fields.get('cpTags') :
      child === '[data-rq-tag-input]' ? fields.get('cpTagsInput') : {hidden: true}}] : Array.from(fields.values()),
    get innerHTML() { return html; }, set innerHTML(value) {
      html = value; fields.clear(); checks.length = 0;
      for (const m of value.matchAll(/<input\b([^>]*)>|<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/g)) {
        const attrs = m[1] ?? m[2], id = /\bid="([^"]+)"/.exec(attrs)?.[1];
        const el = node(decode(m[2] === undefined ? /\bvalue="([^"]*)"/.exec(attrs)?.[1] : m[3]));
        if (id) fields.set(id, el); if (/\bclass="cp-ck-t"/.test(attrs)) checks.push(el);
      }
      for (const m of value.matchAll(/<select\b[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
        const selected = /<option value="([^"]+)" selected/.exec(m[2]) || /<option value="([^"]+)"/.exec(m[2]);
        fields.set(m[1], node(selected?.[1] || ''));
      }
      for (const id of ['cpCreate', 'cpCancel', 'cpCheck']) if (value.includes('id="' + id + '"')) fields.set(id, node(''));
    } };
  const ctx = { window: null, console, setTimeout, clearTimeout, document: {
    createElement:()=>node(''),
    getElementById: id => id === 'cpDraft' ? box : fields.get(id), querySelectorAll: s => s === '.cp-ck-t' ? checks : [], addEventListener() {} },
    addEventListener() {}, ComposeSelectionPosition: { position() {} }, petSay: value => alerts.push(value),
    Requirements: { dateTimestamp: () => null }, tasks: [],
    Store: { persistTask: async () => { calls.push(['persist']); return true; }, pauseUnconfirmedTask: () => calls.push(['pause']),
      applyServerEvent: event => serverEvents.push(event) },
    SoduWorkAPI: { parseTaskText: async (...args) => { calls.push(['parse', ...args]); return typeof parsed === 'function' ? parsed(...args) : parsed; },
      taskExecutionOptions: async body => { calls.push(['options', body]); return typeof execution === 'function' ? execution(body) : execution; },
      listTeammates: async () => typeof mates === 'function' ? mates() : mates,
      workCatalog: async () => { calls.push(['catalog']); return { scenarios: [{ key: 'bug', name: '缺陷修复' }] }; },
      createAssignedTask: async body => { calls.push(['assign', body]); return { task: { id: 'created', title: body.title } }; } } };
  ctx.window = ctx; vm.createContext(ctx);
  for (const file of ['task-priority.js', '../requirements/requirement-fields.js', 'task-execution-client.js', 'requirement-routing.js', 'panels-compose-submit.js', 'panels-compose-draft.js']) {
    if (!fs.existsSync(path.join(directory, file))) continue;
    let source = fs.readFileSync(path.join(directory, file), 'utf8');
    if (file === 'panels-compose-draft.js') source = source.replace('  global.ComposeDraft =',
      '  global.audit = { snapshot: () => JSON.parse(JSON.stringify(_d)), reload: _reloadMates, create: _create };\n  global.ComposeDraft =');
    vm.runInContext(source, ctx, { filename: file });
  }
  const click = selection => handlers.click({ stopPropagation() {}, target: { closest: s => s === '[data-selv]' ? { dataset: { selv: selection } } : null } });
  return { ctx, box, fields, calls, alerts, click, serverEvents, state: () => ctx.audit.snapshot(),
    async open(text = '修复缺陷，转给示例成员', opts = {}) { ctx.ComposeDraft.open(text, opts); await flush(); },
    async refine(text, opts = {}) { return ctx.ComposeDraft.refine(text, opts); } };
}

test('直接交办后立即合并服务端任务投影，创建人仍可在我提出查看', async () => {
  const f = fixture({ parsed: { title: '转交后的需求', ...explicit('示例成员') } });
  await f.open('转交给示例成员');
  await f.ctx.audit.create();
  const event = f.serverEvents.find(row => row.type === 'task.created');
  assert.ok(event, '应把转交回执并入本地任务镜像');
  assert.equal(event.arrival, 'self');
  assert.equal(event.task.id, 'created');
});

test('创建需求只保存内容和负责人，明确提及插件也留给执行者决定', async () => {
  const f = fixture({ parsed: { title: '修复缺陷', assignee: 'ai', flow: flow.key, flowExplicit: true } });
  await f.open('使用Bug修复·上线trial修复缺陷');
  assert.equal(f.state().who.kind, 'me');
  assert.equal(f.state().flow, '');
  assert.doesNotMatch(f.box.innerHTML, /data-sel="flow"|创建并按流程开始|创建并派出去/);
  const before = f.calls.filter(row => row[0] === 'options').length;
  await f.ctx.audit.create();
  assert.equal(f.calls.filter(row => row[0] === 'options').length, before, '保存需求不应预检执行器');
  assert.equal(f.ctx.tasks.length, 1);
  assert.equal(f.ctx.tasks[0].executionContext, null);
  assert.deepEqual(JSON.parse(JSON.stringify(f.ctx.tasks[0].workRouting)), {});
});

for (const name of ['示例成员', '高示例成员']) test('explicit human survives managed model flow: ' + name, async () => {
  const f = fixture({ parsed: { title: '修复', ...explicit(name), flow: flow.key, reason: '应该按流程交给AI执行' } });
  await f.open('修复缺陷，转给' + name);
  assert.equal(f.state().who.kind, 'mate'); assert.equal(f.state().who.id, 'gao'); assert.equal(f.state().flow, '');
  assert.doesNotMatch(f.box.innerHTML, /应该按流程交给AI执行/);
});
for (const failure of ['unavailable', 'missing', 'ambiguous', 'same-name', 'failed', 'thrown']) test('unresolved explicit human blocks create: ' + failure, async () => {
  const mates = failure === 'unavailable' ? { mates: [{ ...mate, hasBox: false }] } : failure === 'missing' ? { mates: [] }
    : failure === 'ambiguous' ? { mates: [mate, { ...mate, id: 'wang', name: '王示例成员' }] }
    : failure === 'same-name' ? { mates: [mate, { ...mate, id: 'gao2' }] }
    : failure === 'failed' ? { ok: false, mates: [], reason: 'offline' } : () => { throw Error('offline'); };
  const f = fixture({ parsed: { title: '修复', ...explicit(failure === 'same-name' ? '高示例成员' : '示例成员'), flow: flow.key }, mates });
  await f.open('转给' + (failure === 'same-name' ? '高示例成员' : '示例成员'));
  assert.equal(f.state().who.kind, 'pending'); await f.ctx.audit.create();
  assert.equal(f.calls.some(row => ['persist', 'assign', 'discard'].includes(row[0])), false);
  assert.ok(f.alerts.length);
});
test('self is independent from model workflow recommendation', async () => {
  const f = fixture({ parsed: { ...explicit('me'), flow: flow.key } }); await f.open('我自己修复');
  assert.equal(f.state().who.kind, 'me'); assert.equal(f.state().flow, '');
});
for (const name of ['示例成员', '高示例成员']) test('legacy parser still honors the direct named recipient: ' + name, async () => {
  const f = fixture({ parsed: { assignee: name, flow: flow.key } }); await f.open('缺陷如附件，转给' + name + '修复');
  assert.equal(f.state().who.kind, 'mate'); assert.equal(f.state().who.id, 'gao'); assert.equal(f.state().flow, '');
});
test('legacy self instruction is not downgraded to AI', async () => {
  const f = fixture({ parsed: { assignee: 'ai', flow: flow.key } }); await f.open('改为我自己处理');
  assert.equal(f.state().who.kind, 'me');
});
test('legacy unknown named recipient stays pending even when the parser suggests AI', async () => {
  const f = fixture({ parsed: { assignee: 'ai', flow: flow.key } }); await f.open('转给不存在的人处理');
  assert.equal(f.state().who.kind, 'pending');
});

for (const instruction of ['由于附件打不开，请修复预览功能', '让界面显示完整文件名', '附件由服务器提供，请修复预览功能']) {
  test('legacy parser does not turn an object or causal phrase into a person: ' + instruction, async () => {
    const f = fixture({ parsed: { assignee: 'ai' } }); await f.open(instruction);
    assert.equal(f.state().who.kind, 'me');
  });
}
for (const instruction of ['让示例成员来处理缺陷', '由示例成员负责修复']) test('legacy explicit assignment verb retains the human: ' + instruction, async () => {
  const f = fixture({ parsed: { assignee: '示例成员', flow: flow.key } }); await f.open(instruction);
  assert.equal(f.state().who.kind, 'mate'); assert.equal(f.state().who.id, 'gao'); assert.equal(f.state().flow, '');
});
test('multiple explicitly named recipients remain pending instead of falling back to AI', async () => {
  const f = fixture({ parsed: { assignee: '', assigneeExplicit: true, assigneeProblem: 'ambiguous',
    assigneeRequested: '高示例成员、王示例成员', assigneeReferences: ['高示例成员', '王示例成员'] },
    mates: { mates: [mate, { ...mate, id: 'wang', name: '王示例成员' }] } });
  await f.open('转给高示例成员，转给王示例成员'); assert.equal(f.state().who.kind, 'pending');
  assert.match(f.state().who.hint, /多个|多位/); await f.ctx.audit.create();
  assert.equal(f.calls.some(row => ['assign', 'persist'].includes(row[0])), false);
});
test('legacy multiple human directives cannot silently select the last person', async () => {
  const f = fixture({ parsed: { assignee: '王示例成员' }, mates: { mates: [mate, { ...mate, id: 'wang', name: '王示例成员' }] } });
  await f.open('转给高示例成员，转给王示例成员'); assert.equal(f.state().who.kind, 'pending');
});
for (const parsed of [{ assignee: 'ai', flow: flow.key }, { recommendedFlow: flow.key }, { scene: 'bug' }]) test('recommendations never select a workflow: ' + JSON.stringify(parsed), async () => {
  const f = fixture({ parsed }); await f.open('检查需求'); assert.equal(f.state().flow, '');
  assert.notEqual(f.state().who.kind, 'workflow'); f.click('scene|bug'); await flush();
  assert.equal(f.state().flow, ''); assert.notEqual(f.state().who.kind, 'workflow');
});
test('创建界面不提供执行选择器，负责人可手动换成真人', async () => {
  const f = fixture({ parsed: explicit('ai') }); await f.open('交给AI修复');
  assert.doesNotMatch(f.box.innerHTML, /data-selbtn="(?:flow|repo|scene)"/);
  f.click('flow|bug-binding'); assert.equal(f.state().flow, '');
  f.click('who|mate:gao'); assert.equal(f.state().who.kind, 'mate');
  await f.ctx.audit.reload(); assert.equal(f.state().who.kind, 'mate');
});
test('明确提及的插件留在说明中，创建不绑定执行流程', async () => {
  const text = '使用' + flow.name + '流程执行';
  const f = fixture({ parsed: { flow: flow.key, flowExplicit: true, flowRequested: flow.name } });
  await f.open(text); await f.ctx.audit.create();
  assert.equal(f.ctx.tasks[0].note, text); assert.equal(f.ctx.tasks[0].executionContext, null);
  assert.equal(f.calls.some(row => row[0] === 'options'), false);
});

test('a claimed explicit workflow missing from direct instruction cannot select', async () => {
  const f = fixture({ parsed: { flow: flow.key, flowExplicit: true, flowRequested: flow.name } });
  await f.open('修复缺陷\n历史：使用' + flow.name + '流程执行', { instruction: '修复缺陷', conversationContext: { text: 'history' } });
  assert.equal(f.state().flow, '');
});
test('尚不可用的插件建议不阻止记录需求', async () => {
  const f = fixture({ parsed: { flow: '', flowRequested: '已经失效的流程', flowProblem: 'unavailable', recommendedFlow: flow.key } });
  await f.open('使用已经失效的流程执行'); assert.equal(f.state().flowProblem, ''); await f.ctx.audit.create();
  assert.equal(f.ctx.tasks.length, 1); assert.match(f.ctx.tasks[0].note, /已经失效的流程/);
});
for (const references of [undefined, ['Alpha', 'Beta']]) test('多个插件建议不在创建阶段绑定: ' + Boolean(references), async () => {
  const f = fixture({ parsed: { title: '多流程', flow: '', flowExplicit: false, flowRequested: 'Alpha、Beta',
    flowProblem: 'ambiguous', ...(references ? { flowReferences: references } : {}) } });
  await f.open('使用 Alpha 流程，使用 Beta 流程'); assert.equal(f.state().flowProblem, '');
  await f.ctx.audit.create(); assert.equal(f.ctx.tasks.length, 1);
  assert.match(f.ctx.tasks[0].note, /Alpha.*Beta/); assert.equal(f.ctx.tasks[0].executionContext, null);
});
test('manual human remains selected during late refresh and unrelated refinement', async () => {
  const f = fixture({ parsed: explicit('ai') }); await f.open('交给AI修复');
  const pending = deferred(); f.ctx.SoduWorkAPI.taskExecutionOptions = () => pending.promise;
  f.click('scene|bug'); f.click('who|mate:gao'); pending.resolve(options); await flush();
  f.ctx.SoduWorkAPI.parseTaskText = async () => ({ assignee: 'ai', flow: flow.key, reason: '交给AI' });
  await f.refine('加上回归截图'); assert.equal(f.state().who.kind, 'mate'); assert.equal(f.state().flow, '');
  assert.doesNotMatch(f.box.innerHTML, /交给AI<\/div>/);
});
test('refinement sends actual human identity and only the current direct instruction', async () => {
  const f = fixture({ parsed: explicit('示例成员') }); await f.open();
  await f.refine('补充要求及历史材料', { instruction: '补充回归截图', conversationContext: { text: '历史：转给王示例成员' } });
  const request = f.calls.filter(row => row[0] === 'parse').at(-1);
  assert.equal(request[4].instruction, '补充回归截图'); assert.match(request[1], /gao/); assert.match(request[1], /高示例成员/);
});
test('explicit refinement can replace the selected human with self', async () => {
  const f = fixture({ parsed: explicit('示例成员') }); await f.open();
  f.ctx.SoduWorkAPI.parseTaskText = async () => explicit('me'); await f.refine('改为我自己处理');
  assert.equal(f.state().who.kind, 'me');
});
test('补充或撤销插件建议均不能产生执行绑定', async () => {
  const f = fixture({ parsed: explicit('ai') }); await f.open('使用Bug修复插件处理');
  f.ctx.SoduWorkAPI.parseTaskText = async () => ({ flow: flow.key, flowExplicit: true, flowRequested: flow.name });
  await f.refine('补充截图'); assert.equal(f.state().flow, ''); assert.equal(f.state().who.kind, 'me');
  f.ctx.SoduWorkAPI.parseTaskText = async () => ({ flow: '', flowExplicit: true, flowCleared: true });
  await f.refine('取消工作流'); await f.ctx.audit.create();
  assert.equal(f.ctx.tasks[0].executionContext, null); assert.match(f.ctx.tasks[0].note, /取消工作流/);
});

test('明确真人和插件建议仅保留负责人，不额外展示执行配置', async () => {
  const f = fixture({ parsed: { ...explicit('示例成员'), flow: flow.key, flowExplicit: true, flowRequested: flow.name } });
  await f.open('转给示例成员，使用' + flow.name + '流程');
  assert.equal(f.state().who.kind, 'mate'); assert.equal(f.state().flow, ''); assert.doesNotMatch(f.box.innerHTML, /data-selbtn="flow"|执行方式/);
});
test('structured proposal preserves a real human ID and never infers workflow permission', async () => {
  const f = fixture(); await f.ctx.ComposeDraft.openWith({ title: 'proposal', assigneeUserId: 'gao', flow: flow.key }, {});
  assert.equal(f.state().who.kind, 'mate'); assert.equal(f.state().flow, '');
});
test('unknown structured person ID remains unresolved instead of silently assigning self', async () => {
  const f = fixture(); await f.ctx.ComposeDraft.openWith({ title: 'proposal', assigneeUserId: 'missing', flow: flow.key }, {});
  assert.equal(f.state().who.kind, 'pending'); await f.ctx.audit.create();
  assert.equal(f.calls.some(row => ['persist', 'assign'].includes(row[0])), false);
});
test('结构化提议中的旧执行选择也不会在创建时自动启动', async () => {
  const f = fixture(); await f.ctx.ComposeDraft.openWith({ title: 'proposal', flow: flow.key }, { userSelection: { flow: flow.bindingId } });
  assert.equal(f.state().flow, ''); assert.equal(f.state().who.kind, 'me');
});
test('保存期间冻结补充，保存失败释放表单且暂停未确认需求', async () => {
  const f = fixture({ parsed: { title: 'AI工作', ...explicit('ai') } }); await f.open('交给AI处理');
  const pending = deferred(); f.ctx.Store.persistTask = () => pending.promise;
  const creating = f.ctx.audit.create(); await flush();
  assert.equal(await f.refine('补充标题'), false);
  pending.resolve(false); await creating;
  assert.equal(f.calls.some(row => row[0] === 'pause'), true); assert.equal(f.fields.get('cpCreate').disabled, false);
});

test('real parser API passes the independent direct instruction for requirements', async () => {
  let body; const context = { window: null, localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    console, setTimeout: () => 0, clearTimeout() {}, AbortController, navigator: {},
    fetch: async (_url, options) => { body = JSON.parse(options.body); return { ok: true, status: 200, text: async () => '{"fields":{}}' }; } };
  context.window = context; vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../api.js'), 'utf8'), context);
  await context.SoduWorkAPI.parseTaskText('历史和材料', '', [], { instruction: '转给示例成员' });
  assert.equal(body.instruction, '转给示例成员'); assert.equal(body.text, '历史和材料');
});
test('failed directory retry can resolve the retained named human', async () => {
  const f = fixture({ parsed: explicit('示例成员'), mates: { ok: false, mates: [] } }); await f.open();
  assert.equal(f.state().who.kind, 'pending'); f.ctx.SoduWorkAPI.listTeammates = async () => ({ mates: [mate] });
  await f.ctx.audit.reload(); assert.equal(f.state().who.kind, 'mate'); assert.equal(f.state().who.id, 'gao');
});
test('Runner离线不阻止创建，保存不发起执行预检', async () => {
  const f = fixture({ parsed: { title: 'AI工作', ...explicit('ai') }, execution: () => { throw Error('offline'); } });
  await f.open('交给AI处理'); await f.ctx.audit.create();
  assert.equal(f.ctx.tasks.length, 1); assert.equal(f.calls.some(row => row[0] === 'options'), false);
  assert.equal(f.alerts.length, 0);
});

test('关闭重开后，旧的解析结果不覆盖新的草稿', async () => {
  const f = fixture(); const pending = deferred(); f.ctx.SoduWorkAPI.parseTaskText = () => pending.promise;
  f.ctx.ComposeDraft.open('旧需求'); await flush(); f.ctx.ComposeDraft.clear();
  await f.ctx.ComposeDraft.openWith({ title: 'new', assigneeUserId: 'gao' }, {});
  pending.resolve({ title: '旧需求解析返回', kind: 'bug' }); await flush();
  assert.equal(f.state().title, 'new'); assert.equal(f.state().who.kind, 'mate');
});

for (const kind of ['requirement', 'bug', 'ticket', 'improvement', 'other']) test('业务类型从解析、表单到保存保持一致：' + kind, async () => {
  const f = fixture({ parsed: { title: '分类验证', kind, scene: 'bug' } });
  await f.open('检查分类', { saveOnly: true });
  assert.equal(f.fields.get('cpKind').value, kind); assert.doesNotMatch(f.box.innerHTML, /工作类型|执行方式|关联工程/);
  await f.ctx.audit.create(); assert.equal(f.ctx.tasks[0].kind, kind);
  assert.equal(f.ctx.tasks[0].workScenarioKey, undefined); assert.equal(f.ctx.tasks[0].workScenarioName, undefined);
  assert.equal(f.calls.some(row => row[0] === 'catalog' || row[0] === 'options'), false);
});

test('手选业务类型在补充中保留，模型场景不会成为创建字段', async () => {
  const f = fixture({ parsed: { title: '分类验证', kind: 'bug', scene: 'bug' } }); await f.open('修复问题');
  f.fields.get('cpKind').value = 'improvement'; f.click('scene|other');
  f.ctx.SoduWorkAPI.parseTaskText = async text => {
    assert.match(text, /"kind":"improvement"/); assert.doesNotMatch(text, /"scene"/);
    return { kind: 'requirement', scene: 'bug', note: '增加截图' };
  };
  await f.refine('增加截图'); assert.equal(f.state().kind, 'improvement'); assert.equal(f.state().scene, undefined);
});

test('长文尾部完整保留，解析的工程建议不被绑定到创建记录', async () => {
  const input = '原始材料'.repeat(600) + '尾部要求：保留数据';
  const f = fixture({ parsed: { title: '完整材料', kind: 'bug', note: '摘要', repo: 'guessed' } });
  await f.open(input); await f.ctx.audit.create();
  assert.equal(f.ctx.tasks[0].note, input); assert.equal(f.ctx.tasks[0].repoId, '');
});

test('创建所处项目只作为背景保留，不成为流程或执行选择', async () => {
  const f = fixture(); await f.ctx.ComposeDraft.openWith({ title: '项目记录', kind: 'ticket', repoId: 'repo-context' }, { projectId: 'project-context' });
  await f.ctx.audit.create(); assert.equal(f.ctx.tasks[0].projectId, 'project-context');
  assert.equal(f.ctx.tasks[0].repoId, 'repo-context'); assert.equal(f.ctx.tasks[0].executionContext, null);
});

test('the project selected or cleared in creation replaces the initial board filter without migrating a repository',async()=>{
  for(const chosen of ['business-b','']){
    const f=fixture();f.ctx.SoduWorkAPI.getProjects=async()=>[{id:'business-a',name:'Business A'},{id:'business-b',name:'Business B'}];
    await f.ctx.ComposeDraft.openWith({title:'Project choice'},{projectId:'business-a',saveOnly:true});await flush();
    const select=f.fields.get('cpProjectId');assert.equal(select.value,'business-a');assert.equal(select.disabled,false);
    select.value=chosen;select.listeners.change();
    assert.equal(f.ctx.ComposeDraft.capture().draft.projectId,chosen);
    await f.ctx.audit.create();assert.equal(f.ctx.tasks[0].projectId,chosen||null);assert.equal(f.ctx.tasks[0].repoId,'');
  }
});

test('a repository-bound creation retains its project and repository despite a forged selection event',async()=>{
  const f=fixture();f.ctx.SoduWorkAPI.getProjects=async()=>[{id:'business-a',name:'A'},{id:'business-b',name:'B'}];
  await f.ctx.ComposeDraft.openWith({title:'Bound project',repoId:'repository-a'},{projectId:'business-a',saveOnly:true});await flush();
  const select=f.fields.get('cpProjectId');assert.equal(select.disabled,true);
  select.value='business-b';select.listeners.change();await f.ctx.audit.create();
  assert.equal(f.ctx.tasks[0].projectId,'business-a');assert.equal(f.ctx.tasks[0].repoId,'repository-a');
});
