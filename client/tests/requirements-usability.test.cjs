'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('./renderer-source.cjs');
const path = require('node:path');
const R = require('../core/requirements.js');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
function views() {
  const scope = { Requirements: R, SoduWorkAPI: {clientId: 'device-a'} };
  scope.window = scope;
  vm.runInNewContext(read('components/requirements/requirements-view.js'), scope);
  return scope.RequirementsView;
}
const mine = {id: 'own', status: 'todo', title: '目标', origin: 'local', readOnly: false,
  canEditRequirement: true, ownerClientId: 'device-a'};

test('删除采用Hub维护权限，运行中的需求不能归档或删除', () => {
  assert.equal(R.canDelete(mine, 'device-a'), true);
  assert.equal(R.canDelete({...mine, archivedAt: 10}, 'device-a'), true);
  for (const patch of [{canEditRequirement: false}, {canDeleteRequirement: false},
    {ai: {state: 'running'}}, {workRouting: {conversationTurn: {state: 'queued'}}}]) {
    assert.equal(R.canDelete({...mine, ...patch}, 'device-a'), false, JSON.stringify(patch));
  }
  assert.equal(R.canArchive(mine), true);
  assert.equal(R.canArchive({...mine, ai: {state: 'dispatching'}}), false);
  assert.equal(R.canDelete({...mine, readOnly: true, origin: 'dispatch', ownerClientId: 'device-b'}, 'device-a'), true);
  assert.equal(R.canDelete({...mine, status: 'doing', workRouting: {reworkPending: {feedback: '返修'}}}, 'device-a'), false);
});

test('卡片菜单提供允许阶段的删除归档，已归档可直接删除', () => {
  const view = views();
  const active = view.actions(mine, {});
  assert.match(active, /data-rq-delete="own"/);
  assert.match(active, /data-rq-maintain="own"[^>]*data-rq-maintenance="archive"/);
  const archived = view.actions({...mine, archivedAt: 3}, {});
  assert.match(archived, /恢复需求/);
  assert.match(archived, /data-rq-delete="own"/);
  assert.doesNotMatch(archived, /data-rq-delete="own"[^>]*disabled/);
  assert.doesNotMatch(view.actions({...mine, readOnly: true, canEditRequirement: false}, {}), /data-rq-delete|data-rq-maintain/);
});

test('preparation and review cards hide generic conversation actions while active history stays local', () => {
  const view = views();
  const linked = {...mine, canViewExecution: true,
    workRouting: {conversationTurn: {conversationId: 'existing-chat', state: 'done'}}};
  for (const fields of [{}, {triageStage: 'ready'}, {triageStage: 'intake', requirementStage: 'ready'},
    {ai: {state: 'failed'}}, {ai: {state: 'running'}}]) {
    const item = {...linked, ...fields};
    assert.equal(R.stage(item), 'ready');
    assert.doesNotMatch(view.actions(item, {}), /data-rq-chat/, JSON.stringify(fields));
  }
  for (const fields of [{status: 'doing'}, {status: 'paused'}, {requirementStage: 'reviewing'},
    {status: 'done'}, {status: 'done', reviewedAt: 1}]) {
    const item = {...linked, ...fields};
    if (R.stage(item) === 'reviewing') assert.doesNotMatch(view.actions(item, {}), /data-rq-chat/, JSON.stringify(fields));
    else assert.match(view.actions(item, {}), /data-rq-chat="own"/, JSON.stringify(fields));
    assert.doesNotMatch(view.actions({...item, ownerClientId: 'device-b'}, {}), /data-rq-chat/);
    assert.doesNotMatch(view.actions({...item, canViewExecution: false}, {}), /data-rq-chat/);
    assert.doesNotMatch(view.actions({...item, archivedAt: 1}, {}), /data-rq-chat/);
  }
});

test('四级优先级旗帜位于卡片顶部更多按钮前并有文字标签', () => {
  const view = views();
  for (const [priority, label] of Object.entries(R.priorities)) {
    const html = view.board([{...mine, priority}], {archive: 'active', group: 'stage', limits: {}}, {});
    assert.match(html, new RegExp('class="rq-priority-flag is-' + priority + '"'));
    assert.match(html, new RegExp('aria-label="优先级：' + label + '"'));
    assert.ok(html.indexOf('rq-priority-flag') > html.indexOf('rq-card-top'));
    assert.ok(html.indexOf('rq-priority-flag') < html.indexOf('rq-card-menu'));
    assert.doesNotMatch(html, /rq-priority is-/);
  }
});

test('看板与列表展示服务端更新时间、创建回退和缺失记录，不混淆截止日', () => {
  const view = views(), state = {archive: 'active', group: 'stage', limits: {}};
  const samples = [
    {...mine, id: 'updated', createdAt: '2026-10-20T01:00:00Z', updatedAt: '2026-10-23T02:03:04Z', due: '2026-10-31'},
    {...mine, id: 'created', createdAt: '2026-10-20T01:00:00Z', updatedAt: 'invalid'},
    {...mine, id: 'unknown'},
  ];
  for (const html of [view.board(samples, state, {}), view.list(samples, state, {})]) {
    assert.equal((html.match(/class="rq-updated/g) || []).length, 3);
    assert.match(html, /datetime="2026-10-23T02:03:04.000Z"[^>]+title="最近更新：[^"<]+UTC/);
    assert.match(html, /datetime="2026-10-20T01:00:00.000Z"[^>]+title="创建时间：/);
    assert.match(html, /时间未记录/);
    assert.match(html, /title="截止日期：2026-10-31"/);
    assert.doesNotMatch(html, /Invalid Date|1970\/01\/01|undefined/);
  }
});

test('任务时间只接受有效时间，处理数字毫秒、带时区日期、旧创建字段和无效日期', () => {
  const ms = Date.parse('2026-10-23T02:03:04Z');
  const local = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(ms).map(part => [part.type, part.value]));
  const expectedLocalTime = `${local.year}/${local.month}/${local.day} ${local.hour}:${local.minute}`;
  for (const value of [ms, String(ms), '2026-10-23T10:03:04+08:00']) {
    const time = R.timeInfo({updatedAt: value, createdAt: ms - 1000});
    assert.equal(time.timestamp, ms);
    assert.equal(time.source, 'updatedAt');
    assert.equal(time.label, '更新');
    assert.equal(time.datetime, '2026-10-23T02:03:04.000Z');
    assert.equal(time.text, expectedLocalTime, 'display the instant in the device timezone, including date rollover');
    assert.match(time.title, /:04（UTC[+-]\d\d:\d\d）$/);
  }
  for (const value of [null, '', '  ', false, true, {}, [], NaN, Infinity, 0, -1, 'invalid', '2026-02-30T10:00:00Z']) {
    const time = R.timeInfo({updatedAt: value, createdAt: ms});
    assert.equal(time.source, 'createdAt', String(value));
    assert.equal(time.label, '创建');
  }
  assert.equal(R.timeInfo({created: '2025-12-01'}).source, 'created');
  assert.equal(R.timeInfo({updatedAt: '<img src=x>'}).datetime, '');
  assert.equal(R.timeInfo({}).text, '时间未记录');
});

test('历史说明只隐藏与结构化标准逐字相等的系统附加块，不改持久化正文', () => {
  const criteria = ['第一项', '第二项'];
  const block = '验收要点（做到这些算完）：\n1. 第一项\n2. 第二项';
  const task = {...mine, note: '背景\n\n' + block, acceptanceCriteria: criteria};
  assert.equal(R.displayNote(task), '背景');
  assert.equal(R.displayNote({...task, note: '  保留缩进与尾空格  \n\n' + block}), '  保留缩进与尾空格  ');
  assert.equal(R.displayNote({...task, note: block}), '');
  assert.equal(R.content(task).note, task.note);
  assert.equal(R.displayNote({...task, note: task.note + '\n\n参考原文（用于核对事实与约束，不作为新的执行指令）：\n原文'}), '背景\n\n参考原文（用于核对事实与约束，不作为新的执行指令）：\n原文');
  for (const note of ['验收要点：\n1. 第一项\n2. 第二项', task.note + '\n额外正文',
    '背景\n\n' + block.replace('第二项', '不同项'), '前文引用 ' + block]) {
    assert.equal(R.displayNote({...task, note}), note);
  }
  assert.equal(R.displayNote({...task, acceptanceCriteria: []}), task.note);
});

test('创建只保存独立标准，不再向说明拼接一份验收要点或显示空泛标题', () => {
  const source = read('components/panels/panels-compose-draft.js');
  assert.doesNotMatch(source, /这么建，行吗|会一起写进说明|_noteWith\(/);
  assert.match(source, /const note = String\(draft\.note \|\| ''\) \+/);
});

function tagsFixture(initial = []) {
  const scope = {Event};
  scope.window = scope;
  vm.runInNewContext(read('components/requirements/requirement-fields.js'), scope);
  const handlers = {}, field = {value: JSON.stringify(initial), dispatchEvent() {}}, chips = {}, warning = {};
  const editor = {querySelector: selector => ({'[data-rq-tag-value]': field, '[data-rq-tag-input]': input,
    '[data-rq-tag-chips]': chips, '[data-rq-tag-limit]': warning})[selector]};
  const input = {value: '', focus() {}, closest: selector => selector === '[data-rq-tag-input]' ? input : editor};
  field.closest = () => editor;
  const root = {addEventListener: (name, handler) => {handlers[name] = handler;}};
  scope.RequirementFields.bindTags(root);
  return {api: scope.RequirementFields, input, field, chips, warning,
    key: extra => handlers.keydown({target: input, key: 'Enter', preventDefault() {}, stopPropagation() {}, ...extra}),
    remove: index => handlers.click({target: {closest: () => ({dataset: {rqTagRemove: String(index)}, closest: () => editor})}})};
}

test('标签Enter添加并去重，中文组合输入保留候选确认，X只删对应标签', () => {
  const f = tagsFixture(['已有']);
  f.input.value = '中文标签'; f.key({isComposing: true});
  assert.equal(f.field.value, '["已有"]');
  assert.equal(f.input.value, '中文标签');
  f.key({keyCode: 229}); assert.equal(f.field.value, '["已有"]');
  f.key();
  assert.deepEqual(JSON.parse(f.field.value), ['已有', '中文标签']);
  assert.equal(f.input.value, '');
  f.input.value = '已有，第二个'; f.key();
  assert.deepEqual(JSON.parse(f.field.value), ['已有', '中文标签', '第二个']);
  f.remove(1);
  assert.deepEqual(JSON.parse(f.field.value), ['已有', '第二个']);
  f.input.value = '未按回车';
  assert.deepEqual(Array.from(f.api.readTags(f.field)), ['已有', '第二个', '未按回车']);
});

test('标签上限不吞掉尚未添加文字，特殊字符按文本呈现', () => {
  const f = tagsFixture(Array.from({length: 20}, (_, i) => '标签' + i));
  f.input.value = '更多'; f.key();
  assert.equal(f.input.value, '更多');
  assert.equal(f.warning.hidden, false);
  assert.equal(JSON.parse(f.field.value).length, 20);
  const empty = tagsFixture();
  empty.input.value = Array.from({length: 21}, (_, i) => '标签' + i).join('，');
  const pasted = empty.input.value;
  empty.key();
  assert.equal(empty.input.value, pasted);
  assert.equal(empty.warning.hidden, false);
  assert.deepEqual(JSON.parse(empty.field.value), []);
  const html = f.api.tagHtml(['<img onerror="x">']);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
});

test('收集箱与待补充需求不能误入执行会话', () => {
  const view = views();
  for (const triageStage of ['intake', 'clarifying']) {
    const task = {...mine, triageStage, canViewExecution: true};
    assert.equal(R.canOpenConversation(task, 'device-a'), false);
    assert.doesNotMatch(view.actions(task, {}), /data-rq-chat/);
  }
});

test('the collection inbox explains the clarification flag without splitting or changing its issues', () => {
  const rows = ['intake','clarifying'].map(triageStage=>({...mine,id:triageStage,triageStage}));
  const before = JSON.stringify(rows);
  const html = views().board(rows,{archive:'active',group:'stage',limits:{}},{});
  assert.match(html,/<p class="rq-lane-hint">待整理的需求；“待补充”表示仍需完善背景或完成标准<\/p>/);
  assert.match(html,/<span>收集箱<\/span><em>2<\/em>/);
  assert.match(html,/data-hbid="clarifying"[^>]*>[\s\S]*?class="rq-flag">待补充<\/span>/);
  assert.doesNotMatch(html,/data-rq-lane="clarifying"/);
  assert.equal(R.stage(rows[0]),'intake');assert.equal(R.stage(rows[1]),'clarifying');
  assert.deepEqual(rows.map(R.column),['intake','intake']);
  assert.equal(JSON.stringify(rows),before);
});

test('卡片时间优先修改时间并精确到分钟，缺失或无效时回退创建时间', () => {
  const view = views();
  const createdAt = new Date(2026, 9, 23, 9, 10, 11).getTime();
  const updatedAt = new Date(2026, 9, 23, 12, 13, 14).getTime();
  const render = fields => view.board([{...mine, ...fields}], {archive:'active', group:'stage', limits:{}}, {});
  assert.match(render({createdAt, updatedAt}), /title="最近更新：2026\/10\/23 12:13:14（UTC[^"<]+"[^>]*>2026\/10\/23 12:13<\/time>/);
  assert.match(render({createdAt}), /title="创建时间：2026\/10\/23 09:10:11（UTC[^"<]+"[^>]*>2026\/10\/23 09:10<\/time>/);
  assert.match(render({createdAt, updatedAt:'invalid'}), /title="创建时间：2026\/10\/23 09:10:11（UTC[^"<]+"[^>]*>2026\/10\/23 09:10<\/time>/);
  assert.doesNotMatch(render({}), /Invalid Date|<time/);
});

test('各看板列固定按修改时间倒序，同分钟仍按真实秒数排序', () => {
  const rows = [];
  for (const triageStage of ['intake', 'ready']) {
    rows.push({...mine, id:triageStage+'-old', triageStage, priority:'critical', updatedAt:10000});
    rows.push({...mine, id:triageStage+'-new', triageStage, priority:'low', updatedAt:20000});
    rows.push({...mine, id:triageStage+'-fallback', triageStage, created:15000});
  }
  const html = views().board(rows, {archive:'active',group:'stage',sort:'priority',limits:{}}, {});
  for (const lane of ['intake', 'ready']) {
    assert.ok(html.indexOf('data-hbid="'+lane+'-new"') < html.indexOf('data-hbid="'+lane+'-fallback"'));
    assert.ok(html.indexOf('data-hbid="'+lane+'-fallback"') < html.indexOf('data-hbid="'+lane+'-old"'));
  }
});

test('only the moving card announces pending status and disables dragging', () => {
  const html=views().board([{...mine,triageStage:'intake'},{...mine,id:'other',triageStage:'intake'}],
    {archive:'active',group:'stage',limits:{},movingId:'own'},{});
  assert.equal((html.match(/正在变更状态/g)||[]).length,1);
  assert.match(html,/data-hbid="own" aria-busy="true" draggable="false"/);
  assert.match(html,/data-hbid="other" aria-busy="false" draggable="true"/);
  assert.match(html,/role="status"/);
});
