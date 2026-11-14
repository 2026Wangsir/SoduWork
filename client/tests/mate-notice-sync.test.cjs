'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function fixture({ values = new Map(), received = [], sent = [] } = {}) {
  const calls = [], events = {}, timers = [], bubbles = [], alerts = [];
  let scope = 'user-a', failStorage = false;
  const ctx = { window: null, console, TaskSync: require('../core/task-sync.js'),
    petSay: text => bubbles.push(text), playOpenBox: () => alerts.push('sound'),
    setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout() {},
    setInterval: (fn, delay) => { timers.push({ fn, delay }); return timers.length; }, clearInterval() {},
    document: { getElementById: () => null, querySelectorAll: () => [], documentElement: { setAttribute() {} } },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    addEventListener: (name, fn) => (events[name] ||= []).push(fn),
    dispatchEvent: event => (events[event.type] || []).forEach(fn => fn(event)),
    localStorage: { getItem: key => values.get(key) ?? null,
      setItem: (key, value) => { if (failStorage) throw Error('disk full'); values.set(key, String(value)); },
      removeItem: key => values.delete(key) },
    SoduWorkAPI: { taskStorageKey: kind => scope + ':' + kind,
      clientAuthSnapshot: () => ({ user: { id: scope } }),
      mateMessages: async (folder, limit, before) => { calls.push(['list', folder, limit, before]);
        return { ok: true, items: folder === 'sent' ? sent : received, nextCursor: '' }; },
      markMateMessageDelivered: async id => { calls.push(['delivered', id, values.get(scope + ':notices')]);
        return { ok: true, messageId: id, status: 'delivered', deliveredAt: 200 }; },
      markMateMessageRead: async id => { calls.push(['read', id]);
        return { ok: true, messageId: id, status: 'read', deliveredAt: 200, readAt: 300 }; },
    },
  };
  ctx.window = ctx; vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../core/store-lifecycle.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../core/store.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../core/notice-persistence.js'), 'utf8'), ctx);
  const helper = path.join(__dirname, '../core/mate-notice-sync.js');
  if (fs.existsSync(helper)) vm.runInContext(fs.readFileSync(helper, 'utf8'), ctx);
  return { ctx, values, calls, events, timers, bubbles, alerts, api: ctx.SoduWorkAPI,
    event: event => { ctx.serverEvent = event; vm.runInContext('Store.applyServerEvent(serverEvent)', ctx); },
    get sync() { assert.ok(ctx.MateNoticeSync, 'persistent message synchronization must be loaded'); return ctx.MateNoticeSync; },
    unread: () => vm.runInContext('noticeUnread()', ctx), all: () => vm.runInContext('notices', ctx),
    clear: () => vm.runInContext('clearNotices()', ctx),
    failStorage: value => { failStorage = value; },
    scope: value => { scope = value; ctx.dispatchEvent(new ctx.CustomEvent('soduwork-data-scope-changed')); },
  };
}
const message = (changes = {}) => ({ id: 'server-1', messageId: 'client-1', senderId: 'user-b', recipientId: 'user-a',
  senderName: '发件人', recipientName: '接收人', text: '完整需求说明', kind: 'task_assignment', taskId: 'task-1',
  createdAt: 100, status: 'accepted', deliveredAt: null, readAt: null, attachments: [], ...changes });

test('both production renderers load durable notice storage before reconciliation', () => {
  for (const name of ['desk.html', 'index.html']) {
    const html = fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
    const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*>/g)].map(match => match[1]);
    const storage = scripts.indexOf('core/notice-persistence.js');
    assert.ok(storage > scripts.indexOf('core/store.js'), name + ' loads the notice store first');
    assert.ok(storage >= 0 && storage < scripts.indexOf('core/mate-notice-sync.js'), name + ' enables persistence before reconciliation');
    assert.equal(scripts.filter(file => file === 'core/notice-persistence.js').length, 1);
  }
});

test('storage capability fallback keeps local notices and receipt acknowledgements working', async () => {
  const f = fixture({ received: [message()] });
  assert.equal(f.ctx.SoduWorkNoticePersistence.create(), null);
  assert.equal(f.sync.persistent, false);
  await f.sync.refresh('received');
  assert.equal(f.sync.rows('received').length, 1);
  assert.ok(f.values.get('user-a:notices').includes('server-1'));
  assert.ok(f.calls.some(call => call[0] === 'delivered' && call[1] === 'server-1'));
});

test('publication notices survive reconnect and self-recipient delivery without duplicate sender receipts', async () => {
  const item = message({ kind: 'plugin_lifecycle', taskId: '', senderId: 'user-a',
    text: 'Publication changed', textMessage: { key: 'notification.plugin_unpublished', params: { name: 'Example' } } });
  const f = fixture({ received: [item], sent: [item] });
  await f.sync.refresh();
  assert.equal(f.sync.rows('received').length, 1);
  assert.equal(f.sync.rows('received')[0].kind, 'plugin_lifecycle');
  assert.equal(f.sync.rows('sent').length, 1);
  assert.ok(!f.all().some(row => row.kind === 'mate_receipt'));
  const reopened = fixture({ values: f.values, received: [item], sent: [item] });
  await reopened.sync.refresh();
  assert.equal(reopened.sync.rows('received').length, 1);
  await reopened.sync.markRead(item.id);
  assert.equal(reopened.sync.rows('received')[0].read, true);
  assert.equal(reopened.sync.rows('received')[0].textMessage.params.name, 'Example');
});

test('only a complete consistent inbox snapshot removes publication notices outside current scope', async () => {
  const lifecycle = id => message({ id, messageId: id, kind: 'plugin_lifecycle', taskId: '', status: 'read', readAt: 300 });
  const f = fixture({ received: [lifecycle('old'), lifecycle('kept'), message({ id: 'ordinary' })] });
  await f.sync.refresh('received');
  let fail = true;
  f.api.mateMessages = async (_folder, _limit, before) => {
    if (!before) return { ok: true, items: [lifecycle('kept')], nextCursor: 'kept', revision: 'scope-two' };
    if (fail) throw Error('offline');
    return { ok: true, items: [], nextCursor: '', revision: 'scope-two' };
  };
  await assert.rejects(f.sync.refresh('received'), /offline/);
  assert.ok(f.sync.rows('received').some(row => row.serverMessageId === 'old'));
  fail = false;
  await f.sync.refresh('received');
  assert.deepEqual(Array.from(f.sync.rows('received'), row => row.serverMessageId).sort(), ['kept', 'ordinary']);
});

test('mixed revisions and arrivals during a refresh cannot erase publication notices', async () => {
  const lifecycle = id => message({ id, messageId: id, kind: 'plugin_lifecycle', taskId: '', status: 'delivered', deliveredAt: 200 });
  const f = fixture({ received: [lifecycle('prior')] });
  await f.sync.refresh('received');
  f.api.mateMessages = async (_folder, _limit, before) => before
    ? { ok: true, items: [], nextCursor: '', revision: 'changed' }
    : { ok: true, items: [], nextCursor: 'page-two', revision: 'first' };
  await f.sync.refresh('received');
  assert.ok(f.sync.rows('received').some(row => row.serverMessageId === 'prior'));
  assert.equal(await f.sync.present({ ...lifecycle('prior'), type: 'notice', serverMessageId: 'prior' }), null,
    'an inconsistent refresh may retain the cache but cannot authorize an absent websocket notice');
  const delayed = deferred();
  f.api.mateMessages = () => delayed.promise;
  const refreshing = f.sync.refresh('received');
  // Another window may restore a newly committed notice while HTTP is in flight.
  f.values.set('user-a:notices', JSON.stringify([...f.sync.rows('received'),
    { ...f.sync.rows('received')[0], id: 'mate-new', serverMessageId: 'new', messageId: 'new' }]));
  delayed.resolve({ ok: true, items: [], nextCursor: '', revision: 'stable' });
  await refreshing;
  assert.deepEqual(Array.from(f.sync.rows('received'), row => row.serverMessageId), ['new']);
  let conditional;
  f.api.mateMessages = async (_folder, _limit, _before, revision) => {
    conditional = revision;
    return { ok: true, items: [], nextCursor: '', revision: 'stable' };
  };
  await f.sync.refresh('received');
  assert.equal(conditional, '', 'a concurrent unverified row must not be frozen by notModified responses');
  assert.equal(f.sync.rows('received').length, 0);
});

test('publication websocket bodies require the current authenticated inbox and use localized descriptors', async () => {
  const item = message({ kind: 'plugin_lifecycle', taskId: '', text: 'Legacy publication text',
    textMessage: { key: 'notification.plugin_unpublished', fallback: 'Legacy publication text', params: { name: 'Save {name}' } } });
  const f = fixture({ received: [item] });
  f.ctx.SoduWorkI18n = { t: (key, fallback, params) => key === 'notification.plugin_unpublished'
    ? 'Removed: ' + params.name : fallback };
  const event = { ...item, type: 'notice', serverMessageId: item.id, text: 'Untrusted socket copy' };
  const presented = await f.sync.present(event);
  assert.equal(presented.text, 'Removed: Save {name}');
  assert.equal(await f.sync.present(event), null, 'replayed arrivals do not notify twice');
  const rejected = fixture();
  rejected.api.mateMessages = async () => ({ ok: true, items: [], nextCursor: '', revision: 'current-company' });
  assert.equal(await rejected.sync.present(event), null);
  assert.equal(rejected.sync.rows('received').length, 0);
  rejected.api.mateMessages = async () => { throw Error('offline'); };
  assert.equal(await rejected.sync.present(event), null);
  assert.equal(rejected.sync.rows('received').length, 0);
  assert.ok(!rejected.calls.some(call => call[0] === 'delivered'));
});

test('unchanged large histories do not rewrite storage, broadcast, or recreate receipts', async () => {
  const sent = Array.from({ length: 2000 }, (_, i) => message({ id: 's' + i, messageId: 'c' + i,
    senderId: 'user-a', recipientId: 'user-b', status: 'read', readAt: 300 }));
  const f = fixture({ sent });
  await f.sync.refresh('sent');
  const original = f.values.get('user-a:notices');
  let writes = 0, broadcasts = 0;
  const save = f.ctx.localStorage.setItem;
  f.ctx.localStorage.setItem = (...args) => { writes++; save(...args); };
  f.ctx.WinSync = { pushNotices() { broadcasts++; } };
  await f.sync.refresh('sent');
  assert.equal(writes, 0); assert.equal(broadcasts, 0);
  assert.equal(f.values.get('user-a:notices'), original);
  assert.equal(f.sync.rows('received').length, 2000);
});

test('stable revision skips all history pages and remains bound to the durable account cache', async () => {
  const f = fixture(), requested = [];
  f.api.mateMessages = async (folder, limit, before, revision) => {
    requested.push({ folder, before, revision });
    if (revision === 'stable') return { ok: true, items: [], notModified: true, revision: 'stable' };
    return { ok: true, items: [message({ id: before ? 'old' : 'new', messageId: before ? 'old' : 'new',
      status: 'read', readAt: 300 })], nextCursor: before ? '' : 'new', revision: 'stable' };
  };
  await f.sync.refresh('received'); await f.sync.refresh('received');
  assert.equal(requested.length, 3); assert.equal(requested[2].revision, 'stable');
  assert.equal(f.sync.rows('received').length, 2);
  f.values.set('user-a:notices', '[]');
  await f.sync.refresh('received');
  assert.equal(requested[3].revision, ''); assert.equal(f.sync.rows('received').length, 2);
  f.scope('user-c'); await f.sync.refresh('received');
  assert.equal(requested[5].revision, ''); assert.equal(f.sync.rows('received').length, 0);
});

test('a receipt changed during pagination cannot become a cached conditional snapshot', async () => {
  const f = fixture(), requested = []; let changed = false;
  f.api.mateMessages = async (_folder, _limit, before, revision) => {
    requested.push(revision);
    const result = { ok: true, items: [message({ id: before ? 'old' : 'new', messageId: before ? 'old' : 'new',
      senderId: 'user-a', recipientId: 'user-b', status: changed ? 'read' : 'delivered',
      readAt: changed ? 300 : null, deliveredAt: 200 })], nextCursor: before ? '' : 'new', revision: changed ? 'after' : 'before' };
    changed = true; return result;
  };
  await f.sync.refresh('sent'); await f.sync.refresh('sent');
  assert.equal(requested[2], '', 'mixed pages must force a complete retry on the next refresh');
  assert.ok(f.sync.rows('sent').every(row => row.status === 'read'));
});

test('a cache replaced while notModified is in flight is reconciled unconditionally', async () => {
  const f = fixture(), delayed = deferred(); let calls = 0;
  f.api.mateMessages = async (_folder, _limit, _before, revision) => {
    calls++;
    if (revision) return delayed.promise;
    return { ok: true, items: [message({ status: 'read', readAt: 300 })], revision: 'r1' };
  };
  await f.sync.refresh('received');
  const next = f.sync.refresh('received');
  f.values.set('user-a:notices', '[]');
  delayed.resolve({ ok: true, items: [], revision: 'r1', notModified: true });
  await next;
  assert.equal(calls, 3); assert.equal(f.sync.rows('received').length, 1);
});

test('delivery batches preserve successful receipts when a peer acknowledgement fails', async () => {
  const f = fixture({ received: [message(), message({ id: 'failed', messageId: 'failed' })] });
  f.api.markMateMessageDelivered = async id => {
    if (id === 'failed') throw Error('offline');
    return { ok: true, status: 'delivered', deliveredAt: 200 };
  };
  await assert.rejects(f.sync.refresh('received'), /offline/);
  assert.equal(f.sync.rows('received').find(row => row.serverMessageId === 'server-1').status, 'delivered');
  assert.equal(f.sync.rows('received').find(row => row.serverMessageId === 'failed').status, 'accepted');
});

function mountChatList(f) {
  const opened = [];
  f.ctx.openTaskConversation = (...args) => { opened.push(args); return true; };
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../components/workspace/workspace-chat-list.js'), 'utf8'), f.ctx);
  const context = {chatItems: [{id: 'ongoing-chat'}], activeChatId: 'ongoing-chat', incomingOpened: new Map()};
  const list = f.ctx.WorkspaceChatList.create(context);
  // Exercise an arrival listener if the workspace registers one, including queued arrivals.
  list.subscribeTaskChanges?.();
  return {opened, context};
}

for (const beforeMount of [true, false]) {
  for (const type of ['task.created', 'task.updated']) {
    test(`${type} assignment ${beforeMount ? 'before' : 'after'} workspace mount notifies without opening a conversation`, () => {
      const f = fixture(), relayed = [];
      f.ctx.WinSync = {pushTasks() {}, pushNotices() {}, pushTaskEvent: event => relayed.push(event)};
      let workspace;
      if (!beforeMount) workspace = mountChatList(f);
      const event = {type, arrival: 'assign', by: 'Sender', autoOpen: true,
        task: {id: 'task-1', title: 'Assigned requirement', status: 'todo', triageStage: 'ready',
          ownerClientId: 'device-a', myRoles: ['assignee'], readOnly: false}};
      f.event(event);
      if (beforeMount) workspace = mountChatList(f);
      f.event({...event, __fromWindow: true});
      f.event(event);
      assert.deepEqual(workspace.opened, []);
      assert.deepEqual(workspace.context.chatItems, [{id: 'ongoing-chat'}]);
      assert.equal(workspace.context.activeChatId, 'ongoing-chat');
      assert.equal(f.bubbles.length, 1); assert.equal(f.alerts.length, 1); assert.equal(f.unread(), 1);
      assert.equal(vm.runInContext('Store.tasks[0].triageStage', f.ctx), 'ready');
      assert.ok(relayed.length > 0);
      assert.ok(relayed.every(row => row.autoOpen === false));
    });
  }
}

for (const scenario of [
  {name: 'intake moves to ready', previous: {triageStage: 'intake'}, arrival: '', alerts: 0},
  {name: 'ownership moves from a colleague', previous: {readOnly: true, ownerClientId: 'device-b', myRoles: ['creator']}, arrival: 'assign', alerts: 1},
  {name: 'creator assigns the requirement to self', previous: null, arrival: 'self', alerts: 0},
]) {
  test(`${scenario.name} updates the pool without creating a conversation`, () => {
    const f = fixture();
    const task = {id: 'task-1', title: 'Requirement', status: 'todo', triageStage: 'ready',
      readOnly: false, ownerClientId: 'device-a', myRoles: ['assignee']};
    if (scenario.previous) f.event({type: 'task.created', task: {...task, ...scenario.previous}});
    const workspace = mountChatList(f);
    f.event({type: scenario.previous ? 'task.updated' : 'task.created', arrival: scenario.arrival, task});
    assert.deepEqual(workspace.opened, []);
    assert.equal(workspace.context.activeChatId, 'ongoing-chat');
    assert.equal(f.alerts.length, scenario.alerts);
    assert.equal(vm.runInContext('Store.tasks[0].triageStage', f.ctx), 'ready');
    assert.equal(vm.runInContext('Store.tasks[0].ownerClientId', f.ctx), 'device-a');
  });
}

test('通知缓存中明确属于其他账号的私信不展示或计数，定向协作消息保留', async () => {
  const values = new Map([['user-a:notices', JSON.stringify([
    { ...message({ recipientId: 'user-c' }), id: 'foreign', at: 1, read: false },
    { ...message(), id: 'mine', at: 2, read: false },
    { id: 'system', kind: 'notice', text: '系统维护', at: 3, read: false },
  ])]]);
  const f = fixture({ values });
  assert.deepEqual(Array.from(f.sync.rows('received'), row => row.id).sort(), ['mine', 'system']);
  assert.equal(f.unread(), 2);
  f.scope('user-c');
  assert.equal(f.unread(), 0);
  f.scope('user-a');
  assert.equal(f.unread(), 2);
  assert.match(values.get('user-a:notices'), /foreign/, '只隐藏明确不匹配的旧行，不删除原始缓存');
});

test('旧转出通知只在服务端明确无参与角色时隐藏，任务未加载不推断无权', () => {
  const f = fixture({ values: new Map([['user-a:notices', JSON.stringify([
    { id: 'handoff-old', kind: 'handoff.done', taskId: 'team-task', text: '旧错误转出提醒', at: 1, read: false },
    { id: 'direct', kind: 'mate_message', recipientId: 'user-a', taskId: 'team-task', text: '@本人', at: 2, read: false },
  ])]]) });
  assert.equal(f.unread(), 2);
  f.event({ type: 'task.created', task: { id: 'team-task', myRoles: [], readOnly: true } });
  assert.deepEqual(Array.from(f.sync.rows('received'), row => row.id), ['direct']);
  assert.equal(f.unread(), 1);
  f.event({ type: 'task.updated', task: { id: 'team-task', myRoles: ['requester'], readOnly: true } });
  assert.equal(f.unread(), 2);
});

test('鉴权列表中的显式账号不匹配行不会生成回执或确认送达', async () => {
  const f = fixture({ received: [message({ recipientId: 'user-c' })],
    sent: [message({ senderId: 'user-c' })] });
  await f.sync.refresh();
  assert.equal(f.unread(), 0);
  assert.equal(f.sync.rows('sent').length, 0);
  assert.equal(f.calls.some(row => row[0] === 'delivered'), false);
});

test('办结回执按明确接收人展示和持久化，其他人完成的相关协作仍收到', async () => {
  const f = fixture();
  f.event({ type: 'notice', kind: 'task_receipt', text: '同事已完成我提出的需求',
    taskId: 'not-yet-loaded', recipientId: 'user-a' });
  assert.equal(f.unread(), 1);
  assert.equal(f.all()[0].recipientId, 'user-a');
  assert.deepEqual(f.bubbles, ['同事已完成我提出的需求']);
  f.event({ type: 'notice', kind: 'task_receipt', text: '别人的工作', recipientId: 'user-c' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.unread(), 1); assert.equal(f.bubbles.length, 1);
});

test('没有kind的普通notice仍按显式接收人阻止列表、气泡和声音', async () => {
  const f = fixture();
  f.event({ type: 'notice', text: '其他账号的普通通知', recipientId: 'user-c' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.unread(), 0); assert.deepEqual(f.bubbles, []); assert.deepEqual(f.alerts, []);
  assert.equal(Array.from(f.values.values()).some(value => value.includes('其他账号的普通通知')), false);
  f.event({ type: 'notice', text: '本人的普通通知', recipientId: 'user-a' });
  assert.equal(f.unread(), 1); assert.deepEqual(f.bubbles, ['本人的普通通知']);
  assert.equal(f.alerts.length, 1);
});

test('明确未登录时不展示或确认私有缓存和列表，恢复身份后保留原消息', async () => {
  const values = new Map([['user-a:notices', JSON.stringify([
    { ...message(), id: 'saved-private', serverMessageId: 'server-1', at: 1, read: false },
  ])]]);
  const f = fixture({ values, received: [message({ id: 'server-2' })] });
  f.api.clientAuthSnapshot = () => ({ state: 'pending', user: null });
  assert.equal(f.unread(), 0);
  await f.sync.refresh('received');
  assert.equal(f.unread(), 0);
  assert.equal(f.calls.some(row => row[0] === 'delivered'), false);
  f.event({ type: 'notice', text: '未经验证的当前用户消息', recipientId: 'user-a' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.bubbles, []); assert.deepEqual(f.alerts, []);
  f.api.clientAuthSnapshot = () => ({ state: 'active', user: { id: 'user-a' } });
  assert.equal(f.unread(), 1);
  assert.equal(f.sync.rows('received')[0].id, 'saved-private');
});

test('启动暂未读取身份时仍可经鉴权收件箱恢复，原始事件保持静默', async () => {
  const f = fixture({ received: [message()] });
  f.api.clientAuthSnapshot = () => ({ state: 'legacy', user: null });
  f.event({ type: 'notice', text: '启动时未经核准的正文', recipientId: 'user-a', serverMessageId: 'server-1' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.unread(), 1);
  assert.equal(f.sync.rows('received')[0].text, message().text);
  assert.deepEqual(f.bubbles, []); assert.deepEqual(f.alerts, []);
});

test('received messages persist and light the badge before delivery is acknowledged', async () => {
  const f = fixture({ received: [message()] });
  await f.sync.refresh('received');
  assert.equal(f.unread(), 1);
  assert.equal(f.sync.rows('received')[0].taskId, 'task-1');
  const ack = f.calls.find(row => row[0] === 'delivered');
  assert.ok(JSON.parse(ack[2]).some(row => row.serverMessageId === 'server-1'));
  assert.equal(f.sync.rows('received')[0].status, 'delivered');
});

test('同一消息的回执在一行内推进状态，不叠加三条未读', async () => {
  const sent = [message({ senderId: 'user-a', recipientId: 'user-b' })], f = fixture({ sent });
  await f.sync.refresh('sent');
  assert.equal(f.sync.rows('sent').length, 1); assert.equal(f.unread(), 1);
  const first = f.sync.rows('received')[0];
  assert.equal(first.receiptStatus, 'accepted'); assert.equal(first.at, 100);
  sent[0].status = 'delivered'; sent[0].deliveredAt = 200;
  await f.sync.refresh('sent');
  assert.equal(f.unread(), 1); assert.equal(f.sync.rows('received')[0].id, first.id);
  assert.equal(f.sync.rows('received')[0].receiptStatus, 'delivered');
  assert.equal(f.sync.rows('received')[0].at, 200);
  sent[0].status = 'read'; sent[0].readAt = 300;
  await f.sync.refresh('sent');
  assert.equal(f.unread(), 1);
  assert.deepEqual(Array.from(f.sync.rows('received'), row => row.receiptStatus), ['read']);
  assert.equal(f.sync.rows('received')[0].id, first.id);
  assert.equal(f.sync.rows('received')[0].at, 300);
  await f.sync.refresh('sent'); assert.equal(f.unread(), 1);
  const reloaded = fixture({ values: f.values, sent });
  await reloaded.sync.refresh('sent'); assert.equal(reloaded.unread(), 1);
});

test('清空早期回执不屏蔽后续阶段，清空终态后不再出现', async () => {
  const sent = [message({ senderId: 'user-a', recipientId: 'user-b' })], f = fixture({ sent });
  await f.sync.refresh('sent'); f.clear(); assert.equal(f.unread(), 0);
  sent[0].status = 'delivered'; sent[0].deliveredAt = 200;
  await f.sync.refresh('sent'); assert.equal(f.unread(), 1);
  f.clear(); sent[0].status = 'read'; sent[0].readAt = 300;
  await f.sync.refresh('sent'); assert.equal(f.unread(), 1);
  f.clear(); await f.sync.refresh('sent'); assert.equal(f.unread(), 0);
});

test('旧三阶段回执及清空、已读、提醒标记迁移到统一格式，重复同步保持幂等', async () => {
  const legacy = ['accepted', 'delivered', 'read'].map((receiptStatus, index) => ({
    id: 'mate_receipt_server-1_' + receiptStatus, folder: 'received', kind: 'mate_receipt',
    receiptStatus, serverMessageId: 'server-1', messageId: 'client-1',
    at: (index + 1) * 100, text: '旧回执', bodyText: '旧回执', read: false }));
  const values = new Map([
    ['user-a:notices', JSON.stringify(legacy)],
    ['user-a:notices:sync', JSON.stringify({ ids: ['mate_receipt_server-1_accepted'],
      readIds: ['mate_receipt_server-1_read'], presentedIds: ['mate_receipt_server-1_read'] })],
  ]);
  const sent = [message({ senderId: 'user-a', recipientId: 'user-b', status: 'read', deliveredAt: 200, readAt: 300 })];
  const f = fixture({ values, sent }); await f.sync.refresh('sent');
  const receipts = f.sync.rows('received');
  assert.equal(receipts.length, 1); assert.equal(receipts[0].id, 'mate_receipt_server-1');
  assert.equal(receipts[0].receiptStatus, 'read'); assert.equal(receipts[0].read, true);
  const meta = JSON.parse(values.get('user-a:notices:sync'));
  assert.deepEqual(meta.readIds, ['mate_receipt_server-1@read']);
  assert.deepEqual(meta.presentedIds, ['mate_receipt_server-1@read']);
  assert.ok(meta.ids.includes('mate_receipt_server-1@accepted'));
  await f.sync.refresh('sent'); assert.equal(f.sync.rows('received').length, 1);
});

test('已发送列表同步完成后清理没有原消息的旧孤儿回执', async () => {
  const orphan = { id: 'mate_receipt_ghost_accepted', folder: 'received', kind: 'mate_receipt',
    receiptStatus: 'accepted', serverMessageId: 'ghost', messageId: 'ghost-client',
    at: 100, text: '旧回执', bodyText: '旧回执', read: false };
  const values = new Map([['user-a:notices', JSON.stringify([orphan])]]);
  const f = fixture({ values }); await f.sync.refresh('sent');
  assert.equal(f.sync.rows('received').length, 0);
});

test('收件箱先到及已发送分页期间保留旧回执，原消息后到仍保留最高阶段已读状态', async () => {
  const legacy = { id: 'mate_receipt_server-1_read', kind: 'mate_receipt', receiptStatus: 'read',
    serverMessageId: 'server-1', at: 300, read: true, text: '旧回执' };
  const values = new Map([['user-a:notices', JSON.stringify([legacy])]]), f = fixture({ values });
  await f.sync.refresh('received');
  f.api.mateMessages = async (_folder, _limit, before) => before
    ? { ok: true, items: [message({ senderId: 'user-a', recipientId: 'user-b' })], nextCursor: '' }
    : { ok: true, items: [message({ id: 'newer', messageId: 'newer-client', senderId: 'user-a', recipientId: 'user-b' })], nextCursor: 'newer' };
  await f.sync.refresh('sent');
  const receipt = f.sync.rows('received').find(row => row.serverMessageId === 'server-1');
  assert.equal(receipt.id, 'mate_receipt_server-1'); assert.equal(receipt.receiptStatus, 'read');
  assert.equal(receipt.read, true); assert.equal(receipt.at, 300);
});

test('只有缓存已发送记录时也能重建合并旧回执，已完成迁移的回执不会误删', async () => {
  const sent = message({ id: 'mate_sent_server-1', serverMessageId: 'server-1', senderId: 'user-a',
    recipientId: 'user-b', folder: 'sent', status: 'read', at: 100, readAt: 300 });
  const legacy = { id: 'mate_receipt_server-1_read', kind: 'mate_receipt', receiptStatus: 'read',
    serverMessageId: 'server-1', at: 300, read: true, text: '旧回执' };
  const canonical = { ...legacy, id: 'mate_receipt_other', serverMessageId: 'other' };
  const values = new Map([['user-a:notices', JSON.stringify([sent, legacy, canonical])]]), f = fixture({ values });
  await f.sync.refresh('sent');
  const receipts = f.sync.rows('received'); assert.equal(receipts.length, 2);
  assert.equal(receipts.find(row => row.serverMessageId === 'server-1').id, 'mate_receipt_server-1');
  assert.equal(receipts.find(row => row.serverMessageId === 'server-1').read, true);
  assert.ok(receipts.some(row => row.id === 'mate_receipt_other'));
});

for (const separator of ['_', '@']) {
  for (const field of ['ids', 'readIds', 'presentedIds']) {
    test(`兼容 ${separator} 格式的 ${field} 终态标记，缓存缺失后旧阶段不重复提醒`, async () => {
      const values = new Map([['user-a:notices:sync', JSON.stringify({
        [field]: ['mate_receipt_server-1' + separator + 'read'] })]]);
      const sent = [message({ senderId: 'user-a', recipientId: 'user-b' })], f = fixture({ values, sent });
      f.event({ type: 'mate_message_accepted', messageId: 'server-1', senderId: 'user-a',
        recipientId: 'user-b', status: 'accepted' });
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(f.alerts, []); assert.deepEqual(f.bubbles, []);
      if (field === 'ids') assert.equal(f.sync.rows('received').length, 0);
      if (field === 'readIds') assert.equal(f.unread(), 0);
    });
  }
}

test('clearing received notices survives refresh and reload without deleting sent records', async () => {
  const sent = [message({ senderId: 'user-a', recipientId: 'user-b', status: 'read', deliveredAt: 200, readAt: 300 })];
  const f = fixture({ received: [message()], sent });
  await f.sync.refresh(); f.clear();
  await f.sync.refresh(); assert.equal(f.unread(), 0); assert.equal(f.sync.rows('sent').length, 1);
  const reloaded = fixture({ values: f.values, received: [message()], sent });
  await reloaded.sync.refresh(); assert.equal(reloaded.sync.rows('received').length, 0);
});

test('failed read keeps the badge, successful read updates the received row after acknowledgement', async () => {
  const f = fixture({ received: [message()] }); await f.sync.refresh('received');
  const read = f.api.markMateMessageRead;
  f.api.markMateMessageRead = async () => { throw Error('offline'); };
  await assert.rejects(f.sync.markRead('server-1'), /offline/); assert.equal(f.unread(), 1);
  f.api.markMateMessageRead = read;
  await f.sync.markRead('server-1'); assert.equal(f.unread(), 0);
  await f.sync.refresh('received'); assert.equal(f.unread(), 0, 'stale list cannot undo read');
});

test('storage failure never acknowledges receipt and a later refresh retries persistence', async () => {
  const f = fixture({ received: [message()] }); f.failStorage(true);
  await assert.rejects(f.sync.refresh('received'), /保存|存储|persist|disk/);
  assert.equal(f.calls.some(row => row[0] === 'delivered'), false);
  f.failStorage(false); await f.sync.refresh('received');
  assert.equal(f.calls.filter(row => row[0] === 'delivered').length, 1);
});

test('late list and read replies cannot mutate the next account', async () => {
  const f = fixture(), pending = deferred();
  f.api.mateMessages = () => pending.promise;
  const request = f.sync.refresh('received'); f.scope('user-c');
  pending.resolve({ ok: true, items: [message()] }); await request;
  assert.equal(f.unread(), 0); assert.equal(f.calls.some(row => row[0] === 'delivered'), false);
  assert.equal(f.values.has('user-c:notices'), false);
});

test('all received pages are persisted and acknowledged, including messages beyond the first page', async () => {
  const f = fixture();
  f.api.mateMessages = async (_folder, _limit, before) => before
    ? { ok: true, items: [message({ id: 'old', messageId: 'old-client' })], nextCursor: '' }
    : { ok: true, items: [message()], nextCursor: 'server-1' };
  await f.sync.refresh('received');
  assert.equal(f.sync.rows('received').length, 2);
  assert.deepEqual(f.calls.filter(row => row[0] === 'delivered').map(row => row[1]).sort(), ['old', 'server-1']);
});

test('delivery/read events refresh durable state instead of marking sender notices read', async () => {
  const sent = [message({ senderId: 'user-a', recipientId: 'user-b' })], f = fixture({ sent });
  await f.sync.refresh('sent');
  sent[0].status = 'read'; sent[0].deliveredAt = 200; sent[0].readAt = 300;
  await f.sync.handle({ type: 'mate_message_read', messageId: 'server-1', clientMessageId: 'client-1',
    senderId: 'user-a', recipientId: 'user-b', status: 'read', deliveredAt: 200, readAt: 300 });
  assert.equal(f.unread(), 1); assert.equal(f.sync.rows('sent')[0].sentStatus, 'read');
});

test('读过或清空的旧阶段回执不复活，新阶段只更新原消息的一行', async () => {
  const sent = [message({ senderId: 'user-a', recipientId: 'user-b' })], f = fixture({ sent });
  await f.sync.refresh('sent');
  const id = f.sync.rows('received')[0].id;
  f.sync.markLocalRead(id); await f.sync.refresh('sent'); assert.equal(f.unread(), 0);
  sent[0].status = 'delivered'; sent[0].deliveredAt = 200;
  await f.sync.refresh('sent'); assert.equal(f.unread(), 1);
  assert.equal(f.sync.rows('received')[0].id, id);
  f.clear(); await f.sync.refresh('sent'); assert.equal(f.unread(), 0);
  sent[0].status = 'read'; sent[0].readAt = 300;
  await f.sync.refresh('sent'); assert.equal(f.unread(), 1);
  assert.equal(f.sync.rows('received').length, 1);
  assert.equal(f.sync.rows('received')[0].id, id);
});

test('旧版三阶段回执合并为最高阶段，保留最高阶段已读标记并简化交办正文', async () => {
  const item = message({ senderId: 'user-a', recipientId: 'user-b', status: 'read', deliveredAt: 200, readAt: 300,
    text: '武娇娇 将需求「音乐网站修复」交给你' });
  const legacy = ['accepted', 'delivered', 'read'].map((receiptStatus, index) => ({
    id: 'mate_receipt_server-1_' + receiptStatus, serverMessageId: 'server-1', kind: 'mate_receipt',
    receiptStatus, at: (index + 1) * 100, read: receiptStatus === 'read', text: '旧回执' }));
  const values = new Map([['user-a:notices', JSON.stringify(legacy)]]);
  const f = fixture({ values, sent: [item] }); await f.sync.refresh('sent');
  const receipts = f.sync.rows('received');
  assert.equal(receipts.length, 1); assert.equal(receipts[0].receiptStatus, 'read'); assert.equal(f.unread(), 0);
  assert.match(receipts[0].text, /接收人.*已读/); assert.match(receipts[0].text, /音乐网站修复/);
  assert.doesNotMatch(receipts[0].text, /武娇娇|交给你/);
  item.status = 'accepted'; item.readAt = null; item.deliveredAt = null;
  await f.sync.refresh('sent'); assert.equal(f.sync.rows('received')[0].receiptStatus, 'read');
});

test('清空最新回执后即使缓存被回收，迟到旧阶段也不能复活', async () => {
  const sent = [message({ senderId: 'user-a', recipientId: 'user-b', status: 'read', deliveredAt: 200, readAt: 300 })];
  const f = fixture({ sent }); await f.sync.refresh('sent'); f.clear();
  f.values.set('user-a:notices', '[]');
  sent[0].status = 'accepted'; sent[0].deliveredAt = null; sent[0].readAt = null;
  const reloaded = fixture({ values: f.values, sent }); await reloaded.sync.refresh('sent');
  assert.equal(reloaded.sync.rows('received').length, 0);
});

test('a receipt arriving during an older list request schedules a fresh reconciliation', async () => {
  const f = fixture(), pending = deferred(); let count = 0;
  f.api.mateMessages = async () => ++count === 1 ? pending.promise : { ok: true, items: [message({
    senderId: 'user-a', recipientId: 'user-b', status: 'read', deliveredAt: 200, readAt: 300 })] };
  const first = f.sync.refresh('sent');
  const event = f.sync.handle({ type: 'mate_message_read', senderId: 'user-a', recipientId: 'user-b',
    messageId: 'server-1', clientMessageId: 'client-1', status: 'read', readAt: 300 });
  pending.resolve({ ok: true, items: [message({ senderId: 'user-a', recipientId: 'user-b' })] });
  await first; await event;
  assert.equal(count, 2); assert.equal(f.sync.rows('sent')[0].sentStatus, 'read');
});

test('a consumed receipt stays read after its local history row is evicted and replayed', async () => {
  const sent = [message({ senderId: 'user-a', recipientId: 'user-b' })], f = fixture({ sent });
  await f.sync.refresh('sent');
  f.ctx.receiptId = f.sync.rows('received')[0].id;
  vm.runInContext('markNoticeRead(receiptId)', f.ctx);
  const stored = JSON.parse(f.values.get('user-a:notices')).filter(row => row.kind !== 'mate_receipt');
  f.values.set('user-a:notices', JSON.stringify(stored));
  const reloaded = fixture({ values: f.values, sent }); await reloaded.sync.refresh('sent');
  assert.equal(reloaded.unread(), 0); assert.equal(reloaded.sync.rows('received').length, 1);
});

test('ordinary websocket notices persist without a pet bubble being mounted', () => {
  const f = fixture();
  vm.runInContext('Store.applyServerEvent({type:"notice",text:"有一项需求待处理",taskId:"task-a"})', f.ctx);
  assert.equal(f.unread(), 1); assert.equal(f.all()[0].taskId, 'task-a');
});

test('different server messages sharing a sender-scoped client key remain distinct', async () => {
  const f = fixture({ received: [message(), message({ id: 'server-2', senderId: 'user-c', text: '另一发送人的消息' })] });
  await f.sync.refresh('received');
  assert.equal(f.unread(), 2);
  assert.deepEqual(Array.from(f.sync.rows('received'), row => row.serverMessageId).sort(), ['server-1', 'server-2']);
  assert.equal(f.calls.filter(row => row[0] === 'delivered').length, 2);
});

test('a notice addressed to another account never persists or acknowledges its private body', async () => {
  const f = fixture();
  await f.sync.handle({ ...message({ recipientId: 'user-c' }), type: 'notice', serverMessageId: 'server-1' });
  assert.equal(f.unread(), 0);
  assert.equal(f.calls.some(row => row[0] === 'delivered'), false);
  assert.equal(Array.from(f.values.values()).some(value => value.includes('完整需求说明')), false);
});

test('clear only dismisses known IDs and never hides a later server message behind a faster local clock', async () => {
  const serverTime = Date.now() - 5 * 60000, received = [message({ createdAt: serverTime })];
  const f = fixture({ received }); await f.sync.refresh('received'); f.clear();
  received.push(message({ id: 'server-new', messageId: 'client-new', createdAt: serverTime + 1000 }));
  await f.sync.refresh('received');
  assert.deepEqual(Array.from(f.sync.rows('received'), row => row.serverMessageId), ['server-new']);
  assert.ok(f.calls.some(row => row[0] === 'delivered' && row[1] === 'server-new'));
  const reloaded = fixture({ values: f.values, received }); await reloaded.sync.refresh('received');
  assert.deepEqual(Array.from(reloaded.sync.rows('received'), row => row.serverMessageId), ['server-new']);
});

test('legacy clear timestamps are ignored while existing dismissed and read IDs remain effective', async () => {
  const values = new Map([['user-a:notices:sync', JSON.stringify({ clearedAt: Date.now() + 5 * 60000,
    ids: ['mate_server-1'], readIds: ['mate_receipt_sent-1_accepted'] })]]);
  const f = fixture({ values, received: [message(), message({ id: 'server-new', messageId: 'client-new' })],
    sent: [message({ id: 'sent-1', messageId: 'sent-client', senderId: 'user-a', recipientId: 'user-b' })] });
  await f.sync.refresh();
  assert.equal(f.unread(), 1);
  assert.equal(f.sync.rows('received').find(row => row.kind !== 'mate_receipt').serverMessageId, 'server-new');
  assert.equal(f.sync.rows('received').find(row => row.kind === 'mate_receipt').read, true);
  f.clear();
  assert.equal(Object.hasOwn(JSON.parse(values.get('user-a:notices:sync')), 'clearedAt'), false);
});

test('clearing a migrated client-key notice also dismisses its canonical server identity on replay', async () => {
  const legacy = { ...message(), id: 'mate_client-1', serverMessageId: 'server-1', at: 100, read: false };
  const values = new Map([['user-a:notices', JSON.stringify([legacy])]]);
  const f = fixture({ values, received: [message()] }); f.clear();
  await f.sync.refresh('received'); assert.equal(f.unread(), 0);
  const reloaded = fixture({ values, received: [message()] }); await reloaded.sync.refresh('received');
  assert.equal(reloaded.sync.rows('received').length, 0);
});

test('a legacy client with unknown user identity verifies a notice using its authenticated inbox', async () => {
  const f = fixture({ received: [message()] }); f.api.clientAuthSnapshot = () => ({ user: null });
  await f.sync.handle({ ...message(), type: 'notice', serverMessageId: 'server-1', text: 'unverified event text' });
  assert.ok(f.calls.some(row => row[0] === 'list' && row[1] === 'received'));
  assert.equal(f.unread(), 1);
  assert.equal(f.sync.rows('received')[0].text, message().text);
});

for (const durable of [true, false]) {
  test(`其他收件人的${durable ? '持久' : '旧版'}通知不能进入列表、弹窗或提示音`, async () => {
    const f = fixture();
    f.event({ ...message({ recipientId: 'user-c' }), type: 'notice',
      ...(durable ? { serverMessageId: 'server-1' } : {}) });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.unread(), 0);
    assert.deepEqual(f.bubbles, []); assert.deepEqual(f.alerts, []);
    assert.equal(f.calls.some(row => row[0] === 'delivered'), false);
  });
}

for (const identity of ['未知账号', '旧服务未带收件人']) {
  test(`${identity}时只同步鉴权收件箱，不弹出未经核实的正文`, async () => {
    const f = fixture({ received: [message()] });
    if (identity === '未知账号') f.api.clientAuthSnapshot = () => ({ user: null });
    f.event({ ...message(), type: 'notice', serverMessageId: 'server-1', text: '未经核实的正文',
      ...(identity === '旧服务未带收件人' ? { recipientId: undefined } : {}) });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.sync.rows('received')[0].text, message().text);
    assert.deepEqual(f.bubbles, []); assert.deepEqual(f.alerts, []);
    assert.equal(Array.from(f.values.values()).some(value => value.includes('未经核实的正文')), false);
  });
}

test('当前收件人的私信与正常系统通知仍然提醒', async () => {
  const f = fixture({ received: [message()] });
  f.event({ ...message(), type: 'notice', serverMessageId: 'server-1' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.unread(), 1); assert.deepEqual(f.bubbles, [message().text]);
  assert.equal(f.alerts.length, 1);
  f.event({ type: 'notice', text: '系统维护通知' });
  assert.equal(f.unread(), 2); assert.equal(f.bubbles.at(-1), '系统维护通知');
  assert.equal(f.alerts.length, 2);
});

test('quota wording in a notice only requests verification, never asserts recovery', () => {
  const f = fixture(), refreshes = [];
  f.ctx.SoduWorkQuotaNotice = { markRestored: () => assert.fail('notice text cannot grant quota'),
    refreshIfBlocked: () => { refreshes.push('refresh'); } };
  f.event({ type: 'notice', text: '额度已恢复，可继续使用 AI' });
  f.event({ type: 'notice', text: '额度尚未恢复' });
  f.event({ type: 'notice', kind: 'mate_message', senderId: 'user-b', recipientId: 'user-a', text: 'When will my quota be restored?' });
  assert.deepEqual(refreshes, ['refresh', 'refresh', 'refresh']);
});

test('其他账号的额度通知不影响当前对话额度卡', () => {
  const f = fixture(), refreshes = [];
  f.ctx.SoduWorkQuotaNotice = { markRestored: () => { refreshes.push('restored'); } };
  f.event({ type: 'notice', recipientId: 'user-b', text: '额度已恢复，可继续使用 AI' });
  assert.deepEqual(refreshes, []);
});

test('通知同步完成后也会静默刷新已显示的额度卡', async () => {
  const f = fixture(), refreshes = [];
  f.ctx.SoduWorkQuotaNotice = { refreshIfBlocked: () => { refreshes.push('refresh'); } };
  await f.sync.refresh('received');
  assert.deepEqual(refreshes, ['refresh']);
});

test('同一持久消息重放只提醒一次，清空后也不会再次弹窗', async () => {
  const f = fixture({ received: [message()] });
  const event = { ...message(), type: 'notice', serverMessageId: 'server-1' };
  f.event(event); await new Promise(resolve => setImmediate(resolve));
  f.event(event); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.bubbles, [message().text]); assert.equal(f.alerts.length, 1);
  f.clear(); f.event(event); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.bubbles.length, 1); assert.equal(f.alerts.length, 1);
});

for (const noticeFirst of [false, true]) {
  test(`交办任务与持久通知${noticeFirst ? '通知先到' : '任务先到'}时只提醒一次，保留任务自动导航事件`, async () => {
    const f = fixture({ received: [message()] }), changes = [];
    f.ctx.addEventListener('soduwork-work-task-change', event => changes.push(event.detail));
    const taskEvent = { type: 'task.created', arrival: 'assign', by: '发件人', notificationId: 'server-1',
      task: { id: 'task-1', title: '待修复缺陷', status: 'todo', myRoles: ['assignee'], readOnly: false } };
    const noticeEvent = { ...message(), type: 'notice', serverMessageId: 'server-1' };
    for (const event of noticeFirst ? [noticeEvent, taskEvent] : [taskEvent, noticeEvent]) f.event(event);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(f.bubbles, [message().text]); assert.equal(f.alerts.length, 1);
    assert.equal(f.sync.rows('received').length, 1);
    assert.equal(changes.length, 1); assert.equal(changes[0].incoming, true); assert.equal(changes[0].autoOpen, false);
    assert.equal(vm.runInContext('Store.tasks[0].id', f.ctx), 'task-1');
  });
}

test('没有持久通知 ID 的旧版交办仍保留通知和自动导航', () => {
  const f = fixture(), changes = [];
  f.ctx.addEventListener('soduwork-work-task-change', event => changes.push(event.detail));
  f.event({ type: 'task.created', arrival: 'assign', by: '发件人',
    task: { id: 'task-1', title: '待修复缺陷', status: 'todo', myRoles: ['assignee'], readOnly: false } });
  assert.equal(f.bubbles.length, 1); assert.equal(f.alerts.length, 1); assert.equal(f.unread(), 1);
  assert.equal(changes[0].incoming, true); assert.equal(changes[0].autoOpen, false);
});

test('已读消息重放和持久化失败均不弹窗或响铃', async () => {
  for (const failed of [false, true]) {
    const item = message({ ...(failed ? {} : { status: 'read', deliveredAt: 200, readAt: 300 }) });
    const f = fixture({ received: [item] }); if (failed) f.failStorage(true);
    f.event({ ...item, type: 'notice', serverMessageId: 'server-1' });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(f.bubbles, []); assert.deepEqual(f.alerts, []);
    if (failed) assert.equal(f.calls.some(row => row[0] === 'delivered'), false);
  }
});

test('发送人的回执只在新阶段提醒一次，旧阶段和接收端同步保持安静', async () => {
  const sent = [message({ senderId: 'user-a', recipientId: 'user-b', status: 'delivered', deliveredAt: 200 })];
  const f = fixture({ sent });
  const event = { type: 'mate_message_delivered', messageId: 'server-1', senderId: 'user-a', recipientId: 'user-b', status: 'delivered' };
  for (let i = 0; i < 2; i++) { f.event(event); await new Promise(resolve => setImmediate(resolve)); }
  assert.equal(f.alerts.length, 1);
  f.sync.markLocalRead(f.sync.rows('received')[0].id);
  f.event(event); await new Promise(resolve => setImmediate(resolve)); assert.equal(f.alerts.length, 1);
  sent[0].status = 'read'; sent[0].readAt = 300;
  f.event({ ...event, type: 'mate_message_read', status: 'read' }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.alerts.length, 2);
  f.clear(); f.event({ ...event, type: 'mate_message_read', status: 'read' }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.alerts.length, 2);
  f.event({ ...event, senderId: 'user-b', recipientId: 'user-a' }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.alerts.length, 2);
});

test('并发重放与重开窗口共用持久提醒标记，缓存回收后不重复提醒', async () => {
  const sent = [message({ senderId: 'user-a', recipientId: 'user-b', status: 'read', readAt: 300 })];
  const f = fixture({ sent }), event = { type: 'mate_message_read', messageId: 'server-1', senderId: 'user-a', recipientId: 'user-b', status: 'read' };
  f.event(event); f.event(event); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.alerts.length, 1);
  f.values.set('user-a:notices', '[]');
  const reloaded = fixture({ values: f.values, sent }); reloaded.event(event); await new Promise(resolve => setImmediate(resolve));
  assert.equal(reloaded.alerts.length, 0);
});

test('回执同步等待期间换账号，迟到结果不触发新账号提醒', async () => {
  const f = fixture(), pending = deferred(); f.api.mateMessages = () => pending.promise;
  f.event({ type: 'mate_message_read', messageId: 'server-1', senderId: 'user-a', recipientId: 'user-b', status: 'read' });
  f.scope('user-c'); pending.resolve({ ok: true, items: [message({ senderId: 'user-a', recipientId: 'user-b', status: 'read' })] });
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(f.alerts, []); assert.deepEqual(f.bubbles, []);
});

test('已核准提醒返回后切换账号，界面回调仍不能展示旧账号内容', async () => {
  const f = fixture({ received: [message()] }), present = f.sync.present;
  f.sync.present = async event => {
    const notice = await present(event);
    f.scope('user-c');
    return notice;
  };
  f.event({ ...message(), type: 'notice', serverMessageId: 'server-1' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.alerts, []); assert.deepEqual(f.bubbles, []);
});

test('旧版带客户端消息ID的重复事件不重复弹窗，普通系统通知保留', async () => {
  const f = fixture(), event = { ...message(), type: 'notice' };
  f.event(event); f.event(event);
  assert.equal(f.bubbles.length, 1); assert.equal(f.alerts.length, 1);
  f.event({ type: 'notice', text: '系统消息' }); assert.equal(f.alerts.length, 2);
});

for (const state of ['accepted', 'delivered', 'read']) {
  test(`无关账号不会因他人的 ${state} 回执响铃，真实发送人仍可收到提醒`, async () => {
    const f = fixture();
    const event = { type: 'mate_message_' + state, messageId: 'server-1',
      clientMessageId: 'client-1', senderId: 'user-b', recipientId: 'user-c', status: state };
    f.event(event);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.unread(), 0); assert.deepEqual(f.alerts, []);
    f.api.mateMessages = async folder => ({ ok: true, items: folder === 'sent' ? [message({
      senderId: 'user-a', recipientId: 'user-c', status: state, deliveredAt: 200, readAt: state === 'read' ? 300 : null })] : [] });
    f.event({ ...event, senderId: 'user-a' });
    f.event({ ...event, recipientId: 'user-a' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.alerts.length, 1);
  });
}
