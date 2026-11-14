'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { replaceFileSync } = require('./verified-file-replace.cjs');

const SCHEMA = 2;
const MODEL_REF = /^local:model-[a-f0-9]{32}$/;
const HUB = /^https?:\/\/[^/]+$/i;
const ID = /^[A-Za-z0-9._:-]{1,160}$/;
let deps = null;

function configure(value) { deps = value || null; }
function file() { return path.join(deps.app.getPath('userData'), 'automation-models.secure.json'); }
function secure() {
  if (!deps?.safeStorage?.isEncryptionAvailable?.() ||
      (process.platform === 'linux' && deps.safeStorage.getSelectedStorageBackend?.() === 'basic_text')) {
    throw Error('系统安全存储不可用，无法保存自动化本地模型选择');
  }
}
function cleanScope(hub, clientId, owner) {
  const origin = String(hub || '').replace(/\/+$/, '');
  if (!HUB.test(origin) || !ID.test(String(clientId || ''))) throw Error('自动化模型作用域无效');
  const deviceScope = origin + '\n' + String(clientId);
  if (arguments.length < 3) return deviceScope;
  if (typeof owner !== 'string' || !/^account:[^\s\u0000-\u001f]{1,160}$/.test(owner)) throw Error('自动化模型账号作用域无效');
  return deviceScope + '\n' + owner;
}
function cleanScheduleId(value) {
  const id = String(value || '').trim();
  if (!ID.test(id)) throw Error('自动化标识无效');
  return id;
}
function cleanModel(value) {
  const model = String(value || '').trim();
  if (model && !MODEL_REF.test(model)) throw Error('本地模型引用无效');
  return model;
}
function empty() { return { schema: SCHEMA, entries: {}, legacyEntries: {} }; }
function read() {
  if (!deps?.app || !deps?.safeStorage) return empty();
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file(), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return empty(); throw Error('自动化本地模型选择无法读取'); }
  if (![1, SCHEMA].includes(raw?.schema) || typeof raw.cipher !== 'string') throw Error('自动化本地模型选择无法读取');
  secure();
  let value;
  try {
    value = JSON.parse(deps.safeStorage.decryptString(Buffer.from(raw.cipher, 'base64')));
  } catch (_) { throw Error('自动化本地模型选择无法解密'); }
  if (!value || value.schema !== raw.schema || !value.entries ||
      typeof value.entries !== 'object' || Array.isArray(value.entries)) {
    throw Error('自动化本地模型选择数据损坏');
  }
  function validated(entries, legacy) {
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw Error('自动化本地模型选择数据损坏');
    const checked = {};
    for (const [key, model] of Object.entries(entries)) {
      const parts = typeof key === 'string' ? key.split('\n') : [];
      if (parts.length !== (legacy ? 3 : 4) || typeof model !== 'string' || !MODEL_REF.test(model)) {
        throw Error('自动化本地模型选择数据损坏');
      }
      let scope;
      try {
        scope = legacy ? cleanScope(parts[0], parts[1]) : cleanScope(parts[0], parts[1], parts[2]);
        cleanScheduleId(parts.at(-1));
      } catch (_) { throw Error('自动化本地模型选择数据损坏'); }
      if (scope + '\n' + parts.at(-1) !== key) throw Error('自动化本地模型选择数据损坏');
      checked[key] = model;
    }
    return checked;
  }
  // Legacy entries have no account provenance. Preserve them verbatim, but
  // require an explicit model selection before binding a schedule to an owner.
  return value.schema === 1
    ? { schema: SCHEMA, entries: {}, legacyEntries: validated(value.entries, true) }
    : { schema: SCHEMA, entries: validated(value.entries, false), legacyEntries: validated(value.legacyEntries || {}, true) };
}
function write(value) {
  secure();
  const target = file(), temporary = target + '.' + crypto.randomUUID() + '.tmp';
  const cipher = deps.safeStorage.encryptString(JSON.stringify(value)).toString('base64');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try {
    fs.writeFileSync(temporary, JSON.stringify({ schema: SCHEMA, cipher }), { mode: 0o600, flag: 'wx' });
    replaceFileSync(temporary, target);
  } finally { fs.rmSync(temporary, { force: true }); }
}
function get(input = {}) {
  const scope = cleanScope(input.hub, input.clientId, input.owner);
  const legacyScope = cleanScope(input.hub, input.clientId);
  const value = read(), ids = Array.isArray(input.scheduleIds) ? input.scheduleIds : null;
  if (input.scheduleId != null) {
    const id = cleanScheduleId(input.scheduleId);
    const key = scope + '\n' + id;
    const configured = Object.hasOwn(value.entries, key);
    return { ok: true, modelName: value.entries[key] || '', configured,
      ...(!configured && Object.hasOwn(value.legacyEntries, legacyScope + '\n' + id) ? { needsReselection: true } : {}) };
  }
  const selected = {};
  for (const [key, model] of Object.entries(value.entries)) {
    if (key.startsWith(scope + '\n')) {
      const id = key.slice(scope.length + 1);
      if ((!ids || ids.includes(id)) && ID.test(id)) selected[id] = model;
    }
  }
  const unavailableScheduleIds = (ids || []).filter(id => ID.test(id) && !selected[id] &&
    Object.hasOwn(value.legacyEntries, legacyScope + '\n' + id));
  return { ok: true, models: selected, ...(unavailableScheduleIds.length ? { unavailableScheduleIds } : {}) };
}
function set(input = {}) {
  const scope = cleanScope(input.hub, input.clientId, input.owner), id = cleanScheduleId(input.scheduleId);
  const model = cleanModel(input.modelName), value = read(), key = scope + '\n' + id;
  if (model) value.entries[key] = model; else delete value.entries[key];
  write(value);
  return { ok: true, modelName: model };
}
function remove(input = {}) { return set({ ...input, modelName: '' }); }

module.exports = { configure, get, set, remove, MODEL_REF };
