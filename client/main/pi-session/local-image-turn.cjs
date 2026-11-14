'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const media = require('./media-artifacts');
const MAX_BYTES = 32 * 1024 * 1024, JSON_LIMIT = Math.ceil(MAX_BYTES / 3) * 4 + 1024 * 1024;
const INDEX = '.soduwork-media-index.json';

async function bounded(response, limit, signal) {
  signal.throwIfAborted();
  if (!response?.ok || response.redirected || Number(response.headers?.get('content-length') || 0) > limit) throw Error('Invalid image response');
  const chunks = []; let total = 0;
  const reader = response.body?.getReader?.();
  if (!reader) throw Error('Image response is not streamable');
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read(); if (done) break;
      total += value.byteLength;
      if (total > limit) throw Error('Image response exceeds the local limit');
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  if (!total) throw Error('Image response is empty');
  return Buffer.concat(chunks, total);
}
function outputDirectory(cwd) {
  if (!path.isAbsolute(String(cwd || ''))) throw Error('Image workspace is unavailable');
  const root = path.resolve(cwd), stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('Unsafe image workspace');
  const output = path.join(root, 'outputs');
  try { fs.mkdirSync(output, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const dir = fs.lstatSync(output);
  if (!dir.isDirectory() || dir.isSymbolicLink() || path.dirname(fs.realpathSync(output)) !== fs.realpathSync(root)) throw Error('Unsafe image output directory');
  const index = path.join(output, INDEX);
  try {
    const record = fs.lstatSync(index);
    if (!record.isFile() || record.isSymbolicLink() || record.size > 128 * 1024) throw Error('Unsafe image index');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return output;
}
function save(cwd, bytes, id) {
  if (!bytes.length || bytes.length > MAX_BYTES) throw Error('Invalid image size');
  const type = ['image/png', 'image/jpeg', 'image/webp'].find(value => media._videoSignature(bytes.subarray(0, 16), value));
  if (!type) throw Error('Image type is unsupported');
  const output = outputDirectory(cwd), name = 'image-' + id + ({ 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' })[type];
  const target = path.join(output, name), temporaryImage = target + '.part-' + crypto.randomUUID();
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0);
  let fd = fs.openSync(temporaryImage, flags, 0o600), ready = false, published = false;
  try {
    fs.writeFileSync(fd, bytes); fs.fsyncSync(fd);
    fs.closeSync(fd); fd = null;
    outputDirectory(cwd);
    // An exclusive hard link publishes complete bytes without replacing an existing path.
    fs.linkSync(temporaryImage, target); published = true;
    fs.unlinkSync(temporaryImage);
    if (fs.realpathSync(target) !== path.join(fs.realpathSync(output), name)) throw Error('Unsafe image output path');
    let index = {};
    const indexFile = path.join(output, INDEX);
    try {
      const handle = fs.openSync(indexFile, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      try { index = JSON.parse(fs.readFileSync(handle, 'utf8')); } finally { fs.closeSync(handle); }
      if (!index || typeof index !== 'object' || Array.isArray(index)) throw Error('Invalid image index');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    index['local-image:' + id] = name;
    const temporary = path.join(output, INDEX + '.' + crypto.randomUUID() + '.tmp');
    try {
      fs.writeFileSync(temporary, JSON.stringify(Object.fromEntries(Object.entries(index).slice(-500))), { flag: 'wx', mode: 0o600 });
      outputDirectory(cwd);
      fs.renameSync(temporary, indexFile);
    } finally { fs.rmSync(temporary, { force: true }); }
    ready = true;
    return { path: target, relative: 'outputs/' + name, name, size: bytes.length, at: Date.now(),
      primary: true, changedInTurn: true, artifactId: 'local-image-' + id, mimeType: type };
  } finally {
    if (fd !== null) fs.closeSync(fd);
    fs.rmSync(temporaryImage, { force: true });
    if (published && !ready) fs.rmSync(target, { force: true });
  }
}
async function generate({ handle, selected, text, submissionId, signal, push, emit, fetchImpl = global.fetch }) {
  const id = crypto.randomUUID(), generationId = submissionId || id;
  const event = { toolCallId: 'image-' + generationId, toolName: 'generate_image', localOnly: true,
    args: { prompt: text, generationId } };
  push({ type: 'agent_start' });
  handle.appendTaskMessage('user', text, [], '', 'image-user:' + generationId);
  handle.appendTaskTool({ ...event, type: 'tool_execution_start' }, ''); emit({ kind: 'image-generation' });
  try {
    const local = await require('./image-model').resolveLocal(selected);
    if (!local) throw Error('Local image selection is unavailable');
    outputDirectory(handle.cwd);
    const base = new URL(local.baseUrl);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw Error('Invalid image provider');
    const combined = AbortSignal.any([signal, AbortSignal.timeout(250000)]);
    const response = await fetchImpl(local.baseUrl.replace(/\/+$/, '') + '/images/generations', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(local.key ? { Authorization: 'Bearer ' + local.key } : {}) },
      body: JSON.stringify({ model: local.name, prompt: text, n: 1 }), redirect: 'error', signal: combined,
    });
    const payload = JSON.parse((await bounded(response, JSON_LIMIT, combined)).toString('utf8'));
    const result = payload?.data?.[0]; let bytes;
    if (typeof result?.b64_json === 'string') {
      const raw = result.b64_json;
      if (raw.length > Math.ceil(MAX_BYTES / 3) * 4 || raw.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(raw)) throw Error('Invalid image encoding');
      bytes = Buffer.from(raw, 'base64');
      if (bytes.toString('base64') !== raw) throw Error('Invalid image encoding');
    } else if (typeof result?.url === 'string') {
      const url = new URL(result.url, base);
      // The configured provider is the only network destination authorized by this turn.
      if (url.origin !== base.origin || url.username || url.password || url.hash) throw Error('Untrusted image result URL');
      const download = await fetchImpl(url.href, { method: 'GET', redirect: 'error', signal: combined });
      bytes = await bounded(download, MAX_BYTES, combined);
    } else throw Error('Image data is missing');
    combined.throwIfAborted();
    const file = save(handle.cwd, bytes, id);
    handle.appendTaskTool({ ...event, type: 'tool_execution_end', isError: false,
      result: { content: [{ type: 'text', text: JSON.stringify({ file: file.relative }) }] } }, '');
    handle.appendTaskMessage('assistant', '图片已生成。\n\n[查看图片](' + file.relative + ')', [], '', 'image-result:' + generationId);
    emit({ kind: 'settled', mediaArtifact: file });
    return { ok: true, artifact: file };
  } catch (_) {
    const cancelled = signal.aborted;
    const reason = cancelled ? '已停止等待本地图片生成，请先检查本机成果后再决定是否重新生成。'
      : '本地图片生成未完成，请检查本机模型设置和输出目录后重试；服务端可能已处理请求。';
    handle.appendTaskTool({ ...event, type: 'tool_execution_end', isError: true, result: { content: [{ type: 'text', text: reason }] } }, '');
    handle.appendTaskMessage('assistant', reason, [], '', 'image-error:' + generationId);
    return cancelled ? { ok: true, cancelled: true } : { ok: false, reason, retrySafe: false };
  } finally { push({ type: 'agent_settled' }); emit({ kind: 'settled' }); }
}
module.exports = { generate, MAX_BYTES, JSON_LIMIT };
