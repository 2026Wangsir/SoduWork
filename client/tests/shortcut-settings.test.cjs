'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const ShortcutSettings = require('../core/shortcut-bindings.js');

test('settings defaults to Ctrl+O and migrates the old default without losing custom bindings', () => {
  const settings = (saved, version) => ShortcutSettings.cloneRows(saved, version).find(row => row.id === 'open-settings');
  assert.equal(settings().binding, 'Ctrl+O');
  assert.equal(settings({ 'open-settings': 'Ctrl+,' }).binding, 'Ctrl+O');
  assert.equal(settings({ 'open-settings': 'Ctrl+Alt+O' }).binding, 'Ctrl+Alt+O');
  assert.equal(settings({ 'open-settings': '' }).binding, '');
  assert.equal(settings({ 'open-settings': 'Ctrl+,' }, 1).binding, 'Ctrl+,', 'new custom comma binding is retained');
  const rows = ShortcutSettings.cloneRows({ 'open-settings': 'Ctrl+,', 'open-library': 'Ctrl+O' });
  assert.deepEqual(ShortcutSettings.findConflicts(rows, 'open-settings').map(row => row.id), ['open-library']);
});

test('ships one fixed catalog of 21 editable actions with unique usable defaults', () => {
  const rows = ShortcutSettings.cloneRows();
  assert.equal(rows.length, 21);
  assert.equal(new Set(rows.map(row => row.id)).size, rows.length);
  for (const id of ['new-chat', 'focus-composer', 'send-message', 'open-home', 'open-task-pool', 'new-requirement',
    'open-acceptance', 'open-plugins', 'open-schedules', 'open-library', 'focus-search', 'toggle-sidebar',
    'menu-file', 'menu-view', 'menu-help', 'open-settings', 'open-shortcuts', 'open-about', 'capture-window', 'copy-screenshot']) {
    const row = rows.find(item => item.id === id);
    assert.ok(row, id);
    assert.equal(row.editable, true, id);
    assert.equal(row.runtime, true, id);
    assert.equal(row.binding, row.defaultBinding, id);
    assert.equal(ShortcutSettings.bindingError(row.binding), '', id);
    assert.deepEqual(ShortcutSettings.findConflicts(rows, id), [], id);
    assert.ok(ShortcutSettings.CATEGORIES.some(category => category.id === row.category), id);
  }
  assert.equal(ShortcutSettings.exportBindings, undefined, '页面没有导入或导出配置功能');
});

test('shift plus any digit is rejected and old screenshot defaults migrate to letter combinations', () => {
  for (const digit of '0123456789') {
    for (const modifiers of ['Shift', 'Ctrl+Shift', 'Alt+Shift', 'Ctrl+Alt+Shift']) {
      assert.match(ShortcutSettings.bindingError(modifiers + '+' + digit), /Shift.*数字/);
    }
  }
  const rows = ShortcutSettings.cloneRows({ 'capture-window': 'Ctrl+Shift+4', 'copy-screenshot': 'Ctrl+Alt+4' });
  assert.equal(rows.find(r => r.id === 'capture-window').binding, 'Ctrl+Alt+S');
  assert.equal(rows.find(r => r.id === 'copy-screenshot').binding, 'Ctrl+Alt+C');
  assert.equal(ShortcutSettings.cloneRows({ 'new-chat': 'Ctrl+Shift+9' }).find(r => r.id === 'new-chat').binding, 'Ctrl+N');
  assert.equal(ShortcutSettings.cloneRows({ 'copy-screenshot': 'Ctrl+Alt+8' }).find(r => r.id === 'copy-screenshot').binding, 'Ctrl+Alt+8');
  assert.equal(ShortcutSettings.cloneRows({ 'capture-window': '' }).find(r => r.id === 'capture-window').binding, '');
});

test('normalizes and labels shortcut combinations consistently', () => {
  assert.equal(ShortcutSettings.normalizeCombo(' ctrl + shift + k '), 'Ctrl+Shift+K');
  assert.equal(ShortcutSettings.normalizeCombo('CommandOrControl+Shift+4'), 'Ctrl+Shift+4');
  assert.equal(ShortcutSettings.displayCombo('Ctrl+Shift+4', 'win'), 'Ctrl + Shift + 4');
  assert.equal(ShortcutSettings.comboFromKeyEvent({ ctrlKey: true, shiftKey: true, altKey: false, metaKey: false, key: 'k' }), 'Ctrl+Shift+K');
  assert.equal(ShortcutSettings.comboFromKeyEvent({ ctrlKey: true, shiftKey: false, altKey: false, metaKey: false, key: 'Control' }), '');
  assert.equal(ShortcutSettings.comboFromKeyEvent({ ctrlKey: true, shiftKey: true, key: '$', code: 'Digit4' }), 'Ctrl+Shift+4');
  assert.equal(ShortcutSettings.comboFromKeyEvent({ ctrlKey: true, shiftKey: true, key: '(', code: 'Digit9' }), 'Ctrl+Shift+9');
  assert.equal(ShortcutSettings.normalizeCombo('option+command+k'), 'Ctrl+Alt+K');
  assert.equal(ShortcutSettings.displayCombo('Ctrl+Alt+K', 'mac'), '⌘ + ⌥ + K');
  assert.equal(ShortcutSettings.comboFromKeyEvent({ metaKey: true, key: 'n', code: 'KeyN' }), 'Ctrl+N');
  assert.equal(ShortcutSettings.comboFromKeyEvent({ ctrlKey: true, shiftKey: true, key: '?', code: 'Slash' }), 'Ctrl+Shift+/');
  assert.equal(ShortcutSettings.comboFromKeyEvent({ ctrlKey: true, shiftKey: true, key: '+', code: 'Equal' }), 'Ctrl+Shift+=');
  assert.equal(ShortcutSettings.normalizeCombo('F24'), 'F24');
});

test('rejects malformed key combinations instead of persisting unusable shortcuts', () => {
  for (const combo of ['Ctrl', 'Alt+Shift', 'Ctrl+N+B', 'Ctrl+NotARealKey', 'F0', 'F25', 'Ctrl+Unidentified', 'Ctrl+🎉']) {
    assert.equal(ShortcutSettings.normalizeCombo(combo), '', combo);
    assert.notEqual(ShortcutSettings.bindingError(combo), '', combo);
  }
  assert.equal(ShortcutSettings.normalizeCombo(''), '');
  assert.equal(ShortcutSettings.bindingError(''), '', '清空绑定仍是有效操作');
});

test('uses letter key codes when macOS Option produces a composed symbol', () => {
  assert.equal(ShortcutSettings.comboFromKeyEvent({ metaKey: true, altKey: true, key: '˜', code: 'KeyN' }), 'Ctrl+Alt+N');
  assert.equal(ShortcutSettings.comboFromKeyEvent({ metaKey: true, altKey: true, key: '˚', code: 'KeyK' }), 'Ctrl+Alt+K');
});

test('AltGraph character input is not normalized into a Ctrl+Alt shortcut', () => {
  for (const [key, code] of [['ś', 'KeyS'], ['ń', 'KeyN'], ['ć', 'KeyC']]) {
    const event = { key, code, ctrlKey: true, altKey: true,
      getModifierState: modifier => modifier === 'AltGraph' };
    assert.equal(ShortcutSettings.comboFromKeyEvent(event), '', key);
    assert.equal(ShortcutSettings.comboFromKeyEvent({ ...event, getModifierState: () => false }), 'Ctrl+Alt+' + code.slice(3));
  }
});

test('protects text entry and reserved application or operating-system actions', () => {
  for (const combo of ['A', 'Shift+N', 'Enter', 'Space', 'Escape', 'Tab', 'Backspace', 'Delete', 'Meta+N']) {
    assert.notEqual(ShortcutSettings.bindingError(combo), '', combo);
  }
  for (const combo of ['Ctrl+Q', 'Alt+F4', 'F10', 'Ctrl+C', 'Ctrl+V', 'Ctrl+X', 'Ctrl+A', 'Ctrl+Z', 'Ctrl+Y', 'Ctrl+Shift+Z', 'Ctrl+Shift+R', 'Ctrl+Shift+X']) {
    assert.match(ShortcutSettings.bindingError(combo), /该快捷键用于/, combo);
  }
  for (const combo of ['F1', 'Ctrl+Enter', 'Ctrl+,', 'Alt+F', 'Ctrl+Alt+9']) {
    assert.equal(ShortcutSettings.bindingError(combo), '', combo);
  }
});

test('reserves native macOS menu accelerators only on macOS', () => {
  for (const combo of ['Ctrl+W', 'Ctrl+H', 'Ctrl+Alt+H']) {
    assert.notEqual(ShortcutSettings.bindingError(combo, 'mac'), '', combo);
    assert.equal(ShortcutSettings.bindingError(combo, 'win'), '', combo);
  }
  for (const combo of ['Ctrl+Alt+N', 'Ctrl+Alt+K', 'Alt+F']) assert.equal(ShortcutSettings.bindingError(combo, 'mac'), '', combo);
});

test('finds conflicts only inside the same scope and ignores empty bindings', () => {
  const rows = [
    { id: 'new-chat', scope: 'app', binding: 'Ctrl+N' },
    { id: 'focus-chat', scope: 'app', binding: 'Ctrl+N' },
    { id: 'global-capture', scope: 'global', binding: 'Ctrl+N' },
    { id: 'unassigned', scope: 'app', binding: '' },
  ];
  assert.deepEqual(ShortcutSettings.findConflicts(rows, 'new-chat').map(row => row.id), ['focus-chat']);
  assert.deepEqual(ShortcutSettings.findConflicts(rows, 'global-capture').map(row => row.id), []);
  assert.deepEqual(ShortcutSettings.findConflicts(rows, 'unassigned'), []);
  assert.deepEqual(ShortcutSettings.findConflicts(rows, 'missing', 'Ctrl+N'), []);
  assert.equal(ShortcutSettings.findConflicts(rows, 'focus-chat', 'Ctrl+Q')[0].title, '退出 SoduWork');
  assert.equal(ShortcutSettings.findConflicts(rows, 'focus-chat', 'Ctrl+Q')[0].reserved, true);
  assert.deepEqual(ShortcutSettings.findConflicts(rows, 'new-chat', ' control + n ').map(row => row.id), ['focus-chat']);
});

test('merges saved bindings without losing newly added defaults', () => {
  const defaults = [{ id: 'new-chat', binding: 'Ctrl+N' }, { id: 'capture-window', binding: 'Ctrl+Alt+S' }];
  const saved = { 'new-chat': 'Alt+N', removed: 'Ctrl+R' };
  assert.deepEqual(ShortcutSettings.mergeBindings(defaults, saved), {
    'new-chat': 'Alt+N',
    'capture-window': 'Ctrl+Alt+S',
  });
  assert.equal(ShortcutSettings.cloneRows({ 'new-chat': 'Ctrl+J' }).find(row => row.id === 'new-chat').binding, 'Ctrl+J');
  assert.equal(ShortcutSettings.cloneRows({ 'capture-window': 'Ctrl+Shift+R' }).find(row => row.id === 'capture-window').binding, 'Ctrl+Alt+S');
  assert.equal(ShortcutSettings.cloneRows({ 'new-chat': '' }).find(row => row.id === 'new-chat').binding, '');
  for (const invalid of ['Ctrl+Q', 'Ctrl+NotARealKey', 'Ctrl+N+B', 'Ctrl', 'a']) {
    assert.equal(ShortcutSettings.cloneRows({ 'new-chat': invalid }).find(row => row.id === 'new-chat').binding, 'Ctrl+N', invalid);
  }
  for (const invalid of [null, false, 0, { key: 'N' }, ['Ctrl', 'N']]) {
    assert.equal(ShortcutSettings.cloneRows({ 'new-chat': invalid }).find(row => row.id === 'new-chat').binding, 'Ctrl+N', JSON.stringify(invalid));
  }
  assert.equal(ShortcutSettings.cloneRows({ 'removed-action': 'Alt+N' }).some(row => row.id === 'removed-action'), false);
});

test('searches actions, descriptions, key combinations and inline category labels without mutating rows', () => {
  const rows = ShortcutSettings.cloneRows(), before = JSON.stringify(rows);
  assert.deepEqual(ShortcutSettings.filterRows(rows, { query: '截图' }).map(row => row.id), ['capture-window', 'copy-screenshot']);
  assert.deepEqual(ShortcutSettings.filterRows(rows, { query: 'Ctrl + Alt + S' }).map(row => row.id), ['capture-window']);
  assert.deepEqual(ShortcutSettings.filterRows(rows, { query: '窗口与菜单' }).map(row => row.id), rows.filter(row => row.category === 'window').map(row => row.id));
  assert.deepEqual(ShortcutSettings.filterRows(rows, { query: '发送已填写的内容' }).map(row => row.id), ['send-message']);
  assert.equal(ShortcutSettings.filterRows(rows, { query: '不存在的命令' }).length, 0);
  assert.equal(ShortcutSettings.filterRows(rows, { query: ' ' }).length, rows.length);
  assert.equal(JSON.stringify(rows), before);
});

test('cloned rows retain immutable defaults for per-action and full reset', () => {
  const customized = ShortcutSettings.cloneRows({ 'new-chat': 'Alt+N', 'menu-file': 'Ctrl+Alt+F', 'toggle-sidebar': '' });
  customized.find(row => row.id === 'new-chat').binding = 'Alt+J';
  assert.equal(customized.find(row => row.id === 'new-chat').defaultBinding, 'Ctrl+N');
  assert.equal(customized.find(row => row.id === 'menu-file').binding, 'Ctrl+Alt+F');
  assert.equal(customized.find(row => row.id === 'toggle-sidebar').binding, '');
  const reset = ShortcutSettings.cloneRows();
  assert.equal(reset.find(row => row.id === 'new-chat').binding, 'Ctrl+N');
  assert.equal(reset.find(row => row.id === 'menu-file').binding, 'Alt+F');
  assert.equal(reset.find(row => row.id === 'toggle-sidebar').binding, 'Ctrl+B');
  assert.equal(ShortcutSettings.DEFAULT_SHORTCUTS.find(row => row.id === 'new-chat').binding, 'Ctrl+N');
});
