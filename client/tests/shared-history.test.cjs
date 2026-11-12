'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { create: createStore } = require('../main/conversation/replica-store.cjs');
const { create } = require('../main/conversation/shared-history.cjs');
const { identity } = require('./helpers/platform-session-fixture.cjs');

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-shared-'));
  const app = { getPath: () => root }, file = path.join(root, 'pi-agent', 'sessions', 'one.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [
    { type: 'session', id: 'one' },
    { type: 'message', id: 'msg-1', message: { role: 'user', content: 'saved by Alice' } },
    { type: 'message', id: 'msg-2', message: { role: 'assistant', content: [{ type: 'text', text: 'local answer' }] } },
  ].map(row => JSON.stringify(row)).join('\n'));
  const row = { id: 'one', title: 'History', path: file, adapterId: 'pi', count: 2, at: 1 };
  const store = createStore(path.join(root, 'replicas.sqlite'));
  const flags = new Map();
  let live = null;
  const session = { archivedConversation: async idApp => row,
    historyEntry: async () => fs.existsSync(file) ? { ok: true, entry: row } : { ok: false, notFound: true },
    findBySessionId: () => live, setArchived: (_app, id, value) => flags.set(id, value),
    forgetRunner: async () => ({ ok: false, notFound: true }) };
  let currentIdentity = identity();
  const identityOf = () => currentIdentity;
  const history = create({ app, session, store, identityOf });
  t.after(async () => { await history.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, file, app, row, session, store, history, flags, identityOf,
    set identity(value) { currentIdentity = value; }, set live(value) { live = value; } };
}
test('shared local reader opens native text without starting any account runtime', async t => {
  const f = setup(t);
  const rows = await f.history.projectRows([{ ...f.row, workOwner: 'another-account' }]);
  assert.equal(rows.length, 1);
  const view = await f.history.open('one');
  assert.equal(view.localReplica, true);
  assert.deepEqual(view.snapshot().messages.map(row => row.text), ['saved by Alice', 'local answer']);
  assert.equal(view.snapshot().messages[1].blocks[0].text, 'local answer');
  assert.equal((await view.send('should not execute')).accepted, false);
});
test('logout during a protected native transcript page cancels the read before returning local content', async t => {
  const f = setup(t);
  const metadata = path.join(f.root, 'requirement-session-context', require('node:crypto').createHash('sha256').update(f.row.id).digest('hex') + '.json');
  fs.mkdirSync(path.dirname(metadata), { recursive: true });
  fs.writeFileSync(metadata, JSON.stringify({ version: 1, owner: require('../main/platform-connections/runtime.cjs').scope(f.identityOf()) }));
  await f.history.projectRows([f.row]);
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  f.session.historyEntry = async () => { entered(); return new Promise(resolve => { release = () => resolve({ ok: true, entry: f.row }); }); };
  const pending = f.history.read(f.row.id);
  await waiting; f.identity = null; release();
  await assert.rejects(pending, /账号已切换/);
});

test('cached pages reject same-account Hub or device changes while allowing same-connection renewal', async t => {
  const f = setup(t), first = identity(), tokens = require('./helpers/platform-session-fixture.cjs').sessions();
  await f.history.capture({ historyRow: () => ({ id: 'private', cloud: true }),
    snapshot: () => ({ messages: [{ role: 'assistant', text: 'Private synthetic content' }] }) }, first);
  const copy = (await f.history.list()).items[0], original = f.store.messages.bind(f.store);
  for (const [next, allowed] of [[{ ...first, hub: 'https://another.invalid' }, false],
    [{ ...first, clientId: 'device-two', session: tokens.otherDevice }, false],
    [{ ...first, session: tokens.renewed }, true]]) {
    f.identity = first;
    let release, entered;
    const waiting = new Promise(resolve => { entered = resolve; });
    f.store.messages = (...args) => { entered(); return new Promise(resolve => { release = () => resolve(original(...args)); }); };
    const pending = f.history.read(copy.id);
    await waiting; f.identity = next; release();
    if (allowed) assert.equal((await pending).items[0].text, 'Private synthetic content');
    else await assert.rejects(pending, /账号已切换/);
  }
});
test('protected local actions reject account changes during resolution before confirmation or revision replies', async t => {
  const f = setup(t), first = identity();
  await f.history.capture({ historyRow: () => ({ id: 'protected', cloud: true }),
    snapshot: () => ({ messages: [{ role: 'assistant', text: 'Protected synthetic transcript' }] }) }, first);
  const copy = (await f.history.list()).items[0];
  await f.history.lifecycle(copy.id, 'archive');
  const resolve = f.history.resolve.bind(f.history);
  const action = require('../main/pi-session/local-history-actions.cjs').create({ ...f });
  for (const [operation, options] of [['delete', {}], ['archive', { expectedRevision: 0 }]]) {
    f.identity = first;
    let release, entered, calls = 0;
    const waiting = new Promise(done => { entered = done; });
    f.history.resolve = async id => {
      const row = await resolve(id);
      if (++calls === 2) { entered(); await new Promise(done => { release = done; }); }
      return row;
    };
    const pending = action(operation, copy.id, options);
    await waiting; f.identity = identity('two'); release();
    await assert.rejects(pending, /账号已切换/);
    assert.equal((await resolve(copy.id)).deleted, false);
    assert.equal((await resolve(copy.id)).archived, true);
  }
});
test('expired credentials cannot read a protected cached copy even with a remembered local owner', async t => {
  const f = setup(t), first = identity();
  await f.history.capture({ historyRow: () => ({ id: 'private-expiry', cloud: true }),
    snapshot: () => ({ messages: [{ role: 'assistant', text: 'Protected synthetic transcript' }] }) }, first);
  const copy = (await f.history.list()).items[0], auth = require('../main/device-auth'), prior = auth.localOwner;
  auth.localOwner = () => require('../main/platform-connections/runtime.cjs').scope(first);
  t.after(() => { auth.localOwner = prior; });
  f.identity = { ...first, session: require('./helpers/platform-session-fixture.cjs').sessions().expired };
  assert.deepEqual((await f.history.list()).items, []);
  await assert.rejects(f.history.read(copy.id), /失效|登录/);
});
test('multi-page native indexing removes protected rows collected before an account change', async t => {
  const f = setup(t), first = identity();
  await f.history.capture({ historyRow: () => ({ id: 'private-index', cloud: true }),
    snapshot: () => ({ messages: [{ role: 'assistant', text: 'Protected synthetic transcript' }] }) }, first);
  const copy = (await f.history.list()).items[0];
  let pages = 0;
  f.store.list = async () => {
    if (++pages === 1) return { items: [copy], next: 1 };
    f.identity = identity('two');
    return { items: [], next: null };
  };
  assert.deepEqual(await f.history.indexedRows(false, 2), []);
});
test('deleted protected receipts remain private across account, Hub and signout changes', async t => {
  const f = setup(t), owner = identity();
  await f.history.capture({ historyRow: () => ({ id: 'private-receipt', cloud: true, title: 'Private receipt title' }),
    snapshot: () => ({ messages: [{ role: 'assistant', text: 'Private receipt body' }] }) }, owner);
  const copy = (await f.history.list()).items[0];
  await f.history.lifecycle(copy.id, 'delete');
  const remote = require('../main/pi-session/local-history-remote.cjs').create({ ...f });
  for (const other of [identity('two'), { ...owner, hub: 'https://another.invalid' }, null]) {
    f.identity = other;
    assert.deepEqual((await f.history.list()).items, []);
    await assert.rejects(remote({ action: 'read', id: copy.id }, async () => {}), /账号|登录/);
  }
  f.identity = owner;
  const receipt = await remote({ action: 'read', id: copy.id }, async () => {});
  assert.equal(receipt.conversation.title, 'Private receipt title');
  assert.equal(receipt.conversation.deleted, true);
  assert.deepEqual(receipt.items, []);
  await f.history.projectRows([f.row]);
  await f.history.lifecycle(f.row.id, 'delete');
  f.identity = identity('two');
  assert.equal((await remote({ action: 'read', id: f.row.id }, async () => {})).conversation.deleted, true,
    'ordinary device-local deletion receipts keep their existing sharing boundary');
  const resolve = f.history.resolve.bind(f.history);
  f.identity = owner;
  f.history.resolve = async id => { const row = await resolve(id); f.identity = identity('two'); return row; };
  await assert.rejects(remote({ action: 'read', id: copy.id }, async () => {}), /账号已切换/);
});
for (const operation of ['archive', 'restore', 'delete']) {
  test(`a late protected ${operation} commit cannot publish or return its payload to the next account`, async t => {
    const f = setup(t), owner = identity(), deliveries = [];
    await f.history.capture({ historyRow: () => ({ id: 'private-mutation', cloud: true, title: 'Private lifecycle title' }),
      snapshot: () => ({ messages: [{ role: 'assistant', text: 'Private lifecycle body' }] }) }, owner);
    const copy = (await f.history.list()).items[0];
    if (operation === 'restore') await f.history.lifecycle(copy.id, 'archive');
    const mutate = f.store.lifecycle.bind(f.store);
    f.store.lifecycle = async (...args) => {
      const result = await mutate(...args);
      if (args[1] === operation) f.identity = identity('two');
      return result;
    };
    const action = require('../main/pi-session/local-history-actions.cjs').create({ ...f,
      BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: {
        send: (_event, payload) => deliveries.push({ identity: f.identityOf(), payload }) } }] } });
    await assert.rejects(action(operation, copy.id, { confirmed: true }), /账号已切换/);
    assert.ok(deliveries.every(item => item.identity.session === owner.session), 'only the original account receives authorized notifications');
    const retained = await f.history.resolve(copy.id);
    assert.equal(retained.deleted, operation === 'delete');
    assert.equal(retained.archived, operation === 'archive');
    assert.deepEqual((await f.history.list()).items, []);
  });
}
test('ordinary local lifecycle completion survives signout without granting execution', async t => {
  const f = setup(t), deliveries = [], mutate = f.store.lifecycle.bind(f.store);
  f.store.lifecycle = async (...args) => { const result = await mutate(...args); f.identity = null; return result; };
  const action = require('../main/pi-session/local-history-actions.cjs').create({ ...f,
    BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: (_event, payload) => deliveries.push(payload) } }] } });
  const result = await action('archive', f.row.id);
  assert.equal(result.ok, true);
  assert.equal(result.conversation.archived, true);
  assert.equal(deliveries[0].presence.id, f.row.id);
  const access = require('../main/conversation/history-access');
  assert.throws(() => access.assertOwner(f.app, f.row.id, access.actor(f.app, null), result.conversation), /登录/);
});
test('legacy outbox recovery preserves sparse positions with bounded batches before metadata-only sync', async t => {
  const f = setup(t), original = f.store.cache.bind(f.store); let writes = 0;
  f.store.cache = (...args) => { writes++; return original(...args); };
  const messages = Array.from({ length: 250 }, (_, i) => ({ position: i < 150 ? i : i + 10,
    role: 'user', text: 'retained-' + i }));
  const job = { hub: identity().hub, ownerKey: 'original', body: {
    sourceSessionId: 'orphan', sourceEpoch: 'first', title: 'Recovered', messages } };
  await f.history.preserveLegacyOutbox(job, identity());
  const recovered = (await f.history.list({ archived: true })).items[0];
  assert.equal(writes, 3);
  const first = await f.store.messages(recovered.id, { limit: 200 });
  const last = await f.store.messages(recovered.id, { after: first.next, limit: 200 });
  assert.deepEqual([...first.items, ...last.items].map(row => [row.position, row.text]), messages.map(row => [row.position, row.text]));
  await f.history.preserveLegacyOutbox(job, identity());
  assert.equal((await f.history.list({ archived: true })).items.length, 1);
});
test('local lifecycle never calls cloud or account mutation endpoints', async t => {
  const f = setup(t), events = [];
  const action = require('../main/pi-session/local-history-actions.cjs').create({ ...f,
    BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: (_event, data) => events.push(data) } }] },
    trash: async (_shell, file) => fs.renameSync(file, path.join(f.root, 'recycled.jsonl')) });
  assert.equal((await action('delete', 'one')).needsConfirm, true);
  assert.equal((await action('delete', 'one', null)).needsConfirm, true);
  assert.equal(fs.existsSync(f.file), true);
  assert.equal((await action('archive', 'one')).archived, true);
  assert.equal((await f.history.projectRows([f.row])).length, 0);
  assert.equal((await action('restore', 'one')).archived, false);
  assert.equal((await action('delete', 'one', { confirmed: true })).deleted, true);
  assert.equal(fs.existsSync(f.file), false);
  assert.equal((await f.history.projectRows([f.row])).length, 0);
  assert.equal(events.at(-1).presence.deleted, true);
  assert.equal((await action('delete', 'one', { confirmed: true })).alreadyDeleted, true);
});
test('failed recycle preserves archived retry entry and original bytes', async t => {
  const f = setup(t);
  const action = require('../main/pi-session/local-history-actions.cjs').create({ ...f,
    trash: async () => { throw Error('recycle failed'); } });
  await assert.rejects(action('delete', 'one', { confirmed: true }), /recycle failed/);
  assert.equal(fs.existsSync(f.file), true);
  assert.equal((await f.history.resolve('one')).archived, true);
  assert.equal((await f.history.resolve('one')).deleted, false);
});
test('active local execution remains protected from archive or delete', async t => {
  const f = setup(t);
  f.live = { inFlight: () => true };
  const action = require('../main/pi-session/local-history-actions.cjs').create({ ...f, trash: async () => assert.fail('must not recycle') });
  await assert.rejects(action('archive', 'one'), /还在执行/);
  await assert.rejects(action('delete', 'one', { confirmed: true }), /还在执行/);
  assert.equal((await f.history.resolve('one')).deleted, false);
});
test('downloaded cloud copies stay account-owned and late refresh cannot revive an owner deletion', async t => {
  const f = setup(t);
  const handle = { snapshot: () => ({ messages: [{ role: 'assistant', text: 'saved cloud answer' }] }),
    historyRow: () => ({ id: 'remote-one', cloud: true, remoteProjection: true, adapterId: 'codex-harness', title: 'Cloud result' }) };
  await f.history.capture(handle, identity());
  const copy = (await f.history.list()).items[0];
  assert.ok(copy.id.startsWith('copy-'));
  assert.equal(copy.cloud, false);
  assert.equal((await f.history.read(copy.id)).items[0].text, 'saved cloud answer');
  f.identity = identity('two');
  assert.deepEqual((await f.history.list()).items, []);
  await assert.rejects(f.history.read(copy.id), /账号|归属/);
  await assert.rejects(f.history.lifecycle(copy.id, 'delete', identity('two')), /账号|归属/);
  f.identity = identity();
  await f.history.lifecycle(copy.id, 'delete', identity());
  await f.history.capture(handle, identity());
  assert.equal((await f.history.list()).items.length, 0);
  assert.equal((await f.history.resolve(copy.id)).deleted, true);
  assert.equal((await f.history.resolve(copy.id)).source.id, 'remote-one');
});

test('archived task copies keep executable origins out of cold recent history until explicit restore', async t => {
  const f = setup(t), who = identity();
  const origin = { id: 'remote-one', taskId: 'task-one', cloud: true, remoteProjection: true,
    title: 'Same title', at: 20 };
  const alias = { ...origin, id: 'remote-alias', historyAliasIds: [origin.id] };
  const namesake = { ...origin, id: 'other', taskId: 'other-task' };
  await f.history.capture({ snapshot: () => ({ messages: [{ role: 'assistant', text: 'retained' }] }),
    historyRow: () => origin }, who);
  const copy = (await f.history.list()).items[0];
  await f.history.lifecycle(copy.id, 'archive', who);
  const projections = [origin, alias, namesake];
  assert.equal((await f.history.remoteLifecycle(projections, who)).length, 2);
  assert.deepEqual(await f.history.remoteLifecycle(projections, identity('two')), []);
  assert.deepEqual(await f.history.remoteLifecycle(projections, { ...who, hub: 'https://other.invalid' }), []);
  const makeBridge = () => {
    const bridge = require('../main/agent-runtime/pi-session-bridge').createPiSessionBridge({ app: f.app,
      sessionModule: { open: async () => ({}), probe: async () => ({ ok: true }),
        history: async () => ({ ok: true, chats: [] }) }, runnerAdapters: [] });
    bridge.setExternalHistory({ history: async options => ({ ok: true, chats: options?.archived ? [] : projections }) });
    bridge.setReplicaHistory({ ...f.history, remoteLifecycle: rows => f.history.remoteLifecycle(rows, who) });
    return bridge;
  };
  let bridge = makeBridge();
  assert.deepEqual((await bridge.history()).chats.map(row => row.id), ['other']);
  await bridge.dispose();
  bridge = makeBridge();
  assert.deepEqual((await bridge.history()).chats.map(row => row.id), ['other']);
  assert.ok((await bridge.archivedHistory()).chats.some(row => row.id === copy.id));
  await f.history.lifecycle(copy.id, 'restore', who);
  const restored = await bridge.history();
  assert.equal(restored.chats.filter(row => row.taskId === 'task-one').length, 1);
  assert.ok(restored.lifecycle.some(row => row.id === origin.id && !row.archived && row.lifecycleRevision > 0));
  assert.equal((await f.history.read(copy.id)).items[0].text, 'retained');
  await f.history.lifecycle(copy.id, 'delete', who);
  assert.deepEqual(await f.history.remoteLifecycle(projections, who), []);
  assert.equal((await bridge.history()).chats.filter(row => row.taskId === 'task-one').length, 1);
  await bridge.dispose();
});

test('remote lifecycle skips unrelated inventory and resolves all alias batches with the newest explicit intent', async t => {
  const f = setup(t), who = identity();
  f.store.list = () => assert.fail('Lifecycle overlays must not scan the local inventory');
  let queries = 0;
  const lookup = f.store.remoteLifecycleRows.bind(f.store);
  f.store.remoteLifecycleRows = options => { queries++; return lookup(options); };
  assert.deepEqual(await f.history.remoteLifecycle([], who), []);
  assert.deepEqual(await f.history.remoteLifecycle([{ id: 'native' }], who), []);
  assert.equal(queries, 0);
  const origin = { id: 'last-alias', taskId: 'shared-task', cloud: true };
  await f.history.capture({ snapshot: () => ({ messages: [{ role: 'assistant', text: 'retained' }] }),
    historyRow: () => origin }, who);
  const original = f.store.get('last-alias');
  await f.history.lifecycle(original.id, 'archive', who);
  f.store.register([{ id: 'second-copy', cached: true, taskId: origin.taskId,
    source: { id: 'another-origin', account: 'one', hub: who.hub } }]);
  await f.history.lifecycle('second-copy', 'archive', who);
  await f.history.lifecycle('second-copy', 'restore', who);
  f.store.register([{ id: 'foreign-copy', cached: true, taskId: origin.taskId,
    source: { id: 'foreign-origin', account: 'one', hub: 'https://foreign.test' } }]);
  f.identity = { ...who, hub: 'https://foreign.test' };
  await f.history.lifecycle('foreign-copy', 'archive', f.identityOf());
  f.identity = who;
  const rows = Array.from({ length: 205 }, (_, index) => ({ id: 'view-' + index, cloud: true,
    historyAliasIds: [index === 204 ? 'last-alias' : 'missing-' + index] }));
  rows.push({ id: 'task-view', taskId: origin.taskId, remoteProjection: true });
  const states = await f.history.remoteLifecycle(rows, who);
  assert.deepEqual(states.map(row => [row.id, row.archived]).sort(), [['task-view', false], ['view-204', true]]);
  assert.equal(queries, 3, 'Every source identity batch is queried, including the last alias');
  assert.deepEqual(await f.history.remoteLifecycle(rows, { ...who, hub: 'malformed' }), []);
  assert.equal(queries, 3);
});

test('large cloud snapshots are cached in bounded batches without losing their tail', async t => {
  const f = setup(t), original = f.store.cache.bind(f.store), writes = [];
  f.store.cache = (id, messages, options) => {
    writes.push({ bytes: Buffer.byteLength(JSON.stringify(messages)), ...options });
    return original(id, messages, options);
  };
  const messages = Array.from({ length: 40 }, (_, i) => ({ role: 'assistant', text: String(i) + 'x'.repeat(600000) }));
  const handle = { snapshot: () => ({ messages }), historyRow: () => ({ id: 'large-remote', cloud: true }) };
  await f.history.capture(handle, identity());
  assert.ok(writes.length > 1);
  assert.ok(writes.every(row => row.bytes < 16 * 1024 * 1024));
  assert.equal(writes.at(-1).complete, true);
  const copy = (await f.history.list()).items[0];
  const stored = []; let after = 0;
  do {
    const page = await f.history.read(copy.id, { after });
    stored.push(...page.items); after = page.nextCursor;
  } while (after !== null);
  assert.deepEqual(stored.map(row => row.text), messages.map(row => row.text));
  messages.splice(2);
  await f.history.capture(handle, identity());
  assert.equal((await f.history.read(copy.id)).items.length, 2);
});
