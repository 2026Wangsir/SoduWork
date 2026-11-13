'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { create } = require('../main/desktop-overlay.cjs');

class Clock {
  time = 0;
  pending = new Map();
  setTimeout(fn, delay) { return this.add(fn, delay, 0); }
  setInterval(fn, delay) { return this.add(fn, delay, delay); }
  clearTimeout(id) { this.pending.delete(id); }
  clearInterval(id) { this.pending.delete(id); }
  add(fn, delay, interval) {
    const id = { unref() {} };
    this.pending.set(id, { fn, at: this.time + delay, interval });
    return id;
  }
  tick(duration) {
    const end = this.time + duration;
    for (;;) {
      const next = [...this.pending.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > end) break;
      const [id, job] = next;
      this.time = job.at;
      if (job.interval) job.at += job.interval;
      else this.pending.delete(id);
      job.fn();
    }
    this.time = end;
  }
}

function harness(t, { readyDuringLoad = false, synchronousBlur = false } = {}) {
  const timers = new Clock();
  const app = new EventEmitter();
  const screen = new EventEmitter();
  screen.display = { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 };
  screen.cursor = { x: 10, y: 10 };
  screen.getPrimaryDisplay = () => screen.display;
  screen.getCursorScreenPoint = () => screen.cursor;
  const ipcMain = new EventEmitter();
  ipcMain.handlers = new Map();
  ipcMain.handle = (channel, fn) => {
    assert.equal(ipcMain.handlers.has(channel), false, 'IPC handler registered once');
    ipcMain.handlers.set(channel, fn);
  };
  ipcMain.removeHandler = (channel) => ipcMain.handlers.delete(channel);
  const powerMonitor = new EventEmitter();
  const shortcuts = new Map();
  const globalShortcut = {
    register(key, fn) { assert.equal(shortcuts.has(key), false); shortcuts.set(key, fn); return true; },
    unregister(key) { shortcuts.delete(key); },
  };
  const notices = [];
  class Notification extends EventEmitter {
    static isSupported() { return true; }
    constructor(options) { super(); this.options = options; notices.push(this); }
    show() {}
  }
  const windows = [];
  const workWindows = [];
  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.bounds = { ...screen.display.bounds };
      this.visible = options.show !== false;
      this.destroyed = false;
      this.calls = [];
      this.reloads = 0;
      this.focusCount = 0;
      this.focusable = true;
      const wc = this.webContents = new EventEmitter();
      wc.isDestroyed = () => this.destroyed;
      wc.isDevToolsOpened = () => false;
      wc.openDevTools = () => {};
      wc.send = (...args) => this.calls.push(['send', ...args]);
      wc.zoom = 1;
      wc.zoomReads = 0;
      wc.getZoomFactor = () => { wc.zoomReads++; return wc.zoom; };
      wc.setZoomFactor = (value) => { wc.zoom = value; };
      wc.executeJavaScript = () => Promise.resolve(1);
      wc.invalidate = () => this.calls.push(['invalidate']);
      windows.push(this);
    }
    isDestroyed() { return this.destroyed; }
    isVisible() { return this.visible; }
    getContentBounds() { return this.bounds; }
    getBounds() { return this.bounds; }
    setBounds(value) { this.bounds = { ...value }; this.calls.push(['bounds', value]); }
    setPosition(x, y) { Object.assign(this.bounds, { x, y }); }
    setShape(value) { this.calls.push(['shape', value]); }
    setIgnoreMouseEvents(value, options) { this.ignored = value; this.forwardMouse = !!options?.forward; this.calls.push(['ignore', value]); }
    setFocusable(value) { this.focusable = value; this.calls.push(['focusable', value]); }
    setVisibleOnAllWorkspaces(visible, options) { this.calls.push(['spaces', visible, options]); }
    blur() { this.calls.push(['blur']); if (synchronousBlur) this.emit('blur'); }
    setAlwaysOnTop(value, level) { this.calls.push(['top', value, level]); }
    setTitle() {}
    hide() { this.visible = false; this.calls.push(['hide']); }
    show() { this.visible = true; this.calls.push(['show']); this.emit('show'); }
    showInactive() { this.show(); }
    focus() { this.focusCount++; }
    loadFile(file) {
      this.file = file;
      this.webContents.emit('did-start-loading');
      if (readyDuringLoad) ready(this);
      return Promise.resolve();
    }
    reload() { this.reloads++; this.webContents.emit('did-start-loading'); }
    close() { this.destroyed = true; this.emit('closed'); }
  }
  const controller = create({ app, screen, ipcMain, BrowserWindow, globalShortcut, Notification,
    powerMonitor, timers, now: () => timers.time, getRendererRoot: () => 'C:/SoduWork/client',
    getIcon: () => 'icon', translate: (value) => value,
    getWorkWindows: () => workWindows });
  t.after(() => controller.dispose());
  function send(channel, win, ...args) { ipcMain.emit(channel, { sender: win.webContents }, ...args); }
  function ready(win) {
    win.emit?.('ready-to-show');
    send('renderer-ready', win);
    const info = query('window-get-overlay-shape', win);
    send('window-set-overlay-shape', win, [{ x: 100, y: 100, width: 60, height: 180 }], info?.revision);
  }
  function query(channel, win) { return ipcMain.handlers.get(channel)({ sender: win.webContents }); }
  return { controller, timers, screen, ipcMain, powerMonitor, app, shortcuts, notices, windows,
    workWindows, send, ready, query };
}

test('blur keeps visible native regions while every input path waits for a fresh renderer revision', (t) => {
  const h = harness(t);
  const win = h.controller.createWindow();
  h.screen.cursor = { x: 110, y: 110 };
  h.ready(win);
  const before = h.query('window-get-overlay-shape', win);
  win.calls.length = 0;
  win.emit('blur');
  const pending = h.query('window-get-overlay-shape', win);
  assert.deepEqual(pending.applied, before.applied, 'blur never clips the visible dock');
  assert.equal(pending.awaitingShape, true);
  assert.equal(pending.revision, before.revision + 1);
  assert.equal(win.calls.some(call => call[0] === 'shape'), false, 'blur needs no native repaint');
  h.send('window-set-ignore-mouse-events', win, false);
  win.show();
  win.emit('ready-to-show');
  h.controller.setWorkspaceMaximized(true);
  h.controller.setWorkspaceMaximized(false);
  h.timers.tick(450);
  assert.equal(win.ignored, true, 'polling, show and delayed redraw cannot release input');
  assert.equal(win.focusable, false);
  assert.deepEqual(h.query('window-get-overlay-shape', win).applied, before.applied);
  const staleRects = [{ x: 0, y: 0, width: 1920, height: 1080 }];
  h.send('window-set-overlay-shape', win, staleRects, before.revision);
  h.send('window-set-overlay-shape', win, staleRects);
  const foreign = { webContents: new EventEmitter() };
  h.send('window-set-overlay-shape', foreign, staleRects, pending.revision);
  assert.equal(win.ignored, true, 'stale and foreign shape reports do not release input');
  assert.deepEqual(h.query('window-get-overlay-shape', win).applied, before.applied);
  h.send('window-set-overlay-shape', win, before.requested, pending.revision);
  assert.equal(win.ignored, false);
  assert.equal(win.focusable, true);
  assert.equal(h.query('window-get-overlay-shape', win).awaitingShape, false);
});

test('synchronous and repeated blur preserve one pending revision and reject earlier acknowledgements', (t) => {
  const h = harness(t, { synchronousBlur: true });
  const win = h.controller.createWindow();
  h.screen.cursor = { x: 110, y: 110 };
  h.ready(win);
  win.calls.length = 0;
  win.emit('blur');
  const pending = h.query('window-get-overlay-shape', win);
  win.emit('blur');
  h.timers.tick(80);
  assert.equal(h.query('window-get-overlay-shape', win).revision, pending.revision);
  assert.equal(win.calls.filter(call => call[0] === 'send' && call[1] === 'overlay-window-blur').length, 1);
  h.send('window-set-overlay-shape', win, pending.requested, pending.revision);
  assert.equal(win.ignored, false);
  win.emit('blur');
  const next = h.query('window-get-overlay-shape', win);
  assert.equal(next.revision, pending.revision + 1);
  h.send('window-set-overlay-shape', win, pending.requested, pending.revision);
  assert.equal(win.ignored, true);
  h.send('window-set-overlay-shape', win, next.requested, next.revision);
  assert.equal(win.ignored, false);
});

test('reload invalidates blur acknowledgements and pending show callbacks keep the new page parked', (t) => {
  const h = harness(t);
  const win = h.controller.createWindow();
  h.ready(win);
  win.emit('blur');
  const pending = h.query('window-get-overlay-shape', win);
  win.show();
  h.controller.reload();
  const loading = h.query('window-get-overlay-shape', win);
  assert.ok(loading.revision > pending.revision);
  h.send('window-set-overlay-shape', win, pending.requested, pending.revision);
  h.timers.tick(0);
  assert.equal(win.ignored, true);
  assert.deepEqual(h.query('window-get-overlay-shape', win).requested, []);
  if (process.platform !== 'darwin') assert.equal(h.query('window-get-overlay-shape', win).applied[0].width, 1);
  h.ready(win);
  h.screen.cursor = { x: 110, y: 110 };
  h.timers.tick(40);
  assert.equal(win.ignored, false);
});

test('multi-component overlay stays passive through blur and emergency rejects even current renderer reports', (t) => {
  const h = harness(t);
  const win = h.controller.createWindow();
  const rects = [{ x: 100, y: 100, width: 60, height: 180 }, { x: 300, y: 100, width: 40, height: 40 }];
  h.send('renderer-ready', win);
  h.send('window-set-overlay-shape', win, rects);
  win.emit('blur');
  const pending = h.query('window-get-overlay-shape', win);
  win.show();
  h.timers.tick(120);
  h.send('window-set-ignore-mouse-events', win, false);
  assert.equal(win.ignored, true);
  assert.deepEqual(h.query('window-get-overlay-shape', win).requested, rects);
  h.controller.emergencyPassthrough('fixture');
  h.send('window-set-overlay-shape', win, rects, pending.revision);
  assert.deepEqual(h.query('window-get-overlay-shape', win).requested, []);
  assert.equal(win.ignored, true);
  assert.equal(win.visible, false);
});

test('controller owns one overlay and preserves renderer/preload paths', (t) => {
  const h = harness(t);
  h.controller.start();
  h.controller.start();
  const win = h.controller.createWindow();
  assert.equal(h.controller.createWindow(), win);
  assert.equal(h.windows.length, 1);
  assert.equal(h.shortcuts.size, 2);
  assert.equal(h.powerMonitor.listenerCount('resume'), 1);
  assert.equal(win.options.webPreferences.preload, path.join('C:/SoduWork/client', 'preload.js'));
  assert.equal(win.file, path.join('C:/SoduWork/client', 'index.html'));
  assert.equal(win.options.transparent, true);
  assert.equal(win.options.backgroundColor, '#00000000');
  assert.equal(win.options.thickFrame, false);
  assert.equal(win.visible, false, 'startup waits for paint and clipped geometry');
  if (process.platform === 'win32') assert.equal(win.options.type, 'toolbar');
  assert.equal(win.ignored, true, 'startup never intercepts the desktop');
  if (process.platform === 'win32' || process.platform === 'linux') {
    assert.equal(h.query('window-get-overlay-shape', win).applied[0].width, 1);
  } else {
    assert.equal(h.query('window-get-overlay-shape', win).applied.length, 0,
      'mac 没有原生裁剪，动态穿透不产生 applied 区域');
  }
  if (process.platform === 'darwin') {


    const spacePins = win.calls.filter(call => call[0] === 'spaces');
    assert.equal(spacePins.length, 0,
      '覆盖窗不得再跨 Space（全住第一个桌面，全屏时自然不可见）');
    const tops = win.calls.filter(call => call[0] === 'top');
    assert.deepEqual(tops[0], ['top', true, 'floating'],
      'mac 置顶级别用 floating：高于普通窗口，低于全屏窗口');
  }
  assert.throws(() => { h.controller.window = null; }, TypeError);
});

test('ready received inside loadFile survives startup and busy/GC heartbeat gaps', (t) => {
  const h = harness(t, { readyDuringLoad: true });
  h.controller.createWindow();
  h.timers.tick(45000);
  assert.equal(h.controller.emergency, false);
  assert.equal(h.notices.length, 0);
});

test('other work windows cannot supply overlay ready, heartbeat or shape', (t) => {
  const h = harness(t);
  const win = h.controller.createWindow();
  const foreign = { webContents: new EventEmitter() };
  h.ready(foreign);
  h.send('renderer-heartbeat', foreign);
  assert.equal(h.query('window-get-overlay-shape', foreign), null);
  assert.equal(h.query('window-get-overlay-shape', win).reported, false);
  h.timers.tick(15000);
  assert.equal(h.controller.emergency, true);
  assert.equal(win.visible, false);
  assert.equal(win.ignored, true);
});

test('single component keeps its visible shape and releases input before notifying renderer of blur', (t) => {
  const h = harness(t);
  const win = h.controller.createWindow();
  h.ready(win);
  assert.equal(win.ignored, true);
  h.screen.cursor = { x: 110, y: 110 };
  h.timers.tick(40);
  assert.equal(win.ignored, false);
  assert.equal(win.focusable, true, 'interactive overlay can receive pointer focus');
  win.calls.length = 0;
  win.emit('blur');
  assert.deepEqual(win.calls.slice(0, 4).map(call => call[0]),
    ['ignore', 'focusable', 'blur', 'send'], '先释放输入与焦点，保留原生可见区域');
  assert.equal(win.calls.some(call => call[0] === 'shape'), false);
  assert.equal(win.ignored, true);
  assert.equal(win.focusable, false, 'passive overlay is removed from the keyboard focus chain');
  h.timers.tick(40);
  assert.equal(win.ignored, true, 'passive overlay waits for the current region revision');
});

test('initial surface is revealed once after paint, readiness and geometry, without a hide/show rebuild', t => {
  const h = harness(t), win = h.controller.createWindow();
  win.emit('ready-to-show');
  assert.equal(win.visible, false);
  h.send('renderer-ready', win);
  assert.equal(win.visible, false);
  h.send('window-set-overlay-shape', win, [{ x: 100, y: 100, width: 60, height: 180 }]);
  assert.equal(win.visible, true);
  assert.equal(win.focusCount, 0);
  h.timers.tick(500);
  assert.equal(win.calls.filter(call => call[0] === 'show').length, 1);
  assert.equal(win.calls.filter(call => call[0] === 'hide').length, 0);
});

test('passive overlay avoids Windows cursor forwarding and recovers entry without renderer mouse events', (t) => {
  const h = harness(t);
  const win = h.controller.createWindow();
  h.ready(win);
  assert.equal(win.forwardMouse, process.platform !== 'win32');
  win.calls.length = 0;
  for (let x = 200; x < 300; x++) {
    h.screen.cursor = { x, y: 120 };
    h.timers.tick(40);
  }
  assert.equal(win.calls.filter(call => call[0] === 'ignore').length, 0,
    'movement over an underlying window never toggles native mouse handling');
  h.screen.cursor = { x: 120, y: 120 };
  h.timers.tick(40);
  assert.equal(win.ignored, false, 'main-process hit testing restores interaction without forwarded mousemove');
  assert.equal(win.focusable, true);
  h.screen.cursor = { x: 200, y: 120 };
  h.timers.tick(40);
  assert.equal(win.ignored, true);
  assert.equal(win.focusable, false);
  assert.equal(win.forwardMouse, process.platform !== 'win32');
});

test('a visible work window wins hit-testing when its bounds overlap a pet or dock', (t) => {
  const h = harness(t), win = h.controller.createWindow();
  h.ready(win);
  h.workWindows.push({
    isDestroyed: () => false,
    isVisible: () => true,
    isMinimized: () => false,
    getBounds: () => ({ x: 80, y: 80, width: 640, height: 480 }),
  });
  h.screen.cursor = { x: 110, y: 110 };
  h.timers.tick(40);
  assert.equal(win.ignored, true, 'a composer under the pet must receive the first click');
  assert.equal(win.focusable, false, 'the overlay must leave the keyboard focus chain over work content');
  h.workWindows.length = 0;
  h.timers.tick(40);
  assert.equal(win.ignored, false, 'the desktop widget remains available outside work windows');
});

test('work-window focus lowers the overlay and restores it after focus returns to the desktop', (t) => {
  const h = harness(t), win = h.controller.createWindow();
  h.ready(win);
  win.calls.length = 0;
  h.controller.setWorkWindowFocused(true);
  assert.deepEqual(win.calls.at(-1), ['top', false, process.platform === 'darwin' ? 'floating' : 'screen-saver']);
  assert.equal(win.ignored, true);
  h.controller.setWorkWindowFocused(false);
  assert.deepEqual(win.calls.at(-1), ['top', true, process.platform === 'darwin' ? 'floating' : 'screen-saver']);
});

test('browser-window focus events apply the same stacking guard as direct work-window state', (t) => {
  const h = harness(t), win = h.controller.createWindow();
  h.ready(win);
  h.controller.start();
  const work = { isDestroyed: () => false };
  h.app.emit('browser-window-focus', {}, work);
  assert.equal(win.focusable, false);
  assert.ok(win.calls.some(call => call[0] === 'top' && call[1] === false));
  h.app.emit('browser-window-blur', {}, work);
  assert.deepEqual(win.calls.at(-1), ['top', true, process.platform === 'darwin' ? 'floating' : 'screen-saver']);
});

test('foreign windows cannot change overlay input before or after region registration', (t) => {
  const h = harness(t);
  const win = h.controller.createWindow();
  const foreign = { webContents: new EventEmitter() };
  h.send('window-set-ignore-mouse-events', foreign, false, { forward: true });
  assert.equal(win.ignored, true);
  h.ready(win);
  h.screen.cursor = { x: 120, y: 120 };
  h.send('window-set-ignore-mouse-events', foreign, false, { forward: true });
  assert.equal(win.ignored, true, 'foreign IPC does not trigger an input transition');
  h.timers.tick(40);
  assert.equal(win.ignored, false, 'legitimate position polling still works');
});

test('emergency recovery starts a fresh navigation, and missed ready is still detected', (t) => {
  const h = harness(t);
  const win = h.controller.createWindow();
  h.ready(win);
  h.controller.emergencyPassthrough('test');
  h.controller.recoverFromEmergency();
  assert.equal(win.reloads, 1);
  assert.equal(win.ignored, true);
  assert.equal(h.controller.emergency, false);
  assert.equal(h.query('window-get-overlay-shape', win).reported, false);
  h.timers.tick(15000);
  assert.equal(h.controller.emergency, true);
  h.controller.recoverFromEmergency();
  h.ready(win);
  h.timers.tick(15000);
  assert.equal(h.controller.emergency, false);
});

test('crash recovery releases emergency state without stealing focus', (t) => {
  const h = harness(t);
  const win = h.controller.createWindow();
  h.ready(win);
  win.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  assert.equal(h.controller.emergency, true);
  h.timers.tick(800);
  assert.equal(win.reloads, 1);
  assert.equal(h.controller.emergency, false);
  assert.equal(win.focusCount, 0);
  h.ready(win);
  h.screen.cursor = { x: 110, y: 110 };
  h.timers.tick(40);
  assert.equal(win.ignored, false, 'recovered pet and dock can be interacted with');
});

test('manual recovery cancels the effect of a pending automatic crash retry', (t) => {
  const h = harness(t);
  const win = h.controller.createWindow();
  win.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  h.controller.reload();
  h.ready(win);
  h.timers.tick(800);
  assert.equal(win.reloads, 1);
  assert.equal(h.controller.emergency, false);
});

test('repeated renderer crashes stop automatic recovery after three attempts', (t) => {
  const h = harness(t);
  const win = h.controller.createWindow();
  for (let attempt = 1; attempt <= 4; attempt++) {
    h.ready(win);
    win.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
    h.timers.tick(800 * attempt);
  }
  assert.equal(win.reloads, 3);
  assert.equal(h.controller.emergency, true);
  assert.equal(win.ignored, true);
  h.controller.reload();
  h.ready(win);
  assert.equal(win.reloads, 4);
  assert.equal(h.controller.emergency, false, 'manual tray recovery remains available');
});

test('ready without native regions and failed region application stay safely hidden', (t) => {
  const h = harness(t);
  const win = h.controller.createWindow();
  h.send('renderer-ready', win);
  h.timers.tick(600);
  assert.equal(h.controller.emergency, true);
  assert.equal(win.visible, false);
  h.controller.recoverFromEmergency();
  if (process.platform === 'win32' || process.platform === 'linux') {
    /* Native clipping failures apply to supported platforms; macOS uses dynamic passthrough instead. */
    win.setShape = () => { throw new Error('simulated native failure'); };
    h.send('window-set-overlay-shape', win, [{ x: 10, y: 10, width: 60, height: 180 }],
      h.query('window-get-overlay-shape', win).revision);
    assert.equal(h.controller.emergency, true);
    assert.equal(win.ignored, true);
    assert.equal(h.query('window-get-overlay-shape', win).enabled, false);
  }
});

test('close clears all timers/display listeners and stale events cannot mutate replacement', async (t) => {
  const h = harness(t);
  const old = h.controller.createWindow();
  let resolveDpi;
  old.webContents.executeJavaScript = () => new Promise(resolve => { resolveDpi = resolve; });
  old.webContents.emit('dom-ready');
  old.emit('ready-to-show');
  h.ready(old);
  old.webContents.emit('unresponsive');
  old.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  assert.ok(h.timers.pending.size > 4);
  old.close();
  assert.equal(h.controller.window, null);
  assert.equal(h.timers.pending.size, 0);
  for (const event of ['display-metrics-changed', 'display-added', 'display-removed']) {
    assert.equal(h.screen.listenerCount(event), 0);
  }
  const replacement = h.controller.createWindow();
  h.ready(replacement);
  resolveDpi(2);
  await Promise.resolve();
  assert.equal(old.webContents.zoomReads, 0, 'late DPI response never touches destroyed contents');
  const calls = replacement.calls.length;
  old.emit('closed');
  old.emit('blur');
  old.emit('minimize', { preventDefault() {} });
  old.webContents.emit('dom-ready');
  h.notices[0].emit('click');
  assert.equal(replacement.calls.length, calls);
  assert.equal(h.controller.window, replacement);
  h.timers.tick(15000);
  assert.equal(replacement.reloads, 0);
  assert.equal(h.controller.emergency, false);
  assert.equal(h.screen.listenerCount('display-added'), 1);
});

test('new navigation invalidates delayed shape checks and in-flight DPI correction', async (t) => {
  const h = harness(t);
  const win = h.controller.createWindow();
  let resolveDpi;
  win.webContents.executeJavaScript = () => new Promise(resolve => { resolveDpi = resolve; });
  win.webContents.emit('dom-ready');
  h.send('renderer-ready', win);
  h.controller.reload();
  resolveDpi(2);
  await Promise.resolve();
  assert.equal(win.webContents.zoom, 1);
  h.timers.tick(700);
  assert.equal(h.controller.emergency, false, 'old page shape grace period cannot pause a new page');
  h.ready(win);
  h.timers.tick(15000);
  assert.equal(h.controller.emergency, false);
});

test('valid DPI correction uses the current renderer ratio and display scale', async (t) => {
  const h = harness(t);
  const win = h.controller.createWindow();
  h.screen.display.scaleFactor = 1.5;
  win.webContents.executeJavaScript = () => Promise.resolve(3);
  win.webContents.emit('dom-ready');
  await Promise.resolve();
  assert.equal(win.webContents.zoom, 2);
});

test('responsive, heartbeat and power events cancel transient unresponsive timers', (t) => {
  const h = harness(t);
  h.controller.start();
  const win = h.controller.createWindow();
  h.ready(win);
  for (const recover of [() => win.webContents.emit('responsive'),
    () => h.send('renderer-heartbeat', win), () => h.powerMonitor.emit('resume')]) {
    win.webContents.emit('unresponsive');
    h.timers.tick(1000);
    recover();
    h.timers.tick(16000);
    assert.equal(h.controller.emergency, false);
  }
  win.webContents.emit('unresponsive');
  h.timers.tick(15000);
  assert.equal(h.controller.emergency, true);
  h.timers.tick(30000);
  assert.equal(h.notices.length, 1, 'multiple watchdogs do not stack native notifications');
});

test('display changes follow primary monitor bounds and dispose releases every registration', (t) => {
  const h = harness(t);
  h.controller.start();
  const win = h.controller.createWindow();
  h.ready(win);
  h.screen.display.bounds = { x: -1280, y: 100, width: 1280, height: 720 };
  h.screen.emit('display-metrics-changed');
  assert.deepEqual(win.bounds, h.screen.display.bounds);
  h.controller.dispose();
  h.controller.dispose();
  assert.equal(h.timers.pending.size, 0);
  assert.equal(h.screen.eventNames().length, 0);
  assert.equal(h.powerMonitor.eventNames().length, 0);
  assert.equal(h.app.eventNames().length, 0);
  assert.equal(h.ipcMain.eventNames().length, 0);
  assert.equal(h.ipcMain.handlers.size, 0);
  assert.equal(h.shortcuts.size, 0);
  assert.equal(win.ignored, true);
  assert.throws(() => h.controller.createWindow(), /disposed/);
});

test('workspace maximize hides overlay and restore brings it back without stealing focus', (t) => {
  const h = harness(t);
  h.controller.start();
  const win = h.controller.createWindow();
  h.ready(win);
  assert.equal(win.visible, true);

  h.controller.setWorkspaceMaximized(true);
  assert.equal(win.visible, false);
  // Repeated maximization reports are idempotent.
  h.controller.setWorkspaceMaximized(true);
  assert.equal(win.visible, false);

  h.controller.setWorkspaceMaximized(false);
  assert.equal(win.visible, true);
  assert.ok(win.calls.some(([kind]) => kind === 'top'), '层级重钉');

  // Restoring an overlay not hidden by this mechanism is a no-op.
  h.controller.setWorkspaceMaximized(false);
  h.controller.setWorkspaceMaximized(false);
  assert.equal(win.visible, true);
});

test('emergency passthrough keeps overlay ownership over workspace sync', (t) => {
  const h = harness(t);
  h.controller.start();
  const win = h.controller.createWindow();
  h.ready(win);
  h.controller.emergencyPassthrough('测试');
  assert.equal(win.visible, false);

  // Workspace state changes must not reveal an emergency-hidden overlay.
  h.controller.setWorkspaceMaximized(true);
  h.controller.setWorkspaceMaximized(false);
  assert.equal(win.visible, false);

  h.controller.recoverFromEmergency();
  assert.equal(win.visible, true);
});

// Pet + shortcut dock must be as passive as a single widget over the chat editor.
test('multiple widgets release mouse and keyboard focus in every gap, including after a blur acknowledgement', t => {
  const h = harness(t), win = h.controller.createWindow();
  const rects = [{ x: 100, y: 100, width: 60, height: 180 }, { x: 400, y: 400, width: 72, height: 72 }];
  h.ready(win);
  const report = () => h.send('window-set-overlay-shape', win, rects, h.query('window-get-overlay-shape', win).revision);
  report();
  assert.equal(win.ignored, true, 'empty desktop must not become active just because pet and dock coexist');
  assert.equal(win.focusable, false);
  for (const point of [{ x: 110, y: 110 }, { x: 420, y: 420 }]) {
    h.screen.cursor = point; h.timers.tick(40);
    assert.equal(win.ignored, false, 'each visible widget remains clickable');
    assert.equal(win.focusable, true);
    h.screen.cursor = { x: 300, y: 300 }; h.timers.tick(40);
    assert.equal(win.ignored, true, 'the gap between widgets belongs to the underlying chat');
    assert.equal(win.focusable, false);
    win.emit('blur'); report();
    assert.equal(win.ignored, true, 'fresh geometry must not reactivate the transparent area');
    h.send('window-set-ignore-mouse-events', win, false);
    assert.equal(win.ignored, true, 'renderer mouse requests cannot bypass the guard');
  }
  const shapeCalls = win.calls.filter(call => call[0] === 'shape').length;
  h.timers.tick(400);
  assert.equal(win.calls.filter(call => call[0] === 'shape').length, shapeCalls, 'input polling never repaints unchanged regions');
  h.screen.getCursorScreenPoint = () => { throw Error('display unavailable'); };
  report();
  assert.equal(win.ignored, true, 'missing cursor information fails open for underlying windows');
});
