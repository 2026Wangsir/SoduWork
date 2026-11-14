'use strict';

// This entrypoint is loaded only in a utility process (or an isolated Node
// process in tests). Never import the SDK from the desktop host.
const path = require('node:path');
const { createRpcPeer } = require('./process-rpc');
const { createPublisher } = require('./process-projection');
const { redact } = require('./process-grants');
const context = require('./process-context');
const parent = process.parentPort;
if (!parent && typeof process.send !== 'function') throw Error('Runtime must be started by its host');

let app, engine, heartbeat, shuttingDown = false, powerEpoch = -1;
const sessions = new Map(), publishers = new Map(), native = new WeakMap(), identities = new WeakMap();
const METHODS = new Set(['submit', 'continueGoal', 'pauseGoal', 'disableGoal', 'cancel', 'cancelQueued', 'updateQueue',
  'setAccessPolicy', 'selectModel', 'setThinkingMode', 'bindTask', 'answerUi', 'toolDetail', 'snapshot',
  'outputSnapshotAsync', 'outputs', 'outputSnapshot', 'appendTaskMessage', 'appendTaskTool',
  'appendTaskRuntimeEvent', 'appendTaskBatch', 'rememberWorkflowPlugin',
  'taskExecutionChanged', 'pluginDebugChanged', 'claimInterruptedTask', 'releaseInterruptedTask', 'close']);
const MODULE_METHODS = new Set(['history', 'archivedHistory', 'historyEntry', 'archiveHistory', 'restoreHistory',
  'permanentlyDeleteHistory', 'loadSdk', 'prewarm', 'prewarmResources', 'probe']);
function session(ref) {
  const handle = sessions.get(ref); if (!handle) throw Error('会话已经关闭，请重新打开'); return handle;
}
function projection(ref, event) { return publishers.get(ref)?.capture(event); }
function publish(ref, event) {
  const value = projection(ref, event); if (value) peer.notify('projection', [value]);
}
function register(handle) {
  if (!sessions.has(handle.ref)) {
    sessions.set(handle.ref, handle); native.set(handle, handle.ref);
    const publisher = createPublisher(handle, packet => peer.notify('projection', [packet]));
    publishers.set(handle.ref, publisher);
    handle.on((event, raw) => publisher.publish({ ...require('../pi-session/event-publication').fields(event, true, raw),
      ...(event?.queueId ? { queueId: String(event.queueId) } : {}) }, raw));
  }
  return handle;
}
function getEngine() { return engine || (engine = require('../pi-session/session')); }
function application(data) {
  return Object.freeze({ isPackaged: data.isPackaged,
    getPath(name) { if (!data.paths[name]) throw Error('Runtime path is unavailable: ' + name); return data.paths[name]; },
    getAppPath: () => data.appPath, getVersion: () => data.version, getLocale: () => data.locale,
    getName: () => 'SoduWork' });
}
async function bodyData(body) {
  if (!(body instanceof FormData)) return body;
  const parts = [];
  for (const [name, value] of body) parts.push(typeof value === 'string' ? { name, value } :
    { name, value: new Uint8Array(await value.arrayBuffer()), type: value.type, file: value.name || 'file' });
  return { kind: 'soduwork.multipart', parts };
}
function applyHostPowerState(state) {
  const epoch = state?.epoch;
  if (!Number.isSafeInteger(epoch) || epoch < 0 || epoch <= powerEpoch) return false;
  powerEpoch = epoch;
  if (state.suspended === true) peer.pauseTimeouts();
  else peer.resumeTimeouts();
  return true;
}
const peer = createRpcPeer({
  send: packet => parent ? parent.postMessage(packet) : process.send(packet),
  callbackTimeoutMs: 0,
  limits: { bytes: 128 * 1024 * 1024, nodes: 200000 },
  encodeSpecial(value) {
    if (value === app) return { tag: 'soduwork.app', data: null };
    if (value && native.has(value)) {
      const ref = native.get(value);
      return { tag: 'soduwork.session', data: { ref, projection: projection(ref) } };
    }
    if (value && identities.has(value)) return { tag: 'soduwork.identity', data: { id: identities.get(value) } };
    return undefined;
  },
  decodeSpecial(tag, data) {
    if (tag === 'soduwork.app') return app;
    if (tag === 'soduwork.identity') { const { id, ...value } = data; identities.set(value, id); return value; }
    if (tag === 'soduwork.session') return session(data.ref);
    if (tag === 'soduwork.grant') return { ...data.value, redact: text => redact(text, data.rules),
      cleanup: () => peer.notify('releaseGrant', [data.id]) };
    throw Error('Unknown host capability');
  },
  handlers: {
    initialize(data, _generation, powerState) {
      if (app) throw Error('Runtime is already initialized');
      applyHostPowerState(powerState);
      app = application(data);
      if (data.resourcesPath && !process.resourcesPath) Object.defineProperty(process, 'resourcesPath', { value: data.resourcesPath });
      require('../native-locale.cjs').setLocale(data.locale);
      context.install({ resourcesPath: data.resourcesPath,
        deviceAuth: { ensureSession: (_, identity) => peer.call('ensureSession', [identities.get(identity)]) },
        ensureSession: (_, identity) => peer.call('ensureSession', [identities.get(identity)]),
        // Resolve desktop-owned model credentials through the trusted host. The
        // renderer never receives this value and the runtime does not read the
        // encrypted store directly because safeStorage is host-only.
        localModel: modelRef => peer.call('localModel', [String(modelRef || '')]),
        localAgentModel: (identity, agentId) => {
          const id = identities.get(identity); if (!id) throw Error('执行请求没有可信的会话身份');
          return peer.call('localAgentModel', [id, String(agentId || '')]);
        },
        prepareLocalModels: () => peer.call('prepareLocalModels', []),
        async authFetch(identity, url, options = {}) {
          const id = identities.get(identity); if (!id) throw Error('执行请求没有可信的会话身份');
          const { signal, headers, body, ...rest } = options;
          const value = await peer.call('authRequest', [id, String(url), { ...rest,
            headers: [...new Headers(headers || {})], body: await bodyData(body) }], { signal, timeoutMs: 125000 });
          return new Response(value.body.length ? value.body : null, {
            status: value.status, statusText: value.statusText, headers: value.headers });
        },
        async synchronize(handle) {
          if (native.has(handle)) await peer.call('barrier', [handle.ref, projection(handle.ref)], { timeoutMs: 10000 });
        },
      });
      heartbeat = setInterval(() => peer.notify('heartbeat', []), 1000); heartbeat.unref?.();
      return { pid: process.pid, node: process.versions.node };
    },
    hostPowerState(state) { return applyHostPowerState(state); },
    health() { return true; },
    async open(options) {
      if (shuttingDown) throw Error('Runtime is closing');
      const result = await getEngine().open(options);
      if (result.ok) register(result.session);
      return result;
    },
    async module(method, args) {
      if (!MODULE_METHODS.has(method)) throw Error('Runtime operation is unavailable');
      const result = await getEngine()[method](...args);
      if (method === 'loadSdk') return { ok: result.ok, reason: result.reason, entry: result.entry };
      if (method === 'prewarm') return { ok: result.ok, sdk: { ok: result.sdk?.ok, reason: result.sdk?.reason },
        model: result.model?.ok ? { ok: true } : result.model };
      return result;
    },
    async session(ref, method, args) {
      if (!METHODS.has(method)) throw Error('Session operation is unavailable');
      const handle = session(ref);
      const result = method === 'appendTaskBatch'
        ? await require('../conversation/task-output-batch.cjs').apply(handle, args[0])
        : await handle[method](...args);
      publish(ref);
      if (result?.completion?.then) result.completion = Promise.resolve(result.completion).then(
        value => { publish(ref); return value; }, error => { publish(ref); throw error; });
      if (method === 'close') { sessions.delete(ref); publishers.delete(ref); }
      return result;
    },
    property(ref, name, value) {
      if (name !== 'captureDelivery') throw Error('Session property is not writable');
      const handle = session(ref);
      handle.captureDelivery = typeof value === 'function' ? async (...args) => {
        await context.current().synchronize(handle); return value(...args);
      } : undefined;
      return true;
    },
    locale(value) { require('../native-locale.cjs').setLocale(value); },
    invalidateModels() { require('../pi-session/model-config').invalidate(); },
    storage(method, args) {
      if (!['plan', 'commit', 'abandon'].includes(method)) throw Error('Archive operation is unavailable');
      return require('./process-storage')[method](app, ...args);
    },
    async prepareSkills(request) {
      if (shuttingDown) throw Error('Runtime is closing');
      const skills = require('../pi-session/skill-turn'), selected = skills.names(request?.names);
      if (!path.isAbsolute(request?.cwd || '') || !Array.isArray(request.items) || request.items.length !== selected.length ||
          request.items.some((row, index) => row?.name !== selected[index] || !path.isAbsolute(row?.path || '')))
        throw Error('所选技能的可信资源路径无效');
      const loaded = await getEngine().loadSdk(app);
      if (!loaded.ok) return skills.failure(Error(loaded.reason));
      const prepared = await skills.prepare({ cwd: request.cwd, resolveSkills: async () => ({ items: request.items }) },
        { skills: selected }, loaded.sdk);
      const { readScope, ...result } = prepared;
      return result;
    },
    async shutdown() {
      shuttingDown = true; clearInterval(heartbeat);
      for (const handle of sessions.values()) { try { await handle.close(); } catch (_) {} }
      sessions.clear(); publishers.clear(); return true;
    },
  },
});
const receive = packet => { try { peer.receive(packet); } catch (_) { process.exitCode = 1; void shutdown(); } };
if (parent) parent.on('message', event => receive(event.data));
else process.on('message', receive);
async function shutdown() {
  clearInterval(heartbeat);
  try { engine?.closeAll(); } finally { peer.close(); process.exit(); }
}
if (parent) parent.on('close', () => void shutdown());
else process.on('disconnect', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
