/*
 * Render and submit the current approval; historical approvals remain read-only trace
 * evidence. Existing SoduWorkAPI calls and backend authorization govern decisions.
 */
(function (global) {
  'use strict';

  const APPROVAL_TEXT = {
    baseline: '需求确认', review: '验收交付结果', merge: '合并授权',
    uat: '环境验收', deploy: '发布授权',
  };
  const STATE_TONE = {
    pending: 'wait', waiting_human: 'wait', approved: 'ok',
    rejected: 'bad', failed: 'bad', revoked: 'idle',
  };
  const STATE_LABEL = {
    pending: '等待确认', waiting_human: '等待确认', waiting: '等待确认',
    approved: '已批准', rejected: '已退回', failed: '处理失败', revoked: '已失效',
  };
  const acceptanceModes = new Map();
  const acceptanceOpens = new Map();
  const recentAcceptanceOpens = new Map();
  const ACCEPTANCE_OPEN_DEDUPE_MS = 2000;
  let acceptanceEpoch = 0;
  let pendingEligibility = null;
  let approvalAccessRevision = 0;
  let eligibilitySnapshot = '';
  const cardRoots = new WeakMap(), deniedRoots = new WeakMap();
  const invalidateEligibility = () => { approvalAccessRevision++; pendingEligibility = null; };
  global.addEventListener?.('soduwork-approvals-invalidated', invalidateEligibility);
  global.addEventListener?.('soduwork-approvals-changed', () => {
    const rows = global.TaskApprovalInbox?.snapshot?.();
    if (!Array.isArray(rows)) return;
    const signature = JSON.stringify(rows.map(requestId).filter(Boolean).sort());
    if (signature !== eligibilitySnapshot) {
      eligibilitySnapshot = signature;
      invalidateEligibility();
    }
  });
  const acceptanceKey = (id, consent) => String(id || '') + ':' + String(consent || '');
  function manualConfirmationOnly(item) {
    const confirmation = item?.confirmation || {}, artifact = confirmation.lockedArtifact || item?.artifact || {};
    return item?.action === 'review' && ((item.gate || confirmation.gate)?.readiness?.requiresHumanConfirmation === true ||
      (artifact.kind === 'manual' && artifact.manifest?.manual === true));
  }
  global.addEventListener?.('soduwork-data-scope-changed', () => {
    acceptanceEpoch++; acceptanceModes.clear(); acceptanceOpens.clear(); recentAcceptanceOpens.clear();
    eligibilitySnapshot = '';
    invalidateEligibility();
  });

  // Show review entry points from actual pending work and creator fallback, regardless of the execution device.
  function canAcceptTask(task, context) {
    const R = global.Requirements;
    if (!task || !R || R.stage(task) !== 'reviewing' || task.reviewedAt || task.canViewExecution === false) return false;
    const creator = R.canReview(task) ||
      (Boolean(global.__teamCap?.meId) && String(task.createdBy || '') === String(global.__teamCap.meId));
    const item = R.approval(task, context);
    if (item) return item.action === 'review' && creator &&
      (!item.status || item.status === 'pending') && !item.myDecision;
    return task.status === 'done' && creator && !R.waitingOn(task, context).length;
  }
  /*
   * Reuse the execution conversation for review only when the server confirms both roles
   * belong to the same user. Otherwise use a separate review conversation.
   */
  function sameExecutorReviewer(task, assignment, direct, capability = global.__teamCap) {
    const reviewer = String(assignment?.userId || (direct ? task?.createdBy : '') || '').trim();
    const executor = String(task?.assigneeUserId || task?.executorUserId ||
      task?.executionContext?.assigneeUserId || (direct ? task?.createdBy : '') || '').trim();
    const me = String(capability?.meId || '').trim();
    /*
     * The signed-in user must own both roles; matching card IDs alone cannot authorize review
     * context.
     */
    return Boolean(me && reviewer && executor && reviewer === executor && me === reviewer);
  }
  function currentTeamCapability() {
    if (String(global.__teamCap?.meId || '').trim()) return global.__teamCap;
    const load = global.SoduWorkAPI?.getTeamCapability;
    if (typeof load !== 'function') return global.__teamCap || {};
    return Promise.resolve().then(() => load()).then(capability => {
      if (capability && typeof capability === 'object' && String(capability.meId || '').trim()) {
        global.__teamCap = capability;
        return capability;
      }
      return global.__teamCap || {};
    }).catch(() => global.__teamCap || {});
  }
  function openAcceptance(task, opts = {}) {
    const id = String(task?.id || '');
    const mode = opts.acceptanceMode === 'auto' ? 'auto' : 'manual';
    const approvalId = String(opts.approvalId || '').startsWith('direct:') ? '' : String(opts.approvalId || '');
    // The card has one active acceptance session per approval. Keep the mode
    // out of the dedupe key so a quick radio switch cannot create two chats.
    const key = [id, approvalId, acceptanceEpoch].join(':');
    const recent = recentAcceptanceOpens.get(key);
    if (recent && recent.expiresAt > Date.now()) return recent.promise;
    if (recent) recentAcceptanceOpens.delete(key);
    const inFlight = acceptanceOpens.get(key);
    if (inFlight) return inFlight;
    const run = (async () => {
      const epoch = acceptanceEpoch;
      const assertCurrent = () => { if (epoch !== acceptanceEpoch) throw new Error('账号或服务已变化，请重新打开需求后重试'); };
      if (!id || typeof global.openTaskConversation !== 'function') throw new Error('验收会话暂时无法打开，请重试');
      const latest = global.SoduWorkAPI?.getTask ? await global.SoduWorkAPI.getTask(id) : task;
      assertCurrent();
      if (global.Requirements && (!latest || global.Requirements.stage(latest) !== 'reviewing' || latest.reviewedAt || latest.canViewExecution === false))
        throw new Error('需求状态或验收权限已变化，请刷新后重试');
      if (mode === 'auto') {
        const translated = message => global.SoduWorkI18n?.translateText?.(message) || message;
        if (typeof global.SoduWorkAPI?.getAcceptanceContext !== 'function')
          throw new Error(translated('暂时无法读取验收条件，请刷新后重试'));
        const context = await global.SoduWorkAPI.getAcceptanceContext(id);
        assertCurrent();
        if (context?.readiness?.requiresHumanConfirmation === true ||
            (context?.artifact?.kind === 'manual' && context?.artifact?.manifest?.manual === true))
          throw new Error('本轮没有可自动核验的交付物，请使用手动验收确认实际结果');
        // Use the approval's frozen criteria, not a mutable task field. Fail
        // before navigation; runtime and Hub guards still recheck on send.
        if (!Array.isArray(context?.criteria) || !context.criteria.length || !context.artifactVersionId)
          throw new Error(translated('自动验收需要明确的验收标准和固定交付版本，请先补齐或选择手动验收'));
      }
      const capabilityResult = currentTeamCapability();
      const capability = capabilityResult && typeof capabilityResult.then === 'function'
        ? await capabilityResult : capabilityResult;
      assertCurrent();
      if (global.Requirements?.canReview && !global.Requirements.canReview(latest) &&
          String(latest?.createdBy || '') !== String(capability?.meId || ''))
        throw new Error('只有需求创建人可以验收交付成果');
      let assignment = null;
      if (approvalId && global.SoduWorkAPI?.approvalDetail) {
        const response = await global.SoduWorkAPI.approvalDetail(approvalId), item = response?.item;
        assertCurrent();
        if (!item || item.action !== 'review' || item.status !== 'pending' || !item.assignment || item.myDecision)
          throw new Error('当前验收已处理或不由你确认，请刷新后重试');
        assignment = item.assignment;
      }
      const direct = !approvalId;
      const samePerson = sameExecutorReviewer(latest, assignment, direct, capability);
      const preferred = samePerson && global.TaskConversationNavigation?.preferredConversation
        ? await global.TaskConversationNavigation.preferredConversation(latest) : '';
      assertCurrent();
      const originalId = preferred || (samePerson ? latest?.workRouting?.conversationTurn?.conversationId : '');
      const reuseExecutionSession = Boolean(originalId);
      const opened = await global.openTaskConversation(id, latest?.title || task.title || '', {
        /* acceptanceSession itself creates a clean session on the first open.
           Keeping forceNew false is essential afterwards: navigation can reuse
           the in-flight/current/cached acceptance session when the same card is
           opened again from the chat or requirement drawer. */
        source: 'acceptance', forceNew: false,
        /*
         * Keep the original conversation type and mark this turn as review context. Navigation
         * creates a separate review conversation if the original is unavailable.
         */
        acceptanceSession: !reuseExecutionSession,
        ...(reuseExecutionSession ? {chatId: originalId, reuseExecutionSession: true, acceptanceExecutionSession: true} : {}),
        acceptanceMode: mode, approvalId,
        ...(Array.isArray(opts.acceptanceAttachmentIds) && opts.acceptanceAttachmentIds.length
          ? {acceptanceAttachmentIds: [...new Set(opts.acceptanceAttachmentIds.map(String))].slice(0, 60)} : {}),
      });
      if (!opened) throw new Error('验收会话未能打开，需求仍保留在待验收，可重试');
      assertCurrent();
      await opts.onOpened?.(opts.approvalId || '', mode);
      return true;
    })();
    const tracked = run.then((result) => {
      recentAcceptanceOpens.set(key, {promise: tracked, expiresAt: Date.now() + ACCEPTANCE_OPEN_DEDUPE_MS});
      return result;
    }, (error) => { throw error; });
    acceptanceOpens.set(key, tracked);
    tracked.then(() => {
      if (acceptanceOpens.get(key) === tracked) acceptanceOpens.delete(key);
    }, () => {
      if (acceptanceOpens.get(key) === tracked) acceptanceOpens.delete(key);
    });
    return tracked;
  }

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[char]));
  }
  function tone(value) { return STATE_TONE[value] || 'idle'; }
  function statusLabel(value) { return STATE_LABEL[String(value || '').toLowerCase()] || '等待确认'; }
  function say(message) {
    if (typeof global.petSay === 'function') global.petSay(message);
  }
  function humanError(error, fallback) {
    return typeof global._humanErr === 'function'
      ? global._humanErr(error, fallback) : fallback;
  }
  function requestId(item) {
    const row = item || {};
    return String(row.id || row.requestId || '');
  }
  function current(list, preferredId) {
    const pending = (list || []).filter((item) =>
      String((item || {}).status || '') === 'pending');
    const preferred = String(preferredId || '');
    if (preferred) {
      const matched = pending.find((item) => requestId(item) === preferred);
      return matched || null;
    }
    return pending.slice().reverse()[0] || null;
  }
  function currentId(trace, node) {
    const currentNode = node || {};
    const output = currentNode.output || currentNode.rawOutput || {};
    const card = (trace || {}).card || {};
    const pending = card.pending || {};
    const delivery = (trace || {}).delivery || {};
    const blocker = (delivery.blockers || []).find((item) =>
      String((item || {}).action || '') === 'approval');
    return [currentNode.requestId, currentNode.approvalId, output.requestId,
      output.approvalId, output.approvalRequestId, pending.requestId,
      blocker && (blocker.requestId || blocker.approvalId)].map(String)
      .find((value) => value && value !== 'undefined' && value !== 'null') || '';
  }
  function needsVerification(item) {
    return ['merge', 'deploy', 'uat'].includes(String((item || {}).action || ''));
  }
  /*
   * Show the approval subject consistently in list rendering and detail refreshes through
   * renderSubject.
   */
  function subjectOf(item) {
    const confirmation = (item || {}).confirmation || {};
    const artifact = confirmation.lockedArtifact || item.artifact || {};
    const target = confirmation.targetEnvironment || {};
    const gate = item.gate || confirmation.gate || {};
    return [artifact.seq ? 'v' + Number(artifact.seq) : '',
      artifact.commit || artifact.checksum
        ? String(artifact.commit || artifact.checksum).slice(0, 14) : '',
      target.name || gate.subject?.environmentName || ''].filter(Boolean).join(' · ');
  }

  /*
   * Use identical gate markup in list and detail views; polling compares markup and would
   * otherwise redraw unchanged cards.
   */
  function gateNotice(item) {
    const gate = item.gate || (item.confirmation || {}).gate || {};
    const readiness = gate.readiness || {};
    if (readiness.canApprove !== false) return '';
    const requirements = gate.requirements || [];
    const blockers = readiness.blockers || [];
    const needsImage = requirements.some((requirement) =>
      !requirement.satisfied && (requirement.oneOf || []).includes('image'));
    return '<div class="tfd-inline-approval-gate is-blocked"><span>还需补充证据</span>' +
      (blockers.length ? '<small>' + esc(blockers.join('；')) + '</small>' : '') +
      (needsImage
        ? '<label class="tfd-inline-upload"><input type="file" data-tfd-approval-file hidden><span>上传截图</span></label>'
        /*
         * Explain evidence gaps that only the executor can resolve instead of showing unusable
         * review buttons.
         */
        : '<small>此项证据由执行侧产生，补齐后确认自动恢复；无法补齐时可退回修改。</small>') +
      '</div>';
  }

  function evidenceSummary(item) {
    const gate = item.gate || (item.confirmation || {}).gate || {};
    const requirements = Array.isArray(gate.requirements) ? gate.requirements : [];
    if (!requirements.length) return '';
    const satisfied = requirements.filter(requirement => requirement && requirement.satisfied).length;
    const blockers = (gate.readiness && gate.readiness.blockers || []).filter(Boolean);
    const detail = blockers.length ? blockers.slice(0, 2).join('；') :
      satisfied === requirements.length ? '验收标准与固定版本证据已就绪' : '仍有证据需要补齐';
    return '<div class="tfd-inline-evidence-summary ' + (satisfied === requirements.length ? 'is-ready' : 'is-pending') + '" role="status">' +
      '<span class="tfd-inline-evidence-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 12.5 9.2 17 19 7"/></svg></span>' +
      '<span><b>验收资料</b><small>' + esc(satisfied) + '/' + esc(requirements.length) + ' 项已满足 · ' + esc(detail) + '</small></span></div>';
  }

  function html(list, opts, preferredId) {
    if (!opts || opts.variant !== 'task') return '';
    const item = current(list, preferredId);
    // A decision already submitted by this user is a waiting state. Do not
    // recreate the actionable card while the remaining approvers finish.
    if (!item || item.myDecision) return '';
    const confirmation = item.confirmation || {};
    const artifact = confirmation.lockedArtifact || item.artifact || {};
    const notice = gateNotice(item);
    const evidence = evidenceSummary(item);
    const verify = needsVerification(item);
    const title = confirmation.title || APPROVAL_TEXT[item.action] || '当前审批';
    const subject = subjectOf(item);
    const required = Math.max(1, Number(item.required || confirmation.required || 1));
    const blocking = opts.blocksExecution !== false;
    const taskTitle = opts.taskTitle || (item.task || {}).title || '';
    // Creator-direct review uses a synthetic direct:{taskId} ID and the same presentation as Hub approvals.
    const direct = String(requestId(item)).startsWith('direct:');
    const taskId = String(opts.taskId || '');
    const review = String(item.action || '') === 'review';
    const manualOnly = manualConfirmationOnly(item);
    const mode = manualOnly ? 'manual' : acceptanceModes.get(acceptanceKey(requestId(item), item.artifactVersionId || artifact.id || subject)) || 'manual';
    return '<section class="tfd-inline-approval is-' + tone(item.status) +
      '" data-tfd-acceptance-choice="' + mode + '" data-tfd-approval-id="' + esc(requestId(item)) + '" data-tfd-consent="' + esc(item.artifactVersionId || artifact.id || subject) + '" data-tfd-blocking="' + blocking + '"' + (direct ? ' data-tfd-direct="1"' : '') + '>' +
      '<header><div class="tfd-inline-approval-title"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="m12 3 8 3v6c0 4-4 7-8 9-4-2-8-5-8-9V6zM12 8v5m0 3h.01"/></svg><b>' +
      esc(title) + '</b></div><em>' + esc(statusLabel(item.status)) + '</em></header>' +
      '<div class="tfd-inline-approval-body">' +
      (taskTitle ? '<p class="tfd-inline-task-name">' + esc(taskTitle) + '</p>' : '') +
      (review ? '' : '<p class="tfd-inline-rule">' + (blocking
        ? (required > 1 ? '需 ' + required + ' 人批准后继续下一步。' : '批准后继续下一步，退回则暂停并修改。')
        : (required > 1 ? '本次交付需 ' + required + ' 人确认。' : '请确认本次需求的交付结果。')) + '</p>') +
      evidence + notice + (review ? '<p role="status" data-tfd-manual-only' + (manualOnly ? '' : ' hidden') + '>本轮没有可自动核验的交付物，请使用手动验收确认实际结果</p>' : '') +
      (review && taskId ? '<fieldset class="tfd-acceptance-method"><legend>验收方式</legend><div class="tfd-acceptance-options">' +
        ['manual', 'auto'].map(value => '<label><input type="radio" name="tfd-acceptance-' + esc(requestId(item)) + '" data-tfd-acceptance-mode value="' + value + '"' +
          (mode === value ? ' checked' : '') + (manualOnly && value === 'auto' ? ' disabled' : '') + '><span>' + (value === 'manual' ? '手动验收' : '自动验收') + '</span></label>').join('') +
        '</div><p data-tfd-mode-manual>在新会话中核对本次固定版本与证据，不重新执行原需求；分析完成后回到此卡提交确认或退回。</p>' +
        '<p data-tfd-mode-auto>打开独立验收会话，由 SoduWork 核对本次固定版本。只有完整报告且每项标准可证实才会自动提交；失败或未通过保留待验收并附逐项证据。原交付物不重新执行或修改，启动失败可重试。</p></fieldset>' : '') +
      (verify ? '<label class="tfd-inline-verify"' + (review && taskId ? ' data-tfd-mode-manual' : '') + '><input type="checkbox" data-tfd-approval-verify><span>我已核对本次版本、证据与环境范围</span></label>' : '') +
      '<details class="tfd-inline-approval-form"' + (review && taskId ? ' data-tfd-mode-manual' : '') + (review && taskId && mode === 'manual' ? ' open' : '') + ' data-tfd-open="inline-approval-form"><summary>说明与审批依据<svg viewBox="0 0 24 24"><path d="m8 10 4 4 4-4"/></svg></summary>' +
      '<label class="tfd-inline-note"><span>审批说明 <small>退回时必填</small></span><textarea rows="2" maxlength="2000" data-tfd-approval-note placeholder="需要修改什么，或补充批准依据"></textarea></label>' +
      (review ? '<div class="tfd-inline-rework-files" data-tfd-rework-files>' +
        '<label class="tfd-inline-file-picker"><input type="file" multiple data-tfd-rework-file hidden><span>添加返修资料</span></label>' +
        '<small>仅作为返修参考，不会计入交付产物</small><div data-tfd-rework-file-list></div></div>' : '') +
      '</details>' + (direct ? '' : '<details class="tfd-inline-approval-form tfd-inline-proof" data-tfd-open="inline-approval-evidence"><summary>查看验收标准与证据<svg viewBox="0 0 24 24"><path d="m8 10 4 4 4-4"/></svg></summary>' +
      '<div data-tfd-proof-body><p>展开后加载本次固定版本的证据</p></div></details>') +
      '<p class="tfd-inline-error" data-tfd-approval-error role="alert" hidden></p>' +
      '<div class="tfd-inline-actions"><small class="tfd-inline-hint">' + (direct ? '由需求创建人确认' : '仅指定审批人可处理') + '</small>' +
      (review && taskId ? '<button type="button" class="tfd-inline-secondary" data-tfd-mode-manual data-tfd-acceptance-session="1">在会话中分析</button>' +
        '<button type="button" class="primary" data-tfd-mode-auto data-tfd-acceptance-session="auto">开始自动验收</button>' : '') +
      '<button type="button" class="danger"' + (review && taskId ? ' data-tfd-mode-manual' : '') + ' data-tfd-approval-action="reject">退回修改</button>' +
      '<button type="button" class="primary"' + (review && taskId ? ' data-tfd-mode-manual' : '') + ' data-tfd-approval-action="approve"' + ((verify || notice) ? ' disabled' : '') + '>' +
      (blocking ? '批准' + (required > 1 ? '（我的意见）' : '并继续') : '确认验收') + '</button></div></div></section>';
  }

  function focus(trace, taskId) {
    const rows = (trace && trace.approvals) || [];
    const open = current(rows) || rows.slice().reverse().find((item) =>
      ['waiting_human', 'waiting'].includes(String((item || {}).status || '')));
    return { taskId: String(taskId || ''), approvalId: String((open || {}).id || '') };
  }
  function taskIdFromState(state) {
    const trace = (state && state.trace) || {};
    const opts = (state && state.opts) || {};
    return String(((trace.task || {}).id) || ((trace.card || {}).taskId) || opts.taskId || '');
  }

  const submitting = new Set();
  const detailsByCard = new WeakMap();
  function concealUnauthorized(block, revision = approvalAccessRevision) {
    if (!block) return;
    const root = cardRoots.get(block);
    if (root) deniedRoots.set(root, revision);
    const host = typeof block.closest === 'function'
      ? block.closest('[data-task-confirmation], [data-rq-approval-card]')
      : null;
    if (typeof block.remove === 'function') block.remove();
    else block.hidden = true;
    /*
     * Hide the containing review region when authorization filters out its only card.
     */
    if (host && typeof host.querySelector === 'function' &&
        !host.querySelector('[data-tfd-approval-id]')) host.hidden = true;
  }
  function showError(block, message) {
    const output = block.querySelector('[data-tfd-approval-error]');
    if (output) { output.textContent = message; output.hidden = !message; }
  }
  function syncAcceptanceMode(block, mode) {
    if (!block) return;
    const selected = mode === 'auto' && block.dataset.tfdManualOnly !== 'true' ? 'auto' : 'manual';
    block.dataset.tfdAcceptanceChoice = selected;
    block.querySelectorAll?.('[data-tfd-acceptance-mode]').forEach(input => { input.checked = input.value === selected; });
    block.querySelectorAll?.('[data-tfd-mode-manual], [data-tfd-mode-auto]').forEach((element) => {
      if (typeof element.hasAttribute !== 'function') return;
      const visible = selected === 'manual'
        ? element.hasAttribute('data-tfd-mode-manual')
        : element.hasAttribute('data-tfd-mode-auto');
      element.hidden = !visible;
      element.setAttribute?.('aria-hidden', String(!visible));
    });
  }
  // The chat surface replaces successful choices with read-only receipts.
  // Other surfaces dismiss them and refresh from the authoritative task state.
  function dismissAcceptanceCard(block, state, outcome) {
    if (!block) return;
    block.dataset.acceptanceClosed = 'true';
    try {
      if (state?.opts?.onAcceptanceClosed?.(block, outcome) === true) return;
    } catch (_) { /* A presentation failure must not undo a submitted choice. */ }
    block.hidden = true;
    const host = block.closest?.('[data-task-confirmation], [data-rq-approval-card]');
    if (typeof block.remove === 'function') block.remove(); else block.hidden = true;
    if (host && host !== block) {
      const cards = [...(host.querySelectorAll?.('[data-tfd-approval-id]') || [])];
      if (!cards.some(card => !card.hidden)) {
        if (typeof host.remove === 'function') host.remove(); else host.hidden = true;
      }
    }
  }
  function syncActions(block, state) {
    const id = block.getAttribute('data-tfd-approval-id');
    const approval = detailsByCard.get(block) || current(((state || {}).trace || {}).approvals, id) ||
      (String(id || '').startsWith('direct:') ? {id, action: 'review', status: 'pending'} : null);
    const gate = approval && (approval.gate || (approval.confirmation || {}).gate) || {};
    const manualOnly = manualConfirmationOnly(approval);
    block.dataset.tfdManualOnly = String(manualOnly);
    const manualHint = block.querySelector('[data-tfd-manual-only]');
    if (manualHint) manualHint.hidden = !manualOnly;
    if (manualOnly) syncAcceptanceMode(block, 'manual');
    const verify = block.querySelector('[data-tfd-approval-verify]');
    block.querySelectorAll('[data-tfd-approval-action], [data-tfd-approval-file], [data-tfd-acceptance-session], [data-tfd-acceptance-mode]').forEach((item) => {
      item.disabled = !approval || approval.status !== 'pending' || ['loading', 'denied', 'error'].includes(block.dataset.approvalAccess) ||
        Boolean(approval.myDecision) || submitting.has(id) || block.dataset.approvalSubmitted === 'true' ||
        (manualOnly && (item.getAttribute('data-tfd-acceptance-session') === 'auto' ||
          (item.hasAttribute?.('data-tfd-acceptance-mode') && item.value === 'auto'))) ||
        (item.getAttribute('data-tfd-approval-action') === 'approve' &&
          ((needsVerification(approval) && !(verify && verify.checked)) ||
            (gate.readiness?.canApprove === false)));
    });
  }

  async function uploadReworkFiles(block, state, direct) {
    const input = block && block.querySelector('[data-tfd-rework-file]');
    const selectedFiles = input && input.files ? [...input.files] : [];
    if (selectedFiles.length > 20) throw new Error('返修资料最多添加 20 个文件');
    const files = selectedFiles;
    if (!files.length) return [];
    const signature = files.map(file => [file.name, file.size, file.lastModified].join(':')).join('|');
    if (block.dataset.tfdReworkFileSignature === signature && block.dataset.tfdReworkAttachmentIds) {
      try { return JSON.parse(block.dataset.tfdReworkAttachmentIds); } catch (_) { /* upload again */ }
    }
    const api = global.SoduWorkAPI;
    const approvalId = block.getAttribute('data-tfd-approval-id') || '';
    const taskId = taskIdFromState(state);
    const upload = direct ? api?.uploadTaskReworkMaterial : api?.uploadApprovalReworkMaterial;
    if (!upload || (direct ? !taskId : !approvalId)) {
      throw new Error('当前客户端暂不支持上传返修资料，请先更新后重试');
    }
    input.disabled = true;
    try {
      const ids = [];
      for (const file of files) {
        const result = await upload(direct ? taskId : approvalId, file);
        const row = result?.attachment || result?.item || result;
        const id = String(row?.id || row?.attachmentId || '').trim();
        if (!id) throw new Error('返修资料上传后没有返回附件标识');
        ids.push(id);
      }
      block.dataset.tfdReworkFileSignature = signature;
      block.dataset.tfdReworkAttachmentIds = JSON.stringify(ids);
      say(files.length > 1 ? '返修资料已添加' : '返修资料已添加');
      return ids;
    } finally {
      input.disabled = false;
    }
  }

  function renderReworkFiles(input) {
    const block = input && input.closest('.tfd-inline-approval');
    const list = block && block.querySelector('[data-tfd-rework-file-list]');
    if (!list) return;
    delete block.dataset.tfdReworkFileSignature;
    delete block.dataset.tfdReworkAttachmentIds;
    list.replaceChildren();
    [...(input.files || [])].slice(0, 20).forEach((file) => {
      const chip = document.createElement('span');
      chip.className = 'tfd-inline-rework-file';
      chip.textContent = String(file.name || '返修资料');
      list.append(chip);
    });
  }

  async function submit(button, decision, state) {
    const block = button.closest('.tfd-inline-approval');
    const id = block && block.getAttribute('data-tfd-approval-id');
    /*
     * Submit creator-direct decisions through directApi and Hub decisions through
     * decideApproval. Validation, drafts, and feedback remain shared.
     */
    const direct = String(id || '').startsWith('direct:');
    const directApi = (state || {}).directApi;
    if (direct && (!directApi || typeof directApi.approve !== 'function' || typeof directApi.reject !== 'function')) return;
    if (!block || !id || !global.SoduWorkAPI || (!direct && typeof global.SoduWorkAPI.decideApproval !== 'function')) return;
    if (button.disabled || submitting.has(id) || block.dataset.approvalSubmitted === 'true' ||
        !['approve', 'reject'].includes(decision)) return;
    showError(block, '');
    const note = block.querySelector('[data-tfd-approval-note]');
    const text = note ? String(note.value || '').trim() : '';
    if (decision === 'reject' && !text) {
      const details = block.querySelector('.tfd-inline-approval-form');
      if (details) details.open = true;
      if (note) note.focus();
      if (note && typeof note.scrollIntoView === 'function') note.scrollIntoView({block: 'center'});
      showError(block, '请写明需要修改的内容，再退回。');
      return;
    }
    const approval = detailsByCard.get(block) || current(((state || {}).trace || {}).approvals, id);
    const gate = approval && (approval.gate || (approval.confirmation || {}).gate) || {};
    const verify = block.querySelector('[data-tfd-approval-verify]');
    if (!approval || approval.status !== 'pending') {
      showError(block, '当前审批已变化，请刷新后查看最新状态。');
      syncActions(block, state);
      return;
    }
    // Rejection retains executor-owned feedback; workflow gates keep their graph transitions.
    if (decision === 'approve' && ((needsVerification(approval) && !(verify && verify.checked)) ||
        (gate.readiness && gate.readiness.canApprove === false))) {
      showError(block, '请先补齐证据并确认当前版本。');
      return;
    }
    submitting.add(id);
    syncActions(block, state);
    block.setAttribute('aria-busy', 'true');
    try {
      const reworkAttachmentIds = decision === 'reject'
        ? await uploadReworkFiles(block, state, direct) : [];
      const result = direct
        ? await (decision === 'approve' ? directApi.approve(text) : directApi.reject(text, reworkAttachmentIds))
        : await global.SoduWorkAPI.decideApproval(id, decision, text, undefined, reworkAttachmentIds);
      if (!result || result.ok === false) throw new Error('审批未被接受');
      block.dataset.approvalSubmitted = 'true';
      dismissAcceptanceCard(block, state, { decision, note: text, status: result.request?.status || '' });
      const request = result.request || {};
      const blocking = block.getAttribute('data-tfd-blocking') !== 'false';
      const rework = (result || {}).rework || {};
      say(direct
        ? (decision === 'approve' ? '交付结果已确认'
          : '已退回，修改意见已经留在需求里')
        : (decision === 'approve' ? (request.status === 'approved'
        ? (blocking ? '审批已通过，流程将继续下一步' : '交付结果已确认')
        : '你的批准意见已提交，仍需等待其他审批人' + (blocking ? '，流程暂不继续' : '确认')) :
        (rework.started ? '已退回，修改意见已经送回流程'
          : '已退回，修改意见已经留在需求里')));
      try {
        if (state && typeof state.refresh === 'function') await state.refresh(true);
        const opts = (state && state.opts) || {};
        if (typeof opts.onChanged === 'function') await opts.onChanged(taskIdFromState(state));
      } catch (_) {
        showError(block, '审批意见已提交，状态刷新暂时失败。请刷新查看，无需重复提交。');
      }
    } catch (error) {
      const fallback = /403|权限|审批人未分配/.test(String((error && error.message) || error || ''))
        ? (direct ? '这项交付只能由需求创建人确认' : '这项审批当前分配给其他人处理')
        : (direct ? '验收意见没有提交成功，请刷新后再试' : '审批没有提交成功，请刷新后再试');
      showError(block, humanError(error, fallback));
    } finally {
      submitting.delete(id);
      block.removeAttribute('aria-busy');
      syncActions(block, state);
    }
  }

  async function startAcceptance(button, state) {
    const block = button.closest('.tfd-inline-approval');
    const taskId = taskIdFromState(state);
    if (!block || !taskId || button.disabled) return;
    const id = block.getAttribute('data-tfd-approval-id') || taskId;
    if (submitting.has(id)) return;
    submitting.add(id); button.disabled = true; block.setAttribute('aria-busy', 'true'); showError(block, '');
    try {
      await openAcceptance({id: taskId, title: state?.opts?.taskTitle || ''}, {
        acceptanceMode: button.getAttribute('data-tfd-acceptance-session') === 'auto' ? 'auto' : 'manual',
        approvalId: id, onOpened: state?.opts?.onAcceptanceOpened,
      });
      dismissAcceptanceCard(block, state, {
        decision: button.getAttribute('data-tfd-acceptance-session') === 'auto' ? 'auto' : 'manual',
      });
    } catch (error) {
      showError(block, String(error?.message || '验收会话未能打开，请重试'));
    } finally {
      submitting.delete(id); block.removeAttribute('aria-busy');
      if (button.isConnected) button.disabled = false;
      syncActions(block, state);
    }
  }

  async function upload(input, state) {
    const file = input.files && input.files[0];
    const block = input.closest('.tfd-inline-approval');
    const id = block && block.getAttribute('data-tfd-approval-id');
    if (!file || !id || !global.SoduWorkAPI || typeof global.SoduWorkAPI.uploadApprovalEvidence !== 'function') return;
    input.disabled = true;
    try {
      await global.SoduWorkAPI.uploadApprovalEvidence(id, file);
      say('验收截图已进入当前审批证据');
      if (state && typeof state.refresh === 'function') await state.refresh(true);
    } catch (error) {
      say(humanError(error, '截图暂时没有上传成功'));
    } finally {
      input.disabled = false;
      input.value = '';
    }
  }

  const boundStates = new WeakMap();
  function eligibleApprovalIds() {
    if (pendingEligibility) return pendingEligibility;
    const request = Promise.resolve().then(() => global.SoduWorkAPI.listApprovals('pending')).then(result => {
      // The complete reference list includes candidates beyond the first inbox page.
      // Trace rows describe shared facts and do not establish review permission.
      const rows = Array.isArray(result?.pendingTasks) ? result.pendingTasks : result?.items;
      if (!Array.isArray(rows)) throw new Error('审批权限列表暂时不可用');
      return new Set(rows.filter(item => item && !item.myDecision && (!item.status || item.status === 'pending'))
        .map(requestId).filter(Boolean));
    });
    pendingEligibility = request;
    const clear = () => { if (pendingEligibility === request) pendingEligibility = null; };
    request.then(clear, clear);
    return request;
  }
  async function loadDetails(block, state) {
    if (!global.SoduWorkAPI?.approvalDetail || block.dataset.approvalAccess === 'loading') return;
    const id = block.getAttribute('data-tfd-approval-id');
    const epoch = acceptanceEpoch;
    const revision = approvalAccessRevision;
    block.dataset.approvalAccess = 'loading';
    const loadingHint = block.querySelector('.tfd-inline-hint');
    if (loadingHint) loadingHint.textContent = '正在核对审批权限与证据…';
    syncActions(block, state);
    try {
      if (typeof global.SoduWorkAPI.listApprovals === 'function') {
        const eligible = await eligibleApprovalIds();
        if (epoch !== acceptanceEpoch || !block.isConnected) return;
        if (!eligible.has(id)) {
          block.dataset.approvalAccess = 'denied';
          concealUnauthorized(block, revision);
          return;
        }
      }
      const response = await global.SoduWorkAPI.approvalDetail(id);
      if (epoch !== acceptanceEpoch || !block.isConnected) return;
      const item = response && response.item;
      if (!item || requestId(item) !== id) throw new Error('审批记录不匹配');
      if (!block.isConnected) return;
      detailsByCard.set(block, item);
      /*
       * Assignments identify review participants. Users who already decided retain read-only
       * results while other reviewers are pending.
       */
      const allowed = Boolean(item.assignment);
      block.dataset.approvalAccess = allowed ? 'allowed' : 'denied';
      if (!allowed) {
        concealUnauthorized(block, revision);
        return;
      }
      block.hidden = false;
      const hint = block.querySelector('.tfd-inline-hint');
      if (hint) hint.textContent = item.myDecision ? '你的意见已提交，等待其余确认' :
        item.assignment ? '由你确认 · ' + (item.assignment.reasons || []).map(x => x.label).filter(Boolean).join('、') : '由指定审批人处理';
      renderSubject(block, item);
      renderProof(block, item);
      renderGate(block, item);
      showError(block, '');
    } catch (error) {
      if (epoch !== acceptanceEpoch || !block.isConnected) return;
      const permissionDenied = error && (error.status === 403 || error.status === 404);
      if (permissionDenied) {
        /*
         * Remove the entry point when the server confirms the current account is not a reviewer.
         */
        block.dataset.approvalAccess = 'denied';
        concealUnauthorized(block, revision);
        return;
      }
      block.hidden = false;
      block.dataset.approvalAccess = 'error';
      /* Keep the card and offer retry for non-authorization failures. */
      const reason = humanError(error, '');
      showError(block, reason || '确认信息暂时未加载完整，请展开证据后重试。');
      const hint = block.querySelector('.tfd-inline-hint');
      if (hint) hint.textContent = '暂时无法核对权限与证据，可重试';
      const body = block.querySelector('[data-tfd-proof-body]');
      if (body) body.innerHTML = '<p>证据暂时不可用</p><button type="button" class="tfd-inline-evidence" data-tfd-proof-retry>重新加载</button>';
      // Keep the recovery control visible after a transient evidence failure.
      const proof = block.querySelector('.tfd-inline-proof');
      if (proof) proof.open = true;
    } finally { if (epoch === acceptanceEpoch) syncActions(block, state); }
  }
  function renderProof(block, item) {
    const body = block.querySelector('[data-tfd-proof-body]');
    if (!body) return;
    const gate = item.gate || item.confirmation?.gate;
    body.innerHTML = global.TaskTraceView?.gateHtml?.(gate, {compact: true}) ||
      '<p>这次确认没有附加证据，请按需求目标与验收标准核对。</p>';
  }
  /*
   * Synchronize one dynamic approval block: remove empty content, replace existing content
   * in place, or insert at the first matching anchor. renderSubject and renderGate share
   * this behavior.
   */
  function syncChild(body, className, wanted, anchors) {
    const existing = body.querySelector(':scope > .' + className);
    if (!wanted) { if (existing) existing.remove(); return; }
    if (existing) { existing.outerHTML = wanted; return; }
    for (const [selector, position] of anchors) {
      const anchor = body.querySelector(':scope > ' + selector);
      if (anchor && anchor.insertAdjacentHTML) {
        anchor.insertAdjacentHTML(position, wanted);
        return;
      }
    }
    if (body.insertAdjacentHTML) body.insertAdjacentHTML('afterbegin', wanted);
  }
  /* Keep version numbers and fingerprints for internal version checks without exposing implementation identifiers in review text. */
  function renderSubject(block, item) {
    return block && item;
  }
  /*
   * Refresh gate explanations from authoritative details because list data may omit them or
   * be stale.
   */
  function renderGate(block, item) {
    const body = block.querySelector('.tfd-inline-approval-body');
    if (!body || typeof body.querySelector !== 'function') return;
    syncChild(body, 'tfd-inline-approval-gate', gateNotice(item),
      [['.tfd-inline-rule', 'afterend']]);
  }
  // Cache server-rendered markup, not mutable DOM (notes, expanded evidence,
  // validation errors and busy states must survive ordinary chat polling).
  const renderedCards = new WeakMap();
  function patch(currentRoot, wanted) {
    const markup = wanted.outerHTML;
    if (renderedCards.get(currentRoot) === markup &&
        (!deniedRoots.has(currentRoot) || deniedRoots.get(currentRoot) === approvalAccessRevision)) return currentRoot;
    const active = document.activeElement;
    const drafts = new Map([...currentRoot.querySelectorAll('[data-tfd-approval-id]')].map(block => {
      const note = block.querySelector('[data-tfd-approval-note]');
      return [block.getAttribute('data-tfd-approval-id'), {
        note: note && note.value || '', open: Boolean(block.querySelector('details')?.open),
        focused: note === active, start: note?.selectionStart, end: note?.selectionEnd,
        submitted: block.dataset.approvalSubmitted === 'true',
        proofOpen: Boolean(block.querySelector('.tfd-inline-proof')?.open),
        consent: block.getAttribute('data-tfd-consent'),
        verified: Boolean(block.querySelector('[data-tfd-approval-verify]')?.checked),
        acceptanceMode: block.dataset.tfdAcceptanceChoice || 'manual',
      }];
    }));
    currentRoot.replaceWith(wanted);
    renderedCards.set(wanted, markup);
    wanted.querySelectorAll('[data-tfd-approval-id]').forEach(block => {
      const draft = drafts.get(block.getAttribute('data-tfd-approval-id'));
      if (!draft) return; // Never copy consent or notes to a different approval/version.
      const note = block.querySelector('[data-tfd-approval-note]'), details = block.querySelector('details');
      if (note) note.value = draft.note;
      if (details) details.open = draft.open;
      const proof = block.querySelector('.tfd-inline-proof'), verify = block.querySelector('[data-tfd-approval-verify]');
      if (proof) proof.open = draft.proofOpen;
      if (verify && draft.consent === block.getAttribute('data-tfd-consent')) verify.checked = draft.verified;
      if (draft.consent === block.getAttribute('data-tfd-consent')) {
        block.dataset.tfdAcceptanceChoice = draft.acceptanceMode;
        const mode = block.querySelector('[data-tfd-acceptance-mode][value="' + draft.acceptanceMode + '"]');
        if (mode) mode.checked = true;
        syncAcceptanceMode(block, draft.acceptanceMode);
      }
      if (draft.submitted) block.dataset.approvalSubmitted = 'true';
      if (note && draft.focused) { note.focus({preventScroll: true}); note.setSelectionRange(draft.start, draft.end); }
    });
    return wanted;
  }
  function remember(root) { renderedCards.set(root, root.outerHTML); }
  function bind(root, state) {
    if (!root) return;
    const alreadyBound = boundStates.has(root);
    boundStates.set(root, state);
    root.querySelectorAll('[data-tfd-approval-id]').forEach(block => {
      cardRoots.set(block, root);
      syncActions(block, state);
      syncAcceptanceMode(block, block.dataset.tfdAcceptanceChoice || 'manual');
      /* Creator-direct cards have no Hub approval details endpoint; treat them as available without a permission lookup. */
      if (String(block.getAttribute('data-tfd-approval-id') || '').startsWith('direct:')) {
        if (!block.dataset.approvalAccess) block.dataset.approvalAccess = 'allowed';
        block.hidden = false;
        return;
      }
      if (!block.dataset.approvalAccess && typeof global.SoduWorkAPI?.approvalDetail === 'function') {
        /*
         * Hide the card until permission lookup completes. loadDetails restores it with retry
         * controls after transient network failures.
         */
        block.hidden = true;
        void loadDetails(block, state);
      }
    });
    if (alreadyBound) return;
    root.addEventListener('click', (event) => {
      if (event.target.closest?.('[data-tfd-proof-retry]')?.hasAttribute?.('data-tfd-proof-retry')) {
        event.preventDefault(); event.stopPropagation();
        void loadDetails(event.target.closest('.tfd-inline-approval'), boundStates.get(root));
        return;
      }
      const link = event.target.closest?.('.tfd-inline-proof a[href]');
      if (link?.tagName === 'A' && global.TaskTraceView?.openEvidence) {
        event.preventDefault(); event.stopPropagation(); global.TaskTraceView.openEvidence(link); return;
      }
      const sessionButton = event.target.closest?.('[data-tfd-acceptance-session]');
      if (sessionButton && ['1', 'auto'].includes(sessionButton.getAttribute?.('data-tfd-acceptance-session')) && root.contains(sessionButton)) {
        event.preventDefault(); event.stopPropagation();
        void startAcceptance(sessionButton, boundStates.get(root));
        return;
      }
      const button = event.target.closest('[data-tfd-approval-action]');
      if (!button || !root.contains(button)) return;
      event.preventDefault(); event.stopPropagation();
      submit(button, button.getAttribute('data-tfd-approval-action') || '', boundStates.get(root));
    });
    root.addEventListener('change', (event) => {
      const input = event.target;
      if (input.matches('[data-tfd-acceptance-mode]')) {
        const block = input.closest('.tfd-inline-approval');
        if (block && !input.disabled) {
          const mode = input.value === 'auto' ? 'auto' : 'manual';
          acceptanceModes.set(acceptanceKey(block.getAttribute('data-tfd-approval-id'), block.getAttribute('data-tfd-consent')), mode);
          syncAcceptanceMode(block, mode);
        }
      } else if (input.matches('[data-tfd-approval-verify]')) {
        const block = input.closest('.tfd-inline-approval');
        if (block) syncActions(block, boundStates.get(root));
      } else if (input.matches('[data-tfd-approval-file]')) upload(input, boundStates.get(root));
      else if (input.matches('[data-tfd-rework-file]')) renderReworkFiles(input);
    });
  }

  global.TaskTraceApproval = { html, current, currentId, needsVerification, focus, bind, patch, remember, canAcceptTask, openAcceptance };
})(window);
