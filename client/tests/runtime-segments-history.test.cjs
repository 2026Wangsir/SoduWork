'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const segments = require('../main/conversation/runtime-segments');

test('runtime identity cache observes same-size owner and alias changes despite identical file timestamps', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-runtime-history-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = { getPath: () => root }, record = { version: 1, id: 'public-id', owner: 'owner-a',
    segments: [{ sessionId: 'child-aa', adapterId: 'pi' }], active: { sessionId: 'child-aa', adapterId: 'pi' } };
  await segments.save(app, record);
  const file = path.join(root, 'conversation-runtime-segments', require('node:crypto').createHash('sha256').update(record.id).digest('hex') + '.json');
  const original = fs.lstatSync, stat = original(file), big = original(file, { bigint: true });
  fs.lstatSync = function (target, options) {
    return String(target) === file ? options?.bigint ? big : stat : original.apply(this, arguments);
  };
  try {
    const first = segments.read(app, record.id);
    assert.strictEqual(segments.read(app, record.id), first, 'unchanged bytes reuse the parsed manifest');
    const changed = { ...record, owner: 'owner-b', segments: [{ sessionId: 'child-bb', adapterId: 'pi' }],
      active: { sessionId: 'child-bb', adapterId: 'pi' } };
    const bytes = JSON.stringify(changed);
    assert.equal(Buffer.byteLength(bytes), stat.size);
    fs.writeFileSync(file, bytes);
    const refreshed = segments.read(app, record.id);
    assert.notStrictEqual(refreshed, first);
    assert.equal(refreshed.owner, 'owner-b');
    assert.deepEqual(segments.identities(app)[0].segments, [{ sessionId: 'child-bb' }]);
    assert.equal(segments.identities(app)[0].active.sessionId, 'child-bb');
    const merged = segments.mergeHistory(app, [{ id: 'child-aa' }, { id: 'child-bb' }]);
    assert.deepEqual(merged.map(row => row.id).sort(), ['child-aa', 'public-id']);
  } finally { fs.lstatSync = original; }
});

test('runtime identity cache rejects same-sized identity corruption after a valid read', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-runtime-history-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = { getPath: () => root }, record = { version: 1, id: 'public-aa', owner: 'owner-a',
    segments: [], active: { sessionId: 'child-aa', adapterId: 'pi' } };
  await segments.save(app, record);
  const file = path.join(root, 'conversation-runtime-segments', require('node:crypto').createHash('sha256').update(record.id).digest('hex') + '.json');
  const original = fs.lstatSync, stat = original(file), big = original(file, { bigint: true });
  fs.lstatSync = function (target, options) {
    return String(target) === file ? options?.bigint ? big : stat : original.apply(this, arguments);
  };
  try {
    assert.equal(segments.read(app, record.id).id, record.id);
    fs.writeFileSync(file, JSON.stringify({ ...record, id: 'public-bb' }));
    assert.throws(() => segments.read(app, record.id), /Agent/);
  } finally { fs.lstatSync = original; }
});

test('large runtime prefixes remain readable while warm identity checks stream bounded chunks', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-runtime-history-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = { getPath: () => root }, record = { version: 1, id: 'large-prefix', owner: 'owner-a',
    prefix: { messages: [{ role: 'assistant', text: 'x'.repeat(2300000) }] },
    segments: [], active: { sessionId: 'native-child', adapterId: 'pi' } };
  await segments.save(app, record);
  const first = segments.read(app, record.id);
  assert.equal(first.prefix.messages[0].text.length, 2300000);
  const read = fs.readSync, parse = JSON.parse; let largestBuffer = 0, bytesRead = 0, parses = 0;
  fs.readSync = function (fd, buffer, ...args) {
    largestBuffer = Math.max(largestBuffer, buffer.length);
    const count = read.call(this, fd, buffer, ...args); bytesRead += count; return count;
  };
  JSON.parse = function (...args) { parses++; return parse.apply(this, args); };
  try {
    assert.strictEqual(segments.read(app, record.id), first);
    assert.ok(bytesRead > 2300000, 'a warm cache still verifies every byte of the authority-bearing manifest');
    assert.ok(largestBuffer <= 64 * 1024, 'a warm check never allocates the full history prefix');
    assert.equal(parses, 0, 'unchanged content reuses the already verified parsed record');
  } finally { fs.readSync = read; JSON.parse = parse; }
});

test('runtime history merges authenticated account aliases without joining an independent namesake', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-runtime-history-'));
  const app = { getPath: () => root };
  const record = {
    version: 1, id: 'public-conversation', owner: 'owner-a', cwd: root, at: 1,
    title: 'Original conversation', prefix: { messages: [], tools: [] },
    active: { sessionId: 'native-segment', adapterId: 'opencode', path: '' },
    segments: [{ sessionId: 'native-segment', adapterId: 'opencode', path: '' }],
  };
  try {
    await segments.save(app, record);
    await segments.flush(app, record.id);
    const rows = segments.mergeHistory(app, [
      { id: 'account-copy', sourceSessionId: 'native-segment', historyAliasIds: ['public-conversation', 'native-segment'],
        title: 'Original conversation', adapterId: 'opencode', usedHarnesses: ['opencode'] },
      { id: 'native-segment', title: 'runtime error copy', adapterId: 'opencode', state: 'unreachable' },
      { id: 'foreign-copy', sourceSessionId: 'native-segment', title: 'Original conversation', adapterId: 'pi' },
      { id: 'independent', title: 'Original conversation', adapterId: 'pi' },
    ]);
    assert.deepEqual(rows.map(row => row.id).sort(), ['foreign-copy', 'independent', 'public-conversation']);
    const merged = rows.find(row => row.id === record.id);
    assert.deepEqual(new Set(merged.historyAliasIds), new Set(['account-copy', 'native-segment', 'public-conversation']));
    assert.equal(rows.find(row => row.id === 'independent').title, 'Original conversation');
    assert.equal(rows.find(row => row.id === 'foreign-copy').id, 'foreign-copy');
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});
