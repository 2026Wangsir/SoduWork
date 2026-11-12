'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const access = require('../main/conversation/history-access');
const { identity } = require('./helpers/platform-session-fixture.cjs');
const runtime = require('../main/platform-connections/runtime.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-local-scope-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = { getPath: () => root }, a = identity(), b = identity('two');
  const row = { id: 'ordinary', adapterId: 'pi', localReplica: true, count: 2, path: path.join(root, 'pi-agent', 'sessions', 'ordinary.jsonl') };
  const save = (directory, id, value) => {
    const file = path.join(root, directory, crypto.createHash('sha256').update(id).digest('hex') + '.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); return file;
  };
  const binding = save('session-memory-bindings', row.id, { owner: runtime.scope(a), ids: ['private-memory-a'] });
  return { app, root, a, b, row, save, binding, actor: value => access.actor(app, value) };
}

test('ordinary verified native data is shared without changing private memory ownership', t => {
  const f = fixture(t), before = fs.readFileSync(f.binding, 'utf8');
  assert.equal(access.classifyLocal(f.app, f.row.id, f.row).kind, 'ordinary');
  for (const actor of [f.a, f.b, f.a]) assert.doesNotThrow(() => access.assertLocalMutation(f.app, f.row.id, f.actor(actor), f.row));
  assert.throws(() => access.assertOwner(f.app, f.row.id, f.actor(f.b), f.row), /账号/);
  assert.equal(fs.readFileSync(f.binding, 'utf8'), before);
  assert.throws(() => access.assertOwner(f.app, f.row.id, { owner: '', identity: null }, f.row));
  assert.doesNotThrow(() => access.assertReadable(f.app, f.row.id, { owner: '', identity: null }, f.row));
  assert.notEqual(access.classifyLocal(f.app, 'acct-source', f.row).kind, 'ordinary');
});

test('requirement read authority protects every native segment without transferring creator execution ownership', t => {
  const f = fixture(t), child = 'native-child';
  f.save('conversation-runtime-segments', f.row.id, { version: 1, id: f.row.id, owner: runtime.scope(f.a),
    segments: [{ sessionId: child, adapterId: 'pi' }], active: { sessionId: child, adapterId: 'pi' } });
  f.save('requirement-session-context', child, { version: 1, owner: runtime.scope(f.b), cwd: f.root,
    projectId: 'project', repoId: 'repo', adapterId: 'pi' });
  const row = { ...f.row, historyAliasIds: [child], workOwner: runtime.scope(f.a) };
  assert.equal(access.classifyLocal(f.app, f.row.id, row).kind, 'protected');
  assert.throws(() => access.assertOwner(f.app, f.row.id, f.actor(f.a), row));
  assert.throws(() => access.assertOwner(f.app, f.row.id, f.actor(f.b), row), /当前账号/);
  assert.doesNotThrow(() => access.assertReadable(f.app, f.row.id, f.actor(f.b), row));
  assert.doesNotThrow(() => access.assertLocalMutation(f.app, f.row.id, f.actor(f.b), row));
  assert.equal(JSON.parse(fs.readFileSync(f.binding, 'utf8')).owner, runtime.scope(f.a));
  assert.throws(() => access.assertOwner(f.app, f.row.id, f.actor(f.b), { ...row, workOwner: 'unrelated-owner' }));
  assert.throws(() => access.assertReadable(f.app, f.row.id, f.actor(f.a), row));
});

test('persisted task, acceptance, handoff and corrupt metadata never become ordinary by changing title or aliases', t => {
  for (const [directory, value] of [
    ['conversation-tasks', [{ taskId: 'requirement', title: '' }]],
    ['acceptance-session-context', { version: 1, owner: runtime.scope(identity()), acceptanceSession: true }],
    ['conversation-handoffs', { version: 1, owner: runtime.scope(identity()), sessionId: 'ordinary', phase: 'completed' }],
    ['requirement-session-context', '{invalid'],
  ]) {
    const f = fixture(t); f.save(directory, f.row.id, value);
    const row = { ...f.row, title: 'Just an ordinary chat', historyAliasIds: ['alias'] };
    assert.notEqual(access.classifyLocal(f.app, row.id, row).kind, 'ordinary', directory);
    assert.throws(() => access.assertOwner(f.app, row.id, f.actor(f.b), row), directory);
  }
});

test('downloaded unknown or protected copies retain source-account scope and never authorize the source original', t => {
  const f = fixture(t);
  const copy = { id: 'copy', localReplica: true, cached: true, adapterId: 'account-sync',
    source: { id: 'acct-source', account: 'one', hub: f.a.hub }, creator: { account: 'one', hub: f.a.hub } };
  assert.notEqual(access.classifyLocal(f.app, copy.id, copy).kind, 'ordinary');
  assert.doesNotThrow(() => access.assertReadable(f.app, copy.id, f.actor(f.a), copy));
  assert.throws(() => access.assertReadable(f.app, copy.id, f.actor(f.b), copy));
  assert.throws(() => access.assertReadable(f.app, copy.id, f.actor({ ...f.a, hub: 'https://other.invalid' }), copy));
  assert.throws(() => access.assertOwner(f.app, 'acct-source', f.actor(f.a), copy));
});

test('native registration cannot adopt a downloaded origin locator in either discovery order', t => {
  const f = fixture(t), module = require('../main/conversation/replica-store.cjs');
  for (const copyFirst of [true, false]) {
    const store = module.create(path.join(f.root, String(copyFirst), 'history.sqlite'));
    try {
      const copy = { id: 'copy', cached: true, sourceSessionId: 'native', source: { id: 'acct', account: 'one', hub: f.a.hub } };
      const native = { id: 'native', adapterId: 'pi', historyAliasIds: ['native-segment'] };
      for (const row of copyFirst ? [copy, native] : [native, copy]) assert.equal(store.register([row])[0].id, row.id);
      assert.equal(store.get('native').cached, undefined);
      assert.equal(store.get('native-segment').id, 'native');
      assert.equal(store.get('acct').id, 'copy', 'passive origin recovery remains available');
      assert.doesNotThrow(() => store.join('native', ['native-segment', 'not-discovered']));
      assert.deepEqual(new Set(store.list().items.map(row => row.id)), new Set(['native', 'copy']));
    } finally { store.close(); }
  }
});

test('a later requirement binding immediately revokes sharing without changing private memory or trusting a title', t => {
  const f = fixture(t), before = fs.readFileSync(f.binding, 'utf8');
  assert.equal(access.visible(f.app, [f.row], f.b).length, 1);
  f.save('requirement-session-context', f.row.id, { version: 1, owner: runtime.scope(f.a) });
  assert.equal(access.visible(f.app, [f.row], f.b).length, 0);
  assert.throws(() => access.assertOwner(f.app, f.row.id, f.actor(f.b), f.row));
  assert.equal(access.visible(f.app, [f.row], f.a).length, 1);
  assert.equal(fs.readFileSync(f.binding, 'utf8'), before);
});

test('runtime segment traversal is cycle-safe and rejects oversized or malformed manifests', t => {
  const f = fixture(t);
  f.save('conversation-runtime-segments', f.row.id, { version: 1, id: f.row.id,
    segments: [{ sessionId: 'child', adapterId: 'pi' }], active: { sessionId: f.row.id, adapterId: 'pi' } });
  f.save('conversation-runtime-segments', 'child', { version: 1, id: 'child',
    segments: [{ sessionId: f.row.id, adapterId: 'pi' }], active: { sessionId: 'child', adapterId: 'pi' } });
  assert.equal(access.classifyLocal(f.app, f.row.id, f.row).kind, 'ordinary');
  f.save('conversation-runtime-segments', 'child', { version: 1, id: 'child',
    segments: Array.from({ length: 1002 }, (_, i) => ({ sessionId: 'part-' + i })), active: { sessionId: 'child', adapterId: 'pi' } });
  assert.equal(access.classifyLocal(f.app, f.row.id, f.row).invalid, true);
});

test('a protected parent also protects raw children before history merging can reconstruct it', t => {
  const f = fixture(t), child = { id: 'child', localReplica: true, adapterId: 'opencode' };
  f.save('conversation-runtime-segments', f.row.id, { version: 1, id: f.row.id, owner: runtime.scope(f.a),
    segments: [{ sessionId: f.row.id, adapterId: 'pi' }], active: { sessionId: child.id, adapterId: 'opencode' } });
  f.save('requirement-session-context', f.row.id, { version: 1, owner: runtime.scope(f.a) });
  assert.equal(access.classifyLocal(f.app, child.id, child).kind, 'protected');
  assert.throws(() => access.assertReadable(f.app, child.id, f.actor(f.b), child));
  const visible = access.visible(f.app, [f.row, child], f.b);
  assert.deepEqual(visible, []);
  assert.deepEqual(require('../main/conversation/runtime-segments').mergeHistory(f.app, visible), []);
  assert.equal(access.visible(f.app, [f.row, child], f.a).length, 2);
});

test('ordinary Runner and automation drafts are shared but requirement cards are protected', t => {
  const f = fixture(t), row = { ...f.row, adapterId: 'harness2', path: undefined };
  f.save('conversation-work-cards', row.id, { version: 1, sessionId: row.id, owner: runtime.scope(f.a),
    cards: [{ actionId: 'work.automation.create' }] });
  assert.equal(access.classifyLocal(f.app, row.id, row).kind, 'ordinary');
  assert.doesNotThrow(() => access.assertLocalMutation(f.app, row.id, f.actor(f.b), row));
  f.save('conversation-work-cards', row.id, { version: 1, sessionId: row.id, owner: runtime.scope(f.a),
    cards: [{ actionId: 'work.requirement.create' }] });
  assert.equal(access.classifyLocal(f.app, row.id, row).kind, 'protected');
  assert.throws(() => access.assertOwner(f.app, row.id, f.actor(f.b), row));
});

test('large legacy runtime prefixes do not hide unrelated chats and revision changes invalidate the identity cache', t => {
  const f = fixture(t), segments = require('../main/conversation/runtime-segments');
  const manifest = { version: 1, id: 'large', owner: runtime.scope(f.a),
    prefix: { messages: [{ role: 'assistant', text: 'x'.repeat(2300000) }] },
    segments: [{ sessionId: 'large', adapterId: 'pi' }], active: { sessionId: 'large-child', adapterId: 'pi' } };
  f.save('conversation-runtime-segments', manifest.id, manifest);
  assert.equal(segments.read(f.app, manifest.id).prefix.messages[0].text.length, 2300000);
  const read = fs.readFileSync; let manifestReads = 0;
  fs.readFileSync = function (file, ...args) {
    if (String(file).includes('conversation-runtime-segments')) manifestReads++;
    return read.call(this, file, ...args);
  };
  try {
    for (let i = 0; i < 10; i++) assert.equal(access.visible(f.app, [f.row], f.b).length, 1);
    assert.equal(manifestReads, 0, 'Warm permission checks reuse validated native identity metadata');
  } finally { fs.readFileSync = read; }
  f.save('requirement-session-context', manifest.id, { version: 1, owner: runtime.scope(f.a) });
  f.save('conversation-runtime-segments', manifest.id, { ...manifest, active: { sessionId: f.row.id, adapterId: 'pi' } });
  assert.equal(access.visible(f.app, [f.row], f.b).length, 0, 'A replaced manifest immediately protects its newly attached child');
  f.save('conversation-runtime-segments', manifest.id, '{broken');
  assert.equal(access.classifyLocal(f.app, f.row.id, f.row).invalid, true);
});

test('absent native metadata is unknown rather than corrupt and cannot authorize sharing', t => {
  const f = fixture(t), app = { getPath: () => path.join(f.root, 'not-created') };
  assert.equal(access.classifyLocal(app, 'legacy', { id: 'legacy', path: path.join(f.root, 'missing.jsonl') }).invalid, false);
  assert.equal(access.classifyLocal(app, 'legacy', { id: 'legacy' }).kind, 'unknown');
});

test('repeated 1200-row directories use bounded metadata batches and never read transcript bodies', t => {
  const f = fixture(t), rows = Array.from({ length: 1200 }, (_, i) => ({ id: 'local-' + i, localReplica: true, adapterId: 'pi' }));
  for (let i = 0; i < 12; i++) f.save('requirement-session-context', rows[i].id, { version: 1, owner: runtime.scope(f.a) });
  for (let i = 100; i < 220; i++) f.save('conversation-runtime-segments', rows[i].id, {
    version: 1, id: rows[i].id, segments: [{ sessionId: rows[i].id, adapterId: 'pi' }], active: { sessionId: rows[i + 700].id, adapterId: 'pi' } });
  const originals = { readdirSync: fs.readdirSync, readFileSync: fs.readFileSync };
  let directoryReads = 0, contentReads = 0, manifestReads = 0;
  fs.readdirSync = function (...args) { directoryReads++; return originals.readdirSync.apply(this, args); };
  fs.readFileSync = function (file, ...args) {
    assert.ok(!String(file).endsWith('.jsonl'), 'Authorization must not scan transcript bodies');
    if (String(file).includes('requirement-session-context')) contentReads++;
    if (String(file).includes('conversation-runtime-segments')) manifestReads++;
    return originals.readFileSync.call(this, file, ...args);
  };
  const started = performance.now();
  try {
    for (let run = 0; run < 3; run++) assert.equal(access.visible(f.app, rows, f.b).length, 1188);
    assert.equal(directoryReads, 18, 'Each of six fixed metadata directories is read once per batch');
    assert.equal(contentReads, 36, 'Only the twelve existing metadata files are parsed per batch');
    assert.equal(manifestReads, 120, 'The existing revision-validated native cache parses each cold manifest once, never per conversation');
  } finally { Object.assign(fs, originals); }
  assert.ok(performance.now() - started < 5000, 'A 3600-row directory check must remain bounded');
  f.save('requirement-session-context', rows[20].id, { version: 1, owner: runtime.scope(f.a) });
  assert.throws(() => access.assertOwner(f.app, rows[20].id, f.actor(f.b), rows[20]), 'Operations re-read newly protected metadata');
});
