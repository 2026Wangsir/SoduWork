'use strict';

// Migrate only application-owned model metadata. Message text, tool arguments,
// usage totals and arbitrary workspace files are never rewritten.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const store = require('./local-model-store.cjs');
const opaque = value => /^local:model-[a-f0-9]{32}$/.test(value || '');
const local = value => typeof value === 'string' && value.startsWith('local:');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const failure = () => Error('本地模型记录迁移未完成，请检查系统安全存储后重试');
const metadataMarker = /"(?:name|model|modelId|modelName|modelRef|localRef)"\s*:\s*"local:/;
const checkedFiles = new Map();

function canonical(value) {
  if (!local(value) || opaque(value)) return value;
  const result = store.canonicalReference(value, { rememberMissing: true });
  if (!opaque(result)) throw Error('本地模型记录迁移未完成，请检查系统安全存储后重试');
  return result;
}
function safePath(root, file) {
  const relative = path.relative(root, file);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return false;
  const parts = relative ? relative.split(path.sep) : [];
  let current = root;
  for (let index = 0; index <= parts.length; index++) {
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || (index < parts.length && !stat.isDirectory())) return false;
    if (index === parts.length && stat.isFile() && stat.nlink > 1) return false;
    if (index < parts.length) current = path.join(current, parts[index]);
  }
  return true;
}
function read(file, root) {
  try {
    if (!safePath(root, file) || !fs.lstatSync(file).isFile()) return null;
    return fs.readFileSync(file, 'utf8');
  } catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null; throw error; }
}
function fingerprint(file, root) {
  try {
    if (!safePath(root, file)) return '';
    const stat = fs.lstatSync(file);
    return stat.isFile() ? [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':') : '';
  } catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return ''; throw error; }
}
function checked(file, root, visit) {
  const before = fingerprint(file, root);
  if (!before || checkedFiles.get(file) === before) return;
  visit(file, root);
  // Cache only successful inspections. New imports and modified native archives
  // remain discoverable without reading every old transcript for each turn.
  const after = fingerprint(file, root);
  if (after && before === after) checkedFiles.set(file, after);
  else checkedFiles.delete(file);
}
function parse(before, marker = metadataMarker) {
  try { return JSON.parse(before); }
  catch (_) {
    // Damaged unrelated records must not disable managed models. Local records
    // stay untouched and cannot be silently declared migrated.
    if (marker.test(before)) throw failure();
    return null;
  }
}
function replace(file, before, after, root) {
  if (before === after) return;
  const tmp = file + '.privacy-' + crypto.randomUUID() + '.tmp';
  try {
    if (read(file, root) !== before) throw failure();
    fs.writeFileSync(tmp, after, { mode: 0o600, flag: 'wx' });
    if (read(file, root) !== before) throw failure();
    // Require atomic publication; never create plaintext recovery copies or
    // remove the old file after a rename failure.
    fs.renameSync(tmp, file);
  } finally { try { fs.unlinkSync(tmp); } catch (_) {} }
}
function files(directory, extension, visit, root) {
  let entries;
  try {
    if (!safePath(root, directory) || !fs.lstatSync(directory).isDirectory()) return;
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return; throw error; }
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) files(target, extension, visit, root);
    else if (entry.isFile() && entry.name.endsWith(extension)) checked(target, root, visit);
  }
}
function preference(file, root) {
  const before = read(file, root);
  if (before === null) return;
  const value = parse(before);
  if (!object(value) || !local(value.name)) return;
  value.name = canonical(value.name);
  replace(file, before, JSON.stringify(value), root);
}
function models(file, root) {
  const before = read(file, root);
  if (before === null) return;
  const value = parse(before, /"localOnly"\s*:\s*true/);
  if (!object(value?.providers)) return;
  let changed = false;
  for (const provider of Object.values(value.providers || {})) {
    if (provider?.localOnly !== true) continue;
    provider.baseUrl = 'https://local-model.invalid/v1';
    provider.apiKey = 'soduwork-local-no-key';
    if (local(provider.localRef)) provider.localRef = canonical(provider.localRef);
    if (!Array.isArray(provider.models)) throw failure();
    for (const model of provider.models) {
      const ref = model.localRef || provider.localRef;
      if (!local(ref)) throw Error('Local model metadata has no private reference');
      model.id = model.localRef = canonical(ref);
      model.name = 'Local model';
    }
    changed = true;
  }
  if (changed) replace(file, before, JSON.stringify(value, null, 2), root);
}
const selection = row => row?.type === 'custom' && row.customType === 'soduwork.model.selection';
const modelFields = ['modelName', 'model', 'modelId', 'modelRef', 'localRef'];
function archive(file, root = path.dirname(file)) {
  const before = read(file, root);
  if (before === null) return;
  const lines = before.split('\n');
  let damaged = false;
  const entries = lines.map(line => {
    if (!line.trim()) return null;
    try { return JSON.parse(line); } catch (_) { damaged = true; return null; }
  });
  const hasLocal = entries.some(row => selection(row) && local(row.data?.name) ||
    row?.type === 'model_change' && local(row.modelId) || row?.type === 'message' &&
      (local(row.message?.model) || row.message?.usageLocalOnly === true));
  if (damaged) { if (hasLocal || metadataMarker.test(before)) throw failure(); return; }
  if (!hasLocal) return;
  let aliases;
  const matches = (ref, name) => opaque(ref) && (name === ref || (aliases ||= store.referenceAliases())
    .some(row => row.modelRef === ref && row.modelName === name));
  const ownedReference = name => {
    if (local(name)) return canonical(name);
    const refs = new Set((aliases ||= store.referenceAliases())
      .filter(alias => alias.modelName === name).map(alias => alias.modelRef));
    if (refs.size !== 1) throw failure();
    return [...refs][0];
  };
  const initial = entries.findIndex(selection);
  // Only SDK metadata before the first message can inherit the initial choice.
  // Managed responses preceding a later local selection stay unchanged.
  let current = initial >= 0 && !entries.slice(0, initial).some(row => row?.type === 'message')
    ? entries[initial].data?.name || '' : '';
  let changed = false;
  for (let index = 0; index < entries.length; index++) {
    const row = entries[index];
    if (!object(row)) continue;
    const original = JSON.stringify(row);
    if (selection(row)) {
      current = row.data?.name || '';
      if (local(current)) row.data.name = current = canonical(current);
    }
    const currentRef = local(current) ? canonical(current) : '';
    if (row.type === 'custom' && row.customType === 'soduwork.context-window' && currentRef &&
        typeof row.data?.key === 'string' && row.data.key.startsWith('soduwork|')) {
      const key = row.data.key.slice('soduwork|'.length);
      if (key === currentRef || key.startsWith(currentRef + '|')) row.data.key = 'soduwork|' + currentRef;
      else if ((aliases ||= store.referenceAliases()).some(alias => alias.modelRef === currentRef &&
          (key === alias.modelName || key.startsWith(alias.modelName + '|')))) row.data.key = 'soduwork|' + currentRef;
    }
    if (row.type === 'model_change' && (local(row.modelId) ||
        (row.provider === 'soduwork' && matches(currentRef, row.modelId)))) {
      row.modelId = local(row.modelId) ? canonical(row.modelId) : currentRef;
    }
    const message = row.type === 'message' && row.message;
    const managed = message?.usageLocalOnly === false || message?.quotaUsageToken ||
      message?.usageProvider && message?.usageLocalOnly !== true;
    if (message?.role === 'assistant' && !managed) {
      // A saved choice targets a future turn. An in-flight local response may
      // arrive after a managed choice, so its own ownership takes precedence.
      const ref = message.usageLocalOnly === true ? ownedReference(message.model)
        : local(message.model) ? canonical(message.model)
          : message.provider === 'soduwork' && matches(currentRef, message.model) ? currentRef : '';
      if (ref) {
        message.model = ref;
        if (message.responseModel) message.responseModel = ref;
        delete message.responseId;
        if (message.errorMessage) message.errorMessage = require('./pi-session/local-model-runtime-privacy.cjs')
          .safeError(message.errorMessage);
      }
    }
    if (original !== JSON.stringify(row)) { lines[index] = JSON.stringify(row); changed = true; }
  }
  if (changed) replace(file, before, lines.join('\n'), root);
}
function segments(file, root) {
  const before = read(file, root);
  if (before === null) return;
  const value = parse(before);
  if (!object(value) || value.version !== 1 || !Array.isArray(value.segments)) return;
  const original = JSON.stringify(value);
  for (const row of [value, value.active, ...value.segments]) {
    if (!object(row)) continue;
    for (const field of modelFields) if (local(row[field])) row[field] = canonical(row[field]);
  }
  // Native switching snapshots contain structured local receipts as well as
  // user text. Never infer ownership from a model name alone.
  let aliases;
  const localRows = [
    ...(Array.isArray(value.prefix?.messages) ? value.prefix.messages.map(row => [row, 'usageModel']) : []),
    ...(Array.isArray(value.prefix?.usageReceipts) ? value.prefix.usageReceipts.map(row => [row, 'model']) : []),
  ];
  for (const [row, field] of localRows) {
    if (!object(row) || row.localOnly === false || row.usageLocalOnly === false || row.quotaUsageToken) continue;
    if (typeof row[field] !== 'string' || !row[field]) continue;
    let ref = local(row[field]) ? canonical(row[field]) : '';
    if (!ref && (row.localOnly === true || row.usageLocalOnly === true)) {
      const found = new Set((aliases ||= store.referenceAliases()).filter(alias => alias.modelName === row[field])
        .map(alias => alias.modelRef));
      if (found.size === 1) ref = [...found][0];
    }
    if (!ref) continue;
    row[field] = ref;
    if (row.responseModel) row.responseModel = ref;
    delete row.responseId;
    if (row.errorMessage) row.errorMessage = require('./pi-session/local-model-runtime-privacy.cjs').safeError(row.errorMessage);
    for (const field of ['provider', 'usageProvider']) if (typeof row[field] === 'string') row[field] = 'local';
    for (const field of ['modelLabel', 'label']) if (typeof row[field] === 'string') row[field] = 'Local model';
  }
  if (original !== JSON.stringify(value)) replace(file, before, JSON.stringify(value), root);
}
function ensure(app) {
  const root = app?.getPath?.('userData');
  if (!root) return;
  try {
    checked(path.join(root, 'pi-agent', 'models.json'), root, models);
    files(path.join(root, 'conversation-models'), '.json', preference, root);
    files(path.join(root, 'conversation-runtime-segments'), '.json', segments, root);
    files(path.join(root, 'pi-agent', 'sessions'), '.jsonl', archive, root);
  } catch (_) { throw failure(); }
}
async function prepare(app) {
  const context = require('./agent-runtime/process-context').current();
  if (context?.prepareLocalModels) return context.prepareLocalModels();
  return ensure(app);
}
module.exports = { prepare, ensure, canonical, archive };
