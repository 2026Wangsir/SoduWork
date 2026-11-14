'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { replaceFileSync } = require('./verified-file-replace.cjs');
const defaultModels = require('./local-model-store.cjs');
const defaultRuntimes = require('./agent-runtime/runtime-catalog');

const MODEL = /^local:model-[a-f0-9]{32}$/;
const AGENT = /^[a-z][a-z0-9-]{0,39}$/;
const ID = /^[A-Za-z0-9._:-]{1,160}$/;
const DIGEST = /^[a-f0-9]{64}$/;
let deps;

function configure(value) { deps = value; }
function configured() { return Boolean(deps?.app && deps?.safeStorage); }
function models() { return deps?.modelStore || defaultModels; }
function agentId(value) {
  const id = String(value || '').trim();
  const runtime = (deps?.runtimes || defaultRuntimes).runtime(id);
  if (!AGENT.test(id) || !runtime || runtime.modelMode !== 'managed') {
    throw Error('本地默认模型仅支持受管型 Agent，账号型底座使用独立模型');
  }
  return id;
}
function scopeKey(input) {
  const hub = String(input?.hub || '').replace(/\/+$/, '');
  let origin;
  try { origin = new URL(hub); } catch (_) { throw Error('本地 Agent 模型作用域无效'); }
  if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== hub ||
      !ID.test(String(input?.clientId || '')) || !ID.test(String(input?.owner || ''))) {
    throw Error('本地 Agent 模型作用域无效');
  }
  return crypto.createHash('sha256').update(JSON.stringify([hub, input.clientId, input.owner])).digest('hex');
}
function scopeFromIdentity(identity) {
  // Identity is supplied by the trusted device-auth session, never renderer input.
  const owner = require('./platform-connections/runtime.cjs').scope(identity);
  return { hub: new URL(identity.hub).origin, clientId: identity.clientId, owner };
}
function secure() {
  if (!deps?.safeStorage?.isEncryptionAvailable?.() ||
      (process.platform === 'linux' && deps.safeStorage.getSelectedStorageBackend?.() === 'basic_text')) {
    throw Error('系统安全存储不可用，无法读写本地 Agent 默认模型');
  }
}
function file() { return path.join(deps.app.getPath('userData'), 'agent-models.secure.json'); }
function object(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function revision(value) { return Number.isSafeInteger(value) && value >= 0; }
function emptyRecord() { return { revision: 0, models: {} }; }
function read() {
  if (!deps?.app || !deps?.safeStorage) throw Error('本地 Agent 默认模型存储未就绪');
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file(), 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return { schema: 1, scopes: {} };
    throw Error('本地 Agent 默认模型存储无法读取');
  }
  secure();
  let value;
  try {
    if (raw?.schema !== 1 || typeof raw.cipher !== 'string') throw Error();
    value = JSON.parse(deps.safeStorage.decryptString(Buffer.from(raw.cipher, 'base64')));
  } catch (_) { throw Error('本地 Agent 默认模型存储无法解密'); }
  if (value?.schema !== 1 || !object(value.scopes)) throw Error('本地 Agent 默认模型存储已损坏');
  for (const [key, row] of Object.entries(value.scopes)) {
    if (!DIGEST.test(key) || !object(row) || !revision(row.revision) || !object(row.models) ||
        Object.entries(row.models).some(([id, model]) => !AGENT.test(id) || !MODEL.test(model))) {
      throw Error('本地 Agent 默认模型存储已损坏');
    }
  }
  return value;
}
function write(value) {
  secure();
  const target = file(), temporary = target + '.' + crypto.randomUUID() + '.tmp';
  const cipher = deps.safeStorage.encryptString(JSON.stringify(value)).toString('base64');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try {
    fs.writeFileSync(temporary, JSON.stringify({ schema: 1, cipher }), { mode: 0o600, flag: 'wx' });
    replaceFileSync(temporary, target);
  } finally { fs.rmSync(temporary, { force: true }); }
}
function selection(id, modelName, usable) {
  const model = modelName && usable.find(row => row.name === modelName);
  const configured = Boolean(modelName);
  return { agentId: id, modelName: modelName || '', configured,
    localOnly: configured, unavailable: configured && !model,
    label: model ? String(model.label || model.name) : configured ? '原本地模型已删除或不可用' : '' };
}
function get(input = {}) {
  const key = scopeKey(input), id = input.agentId == null ? '' : agentId(input.agentId);
  const row = read().scopes[key] || emptyRecord();
  const usable = Object.keys(row.models).length ? models().get().usable : [];
  if (!Array.isArray(usable)) throw Error('本地模型目录无法读取，请检查系统安全存储');
  if (id) return { ok: true, scopeKey: key, revision: row.revision, ...selection(id, row.models[id], usable) };
  const selections = {};
  for (const [name, model] of Object.entries(row.models)) {
    // Removed custom runtimes retain encrypted records without becoming selectable defaults.
    if ((deps?.runtimes || defaultRuntimes).runtime(name)?.modelMode === 'managed') {
      selections[name] = selection(name, model, usable);
    }
  }
  return { ok: true, scopeKey: key, revision: row.revision,
    models: Object.fromEntries(Object.entries(selections).map(([name, value]) => [name, value.modelName])), selections };
}
function set(input = {}) {
  const key = scopeKey(input), id = agentId(input.agentId), model = String(input.modelName || '').trim();
  if (model && !MODEL.test(model)) throw Error('请选择当前设备可用的本地模型');
  const value = read(), row = value.scopes[key] || emptyRecord();
  if (input.expectedRevision != null && (!revision(input.expectedRevision) || input.expectedRevision !== row.revision)) {
    throw Object.assign(Error('本地 Agent 默认模型已变化，请刷新后重试'), { code: 'LOCAL_AGENT_MODEL_CONFLICT' });
  }
  if (model && !(models().get().usable || []).some(item => item.name === model && item.localOnly === true &&
      (!item.modality || item.modality === 'chat'))) throw Error('原本地模型已删除或不可用，请重新选择');
  if (row.revision === Number.MAX_SAFE_INTEGER) throw Error('本地 Agent 默认模型版本已达上限');
  const next = { ...row.models };
  if (model) next[id] = model; else delete next[id];
  value.scopes[key] = { revision: row.revision + 1, models: next };
  write(value);
  return get({ ...input, agentId: id });
}
function remove(input = {}) { return set({ ...input, modelName: '' }); }

function fromIdentity(identity, agent) { return get({ ...scopeFromIdentity(identity), agentId: agent }); }

module.exports = { configure, configured, get, set, remove, scopeKey, scopeFromIdentity, fromIdentity, agentId, MODEL };
