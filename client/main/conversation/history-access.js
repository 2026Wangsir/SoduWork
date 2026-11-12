'use strict';

// Ordinary local data belongs to this profile. Execution credentials and
// protected requirement/cloud conversations remain account-bound.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const runtime = require('../platform-connections/runtime.cjs');
const { assertNoLinks } = require('../plugin-resources');
const LEGACY_OWNER_DIRECTORY = 'conversation-history-owners';
function metadataReader(app, batch = false) {
  const root = app.getPath('userData'), directories = new Map(), values = new Map();
  const names = directory => {
    if (!directories.has(directory)) {
      try {
        assertNoLinks(root, path.join(root, directory));
        directories.set(directory, new Set(fs.readdirSync(path.join(root, directory))));
      }
      catch (error) { if (error.code === 'ENOENT') directories.set(directory, new Set()); else throw error; }
    }
    return directories.get(directory);
  };
  const contains = (directory, name) => !batch || names(directory).has(name);
  const load = file => {
    if (values.has(file)) return values.get(file);
    let stat;
    try { stat = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    assertNoLinks(root, file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw Error('Invalid conversation metadata');
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!value || typeof value !== 'object') throw Error('Invalid conversation metadata');
    values.set(file, value);
    return value;
  };
  const read = (directory, target) => {
    const name = crypto.createHash('sha256').update(target).digest('hex') + '.json';
    if (directory === 'conversation-runtime-segments') {
      const file = path.join(root, directory, name);
      if (values.has(file)) return values.get(file);
      const record = require('./runtime-segments').read(app, target);
      values.set(file, record); return record;
    }
    return contains(directory, name) ? load(path.join(root, directory, name)) : null;
  };
  let parents, parentFailure;
  read.parents = id => {
    if (parentFailure) throw parentFailure;
    if (!parents) {
      const index = new Map();
      try {
        const records = require('./runtime-segments').identities(app), filenames = new Set();
        for (const record of records) {
          const name = crypto.createHash('sha256').update(record.id).digest('hex') + '.json';
          filenames.add(name);
          values.set(path.join(root, 'conversation-runtime-segments', name), record);
          for (const part of [...record.segments, record.active]) {
            if (typeof part?.sessionId !== 'string' || !part.sessionId || part.sessionId.length > 512)
              throw Error('Invalid runtime segment identity');
            if (!index.has(part.sessionId)) index.set(part.sessionId, new Set());
            index.get(part.sessionId).add(record.id);
          }
        }
        directories.set('conversation-runtime-segments', filenames);
        parents = index;
      } catch (error) { parentFailure = error; throw error; }
    }
    return parents.get(id) || [];
  };
  read.contains = (directory, id) => contains(directory, crypto.createHash('sha256').update(id).digest('hex') + '.json');
  return read;
}
function classify(app, id, row, metadata) {
  const canonical = String(row.id || row.sessionId || '');
  const ids = new Set([canonical, ...(Array.isArray(row.historyAliasIds) ? row.historyAliasIds : [])].filter(Boolean));
  const authority = [], clouds = [];
  let protectedData = Boolean(row.cloud || row.remoteProjection || row.accountProjection || row.accountConversation ||
    row.acceptanceReview || row.requirementContext || row.taskId || row.taskRef || row.activeTaskId ||
    row.taskIds?.length || row.taskBindings?.length || row.historyProtection === 'account');
  const result = (kind, invalid = false) => Object.freeze({ kind, id: canonical, ids: Object.freeze([...ids]), row,
    authority: Object.freeze(authority), clouds: Object.freeze(clouds), invalid });
  if (!app?.getPath || !canonical || typeof id !== 'string' || ids.size > 1001) return result('unknown', true);
  try {
    // Follow explicit native segments only. Source locators are not aliases and
    // cannot inherit another conversation's local execution or lifecycle rights.
    const pending = [...ids];
    for (let index = 0; index < pending.length; index++) {
      if (pending.length > 1001) return result('unknown', true);
      const current = pending[index];
      if (!row.cached && !row.source && !row.cloud && !row.accountProjection && !row.accountConversation && !row.remoteProjection)
        for (const parent of metadata.parents(current)) {
          if (!ids.has(parent)) { ids.add(parent); pending.push(parent); }
        }
      const record = metadata('conversation-runtime-segments', current);
      if (record) {
        if (record.version !== 1 || record.id !== current || !Array.isArray(record.segments) || !record.active?.sessionId)
          return result('unknown', true);
        for (const part of [...record.segments, record.active]) {
          if (typeof part?.sessionId !== 'string' || !part.sessionId || part.sessionId.length > 512) return result('unknown', true);
          if (!ids.has(part.sessionId)) { ids.add(part.sessionId); pending.push(part.sessionId); }
        }
      }
      for (const directory of ['requirement-session-context', 'acceptance-session-context']) {
        const value = metadata(directory, current);
        if (value) {
          if (value.version !== 1 || typeof value.owner !== 'string' || !value.owner) return result('unknown', true);
          protectedData = true; authority.push(value.owner);
        }
      }
      const cloud = metadata('conversation-handoffs', current);
      if (cloud) {
        if (cloud.sessionId !== current || typeof cloud.owner !== 'string' || !cloud.owner) return result('unknown', true);
        protectedData = true; clouds.push(cloud);
      }
      const tasks = metadata('conversation-tasks', current);
      if (tasks) {
        if (!Array.isArray(tasks) || tasks.some(task => typeof task?.taskId !== 'string' || !task.taskId)) return result('unknown', true);
        protectedData ||= tasks.length > 0;
      }
      const forms = metadata.contains('conversation-work-cards', current)
        ? require('./work-conversation-cards').protection(app, current) : null;
      if (forms) {
        if (forms.invalid || forms.unknown && (typeof forms.owner !== 'string' || !forms.owner)) return result('unknown', true);
        if (forms.hasRequirement || forms.unknown) {
          if (typeof forms.owner !== 'string' || !forms.owner) return result('unknown', true);
          protectedData = true; authority.push(forms.owner);
        }
      }
    }
    if (!ids.has(id)) return result('unknown', true);
    if (protectedData && !authority.length && !clouds.length && row.historyTaskOwnerIds?.length) {
      if (!Array.isArray(row.historyTaskOwnerIds) || row.historyTaskOwnerIds.length > 1001) return result('unknown', true);
      for (const sourceId of row.historyTaskOwnerIds) {
        if (!ids.has(sourceId)) return result('unknown', true);
        const binding = metadata('session-memory-bindings', sourceId);
        const manifest = metadata('conversation-runtime-segments', sourceId);
        const owner = binding?.owner || manifest?.owner;
        if (typeof owner !== 'string' || !owner) return result('unknown', true);
        authority.push(owner);
      }
    }
    if (protectedData) return result('protected');
    // A downloaded transcript is not a native runtime. Old copies did not
    // retain complete requirement provenance, so absence is not sharing proof.
    if (row.cached || row.adapterId === 'account-sync' || row.source) return result('unknown');
    let native = row.localReplica === true || row.nativeHistory === true;
    if (!native && typeof row.path === 'string' && path.isAbsolute(row.path)) {
      let root, real;
      try { root = fs.realpathSync(path.join(app.getPath('userData'), 'pi-agent')); real = fs.realpathSync(row.path); }
      catch (error) { if (error.code === 'ENOENT') return result('unknown'); throw error; }
      const relative = path.relative(root, real);
      if (relative && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative) &&
          path.extname(row.path).toLowerCase() === '.jsonl') {
        // Windows native archives may use the canonical path while userData
        // retains an 8.3 spelling. Check physical containment and both paths.
        for (let cursor = path.resolve(row.path);;) {
          if (fs.lstatSync(cursor).isSymbolicLink()) throw Error('Linked native archive');
          if (!path.relative(root, fs.realpathSync(cursor))) break;
          const parent = path.dirname(cursor);
          if (parent === cursor) throw Error('Invalid native archive root');
          cursor = parent;
        }
        assertNoLinks(root, real); native = fs.statSync(real).isFile();
      }
    }
    return result(native ? 'ordinary' : 'unknown');
  } catch (_) { return result('unknown', true); }
}
function classifyLocal(app, id, row = {}) {
  return classify(app, id, row, app?.getPath ? metadataReader(app) : () => null);
}
function actor(app, identity) {
  const auth = require('../device-auth');
  if (identity === undefined) identity = require('./requirement-context').cachedIdentity(app);
  let owner = '';
  try { owner = runtime.scope(identity); } catch (_) { owner = auth.localOwner(app); }
  return { identity, owner, candidates: auth.profiles(app) };
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
function bindLegacyOwner(app, id, captured) {
  const file = path.join(app.getPath('userData'), LEGACY_OWNER_DIRECTORY,
    crypto.createHash('sha256').update(String(id)).digest('hex') + '.json');
  const record = {
    version: 1, sessionId: id, owner: captured.owner,
    hub: String(captured.identity?.hub || ''), migratedAt: new Date().toISOString(),
  };
  assertNoLinks(app.getPath('userData'), file);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(file, JSON.stringify(record), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return record;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return legacyOwner(app, id);
  }
}
function isOwnerlessNativeArchive(row) {
  // Native archive projections carry an absolute JSONL path and at least one
  // persisted message. Synthetic rows and cloud previews do not qualify for
  // first-open migration, so they remain hidden until an owner is recorded.
  return !!row && !row.workOwner && !row.cloud && typeof row.path === 'string' &&
    path.isAbsolute(row.path) && path.extname(row.path).toLowerCase() === '.jsonl' &&
    Number.isSafeInteger(Number(row.count)) && Number(row.count) > 0;
}
function assertOwner(app, id, captured = actor(app), row = {}, options = {}) {
  return assertClassifiedOwner(app, id, captured, row, options, null);
}
function assertClassifiedOwner(app, id, captured, row, options, classified) {
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
  const local = classified || classifyLocal(app, id, row);
  if (local.invalid && (row.id || row.sessionId)) throw Error('无法读取会话归属记录，请重新打开 SoduWork');
  if ((local.kind === 'protected' || row.cached) && runtime.scope(captured.identity) !== captured.owner)
    throw Error('请先登录 SoduWork 后查看会话');
  if (row.cached && row.localReplica && local.ids.includes(id)) {
    const owner = row.source?.account || row.creator?.account;
    const hub = row.source?.hub || row.creator?.hub;
    if (!owner || owner !== require('../device-auth-request').accountId(captured.identity) ||
        !hub || new URL(hub).origin !== new URL(captured.identity?.hub).origin)
      throw Error('无法确认这条会话属于当前账号，请切回原账号');
    if (!local.authority.length && !local.clouds.length) return;
  }
  if (local.kind === 'protected' && (local.authority.length || local.clouds.length)) {
    if (local.authority.some(owner => !runtime.scopeMatches(owner, captured.identity, captured.candidates)))
      throw Error('无法确认这条会话属于当前账号，请切回原账号');
    const syncOwner = require('./cloud-execution-sync').scope(captured.identity);
    if (local.clouds.some(cloud => cloud.owner !== runtime.connectionScope(captured.identity) && (!syncOwner || cloud.syncOwner !== syncOwner)))
      throw Error('这条云端会话属于其他账号或服务，请切回原连接');
    if (row.workOwner && !runtime.scopeMatches(row.workOwner, captured.identity, captured.candidates)) {
      // Adding a requirement to a shared ordinary draft does not transfer its
      // private memory binding. Preserve that creator proof, but reject an
      // unrelated or corrupt native form owner rather than trusting one file.
      const original = metadataReader(app)('session-memory-bindings', local.id);
      if (!original?.owner || original.owner !== row.workOwner)
        throw Error('无法确认这条会话属于当前账号，请切回原账号');
    }
    if (options.readOnly) return;
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
  if (!owners.length && options.allowLegacy === true && isOwnerlessNativeArchive(row)) {
    const migrated = bindLegacyOwner(app, id, captured);
    if (migrated?.owner) owners.push(migrated.owner);
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
  return assertClassifiedReadable(app, id, captured, row, null);
}
function assertClassifiedReadable(app, id, captured, row, classified) {
  if (!id || typeof id !== 'string' || id.length > 512 || (row.id || row.sessionId) !== id)
    throw Error('会话标识无效');
  // Callers resolve rows through trusted local indexes, never renderer-supplied
  // paths. A downloaded replica is local data, not a remote permission grant.
  const local = classified || classifyLocal(app, id, row);
  if (local.invalid) throw Error('无法读取会话归属记录，请重新打开 SoduWork');
  if (local.kind === 'ordinary') {
    // Device-local transcripts retain their existing offline read behavior.
    // They never grant access to account-bound execution credentials.
    return;
  }
  if (local.kind === 'protected' || row.localReplica === true)
    return assertClassifiedOwner(app, id, captured, row, { readOnly: true }, local);
  if (row.remoteProjection === true || row.accountProjection === true || row.accountConversation === true ||
      row.adapterId === 'account-sync' || row.sourceClientId || row.cloud === true)
    return assertOwner(app, id, captured, row);
}
function assertLocalMutation(app, id, captured = actor(app), row = {}) {
  if (classifyLocal(app, id, row).kind !== 'ordinary' &&
      (!captured.owner || runtime.scope(captured.identity) !== captured.owner))
    throw Error('请先登录 SoduWork 后查看会话');
  assertReadable(app, id, captured, row);
}
function visible(app, rows, identity) {
  const captured = actor(app, identity), metadata = metadataReader(app, true);
  return filterVisible(app, rows, captured, row => classify(app, row.sessionId || row.id, row, metadata));
}
async function visibleAsync(app, rows, identityOf) {
  const metadata = metadataReader(app, true), classified = new Map();
  for (let index = 0; index < rows.length; index++) {
    if (index % 32 === 0) await new Promise(resolve => setImmediate(resolve));
    const row = rows[index];
    classified.set(row, classify(app, row.sessionId || row.id, row, metadata));
  }
  // Metadata discovery may yield to an account switch. Apply its authority only
  // once all batches are ready, using the identity that will receive the page.
  return filterVisible(app, rows, actor(app, identityOf()), row => classified.get(row));
}
function filterVisible(app, rows, captured, classification) {
  return rows.filter(row => {
    try {
      const id = row.sessionId || row.id;
      assertClassifiedReadable(app, id, captured, row, classification(row));
      return true;
    }
    catch (_) { return false; }
  }).map(row => { const { workOwner, ...visible } = row; return visible; });
}
function assertLocalCurrent(app, captured, row, identity) {
  if (classifyLocal(app, row.id || row.sessionId, row).kind !== 'ordinary')
    assertCurrent(app, captured, identity);
}
function assertCurrent(app, captured, identity) {
  const current = actor(app, identity);
  const connection = value => {
    let hub = String(value.identity?.hub || '').replace(/\/+$/, '');
    try { hub = new URL(hub).toString().replace(/\/+$/, ''); } catch (_) { /* Keep invalid identities distinct without trusting them. */ }
    return JSON.stringify([hub, String(value.identity?.clientId || '')]);
  };
  if (!captured.owner || current.owner !== captured.owner || connection(current) !== connection(captured))
    throw Error('账号已切换，请在当前账号重新打开会话');
}
module.exports = { assertLocalCurrent, assertLocalMutation, actor, assertOwner, assertReadable, assertCurrent, visible, visibleAsync, isOwnerlessNativeArchive, classifyLocal };
