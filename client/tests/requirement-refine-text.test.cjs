'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const decode = value => String(value || '').replace(/&quot;/g, '"').replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

// The production renderer writes HTML; retain its form values so _sync also
// sees manual edits. Only the network/model boundary is replaced.
function fixture(parse) {
  const fields = new Map(), checks = [], requests = [], executionRequests = [], handlers = {}, persisted = [];
  let html = '';
  const box = {
    classList: { add() {}, remove() {} },
    addEventListener: (kind, handler) => { handlers[kind] = handler; },
    querySelector: selector => fields.get(selector.replace(/^#/, '')) || null,
    querySelectorAll: () => [],
    get innerHTML() { return html; },
    set innerHTML(value) {
      html = value; fields.clear(); checks.length = 0;
      for (const hit of value.matchAll(/<input\b([^>]*)>|<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/g)) {
        const attrs = hit[1] ?? hit[2], id = /\bid="([^"]+)"/.exec(attrs)?.[1];
        const node = { value: decode(hit[2] === undefined ? /\bvalue="([^"]*)"/.exec(attrs)?.[1] : hit[3]),
          attributes: {}, setAttribute(name, value) { this.attributes[name] = value; }, focus() {} };
        if (id) fields.set(id, node);
        if (/\bclass="cp-ck-t"/.test(attrs)) checks.push(node);
      }
      if (value.includes('id="cpCheck"')) fields.set('cpCheck', {});
      if (value.includes('id="cpCreate"')) fields.set('cpCreate', { disabled: false });
    },
  };
  const ctx = { window: null, setTimeout, clearTimeout, console,
    document: { getElementById: id => id === 'cpDraft' ? box : fields.get(id) || null,
      querySelectorAll: selector => selector === '.cp-ck-t' ? checks : [], addEventListener() {} },
    addEventListener() {}, tasks: [], Requirements: { dateTimestamp: () => null },
    Store: { persistTask: async id => { persisted.push(JSON.parse(JSON.stringify(ctx.tasks.find(task => task.id === id)))); return true; } },
    SoduWorkAPI: {
      parseTaskText: async (...args) => { requests.push(args); return parse(...args); },
      taskExecutionOptions: async body => { executionRequests.push(body); return { substrates: [], workflows: [], repos: [] }; },
      listTeammates: async () => ({ mates: [] }), workCatalog: async () => ({ scenarios: [] }),
    },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  for (const name of ['task-priority', 'task-execution-client', 'requirement-routing', 'panels-compose-submit', 'panels-compose-draft']) {
    const file = path.join(__dirname, '../components/panels', name + '.js');
    vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: file });
  }
  return { draft: ctx.ComposeDraft, requests, executionRequests, persisted, box, fields, checks, handlers,
    open: (data, options) => ctx.ComposeDraft.openWith({ title: '原需求', note: '原始说明', ...data }, { saveOnly: true, ...options }),
    value: id => fields.get(id)?.value,
  };
}

function parsedRequest(text) {
  const marker = '\n用户补充：', split = text.indexOf(marker);
  const start = text.indexOf('当前需求：') + '当前需求：'.length;
  return { current: JSON.parse(text.slice(start, split)), change: text.slice(split + marker.length) };
}

test('oversized manual titles remain editable and cannot be persisted', async () => {
  for (const title of ['x'.repeat(201), '\u6807'.repeat(201), '\u{1F600}'.repeat(101)]) {
    const f = fixture(() => ({})); await f.open({});
    f.fields.get('cpTitle').value = title;
    f.handlers.click({ target: { closest: selector => selector === '#cpCreate' ? {} : null } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.persisted.length, 0);
    assert.equal(f.value('cpTitle'), title);
    assert.equal(f.fields.get('cpTitle').attributes['aria-invalid'], 'true');
  }
});

test('the 200 UTF-16-unit title boundary matches task synchronization', async () => {
  for (const title of ['x'.repeat(200), '\u6807'.repeat(200), '\u{1F600}'.repeat(100)]) {
    const f = fixture(() => ({})); await f.open({});
    f.fields.get('cpTitle').value = title;
    f.handlers.click({ target: { closest: selector => selector === '#cpCreate' ? {} : null } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.persisted.length, 1);
    assert.equal(f.persisted[0].title, title);
  }
});

test('1501-2000 character original request survives task parsing and creation unchanged', async () => {
  const f = fixture(() => ({ title: '短标题', note: '模型改写后的摘要' }));
  const raw = '  /需求 #1\r\n' + '原文'.repeat(800) + '\n  ';
  f.draft.open(raw, { saveOnly: true, model: () => 'fixture' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.requests[0][0], raw);
  assert.equal(f.requests[0][3].instruction, raw);
  assert.equal(f.value('cpNote'), raw);
  f.handlers.click({ stopPropagation() {}, target: { closest: selector => selector === '#cpCreate' ? {} : null } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.persisted.length, 1);
  assert.equal(f.persisted[0].note, raw);
});

for (const persistent of [true, false]) {
  test('send cleanup preserves only a persistent successful requirement: ' + persistent, async () => {
    const f = fixture(() => ({})); let closed = 0;
    await f.draft.restore({ cardId: 'saved-requirement', phase: 'succeeded',
      receipt: { id: 'task-saved', title: '已创建的需求', who: {kind:'me'} } },
      { persistent, requirement: true, onClose: () => { closed++; } });
    const html = f.box.innerHTML;
    f.draft.clear({ preserveCreatedRequirement: true });
    assert.equal(closed, persistent ? 0 : 1);
    assert.equal(f.box.innerHTML, persistent ? html : '');
    assert.equal(f.draft.capture()?.receipt?.id, persistent ? 'task-saved' : undefined);
    if (persistent) {
      f.draft.clear();
      assert.equal(closed, 1, 'navigation can still unmount a successful card');
      assert.equal(f.box.innerHTML, '');
    }
  });
}

test('send cleanup still closes an unfinished persistent requirement', async () => {
  const f = fixture(() => ({})); let closed = 0;
  await f.open({}, { persistent: true, requirement: true, onClose: () => { closed++; } });
  f.draft.clear({ preserveCreatedRequirement: true });
  assert.equal(closed, 1);
  assert.equal(f.draft.capture(), null);
  assert.equal(f.box.innerHTML, '');
});

test('parse retry keeps edited fields on failure and can recover without creating or appending instructions', async () => {
  let result = { _parseError: '需求解析超时，原文已保留，请重试' };
  const f = fixture(() => result);
  f.draft.open('原始目标', { variant: 'sheet', model: () => 'chosen', attachmentContext: [{ name: '原件', mode: 'metadata' }] });
  await new Promise(resolve => setImmediate(resolve));
  assert.doesNotMatch(f.box.innerHTML, /cpParseRetry|cp-parse-retry/);
  f.fields.get('cpNote').value = '用户已修改的说明';
  const retry = () => f.draft.refine('重试');
  retry(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.value('cpNote'), '用户已修改的说明');
  assert.deepEqual(f.requests[1], f.requests[0], 'retry reuses original request; edits remain in the draft');
  assert.equal(f.requests[1][1], 'chosen');
  assert.equal(f.requests[1][2][0].name, '原件');
  result = { title: '整理后的目标', note: '整理后的完整说明', checklist: ['验收结果'] };
  retry(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.value('cpNote'), '用户已修改的说明');
  assert.doesNotMatch(f.box.innerHTML, /cpParseRetry|需求解析超时/);
  assert.equal(f.persisted.length, 0);
});

test('repeated chat retries start one request; its late result cannot replace another draft', async () => {
  const pending = deferred(); let retrying = false;
  const f = fixture(() => retrying ? pending.promise : { _parseError: '暂时失败' });
  f.draft.open('第一条', { variant: 'sheet' });
  await new Promise(resolve => setImmediate(resolve));
  retrying = true;
  const click = () => f.draft.refine('重试');
  click(); click();
  assert.equal(f.requests.length, 2, 'one initial request and one retry');
  await f.open({ title: '另一个需求', note: '另一条正文' });
  pending.resolve({ title: '迟到结果', note: '不应覆盖新表单' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.value('cpTitle'), '另一个需求');
  assert.equal(f.value('cpNote'), '另一条正文');
  assert.equal(f.persisted.length, 0);
});

test('refinement gives the parser the full existing note, including its final constraints', async () => {
  const note = '已有边界与明细。'.repeat(700) + '\n原说明尾部：不得发布或变更业务库。';
  const f = fixture(() => ({ note: '模型只返回摘要。' }));
  await f.open({ note });
  assert.equal(await f.draft.refine('增加验收记录。'), true);
  assert.equal(parsedRequest(f.requests[0][0]).current.note.length, note.length);
  assert.equal(parsedRequest(f.requests[0][0]).current.note, note);
  assert.equal(f.value('cpNote'), note + '\n\n补充要求（与上文冲突时以本次补充为准）：\n增加验收记录。');
});

test('refinement sends all supplementary text and retains its final requirement', async () => {
  const change = '逐项修复缺陷并记录证据。'.repeat(450) + '\n补充尾部：交付完整CSV附件。';
  const f = fixture(() => ({ note: '模型仅概括补充内容。' }));
  await f.open();
  await f.draft.refine(change);
  assert.equal(parsedRequest(f.requests[0][0]).change.length, change.length);
  assert.equal(parsedRequest(f.requests[0][0]).change, change);
  assert.equal(f.value('cpNote'), '原始说明\n\n补充要求（与上文冲突时以本次补充为准）：\n' + change);
});

test('a parser failure appends the complete supplement for manual editing', async () => {
  const change = '失败后仍需保留的完整要求。'.repeat(300) + '\n末尾验收：交付截图。';
  const f = fixture(() => { throw Error('isolated model failure'); });
  await f.open();
  assert.equal(await f.draft.refine(change), true);
  assert.ok(f.value('cpNote').endsWith('末尾验收：交付截图。'));
  assert.equal(f.value('cpNote'), '原始说明\n\n补充要求（与上文冲突时以本次补充为准）：\n' + change);
});

test('an incomplete parse without a note cannot silently discard a textual supplement', async () => {
  const f = fixture(() => ({ title: '补充后的标题' }));
  await f.open();
  await f.draft.refine('增加异常回滚日志。');
  assert.equal(f.value('cpNote'), '原始说明\n\n补充：增加异常回滚日志。');
  assert.equal(f.value('cpTitle'), '补充后的标题');
});

test('refinement starts from current manual edits and keeps fields absent from the response', async () => {
  const f = fixture(text => ({ note: parsedRequest(text).current.note + '\n补充记录。' }));
  await f.open({ checklist: ['原验收'], due: '2026-10-16', priority: 'high' });
  f.fields.get('cpTitle').value = '手动标题';
  f.fields.get('cpNote').value = '手动改过的说明';
  f.fields.get('cpDue').value = '2026-10-31';
  f.checks[0].value = '手动验收条件';
  await f.draft.refine('补充记录。');
  const sent = parsedRequest(f.requests[0][0]).current;
  assert.equal(sent.note, '手动改过的说明');
  assert.equal(sent.priority, 'high');
  assert.equal(f.value('cpTitle'), '手动标题');
  assert.equal(f.value('cpDue'), '2026-10-31');
  assert.deepEqual(f.checks.map(row => row.value), ['手动验收条件']);
  assert.match(f.box.innerHTML, /<b>高<\/b>/);
});

test('a successful short edit may replace obsolete text without reappending the original', async () => {
  const f = fixture(() => ({ note: '仅交付PDF。' }));
  await f.open({ note: '交付PDF和CSV。' });
  await f.draft.refine('取消CSV，只交付PDF。');
  assert.equal(f.value('cpNote'), '仅交付PDF。');
});

test('initial loading and saving retain complete long material and manual edits even if parsing returns a short summary', async () => {
  const original = '完整的初始需求。'.repeat(600) + '\n初始尾部标记';
  const f = fixture(() => ({ title: '整理后的标题', note: '整理后的需求说明' }));
  f.draft.open(original, { saveOnly: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.requests[0][0], original);
  assert.equal(f.executionRequests.length, 0, '创建不请求执行选项');
  assert.equal(f.value('cpNote')?.length, original.length);
  assert.equal(f.value('cpNote'), original);
  const edited = original + '\n人工补充：交付完整证据。';
  f.fields.get('cpNote').value = edited;
  f.handlers.click({ stopPropagation() {}, target: { closest: selector => selector === '#cpCreate' ? {} : null } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.persisted.length, 1, '确认创建必须实际保存一次');
  assert.equal(f.persisted[0].note, edited);
  assert.equal(f.persisted[0].executionContext, null);
  assert.equal(f.executionRequests.length, 0);
});

test('short standalone input continues to use the parsed note without duplicating the source', async () => {
  const f = fixture(() => ({ note: '整理后的简短说明' }));
  f.draft.open('写一份简短说明。', { saveOnly: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.value('cpNote'), '整理后的简短说明');
});

test('解析被拒绝时显示原因并完整保留输入', async () => {
  const f = fixture(() => ({ _parseError: '附件内容超过解析上限，请拆分后重试' }));
  f.draft.open('根据完整缺陷文档修复', { saveOnly: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(f.box.innerHTML, /超过解析上限/);
  assert.equal(f.value('cpNote'), '根据完整缺陷文档修复');
});

test('引用会话时描述使用整理结果，完整原文独立保留并可编辑', async () => {
  const original = '当前要求：修复这份清单。\n对话材料：一、导出失败；二、重复导入。';
  const f = fixture(() => ({ note: '修复缺陷清单。' }));
  f.draft.open(original, { saveOnly: true, conversationContext: { text: '一、导出失败；二、重复导入。' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.value('cpNote'), '修复缺陷清单。');
  assert.equal(f.value('cpSourceNote'), original);
  f.fields.get('cpSourceNote').value = '人工确认的缺陷原文。';
  f.handlers.click({ stopPropagation() {}, target: { closest: selector => selector === '#cpCreate' ? {} : null } });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(f.persisted[0].note, /^修复缺陷清单。/);
  assert.ok(f.persisted[0].note.endsWith('人工确认的缺陷原文。'));
  assert.doesNotMatch(f.persisted[0].note, /二、重复导入/);
});

test('引用修复任务的标题、说明和业务验收不会被聊天原文覆盖', async () => {
  const source = '上轮讨论。'.repeat(800) + '\n缺陷尾项：导出失败应显示错误原因。';
  const parsed = { title: '修复工作目标分析导出缺陷', kind: 'bug', note: '修复文档导出失败并验证错误提示。',
    checklist: ['导出文档包含完整内容', '导出失败显示可操作错误提示'] };
  const f = fixture(() => parsed);
  f.draft.open('把这个缺陷文档转给高示例成员修复\n' + source, {
    saveOnly: true, conversationContext: { text: source }, instruction: '把这个缺陷文档转给高示例成员修复' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.value('cpTitle'), parsed.title);
  assert.equal(f.value('cpNote'), parsed.note);
  assert.deepEqual(f.checks.map(row => row.value), parsed.checklist);
  assert.ok(f.value('cpSourceNote').endsWith('导出失败应显示错误原因。'));
  f.fields.get('cpSourceNote').value = '手动保留：导出失败应显示错误原因。';
  await f.draft.refine('补充回归记录。');
  assert.equal(parsedRequest(f.requests[1][0]).current.sourceNote, '手动保留：导出失败应显示错误原因。');
  assert.equal(f.value('cpSourceNote'), '手动保留：导出失败应显示错误原因。');
  assert.equal(f.value('cpNote'), parsed.note);
});

test('引用解析失败时保留本次要求和完整来源，不用历史会话冒充整理后的描述', async () => {
  const f = fixture(() => ({}));
  f.draft.open('把这份文档交给同事修复\n全部对话', { saveOnly: true,
    instruction: '把这份文档交给同事修复', conversationContext: { text: '全部对话' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.value('cpNote'), '把这份文档交给同事修复');
  assert.ok(f.value('cpSourceNote').endsWith('全部对话'));
  assert.match(f.box.innerHTML, /未能整理/);
});

test('supplementing referenced material preserves manual edits without restoring deleted source', async () => {
  const f = fixture(() => ({ title: '更新后的标题', note: '模型摘要', checklist: ['回归通过'] }));
  await f.open({ note: '保留项目A；删除项目B。' }, { conversationContext: { text: '保留项目A；删除项目B。' } });
  f.fields.get('cpNote').value = '手动确认：只处理项目A。';
  await f.draft.refine('新增项目C。');
  assert.equal(f.value('cpNote'), '手动确认：只处理项目A。\n\n补充要求（与上文冲突时以本次补充为准）：\n新增项目C。');
  assert.equal(f.value('cpTitle'), '更新后的标题');
  assert.deepEqual(f.checks.map(row => row.value), ['回归通过']);
  assert.doesNotMatch(f.value('cpNote'), /项目B/);
});

test('a later conversation reference retains full material in an initially standalone draft', async () => {
  const f = fixture(() => ({ note: '概括后的说明。' }));
  await f.open({ note: '原来是独立需求。' });
  const change = '参考上文补充：项目A的导出必须保留原始表头。';
  await f.draft.refine(change, { conversationContext: { text: '项目A的导出必须保留原始表头。' } });
  assert.equal(f.value('cpNote'), '概括后的说明。');
  assert.equal(f.value('cpSourceNote'), change);
});

test('再次引用新材料时保留手动原文并追加完整新来源，不用长会话覆盖摘要', async () => {
  const f = fixture(() => ({ note: '更新后的修复目标。' }));
  f.draft.open('修复原缺陷\n原始材料', { saveOnly: true, instruction: '修复原缺陷', conversationContext: { text: '原始材料' } });
  await new Promise(resolve => setImmediate(resolve));
  f.fields.get('cpSourceNote').value = '手动确认的原文';
  const source = '新缺陷文档内容。'.repeat(500) + '新增末尾要求';
  const change = '再加入这份文档\n' + source;
  await f.draft.refine(change, { instruction: '再加入这份文档', conversationContext: { text: source } });
  assert.equal(f.value('cpNote'), '更新后的修复目标。');
  assert.equal(f.value('cpSourceNote'), '手动确认的原文\n\n补充参考原文：\n' + change);
  assert.doesNotMatch(f.value('cpSourceNote'), /原始材料/);
});

for (const fail of [false, true]) {
  test('closing a draft ignores its late ' + (fail ? 'failed' : 'successful') + ' refinement', async () => {
    const pending = deferred(), f = fixture(() => pending.promise);
    await f.open();
    const request = f.draft.refine('不应在关闭后回填。');
    f.draft.clear();
    if (fail) pending.reject(Error('late failure')); else pending.resolve({ note: '迟到的说明' });
    assert.equal(await request, false);
    assert.equal(f.box.innerHTML, '');
  });
}

test('closing and reopening a draft rejects the old refinement response', async () => {
  const pending = deferred(), f = fixture(() => pending.promise);
  await f.open();
  const request = f.draft.refine('旧表单的补充');
  f.draft.clear();
  await f.open({ title: '新的需求', note: '新表单的内容' });
  pending.resolve({ title: '旧标题', note: '迟到的旧说明' });
  assert.equal(await request, false);
  assert.equal(f.value('cpTitle'), '新的需求');
  assert.equal(f.value('cpNote'), '新表单的内容');
});

test('retry reuses original input, attachments and model, blocks duplicates and clears the warning', async () => {
  const pending = deferred(); let calls = 0, model = 'original-model';
  const f = fixture(() => ++calls === 1 ? { _parseError: '模型超时' } : pending.promise);
  f.draft.open('完整原文', { model: () => model, attachmentContext: [{ name: '材料', text: '附件全文' }] });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(f.box.innerHTML, /cp-parse-warning/);
  model = 'later-selection';
  const retry = f.draft.refine('重试');
  assert.equal(await f.draft.refine('重试'), false);
  assert.deepEqual(f.requests[1], f.requests[0]);
  pending.resolve({ title: '整理成功', note: '完整需求说明' });
  assert.equal(await retry, true);
  assert.equal(f.value('cpNote'), '完整需求说明');
  assert.doesNotMatch(f.box.innerHTML, /cpParseRetry|模型超时/);
  assert.equal(f.persisted.length, 0);
});

test('retry failure retains its input and late retry cannot replace a new card', async () => {
  const pending = deferred(); let calls = 0;
  const f = fixture(() => ++calls < 3 ? { _parseError: '模型忙' } : pending.promise);
  f.draft.open('完整原文', {});
  await new Promise(resolve => setImmediate(resolve));
  await f.draft.refine('重试');
  assert.equal(f.value('cpNote'), '完整原文');
  assert.match(f.box.innerHTML, /cp-parse-warning/);
  const retry = f.draft.refine('重试');
  f.draft.clear();
  await f.open({ note: '另一会话的内容' });
  pending.resolve({ note: '旧结果' });
  assert.equal(await retry, false);
  assert.equal(f.value('cpNote'), '另一会话的内容');
});

test('chat retry and restored failed draft keep the same request', async () => {
  let calls = 0;
  const f = fixture(() => ++calls === 1 ? { _parseError: '超时' } : { note: '恢复后成功' });
  f.draft.open('原文', {});
  await new Promise(resolve => setImmediate(resolve));
  const saved = f.draft.capture(); f.draft.clear();
  await f.draft.restore(saved, {});
  f.draft.refine('重试');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.requests[1], f.requests[0]);
  assert.equal(f.value('cpNote'), '恢复后成功');
});

test('retry does not overwrite fields manually edited after failure', async () => {
  let calls = 0;
  const f = fixture(() => ++calls === 1 ? { _parseError: '超时' } : { title: '模型标题', note: '模型内容' });
  f.draft.open('原文', {});
  await new Promise(resolve => setImmediate(resolve));
  f.fields.get('cpTitle').value = '手动标题';
  f.fields.get('cpNote').value = '手动保留内容';
  await f.draft.refine('重试');
  assert.equal(f.value('cpTitle'), '手动标题');
  assert.equal(f.value('cpNote'), '手动保留内容');
});
