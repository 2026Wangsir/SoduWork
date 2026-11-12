'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const read = name => fs.readFileSync(path.join(__dirname, '../components/panels', name + '.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(inline = true) {
  let state = null, bridge, owner = 'alice';
  const calls = { opens: 0, restores: 0, added: [], changes: [], closes: [], dialogs: [] }, children = new Map();
  const node = () => ({ isConnected: true, classList: { add() {} }, attributes: {}, dataset: {},
    setAttribute(name, value) { this.attributes[name] = value; }, removeAttribute(name) { delete this.attributes[name]; },
    querySelector(selector) { if (!children.has(selector)) children.set(selector, node()); return children.get(selector); },
    appendChild() {}, append() {}, replaceChildren() {}, addEventListener() {}, focus() {},
    showModal() { this.open = true; }, close() { this.open = false; }, remove() { this.isConnected = false; } });
  const ctx = { window: null, document: { documentElement: { dataset: {} }, body: node(), addEventListener() {}, createElement: tag => {
    const element = node(); if (tag === 'dialog') calls.dialogs.push(element); return element;
  }, getElementById: () => node() },
    addEventListener() {}, SoduWorkAPI: { taskStorageKey: () => owner },
    PluginUIHost: { registerAction() {}, mount: () => ({ inline, content: node(), destroy() {} }) },
    ConversationAttachments: { create: options => {
      let files = [];
      return { add: (value, source) => { files.push(...value); calls.added.push({ files: value, source }); options.onChange?.(); },
        files: () => files, destroy() {}, clear: () => { files = []; options.onChange?.(); } };
    } },
    ComposeDraft: {
      capture: () => state,
      clear: () => { const saved = state; state = null; bridge?.onClose?.(saved); },
      open: (text, options) => { calls.opens++; bridge = options; state = { ownerScope: owner, phase: 'draft', draft: { note: text }, files: options.atts() }; },
      restore: (saved, options) => { calls.restores++; state = saved; bridge = options; },
      notifyCardState: () => { if (state) { state.files = bridge.atts(); bridge.onCardState?.(state); } },
      refine: async () => true,
    } };
  ctx.window = ctx; vm.createContext(ctx); vm.runInContext(read('work-entry-sheet'), ctx);
  const seed = extra => ({ text: '需求', cardId: 'card', onCardState: value => calls.changes.push(value),
    onCardClose: value => calls.closes.push(value), ...extra });
  return { ctx, calls, children, sheet: ctx.WorkEntrySheet, seed, bridge: () => bridge, scope: value => { owner = value; } };
}

test('需求默认仅相关人可见，显式团队共享仍保留', () => {
  for (const inline of [true, false]) {
    const f = fixture(inline);
    f.sheet.openTask(f.seed());
    assert.equal(f.bridge().visibility, 'related');
    f.sheet.openTask(f.seed({ cardId: 'shared', visibility: 'organization' }));
    assert.equal(f.bridge().visibility, 'organization');
  }
});

test('切会话静默卸载不折叠记录，主动关闭先捕获字段再通知原卡', () => {
  const f = fixture(); f.sheet.openTask(f.seed()); f.sheet.close(false, true);
  assert.equal(f.calls.closes.length, 0); assert.equal(f.calls.changes.at(-1).draft.note, '需求');
  f.sheet.openTask(f.seed()); const snapshot = f.sheet.capture(); snapshot.draft.note = '未失焦的修改';
  f.sheet.close(); assert.equal(f.calls.closes.length, 1);
  assert.equal(f.calls.closes[0].draft.note, '未失焦的修改');
});

test('恢复直接消费卡片和附件原件，已完成卡不继续吸收新补充', async () => {
  const f = fixture(), file = new File(['材料正文'], '原稿.md');
  const saved = { cardId: 'card', ownerScope: 'alice', phase: 'succeeded', files: [file], receipt: { id: 'task' } };
  f.sheet.openTask(f.seed({ cardState: saved }));
  assert.equal(f.calls.restores, 1); assert.equal(f.calls.opens, 0);
  assert.equal(f.calls.added[0].source, 'card-restore'); assert.equal(f.sheet.capture().files[0], file);
  assert.equal(f.sheet.active(), null); assert.equal(await f.sheet.refine('新的独立任务'), false);
});

test('迟到的旧表单关闭回调不能卸载新卡，账号切换不能发布旧卡', () => {
  const f = fixture(); f.sheet.openTask(f.seed()); const old = f.bridge();
  f.sheet.openTask(f.seed({ text: '新卡', cardId: 'new' })); old.onClose();
  assert.equal(f.sheet.capture().draft.note, '新卡');
  const count = f.calls.changes.length; f.scope('bob'); f.sheet.close(false, true);
  assert.equal(f.calls.changes.length, count);
});

test('自动化已保存表面也能被静默卸载，不以可补充状态误判是否存在', () => {
  const f = fixture(); let closed = 0;
  f.ctx.WorkAutomationSheet = { hasSurface: () => true, active: () => null, close: silent => { assert.equal(silent, true); closed++; } };
  f.sheet.close(false, true); assert.equal(closed, 1);
});

test('补充解析等待期间，新增材料已归入原卡而非等待解析结束才添加', async () => {
  const f = fixture(); f.sheet.openTask(f.seed()); let finish;
  f.ctx.ComposeDraft.refine = () => new Promise(resolve => { finish = resolve; });
  const file = new File(['尾部'], '补充.md');
  const work = f.sheet.refine('参考补充', { conversationContext: { files: [file] } }); await tick();
  assert.equal(f.calls.changes.at(-1).files[0], file);
  f.sheet.close(false, true); finish(true); await work;
});

test('恢复卡片和正常新增的附件都不会自动上传资料库', async () => {
  const tracked = [], ctx = { window: null, File, Blob, URL, Uint8Array, console,
    LibraryTransfer: { trackFile: file => { tracked.push(file.name); return {}; } } };
  ctx.window = ctx; vm.createContext(ctx); vm.runInContext(read('conversation-attachments'), ctx);
  const attachments = ctx.ConversationAttachments.create({});
  attachments.add([new File(['旧原文'], '原稿.md')], 'card-restore'); await tick();
  assert.deepEqual(tracked, []);
  attachments.add([new File(['新增'], '补充.md')], 'pick'); await tick();
  assert.deepEqual(tracked, []); assert.equal(attachments.files().length, 2);
  attachments.destroy();
});

test('恢复归属被拒绝时显示可见错误且不留下可补充或覆盖原稿的空壳', async () => {
  const f = fixture();
  // Use the real ownership gate, not a fake restore success that bypasses it.
  vm.runInContext(read('panels-compose-submit'), f.ctx);
  f.ctx.ComposeDraft.restore = async (saved, options) => f.ctx.ComposeDraftSubmit.card(options, saved);
  const saved = { cardId: 'card', ownerScope: 'another-account', phase: 'draft', draft: { title: '原稿', note: '保留正文' } };
  await assert.rejects(f.sheet.openTask(f.seed({ cardState: saved })), /账号或服务已切换/);
  assert.match(f.children.get('#wesTaskDraft')?.textContent || '', /账号或服务已切换/);
  assert.equal(f.children.get('#wesTaskDraft').attributes.role, 'alert');
  assert.equal(f.children.get('.wes-attach-zone').inert, true);
  assert.equal(f.sheet.active(), null);
  assert.equal(f.sheet.capture(), null);
  assert.equal(await f.sheet.refine('不能补充到恢复失败的卡'), false);
  f.sheet.close(false, true);
  assert.equal(f.calls.changes.length, 0, 'failed restoration must not overwrite the stored draft');
  assert.equal(saved.draft.note, '保留正文');
});

test('恢复归属拒绝后自愈巡检不创建空表单，正常重开仍允许修复丢失内容', async () => {
  const f = fixture(), timers = [], cleared = [], repaired = [];
  f.ctx.setInterval = callback => { timers.push(callback); return timers.length; };
  f.ctx.clearInterval = id => cleared.push(id);
  f.ctx.ComposeDraft.repaint = () => { repaired.push('repaint'); return false; };
  f.ctx.ComposeDraft.openWith = () => { repaired.push('openWith'); };
  vm.runInContext(read('panels-compose-submit'), f.ctx);
  f.ctx.ComposeDraft.restore = async (saved, options) => f.ctx.ComposeDraftSubmit.card(options, saved);
  const saved = { cardId: 'card', ownerScope: 'another-account', phase: 'draft', draft: { title: '原稿', note: '保留正文' } };
  await assert.rejects(f.sheet.openTask(f.seed({ cardState: saved })), /账号或服务已切换/);
  const message = f.children.get('#wesTaskDraft').textContent;
  for (let index = 0; index < 3; index++) timers[0]();
  assert.deepEqual(repaired, [], 'a rejected restore must never become an editable empty draft');
  assert.match(message, /账号或服务已切换/);
  assert.equal(f.children.get('#wesTaskDraft').textContent, message);
  assert.equal(f.children.get('.wes-attach-zone').inert, true);
  assert.equal(f.sheet.active(), null); assert.equal(f.sheet.capture(), null);
  assert.ok(cleared.includes(1), 'the failed surface must stop its repair timer');
  assert.equal(f.calls.changes.length, 0);
  f.sheet.openTask(f.seed({ cardId: 'new', text: '新的可编辑需求' }));
  timers[1]();
  assert.deepEqual(repaired, ['repaint', 'openWith'], 'a new authorized surface retains its own repair loop');
  assert.equal(f.sheet.active()?.actionId, 'work.requirement.create');
  assert.equal(f.sheet.capture()?.draft.note, '新的可编辑需求');
});

test('旧恢复请求迟到失败不能覆盖已打开的新表单', async () => {
  const f = fixture(); let reject;
  f.ctx.ComposeDraft.restore = () => new Promise((_, fail) => { reject = fail; });
  const pending = f.sheet.openTask(f.seed({ cardState: { ownerScope: 'alice', phase: 'draft' } }));
  f.sheet.openTask(f.seed({ cardId: 'new', text: '新表单' }));
  reject(Error('旧恢复失败')); await assert.rejects(pending, /旧恢复失败/);
  assert.equal(f.sheet.active()?.actionId, 'work.requirement.create');
  assert.equal(f.sheet.capture()?.draft.note, '新表单');
  assert.equal(f.children.get('#wesTaskDraft')?.textContent, undefined);
  assert.notEqual(f.children.get('.wes-attach-zone').inert, true);
});

test('需求池成功关闭创建卡并显示结果弹窗，内联会话仍保留回执', () => {
  const f = fixture(false); f.sheet.openTask(f.seed({ saveOnly: true }));
  Object.assign(f.sheet.capture(), { phase: 'succeeded', receipt: { id: 'saved' } });
  f.bridge().onCreated('saved', '已保存的需求', {});
  assert.equal(f.sheet.capture(), null);
  assert.equal(f.calls.dialogs.length, 1);
  assert.equal(f.calls.dialogs[0].open, true);
  const chat = fixture(true); chat.sheet.openTask(chat.seed({ saveOnly: true }));
  chat.bridge().onCreated('saved', '会话内创建', {});
  assert.ok(chat.sheet.capture()); assert.equal(chat.calls.dialogs.length, 0);
});

test('需求池提交失败显示弹窗并保留原草稿，关闭重开不遗留旧提示', () => {
  const f = fixture(false); f.sheet.openTask(f.seed({ saveOnly: true }));
  const saved = f.sheet.capture(); saved.draft.note = '必须保留的说明';
  assert.equal(f.bridge().onSubmitError(Error('连接失败'), { stored: false }), true);
  assert.equal(f.sheet.capture(), saved); assert.equal(f.calls.dialogs.length, 1);
  f.sheet.openTask(f.seed({ saveOnly: true, text: '新的独立需求' }));
  assert.equal(f.calls.dialogs[0].isConnected, false);
  assert.equal(f.sheet.capture().draft.note, '新的独立需求');
});

test('旧需求结果与账号切换不能关闭新表单或弹出旧结果', () => {
  const f = fixture(false); f.sheet.openTask(f.seed({ saveOnly: true })); const old = f.bridge();
  f.sheet.openTask(f.seed({ saveOnly: true, text: '新表单' }));
  old.onCreated('old', '旧结果', {});
  assert.equal(f.sheet.capture().draft.note, '新表单'); assert.equal(f.calls.dialogs.length, 0);
  f.scope('bob'); f.bridge().onCreated('old-account', '旧账号', {});
  assert.equal(f.calls.dialogs.length, 0); assert.ok(f.sheet.capture());
});

for (const [label, inline, restored, handedOff] of [
  ['会话内自己的需求', true, false, false],
  ['切走返回的持久化回执', true, true, false],
  ['会话内已交办需求', true, false, true],
  ['全屏创建抽屉', false, false, false],
]) test(label + '的查看详情先关闭创建卡再跳需求池并定位原需求', () => {
  const f = fixture(inline), routes = [], bound = [], direct = [], buttons = {};
  f.ctx.__deskPanel = 'workspace';
  f.ctx.WorkspaceHost = { open(view, options) {
    assert.equal(f.sheet.capture(), null, 'the entry surface must close before navigation');
    routes.push({ view, ...options });
  } };
  f.ctx.openDetailEntry = id => direct.push(id);
  const state = { cardId: 'saved-card', ownerScope: 'alice', phase: 'succeeded', files: [], receipt: { id: 'saved-task', title: '原需求' } };
  f.sheet.openTask(f.seed({ bridge: { onOpen: id => bound.push(id) }, ...(restored ? { cardState: state } : {}) }));
  vm.runInContext(read('panels-compose-submit'), f.ctx);
  const box = { innerHTML: '', querySelector: selector => buttons[selector] ||= { addEventListener(_event, fn) { this.click = fn; } } };
  f.ctx.ComposeDraftSubmit.done({ ...f.bridge(), box, id: 'saved-task', title: '原需求', gone: handedOff, restored, esc: String });
  assert.match(box.innerHTML, /查看详情/);
  buttons['#cpOpen'].click();
  assert.deepEqual(routes, [{ view: 'history', requirementId: 'saved-task' }]);
  assert.deepEqual(bound, [], 'viewing a receipt must not bind or start an execution session');
  assert.deepEqual(direct, [], 'workspace navigation must select the requirement pool, not overlay the chat');
  assert.equal(f.calls.closes.length, inline ? 0 : 1,
    'inline detail navigation must preserve the card; independent sheets still close');
  if (inline) assert.doesNotMatch(box.innerHTML, /data-cp-receipt-close/);
});

test('详情回执没有工作区宿主时仍通过原生统一入口，过期回执不能关闭新卡', () => {
  const f = fixture(), opened = [];
  f.ctx.openDetailEntry = id => opened.push(id);
  f.sheet.openTask(f.seed()); const old = f.bridge();
  f.sheet.openTask(f.seed({ cardId: 'new', text: '新草稿' }));
  old.onOpenDetail?.('old');
  assert.equal(f.sheet.capture()?.draft.note, '新草稿');
  assert.deepEqual(opened, []);
  f.bridge().onOpenDetail?.('current');
  assert.deepEqual(opened, ['current']);
  assert.equal(f.sheet.capture(), null);
});

test('独立创建窗口的详情通过原生入口打开主工作区，不导航即将关闭的本窗口', () => {
  const f = fixture(false), opened = [], local = [];
  f.ctx.__deskPanel = 'add';
  f.ctx.WorkspaceHost = { open: (...args) => local.push(args) };
  f.ctx.openDetailEntry = id => opened.push(id);
  f.sheet.openTask(f.seed()); f.bridge().onOpenDetail('saved');
  assert.deepEqual(opened, ['saved']);
  assert.deepEqual(local, []);
});
