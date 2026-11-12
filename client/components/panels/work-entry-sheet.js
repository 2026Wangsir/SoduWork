/* Shared requirement creation card records goals, materials, and ownership; the assignee chooses execution settings before starting. */
(function (global) {
  'use strict';
  let layer = null, surface = null, seed = null, attachments = null, scope = 0, restoreFailed = false;
  let refineTail = Promise.resolve();
  let resultDialog = null;
  let focusReturn = null;
  const isModal = () => layer?.isConnected && !surface?.inline && document.documentElement.dataset.deskPanel !== 'add';
  function focusableControls() {
    return Array.from(layer.querySelectorAll('button,input,textarea,select,a[href],[tabindex]')).filter(node =>
      node.tabIndex >= 0 && !node.disabled && !node.closest('[inert],[hidden]') &&
      node.getClientRects().length && getComputedStyle(node).visibility === 'visible');
  }
  const ownerScope = () => String(global.SoduWorkAPI?.taskStorageKey?.('ops') || '');
  function dismissResult(restoreFocus = false) { resultDialog?.finish(restoreFocus); }
  function showResult({ success, title, message, hint, id, focusTarget }) {
    dismissResult();
    const request = scope, owner = ownerScope(), dialog = document.createElement('dialog');
    const current = () => request === scope && owner === ownerScope();
    const element = (tag, className, text) => {
      const node = document.createElement(tag); node.className = className;
      if (text != null) node.textContent = text;
      return node;
    };
    dialog.className = 'wes-result-dialog ' + (success ? 'is-success' : 'is-error');
    dialog.setAttribute('aria-labelledby', 'wesResultTitle');
    dialog.setAttribute('aria-describedby', 'wesResultMessage');
    if (!success) dialog.setAttribute('role', 'alertdialog');
    const head = element('header', 'wes-result-head');
    const mark = element('span', 'wes-result-mark', success ? '✓' : '!'); mark.setAttribute('aria-hidden', 'true');
    const heading = element('h2', '', title); heading.id = 'wesResultTitle';
    const exit = element('button', 'wes-result-close', '×'); exit.type = 'button'; exit.setAttribute('aria-label', '关闭提示');
    head.append(mark, heading, exit);
    const body = element('div', 'wes-result-body');
    const text = element('p', 'wes-result-message', message); text.id = 'wesResultMessage'; text.setAttribute('data-user-content', '');
    body.appendChild(text);
    if (hint) body.appendChild(element('p', 'wes-result-hint', hint));
    const actions = element('footer', 'wes-result-actions');
    const primary = element('button', 'wes-result-primary', success ? '知道了' : '返回继续'); primary.type = 'button';
    let finished = false;
    const finish = (restoreFocus = true) => {
      if (finished) return;
      finished = true;
      if (dialog.open) dialog.close();
      dialog.remove();
      if (resultDialog?.node === dialog) resultDialog = null;
      if (restoreFocus && current() && focusTarget?.isConnected) focusTarget.focus({ preventScroll: true });
    };
    if (success && id) {
      const detail = element('button', 'wes-result-secondary', '查看详情'); detail.type = 'button';
      detail.addEventListener('click', () => { finish(false); if (current()) openCreatedDetail(id); });
      actions.appendChild(detail);
    }
    actions.appendChild(primary); dialog.append(head, body, actions);
    exit.addEventListener('click', () => finish()); primary.addEventListener('click', () => finish());
    dialog.addEventListener('cancel', event => { event.preventDefault(); finish(); });
    dialog.addEventListener('close', () => finish());
    resultDialog = { node: dialog, finish };
    document.body.appendChild(dialog); dialog.showModal(); primary.focus();
    return true;
  }
  /*
   * Close the creation drawer before opening details through the shared entry point so its
   * higher layer cannot obscure the result.
   */
  function openCreatedDetail(id) {
    if (!id) return;
    // Navigating away unmounts the inline surface, but is not a dismissal of
    // its persisted conversation record. Independent windows still close.
    close(false, Boolean(surface?.inline));
    if (global.__deskPanel === 'workspace' && typeof global.WorkspaceHost?.open === 'function') {
      global.WorkspaceHost.open('history', { requirementId: id });
    }
    else if (typeof global.openDetailEntry === 'function') global.openDetailEntry(id);
  }
  function active() {
    if (global.WorkAutomationSheet?.active()) return WorkAutomationSheet.active();
    if (restoreFailed) return null;
    if (['succeeded', 'submitting'].includes(global.ComposeDraft?.capture?.()?.phase)) return null;
    return layer?.isConnected ? { mode: 'task', actionId: 'work.requirement.create' } : null;
  }
  function capture() { return layer && !restoreFailed ? global.ComposeDraft?.capture?.() || null : null; }
  function close(fromDraft, silent, captured) {
    dismissResult();
    const previousFocus = focusReturn, restoreFocus = !silent && isModal();
    focusReturn = null;
    const automation = global.WorkAutomationSheet;
    if (automation?.hasSurface ? automation.hasSurface() : automation?.active()) automation.close(silent);
    const oldSurface = surface, oldSeed = seed, hadLayer = Boolean(layer);
    const saved = captured || capture();
    if (saved && saved.ownerScope === String(global.SoduWorkAPI?.taskStorageKey?.('ops') || '')) oldSeed?.onCardState?.(saved);
    scope++; refineTail = Promise.resolve();
    attachments?.destroy(); attachments = null;
    layer = null; surface = null; seed = null; restoreFailed = false;
    if (oldSurface) oldSurface.destroy();
    if (hadLayer && !fromDraft) global.ComposeDraft?.clear();
    // Replacing a form closes it silently; invoking the host close callback would also close the window being reopened.
    if (!silent && typeof oldSeed?.onClose === 'function') oldSeed.onClose();
    if (!silent && hadLayer) oldSeed?.onCardClose?.(saved);
    if (restoreFocus && previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
  }
  function showSavedMaterials(taskId, files) {
    const zone = layer?.querySelector('.wes-attach-zone'), request = scope;
    if (!zone) return;
    attachments?.destroy(); attachments = null;
    const rows = Array.isArray(files) ? files : [];
    zone.inert = false; zone.removeAttribute('aria-busy'); zone.replaceChildren(); zone.hidden = !rows.length;
    if (!rows.length) return;
    zone.classList.add('is-saved');
    const title = document.createElement('strong'); title.textContent = '相关材料 · ' + rows.length;
    zone.appendChild(title);
    const status = document.createElement('div'); status.className = 'wes-material-status'; status.setAttribute('role', 'status');
    async function use(file, action, button) {
      const api = global.SoduWorkAPI, account = api?.taskStorageKey?.('ops');
      const current = () => request === scope && zone.isConnected && account === api?.taskStorageKey?.('ops');
      button.disabled = true; status.textContent = '';
      try {
        // Reauthorize attachment access at action time instead of reusing a short-lived creation URL.
        const candidates = await api.listAttachments(taskId);
        if (!current()) return;
        const saved = candidates.find(row => String(row.id) === String(file.id));
        if (!saved) throw new Error('附件已移除或当前账号无法访问，请在需求详情中确认');
        const attachment = { ...saved, url: api.attachmentUrl(saved) };
        let reply;
        if (action === 'view') reply = await global.ConversationAttachments.openTaskAttachment(attachment, { isCurrent: current, say: message => { if (current()) status.textContent = message; } });
        else {
          if (!global.soduWorkAPI?.downloadAttachment) throw new Error('当前客户端不支持附件下载');
          reply = await global.soduWorkAPI.downloadAttachment(attachment);
        }
        if (reply?.ok === false && !reply.canceled && !reply.cancelled) throw new Error(reply.reason || '附件操作没有完成');
      } catch (error) {
        if (current()) status.textContent = String(error?.message || '附件暂时不可用，请重试');
      } finally { if (current()) button.disabled = false; }
    }
    rows.forEach(file => {
      const row = document.createElement('div'); row.className = 'wes-material-row';
      const copy = document.createElement('div'); copy.className = 'wes-material-copy';
      const name = document.createElement('b'); name.textContent = file.filename || '附件'; name.title = name.textContent;
      const size = document.createElement('small'); size.textContent = global.ConversationAttachments?.size?.(file.size) || '';
      copy.append(name, size); row.appendChild(copy);
      for (const [action, label] of [['view', '查看'], ['download', '下载']]) {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
        button.dataset.wesMaterial = action; button.disabled = !file.id;
        button.addEventListener('click', () => use(file, action, button)); row.appendChild(button);
      }
      zone.appendChild(row);
    });
    if (rows.some(file => !file.id)) status.textContent = '部分附件尚未返回标识，请在需求详情中查看';
    zone.appendChild(status);
  }
  function openTask(value) {
    if (!global.ComposeDraft || !global.PluginUIHost) throw new Error('需求表单暂时不可用，请重新打开窗口');
    close(false, true);
    const s = value || {};
    seed = s; const request = ++scope;
    const owner = ownerScope(), returnFocus = document.activeElement;
    focusReturn = returnFocus;
    const current = () => request === scope && owner === ownerScope() && layer?.isConnected;
    const text = String(s.parseText || s.text || '');
    surface = PluginUIHost.mount({ id: 'work-entry', host: s.host, anchor: s.anchor,
      className: 'wes-plugin-surface', prompt: s.text ? '【需求】：' + String(s.text) : '' });
    layer = document.createElement('div');
    layer.id = 'workEntryLayer'; layer.className = 'wes-layer is-task show entered ' + (surface.inline ? 'is-inline' : 'is-dialog');
    const modal = !surface.inline && document.documentElement.dataset.deskPanel !== 'add';
    layer.innerHTML = '<aside class="wes-sheet" role="' + (modal ? 'dialog' : 'region') + '"' +
      (modal ? ' aria-modal="true"' : '') + ' aria-labelledby="wesTitle">' +
      '<header class="wes-head"><div class="wes-head-icon"><svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="4"/><path d="M8 9h8M8 13h5"/></svg></div>' +
      '<div><h2 id="wesTitle">新建需求</h2><p>' + (s.saveOnly ? '先记录目标，准备好后再安排执行' : '写清目标与完成标准，保存或交办给负责人') + '</p></div>' +
      '<button type="button" class="wes-close" data-wes-close aria-label="取消" title="取消"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button></header>' +
      '<main class="wes-body"><div class="wes-task-host cp-draft show" id="wesTaskDraft"></div>' +
      '<section class="wes-attach-zone"><div class="wes-attach-head"><div><strong>' + (global.RequirementFields?.sectionIcon?.('materials') || '') + '相关材料</strong><small>随需求一起交给执行人</small></div>' +
      '<button type="button" id="wesAttachPick">添加附件</button></div>' +
      '<input type="file" id="wesAttachInput" multiple hidden><div class="catt-tray wes-attach-tray" id="wesAttachTray"></div></section></main></aside>';
    surface.content.appendChild(layer);
    if (modal) layer.querySelector('[data-wes-close]')?.focus();
    const attachmentZone = layer.querySelector('.wes-attach-zone');
    const resultFeedback = s.saveOnly === true && !surface.inline;
    const closeButton = layer.querySelector('[data-wes-close]');
    if (closeButton) closeButton.onclick = () => close();
    // Render synchronous post-mount errors inside #wesTaskDraft instead of leaving a blank card.
    const paintFailure = error => {
      if (request !== scope || !layer?.isConnected || restoreFailed) return;
      restoreFailed = true;
      const box = layer.querySelector('#wesTaskDraft');
      if (box) {
        box.classList.add('show'); box.setAttribute('role', 'alert');
        box.textContent = String(error?.message || '需求表单未能打开，请重新打开后重试');
      }
      const zone = layer.querySelector('.wes-attach-zone');
      if (zone) zone.inert = true;
    };
    try {
      if (global.ConversationAttachments) {
        attachments = ConversationAttachments.create({ host: layer.querySelector('.wes-attach-zone'),
          fileInput: layer.querySelector('#wesAttachInput'), button: layer.querySelector('#wesAttachPick'),
          tray: layer.querySelector('#wesAttachTray'), captureLongText: false,
          onChange: () => { if (request === scope) global.ComposeDraft?.notifyCardState?.(); },
          say: message => global.petSay?.(message) });
        const files = s.cardState ? s.cardState.files || [] : [...(typeof s.bridge?.atts === 'function' ? s.bridge.atts() || [] : []), ...(s.conversationContext?.files || [])];
        // Attachment-tray failures must not block form rendering; show feedback and allow manual attachments.
        try { if (files?.length) attachments.add(files, s.cardState ? 'card-restore' : 'restore'); }
        catch (error) { global.petSay?.('附件恢复失败：' + String(error?.message || error || '请重新添加')); }
      }
    } catch (error) {
      global.petSay?.('附件区初始化失败：' + String(error?.message || error || '请重新打开需求'));
    }
    const bridge = { ...(s.bridge || {}), variant: 'sheet', requirement: true,
      fixedActions: !surface.inline,
      onFormRendered: host => {
        // Reuse the material tray and its listeners when the form is rebuilt.
        if (current() && host && attachmentZone) host.appendChild(attachmentZone);
      },
      persistent: Boolean(surface.inline),
      cardId: s.cardId,
      onCardState: snapshot => {
        s.onCardState?.(snapshot);
      },
      onBeforeSubmit: s.onBeforeSubmit || s.bridge?.onBeforeSubmit,
      saveOnly: s.saveOnly === true, triageStage: s.triageStage || 'ready', projectId: s.projectId || '',
      repoId: s.repoId || s.bridge?.repoId || '',
      visibility: s.visibility || 'related', source: s.source || '需求池',
      attachmentContext: s.attachmentContext || [], conversationContext: s.conversationContext || null,
      instruction: typeof s.instruction === 'string' ? s.instruction : String(s.text || ''),
      bindingContext: s.bindingContext || null,
      box: () => document.getElementById('wesTaskDraft'),
      atts: () => attachments ? attachments.files() : [...(s.bridge?.atts?.() || []), ...(s.conversationContext?.files || [])],
      setAttachmentsLocked: locked => {
        const zone = layer?.querySelector('.wes-attach-zone');
        if (zone) { zone.inert = locked; zone.setAttribute('aria-busy', String(locked)); }
      },
      clearAtts: () => { attachments?.clear(); s.bridge?.clearAtts?.(); },
      onClose: saved => {
        if (request !== scope) return false;
        close(true, false, saved);
        return true;
      },
      // Use the View details action on every sheet receipt, including conversation receipts.
      // Its inherited chat hook binds execution instead of navigating to the saved requirement.
      onOpen: id => { if (current()) openCreatedDetail(id); },
      onOpenDetail: id => { if (current()) openCreatedDetail(id); },
      onReceiptRendered: (id, title, outcome) => {
        if (!current()) return;
        layer.classList.add('is-complete');
        // A completed inline receipt is history, not a cancellable creation form.
        if (surface.inline) layer.querySelector('[data-wes-close]')?.remove();
        layer.querySelector('#wesTitle').textContent = '需求已创建';
        if (attachmentZone) layer.querySelector('.wes-body').appendChild(attachmentZone);
        showSavedMaterials(id, outcome?.attachments);
      },
      onSubmitError: (error, outcome) => {
        if (!resultFeedback || !current()) return false;
        return showResult({ success: false,
          title: outcome?.stored ? '需求已保存，提交未完成' : '需求未提交完成',
          message: String(error?.message || '暂时无法完成提交，请稍后重试'),
          hint: outcome?.stored ? '已保存的需求不会重复创建。返回后可继续完成提交。' : '填写内容和附件已保留。返回后可继续修改或重试。',
          focusTarget: layer.querySelector('#cpCreate') });
      },
      onCreated: (id, title, outcome) => {
        if (!current()) return;
        s.bridge?.onCreated?.(id, title, outcome);
        global.RequirementsBoard?.refresh();
        s.onCreated?.(id, title, outcome);
        if (resultFeedback && current()) {
          const stage = global.ComposeDraft?.capture?.()?.draft?.triageStage || s.triageStage || 'intake';
          close();
          showResult({ success: true, title: '需求已创建', message: title,
            hint: outcome?.handedOff ? '已交给负责人，可在需求池查看进展。'
              : '已保存到' + (stage === 'ready' ? '待开始' : '收集箱') + '，可在需求池继续查看。',
            id, focusTarget: returnFocus });
        }
      } };
    // Recover an empty #wesTaskDraft while this sheet generation remains active.
    // Repaint missing content after clearing races or swallowed errors.
    // Stop when the sheet scope changes; skip timer-free test sandboxes.
    if (typeof setInterval === 'function') {
      let healTicks = 0;
      const healTimer = setInterval(() => {
        try {
          // A rejected restore is a terminal state for this surface. Its text-only
          // error is not an empty form and must never be replaced or persisted.
          if (request !== scope || !layer?.isConnected || restoreFailed) { clearInterval(healTimer); return; }
          const box = layer.querySelector('#wesTaskDraft');
          if (!box || box.childElementCount || !global.ComposeDraft) return;
          // Repaint the current card; create an empty form only when no card exists.
          if (ComposeDraft.repaint?.()) return;
          Promise.resolve(ComposeDraft.openWith({ title: '', note: '', checklist: [], priority: 'normal',
            kind: s.kind || 'requirement' }, bridge)).catch(() => {});
        } catch (_) {} finally { if (++healTicks > 600) clearInterval(healTimer); }
      }, 120);
    }
    if (s.cardState) return Promise.resolve(ComposeDraft.restore(s.cardState, bridge)).catch(error => {
      paintFailure(error);
      throw error;
    });
    try {
      if (s.proposal) return ComposeDraft.openWith(s.proposal, bridge);
      if (text) return ComposeDraft.open(text, bridge);
      return ComposeDraft.openWith({ title: '', note: '', checklist: [], priority: 'normal', kind: s.kind || 'requirement' }, bridge);
    } catch (error) {
      paintFailure(error);
      throw error;
    }
  }
  function refine(text, options) {
    if (global.WorkAutomationSheet?.active()) return WorkAutomationSheet.refine(text, options || {});
    const change = String(text || '');
    if (!active() || !change.trim()) return Promise.resolve(false);
    const request = scope;
    const work = refineTail.then(async () => {
      if (request !== scope || !layer) return false;
      PluginUIHost.checkpointCurrent?.({ label: '需求表单', title: layer.querySelector('#cpTitle')?.value || '需求信息', prompt: change });
      // Persist added materials in the original card before parsing so navigation cannot lose them.
      if (options?.conversationContext?.files?.length) attachments?.add(options.conversationContext.files, 'restore');
      const updated = await ComposeDraft.refine(change, options || {});
      return updated;
    });
    refineTail = work.catch(() => false);
    return work;
  }
  document.addEventListener('keydown', event => {
    if (event.key === 'Tab' && !event.defaultPrevented && isModal() &&
        !document.querySelector('dialog:modal,[popover]:popover-open,.catt-preview')) {
      const controls = focusableControls(), first = controls[0], last = controls[controls.length - 1];
      if (!first) { event.preventDefault(); return; }
      // Recompute boundaries after dynamic owner pickers, attachments, and validation rerenders.
      const outside = !layer.contains(document.activeElement);
      if (outside || (event.shiftKey ? document.activeElement === first : document.activeElement === last)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
      return;
    }
    if (event.key !== 'Escape' || event.defaultPrevented || !layer?.isConnected) return;
    if (surface?.inline) return;
    if (document.querySelector('dialog:modal,[popover]:popover-open,.catt-preview')) return;
    // Standalone creation windows use the form as their main page; Escape must not trigger the callback that closes the window.
    if (document.documentElement.dataset.deskPanel === 'add') return;
    event.preventDefault(); event.stopImmediatePropagation(); close();
  });
  global.WorkEntrySheet = { openTask, active, refine, close, capture,
    // Let ComposeDraft.clear() detect whether a box belongs to an active sheet.
    // Do not let stale bridge cleanup clear a newer sheet generation.
    ownsBox: box => Boolean(layer && layer.isConnected && box && layer.contains(box)) };
  global.addEventListener('soduwork-data-scope-changed', () => close(false, true));
  global.PluginUIHost?.registerAction({ id: 'work.requirement.create', command: '需求',
    aliases: ['新建需求', '创建需求', '沉淀需求', 'Bug', '工单', '改进', 'issue', 'request', '任务', '创建任务', '安排执行', '派活', 'task'],
    name: '新建需求', icon: '需', badge: '内置表单', priority: 10,
    description: '记录目标与完成标准，保存到需求池或交办给同事', open: openTask });
})(window);
