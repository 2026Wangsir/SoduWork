'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { identity } = require('./helpers/platform-session-fixture.cjs');
const runtime = require('../main/platform-connections/runtime.cjs');
const cardsModule = require('../main/conversation/work-conversation-cards');

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-cached-cards-'));
  const app = { getPath: () => root }, actor = identity();
  let current = actor;
  const native = { id: 'native-owned', adapterId: 'pi', title: 'Same synthetic title',
    workOwner: runtime.scope(actor), at: 10, count: 2, cwd: root, path: path.join(root, 'native.jsonl') };
  const original = { id: 'acct-source', adapterId: 'account-sync', title: native.title,
    sourceClientId: 'other-device', sourceSessionId: 'other-native', accountProjection: true,
    accountConversation: true, owner: runtime.connectionScope(actor), at: 20 };
  const bridge = require('../main/agent-runtime/pi-session-bridge').createPiSessionBridge({ app,
    runnerAdapters: [], sessionModule: {
      open: () => assert.fail('Reading cards cannot start a runtime'), probe: async () => ({ ok: true }),
      history: async () => ({ ok: true, chats: [native] }),
      archivedHistory: async () => ({ ok: true, chats: [] }),
      historyEntry: async (_app, id) => id === native.id ? { ok: true, entry: native } : { ok: false, notFound: true },
    } });
  bridge.setExternalHistory({ history: async () => ({ ok: true, chats: [original] }) });
  const shared = require('../main/conversation/shared-history.cjs').create({ app, session: bridge, identityOf: () => current });
  bridge.setReplicaHistory(shared);
  t.after(async () => { await shared.close(); await bridge.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  await shared.capture({ historyRow: () => original, snapshot: () => ({ messages: [
    { role: 'user', text: 'Synthetic historical question' }, { role: 'assistant', text: 'Synthetic historical answer' },
  ] }) }, actor);
  const copy = (await shared.list()).items.find(row => row.cached);
  await shared.register([{ ...copy, historyAliasIds: ['copy-native-alias'] }]);
  const cards = cardsModule.create({ app, session: bridge, sharedHistory: shared,
    identityOf: async () => current, newCwd: () => assert.fail('Read cannot create a workspace') });
  return { app, bridge, shared, cards, original, copy, native, actor, setIdentity: value => { current = value; } };
}

test('legacy history winner can restore cached transcript without inventing a native work-form archive', async t => {
  const f = await fixture(t);
  const history = await f.bridge.history(f.app);
  assert.equal(history.ok, true);
  assert.equal(history.chats.length, 2, 'unrelated same-title native conversation remains separate');
  const selected = history.chats.find(row => row.cached);
  assert.equal(selected.id, f.copy.id);
  assert.ok(selected.historyAliasIds.includes(f.original.id));
  assert.equal(await f.bridge.archivedConversation(f.app, selected.id), null);
  assert.equal((await f.shared.read(selected.id)).items.length, 2);
  const reply = await f.cards.read(selected.id);
  assert.equal(reply.ok, true, reply.reason);
  assert.deepEqual(reply.cards, []);
  assert.equal(reply.workOnly, false);
  assert.equal(reply.draftSelection, null);
  assert.equal(reply.presence.id, selected.id);
  assert.equal(fs.existsSync(cardsModule.location(f.app, selected.id)), false);
});

test('cached cloud preflight is passive for its owner and denied across accounts or sign-out', async t => {
  const f = await fixture(t);
  const card = { id: 'draft', actionId: 'work.requirement.create', prompt: 'Private synthetic draft', seed: {}, state: {}, files: [], closed: false };
  for (const actor of [f.actor, identity('two'), null]) {
    f.setIdentity(actor);
    for (const id of [f.copy.id, 'copy-native-alias']) {
      const result = await f.cards.read(id);
      if (actor === f.actor) {
        assert.equal(result.ok, true, result.reason); assert.deepEqual(result.cards, []);
        assert.equal(result.workOnly, false); assert.equal(result.draftSelectionRevision, 0);
      } else {
        assert.equal(result.ok, false, 'Cloud copy titles and content stay private');
        assert.equal(result.presence, undefined);
        await assert.rejects(f.shared.read(id), /账号|登录/);
      }
      assert.equal((await f.cards.save(id, card)).ok, false);
      assert.equal((await f.cards.saveDraftSelection(id, { selection: { adapterId: 'pi' }, revision: 0 })).ok, false);
    }
  }
  assert.equal((await f.cards.read(f.original.id)).ok, false, 'a source locator does not become a signed-out local identity');
  assert.equal((await f.cards.read('missing-conversation')).ok, false);
  f.setIdentity(f.actor);
  await f.shared.lifecycle(f.copy.id, 'delete', f.actor);
  assert.equal((await f.cards.read(f.copy.id)).ok, false, 'deleted local transcripts are not resurrected');
  assert.equal(fs.existsSync(cardsModule.location(f.app, f.copy.id)), false);
});

test('native form restore and its ownership checks are unchanged by cached transcript preflight', async t => {
  const f = await fixture(t);
  await f.bridge.history(f.app);
  const saved = await f.cards.save(f.native.id, { id: 'draft', actionId: 'work.requirement.create',
    prompt: 'Owned native form', seed: {}, state: { marker: 'private' }, files: [], closed: false });
  assert.equal(saved.ok, true, saved.reason);
  const before = fs.readFileSync(cardsModule.location(f.app, f.native.id), 'utf8');
  const own = await f.cards.read(f.native.id);
  assert.equal(own.ok, true, own.reason); assert.equal(own.cards[0].state.marker, 'private');
  f.setIdentity(identity('two'));
  assert.equal((await f.cards.read(f.native.id)).ok, false);
  assert.equal(fs.readFileSync(cardsModule.location(f.app, f.native.id), 'utf8'), before);
  f.setIdentity(null);
  assert.equal((await f.cards.read(f.native.id)).ok, false);
});
