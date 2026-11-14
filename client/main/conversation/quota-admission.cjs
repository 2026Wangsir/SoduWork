'use strict';

const { fetchWithDeviceAuthRetry } = require('../device-auth-request');
const { scope } = require('./runtime-segments');

function managedAgent(value) {
  const agent = String(value || '').trim().replace(/^local:/, '').replace(/^runner:[^:]+:/, '');
  if (agent === 'custom-acp') return agent;
  if (require('../agent-runtime/runtime-catalog').runtime(agent)?.modelMode !== 'managed') return '';
  return agent.startsWith('custom-') ? 'custom-acp' : agent;
}

function create({ app, identityOf, onQuotaExceeded, onQuotaChanged, fetchImpl = global.fetch }) {
  return async function authorize(expected, expectedScope = scope(expected), selection) {
    const identity = await identityOf(app);
    const matches = value => value && value.hub === expected?.hub &&
      value.clientId === expected?.clientId && scope(value) === expectedScope;
    if (!matches(identity)) throw Error('账号或连接环境已变化，请重新发送');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      // Captured model names are resolved by the server, never an exemption flag.
      const query = new URLSearchParams();
      if (typeof selection?.model === 'string') query.set('model', selection.model);
      if (typeof selection?.agent === 'string') query.set('agent', selection.agent);
      const response = await fetchWithDeviceAuthRetry(identity,
        identity.hub.replace(/\/+$/, '') + '/api/v1/client-auth/authorize-ai' +
          (query.size ? '?' + query.toString() : ''),
        { signal: controller.signal }, fetchImpl);
      const result = await response.json().catch(() => null);
      if (!matches(await identityOf(app))) throw Error('账号或连接环境已变化，请重新发送');
      const quota = result?.quota;
      // Legacy Hubs retain their strict account gate. Only a versioned,
      // server-resolved response can grant personal funding.
      const versioned = result?.quotaVersion === 2;
      const invalidScope = result?.quotaScope === 'personal' && (!versioned || !managedAgent(query.get('agent')) ||
        result.personalQuotaSupported !== true) ||
        versioned && query.size && (!['personal', 'platform'].includes(result.quotaScope) ||
          typeof result.resolvedModel !== 'string' || !result.resolvedModel ||
          typeof result.providerId !== 'string' || !result.providerId ||
          Boolean(selection?.model && result.resolvedModel !== selection.model));
      if (invalidScope || !response.ok || result?.ok !== true || typeof quota?.enabled !== 'boolean' ||
          typeof quota?.exceeded !== 'boolean' || quota.exceeded) {
        const detail = quota?.exceeded ? { code: 'TOKEN_QUOTA_EXCEEDED',
          message: '本月 AI Token 额度已用完，请联系管理员调整额度', quota } : result?.detail;
        if (detail?.code === 'TOKEN_QUOTA_EXCEEDED') onQuotaExceeded?.({
          hub: identity.hub, clientId: identity.clientId, quota: detail.quota });
        throw Object.assign(Error(detail?.message || (response.status === 404 || invalidScope
          ? '服务端需要升级后才能校验个人 Token 额度' : '无法确认可用额度，请稍后重试')), require('../../core/token-quota').fields(detail));
      }
      // A successful new turn can follow an administrator restoring allowance.
      // Notify presentation without treating a model-specific personal grant
      // as the account's global platform quota.
      try { onQuotaChanged?.({ hub: identity.hub, clientId: identity.clientId }); } catch (_) {}
      return result.quota;
    } finally { clearTimeout(timer); }
  };
}

function localManagedRuntime(runtime) {
  const agent = String(runtime?.agent || '').trim()
    .replace(/^local:/, '').replace(/^runner:[^:]+:/, '');
  return runtime?.modelMode === 'managed' && !runtime?.controlled &&
    agent && !['codex', 'claude'].includes(agent);
}

function beforeTurn(authorize, identity, previous, runtime) {
  const expectedScope = scope(identity);
  return async function (turn, ...args) {
    const modelName = typeof turn?.modelName === 'string' ? turn.modelName.trim() : '';
    const image = require('../../core/model-choice').imageChoice(modelName);
    if (image?.name.startsWith('local:')) {
      const local = localManagedRuntime(runtime) && managedAgent(runtime.agent) === 'pi' &&
        await runtime.localModel?.(image.name);
      if (!local?.localOnly || local.modality !== 'image' || local.provider !== image.providerId.replace(/^device:/, '')) {
        throw Error('原本地图片模型已删除或不可用，请主动选择可用模型');
      }
      return previous?.apply(this, args);
    }
    if (modelName.startsWith('local:')) {
      // Managed local runtimes validate the captured reference locally and
      // never disclose it to Hub admission. Account-owned runtimes remain
      // independent of SoduWork model configuration.
      const local = localManagedRuntime(runtime) &&
        await runtime.localModel?.(modelName);
      if (!local?.localOnly) throw Error('本地模型不可用，请刷新模型配置后重试');
      return previous?.apply(this, args);
    }
    const agent = managedAgent(runtime?.agent);
    const selection = agent && runtime.modelMode === 'managed' && !runtime.controlled &&
      !require('../../core/model-choice').imageChoice(modelName) ? {
      model: modelName, agent,
    } : undefined;
    await authorize(identity, expectedScope, selection);
    return previous?.apply(this, args);
  };
}

module.exports = { create, beforeTurn };
