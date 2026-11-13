'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const model = fs.readFileSync(path.join(__dirname, '../core/shortcut-bindings.js'), 'utf8');
const source = fs.readFileSync(path.join(__dirname, '../components/settings/shortcut-settings.js'), 'utf8');
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';

function element(tagName = 'DIV') {
  const classes = new Set(), listeners = new Map();
  return {
    tagName, dataset: {}, hidden: false, innerHTML: '', textContent: '', value: '', src: '', listeners,
    classList: {
      add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name),
      toggle(name, on) { if (on) classes.add(name); else classes.delete(name); },
    },
    addEventListener(type, handler) { listeners.set(type, handler); },
    removeAttribute(name) { delete this[name]; },
    focus() { this.focused = true; },
    click() { this.clickCount = (this.clickCount || 0) + 1; },
    scrollIntoView() { this.scrolledIntoView = true; },
    closest() { return null; },
    hasAttribute(name) { return name === 'data-shortcut-recorder' && this.recorder === true; },
    matches(selector) { return selector === '[data-shortcut-search]' && this.search === true; },
    getClientRects() { return this.hidden ? [] : [{}]; },
  };
}

function fixture(options = {}) {
  const root = element('SECTION'); root.hidden = true;
  const list = element(), status = element(), search = element('INPUT'), recorder = element('BUTTON');
  search.search = true; recorder.recorder = true;
  const preview = element('SECTION'), image = element('IMG'); preview.hidden = true; image.hidden = true;
  const nodes = new Map([
    ['[data-shortcut-list]', list], ['[data-shortcut-status]', status], ['[data-shortcut-search]', search],
    ['[data-shortcut-preview-panel]', preview], ['[data-shortcut-preview-image]', image],
  ]);
  root.querySelector = selector => selector.endsWith(' [data-shortcut-recorder]') ? recorder : nodes.get(selector) || null;
  root.querySelectorAll = () => [];
  const keyListeners = [], windowListeners = new Map(), routes = [], captures = [], screenEdits = [], copies = [], menus = [], commands = [],
    sidebar = [], sends = [], nativeSync = [], notifications = [];
  let saveCount = 0;
  const store = { _cfg: options.config || {}, saveCfg() { saveCount += 1; } };
  const chatInput = element('TEXTAREA'), composeInput = element('TEXTAREA'), composeGo = element('BUTTON'), stop = element('BUTTON');
  chatInput.id = 'nchatInput'; composeInput.id = 'cpInput';
  chatInput.hidden = options.composer !== 'chat'; composeInput.hidden = options.composer !== 'compose';
  composeGo.hidden = composeInput.hidden;
  const ids = new Map([['shortcutsPanel', root], ['nchatInput', chatInput], ['cpInput', composeInput], ['cpGo', composeGo], ['nchatSend', stop]]);
  const window = {
    SoduWorkI18n: options.i18n,
    RequirementConfirm: {isOpen: () => Boolean(options.confirmation?.())},
    SoduWorkGlobalSearch: { open: () => commands.push('global-search'), isOpen: () => false },
    addEventListener(type, handler, capture) {
      if (type === 'keydown') keyListeners.push({ handler, capture }); else windowListeners.set(type, handler);
    },
    petSay: message => notifications.push(message),
    soduWorkAPI: {
      async startScreenshot(input) { screenEdits.push(input); return options.editScreen ? options.editScreen() : { ok: true, action: 'copy' }; },
      async capturePage() { captures.push(true); return options.capture ? options.capture() : options.dataUrl || png; },
      async setWindowShortcuts(payload) { nativeSync.push(payload); return { ok: true }; },
      conversationSession: {
        async copyImage(bytes) { copies.push(bytes); return options.copyImage ? options.copyImage(bytes) : { ok: true }; },
      },
    },
    DesktopWindowMenu: {
      openMenu: id => menus.push(id), runCommand: id => commands.push(id), toggleSidebar: () => sidebar.push(true),
      usesNativeAccelerator: id => (options.nativeAccelerators || []).includes(id),
    },
    NativeChat: { send: (...args) => sends.push(args) },
    WorkspaceHost: { open(route, payload) {
      routes.push({ route, payload }); if (route === 'shortcuts') window.ShortcutSettings.open();
    } },
  };
  const document = { readyState: 'complete', getElementById: id => ids.get(id) || null,
    querySelectorAll: selector => selector === 'dialog[open],[aria-modal="true"]'
      ? options.modals || [] : options.searchInputs || [search] };
  const context = vm.createContext({ window, document, Store: store, navigator: { platform: options.platform || 'Win32' }, Buffer });
  vm.runInContext(model, context, { filename: 'shortcut-bindings.js' });
  vm.runInContext(source, context, { filename: 'shortcut-settings.js' });
  function key(properties) {
    const event = {
      key: '', code: '', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false,
      target: element('DIV'), defaultPrevented: false, immediateStopped: false,
      preventDefault() { this.defaultPrevented = true; }, stopImmediatePropagation() { this.immediateStopped = true; }, ...properties,
    };
    for (const listener of keyListeners) { listener.handler(event); if (event.immediateStopped) break; }
    return event;
  }
  function press(combo, extra = {}) {
    const parts = combo.split('+'), keyName = parts.pop(), code = /^[0-9]$/.test(keyName) ? 'Digit' + keyName
      : /^[A-Z]$/.test(keyName) ? 'Key' + keyName : keyName === ',' ? 'Comma' : keyName;
    return key({ key: keyName, code, ctrlKey: parts.includes('Ctrl'), altKey: parts.includes('Alt'), shiftKey: parts.includes('Shift'), ...extra });
  }
  function click(action, rowId) {
    const button = element('BUTTON'), row = element('ARTICLE'); button.dataset[action] = ''; row.dataset.shortcutRow = rowId;
    button.closest = selector => selector === '[data-shortcut-row]' ? row : button;
    root.listeners.get('click')({ target: button });
  }
  function edit(id, combo) { click('shortcutEdit', id); press(combo, { target: recorder }); click('shortcutSave', id); }
  function hydrate(config) { store._cfg = config; windowListeners.get('soduwork-store-hydrated')(); }
  function filter(value) { search.value = value; root.listeners.get('input')({ target: search }); }
  return { api: window.ShortcutSettings, window, root, list, status, search, preview, image, recorder, keyListeners,
    routes, captures, screenEdits, copies, menus, commands, sidebar, sends, nativeSync, notifications, store, key, press, click,
    edit, hydrate, filter, chatInput, composeInput, composeGo, stop, get saveCount() { return saveCount; } };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('shortcut labels and search use the current locale without changing bindings', () => {
  for (const locale of ['en-US', 'ja-JP', 'ko-KR']) {
    const pack = require('../core/locales/' + locale + '-gap-pages.js');
    const f = fixture({ i18n: { translateText: text => pack[text] || text } });
    f.api.open();
    assert.ok(f.list.innerHTML.includes(pack['聚焦对话输入框']));
    assert.ok(!f.list.innerHTML.includes('聚焦对话输入框'));
    f.filter(pack['聚焦对话输入框']);
    assert.ok(f.list.innerHTML.includes('data-shortcut-row="focus-composer"'));
    assert.ok(!f.list.innerHTML.includes('data-shortcut-row="open-home"'));
    assert.equal(f.api.getBinding('focus-composer'), 'Ctrl+L');
    assert.equal(f.saveCount, 0);
  }
});

test('requirement confirmation owns all shortcut keys until its decision is closed', async () => {
  for (const row of fixture().api.DEFAULT_SHORTCUTS) {
    let confirming = true;
    const f = fixture({composer: 'chat', confirmation: () => confirming});
    const blocked = f.press(row.binding); await settle();
    assert.equal(blocked.defaultPrevented, false, row.id + ' must remain available to the confirmation');
    assert.deepEqual([f.routes, f.commands, f.menus, f.sidebar, f.sends, f.captures, f.screenEdits],
      [[], [], [], [], [], [], []], row.id + ' must not act behind confirmation');
    assert.equal(Boolean(f.search.focused || f.chatInput.focused || f.stop.clickCount), false, row.id);
    confirming = false;
    assert.equal(f.press(row.binding).defaultPrevented, true, row.id + ' resumes after confirmation');
    await settle();
  }
});

test('requirement confirmation also owns Escape while a shortcut recorder is open', () => {
  let confirming = false;
  const f = fixture({confirmation: () => confirming});
  f.api.open(); f.click('shortcutEdit', 'new-chat');
  confirming = true;
  assert.equal(f.press('Escape').defaultPrevented, false);
  assert.equal(f.api.isRecording(), true);
  confirming = false;
  assert.equal(f.press('Escape').defaultPrevented, true);
  assert.equal(f.api.isRecording(), false);
});

test('Ctrl+O replaces the former settings default on startup and hydration, with editable reset behavior', () => {
  const f = fixture({ config: { shortcutBindings: { 'open-settings': 'Ctrl+,' } } });
  assert.equal(f.press('Ctrl+O').defaultPrevented, true);
  assert.equal(f.routes.at(-1).route, 'settings');
  assert.equal(f.press('Ctrl+,').defaultPrevented, false);
  assert.equal(f.routes.length, 1);
  f.api.open();
  f.edit('open-settings', 'Ctrl+,');
  f.api.open();
  assert.equal(f.api.getBinding('open-settings'), 'Ctrl+,');
  assert.equal(f.store._cfg.shortcutBindingsVersion, 1);
  f.hydrate(f.store._cfg);
  assert.equal(f.press('Ctrl+,').defaultPrevented, true);
  assert.equal(f.press('Ctrl+O').defaultPrevented, false);
  f.click('shortcutRestore', 'open-settings');
  assert.equal(f.api.getBinding('open-settings'), 'Ctrl+O');
  f.hydrate({ shortcutBindings: { 'open-settings': 'Ctrl+,' } });
  assert.equal(f.api.getBinding('open-settings'), 'Ctrl+O');
});

test('a migrated settings shortcut never takes another saved action silently', () => {
  const f = fixture({ config: { shortcutBindings: { 'open-settings': 'Ctrl+,', 'open-library': 'Ctrl+O' } } });
  assert.equal(f.press('Ctrl+O').defaultPrevented, false);
  assert.equal(f.routes.length, 0);
  assert.equal(f.nativeSync.at(-1).bindings['open-settings'], '');
  assert.equal(f.nativeSync.at(-1).bindings['open-library'], '');
  f.api.open();
  assert.match(f.list.innerHTML, /has-conflict/);
});

test('all 21 fixed commands reach their actual application owner', async () => {
  const expectedRoutes = { 'open-home': 'create', 'open-task-pool': 'history', 'new-requirement': 'history',
    'open-acceptance': 'history', 'open-plugins': 'skills', 'open-schedules': 'schedules', 'open-library': 'library',
    'open-settings': 'settings', 'open-shortcuts': 'shortcuts' };
  const catalog = fixture().api.DEFAULT_SHORTCUTS; assert.equal(catalog.length, 21);
  for (const row of catalog) {
    const f = fixture({ composer: 'chat' }), event = f.press(row.binding); await settle();
    assert.equal(event.defaultPrevented, true, row.id); assert.equal(event.immediateStopped, true, row.id);
    if (expectedRoutes[row.id]) {
      assert.equal(f.routes[0]?.route, expectedRoutes[row.id], row.id);
      if (row.id === 'new-requirement') assert.equal(f.routes[0].payload.createRequirement, true);
      if (row.id === 'open-acceptance') assert.equal(f.routes[0].payload.phase, 'reviewing');
    } else if (row.id.startsWith('menu-')) assert.deepEqual(f.menus, [row.id.slice(5)]);
    else if (row.id === 'new-chat') assert.deepEqual(f.commands, ['new']);
    else if (row.id === 'open-about') assert.deepEqual(f.commands, ['about']);
    else if (row.id === 'toggle-sidebar') assert.equal(f.sidebar.length, 1);
    else if (row.id === 'focus-search') assert.equal(f.search.focused, true);
    else if (row.id === 'open-global-search') assert.deepEqual(f.commands, ['global-search']);
    else if (row.id === 'focus-composer') assert.equal(f.chatInput.focused, true);
    else if (row.id === 'send-message') assert.deepEqual(f.sends, [[]]);
    else if (row.capture) {
      assert.equal(f.captures.length, row.capture === 'copy' ? 1 : 0); assert.equal(f.copies.length, row.capture === 'copy' ? 1 : 0);
      assert.equal(f.screenEdits.length, row.capture === 'edit' ? 1 : 0);
      assert.equal(f.routes.length, 0);
    } else assert.fail('Missing behavioral expectation for ' + row.id);
  }
});

test('grouped list has readable modifier keycaps and no obsolete dashboards or filters', () => {
  for (const platform of ['Win32', 'MacIntel']) {
    const f = fixture({ platform }); f.api.open();
    assert.equal((f.list.innerHTML.match(/class="shortcut-group"/g) || []).length, 4);
    assert.equal((f.list.innerHTML.match(/data-shortcut-row=/g) || []).length, 21);
    assert.match(f.list.innerHTML, platform === 'MacIntel' ? /<kbd class="shortcut-keycap">⌘<\/kbd>/ : /<kbd class="shortcut-keycap">Ctrl<\/kbd>/);
    assert.doesNotMatch(f.list.innerHTML, /系统菜单固定|data-shortcut-filter|data-shortcut-category|data-shortcut-export/);
  }
});

test('new chat, sidebar and all menu commands are editable and old bindings stop dispatching', () => {
  for (const id of ['new-chat', 'toggle-sidebar', 'menu-file', 'menu-view', 'menu-help']) {
    const f = fixture(); f.api.open(); const old = f.api.getBinding(id); f.edit(id, 'Ctrl+Alt+9');
    assert.equal(f.api.getBinding(id), 'Ctrl+Alt+9', id); assert.equal(f.store._cfg.shortcutBindings[id], 'Ctrl+Alt+9');
    assert.equal(f.press(old).defaultPrevented, false, id + ' old key');
    assert.equal(f.press('Ctrl+Alt+9').defaultPrevented, true, id + ' new key');
    assert.equal(f.commands.length + f.sidebar.length + f.menus.length, 1);
    assert.equal(f.nativeSync.at(-1).bindings[id], 'Ctrl+Alt+9'); assert.equal(f.nativeSync.at(-1).recording, false);
  }
});

test('native-owned accelerators are not dispatched a second time by the renderer', () => {
  const f = fixture({ nativeAccelerators: ['new-chat', 'toggle-sidebar'] });
  assert.equal(f.press('Ctrl+N').defaultPrevented, false); assert.equal(f.press('Ctrl+B').defaultPrevented, false);
  assert.deepEqual(f.commands, []); assert.deepEqual(f.sidebar, []);
  assert.equal(f.press('Alt+F').defaultPrevented, true); assert.deepEqual(f.menus, ['file']);
});

test('conflicts require explicit transfer and never dispatch two actions', () => {
  const f = fixture(); f.api.open(); f.edit('new-chat', 'Ctrl+B');
  assert.equal(f.saveCount, 0); assert.equal(f.status.dataset.tone, 'error'); assert.equal(f.api.getBinding('new-chat'), 'Ctrl+N');
  f.click('shortcutReplace', 'new-chat'); assert.equal(f.api.getBinding('toggle-sidebar'), ''); assert.equal(f.api.getBinding('new-chat'), 'Ctrl+B');
  f.press('Ctrl+B'); assert.deepEqual(f.commands, ['new']); assert.deepEqual(f.sidebar, []);
  assert.equal(f.nativeSync.at(-1).bindings['toggle-sidebar'], '');
});

test('restoring an occupied default opens conflict resolution without silently overwriting', () => {
  const f = fixture(); f.api.open(); f.edit('new-chat', 'Ctrl+Alt+9'); f.edit('toggle-sidebar', 'Ctrl+N');
  const saved = f.saveCount; f.click('shortcutRestore', 'new-chat');
  assert.equal(f.api.isRecording(), true); assert.equal(f.saveCount, saved);
  assert.equal(f.api.getBinding('new-chat'), 'Ctrl+Alt+9'); assert.equal(f.api.getBinding('toggle-sidebar'), 'Ctrl+N');
  f.click('shortcutSave', 'new-chat'); assert.equal(f.saveCount, saved); f.click('shortcutReplace', 'new-chat');
  assert.equal(f.api.getBinding('new-chat'), 'Ctrl+N'); assert.equal(f.api.getBinding('toggle-sidebar'), '');
});

test('clear, cancel and individual/all restore keep saved and native recording state consistent', () => {
  const f = fixture(); f.api.open();
  f.click('shortcutEdit', 'new-chat'); f.key({ key: 'Backspace', target: f.recorder }); f.key({ key: 'Escape', target: f.recorder });
  assert.equal(f.api.getBinding('new-chat'), 'Ctrl+N'); assert.equal(f.saveCount, 0);
  assert.equal(f.api.isRecording(), false); assert.equal(f.nativeSync.at(-1).recording, false);
  f.click('shortcutEdit', 'new-chat'); f.key({ key: 'Delete', target: f.recorder }); f.click('shortcutSave', 'new-chat');
  assert.equal(f.api.getBinding('new-chat'), ''); assert.equal(f.press('Ctrl+N').defaultPrevented, false);
  f.click('shortcutRestore', 'new-chat'); assert.equal(f.api.getBinding('new-chat'), 'Ctrl+N');
  f.edit('new-chat', 'Ctrl+Alt+9'); f.edit('menu-file', 'Ctrl+Alt+8'); f.click('shortcutResetAll');
  for (const row of f.api.DEFAULT_SHORTCUTS) assert.equal(f.api.getBinding(row.id), row.binding);
  assert.equal(f.nativeSync.at(-1).recording, false);
});

test('reserved clipboard keys cannot be saved or transferred away from standard editing', () => {
  const f = fixture(); f.api.open(); f.edit('new-chat', 'Ctrl+C');
  assert.equal(f.status.dataset.tone, 'error'); assert.match(f.status.textContent, /复制/); f.click('shortcutReplace', 'new-chat');
  assert.equal(f.api.getBinding('new-chat'), 'Ctrl+N'); assert.equal(f.saveCount, 0);
});

test('hydrated preferences replace startup defaults and synchronize native shortcuts', () => {
  const f = fixture(); f.hydrate({ shortcutBindings: { 'new-chat': 'Ctrl+Alt+9', 'menu-file': '', 'open-task-pool': 'Ctrl+Alt+8' } });
  assert.equal(f.press('Ctrl+N').defaultPrevented, false); assert.equal(f.press('Alt+F').defaultPrevented, false);
  assert.equal(f.press('Ctrl+Alt+9').defaultPrevented, true); assert.deepEqual(f.commands, ['new']);
  f.press('Ctrl+Alt+8'); assert.equal(f.routes[0].route, 'history'); assert.equal(f.nativeSync.at(-1).bindings['new-chat'], 'Ctrl+Alt+9');
  assert.equal(f.saveCount, 0, 'hydration must not overwrite loaded preferences');
});

test('duplicate saved bindings are inert until the user resolves the collision', () => {
  const f = fixture({ config: { shortcutBindings: { 'new-chat': 'Ctrl+B' } } });
  assert.equal(f.press('Ctrl+B').defaultPrevented, false); assert.deepEqual(f.commands, []); assert.deepEqual(f.sidebar, []);
  f.api.open(); assert.match(f.list.innerHTML, /has-conflict/);
  assert.equal(f.nativeSync.at(-1).bindings['new-chat'], '');
  assert.equal(f.nativeSync.at(-1).bindings['toggle-sidebar'], '');
  assert.equal(f.nativeSync.at(-1).bindings['menu-file'], 'Alt+F');
  assert.equal(f.store._cfg.shortcutBindings['new-chat'], 'Ctrl+B', 'native suppression must retain the preference for conflict resolution');
  f.edit('new-chat', 'Ctrl+N');
  assert.equal(f.nativeSync.at(-1).bindings['new-chat'], 'Ctrl+N');
  assert.equal(f.nativeSync.at(-1).bindings['toggle-sidebar'], 'Ctrl+B');
});

test('hydrated collisions suppress every affected native binding without disabling unrelated actions', () => {
  const f = fixture();
  f.hydrate({ shortcutBindings: { 'menu-file': 'Ctrl+N', 'toggle-sidebar': 'Ctrl+N' } });
  for (const id of ['new-chat', 'menu-file', 'toggle-sidebar']) assert.equal(f.nativeSync.at(-1).bindings[id], '');
  assert.equal(f.nativeSync.at(-1).bindings['menu-help'], 'Alt+H');
  assert.equal(f.press('Ctrl+N').defaultPrevented, false);
  f.press('Alt+H'); assert.deepEqual(f.menus, ['help']); assert.equal(f.saveCount, 0);
});

test('focusing search leaves recording before the first typed character and discards the unsaved key', () => {
  const f = fixture(); f.api.open(); f.click('shortcutEdit', 'new-chat');
  f.press('Ctrl+Alt+9', { target: f.recorder });
  f.root.listeners.get('focusin')({ target: f.recorder });
  assert.equal(f.api.isRecording(), true, 'focus within the recording row must not cancel recording');
  f.root.listeners.get('focusin')({ target: f.search });
  assert.equal(f.api.isRecording(), false); assert.equal(f.nativeSync.at(-1).recording, false);
  assert.equal(f.api.getBinding('new-chat'), 'Ctrl+N'); assert.equal(f.saveCount, 0);
  const firstCharacter = f.key({ key: 'a', code: 'KeyA', target: f.search });
  assert.equal(firstCharacter.defaultPrevented, false); assert.equal(firstCharacter.immediateStopped, false);
  f.filter('截图'); assert.equal((f.list.innerHTML.match(/data-shortcut-row=/g) || []).length, 2);
});

test('plain Tab retains focus navigation while Ctrl+Tab can be recorded and Alt+Tab stays reserved', () => {
  const f = fixture(); f.api.open(); f.click('shortcutEdit', 'new-chat');
  for (const shiftKey of [false, true]) {
    const event = f.key({ key: 'Tab', code: 'Tab', shiftKey, target: f.recorder });
    assert.equal(event.defaultPrevented, false); assert.equal(event.immediateStopped, false);
    assert.equal(f.api.isRecording(), true);
  }
  assert.equal(f.press('Ctrl+Tab', { target: f.recorder }).defaultPrevented, true);
  f.click('shortcutSave', 'new-chat'); assert.equal(f.api.getBinding('new-chat'), 'Ctrl+Tab');
  f.press('Ctrl+Tab'); assert.deepEqual(f.commands, ['new']);
  const saved = f.saveCount; f.edit('new-chat', 'Alt+Tab');
  assert.equal(f.status.dataset.tone, 'error'); assert.equal(f.saveCount, saved);
  assert.equal(f.api.getBinding('new-chat'), 'Ctrl+Tab');
});

test('filtering or closing during recording cancels unsaved edits and reenables native bindings', () => {
  const f = fixture(); f.api.open(); f.click('shortcutEdit', 'new-chat'); f.press('Ctrl+Alt+9', { target: f.recorder }); f.filter('截图');
  assert.equal(f.api.isRecording(), false); assert.equal(f.api.getBinding('new-chat'), 'Ctrl+N');
  assert.equal((f.list.innerHTML.match(/data-shortcut-row=/g) || []).length, 2); assert.equal(f.nativeSync.at(-1).recording, false);
  f.filter(''); f.click('shortcutEdit', 'new-chat'); f.api.close();
  assert.equal(f.root.hidden, true); assert.equal(f.api.isRecording(), false); assert.equal(f.nativeSync.at(-1).recording, false); assert.equal(f.saveCount, 0);
});

test('send uses the full NativeChat path and never clicks the stop-generation button', () => {
  const f = fixture({ composer: 'chat' }); f.press('Ctrl+Enter', { target: f.chatInput });
  assert.deepEqual(f.sends, [[]]); assert.equal(f.stop.clickCount, undefined);
  f.api.open(); f.edit('send-message', 'Ctrl+Alt+Enter');
  assert.equal(f.press('Ctrl+Enter', { target: f.chatInput }).defaultPrevented, false); f.press('Ctrl+Alt+Enter', { target: f.chatInput });
  assert.equal(f.sends.length, 2); assert.equal(f.stop.clickCount, undefined);
});

test('new-conversation send uses its existing button and hidden conversations cannot receive shortcuts', () => {
  const f = fixture({ composer: 'compose' }); f.press('Ctrl+Enter', { target: f.composeInput });
  assert.equal(f.composeGo.clickCount, 1); assert.deepEqual(f.sends, []); f.composeInput.hidden = true;
  assert.equal(f.press('Ctrl+Enter').defaultPrevented, false); assert.equal(f.press('Ctrl+L').defaultPrevented, false);
  assert.equal(f.composeGo.clickCount, 1);
});

test('composer shortcuts cannot send behind a modal but resume when the modal is closed', () => {
  for (const composer of ['chat', 'compose']) {
    const modal = element('DIALOG'), f = fixture({ composer, modals: [modal] });
    assert.equal(f.press('Ctrl+Enter').defaultPrevented, false);
    assert.equal(f.press('Ctrl+L').defaultPrevented, false);
    assert.deepEqual(f.sends, []); assert.equal(f.composeGo.clickCount, undefined);
    modal.hidden = true;
    assert.equal(f.press('Ctrl+Enter').defaultPrevented, true);
    assert.equal(composer === 'chat' ? f.sends.length : f.composeGo.clickCount, 1);
    assert.equal(f.press('Ctrl+L').defaultPrevented, true);
    assert.equal(composer === 'chat' ? f.chatInput.focused : f.composeInput.focused, true);
  }
});

test('Mac Option-generated characters use the physical letter key for configured shortcuts', () => {
  const f = fixture({ platform: 'MacIntel' });
  const event = f.key({ metaKey: true, altKey: true, key: '˜', code: 'KeyN' });
  assert.equal(event.defaultPrevented, true);
  assert.equal(f.routes[0].route, 'history'); assert.equal(f.routes[0].payload.createRequirement, true);
});

test('registered screenshot shortcut opens the screen editor without navigation or settings previews', async () => {
  const f = fixture(); assert.equal(f.keyListeners.length, 1); assert.equal(f.keyListeners[0].capture, true);
  const event = f.key({ ctrlKey: true, altKey: true, key: 's', code: 'KeyS' }); await settle();
  assert.equal(event.defaultPrevented, true); assert.equal(event.immediateStopped, true);
  assert.equal(f.screenEdits.length, 1); assert.equal(f.routes.length, 0); assert.equal(f.root.hidden, true);
  assert.equal(f.preview.hidden, true); assert.equal(f.captures.length, 0); assert.equal(f.status.dataset.tone, 'success');
});

test('screen editor cancellation is silent, failures release the guard, and duplicate starts are ignored', async () => {
  let finish; const f = fixture({ editScreen: () => new Promise(resolve => { finish = resolve; }) });
  const pending = f.api.capture('edit'); assert.equal(await f.api.capture('edit'), null);
  assert.equal(f.screenEdits.length, 1); finish({ ok: true, cancelled: true }); await pending;
  assert.equal(f.notifications.length, 0); assert.equal(f.routes.length, 0);
  const retry = f.api.capture('edit'); finish({ ok: false, error: '屏幕权限未开启' }); await retry;
  assert.equal(f.status.textContent, '屏幕权限未开启');
  const third = f.api.capture('edit'); finish({ ok: true, action: 'save' }); await third;
  assert.equal(f.screenEdits.length, 3); assert.equal(f.status.textContent, '截图已保存。');
});

test('only an explicit hide option reaches screenshot IPC and ordinary shortcuts keep the window visible', async () => {
  const f = fixture();
  await f.api.capture('edit', { hideOwner: true });
  await f.api.capture('edit');
  await f.api.capture('edit', { hideOwner: 'true', windowId: 99 });
  assert.deepEqual(f.screenEdits.map(input => input.hideOwner), [true, false, false]);
  assert.ok(f.screenEdits.every(input => Object.keys(input).join() === 'hideOwner'));
});

test('rejected and thrown clipboard writes remain errors without claiming copy success', async () => {
  for (const copyImage of [async () => ({ ok: false, reason: '剪贴板被占用' }), async () => { throw Error('剪贴板被占用'); }]) {
    const f = fixture({ copyImage }); assert.equal(await f.api.capture('copy'), null);
    assert.equal(f.captures.length, 1); assert.equal(f.copies.length, 1); assert.ok(f.copies[0].byteLength > 0);
    assert.equal(f.status.dataset.tone, 'error'); assert.equal(f.status.textContent, '剪贴板被占用');
    assert.deepEqual(f.notifications, ['剪贴板被占用']); assert.equal(f.preview.hidden, true); assert.equal(f.routes.length, 0);
  }
});

test('capture failures release the guard so the next attempt can succeed', async () => {
  let attempts = 0; const f = fixture({ capture: async () => { if (++attempts === 1) throw Error('暂时无法截图'); return png; } });
  assert.equal(await f.api.capture('copy'), null); assert.equal(f.status.dataset.tone, 'error');
  assert.ok((await f.api.capture('copy')).byteLength > 0); assert.equal(f.preview.hidden, true);
});

test('recording shifted digits in Chinese or English cannot save or execute screenshots', async () => {
  for (const key of ['$', '￥', '（']) {
    const f = fixture({ config: { shortcutBindings: { 'capture-window': 'Ctrl+Shift+4' } } });
    f.api.open(); f.click('shortcutEdit', 'capture-window');
    f.key({ ctrlKey: true, shiftKey: true, key, code: 'Digit4', target: f.recorder });
    f.click('shortcutSave', 'capture-window');
    assert.match(f.status.textContent, /Shift.*数字/);
    assert.equal(f.api.getBinding('capture-window'), 'Ctrl+Alt+S');
    assert.equal(f.saveCount, 0); assert.equal(f.captures.length, 0);
    f.click('shortcutCancel');
    assert.equal(f.press('Ctrl+Shift+4').defaultPrevented, false);
    f.press('Ctrl+Alt+S'); await settle();
    assert.equal(f.screenEdits.length, 1); assert.equal(f.preview.hidden, true);
  }
});

test('held, composed and already-handled shortcuts do not dispatch actions', async () => {
  const f = fixture();
  for (const flag of ['repeat', 'isComposing', 'defaultPrevented']) assert.equal(f.press('Ctrl+Alt+S', { [flag]: true }).immediateStopped, false);
  await settle(); assert.equal(f.captures.length, 0);
});

test('AltGraph text input does not dispatch commands or prevent character entry', async () => {
  const runtime = fixture();
  for (const [combo, key] of [['Ctrl+Alt+S', 'ś'], ['Ctrl+Alt+N', 'ń'], ['Ctrl+Alt+C', 'ć']]) {
    const event = runtime.press(combo, { key, getModifierState: modifier => modifier === 'AltGraph' });
    assert.equal(event.defaultPrevented, false, key);
    assert.equal(event.immediateStopped, false, key);
  }
  await settle();
  assert.deepEqual(runtime.routes, []);
  assert.deepEqual(runtime.screenEdits, []);
  assert.deepEqual(runtime.captures, []);
  assert.deepEqual(runtime.copies, []);
});

test('shortcut recording ignores AltGraph text input without changing the draft', () => {
  const runtime = fixture();
  runtime.api.open();
  runtime.click('shortcutEdit', 'new-chat');
  const event = runtime.press('Ctrl+Alt+L', { key: 'ł', target: runtime.recorder,
    getModifierState: modifier => modifier === 'AltGraph' });
  assert.equal(event.defaultPrevented, false);
  assert.equal(event.immediateStopped, false);
  assert.equal(runtime.api.isRecording(), true);
  runtime.click('shortcutSave', 'new-chat');
  assert.equal(runtime.api.getBinding('new-chat'), 'Ctrl+N');
});

test('focus search skips hidden and disabled inputs and does not consume unavailable search', () => {
  const hidden = element('INPUT'), disabled = element('INPUT'), visible = element('INPUT'); hidden.hidden = true; disabled.disabled = true;
  const f = fixture({ searchInputs: [hidden, disabled, visible] });
  assert.equal(f.press('Ctrl+K').defaultPrevented, true); assert.equal(visible.focused, true);
  assert.equal(hidden.focused, undefined); assert.equal(disabled.focused, undefined); visible.hidden = true;
  assert.equal(f.press('Ctrl+K').defaultPrevented, false);
});
