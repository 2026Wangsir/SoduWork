'use strict';

// Explicit, single-file recovery into a separate read-only copy. Never assign
// the original archive to an account or import its execution/credential state.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const access = require('./history-access');
const { assertNoLinks } = require('../plugin-resources');
const MAX_BYTES = 32 * 1024 * 1024, MAX_MESSAGES = 10000;
const OWNER_DIRS = ['session-memory-bindings', 'requirement-session-context',
  'conversation-runtime-segments', 'conversation-history-owners', 'conversation-handoffs'];
const FORMAT = '仅支持本机索引中的旧 Pi JSONL 会话，其它原生格式暂不支持';
const OWNED = '这条会话已有归属记录，不能作为未知会话导入。有明确归属时，请切回原账号和服务查看；缺少服务归属信息的旧记录无法通过此入口恢复，原文件已保留';
const CHANGED = '导入期间会话文件或归属已变化，原文件已保留，请重新选择';
const TOO_LARGE = '会话过大，无法完整导入；原文件已保留';
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const stamp = stat => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');

function unknown(app, row) {
  if (!row?.id || row.cached || row.cloud || row.remoteProjection || row.accountProjection ||
      (row.adapterId && row.adapterId !== 'pi') || !path.isAbsolute(row.path || '') ||
      path.extname(row.path).toLowerCase() !== '.jsonl') throw Error(FORMAT);
  if (row.deleted || row.creator || row.source || row.workOwner || row.owner) throw Error(OWNED);
  for (const id of new Set([row.id, ...(row.historyAliasIds || [])])) {
    for (const directory of OWNER_DIRS) {
      const file = path.join(app.getPath('userData'), directory, hash(String(id)) + '.json');
      assertNoLinks(app.getPath('userData'), file);
      try { fs.lstatSync(file); throw Error(OWNED); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
}
function checkedPath(app, file) {
  if (!path.isAbsolute(file || '')) throw Error(FORMAT);
  const base = path.join(app.getPath('userData'), 'pi-agent');
  const root = fs.realpathSync.native(base), real = fs.realpathSync.native(file);
  const relative = path.relative(root, real);
  if (!relative || relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) throw Error(FORMAT);
  // Windows native discovery expands 8.3 names, while the picker and stored
  // index may retain either spelling. Check both original path chains before
  // comparing physical paths; realpath alone would also accept junctions.
  if (fs.lstatSync(base).isSymbolicLink()) throw Error('会话路径不能经过链接或联接点，原文件已保留');
  for (let cursor = path.resolve(file);;) {
    if (fs.lstatSync(cursor).isSymbolicLink()) throw Error('会话路径不能经过链接或联接点，原文件已保留');
    if (root === fs.realpathSync.native(cursor)) break;
    const parent = path.dirname(cursor);
    if (parent === cursor) throw Error(FORMAT);
    cursor = parent;
  }
  assertNoLinks(root, real);
  return real;
}
async function readFile(app, file, guard, expected) {
  const real = checkedPath(app, file); guard();
  if (expected !== real) throw Error(CHANGED);
  const handle = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    guard();
    const stat = await handle.stat(); guard();
    if (!stat.isFile() || stat.size > MAX_BYTES) throw Error(TOO_LARGE);
    const buffer = Buffer.alloc(stat.size + 1); let size = 0;
    while (size < buffer.length) {
      const result = await handle.read(buffer, size, Math.min(64 * 1024, buffer.length - size), size); guard();
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    if (real !== checkedPath(app, file)) throw Error(CHANGED);
    const after = await fs.promises.stat(file); guard();
    if (size !== stat.size || stamp(after) !== stamp(stat)) throw Error(CHANGED);
    const bytes = buffer.subarray(0, size);
    return { bytes, fingerprint: stamp(stat) + ':' + hash(bytes), real };
  } finally { await handle.close(); }
}
function project(bytes, id) {
  let entries;
  try { entries = new TextDecoder('utf-8', { fatal: true }).decode(bytes).split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line)); }
  catch (_) { throw Error('会话格式不完整，无法安全导入；原文件已保留'); }
  if (entries[0]?.type !== 'session' || entries[0].id !== id) throw Error(CHANGED);
  if (entries.some(row => row?.type === 'custom' && row.customType === 'soduwork.work-entry')) throw Error(OWNED);
  const messageCount = entries.filter(row => row?.type === 'message' && ['user', 'assistant'].includes(row.message?.role)).length;
  if (!messageCount || messageCount > MAX_MESSAGES) throw Error(TOO_LARGE);
  const calls = new Map(), results = new Map(), clock = require('./message-time');
  for (const entry of entries) {
    const message = entry?.type === 'message' ? entry.message : null;
    if (message) {
      const allowed = message.role === 'assistant' ? ['text', 'thinking', 'toolCall'] : ['text'];
      if (!['user', 'assistant', 'toolResult'].includes(message.role) ||
          !(typeof message.content === 'string' && message.role === 'user') &&
          (!Array.isArray(message.content) || message.content.some(item => !allowed.includes(item?.type))))
        throw Error('会话包含暂不支持的消息或附件格式，无法完整导入；原文件已保留');
    }
    if (message?.role === 'assistant') for (const content of Array.isArray(message.content) ? message.content : []) {
      if (content?.type !== 'toolCall') continue;
      const key = String(content.id || content.toolCallId || '');
      if (!key || calls.has(key)) throw Error('工具记录无法完整关联，原文件已保留');
      calls.set(key, clock.epoch(message.timestamp) || clock.epoch(entry.timestamp));
    }
    if (message?.role === 'toolResult') {
      const key = String(message.toolCallId || '');
      if (!key || results.has(key)) throw Error('工具记录无法完整关联，原文件已保留');
      results.set(key, clock.epoch(message.timestamp) || clock.epoch(entry.timestamp));
    }
  }
  if (calls.size !== results.size || [...calls.keys()].some(id => !results.has(id)))
    throw Error('工具记录无法完整关联，原文件已保留');
  // Reuse Pi's production replay without its default 240-message presentation tail.
  const accumulator = require('../pi-session/event-stream').create();
  require('../pi-session/history-seed').seed(accumulator, { state: {}, sessionManager: { getEntries: () => entries } },
    { maxMessages: MAX_MESSAGES, nativeAgentId: 'pi' });
  const snapshot = accumulator.snapshot();
  if (snapshot.messages.length !== messageCount || snapshot.messages.some(message => message.scope && message.scope !== 'normal'))
    throw Error('会话包含暂不支持的消息或附件格式，无法完整导入；原文件已保留');
  if ((snapshot.tools || []).length !== results.size || [...results.keys()].some(id => !snapshot.tools.some(tool => tool.id === id)))
    throw Error('工具记录无法完整关联，原文件已保留');
  const messages = snapshot.messages.map((message, index) => ({ id: 'message-' + index,
    role: message.role, text: message.text || '', blocks: message.role === 'user'
      ? [{ index: 0, kind: 'text', text: message.text || '', done: true, toolCall: null }] : message.blocks || [], done: true,
    sentAt: message.sentAt || 0, completedAt: message.completedAt || 0,
    attachments: (message.attachments || []).map(item => ({ name: path.basename(String(item.name || item.path || '')),
      ...(typeof item.type === 'string' ? { type: item.type } : {}),
      ...(Number.isSafeInteger(item.size) && item.size >= 0 ? { size: item.size } : {}) })) }));
  for (const tool of snapshot.tools || []) {
    const message = messages[tool.after];
    if (!message || message.role !== 'assistant') throw Error('工具记录无法完整关联，原文件已保留');
    const { after, readImages, serviceUrl, previewUrl, host, ...display } = tool;
    (message.historyTools ||= []).push({ ...display, startedAt: calls.get(tool.id), endedAt: results.get(tool.id), updatedAt: results.get(tool.id) });
  }
  // Imported messages never carry accounting receipts, task bindings, plugin
  // authorization, source paths or executable session options.
  if (!messages.length || messages.some(message => Buffer.byteLength(JSON.stringify(message)) > 2 * 1024 * 1024)) throw Error(TOO_LARGE);
  const body = Buffer.from(JSON.stringify(messages));
  if (body.length > MAX_BYTES) throw Error(TOO_LARGE);
  return { body, count: messages.length };
}
function create({ app, session, history, dialog, BrowserWindow,
  identityOf = () => require('./requirement-context').cachedIdentity(app) }) {
  let busy = false;
  return async function importFor(event) {
    if (busy) throw Error('请先完成当前导入');
    if (!require('../access-control/preferences').isTrusted(event)) throw Error('请从 SoduWork 归档页面导入旧会话');
    const win = BrowserWindow.fromWebContents(event.sender), captured = access.actor(app, identityOf());
    const guard = () => {
      if (!win || win.isDestroyed() || !require('../access-control/preferences').isTrusted(event)) throw Error('导入窗口已关闭，请重新操作');
      access.assertCurrent(app, captured, identityOf());
      if (!captured.readScope || !require('../device-auth-request').accountId(captured.identity))
        throw Error('请先登录 SoduWork 后导入会话');
    };
    guard(); busy = true;
    const id = 'imported-' + crypto.randomUUID(); let sealed = false;
    async function verify(row, expected) {
      guard();
      const current = (await history.store.nativeRows([row.id])).find(item => item.id === row.id); guard();
      if (!current || expected !== checkedPath(app, current.path)) throw Error(CHANGED);
      unknown(app, current);
      const fresh = await session.historyEntry(app, row.id, { strict: true }); guard();
      if (!fresh?.ok || fresh.entry?.id !== row.id || expected !== checkedPath(app, fresh.entry.path)) throw Error(CHANGED);
      unknown(app, fresh.entry);
      return current;
    }
    try {
      const locale = require('../native-locale.cjs');
      const chosen = await dialog.showOpenDialog(win, locale.dialogOptions({ title: '导入旧 Pi 会话',
        defaultPath: path.join(app.getPath('userData'), 'pi-agent'), properties: ['openFile'],
        filters: [{ name: 'Pi 会话', extensions: ['jsonl'] }] })); guard();
      if (chosen.canceled || !chosen.filePaths?.length) return { ok: false, canceled: true };
      if (chosen.filePaths.length !== 1) throw Error(FORMAT);
      const file = path.resolve(chosen.filePaths[0]), expected = checkedPath(app, file); let row, cursor = 0;
      do {
        const page = await history.store.directory(cursor, 200); guard();
        const matches = page.items.filter(item => {
          if (!item.path || !path.isAbsolute(item.path)) return false;
          try { return expected === fs.realpathSync.native(item.path); }
          catch (_) { return false; } // Unrelated stale index entries cannot be imported.
        });
        if (matches.length > 1 || row && matches.length) throw Error(CHANGED);
        row ||= matches[0];
        if (!page.hasMore) break;
        if (!Number.isSafeInteger(page.cursor) || page.cursor <= cursor) throw Error(CHANGED);
        cursor = page.cursor;
      } while (true);
      if (!row) throw Error(FORMAT);
      unknown(app, row);
      if (expected !== checkedPath(app, row.path)) throw Error(CHANGED);
      await verify(row, expected);
      const original = await readFile(app, file, guard, expected);
      const projection = project(original.bytes, row.id);
      const confirmed = await dialog.showMessageBox(win, locale.dialogOptions({ type: 'question', title: '导入旧 Pi 会话',
        message: '将所选会话导入为当前账号的只读副本？',
        detail: '原文件保持不变。仅导入此会话，不恢复原账号、工具权限或执行状态。',
        buttons: ['取消', '导入副本'], defaultId: 0, cancelId: 0, noLink: true })); guard();
      if (confirmed.response !== 1) return { ok: false, canceled: true };
      await verify(row, expected);
      if ((await readFile(app, file, guard, original.real)).fingerprint !== original.fingerprint) throw Error(CHANGED);
      const pointer = { sha256: hash(projection.body), size: projection.body.length };
      for (let offset = 0; offset < projection.body.length; offset += 256 * 1024) {
        guard();
        const result = await history.store.importChunk(id, pointer, offset, projection.body.subarray(offset, offset + 256 * 1024).toString('base64'));
        guard(); if (!result?.ok) throw Error('导入未完成，原文件已保留');
      }
      await verify(row, expected);
      if ((await readFile(app, file, guard, original.real)).fingerprint !== original.fingerprint) throw Error(CHANGED);
      guard();
      const result = await history.store.sealImport(id, pointer, { title: String(row.title || row.name || '旧 Pi 会话').slice(0, 200),
        archived: true, adapterId: 'pi', creator: { account: require('../device-auth-request').accountId(captured.identity),
          hub: new URL(captured.identity.hub).origin }, importedHistory: true });
      sealed = result?.ok === true && result?.durable === true;
      guard(); if (!sealed) throw Error('导入未完成，原文件已保留');
      return { ok: true, id, imported: true, count: projection.count };
    } finally {
      try { if (!sealed) await history.store.discardImport(id); } finally { busy = false; }
    }
  };
}
module.exports = { create };
