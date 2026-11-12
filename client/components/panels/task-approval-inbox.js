/* Discovery only. Decisions stay in the linked ordinary conversation. */
(function (global) {
  'use strict';
  let panel, anchor, revision = 0, pendingTasks = [], waitingRows = [];
  let refreshTimer = null, refreshNeeded = false;
  const requests = new Set();
  const esc = value => String(value || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const labels = {baseline:'需求确认',review:'交付验收',merge:'合并确认',uat:'环境验收',deploy:'发布确认'};
  const unavailable = '<p class="task-confirmation-empty" role="alert">暂时无法读取，请关闭后重试。已有审批不会丢失。</p>';
  function snapshot() { return pendingTasks.map(item => ({...item})); }
  /*
   * mineWaiting identifies tasks on this device awaiting the requirement creator's review.
   * It is a waiting notice only; it never grants the executor a duplicate approval action.
   */
  function waiting() { return waitingRows.map(row => ({...row})); }
  function update(result) {
    const refs = Array.isArray(result?.pendingTasks) ? result.pendingTasks :
      Array.isArray(result?.items) ? result.items : [];
    const seen = new Set();
    pendingTasks = [];
    for (const item of refs) {
      if (!item?.id || !item.taskId || item.myDecision || (item.status && item.status !== 'pending')) continue;
      const id = String(item.id);
      if (seen.has(id)) continue;
      seen.add(id);
      pendingTasks.push({taskId: String(item.taskId), id, action: String(item.action || ''),
        ...(item.artifactVersionId ? {artifactVersionId: String(item.artifactVersionId)} : {})});
    }
    waitingRows = (Array.isArray(result?.mineWaiting) ? result.mineWaiting : [])
      .filter(row => row?.taskId && String(row.action || '') === 'review')
      .map(row => ({taskId: String(row.taskId), waitingOn: (Array.isArray(row.waitingOn) ? row.waitingOn : []).filter(Boolean)}));
    const count = Number.isFinite(result?.pendingCount) ? Math.max(0, result.pendingCount) : pendingTasks.length;
    const badge = document.querySelector('[data-task-approval-count]');
    if (badge) {
      // Keep the count visually separate from the label. Preserve the numeric
      // text for lightweight clients that only expose textContent; CSS hides
      // the zero badge in the full renderer.
      badge.textContent = String(count);
      badge.hidden = count <= 0;
      if (typeof badge.setAttribute === 'function') {
        badge.setAttribute('aria-label', count > 0 ? String(count) + ' 项待确认' : '没有待确认事项');
      }
    }
    global.WorkspaceShell?.setApprovalCount?.(count);
    global.dispatchEvent(new CustomEvent('soduwork-approvals-changed'));
  }
  function close() { if (panel?.matches(':popover-open')) panel.hidePopover(); anchor?.focus({preventScroll:true}); }
  function position() {
    if (!panel || !anchor) return;
    const r = anchor.getBoundingClientRect();
    panel.style.width = Math.min(420, innerWidth - 32) + 'px';
    panel.style.left = Math.max(16, Math.min(r.right - Math.min(420, innerWidth - 32), innerWidth - 436)) + 'px';
    panel.style.top = Math.min(r.bottom + 10, innerHeight - 180) + 'px';
    panel.style.maxHeight = Math.max(140, Math.min(600, innerHeight - r.bottom - 26)) + 'px';
  }
  function scheduleRefresh() {
    refreshNeeded = true;
    if (document.visibilityState === 'hidden' || refreshTimer !== null || requests.size) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      if (document.visibilityState !== 'hidden') void refresh().catch(() => {});
    }, 250);
  }
  async function refresh() {
    clearTimeout(refreshTimer); refreshTimer = null; refreshNeeded = false;
    const seq = ++revision;
    requests.add(seq);
    let result;
    try {
      try { result = await global.SoduWorkAPI.listApprovals('pending'); }
      catch (error) {
        if (seq !== revision) return;
        update(null);
        const body = panel?.querySelector('[data-confirmation-list]');
        if (body) body.innerHTML = unavailable;
        throw error;
      }
      if (seq !== revision) return;
      update(result);
      const body = panel?.querySelector('[data-confirmation-list]');
      if (!body) return;
      const items = result.items || [];
      body.innerHTML = items.length ? items.map(item =>
        '<button type="button" class="task-confirmation-row" data-confirmation-task="' + esc(item.taskId) + '" data-confirmation-id="' + esc(item.id) + '">' +
        '<span class="task-confirmation-dot" aria-hidden="true"></span><span><b>' + esc(item.task?.title || '待确认需求') + '</b><small>' +
        esc(labels[item.action] || '需求确认') + ' · 在需求详情里查看证据并处理</small></span><span aria-hidden="true">›</span></button>').join('') :
        '<p class="task-confirmation-empty">暂无需要你确认的需求</p>';
    } finally {
      requests.delete(seq);
      if (refreshNeeded && !requests.size) scheduleRefresh();
    }
  }
  async function open(button) {
    anchor = button || document.getElementById('hbApprovalInbox');
    if (!anchor) return false;
    if (!panel) {
      panel = document.createElement('section');
      panel.id = 'taskApprovalInbox'; panel.className = 'task-confirmation-inbox';
      panel.setAttribute('popover','auto'); panel.setAttribute('aria-label','待我确认');
      panel.innerHTML = '<header><div><b>待我确认</b><span>打开需求详情，核对后继续</span></div><button type="button" aria-label="关闭待确认列表" data-confirmation-close>×</button></header><div data-confirmation-list></div>';
      document.body.appendChild(panel);
      panel.addEventListener('click', async event => {
        if (event.target.closest('[data-confirmation-close]')) { close(); return; }
        const row = event.target.closest('[data-confirmation-task]');
        if (!row || row.disabled) return;
        row.disabled = true;
        /*
         * Open review cards in requirement details using Hub evidence available on any device.
         * Execution archives exist only on the execution machine.
         */
        const taskId = String(row.dataset.confirmationTask || '');
        let ok = false;
        if (global.__deskPanel === 'workspace' && global.RequirementsDetail) {
          void global.RequirementsDetail.open(taskId); ok = true;
        } else if (global.soduWorkAPI?.openDeskWindow) {
          ok = await global.soduWorkAPI.openDeskWindow({panel: 'workspace', view: 'history', requirementId: taskId});
        }
        if (ok) { if(panel.matches(':popover-open'))panel.hidePopover(); }
        else row.disabled = false;
      });
      panel.addEventListener('toggle', () => anchor?.setAttribute('aria-expanded', String(panel.matches(':popover-open'))));
      global.addEventListener('resize',position);
    }
    position(); panel.showPopover();
    panel.querySelector('[data-confirmation-list]').innerHTML = '<p class="task-confirmation-empty" role="status">正在读取待确认需求…</p>';
    // refresh owns the error UI and revision check, so an old rejected request
    // cannot overwrite a newer response or reveal a previous account's data.
    try { await refresh(); } catch (_) {}
    return true;
  }
  global.TaskApprovalInbox = {open,refresh,close,snapshot,waiting};
  function reset() {
    revision++;
    clearTimeout(refreshTimer); refreshTimer = null; refreshNeeded = false; requests.clear();
    if (panel?.matches(':popover-open')) panel.hidePopover();
    const body = panel?.querySelector('[data-confirmation-list]');
    if (body) body.innerHTML = '';
    anchor?.setAttribute('aria-expanded', 'false');
    anchor = null;
    update(null);
  }
  global.addEventListener('soduwork-data-scope-changed', reset);
  global.addEventListener('soduwork-work-task-change', event => {
    const type = event.detail?.type;
    if (type === 'tasks.offline' || type === 'tasks.environment') { reset(); return; }
    scheduleRefresh();
  });
  global.addEventListener('soduwork-store-hydrated', scheduleRefresh);
  global.addEventListener('soduwork-approvals-invalidated', scheduleRefresh);
  global.addEventListener('focus', scheduleRefresh);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { clearTimeout(refreshTimer); refreshTimer = null; }
    else scheduleRefresh();
  });
})(window);
