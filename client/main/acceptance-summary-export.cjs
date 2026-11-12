'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const preferences = require('./access-control/preferences');
const { safeFilename } = require('./attachment-files');
const { readResponse } = require('./library-binary.cjs');
const { replaceFileSync } = require('./verified-file-replace.cjs');
const { fetchWithDeviceAuthRetry } = require('./device-auth-request');
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_BYTES = 4 * 1024 * 1024;

function install({ app, ipcMain, BrowserWindow, dialog, identityOf, authenticatedIdentityOf,
  ownerOf = require('./device-auth').localOwner, fetchAuthenticated = fetchWithDeviceAuthRetry }) {
  const pending = new WeakSet();
  ipcMain.handle('acceptance-summary-export', async (event, input = {}) => {
    if (!preferences.isTrusted(event)) return { ok: false, reason: '请在需求详情中导出验收摘要' };
    if (pending.has(event.sender)) return { ok: false, reason: '正在导出验收摘要，请稍候' };
    pending.add(event.sender);
    let temporary;
    try {
      if (!ID.test(input.taskId || '') || (input.artifactVersionId && !ID.test(input.artifactVersionId)) ||
          (input.requirementVersion !== undefined && (!Number.isSafeInteger(input.requirementVersion) || input.requirementVersion < 1)))
        throw Error('需求版本无效，请刷新后重试');
      const identity = { ...identityOf(app) }, owner = ownerOf(app);
      const parent = BrowserWindow.fromWebContents(event.sender), frame = event.senderFrame;
      const current = () => {
        const next = identityOf(app);
        if (!preferences.isTrusted(event) || event.sender.mainFrame !== frame || !parent || parent.isDestroyed() ||
            BrowserWindow.fromWebContents(event.sender) !== parent || !owner || ownerOf(app) !== owner ||
            !next || ['hub', 'clientId', 'secret'].some(key => next[key] !== identity[key]))
          throw Error('账号、服务或窗口已变化，请重新导出');
      };
      current();
      const authenticated = await authenticatedIdentityOf(app);
      current();
      if (!authenticated?.session || ['hub', 'clientId', 'secret'].some(key => authenticated[key] !== identity[key]))
        throw Error('请重新登录后导出');
      // Only the current Hub can supply the snapshot. Renderers cannot choose
      // an arbitrary URL, Markdown body, credentials, or destination path.
      const hub = new URL(identity.hub);
      if (!/^https?:$/.test(hub.protocol) || hub.username || hub.password) throw Error('当前服务地址无效');
      const url = new URL('/api/v1/tasks/' + encodeURIComponent(input.taskId) + '/acceptance-summary', hub);
      if (input.requirementVersion !== undefined) url.searchParams.set('requirementVersion', input.requirementVersion);
      if (input.artifactVersionId) url.searchParams.set('artifactVersionId', input.artifactVersionId);
      const response = await fetchAuthenticated({ ...authenticated }, url.href,
        { redirect: 'manual', signal: AbortSignal.timeout(30000) });
      current();
      if (response.status >= 300 && response.status < 400) throw Error('导出服务返回了无效跳转');
      const bytes = await readResponse(response, MAX_BYTES);
      current();
      let snapshot;
      try { snapshot = JSON.parse(bytes.toString('utf8')); } catch { throw Error('导出服务返回了无效内容'); }
      if (!response.ok) throw Error(typeof snapshot.detail === 'string' ? snapshot.detail : '验收摘要导出失败，请刷新后重试');
      if (typeof snapshot.markdown !== 'string' || !snapshot.markdown.trim() || !ID.test(snapshot.artifactVersionId || '') ||
          !Number.isSafeInteger(snapshot.requirementVersion) || snapshot.requirementVersion < 1 ||
          !Number.isFinite(Date.parse(snapshot.exportedAt)) ||
          (input.requirementVersion !== undefined && input.requirementVersion !== snapshot.requirementVersion) ||
          (input.artifactVersionId && input.artifactVersionId !== snapshot.artifactVersionId))
        throw Error('导出版本无效，请刷新后重试');
      const filename = safeFilename(snapshot.filename, 'acceptance-summary.md').replace(/(?:\.md)?$/i, '.md');
      const picked = await dialog.showSaveDialog(parent, require('./native-locale.cjs').dialogOptions({
        title: '导出验收摘要', defaultPath: path.join(app.getPath('downloads'), filename),
        filters: [{ name: 'Markdown', extensions: ['md'] }], properties: ['showOverwriteConfirmation'],
      }));
      if (picked.canceled || !picked.filePath) return { ok: false, canceled: true };
      current();
      temporary = picked.filePath + '.' + randomUUID() + '.tmp';
      await fs.writeFile(temporary, snapshot.markdown, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      // Account changes run on this event loop. Keep the final identity check
      // and publication synchronous so no old-account bytes commit between them.
      current();
      replaceFileSync(temporary, picked.filePath);
      return { ok: true, artifactVersionId: snapshot.artifactVersionId,
        requirementVersion: snapshot.requirementVersion, exportedAt: snapshot.exportedAt };
    } catch (error) { return { ok: false, reason: String(error.message || '验收摘要导出失败，请重试') }; }
    finally {
      if (temporary) await fs.unlink(temporary).catch(() => {});
      pending.delete(event.sender);
    }
  });
}

module.exports = { install };
