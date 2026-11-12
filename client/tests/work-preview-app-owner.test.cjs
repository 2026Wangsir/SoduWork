'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const { EventEmitter } = require('node:events');

// Exercise the production showDetached/createView path, including its native
// account binding. Electron surfaces are isolated doubles; no user app is opened.
test('opening an application bridge captures native ownership before attaching its composer', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-preview-owner-'));
  const app = { getPath: () => root }, views = [], windows = [], handlers = {};
  let account = 'isolated-account';
  require('../main/app-settings-store.cjs').configure({ app, ownerOf: () => account });
  const sender = new EventEmitter();
  Object.assign(sender, { id: 23, isDestroyed: () => false, send() {} });
  class View {
    constructor() {
      const wc = this.webContents = new EventEmitter(); views.push(this);
      Object.assign(wc, { session: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} },
        isDestroyed: () => !!wc.dead, getURL: () => wc.url || '', getTitle: () => '', isLoading: () => false,
        loadURL: async url => { wc.url = url; }, loadFile: async file => { wc.file = file; },
        setWindowOpenHandler() {}, send() {}, close: () => { wc.dead = true; wc.emit('destroyed'); },
        navigationHistory: { canGoBack: () => false, canGoForward: () => false } });
    }
    setBorderRadius() {} setBackgroundColor() {} setVisible() {} setBounds(value) { this.bounds = value; }
    getBounds() { return this.bounds || { x: 0, y: 0, width: 800, height: 600 }; }
  }
  class Window extends EventEmitter {
    constructor() { super(); windows.push(this); this.contentView = { addChildView() {}, removeChildView() {} }; }
    static fromWebContents() { return host; }
    isDestroyed() { return !!this.dead; } isVisible() { return true; } isMinimized() { return false; }
    getContentBounds() { return { width: 1120, height: 780 }; }
    setMenuBarVisibility() {} setBounds() {} show() {} focus() {}
    getNativeWindowHandle() { throw Error('No native decoration in fixture'); }
    destroy() { this.dead = true; this.emit('closed'); }
  }
  const host = new Window(); windows.length = 0;
  const file = path.join(__dirname, '../main/work-preview.js'), module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module, require: require('node:module').createRequire(file),
    URL, setTimeout, clearTimeout, setImmediate });
  module.exports.install({ app, WebContentsView: View, BrowserWindow: Window,
    ipcMain: { handle: (key, fn) => { handlers[key] = fn; }, on: (key, fn) => { handlers[key] = fn; } },
    session: { fromPartition: () => ({ on() {}, closeAllConnections: async () => {}, clearData: async () => {}, clearAuthCache: async () => {} }) } });
  t.after(() => { handlers['work-preview-destroy']({ sender }, ''); fs.rmSync(root, { recursive: true, force: true }); });
  const result = await handlers['work-preview-show-detached']({ sender }, {
    tabId: 'application-owner-fixture', url: 'https://application.example.test/', label: 'Fixture',
    appBridge: { appId: 'plugin:local:owner-fixture', contributionId: 'main',
      origin: 'https://application.example.test', version: 1, capabilities: [] },
  });
  assert.equal(result.ok, true, result.reason);
  assert.equal(windows.length, 1);
  const composer = views.find(view => view.webContents.file?.endsWith('app-composer-launcher.html'));
  assert.ok(composer, 'the production application composer was created');
  const owner = require('../main/work-preview-app-owner.cjs');
  assert.equal(owner.assertSender(composer.webContents), true);
  account = 'another-isolated-account';
  assert.throws(() => owner.assertSender(composer.webContents), { code: 'APP_ACCOUNT_CHANGED' });
});
