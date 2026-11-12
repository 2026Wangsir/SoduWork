'use strict';

const path = require('node:path');
const { fileURLToPath } = require('node:url');
const store = require('./local-model-store.cjs');

function install({ app, ipcMain, safeStorage }) {
  store.configure({ app, safeStorage });
  function assertDesk(event) {
    const frame = event.senderFrame, url = frame?.url || event.sender.getURL();
    if ((frame && frame !== event.sender.mainFrame) || !url.startsWith('file:') ||
        path.resolve(fileURLToPath(new URL(url))) !== path.resolve(__dirname, '../desk.html')) {
      throw Error('本地模型设置只允许主工作台管理');
    }
  }
  ipcMain.handle('local-models-get', event => { assertDesk(event); return store.get(); });
  ipcMain.handle('local-models-save', (event, input) => { assertDesk(event); return store.save(input || {}); });
  ipcMain.handle('local-models-test', (event, providerId, modelName) => { assertDesk(event); return store.test(providerId || '', modelName || ''); });
}

module.exports = { install };
