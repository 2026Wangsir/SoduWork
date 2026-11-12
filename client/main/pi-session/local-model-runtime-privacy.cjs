'use strict';

const OPAQUE_REFERENCE = /^local:model-[a-f0-9]{32}$/;
const LOCAL_ENDPOINT = 'https://local-model.invalid/v1';
const LOCAL_LABEL = 'Local model';
const runtimes = new WeakMap();

function reference(model) {
  const ref = String(model?.modelRef || model?.id || '');
  if (!OPAQUE_REFERENCE.test(ref)) throw new Error('Local model reference is unavailable');
  return ref;
}

// Preserve only classifications consumed by retry and context recovery. Provider
// error bodies can echo credentials, private addresses and arbitrary model names.
function safeError(value) {
  const info = require('./model-errors').describe(value);
  const recovery = require('./context-recovery');
  const prefix = info.status ? 'HTTP ' + info.status + ': ' : '';
  if (recovery.OVERFLOW.test(info.raw)) {
    const size = recovery.errorWindow(value);
    return prefix + 'context_length_exceeded' + (size ? '; maximum context length is ' + size : '');
  }
  if (info.authExpired) return prefix + 'Local model credential expired';
  if (info.code === 'upstream_billing_error') return prefix + 'Local model insufficient_quota';
  if (info.transient) return prefix + 'Local model service temporarily unavailable';
  return prefix + 'Local model request failed';
}

function cleanMessage(message, ref) {
  if (!message || typeof message !== 'object') return message;
  message.model = ref;
  delete message.responseModel;
  // Completion IDs are provider-controlled metadata, not continuation tokens in
  // the OpenAI chat-completions transport used by local models.
  delete message.responseId;
  if (message.errorMessage) message.errorMessage = safeError(message.errorMessage);
  return message;
}

function cleanEvent(event, ref) {
  if (!event || typeof event !== 'object') return event;
  for (const field of ['partial', 'message', 'error']) cleanMessage(event[field], ref);
  return event;
}

function privateStream(source, ref) {
  return {
    async *[Symbol.asyncIterator]() {
      try {
        for await (const event of source) yield cleanEvent(event, ref);
      } catch (error) { throw new Error(safeError(error)); }
    },
    async result() {
      try { return cleanMessage(await source.result(), ref); }
      catch (error) { throw new Error(safeError(error)); }
    },
  };
}

function install(runtime) {
  if (runtimes.has(runtime)) return runtimes.get(runtime);
  const models = new Map();
  for (const method of ['stream', 'streamSimple']) {
    if (typeof runtime[method] !== 'function') continue;
    const original = runtime[method].bind(runtime);
    runtime[method] = (model, context, options = {}) => {
      const local = models.get(model?.id);
      if (!local || model?.provider !== 'soduwork') return original(model, context, options);
      const ref = model.id;
      const visibleModel = { ...model, name: LOCAL_LABEL, baseUrl: LOCAL_ENDPOINT };
      const privateOptions = {
        ...options,
        // Capture credentials with the selected local configuration. Background
        // cache warming can overlap a later managed-provider registration.
        apiKey: local.key || 'soduwork-local-no-key',
        headers: { ...options.headers, Authorization: local.key ? 'Bearer ' + local.key : null },
        async onPayload(payload) {
          // Extensions observe only the opaque model reference. Restore the wire
          // name after their transformations so it cannot become persisted state.
          const transformed = await options.onPayload?.(payload, visibleModel);
          return { ...(transformed === undefined ? payload : transformed), model: local.wireModelId };
        },
        async onProviderStreamEvent(chunk) {
          if (chunk && typeof chunk === 'object') {
            chunk.model = ref;
            delete chunk.id;
          }
          if (options.onProviderStreamEvent) {
            await options.onProviderStreamEvent(chunk && typeof chunk === 'object'
              ? { object: 'chat.completion.chunk', model: ref, choices: chunk.choices, usage: chunk.usage }
              : chunk, visibleModel);
          }
        },
        async onResponse(response) {
          // Do not hand arbitrary provider-controlled headers to extensions that
          // may persist diagnostics. The transport still receives the originals.
          await options.onResponse?.({ status: response?.status, headers: {} }, visibleModel);
        },
      };
      try {
        return privateStream(original({ ...model, baseUrl: local.baseUrl }, context, privateOptions), ref);
      } catch (error) { throw new Error(safeError(error)); }
    };
  }
  runtimes.set(runtime, models);
  return models;
}

function configure(runtime, target, next) {
  if (!target || next?.localOnly !== true) return target;
  const ref = reference(next);
  if (!String(next.wireModelId || '').trim()) throw new Error('Local model name is unavailable');
  install(runtime).set(ref, { wireModelId: next.wireModelId, baseUrl: next.baseUrl, key: String(next.key || '') });
  const headers = { ...target.headers };
  if (!String(next.key || '').trim()) headers.Authorization = null;
  else delete headers.Authorization;
  return { ...target, id: ref, name: LOCAL_LABEL, baseUrl: LOCAL_ENDPOINT, headers };
}

module.exports = { configure, reference, safeError, LOCAL_ENDPOINT, LOCAL_LABEL, OPAQUE_REFERENCE };
