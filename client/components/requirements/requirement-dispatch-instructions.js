/* Dispatch history is private execution evidence, never reconstructed from chat. */
(function (global) {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g,
    c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const scope = detail => detail?.conversationId && detail?.turnId
    ? JSON.stringify([detail.conversationId, detail.turnId]) : '';
  function records(events) {
    const rows = new Map();
    for (const event of events) {
      const d = event.detail || {}, key = scope(d);
      if (event.kind === 'execution.instructions' && d.schemaVersion === 1 && key) {
        rows.set(key, {...event, recorded:true});
      } else if (event.kind === 'conversation.turn' && d.state === 'queued' && key && !rows.has(key)) {
        rows.set(key, {...event, recorded:false});
      }
    }
    // An old standalone Runner dispatch has no turn correlation. Keep it
    // explicitly historical instead of assigning invented round numbers.
    for (const event of events) {
      if (event.kind !== 'ai.dispatched') continue;
      const d = event.detail || {}, key = scope(d.conversationTurn);
      if (d.plugin?.runId && d.plugin?.nodeId) continue;
      if (key && rows.has(key)) continue;
      rows.set('legacy:' + (d.attemptId || d.ref || d.issueId || event.id), {...event, recorded:false});
    }
    return [...rows.values()].sort((a, b) => Number(b.at || 0) - Number(a.at || 0));
  }
  function modeText(detail) {
    const selected = detail.submissionMode, effective = detail.effectiveSubmissionMode;
    if (!['auto', 'manual'].includes(effective)) return '未记录';
    if (selected === 'manual') return '完成后手动提交验收';
    if (selected === 'auto') return '完成后自动提交验收';
    return selected === 'default' ? '按交付物自动判断（本次：' + (effective === 'auto' ? '自动提交验收' : '手动提交验收') + '）' : '未记录';
  }
  function html(events) {
    const rows = records(events);
    if (!rows.length) return '<p class="rq-dispatch-muted">暂无派发记录</p>';
    return rows.map(row => {
      const d = row.detail || {}, known = row.recorded && typeof d.note === 'string';
      const time = row.at ? new Date(row.at).toLocaleString(global.SoduWorkI18n?.getLocale?.() || 'zh-CN',
        {month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'}) : '';
      return '<article class="rq-dispatch-record"><div class="rq-dispatch-head"><b>' +
        (known ? '安排执行' : '历史安排执行') + '</b><time>' + esc(time) + '</time></div><dl>' +
        '<dt>补充内容</dt><dd' + (known && d.note ? ' data-user-content' : ' class="rq-dispatch-muted"') + '>' +
        esc(known ? d.note || '未填写' : '未记录') + '</dd><dt>交付提交方式</dt><dd' +
        (known ? '' : ' class="rq-dispatch-muted"') + '>' + esc(known ? modeText(d) : '未记录') + '</dd></dl></article>';
    }).join('');
  }
  function shell() {
    return '<details class="rq-evidence" data-rq-dispatch-instructions><summary><span><b>派发说明</b>' +
      '<small>按每次安排执行保留补充内容与交付提交方式</small></span><i aria-hidden="true"></i></summary>' +
      '<div class="rq-dispatch-records" data-rq-dispatch-records role="status"></div></details>';
  }
  function mount(root, task, valid, open = false) {
    const disclosure = root?.querySelector('[data-rq-dispatch-instructions]');
    const node = disclosure?.querySelector('[data-rq-dispatch-records]');
    if (!node || task.canViewExecution === false) return;
    let loaded = false, loading = false;
    const live = () => node.isConnected && valid();
    async function load() {
      if (!disclosure.open || loaded || loading || !live()) return;
      loading = true; node.textContent = '正在加载派发说明…';
      try {
        const events = await global.SoduWorkAPI.getTaskEvents(task.id);
        if (!live()) return;
        if (!Array.isArray(events)) throw Error('Records unavailable');
        node.innerHTML = html(events); loaded = true;
      } catch (_) {
        if (live()) node.textContent = '派发说明未能加载，请收起后重新展开';
      } finally { loading = false; }
    }
    disclosure.addEventListener('toggle', load);
    disclosure.open = open;
    if (open) void load();
  }
  global.RequirementDispatchInstructions = {html, records, shell, mount};
})(window);
