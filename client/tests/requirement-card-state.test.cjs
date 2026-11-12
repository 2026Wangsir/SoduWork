'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture() {
  const fields = new Map(), checks = [], handlers = {}, calls = { parse: 0, creates: [], uploads: [], created: 0 }, states = [];
  let html = '', scope = 'account-a';
  const decode = text => String(text || '').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const box = { classList: { add() {}, remove() {} }, addEventListener: (name, fn) => { handlers[name] = fn; },
    querySelector: selector => fields.get(selector.replace(/^#/, '')) || null,
    querySelectorAll: () => [...fields.values()], get innerHTML() { return html; },
    set innerHTML(value) {
      html = value; fields.clear(); checks.length = 0;
      for (const hit of value.matchAll(/<input\b([^>]*)>|<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/g)) {
        const attrs = hit[1] ?? hit[2], id = /\bid="([^"]+)"/.exec(attrs)?.[1];
        const node = { value: decode(hit[2] === undefined ? /\bvalue="([^"]*)"/.exec(attrs)?.[1] : hit[3]),
          disabled: false, attributes: new Map(),
          setAttribute(name, next) { this.attributes.set(name, String(next)); },
          getAttribute(name) { return this.attributes.get(name) ?? null; },
          removeAttribute(name) { this.attributes.delete(name); }, focus() { this.focused = true; } };
        if (id) fields.set(id, node); if (/class="cp-ck-t"/.test(attrs)) checks.push(node);
      }
      if (value.includes('id="cpCheck"')) fields.set('cpCheck', {});
      for (const id of ['cpCreate', 'cpCancel', 'cpOpen']) if (value.includes('id="' + id + '"'))
        fields.set(id, { disabled: false, addEventListener() {} });
    } };
  const ctx = { window: null, console, setTimeout, clearTimeout, tasks: [], addEventListener() {},
    document: { getElementById: id => id === 'cpDraft' ? box : fields.get(id),
      querySelectorAll: selector => selector === '.cp-ck-t' ? checks : [], addEventListener() {} },
    Requirements: { dateTimestamp: value => value },
    Store: { persistTask: async id => { calls.creates.push(id); return true; } },
    SoduWorkAPI: { taskStorageKey: () => scope, listTeammates: async () => ({ mates: [] }),
      parseTaskText: async () => { calls.parse++; return { title: '解析标题', note: '解析正文', kind: 'bug' }; },
      uploadAttachment: async (id, file) => { calls.uploads.push(file.name); return { id: file.name, filename: file.name }; } } };
  ctx.window = ctx; vm.createContext(ctx);
  for (const name of ['task-priority', 'requirement-routing', 'panels-compose-submit', 'panels-compose-draft'])
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../components/panels', name + '.js'), 'utf8'), ctx);
  const options = extra => ({ saveOnly: true, cardId: 'card-a', onCardState: state => states.push(state),
    onCreated: () => calls.created++, ...extra });
  return { ctx, box, fields, checks, handlers, calls, states, options, draft: ctx.ComposeDraft,
    scope: value => { scope = value; },
    open: extra => ctx.ComposeDraft.openWith({ title: '初始标题', note: '初始正文', checklist: ['完成验收'] }, options(extra)),
    create: () => handlers.click({ target: { closest: selector => selector === '#cpCreate' ? {} : null } }),
    input: () => handlers.input({ target: { closest: () => null } }),
  };
}

test('导航快照同步未失焦的手改字段，恢复不重解析或触发创建回调', async () => {
  const f = fixture(); await f.open();
  f.fields.get('cpTitle').value = '人工标题'; f.fields.get('cpNote').value = '人工正文';
  f.checks[0].value = '人工验收';
  const saved = f.draft.capture(); f.draft.clear();
  await f.draft.restore(saved, f.options());
  assert.equal(f.fields.get('cpTitle').value, '人工标题'); assert.equal(f.checks[0].value, '人工验收');
  assert.equal(f.calls.parse, 0); assert.equal(f.calls.created, 0);
  f.fields.get('cpNote').value = '再次修改'; f.input();
  assert.equal(f.states.at(-1).draft.note, '再次修改');
});

test('点击创建已填好的需求卡只提交字段，不重新调用模型解析', async () => {
  const f=fixture();await f.open();
  f.ctx.SoduWorkAPI.parseTaskText=async()=>assert.fail('Create must not parse the completed form again');
  f.fields.get('cpTitle').value='已确认的标题';
  f.create();await tick();
  assert.equal(f.calls.creates.length,1);
  assert.equal(f.calls.parse,0);
  assert.equal(f.states.at(-1).phase,'succeeded');
  assert.equal(f.states.at(-1).receipt.title,'已确认的标题');
});

test('提交中切走再恢复接上同一作业，完成卡恢复不重复创建或回调', async () => {
  const f = fixture(), wait = deferred();
  f.ctx.Store.persistTask = async id => { f.calls.creates.push(id); await wait.promise; return true; };
  await f.open(); f.create(); await tick();
  const saved = f.draft.capture(); assert.equal(saved.phase, 'submitting');
  f.draft.clear(); await f.draft.restore(saved, f.options());
  assert.equal(f.fields.get('cpCreate').disabled, true);
  wait.resolve(); await tick();
  assert.equal(f.calls.creates.length, 1); assert.match(f.box.innerHTML, /已创建/);
  const receipt = f.draft.capture(); assert.equal(receipt.phase, 'succeeded');
  f.draft.clear(); await f.draft.restore(receipt, f.options());
  assert.match(f.box.innerHTML, /已创建/); assert.equal(f.calls.created, 0);
  assert.equal(await f.draft.refine('不应改已完成卡'), false);
});

test('后台创建完成仍发布原卡状态，不污染后来打开的卡', async () => {
  const f = fixture(), wait = deferred(), bStates = [];
  f.ctx.Store.persistTask = async id => { f.calls.creates.push(id); await wait.promise; return true; };
  await f.open(); f.create(); await tick(); f.draft.clear();
  await f.open({ cardId: 'card-b', onCardState: value => bStates.push(value) });
  f.fields.get('cpTitle').value = '另一个会话'; wait.resolve(); await tick();
  assert.equal(f.states.at(-1).phase, 'succeeded'); assert.equal(f.states.at(-1).cardId, 'card-a');
  assert.equal(bStates.at(-1).phase, 'draft'); assert.equal(f.fields.get('cpTitle').value, '另一个会话');
});

test('部分附件上传失败的冷恢复保留稳定任务 ID 与已上传映射', async () => {
  const f = fixture(), files = [{ name: 'a.txt' }, { name: 'b.txt' }];
  f.ctx.SoduWorkAPI.uploadAttachment = async (id, file) => {
    f.calls.uploads.push(file.name); if (file.name === 'b.txt') throw Error('离线'); return { id: 'file-a', filename: file.name };
  };
  await f.open({ atts: () => files }); f.create(); await tick();
  const saved = f.draft.capture(), g = fixture();
  assert.equal(saved.phase, 'error'); assert.deepEqual(Array.from(saved.submission.uploadedIndices), [0]);
  await g.draft.restore(JSON.parse(JSON.stringify(saved)), g.options({ atts: () => files }));
  g.create(); await tick();
  assert.equal(g.calls.creates.length, 0); assert.deepEqual(g.calls.uploads, ['b.txt']);
  assert.equal(g.draft.capture().receipt.id, saved.submission.id);
});

test('账号切换后的迟到成功不发布旧账号卡片状态', async () => {
  const f = fixture(), wait = deferred();
  f.ctx.Store.persistTask = async () => { await wait.promise; return true; };
  await f.open(); f.create(); await tick(); const count = f.states.length;
  f.scope('account-b'); f.draft.clear(); wait.resolve(); await tick();
  assert.equal(f.states.length, count);
});

test('整理需求时切走，结果仍归属原卡且恢复不重复请求模型', async () => {
  const f = fixture(), wait = deferred();
  f.ctx.SoduWorkAPI.parseTaskText = async () => { f.calls.parse++; return wait.promise; };
  f.draft.open('原会话输入', f.options()); await tick();
  const saved = f.draft.capture(); f.draft.clear();
  await f.open({ cardId: 'card-b' }); f.fields.get('cpTitle').value = '新会话手改';
  wait.resolve({ title: '异步解析结果', note: '旧会话正文', kind: 'bug' }); await tick();
  assert.equal(f.states.findLast(state => state.cardId === 'card-a').phase, 'draft');
  assert.equal(f.fields.get('cpTitle').value, '新会话手改');
  f.draft.clear(); await f.draft.restore(saved, f.options());
  assert.equal(f.fields.get('cpTitle').value, '异步解析结果'); assert.equal(f.calls.parse, 1);
});

test('整理中返回原卡等待同一请求，不显示可重复创建的临时草稿', async () => {
  const f = fixture(), wait = deferred();
  f.ctx.SoduWorkAPI.parseTaskText = async () => { f.calls.parse++; return wait.promise; };
  f.draft.open('原文', f.options()); const saved = f.draft.capture(); f.draft.clear();
  await f.draft.restore(saved, f.options());
  assert.equal(f.fields.has('cpCreate'), false);
  wait.resolve({ title: '整理完成', note: '要求' }); await tick();
  assert.equal(f.fields.get('cpTitle').value, '整理完成'); assert.equal(f.calls.parse, 1);
});

test('对话创建需求先显示用户输入和思考状态，准备完成后再显示带内容的卡片', async () => {
  const f = fixture(), wait = deferred();
  f.ctx.SoduWorkAPI.listTeammates = () => wait.promise;
  const pending = f.draft.openWith({ title: '准备中的标题', note: '准备中的正文', checklist: ['完成验收'] },
    f.options({ variant: 'sheet', persistent: true }));
  assert.match(f.box.innerHTML, /cp-loading-thinking/);
  assert.match(f.box.innerHTML, /正在思考/);
  assert.equal(f.fields.has('cpTitle'), false);
  wait.resolve({ mates: [] }); await pending; await tick();
  assert.equal(f.fields.get('cpTitle').value, '准备中的标题');
  assert.match(f.box.innerHTML, /准备中的正文/);
});

test('新建需求卡提供明确的取消入口，取消后可继续普通对话', async () => {
  const f = fixture();
  await f.open({ variant: 'sheet', persistent: true, requirement: true });
  assert.match(f.box.innerHTML, /id="cpCancel">取消<\/button>/);
  assert.doesNotMatch(f.box.innerHTML, /取消新建需求/);
});

test('对话内需求卡在快速视图也显示取消入口', async () => {
  const f = fixture();
  await f.open({ variant: 'chat', persistent: true, requirement: true });
  assert.match(f.box.innerHTML, /data-cp-cancel/);
  assert.match(f.box.innerHTML, /data-cp-cancel>取消<\/button>/);
  assert.doesNotMatch(f.box.innerHTML, /取消新建需求/);
});

test('补充解析中离开仍保留手改字段与迟到结果，旧视图不重开', async () => {
  const f = fixture(), wait = deferred(); await f.open();
  f.fields.get('cpTitle').value = '手改标题';
  f.ctx.SoduWorkAPI.parseTaskText = async () => wait.promise;
  const pending = f.draft.refine('增加尾部要求'); const saved = f.draft.capture(); f.draft.clear();
  wait.resolve({ note: '补充后的执行说明' }); assert.equal(await pending, false);
  assert.equal(f.box.innerHTML, '');
  await f.draft.restore(saved, f.options());
  assert.equal(f.fields.get('cpTitle').value, '手改标题');
  assert.equal(f.fields.get('cpNote').value, '补充后的执行说明');
});

test('进程重开时整理中快照保留原文供手动核对，不自动请求模型', async () => {
  const f = fixture(); await f.draft.restore({ cardId: 'cold', ownerScope: 'account-a', phase: 'loading',
    draft: { title: '待整理标题', note: '完整待整理原文', check: [], who: { kind: 'me' } }, files: [] }, f.options({ cardId: 'cold' }));
  assert.equal(f.fields.get('cpNote').value, '完整待整理原文'); assert.equal(f.calls.parse, 0);
  assert.match(f.box.innerHTML, /尚未完成/);
});

test('补充尚未完成就重开进程时，本次补充指令也能恢复核对', async () => {
  const f = fixture(), wait = deferred(); await f.open();
  f.ctx.SoduWorkAPI.parseTaskText = async () => wait.promise;
  const work = f.draft.refine('补充尾部约束不可丢失'); const saved = f.draft.capture(); f.draft.clear();
  const g = fixture(); await g.draft.restore(JSON.parse(JSON.stringify(saved)), g.options());
  assert.match(g.fields.get('cpNote').value, /初始正文[\s\S]*补充尾部约束不可丢失/);
  assert.equal(g.calls.parse, 0); wait.resolve({}); await work;
});

test('冷恢复未确认的提交仅展示待核对状态，重试仍沿用原任务标识', async () => {
  const f = fixture(), wait = deferred();
  f.ctx.Store.persistTask = async () => { await wait.promise; return true; };
  await f.open(); f.create(); await tick(); const saved = f.draft.capture(); f.draft.clear();
  const g = fixture(); await g.draft.restore(JSON.parse(JSON.stringify(saved)), g.options());
  assert.equal(g.calls.creates.length, 0); assert.match(g.box.innerHTML, /上次提交尚未确认/);
  g.create(); await tick(); assert.deepEqual(g.calls.creates, [saved.submission.id]);
  wait.resolve(); await tick();
});

test('稳定任务 ID 落盘失败时阻止业务创建，保留可重试草稿与明确错误', async () => {
  const f = fixture(); let captured;
  await f.open({ onBeforeSubmit: async state => { captured = state; throw Error('会话卡片写入失败'); } });
  f.create(); await tick();
  assert.equal(f.calls.creates.length, 0); assert.equal(captured.phase, 'submitting');
  assert.ok(captured.submission.id); assert.equal(f.draft.capture().submission.id, captured.submission.id);
  assert.equal(f.draft.capture().phase, 'error'); assert.match(f.draft.capture().error, /写入失败/);
});

test('提交前落盘等待期间返回原卡仍锁定，持久化确认后才创建一次', async () => {
  const f = fixture(), wait = deferred();
  await f.open({ onBeforeSubmit: async () => wait.promise }); f.create(); await tick();
  assert.equal(f.calls.creates.length, 0); const saved = f.draft.capture(); f.draft.clear();
  await f.draft.restore(saved, f.options()); assert.equal(f.fields.get('cpCreate').disabled, true);
  f.create(); wait.resolve(); await tick(); assert.equal(f.calls.creates.length, 1);
});


test('提交阶段在会话恢复后保留，材料未上传完成时不能重复创建', async () => {
  const f=fixture(), before=deferred(), stored=deferred(), uploaded=deferred();
  f.ctx.Store.persistTask=async id=>{f.calls.creates.push(id);await stored.promise;return true;};
  f.ctx.SoduWorkAPI.uploadAttachment=async()=>{await uploaded.promise;return {id:'material'};};
  await f.open({onBeforeSubmit:()=>before.promise,atts:()=>[{name:'brief.txt'}]});
  f.create();await tick();
  assert.match(f.fields.get('cpCreate').textContent,/保存提交记录/);
  before.resolve();await tick();
  assert.match(f.fields.get('cpCreate').textContent,/保存需求/);
  const saved=f.draft.capture();f.draft.clear();await f.draft.restore(saved,f.options());
  assert.match(f.fields.get('cpCreate').textContent,/保存需求/);
  assert.equal(f.fields.get('cpCreate').disabled,true);
  stored.resolve();await tick();
  assert.match(f.fields.get('cpCreate').textContent,/上传材料（1\/1）/);
  f.create();assert.equal(f.calls.creates.length,1);
  uploaded.resolve();await tick();assert.equal(f.draft.capture().phase,'succeeded');
});

for (const createdField of ['createdAt', 'created']) test('创建回执保留服务端时间，冷恢复展示同一时间且不再次创建: ' + createdField, async () => {
  const f=fixture(), created=1792700000000, updated=1792700123000;
  f.ctx.Requirements=require('../core/requirements.js');
  f.ctx.Store.persistTask=async id=>{
    const task=f.ctx.tasks.find(task=>task.id===id);delete task.createdAt;
    Object.assign(task,{[createdField]:created,updatedAt:updated,assigneeName:'张负责人',assigneeUserId:'owner',priority:'high',kind:'bug'});return true;
  };
  await f.open();f.create();await tick();
  const saved=f.draft.capture();assert.equal(saved.receipt.updatedAt,updated);assert.equal(saved.receipt.createdAt,created);
  assert.match(f.box.innerHTML,/cp-receipt-time/);assert.ok(f.box.innerHTML.includes(new Date(created).toISOString()));
  assert.doesNotMatch(f.box.innerHTML,/更新于/);
  assert.equal(saved.receipt.assigneeName,'张负责人');assert.equal(saved.receipt.priority,'high');
  assert.equal(saved.receipt.kind,'bug');assert.match(f.box.innerHTML,/cp-receipt-kind\">Bug/);
  assert.match(f.box.innerHTML,/负责人.*张负责人/);assert.match(f.box.innerHTML,/is-high/);assert.match(f.box.innerHTML,/创建时间/);
  const g=fixture();g.ctx.Requirements=require('../core/requirements.js');await g.draft.restore(saved,g.options());
  assert.ok(g.box.innerHTML.includes(new Date(created).toISOString()));assert.equal(g.calls.creates.length,0);
  assert.match(g.box.innerHTML,/张负责人/);assert.match(g.box.innerHTML,/is-high/);
  assert.match(g.box.innerHTML,/cp-receipt-kind\">Bug/);
});

test('direct assignment keeps the Hub creation time in the receipt without a local task', async () => {
  const f=fixture(), created=1792700000000, updated=1792700123000;
  f.ctx.SoduWorkAPI.createAssignedTask=async () => ({task:{id:'assigned-task',created,updatedAt:updated}});
  const card={cardId:'assigned-card',ownerScope:'account-a',files:[]};
  await f.ctx.ComposeDraftSubmit.createRequirement({
    card, state:{}, options:{}, draft:{title:'Assigned requirement',check:[],who:{kind:'mate',id:'colleague'}},
    box:f.box, btn:{}, current:()=>false, done(){}, note:'Keep the confirmed creation time.',
  });
  assert.equal(card.phase,'succeeded');assert.equal(card.receipt.createdAt,created);
  assert.equal(card.receipt.updatedAt,updated);assert.equal(f.ctx.tasks.length,0);
});
