'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { identity } = require('./helpers/platform-session-fixture.cjs');
const segments = require('../main/conversation/runtime-segments');
const access = require('../main/conversation/history-access');
const { create } = require('../main/conversation/shared-history.cjs');
const { create: createStore } = require('../main/conversation/replica-store.cjs');
const { createPiSessionBridge } = require('../main/agent-runtime/pi-session-bridge');
const { openReply } = require('../main/pi-session/open-reply');
const switchable = require('../main/agent-runtime/switchable-conversation');
const archiveState = require('../main/pi-session/archive-state');

async function fixture(t, { accountAlias = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-history-roundtrip-'));
  const app = { getPath: () => root }, actor = identity();
  const record = { version: 1, id: 'public-a', owner: segments.scope(actor), cwd: root, at: 10,
    title: 'Original first question', prefix: { messages: [{ role: 'user', text: 'Original first question' }], tools: [] },
    active: { sessionId: 'runner-a', adapterId: 'opencode', path: 'runner-a' },
    segments: [{ sessionId: 'public-a', adapterId: 'pi', path: path.join(root, 'old.jsonl') }] };
  await segments.save(app, record);
  let account = 'a';
  const auth = require('../main/device-auth'), originalIdentity = auth.identity, originalSession = auth.session;
  auth.identity = () => account === 'a' ? actor : identity('two');
  auth.session = () => auth.identity().session;
  t.after(() => { auth.identity = originalIdentity; auth.session = originalSession; });
  const creator = { account: 'one', hub: actor.hub };
  require('../main/conversation/session-memory').bind(app, 'local-second', actor, [], true);
  let rows = [
    { id: 'public-a', creator, adapterId: 'pi', title: record.title, at: 10, count: 2 },
    { id: 'runner-a', creator, adapterId: 'opencode', title: 'Later segment request', at: 20, count: 4 },
    { id: 'local-second', creator, adapterId: 'pi', title: 'Independent conversation', at: 9, count: 2 },
  ];
  let bridge, history, sync;
  async function start() {
    bridge = createPiSessionBridge({ app, runnerAdapters: [], sessionModule: {
      open: async () => assert.fail('History must not start an execution runtime'),
      probe: async () => ({ ok: true }),
      history: async () => ({ ok: true, chats: rows }),
      archiveState, archiveRoot: () => root,
      isArchived: (_app, id) => archiveState.isArchived(root, id),
      setArchived: (_app, id, value) => archiveState.setArchived(root, id, value),
    } });
    const store = createStore(path.join(root, 'replicas.sqlite'));
    history = create({ app, session: bridge, store });
    bridge.setReplicaHistory(history);
    await history.projectRows(rows);
    // Use the production authenticated mapper. A bare sourceSessionId is not
    // sufficient to make the account record an alias of the local archive.
    sync = require('../main/conversation/account-sync').create({ app,
      identityOf: () => account === 'a' ? actor : identity('two'), store: { jobs: () => [] },
      resolveNativeSource: (item, identity) => require('../main/conversation/account-native-source.cjs').resolve({
        app, identity, item, session: { archivedConversation: (_app, id) => history.resolve(id) } }),
      fetch: async () => new Response(JSON.stringify({ items: [
      { id: 'remote-' + account, title: 'Remote ' + account, sourceSessionId: 'foreign-' + account,
        sourceClientId: 'foreign-device', updatedAt: 5, messageCount: 2 },
      ...(account === 'a' && accountAlias ? [{ id: 'account-copy-a', title: 'Later segment request',
        sourceSessionId: record.id, sourceClientId: actor.clientId, canSend: true, updatedAt: 20, messageCount: 2 }] : []),
    ], hasMore: false })) });
    bridge.setExternalHistory({ history: () => sync.history({ force: true }) });
  }
  await start();
  t.after(async () => { await sync.close(); await history.close(); await bridge.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  return { app, actor, record, get history() { return history; },
    read: () => bridge.history(app),
    action: (action, id) => require('../main/pi-session/local-history-actions.cjs').create({ app, session: bridge, history })(action, id),
    switch(value) { account = value; rows = []; },
    async restart() { await sync.close(); await history.close(); await bridge.dispose(); await start(); },
  };
}

test('account A to B to A and restart isolate durable native rows without losing them', async t => {
  const f = await fixture(t);
  const first = await f.read();
  assert.deepEqual(first.chats.map(row => row.id).sort(), ['local-second', 'public-a', 'remote-a']);
  for (const account of ['b', 'a']) {
    f.switch(account);
    const next = await f.read();
    assert.deepEqual(next.chats.map(row => row.id).sort(), account === 'a' ? ['local-second', 'public-a', 'remote-a'] : ['remote-b']);
    if (account === 'a') assert.equal(next.chats.find(row => row.id === 'public-a').title, f.record.title);
    assert.equal(next.chats.some(row => row.id === 'remote-' + (account === 'a' ? 'b' : 'a')), false);
  }
  await f.restart();
  const restored = await f.read();
  assert.deepEqual(restored.chats.map(row => row.id).sort(), ['local-second', 'public-a', 'remote-a']);
  const native = restored.chats.find(row => row.id === 'public-a');
  assert.equal(native.title, f.record.title, 'a later native segment cannot rename the public conversation');
  assert.equal(native.localReplica, true);
  const reopened = switchable.create({ restored: segments.read(f.app, f.record.id),
    options: { app: f.app, identity: f.actor }, raw: {
      sessionId: 'runner-a', ref: 'reopened', adapterId: 'opencode', cwd: f.record.cwd,
      snapshot: () => ({ messages: [], tools: [], status: 'idle' }),
      historyRow: () => ({ id: 'runner-a', title: 'Later segment request' }),
    } });
  assert.equal(openReply(f.app, reopened).title, native.title, 'cold sidebar and reopened header use the same canonical title');
  await reopened.close();
  access.assertOwner(f.app, native.id, access.actor(f.app, f.actor), native);
  assert.throws(() => access.assertOwner(f.app, native.id, access.actor(f.app, identity('two')), native), /账号/);
});

test('durable fallback keeps local archive/delete intent and does not resurrect omitted native rows', async t => {
  const f = await fixture(t, { accountAlias: false });
  await f.read();
  await f.action('archive', 'public-a');
  await f.history.lifecycle('local-second', 'delete', f.actor);
  f.switch('b'); f.switch('a');
  await f.restart();
  assert.deepEqual((await f.read()).chats.map(row => row.id), ['remote-a']);
  await f.action('restore', 'public-a');
  assert.deepEqual((await f.read()).chats.map(row => row.id).sort(), ['public-a', 'remote-a']);
});

test('returning to an account cannot replace a canonical title with a later source projection', async t => {
  const f = await fixture(t);
  await f.read();
  f.switch('b'); await f.read();
  f.switch('a');
  const returned = (await f.read()).chats.find(row => row.id === f.record.id || row.sourceSessionId === f.record.id);
  assert.equal(returned?.title, f.record.title, 'the account alias must not adopt a later runtime segment request');
  assert.equal(returned.id, f.record.id, 'sidebar navigation retains the public conversation identity');
});
