'use strict';

// Local requirement parsing is a bounded, one-shot call. It never creates a
// conversation, loads workspace resources, or sends model data to the Hub.
const { create } = require('./app-ai-generate.cjs');

function localReference(value) {
  const model = String(value || '').trim();
  return model.startsWith('local:') ? model : '';
}

function createLocalRequirementParser({ app, identityOf, fetchImpl = global.fetch,
  resolveModel, configuredModel } = {}) {
  const generate = create({ app, authenticatedIdentityOf: identityOf, fetchImpl,
    ...(resolveModel ? { resolveModel } : {}), ...(configuredModel ? { configuredModel } : {}) });
  return async raw => {
    const params = raw && typeof raw === 'object' ? raw : {};
    const model = localReference(params.model);
    if (!model) return { ok: false, code: 'APP_AI_LOCAL_MODEL_REQUIRED', reason: '本地需求解析只支持本地模型' };
    const result = await generate({ appBridge: { appId: 'local-requirement-parser' }, view: null }, { ...params, model });
    if (result?.ok && result.finishReason === 'length') {
      return { ok: false, code: 'APP_AI_OUTPUT_LIMIT', reason: '本地模型输出达到长度上限，未生成完整需求' };
    }
    return result;
  };
}

module.exports = { createLocalRequirementParser, localReference };
