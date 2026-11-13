'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const read = name => fs.readFileSync(path.join(__dirname, '../components/panels', name + '.js'), 'utf8');
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  let owner = 'alice'; const events = [], layers = [], calls = { parse: 0, preflight: 0, create: 0 };
  const context = { Intl, setTimeout: () => 1, clearTimeout() {}, requestAnimationFrame: fn => fn(),
    addEventListener: (name, fn) => events.push([name, fn]), PluginUIHost: { registerAction() {} },
    _schmLoad: async () => [{ key: 'report', name: '报告', version: '1', inputs: [] }],
    SoduWorkAPI: { taskStorageKey: () => owner,
      taskExecutionOptions: async () => ({ substrates: [{ key: 'local:pi', name: 'Pi' }], repos: [] }),
      parseTaskText: async () => { calls.parse++; return { title: '新自动化', note: '完整说明' }; },
      preflightSchedule: async (_body, options) => { assert.equal(options.force, true); calls.preflight++; return { state: 'ready' }; },
      createSchedule: async body => { calls.create++; return { ...body, id: 'saved-1' }; },
    } };
  context.window = context;
  context.FormData = class {
    constructor(form) { this.fields = form.elements; }
    get(key) { const field = this.fields[key]; return !field || field.disabled || field.type === 'checkbox' && !field.checked ? null : field.value; }
  };
  context.harnessMount = state => {
    const body = { _text: '', set innerHTML(value) { this._text = value; layer.form = null; }, get innerHTML() { return this._text; }, insertAdjacentHTML(_where, html) { this._text += html; } };
    const button = { disabled: false, textContent: '', classList: { remove() {} } }, error = { hidden: true, textContent: '' };
    const probe = { className: '', title: {}, detail: {}, querySelector(selector) { return selector === 'b' ? this.title : this.detail; } };
    const layer = { isConnected: true, body, button, probe, form: null, classList: { remove() {} },
      querySelector: selector => selector === '#wazProbe' ? probe : selector === '#wazBody' ? body : selector === '#wazForm' ? layer.form : selector === '#wazError' ? error : button,
      querySelectorAll: () => [button, ...Object.values(layer.form?.elements || {})] };
    state.layer = layer; state.surface = { inline: true, destroy() { layer.isConnected = false; } }; layers.push(layer); return body;
  };
  context.harnessRender = (state, error) => {
    const p = state.proposal, layer = state.layer, fields = {};
    for (const key of ['title', 'note', 'every', 'assigneeId', 'repoId', 'personalPluginKey', 'retryLimit', 'retryDelayMinutes', 'weekday'])
      fields[key] = { value: String(p[key] ?? ''), disabled: false };
    fields.acceptance = { value: (p.acceptance || []).join('\n') }; fields.clock = { value: `${p.atHour || 0}:${p.atMinute || 0}` };
    fields.minute = { value: String(p.atMinute || 0) }; fields.runAt = { value: context.ScheduleTiming.localInput(p.runAt, p.timeZone) };
    for (const key of ['flow', 'enabled']) fields[key] = { type: 'checkbox', checked: !!p[key], value: 'on' };
    layer.form = { elements: fields, querySelector: () => ({}), querySelectorAll: selector => selector === '[data-waz-method-input]'
      ? Object.entries(p.pluginInputs || {}).map(([key, value]) => ({ dataset: { wazMethodInput: key, inputType: typeof value }, value, checked: value })) : [] };
    layer.body._text = error || 'rendered';
  };
  vm.createContext(context);
  for (const name of ['schedule-timing', 'work-automation-bindings', 'work-automation-card-state']) vm.runInContext(read(name), context);
  const source = read('work-automation-sheet').replace('  global.WorkAutomationSheet = { open, active, refine, close };',
    '  mount = seed => harnessMount(state, seed); render = error => harnessRender(state, error); global.probe = {state,save,onChange};\n  global.WorkAutomationSheet = { open, active, refine, close };');
  vm.runInContext(source, context);
  return { context, api: context.SoduWorkAPI, sheet: context.WorkAutomationSheet, probe: context.probe, calls, layers,
    switchOwner() { owner = 'bob'; events.filter(([name]) => name === 'soduwork-data-scope-changed').forEach(([, fn]) => fn()); } };
}
const proposal = { title: '原始计划', note: '完整要求', acceptance: ['检查完成'], every: 'once', runAt: '2099-10-16T04:00:00.000Z',
  timeZone: 'Asia/Shanghai', assigneeId: 'local:pi', repoId: '', personalPluginKey: 'report', pluginInputs: { audience: '研发组', includeDetail: true },
  retryLimit: 2, retryDelayMinutes: 5, enabled: true, requiredCapabilities: [] };
const restored = extra => ({ version: 1, cardId: 'card-a', phase: 'draft', proposal, ...extra });

test('ordinary enabled automation receipts with empty provenance remain ordinary', async () => {
  const f = fixture(); let submitted;
  await f.sheet.open({proposal: {...proposal, sourceRequirement: {}}});
  assert.equal(f.sheet.capture().proposal.enabled, true);
  f.api.createSchedule = async body => {submitted = body; return {...body, id: 'ordinary', sourceRequirement: {}};};
  await f.probe.save();
  assert.equal(submitted.enabled, true);
  assert.equal(Object.hasOwn(submitted, 'sourceRequirement'), false);
  const html = f.context.WorkAutomationCardState.savedHtml({...proposal, sourceRequirement: {}}, null, null, String);
  assert.match(html, /自动化已创建/);
  assert.doesNotMatch(html, /草稿|尚未启用|来源需求/);
});

test('automation option loading preserves managed and native model choices', async () => {
  const f = fixture();
  f.api.taskExecutionOptions = async () => ({
    substrates: [
      { key: 'local:pi', name: 'Pi', modelPick: true },
      { key: 'local:codex', name: 'Codex', nativeModelPick: true },
    ],
    modelOptions: [{ name: 'configured-model', label: 'Configured model' }],
    defaultModel: 'configured-model', repos: [],
  });
  f.context.soduWorkAPI = {
    conversationSession: {
      runtimeModels: async () => ({ models: [{ id: 'codex-account-model', label: 'Codex account model' }] }),
    },
  };

  const loaded = await f.context.WorkAutomationCardState.loadOptions({ text: 'daily report' });
  assert.deepEqual(loaded.modelOptions, [{ name: 'configured-model', label: 'Configured model' }]);
  assert.equal(loaded.defaultModel, 'configured-model');
  assert.equal(loaded.agents[0].modelPick, true);
  assert.equal(loaded.agents[0].nativeModelPick, false);
  assert.equal(loaded.agents[1].nativeModelPick, true);
  assert.deepEqual(loaded.agents[1].modelOptions, [{ id: 'codex-account-model', label: 'Codex account model' }]);
  assert.match(read('work-automation-sheet'), /本机模型仅支持本机对话；后台自动化需要 Hub 托管模型/);
});

test('requirement entry is an independent disabled draft and cancel creates nothing', async () => {
  const f = fixture();
  const source = {id: 'requirement-one', title: '<Original requirement>', requirementVersion: 3};
  await f.sheet.open({sourceRequirement: source, proposal: {...proposal, enabled: true}});
  assert.equal(f.sheet.capture().proposal.enabled, false);
  assert.equal(f.calls.create, 0); assert.equal(f.calls.parse, 0);
  f.sheet.close();
  assert.equal(f.calls.create, 0);
  await f.sheet.open({sourceRequirement: source, proposal: {...proposal, enabled: true}});
  const bodies = [];
  f.api.createSchedule = async body => {bodies.push(body); return {...body, id: 'saved-source', sourceRequirement: source};};
  f.probe.state.layer.form.elements.enabled.checked = true;
  await f.probe.save();
  assert.equal(bodies.length, 1); assert.equal(bodies[0].enabled, false);
  assert.deepEqual(JSON.parse(JSON.stringify(bodies[0].sourceRequirement)), {id: source.id, requirementVersion: 3});
  assert.match(bodies[0].creationRequestId, /^automation-/);
  assert.match(f.probe.state.layer.body.innerHTML, /自动化草稿已保存/);
  assert.match(f.probe.state.layer.body.innerHTML, /&lt;Original requirement&gt;/);
  assert.doesNotMatch(f.probe.state.layer.body.innerHTML, /<Original requirement>/);
});

test('requirement draft retry retains the same creation identity after a lost response', async () => {
  const f = fixture(), bodies = [];
  await f.sheet.open({sourceRequirement: {id: 'source', title: 'Original', requirementVersion: 3}, proposal});
  f.api.createSchedule = async body => {
    bodies.push(JSON.parse(JSON.stringify(body)));
    if (bodies.length === 1) throw new Error('Response lost after save');
    return {...body, id: 'one-draft'};
  };
  await f.probe.save();
  assert.equal(f.sheet.capture().uncertain, false);
  await f.probe.save();
  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies[1], bodies[0]);
  assert.equal(f.sheet.capture().createdId, 'one-draft');
});

test('account switching during requirement preflight prevents its creation', async () => {
  const f = fixture(), preflight = deferred();
  f.api.preflightSchedule = () => preflight.promise;
  await f.sheet.open({sourceRequirement: {id: 'source', title: 'Original', requirementVersion: 3}, proposal});
  const saving = f.probe.save();
  f.switchOwner(); preflight.resolve({state: 'ready'}); await saving;
  assert.equal(f.calls.create, 0);
});

test('恢复原时间、参数和手动字段，不再次解析或推断相对日期', async () => {
  const f = fixture(), snapshots = [];
  f.context.ScheduleTiming.infer = () => { throw Error('恢复不能重新推断日期'); };
  await f.sheet.open({ cardId: 'card-a', text: '今天中午执行', cardState: restored(), onCardState: s => snapshots.push(s) });
  assert.equal(f.calls.parse, 0); assert.equal(f.sheet.capture().proposal.runAt, proposal.runAt);
  assert.equal(f.sheet.capture().proposal.pluginInputs.audience, '研发组');
  f.probe.state.layer.form.elements.note.value = '最新手动修改';
  assert.equal(f.sheet.capture().proposal.note, '最新手动修改');
  assert.equal(snapshots.at(-1).proposal.note, '最新手动修改');
  assert.doesNotThrow(() => JSON.stringify(f.sheet.capture()));
});

test('保存中切走再回来保持原值和单次请求，完成回执自动更新恢复的卡片', async () => {
  const f = fixture(), preflight = deferred(), created = deferred(), snapshots = []; let onCreated = 0;
  f.api.preflightSchedule = async () => { f.calls.preflight++; return preflight.promise; };
  f.api.createSchedule = async body => { f.calls.create++; assert.equal(body.note.startsWith('完整要求'), true); return created.promise; };
  await f.sheet.open({ cardId: 'card-a', cardState: restored(), onCardState: s => snapshots.push(s), onCreated: () => onCreated++ });
  const saving = f.probe.save(), snapshot = f.sheet.capture();
  assert.equal(snapshot.phase, 'submitting'); assert.equal(snapshot.proposal.note, '完整要求');
  f.sheet.close(true); await f.sheet.open({ cardId: 'card-a', cardState: snapshot });
  await f.probe.save(); assert.equal(f.calls.preflight, 1); assert.equal(f.sheet.capture().phase, 'submitting');
  preflight.resolve({ state: 'ready' }); await tick(); assert.equal(f.calls.create, 1);
  created.resolve({ id: 'schedule-one', title: '原始计划' }); await saving;
  assert.equal(f.sheet.capture().phase, 'succeeded'); assert.equal(f.sheet.capture().createdId, 'schedule-one');
  assert.equal(snapshots.at(-1).phase, 'succeeded'); assert.equal(onCreated, 0);
  assert.match(f.probe.state.layer.body.innerHTML, /自动化已创建/);
});

test('迟到创建结果写回原卡，不污染新会话或调用旧页面回调', async () => {
  const f = fixture(), created = deferred(), a = [], b = []; let callback = 0;
  f.api.createSchedule = () => created.promise;
  await f.sheet.open({ cardId: 'card-a', cardState: restored(), onCardState: s => a.push(s), onCreated: () => callback++ });
  const saving = f.probe.save(); await tick(); f.sheet.close(true);
  await f.sheet.open({ cardId: 'card-b', cardState: restored({ cardId: 'card-b', proposal: { ...proposal, title: '另一条计划' } }), onCardState: s => b.push(s) });
  created.resolve({ id: 'schedule-a' }); await saving;
  assert.equal(a.at(-1).createdId, 'schedule-a'); assert.equal(f.sheet.capture().proposal.title, '另一条计划');
  assert.equal(f.sheet.capture().phase, 'draft'); assert.equal(b.some(s => s.createdId), false); assert.equal(callback, 0);
});

test('跨重启恢复未确认的提交只允许查询，不当作未创建重新发送', async () => {
  const f = fixture(); await f.sheet.open({ cardId: 'card-a', cardState: restored({ phase: 'submitting' }) });
  const snapshot = f.sheet.capture(); assert.equal(snapshot.phase, 'error'); assert.equal(snapshot.uncertain, true);
  assert.match(snapshot.error, /查询.*重复创建/); assert.equal(f.probe.state.layer.button.disabled, true);
  await f.probe.save(); assert.equal(f.calls.create, 0); assert.equal(f.calls.preflight, 0);
});

test('导航卸载不通知关闭；显式关闭保留草稿并回调原卡', async () => {
  const f = fixture(); let closed = 0, legacyClosed = 0;
  const seed = { cardId: 'card-a', cardState: restored(), onCardClose: s => { closed++; assert.equal(s.proposal.title, proposal.title); }, onClose: () => legacyClosed++ };
  await f.sheet.open(seed); assert.equal(f.sheet.hasSurface(), true); f.sheet.close(true);
  assert.equal(closed, 0); assert.equal(legacyClosed, 0); assert.equal(f.sheet.hasSurface(), false);
  await f.sheet.open(seed); f.sheet.close(); assert.equal(closed, 1); assert.equal(legacyClosed, 1);
});

test('迟到解析可保留原卡结果，账号切换后不得保存旧账号回执', async () => {
  const f = fixture(), parsed = deferred(), states = [];
  f.api.parseTaskText = () => parsed.promise;
  const opening = f.sheet.open({ cardId: 'card-a', text: '每天检查', onCardState: s => states.push(s) });
  await tick(); f.sheet.close(true);
  await f.sheet.open({ cardId: 'card-b', cardState: restored({ cardId: 'card-b' }) });
  parsed.resolve({ title: '原卡解析结果', note: '原要求' }); await opening;
  assert.equal(states.at(-1).proposal.title, '原卡解析结果'); assert.equal(f.sheet.capture().cardId, 'card-b');
  const created = deferred(); f.api.createSchedule = () => created.promise;
  const seed = { cardId: 'card-c', cardState: restored({ cardId: 'card-c' }), onCardState: s => states.push(s) };
  await f.sheet.open(seed); const saving = f.probe.save(); await tick(); const count = states.length;
  f.switchOwner(); created.resolve({ id: 'old-account' }); await saving;
  assert.equal(states.length, count); assert.equal(f.sheet.capture(), null);
});

test('预检失败保留草稿并可重试，创建请求失败则先确认服务端结果', async () => {
  const f = fixture(); let attempts = 0;
  f.api.preflightSchedule = async () => { attempts++; return { state: 'blocked', message: 'Runner 不在线' }; };
  await f.sheet.open({ cardId: 'card-a', cardState: restored() });
  await f.probe.save();
  assert.equal(f.sheet.capture().phase, 'error'); assert.equal(f.sheet.capture().uncertain, false);
  assert.equal(f.sheet.capture().proposal.note, proposal.note); assert.equal(f.calls.create, 0);
  await f.probe.save(); assert.equal(attempts, 2);
  f.api.preflightSchedule = async () => ({ state: 'ready' });
  f.api.createSchedule = async () => { f.calls.create++; throw Error('连接在响应前中断'); };
  await f.probe.save();
  assert.equal(f.sheet.capture().uncertain, true); assert.match(f.sheet.capture().error, /查询/);
  await f.probe.save(); assert.equal(f.calls.create, 1);
});

test('跨重启恢复整理中的卡片不重新调用模型，原字段保持可编辑', async () => {
  const f = fixture();
  await f.sheet.open({ cardId: 'card-a', cardState: restored({ phase: 'loading' }) });
  assert.equal(f.calls.parse, 0); assert.equal(f.sheet.capture().phase, 'error');
  assert.match(f.sheet.capture().error, /整理未完成/); assert.equal(f.sheet.capture().proposal.runAt, proposal.runAt);
});

test('补充解析失败保留原手动字段及错误状态，不能把网关失败标成整理成功', async () => {
  const f = fixture(); let refined = 0;
  await f.sheet.open({ cardId: 'card-a', cardState: restored(), onRefined: () => refined++ });
  f.api.parseTaskText = async () => ({ _parseError: '模型网关暂时不可用' });
  const accepted = await f.sheet.refine('标题改为下周巡检');
  assert.equal(accepted, false); assert.equal(f.sheet.capture().phase, 'error');
  assert.equal(f.sheet.capture().proposal.title, proposal.title);
  assert.equal(f.sheet.capture().proposal.pluginInputs.audience, '研发组'); assert.equal(refined, 0);
});

test('创建前等待提交意图写入会话，写入失败不调用服务端且允许明确重试', async () => {
  const f = fixture(), persisted = deferred(); let attempts = 0;
  await f.sheet.open({ cardId: 'card-a', cardState: restored(), onBeforeSubmit: snapshot => {
    attempts++; assert.equal(snapshot.phase, 'submitting'); assert.equal(snapshot.proposal.note, proposal.note);
    return attempts === 1 ? persisted.promise : Promise.resolve();
  } });
  const saving = f.probe.save(); await tick();
  assert.equal(attempts, 1); assert.equal(f.calls.create, 0);
  persisted.reject(Error('会话存储写入失败')); await saving;
  assert.equal(f.sheet.capture().phase, 'error'); assert.equal(f.sheet.capture().uncertain, false);
  assert.match(f.sheet.capture().error, /存储写入失败/); assert.equal(f.calls.create, 0);
  await f.probe.save(); assert.equal(attempts, 2); assert.equal(f.calls.create, 1);
  assert.equal(f.sheet.capture().phase, 'succeeded');
});
