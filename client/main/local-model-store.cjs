'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { replaceFileSync } = require('./verified-file-replace.cjs');

const SCHEMA = 2;
const OPAQUE_REF = /^local:model-[a-f0-9]{32}$/;
const ID = /^[a-z][a-z0-9_-]{0,47}$/;
const MODEL_ID = /^[^\u0000\r\n]{1,160}$/u;
let deps = null;

function configure(value) { deps = value || null; }
function file() { return path.join(deps.app.getPath('userData'), 'local-models.secure.json'); }
function secure() {
  if (!deps?.safeStorage?.isEncryptionAvailable?.() ||
      (process.platform === 'linux' && deps.safeStorage.getSelectedStorageBackend?.() === 'basic_text')) {
    throw Error('系统安全存储不可用，无法保存本地模型凭据');
  }
}
function empty() { return { schema: SCHEMA, revision: 0, providers: [], models: [], keys: {}, aliases: {} }; }
function readRaw() {
  if (!deps?.app || !deps?.safeStorage) return empty();
  let encoded;
  try { encoded = fs.readFileSync(file(), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return empty(); throw Error('本地模型配置无法读取'); }
  try {
    const value = JSON.parse(encoded);
    if (![1, SCHEMA].includes(value?.schema) || typeof value.cipher !== 'string') throw Error();
    secure();
    const decoded = JSON.parse(deps.safeStorage.decryptString(Buffer.from(value.cipher, 'base64')));
    if (!decoded || decoded.schema !== value.schema || !Array.isArray(decoded.providers) ||
        !Array.isArray(decoded.models) || !record(decoded.keys) || !Number.isSafeInteger(decoded.revision)) throw Error();
    const normalized = normalize(decoded);
    if (decoded.schema === SCHEMA) return normalized;
    if (normalized.revision === Number.MAX_SAFE_INTEGER) invalid('配置版本');
    // Persist the random identity once before exposing it. A failed migration
    // must not return references that a subsequent read cannot recover.
    const migrated = identify(normalized, empty());
    migrated.revision = normalized.revision + 1;
    write(migrated);
    return migrated;
  } catch (error) {
    if (error.message === '系统安全存储不可用，无法保存本地模型凭据') throw error;
    throw Error('本地模型配置无法读取');
  }
}
function text(value, max) {
  const result = typeof value === 'string' ? value.trim() : '';
  return result.length <= max ? result : '';
}
function record(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function invalid(field) { throw Error('本地模型配置无效：' + field); }
function field(value, max, label, fallback = '') {
  if (value == null) return fallback;
  if (typeof value !== 'string' || value.trim().length > max) invalid(label);
  return value.trim();
}
function normalize(input) {
  if (!record(input)) invalid('配置格式');
  const rawProviders = input.providers ?? [], rawModels = input.models ?? [], rawKeys = input.keys ?? {};
  if (!Array.isArray(rawProviders) || rawProviders.length > 50) invalid('服务列表（最多 50 项）');
  if (!Array.isArray(rawModels) || rawModels.length > 200) invalid('模型列表（最多 200 项）');
  if (!record(rawKeys)) invalid('凭据格式');
  if (input.revision != null && (!Number.isSafeInteger(input.revision) || input.revision < 0)) invalid('配置版本');
  const providers = [], seen = new Set();
  for (const raw of rawProviders) {
    if (!record(raw)) invalid('服务格式');
    const id = field(raw.id, 48, '服务标识').toLowerCase();
    const baseUrl = field(raw.baseUrl, 400, 'API 地址').replace(/\/+$/, '');
    if (!ID.test(id) || seen.has(id)) invalid('服务标识无效或重复');
    if (raw.kind != null && raw.kind !== 'openai-compat') invalid('接口协议仅支持 OpenAI 兼容');
    if (raw.authMode != null && !['none', 'key'].includes(raw.authMode)) invalid('认证方式');
    let parsed;
    try {
      parsed = new URL(baseUrl);
    } catch (_) { invalid('API 地址'); }
    if (!/^https?:\/\//i.test(baseUrl) || !['http:', 'https:'].includes(parsed.protocol) ||
        parsed.username || parsed.password || parsed.search || parsed.hash) invalid('API 地址');
    providers.push({ id, name: field(raw.name, 64, '服务名称', id) || id, kind: 'openai-compat', baseUrl,
      authMode: raw.authMode === 'none' ? 'none' : 'key', note: field(raw.note, 300, '服务备注'), localOnly: true });
    seen.add(id);
  }
  const models = [], modelSeen = new Set(), references = new Set();
  for (const raw of rawModels) {
    if (!record(raw)) invalid('模型格式');
    const providerId = field(raw.providerId, 48, '模型服务标识').toLowerCase(), name = field(raw.name, 160, '模型 ID');
    if (!seen.has(providerId) || !MODEL_ID.test(name) || !name.isWellFormed()) invalid('模型 ID 或所属服务');
    const key = providerId + '\0' + name;
    if (modelSeen.has(key)) invalid('模型 ID 重复');
    const modelRef = raw.id == null ? '' : field(raw.id, 2048, '模型引用');
    if (modelRef && !OPAQUE_REF.test(modelRef) && !legacyParts(modelRef)) invalid('模型引用');
    if (input.schema === SCHEMA && !OPAQUE_REF.test(modelRef)) invalid('模型引用');
    if (modelRef && references.has(modelRef)) invalid('模型引用重复');
    if (modelRef) references.add(modelRef);
    const modality = raw.modality ?? 'chat';
    if (!['chat', 'image', 'video'].includes(modality)) invalid('模型类型');
    if (raw.config != null && !record(raw.config)) invalid('模型参数');
    if (raw.ctxWindow != null && (!Number.isSafeInteger(raw.ctxWindow) || raw.ctxWindow < 0)) invalid('上下文窗口');
    models.push({ ...(modelRef ? { id: modelRef } : {}), providerId, name, label: raw.label === name ? name.slice(0, 80) :
      field(raw.label, 80, '模型名称', name.slice(0, 80)) || name.slice(0, 80), modality,
      ...(raw.config && typeof raw.config === 'object' && !Array.isArray(raw.config) ? { config: raw.config } : {}),
      ...(Number.isSafeInteger(raw.ctxWindow) && raw.ctxWindow > 0 ? { ctxWindow: raw.ctxWindow } : {}) });
    modelSeen.add(key);
  }
  const keys = Object.create(null);
  for (const [id, value] of Object.entries(rawKeys)) {
    if (!seen.has(id)) invalid('凭据所属服务');
    if (typeof value !== 'string') invalid('API Key');
    const key = field(value, 400, 'API Key');
    if (key) keys[id] = key;
  }
  const aliases = Object.create(null);
  if (input.schema === SCHEMA && !record(input.aliases)) invalid('模型引用映射');
  if (input.aliases != null) {
    if (!record(input.aliases)) invalid('模型引用映射');
    for (const [legacyRef, modelRef] of Object.entries(input.aliases)) {
      const parts = legacyParts(legacyRef);
      if (!parts || ref(parts.providerId, parts.name) !== legacyRef || !OPAQUE_REF.test(modelRef)) invalid('模型引用映射');
      aliases[legacyRef] = modelRef;
    }
  }
  return { schema: SCHEMA, revision: Number.isSafeInteger(input?.revision) ? input.revision : 0,
    providers, models, keys, aliases };
}
function write(value) {
  secure();
  const target = file(), temp = target + '.' + crypto.randomUUID() + '.tmp';
  const cipher = deps.safeStorage.encryptString(JSON.stringify(value)).toString('base64');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try {
    fs.writeFileSync(temp, JSON.stringify({ schema: SCHEMA, cipher }), { mode: 0o600, flag: 'wx' });
    replaceFileSync(temp, target);
  } finally { fs.rmSync(temp, { force: true }); }
}
function ref(providerId, modelId) { return 'local:' + providerId + ':' + encodeURIComponent(modelId); }
function legacyParts(value) {
  if (typeof value !== 'string' || !value.startsWith('local:') || value.length > 2048) return null;
  const split = value.indexOf(':', 6), providerId = split < 0 ? '' : value.slice(6, split);
  let name;
  try { name = split < 0 ? '' : decodeURIComponent(value.slice(split + 1)); } catch (_) { return null; }
  return ID.test(providerId) && MODEL_ID.test(name) && name.isWellFormed() ? { providerId, name } : null;
}
function randomReference(used) {
  let value;
  do { value = 'local:model-' + crypto.randomBytes(16).toString('hex'); } while (used.has(value));
  used.add(value);
  return value;
}
function identify(value, current) {
  const aliases = Object.assign(Object.create(null), current.aliases);
  const used = new Set([...Object.values(aliases), ...current.models.map(row => row.id)]);
  const selected = new Set();
  const models = value.models.map(row => {
    let existing;
    if (row.id) {
      const parts = legacyParts(row.id);
      const id = parts ? aliases[ref(parts.providerId, parts.name)] : row.id;
      existing = current.models.find(item => item.id === id);
      if (!existing || existing.providerId !== row.providerId) invalid('模型引用');
    } else existing = current.models.find(item => item.providerId === row.providerId && item.name === row.name);
    const id = existing?.id || randomReference(used);
    if (selected.has(id)) invalid('模型引用重复');
    selected.add(id);
    // Never retarget an old reference after deletion and recreation. The old
    // alias remains an encrypted tombstone, so history cannot select a new key.
    const legacy = ref(row.providerId, row.name);
    if (!Object.hasOwn(aliases, legacy)) aliases[legacy] = id;
    return { ...row, id };
  });
  return { ...value, models, aliases };
}
function canonicalIn(value, modelRef) {
  const raw = text(modelRef, 2048);
  if (OPAQUE_REF.test(raw)) return raw;
  const parts = legacyParts(raw);
  return parts ? value.aliases[ref(parts.providerId, parts.name)] || '' : '';
}
function canonicalReference(modelRef, { rememberMissing = false } = {}) {
  const value = readRaw(), found = canonicalIn(value, modelRef);
  if (found || !rememberMissing) return found;
  const parts = legacyParts(text(modelRef, 2048));
  if (!parts) return '';
  if (value.revision === Number.MAX_SAFE_INTEGER) invalid('配置版本');
  const canonical = randomReference(new Set([...Object.values(value.aliases), ...value.models.map(row => row.id)]));
  value.aliases[ref(parts.providerId, parts.name)] = canonical;
  value.revision++;
  write(value);
  return canonical;
}
// Host-only migration metadata. Never expose this mapping through renderer IPC.
function referenceAliases() {
  const value = readRaw();
  return Object.entries(value.aliases).map(([legacyRef, modelRef]) => {
    const { providerId, name } = legacyParts(legacyRef);
    return { legacyRef, modelRef, runtimeId: modelRef, providerId, modelName: name,
      active: value.models.some(row => row.id === modelRef) };
  });
}
function publicCatalog(value = readRaw()) {
  const providers = value.providers.map(provider => ({ ...provider, personal: true,
    keySet: provider.authMode === 'none' || Boolean(value.keys[provider.id]),
    keyLen: value.keys[provider.id]?.length || 0,
    myKeySet: provider.authMode === 'none' || Boolean(value.keys[provider.id]),
    myKeyLen: value.keys[provider.id]?.length || 0,
    modelDefs: value.models.filter(model => model.providerId === provider.id).map(model => ({ ...model, localOnly: true })),
    modelNames: value.models.filter(model => model.providerId === provider.id).map(model => model.name),
  }));
  const usable = value.models.filter(model => {
    const provider = value.providers.find(row => row.id === model.providerId);
    return provider && (provider.authMode === 'none' || value.keys[provider.id]);
  }).map(model => {
    const provider = value.providers.find(row => row.id === model.providerId);
    return { id: model.id, providerId: model.providerId,
      name: model.id, modelName: model.name, label: model.label,
      modality: model.modality, config: model.config || {}, ctxWindow: model.ctxWindow || 0,
      providerName: provider.name, keyFrom: 'local', own: true, localOnly: true };
  });
  return { providers, usable: usable.filter(row => row.modality === 'chat'),
    mediaUsable: { image: usable.filter(row => row.modality === 'image'), video: usable.filter(row => row.modality === 'video') },
    myModels: value.models.map(model => ({ ...model, localOnly: true })),
    revision: value.revision };
}
function get() { return publicCatalog(); }
function save(input = {}) {
  if (!record(input)) invalid('配置格式');
  for (const name of ['providers', 'models']) {
    if (Object.hasOwn(input, name) && !Array.isArray(input[name])) invalid(name === 'providers' ? '服务列表' : '模型列表');
  }
  if (Object.hasOwn(input, 'keys') && !record(input.keys)) invalid('凭据格式');
  const current = readRaw();
  if (input.expectedRevision != null && input.expectedRevision !== current.revision) throw Error('本地模型配置已变化，请刷新后重试');
  if (current.revision === Number.MAX_SAFE_INTEGER) invalid('配置版本');
  const providers = Object.hasOwn(input, 'providers') ? input.providers : current.providers;
  const providerIds = new Set(providers.map(provider => text(provider?.id, 48).toLowerCase()));
  const mergedKeys = { ...current.keys };
  for (const [id, value] of Object.entries(input.keys || {})) {
    if (value != null && !providerIds.has(id)) invalid('凭据所属服务');
    if (value == null) delete mergedKeys[id]; else mergedKeys[id] = value;
  }
  // Removing a provider intentionally removes its credentials and models. All
  // other invalid edits fail before the encrypted snapshot can be replaced.
  for (const id of Object.keys(mergedKeys)) if (!providerIds.has(id)) delete mergedKeys[id];
  const next = identify(normalize({
    providers,
    models: Object.hasOwn(input, 'models') ? input.models : current.models.filter(model => providerIds.has(model.providerId)),
    keys: mergedKeys,
  }), current);
  next.revision = current.revision + 1;
  write(next);
  return publicCatalog(next);
}
function resolve(modelRef) {
  const value = readRaw(), raw = text(modelRef, 2048);
  const canonical = canonicalIn(value, raw);
  // Keep the existing main-process bare-name compatibility without converting
  // managed names in the structured-reference migration API.
  const model = raw.startsWith('local:') ? value.models.find(row => row.id === canonical)
    : value.models.find(row => row.name === raw);
  if (!model) return null;
  const provider = value.providers.find(row => row.id === model.providerId);
  if (!provider || (provider.authMode !== 'none' && !value.keys[provider.id])) return null;
  return { ...model, modelRef: model.id, runtimeId: model.id, configRevision: value.revision, baseUrl: provider.baseUrl,
    key: provider.authMode === 'none' ? '' : value.keys[provider.id],
    provider: provider.id, providerName: provider.name, kind: provider.kind, authMode: provider.authMode,
    localOnly: true,
    keyFrom: 'local' };
}
async function test(providerId, modelName, fetchImpl = global.fetch) {
  const value = readRaw(), provider = value.providers.find(row => row.id === text(providerId, 48));
  if (!provider) return { ok: false, detail: '本地模型服务不存在' };
  const models = value.models.filter(row => row.providerId === provider.id);
  const key = provider.authMode === 'none' ? 'soduwork-local-no-key' : value.keys[provider.id];
  if (!key) return { ok: false, detail: '请先填写 API Key，或启用免密连接' };
  const headers = { Accept: 'application/json' };
  if (provider.authMode !== 'none') headers.Authorization = 'Bearer ' + key;
  const base = provider.baseUrl.replace(/\/+$/, '');
  const matches = latest => {
    const row = latest.providers.find(item => item.id === provider.id);
    return row && row.baseUrl === provider.baseUrl && row.authMode === provider.authMode && row.kind === provider.kind &&
      (provider.authMode === 'none' || latest.keys[provider.id] === value.keys[provider.id]);
  };
  const stale = { ok: false, detail: '本地模型连接配置已变化，请重新测试' };
  try {
    const response = await fetchImpl(base + '/models', { method: 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (response.ok) {
      const body = await response.json().catch(() => null);
      const rows = Array.isArray(body?.data) ? body.data : [];
      const discovered = [...new Set(rows.map(row => text(row?.id, 160))
        .filter(name => MODEL_ID.test(name) && name.isWellFormed()))].slice(0, 200);
      // The request may finish after an endpoint or credential edit. Its result
      // must never validate or populate the replacement connection.
      const latest = readRaw();
      if (!matches(latest)) return stale;
      let limited = false;
      if (discovered.length) {
        const existing = new Set(latest.models.filter(row => row.providerId === provider.id).map(row => row.name));
        const candidates = discovered.filter(name => !existing.has(name));
        const available = Math.max(0, 200 - latest.models.length);
        limited = candidates.length > available;
        const nextModels = latest.models.concat(candidates.slice(0, available).map(name => ({
          providerId: provider.id, name, label: name.slice(0, 80), modality: 'chat', config: {},
        })));
        if (nextModels.length !== latest.models.length) {
          if (latest.revision === Number.MAX_SAFE_INTEGER) invalid('配置版本');
          const next = identify(normalize({ providers: latest.providers, models: nextModels, keys: latest.keys }), latest);
          next.revision = latest.revision + 1;
          write(next);
        }
      }
      return { ok: true, detail: limited ? '连接通过，模型列表已达 200 项上限，部分模型未添加' :
        discovered.length ? '连接通过，已读取模型列表' : '连接通过', models: discovered };
    }
    if (![401, 403, 404, 405].includes(response.status)) return { ok: false, detail: 'HTTP ' + response.status };
  } catch (error) {
    return { ok: false, detail: '连接失败：' + String(error?.message || error).slice(0, 120) };
  }
  const selected = models.find(row => row.name === text(modelName, 160)) || models[0];
  if (!selected) return { ok: false, detail: '请先添加一个模型 ID' };
  try {
    const response = await fetchImpl(base + '/chat/completions', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: selected.name, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }), redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!matches(readRaw())) return stale;
    return response.ok ? { ok: true, detail: '连接通过，已使用「' + selected.name + '」测试' } : { ok: false, detail: 'HTTP ' + response.status };
  } catch (error) { return { ok: false, detail: '连接失败：' + String(error?.message || error).slice(0, 120) }; }
}
module.exports = { configure, get, save, resolve, test, publicCatalog, normalize, ref, canonicalReference, referenceAliases, _readRaw: readRaw };
