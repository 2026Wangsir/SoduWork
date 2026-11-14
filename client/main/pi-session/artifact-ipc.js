'use strict';
// Session-scoped artifact and attachment access, shared by every runtime.
const path = require('path');
const fs = require('fs');
const attachments = require('./attachments');
const attachmentContract = require('./attachment-contract');
const artifactRuntime = require('../conversation/artifact-runtime');
const shareArchive = require('../conversation/zip-archive');
const mateMessageIpc = require('./mate-message-ipc');
const { readOutputText } = require('./read-output-text.cjs');
const { shell, nativeImage, dialog } = require('electron');
const imageClipboard = require('../conversation/image-clipboard');

function install({ app, ipcMain, BrowserWindow, session, workDir, resolveSession = async handle => handle }) {
  require('./tool-detail-ipc').install({ ipcMain, session, BrowserWindow });
  require('../conversation/delivery-package-ipc').install({ ipcMain, session, BrowserWindow, dialog, resolveSession });
async function _attachmentTarget(handle, ref, token) {
  const source = attachmentContract.previewPath(token);
  if (!source || !handle) return '';
  const managed = path.join(workDir(app), 'temp', String(ref || ''), '.soduwork-inputs');
  const candidates = path.isAbsolute(source)
    ? [path.resolve(source)]
    : [path.resolve(handle.cwd, source), path.resolve(managed, source)];
  for (const target of candidates) {
    let root = [handle.cwd, managed].find(folder => attachments.inside(folder, target));
    let historical = false;
    if (!root && path.isAbsolute(source)) {
      // Opening history allocates a new runtime ref. Older inputs remain under
      // temp/<original-ref>/.soduwork-inputs: authorize only the exact attachment
      // present in this handle's user-message snapshot, never the whole folder.
      const relative = path.relative(path.join(workDir(app), 'temp'), target).split(path.sep);
      const recorded = relative.length >= 3 && relative[0] !== '..' && !path.isAbsolute(relative[0]) &&
        relative[1] === '.soduwork-inputs' && handle.snapshot?.().messages?.some(message =>
          message.role === 'user' && message.attachments?.some(item =>
            attachmentContract.previewPath(item.previewRef) === source));
      if (recorded) { root = path.join(workDir(app), 'temp', relative[0], '.soduwork-inputs'); historical = true; }
    }
    if (!root) continue;
    // Check the real location too: a link inside an allowed folder must not
    // turn a session-scoped image reference into access to an unrelated file.
    const [realRoot, realTarget] = await Promise.all([
      fs.promises.realpath(root), fs.promises.realpath(target),
    ]);
    if (historical) {
      const temp = path.join(workDir(app), 'temp');
      const expected = path.join(await fs.promises.realpath(temp), path.relative(temp, root));
      if (path.relative(expected, realRoot)) continue;
    }
    if (attachments.inside(realRoot, realTarget)) return realTarget;
  }
  return '';
}

async function _attachmentImage(handle, ref, token) {
  const target = await _attachmentTarget(handle, ref, token);
  if (!target) throw new Error('这张图片不属于当前会话');
  return attachments.readImage(target);
}


  ipcMain.handle('pi-session-outputs', async (event, ref) => { const s = session.get(ref); if (!s) return { ok: false, reason: '\u4f1a\u8bdd\u4e0d\u5728\u4e86' }; try { const { got, delivery, items } = await artifactRuntime.snapshotAsync(await resolveSession(s)); const artifacts = artifactRuntime.decorate(ref, { items }); return { ok: true, files: got.files || [], deliverables: delivery.items || [], artifacts, delivery, cloudOutputs: got.cloudOutputs, truncated: Boolean(got.truncated) }; } catch (e) { return { ok: false, reason: String((e && e.message) || e) }; } });

  ipcMain.handle('mate-message-pick-folder', mateMessageIpc.createPickFolderHandler({ BrowserWindow, dialog, shareArchive }));
  ipcMain.handle('pi-session-artifact-action', async (event, ref, artifactId, action) => {
    const s = session.get(ref);
    if (!s) return { ok: false, reason: '会话不在了' };
    try {
      return await artifactRuntime.action(await resolveSession(s), ref, artifactId, action, { shell, nativeImage });
    } catch (error) {
      return { ok: false, reason: String((error && error.message) || error) };
    }
  });

  /*
   * Load input images on demand through opaque references and revalidate session boundaries
   * on every read. Limit thumbnails to 192px to avoid repeated large IPC transfers.
   */
  ipcMain.handle('pi-session-attachment-image', async (event, ref, token, mode) => {
    const s = session.get(ref);
    if (!s) return { ok: false, reason: '会话不在了' };
    try {
      const image = await _attachmentImage(s, ref, token);
      if (mode === 'thumbnail') {
        const source = nativeImage.createFromBuffer(image.data);
        if (source.isEmpty()) return { ok: false, reason: '图片内容无法识别' };
        const thumb = source.resize({ width: 192, quality: 'good' }).toPNG();
        return { ok: true, mimeType: 'image/png', size: image.size, data: thumb.toString('base64') };
      }
      return { ok: true, mimeType: image.mimeType, size: image.size, data: image.data.toString('base64') };
    } catch (error) {
      return { ok: false, reason: String((error && error.message) || error) };
    }
  });

  // Unsaved composer images have no session reference yet. Only write bounded,
  // decoded PNG bytes supplied by the trusted desktop UI; never read a path.
  ipcMain.handle('conversation-copy-image', async (event, pngData) => {
    try {
      await imageClipboard.writePng(pngData);
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: String((error && error.message) || error) };
    }
  });

  ipcMain.handle('pi-session-copy-attachment-image', async (event, ref, token, pngData) => {
    const s = session.get(ref);
    if (!s) return { ok: false, reason: '会话不在了' };
    try {
      const image = await _attachmentImage(s, ref, token);
      const value = nativeImage.createFromBuffer(image.data);
      if (value.isEmpty() && /^image\/(webp|gif)$/.test(image.mimeType)) {
        // The renderer may supply a PNG decoded by Chromium, but only after
        // rechecking the original attachment's session scope above. No paths,
        // URLs, HTML, or arbitrary clipboard formats are accepted here.
        if (pngData == null) return { ok: false, code: 'IMAGE_CONVERSION_REQUIRED',
          reason: '当前图片需要转换后复制' };
        await imageClipboard.writePng(pngData);
      } else {
        await imageClipboard.writeImage(value);
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: String((error && error.message) || error) };
    }
  });

  /*
   * Open outputs with the system application only within this conversation's workspace.
   */
  ipcMain.handle('pi-session-open-output', async (event, ref, target) => {
    const original = session.get(ref);
    let s;
    try { s = original && await resolveSession(original); }
    catch (error) { return { ok: false, reason: String(error.message || error) }; }
    if (!s) return { ok: false, reason: '会话不在了' };
    const outputs = require('./outputs');
    if (!outputs.inside(s.cwd, target)) return { ok: false, reason: '这个文件不在这条对话的工作目录里' };
    const err = await shell.openPath(String(target));
    return err ? { ok: false, reason: err } : { ok: true };
  });

  /*
   * Open outputs in isolated native preview windows for explicit or legacy entry points.
   * Enforce workspace paths and disable preload, Node access, and shared authentication for
   * model-generated pages.
   */
  ipcMain.handle('pi-session-open-in-app', async (event, ref, target) => {
    const original = session.get(ref);
    let s;
    try { s = original && await resolveSession(original); }
    catch (error) { return { ok: false, reason: String(error.message || error) }; }
    if (!s) return { ok: false, reason: '会话不在了' };
    const outputs = require('./outputs');
    if (!outputs.inside(s.cwd, target)) return { ok: false, reason: '这个文件不在这条对话的工作目录里' };
    const { BrowserWindow } = require('electron');
    const name = path.basename(String(target));
    const win = new BrowserWindow({
      width: 1040, height: 760, minWidth: 480, minHeight: 360,
      title: 'SoduWork · ' + name, backgroundColor: '#ffffff', show: false,
      frame: true, skipTaskbar: false, alwaysOnTop: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    win.setMenuBarVisibility(false);
    // Preserve the output-specific native title against document.title changes.
    win.webContents.on('page-title-updated', (e) => { e.preventDefault(); });
    // Validate same-window navigation against workspace boundaries to prevent generated links from reading unrelated local files.
    win.webContents.on('will-navigate', (e, url) => {
      const nav = outputs.navigation(s.cwd, url);
      if (nav.kind === 'inside') return;
      e.preventDefault();
      if (nav.kind === 'external') shell.openExternal(nav.url).catch(() => {});
    });
    // Open external links in the system browser while retaining workspace-local page navigation.
    win.webContents.setWindowOpenHandler(({ url }) => {
      const nav = outputs.navigation(s.cwd, url);
      if (nav.kind === 'external') shell.openExternal(nav.url).catch(() => {});
      else if (nav.kind === 'inside') setImmediate(() => win.loadURL(nav.url));
      return { action: 'deny' };
    });
    win.once('ready-to-show', () => win.show());
    win.loadFile(String(target));
    return { ok: true };
  });

  /*
   * Read preview text only from this conversation's workspace with a bounded size.
   */
  ipcMain.handle('pi-session-read-output', async (event, ref, target) => {
    const original = session.get(ref);
    let s;
    try { s = original && await resolveSession(original); }
    catch (error) { return { ok: false, reason: String(error.message || error) }; }
    if (!s) return { ok: false, reason: '会话不在了' };
    const outputs = require('./outputs');
    if (!outputs.inside(s.cwd, target)) return { ok: false, reason: '这个文件不在这条对话的工作目录里' };
    try {
      return await readOutputText(target);
    } catch (e) {
      return { ok: false, reason: String((e && e.message) || e) };
    }
  });

  // The native code editor can save only an existing text file inside the
  // current conversation workspace.  Keep this boundary in the main process;
  // the renderer never receives an arbitrary filesystem write primitive.
  ipcMain.handle('pi-session-write-output', async (event, ref, target, text) => {
    const original = session.get(ref);
    let s;
    try { s = original && await resolveSession(original); }
    catch (error) { return { ok: false, reason: String(error.message || error) }; }
    if (!s) return { ok: false, reason: '会话不在了' };
    const outputs = require('./outputs');
    const rawTarget = String(target || '');
    const candidate = path.isAbsolute(rawTarget) ? path.resolve(rawTarget) : path.resolve(s.cwd, rawTarget);
    if (!outputs.inside(s.cwd, candidate)) return { ok: false, reason: '这个文件不在当前会话工作目录里' };
    const value = String(text == null ? '' : text);
    const CAP = 4 * 1024 * 1024;
    if (Buffer.byteLength(value, 'utf8') > CAP) return { ok: false, reason: '代码文件超过 4 MB，暂不支持在线保存' };
    try {
      const st = fs.statSync(candidate);
      if (!st.isFile()) return { ok: false, reason: '只能保存文件，不能覆盖目录' };
      fs.writeFileSync(candidate, value, 'utf8');
      return { ok: true, size: Buffer.byteLength(value, 'utf8'), at: Date.now() };
    } catch (error) {
      return { ok: false, reason: String((error && error.message) || error) };
    }
  });

  // The library upload action needs the original bytes (including images,
  // office files, archives, and generated HTML), while the preview endpoint
  // above intentionally truncates text. Keep the same conversation-boundary
  // check and return only a typed byte payload to the renderer.
  ipcMain.handle('pi-session-read-output-binary', async (event, ref, target) => {
    try {
      const handle = session.get(ref);
      return require('../library-output.cjs').readAsync(handle && await resolveSession(handle), target);
    } catch (error) { return { ok: false, reason: String(error.message || error) }; }
  });

  /* Reveal the output in the file manager for external editing. */
  ipcMain.handle('pi-session-reveal-output', async (event, ref, target) => {
    const original = session.get(ref);
    let s;
    try { s = original && await resolveSession(original); }
    catch (error) { return { ok: false, reason: String(error.message || error) }; }
    if (!s) return { ok: false, reason: '会话不在了' };
    const outputs = require('./outputs');
    if (!outputs.inside(s.cwd, target)) return { ok: false, reason: '这个文件不在这条对话的工作目录里' };
    shell.showItemInFolder(String(target));
    return { ok: true };
  });

  /* Offer one Open folder action in the delivery header rather than repeating it for every file. */
  ipcMain.handle('pi-session-open-output-folder', async (event, ref) => {
    const original = session.get(ref);
    let s;
    try { s = original && await resolveSession(original); }
    catch (error) { return { ok: false, reason: String(error.message || error) }; }
    if (!s) return { ok: false, reason: '会话不在了' };
    try {
      const st = fs.statSync(s.cwd);
      if (!st.isDirectory()) return { ok: false, reason: '这条会话的工作目录已不存在' };
      const err = await shell.openPath(String(s.cwd));
      return err ? { ok: false, reason: err } : { ok: true };
    } catch (e) { return { ok: false, reason: String((e && e.message) || e) }; }
  });

}

module.exports = { install };
