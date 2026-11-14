'use strict';
const choice = require('../../core/model-choice');
const { fetchWithDeviceAuthRetry } = require('../device-auth-request');

async function resolve(identity, key, fetchImpl = global.fetch, options = {}) {
  const selected = choice.imageChoice(key);
  if (!selected) return { ok: false, reason: '图片模型选择无效' };
  if (selected.name.startsWith('local:')) {
    const local = await resolveLocal(selected);
    if (!local) {
      if (options.allowHistorical && options.app && /^local:model-[a-f0-9]{32}$/.test(selected.name)) {
        return { ok: true, localOnly: true, model: { id: selected.name, modelRef: selected.name,
          wireModelId: selected.name, imageChoice: key, modality: 'image', localOnly: true, historicalLocal: true,
          label: '原本地图片模型已删除或不可用', key: '', input: ['text'],
          baseUrl: require('./local-model-runtime-privacy.cjs').LOCAL_ENDPOINT, contextWindow: 128000 } };
      }
      return { ok: false, reason: '原本地图片模型已删除或不可用，请主动选择可用模型' };
    }
    return { ok: true, localOnly: true, model: {
      id: local.modelRef, modelRef: local.modelRef, wireModelId: local.name, imageChoice: key,
      label: '生成图片 · ' + (local.label || '本地图片模型'), modality: 'image', localOnly: true,
      baseUrl: local.baseUrl, key: local.key, authMode: local.authMode,
      input: ['text'], contextWindow: 128000, contextWindowKnown: true,
      contextWindowEstimated: true, contextWindowSource: 'safe-default',
    } };
  }
  try {
    const hub = String(identity.hub || '').replace(/\/+$/, '');
    const response = await fetchWithDeviceAuthRetry(identity,
      hub + '/api/v1/ai-proxy/media/config', {
        redirect: 'error', signal: AbortSignal.timeout(10000),
      }, fetchImpl);
    if (!response.ok) return { ok: false, reason: '图片模型目录暂不可用，请检查服务端版本和连接' };
    const data = await response.json();
    const row = (data.models?.image || []).find(row => row.providerId === selected.providerId && row.name === selected.name);
    if (!row || !data.key) return { ok: false, reason: '所选图片模型已不可用，请重新选择' };
    return { ok: true, model: { id: row.name, providerId: row.providerId, label: '生成图片 · ' + (row.label || row.name),
      modality: 'image', baseUrl: hub + '/api/v1/ai-proxy/v1', key: data.key,
      contextWindow: 128000, contextWindowKnown: true, contextWindowEstimated: true, contextWindowSource: 'safe-default', input: ['text'] } };
  } catch (_) { return { ok: false, reason: '无法加载图片模型，请检查后台连接' }; }
}
async function resolveLocal(selected) {
  if (!/^local:model-[a-f0-9]{32}$/.test(String(selected?.name || ''))) return null;
  try {
    const runtime = require('../agent-runtime/process-context').current();
    const local = typeof runtime?.localModel === 'function' ? await runtime.localModel(selected.name)
      : require('../local-model-store.cjs').resolve(selected.name);
    return local?.localOnly === true && local.modality === 'image' &&
      local.modelRef === selected.name && local.provider === selected.providerId.replace(/^device:/, '') ? local : null;
  } catch (_) { return null; }
}
module.exports = { ...choice, resolve, resolveLocal };
