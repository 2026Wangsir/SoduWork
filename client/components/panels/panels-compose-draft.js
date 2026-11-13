/* Requirement creation confirms goals, materials, and ownership; the executor chooses execution methods when starting work. */
(function (global) {
  'use strict';

  let _d = null;              // Current draft; synchronize editable DOM values with _sync() before changing it.
  let _opts = {};             // Starter bridge carrying model, attachments, and post-creation action.
  let _openSel = '';          // Currently expanded picker.
  let _detailOpen = true;     // Use quick confirmation in conversations and full details on standalone creation pages.
  let _requestSeq = 0;        // Invalidate pending parsing/candidate requests on collapse so late responses cannot reopen the card.
  let _wiredBox = null;
  let _docWired = false;
  let _whoQuery = '';
  let _mateLoadReason = '';
  let _mateLoadFailed = false;
  let _mateLoadedAt = 0;
  let _mateRequestSeq = 0;
  let _mateLoading = false;

  // Creation loads owners independently of executor connectivity.
  let _mates = [];
  let _submission = null;
  let _card = null;
  let _projectPicker = null;

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const tx = value => global.SoduWorkI18n?.translateText?.(value) || value;
  const txf = (value, params = {}) => Object.entries(params).reduce((text, [key, replacement]) =>
    text.replaceAll('{' + key + '}', String(replacement)), tx(value));
  const locale = () => global.SoduWorkI18n?.getLocale?.() || global.document?.documentElement?.lang || 'zh-CN';

  const requirementKind = value => ['requirement', 'bug', 'ticket', 'improvement', 'other'].includes(value) ? value : 'requirement';
  const _normalizeTags = value => {
    const values = Array.isArray(value) ? value : String(value || '').split(/[,，]/);
    return [...new Set(values.map(item => String(item || '').trim()).filter(Boolean))].slice(0, 20);
  };
  const _PRIO = global.TaskPriority.labels;
  const _PRIO_SUB = global.TaskPriority.descriptions;
  const _box = () => (_opts && typeof _opts.box === 'function'
    ? _opts.box() : document.getElementById('cpDraft'));
  function _mergeChecks(parsed, options = _opts) {
    const workIntent = options.workIntent || {};
    const explicit = global.WorkIntent && typeof WorkIntent.acceptanceItems === 'function'
      ? WorkIntent.acceptanceItems(workIntent.acceptance) : [];
    const rows = explicit.concat(Array.isArray(parsed) ? parsed : []);
    const seen = new Set();
    const merged = rows.map((item) => String(item || '').trim()).filter((item) => {
      if (!item || seen.has(item)) return false;
      seen.add(item); return true;
    });
    return merged;
  }

  /* Entry points. */
  /* opts: {model(), atts(), clearAtts(), onCreated(id,title), workIntent} */
  function open(text, opts) {
    _projectPicker?.dispose(); _projectPicker = null;
    _submission = null;
    _d = null;
    _opts = opts || {};
    _card = ComposeDraftSubmit.card(_opts);
    _card.parsing = true;
    ComposeDraftSubmit.publish(_card, { phase: 'loading', draft: { title: '', note: text, check: [], who: { kind: 'me' } } });
    _detailOpen = _opts.variant !== 'chat';
    _whoQuery = '';
    _mateLoadReason = '';
    _mateLoadFailed = false;
    _mateLoadedAt = 0;
    _mateRequestSeq++;
    _mateLoading = false;
    _requestSeq++;
    _bind();
    const box = _box();
    if (!box) return;
    box.classList.add('show');
    /*
     * Show an explicit thinking state immediately. The user prompt is mounted by
     * PluginUIHost before this call, so the transcript always reads as:
     * prompt -> thinking -> populated card.
     */
    _showLoading(box, '正在整理需求说明，最多等待两分钟');
    // Keep the surface mounted while parsing, but expose the same promise to
    // the action router so a completed card/error has one lifecycle boundary.
    return _load(text);
  }

  function clear(options = {}) {
    // Sending a turn clears editable drafts, but a saved inline requirement is
    // conversation content. Navigation still calls clear() without this option.
    if (options.preserveCreatedRequirement && _opts?.persistent && _opts?.requirement &&
        _card?.phase === 'succeeded' && _card.receipt?.id &&
        _card.ownerScope === String(global.SoduWorkAPI?.taskStorageKey?.('ops') || '')) return;
    const saved = capture();
    _projectPicker?.dispose(); _projectPicker = null;
    _requestSeq++;
    _mateRequestSeq++;
    _d = null; _openSel = ''; _submission = null;
    _whoQuery = '';
    _mateLoadReason = '';
    _mateLoadFailed = false;
    _mateLoadedAt = 0;
    _mateLoading = false;
    if (_card) _card.observer = null;
    _card = null;
    let closed = false;
    if (_opts && typeof _opts.onClose === 'function') {
      try { closed = _opts.onClose(saved) === true; } catch (_) { closed = false; }
    }
    // Clear only after onClose, which may destroy the surface. If a stale bridge is rejected,
    // #wesTaskDraft may already belong to a newer form and must remain intact,
    // otherwise the live sheet would become an empty card.
    const box = _box();
    if (box && !closed && !global.WorkEntrySheet?.ownsBox?.(box)) {
      box.classList.remove('show'); box.innerHTML = '';
    }
  }

  function _showLoading(box, text) { box.innerHTML = _loadingHtml(text); }
  function _loadingHtml(text) {
    if (_opts.variant !== 'chat') {
      return '<div class="cp-loading cp-loading-thinking" role="status" aria-live="polite">' +
        '<i aria-hidden="true"></i><span><b>' + esc(tx('正在思考')) + '</b><small>' + esc(tx(text)) + '…</small></span></div>';
    }
    return '<div class="cp-loading cp-loading-chat cp-loading-thinking" role="status" aria-live="polite"><i aria-hidden="true"></i><span><b>' + esc(tx('正在思考')) + '</b><small>' + esc(tx(text)) + '…</small></span>' +
      '<button class="cp-card-close" id="cpCancel" title="' + esc(tx('继续对话')) + '" aria-label="' + esc(tx('继续对话')) + '">' +
        '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>';
  }

  /*
   * Render already-structured task_propose fields directly instead of asking a model to
   * parse the conversation again. Keep the same editable card and explicit creation action.
   */
  async function openWith(p, opts) {
    if (!p) return;
    _projectPicker?.dispose(); _projectPicker = null;
    _submission = null;
    _d = null;
    _opts = opts || {};
    _card = ComposeDraftSubmit.card(_opts);
    const record = _card, options = _opts;
    record.parsing = true;
    ComposeDraftSubmit.publish(record, { phase: 'loading', draft: { ...p, note: p.note || p.description || '', check: p.checklist || p.acceptanceCriteria || [],
      who: p.assigneeUserId ? { kind: 'pending', requested: p.assigneeName || String(p.assigneeUserId), hint: '请确认指定负责人后再创建。' } : { kind: 'me' } } });
    _detailOpen = _opts.variant !== 'chat';
    _whoQuery = '';
    _mateLoadReason = '';
    _mateLoadFailed = false;
    _mateLoadedAt = 0;
    _mateRequestSeq++;
    _mateLoading = false;
    _requestSeq++;
    _bind();
    const box = _box();
    if (!box || !p) return;
    box.classList.add('show');
    _showLoading(box, '正在准备需求信息');
    const A = global.SoduWorkAPI || {};
    const got = await Promise.all([
      A.listTeammates ? A.listTeammates().catch((error) => ({ ok: false, mates: [],
        reason: error?.message || '同事名单暂时无法加载' })) : Promise.resolve(null),
    ]);
    const directory = got[0], mates = RequirementRouting.normalizeMates(Array.isArray(directory) ? directory : directory?.mates);
    let who = { kind: 'me' };
    if (p.assigneeUserId) {
      const mate = mates.find((item) => _sameId(item.id, p.assigneeUserId));
      who = mate?.hasBox ? { kind: 'mate', id: mate.id, name: mate.name } : {
        kind: 'pending', requested: mate?.name || p.assigneeName || String(p.assigneeUserId),
        hint: '指定同事当前无法接收需求，请确认负责人。' };
    }
    const draft = {
      title: String(p.title || '').slice(0, 200),
      note: String(p.note || p.description || ''),
      kind: requirementKind(p.kind), visibility: p.visibility || options.visibility || 'related',
      priority: p.priority || 'normal',
      due: p.due || '',
      tags: _normalizeTags(p.tags),
      check: _mergeChecks(p.checklist || p.acceptanceCriteria, options),
      reason: '',
      who: who,
      flow: '', flowExplicit: false, whoSource: p.assigneeUserId || p.assigneeKind ? 'proposal' : 'default',
      repo: options.repoId || p.repoId || "",
      projectId: String(options.projectId || ''),
    };
    _applyParsedRouting(p, RequirementRouting.instruction(options, ''), true, draft, mates, directory?.ok === false);
    _acceptDraft(record, draft, directory);
  }

  function capture() {
    if (!_card) return null;
    _sync();
    return ComposeDraftSubmit.snapshot(_card, { draft: _card.phase === 'loading' ? _card.draft : _d || _card.draft,
      files: _submission?.context?.files || (_submission?.stored ? _card.files : _opts.atts?.()) || _card.files || [] });
  }
  function _publishDraft() {
    capture();
    return ComposeDraftSubmit.publish(_card, { phase: ['loading', 'submitting', 'succeeded'].includes(_card?.phase) ? _card.phase : 'draft' });
  }
  function _acceptDraft(record, draft, directory) {
    if (record.ownerScope !== String(global.SoduWorkAPI?.taskStorageKey?.('ops') || '')) return false;
    if (draft.parseWarning && draft.parseRetry && !draft.parseRetry.baseline) {
      draft.parseRetry.baseline = JSON.parse(JSON.stringify(Object.fromEntries(
        ['title', 'note', 'priority', 'due', 'check', 'kind'].map(key => [key, draft[key]]))));
    }
    record.parsing = false; record.directory = directory;
    const observed = Boolean(record.observer);
    if (_card === record) _setMateDirectory(directory);
    if (!ComposeDraftSubmit.publish(record, { phase: 'draft', draft })) return false;
    if (_card === record && !observed) { _d = draft; _render(); }
    return _card === record;
  }
  // Render the card into the current box for both restoration and recovery repainting.
  function paintCard(record) {
    if (_card !== record) return;
    if (!_submission?.running && !_submission?.preflighting && record.phase !== 'loading') record.observer = null;
    if (record.phase === 'loading') { _showLoading(_box(), '正在整理需求说明'); _opts.setAttachmentsLocked?.(true); return; }
    if (record.phase === 'succeeded' && record.receipt) {
      const r = record.receipt; _done(r.id, r.title, r.who, r.warn, r.gone, true); return;
    }
    _d = record.draft ? JSON.parse(JSON.stringify(record.draft)) : { title: '', note: '', check: [], who: { kind: 'me' } };
    _render();
    const locked = Boolean(record.phase === 'submitting' || _submission?.stored || _submission?.running || _submission?.preflighting);
    _box()?.querySelectorAll('input,textarea,select,button').forEach(node => { node.disabled = locked; });
    _opts.setAttachmentsLocked?.(locked);
    const button = _box()?.querySelector('#cpCreate');
    if (button) {
      button.disabled = Boolean(record.phase === 'submitting' || _submission?.running || _submission?.preflighting);
      if (record.phase === 'submitting') { button.textContent = tx(record.submitLabel || '正在提交需求…'); button.setAttribute?.('aria-busy', 'true'); }
      if (record.phase === 'error') button.textContent = tx(_submission?.stored ? '重试上传并继续' : '重试创建需求');
    }
    const cancel = _box()?.querySelector('#cpCancel'); if (cancel) cancel.disabled = false;
    _projectPicker?.paint();
  }

  async function restore(saved, opts) {
    clear(); _opts = opts || {}; _card = ComposeDraftSubmit.card(_opts, saved);
    const record = _card, seq = ++_requestSeq;
    _submission = record.submission || null; _d = record.draft ? JSON.parse(JSON.stringify(record.draft)) : null;
    _detailOpen = true; _bind();
    const paint = () => paintCard(record);
    record.observer = paint; paint();
    if (record.phase === 'succeeded') return;
    const A = global.SoduWorkAPI || {};
    const mates = await A.listTeammates?.().catch(error => ({ ok: false, reason: error.message, mates: [] }));
    if (seq !== _requestSeq || record !== _card || record.phase === 'succeeded') return;
    _setMateDirectory(mates); capture(); paint();
  }

  // Preserve standalone long instructions; when reference text is separate, do not replace execution instructions with the entire conversation.
  function _keepFullNote(text, options = _opts, draft = _d) {
    return Array.from(String(text || '')).length > 1500 || Boolean(options.conversationContext?.text &&
      !Object.prototype.hasOwnProperty.call(draft || {}, 'sourceNote'));
  }

  function _refinePrompt(current, change) {
    const snapshot = {
      title: String(current.title || '').slice(0, 80),
      note: String(current.note || ''),
      sourceNote: current.sourceNote,
      kind: current.kind,
      priority: current.priority || 'normal',
      due: current.due || '',
      checklist: (current.check || []).slice(),
      assignee: current.who && current.who.kind || 'me',
      assigneeId: current.who && current.who.id || '',
      assigneeName: current.who?.name || current.who?.requested || '',
    };
    return [
      '请根据用户的补充更新当前需求。没有提到的字段必须保持，不要删除已有细节。',
      '当前需求：' + JSON.stringify(snapshot),
      '用户补充：' + String(change || ''),
    ].join('\n');
  }

  async function refine(text, options) {
    const change = String(text || '');
    if (!_d || !change.trim()) return false;
    if (_card?.parsing) return false;
    if (_d.parseWarning && /^(重试|重新解析|再试一次)[。！!]?$/u.test(change)) return retryParse();
    if (_submission?.stored || _submission?.running || _submission?.preflighting) {
      global.petSay?.('需求正在提交，请先完成当前提交，再在详情中补充。');
      return false;
    }
    _sync();
    const before = {
      ..._d,
      check: Array.isArray(_d.check) ? _d.check.slice() : [],
      who: _d.who ? { ..._d.who } : { kind: 'me' },
    };
    const seq = ++_requestSeq;
    const box = _box();
    if (!box) return false;
    box.classList.add('show');
    _showLoading(box, '正在按补充内容更新需求');
    const A = global.SoduWorkAPI || {};
    if (options && Array.isArray(options.attachmentContext) && options.attachmentContext.length) {
      _opts.attachmentContext = options.attachmentContext.slice();
    }
    if (options?.conversationContext?.text) {
      _opts.conversationContext = { ...options.conversationContext };
    }
    const model = (_opts.model && _opts.model()) || '';
    const instruction = RequirementRouting.instruction(options, change);
    const record = _card, ownerOptions = _opts, mates = _mates, failed = _mateLoadFailed;
    const parseRetry = { text: _refinePrompt(before, change), model,
      attachments: ownerOptions.attachmentContext || [], options: { instruction } };
    record.parsing = true;
    ComposeDraftSubmit.publish(record, { phase: 'loading', draft: { ...before, pendingChange: change, parseRetry } });
    const f = A.parseTaskText
      ? await A.parseTaskText(_refinePrompt(before, change), model, ownerOptions.attachmentContext || [], { instruction }).catch(() => ({})) : {};
    const draft = { ...before };
    const retry = options?.retryParse === true;
    const referenced = Boolean(options?.conversationContext?.text);
    const supplement = referenced ? instruction : change;
    if (referenced && !retry) draft.sourceNote = [before.sourceNote, (before.sourceNote ? '补充参考原文：\n' : '') + change].filter(Boolean).join('\n\n');
    draft.parseWarning = f._parseError || '';
    draft.parseRetry = draft.parseWarning ? parseRetry : null;
    if (retry && (f._parseError || !String(f.note || '').trim())) {
      draft.parseWarning ||= '未能整理需求说明，原文已保留，请重试或手动填写';
      _acceptDraft(record, draft, { mates, ok: !failed });
      return seq === _requestSeq;
    }
    if (String(f.title || '').trim()) draft.title = String(f.title).trim().slice(0, 200);
    if (_keepFullNote(before.note, ownerOptions, draft) || _keepFullNote(supplement, ownerOptions, draft)) {
      // Use only current editable instructions and the new request; reference text must not restore content the user deleted.
      draft.note = retry ? before.note : [before.note, '补充要求（与上文冲突时以本次补充为准）：\n' + supplement].filter(Boolean).join('\n\n');
    } else if (String(f.note || '').trim()) draft.note = String(f.note).trim();
    else {
      draft.note = [before.note, '补充：' + supplement].filter(Boolean).join('\n\n');
    }
    if (_PRIO[f.priority]) draft.priority = f.priority;
    if (f.due) draft.due = f.due;
    if (Array.isArray(f.checklist) && f.checklist.length) draft.check = _mergeChecks(f.checklist, ownerOptions);
    if (['requirement', 'bug', 'ticket', 'improvement', 'other'].includes(f.kind) && !before.kindManual) draft.kind = f.kind;
    _applyParsedRouting(f, instruction, false, draft, mates, failed);
    _acceptDraft(record, draft, { mates, ok: !failed });
    return seq === _requestSeq;
  }

  /* Load supporting data. */
  async function _load(text) {
    const A = global.SoduWorkAPI || {}, options = _opts, record = _card;
    const model = (options.model && options.model()) || '';
    const parseRetry = { text, model, attachments: options.attachmentContext || [],
      options: { instruction: RequirementRouting.instruction(options, text) } };
    ComposeDraftSubmit.publish(record, { draft: { ...record.draft, parseRetry } });
    const got = await Promise.all([
      A.parseTaskText ? A.parseTaskText(text, model, options.attachmentContext || [], {
        instruction: RequirementRouting.instruction(options, text),
      }).catch(() => ({})) : Promise.resolve({}),
      A.listTeammates ? A.listTeammates().catch((error) => ({ ok: false, mates: [],
        reason: error?.message || '同事名单暂时无法加载' })) : Promise.resolve(null),
    ]);
    const f = got[0] || {};
    const referenced = Boolean(options.conversationContext?.text);
    const direct = RequirementRouting.instruction(options, text);
    const note = referenced ? (Array.from(direct).length > 1500 ? direct : String(f.note || direct))
      : Array.from(String(text)).length > 1500 ? String(text) : String(f.note || text);
    const draft = {
      title: String(f.title || text).slice(0, 200),
      note: note,
      ...(referenced ? { sourceNote: String(text) } : {}),
      parseWarning: f._parseError || (referenced && !f.note ? '未能整理需求说明，请核对本次要求和参考原文后再创建。' : ''),
      parseRetry: f._parseError || (referenced && !f.note) ? parseRetry : null,
      kind: requirementKind(f.kind), visibility: options.visibility || 'related',
      priority: f.priority || 'normal',
      due: f.due || '',
      tags: _normalizeTags(f.tags),
      check: _mergeChecks(f.checklist, options),
      reason: '',
      who: null,
      flow: '', flowExplicit: false,
      repo: options.repoId || "",
      projectId: String(options.projectId || ''),
    };
    const directory = got[1], mates = RequirementRouting.normalizeMates(Array.isArray(directory) ? directory : directory?.mates);
    _applyParsedRouting(f, direct, true, draft, mates, directory?.ok === false);
    _acceptDraft(record, draft, directory);
  }

  async function retryParse() {
    if (!_d?.parseRetry || _card?.parsing || _submission?.stored ||
        _submission?.running || _submission?.preflighting) return false;
    _sync();
    const record = _card, options = _opts, before = { ..._d }, request = before.parseRetry;
    const mates = _mates, failed = _mateLoadFailed;
    record.parsing = true;
    ComposeDraftSubmit.publish(record, { phase: 'loading', draft: before });
    _showLoading(_box(), '正在重新整理需求，最多等待两分钟');
    const f = await global.SoduWorkAPI.parseTaskText(request.text, request.model,
      request.attachments, request.options).catch(() => ({ _parseError: '解析失败，原文已保留，请重试' }));
    const draft = { ...before, parseWarning: f._parseError || '', parseRetry: f._parseError ? request : null };
    const unchanged = key => !request.baseline || JSON.stringify(before[key]) === JSON.stringify(request.baseline[key]);
    if (!f._parseError) {
      if (f.title && unchanged('title')) draft.title = String(f.title).slice(0, 200);
      if (f.note && unchanged('note') && !_keepFullNote(before.note, options, before)) draft.note = String(f.note);
      if (f.priority && unchanged('priority') && _PRIO[f.priority]) draft.priority = f.priority;
      if (f.due && unchanged('due')) draft.due = f.due;
      if (Array.isArray(f.checklist) && unchanged('check')) draft.check = _mergeChecks(f.checklist, options);
      if (!before.kindManual && unchanged('kind') && ['requirement', 'bug', 'ticket', 'improvement', 'other'].includes(f.kind)) draft.kind = f.kind;
      _applyParsedRouting(f, request.options.instruction, false, draft, mates, failed);
    }
    return _acceptDraft(record, draft, record.directory);
  }

  /* Without an explicit human assignee, retain ownership with the creator; the executor chooses the method later. */
  function _sameId(left, right) {
    return String(left == null ? '' : left).trim().toLowerCase() ===
      String(right == null ? '' : right).trim().toLowerCase();
  }

  function _applyParsedRouting(fields, instruction, initial, draft = _d, mates = _mates, failed = _mateLoadFailed) {
    RequirementRouting.parsed(draft, { ...fields, flow: '', flowExplicit: false }, {
      instruction, mates, failed, agent: null, flows: [],
      managed: () => false, userSelection: null,
    }, initial);
    if (!['me', 'mate', 'pending'].includes(draft.who?.kind) || draft.who?.requested === 'AI') draft.who = { kind: 'me' };
    draft.flow = ''; draft.flowProblem = ''; draft.routeHint = ''; draft.reason = '';
  }

  const _mateOf = (id) => _mates.find((m) => _sameId(m.id, id)) || null;

  /* Current assignee display. */
  function _whoLabel() {
    const w = _d.who || { kind: 'me' };
    if (w.kind === 'pending') return { name: tx('待确认') + '：' + (w.requested || tx('负责人')), sub: w.hint || tx('请选择负责人') };
    if (w.kind === 'mate') {
      const m = _mateOf(w.id);
      return m ? { name: m.name, sub: m.org || tx('同事') } : { name: tx('选一位同事'), sub: '' };
    }
    return { name: tx('自己'), sub: tx('先放进我的需求里') };
  }

  /* Render the draft card. */
  function _render() {
    const box = _box();
    if (!box || !_d) { clear(); return; }
    if (_opts.variant === 'chat' && !_detailOpen) {
      box.innerHTML = _quickHtml();
      box.classList.add('show');
      return;
    }
    const d = _d;
    if (!Object.prototype.hasOwnProperty.call(d, 'projectId')) d.projectId = String(_opts.projectId || '');
    if (!_projectPicker && global.RequirementFields?.projectPicker) {
      const record = _card;
      _projectPicker = global.RequirementFields.projectPicker({value: d.projectId,
        current: () => _card === record && Boolean(_d),
        editable: () => !_d?.repo && !_submission?.stored && !_submission?.running && !_submission?.preflighting && _card?.phase !== 'submitting',
        onChange: value => { if (_card === record && _d) _d.projectId = value; }});
    }
    const inChat = _opts.variant === 'chat';
    const fixedActions = _opts.variant === 'sheet' && _opts.fixedActions === true;
    box.innerHTML =
      '<div class="cp-card' + (inChat ? ' cp-card-chat' : '') + '">' +
        (fixedActions ? '<div class="cp-form-scroll">' : '') +
        (inChat ? '<div class="cp-card-head"><span><b>' + esc(tx('检查需求详情')) + '</b><i>' + esc(tx('确认后才会创建')) + '</i></span>' +
          '<button class="cp-card-close" id="cpCancel" title="' + esc(tx('继续对话')) + '" aria-label="' + esc(tx('继续对话')) + '">' +
          '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>' : '') +
        (_opts.variant === 'sheet' ? '<div class="cp-sec-h cp-content-heading">' + (global.RequirementFields?.sectionIcon?.('content') || '') + esc(tx('需求内容')) + '</div><label class="cp-field-label" for="cpTitle">' + esc(tx('需求标题')) + '</label>' : '') +
        _titleHtml(d.title) +
        (_opts.variant === 'sheet' ? '<label class="cp-field-label" for="cpNote">' + esc(tx('背景与说明')) + '</label>' : '') +
        '<textarea class="cp-note" id="cpNote" rows="3" placeholder="' + esc(tx('要说清楚的细节')) + '">' + esc(d.note) + '</textarea>' +
        _sourceHtml() +
        '<div id="cpCheck">' + _checkHtml() + '</div>' +
        '<div id="cpRows">' + _rowsHtml() + '</div>' +
        (fixedActions ? '<div class="cp-form-materials"></div></div>' : '') +
        '<div class="cp-acts">' +
          '<button class="cp-primary" id="cpCreate">' + esc(_goLabel()) + '</button>' +
          (inChat ? '<button class="cp-ghost cp-cancel" data-cp-cancel>' + esc(tx('取消')) + '</button><button class="cp-ghost" id="cpCollapse">' + esc(tx('收起详情')) + '</button>' :
            '<button class="cp-ghost" id="cpCancel">' + esc(tx(_opts.requirement ? '取消' : '再想想')) + '</button>') +
        '</div>' +
      '</div>';
    box.classList.add('show');
    _projectPicker?.bind(box);
    if (fixedActions) _opts.onFormRendered?.(box.querySelector('.cp-form-materials'));
  }

  function _sourceHtml() {
    const parseWarning = tx(String(_d.parseWarning || '').replace(/^(需求解析超时)（\d+(?:\.\d+)?\s*秒）/, '$1'));
    const warning = (parseWarning ? '<div class="cp-warn cp-parse-warning"><span role="status">' + esc(parseWarning) + '</span></div>' : '') +
      (_card?.error ? '<div class="cp-warn" role="status">' + esc(_card.error) + '</div>' : '');
    if (typeof _d.sourceNote !== 'string') return warning;
    return warning +
      '<details class="cp-source-note"><summary>' + esc(tx('查看与编辑参考原文')) + '</summary>' +
      '<p>' + esc(tx('完整保留引用内容，随需求保存；执行目标以以上说明和验收要点为准。')) + '</p>' +
      '<textarea class="cp-note" id="cpSourceNote" rows="5" aria-label="' + esc(tx('参考原文')) + '">' + esc(_d.sourceNote) + '</textarea></details>';
  }

  /*
   * The compact card explains what will be created, who owns it, and what submission does.
   * Retain detailed instructions, acceptance criteria, category, and dates in the expandable
   * draft.
   */
  function _quickHtml() {
    const d = _d;
    const w = _whoLabel();
    const meta = [tx(global.Requirements?.kinds?.[d.kind] || ({ requirement: '需求', bug: 'Bug', ticket: '工单', improvement: '优化', other: '其它' })[d.kind]), w.name].filter(Boolean);
    if ((d.check || []).length) meta.push(txf('{value} 条验收要点', { value: d.check.length }));
    const materialCount = ((_opts.atts && _opts.atts()) || []).length;
    if (materialCount) meta.push(txf('{value} 份输入材料', { value: materialCount }));
    if (d.due) meta.push(tx('期望') + ' ' + d.due);
    return '<div class="cp-card cp-card-quick">' +
      '<div class="cp-card-head cp-quick-head">' +
        '<svg viewBox="0 0 24 24"><path d="M9 11l2.5 2.5L16 8"/><rect x="4" y="4" width="16" height="16" rx="4"/></svg>' +
        '<span><b>' + esc(tx('加入需求池')) + '</b><i>' + esc(tx('可选，不创建也能继续对话')) + '</i></span>' +
        '<button class="cp-card-close" id="cpCancel" title="' + esc(tx('继续对话')) + '" aria-label="' + esc(tx('继续对话')) + '">' +
          '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>' +
      '</div>' +
      _titleHtml(d.title) +
      (d.note ? '<div class="cp-quick-note">' + esc(_cut(d.note.replace(/\s+/g, ' '), 120)) + '</div>' : '') +
      _sourceHtml() +
      '<div class="cp-quick-meta">' + meta.map((s) => '<span>' + esc(s) + '</span>').join('') + '</div>' +
      '<div class="cp-acts">' +
        '<button class="cp-primary" id="cpCreate">' + esc(_goLabel()) + '</button>' +
        '<button class="cp-ghost cp-cancel" data-cp-cancel>' + esc(tx('取消')) + '</button>' +
        '<button class="cp-ghost" id="cpExpand">' + esc(tx('检查详情')) + '</button>' +
      '</div>' +
    '</div>';
  }

  function _titleHtml(title) {
    return '<input class="cp-title" id="cpTitle" value="' + esc(title) +
      '" placeholder="' + esc(tx('需求标题')) + '" aria-describedby="cpTitleLimit">' +
      '<small class="cp-title-limit" id="cpTitleLimit">' + esc(tx('需求标题最多 200 个字符')) + '</small>';
  }

  function _goLabel() {
    if (_opts.saveOnly) return tx('保存到需求池');
    const w = _d.who || {};
    if (w.kind === 'mate') return tx('创建并转给他');
    return tx('创建需求');
  }

  /*
   * Place acceptance criteria directly below instructions; they define how delivery will be
   * judged.
   */
  function _checkHtml() {
    const items = _d.check || [];
    return '<div class="cp-sec">' +
      '<div class="cp-sec-h">' + (global.RequirementFields?.sectionIcon?.('criteria') || '') + esc(tx('完成标准')) + '<i>' + esc(tx('明确完成这项需求的标准')) + '</i></div>' +
      (items.length
        ? '<div class="cp-cks">' + items.map((s, i) =>
            '<div class="cp-ck"><span class="cp-ck-n">' + (i + 1) + '</span>' +
            '<input class="cp-ck-t" data-ck="' + i + '" value="' + esc(s) + '" placeholder="' + esc(tx('做到什么算完')) + '">' +
            '<button class="cp-ck-x" data-ckrm="' + i + '" title="' + esc(tx('去掉这条')) + '">' +
              '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>').join('') +
          '</div>'
        : '<div class="cp-sec-empty">' + esc(tx('还没有验收要点——写上一两条，交回来的时候好判"这算不算做完"')) + '</div>') +
      '<button class="cp-add" id="cpCkAdd"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>' + esc(tx('加一条')) + '</button>' +
    '</div>';
  }

  /* Project, category, and owner are editable; repository associations never migrate here. */
  function _rowsHtml() {
    const wl = _whoLabel();
    let html = '<div class="cp-sec"><div class="cp-sec-h">' + (global.RequirementFields?.sectionIcon?.('settings') || '') + esc(tx('基本信息')) + '</div>';
    if (_projectPicker) html += '<div class="cp-row cp-requirement-fields"><label class="cp-k" for="cpProjectId">' + esc(tx('关联项目')) + '</label>' +
      _projectPicker.html({id:'cpProjectId',hint:_d.repo ? tx('项目由已关联仓库确定，本次不迁移仓库') : ''}) + '</div>';
    html += _row(tx('负责人'), _sel('who', wl.name, wl.sub));
    if (_d.who?.hint) html += '<div class="cp-why">' + esc(tx(_d.who.hint)) + '</div>';
    html += _row(tx('优先级'), _sel('prio', tx(_PRIO[_d.priority] || '普通'), '') +
      '<span class="cp-k cp-k2">' + esc(tx('期望完成')) + '</span><input type="date" id="cpDue" lang="' + esc(locale()) + '" value="' + esc(_d.due || '') + '">');
    if (global.RequirementFields) html += RequirementFields.html(_d, _opts);
    return html + '</div>';
  }

  const _row = (k, inner) => '<div class="cp-row"><span class="cp-k">' + esc(k) + '</span>' + inner + '</div>';
  const _cut = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n) + '…' : s; };
  /* Pickers update only the draft without triggering execution preflight or dispatch. */
  function _sel(kind, name, sub) {
    const picker = _openSel === kind
      ? '<div class="cp-selpop' + (kind === 'who' ? ' cp-selpop-who' : '') + '">' +
        (kind === 'who' ? _whoToolbar() : '') +
        '<div class="cp-selrows" data-selrows="' + esc(kind) + '">' + _popRows(kind) + '</div></div>' : '';
    return '<div class="cp-sel' + (_openSel === kind ? ' open' : '') + '" data-selwrap="' + kind + '">' +
      '<button class="cp-selbtn" data-selbtn="' + kind + '">' +
        '<b>' + esc(name) + '</b>' + (sub ? '<i>' + esc(sub) + '</i>' : '') +
        '<svg class="cp-selchev" viewBox="0 0 24 24"><path d="M6 9.5l6 6 6-6"/></svg>' +
      '</button>' +
      picker +
    '</div>';
  }

  function _setMateDirectory(directory) {
    const data = Array.isArray(directory) ? { mates: directory } : (directory || {});
    _mates = RequirementRouting.normalizeMates(data.mates);
    _mateLoadFailed = Boolean(data && data.ok === false);
    _mateLoadReason = String(data && data.reason || '').trim();
    if (_mateLoadFailed && !_mateLoadReason) _mateLoadReason = '同事名单暂时无法加载';
    _mateLoadedAt = Date.now();
    _mateLoading = false;
  }

  function _whoMatches(row, query) {
    if (!query) return true;
    return [row.b, row.i, row.tag, row.v].some((value) =>
      String(value || '').toLocaleLowerCase().indexOf(query) >= 0);
  }

  function _whoToolbar() {
    const readyMates = (_mates || []).filter((item) => item.hasBox).length;
    const totalMates = (_mates || []).length;
    return '<div class="cp-seltoolbar">' +
      '<div class="cp-seltoolbar-head"><b>' + esc(tx('选择负责人')) + '</b><span data-sel-summary>' +
        esc(txf('{value1}/{value2} 位同事可接收', { value1: readyMates, value2: totalMates })) + '</span></div>' +
      '<label class="cp-selsearch"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.8" cy="10.8" r="6.2"></circle><path d="m16 16 4.2 4.2"></path></svg>' +
        '<input type="search" data-selsearch maxlength="80" autocomplete="off" value="' + esc(_whoQuery) +
        '" placeholder="' + esc(tx('搜索同事或部门')) + '"></label>' +
      '<button type="button" class="cp-selclear" data-selclear' + (_whoQuery ? '' : ' hidden') + '>' + esc(tx('清空搜索')) + '</button>' +
      '</div>';
  }

  function _popRows(kind) {
    const cur = kind === 'who' ? _whoValue() : _d.priority;
    const rows = kind === 'who' ? _whoRows()
               : Object.keys(_PRIO).map((key) => ({
                   v: key, b: tx(_PRIO[key]), i: tx(_PRIO_SUB[key])
                 }));
    return rows.map((row) => {
      if (row.grp) return '<div class="cp-selgrp">' + esc(row.grp) + '</div>';
      if (row.notice) return '<div class="cp-selnotice' + (row.tone ? ' is-' + esc(row.tone) : '') + '">' +
        '<b>' + esc(row.notice) + '</b>' + (row.i ? '<span>' + esc(row.i) + '</span>' : '') +
        (row.retry ? '<button type="button" data-sel-mate-retry>' + esc(tx('重试')) + '</button>' : '') +
        (row.clear ? '<button type="button" data-selclear>' + esc(tx('清空搜索')) + '</button>' : '') + '</div>';
      const selected = _sameId(row.v, cur);
      const state = row.state ? '<em class="cp-selstate' + (row.stateCls ? ' ' + esc(row.stateCls) : '') + '">' +
        esc(row.state) + '</em>' : '';
      const tag = row.tag ? '<em class="cp-seltag">' + esc(row.tag) + '</em>' : '';
      return '<button class="cp-selrow' + (selected ? ' on' : '') + (row.dis ? ' dis' : '') + '"' +
        (row.dis ? ' disabled aria-disabled="true"' : ' data-selv="' + esc(kind) + '|' + esc(row.v) + '"') +
        ' aria-pressed="' + (selected ? 'true' : 'false') + '">' +
          '<span class="cp-mtick"><svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></span>' +
          '<span class="cp-mtxt"><b>' + esc(row.b) + tag + state + '</b>' +
            (row.i ? '<i>' + esc(row.i) + '</i>' : '') + '</span>' +
        '</button>';
    }).join('');
  }

  const _whoValue = () => {
    const w = _d.who || { kind: 'me' };
    return w.kind === 'me' ? 'me' : w.kind + ':' + w.id;
  };

  /*
   * Owners are people; select AI/plugins before execution. Deduplicate and sort colleagues
   * by availability and organization. Search patches the list without replacing the focused
   * input.
   */
  function _whoRows() {
    const query = String(_whoQuery || '').trim().toLocaleLowerCase();
    const rows = [];
    const self = { v: 'me', b: tx('自己'), i: tx('需求会留在我的需求中心，稍后自己处理'),
      tag: tx('自己'), state: tx('可用'), stateCls: 'is-ready' };
    if (_whoMatches(self, query)) rows.push(self);

    const mates = (_mates || []).map((m) => ({
      v: 'mate:' + m.id, b: m.name || tx('未命名同事'), tag: m.org || tx('未分组'),
      i: m.hasBox ? (m.deviceCount > 1 ? txf('{value} 台设备可接收需求', { value: m.deviceCount }) : tx('可接收需求'))
        : tx('尚未启用 SoduWork，暂时无法转交'),
      state: _mateLoading ? tx('正在刷新') : (m.hasBox ? tx('可接收') : tx('不可用')),
      stateCls: _mateLoading ? 'is-loading' : (m.hasBox ? 'is-ready' : 'is-off'),
      dis: _mateLoading || !m.hasBox,
    })).filter((row) => _whoMatches(row, query));
    if (mates.length) {
      rows.push({ grp: txf('同事 · {value} 位', { value: mates.length }) });
      rows.push(...mates);
    }
    if (!mates.length && _mateLoading) {
      rows.push({ notice: tx('正在刷新同事清单…'), tone: 'loading', i: tx('请稍候，列表会自动更新') });
    } else if (!mates.length && _mateLoadReason && !query) {
      rows.push({
        notice: _mateLoadFailed ? tx('同事清单没有加载成功') : tx('暂无可接收的同事'),
        i: _mateLoadReason, retry: _mateLoadFailed, tone: _mateLoadFailed ? 'error' : 'loading'
      });
    } else if (!rows.some((row) => row.v)) {
      rows.push({ notice: tx('没有匹配的人'), i: tx('试试姓名或部门名称'), clear: Boolean(query) });
    }
    return rows;
  }

  function _renderSelectionRows(kind) {
    const box = _box();
    if (!box) return;
    const rows = box.querySelector('[data-selrows="' + kind + '"]');
    if (rows) rows.innerHTML = _popRows(kind);
    if (kind === 'who') {
      const clear = box.querySelector('[data-selclear]');
      if (clear) clear.hidden = !_whoQuery;
      const summary = box.querySelector('[data-sel-summary]');
      if (summary) {
        const readyMates = (_mates || []).filter((item) => item.hasBox).length;
        summary.textContent = txf('{value1}/{value2} 位同事可接收', { value1: readyMates, value2: (_mates || []).length });
      }
    }
  }

  async function _reloadMates() {
    const A = global.SoduWorkAPI || {};
    if (!_d || typeof A.listTeammates !== 'function') return;
    const seq = ++_mateRequestSeq;
    _mateLoading = true;
    _mateLoadReason = '';
    _renderSelectionRows('who');
    let result;
    try {
      result = await A.listTeammates();
    } catch (error) {
      result = { ok: false, mates: [], reason: (error && error.message) || '同事名单暂时无法加载' };
    }
    if (seq !== _mateRequestSeq || !_d) return;
    _setMateDirectory(result);
    if (_d.who?.kind === 'pending' && !_d.who.problem && _d.who.requested !== 'AI') {
      _d.who = RequirementRouting.person(_d.who.requested, _mates, _mateLoadFailed);
      _rerender();
    }
    _renderSelectionRows('who');
  }

  /* Draft interactions. */
  /* Delegate events once on #cpDraft because the card contents are rebuilt. */
  function _bind() {
    const box = _box();
    if (!box || _wiredBox === box) return;
    /*
     * Track the actual #cpDraft node, not a permanent bound flag; opening another conversation
     * replaces the node.
     */
    _wiredBox = box;
    global.RequirementFields?.bindTags(box);
    global.RequirementFields?.bindVisibility?.(box);

    box.addEventListener('click', (e) => {
      const sb = e.target.closest('[data-selbtn]');
      if (sb) {
        e.stopPropagation(); _sync();
        const next = _openSel === sb.dataset.selbtn ? '' : sb.dataset.selbtn;
        if (next !== 'who') _whoQuery = '';
        _openSel = next; _rerender();
        if (next === 'who') {
          const age = Date.now() - _mateLoadedAt;
          if (age > 15000) _reloadMates();
          const search = box.querySelector('[data-selsearch]');
          if (search) setTimeout(() => search.focus(), 0);
        }
        return;
      }
      const clearButton = e.target.closest('[data-selclear]');
      if (clearButton) {
        e.stopPropagation(); _whoQuery = ''; _renderSelectionRows('who');
        const search = box.querySelector('[data-selsearch]');
        if (search) search.focus();
        return;
      }
      const retry = e.target.closest('[data-sel-mate-retry]');
      if (retry) { e.stopPropagation(); _reloadMates(); return; }
      const sv = e.target.closest('[data-selv]');
      if (sv) { e.stopPropagation(); _sync(); _apply(sv.dataset.selv); _openSel = ''; _rerender(); _publishDraft(); return; }
      const rm = e.target.closest('[data-ckrm]');
      if (rm) { _sync(); _d.check.splice(parseInt(rm.dataset.ckrm, 10), 1); _rerenderCheck(); _publishDraft(); return; }
      if (e.target.closest('#cpCkAdd')) {
        _sync(); _d.check.push(''); _rerenderCheck(); _publishDraft();
        const last = box.querySelectorAll('.cp-ck-t');
        if (last.length) last[last.length - 1].focus();
        return;
      }
      if (e.target.closest('#cpExpand')) { _sync(); _detailOpen = true; _render(); return; }
      if (e.target.closest('#cpCollapse')) { _sync(); _detailOpen = false; _render(); return; }
      if (e.target.closest('#cpCancel,[data-cp-cancel]')) { clear(); return; }
      if (e.target.closest('#cpCreate')) { _create(); }
    });

    box.addEventListener('input', (e) => {
      if (e.target.id === 'cpTitle') e.target.setAttribute('aria-invalid', String(e.target.value.trim().length > 200));
      const search = e.target.closest('[data-selsearch]');
      if (!search) { if (_d && !_submission?.running && !_submission?.stored) _publishDraft(); return; }
      _whoQuery = String(search.value || '').slice(0, 80);
      _renderSelectionRows('who');
    });
    box.addEventListener('change', () => { if (_d && !_submission?.running && !_submission?.stored) _publishDraft(); });

    /* Close the picker when clicking elsewhere, including other parts of the card. */
    if (!_docWired) {
      _docWired = true;
      const reposition = () => { if (_openSel) _positionSelection(); };
      global.addEventListener('resize', reposition);
      document.addEventListener('scroll', reposition, true);
      document.addEventListener('click', (e) => {
        if (!_openSel) return;
        if (e.target.closest('[data-selwrap]')) return;
        _sync(); _openSel = ''; _whoQuery = ''; _rerender();
      });
    }
  }

  function _apply(v) {
    if (_submission?.stored || _submission?.running || _submission?.preflighting) return;
    const raw = String(v || '');
    const i = raw.indexOf('|');
    if (i < 1) return;
    const kind = raw.slice(0, i), val = raw.slice(i + 1);
    if (kind === 'who') {
      if (val === 'me') {
        _d.who = { kind: 'me' };
      } else {
        const split = val.indexOf(':');
        const selectedKind = split > 0 ? val.slice(0, split) : '';
        const selectedId = split > 0 ? val.slice(split + 1) : '';
        const selected = selectedKind === 'mate' ? _mateOf(selectedId) : null;
        if (!selected || _mateLoading || !selected.hasBox) {
          if (typeof petSay === 'function') petSay('这个负责人当前不可用，请重新选择');
          return;
        }
        _d.who = { kind: selectedKind, id: selected.id, name: selected.name };
      }
      // Preserve manually selected ownership; added instructions must not convert it into automatic dispatch.
      _d.flow = '';
      _d.flowExplicit = true;
      _d.flowProblem = ''; _d.whoSource = 'manual'; _d.reason = ''; _d.routeHint = '';
    }
    else if (kind === 'prio') _d.priority = val;
  }

  /* Read current field edits before rendering so picker actions cannot restore stale title or instructions. */
  function _sync() {
    if (!_d) return;
    const g = (id) => document.getElementById(id);
    if (g('cpTitle')) _d.title = g('cpTitle').value;
    if (g('cpNote')) _d.note = g('cpNote').value;
    if (g('cpSourceNote')) _d.sourceNote = g('cpSourceNote').value;
    if (g('cpDue')) _d.due = g('cpDue').value;
    if (g('cpKind') && _d.kind !== g('cpKind').value) { _d.kind = requirementKind(g('cpKind').value); _d.kindManual = true; }
    if (g('cpVisibility')) _d.visibility = g('cpVisibility').value;
    if (g('cpTags')) _d.tags = global.RequirementFields.readTags(g('cpTags'));
    if (g('cpTriage')) _d.triageStage = g('cpTriage').value;
    if (_projectPicker) _d.projectId = _projectPicker.value();
    const cks = document.querySelectorAll('.cp-ck-t');
    if (document.getElementById('cpCheck')) {
      _d.check = Array.prototype.map.call(cks, (el) => el.value);
    }
  }

  /* Patch only changing sections; preserve title/instruction DOM, focus, and selection. */
  function _positionSelection() {
    global.ComposeSelectionPosition.position(_box());
  }

  function _rerender() {
    const el = document.getElementById('cpRows');
    if (el) el.innerHTML = _rowsHtml(); else _render();
    _projectPicker?.bind(_box());
    _positionSelection();
    const btn = document.getElementById('cpCreate');
    if (btn && !btn.disabled) btn.textContent = _goLabel();
  }
  function _rerenderCheck() {
    const el = document.getElementById('cpCheck');
    if (el) el.innerHTML = _checkHtml(); else _render();
  }

  /* Submit requirement creation. */
  async function _create() {
    const btn = document.getElementById('cpCreate');
    if (!_d || !btn || btn.disabled || _submission?.running || _submission?.preflighting) return;
    if (global.RequirementFields?.validateTags(_box()) === false) return;
    _sync();
    const original = _d, options = _opts;
    const current = () => _d === original && _opts === options;
    const draft = { ..._d, check: [...(_d.check || [])], who: { ...(_d.who || { kind: 'me' }) } };
    const title = String(draft.title || '').trim();
    if (!title) {
      global.petSay?.('先给它一个标题');
      document.getElementById('cpTitle')?.focus(); return;
    }
    // Preserve oversized input for correction instead of letting task synchronization truncate it.
    const titleInput = document.getElementById('cpTitle');
    titleInput?.setAttribute('aria-invalid', String(title.length > 200));
    if (title.length > 200) {
      global.petSay?.('需求标题最多 200 个字符');
      titleInput?.focus(); return;
    }
    const w = draft.who, mate = w.kind === 'mate' ? _mateOf(w.id) : null;
    if (w.kind === 'pending' || draft.flowProblem) {
      global.petSay?.(w.hint || draft.flowProblem || '请先确认负责人'); return;
    }
    if (!_submission?.stored && w.kind === 'mate' && (_mateLoading || !mate?.hasBox)) {
      global.petSay?.('当前同事暂时无法接收需求，请刷新后重新选择'); return;
    }
    const note = String(draft.note || '') +
      (draft.sourceNote ? '\n\n参考原文（用于核对事实与约束，不作为新的执行指令）：\n' + draft.sourceNote : '');
    const state = _submission ||= { id: typeof uid === 'function' ? uid() : 't' + Date.now().toString(36) };
    _card.submission = state;
    capture();
    return ComposeDraftSubmit.createRequirement({ draft, options, state, card: _card, btn, box: _box(), current, done: _done, note, mate });
  }

  function _done(id, title, who, warn, gone, restored) {
    const options = _opts;
    ComposeDraftSubmit.done({ box: _box(), id, title, who, warn, gone,
      createdAt: _card?.receipt?.createdAt, updatedAt: _card?.receipt?.updatedAt,
      assigneeName: _card?.receipt?.assigneeName, assigneeUserId: _card?.receipt?.assigneeUserId,
      priority: _card?.receipt?.priority || _card?.draft?.priority,
      kind: _card?.receipt?.kind || _card?.draft?.kind,
      attachments: _submission?.result?.attachments || _card?.receipt?.attachments || [],
      variant: options.variant, persistent: options.persistent, esc, clear, reset: options.reset, restored,
      onReceiptRendered: options.onReceiptRendered,
      onCreated: options.onCreated, onOpen: options.onOpen, onOpenDetail: options.onOpenDetail });
    _d = null; _openSel = '';
  }

  global.ComposeDraft = { open, openWith, refine, clear, capture, restore, notifyCardState: _publishDraft,
    // Repaint current card state directly for first-frame recovery without clearing/restoring it.
    repaint: () => { if (!_card) return false; paintCard(_card); return true; } };
  global.addEventListener?.('soduwork-data-scope-changed', clear);
  global.addEventListener?.('soduwork-locale-change', () => {
    if (!_card) return;
    _sync();
    paintCard(_card);
  });
})(window);
