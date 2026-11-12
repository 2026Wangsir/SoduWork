'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { identity } = require('./helpers/platform-session-fixture.cjs');
const { create } = require('../main/conversation/import-local-history.cjs');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
function entries(count = 4, tool = false) {
  const rows = [{ type: 'session', version: 3, id: 'legacy', timestamp: '2026-01-01T00:00:00.000Z' }];
  for (let i = 0; i < count; i++) {
    const role = i % 2 ? 'assistant' : 'user';
    rows.push({ type: 'message', id: 'entry-' + i, timestamp: 1767225600000 + i * 1000,
      message: { role, content: [{ type: 'text', text: i === 0 ? '旧会话 Unicode 🧪 ' + '内容'.repeat(8000) : 'message-' + i }],
        timestamp: 1767225600000 + i * 1000, ...(role === 'assistant' ? { usage: { input: 1 }, quotaUsageToken: 'must-not-copy-receipt' } : {}) } });
    if (tool && i === 1) {
      rows.at(-1).message.content.push({ type: 'toolCall', id: 'call-one', name: 'read', arguments: { path: 'project/说明.md' } });
      rows.push({ type: 'message', timestamp: 1767225601500, message: { role: 'toolResult', toolCallId: 'call-one', toolName: 'read',
        content: [{ type: 'text', text: '完整工具结果 ' + '结果'.repeat(7000) }], timestamp: 1767225601500 } });
    }
  }
  return rows;
}
function shortPath(root) {
  const query = require('node:child_process').spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);$f=New-Object -ComObject Scripting.FileSystemObject;[Console]::Write($f.GetFolder($env:SODUWORK_TEST_ROOT).ShortPath)'],
    { env: { ...process.env, SODUWORK_TEST_ROOT: root }, windowsHide: true, encoding: 'utf8', timeout: 10000 });
  assert.equal(query.status, 0, query.stderr);
  const alias = query.stdout.trim();
  assert.ok(path.isAbsolute(alias), 'Windows must return an absolute short-path spelling');
  assert.equal(fs.realpathSync.native(alias), fs.realpathSync.native(root));
  return alias;
}
async function fixture(t, data = entries(), { rootSpelling = value => value } = {}) {
  const ownedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-import-history-'));
  let store;
  t.after(async () => {
    await store?.close();
    assert.equal(path.dirname(ownedRoot), path.resolve(os.tmpdir()));
    assert.ok(path.basename(ownedRoot).startsWith('soduwork-import-history-'));
    fs.rmSync(ownedRoot, { recursive: true, force: true });
  });
  const root = rootSpelling(ownedRoot);
  const app = { getPath: () => root }, file = path.join(root, 'pi-agent', 'sessions', 'project', 'legacy.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data.map(row => JSON.stringify(row)).join('\n') + '\n');
  store = require('../main/conversation/replica-store.cjs').createWorker(path.join(root, 'replicas.sqlite'));
  const row = { id: 'legacy', path: file, count: data.length - 1, adapterId: 'pi', title: '旧会话' };
  await store.register([row]);
  let current = identity(), destroyed = false, url = pathToFileURL(path.resolve(__dirname, '../desk.html')).href;
  const frame = {}, sender = { getURL: () => url, isDestroyed: () => destroyed, mainFrame: frame };
  const event = { sender, senderFrame: frame }, win = { isDestroyed: () => destroyed };
  const dialog = { showOpenDialog: async () => ({ canceled: false, filePaths: [file] }), showMessageBox: async () => ({ response: 1 }) };
  const session = { historyEntry: async (_app, id) => ({ ok: true, entry: id === row.id ? { ...row } : null }) };
  const importer = create({ app, history: { store }, session, dialog, BrowserWindow: { fromWebContents: () => win }, identityOf: () => current });
  const staging = () => {
    const db = new (require('node:sqlite').DatabaseSync)(path.join(root, 'replicas.sqlite'));
    try { return ['import_chunks', 'import_pages', 'import_messages'].map(name => db.prepare('SELECT count(*) AS n FROM ' + name).get().n); }
    finally { db.close(); }
  };
  const owned = (id = row.id, directory = 'conversation-history-owners') => {
    const folder = path.join(root, directory); fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, digest(id) + '.json'), '{not even valid JSON');
  };
  return { root, file, app, row, store, dialog, session, event, importer, staging, owned,
    set current(value) { current = value; }, get current() { return current; },
    destroy() { destroyed = true; }, navigate() { url = 'https://untrusted.invalid/'; } };
}
async function unchanged(f, bytes) {
  assert.deepEqual(fs.readFileSync(f.file), bytes);
  assert.deepEqual((await f.store.directory(0, 200)).items.map(row => row.id), ['legacy']);
  assert.deepEqual(f.staging(), [0, 0, 0]);
}
test('explicit indexed Pi import preserves the entire transcript and tool results in an independent read-only copy', async t => {
  const data = entries(302, true);
  data.find(row => row.id === 'entry-2').message.content[0].text = require('../main/pi-session/attachment-contract').augment('message-2',
    [{ name: '说明.txt', path: '/private/source/说明.txt', mimeType: 'text/plain', size: 12 }]);
  const f = await fixture(t, data), before = fs.readFileSync(f.file);
  const result = await f.importer(f.event); assert.equal(result.ok, true); assert.equal(result.count, 302);
  assert.notEqual(result.id, 'legacy'); const row = await f.store.get(result.id);
  assert.equal(row.cached, true); assert.equal(row.archived, true); assert.equal(row.importedHistory, true);
  assert.deepEqual(row.creator, { account: 'one', hub: 'https://fixture.invalid' });
  assert.ok(!row.source); assert.ok(!(row.historyAliasIds || []).includes('legacy'));
  const read = (_id, { after, limit }) => f.store.messages(result.id, { after: after - 1, limit });
  const view = await require('../main/conversation/local-history-view.cjs').create({ row, read: async (id, options) => {
    const page = await read(id, options); return { ...page, nextCursor: page.next == null ? null : page.next + 1 };
  } });
  assert.equal(view.snapshot().messages.length, 100); assert.equal(view.snapshot().tools.length, 0);
  await view.loadHistory({ messageLimit: 500 }); const snapshot = view.snapshot();
  assert.equal(snapshot.messages.length, 302); assert.equal(snapshot.messages[0].text, entries()[1].message.content[0].text);
  assert.equal(snapshot.messages[0].blocks[0].text, snapshot.messages[0].text);
  assert.equal(snapshot.messages[0].sentAt, 1767225600000);
  assert.equal(snapshot.messages[1].completedAt, 1767225601000);
  assert.deepEqual(snapshot.messages[2].attachments, [{ name: '说明.txt', type: 'text/plain', size: 12 }]);
  assert.equal(JSON.stringify(snapshot).includes('/private/source'), false);
  assert.equal(snapshot.tools.length, 1); assert.equal(snapshot.tools[0].after, 1);
  assert.equal(snapshot.tools[0].result, '完整工具结果 ' + '结果'.repeat(7000));
  assert.equal(snapshot.tools[0].startedAt, 1767225601000); assert.equal(snapshot.tools[0].endedAt, 1767225601500);
  assert.equal(snapshot.tools[0].args.path, 'project/说明.md');
  assert.equal(JSON.stringify(snapshot).includes('must-not-copy-receipt'), false);
  assert.equal((await view.send('cannot execute')).accepted, false); await view.close();
  assert.deepEqual(fs.readFileSync(f.file), before); assert.ok(!(await f.store.get('legacy')).creator);
  assert.equal(fs.existsSync(path.join(f.root, 'conversation-history-owners')), false);
});
test('production native index and shared-history enforce A to B to A visibility for the new copy only', async t => {
  const f = await fixture(t), session = require('../main/pi-session/session');
  f.session.historyEntry = session.historyEntry;
  const result = await f.importer(f.event); assert.equal(result.ok, true);
  const history = require('../main/conversation/shared-history.cjs').create({ app: f.app, session, store: f.store, identityOf: () => f.current });
  assert.equal(await history.resolve('legacy'), null, 'The original stays unknown');
  const view = await history.open(result.id); assert.equal(view.readOnly, true);
  assert.equal(view.snapshot().messages.length, 4);
  f.current = identity('two'); assert.equal(await history.resolve(result.id), null);
  await assert.rejects(history.read(result.id), /不存在/);
  assert.throws(() => view.snapshot(), /切换/);
  f.current = identity(); assert.ok(await history.resolve(result.id));
  assert.equal(await history.resolve('legacy'), null);
  await view.close();
});
for (const spelling of ['short-root-long-picker', 'long-root-short-picker']) {
  test('Windows native import accepts the same archive through ' + spelling,
    { skip: process.platform !== 'win32' }, async t => {
      const f = await fixture(t, entries(), { rootSpelling: spelling === 'short-root-long-picker'
        ? shortPath : root => fs.realpathSync.native(root) });
      const longRoot = fs.realpathSync.native(f.root), alias = shortPath(longRoot);
      if (path.resolve(alias).toLowerCase() === path.resolve(longRoot).toLowerCase())
        return t.skip('The temporary volume does not provide a native 8.3 alias');
      const canonicalFile = fs.realpathSync.native(f.file), picked = spelling === 'short-root-long-picker'
        ? canonicalFile : path.join(alias, path.relative(f.root, f.file));
      assert.notEqual(path.resolve(picked).toLowerCase(), path.resolve(f.row.path).toLowerCase());
      assert.equal(fs.realpathSync.native(picked), canonicalFile);
      const before = fs.readFileSync(f.file), originalCreator = (await f.store.get('legacy')).creator;
      const native = require('../main/pi-session/session');
      f.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [picked] });
      f.session.historyEntry = native.historyEntry;
      const fresh = await native.historyEntry(f.app, 'legacy', { strict: true });
      assert.equal(fresh.ok, true);
      assert.equal(fs.realpathSync.native(fresh.entry.path), canonicalFile);
      const result = await f.importer(f.event);
      assert.equal(result.ok, true); assert.equal(result.count, 4);
      assert.notEqual(result.id, 'legacy');
      assert.deepEqual((await f.store.get(result.id)).creator, { account: 'one', hub: 'https://fixture.invalid' });
      assert.deepEqual((await f.store.get('legacy')).creator, originalCreator);
      assert.deepEqual(fs.readFileSync(f.file), before);
      assert.deepEqual(f.staging(), [0, 0, 0]);
    });
}
test('ordinary cached rows do not publish imported-only tool records', async () => {
  const view = await require('../main/conversation/local-history-view.cjs').create({ row: { id: 'ordinary' },
    read: async () => ({ items: [{ role: 'assistant', text: 'answer', historyTools: [{ id: 'hidden', result: 'not a verified import' }] }], nextCursor: null }) });
  assert.deepEqual(view.snapshot().tools, []); await view.close();
});
test('picker and native confirmation cancellation never stage or claim the original', async t => {
  for (const stage of ['picker', 'confirm']) await t.test(stage, async t => {
    const f = await fixture(t), before = fs.readFileSync(f.file);
    if (stage === 'picker') f.dialog.showOpenDialog = async () => ({ canceled: true });
    else f.dialog.showMessageBox = async () => ({ response: 0 });
    assert.deepEqual(await f.importer(f.event), { ok: false, canceled: true }); await unchanged(f, before);
  });
});
test('owned metadata, canonical and alias ownership evidence are never importable, including corrupt records', async t => {
  for (const field of ['creator', 'source', 'workOwner', 'owner']) await t.test(field, async t => {
    const f = await fixture(t), before = fs.readFileSync(f.file); f.row[field] = field === 'creator' || field === 'source' ? { account: 'two', hub: f.current.hub } : 'foreign';
    await f.store.register([f.row]); await assert.rejects(f.importer(f.event), /归属/); await unchanged(f, before);
  });
  for (const directory of ['session-memory-bindings', 'requirement-session-context', 'conversation-runtime-segments', 'conversation-history-owners', 'conversation-handoffs'])
    await t.test(directory, async t => { const f = await fixture(t); f.owned('legacy', directory); await assert.rejects(f.importer(f.event), /归属/); assert.deepEqual(f.staging(), [0, 0, 0]); });
  await t.test('alias', async t => { const f = await fixture(t); f.row.historyAliasIds = ['old-alias']; await f.store.register([f.row]); f.owned('old-alias'); await assert.rejects(f.importer(f.event), /归属/); });
});
test('ownership rejection explains both the original-account route and missing-service recovery boundary', async t => {
  for (const knownHub of [true, false]) await t.test(knownHub ? 'known foreign account and Hub' : 'current-account fingerprint without Hub', async t => {
    const f = await fixture(t), before = fs.readFileSync(f.file);
    if (knownHub) f.row.creator = { account: 'two', hub: f.current.hub };
    else f.row.workOwner = require('../main/platform-connections/runtime.cjs').scope(f.current);
    await f.store.register([f.row]);
    await assert.rejects(f.importer(f.event), error => {
      assert.match(error.message, /已有归属记录，不能作为未知会话导入/);
      assert.match(error.message, /有明确归属时，请切回原账号和服务查看/);
      assert.match(error.message, /缺少服务归属信息的旧记录无法通过此入口恢复/);
      const english = require('../core/locales/en-US-workspace.js')[error.message];
      assert.match(english, /original account and service/);
      assert.match(english, /missing service provenance cannot be recovered through this importer/);
      return true;
    });
    await unchanged(f, before);
  });
});
test('confirmation rechecks owner, file fingerprint, account, Hub, epoch and sender lifetime', async t => {
  const auth = require('../main/device-auth');
  for (const change of ['owner', 'file', 'account', 'hub', 'epoch', 'destroy', 'navigate']) await t.test(change, async t => {
    const f = await fixture(t), before = fs.readFileSync(f.file), oldEpoch = auth.historyEpoch; let epoch = 0;
    if (change === 'epoch') { auth.historyEpoch = () => epoch; t.after(() => { auth.historyEpoch = oldEpoch; }); }
    f.dialog.showMessageBox = async () => {
      if (change === 'owner') f.owned();
      if (change === 'file') fs.appendFileSync(f.file, '\n');
      if (change === 'account') f.current = identity('two');
      if (change === 'hub') f.current = { ...f.current, hub: 'https://other.invalid' };
      if (change === 'epoch') { f.current = identity('two'); epoch++; f.current = identity(); epoch++; }
      if (change === 'destroy') f.destroy();
      if (change === 'navigate') f.navigate();
      return { response: 1 };
    };
    await assert.rejects(f.importer(f.event), /归属|变化|切换|关闭/);
    if (change !== 'file') assert.deepEqual(fs.readFileSync(f.file), before);
    assert.deepEqual((await f.store.directory(0, 200)).items.map(row => row.id), ['legacy']); assert.deepEqual(f.staging(), [0, 0, 0]);
  });
});
test('unindexed, out-of-root, foreign formats, malformed and incomplete tools fail without creating a copy', async t => {
  for (const kind of ['unindexed', 'outside', 'codex', 'malformed', 'embedded-owner', 'orphan-tool', 'image', 'wrong-id']) await t.test(kind, async t => {
    const f = await fixture(t);
    if (kind === 'unindexed' || kind === 'outside') {
      const file = path.join(f.root, 'other.jsonl'); fs.copyFileSync(f.file, file);
      f.dialog.showOpenDialog = async () => ({ filePaths: [file] });
      if (kind === 'outside') { f.row.path = file; await f.store.register([f.row]); }
    } else if (kind === 'codex') { f.row.adapterId = 'codex'; await f.store.register([f.row]); }
    else if (kind === 'malformed') fs.appendFileSync(f.file, '{');
    else {
      const data = entries();
      if (kind === 'embedded-owner') data.push({ type: 'custom', customType: 'soduwork.work-entry', data: { owner: 'foreign' } });
      if (kind === 'orphan-tool') data.push({ type: 'message', message: { role: 'toolResult', toolCallId: 'orphan', content: [{ type: 'text', text: 'result' }] } });
      if (kind === 'image') data[1].message.content.push({ type: 'image', data: 'unsupported' });
      if (kind === 'wrong-id') data[0].id = 'different';
      fs.writeFileSync(f.file, data.map(row => JSON.stringify(row)).join('\n'));
    }
    await assert.rejects(f.importer(f.event)); assert.deepEqual(f.staging(), [0, 0, 0]);
    assert.equal((await f.store.directory(0, 200)).items.length, 1);
  });
});
test('linked indexed paths are rejected before opening their contents', async t => {
  const f = await fixture(t), original = f.file + '.original'; fs.renameSync(f.file, original);
  try { fs.symlinkSync(original, f.file, 'file'); } catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) return t.skip('Host does not allow creating symlinks'); throw error; }
  await assert.rejects(f.importer(f.event), /symlink|link|链接|符号/i); assert.deepEqual(f.staging(), [0, 0, 0]);
});
for (const kind of ['copy', 'hardlink']) for (const mismatch of ['picker', 'native-index']) {
  test(kind + ' with identical content at a different canonical path cannot match the ' + mismatch, async t => {
    const f = await fixture(t), before = fs.readFileSync(f.file), other = path.join(path.dirname(f.file), 'different.jsonl');
    if (kind === 'copy') fs.copyFileSync(f.file, other);
    else {
      try { fs.linkSync(f.file, other); }
      catch (error) {
        if (['EPERM', 'EACCES', 'ENOTSUP', 'EXDEV'].includes(error.code)) return t.skip('Host does not allow creating hard links');
        throw error;
      }
    }
    assert.notEqual(fs.realpathSync.native(other), fs.realpathSync.native(f.file));
    if (mismatch === 'picker') f.dialog.showOpenDialog = async () => ({ filePaths: [other] });
    else f.session.historyEntry = async () => ({ ok: true, entry: { ...f.row, path: other } });
    await assert.rejects(f.importer(f.event), /索引|变化|路径/);
    assert.deepEqual(fs.readFileSync(other), before);
    await unchanged(f, before);
  });
}
test('a directory junction to the same indexed file is rejected rather than canonicalized into permission', async t => {
  const f = await fixture(t), before = fs.readFileSync(f.file);
  const link = path.join(f.root, 'pi-agent', 'sessions', 'linked-project');
  fs.symlinkSync(path.dirname(f.file), link, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    const selected = path.join(link, path.basename(f.file));
    assert.equal(fs.realpathSync.native(selected), fs.realpathSync.native(f.file));
    f.row.path = selected; await f.store.register([f.row]);
    f.dialog.showOpenDialog = async () => ({ filePaths: [selected] });
    await assert.rejects(f.importer(f.event), /symlink|link|链接|联接|符号/i);
    await unchanged(f, before);
  } finally { fs.unlinkSync(link); }
});
for (const replacement of ['same-bytes-file', 'parent-junction']) {
  test('confirmation rejects ' + replacement + ' replacement and leaves no staged copy', async t => {
    const f = await fixture(t), before = fs.readFileSync(f.file), parent = path.dirname(f.file);
    const retained = replacement === 'same-bytes-file' ? f.file + '.original' : parent + '-original';
    let changed = false;
    f.dialog.showMessageBox = async () => {
      fs.renameSync(replacement === 'same-bytes-file' ? f.file : parent, retained);
      changed = true;
      if (replacement === 'same-bytes-file') fs.writeFileSync(f.file, before);
      else fs.symlinkSync(retained, parent, process.platform === 'win32' ? 'junction' : 'dir');
      return { response: 1 };
    };
    try {
      await assert.rejects(f.importer(f.event), /变化|symlink|link|链接|联接|符号/i);
      assert.equal(changed, true, 'the importer must reach native confirmation before the replacement');
      await unchanged(f, before);
      assert.deepEqual(fs.readFileSync(replacement === 'same-bytes-file' ? retained : path.join(retained, path.basename(f.file))), before);
    } finally {
      if (changed && replacement === 'parent-junction') {
        fs.unlinkSync(parent); fs.renameSync(retained, parent);
      }
    }
  });
}
test('chunk failure cleans only the unsealed copy, preserving source and existing replicas', async t => {
  const f = await fixture(t, entries(30)), before = fs.readFileSync(f.file), original = f.store.importChunk;
  f.store.importChunk = async (...args) => { await original(...args); throw Error('synthetic storage failure'); };
  await assert.rejects(f.importer(f.event), /synthetic storage failure/); await unchanged(f, before);
});
test('late file, ownership or account changes during staged writes discard the unsealed copy', async t => {
  for (const change of ['file', 'owner', 'account']) await t.test(change, async t => {
    const f = await fixture(t), original = f.store.importChunk;
    f.store.importChunk = async (...args) => {
      const result = await original(...args);
      if (change === 'file') fs.appendFileSync(f.file, '\n');
      if (change === 'owner') f.owned();
      if (change === 'account') f.current = identity('two');
      return result;
    };
    await assert.rejects(f.importer(f.event), /变化|归属|切换/);
    assert.deepEqual(f.staging(), [0, 0, 0]); assert.equal((await f.store.directory(0, 200)).items.length, 1);
  });
});
test('untrusted frames and signed-out identities cannot open the picker', async t => {
  for (const change of ['frame', 'origin', 'identity']) await t.test(change, async t => {
    const f = await fixture(t); let picked = false;
    f.dialog.showOpenDialog = async () => { picked = true; return { canceled: true }; };
    if (change === 'frame') f.event.senderFrame = {};
    if (change === 'origin') f.navigate();
    if (change === 'identity') f.current = null;
    await assert.rejects(f.importer(f.event)); assert.equal(picked, false);
  });
});
test('native import confirmation and errors have English fallback translations', () => {
  const locale = require('../main/native-locale.cjs'), before = locale.getLocale();
  try {
    locale.setLocale('en-US');
    const source = fs.readFileSync(require.resolve('../main/conversation/import-local-history.cjs'), 'utf8');
    const strings = [...source.matchAll(/'([^'\r\n]*[\u4e00-\u9fff][^'\r\n]*)'/g)].map(match => match[1]);
    for (const value of strings) assert.notEqual(locale.translate(value), value, value);
  } finally { locale.setLocale(before); }
});
test('format and size bounds reject instead of silently truncating', async t => {
  for (const kind of ['bytes', 'messages', 'message']) await t.test(kind, async t => {
    const f = await fixture(t);
    if (kind === 'bytes') fs.truncateSync(f.file, 32 * 1024 * 1024 + 1);
    else { const data = kind === 'messages' ? entries(10001) : entries(); if (kind === 'message') data[2].message.content[0].text = 'x'.repeat(2 * 1024 * 1024 + 1); fs.writeFileSync(f.file, data.map(row => JSON.stringify(row)).join('\n')); }
    await assert.rejects(f.importer(f.event), /过大/); assert.deepEqual(f.staging(), [0, 0, 0]);
  });
});
