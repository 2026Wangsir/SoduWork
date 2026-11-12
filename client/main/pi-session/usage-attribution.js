'use strict';

// Freeze the resolved catalog provider per assistant call before SDK archival.
function create(preparedModel) {
  let active = null;
  return function stamp(event) {
    if (event?.type === 'agent_end') { active = null; return; }
    const message = event?.message;
    if (message?.role !== 'assistant') return;
    if (event.type === 'message_start') {
      const prepared = preparedModel();
      const model = prepared?.model;
      const provider = typeof model?.quotaProvider === 'string' ? model.quotaProvider.trim() : '';
      active = model?.id
        ? { model: String(model.id), provider, runtimeProvider: prepared.provider || '', localOnly: model.localOnly === true,
          quotaUsageToken: model.quotaVersion === 2 && typeof model.quotaUsageToken === 'string'
            ? model.quotaUsageToken : '' } : null;
    }
    if (event.type !== 'message_start' && event.type !== 'message_end') return;
    if (active && message.model === active.model &&
        (!active.runtimeProvider || message.provider === active.runtimeProvider)) {
      // Persist ownership with each call so switching models or reopening an
      // archive cannot upload local usage as part of a managed cumulative total.
      message.usageLocalOnly = active.localOnly;
    }
    if (!message.usageProvider && active?.provider && message.model === active.model &&
        (!active.runtimeProvider || message.provider === active.runtimeProvider)) {
      message.usageProvider = active.provider;
    }
    if (active && active.quotaUsageToken && message.model === active.model &&
        message.usageProvider === active.provider &&
        (!active.runtimeProvider || message.provider === active.runtimeProvider)) {
      // Persist only with this actual call's usage; never label historical totals
      // from the composer's current selection or an unverified funding flag.
      message.quotaUsageToken = active.quotaUsageToken;
    }
    if (event.type === 'message_end') active = null;
  };
}

module.exports = { create };
