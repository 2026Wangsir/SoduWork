'use strict';

// Local transcripts and remote projections are account/Hub scoped. Reading an
// archive never claims unknown ownership or grants execution permissions.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const runtime = require('../platform-connections/runtime.cjs');
const { assertNoLinks } = require('../plugin-resources');
const LEGACY_OWNER_DIRECTORY = 'conversation-history-owners';
function actor(app, identity) {
  const auth = require('../device-auth');
  if (identity === undefined) identity = require('./requirement-context').cachedIdentity(app);
  let owner = '';
  try { owner = runtime.scope(identity); } catch (_) { owner = auth.localOwner(app); }
  // A retained offline owner is evidence from a previous Hub login, not an
  // anonymous device identity. Logout clears it; token expiry alone does not.
  if (!identity && owner) identity = auth.identity(app);
  return { identity, owner, candidates: [identity, ...auth.profiles(app)].filter(Boolean), readScope: readScope(identity, owner),
    epoch: auth.historyEpoch?.(identity) };
}
function saved(app, directory, id) {
  const file = path.join(app.getPath('userData'), directory,
    crypto.createHash('sha256').update(String(id)).digest('hex') + '.json');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function legacyOwner(app, id) {
  const file = path.join(app.getPath('userData'), LEGACY_OWNER_DIRECTORY,
    crypto.createHash('sha256').update(String(id)).digest('hex') + '.json');
  let record;
  try {
    // Legacy sidecars are local trust anchors. Reject links before reading so
    // migration never intentionally follows an external path.
    assertNoLinks(app.getPath('userData'), file);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw Error('linked');
    record = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw Error('无法读取会话归属记录，请重新打开 SoduWork');
  }
  if (!record) return null;
  if (record.version !== 1 || record.sessionId !== id ||
      !/^[a-f0-9]{32}$/.test(String(record.owner || ''))) {
    throw Error('无法读取会话归属记录，请重新打开 SoduWork');
  }
  return record;
}
function isOwnerlessNativeArchive(row) {
  // Native archive projections carry an absolute JSONL path and at least one
  // persisted message. Synthetic rows and cloud previews do not qualify for
  // explicit import, so they remain hidden until the user imports a copy.
  return !!row && !row.workOwner && !row.cloud && typeof row.path === 'string' &&
    path.isAbsolute(row.path) && path.extname(row.path).toLowerCase() === '.jsonl' &&
    Number.isSafeInteger(Number(row.count)) && Number(row.count) > 0;
}
function assertOwner(app, id, captured = actor(app), row = {}, options = {}) {
  if (!id || !captured.owner) throw Error('请先登录 SoduWork 后查看会话');
  // Account projections are authenticated Hub records, not ownerless native archives.
  if (row.accountProjection === true) {
    if (row.accountConversation !== true || row.adapterId !== 'account-sync' ||
        row.owner !== runtime.connectionScope(captured.identity) ||
        !row.sourceSessionId || !row.sourceClientId || row.id !== id) {
      throw Error('账号会话归属记录无效');
    }
    return;
  }
  // A remote directory row is a projection of Hub metadata, not a local
  // archive.  Accept it only when the row carries the exact identity that was
  // derived from the authenticated connection and the immutable task/ref
  // needed to read its transcript.  The cloud flag alone is never an owner
  // proof and cannot bypass the account boundary.
  if (row.remoteProjection === true) {
    // Cloud projections use the current connection scope, like handoff receipts.
    // Local archive ownership remains account-scoped across device enrollment.
    if (row.cloud !== true || row.owner !== runtime.connectionScope(captured.identity) ||
        String(row.taskId || '').length === 0 || String(row.ref || '').length === 0) {
      throw Error('云端会话归属记录无效');
    }
    return;
  }
  const records = ['session-memory-bindings', 'requirement-session-context', 'conversation-runtime-segments']
    .map(directory => saved(app, directory, id)).filter(Boolean);
  const owners = records.map(record => record.owner);
  if (row.workOwner) owners.push(row.workOwner);
  const legacy = legacyOwner(app, id);
  if (legacy) owners.push(legacy.owner);
  const cloud = saved(app, 'conversation-handoffs', id);
  if (cloud) {
    const syncOwner = require('./cloud-execution-sync').scope(captured.identity);
    if (cloud.sessionId !== id || !cloud.owner || (cloud.owner !== runtime.connectionScope(captured.identity) &&
        (!syncOwner || cloud.syncOwner !== syncOwner)))
      throw Error('这条云端会话属于其他账号或服务，请切回原连接');
    // A verified cloud receipt also owns a remote-only conversation.
    if (!owners.length) return;
  }
  if (!owners.length) {
    const error = Error('无法确认这条会话属于当前账号，请切回原账号');
    error.code = 'HISTORY_OWNER_MISSING';
    throw error;
  }
  if (owners.some(owner => !owner || (owner !== captured.owner &&
      !runtime.scopeMatches(owner, captured.identity, captured.candidates))))
    throw Error('无法确认这条会话属于当前账号，请切回原账号');
}
function assertReadable(app, id, captured = actor(app), row = {}) {
  if (!id || typeof id !== 'string' || id.length > 512 || (row.id || row.sessionId) !== id)
    throw Error('会话标识无效');
  if (!captured.readScope) throw Error('请先登录 SoduWork 后查看会话');
  if (row.remoteProjection === true || row.accountProjection === true || row.accountConversation === true ||
      (!row.localReplica && row.adapterId === 'account-sync') || row.cloud === true)
    return assertOwner(app, id, captured, row);
  const hub = new URL(captured.identity.hub).origin;
  const provenance = row.creator || (row.cached && row.source?.account ? row.source : null);
  let proven = false;
  if (provenance) {
    const owner = provenance.account && crypto.createHash('sha256').update('soduwork-account\0' + provenance.account).digest('hex').slice(0, 32);
    if (owner !== captured.owner || origin(provenance.hub) !== hub)
      throw Error('这条会话属于另一个账号或服务，请切回原账号');
    proven = true;
  }
  // Check all persisted aliases for conflicting owners. Missing aliases do not
  // create ownership; immutable capture/import provenance can own a read-only copy.
  const owners = row.workOwner ? [row.workOwner] : [];
  for (const alias of new Set([id, ...(row.historyAliasIds || [])])) {
    const indexed = captured.ownership?.(alias);
    const records = indexed ? indexed.records.slice() : ['session-memory-bindings', 'requirement-session-context', 'conversation-runtime-segments']
      .map(directory => saved(app, directory, alias)).filter(Boolean);
    const legacy = indexed ? indexed.legacy : legacyOwner(app, alias);
    if (legacy && (legacy.version !== 1 || legacy.sessionId !== alias || !/^[a-f0-9]{32}$/.test(legacy.owner)))
      throw Error('无法读取会话归属记录，请重新打开 SoduWork');
    if (legacy) records.push(legacy);
    for (const record of records) {
      owners.push(record.owner);
      if (record.hub) {
        if (origin(record.hub) !== hub) throw Error('这条会话属于另一个账号或服务，请切回原账号');
        proven = true;
      }
    }
  }
  if (owners.some(owner => !owner || owner !== captured.owner && !runtime.scopeMatches(owner, captured.identity, captured.candidates)))
    throw Error('这条会话属于另一个账号或服务，请切回原账号');
  // Older environment fingerprints can prove their original Hub without
  // rewriting the archive. A newer account-only fingerprint cannot do so.
  if (!proven) for (const candidate of captured.candidates || []) {
    if (origin(candidate.hub) !== hub) continue;
    try { if (owners.includes(runtime.legacyScope(hub, candidate.clientId, captured.identity))) proven = true; }
    catch (_) { /* Expired tokens cannot establish new legacy provenance. */ }
  }
  if (!proven) {
    if (owners.length) {
      const error = Error('这条旧会话缺少服务归属信息，原文件已保留，暂时无法读取');
      error.code = 'HISTORY_HUB_MISSING'; throw error;
    }
    const error = Error('无法确认这条会话属于当前账号，请明确导入后再查看');
    error.code = 'HISTORY_OWNER_MISSING'; throw error;
  }
}
function origin(value) { try { return new URL(value).origin; } catch (_) { return ''; } }
function readScope(identity, trustedOwner = '') {
  let owner = trustedOwner;
  try { owner = runtime.scope(identity); } catch (_) {}
  const hub = origin(identity?.hub);
  return /^[a-f0-9]{32}$/.test(owner) && hub ? crypto.createHash('sha256').update(JSON.stringify([hub, owner])).digest('hex') : '';
}
function visible(app, rows, identity) {
  const captured = actor(app, identity);
  return rows.filter(row => {
    try {
      assertReadable(app, row.sessionId || row.id, captured, row);
      return true;
    }
    catch (_) { return false; }
  }).map(row => { const { workOwner, ...visible } = row; return visible; });
}
function assertCurrent(app, captured, identity) {
  const current = actor(app, identity);
  if (!captured.owner || current.owner !== captured.owner || current.readScope !== captured.readScope ||
      captured.epoch !== undefined && current.epoch !== captured.epoch)
    throw Error('账号已切换，请在当前账号重新打开会话');
}
module.exports = { actor, assertOwner, assertReadable, assertCurrent, visible, isOwnerlessNativeArchive, readScope };
