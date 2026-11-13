(function (host, factory) {
  const model = typeof module !== 'undefined' && module.exports ? require('../../core/shortcut-bindings.js') : host.ShortcutBindings;
  const api = factory(host, model);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (host) host.ShortcutSettings = api;
})(typeof window !== 'undefined' ? window : globalThis, function (host, model) {
  'use strict';
  const { CATEGORIES, normalizeCombo, displayCombo, comboFromKeyEvent, bindingError, findConflicts, cloneRows, filterRows } = model;
  function dataUrlToBytes(value) {
    const match = String(value || '').match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/);
    if (!match) throw new Error('截图数据不是有效的 PNG');
    const binary = typeof atob === 'function' ? atob(match[1]) : Buffer.from(match[1], 'base64').toString('binary');
    return Uint8Array.from(binary, char => char.charCodeAt(0));
  }
  const api = { ...model, dataUrlToBytes };
  if (typeof document === 'undefined') return api;
  let root, state, bound = false, capturing = false;
  const t = (text, values = {}) => String(host.SoduWorkI18n?.translateText(text) ?? text)
    .replace(/\{(\w+)\}/g, (token, name) => values[name] ?? token);
  const localizedError = combo => {
    const error = bindingError(combo), reserved = /^该快捷键用于“(.+)”，请选择其他组合$/.exec(error);
    return reserved ? t('该快捷键用于“{title}”，请选择其他组合', { title: t(reserved[1]) }) : t(error);
  };
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const getCfg = () => {
    if (typeof Store !== 'undefined' && Store?._cfg) return Store._cfg;
    if (typeof cfg === 'object' && cfg) return cfg;
    return host.cfg || {};
  };
  const configuredRows = () => cloneRows(getCfg().shortcutBindings, getCfg().shortcutBindingsVersion);
  const platform = () => /Mac/i.test(navigator.platform || '') ? 'mac' : 'win';
  const visible = el => el && !el.disabled && !el.closest('[hidden],[inert]') && el.getClientRects().length > 0;
  const menu = () => host.DesktopWindowMenu || host.WindowMenu;
  const focusRow = id => root?.querySelector('[data-shortcut-row="' + id + '"] [data-shortcut-edit]')?.focus();
  const route = (name, payload = {}) => host.WorkspaceHost?.open(name, payload);
  function status(message = '', tone = '') {
    const live = root?.querySelector('[data-shortcut-status]');
    if (live) { live.textContent = t(message); live.dataset.tone = tone; live.hidden = !message; }
  }
  function notify(message, tone) {
    status(message, tone);
    if (!root?.classList.contains('show')) {
      const say = host.petSay || (typeof petSay === 'function' ? petSay : null);
      say?.(t(message));
    }
  }
  function syncMenu() {
    // Damaged/older preferences must not let a native accelerator bypass the
    // same collision checks used by renderer dispatch.
    const bindings = Object.fromEntries(state.rows.map(row => [row.id, findConflicts(state.rows, row.id).length ? '' : row.binding]));
    const result = host.soduWorkAPI?.setWindowShortcuts?.({ bindings, recording: !!state.editingId });
    if (result?.catch) result.catch(() => status('窗口菜单同步失败，请重新打开窗口后重试。', 'error'));
    if (host.CustomEvent) host.dispatchEvent(new host.CustomEvent('soduwork-shortcuts-changed'));
  }
  function persist() {
    getCfg().shortcutBindings = Object.fromEntries(state.rows.map(row => [row.id, row.binding]));
    getCfg().shortcutBindingsVersion = model.BINDINGS_VERSION;
    if (typeof Store !== 'undefined' && typeof Store.saveCfg === 'function') Store.saveCfg();
    else host.saveCfg?.();
    syncMenu();
  }
  function rowMarkup(row) {
    const editing = state.editingId === row.id, combo = editing ? state.draft : row.binding;
    const conflicts = findConflicts(state.rows, row.id, combo), error = editing ? localizedError(combo) : '';
    const keycaps = combo ? displayCombo(combo, platform()).split(' + ').map(part => '<kbd class="shortcut-keycap">' + esc(part) + '</kbd>').join('<span class="shortcut-plus">+</span>') : '<span class="shortcut-unset">' + esc(t(editing ? '按下组合键…' : '未设置')) + '</span>';
    return '<article class="shortcut-row' + (editing ? ' is-editing' : '') + (conflicts.length ? ' has-conflict' : '') + '" data-shortcut-row="' + row.id + '">' +
      '<div class="shortcut-row-main"><div class="shortcut-row-title">' + esc(t(row.title)) + '</div>' + (row.description ? '<p>' + esc(t(row.description)) + '</p>' : '') + '</div>' +
      '<div class="shortcut-row-binding"><button type="button" class="shortcut-binding-button' + (editing ? ' shortcut-recorder' : '') + '" ' + (editing ? 'data-shortcut-recorder' : 'data-shortcut-edit') + ' aria-label="' + esc(t(editing ? '录入 {title}' : '修改 {title}', { title: t(row.title) })) + '" title="' + esc(t(editing ? '按下组合键，Esc 取消，Backspace 清空' : '点击修改快捷键')) + '">' + keycaps + '</button></div>' +
      '<div class="shortcut-row-actions">' + (editing ? '<button type="button" class="shortcut-btn shortcut-btn-primary" data-shortcut-save>' + esc(t('保存')) + '</button><button type="button" class="shortcut-btn" data-shortcut-cancel>' + esc(t('取消')) + '</button>' : (row.binding !== row.defaultBinding ? '<button type="button" class="shortcut-btn shortcut-btn-quiet" data-shortcut-restore title="' + esc(t('恢复 {binding}', { binding: displayCombo(row.defaultBinding, platform()) })) + '">' + esc(t('恢复默认')) + '</button>' : '')) + '</div>' +
      (editing ? '<div class="shortcut-edit-hint">' + esc(t('按下组合键 · Backspace 清空 · Esc 取消')) + '</div>' : '') +
      (error || conflicts.length ? '<div class="shortcut-conflict" role="alert"><span>' + esc(error || t('与“{title}”冲突', { title: conflicts.map(item => t(item.title)).join(', ') })) + '</span>' + (editing && !error && conflicts.every(item => !item.reserved) ? '<button type="button" class="shortcut-btn" data-shortcut-replace>' + esc(t('移用于此处')) + '</button>' : '') + '</div>' : '') + '</article>';
  }
  function render() {
    if (!root || !state) return;
    const rows = filterRows(state.rows, { query: state.query, translate: t });
    root.querySelector('[data-shortcut-list]').innerHTML = rows.length ? CATEGORIES.map(category => {
      const items = rows.filter(row => row.category === category.id);
      return items.length ? '<section class="shortcut-group" aria-labelledby="shortcut-group-' + category.id + '"><h2 class="shortcut-group-title" id="shortcut-group-' + category.id + '">' + esc(t(category.label)) + '</h2>' + items.map(rowMarkup).join('') + '</section>' : '';
    }).join('') : '<div class="shortcut-empty">' + esc(t('没有匹配的快捷键，试试其他关键词。')) + '</div>';
    root.querySelector('[data-shortcut-search]').value = state.query;
  }
  function setEditing(id, draft) {
    const row = state.rows.find(item => item.id === id);
    if (!row) return;
    state.editingId = id; state.draft = draft ?? row.binding;
    syncMenu(); render(); status();
    root.querySelector('[data-shortcut-row="' + id + '"] [data-shortcut-recorder]')?.focus();
  }
  function cancelEditing() {
    const id = state.editingId;
    state.editingId = ''; state.draft = ''; syncMenu(); render(); status(); focusRow(id);
  }
  function saveEditing(replace) {
    const row = state.rows.find(item => item.id === state.editingId);
    if (!row) return;
    const error = localizedError(state.draft), conflicts = findConflicts(state.rows, row.id, state.draft);
    if (error) { status(error, 'error'); return; }
    if (conflicts.some(item => item.reserved) || (conflicts.length && !replace)) {
      status('此组合键已被使用，请更换，或选择“移用于此处”。', 'error'); return;
    }
    if (replace) conflicts.forEach(item => { item.binding = ''; });
    row.binding = normalizeCombo(state.draft); state.editingId = ''; state.draft = '';
    persist(); render(); focusRow(row.id); status(t('已保存“{title}”的快捷键。', { title: t(row.title) }), 'success');
  }
  async function capture(mode, options) {
    if (capturing) return null;
    capturing = true;
    try {
      if (mode !== 'copy') {
        if (!host.soduWorkAPI?.startScreenshot) throw new Error('请重启客户端以使用区域截图');
        const result = await host.soduWorkAPI.startScreenshot({ hideOwner: options?.hideOwner === true });
        if (!result?.ok) throw new Error(result?.error || '截图未能启动，请重试');
        if (!result.cancelled) notify(result.action === 'save' ? '截图已保存。' : '截图已复制，可在输入框粘贴。', 'success');
        return result;
      }
      if (!host.soduWorkAPI?.capturePage) throw new Error('当前客户端暂不支持窗口截图');
      const dataUrl = await host.soduWorkAPI.capturePage(), bytes = dataUrlToBytes(dataUrl);
      if (!await copyScreenshot(bytes)) return null;
      return bytes;
    } catch (error) { notify(String(error.message || error), 'error'); return null; }
    finally { capturing = false; }
  }
  async function copyScreenshot(bytes) {
    try {
      const session = host.soduWorkAPI?.conversationSession || host.soduWorkAPI?.piSession;
      if (typeof session?.copyImage === 'function') {
        const result = await session.copyImage(bytes);
        if (result?.ok === false) throw new Error(result.reason || '系统剪贴板暂不可用');
      } else {
        if (!navigator.clipboard?.write || !host.ClipboardItem) throw new Error('系统剪贴板暂不可用');
        await navigator.clipboard.write([new host.ClipboardItem({ 'image/png': new Blob([bytes], { type: 'image/png' }) })]);
      }
      notify('截图已复制到剪贴板。', 'success'); return true;
    } catch (error) { notify(String(error.message || error), 'error'); return false; }
  }
  function composer() { return ['nchatInput', 'cpInput'].map(id => document.getElementById(id)).find(visible); }
  function searchInput() { return Array.from(document.querySelectorAll('input[type="search"],input[placeholder*="搜索"],input[aria-label*="搜索"]')).find(visible); }
  function execute(row) {
    const routes = { 'open-home': ['create'], 'open-task-pool': ['history'], 'new-requirement': ['history', { createRequirement: true }],
      'open-acceptance': ['history', { phase: 'reviewing' }], 'open-plugins': ['skills'], 'open-schedules': ['schedules'],
      'open-library': ['library'], 'open-settings': ['settings'], 'open-shortcuts': ['shortcuts'] };
    if (routes[row.id]) { route(...routes[row.id]); return; }
    if (row.id.startsWith('menu-')) { menu()?.openMenu(row.id.slice(5)); return; }
    if (row.id === 'new-chat') {
      if (menu()?.runCommand) menu().runCommand('new'); else route('create', host.WorkspaceShell?.newSessionPayload?.() || { newSession: true });
      return;
    }
    if (row.id === 'toggle-sidebar') { menu()?.toggleSidebar(); return; }
    if (row.id === 'open-about') { menu()?.runCommand('about'); return; }
    if (row.id === 'focus-search') { searchInput()?.focus(); return; }
    if (row.id === 'open-global-search') { host.SoduWorkGlobalSearch?.open(); return; }
    if (row.id === 'focus-composer') { composer()?.focus(); return; }
    if (row.id === 'send-message') {
      const input = composer();
      if (input?.id === 'nchatInput') host.NativeChat?.send();
      else if (input?.id === 'cpInput') { const button = document.getElementById('cpGo'); if (visible(button)) button.click(); }
      return;
    }
    if (row.capture) void capture(row.capture);
  }
  function onKeydown(event) {
    if (host.SoduWorkGlobalSearch?.isOpen()) return;
    if (host.RequirementConfirm?.isOpen?.()) return;
    if (!state || event.isComposing || event.repeat) return;
    if (state.editingId) {
      if (!root.classList.contains('show')) { cancelEditing(); return; }
      if (event.key === 'Tab' && !event.ctrlKey && !event.metaKey && !event.altKey) return;
      const plain = !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
      if (plain && event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); cancelEditing(); return; }
      const clear = plain && ['Backspace', 'Delete'].includes(event.key), combo = clear ? '' : comboFromKeyEvent(event);
      if (!clear && !combo) return;
      if (plain && ['Enter', ' '].includes(event.key) && !event.target?.hasAttribute?.('data-shortcut-recorder')) return;
      event.preventDefault(); event.stopImmediatePropagation(); state.draft = combo; render();
      root.querySelector('[data-shortcut-row="' + state.editingId + '"] [data-shortcut-recorder]')?.focus(); return;
    }
    if (event.defaultPrevented) return;
    const combo = comboFromKeyEvent(event), row = state.rows.find(item => item.binding && item.binding === combo);
    if (!row || findConflicts(state.rows, row.id).length || menu()?.usesNativeAccelerator?.(row.id)) return;
    if (row.id === 'focus-search' && !searchInput()) return;
    if (['focus-composer', 'send-message'].includes(row.id) && (!composer() || Array.from(document.querySelectorAll('dialog[open],[aria-modal="true"]')).some(visible))) return;
    event.preventDefault(); event.stopImmediatePropagation(); execute(row);
  }
  function bind() {
    if (bound || !root) return;
    bound = true;
    root.addEventListener('click', event => {
      const target = event.target.closest('[data-shortcut-edit],[data-shortcut-save],[data-shortcut-cancel],[data-shortcut-restore],[data-shortcut-replace],[data-shortcut-reset-all]');
      if (!target) return;
      const has = name => target.dataset[name] != null, id = target.closest('[data-shortcut-row]')?.dataset.shortcutRow;
      if (has('shortcutEdit')) { setEditing(id); return; }
      if (has('shortcutCancel')) { cancelEditing(); return; }
      if (has('shortcutSave') || has('shortcutReplace')) { saveEditing(has('shortcutReplace')); return; }
      if (has('shortcutRestore')) {
        const row = state.rows.find(item => item.id === id);
        if (!row) return;
        if (findConflicts(state.rows, id, row.defaultBinding).length) { setEditing(id, row.defaultBinding); return; }
        row.binding = row.defaultBinding; persist(); render(); focusRow(id); status('已恢复默认快捷键。', 'success'); return;
      }
      if (has('shortcutResetAll')) { state.rows = cloneRows(); state.editingId = ''; state.draft = ''; persist(); render(); status('所有快捷键已恢复默认。', 'success'); }
    });
    root.addEventListener('input', event => {
      if (!event.target.matches('[data-shortcut-search]')) return;
      state.query = event.target.value;
      if (state.editingId) { state.editingId = ''; state.draft = ''; syncMenu(); }
      render();
    });
    root.addEventListener('focusin', event => {
      if (!event.target.matches('[data-shortcut-search]') || !state.editingId) return;
      state.editingId = ''; state.draft = ''; syncMenu(); render(); status();
    });
    host.addEventListener('keydown', onKeydown, true);
  }
  function open() {
    root ||= document.getElementById('shortcutsPanel');
    if (!root) return false;
    state ||= { rows: configuredRows(), query: '', editingId: '', draft: '' };
    state.rows = configuredRows();
    root.hidden = false; root.classList.add('show'); bind(); render(); return true;
  }
  function close() {
    if (root) { root.classList.remove('show'); root.hidden = true; }
    if (state?.editingId) { state.editingId = ''; state.draft = ''; syncMenu(); }
  }
  function init() {
    root = document.getElementById('shortcutsPanel');
    state = { rows: configuredRows(), query: '', editingId: '', draft: '' };
    bind(); syncMenu();
  }
  host.openShortcutSettings = open; host.closeShortcutSettings = close;
  host.addEventListener('soduwork-locale-change', () => { render(); status(); });
  host.addEventListener('soduwork-store-hydrated', () => { if (state) { state.rows = configuredRows(); syncMenu(); render(); } });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
  Object.assign(api, { open, close, capture, getRows: () => (state?.rows || configuredRows()).map(row => ({ ...row })),
    execute: id => { const row = (state?.rows || configuredRows()).find(row => row.id === id); if (row) execute(row); },
    getBinding: id => (state?.rows || configuredRows()).find(row => row.id === id)?.binding || '', isRecording: () => !!state?.editingId });
  return api;
});
