'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { identity } = require('./helpers/platform-session-fixture.cjs');
const { scope } = require('../main/platform-connections/runtime.cjs');
const { createWorker } = require('../main/conversation/replica-store.cjs');
const { create: createHistory } = require('../main/conversation/shared-history.cjs');
const { create: createSync } = require('../main/conversation/account-sync');

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-account-display-'));
  const app = { getPath: () => root }, actor = identity(), batches = [];
  const storage = createWorker(path.join(root, 'replicas.sqlite'));
  const store = new Proxy(storage, { get(target, key) {
    if (key === 'nativeRows') return (ids, options) => { batches.push(ids.length); return target.nativeRows(ids, options); };
    return target[key];
  } });
  const history = createHistory({ app, store, session: new Proxy({}, {
    get: (_target, name) => () => assert.fail('Display linking called runtime method: ' + String(name)),
  }) });
  t.after(async () => { await history.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const native = (id, extra = {}) => ({ id, adapterId: 'pi', count: 2, title: 'Same title', workOwner: scope(actor),
    creator: { account: 'one', hub: actor.hub }, ...extra });
  const account = (id, source, extra = {}) => ({ id, sourceSessionId: source, sourceClientId: actor.clientId,
    title: 'Same title', revision: 1, messageCount: 2, ...extra });
  return { app, actor, history, storage, batches, native, account };
}

test('display links use owned indexed native identities without claiming copies or account lifecycle aliases', async t => {
  const f = await fixture(t);
  await f.history.register([f.native('native', { historyAliasIds: ['runtime-child'] }),
    f.native('other-owner', { workOwner: scope(identity('two')), creator: { account: 'two', hub: f.actor.hub } }),
    f.native('ownerless', { workOwner: undefined }), f.native('unproven-origin', { creator: null }),
    f.native('download', { cached: true, source: { id: 'acct-downloaded', account: 'one', hub: f.actor.hub }, sourceSessionId: 'copy-source' }),
    f.native('deleted')]);
  await f.storage.lifecycle('deleted', 'delete');
  const before = await f.storage.catalog();
  const rows = [f.account('acct-owned', 'native'), f.account('acct-child', 'runtime-child'),
    f.account('acct-foreign-device', 'native', { sourceClientId: 'another-device' }),
    f.account('acct-other-owner', 'other-owner'), f.account('acct-ownerless', 'ownerless'),
    f.account('acct-unproven-origin', 'unproven-origin'),
    f.account('acct-copy', 'download'), f.account('acct-origin', 'copy-source'), f.account('acct-downloaded', 'unindexed'),
    f.account('acct-deleted-native', 'deleted'), f.account('acct-deleted', 'native', { deleted: true })];
  assert.deepEqual((await f.history.accountDisplayLinks(rows, f.actor)).sort(),
    [['acct-owned', 'native'], ['acct-child', 'native'], ['acct-deleted-native', 'deleted']].sort());
  assert.deepEqual(await f.storage.catalog(), before, 'Display association cannot mutate either store or its lifecycle aliases');
  assert.equal((await f.storage.get('acct-owned')), null);
  assert.deepEqual(await f.history.accountDisplayLinks(rows, identity('two')), [['acct-other-owner', 'other-owner']],
    'The other account may link only its own archive, not the first account native IDs');
  assert.deepEqual(await f.history.accountDisplayLinks(rows, { ...f.actor, hub: 'https://another.invalid' }), []);
});

test('account history keeps display links separate from lifecycle, recomputes them after local changes, and never scans SDK archives', async t => {
  const f = await fixture(t), item = f.account('acct-owned', 'native');
  let current = f.actor;
  const sync = createSync({ app: f.app, identityOf: () => current, localIdentityOf: () => current,
    store: { jobs: () => [] }, resolveNativeSource: () => assert.fail('Account list scanned SDK archives'),
    resolveDisplayLinks: (rows, actor) => f.history.accountDisplayLinks(rows, actor),
    fetch: async () => new Response(JSON.stringify({ items: [item], hasMore: false })) });
  t.after(() => sync.close());
  assert.equal((await sync.history({ source: 'account' })).chats[0].displayNativeId, undefined);
  await f.history.register([f.native('native')]);
  const linked = await sync.history({ source: 'account' });
  assert.equal(linked.chats[0].id, item.id); assert.equal(linked.chats[0].displayNativeId, 'native');
  assert.deepEqual(linked.chats[0].historyAliasIds, [item.id]);
  assert.deepEqual(linked.lifecycle[0].nativeIds, []); assert.deepEqual(linked.lifecycle[0].historyAliasIds, [item.id]);
  await f.storage.lifecycle('native', 'delete');
  const deleted = await sync.history({ source: 'account' });
  assert.equal(deleted.chats[0].displayNativeId, 'native', 'A local tombstone retains the verified display relationship');
  assert.equal(deleted.chats[0].deleted, false, 'Local display suppression does not delete the account original');
  assert.deepEqual(deleted.lifecycle[0].historyAliasIds, [item.id]);
  current = identity('two');
  assert.equal((await sync.history({ source: 'account' })).chats[0].displayNativeId, undefined);
});

test('a large account directory links through bounded worker batches and leaves remote-only IDs independent', async t => {
  const f = await fixture(t), native = Array.from({ length: 451 }, (_, i) => f.native('native-' + i));
  await f.history.register(native);
  const rows = native.map(row => f.account('acct-' + row.id, row.id));
  rows.push(...Array.from({ length: 1000 }, (_, i) => f.account('foreign-' + i, 'native-' + i, { sourceClientId: 'foreign' })));
  const links = await f.history.accountDisplayLinks(rows, f.actor);
  assert.equal(links.length, 451); assert.deepEqual(f.batches, [200, 200, 51]);
  assert.ok(links.some(([account, native]) => account === 'acct-native-450' && native === 'native-450'));
  assert.ok(links.every(([account]) => account.startsWith('acct-')));
});

test('late display linking cannot publish an old account response and a failed local index leaves the directory usable', async t => {
  const f = await fixture(t);
  let current = f.actor, release, started;
  const entered = new Promise(resolve => { started = resolve; });
  const sync = createSync({ app: f.app, identityOf: () => current, localIdentityOf: () => current,
    store: { jobs: () => [] }, resolveDisplayLinks: async () => { started(); return new Promise(resolve => { release = resolve; }); },
    fetch: async () => new Response(JSON.stringify({ items: [f.account('acct-a', 'native')], hasMore: false })) });
  t.after(() => sync.close());
  const pending = sync.history({ source: 'account' }); await entered;
  current = identity('two'); release([['acct-a', 'native']]);
  assert.equal((await pending).ok, false);
  const failed = createSync({ app: f.app, identityOf: () => f.actor, store: { jobs: () => [] },
    resolveDisplayLinks: async () => { throw Error('index unavailable'); },
    fetch: async () => new Response(JSON.stringify({ items: [f.account('acct-a', 'native')], hasMore: false })) });
  t.after(() => failed.close());
  const result = await failed.history({ source: 'account' });
  assert.equal(result.ok, true); assert.equal(result.chats[0].id, 'acct-a');
  assert.equal(result.chats[0].displayNativeId, undefined);
});

test('production capture and account pagination preserve display proof without importing account IDs into the local catalog', async t => {
  const f = await fixture(t);
  require('../main/conversation/session-memory').bind(f.app, 'captured', f.actor, [], true);
  await f.history.capture({ historyRow: () => ({ id: 'captured', title: 'Captured native', adapterId: 'pi', at: 1000 }),
    snapshot: () => ({ messages: [{ role: 'user', text: 'Persisted native question' }] }) }, f.actor);
  assert.deepEqual(await f.history.accountDisplayLinks([f.account('acct-captured', 'captured')], f.actor), [['acct-captured', 'captured']]);
  const native = Array.from({ length: 73 }, (_, i) => f.native('paged-' + i, { at: i + 1 }));
  await f.history.register(native);
  let requests = 0;
  const sync = createSync({ app: f.app, identityOf: () => f.actor, store: { jobs: () => [] },
    resolveDisplayLinks: (items, actor) => f.history.accountDisplayLinks(items, actor),
    resolveNativeSource: () => assert.fail('Pagination cannot scan native runtimes'),
    fetch: async () => { requests++; return new Response(JSON.stringify({
      items: native.map(row => ({ ...f.account('acct-' + row.id, row.id), updatedAt: new Date(row.at).toISOString() })), hasMore: false,
    })); } });
  const bridge = require('../main/agent-runtime/pi-session-bridge').createPiSessionBridge({ app: f.app, runnerAdapters: [],
    sessionModule: { open: async () => assert.fail('Pagination cannot start execution'), probe: async () => ({ ok: true }),
      history: () => assert.fail('Pagination cannot scan SDK archives') } });
  bridge.setExternalHistory({ history: options => sync.history(options) }); bridge.setReplicaHistory(f.history);
  t.after(async () => { await sync.close(); await bridge.dispose(); });
  const rows = []; let after;
  do {
    const page = await bridge.history(f.app, { source: 'account', limit: 17, after });
    assert.ok(page.chats.length <= 17); rows.push(...page.chats); after = page.next;
  } while (after);
  assert.equal(rows.length, 73); assert.equal(new Set(rows.map(row => row.id)).size, 73);
  assert.ok(rows.every(row => row.displayNativeId === row.id.slice('acct-'.length)));
  assert.equal(requests, 1, 'Local association refresh reuses the authenticated directory cache');
  const catalog = await f.storage.catalog();
  assert.ok(catalog.items.every(row => row.historyAliasIds.every(id => !id.startsWith('acct-'))));
});
