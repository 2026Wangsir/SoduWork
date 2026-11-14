'use strict';

const path = require('node:path');
const { fileURLToPath } = require('node:url');
const store = require('./local-automation-model-store.cjs');
const { accountScopeKey } = require('./device-auth-request');

function install({ app, ipcMain, safeStorage, identityOf,
  currentIdentityOf = () => require('./conversation/requirement-context').cachedIdentity(app) }) {
  store.configure({ app, safeStorage });
  function assertDesk(event) {
    const frame = event.senderFrame, url = frame?.url || event.sender.getURL();
    if ((frame && frame !== event.sender.mainFrame) || !url.startsWith('file:') ||
        path.resolve(fileURLToPath(new URL(url))) !== path.resolve(__dirname, '../desk.html')) {
      throw Error('自动化本地模型选择只允许主工作台管理');
    }
  }
  function assertScope(input, identity) {
    const owner = accountScopeKey(identity);
    if (!owner.startsWith('account:') || input?.owner !== owner ||
        String(input?.hub || '').replace(/\/+$/, '') !== String(identity?.hub || '').replace(/\/+$/, '') ||
        input?.clientId !== identity?.clientId) {
      throw Object.assign(Error('当前账号或设备已切换，请重新打开后再操作'), { code: 'STALE_TASK_SCOPE' });
    }
  }
  for (const action of ['get', 'set', 'remove']) {
    ipcMain.handle('automation-models-' + action, async (event, input) => {
      assertDesk(event);
      const captured = { ...(input || {}) };
      // A refreshed token may complete after a Hub/account switch. Recheck
      // the active trusted identity immediately before the synchronous store.
      const identity = await identityOf(app);
      assertDesk(event);
      assertScope(captured, identity);
      assertScope(captured, currentIdentityOf());
      return store[action](captured);
    });
  }
}

module.exports = { install };
