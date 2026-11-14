'use strict';

/* A deliverable is not a path-shaped string.  It is a typed, versioned object
   whose actions are resolved again in the trusted main process.  This module
   is the single authority for opening files and running static web results. */
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const outputs = require('../pi-session/outputs');
const deliveryContract = require('./delivery-contract');
const shareArchive = require('./zip-archive');
const pluginDrafts = require('../pi-session/plugin-draft-candidates');
const screenshotEvidence = require('./screenshot-evidence');
const artifactTitle = require('./artifact-title');
const selection = require('./delivery-selection');

const RECORDS = new Map();
const PENDING = new Map();
const IDLE_MS = 20 * 60 * 1000;
const READ_CAP = 2 * 1024 * 1024;
const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.ogv': 'video/ogg',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
});

function keyOf(ref, artifactId) {
  return String(ref || '') + ':' + String(artifactId || '');
}

function safeText(value, limit) {
  return String(value == null ? '' : value).trim().slice(0, limit);
}

function within(root, target, allowRoot) {
  const rel = path.relative(root, target);
  return (allowRoot && !rel) || Boolean(rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

function recoveredFiles(session) {
  return require('./saved-report-artifacts').recover(session.cwd,
    typeof session.snapshot === 'function' ? session.snapshot()?.tools : []);
}

async function snapshotAsync(session) {
  if (!session) return null;
  const cwd = session.cwd, sessionId = session.sessionId, owner = session.deliveryOwner;
  const asynchronous = session.outputSnapshotAsync, synchronous = session.outputSnapshot, list = session.outputs;
  const recovered = recoveredFiles(session);
  const scanned = typeof asynchronous === 'function'
    ? await asynchronous.call(session)
    : typeof synchronous === 'function' ? await synchronous.call(session)
      : { files: typeof list === 'function' ? await list.call(session) : [] };
  if (session.cwd !== cwd || session.sessionId !== sessionId || session.deliveryOwner !== owner ||
      session.outputSnapshotAsync !== asynchronous || session.outputSnapshot !== synchronous || session.outputs !== list)
    throw Error('会话成果来源已变化，请刷新后重试');
  return sessionSnapshot(session, scanned, recovered);
}

function sessionSnapshot(session, scanned, recovered) {
  if (!session) return null;
  const savedReports = require('./saved-report-artifacts');
  if (!recovered) recovered = recoveredFiles(session);
  if (!scanned) scanned = typeof session.outputSnapshot === 'function'
    ? session.outputSnapshot() : { files: typeof session.outputs === 'function' ? session.outputs() : [] };
  const state = session.snapshot?.() || {};
  const captures = screenshotEvidence.toolPaths(session.cwd, state.tools || []);
  const declared = deliveryContract.readManifest(session.cwd);
  const processFiles = new Set((Array.isArray(declared?.processFiles) ? declared.processFiles : [])
    .filter(value => typeof value === 'string').map(value => path.resolve(session.cwd, value)));
  const captureKey = file => process.platform === 'win32' ? path.resolve(file.path || '').toLowerCase() : path.resolve(file.path || '');
  const metadata = file => artifactTitle.decorate(session.cwd, captures.has(captureKey(file)) ||
    processFiles.has(path.resolve(file.path || '')) || selection.processRoles.has(file.role) ||
    deliveryContract._kindOf(file.path) === 'image' && deliveryContract._isProcess(file)
    ? { ...file, processEvidence: true, evidenceSource: captures.has(captureKey(file)) ? 'capture' : 'manifest', primary: false } : file);
  const got = { ...scanned, files: savedReports.currentFiles(session.cwd, scanned?.files, recovered).map(metadata) };
  const originalDelivery = got.delivery || { source: 'legacy', items: got.files };
  const request = selection.turn(state).request;
  const allowCaptures = selection.requestsCaptures(request) || !request && originalDelivery.source === 'manifest';
  const delivery = selection.select(session.cwd, { ...originalDelivery,
    items: originalDelivery.presentation === 'summary' ? [] : savedReports.currentFiles(session.cwd, originalDelivery.items, recovered)
      .map(file => allowCaptures && !processFiles.has(path.resolve(file.path || '')) && !selection.processRoles.has(file.role)
        ? artifactTitle.decorate(session.cwd, file) : metadata(file))
      .filter(file => !file.processEvidence) }, state);
  if (got.delivery) got.delivery = delivery;
  // A primary delivery list is a shortlist, not the set of files a user may
  // revisit. Keep scanned documents/websites/media addressable across turns,
  // without promoting supporting files or changing delivery acceptance.
  const items = [...(delivery.items || [])].filter(file =>
    pluginDrafts.withinSnapshot(file, got) || !pluginDrafts.describe(session.cwd, file));
  const indexed = new Set(items.filter(item => item.path && item.artifactId).map(item => path.resolve(item.path)));
  const screenshots = screenshotEvidence.collect(session.cwd, {
    since: got.since ?? session.outputSince ?? session.startedAt, turnSince: got.turnSince,
  });
  for (const file of [...(got && got.files || []), ...recovered, ...screenshots]) {
    const kind = deliveryContract._kindOf(file.path);
    if (!file.path || !kind || indexed.has(path.resolve(file.path))) continue;
    const relative = path.relative(session.cwd, file.path).split(path.sep).join('/');
    const item = { ...file, relative, artifactId: deliveryContract._artifactId(kind, relative),
      kind, primary: false, processEvidence: file.processEvidence === true || deliveryContract._isProcess(file),
      preview: ['website', 'video', 'image', 'pdf'].includes(kind),
      actions: ['website', 'video'].includes(kind) ? ['preview', 'open', 'reveal'] : ['open', 'reveal'] };
    const legacy = items.findIndex(row => row.path === file.path && !row.artifactId);
    if (legacy >= 0) items[legacy] = item; else items.push(item);
    indexed.add(path.resolve(file.path));
  }
  for (const file of pluginDrafts.collect(session.cwd, got)) {
    const existing = items.findIndex(row => row.path && path.resolve(row.path) === file.path);
    const previous = existing >= 0 ? items[existing] : null;
    const item = { ...file, ...previous, pluginDraft: true, pluginPackage: file.pluginPackage, skillPackage: file.skillPackage === true,
      pluginName: file.pluginName, pluginVersion: file.pluginVersion,
      // Identity/superseded come from this scan's merge, never from the row the
      // earlier snapshot cached here — a rename must move the identity forward.
      pluginIdentity: file.pluginIdentity || '', pluginSuperseded: file.pluginSuperseded === true,
      pluginRevision: file.pluginRevision, pluginRevisionAt: file.pluginRevisionAt,
      artifactId: previous && previous.artifactId || deliveryContract._artifactId('file', file.relative),
      kind: 'file', primary: previous ? previous.primary !== false : false,
      preview: false, actions: ['open', 'reveal'] };
    if (existing >= 0) items[existing] = item; else items.push(item);
  }
  // Delivery consumers need the same installation metadata as the artifact index.
  const indexedByPath = new Map(items.filter(item => item.path).map(item => [path.resolve(item.path), item]));
  delivery.items = (delivery.items || []).map(item => item.path && indexedByPath.get(path.resolve(item.path)) || item);
  return { got: got || {}, delivery, items };
}

function resolve(session, artifactId) {
  return resolveSnapshot(session, artifactId, sessionSnapshot(session));
}

async function resolveAsync(session, artifactId) {
  return resolveSnapshot(session, artifactId, await snapshotAsync(session));
}

function resolveSnapshot(session, artifactId, snapshot) {
  if (!snapshot) return { ok: false, reason: '这条会话已经结束' };
  const item = snapshot.items.find((row) =>
    String(row && row.artifactId || '') === String(artifactId || ''));
  if (!item) return { ok: false, reason: '这份成果已经更新，请刷新后重试' };
  const candidatePath = path.resolve(String(item.path || ''));
  if (!outputs.inside(session.cwd, candidatePath)) {
    return { ok: false, reason: '这份成果不在当前会话工作区内' };
  }
  let target;
  let stat;
  try {
    // Match the native canonical paths used by outputs.inside and asynchronous
    // packaging; the JS realpath implementation can retain Windows 8.3 aliases.
    const realpath = fs.realpathSync.native || fs.realpathSync;
    const root = realpath(String(session.cwd || ''));
    target = realpath(candidatePath);
    if (!within(root, target, false)) {
      return { ok: false, reason: '这份成果的真实路径超出了当前会话工作区' };
    }
    stat = fs.statSync(target);
  } catch (_) {
    return { ok: false, reason: '成果文件已经不存在' };
  }
  if (!stat.isFile()) return { ok: false, reason: '成果不是可打开的文件' };
  return { ok: true, item, path: target, stat, snapshot };
}

function publicArtifact(ref, item) {
  const id = String(item && item.artifactId || '');
  const record = RECORDS.get(keyOf(ref, id));
  const sameVersion = Boolean(record && Number(record.itemAt) === Number(item && item.at || 0));
  return {
    artifactId: id,
    kind: safeText(item && item.kind || 'file', 32),
    name: safeText(item && item.name, 240),
    title: safeText(item && item.title || item && item.name, 240),
    summary: safeText(item && item.summary, 500),
    relative: safeText(item && item.relative, 600),
    size: Number(item && item.size || 0),
    at: Number(item && item.at || 0),
    preview: Boolean(item && item.preview),
    primary: item ? item.primary !== false : true,
    processEvidence: Boolean(item && item.processEvidence),
    changedInTurn: Boolean(item && item.changedInTurn),
    ...(item && item.pluginDraft ? { pluginDraft: true, pluginPackage: Boolean(item.pluginPackage), skillPackage: Boolean(item.skillPackage),
      pluginName: safeText(item.pluginName, 120), pluginVersion: safeText(item.pluginVersion, 40),
      pluginIdentity: safeText(item.pluginIdentity, 160), pluginSuperseded: item.pluginSuperseded === true,
      pluginRevision: safeText(item.pluginRevision, 64), pluginRevisionAt: Number(item.pluginRevisionAt || item.at || 0) } : {}),
    actions: Array.isArray(item && item.actions) ? item.actions.slice(0, 6) : ['open', 'reveal'],
    runtime: item && item.kind === 'website' ? {
      type: 'static',
      status: sameVersion ? 'running' : 'stopped',
      autoStart: true,
    } : null,
  };
}

function decorate(ref, delivery) {
  return (delivery && Array.isArray(delivery.items) ? delivery.items : [])
    .map((item) => publicArtifact(ref, item));
}

function sendError(response, code, message) {
  response.writeHead(code, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(message);
}

function candidate(record, rawPath) {
  let decoded = '';
  try { decoded = decodeURIComponent(String(rawPath || '/')); } catch (_) { return null; }
  if (decoded.includes('\0')) return null;
  const clean = decoded.replace(/\\/g, '/').replace(/^\/+/, '');
  let target = clean ? path.resolve(record.root, clean) : record.entry;
  if (!within(record.root, target, true)) return null;
  try {
    let stat = fs.statSync(target);
    if (stat.isDirectory()) {
      target = path.join(target, 'index.html');
      stat = fs.statSync(target);
    }
    if (!stat.isFile()) throw new Error('not a file');
    const real = fs.realpathSync(target);
    if (!within(record.root, real, false)) return null;
    return { path: real, stat };
  } catch (_) {
    /* Extensionless routes are application routes, not missing assets. */
    if (!path.posix.extname(clean)) {
      try {
        const real = fs.realpathSync(record.entry), stat = fs.statSync(real);
        if (stat.isFile() && within(record.root, real, false)) return { path: real, stat, applicationRoute: true };
      } catch (_) { /* Entry was removed or replaced while previewing. */ }
    }
    return null;
  }
}

function serve(record, request, response) {
  record.lastUsed = Date.now();
  if (!['GET', 'HEAD'].includes(String(request.method || 'GET').toUpperCase())) {
    response.writeHead(405, { Allow: 'GET, HEAD' });
    response.end();
    return;
  }
  let url;
  try { url = new URL(request.url || '/', 'http://127.0.0.1'); }
  catch (_) { sendError(response, 400, 'Bad request'); return; }
  const found = candidate(record, url.pathname);
  if (!found) { sendError(response, 404, 'Not found'); return; }
  let start = 0, end = Math.max(0, found.stat.size - 1), status = 200;
  const range = String(request.headers.range || '');
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2]) || found.stat.size <= 0) {
      response.writeHead(416, { 'Content-Range': 'bytes */' + found.stat.size, 'Accept-Ranges': 'bytes' }); response.end(); return;
    }
    if (!match[1]) start = Math.max(0, found.stat.size - Math.max(1, Number(match[2]) || 0));
    else start = Number(match[1]);
    end = match[2] ? Math.min(found.stat.size - 1, Number(match[2])) : found.stat.size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= found.stat.size) {
      response.writeHead(416, { 'Content-Range': 'bytes */' + found.stat.size, 'Accept-Ranges': 'bytes' }); response.end(); return;
    }
    status = 206;
  }
  const headers = {
    'Content-Type': MIME[path.extname(found.path).toLowerCase()] || 'application/octet-stream',
    'Content-Length': String(found.stat.size ? end - start + 1 : 0), 'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer', 'Cross-Origin-Opener-Policy': 'same-origin',
  };
  if (status === 206) headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + found.stat.size;
  response.writeHead(status, headers);
  if (String(request.method).toUpperCase() === 'HEAD') { response.end(); return; }
  const stream = fs.createReadStream(found.path, found.stat.size ? { start, end } : undefined);
  response.once('close', () => stream.destroy());
  stream.on('error', () => { if (!response.headersSent) sendError(response, 500, 'Read failed'); else response.destroy(); });
  stream.pipe(response);
}

function stopRecord(record) {
  if (!record) return;
  record.closed = true;
  if (RECORDS.get(record.key) === record) RECORDS.delete(record.key);
  try { record.server.close(); } catch (_) { /* already closed */ }
  record.server.closeAllConnections?.();
  for (const socket of record.sockets || []) socket.destroy();
}

function probe(url) {
  return new Promise((resolveProbe) => {
    const request = http.get(url, { method: 'HEAD' }, (response) => {
      response.resume();
      resolveProbe(response.statusCode >= 200 && response.statusCode < 400);
    });
    request.setTimeout(3000, () => request.destroy(new Error('timeout')));
    request.on('error', () => resolveProbe(false));
  });
}

async function startPreview(session, ref, artifactId, current) {
  const found = await resolveAsync(session, artifactId);
  if (!current()) return { ok: false, reason: '这条会话的预览已经关闭' };
  if (!found.ok) return found;
  if (!['website', 'video'].includes(found.item.kind)) return { ok: false, reason: '这份成果不支持流式预览' };
  return startResolvedPreview(found, ref, artifactId);
}

async function startResolvedPreview(found, ref, artifactId) {
  const key = keyOf(ref, artifactId);
  const version = found.path + ':' + found.stat.mtimeMs + ':' + found.stat.size;
  const current = RECORDS.get(key);
  if (current && current.version === version && current.server.listening) {
    current.lastUsed = Date.now();
    return { ok: true, artifactId, status: 'running', url: current.url };
  }
  if (current) stopRecord(current);
  const root = fs.realpathSync(path.dirname(found.path));
  const entry = fs.realpathSync(found.path);
  const record = {
    key, ref: String(ref || ''), artifactId: String(artifactId || ''),
    itemAt: Number(found.item.at || 0), version, root, entry,
    server: null, sockets: new Set(), url: '', lastUsed: Date.now(),
  };
  record.server = http.createServer((request, response) => serve(record, request, response));
  record.server.on('connection', socket => {
    record.sockets.add(socket);
    socket.once('close', () => record.sockets.delete(socket));
    if (record.closed) socket.destroy();
  });
  RECORDS.set(key, record);
  try {
    await new Promise((resolveListen, reject) => {
      const cleanup = () => { record.server.off('error', fail); record.server.off('close', done); };
      const done = () => { cleanup(); resolveListen(); };
      const fail = error => { cleanup(); reject(error); };
      record.server.once('error', fail);
      record.server.once('close', done);
      record.server.listen(0, '127.0.0.1', done);
    });
  } catch (error) { stopRecord(record); throw error; }
  if (record.closed) { stopRecord(record); return { ok: false, reason: '这条会话的预览已经关闭' }; }
  const address = record.server.address();
  const name = encodeURIComponent(path.basename(entry));
  record.url = 'http://127.0.0.1:' + Number(address && address.port || 0) + '/' + name;
  if (!await probe(record.url) || record.closed) {
    stopRecord(record);
    return { ok: false, reason: found.item.kind === 'video' ? '视频已经生成，但播放器暂时无法读取' : '网页成果已经生成，但启动后的健康检查没有通过' };
  }
  return { ok: true, artifactId, status: 'running', url: record.url };
}

async function preview(session, ref, artifactId) {
  const key = keyOf(ref, artifactId);
  if (PENDING.has(key)) return PENDING.get(key);
  const promise = startPreview(session, ref, artifactId, () => PENDING.get(key) === promise)
    .finally(() => { if (PENDING.get(key) === promise) PENDING.delete(key); });
  PENDING.set(key, promise);
  return promise;
}

async function previewInput(session, ref, rawTarget) {
  if (!session?.cwd) return { ok: false, reason: '这条会话已经结束' };
  const target = path.resolve(String(rawTarget || ''));
  if (!outputs.inside(session.cwd, target)) return { ok: false, reason: '只能预览当前会话工作区里的文件' };
  let entry, stat;
  try {
    const root = fs.realpathSync(session.cwd);
    entry = fs.realpathSync(target); stat = fs.statSync(entry);
    if (!within(root, entry, false) || !stat.isFile()) return { ok: false, reason: '文件的真实路径超出了当前会话工作区' };
  } catch (_) { return { ok: false, reason: '预览文件已经不存在' }; }
  const extension = path.extname(entry).toLowerCase();
  const kind = ['.html', '.htm'].includes(extension) ? 'website' : /^video\//.test(MIME[extension] || '') ? 'video' : '';
  if (!kind) return { ok: false, reason: '这个文件不支持网页流式预览' };
  // An input can be served without scanning the folder or declaring a result.
  // This private runtime key never enters the conversation's artifact index.
  const id = 'input_' + crypto.createHash('sha256').update(entry).digest('hex');
  const key = keyOf(ref, id);
  if (PENDING.has(key)) return PENDING.get(key);
  const promise = startResolvedPreview({ path: entry, stat, item: { kind, at: stat.mtimeMs } }, ref, id)
    .finally(() => { if (PENDING.get(key) === promise) PENDING.delete(key); });
  PENDING.set(key, promise);
  return promise;
}

async function action(session, ref, artifactId, rawAction, deps) {
  const actionName = String(rawAction || '');
  if (actionName === 'preview') return preview(session, ref, artifactId);
  const key = keyOf(ref, artifactId);
  if (actionName === 'status') {
    const record = RECORDS.get(key);
    return { ok: true, artifactId, status: record && record.server.listening ? 'running' : 'stopped',
      url: record && record.server.listening ? record.url : '' };
  }
  if (actionName === 'stop') {
    PENDING.delete(key);
    stopRecord(RECORDS.get(key));
    return { ok: true, artifactId, status: 'stopped' };
  }
  const found = await resolveAsync(session, artifactId);
  if (!found.ok) return found;
  if (actionName === 'location') return { ok: true, path: found.path };
  if (actionName === 'open' && found.item.kind === 'website') {
    return preview(session, ref, artifactId);
  }
  if (actionName === 'open') {
    const error = await deps.shell.openPath(found.path);
    return error ? { ok: false, reason: error } : { ok: true };
  }
  if (actionName === 'reveal') {
    deps.shell.showItemInFolder(found.path);
    return { ok: true };
  }
  if (actionName === 'share-related' && found.item.kind === 'website') {
    try {
      const archive = await shareArchive.createZipAsync(path.dirname(found.path));
      return { ok: true, name: archive.name, size: archive.size, at: Number(found.item.at || 0),
        data: archive.base64, website: true,
        preview: { status: 'zip_only', reason: 'Website assets are packaged for safe preview in SoduWork' } };
    } catch (error) {
      return { ok: false, reason: String(error && error.message || 'Website packaging failed') };
    }
  }
  if (actionName === 'share') {
    if (found.stat.size > 20 * 1024 * 1024) return { ok: false, reason: '单份成果不能超过 20 MB' };
    const data = fs.readFileSync(found.path);
    if (data.length > 20 * 1024 * 1024) return { ok: false, reason: '单份成果不能超过 20 MB' };
    return { ok: true, name: path.basename(found.path), size: data.length, at: Number(found.item.at || 0), data: data.toString('base64') };
  }
  if (actionName === 'read') {
    const fd = fs.openSync(found.path, 'r');
    let text;
    try {
      const buffer = Buffer.alloc(Math.min(found.stat.size, READ_CAP));
      text = buffer.subarray(0, fs.readSync(fd, buffer, 0, buffer.length, 0)).toString('utf8');
    } finally { fs.closeSync(fd); }
    return { ok: true, path: found.path, size: found.stat.size, tooBig: found.stat.size > READ_CAP,
      text };
  }
  if (actionName === 'image' || actionName === 'image-full') {
    const mimeType = MIME[path.extname(found.path).toLowerCase()];
    if (!/^image\/(?:png|jpeg|gif|webp|x-icon)$/.test(mimeType || ''))
      return { ok: false, reason: '这份成果不是支持内嵌预览的图片' };
    if (found.stat.size > 20 * 1024 * 1024) return { ok: false, reason: '图片超过 20 MB，请在原生应用中打开' };
    const data = fs.readFileSync(found.path);
    if (data.length > 20 * 1024 * 1024) return { ok: false, reason: '图片超过 20 MB' };
    if (actionName === 'image' && deps.nativeImage) {
      const image = deps.nativeImage.createFromBuffer(data);
      if (!image.isEmpty()) {
        const dims = image.getSize();
        if (dims.width * dims.height > 40000000) return { ok: false, reason: '图片像素过大，请在原生应用中打开' };
        const thumb = dims.width > 960 || dims.height > 640
          ? image.resize({ width: Math.max(1, Math.round(dims.width * Math.min(960 / dims.width, 640 / dims.height))), quality: 'good' }) : image;
        return { ok: true, path: found.path, mimeType: 'image/png', data: thumb.toPNG().toString('base64') };
      }
    }
    return { ok: true, path: found.path, mimeType, data: data.toString('base64') };
  }
  return { ok: false, reason: '不支持这个成果动作' };
}

function closeRef(ref) {
  const value = String(ref || '');
  for (const key of PENDING.keys()) if (key.startsWith(value + ':')) PENDING.delete(key);
  [...RECORDS.values()].filter((record) => record.ref === value).forEach(stopRecord);
}

function previewLocation(ref, rawUrl) {
  let url;
  try { url = new URL(rawUrl); } catch (_) { return ''; }
  for (const record of RECORDS.values()) {
    if (record.ref !== String(ref || '') || record.closed || !record.server.listening || !record.url) continue;
    if (url.origin !== new URL(record.url).origin) continue;
    const found = candidate(record, url.pathname);
    return found && !found.applicationRoute ? require('node:url').pathToFileURL(found.path).href + url.search + url.hash : '';
  }
  return '';
}

function closeAll() {
  [...RECORDS.values()].forEach(stopRecord);
  PENDING.clear();
}

const sweep = setInterval(() => {
  const now = Date.now();
  [...RECORDS.values()].filter((record) => now - record.lastUsed >= IDLE_MS).forEach(stopRecord);
}, 60 * 1000);
if (typeof sweep.unref === 'function') sweep.unref();

module.exports = {
  snapshot: sessionSnapshot,
  snapshotAsync,
  decorate,
  resolve,
  resolveSnapshot,
  resolveAsync,
  preview,
  previewInput,
  previewLocation,
  action,
  closeRef,
  closeAll,
  _candidate: candidate,
  _records: RECORDS,
};
