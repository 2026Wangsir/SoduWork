'use strict';

// Capture one completed turn before queuing durable, account-scoped transport.
// Review state remains owned by Hub; this payload only holds immutable bytes.
const fs = require('node:fs');
const artifacts = require('../conversation/artifact-runtime');
const packages = require('../conversation/delivery-package');
const { fetchWithDeviceAuthRetry } = require('../device-auth-request');

async function capture(handle, outcome) {
  if (!handle) return null;
  const snapshot = await artifacts.snapshotAsync(handle);
  if (snapshot?.delivery?.presentation === 'summary') return null;
  let items = (snapshot?.delivery?.items || snapshot?.items || []).filter(item =>
    item?.path && !item.processEvidence && item.primary !== false &&
    (!item.pluginDraft || item.skillPackage && /\.skill$/i.test(item.name || item.relative || item.path)));
  if (!items.length) return null;
  const options = { completedTurn: true, includeEntries: true, snapshot, turnSince: snapshot?.got?.turnSince };
  let captured;
  if (items.every(item => item.artifactId)) {
    if (snapshot.delivery?.source !== 'manifest') {
      // Legacy inference is not a declaration of a complete delivery set.
      // Test each dependency closure so unchanged older roots stay historical.
      const changed = [];
      for (const item of items) {
        const candidate = await packages.prepare(handle, [item.artifactId], options);
        if (candidate.changedInTurn !== false) { changed.push(item); captured = candidate; }
      }
      items = changed;
      if (!items.length) return null;
    }
    if (!captured || items.length > 1 || snapshot.delivery?.source === 'manifest')
      captured = await packages.prepare(handle, items.map(item => item.artifactId), options);
    if (captured.changedInTurn === false) return null;
  } else if (snapshot.delivery?.source !== 'manifest') {
    items = items.filter(item => item.changedInTurn === true);
  }
  const entries = captured?.entries?.length > 60
    ? [{name: '完整产出-' + captured.filename, bytes: captured.bytes, role: 'primary', contentType: captured.contentType}]
    : captured?.entries || items.map(item => ({...item, name: item.relative || item.name}));
  if (!entries.length) return null;
  let total = 0;
  const files = entries.map(item => {
    let bytes;
    try { bytes = item.bytes || fs.readFileSync(item.path); }
    catch { throw Error('交付文件无法读取，请修复后重试'); }
    total += bytes.length;
    if (!bytes.length || bytes.length > 50 * 1024 * 1024 || total > packages.MAX_BYTES)
      throw Error('交付文件为空或超过大小限制，请调整后重试');
    return {name: String(item.name || 'artifact'), category: item.role === 'supporting' || item.primary === false ? 'supporting' : 'primary',
      contentType: item.contentType || 'application/octet-stream', data: bytes.toString('base64')};
  });
  return {outcome: outcome === 'completed' ? 'completed' : 'incomplete',
    model: typeof handle.model === 'string' ? handle.model.slice(0, 80) : '', files};
}

async function send(identity, route, scope, payload) {
  const form = new FormData();
  for (const [key, value] of Object.entries({...scope, model: payload.model, outcome: payload.outcome})) form.append(key, value);
  for (const file of payload.files) {
    form.append('paths', file.name); form.append('categories', file.category);
    form.append('files', new Blob([Buffer.from(file.data, 'base64')], {type: file.contentType}), file.name);
  }
  const response = await fetchWithDeviceAuthRetry(identity,
    String(identity.hub).replace(/\/+$/, '') + '/api/v1' + route + '/conversation-delivery',
    {method: 'POST', redirect: 'error', body: form, signal: AbortSignal.timeout(120000)});
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw Object.assign(
    Error(typeof data.detail === 'string' ? data.detail : '交付物尚未同步，文件已保留待重试'), {status: response.status});
  return data;
}

module.exports = {capture, send};
