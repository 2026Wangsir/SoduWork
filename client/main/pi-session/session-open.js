'use strict';

// Session construction owns state; collaborators receive live accessors.
function create(shared) {
  const {
    PLUGIN_SELECTION_ENTRY_TYPE, SCOPE_ENTRY_TYPE, _appendTaskBinding, _openTiming,
    _pluginIds, _pluginSelectionFromEntries, _seed, _sessions, _taskBindingFromEntries,
    agentContract, createTurnQueue, deviceAuth, goalContract, goalFinalizer,
    goalHarness, goalLoop, goalQuality, goalToolStages, initializeExtensions,
    loadSdk, mediaArtifacts, modelConfig, nativeLocale, outputContinuation,
    runControl, sessionResources, stream, toolGuard,
  } = shared;
async function open(opts) {
  const state = {
    get _beginAudit() { return _beginAudit; },
    get _beginFinalAnswer() { return _beginFinalAnswer; },
    get _beginGoalTurn() { return _beginGoalTurn; },
    get _cancelPendingStallRecovery() { return _cancelPendingStallRecovery; },
    get _captureDirectDelivery() { return _captureDirectDelivery; },
    get _checkpoint() { return _checkpoint; },
    get _drainTurns() { return _drainTurns; },
    get _emit() { return _emit; },
    get _endGoalTurn() { return _endGoalTurn; },
    get _enqueueTurn() { return _enqueueTurn; },
    get _promptComplete() { return _promptComplete; },
    get _runContext() { return _runContext; },
    get _scheduleProtocolRecovery() { return _scheduleProtocolRecovery; },
    get _scheduleStallRecovery() { return _scheduleStallRecovery; },
    get _setHarness() { return _setHarness; },
    get _snapshot() { return _snapshot; },
    get acc() { return acc; },
    get access() { return access; },
    get accessChanges() { return accessChanges; },
    get accessPolicy() { return accessPolicy; },
    get activePluginIds() { return activePluginIds; },
    get activeTurnJournal() { return activeTurnJournal; }, set activeTurnJournal(value) { activeTurnJournal = value; },
    get beginTurnJournal() { return beginTurnJournal; },
    get budgetMs() { return budgetMs; },
    get closed() { return closed; }, set closed(value) { closed = value; },
    get desktopControlScope() { return desktopControlScope; }, set desktopControlScope(value) { desktopControlScope = value; },
    get displayTitle() { return displayTitle; }, set displayTitle(value) { displayTitle = value; },
    get effectiveCwd() { return effectiveCwd; },
    get failedLastTurn() { return failedLastTurn; }, set failedLastTurn(value) { failedLastTurn = value; },
    get finishTurnJournal() { return finishTurnJournal; },
    get goal() { return goal; },
    get goalCancelled() { return goalCancelled; }, set goalCancelled(value) { goalCancelled = value; },
    get goalEnabled() { return goalEnabled; }, set goalEnabled(value) { goalEnabled = value; },
    get goalPluginIds() { return goalPluginIds; }, set goalPluginIds(value) { goalPluginIds = value; },
    get goalPluginProjectId() { return goalPluginProjectId; }, set goalPluginProjectId(value) { goalPluginProjectId = value; },
    get goalVisible() { return goalVisible; }, set goalVisible(value) { goalVisible = value; },
    get handle() { return handle; },
    get harness() { return harness; }, set harness(value) { harness = value; },
    get harnessEventSeq() { return harnessEventSeq; }, set harnessEventSeq(value) { harnessEventSeq = value; },
    get identity() { return identity; },
    get imageController() { return imageController; }, set imageController(value) { imageController = value; },
    get immediate() { return immediate; },
    get inFlight() { return inFlight; }, set inFlight(value) { inFlight = value; },
    get limitRequest() { return limitRequest; }, set limitRequest(value) { limitRequest = value; },
    get listeners() { return listeners; },
    get liveAccess() { return liveAccess; },
    get materializedMedia() { return materializedMedia; },
    get maxSteps() { return maxSteps; },
    get maxToolSteps() { return maxToolSteps; },
    get model() { return model; },
    get modelRecovery() { return modelRecovery; },
    get modelSelection() { return modelSelection; },
    get openStarted() { return openStarted; },
    get opts() { return opts; },
    get persistedScope() { return persistedScope; }, set persistedScope(value) { persistedScope = value; },
    get persistPluginSelection() { return persistPluginSelection; },
    get piSession() { return piSession; },
    get pluginOutputSince() { return pluginOutputSince; },
    get prep() { return prep; },
    get qualityPhase() { return qualityPhase; }, set qualityPhase(value) { qualityPhase = value; },
    get qualityReason() { return qualityReason; }, set qualityReason(value) { qualityReason = value; },
    get qualityRounds() { return qualityRounds; }, set qualityRounds(value) { qualityRounds = value; },
    get ref() { return ref; },
    get refreshModelTicketIfNeeded() { return refreshModelTicketIfNeeded; },
    get resourceActivation() { return resourceActivation; },
    get resourceReads() { return resourceReads; },
    get resources() { return resources; },
    get run() { return run; },
    get runtime() { return runtime; },
    get sdk() { return sdk; },
    get shared() { return shared; },
    get skillSelectionFailure() { return skillSelectionFailure; }, set skillSelectionFailure(value) { skillSelectionFailure = value; },
    get snapshotEmitter() { return snapshotEmitter; },
    get startedAt() { return startedAt; },
    get taskBinding() { return taskBinding; }, set taskBinding(value) { taskBinding = value; },
    get taskExecutions() { return taskExecutions; },
    get taskRef() { return taskRef; }, set taskRef(value) { taskRef = value; },
    get taskTitle() { return taskTitle; }, set taskTitle(value) { taskTitle = value; },
    get turnJournalSeq() { return turnJournalSeq; }, set turnJournalSeq(value) { turnJournalSeq = value; },
    get turnQueue() { return turnQueue; },
    get turnReadScope() { return turnReadScope; }, set turnReadScope(value) { turnReadScope = value; },
    get unsub() { return unsub; },
    get updatedAt() { return updatedAt; }, set updatedAt(value) { updatedAt = value; },
  };
  const { _persistScope, _beginGoalTurn, _beginAudit, _beginFinalAnswer, _endGoalTurn, _checkpoint, _setHarness, _captureDirectDelivery, _runContext, _execution, _thinkingView, _snapshot, _stopForLimit, _stopProtocolIssue, beginTurnJournal, finishTurnJournal, onPiEvent } = require('./session-events').create(state);

  const openStarted = performance.now();
  _openTiming('open-start', openStarted);
  const { app, identity, cwd } = opts || {};
  try { await require('../local-model-privacy.cjs').prepare(app); }
  catch (_) { return { ok: false, reason: '本地模型隐私保护初始化失败，请检查本机安全存储后重试' }; }
  const loaded = await loadSdk(app);
  _openTiming('sdk-loaded', openStarted);
  if (!loaded.ok) return { ok: false, reason: loaded.reason };
  const sdk = loaded.sdk;
  const effectiveCwd = cwd || process.cwd();
  let resumedManager = null;
  let goal = goalContract.normalize(opts);
  let restoredMode = { visible: true };
  let restoredQuality = null;
  let restoredLoop = null;
  let storedTaskBinding = { taskId: '', taskTitle: '', tasks: [], taskIds: [], taskBindings: [], activeTaskId: '' };
  if (opts.resumePath) {
    try {
      resumedManager = sdk.SessionManager.open(opts.resumePath);
      if (goal.intent !== 'goal') goal = goalContract.fromEntries(resumedManager.getEntries());
      const entries = resumedManager.getEntries();
      storedTaskBinding = _taskBindingFromEntries(entries);
      const requestedTaskId = String(opts.taskRef || '').trim();
      if (opts.requireTaskBinding && requestedTaskId &&
          !storedTaskBinding.taskIds.includes(requestedTaskId)) {
        return { ok: false, code: 'TASK_BINDING_MISMATCH', reason: "这条会话不是该需求的协作会话" };
      }
      restoredMode = goalContract.modeFromEntries(entries);
      restoredQuality = goalQuality.fromEntries(entries);
      restoredLoop = goalLoop.fromEntries(entries, goal);
    } catch (e) {
      return { ok: false, reason: '接回历史会话失败：' + String((e && e.message) || e) };
    }
  }
  const archiveEntries = resumedManager && (typeof resumedManager.getBranch === 'function'
    ? resumedManager.getBranch() : resumedManager.getEntries());
  const savedModel = archiveEntries && [...archiveEntries].reverse().find(entry =>
    entry.type === 'custom' && entry.customType === 'soduwork.model.selection');
  const explicitModel = typeof opts.modelName === 'string';
  let archivedLocalModel = '';
  if (!explicitModel && !savedModel?.data?.name && archiveEntries) {
    // Older sessions could persist an empty default choice. Only this archive's
    // active branch may identify that choice; models.json belongs to all chats.
    const recorded = [...archiveEntries].reverse().find(entry => entry.type === 'model_change' && entry.modelId ||
      entry.type === 'message' && entry.message?.role === 'assistant' && entry.message.model &&
        entry.message.model !== 'task-executor');
    const name = String(recorded?.type === 'model_change' ? recorded.modelId : recorded?.message?.model || '');
    if (name.startsWith('local:')) archivedLocalModel = name;
    else if (recorded?.localOnly === true || recorded?.message?.usageLocalOnly === true) {
      return { ok: false, code: 'LOCAL_HISTORY_MODEL_UNAVAILABLE',
        reason: '历史会话的原本地模型无法确定，请主动选择可用模型后继续' };
    }
  }
  let modelName = explicitModel ? opts.modelName : savedModel?.data?.name || archivedLocalModel;
  const localChoice = name => String(name || '').startsWith('local:') ||
    require('./image-model').imageChoice(name)?.name.startsWith('local:');
  if (require('./image-model').imageChoice(modelName) && ((goal.intent === 'goal' && restoredMode.visible) || opts.taskRef)) {
    return { ok: false, reason: '直接生图请使用普通对话；目标和需求可通过图片插件生成图片' };
  }
  let resetSavedModel = false;
  const allowHistoricalModel = Boolean(opts.resumePath || opts.resumedConversation);
  let prep = await modelConfig.prepare(app, identity, modelName, { allowHistorical: allowHistoricalModel });
  _openTiming('model-prepared', openStarted);
  // A conversation can outlive a personal model.  Its historical selection
  // must not make the whole conversation unopenable after that model is
  // removed from the personal model catalog; retry once with the current default and clear
  // the stale selection for future resumes.
  const canRecoverStaleModel = Boolean(opts.resumePath || opts.resumedConversation) &&
    prep?.code !== 'LOCAL_AGENT_DEFAULT_UNAVAILABLE';
  // Some older Hub releases returned a successful default configuration even
  // when the requested historical model had already been retired. Treat a
  // different returned model as stale in a resumed conversation so the same
  // recovery path is used instead of letting the SDK fail later with a vague
  // "model unavailable" error.
  const returnedModel = String(prep?.model?.id || '').trim();
  const returnedDifferentModel = Boolean(prep.ok && !prep.model?.localOnly && modelName && returnedModel && returnedModel !== modelName);
  // A historical archive may predate the durable model-selection entry. In
  // that case `modelName` is empty, but the Hub can still reject its own stale
  // Agent preference. Only a resumed conversation may bypass that preference;
  // new chats keep the strict explicit/default selection behavior.
  if (canRecoverStaleModel && !localChoice(modelName) && (!prep.ok || returnedDifferentModel)) {
    const fallback = await modelConfig.prepare(app, identity, '', {
      ignoreAgentPreference: true, allowHistorical: allowHistoricalModel,
    });
    if (fallback.ok) {
      modelName = '';
      prep = fallback;
      resetSavedModel = true;
    }
  }
  if (!prep.ok) return prep;
  if (prep.model.localOnly) modelName = prep.model.modality === 'image'
    ? prep.model.imageChoice || modelName : require('./local-model-runtime-privacy.cjs').reference(prep.model);
  const MODEL_TICKET_REFRESH_SKEW_MS = 2 * 60 * 1000;
  const MODEL_TICKET_FALLBACK_MS = 10 * 60 * 1000;
  const contextPrompts = Array.isArray(opts.contextPrompts)
    ? opts.contextPrompts.map((item) => String(item || '').trim()).filter(Boolean) : [];
  const goalAtOpen = goal.intent === 'goal' && restoredMode.visible &&
    !(restoredQuality && ['reviewed', 'blocked'].includes(restoredQuality.phase)) &&
    !(restoredLoop && ['completed', 'blocked'].includes(restoredLoop.state));
  const openingProfile = goalQuality.deliveryProfile(goalAtOpen ? goal : {});
  const openingPrompts = goalAtOpen && openingProfile.kind === 'conversation'
    ? [goalQuality.conversationPrompt(goal)]
    : (goalAtOpen ? [goalHarness.prompt(goal)] : []);
  const savedAccess = resumedManager && [...resumedManager.getEntries()].reverse().find(entry =>
    entry.type === 'custom' && entry.customType === 'soduwork.access.policy');
  const pendingEntry = resumedManager && [...resumedManager.getEntries()].reverse().find(entry =>
    entry.type === 'custom' && entry.customType === 'soduwork.access.pending');
  const accessRules = require('../access-control/policy');
  const restoredAccess = resumedManager ? accessRules.restoreState(savedAccess?.data, pendingEntry?.data, effectiveCwd) : null;
  let accessPolicy = savedAccess
    ? restoredAccess.accessPolicy
    : accessRules.normalize(opts.accessPolicy, effectiveCwd);
  if (accessPolicy) opts.readOnly = accessPolicy.mode === 'readonly';
  let access = null;
  let resources;
  const resourceReads = require('../access-control/resource-read-scope');
  let turnReadScope;
  const readScope = () => resourceReads.combine(resources?.skillReadScope, turnReadScope);
  try {
    resources = await sessionResources(sdk, effectiveCwd, prep.agentDir, opts.skillDirs,
      agentContract.prompts(
        { readOnly: opts.readOnly, goal: goalAtOpen, locale: nativeLocale.getLocale() },
        [...openingPrompts, ...contextPrompts]),
      {
        noExtensions: Boolean(opts.noExtensions || (accessPolicy && accessPolicy.mode !== 'full')),
        timeoutMs: opts.resourceLoadTimeoutMs,
        contextWindow: prep.model.contextWindow,
        optionalSkillDirs: opts.optionalSkillDirs,
      });
    _openTiming('resources-loaded', openStarted);
  } catch (e) {
    return { ok: false, reason: '会话能力加载失败：' + String((e && e.message) || e) };
  }
  let runtime;
  let model;
  let created;
  const configureLocalTransport = (target, next) => {
    if (!target) return target;
    if (next?.localOnly) return require('./local-model-runtime-privacy.cjs').configure(runtime, target, next);
    if (target.headers && Object.hasOwn(target.headers, 'Authorization')) delete target.headers.Authorization;
    return target;
  };
  try {
    const prepared = await Promise.all([
      require('./background-process').run(() => sdk.ModelRuntime.create()),
      toolGuard.prepareGuardedBash(sdk, opts.resumePath && opts.resumeCwd || effectiveCwd, resources.settingsManager),
    ]);
    _openTiming('runtime-prepared', openStarted);
    runtime = prepared[0];
    if (prep.model.localOnly) runtime.registerProvider(prep.provider,
      require('../conversation/model-selection').piProvider(prep.model));
    model = configureLocalTransport(runtime.getModel(prep.provider, prep.model.id), prep.model);
    if (!model) {
      return { ok: false, reason: '模型配置没被认出来（' + prep.provider + '/' + prep.model.id + '）' };
    }
    const args = {
      model, modelRuntime: runtime, cwd: effectiveCwd, agentDir: prep.agentDir,
      settingsManager: resources.settingsManager,
      resourceLoader: resources.resourceLoader,
    };
    /*
     * Enforce read-only access through the SDK tool allowlist, excluding writes and command
     * execution.
     */
    if (opts.readOnly) args.tools = ['read', 'list', 'glob', 'grep'];
    const initialThinkingLevel = opts.thinkingLevel || (goal.intent === 'goal' || opts.resumePath ? '' : 'off');
    if (initialThinkingLevel) args.thinkingLevel = initialThinkingLevel;
    /*
     * Resume the original archive and cwd so previously referenced files retain their meaning.
     */
    if (opts.resumePath) {
      args.sessionManager = resumedManager;
      if (opts.resumeCwd) args.cwd = opts.resumeCwd;
    } else if (sdk.SessionManager && typeof sdk.SessionManager.inMemory === 'function' && opts.ephemeral) {
      args.sessionManager = sdk.SessionManager.inMemory();
    }
    /*
     * Wrap the SDK Bash tool with a default timeout while retaining its native cancellation
     * and process-tree termination behavior.
     */
    args.customTools = [prepared[1],
      require('./vision-read-tool').create(sdk, args.cwd, identity, () => prep.model)];
    created = await require('./background-process').run(() => sdk.createAgentSession(args));
    _openTiming('agent-created', openStarted);
  } catch (e) {
    return { ok: false, reason: '起会话失败：' + String((e && e.message) || e) };
  }
  let piSession = created.session;
  require('../conversation/native-agent-source.cjs').install(piSession.sessionManager, 'pi');
  const accessChanged = () => {
    queueMicrotask(() => {
      runControl.permissionWait(run, Boolean(access?.broker.pending().length));
      if (!closed) _emit({ kind: 'permission' });
    });
  };
  access = require('../access-control/pi').install(piSession, accessPolicy, effectiveCwd, accessChanged, { readScope });
  if (access && (!savedAccess || savedAccess.data?.mode !== access.policy.mode)) {
    piSession.sessionManager.appendCustomEntry('soduwork.access.policy', access.policy);
  }
  if (resetSavedModel || ((explicitModel || prep.model.localOnly) && savedModel?.data?.name !== modelName)) {
    piSession.sessionManager.appendCustomEntry('soduwork.model.selection', { name: modelName });
  } else if (require('./image-model').imageChoice(modelName) && !savedModel) {
    piSession.sessionManager.appendCustomEntry('soduwork.model.selection', { name: modelName });
  }
  let taskBinding = _taskBindingFromEntries(piSession.sessionManager.getEntries());
  let taskRef = String(opts.taskRef || taskBinding.activeTaskId || taskBinding.taskId || '').trim().slice(0, 120);
  let taskTitle = String(opts.taskTitle || taskBinding.taskTitle || '').trim().slice(0, 200);
  if (taskRef) {
    const bound = _appendTaskBinding(piSession.sessionManager, taskRef, taskTitle);
    if (!bound.ok) {
      try { piSession.dispose(); } catch (e) { /* ignore */ }
      return bound;
    }
    taskBinding = bound;
    taskTitle = bound.taskTitle || taskTitle;
  } else {
    taskBinding = _taskBindingFromEntries(piSession.sessionManager.getEntries());
    taskRef = taskBinding.activeTaskId || taskBinding.taskId || '';
    taskTitle = taskTitle || taskBinding.taskTitle || '';
  }
  const storedGoal = goalContract.fromEntries(piSession.sessionManager.getEntries());
  if (goal.intent === 'goal' && !goalContract.same(goal, storedGoal)) {
    piSession.sessionManager.appendCustomEntry(goalContract.ENTRY_TYPE, goal);
  }
  const sessionEntries = piSession.sessionManager.getEntries();
  // A conversation plugin is a session capability selection: it stays active
  // for follow-up turns, while plugin-grant still issues and cleans a fresh
  // short-lived authorization ticket for every turn.
  let activePluginIds = _pluginSelectionFromEntries(sessionEntries);
  const persistPluginSelection = (ids) => {
    const next = _pluginIds(ids);
    if (JSON.stringify(next) === JSON.stringify(activePluginIds)) return;
    activePluginIds = next;
    try {
      piSession.sessionManager.appendCustomEntry(PLUGIN_SELECTION_ENTRY_TYPE, {
        schemaVersion: 1, pluginIds: next.slice(), at: Date.now(),
      });
    } catch (_) { /* The in-memory selection remains usable for this session. */ }
  };
  if (!opts.resumePath && Array.isArray(opts.activePluginIds)) persistPluginSelection(opts.activePluginIds);
  const storedFinal = opts.resumePath ? goalFinalizer.fromEntries(sessionEntries) : null;
  const internalGoalHistory = goal.intent === 'goal' && (
    Boolean(storedFinal) ||
    Boolean(restoredLoop && restoredLoop.workKind && restoredLoop.workKind !== 'conversation') ||
    goalQuality.deliveryProfile(goal).kind !== 'conversation'
  );
  const acc = stream.create();
  const seeded = opts.resumePath
    ? _seed(acc, piSession, { goal, internalGoal: internalGoalHistory, maxMessages: 240, nativeAgentId: 'pi' }) : 0;
  const lastStoredScope = [...sessionEntries].reverse().find((item) => item &&
    item.type === 'custom' && item.customType === SCOPE_ENTRY_TYPE);
  let persistedScope = String(lastStoredScope && lastStoredScope.data &&
    lastStoredScope.data.scope || stream.SCOPES.NORMAL);
  const listeners = new Set();
  /*
   * Accept a caller-provided ref so the workspace created before session startup matches the
   * conversation ID.
   */
  const ref = opts.ref || ('chat-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8));
  let updatedAt = Number(opts.resumeAt || 0) || Date.now();
  /* Preserve the original first user message during restoration so follow-ups do not replace the title. */
  const originalTitle = require('./history-state').originalMessageTitle(sessionEntries, piSession.state?.messages);
  const requestedTitle = require('../conversation/automatic-title').resolve(
    require('./session-helpers').repairPersistedTitle(opts.sessionTitle, originalTitle));
  let displayTitle = String(requestedTitle || '').replace(/\s+/g, ' ').trim().slice(0, 240) ||
    originalTitle ||
    (taskRef ? taskTitle : '');
  let inFlight = false;
  let closed = false;
  let desktopControlScope = '';
  const restoredPending = restoredAccess?.nextAccessPolicy;
  if (restoredPending && (restoredPending.revision !== pendingEntry?.data?.revision || restoredPending.mode !== pendingEntry?.data?.mode)) {
    piSession.sessionManager.appendCustomEntry('soduwork.access.pending', restoredPending);
  }
  const accessChanges = require('../access-control/pi-transition').create({
    cwd: effectiveCwd,
    pending: restoredPending && restoredPending.revision > (accessPolicy?.revision || 0) ? restoredPending : null,
    current: () => ({ session: piSession, access, policy: accessPolicy }),
    changed: accessChanged,
    readScope,
    commitPolicy(policy) {
      accessPolicy = policy; opts.accessPolicy = policy; opts.readOnly = policy.mode === 'readonly';
    },
    preload(policy) {
      return sessionResources(sdk, effectiveCwd, prep.agentDir, opts.skillDirs,
        agentContract.prompts({ readOnly: policy.mode === 'readonly', goal: goalVisible },
          [...openingPrompts, ...contextPrompts]),
        // An upgrade must not synchronously discover/execute NEW extensions in
        // Electron's main process. Retain the existing resource boundary; full
        // or historic sessions which already used extensions still retain them.
        { noExtensions: Boolean(opts.noExtensions || policy.mode !== 'full' ||
            accessPolicy && accessPolicy.mode !== 'full'), timeoutMs: opts.resourceLoadTimeoutMs,
          optionalSkillDirs: opts.optionalSkillDirs, contextWindow: piSession.model?.contextWindow });
    },
    release(preloaded) {
      preloaded?.resourceLoader?.getExtensions?.()?.runtime?.invalidate?.('Access change was cancelled before session replacement.');
    },
    async prepare(policy, previous, nextResources) {
      const bash = await toolGuard.prepareGuardedBash(sdk, effectiveCwd, nextResources.settingsManager);
      const next = await require('./background-process').run(() => sdk.createAgentSession({
        model: previous.model, thinkingLevel: previous.thinkingLevel,
        modelRuntime: runtime, cwd: effectiveCwd, agentDir: prep.agentDir,
        settingsManager: nextResources.settingsManager, resourceLoader: nextResources.resourceLoader,
        sessionManager: previous.sessionManager,
        ...(policy.mode === 'readonly' ? { tools: ['read', 'list', 'glob', 'grep'] } : {}),
        customTools: [bash,
          require('./vision-read-tool').create(sdk, effectiveCwd, identity, () => prep.model)],
      }));
      try {
        await initializeExtensions(next.session, nextResources);
        return { session: next.session, resources: nextResources };
      } catch (error) { next.session.dispose(); throw error; }
    },
    commit(next) {
      unsub();
      piSession = next.session; access = next.access; accessPolicy = next.policy;
      resources = next.resources; opts.readOnly = accessPolicy.mode === 'readonly';
      opts.accessPolicy = accessPolicy;
      unsub = piSession.subscribe(onPiEvent);
      _rawPromptComplete = outputContinuation.bind(piSession, acc, () => Boolean(run.stopReason) || liveAccess.changing() || turnQueue.active()?.stopRequested || closed, _emit);
    },
  });
  const liveAccess = require('../access-control/pi-live-change').create({
    current: () => ({ session: piSession, access, policy: accessPolicy }),
    transition: accessChanges, changed: accessChanged,
    stopped: () => closed || Boolean(run.stopReason) || goalCancelled,
  });
  let imageController = null;
  // One MCP result can be replayed by the SDK during a reconnect.  Keep the
  // attachment id in memory so a retry cannot create duplicate output files.
  const materializedMedia = new Set();
  const turnQueue = createTurnQueue(undefined, () => handle.captureDelivery?.());
  const modelRecovery = require('./model-recovery').create({
    beforeRetry: async ({ authExpired } = {}) => {
      if (!authExpired) return;
      const refreshed = await refreshModelTicketIfNeeded(true);
      if (!refreshed.ok) throw new Error(refreshed.reason || '模型会话凭据刷新失败');
    },
  });
  let failedLastTurn = false;
  let skillSelectionFailure = null;
  const storedQuality = restoredQuality || (goal.intent === 'goal'
    ? goalQuality.fromEntries(piSession.sessionManager.getEntries()) : null);
  let qualityPhase = storedQuality ? storedQuality.phase : (goal.intent === 'goal' ? 'recorded' : '');
  let qualityReason = storedQuality ? storedQuality.reason : '';
  let qualityRounds = storedQuality ? storedQuality.rounds : 0;
  let goalVisible = goal.intent === 'goal' && restoredMode.visible;
  let goalEnabled = goalVisible && !['reviewed', 'blocked'].includes(qualityPhase);
  let limitRequest = null;
  let goalCancelled = false;
  let goalPluginIds = [];
  let goalPluginProjectId = '';
  let harness = goal.intent === 'goal'
    ? (restoredLoop || goalLoop.fromEntries(piSession.sessionManager.getEntries(), goal))
    : goalLoop.compile({});
  goalToolStages.restore(harness, acc.state.tools);
  const interruptedGoal = Boolean(opts.resumePath && goalVisible &&
    !['completed', 'blocked', 'paused'].includes(harness.state) &&
    !['reviewed', 'blocked'].includes(qualityPhase));
  if (harness.state === 'paused') {
    limitRequest = harness.pause || {
      kind: 'interrupted', reason: harness.reason || '\u4e0a\u6b21\u6267\u884c\u5df2\u6682\u505c',
      used: 0, limit: 0, unit: '',
    };
    qualityPhase = 'paused';
    qualityReason = limitRequest.reason;
    goalEnabled = false;
  } else if (harness.state === 'completed') {
    qualityPhase = 'reviewed'; qualityReason = harness.reason; goalEnabled = false;
  } else if (harness.state === 'blocked') {
    qualityPhase = 'blocked'; qualityReason = harness.reason; goalEnabled = false;
  } else if (interruptedGoal) {
    limitRequest = {
      kind: 'interrupted',
      reason: '\u4e0a\u6b21\u6267\u884c\u5728\u5b8c\u6210\u524d\u4e2d\u65ad\uff0c\u5df2\u4fdd\u7559\u5de5\u4f5c\u76ee\u5f55\u548c\u8fdb\u5ea6\uff0c\u53ef\u4ece\u68c0\u67e5\u70b9\u7ee7\u7eed',
      used: 0, limit: 0, unit: '',
    };
    qualityPhase = 'paused'; qualityReason = limitRequest.reason; goalEnabled = false;
  }
  let harnessEventSeq = 0;
  if (interruptedGoal) _checkpoint('run.paused', limitRequest);
  if (goal.intent === 'goal' && !piSession.sessionManager.getEntries().some((item) =>
    item && item.type === 'custom' && item.customType === goalLoop.ENTRY_TYPE)) {
    piSession.sessionManager.appendCustomEntry(goalLoop.ENTRY_TYPE, harness);
  }
  /*
   * Publish snapshots for local state changes such as Stop and UI answers even when Pi emits
   * no corresponding event.
   */
  const snapshotEmitter = require('./snapshot-emitter').create(() => _snapshot({ messageLimit: 80, toolLimit: 160 }), listeners);
  function _emit(touched) { snapshotEmitter.emit(touched); }
  const run = runControl.createState();
  const budgetMs = goal.intent === 'goal' ? goal.budgetMinutes * 60 * 1000 : 0;
  const maxSteps = goal.intent === 'goal' ? goal.maxSteps : 0;
  // Only an explicit goal budget limits total work. Normal long turns are
  // protected by the bounded no-progress guard in session-events instead.
  const maxToolSteps = maxSteps;
  const taskExecutions = new Map();
  let modelTicketExpiresAt = prep.historical ? 0 : Number(prep.model && prep.model.proxyExpiresAt) > Date.now()
    ? Number(prep.model.proxyExpiresAt) : Date.now() + MODEL_TICKET_FALLBACK_MS;
  let modelTicketRefresh = null;
  function rememberModelTicket(next) {
    const expiry = Number(next && next.proxyExpiresAt);
    modelTicketExpiresAt = expiry > Date.now() ? expiry : Date.now() + MODEL_TICKET_FALLBACK_MS;
    if (next && next.key) process.env[modelConfig.ENV_KEY] = String(next.key);
    else delete process.env[modelConfig.ENV_KEY];
    if (next && next.mcpKey) {
      process.env[modelConfig.ENV_MCP_KEY] = String(next.mcpKey);
      try {
        const file = modelConfig.writeMcpServers(prep.agentDir, identity, next.mcpKey);
        if (file) process.env.SODUWORK_MCP_SERVERS = file;
        else delete process.env.SODUWORK_MCP_SERVERS;
      } catch (_) { delete process.env.SODUWORK_MCP_SERVERS; }
    } else {
      delete process.env[modelConfig.ENV_MCP_KEY];
      delete process.env.SODUWORK_MCP_SERVERS;
    }
    if (next?.localOnly) {
      delete process.env.SODUWORK_HUB_ORIGIN;
    } else {
      try { process.env.SODUWORK_HUB_ORIGIN = new URL(identity?.hub || '').origin; } catch (_) {}
    }
  }
  const modelSelection = require('../conversation/model-selection').create({
    name: modelName, model: prep.model,
    generation: modelConfig.generation,
    resolve: async name => {
      // Keep strict Hub deployments usable after the 30-minute device session
      // expires.  The fallback request still handles older compatibility
      // deployments, but renewing here avoids sending a stale session at all.
      if (!localChoice(name)) {
        try {
          const fresh = await deviceAuth.ensureSession(app, identity);
          if (fresh) identity.session = fresh;
        } catch (_) { /* fetchSelection will perform the bounded secret fallback */ }
      }
      return modelConfig.fetchSelection(identity, name, 8000, global.fetch, false, 'pi', { app });
    },
    persist: name => piSession.sessionManager.appendCustomEntry('soduwork.model.selection', { name }),
    changed: () => _emit({ kind: 'model-selection' }),
    async apply(next) {
      if (next.modality === 'image') {
        acc.push({ type: 'context_reset' }); prep.model = next; handle.model = next; return;
      }
      runtime.registerProvider('soduwork', require('../conversation/model-selection').piProvider(next));
      const target = configureLocalTransport(runtime.getModel('soduwork', next.id), next);
      if (!target) throw new Error('Model unavailable');
      await piSession.setModel(target);
      model = target;
      require('./context-recovery').configure(resources.settingsManager, target.contextWindow);
      acc.push({ type: 'context_reset' });
      prep.model = next; handle.model = next;
      rememberModelTicket(next);
    },
  });
  async function refreshModelTicketIfNeeded(force = false) {
    if (prep.model.modality === 'image') return { ok: true };
    // Device-local models have no expiring Hub proxy ticket. A forced retry
    // may reload local credentials, but must retain the local reference.
    if (prep.model.historicalLocal) {
      return { ok: false, reason: '原本地模型已删除或不可用，请先选择一个当前可用模型后再发送' };
    }
    if (prep.model.localOnly && !force) return { ok: true };
    if (!force && modelTicketExpiresAt > Date.now() + MODEL_TICKET_REFRESH_SKEW_MS) return { ok: true };
    if (modelTicketRefresh) return modelTicketRefresh;
    modelTicketRefresh = (async () => {
      // A queued task may use a different model from the composer's future
      // selection. Renew the model already applied to this turn, never swap it.
      const name = prep.model.localOnly ? prep.model.modelRef || modelSelection.view().activeName || ''
        : prep.model.id || modelSelection.view().activeName || '';
      if (prep.model.localOnly && !String(name).startsWith('local:')) {
        return { ok: false, reason: 'Local model reference is unavailable; select the local model again.' };
      }
      if (!String(name).startsWith('local:')) {
        try {
          const fresh = await deviceAuth.ensureSession(app, identity);
          if (fresh) identity.session = fresh;
        } catch (_) { /* the request helper can still use the compatibility bridge */ }
      }
      const next = await modelConfig.fetchSelection(identity, name, 8000, global.fetch, true, 'pi', { app });
      if (!next || !next.ok || !next.model) {
        return { ok: false, reason: (next && next.reason) || '模型对话凭据刷新失败，请重试',
          ...require('../../core/token-quota').fields(next) };
      }
      if (next.model.modality === 'image') return { ok: true };
      runtime.registerProvider('soduwork', require('../conversation/model-selection').piProvider(next.model));
      const target = configureLocalTransport(runtime.getModel('soduwork', next.model.id), next.model);
      if (!target) return { ok: false, reason: '模型对话凭据刷新后模型不可用，请重试' };
      await piSession.setModel(target);
      require('./context-recovery').configure(resources.settingsManager, target.contextWindow);
      model = target;
      prep.model = next.model;
      if (handle) handle.model = next.model;
      rememberModelTicket(next.model);
      return { ok: true };
    })().catch(error => ({
      ok: false,
      reason: '模型对话凭据刷新失败，请重试：' + String((error && error.message) || error),
    })).finally(() => { modelTicketRefresh = null; });
    return modelTicketRefresh;
  }


  // Contain subscription exceptions because they propagate through the runtime event loop.
  let unsub = piSession.subscribe(onPiEvent);

  let _rawPromptComplete = outputContinuation.bind(
    piSession, acc, () => Boolean(run.stopReason) || liveAccess.changing() || turnQueue.active()?.stopRequested || closed, _emit);
  const resourceActivation = require('./resource-activation').create({
    current: () => ({ session: piSession, resources, access, policy: accessPolicy,
      changing: liveAccess.changing() || Boolean(accessChanges.pending()) }),
    closed: () => closed,
    changed: () => _emit({ kind: 'session-resources' }),
    load: () => sessionResources(sdk, effectiveCwd, prep.agentDir, opts.skillDirs,
      agentContract.prompts({ readOnly: opts.readOnly, goal: goalVisible }, [...openingPrompts, ...contextPrompts]),
      { noExtensions: false, timeoutMs: opts.resourceLoadTimeoutMs, optionalSkillDirs: opts.optionalSkillDirs,
        contextWindow: piSession.model?.contextWindow }),
    async prepare(nextResources, previous) {
      const bash = await toolGuard.prepareGuardedBash(sdk, effectiveCwd, nextResources.settingsManager);
      const next = await require('./background-process').run(() => sdk.createAgentSession({
        model: previous.session.model, thinkingLevel: previous.session.thinkingLevel,
        modelRuntime: runtime, cwd: effectiveCwd, agentDir: prep.agentDir,
        settingsManager: nextResources.settingsManager, resourceLoader: nextResources.resourceLoader,
        sessionManager: previous.session.sessionManager,
        customTools: [bash,
          require('./vision-read-tool').create(sdk, effectiveCwd, identity, () => prep.model)],
      }));
      try {
        const nextAccess = require('../access-control/pi').install(next.session, previous.policy, effectiveCwd, accessChanged, { readScope });
        try {
          await initializeExtensions(next.session, nextResources);
          return { session: next.session, access: nextAccess };
        } catch (error) { nextAccess?.broker.close(); throw error; }
      } catch (error) { next.session.dispose(); throw error; }
    },
    commit(next) {
      unsub(); piSession = next.session; access = next.access; resources = next.resources;
      opts.noExtensions = false;
      unsub = piSession.subscribe(onPiEvent);
      _rawPromptComplete = outputContinuation.bind(piSession, acc, () => Boolean(run.stopReason) || liveAccess.changing() || turnQueue.active()?.stopRequested || closed, _emit);
    },
  });
  const _promptComplete = (prompt, options) => {
    piSession.soduworkRetryPolicy = input => run.retryBudget.plan(input);
    _openTiming('prompt-start', openStarted);
    return runControl.promptComplete(run,
      (value, config) => require('./background-process').run(() =>
        liveAccess.run(() => _rawPromptComplete(value, config)),
        { desktopScope: desktopControlScope }), prompt, options)
      .finally(() => _openTiming('prompt-end', openStarted));
  };

  const startedAt = Date.now();
  /*
   * Use original conversation time for resumed output and draft discovery even when no
   * native archive path is available.
   */
  const resumedConversation = Boolean(opts.resumedConversation || opts.resumePath);
  const pluginOutputSince = resumedConversation
    ? require('./plugin-draft-candidates').sessionSince(piSession.sessionManager) : startedAt;
  runControl.startMonitor(run, _runContext());

  function _enqueueTurn(text, turnAttachments, sendOptions, options) {
    const item = turnQueue.add({
      text: String(text || ''),
      attachments: Array.isArray(turnAttachments) ? turnAttachments : [],
      options: { ...(sendOptions || {}) },
    });
    updatedAt = Date.now();
    // An idle submit is drained immediately. Do not publish a transient
    // queued snapshot for that path; the queue UI should only appear when
    // the receipt confirms that the turn really waited behind active work.
    // Duplicate requirement submissions return null; do not emit events for a missing queue item.
    // The caller reports the rejection to the sender.
    if (item && options?.announceQueued !== false) _emit({ kind: 'turn-queued', queueId: item.id });
    return item;
  }

  function _drainTurns() {
    if (closed || immediate.blocked() || inFlight || run.stallPending || turnQueue.blocked() || limitRequest || acc.status() === 'waiting-user') return;
    const next = turnQueue.take();
    if (!next) return;
    modelRecovery.clear();
    const completion = turnQueue.run(next, async () => {
      if (next.options.controlled) return next.options.controlled.execute(handle, next.text, next.attachments);
      await modelSelection.applyForTurn(next.options.modelName);
      if (next.stopRequested) return { ok: true, cancelled: true, manualStop: true };
      const result = await handle.send(next.text, next.attachments, { ...next.options, fromQueue: true });
      return runControl.finishRecovery(run, result);
    });
    _emit({ kind: 'turn-dequeued', queueId: next.id });
    Promise.resolve(completion).then(
      (result) => { modelRecovery.remember(next, result); turnQueue.complete(next, result); },
      (error) => turnQueue.complete(next, {
        ok: false, reason: '排队消息执行失败：' + String((error && error.message) || error),
      }),
    ).finally(() => { _emit({ kind: 'queue-changed' }); if (!inFlight) queueMicrotask(_drainTurns); });
  }

  function _cancelPendingStallRecovery() {
    return runControl.cancelPending(run);
  }

  function _scheduleStallRecovery(context) {
    return runControl.scheduleStall(run, context, _runContext());
  }

  function _scheduleProtocolRecovery(context) {
    return runControl.scheduleProtocol(run, context, _runContext());
  }

  const immediate = require('./queue-immediate').create({
    queue: turnQueue, drain: _drainTurns, changed: () => _emit({ kind: 'queue-changed' }),
    settled: () => !turnQueue.active() && !inFlight && piSession.isIdle === true,
    unavailable: () => {
      const active = turnQueue.active();
      if (closed) return '会话已关闭';
      if (active && (active.options.taskId || active.options.controlled) || goalEnabled || active?.options.goalMode)
        return '当前工作正在执行，请等待结束后再引导';
      if (liveAccess.changing()) return '正在切换权限，请稍后重试';
      if (imageController) return '正在生成图片，请等待生成结束后再引导';
      if (run.stallPending || limitRequest || modelRecovery.view() || acc.state.pendingUi || inFlight && !active)
        return '当前回复正在恢复或等待处理，请处理后再引导';
      if (typeof piSession.abort !== 'function') return '当前底座暂不支持引导';
      return '';
    },
    async interrupt(active) {
      if (!active) return;
      _cancelPendingStallRecovery(); modelRecovery.clear();
      run.stopReason = '正在停止当前回复';
      run.stopKind = 'steering';
      access?.broker.cancel(); acc.abort();
      await require('./interrupt').interrupt(piSession, active.completion);
    },
  });

  let turnJournalSeq = 0;
  let activeTurnJournal = null;

  let handle = require('./session-handle').create(state);

  // Archives from the deferred-policy version may still carry a choice.
  // Apply it before exposing the restored conversation as ready.
  if (accessChanges.pending()) {
    try { await accessChanges.apply(); }
    catch (error) { handle.close(); return { ok: false, reason: '权限变更未生效：' + String(error?.message || error) }; }
  }
  try { await initializeExtensions(piSession, resources); }
  catch (error) {
    handle.close();
    return { ok: false, reason: '会话能力加载失败：' + String(error?.message || error) };
  }
  _sessions.set(ref, handle);
  // Recover a paid media result when the desktop disconnected after the Hub
  // accepted the generation request.  A persistent attachment index prevents
  // repeated downloads every time the conversation is reopened.
  queueMicrotask(() => {
    mediaArtifacts.recover(identity, handle.sessionId, effectiveCwd).then(({ files, errors }) => {
      if (closed) return;
      for (const file of files || []) {
        if (file.artifactId) materializedMedia.add(String(file.artifactId));
        _emit({ kind: 'settled', mediaArtifact: file, recovered: true });
      }
      if (errors && errors.length) {
        _emit({ kind: 'media-artifact-error', reason: errors[0] });
      }
    }).catch(() => { /* older Hubs may not expose media recovery */ });
  });
  return { ok: true, session: handle, seeded };
}
  return { open };
}
module.exports = { create };
