'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { identity } = require('./helpers/platform-session-fixture.cjs');
const { scope } = require('../main/platform-connections/runtime.cjs');
const access = require('../main/conversation/history-access');
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-account-isolation-'));
  const app = { getPath: () => root }, a = identity(), b = identity('two'); let current = a;
  const store = require('../main/conversation/replica-store.cjs').createWorker(path.join(root, 'replicas.sqlite'));
  const session = { findBySessionId: () => null, history: async () => ({ ok: true, chats: [] }),
    archivedHistory: async () => ({ ok: true, chats: [] }), archivedConversation: async (_app, id) => store.get(id),
    historyEntry: async (_app, id) => ({ ok: true, entry: await store.get(id) }) };
  const history = require('../main/conversation/shared-history.cjs').create({ app, session, store, identityOf: () => current });
  const row = (id, owner = a, extra = {}) => ({ id, count: 2, adapterId: 'pi', at: 100,
    workOwner: scope(owner), creator: { account: owner === b ? 'two' : 'one', hub: owner.hub }, ...extra });
  const cached = async (id, owner = a, extra = {}) => {
    const [saved] = await history.register([row(id, owner, { cached: true, ...extra })]);
    assert.equal((await store.cache(id, [{ role: 'user', text: id + ' private prompt' }, { role: 'assistant', text: id + ' private answer' }],
      { start: 0, complete: true, expectedRevision: saved.replicaRevision })).ok, true);
  };
  t.after(async () => { await history.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, app, a, b, store, session, history, row, cached, set current(value) { current = value; }, get current() { return current; } };
}
test('A to B to A scopes pages, catalog aliases/origins, archives and direct cached reads without deleting data', async t => {
  const f = await fixture(t);
  await f.cached('a', f.a, { historyAliasIds: ['alias-a'], source: { id: 'source-a', account: 'one', hub: f.a.hub } });
  await f.cached('b', f.b, { historyAliasIds: ['alias-b'], source: { id: 'source-b', account: 'two', hub: f.b.hub } });
  await f.cached('a-archived', f.a); await f.store.lifecycle('a-archived', 'archive');
  await f.history.register([{ id: 'unknown', count: 1, path: path.join(f.root, 'unknown.jsonl') },
    f.row('conflict', f.a, { workOwner: scope(f.b) })]);
  const before = await f.store.catalog(); let aWorkspace;
  for (const [owner, expected] of [[f.a, 'a'], [f.b, 'b'], [f.a, 'a']]) {
    f.current = owner;
    const page = await f.history.page({ limit: 2 });
    assert.deepEqual(page.chats.map(row => row.id), [expected]);
    assert.ok(page.localCatalog.items.every(row => row.id === expected || expected === 'a' && row.id === 'a-archived'));
    assert.ok(page.localCatalog.items.every(row => !JSON.stringify(row).includes(expected === 'a' ? 'source-b' : 'source-a')));
    if (expected === 'a') { aWorkspace ||= page.localCatalog.workspace; assert.equal(page.localCatalog.workspace, aWorkspace); }
    else assert.notEqual(page.localCatalog.workspace, aWorkspace);
    assert.equal((await f.history.read(expected)).items[0].text, expected + ' private prompt');
    assert.equal(await f.history.resolve(expected === 'a' ? 'b' : 'a'), null);
    await assert.rejects(f.history.read(expected === 'a' ? 'b' : 'a'), /不存在/);
    const archives = await f.history.list({ archived: true });
    assert.deepEqual(archives.items.map(row => row.id), expected === 'a' ? ['a-archived'] : []);
    assert.deepEqual((await f.history.lifecycleRows()).map(row => row.id), expected === 'a' ? ['a-archived'] : []);
  }
  assert.deepEqual(await f.store.catalog(), before, 'Account switching never rewrites or deletes archives');
  f.current = { ...f.a, hub: 'https://other-hub.invalid' };
  assert.equal((await f.history.page()).chats.length, 0);
  f.current = null;
  assert.equal((await f.history.page()).localCatalog.items.length, 0);
  await assert.rejects(f.history.read('a'), /不存在/);
});
test('authorized pagination crosses foreign and unknown entries; metadata directory and cursor validation agree', async t => {
  const f = await fixture(t);
  await f.history.register(Array.from({ length: 80 }, (_, i) => f.row('item-' + i, i % 3 ? f.b : f.a, { at: i })));
  const rows = []; let after, catalog;
  do {
    const page = await f.history.page({ limit: 5, after, workspace: catalog?.workspace, catalogRevision: catalog?.revision });
    if (catalog) assert.equal(page.localCatalog.items, undefined);
    else catalog = page.localCatalog;
    rows.push(...page.chats); after = page.next;
  } while (after);
  assert.equal(rows.length, 27); assert.equal(new Set(rows.map(row => row.id)).size, 27);
  const directory = []; let cursor = 0, more;
  do { const page = await f.history.directory(cursor, 7); directory.push(...page.items); cursor = page.cursor; more = page.hasMore; } while (more);
  assert.deepEqual(directory.map(row => row.id).sort(), rows.map(row => row.id).sort());
  for (const options of [{ limit: 0 }, { limit: 201 }, { after: { at: 'bad', id: 'x' } }, { workspace: 'foreign' }])
    await assert.rejects(f.history.page(options), /Invalid|workspace/);
  for (const args of [[-1, 5], [0, 0], [0, 201], [NaN, 1]]) await assert.rejects(f.history.directory(...args), /Invalid/);
});
test('unknown native ownership is never claimed and sidecar conflicts invalidate cached catalogs immediately', async t => {
  const f = await fixture(t), file = path.join(f.root, 'pi-agent', 'sessions', 'native.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ type: 'message', message: { role: 'user', content: 'native text' } }) + '\n');
  await f.history.register([{ id: 'unknown', path: file, count: 1, adapterId: 'pi' }, f.row('owned', f.a, { path: file })]);
  assert.throws(() => access.assertOwner(f.app, 'unknown', access.actor(f.app, f.a), { id: 'unknown', path: file, count: 1 }, { allowLegacy: true }), /当前账号/);
  assert.equal(fs.existsSync(path.join(f.root, 'conversation-history-owners')), false);
  assert.equal(await f.history.open('unknown'), null);
  assert.equal((await f.history.read('owned')).items[0].text, 'native text');
  const before = await f.history.page();
  const folder = path.join(f.root, 'session-memory-bindings'); fs.mkdirSync(folder);
  const binding = path.join(folder, crypto.createHash('sha256').update('owned').digest('hex') + '.json');
  fs.writeFileSync(binding, JSON.stringify({ owner: scope(f.b), ids: [] }));
  const denied = await f.history.page({ workspace: before.localCatalog.workspace, catalogRevision: before.localCatalog.revision });
  assert.deepEqual(denied.chats, []); assert.deepEqual(denied.localCatalog.items, []);
  await assert.rejects(f.history.read('owned'), /不存在/);
  fs.writeFileSync(binding, JSON.stringify({ owner: scope(f.a), ids: [] }));
  assert.equal((await f.history.page()).chats.length, 1, 'In-place sidecar changes are also observed');
});
test('a late A read and an already loaded view cannot return content after account switch', async t => {
  const f = await fixture(t); await f.cached('a');
  const view = await f.history.open('a');
  assert.equal(view.snapshot().messages.length, 2);
  const original = f.store.messages; let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  f.store.messages = async (...args) => { const page = await original(...args); entered(); await new Promise(resolve => { release = resolve; }); return page; };
  const pending = f.history.read('a'); await started;
  f.current = f.b; await f.history.page();
  assert.throws(() => view.snapshot(), /切换/);
  await assert.rejects(view.loadHistory(), /切换/);
  f.current = f.a; await f.history.page(); release();
  await assert.rejects(pending, /切换/);
  assert.throws(() => view.snapshot(), /切换/, 'Returning to A does not revive an old view epoch');
  await view.close();
});

test('legacy environment owners prove only their original Hub; account-only owners never invent provenance', async t => {
  const f = await fixture(t), runtime = require('../main/platform-connections/runtime.cjs');
  const own = { id: 'legacy', workOwner: runtime.connectionScope(f.a) };
  assert.doesNotThrow(() => access.assertReadable(f.app, own.id, access.actor(f.app, f.a), own));
  assert.throws(() => access.assertReadable(f.app, own.id, access.actor(f.app, { ...f.a, hub: 'https://other.invalid' }), own));
  assert.throws(() => access.assertReadable(f.app, 'account-only', access.actor(f.app, f.a),
    { id: 'account-only', workOwner: scope(f.a) }), error => error.code === 'HISTORY_HUB_MISSING');
  const enrolled = access.actor(f.app, f.a);
  enrolled.candidates.push({ hub: f.a.hub, clientId: 'retired-device' });
  assert.doesNotThrow(() => access.assertReadable(f.app, own.id, enrolled,
    { ...own, workOwner: runtime.legacyScope(f.a.hub, 'retired-device', f.a) }));
});

test('ownership changes during a warm catalog or lifecycle query cannot publish stale aliases', async t => {
  const f = await fixture(t); await f.cached('owned', f.a, { historyAliasIds: ['private-alias'] });
  const memory = require('../main/conversation/session-memory');
  memory.bind(f.app, 'owned', f.a, [], true);
  await f.store.lifecycle('owned', 'archive');
  const initial = await f.history.page({ archived: true });
  const catalog = f.store.catalog; let change = true;
  f.store.catalog = async (...args) => { const result = await catalog(...args);
    if (change) { change = false; memory.bind(f.app, 'owned', f.b, [], true); } return result; };
  const latest = await f.history.page({ archived: true, workspace: initial.localCatalog.workspace,
    catalogRevision: initial.localCatalog.revision });
  assert.deepEqual(latest.chats, []); assert.deepEqual(latest.localCatalog.items, []);
  assert.ok(latest.localCatalog.revision > initial.localCatalog.revision);
  memory.bind(f.app, 'owned', f.a, [], true); await f.history.page();
  const lifecycle = f.store.lifecycleRows;
  f.store.lifecycleRows = async () => { const result = await lifecycle(); memory.bind(f.app, 'owned', f.b, [], true); return result; };
  await assert.rejects(f.history.lifecycleRows(), /归属已变化/);
  assert.deepEqual((await f.history.page()).localCatalog.items, []);
});

test('native body reads reject a fresh transcript owner that conflicts with the older index', async t => {
  const f = await fixture(t), file = path.join(f.root, 'pi-agent', 'sessions', 'fixture', 'native.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const write = owner => fs.writeFileSync(file, [
    { type: 'session', id: 'native', timestamp: new Date().toISOString() },
    { type: 'custom', customType: 'soduwork.work-entry', data: { version: 1, owner: scope(owner) } },
    { type: 'message', message: { role: 'user', content: 'account-private-body' } },
  ].map(row => JSON.stringify(row)).join('\n'));
  write(f.a); await f.history.register([f.row('native', f.a, { path: file })]);
  f.session.historyEntry = require('../main/pi-session/session').historyEntry;
  assert.equal((await f.history.read('native')).items[0].text, 'account-private-body');
  write(f.b);
  await assert.rejects(f.history.read('native'), /另一个账号/);
});

test('late cached content and a loaded snapshot recheck changed persisted ownership', async t => {
  const f = await fixture(t); await f.cached('owned');
  const view = await f.history.open('owned'), original = f.store.messages;
  f.store.messages = async (...args) => { const result = await original(...args);
    require('../main/conversation/session-memory').bind(f.app, 'owned', f.b, [], true); return result; };
  await assert.rejects(f.history.read('owned'), /归属已变化/);
  assert.throws(() => view.snapshot(), /另一个账号/);
  assert.throws(() => view.uiSnapshot(), /另一个账号/);
});

test('ten thousand mixed-account rows keep authorized paging bounded and reuse ownership metadata', async t => {
  const f = await fixture(t), { performance } = require('node:perf_hooks');
  for (let from = 0; from < 10000; from += 200) await f.history.register(Array.from({ length: 200 }, (_, offset) => {
    const index = from + offset;
    return f.row('large-' + index, index % 2 ? f.b : f.a, { at: index, historyAliasIds: ['segment-' + index] });
  }));
  let heartbeat = 0;
  const timer = setInterval(() => heartbeat++, 1), start = performance.now();
  const first = await f.history.page({ limit: 50 });
  const firstMs = Math.round(performance.now() - start), warm = performance.now();
  assert.equal(first.localCatalog.items.length, 5000);
  const pages = await Promise.all(Array.from({ length: 16 }, () => f.history.page({ limit: 50, after: first.next,
    workspace: first.localCatalog.workspace, catalogRevision: first.localCatalog.revision })));
  clearInterval(timer);
  assert.ok(heartbeat > 0);
  assert.ok(pages.every(page => page.chats.length === 50 && !page.localCatalog.items));
  assert.ok(pages.every(page => page.chats.every(row => Number(row.id.slice(6)) % 2 === 0)));
  t.diagnostic(JSON.stringify({ rows: 10000, authorized: 5000, firstMs,
    warmPages: 16, warmMs: Math.round(performance.now() - warm), heartbeat }));
});

function legacyMemoryRecord(f, id, owner, hub) {
  const folder = path.join(f.root, 'session-memory-bindings');
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, crypto.createHash('sha256').update(id).digest('hex') + '.json');
  fs.writeFileSync(file, JSON.stringify({ owner, ids: [], ...(hub === undefined ? {} : { hub }) }));
  return file;
}

test('restoring ordinary work cards preserves a legacy native archive original Hub when its owner migrates', async t => {
  const f = await fixture(t), runtime = require('../main/platform-connections/runtime.cjs');
  const row = f.row('legacy-native', f.a, { creator: null, workOwner: undefined });
  const file = legacyMemoryRecord(f, row.id, runtime.legacyScope(f.a.hub, f.a.clientId, f.a));
  await f.history.register([row]);
  assert.ok(await f.history.resolve(row.id), 'the original legacy fingerprint already proves the current Hub');
  f.session.archivedConversation = async (_app, id) => id === row.id ? row : null;
  const cards = require('../main/conversation/work-conversation-cards').create({
    app: f.app, session: f.session, identityOf: async () => f.current });
  assert.equal((await cards.read(row.id)).ok, true, 'the normal pre-open work-card read performs the migration');
  const migrated = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(migrated.owner, scope(f.a));
  assert.equal(migrated.hub, new URL(f.a.hub).origin);
  assert.deepEqual(migrated.ids, []);
  assert.ok(await f.history.resolve(row.id), 'reading cards must not hide an already-owned archive');
  assert.deepEqual((await f.history.page()).chats.map(row => row.id), [row.id]);
});

test('legacy memory migration retains the proven original Hub and device instead of the current connection', async t => {
  const f = await fixture(t), runtime = require('../main/platform-connections/runtime.cjs');
  const memory = require('../main/conversation/session-memory'), auth = require('../main/device-auth');
  const row = f.row('legacy-other-hub', f.a, { creator: null, workOwner: undefined });
  const originalHub = f.a.hub, originalClient = 'retired-device';
  const file = legacyMemoryRecord(f, row.id, runtime.legacyScope(originalHub, originalClient, f.a));
  t.mock.method(auth, 'profiles', () => [{ hub: originalHub, clientId: originalClient }]);
  await f.history.register([row]);
  f.current = { ...f.a, hub: 'https://different-hub.invalid' };
  assert.equal(await f.history.resolve(row.id), null);
  assert.deepEqual(memory.binding(f.app, row.id, f.current), []);
  const migrated = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(migrated.owner, scope(f.a));
  assert.equal(migrated.hub, new URL(originalHub).origin, 'the current Hub must not replace verified legacy provenance');
  assert.equal(await f.history.resolve(row.id), null, 'memory migration grants no cross-Hub archive visibility');
  f.current = f.a;
  assert.ok(await f.history.resolve(row.id), 'the original Hub remains readable after device and account-hash migration');
});

test('legacy memory migration preserves explicit provenance and refuses another account fingerprint', async t => {
  const f = await fixture(t), runtime = require('../main/platform-connections/runtime.cjs');
  const memory = require('../main/conversation/session-memory');
  const row = f.row('legacy-explicit-hub', f.a, { creator: null, workOwner: undefined });
  const explicitHub = 'https://conflicting-hub.invalid';
  const file = legacyMemoryRecord(f, row.id, runtime.legacyScope(f.a.hub, f.a.clientId, f.a), explicitHub);
  await f.history.register([row]);
  assert.deepEqual(memory.binding(f.app, row.id, f.a), []);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).hub, explicitHub);
  assert.equal(await f.history.resolve(row.id), null, 'existing conflicting evidence must not be overwritten');
  const foreign = legacyMemoryRecord(f, 'foreign-legacy', runtime.legacyScope(f.b.hub, f.b.clientId, f.b));
  const bytes = fs.readFileSync(foreign);
  assert.throws(() => memory.binding(f.app, 'foreign-legacy', f.a), /另一个账号/);
  assert.deepEqual(fs.readFileSync(foreign), bytes);
});

test('an account-only memory fingerprint still cannot invent missing Hub provenance', async t => {
  const f = await fixture(t), memory = require('../main/conversation/session-memory');
  const row = f.row('account-only-unknown-hub', f.a, { creator: null, workOwner: undefined });
  const file = legacyMemoryRecord(f, row.id, scope(f.a));
  const bytes = fs.readFileSync(file);
  await f.history.register([row]);
  assert.deepEqual(memory.binding(f.app, row.id, f.a), []);
  assert.deepEqual(fs.readFileSync(file), bytes);
  assert.throws(() => access.assertReadable(f.app, row.id, access.actor(f.app, f.a), row), { code: 'HISTORY_HUB_MISSING' });
  assert.equal(await f.history.resolve(row.id), null);
});
