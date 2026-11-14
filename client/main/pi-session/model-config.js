/* ===== Local Pi model configuration: credentials, configuration directory, and proxy =====

   GET /api/v1/ai-proxy/config returns short-lived, purpose-bound proxy tickets instead of gateway keys.
   Tickets work only with the backend OpenAI-compatible endpoint; the backend supplies the shared
   model-service key. Managed conversations resolve Hub configuration or device-owned models here;
   credentials are never exposed to the renderer.

   Keep plaintext credentials off disk: managed models.json contains only the
   $SODUWORK_PROXY_KEY variable reference; local no-key models use a non-secret
   marker and suppress the Authorization header after model resolution. Values
   are supplied through process.env or the host-side encrypted store.

   Point PI_CODING_AGENT_DIR to a separate directory under this application's userData.
   Do not share ~/.pi/agent/ with backend-dispatched sessions, which manage their own configuration. */
const fs = require('fs');
const path = require('path');
const { fetchWithDeviceAuthRetry, accountScopeKey } = require('../device-auth-request');
const contextWindow = require('../conversation/context-window');
const thinkingCapabilities = require('../conversation/thinking-capabilities');
const localModels = require('../local-model-store.cjs');
const runtimeContext = require('../agent-runtime/process-context');
const localPrivacy = require('./local-model-runtime-privacy.cjs');

const ENV_KEY = 'SODUWORK_PROXY_KEY';          // Environment variable referenced by models.json.
const ENV_MCP_KEY = 'SODUWORK_MCP_KEY';
const ENV_AGENT_DIR = 'PI_CODING_AGENT_DIR';
const DEFAULT_CTX = contextWindow.DEFAULT_CONTEXT_WINDOW;                 // Fallback context window when the backend supplies none.
const MODEL_CACHE_MS = 30000;
const _modelCache = new Map();
const _modelPending = new Map();
let configGeneration = 0;
function invalidate() {
  configGeneration++;
  _modelCache.clear();
  _modelPending.clear();
}

function agentDir(app) {
  return path.join(app.getPath('userData'), 'pi-agent');
}

// Automation runs are created outside the ordinary composer, so an empty Hub
// model override should reuse the local selection rather than a stale default.
function configuredModel(app) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(agentDir(app), 'models.json'), 'utf8'));
    for (const provider of Object.values(value && value.providers || {})) {
      for (const model of Array.isArray(provider?.models) ? provider.models : []) {
        if (String(model?.modality || '').toLowerCase() === 'image') continue;
        const localRef = String(model?.localRef || provider?.localRef || '').trim();
        if (provider?.localOnly === true && localRef.startsWith('local:')) {
          // The isolated runtime cannot read Electron safeStorage directly;
          // its host RPC is the authority for whether the local reference exists.
          try {
            if (typeof runtimeContext.current?.()?.localModel === 'function') return localRef;
          } catch (_) {}
          try { if (localModels.resolve(localRef)) return localRef; } catch (_) {}
          continue;
        }
        const id = String(model?.id || '').trim();
        if (id) return id;
      }
    }
  } catch (_) { /* A first run has no local model selection yet. */ }
  return '';
}

/*
 * Opening an archived transcript must not depend on a currently usable AI
 * allowance. The SDK still needs a model-shaped value to hydrate the archive,
 * but no request is sent until a new turn passes quota admission. Reuse the
 * last local model metadata when available and mark the result so callers can
 * force a fresh ticket before any future send.
 */
function historicalModel(app, identity, modelName = '') {
  let stored = null;
  try {
    const value = JSON.parse(fs.readFileSync(path.join(agentDir(app), 'models.json'), 'utf8'));
    const provider = value?.providers?.soduwork;
    const row = Array.isArray(provider?.models) ? provider.models[0] : null;
    if (row) stored = { provider, row };
  } catch (_) { /* A first run may not have local model metadata yet. */ }
  const id = String(modelName || stored?.row?.id || configuredModel(app) || 'history').trim() || 'history';
  const baseUrl = String(stored?.provider?.baseUrl || '').trim() ||
    String(identity?.hub || '').replace(/\/+$/, '') + '/api/v1/ai-proxy/v1';
  const localHistory = String(modelName || '').startsWith('local:');
  const model = {
    // Keep a deleted local selection as a read-only placeholder. It must never
    // become a Hub model or acquire credentials from a same-name replacement.
    baseUrl: localHistory ? localPrivacy.LOCAL_ENDPOINT : baseUrl, key: localHistory ? '' : 'history-only', id,
    ...(localHistory ? { modelRef: id, wireModelId: id, localOnly: true, historicalLocal: true } : {}),
    label: String(stored?.row?.name || stored?.row?.label || id),
    input: Array.isArray(stored?.row?.input) && stored.row.input.length ? stored.row.input : ['text'],
    contextWindow: Number(stored?.row?.contextWindow) || DEFAULT_CTX,
    maxOutputTokens: Number(stored?.row?.maxTokens) || 8192,
    historical: true,
  };
  return { ok: true, historical: true, provider: 'soduwork', agentDir: agentDir(app), model };
}

/*
 * Resolve an authorized Hub endpoint or a device-owned model in an explicit
 * local execution context, returning a readable failure when unavailable.
 */
async function fetchModel(identity, modelName = '', timeoutMs = 8000, fetchImpl = global.fetch, force = false,
  agentId = 'pi', options = {}) {
  modelName = String(modelName || '').trim();
  const requestedAgent = String(agentId || 'pi').trim().toLowerCase().replace(/^local:/, '');
  const runtimeSpec = require('../agent-runtime/runtime-catalog').runtime(requestedAgent);
  // Only on-device calls may inherit a device-owned preference. Cloud and
  // controlled execution keep their explicit server-owned model selection.
  if (!modelName && !options.ignoreAgentPreference && runtimeSpec?.modelMode === 'managed' &&
      (options.allowLocal === true || requestedAgent === 'pi' && options.app)) {
    try {
      const runtime = runtimeContext.current?.();
      const defaults = require('../local-agent-model-store.cjs');
      const preferred = typeof runtime?.localAgentModel === 'function'
        ? await runtime.localAgentModel(identity, requestedAgent)
        : defaults.configured() ? defaults.fromIdentity(identity, requestedAgent) : null;
      if (preferred?.configured) {
        if (preferred.unavailable) {
          if (options.allowHistorical && options.app && String(preferred.modelName || '').startsWith('local:')) {
            return historicalModel(options.app, identity, preferred.modelName);
          }
          return { ok: false, code: 'LOCAL_AGENT_DEFAULT_UNAVAILABLE',
            reason: 'Agent 原本地默认模型已删除或不可用，请主动选择可用模型' };
        }
        modelName = preferred.modelName;
      }
    } catch (_) { return { ok: false, code: 'LOCAL_AGENT_DEFAULT_UNAVAILABLE',
      reason: '本机 Agent 默认模型无法读取，请检查账号和本地模型设置' }; }
  }
  if (require('./image-model').imageChoice(modelName)) {
    return { ok: false, reason: '图片模型不能作为对话推理模型；请使用 Pi 直接生图，或在对话中使用图片插件' };
  }
  if (String(modelName || '').startsWith('local:')) {
    // Local references may only be resolved by a managed runtime in this
    // desktop process. Account runtimes (Codex/Claude) and cloud execution
    // must continue to use their own model or Hub-issued configuration.
    const localAllowed = runtimeSpec?.modelMode === 'managed' &&
      (options.allowLocal === true || requestedAgent === 'pi' && options.app);
    if (!localAllowed) return { ok: false, reason: '本地模型仅支持明确的本机受管底座调用，不能用于云端或账号型底座' };
    let local = null;
    try {
      const runtime = runtimeContext.current?.();
      local = typeof runtime?.localModel === 'function'
        ? await runtime.localModel(modelName)
        : localModels.resolve(modelName);
    } catch (_) { local = null; }
    if (!local) {
      if (options?.allowHistorical && options.app) return historicalModel(options.app, identity, modelName);
      return { ok: false, reason: '本地模型不存在或凭据未配置，请在「我的模型」中刷新' };
    }
    const thinking = thinkingCapabilities.profile({ ...local, id: local.name });
    return { ok: true, localOnly: true, model: {
      baseUrl: local.baseUrl, key: local.key, id: local.runtimeId || local.modelRef,
      wireModelId: local.name, label: local.label || local.name,
      provider: local.provider, providerName: local.providerName, authMode: local.authMode,
      keyFrom: 'local', modelRef: local.modelRef,
      configRevision: local.configRevision,
      input: ['text'], modality: local.modality || 'chat', maxOutputTokens: local.config?.maxOutputTokens,
      ...contextWindow.resolveContextWindow({ contextWindow: local.ctxWindow, modelName: local.name, provider: local.provider }),
      ...thinking,
      ...(thinking.format ? { thinkingFormat: thinking.format } : {}),
      localOnly: true, proxyExpiresAt: 0,
    } };
  }
  if (!identity || !identity.hub || !identity.clientId || (!identity.session && !identity.secret)) {
    return { ok: false, reason: '这台电脑还没连上 SoduWork 后台（先打开桌宠登录一次）' };
  }
  const hub = String(identity.hub).replace(/\/+$/, '');
  const ignoreAgentPreference = options && options.ignoreAgentPreference === true;
  const custom = requestedAgent.startsWith('custom-') &&
    require('../agent-runtime/runtime-catalog').runtime(requestedAgent)?.modelMode === 'managed';
  const agent = custom ? 'custom-acp' : requestedAgent;
  const accountScope = accountScopeKey(identity);
  const cacheKey = hub + '|' + String(identity.clientId || '') + '|' + accountScope + '|' + agent + '|' +
    String(modelName || '') + '|' + (ignoreAgentPreference ? 'without-preference' : 'with-preference');
  const cacheable = fetchImpl === global.fetch && !!accountScope;
  if (cacheable && force) {
    _modelCache.delete(cacheKey);
    _modelPending.delete(cacheKey);
  }
  const cached = cacheable && _modelCache.get(cacheKey);
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.value;
  // The in-memory cache can expire before the signed proxy ticket does. A
  // ticket with a known safety margin is still authorized, so return it while
  // refreshing configuration in the background. Near-expiry/unknown tickets
  // continue to block and refresh synchronously.
  const ticketExpiry = Number(cached && cached.value && cached.value.model &&
    cached.value.model.proxyExpiresAt || 0);
  const staleValue = cached && !force && ticketExpiry > now + 2 * 60 * 1000
    ? cached.value : null;
  if (cacheable && _modelPending.has(cacheKey)) {
    return staleValue || _modelPending.get(cacheKey);
  }
  const request = (async () => {
  const generation = configGeneration;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const query = '?agent=' + encodeURIComponent(agent) + (String(modelName || '').trim()
      ? '&model=' + encodeURIComponent(String(modelName).trim()) : '') +
      (ignoreAgentPreference ? '&ignore_preference=1' : '');
    const res = await fetchWithDeviceAuthRetry(identity,
      hub + '/api/v1/ai-proxy/config' + query, {
      signal: ctl.signal,
      }, fetchImpl);
    if (!res.ok) {
      const error = await res.json().catch(() => null);
      const detail = error?.detail;
      const message = typeof detail === 'string' ? detail : detail?.message;
      const failure = { ok: false, status: res.status,
        reason: typeof message === 'string' && message.trim()
          ? message.slice(0, 500) : '后台没应答（HTTP ' + res.status + '）',
        ...(typeof detail?.code === 'string' ? { code: detail.code } : {}),
        ...(detail?.code === 'TOKEN_QUOTA_EXCEEDED' ? { quota: detail.quota } : {}),
      };
      if (options?.allowHistorical && failure.code === 'TOKEN_QUOTA_EXCEEDED') {
        return historicalModel(options.app, identity, modelName);
      }
      return failure;
    }
    const d = await res.json();
    if (!d || !d.ok) return { ok: false, reason: custom && d?.reason === '此底座不使用企业模型配置，请检查执行底座'
      ? '后台尚不支持新底座的模型配置，请更新后台后重试' : (d && d.reason) || '后台没给出可用的模型' };
    if (!d.key || !d.model) return { ok: false, reason: '后台回的配置不完整（缺 key 或 model）' };
    const managed = custom || require('../agent-runtime/runtime-catalog').runtime(requestedAgent)?.modelMode === 'managed';
    if (d.quotaScope === 'personal' && (!managed || d.quotaVersion !== 2 ||
        d.personalQuotaSupported !== true || typeof d.quotaUsageToken !== 'string' || !d.quotaUsageToken ||
        !String(d.providerKey || d.provider || '').trim())) {
      return { ok: false, reason: '服务端需要升级后才能校验个人 Token 额度' };
    }
    const issuedAt = Date.now();
    const expiresIn = Math.max(0, Number(d.expiresIn) || 0);
    const value = {
      ok: true,
      model: {
        baseUrl: hub + (d.path || '/api/v1/ai-proxy/v1'),
        key: d.key,
        mcpKey: d.mcpKey || '',
        id: d.model,
        quotaProvider: d.providerKey || d.provider || '',
        ...(d.quotaVersion === 2 && ['personal', 'platform'].includes(d.quotaScope) ? {
          quotaVersion: 2, quotaScope: d.quotaScope,
          ...(typeof d.quotaUsageToken === 'string' ? { quotaUsageToken: d.quotaUsageToken } : {}),
        } : {}),
        label: d.label || d.model,
        maxOutputTokens: d.maxOutputTokens,
        capabilityProfile: d.capabilityProfile,
        configRevision: d.configRevision,
        runtimeRevision: d.runtimeRevision,
        ...thinkingCapabilities.profile({ id: d.model, providerName: d.providerName,
          reasoning: d.reasoning, thinkingMode: d.thinkingMode, thinkingFormat: d.thinkingFormat,
          supportsReasoningEffort: d.supportsReasoningEffort,
          thinkingAlwaysOn: d.thinkingAlwaysOn,
          thinkingLevelMap: d.thinkingLevelMap }),
        // Preserve declared policy separately from normalized capabilities.
        ...(['none', 'always', 'controllable'].includes(d.thinkingMode)
          ? { thinkingMode: d.thinkingMode } : {}),
        ...(typeof d.thinkingAlwaysOn === 'boolean' ? { thinkingAlwaysOn: d.thinkingAlwaysOn } : {}),
        ...(thinkingCapabilities.LEVELS.includes(d.thinkingLevel) ? { thinkingLevel: d.thinkingLevel } : {}),
        // Image forwarding is an explicit server-side opt-in.  Older servers
        // advertised every model as image-capable, which made text-only
        // gateways reject an attached image with an opaque HTTP 400.
        imageRouting: d.imageRouting === 'native' ? 'native' : 'vision-fallback',
        visionFallbackAvailable: d.visionFallbackAvailable === true,
        input: d.imageRouting === 'native' && Array.isArray(d.input) && d.input.includes('image')
          ? ['text', 'image'] : ['text'],
        // Gateways may omit model metadata. Resolve a conservative numeric
        // window so the meter and compaction logic work for every provider.
        ...contextWindow.resolveContextWindow({
          contextWindow: d.contextWindow,
          modelName: d.model,
          provider: d.providerName,
        }),
        // Kept in memory only.  The session refreshes the proxy ticket at a
        // turn boundary before it can expire, so a 12-hour conversation does
        // not surface a bare HTTP 401 to the user.
        proxyExpiresAt: expiresIn ? issuedAt + expiresIn * 1000 : 0,
      },
    };
    const ticketMs = Math.max(1000, expiresIn * 1000 - 5000);
    if (cacheable && generation === configGeneration) {
      _modelCache.set(cacheKey, {
        value, expiresAt: Date.now() + Math.min(MODEL_CACHE_MS, ticketMs),
      });
    }
    return value;
  } catch (e) {
    // The isolated runtime reports this cancellation as RPC_ABORTED rather
    // than AbortError. Only our deadline proves that this request timed out;
    // an unrelated runtime cancellation must not become a quota refusal.
    if (ctl.signal.aborted) return { ok: false, code: 'MODEL_CONFIG_TIMEOUT', reason: '服务响应超时，可稍后重试' };
    const why = String((e && e.message) || e);
    return { ok: false, reason: '连不上后台（' + why + '）' };
  } finally {
    clearTimeout(timer);
  }
  })();
  if (cacheable) _modelPending.set(cacheKey, request);
  if (staleValue) {
    request.finally(() => {
      if (cacheable && _modelPending.get(cacheKey) === request) _modelPending.delete(cacheKey);
    }).catch(() => {});
    return staleValue;
  }
  try { return await request; }
  finally { if (cacheable && _modelPending.get(cacheKey) === request) _modelPending.delete(cacheKey); }
}

/* Write models.json only when content changes to avoid unnecessary concurrent file replacement. */
function writeModels(dir, model) {
  const localRef = model.localOnly ? localPrivacy.reference(model) : '';
  // Local runtime capabilities are registered in memory after SDK construction.
  // The bootstrap file must not reveal even a private model-family hint.
  if (localRef) model = { id: localRef, label: localPrivacy.LOCAL_LABEL,
    baseUrl: localPrivacy.LOCAL_ENDPOINT, localOnly: true, modelRef: localRef,
    ...(model.modality ? { modality: model.modality } : {}),
    reasoning: false, contextWindow: DEFAULT_CTX, input: ['text'] };
  const thinking = thinkingCapabilities.profile(model);
  const want = {
    providers: {
      soduwork: {
        name: 'SoduWork 模型服务',
        baseUrl: model.localOnly ? localPrivacy.LOCAL_ENDPOINT : model.baseUrl,
        api: 'openai-completions',
        ...(model.localOnly ? { localOnly: true } : {}),
        ...(localRef ? { localRef } : {}),
        ...(model.key ? { apiKey: '$' + ENV_KEY } :
          (model.localOnly ? { apiKey: 'soduwork-local-no-key' } : {})),
        // OpenAI-compatible services may not support these two optional capabilities; disable them by default.
        compat: {
          supportsDeveloperRole: false,
          supportsReasoningEffort: Boolean(thinking.supportsReasoningEffort),
          ...(thinking.format ? { thinkingFormat: thinking.format } : {}),
        },
        models: [{
          id: localRef || model.id, name: model.localOnly ? localPrivacy.LOCAL_LABEL : model.label,
          ...(localRef ? { localRef } : {}),
          ...(model.modality ? { modality: model.modality } : {}),
          input: model.input || ['text'],
          reasoning: Boolean(thinking.reasoning),
          ...(thinking.reasoning && thinking.thinkingLevelMap ? { thinkingLevelMap: thinking.thinkingLevelMap } : {}),
          contextWindow: model.contextWindow, maxTokens: require('../conversation/model-selection').outputLimit(model),
        }],
      },
    },
  };
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'models.json');
  const blob = JSON.stringify(want, null, 1);
  try {
    if (fs.readFileSync(file, 'utf8') === blob) return file;
  } catch (e) { /* Write the configuration when the existing file is absent or unreadable. */ }
  fs.writeFileSync(file, blob, { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

/*
 * Configure task MCP capabilities using short-lived backend tickets; keep long-lived
 * device keys in main-process secure storage. Match runtime_payload server structure and
 * expose its path through SODUWORK_MCP_SERVERS.
 */
function writeMcpServers(dir, identity, mcpKey = '') {
  const hub = String((identity && identity.hub) || '').replace(/\/+$/, '');
  if (!hub || !identity?.clientId || !mcpKey) return '';
  const want = {
    servers: {
      soduwork: {
        type: 'http',
        url: hub + '/api/v1/mcp',
        headers: { Authorization: 'Bearer $' + ENV_MCP_KEY },
        description: 'SoduWork 自己：建任务、派活、查任务（工具见 skills/task）',
      },
    },
  };
  const d = path.join(dir, 'mcp');
  fs.mkdirSync(d, { recursive: true });
  const file = path.join(d, 'servers.json');
  const blob = JSON.stringify(want, null, 1);
  try {
    if (fs.readFileSync(file, 'utf8') === blob) return file;
  } catch (e) { /* Create the configuration when absent. */ }
  // Persist environment references only; inject tickets into the current child environment without writing their values to disk.
  fs.writeFileSync(file, blob, { encoding: 'utf8', mode: 0o600 });
  return file;
}

/*
 * Append internal hosts to NO_PROXY without deleting process-wide proxy settings, which
 * other Electron services still need.
 */
function noProxyFor(baseUrl, env = process.env) {
  let host = '';
  try { host = new URL(baseUrl).hostname || ''; } catch (e) { host = ''; }
  if (!host) return env.NO_PROXY || '';
  const cur = String(env.NO_PROXY || '');
  const has = cur.split(',').map((s) => s.trim().toLowerCase()).indexOf(host.toLowerCase()) >= 0;
  const next = has ? cur : (host + (cur ? ',' + cur : ''));
  env.NO_PROXY = next;
  env.no_proxy = next;                      // Populate lowercase proxy variables for libraries that require them.
  return next;
}

/* Send at most one token to warm the configured gateway every 30 minutes.
   Warming is best effort; failures must not block the user's first request. */
let _lastWarmupAt = 0;
function warmupGateway(baseUrl, apiKey, modelId, fetchImpl = global.fetch) {
  const now = Date.now();
  if (now - _lastWarmupAt < 30 * 60 * 1000) return;
  _lastWarmupAt = now;
  try {
    const url = String(baseUrl || '').replace(/\/+$/, '') + '/chat/completions';
    if (!/^https?:\/\//.test(url) || !apiKey || !modelId) return;
    fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
      body: JSON.stringify({ model: modelId, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
    }).catch(() => {});   // Warmup failure must not affect normal execution.
  } catch (_) { /* Ignore this optional warmup failure. */ }
}

/* Prepare the environment required to start a Pi session. */
async function fetchSelection(identity, name = '', timeoutMs = 8000, fetchImpl = global.fetch, force = false, agentId = 'pi', options = {}) {
  if (require('./image-model').imageChoice(name)) return require('./image-model').resolve(identity, name, fetchImpl, options);
  return fetchModel(identity, name, timeoutMs, fetchImpl, force, agentId, options);
}

async function prepare(app, identity, modelName = '', options = {}) {
  try { await require('../local-model-privacy.cjs').prepare(app); }
  catch (_) { return { ok: false, reason: '本地模型隐私保护初始化失败，请检查本机安全存储后重试' }; }
  const got = await fetchSelection(identity, modelName, 8000, global.fetch, false, 'pi', { ...options, app });
  if (!got.ok) return got;
  const dir = agentDir(app);
  writeModels(dir, got.model);
  if (got.model.mcpKey) process.env[ENV_MCP_KEY] = got.model.mcpKey;
  else delete process.env[ENV_MCP_KEY];
  if (got.model.localOnly) delete process.env.SODUWORK_HUB_ORIGIN;
  else {
    try { process.env.SODUWORK_HUB_ORIGIN = new URL(identity.hub).origin; } catch (_) {}
  }
  const mcp = writeMcpServers(dir, identity, got.model.mcpKey);
  if (got.model.key) process.env[ENV_KEY] = got.model.key;
  else delete process.env[ENV_KEY];
  process.env[ENV_AGENT_DIR] = dir;
  if (mcp) process.env.SODUWORK_MCP_SERVERS = mcp;    // Expose the servers.json location to the bridge.
  else delete process.env.SODUWORK_MCP_SERVERS;
  noProxyFor(got.model.baseUrl);
  // Configuration reads must not submit inference requests or consume model quota.
  // Actual model calls start when the user sends a message or runs a task.
  return { ok: true, agentDir: dir, provider: 'soduwork', model: got.model, mcpServers: mcp };
}

module.exports = {
  prepare, fetchModel, fetchSelection, writeModels, writeMcpServers, noProxyFor, agentDir, configuredModel,
  warmupGateway,
  _resetWarmup: () => { _lastWarmupAt = 0; },
  ENV_KEY, ENV_MCP_KEY, ENV_AGENT_DIR, DEFAULT_CTX,
  _modelCache, _modelPending,
  invalidate, generation: () => configGeneration,
};
