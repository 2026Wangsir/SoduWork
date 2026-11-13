'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { inspect } = require('../main/macos-keychain.cjs');
const { dispatch, page } = require('../main/keychain-startup.cjs');

test('Keychain preflight reads only the default path and probes access with bounded commands', () => {
  const calls = [];
  const result = inspect({
    run: (...args) => { calls.push(args); return '    "/fixture/login.keychain-db"\n'; },
    stat: file => { assert.equal(file, '/fixture/login.keychain-db'); return { isFile: () => true }; },
  });
  assert.equal(result, null);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], ['/usr/bin/security', ['default-keychain', '-d', 'user'], {
    encoding: 'utf8', timeout: 2000, maxBuffer: 16384, stdio: ['ignore', 'pipe', 'pipe'],
  }]);
  assert.deepEqual(calls[1], ['/usr/bin/security', ['find-generic-password', '-a', 'soduwork-preflight',
    '-s', 'soduwork-preflight', '/fixture/login.keychain-db'], {
    encoding: 'utf8', timeout: 2000, maxBuffer: 16384, stdio: ['ignore', 'pipe', 'pipe'],
  }]);
});

test('an existing but inaccessible default Keychain is diagnosed before safeStorage runs', () => {
  let count = 0;
  const result = inspect({
    run: (...args) => {
      count++;
      if (count === 1) return '"/fixture/login.keychain-db"';
      throw { status: 1, stderr: 'User interaction is not allowed.' };
    },
    stat: file => { assert.equal(file, '/fixture/login.keychain-db'); return { isFile: () => true }; },
  });
  assert.deepEqual(result, { code: 'KEYCHAIN_ACCESS_UNAVAILABLE' });
  assert.equal(count, 2);
});

test('a missing sentinel item proves an accessible Keychain without writing to it', () => {
  let count = 0;
  const result = inspect({
    run: () => {
      count++;
      if (count === 1) return '"/fixture/login.keychain-db"';
      throw { status: 44, stderr: 'The specified item could not be found in the keychain.' };
    },
    stat: () => ({ isFile: () => true }),
  });
  assert.equal(result, null);
  assert.equal(count, 2);
});

test('localized missing-item diagnostics still prove access from the native status', () => {
  let count = 0;
  const result = inspect({
    run: () => {
      count++;
      if (count === 1) return '"/fixture/login.keychain-db"';
      throw { status: 44, stderr: 'Der angegebene Eintrag wurde im Schlüsselbund nicht gefunden.' };
    },
    stat: () => ({ isFile: () => true }),
  });
  assert.equal(result, null);
  assert.equal(count, 2);
});

test('missing default Keychains are diagnosed without returning private paths or command errors', () => {
  for (const run of [() => '', () => { throw { status: 37, stderr: 'private diagnostic' }; },
    () => { throw { status: 1, stderr: 'A default keychain could not be found.' }; }]) {
    assert.deepEqual(inspect({ run, stat: () => assert.fail('must not inspect an unknown path') }),
      { code: 'KEYCHAIN_DEFAULT_MISSING' });
  }
  for (const code of ['ENOENT', 'ENOTDIR']) {
    assert.deepEqual(inspect({ run: () => '"/private/fixture"', stat: () => { throw { code }; } }),
      { code: 'KEYCHAIN_DEFAULT_MISSING' });
  }
});

test('unknown metadata failures and malformed output cannot classify encrypted data as missing', () => {
  for (const run of [() => { throw { code: 'ETIMEDOUT' }; }, () => { throw { status: 1 }; },
    () => 'not a path', () => '"/first"\n"/second"']) {
    assert.equal(inspect({ run, stat: () => assert.fail('must not inspect an invalid path') }), null);
  }
});

test('permission failures while reading Keychain metadata enter recovery', () => {
  for (const code of ['EACCES', 'EPERM']) {
    assert.deepEqual(inspect({ run: () => '"/fixture/login.keychain-db"', stat: () => { throw { code }; } }),
      { code: 'KEYCHAIN_ACCESS_UNAVAILABLE' });
  }
});

function fixture() {
  const app = new EventEmitter(), windows = [], opens = [];
  let ready;
  Object.assign(app, { commandLine: { hasSwitch: () => false }, getLocale: () => 'zh-CN',
    setName: value => { app.name = value; }, quit: () => { app.quits = (app.quits || 0) + 1; },
    whenReady: () => new Promise(resolve => { ready = resolve; }) });
  class BrowserWindow {
    constructor(options) {
      this.options = options; this.webContents = new EventEmitter(); windows.push(this);
      this.webContents.setWindowOpenHandler = value => { this.openHandler = value; };
    }
    async loadURL(url) { this.url = url; }
    show() { this.shown = true; }
    focus() { this.focused = true; }
    isDestroyed() { return false; }
  }
  const options = { app, BrowserWindow, shell: { openPath: async target => { opens.push(target); } },
    platform: 'darwin', probe: () => ({ code: 'KEYCHAIN_DEFAULT_MISSING' }),
    root: '/fixture/no-assets', warn: () => assert.fail('recovery should load') };
  return { app, windows, opens, options, ready: async () => { ready(); await new Promise(resolve => setImmediate(resolve)); } };
}

test('normal, non-macOS and explicit mock-Keychain starts retain the ordinary startup path', () => {
  const f = fixture();
  assert.equal(dispatch({ ...f.options, platform: 'linux', probe: () => assert.fail('must not query macOS') }), false);
  assert.equal(dispatch({ ...f.options, probe: () => null }), false);
  f.app.commandLine.hasSwitch = key => key === 'use-mock-keychain';
  assert.equal(dispatch({ ...f.options, probe: () => assert.fail('must not inspect real test-user metadata') }), false);
  assert.equal(f.windows.length, 0);
  assert.equal(f.app.name, undefined);
});

test('missing Keychain shows an isolated recovery page and restricts all navigation', async () => {
  const f = fixture();
  assert.equal(dispatch(f.options), true);
  assert.equal(f.windows.length, 0);
  await f.ready();
  assert.equal(f.windows.length, 1);
  const win = f.windows[0];
  assert.deepEqual(win.options.webPreferences, { partition: 'soduwork-keychain-recovery',
    sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: false });
  assert.equal(win.shown, true);
  assert.equal(f.app.name, 'SoduWork');
  const html = decodeURIComponent(win.url.split(',').slice(1).join(','));
  assert.match(html, /macOS 当前默认钥匙串不存在/);
  assert.match(html, /不会自动重置或删除钥匙串/);
  assert.doesNotMatch(html, /<script|\/private\/|device-auth/);
  assert.deepEqual(win.openHandler({ url: 'https://untrusted.invalid' }), { action: 'deny' });
  let prevented = 0;
  for (const url of ['https://untrusted.invalid', 'file:///private/fixture', 'soduwork-keychain:unknown'])
    win.webContents.emit('will-navigate', { preventDefault: () => prevented++ }, url);
  assert.equal(prevented, 3);
  assert.deepEqual(f.opens, []);
  assert.equal(f.app.quits, undefined);
  win.webContents.emit('will-navigate', { preventDefault: () => prevented++ }, 'soduwork-keychain:quit');
  assert.equal(f.app.quits, 1);
  f.app.emit('activate');
  assert.equal(win.focused, true);
});

test('recovery explains the preserved-data boundary in every supported locale', () => {
  for (const locale of ['zh-CN', 'en-US', 'ja-JP', 'ko-KR']) {
    const html = page(locale);
    assert.match(html, /Content-Security-Policy/);
    assert.match(html, /soduwork-keychain:open/);
    assert.match(html, /soduwork-keychain:quit/);
    assert.doesNotMatch(html, /<script/);
  }
});
