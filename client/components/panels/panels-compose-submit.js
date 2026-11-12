/*
 * Submit and finalize conversation-to-requirement cards. Keep requirement editing in the
 * card while this module handles transfer, plugin startup, and result feedback.
 */
(function (global) {
  'use strict';

  const cards = new Map();
  let cardSequence = 0;
  const ownerScope = () => String(global.SoduWorkAPI?.taskStorageKey?.('ops') || '');
  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
  function card(options, saved) {
    const owner = ownerScope(), id = String(options.cardId || saved?.cardId || 'requirement-' + Date.now() + '-' + (++cardSequence));
    if (saved?.ownerScope && saved.ownerScope !== owner) throw Error('账号或服务已切换，请重新打开需求');
    const key = owner + '\n' + id;
    if (saved && cards.has(key)) return cards.get(key);
    const value = { cardId: id, ownerScope: owner, phase: 'loading', draft: null, receipt: null, error: '',
      ...clone(saved ? { ...saved, files: undefined, submission: undefined } : {}),
      files: (saved?.files || options.atts?.() || []).slice(), notify: options.onCardState, observer: null };
    if (saved?.submission) {
      value.submission = { ...clone(saved.submission), uploaded: new Set((saved.submission.uploadedIndices || [])
        .map(index => value.files[index]).filter(Boolean)), running: null };
      if (saved.phase === 'submitting') {
        value.phase = 'error'; value.error = '上次提交尚未确认，请核对后点击重试；不会自动重新提交。';
      }
    }
    if (saved?.phase === 'loading') {
      value.phase = 'draft';
      value.draft ||= { title: '', note: '', check: [], who: { kind: 'me' } };
      value.draft.parseWarning = '上次整理尚未完成，已保留原文，请核对后继续编辑或补充。';
      if (value.draft.pendingChange) value.draft.note = [value.draft.note, '补充要求：\n' + value.draft.pendingChange].filter(Boolean).join('\n\n');
      delete value.draft.pendingChange;
    }
    cards.set(key, value);
    // Evict only the oldest inactive cards; conversation storage persists their content.
    if (cards.size > 60) for (const [old, item] of cards) {
      if (old !== key && !item.parsing && !item.submission?.preflighting && !item.submission?.running) { cards.delete(old); break; }
    }
    return value;
  }
  function snapshot(value, patch) {
    if (!value) return null;
    if (patch) Object.assign(value, patch);
    const state = value.submission, files = state?.context?.files || value.files || [];
    return { version: 1, cardId: value.cardId, ownerScope: value.ownerScope, phase: value.phase,
      draft: clone(value.draft), receipt: clone(value.receipt), error: value.error || '', submitLabel: value.submitLabel || '', files: files.slice(),
      ...(state ? { submission: { id: state.id, stored: clone(state.stored), createStarted: state.createStarted === true,
        uploadedIndices: files.flatMap((file, index) => state.uploaded?.has(file) ? [index] : []),
        attachments: clone(state.attachments || []), result: clone(state.result) } } : {}) };
  }
  function publish(value, patch) {
    if (!value || value.ownerScope !== ownerScope()) return null;
    const saved = snapshot(value, patch);
    try { value.notify?.(saved); } catch (_) { /* Host persistence failure must not redispatch an already-created requirement. */ }
    try { value.observer?.(saved); } catch (_) { /* View teardown must not alter the actual submission result. */ }
    return saved;
  }

  // A draft owns one Task id for its entire submission. Retrying missing
  // materials must neither create a second Task nor dispatch incomplete work.
  async function submit(state, context) {
    if (state.running) return state.running;
    if (state.result) return state.result;
    const run = async () => {
      if (!state.stored) {
        context.guard?.();
        const stored = await context.create(state.id);
        if (!stored || !stored.id) throw new Error('服务未确认需求创建，请检查连接后重试');
        state.id = stored.id;
        state.stored = stored;
        state.context = context;
        try { context.onStored?.(stored); } catch (_) {}
      }
      const saved = state.context ||= context;
      state.uploaded ||= new Set();
      state.attachments ||= [];
      const missing = [];
      for (const [index, file] of saved.files.entries()) {
        if (state.uploaded.has(file)) continue;
        saved.guard?.();
        try {
          if (!saved.upload) throw new Error('附件上传暂时不可用');
          saved.onStage?.('正在上传材料（' + (index + 1) + '/' + saved.files.length + '）…');
          const result = await saved.upload(state.id, file);
          if (!result || result.ok === false || !result.id) throw new Error('服务未确认附件保存成功');
          state.uploaded.add(file);
          // Final cards display server-confirmed attachments; clearing the draft must not leave an empty materials section.
          state.attachments.push({ ...result, filename: result.filename || file.name, size: result.size ?? file.size });
          context.onProgress?.();
        } catch (_) { missing.push(file.name || '附件'); }
      }
      if (missing.length) throw new Error('需求已保存，但 ' + missing.length + ' 个附件未上传：' +
        missing.join('、') + '。点击重试继续上传，材料齐全后再安排执行。');
      saved.guard?.();
      const outcome = await saved.dispatch(state.stored);
      state.result = { ...state.stored, outcome, attachments: state.attachments.slice() };
      return state.result;
    };
    state.running = run();
    try { return await state.running; } finally { state.running = null; }
  }

  async function createRequirement(ctx) {
    const { draft, options, state, card: record, btn, box, current, done, note, mate } = ctx;
    const A = global.SoduWorkAPI || {}, dataScope = ownerScope(), w = draft.who;
    if (record.ownerScope !== dataScope) return;
    box?.querySelectorAll('input,textarea,select,button').forEach(node => { node.disabled = true; });
    options.setAttachmentsLocked?.(true);
    const stage = label => {
      publish(record, { submitLabel: label });
      if (current()) { btn.textContent = label; btn.setAttribute?.('aria-busy', 'true'); }
    };
    state.preflighting = true;
    publish(record, { phase: 'submitting', error: '', submitLabel: '正在保存提交记录…' });
    if (current()) { btn.textContent = record.submitLabel; btn.setAttribute?.('aria-busy', 'true'); }
    try {
      // Persist the stable request ID in the originating conversation before creation or upload; stop if persistence fails.
      await options.onBeforeSubmit?.(snapshot(record));
      state.preflighting = false;
      const base = { title: draft.title.trim(), note, priority: draft.priority || 'normal', due: global.Requirements.dateTimestamp(draft.due),
        kind: draft.kind || 'requirement', acceptanceCriteria: draft.check.map(x => x.trim()).filter(Boolean), tags: draft.tags || [],
        visibility: draft.visibility || 'related', triageStage: options.saveOnly ?
          (['intake', 'clarifying', 'ready'].includes(draft.triageStage || options.triageStage) ? draft.triageStage || options.triageStage : 'intake') : 'ready',
        projectId: options.projectId || null, repoId: draft.repo || '' };
      const result = await submit(state, {
        guard: () => { if (dataScope !== ownerScope()) throw Error('账号或服务已切换，请在当前账号中重新打开需求'); },
        files: record.files.slice(),
        upload: A.uploadAttachment ? (id, file) => A.uploadAttachment(id, file, { purpose: 'requirement_input' }) : null,
        onStage: stage,
        onProgress: () => publish(record),
        onStored: stored => { publish(record); if (current()) options.onTaskStored?.(stored.id, stored.title); },
        create: async id => {
          state.createStarted = true;
          stage(w.kind === 'mate' ? '正在交给同事…' : '正在保存需求…');
          if (w.kind === 'mate') {
            if (!A.createAssignedTask) throw Error('当前版本暂不支持直接交办，请升级 SoduWork 后重试');
            const assigned = await A.createAssignedTask({ ...base, taskId: id, assigneeUserId: w.id });
            if (!assigned?.task?.id) throw Error('服务未确认需求创建');
            // The task is stored on the assignee's device, but the creator is
            // still a read-only participant. Merge the decorated server
            // projection immediately so "我提出" stays correct without
            // waiting for a websocket event or a later full refresh.
            if (typeof Store !== 'undefined' && typeof Store.applyServerEvent === 'function') {
              Store.applyServerEvent({ type: 'task.created', task: assigned.task,
                arrival: 'self', by: assigned.task.createdByName || '' });
            }
            return { id: assigned.task.id, title: assigned.task.title || base.title, directlyAssigned: true,
              targetName: assigned.targetName || mate?.name || '同事',
              assigneeName: assigned.task.assigneeName || assigned.targetName || mate?.name,
              assigneeUserId: assigned.task.assigneeUserId || w.id, priority: assigned.task.priority || base.priority,
              kind: assigned.task.kind || base.kind, createdAt: assigned.task.createdAt ?? assigned.task.created, updatedAt: assigned.task.updatedAt };
          }
          if (typeof Store === 'undefined' || typeof Store.persistTask !== 'function') throw Error('需求同步服务暂时不可用，请重新打开窗口');
          if (!tasks.some(task => task.id === id)) tasks.push({ ...base, id, source: options.source || '自己',
            status: 'todo', handler: '', createdAt: Date.now(), start: '', recur: null, recurAt: '',
            remindAt: '', reminded: false, executionContext: null, workRouting: {} });
          if (typeof save === 'function') save();
          if (!await Store.persistTask(id)) throw Error('SoduWork 服务尚未确认创建需求，请检查连接后重试');
          const canonical = tasks.find(task => task.id === id);
          return { id, title: canonical?.title ?? base.title, directlyAssigned: false,
            assigneeName: canonical?.assigneeName, assigneeUserId: canonical?.assigneeUserId,
            priority: canonical?.priority || base.priority, kind: canonical?.kind || base.kind,
            createdAt: canonical?.createdAt ?? canonical?.created, updatedAt: canonical?.updatedAt };
        },
        dispatch: stored => stored.directlyAssigned ? { who: stored.targetName, warn: '' } : { who: '', warn: '' },
      });
      const out = result.outcome, handedOff = result.directlyAssigned && !out.warn;
      // Return results to the originating conversation before checking view state; navigation must not turn a successful requirement back into a resubmittable draft.
      publish(record, { phase: 'succeeded', receipt: { id: result.id, title: result.title, who: out.who,
        warn: out.warn, gone: Boolean(handedOff), attachments: result.attachments || [],
        assigneeName: result.assigneeName, assigneeUserId: result.assigneeUserId, priority: result.priority,
        kind: result.kind, createdAt: result.createdAt, updatedAt: result.updatedAt } });
      if (!current()) return;
      options.clearAtts?.();
      try { options.onPersisted?.(result.id, result.title, { handedOff }); } catch (_) {}
      if (current()) done(result.id, result.title, out.who, out.warn, handedOff);
    } catch (error) {
      state.preflighting = false;
      if (dataScope !== ownerScope()) return;
      if (!state.stored && state.createStarted && typeof Store !== 'undefined') {
        if (typeof Store.pauseUnconfirmedTask === 'function') Store.pauseUnconfirmedTask(state.id);
        if (typeof render === 'function') render();
      }
      publish(record, { phase: 'error', error: String(error.message || error) });
      if (!current()) return;
      options.setAttachmentsLocked?.(Boolean(state.stored));
      box?.querySelectorAll('input,textarea,select,button').forEach(node => { node.disabled = Boolean(state.stored); });
      btn.removeAttribute?.('aria-busy');
      btn.disabled = false; btn.textContent = state.stored ? '重试上传并继续' : '重试创建需求';
      const cancel = box?.querySelector('#cpCancel'); if (cancel) cancel.disabled = false;
      let presented = false;
      try { presented = options.onSubmitError?.(error, { stored: Boolean(state.stored) }) === true; } catch (_) {}
      if (!presented) global.petSay?.(typeof _humanErr === 'function' ? _humanErr(error, '需求未提交完成') : error.message);
    }
  }

  async function handOff(ctx) {
    const api = global.SoduWorkAPI || {};
    const who = ctx.who || {};
    try {
      if (who.kind === 'mate') {
        if (!ctx.mate || !api.handoffTask) {
          return { who: '', warn: '需求建好了，但没转出去（找不到这位同事）' };
        }
        const result = await api.handoffTask(ctx.id, ctx.mate.id, '');
        if (!result || result.ok === false) {
          throw new Error((result && (result.reason || result.error || result.message)) ||
            '需求没有成功转交给同事');
        }
        if (ctx.dropLocal) ctx.dropLocal();
        return { who: ctx.mate.name, warn: '' };
      }

/* Multi-agent workflows select runtimes per node without requiring another agent selection. */
      if ((who.kind === 'agent' || who.kind === 'workflow') && ctx.flowId && api.startTaskPlugin) {
        const run = await api.startTaskPlugin(ctx.id, {
          bindingId: ctx.flowId,
          instruction: ctx.brief,
          repoId: ctx.repoId || '',
          execution: ctx.agent && global.TaskExecutionClient
            ? global.TaskExecutionClient.execution(ctx.agent, ctx.model) : { model: ctx.model || '' },
          executionContext: ctx.executionContext || {},
        });
        if (!run || run.ok === false) {
          throw new Error((run && (run.reason || run.error || run.message)) ||
            '\u4f01\u4e1a\u5de5\u4f5c\u6d41\u672a\u6210\u529f\u542f\u52a8');
        }
        return { who: ((ctx.flow || {}).name || '企业流程') +
          (ctx.agent ? ' · ' + ctx.agent.name : ''), warn: '' };
      }

      if (who.kind !== 'agent') return { who: '', warn: '' };
      const agentAvailable = ctx.agent && global.TaskExecutionClient &&
        typeof global.TaskExecutionClient.isAvailable === 'function'
        ? global.TaskExecutionClient.isAvailable(ctx.agent)
        : !!ctx.agent && ctx.agent.available !== false && ctx.agent.available !== 0 &&
          !['false', '0', 'no', 'offline', 'unavailable'].includes(
            String(ctx.agent.available == null ? '' : ctx.agent.available).trim().toLowerCase());
      if (!ctx.agent || !agentAvailable) {
        return { who: '', warn: '需求建好了，但没派出去（选中的 Agent 已不可用）' };
      }
      if (!api.dispatchToAI) return { who: '', warn: '需求建好了，但派活能力没有加载成功' };
      const result = await api.dispatchToAI(ctx.id, {
        id: ctx.agent.id,
        type: 'agent',
        cliName: ctx.agent.cliName || '',
      }, ctx.brief, ctx.repo || null, ctx.model || '', ctx.executionContext || null);
      if (!result || result.ok === false) {
        const reason = result && (result.reason || result.error || result.message);
        return { who: '', warn: '\u4efb\u52a1\u5efa\u597d\u4e86\uff0c\u4f46\u6ca1\u6709\u88ab\u6267\u884c\u673a\u63a5\u53d7' +
          (reason ? '\uff08' + String(reason) + '\uff09' : '') + '\uff0c\u53ef\u4ee5\u5728\u8be6\u60c5\u91cc\u91cd\u8bd5' };
      }
      return { who: ctx.agent.name || 'Agent', warn: '' };
    } catch (error) {
      const message = typeof global._humanErr === 'function'
        ? global._humanErr(error, '交办失败')
        : (error && error.message) || '交办失败';
      return { who: '', warn: '需求建好了，但没交出去（' + message + '），可以在详情里重试' };
    }
  }

  function done(ctx) {
    const box = ctx.box;
    if (!box) return;
    const esc = ctx.esc;
    const inChat = ctx.variant === 'chat';
    const inSheet = ctx.variant === 'sheet';
    const outcome = { handedOff: ctx.gone === true && !ctx.warn, attachments: ctx.attachments || [] };
    const latest = typeof tasks !== 'undefined' ? tasks.find(task => task.id === ctx.id) : null;
    const task = { ...ctx, ...(latest || {}) };
    const time = global.Requirements?.timeInfo?.({ createdAt: task.createdAt, created: task.created });
    const assignee = task.assigneeName || (task.assigneeUserId ? '成员 ' + String(task.assigneeUserId).slice(0, 6) : ctx.who || '');
    const priorities = global.TaskPriority?.labels || global.Requirements?.priorities || { critical: '紧急', high: '高', normal: '普通', low: '低' };
    const priority = Object.hasOwn(priorities, task.priority) ? task.priority : 'normal';
    const kinds = global.Requirements?.kinds || { requirement: '需求', bug: 'Bug', ticket: '工单', improvement: '优化', other: '其它' };
    const kindLabel = kinds[task.kind] || kinds.requirement || '需求';
    const timeHtml = time ? '<time class="cp-receipt-time"' + (time.datetime ? ' datetime="' + esc(time.datetime) + '"' : '') +
      ' title="' + esc(time.title) + '">' + esc(time.text) + '</time>' : '<span>时间未记录</span>';
    const openLabel = inChat && !outcome.handedOff ? '进入协作' : '查看详情';
    box.innerHTML = '<div class="cp-card cp-ok">' +
      '<div class="cp-card-head cp-okh"><svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>' +
      (ctx.who ? '已创建，已交给 ' + esc(ctx.who) : '已创建') + '</div>' +
      "<div class=\"cp-done-title\" data-user-content>" + esc(ctx.title) + '</div>' +
      '<div class="cp-receipt-meta"><div><span class="cp-receipt-label">类型</span><span class="cp-receipt-kind">' + esc(kindLabel) + '</span></div>' + (assignee ? '<div><span class="cp-receipt-label">负责人</span><span data-user-content title="' + esc(assignee) + '">' + esc(assignee) + '</span></div>' : '') +
      '<div><span class="cp-receipt-label">优先级</span><span class="cp-receipt-priority is-' + priority + '">' + esc(priorities[priority]) + '</span></div>' +
      '<div><span class="cp-receipt-label">创建时间</span>' + timeHtml + '</div></div>' +
      (ctx.warn ? '<div class="cp-warn">' + esc(ctx.warn) + '</div>' : '') +
      '<div class="cp-acts">' +
      (ctx.id ? '<button class="cp-primary" id="cpOpen">' + openLabel + '</button>' : '') +
      (ctx.persistent ? '' : '<button class="' + (ctx.id ? 'cp-ghost' : 'cp-primary') + '" data-cp-receipt-close>' +
      (inChat ? '继续对话' : inSheet ? '关闭' : '再建一条') + '</button>') + '</div></div>';

    // Variant hook: the full-screen entry sheet must close itself before the
    // detail opens, or the detail renders underneath the sheet layer (pui-layer
    // z-2400 vs rq-detail z-1300) and the click looks dead.
    const openDetail = () => {
      if (typeof ctx.onOpenDetail === 'function') { ctx.onOpenDetail(ctx.id, ctx.title, outcome); return; }
      if (typeof global.openDetailEntry === 'function') global.openDetailEntry(ctx.id);
      else if (global.WorkspaceHost) global.WorkspaceHost.open('detail', { taskId: ctx.id });
    };
    const open = box.querySelector('#cpOpen');
    if (open) open.addEventListener('click', () => {
      // A transferred task is visible for tracking, not executable by the sender.
      if (!outcome.handedOff && typeof ctx.onOpen === 'function') ctx.onOpen(ctx.id, ctx.title, outcome);
      else openDetail();
    });
    const more = box.querySelector('[data-cp-receipt-close]');
    if (more) more.addEventListener('click', () => {
      if (ctx.clear) ctx.clear();
      if (ctx.reset) ctx.reset();
    });
    if (!ctx.restored && ctx.onCreated) ctx.onCreated(ctx.id, ctx.title, outcome);
    ctx.onReceiptRendered?.(ctx.id, ctx.title, outcome);
    if (typeof global.render === 'function') global.render();
  }

  global.ComposeDraftSubmit = { submit, handOff, done, card, snapshot, publish, createRequirement };
  global.addEventListener?.('soduwork-data-scope-changed', () => cards.clear());
})(window);
