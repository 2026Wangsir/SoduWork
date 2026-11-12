'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { configure, showRecovery, secureStorageReady, recoveryPage, focusRecovery } = require('../main/linux-startup.cjs');

function commandFixture({ platform = 'linux', env = {}, ready = false, explicit = false } = {}) {
  const switches = [];
  const app = { isReady: () => ready, commandLine: {
    hasSwitch: name => name === 'password-store' && explicit,
    appendSwitch: (...args) => switches.push(args),
  } };
  return { app, platform, env, switches };
}

test('minimal Linux desktops select Secret Service before ready without disabling security', () => {
  for (const env of [{}, { XDG_CURRENT_DESKTOP: 'sway' }, { DESKTOP_SESSION: 'i3' }]) {
    const f = commandFixture({ env });
    assert.equal(configure(f), true);
    assert.deepEqual(f.switches, [['password-store', 'gnome-libsecret']]);
    assert.deepEqual(f.env, env);
  }
});

test('desktops that Chromium maps to basic or cannot recognize select Secret Service', () => {
  for (const env of [
    { XDG_CURRENT_DESKTOP: 'LXQt' },
    { XDG_CURRENT_DESKTOP: 'LXQt:GNOME', DESKTOP_SESSION: 'gnome' },
    { XDG_CURRENT_DESKTOP: 'custom: LXQt :KDE', KDE_SESSION_VERSION: '6' },
    { DESKTOP_SESSION: 'kde' }, { DESKTOP_SESSION: 'kde', GNOME_DESKTOP_SESSION_ID: 'deprecated' },
    { DESKTOP_SESSION: 'plasma' }, { DESKTOP_SESSION: 'plasmawayland' },
    { DESKTOP_SESSION: 'GNOME' },
    { KDE_FULL_SESSION: 'true' }, { KDE_SESSION_VERSION: '5' },
  ]) {
    const f = commandFixture({ env });
    assert.equal(configure(f), true, JSON.stringify(env));
    assert.deepEqual(f.switches, [['password-store', 'gnome-libsecret']]);
  }
});

test('Chromium 152 native secure backends preserve GNOME, COSMIC and KWallet identities', () => {
  for (const env of [
    ...['GNOME', 'Unity', 'X-Cinnamon', 'Deepin', 'Pantheon', 'XFCE', 'UKUI', 'COSMIC']
      .map(XDG_CURRENT_DESKTOP => ({ XDG_CURRENT_DESKTOP })),
    { XDG_CURRENT_DESKTOP: 'ubuntu:GNOME' }, { XDG_CURRENT_DESKTOP: 'GNOME:LXQt' },
    { XDG_CURRENT_DESKTOP: 'KDE' },
    { XDG_CURRENT_DESKTOP: 'custom: KDE :LXQt', KDE_SESSION_VERSION: '5' },
    { XDG_CURRENT_DESKTOP: 'KDE', KDE_SESSION_VERSION: '6' },
    ...['gnome', 'mate', 'deepin', 'kde4', 'kde-plasma', 'ukui', 'xfce4', 'xubuntu']
      .map(DESKTOP_SESSION => ({ DESKTOP_SESSION })),
    { DESKTOP_SESSION: 'kde', KDE_SESSION_VERSION: '4' },
    { KDE_FULL_SESSION: 'true', KDE_SESSION_VERSION: '5' },
    { KDE_FULL_SESSION: '', KDE_SESSION_VERSION: '' },
    { GNOME_DESKTOP_SESSION_ID: 'deprecated' }, { GNOME_DESKTOP_SESSION_ID: '' },
  ]) {
    const f = commandFixture({ env });
    assert.equal(configure(f), false, JSON.stringify(env));
    assert.deepEqual(f.switches, []);
  }
});

test('explicit password-store switches are preserved', () => {
  const explicit = commandFixture({ explicit: true });
  assert.equal(configure(explicit), false);
  assert.deepEqual(explicit.switches, []);
});

test('non-Linux platforms and late calls cannot change the selected store', () => {
  for (const options of [{ platform: 'win32' }, { platform: 'darwin' }, { ready: true }]) {
    const f = commandFixture(options);
    assert.equal(configure(f), false);
    assert.deepEqual(f.switches, []);
  }
});

test('native storage availability never treats basic, unknown or thrown errors as secure', () => {
  for (const backend of ['basic_text', 'unknown', '', 'unrecognized']) {
    assert.equal(secureStorageReady({ getSelectedStorageBackend: () => backend,
      isEncryptionAvailable: () => assert.fail('insecure backends must be rejected first') }), false);
  }
  for (const backend of ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6']) {
    assert.equal(secureStorageReady({ getSelectedStorageBackend: () => backend, isEncryptionAvailable: () => true }), true);
    assert.equal(secureStorageReady({ getSelectedStorageBackend: () => backend, isEncryptionAvailable: () => false }), false);
  }
  assert.equal(secureStorageReady({ getSelectedStorageBackend: () => { throw Error('private detail'); } }), false);
});

function recoveryFixture(overrides = {}) {
  const windows = [], events = [];
  const app = { isReady: () => true, getLocale: () => 'zh-CN',
    quit: () => events.push('quit'), relaunch: () => events.push('relaunch') };
  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.webContents = new EventEmitter(); windows.push(this);
      this.webContents.setWindowOpenHandler = handler => { this.openHandler = handler; };
    }
    async loadURL(url) { this.url = url; }
    isDestroyed() { return this.destroyed === true; }
    isMinimized() { return this.minimized === true; }
    restore() { this.minimized = false; this.restored = true; }
    focus() { this.focused = true; }
    show() { this.shown = true; }
  }
  const safeStorage = { getSelectedStorageBackend: () => 'gnome_libsecret', isEncryptionAvailable: () => false };
  const options = { app, BrowserWindow, safeStorage, platform: 'linux', env: {},
    warn: () => assert.fail('unexpected recovery page failure'), ...overrides };
  return { options, windows, events };
}

test('healthy, non-Linux and early startup retains the normal workspace path', () => {
  for (const override of [{ platform: 'win32' }, { platform: 'darwin' },
    { app: { isReady: () => false } },
    { safeStorage: { getSelectedStorageBackend: () => 'gnome_libsecret', isEncryptionAvailable: () => true } }]) {
    const f = recoveryFixture(override);
    assert.equal(showRecovery(f.options), false);
    assert.deepEqual(f.windows, []);
    assert.deepEqual(f.events, []);
  }
});

test('storage recovery is sandboxed, preserves data and allows only explicit restart or quit', async () => {
  const f = recoveryFixture();
  assert.equal(showRecovery(f.options), true);
  await new Promise(resolve => setImmediate(resolve));
  const win = f.windows[0];
  assert.equal(win.shown, true);
  assert.deepEqual(win.options.webPreferences, { partition: 'soduwork-linux-storage-recovery',
    sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: false });
  assert.deepEqual(win.openHandler({ url: 'https://untrusted.invalid' }), { action: 'deny' });
  let blocked = 0;
  for (const url of ['https://untrusted.invalid', 'file:///private', 'soduwork-linux-storage:other'])
    win.webContents.emit('will-navigate', { preventDefault: () => blocked++ }, url);
  assert.equal(blocked, 3);
  assert.deepEqual(f.events, []);
  win.webContents.emit('will-navigate', { preventDefault() {} }, 'soduwork-linux-storage:restart');
  win.emit('closed');
  assert.deepEqual(f.events, ['relaunch', 'quit']);
});

test('parent-managed source sessions never relaunch a child without its local Hub', async () => {
  const f = recoveryFixture({ env: { SODUWORK_SOURCE_SESSION: '1' } });
  assert.equal(showRecovery(f.options), true);
  const win = f.windows[0], html = decodeURIComponent(win.url.split(',').slice(1).join(','));
  assert.doesNotMatch(html, /soduwork-linux-storage:restart/);
  assert.match(html, /原来的启动入口/);
  win.webContents.emit('will-navigate', { preventDefault() {} }, 'soduwork-linux-storage:restart');
  assert.deepEqual(f.events, []);
  win.webContents.emit('will-navigate', { preventDefault() {} }, 'soduwork-linux-storage:quit');
  assert.deepEqual(f.events, ['quit']);
});

test('repeated launch focuses recovery instead of creating a workspace or duplicate recovery window', () => {
  const f = recoveryFixture();
  assert.equal(focusRecovery(f.options.app), false);
  assert.equal(showRecovery(f.options), true);
  const win = f.windows[0]; win.minimized = true;
  assert.equal(focusRecovery(f.options.app), true);
  assert.equal(win.focused, true); assert.equal(win.restored, true); assert.equal(win.shown, true);
  assert.equal(showRecovery(f.options), true);
  assert.equal(f.windows.length, 1);
  win.emit('closed');
  assert.equal(focusRecovery(f.options.app), false);
  assert.deepEqual(f.events, ['quit']);
});

test('a destroyed recovery window cannot intercept later launches', () => {
  const f = recoveryFixture();
  showRecovery(f.options);
  f.windows[0].destroyed = true;
  assert.equal(focusRecovery(f.options.app), false);
  assert.equal(focusRecovery({}), false);
});

test('all recovery locales are static and arbitrary locale input cannot inject HTML', () => {
  for (const locale of ['zh-CN', 'en-US', 'ja-JP', 'ko-KR', '"><script>bad()</script>']) {
    const html = recoveryPage(locale, true);
    assert.match(html, /Content-Security-Policy/);
    assert.match(html, /soduwork-linux-storage:restart/);
    assert.doesNotMatch(html, /<script|bad\(\)|device-auth\.json/);
  }
});
