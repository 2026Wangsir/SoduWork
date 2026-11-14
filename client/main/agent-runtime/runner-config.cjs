'use strict';

const contextWindow = require('../conversation/context-window');
const modelSelection = require('../conversation/model-selection');
const thinkingCapabilities = require('../conversation/thinking-capabilities');

// Ordinary turns and workflow nodes use the same managed-model contract,
// including when a running node receives a renewed model ticket.
function create(model, adapterId, capabilityIds) {
  const cfg = { local_cli: String(adapterId || 'codex-harness') };
  if (adapterId === 'codex') cfg.codex_model = String(model && model.id || '');
  const requiredCapabilities = Array.from(new Set((Array.isArray(capabilityIds)
    ? capabilityIds : []).map(value => String(value || '').trim().toLowerCase()).filter(Boolean)));
  if (requiredCapabilities.length) cfg.requiredCapabilities = requiredCapabilities;
  // Local providers may intentionally have no API key (for example an
  // Ollama-compatible endpoint). Keep the opaque local reference out of the
  // child process and use the provider's wire model id instead.
  const wireModel = model && model.localOnly
    ? String(model.wireModelId || model.modelName || model.id || '')
    : String(model && model.id || '');
  const hasModelConfig = model && model.baseUrl && wireModel &&
    (model.localOnly || model.key);
  if (hasModelConfig) {
    const thinking = thinkingCapabilities.profile(model);
    cfg.llm = {
      base: String(model.baseUrl), key: String(model.key || ''), model: wireModel,
      ...(model.localOnly ? { localOnly: true, authMode: model.authMode || 'api-key' } : {}),
      ...(model.quotaVersion === 2 && model.quotaUsageToken && !model.localOnly ? {
        quotaVersion: 2, quotaUsageToken: model.quotaUsageToken,
        quotaProvider: model.quotaProvider || '',
      } : {}),
      maxOutputTokens: modelSelection.outputLimit(model),
      ...(['none', 'always', 'controllable'].includes(model.thinkingMode)
        ? { thinkingMode: model.thinkingMode } : {}),
      ...(typeof model.thinkingAlwaysOn === 'boolean' ? { thinkingAlwaysOn: model.thinkingAlwaysOn } : {}),
      ...(thinkingCapabilities.LEVELS.includes(model.thinkingLevel) ? { thinkingLevel: model.thinkingLevel } : {}),
      ...(thinking.reasoning && (model.reasoning === true || ['always', 'controllable'].includes(model.thinkingMode)) ? {
        reasoning: true,
        thinkingFormat: thinking.format,
        supportsReasoningEffort: thinking.supportsReasoningEffort,
        ...(thinking.thinkingLevelMap ? { thinkingLevelMap: { ...thinking.thinkingLevelMap } } : {}),
      } : {}),
      ...(model.capabilityProfile ? { capabilityProfile: model.capabilityProfile } : {}),
      ...(model.configRevision ? { configRevision: model.configRevision } : {}),
      ...(model.runtimeRevision ? { runtimeRevision: model.runtimeRevision } : {}),
      ...(Array.isArray(model.input) ? { input: model.input.filter(value => value === 'text' || value === 'image') } : {}),
      ...(['native', 'vision-fallback'].includes(model.imageRouting) ? { imageRouting: model.imageRouting } : {}),
      ...(typeof model.visionFallbackAvailable === 'boolean' ? { visionFallbackAvailable: model.visionFallbackAvailable } : {}),
      ...contextWindow.resolveContextWindow(model),
    };
  }
  return cfg;
}

module.exports = { create };
