/* Shared fixed command catalog for the renderer and native window menus. */
(function (host, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (host) host.ShortcutBindings = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  const CATEGORIES = [
    { id: 'conversation', label: '对话' }, { id: 'workspace', label: '需求与工作区' },
    { id: 'window', label: '窗口与菜单' }, { id: 'capture', label: '截图' },
  ];
  const definitions = [
    ['new-chat', '新建会话', 'Ctrl+N', 'conversation'],
    ['focus-composer', '聚焦对话输入框', 'Ctrl+L', 'conversation'],
    ['send-message', '发送消息', 'Ctrl+Enter', 'conversation', '在当前对话中发送已填写的内容'],
    ['open-home', '打开主页', 'Ctrl+Shift+H', 'workspace'],
    ['open-task-pool', '打开需求池', 'Ctrl+Shift+G', 'workspace'],
    ['new-requirement', '新建需求', 'Ctrl+Alt+N', 'workspace'],
    ['open-acceptance', '打开待验收', 'Ctrl+Shift+A', 'workspace'],
    ['open-plugins', '打开插件', 'Ctrl+Shift+P', 'workspace'],
    ['open-schedules', '打开自动化', 'Ctrl+Shift+U', 'workspace'],
    ['open-library', '打开资料库', 'Ctrl+Shift+L', 'workspace'],
    ['focus-search', '聚焦当前页面搜索', 'Ctrl+K', 'window'],
    ['open-global-search', '打开全局搜索', 'Ctrl+Shift+F', 'window'],
    ['toggle-sidebar', '显示 / 隐藏侧栏', 'Ctrl+B', 'window'],
    ['menu-file', '文件菜单', 'Alt+F', 'window'],
    ['menu-view', '视图菜单', 'Alt+V', 'window'],
    ['menu-help', '帮助菜单', 'Alt+H', 'window'],
    ['open-settings', '打开设置', 'Ctrl+O', 'window'],
    ['open-shortcuts', '打开快捷键设置', 'Ctrl+Alt+K', 'window'],
    ['open-about', '关于 SoduWork', 'F1', 'window'],
    ['capture-window', '截图与标注', 'Ctrl+Alt+S', 'capture', '框选屏幕区域，标注后复制或保存'],
    ['copy-screenshot', '复制当前窗口截图', 'Ctrl+Alt+C', 'capture', '截取当前 SoduWork 窗口，直接复制到剪贴板'],
  ];
  const DEFAULT_SHORTCUTS = Object.freeze(definitions.map(([id, title, binding, category, description = '']) =>
    Object.freeze({ id, title, binding, category, description, scope: 'app', runtime: true, editable: true,
      ...(id === 'capture-window' ? { capture: 'edit' } : id === 'copy-screenshot' ? { capture: 'copy' } : {}) })));
  const RESERVED_SHORTCUTS = [
    ['Ctrl+Q', '退出 SoduWork'], ['Alt+F4', '关闭窗口'], ['Alt+Tab', '系统切换窗口'], ['Alt+Shift+Tab', '系统切换窗口'], ['Ctrl+Shift+X', '桌宠应急操作'],
    ['Ctrl+Shift+R', '重新加载桌宠'], ['F10', '窗口菜单导航'],
    ['Ctrl+C', '复制'], ['Ctrl+V', '粘贴'], ['Ctrl+X', '剪切'], ['Ctrl+A', '全选'],
    ['Ctrl+Z', '撤销'], ['Ctrl+Y', '重做'], ['Ctrl+Shift+Z', '重做'],
  ].map(([binding, title]) => ({ id: 'reserved-' + binding, title, binding, scope: 'app', reserved: true }));
  const modifiers = ['Ctrl', 'Alt', 'Shift', 'Meta'];
  const aliases = { control: 'Ctrl', ctrl: 'Ctrl', commandorcontrol: 'Ctrl', cmdorctrl: 'Ctrl',
    command: 'Ctrl', cmd: 'Ctrl', meta: 'Meta', option: 'Alt', alt: 'Alt', shift: 'Shift' };
  const keys = { space: 'Space', spacebar: 'Space', esc: 'Escape', escape: 'Escape', return: 'Enter', enter: 'Enter',
    del: 'Delete', delete: 'Delete', ins: 'Insert', backspace: 'Backspace', tab: 'Tab',
    left: 'ArrowLeft', arrowleft: 'ArrowLeft', right: 'ArrowRight', arrowright: 'ArrowRight',
    up: 'ArrowUp', arrowup: 'ArrowUp', down: 'ArrowDown', arrowdown: 'ArrowDown',
    comma: ',', period: '.', slash: '/', minus: '-', equal: '=', semicolon: ';', quote: "'", backquote: '`',
    bracketleft: '[', bracketright: ']', backslash: '\\', home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown' };
  function normalizeCombo(value) {
    const parts = (Array.isArray(value) ? value.join('+') : String(value || '')).split('+').map(v => v.trim()).filter(Boolean);
    const mods = [], bases = [];
    for (const part of parts) {
      const mod = aliases[part.toLowerCase()];
      if (mod) { if (!mods.includes(mod)) mods.push(mod); }
      else { const base = keys[part.toLowerCase()] || (part.length === 1 || /^f\d{1,2}$/i.test(part) ? part.toUpperCase() : part); if (!bases.includes(base)) bases.push(base); }
    }
    if (bases.length !== 1 || !/^(?:[A-Z0-9,./;\x27`\[\]\\=\-]|F(?:[1-9]|1[0-9]|2[0-4])|Space|Escape|Enter|Delete|Insert|Backspace|Tab|Arrow(?:Left|Right|Up|Down)|Home|End|PageUp|PageDown)$/.test(bases[0])) return '';
    return [...modifiers.filter(mod => mods.includes(mod)), ...bases].join('+');
  }
  function comboFromKeyEvent(event) {
    if (event?.getModifierState?.('AltGraph')) return '';
    const key = String(event?.key || '');
    if (!key || ['Control', 'Alt', 'Shift', 'Meta', 'OS', 'CapsLock'].includes(key)) return '';
    const mods = [];
    if (event.ctrlKey || event.metaKey) mods.push('Ctrl');
    if (event.altKey) mods.push('Alt');
    if (event.shiftKey) mods.push('Shift');
    const code = String(event.code || '');
    const punctuation = { Comma: ',', Period: '.', Slash: '/', Minus: '-', Equal: '=', Semicolon: ';', Quote: "'", Backquote: '`', BracketLeft: '[', BracketRight: ']', Backslash: '\\' };
    const base = /^Key[A-Z]$/.test(code) && (event.ctrlKey || event.metaKey || event.altKey) ? code.slice(3)
      : /^Digit[0-9]$/.test(code) ? code.slice(5) : punctuation[code] || (key === ' ' ? 'Space' : key);
    return normalizeCombo([...mods, base]);
  }
  function bindingError(value, platform = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform) ? 'mac' : typeof process !== 'undefined' && process.platform === 'darwin' ? 'mac' : 'win') {
    if (!value) return '';
    const normalized = normalizeCombo(value);
    if (!normalized) return '请按下一个完整的组合键';
    if (platform === 'mac' && ['Ctrl+W', 'Ctrl+H', 'Ctrl+Alt+H'].includes(normalized)) return '该快捷键由 macOS 窗口菜单使用，请选择其他组合';
    const parts = normalized.split('+'), base = parts.filter(p => !modifiers.includes(p));
    if (base.length !== 1) return '请按下一个完整的组合键';
    if (parts.includes('Shift') && /^\d$/.test(base[0])) return '不支持 Shift + 数字组合，容易受输入法影响，请改用字母组合';
    if (parts.includes('Meta')) return '请选择 Ctrl、Alt 或 Shift 组合键';
    if (['Escape', 'Backspace', 'Delete', 'Tab', 'Enter', 'Space'].includes(base[0]) && parts.length === 1) return '请搭配 Ctrl、Alt 或 Shift，保留普通输入操作';
    if (!parts.some(p => ['Ctrl', 'Alt'].includes(p)) && !/^F(?:[1-9]|1[0-9]|2[0-4])$/.test(base[0])) return '请搭配 Ctrl 或 Alt，避免影响输入';
    const reserved = RESERVED_SHORTCUTS.find(row => row.binding === normalizeCombo(value));
    return reserved ? '该快捷键用于“' + reserved.title + '”，请选择其他组合' : '';
  }
  function displayCombo(value, platform) {
    return normalizeCombo(value).split('+').filter(Boolean).map(part => platform === 'mac' && part === 'Ctrl' ? '⌘' : platform === 'mac' && part === 'Alt' ? '⌥' : part).join(' + ') || '未设置';
  }
  function findConflicts(rows, id, binding) {
    const current = rows.find(row => row.id === id), combo = normalizeCombo(binding ?? current?.binding);
    return !current || !combo ? [] : [...rows, ...RESERVED_SHORTCUTS].filter(row => row.id !== id && row.scope === current.scope && normalizeCombo(row.binding) === combo);
  }
  const BINDINGS_VERSION = 1;
  function mergeBindings(defaults, saved, version = 0) {
    return Object.fromEntries(defaults.map(row => {
      const raw = Object.prototype.hasOwnProperty.call(saved || {}, row.id) ? saved[row.id] : row.binding;
      // Old preferences persisted all defaults. Once edited with this catalog,
      // a deliberately assigned Ctrl+, must remain a valid custom binding.
      if (version < 1 && row.id === 'open-settings' && normalizeCombo(raw) === 'Ctrl+,') return [row.id, row.binding];
      // Move the former copy default with the preview default, but retain
      // unrelated custom bindings and intentionally cleared actions.
      if (row.id === 'copy-screenshot' && normalizeCombo(raw) === 'Ctrl+Alt+4' &&
          normalizeCombo(saved?.['capture-window']) === 'Ctrl+Shift+4') return [row.id, row.binding];
      return [row.id, typeof raw !== 'string' || bindingError(raw) ? row.binding : normalizeCombo(raw)];
    }));
  }
  function cloneRows(saved, version = 0) {
    const bindings = mergeBindings(DEFAULT_SHORTCUTS, saved, version);
    return DEFAULT_SHORTCUTS.map(row => ({ ...row, binding: bindings[row.id], defaultBinding: row.binding }));
  }
  function filterRows(rows, options = {}) {
    const q = String(options.query || '').replace(/\s+/g, '').toLowerCase();
    const translate = options.translate || (value => value);
    return rows.filter(row => !q || [row.title, row.description, displayCombo(row.binding), CATEGORIES.find(c => c.id === row.category)?.label]
      .some(value => [value, translate(value || '')].some(text => String(text || '').replace(/\s+/g, '').toLowerCase().includes(q))));
  }
  return { DEFAULT_SHORTCUTS, BINDINGS_VERSION, CATEGORIES, normalizeCombo, comboFromKeyEvent, bindingError, displayCombo, findConflicts, mergeBindings, cloneRows, filterRows };
});
