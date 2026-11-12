'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const { createRpcPeer } = require('./process-rpc');
const { createHostAuth } = require('./process-auth');
const { createProcessHandle } = require('./process-handle');
const { createProcessTreeGuard } = require('./process-tree');
const { REDACTIONS } = require('./process-grants');

const PATHS = ['userData', 'appData', 'sessionData', 'temp', 'home', 'exe', 'documents', 'downloads', 'desktop', 'logs'];
function appData(app) {
  const paths = {};
  for (const key of PATHS) { try { paths[key] = app.getPath(key); } catch (_) {} }
  return { paths, isPackaged: Boolean(app.isPackaged), resourcesPath: process.resourcesPath || '',
    appPath: app.getAppPath?.() || path.resolve(__dirname, '../..'),
    version: app.getVersion?.() || require('../../package.json').version,
    locale: require('../native-locale.cjs').getLocale() };
}
function environment() {
  const result = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(?:PATH|PATHEXT|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|PROGRAMDATA|PROGRAMFILES(?:\(X86\))?|SYSTEMROOT|WINDIR|COMSPEC|SHELL|TMP|TEMP|TMPDIR|LANG|LC_.*|TZ|USER|USERNAME|LOGNAME|XDG_.*|DISPLAY|WAYLAND_DISPLAY|DBUS_SESSION_BUS_ADDRESS|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|SODUWORK_DESKTOP_CONTROL_ENDPOINT|SODUWORK_OPEN_TIMING)$/i.test(key)) result[key] = value;
  }
  if (process.env.SODUWORK_RUNTIME_MANAGED === '1') {
    for (const key of ['SODUWORK_RUNTIME_MANAGED', 'SODUWORK_MANAGED_PYTHON', 'SODUWORK_OFFICE_PYTHON',
      'PYTHONNOUSERSITE', 'PYTHONDONTWRITEBYTECODE']) {
      if (process.env[key]) result[key] = process.env[key];
    }
  }
  return result;
}
function toFormBody(body) {
  if (!body || body.kind !== 'soduwork.multipart') return body;
  const form = new FormData();
  for (const part of body.parts) {
    if (part.file) form.append(part.name, new Blob([part.value], { type: part.type }), part.file);
    else form.append(part.name, String(part.value));
  }
  return form;
}

function createProcessHost(app, options = {}) {
  const generation = crypto.randomUUID();
  const handles = new Map(), native = new WeakMap(), identities = new WeakMap(), auths = new Map(), leases = new Map();
  const authKeys = new Map(), capabilities = new Set(), sessionCapabilities = new Map(), propertyCapabilities = new Map();
  const runningCallbacks = new Set();
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const stallTimeoutMs = Math.max(1, Number(options.stallTimeoutMs) || 45000);
  const defaultWatchdogIntervalMs = Math.min(3000, Math.max(1, Math.floor(stallTimeoutMs / 3)));
  const watchdogIntervalMs = Math.max(1, Number(options.watchdogIntervalMs) || defaultWatchdogIntervalMs);
  const resumeGapMs = Math.max(watchdogIntervalMs * 2,
    Number(options.resumeGapMs) || Math.min(stallTimeoutMs, watchdogIntervalMs * 4));
  const stallProbeTimeoutMs = Math.max(1, Number(options.stallProbeTimeoutMs) || 5000);
  const watchdogSetInterval = options.watchdogSetInterval || setInterval;
  const watchdogClearInterval = options.watchdogClearInterval || clearInterval;
  const powerMonitor = options.powerMonitor;
  let child = null, peer = null, ready = null, dead = false, stopping = null, guard = null, heartbeat = null;
  let watchdogProbe = null, powerSuspended = false, powerEpoch = 0, powerListenersInstalled = false;
  let cleanupPromise = null, cleanupPending = false, cleanupError = null;
  let startupSettled = null;
  let lastHeartbeat = now(), lastWatchdogTick = now(), initialized = false;
  const fail = message => Object.assign(Error(message), { code: 'RUNTIME_PROCESS_GONE' });
  function resetHeartbeatWindow() { lastHeartbeat = lastWatchdogTick = now(); }
  function onSuspend() {
    powerSuspended = true;
    powerEpoch++;
    peer?.pauseTimeouts();
    try { peer?.notify('hostPowerState', [{ suspended: true, epoch: powerEpoch }]); }
    catch (error) { options.onError?.(error); }
    resetHeartbeatWindow();
  }
  function onResume() {
    powerSuspended = false;
    powerEpoch++;
    resetHeartbeatWindow();
    try { peer?.notify('hostPowerState', [{ suspended: false, epoch: powerEpoch }]); }
    catch (error) { options.onError?.(error); }
    peer?.resumeTimeouts();
  }
  function installPowerListeners() {
    if (powerListenersInstalled || typeof powerMonitor?.on !== 'function') return;
    powerMonitor.on('suspend', onSuspend); powerMonitor.on('resume', onResume);
    powerListenersInstalled = true;
  }
  function removePowerListeners() {
    if (!powerListenersInstalled) return;
    powerMonitor.removeListener?.('suspend', onSuspend); powerMonitor.removeListener?.('resume', onResume);
    powerListenersInstalled = false;
  }
  function row(ref) {
    if (!handles.has(ref)) {
      const value = createProcessHandle({ ref,
        confirmStopped: () => dead && !cleanupPending && !cleanupError,
        invoke: (id, method, args, config) => call('session', [id, method, args], config),
        setProperty: (id, property, value) => call('property', [id, property, value]),
        onClose: () => {
          handles.delete(ref);
          for (const value of sessionCapabilities.get(ref) || []) releaseCapabilities(value);
          sessionCapabilities.delete(ref);
          for (const [key, value] of propertyCapabilities) if (key.startsWith(ref + ':')) {
            releaseCapabilities(value); propertyCapabilities.delete(key);
          }
        } });
      handles.set(ref, value); native.set(value.handle, ref);
    }
    return handles.get(ref);
  }
  function authFor(identity) {
    let id = identities.get(identity);
    if (!id) {
      const key = crypto.createHash('sha256').update(String(identity.hub) + '\n' + String(identity.clientId) + '\n' +
        String(identity.secret || identity.session || '')).digest('hex');
      id = authKeys.get(key);
      if (id) { identities.set(identity, id); return { id, ...auths.get(id).publicIdentity() }; }
      id = crypto.randomUUID();
      const auth = (options.authFactory || createHostAuth)({ app, identity,
        ...(options.identityOf ? { identityOf: options.identityOf } : {}) });
      auths.set(id, auth); identities.set(identity, id); authKeys.set(key, id);
    }
    return { id, ...auths.get(id).publicIdentity() };
  }
  function encodeSpecial(value) {
    if (value === app) return { tag: 'soduwork.app', data: appData(app) };
    if (value && native.has(value)) return { tag: 'soduwork.session', data: { ref: native.get(value) } };
    if (value && typeof value === 'object' && value.hub && value.clientId && ('session' in value || 'secret' in value))
      return { tag: 'soduwork.identity', data: authFor(value) };
    if (value && typeof value === 'object' && value[REDACTIONS]) {
      const id = crypto.randomUUID(); leases.set(id, value);
      const data = Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'redact' && key !== 'cleanup'));
      return { tag: 'soduwork.grant', data: { id, value: data, rules: value[REDACTIONS] } };
    }
    return undefined;
  }
  function releaseCapabilities(owned) {
    if (!owned || !capabilities.delete(owned)) return;
    for (const fn of owned) peer?.release(fn);
    owned.clear();
  }
  function releaseIncoming(values) {
    const seen = new WeakSet();
    function visit(value) {
      if (typeof value === 'function') { peer?.release(value); return; }
      if (!value || typeof value !== 'object' || seen.has(value) || value === app || native.has(value) ||
          ![Object.prototype, null, Array.prototype].includes(Object.getPrototypeOf(value))) return;
      seen.add(value); for (const item of Object.values(value)) visit(item);
    }
    visit(values);
  }
  function prepareCapabilities(args) {
    const owned = new Set(), seen = new WeakMap(); capabilities.add(owned);
    function visit(value, owner) {
      if (typeof value === 'function') {
        if (seen.has(value)) return seen.get(value);
        const wrapped = (...args) => {
          let result;
          try { result = value.apply(owner, args); }
          catch (error) { releaseIncoming(args); throw error; }
          if (!result?.then) { releaseIncoming(args); return result; }
          const token = {}; runningCallbacks.add(token);
          return Promise.resolve(result).finally(() => { runningCallbacks.delete(token); releaseIncoming(args); });
        };
        seen.set(value, wrapped); owned.add(wrapped); return wrapped;
      }
      if (!value || typeof value !== 'object' || value === app || native.has(value) || value[REDACTIONS] ||
          (value.hub && value.clientId && ('secret' in value || 'session' in value)) ||
          ![Object.prototype, null, Array.prototype].includes(Object.getPrototypeOf(value))) return value;
      if (seen.has(value)) return seen.get(value);
      const copy = Array.isArray(value) ? [] : {}; seen.set(value, copy);
      for (const [key, item] of Object.entries(value)) Object.defineProperty(copy, key,
        { value: visit(item, value), enumerable: true, writable: true, configurable: true });
      return copy;
    }
    return { args: visit(args), owned };
  }
  function decodeSpecial(tag, data) {
    if (tag === 'soduwork.session') {
      const value = row(data.ref); if (data.projection) value.update(data.projection); return value.handle;
    }
    if (tag === 'soduwork.identity') {
      const auth = auths.get(data.id); if (!auth) throw Error('Runtime identity is unavailable');
      return auth.publicIdentity();
    }
    throw Error('Unknown runtime data type');
  }
  function releaseLeases() {
    for (const value of leases.values()) { try { value.cleanup?.(); } catch (_) {} }
    leases.clear();
  }
  function cleanResources() {
    if (cleanupPromise && (cleanupPending || !cleanupError)) return cleanupPromise;
    cleanupPending = true;
    cleanupError = null;
    let timer;
    const work = Promise.resolve().then(async () => {
      // spawn and the first identity snapshot can complete after stop(). Do
      // not certify an empty cleanup while either may still produce a child.
      if (startupSettled) await startupSettled;
      if (guard) await guard.stop();
      else if (child?.pid) child.kill();
    }).then(() => { cleanupPending = false; cleanupError = null; }, error => {
      cleanupError = error; cleanupPending = false; throw error;
    });
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => {
      const error = Object.assign(Error('执行资源回收超过等待时间，仍需确认回收结果'), { code: 'RUNTIME_CLEANUP_TIMEOUT' });
      cleanupError = error; reject(error);
    }, options.cleanupTimeoutMs || 15000); });
    cleanupPromise = Promise.race([work, deadline]).finally(() => clearTimeout(timer));
    cleanupPromise.catch(error => options.onError?.(error));
    return cleanupPromise;
  }
  function gone(error) {
    if (dead) return;
    dead = true; watchdogClearInterval(heartbeat); removePowerListeners();
    const reason = error instanceof Error ? error : fail('执行服务已退出');
    peer?.close(reason);
    for (const value of handles.values()) value.interrupted(reason);
    for (const auth of auths.values()) auth.close();
    auths.clear(); authKeys.clear(); releaseLeases();
    for (const owned of [...capabilities]) releaseCapabilities(owned);
    void cleanResources();
  }
  async function start() {
    if (dead || stopping) throw fail('执行服务已退出，请重新打开会话');
    if (ready) return ready;
    installPowerListeners();
    let settleStartup;
    startupSettled = new Promise(resolve => { settleStartup = resolve; });
    const assertLive = () => { if (dead || stopping) throw fail('执行服务已退出，请重新打开会话'); };
    ready = (async () => {
      const entry = path.join(__dirname, 'process-worker.js');
      if (options.spawn) child = await options.spawn(entry, { env: environment() });
      else if (process.versions.electron) {
        const { app: electronApp, utilityProcess } = require('electron');
        await electronApp.whenReady();
        assertLive();
        child = utilityProcess.fork(entry, [], { env: environment(), stdio: 'pipe', serviceName: 'SoduWork Agent Runtime' });
      } else {
        child = require('node:child_process').fork(entry, [], { env: environment(), serialization: 'advanced', execArgv: [],
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      }
      child.stdout?.on('data', () => {}); child.stderr?.on('data', () => {});
      child.once('exit', (code, signal) => gone(fail('执行服务已退出（' + String(signal || code) + '）')));
      child.on('error', error => gone(error));
      if (child.exitCode != null || child.signalCode != null) throw fail('执行服务启动期间已退出');
      if (!child.pid) await new Promise((resolve, reject) => {
        child.once('spawn', resolve); child.once('exit', () => reject(fail('执行服务启动失败'))); child.once('error', reject);
      });
      // A late child still needs its actual identity recorded and reclaimed.
      // Check closure after ownership registration, before creating any RPC
      // channel or importing/initializing execution code in that child.
      guard = (options.treeFactory || createProcessTreeGuard)({ pid: child.pid, intervalMs: process.platform === 'win32' ? 1500 : 500 });
      const ownership = await guard.start();
      if (!ownership?.rootFound) throw Object.assign(fail('执行服务的进程身份尚未确认，请重新打开会话'),
        { code: 'RUNTIME_PROCESS_IDENTITY_UNAVAILABLE' });
      assertLive();
      const handlers = {
        projection(packet) { if (!dead) { try { row(packet.ref).update(packet); } catch (error) { gone(error); void stop(error); } } },
        heartbeat() { lastHeartbeat = now(); },
        async ensureSession(id) {
          const auth = auths.get(id); if (!auth) throw Error('执行身份已失效'); return auth.ensureSession();
        },
        async localModel(modelRef) {
          return require('../local-model-store.cjs').resolve(String(modelRef || ''));
        },
        async prepareLocalModels() {
          require('../local-model-privacy.cjs').ensure(app);
          return true;
        },
        async authRequest(id, url, init) {
          const auth = auths.get(id); if (!auth) throw Error('执行身份已失效');
          return auth.request(url, { ...init, body: toFormBody(init.body), signal: this.signal });
        },
        releaseGrant(id) { const grant = leases.get(id); leases.delete(id); grant?.cleanup?.(); },
        async barrier(ref, packet) { try { row(ref).update(packet); return true; } catch (error) { gone(error); void stop(error); throw error; } },
      };
      peer = createRpcPeer({ send: packet => child.postMessage ? child.postMessage(packet) : child.send(packet),
        handlers, encodeSpecial, decodeSpecial, callbackTimeoutMs: 0, limits: { bytes: 128 * 1024 * 1024, nodes: 200000 },
        onError: error => options.onError?.(error) });
      if (powerSuspended) peer.pauseTimeouts();
      child.on('message', packet => { try { peer.receive(packet); } catch (error) { gone(error); } });
      await peer.call('initialize', [appData(app), generation,
        { suspended: powerSuspended, epoch: powerEpoch }], { timeoutMs: options.initializeTimeoutMs || 15000 });
      assertLive();
      initialized = true; resetHeartbeatWindow();
      heartbeat = watchdogSetInterval(() => {
        const sampledAt = now(), tickGap = sampledAt - lastWatchdogTick;
        lastWatchdogTick = sampledAt;
        if (dead || stopping) return;
        if (powerSuspended) { lastHeartbeat = sampledAt; return; }
        // Suspend, Connected Standby and a blocked main loop all delay this
        // timer together with worker heartbeats. Give the resumed worker a
        // complete heartbeat window instead of treating wall-clock sleep as
        // proof that the isolated runtime is hung.
        if (tickGap > resumeGapMs) { lastHeartbeat = sampledAt; return; }
        if (sampledAt - lastHeartbeat <= stallTimeoutMs || watchdogProbe) return;
        // A heartbeat can be delayed behind other IPC after resume or load.
        // Confirm that the worker event loop is actually unavailable before
        // interrupting sessions whose tool outcome may still be uncertain.
        watchdogProbe = peer.call('health', [], { timeoutMs: stallProbeTimeoutMs }).then(
          () => { lastHeartbeat = now(); },
          () => {
            const sampledAfterProbe = now();
            // The host can suspend while this probe is pending. Its timeout
            // uses the same wall clock, so re-check host continuity here too;
            // the watchdog interval and this rejection can run in either order
            // after resume.
            if (powerSuspended || sampledAfterProbe - lastWatchdogTick > resumeGapMs) {
              lastHeartbeat = lastWatchdogTick = sampledAfterProbe;
              return;
            }
            if (!dead && !stopping && sampledAfterProbe - lastHeartbeat > stallTimeoutMs)
              return stop(fail('会话执行长时间没有响应，已停止执行服务'));
          }).finally(() => { watchdogProbe = null; });
        watchdogProbe.catch(() => {});
      }, watchdogIntervalMs);
      heartbeat.unref?.();
      return peer;
    })().finally(settleStartup).catch(error => { gone(error); throw error; });
    ready.catch(() => {}); return ready;
  }
  async function call(method, args = [], config) {
    const channel = await start();
    if (dead || stopping) throw fail('会话执行已中断，请重新打开会话');
    const prepared = prepareCapabilities(args);
    try {
      const result = await channel.call(method, prepared.args, config);
      if (method === 'open' && result?.ok && result.session?.ref) {
        const ref = result.session.ref;
        if (!sessionCapabilities.has(ref)) sessionCapabilities.set(ref, new Set());
        sessionCapabilities.get(ref).add(prepared.owned);
      } else if (method === 'property') {
        const key = args[0] + ':' + args[1];
        releaseCapabilities(propertyCapabilities.get(key)); propertyCapabilities.set(key, prepared.owned);
      } else if (result?.completion?.then) {
        Promise.resolve(result.completion).finally(() => releaseCapabilities(prepared.owned)).catch(() => {});
      } else releaseCapabilities(prepared.owned);
      return result;
    }
    catch (error) {
      releaseCapabilities(prepared.owned);
      if (error.code === 'RPC_TIMEOUT' && error.remote !== true && method !== 'history') await stop(error);
      throw error;
    }
  }
  async function stop(reason) {
    if (stopping) {
      // A deadline does not stop the cleanup operation. Retry only after an
      // actual failure has settled, so concurrent recovery cannot overlap it.
      if (!cleanupPending && cleanupError) {
        stopping = cleanResources();
        stopping.catch(() => {});
      }
      return stopping;
    }
    stopping = (async () => {
      if (!cleanupPromise) cleanupPending = true;
      watchdogClearInterval(heartbeat);
      if (!dead && initialized) {
        try { await peer.call('shutdown', [], { timeoutMs: 2000 }); } catch (_) {}
      }
      gone(reason || fail('会话执行服务已关闭'));
      await cleanResources();
      for (const owned of [...capabilities]) releaseCapabilities(owned);
    })();
    stopping.catch(() => {}); return stopping;
  }
  function retryCleanup() {
    if (!dead) return stop();
    // Only a settled failure can be retried. A deadline may have rejected
    // while startup or tree cleanup is still running; keep that fence intact.
    if (cleanupError && !cleanupPending) cleanupPromise = null;
    return cleanResources();
  }
  return { call, start, stop, retryCleanup, isDead: () => dead, handles,
    maintenanceWorkloads: () => cleanupPending || cleanupError || (dead && runningCallbacks.size) ? [{
      ref: 'runtime-cleanup:' + generation, kind: 'runtime-cleanup', canStop: false,
      status: cleanupError ? 'cleanup-failed' : 'cleaning',
      reason: cleanupError ? '执行资源回收尚未确认，请完成检查后再更新'
        : runningCallbacks.size ? '正在等待已接受操作的收尾回执' : '正在回收会话执行资源',
    }] : [],
    diagnostics: () => ({ pid: child?.pid || null, generation,
      transport: process.versions.electron ? 'utilityProcess' : 'node-fork', initialized, dead,
      capabilities: capabilities.size, auths: auths.size, leases: leases.size, rpc: peer?.stats() }),
    notify(method, args) { if (peer && !dead) peer.notify(method, args); } };
}
module.exports = { createProcessHost, appData, environment };
