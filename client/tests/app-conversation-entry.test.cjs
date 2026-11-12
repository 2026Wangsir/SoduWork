'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const { identity } = require('./helpers/platform-session-fixture.cjs');
const runtime = require('../main/platform-connections/runtime.cjs');
const origins = require('../main/conversation/app-origin.cjs');
const personal = require('../main/personal-plugins');
const entry = require('../main/app-conversation-entry.cjs');
const access = require('../main/conversation/history-access');

function fixture(t, { realHistory = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-app-entry-'));
  let history;
  t.after(async () => { await history?.close?.(); fs.rmSync(root, { recursive: true, force: true }); });
  const app = { getPath: () => root }, original = identity();
  let current = original, available = true, originSource = null, beforeAttach = async () => {};
  const installed = personal.create(app, { key: 'owned-entry', name: 'Owned entry', version: '0.1.0', template: 'app',
    description: 'Fixture', instructions: 'Fixture', ui: { contributions: [{ id: 'main', title: 'App',
      slot: 'workspace.navigation', source: { type: 'external', url: 'https://app.example.test/work',
        bridge: { version: 1, capabilities: ['mcp.connect'] } } }] } }).plugin;
  const origin = { pluginId: installed.pluginId, contributionId: 'main', origin: 'https://app.example.test' };
  const row = { id: 'original-chat', adapterId: 'pi', workOwner: runtime.scope(original), count: 2,
    creator: { account: 'one', hub: original.hub }, historyAliasIds: ['project-alias'] };
  const sender = { mainFrame: {}, isDestroyed: () => false,
    getURL: () => require('node:url').pathToFileURL(path.join(__dirname, '../desk.html')).href };
  const event = { sender, senderFrame: sender.mainFrame };
  const routed = [], opened = [], attachments = [], composer = {}, live = { sessionId: row.id, historyRow: () => row, inFlight: () => true };
  const session = { findBySessionId: id => available && id === row.id ? live : null,
    archivedConversation: async (_app, id) => available && id === row.id ? row : null,
    open: async () => { opened.push('runtime'); throw Error('navigation must never create a runtime'); } };
  const preview = { appConversationOrigin: source => source === sender ? originSource : origin,
    openAppConversation: async (_event, saved, id, payload, guard, attach) => {
      guard(); await beforeAttach(); await attach(composer); routed.push({ saved, id, payload });
    } };
  // account-sync.row() returns the authenticated raw Hub item, not its renderer
  // history projection. In particular, it carries no native execution owner.
  const accountRow = { id: 'acct-original-chat', sourceSessionId: row.id, sourceClientId: original.clientId };
  const accountHistory = { isAccountConversation: id => id === accountRow.id, row: async () => accountRow };
  const source = fs.readFileSync(path.join(__dirname, '../main/conversation/app-entry.cjs'), 'utf8');
  const nativeRequire = require('node:module').createRequire(path.join(__dirname, '../main/conversation/app-entry.cjs'));
  const module = { exports: {} };
  vm.runInNewContext(source, { module, require: name => name === './history-access' ? { ...access,
    actor: (app, value) => access.actor(app, value === undefined ? current : value),
    assertCurrent: (app, captured, value) => access.assertCurrent(app, captured, value === undefined ? current : value) } : nativeRequire(name) });
  let beforeResolve = () => {};
  history = realHistory ? require('../main/conversation/shared-history.cjs').create({ app, session,
    identityOf: () => current, store: require('../main/conversation/replica-store.cjs').createWorker(path.join(root, 'history.sqlite')) })
    : { resolve: async id => available && [row.id, 'project-alias'].includes(id) ? { ...row } : null };
  const router = module.exports.create({ app, session, identityOf: async () => current, preview,
    reattach: (handle, sender) => { attachments.push({ handle, sender }); },
    history,
    accountHistory,
    entry: { resolve: async (...args) => { await beforeResolve(); return entry.resolve(...args); } } });
  return { app, root, row, live, origin, installed, router, session, history, sender, event, routed, opened, attachments, composer, accountRow, accountHistory,
    bind: () => origins.bind(app, row.id, original, origin),
    setOrigin: value => { originSource = value; }, setIdentity: value => { current = value; },
    setAvailable: value => { available = value; }, beforeResolve: fn => { beforeResolve = fn; },
    beforeAttach: fn => { beforeAttach = fn; } };
}

test('real shared-history SQLite native rows and aliases return to the application while cached copies remain readonly', async t => {
  const f = fixture(t, { realHistory: true });
  await f.history.register([f.row]); f.bind();
  const indexed = await f.history.resolve(f.row.id);
  assert.equal(indexed.localReplica, true, 'all durable index rows carry localReplica, including executable native history');
  assert.notEqual(indexed.cached, true);
  assert.equal(indexed.id, f.row.id);
  for (const id of [f.row.id, 'project-alias']) {
    const result = await f.router.navigate(f.event, id);
    assert.equal(result.handled, true); assert.equal(result.sessionId, f.row.id);
  }
  const copy = { ...f.row, id: 'cached-app-chat', historyAliasIds: [], cached: true };
  await f.history.register([copy]); origins.bind(f.app, copy.id, identity(), f.origin);
  assert.equal((await f.history.resolve(copy.id)).localReplica, true);
  await assert.rejects(f.router.navigate(f.event, copy.id), /不可用/);
  assert.equal(f.routed.length, 2); assert.deepEqual(f.opened, []);
  f.setIdentity(identity('two'));
  await assert.rejects(f.router.navigate(f.event, f.row.id), /账号|归属/);
  f.setIdentity({ ...identity(), hub: 'https://another.example.test' });
  await assert.rejects(f.router.navigate(f.event, f.row.id), /账号|服务|归属/);
  assert.equal(f.routed.length, 2, 'account and Hub rejection never reach the application host');
});

test('a strict history rejection cannot be bypassed through an older live application handle', async t => {
  const f = fixture(t, { realHistory: true }); f.bind();
  await f.history.register([{ ...f.row, creator: { account: 'two', hub: identity().hub } }]);
  assert.equal(await f.history.resolve(f.row.id), null, 'strict history rejects conflicting account provenance');
  for (const id of [f.row.id, 'project-alias'])
    await assert.rejects(f.router.navigate(f.event, id), /账号|归属|服务/);
  assert.equal(f.routed.length, 0); assert.equal(f.attachments.length, 0);
  assert.deepEqual(f.opened, []);
});

test('a changed indexed owner during application authorization cannot regain renderer attachment', async t => {
  const f = fixture(t, { realHistory: true }); f.bind(); await f.history.register([f.row]);
  f.beforeResolve(async () => {
    await f.history.register([{ ...f.row, workOwner: runtime.scope(identity('two')) }]);
    assert.equal((await f.history.store.get(f.row.id)).workOwner, runtime.scope(identity('two')));
    assert.equal(await f.history.resolve(f.row.id), null, 'fresh indexed ownership now conflicts with the retained live row');
  });
  await assert.rejects(f.router.navigate(f.event, f.row.id), /账号|服务/);
  assert.equal(f.routed.length, 0); assert.equal(f.attachments.length, 0);
  assert.deepEqual(f.opened, []);
});

test('the final composer attachment rechecks indexed ownership after the application window prepares', async t => {
  const f = fixture(t, { realHistory: true }); f.bind(); await f.history.register([f.row]);
  f.beforeAttach(async () => {
    await f.history.register([{ ...f.row, workOwner: runtime.scope(identity('two')) }]);
    assert.equal(await f.history.resolve(f.row.id), null);
  });
  await assert.rejects(f.router.navigate(f.event, f.row.id), /账号|服务/);
  assert.equal(f.routed.length, 0); assert.equal(f.attachments.length, 0);
  assert.deepEqual(f.opened, []);
});

test('only a verified application composer records immutable navigation provenance', async t => {
  const f = fixture(t);
  f.setOrigin(null);
  await f.router.remember(f.live, f.sender, identity());
  assert.equal(origins.exists(f.app, f.row.id), false, 'ordinary plugin selection cannot create origin metadata');
  f.setOrigin(f.origin);
  await f.router.remember(f.live, f.sender, identity());
  assert.equal(origins.read(f.app, f.row.id, identity()).pluginId, f.origin.pluginId);
  assert.throws(() => origins.bind(f.app, f.row.id, identity(), { ...f.origin, contributionId: 'other' }), /另一个应用/);
  assert.throws(() => origins.read(f.app, f.row.id, identity('two')), /其他账号/);
  assert.throws(() => origins.read(f.app, f.row.id, { ...identity(), hub: 'https://another.example.test' }), /其他账号/);
});

test('recent, project alias and raw account directory item route to one canonical session without execution', async t => {
  const f = fixture(t); f.bind();
  for (const id of [f.row.id, 'project-alias', f.accountRow.id]) {
    const result = await f.router.navigate(f.event, id);
    assert.equal(result.handled, true); assert.equal(result.sessionId, f.row.id);
  }
  assert.equal(f.routed.length, 3);
  assert.ok(f.routed.every(row => row.id === f.row.id));
  assert.deepEqual(f.opened, []);
  assert.equal(f.attachments.length, 3);
  assert.ok(f.attachments.every(item => item.handle === f.live && item.sender === f.composer), 'only the original live runtime is reattached to its native app');
  f.setOrigin(f.origin);
  assert.equal((await f.router.navigate(f.event, f.row.id)).handled, false, 'original composer resumes its own session normally');
});

test('unknown legacy and ordinary chats stay ordinary, including offline navigation', async t => {
  const f = fixture(t); f.setIdentity(null);
  assert.equal((await f.router.navigate(f.event, 'unknown-history')).handled, false);
  assert.equal((await f.router.navigate(f.event, f.row.id)).handled, false);
  assert.deepEqual(f.routed, []); assert.deepEqual(f.opened, []);
});

test('ordinary raw account history falls through and app history still requires native execution ownership', async t => {
  const f = fixture(t);
  assert.equal((await f.router.navigate(f.event, f.accountRow.id)).handled, false);
  assert.equal(origins.exists(f.app, f.row.id), false, 'ordinary history must not acquire application provenance');
  f.bind();
  f.row.workOwner = runtime.scope(identity('two'));
  await assert.rejects(f.router.navigate(f.event, f.accountRow.id), /当前账号|原账号/);
  delete f.row.workOwner;
  await assert.rejects(f.router.navigate(f.event, f.accountRow.id), { code: 'HISTORY_OWNER_MISSING' });
  assert.deepEqual(f.routed, []); assert.deepEqual(f.opened, []); assert.deepEqual(f.attachments, []);
});

test('missing, deleted and other-device account items cannot open an application', async t => {
  const f = fixture(t); f.bind();
  f.accountHistory.row = async () => null;
  assert.equal((await f.router.navigate(f.event, f.accountRow.id)).handled, false);
  f.accountHistory.row = async () => ({ ...f.accountRow, deleted: true });
  await assert.rejects(f.router.navigate(f.event, f.accountRow.id), /已经删除/);
  f.accountHistory.row = async () => ({ ...f.accountRow, sourceClientId: 'other-device' });
  assert.equal((await f.router.navigate(f.event, f.accountRow.id)).handled, false);
  assert.deepEqual(f.routed, []); assert.deepEqual(f.opened, []); assert.deepEqual(f.attachments, []);
});

test('account changes while reading raw directory items reject even ordinary or missing fallbacks', async t => {
  for (const kind of ['ordinary', 'missing', 'deleted', 'other-device']) await t.test(kind, async t => {
    const f = fixture(t);
    f.accountHistory.row = async () => {
      f.setIdentity(identity('two'));
      if (kind === 'missing') return null;
      return { ...f.accountRow, ...(kind === 'deleted' ? { deleted: true } : {}),
        ...(kind === 'other-device' ? { sourceClientId: 'other-device' } : {}) };
    };
    await assert.rejects(f.router.navigate(f.event, f.accountRow.id), /账号.*切换|账号或服务已变化/);
    assert.deepEqual(f.routed, []); assert.deepEqual(f.opened, []); assert.deepEqual(f.attachments, []);
  });
});

test('account and Hub changes while resolving a native source cannot fall through as ordinary history', async t => {
  for (const changed of [identity('two'), { ...identity(), hub: 'https://another.example.test' }]) {
    const f = fixture(t);
    f.session.findBySessionId = () => null;
    f.session.archivedConversation = async () => { f.setIdentity(changed); return f.row; };
    await assert.rejects(f.router.navigate(f.event, f.accountRow.id), /账号.*切换|账号或服务已变化/);
    assert.deepEqual(f.routed, []); assert.deepEqual(f.opened, []); assert.deepEqual(f.attachments, []);
  }
});

test('origin does not replace current session ownership, source-device checks or current install permission', async t => {
  const f = fixture(t); f.bind();
  f.row.workOwner = runtime.scope(identity('two'));
  await assert.rejects(f.router.navigate(f.event, f.row.id), /当前账号|原账号/);
  f.row.workOwner = runtime.scope(identity());
  f.accountRow.sourceClientId = 'foreign-device';
  assert.equal((await f.router.navigate(f.event, f.accountRow.id)).handled, false);
  const registry = path.join(f.root, 'personal-plugins.json'), value = JSON.parse(fs.readFileSync(registry, 'utf8'));
  value.plugins.find(item => item.id === f.origin.pluginId).enabled = false;
  fs.writeFileSync(registry, JSON.stringify(value));
  await assert.rejects(f.router.navigate(f.event, f.row.id), /停用|卸载/);
  assert.deepEqual(f.routed, []); assert.deepEqual(f.opened, []);
});

test('identity changes during authorization, deleted history and untrusted frames never focus an app', async t => {
  const f = fixture(t); f.bind();
  await assert.rejects(f.router.navigate({ ...f.event, senderFrame: {} }, f.row.id), /主窗口/);
  f.row.deleted = true;
  await assert.rejects(f.router.navigate(f.event, f.row.id), /不可用/);
  delete f.row.deleted;
  f.beforeResolve(() => f.setIdentity(identity('two')));
  await assert.rejects(f.router.navigate(f.event, f.row.id), /账号|服务/);
  assert.deepEqual(f.routed, []);
});

test('installed contribution replacement and fabricated app origin cannot redirect a session', async t => {
  const f = fixture(t);
  await assert.rejects(entry.resolve({ app: f.app }, { ...f.origin, origin: 'https://foreign.example.test' }), /来源已变化/);
  await assert.rejects(entry.resolve({ app: f.app }, { ...f.origin, contributionId: 'missing' }), /入口已变化/);
  f.setOrigin({ ...f.origin, contributionId: 'missing' });
  await assert.rejects(f.router.remember(f.live, f.sender, identity()), /入口已变化/);
  assert.equal(origins.exists(f.app, f.row.id), false);
});

test('a stale main renderer release cannot detach the original application composer', () => {
  const source = fs.readFileSync(path.join(__dirname, '../main/pi-session/ipc.js'), 'utf8');
  const start = source.indexOf("  ipcMain.handle('pi-session-release',");
  const end = source.indexOf('\n  });', start) + 6;
  const owner = { mainFrame: {} }, other = { mainFrame: {} }, handle = { sessionId: 'one', attachedWindow: { webContents: owner } };
  let release, detached = 0;
  vm.runInNewContext(source.slice(start, end), {
    ipcMain: { handle: (_name, fn) => { release = fn; } }, session: { get: () => handle },
    _detach: () => { detached++; }, _isActive: () => true,
  });
  release({ sender: other, senderFrame: other.mainFrame }, 'one'); assert.equal(detached, 0);
  release({ sender: owner, senderFrame: {} }, 'one'); assert.equal(detached, 0);
  release({ sender: owner, senderFrame: owner.mainFrame }, 'one'); assert.equal(detached, 1);
});

test('remote application navigation checks the current authorized accepted installation, never the latest unaccepted UI', async () => {
  const origin = { pluginId: 'market-app', contributionId: 'accepted', origin: 'https://accepted.example.test' };
  const contribution = (id, url) => ({ id, slot: 'workspace.navigation', source: { type: 'external', url } });
  const plugin = { pluginId: origin.pluginId, installed: true, enabled: true, permissions: { canUse: true },
    version: '2', ui: { contributions: [contribution('new', 'https://unaccepted.example.test')] },
    conversationVersionId: 'accepted-version', conversationVersion: '1', conversationUi: {
      contributions: [contribution('accepted', origin.origin + '/app')] } };
  const requests = [], deps = { identityOf: async () => identity(), fetchImpl: async (url, options) => {
    requests.push({ url, method: options.method }); return new Response(JSON.stringify({ items: [plugin] }));
  } };
  const result = await entry.resolve(deps, origin);
  assert.equal(result.appVersion, '1'); assert.equal(result.url, origin.origin + '/app');
  assert.equal(requests.length, 1); assert.ok(requests[0].url.endsWith('/api/v1/plugins/catalog'));
  plugin.permissions.canUse = false;
  await assert.rejects(entry.resolve(deps, origin), /安装并启用/);
  plugin.permissions.canUse = true; plugin.installedVersionAvailable = false;
  await assert.rejects(entry.resolve(deps, origin), /安装并启用/);
});

test('foreground IPC redirects known app history without starting a runtime; task and app requests retain their normal open path', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../main/pi-session/ipc.js'), 'utf8');
  const start = source.indexOf("  ipcMain.handle('pi-session-open',");
  const end = source.indexOf('\n  });', start) + 6;
  let open; const routed = [], normal = [];
  vm.runInNewContext(source.slice(start, end), {
    ipcMain: { handle: (_name, fn) => { open = fn; } },
    applicationEntries: { navigate: async (_event, id) => { routed.push(id); return { ok: true, handled: id === 'app-chat' }; } },
    openConversation: async (_event, raw) => { normal.push(raw); return { ok: true, ref: 'normal-ref' }; },
  });
  assert.equal((await open({}, { chatId: 'app-chat' })).applicationOpened, true);
  assert.equal(normal.length, 0);
  for (const patch of [{ taskRef: 'task' }, { taskSession: true }, { requireTaskBinding: true }, { appRequestId: 'validated-request' }]) {
    assert.equal((await open({}, { chatId: 'app-chat', ...patch })).ref, 'normal-ref');
  }
  assert.equal((await open({}, { chatId: 'ordinary-chat' })).ref, 'normal-ref');
  assert.deepEqual(routed, ['app-chat', 'ordinary-chat']); assert.equal(normal.length, 5);
});
