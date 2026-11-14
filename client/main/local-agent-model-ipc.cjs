'use strict';

const path = require('node:path');
const { fileURLToPath } = require('node:url');
const store = require('./local-agent-model-store.cjs');
const defaultModels = require('./local-model-store.cjs');

function stale() {
  return Object.assign(Error('账号或设备环境已变化，请刷新 Agent 设置后重试'), { code: 'LOCAL_AGENT_MODEL_SCOPE_CHANGED' });
}
function install({ app, ipcMain, safeStorage, scopeOf, changed = () => {}, fetchImpl, probeAgent,
  modelStore = defaultModels, runtimes }) {
  store.configure({ app, safeStorage, modelStore, runtimes });
  function assertDesk(event) {
    const frame = event.senderFrame, url = frame?.url || event.sender.getURL();
    if ((frame && frame !== event.sender.mainFrame) || !url.startsWith('file:') ||
        path.resolve(fileURLToPath(new URL(url))) !== path.resolve(__dirname, '../desk.html')) {
      throw Error('本地 Agent 默认模型只允许主工作台管理');
    }
  }
  function scope(input, mutation) {
    const value = scopeOf?.();
    if (!value) throw Error('请先登录本机 SoduWork 再管理 Agent 默认模型');
    const key = store.scopeKey(value);
    if ((mutation || input?.scopeKey != null) && input?.scopeKey !== key) throw stale();
    return { hub: value.hub, clientId: value.clientId, owner: value.owner };
  }
  for (const action of ['get', 'set', 'remove']) ipcMain.handle('local-agent-models-' + action, (event, input = {}) => {
    assertDesk(event);
    const owned = scope(input, action !== 'get');
    const result = store[action]({ ...owned, agentId: input.agentId,
      modelName: input.modelName, expectedRevision: input.expectedRevision });
    if (action !== 'get') changed();
    return result;
  });
  ipcMain.handle('local-agent-models-probe', async (event, input = {}) => {
    assertDesk(event);
    const owned = scope(input, true), id = store.agentId(input.agentId);
    const saved = store.get({ ...owned, agentId: id });
    if (input.expectedRevision != null && input.expectedRevision !== saved.revision) {
      throw Object.assign(Error('Agent 默认模型已变化，请重新测试'), { code: 'LOCAL_AGENT_MODEL_CONFLICT' });
    }
    const modelName = String(input.modelName || saved.modelName || '');
    if (!store.MODEL.test(modelName)) return { ok: false, probeKind: 'model-connectivity',
      localOnly: true, modelName: '', unavailable: true, detail: '请先选择本机可用模型' };
    const model = modelStore.resolve(modelName);
    if (!model || model.modality && model.modality !== 'chat') return { ok: false, probeKind: 'model-connectivity',
      localOnly: true, modelName, unavailable: true, detail: '原本地模型已删除或不可用，请重新选择' };
    const probeKind = probeAgent ? 'agent-execution' : 'model-connectivity';
    let tested;
    try { tested = probeAgent ? await probeAgent({ agentId: id, model,
      assertCurrent: () => scope({ scopeKey: saved.scopeKey }, true) }) :
      await modelStore.test(model.provider || model.providerId, model.name, fetchImpl); }
    catch (_) { tested = { ok: false }; }
    // Provider traffic may outlive navigation, account changes, or a default edit.
    scope({ scopeKey: saved.scopeKey }, true);
    if (!input.modelName && store.get({ ...owned, agentId: id }).revision !== saved.revision) {
      throw Object.assign(Error('Agent 默认模型已变化，请重新测试'), { code: 'LOCAL_AGENT_MODEL_CONFLICT' });
    }
    const current = modelStore.resolve(modelName);
    if (!current || current.baseUrl !== model.baseUrl || current.key !== model.key || current.name !== model.name) {
      return { ok: false, probeKind, localOnly: true, modelName,
        unavailable: !current, detail: '本地模型连接配置已变化，请重新测试' };
    }
    if (tested?.ok === true) changed();
    return { ok: tested?.ok === true, probeKind, localOnly: true, modelName,
      unavailable: false, detail: tested?.ok === true
        ? probeAgent ? '本地模型与 Agent 实际执行测试通过' : '本地模型连接测试通过（未执行 Agent 任务）'
        : probeAgent ? '本地模型与 Agent 实际执行测试未通过，请检查模型和底座配置' : '本地模型连接测试未通过，请检查本机模型设置' };
  });
}

module.exports = { install };
