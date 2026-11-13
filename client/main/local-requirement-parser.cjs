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
    return generate({ appBridge: { appId: 'local-requirement-parser' }, view: null }, { ...params, model });
  };
}

module.exports = { createLocalRequirementParser, localReference };
