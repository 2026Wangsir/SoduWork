'use strict';










const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (...parts) => fs.readFileSync(path.resolve(__dirname, '..', ...parts), 'utf8');
const windowMenu = read('components', 'workspace', 'window-menu.js');
const windowMenuCss = read('components', 'workspace', 'window-menu.css');
const workspaceNavigationCss = read('components', 'workspace', 'workspace-navigation.css');
const workspacePageLayoutCss = read('components', 'workspace', 'workspace-page-layout.css');
const panels = read('components', 'panels', 'panels.js');

function menuRuntime(nativeMenu) {
  let confirming = true, ipc;
  const calls = [], handlers = new Map(), nodes = [], headers = [], items = [];
  const document = {readyState: 'loading', activeElement: null,
    addEventListener: (name, handler) => handlers.set(name, handler)};
  function node(tag = 'div') {
    const n = {tagName: tag, dataset: {}, style: {}, hidden: false, open: false, listeners: new Map(),
      setAttribute(key, value) { this[key] = value; }, removeAttribute(key) { delete this[key]; },
      toggleAttribute() {}, addEventListener(name, handler) { this.listeners.set(name, handler); },
      querySelector() { return null; }, querySelectorAll() { return []; }, contains() { return false; },
      focus() { document.activeElement = this; calls.push(['focus', this.id || this.tagName]); },
      getBoundingClientRect() { return {left: 10, right: 100, top: 10, bottom: 100}; },
      showModal() { this.open = true; }, close() { this.open = false; },
    };
    return n;
  }
  const sidebar = node(), sidebarButton = node('button'), nav = node('nav'), divider = node();
  for (const name of ['file', 'view', 'help']) {
    const h = node('button'); h.id = 'menu-' + name; h.dataset.windowMenu = name; headers.push(h);
  }
  items.push(node('button'));
  document.documentElement = node('html');
  document.documentElement.dataset = {deskPanel: 'workspace', workspaceLayout: 'conversation'};
  document.body = {...node('body'), append() {}, prepend() {}};
  document.querySelector = () => sidebar;
  document.createElement = tag => {
    const n = node(tag); nodes.push(n);
    if (tag === 'header') {
      n.querySelector = selector => selector === 'nav' ? nav : selector === '.wm-divider' ? divider
        : selector.startsWith('[data-window-sidebar]') ? sidebarButton
          : headers.find(h => selector.includes('"' + h.dataset.windowMenu + '"')) || null;
      n.querySelectorAll = () => headers;
    } else if (tag === 'dialog') {
      const children = new Map([['h2', node('h2')], ['.wm-dialog-body', node()], ['[data-window-dialog-close]', node('button')]]);
      n.querySelector = selector => children.get(selector);
    } else n.querySelectorAll = () => items;
    return n;
  };
  const host = {innerWidth: 1200, RequirementConfirm: {isOpen: () => confirming},
    addEventListener() {}, dispatchEvent() {},
    WorkspaceHost: {open: (...args) => calls.push(['route', ...args])},
    soduWorkAPI: {
      getWindowTitlebar: async () => ({mode: 'native', nativeMenu}),
      setWindowMenuState: async () => {},
      onWindowMenuCommand: handler => { ipc = handler; },
      openWindowMenu: async name => { calls.push(['native-menu', name]); },
      getAppInfo: async () => ({version: '1', website: 'https://example.invalid'}),
      openExternal: async value => { calls.push(['external', value]); },
      requestAppQuit: async () => { calls.push(['quit']); },
    }};
  vm.runInNewContext(windowMenu, {window: host, document,
    localStorage: {getItem: () => '{}', setItem() {}},
    requestAnimationFrame: () => 1, MutationObserver: class {observe() {}},
    Event: class {constructor(type) {this.type = type;}}, console});
  host.WindowMenu.mount();
  return {menu: host.WindowMenu, calls, nodes, headers, document, confirm: value => {confirming = value;},
    native: id => ipc(id), key: key => {
      const e = {key, target: {closest: () => null}, preventDefault() {this.defaultPrevented = true;},
        stopImmediatePropagation() {this.stopped = true;}};
      handlers.get('keydown')(e); return e;
    }};
}

test('requirement confirmation blocks renderer menus, native commands and F10 until closed', async () => {
  for (const nativeMenu of [false, true]) {
    const f = menuRuntime(nativeMenu); await new Promise(resolve => setImmediate(resolve));
    for (const id of ['new', 'sidebar', 'history', 'website', 'about', 'quit']) {
      await f.menu.runCommand(id); f.native(id);
    }
    for (const name of ['file', 'view', 'help']) await f.menu.openMenu(name);
    assert.equal(Boolean(f.key('F10').defaultPrevented), false);
    assert.equal(Boolean(f.key('Escape').defaultPrevented), false);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(f.calls, []);
    assert.equal(f.nodes.find(n => n.tagName === 'dialog').open, false);
    f.confirm(false);
    await f.menu.runCommand('new'); f.native('quit'); await f.menu.openMenu('file');
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(f.calls.some(c => c[0] === 'route' && c[1] === 'create'));
    assert.ok(f.calls.some(c => c[0] === 'quit'));
    assert.ok(f.calls.some(c => c[0] === (nativeMenu ? 'native-menu' : 'focus')));
  }
});

test('window-menu stops propagation for its own accelerators so panels.js cannot double-fire', () => {
  const block = windowMenu.match(/const id = \{ n: 'new', b: 'sidebar', q: 'quit' \}\[key\.toLowerCase\(\)\];([\s\S]*?)\n    \}/);
  assert.ok(block, '找不到 window-menu 的 Ctrl 加速键处理块');
  assert.match(
    block[1],
    /event\.preventDefault\(\);\s*event\.stopImmediatePropagation\(\);/,
    '命中 Ctrl+N/B/Q 后必须 stopImmediatePropagation，否则冒泡阶段的 panels.js 会再开「添加需求」窗',
  );
});

test('panels.js Ctrl+N entry only fires in the pet overlay window, never in desk windows', () => {
  const block = panels.match(/if \(\(e\.ctrlKey \|\| e\.metaKey\) && \(e\.key === 'n' \|\| e\.key === 'N'\)\) \{([\s\S]*?)\n  \}/);
  assert.ok(block, '找不到 panels.js 的 Ctrl+N 处理块');
  assert.match(
    block[1],
    /if \(document\.documentElement\.dataset\.deskPanel\) return;/,
    'desk.html 窗口族里 Ctrl+N 归 window-menu（新对话），panels.js 必须让路',
  );
  assert.match(block[1], /openAddEntry/, '桌宠覆盖窗仍需走 openAddEntry 独立窗口入口');
});

test('configured shortcuts own their commands while native menus expose the same actions', () => {
  assert.match(windowMenu, /if \(global\.ShortcutSettings && id !== 'quit'\) return;/, '旧的 Ctrl+N/B 必须让位给当前配置');
  assert.match(windowMenu, /!global\.ShortcutSettings && !chrome\.nativeMenu && event\.altKey/, '菜单 Alt 快捷键修改后不能继续触发旧绑定');
  assert.match(windowMenu, /global\.ShortcutSettings\?\.isRecording\?\.\(\)/, '录入组合键时不能触发窗口菜单动作');
  assert.match(windowMenu, /global\.WindowMenu = \{[\s\S]*openMenu, runCommand: command/);
  assert.match(windowMenu, /api\(\)\.openWindowMenu\(name\)/, '原生菜单模式也能通过可配置快捷键打开菜单');
  assert.match(windowMenu, /soduwork-shortcuts-changed/);
  assert.match(windowMenu, /ShortcutSettings\?\.getBinding\?\.\(id\)/);
});

test('native macOS menus own the sidebar toggle and workspace frames keep the 5px edge', () => {
  assert.match(windowMenuCss, /html\[data-window-native-menu\] \.wm-sidebar\{display:none\}/);
  assert.match(workspaceNavigationCss, /--ws-frame-bottom:5px/);
  assert.match(workspaceNavigationCss, /--ws-frame-right:5px/);
  assert.doesNotMatch(workspaceNavigationCss, /\.ws-canvas\{[^}]*inset:[^}]* 10px /);
  assert.match(workspacePageLayoutCss, /right:var\(--ws-frame-right\)!important/);
  assert.doesNotMatch(workspacePageLayoutCss, /right:(?:10|6)px!important/);
});
