/*
 * AI dispatch, human transfer, and execution results. Option discovery/UI live in
 * panels-forward-options.js; this module owns side effects and tracking.
 */
function _fwdSubmissionMode() {
  const value = String(document.getElementById('fwdSubmissionMode')?.value || '').trim();
  return value === 'auto' || value === 'manual' ? value : '';
}

async function _dispatchNativeTo(tid) {
  const scope = window.RequirementAssignment.scope(), host = document.getElementById('fwdList');
  const current = () => window.RequirementAssignment.inScope(scope) && document.getElementById('fwdList') === host;
  _fwdSetBusy(true, '正在建立会话…');
  try {
    const result = await window.RequirementSessionChoice.executeNative(tid, document.getElementById('fwdNote')?.value.trim() || '', {
      submissionMode: _fwdSubmissionMode(),
    });
    if (current()) await window.RequirementAssignment.completed(tid, scope, result.conversationId);
  } catch (error) {
    if (current()) { _fwdSetBusy(false); _fwdSetStatus(error.message || '会话未能开始，请重试', true); }
  }
}

async function _dispatchAITo(tid, who, name) {
  const scope = window.RequirementAssignment.scope();
  const brief = (document.getElementById('fwdNote') || {}).value || '';
  const selectedAgent = _fwdSubstrateOf(who.id);
  const canPickModel = typeof _fwdCanPickModel === 'function'
    ? _fwdCanPickModel(selectedAgent) : Boolean(selectedAgent && selectedAgent.modelPick !== false);
  const model = !canPickModel ? '' :
    String(((document.getElementById('fwdModel') || {}).value) || _fwdModel || '');
  _fwdSetBusy(true, '正在建立会话…');
  _fwdSetStatus('正在等待执行端接单…');
  try {
    const repo = _pickedRepo();
    const executionContext = window.TaskExecutionClient
      ? TaskExecutionClient.context({...(_fwdOptions || {}), substrates:_fwdDirectAgents()}, {
        strategy: 'direct', agentId: who.id, substrateKey: who.id,
        repoId: repo && repo.id, model: model,
      }) : null;
    const result = await SoduWorkAPI.dispatchToAI(tid, who, brief.trim(), repo, model, executionContext, _fwdSubmissionMode());
    if (!window.RequirementAssignment.inScope(scope)) return;
    if (!result || result.ok === false) {
      const error = new Error((result && (result.reason || result.error || result.message)) ||
        '\u6267\u884c\u673a\u6ca1\u6709\u786e\u8ba4\u63a5\u5355');
      error.detail = error.message;
      throw error;
    }
    const pendingAck = !!(result && result.pending);
    const existingDispatch = !!(result && result.already);
    _closeFwd();
    if (typeof petSay === 'function') petSay(pendingAck ? '派发已送达，正在确认接单。请勿重复派发。' :
      existingDispatch ? name + ' 已经在处理这条需求。' : '已交给 ' + name + '。');
    // The send queue already opened and bound this session. Do not resolve a
    // possibly stale collaboration link again after the task has been accepted.
    try {
      const opened = await window.RequirementAssignment.completed(tid, scope, result.conversationId || '');
      if (opened === false && typeof petSay === 'function') petSay('需求已派发，可从需求详情查看执行进展。');
    } catch (_) {
      if (typeof petSay === 'function') petSay('需求已派发，执行会话暂未打开，请从需求详情查看。');
    }
  } catch (error) {
    if (!window.RequirementAssignment.inScope(scope)) return;
    _fwdSetBusy(false);
    _fwdSetStatus(typeof _humanErr === 'function' ? _humanErr(error, '没有派出去') : '没有派出去', true);
  }
}

async function _handoffTo(tid, userId, name) {
  const scope = window.RequirementAssignment.scope();
  const note = ((document.getElementById('fwdNote') || {}).value || '').trim();
  const task = tasks.find(item => item.id === tid) || {};
  _fwdSetBusy(true, '正在转交…');
  _fwdSetStatus('正在迁移需求归属与协作上下文…');
  try {
    const result = await SoduWorkAPI.handoffTask(tid, userId, note);
    if (!window.RequirementAssignment.inScope(scope)) return;
    if (!result || result.ok === false) {
      const error = new Error((result && (result.reason || result.error || result.message)) ||
        '需求没有成功转交给同事');
      error.detail = error.message;
      throw error;
    }
    _closeFwd();
    const index = tasks.findIndex(item => item.id === tid);
    if (index >= 0) { Store.dropTask(tid); render(); }
    await closeDetail();
    if (typeof petSay === 'function') petSay('“' + (task.title || '') + '”已转给 ' + name + '。');
  } catch (error) {
    if (!window.RequirementAssignment.inScope(scope)) return;
    _fwdSetBusy(false);
    _fwdSetStatus(typeof _humanErr === 'function' ? _humanErr(error, '没有转出去') : '没有转出去', true);
  }
}


function closeDetail() {
  const result = window.RequirementsDetail?.close?.();
  if (result === false) return result;
  if (result && typeof result.then === 'function') {
    return result.then(closed => { if (closed !== false) detailId = null; return closed; });
  }
  detailId = null;
  return result;
}
