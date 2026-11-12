/* Presentation only: keep plugin actions and authoring state in their existing owners. */
(function (global) {
  'use strict';
  const sections = [['Overview', '概览与流程'], ['Resources', '能力与资源'], ['Quality', '质量与权限']];
  function tabs() {
    return '<nav class="cap-detail-tabs" role="tablist" aria-label="插件详情分区">' + sections.map((entry, i) =>
      '<button type="button" role="tab" id="capDetail' + entry[0] + 'Tab" aria-controls="capDetail' + entry[0] +
      '" aria-selected="' + !i + '" tabindex="' + (i ? -1 : 0) + '">' + entry[1] + '</button>').join('') + '</nav>';
  }
  function visible(element) {
    if (!element.getClientRects().length || getComputedStyle(element).visibility === 'hidden') return false;
    if (element.closest('[hidden]')) return false;
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      if (parent.matches('details:not([open])') && !parent.querySelector(':scope > summary').contains(element)) return false;
    }
    return true;
  }
  function dialog(layer, ctx) {
    if (layer.pluginPresentationCleanup) layer.pluginPresentationCleanup.abort();
    const controller = new AbortController();
    layer.pluginPresentationCleanup = controller;
    const listen = (element, type, callback) => element.addEventListener(type, callback, { signal: controller.signal });
    const modal = layer.querySelector('.cap-modal');
    modal.setAttribute('aria-labelledby', 'capModalTitle');
    modal.setAttribute('aria-describedby', 'capModalSub');
    layer.querySelector('#capModalBody').scrollTop = 0;
    if (modal.classList.contains('cap-plugin-maker-modal')) {
      const resources = modal.querySelector('.cap-resource-pack');
      if (resources) resources.open = false;
      modal.querySelectorAll('.cap-maker-group').forEach(group => listen(group, 'toggle', () => {
        if (group.open && !layer.hidden) group.scrollIntoView({ block: 'start', behavior: 'instant' });
      }));
    }
    const opener = document.activeElement;
    function restore() { if (layer.hidden && opener && opener.isConnected) opener.focus({ preventScroll: true }); }
    listen(layer, 'click', () => queueMicrotask(restore));
    listen(layer, 'mousedown', () => queueMicrotask(restore));
    listen(layer, 'keydown', event => {
      if (layer.hidden) return;
      if (event.key === 'Escape') {
        const more = layer.querySelector('.cap-plugin-more[open]');
        if (more) { more.open = false; more.querySelector('summary').focus(); }
        else { ctx.closeModal(); restore(); }
        event.preventDefault(); event.stopPropagation(); return;
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(modal.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary,[tabindex="0"]'))
        .filter(element => element.tabIndex >= 0 && visible(element));
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { last.focus(); event.preventDefault(); }
      else if (!event.shiftKey && document.activeElement === last) { first.focus(); event.preventDefault(); }
    });
    layer.querySelector('#capModalClose').focus({ preventScroll: true });
    return listen;
  }
  function detail(layer, ctx) {
    const listen = dialog(layer, ctx);
    const buttons = Array.from(layer.querySelectorAll('.cap-detail-tabs [role="tab"]'));
    function select(button) {
      buttons.forEach(item => {
        const active = item === button;
        item.setAttribute('aria-selected', String(active)); item.tabIndex = active ? 0 : -1;
        layer.querySelector('#' + item.getAttribute('aria-controls')).hidden = !active;
      });
      layer.querySelector('#capModalBody').scrollTop = 0;
    }
    buttons.forEach((button, index) => {
      listen(button, 'click', () => select(button));
      listen(button, 'keydown', event => {
        let next;
        if (event.key === 'ArrowRight') next = (index + 1) % buttons.length;
        if (event.key === 'ArrowLeft') next = (index + buttons.length - 1) % buttons.length;
        if (event.key === 'Home') next = 0;
        if (event.key === 'End') next = buttons.length - 1;
        if (next == null) return;
        event.preventDefault(); select(buttons[next]); buttons[next].focus();
      });
    });
    const foot = layer.querySelector('#capModalFoot');
    const secondary = ['capPersonalVersions', 'capPersonalImprove', 'capPersonalToggle', 'capPersonalDelete', 'capEnterpriseRemove']
      .map(id => layer.querySelector('#' + id)).filter(Boolean);
    if (secondary.length) {
      const more = document.createElement('details'); more.className = 'cap-plugin-more';
      more.innerHTML = '<summary>更多管理 <span aria-hidden="true">⌄</span></summary><div class="cap-plugin-more-actions"></div>';
      secondary.forEach(button => more.lastElementChild.appendChild(button));
      foot.prepend(more);
      listen(layer, 'click', event => { if (!more.contains(event.target)) more.open = false; });
      listen(more.lastElementChild, 'click', event => {
        if (event.target.closest('button')) { more.open = false; more.querySelector('summary').focus(); }
      });
    }
  }
  function h(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, ch =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
  }
  /*
   * Plugins declaring workspace.navigation pages appear in the application menu. Centralize
   * this classification to keep catalog and marketplace filtering consistent.
   */
  function isWorkspaceApp(item) {
    const contributions = item && item.ui && Array.isArray(item.ui.contributions)
      ? item.ui.contributions : [];
    return contributions.some(row => row && row.slot === 'workspace.navigation');
  }
  function managedPlugins(catalog) {
    const seen = new Set();
    const managed = (catalog.items || []).filter(item => {
      if (!item || !item.pluginId || isWorkspaceApp(item) ||
          !(item.personal || item.installed || item.permissions?.canEdit === true) || seen.has(item.pluginId)) return false;
      seen.add(item.pluginId); return true;
    });
    const grouped = new Map(), hidden = new Set();
    for (const personal of managed.filter(item => item.personal && !item.builtIn && item.key)) {
      // A name or edit permission is not evidence that this user published a
      // local draft. Only the current account's organization receipts link it.
      if (managed.filter(item => item.personal && item.key === personal.key).length !== 1) continue;
      const receipts = (catalog.submissions || []).filter(row => row && row.pluginId &&
        row.scope === 'organization' && row.key === personal.key);
      if (!receipts.length || new Set(receipts.map(row => row.pluginId)).size !== 1) continue;
      if (receipts.some(row => typeof row.qualifiedKey !== 'string' ||
          !/^org:[^/]+\/[^/]+$/.test(row.qualifiedKey) || !row.qualifiedKey.endsWith('/' + personal.key))) continue;
      const qualified = new Set(receipts.map(row => row.qualifiedKey));
      if (qualified.size > 1) continue;
      receipts.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0) ||
        Number(b.reviewedAt || 0) - Number(a.reviewedAt || 0) ||
        String(b.version || '').localeCompare(String(a.version || ''), 'en', { numeric: true }));
      const submission = receipts[0];
      const company = (catalog.items || []).find(item => item && !item.personal && !item.builtIn &&
        !isWorkspaceApp(item) && item.pluginId === submission.pluginId);
      if (company && (company.key !== personal.key || company.scope !== 'organization' ||
          company.qualifiedKey !== submission.qualifiedKey)) continue;
      // These are display associations only: every action still resolves its
      // original catalog record, permission checks and immutable version.
      grouped.set(personal.pluginId, { ...personal,
        creatorPublication: { submission, ...(company ? { company } : {}) } });
      if (company) hidden.add(company.pluginId);
    }
    return managed.filter(item => !hidden.has(item.pluginId)).map(item => grouped.get(item.pluginId) || item);
  }
  function libraryModel(catalog, filters, matches, stateFor) {
    const managed = managedPlugins(catalog);
    const source = ['personal', 'enterprise'].includes(filters.source) ? filters.source : 'all';
    const status = ['ready', 'attention', 'disabled'].includes(filters.status) ? filters.status : 'all';
    const query = String(filters.query || '').trim();
    const directory = global.SoduWorkCapabilityDirectory;
    const view = directory ? directory.categoryView(catalog, managed, filters.category) :
      { selected: '', definitions: [], items: managed };
    const categories = view.definitions.map(category => ({ ...category,
      count: managed.filter(item => directory.categoryFor(item, catalog).key === category.key).length,
    }));
    const items = view.items.filter(item =>
      (source === 'all' || (source === 'personal' ? item.personal : !item.personal || item.creatorPublication)) &&
      (status === 'all' || stateFor(item) === status) &&
      (matches(item, query) || (item.creatorPublication?.company && matches(item.creatorPublication.company, query))));
    const personal = managed.filter(item => item.personal).length;
    const enterprise = managed.filter(item => !item.personal || item.creatorPublication).length;
    return { managed, items, categories, source, status, query, category: view.selected,
      counts: { all: managed.length, personal, enterprise },
      filtered: source !== 'all' || status !== 'all' || !!view.selected || !!query };
  }
  function libraryToolbar(model, submissions) {
    const select = (id, label, value, options) => '<label class="cap-library-select"><span>' + label +
      '</span><select id="' + id + '" aria-label="' + label + '">' + options.map(option =>
        '<option value="' + h(option.key) + '"' + (value === option.key ? ' selected' : '') +
        (option.userContent ? ' data-user-content' : '') + '>' + h(option.name) + '</option>').join('') + '</select></label>';
    return '<div class="cap-library-toolbar"><div class="cap-library-sources" role="group" aria-label="插件来源">' +
      [['all', '全部'], ['personal', '个人'], ['enterprise', '企业']].map(([key, label]) =>
        '<button type="button" data-plugin-source="' + key + '" aria-pressed="' + (model.source === key) +
        '"><span>' + label + '</span><small>' + model.counts[key] + '</small></button>').join('') +
      '</div><div class="cap-library-filters">' +
      select('capPluginCategory', '分类', model.category, [{ key: '', name: '全部分类' }].concat(
        model.categories.map(row => ({ key: row.key, name: row.name })))) +
      select('capPluginStatus', '状态', model.status, [
        { key: 'all', name: '全部状态' }, { key: 'ready', name: '可使用' },
        { key: 'attention', name: '需处理' }, { key: 'disabled', name: '已停用' },
      ]) + '</div><button type="button" class="btn-mini cap-library-records" id="capPluginSubmissions">' +
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4h10a2 2 0 0 1 2 2v14H5V6a2 2 0 0 1 2-2Z M9 3h6v3H9z M9 11h6 M9 15h4"/></svg>' +
      '<span>我的申请</span>' + (submissions.length ? '<small>' + submissions.length + '</small>' : '') +
      '</button></div>';
  }
  function libraryEmpty(model, icon) {
    return '<div class="cap-library-empty"><span aria-hidden="true">' + icon + '</span><b>' +
      (model.filtered ? '没有匹配的插件' : '把常用的工作方法放在这里') + '</b><p>' +
      (model.filtered ? '试试其他关键词，或清除筛选查看全部插件。' : '从市场添加插件，也可以制作自己的插件或导入已有的插件包。') +
      '</p><button type="button" class="btn-mini" id="' + (model.filtered ? 'capPluginClear' : 'capOpenMarket') + '">' +
      (model.filtered ? '清除筛选' : '浏览市场') + '</button></div>';
  }
  function records(rows, ctx, trustName, openSubmission, query = '') {
    const owner = document.getElementById('capPluginSubmissions');
    const recordContext = { ...ctx, closeModal: () => { ctx.closeModal(); owner?.focus({ preventScroll: true }); } };
    const layer = ctx.openModal('我的申请', '查看已提交插件的审核进度与反馈',
      '<label class="cap-record-search"><span>查找申请</span><input id="capRecordSearch" class="cap-input" placeholder="搜索插件名称或版本" value="' + h(query) + '"></label>' +
      '<div id="capRecordList" class="cap-record-list"></div>', '');
    layer.querySelector('.cap-modal').classList.add('cap-record-modal');
    const input = layer.querySelector('#capRecordSearch');
    const list = layer.querySelector('#capRecordList');
    function renderRecords() {
      const needle = query.trim().toLowerCase();
      const shown = rows.filter(item => [item.name, item.version, item.reviewNote,
        ...(Array.isArray(item.reviewHistory) ? item.reviewHistory.flatMap(review => [review?.note, review?.reviewedBy]) : []),
      ].some(value => String(value || '').toLowerCase().includes(needle)));
      list.innerHTML = shown.length ? shown.map(item => {
        const state = trustName(item.trustState, item.enabled, item.reviewDecision);
        const step = global.SoduWorkPluginPublication.currentStep(item);
        return '<button type="button" class="cap-record" data-submission="' + h(item.pluginId) +
          '" data-submission-version="' + h(item.versionId || item.version) + '">' +
          '<span class="cap-record-name"><b data-user-content>' + h(item.name) + '</b><small data-user-content>v' + h(item.version) +
          '</small></span><em class="' + h(state[1]) + '">' + h(state[0]) + '</em><span class="cap-record-note"' +
          (item.reviewNote ? ' data-user-content' : '') + '>' + h(item.reviewNote || step.detail) +
          '</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg></button>';
      }).join('') : '<div class="cap-record-empty"><b>' + (query ? '没有匹配的申请' : '还没有提交申请') +
        '</b><p>' + (query ? '试试其他插件名称或版本。' : '在个人插件详情中提交到企业后，可以在这里跟进审核。') + '</p></div>';
      list.querySelectorAll('[data-submission]').forEach(button => button.addEventListener('click', () => {
        const item = rows.find(row => row.pluginId === button.dataset.submission &&
          String(row.versionId || row.version || '') === button.dataset.submissionVersion);
        if (item) openSubmission(item, recordContext, () => records(rows, ctx, trustName, openSubmission, query));
      }));
    }
    input.addEventListener('input', () => { query = input.value; renderRecords(); });
    renderRecords(); dialog(layer, recordContext); input.focus({ preventScroll: true });
    return layer;
  }
  let menuController;
  function addMenu(button, menu) {
    menuController?.abort(); menuController = new AbortController();
    const listen = (node, type, fn) => node.addEventListener(type, fn, { signal: menuController.signal });
    const toggle = open => { menu.hidden = !open; button.setAttribute('aria-expanded', String(open)); };
    listen(button, 'click', () => toggle(menu.hidden));
    listen(button, 'keydown', event => {
      if (event.key === 'ArrowDown') { event.preventDefault(); toggle(true); menu.querySelector('button')?.focus(); }
    });
    listen(document, 'pointerdown', event => { if (!menu.contains(event.target) && !button.contains(event.target)) toggle(false); });
    listen(document, 'focusin', event => { if (!menu.contains(event.target) && !button.contains(event.target)) toggle(false); });
    listen(document, 'keydown', event => {
      if (event.key === 'Escape' && !menu.hidden) { toggle(false); button.focus(); event.preventDefault(); event.stopPropagation(); }
    });
  }
  global.SoduWorkPluginPresentation = { tabs, detail, dialog, managedPlugins, libraryModel, libraryToolbar, libraryEmpty, records, addMenu, isWorkspaceApp };
})(window);
