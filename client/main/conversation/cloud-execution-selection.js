'use strict';

// A picker stages a selection; the next message carries that immutable choice
// to Hub. Hub validates and commits it together with the continuation receipt.
function create({ app, read, save, guard, identity, request, view, notify, busy }) {
  const catalog = require('../agent-runtime/runtime-catalog');
  const models = require('../pi-session/model-config');
  function active(record) {
    return record.pendingExecutionSelection || record.activeExecutionSelection || {
      agentId: record.target?.agentId || record.adapterId,
      modelName: record.target?.model || record.options?.model || '',
    };
  }
  async function executionRuntimes(handle) {
    const record = guard(handle), current = await identity(record);
    const data = await request(current, '/conversation-handoffs/targets');
    const allowed = (data.targets || []).filter(r => r.runnerId === record.target?.runnerId);
    const runtimes = allowed.map(r => catalog.runtime(r.agentId)).filter(Boolean);
    // Cloud targets have already passed the remote target/runner authorization
    // check above, so expose them through the same projection used by local
    // health checks. This keeps the renderer strict without hiding cloud agents.
    return { ok: true, runtimes, availableRuntimes: runtimes, missing: [] };
  }
  function selectExecution(handle, input) { return busy(handle, async () => {
    try {
      const record = guard(handle);
      if (record?.phase !== 'committed') throw Error('请先完成云端交接');
      if (record.pendingMessage) throw Error('上一条消息尚未确认，请先核对回执');
      const snapshot = view(handle, handle.snapshot());
      if (['streaming', 'queued'].includes(snapshot.status) || snapshot.execution?.running)
        throw Error('请等待本轮和排队消息完成后切换');
      const current = await identity(record), previous = active(record);
      const next = { ...previous, ...input };
      if (!catalog.runtime(next.agentId)) throw Error('未知 Agent');
      if (next.agentId !== previous.agentId) {
        const list = await executionRuntimes(handle);
        if (!list.runtimes.some(r => r.id === next.agentId)) throw Error('此云端电脑尚未安装或授权目标 Agent');
        if (catalog.runtime(next.agentId).modelMode !== catalog.runtime(previous.agentId)?.modelMode) next.modelName = '';
        next.reasoningEffort = '';
      }
      if (typeof next.modelName !== 'string') throw Error('无效的模型选择');
      next.modelName = next.modelName.trim();
      if (next.modelName.startsWith('local:') || require('../../core/model-choice').imageChoice(next.modelName)?.name.trim().startsWith('local:')) {
        throw Error('云端暂不支持本地模型，请选择云端可用模型');
      }
      if (catalog.runtime(next.agentId).modelMode === 'managed') {
        const result = await models.fetchModel(current, next.modelName, undefined, undefined, false, next.agentId);
        if (!result?.ok) throw Error(result?.reason || '当前账号无法使用所选模型');
      }
      // Recheck after network work; another window may have submitted meanwhile.
      const latest = read(handle.sessionId);
      if (latest.pendingMessage || ['running', 'queued'].includes(latest.remoteState)) throw Error('会话已开始执行，请等待本轮完成');
      await identity(latest);
      await save({ ...latest, pendingExecutionSelection: next });
      notify(handle, { kind: 'runtime-selection' });
      const selected = view(handle, handle.snapshot());
      return { ok: true, adapterId: next.agentId, displayName: selected.displayName,
        selection: selected.modelSelection, snapshot: selected, effective: 'next-turn' };
    } catch (error) { return { ok: false, reason: String(error.message || error) }; }
  }); }
  return { active, executionRuntimes, selectExecution };
}
module.exports = { create };
