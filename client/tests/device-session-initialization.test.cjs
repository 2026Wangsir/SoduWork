'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('./renderer-source.cjs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '../api.js'), 'utf8');
const flush = async () => { for (let i = 0; i < 80; i++) await Promise.resolve(); };
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function identity(user = 'alice') {
  return { ok: true, stored: true, clientId: 'fixture-install', user: { id: user },
    session: 'fixture-session-' + user, expiresIn: 1800, activationRequired: false };
}
function fixture() {
  const values = new Map(), timers = new Map(), requests = [], calls = [], events = [];
  let now = 1000, nextTimer = 0;
  class ClockDate extends Date { static now() { return now; } }
  const bridge = {
    getAppVersion: async () => { calls.push('version'); return '1.12.52'; },
    getSysInfo: async () => { calls.push('system'); return { platform: 'fixture' }; },
    configureRunner: async () => { calls.push('runner'); return { ok: true }; },
    deviceAuthBootstrap: async () => { calls.push('bootstrap'); return identity(); },
    deviceAuthLogin: async () => identity('bob'),
    deviceAuthLogout: async () => ({ ok: true }),
    deviceAuthClearSession: async () => ({}),
  };
  const window = { __SODUWORK_TEST_HUB_CONFIG__: { allowSwitch: true }, soduWorkAPI: bridge, dispatchEvent(event) { events.push(event); } };
  const context = { window, Date: ClockDate, URL, URLSearchParams, AbortController,
    localStorage: { getItem: key => values.get(key) || '', setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) },
    User: { id: 'fixture-user' }, navigator: { platform: 'fixture' },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options?.detail; } },
    console: { log() {}, error() {} }, setInterval() {},
    setTimeout(fn, delay) { const id = ++nextTimer; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    fetch: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, status: 200, text: async () => JSON.stringify({ providers: [], usable: [], myModels: [] }) };
    },
  };
  vm.runInNewContext(source, context, { filename: 'api.js' });
  async function advance(ms) {
    now += ms;
    for (const [id, timer] of [...timers]) {
      if (timer.at <= now && timers.delete(id)) timer.fn();
    }
    await flush();
  }
  return { api: window.SoduWorkAPI, bridge, context, requests, calls, timers, events, values, advance };
}

for (const stage of ['version', 'system', 'runner-before', 'bootstrap', 'runner-after']) {
  test(`model-list authentication has a deadline at ${stage}, retries, and ignores the late IPC result`, async () => {
    const f = fixture(), gate = deferred();
    let configCalls = 0;
    const method = stage === 'version' ? 'getAppVersion' : stage === 'system' ? 'getSysInfo' : stage === 'bootstrap' ? 'deviceAuthBootstrap' : 'configureRunner';
    const original = f.bridge[method];
    f.bridge[method] = async (...args) => {
      configCalls++;
      if (stage !== 'runner-after' || configCalls === 2) return gate.promise;
      return original(...args);
    };
    const request = f.api.myModels(), failed = assert.rejects(request, { code: 'DEVICE_AUTH_INIT_TIMEOUT' });
    await flush(); assert.equal(f.requests.length, 0);
    assert.equal(f.timers.size, 1);
    await f.advance(8000); await failed;
    assert.equal(f.requests.length, 0, 'timeout must not fall through to an unauthenticated request');
    f.bridge[method] = original;
    const result = await f.api.myModels(); assert.equal(result.providers.length, 0);
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].options.headers.Authorization, 'Device fixture-session-alice');
    const before = f.calls.length;
    gate.resolve(stage === 'bootstrap' ? identity('obsolete') : stage === 'system' ? {} : stage === 'version' ? 'old-version' : { ok: true });
    await flush();
    assert.equal(f.calls.length, before, 'the expired sequence must not run another initialization step');
    await f.api.myModels();
    assert.equal(f.requests.at(-1).options.headers.Authorization, 'Device fixture-session-alice');
  });
}

test('authentication steps share one eight-second budget rather than accumulating a timeout per step', async () => {
  const f = fixture(), version = deferred(), system = deferred();
  f.bridge.getAppVersion = () => version.promise; f.bridge.getSysInfo = () => system.promise;
  const failed = assert.rejects(f.api.registerClient(), { code: 'DEVICE_AUTH_INIT_TIMEOUT' });
  await flush(); await f.advance(3000); version.resolve('1.12.52'); await flush();
  assert.equal(f.timers.size, 1);
  await f.advance(5000); await failed;
  system.resolve({}); await flush();
  assert.deepEqual(f.calls, []); assert.equal(f.requests.length, 0);
});

test('seven concurrent readers share initialization and all can retry after the shared timeout', async () => {
  const f = fixture(), gate = deferred(); let bootstraps = 0;
  f.bridge.deviceAuthBootstrap = async () => { bootstraps++; return gate.promise; };
  const pending = Array.from({ length: 7 }, () => assert.rejects(f.api.myModels(), { code: 'DEVICE_AUTH_INIT_TIMEOUT' }));
  await flush(); assert.equal(bootstraps, 1);
  await f.advance(8000); await Promise.all(pending);
  f.bridge.deviceAuthBootstrap = async () => { bootstraps++; return identity('bob'); };
  await Promise.all(Array.from({ length: 7 }, () => f.api.myModels()));
  assert.equal(bootstraps, 2); assert.equal(f.requests.length, 7);
  assert.ok(f.requests.every(row => row.options.headers.Authorization === 'Device fixture-session-bob'));
  gate.resolve(identity('alice')); await flush();
  assert.match(f.api.taskStorageKey('ops'), /@bob$/);
});

test('switching accounts cancels old initialization; its late identity cannot replace the successful login', async () => {
  const f = fixture(), gate = deferred();
  f.bridge.deviceAuthBootstrap = () => gate.promise;
  const canceled = assert.rejects(f.api.myModels(), { code: 'STALE_TASK_SCOPE' });
  await flush(); await f.api.clientLogin({ account: 'fixture-bob', password: 'fixture-only' }); await canceled;
  gate.resolve(identity('alice')); await flush();
  assert.match(f.api.taskStorageKey('ops'), /@bob$/);
  await f.api.myModels();
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].options.headers.Authorization, 'Device fixture-session-bob');
});

test('initialization started during login is invalidated when the new identity is adopted', async () => {
  const f = fixture(), login = deferred(), bootstrap = deferred();
  f.bridge.deviceAuthLogin = () => login.promise; f.bridge.deviceAuthBootstrap = () => bootstrap.promise;
  const signingIn = f.api.clientLogin({ account: 'fixture-bob' }); await flush();
  const canceled = assert.rejects(f.api.myModels(), { code: 'STALE_TASK_SCOPE' }); await flush();
  login.resolve(identity('bob')); await signingIn; await canceled;
  bootstrap.resolve(identity('alice')); await flush();
  await f.api.myModels();
  assert.equal(f.requests.at(-1).options.headers.Authorization, 'Device fixture-session-bob');
});

test('logout invalidates a pending bootstrap and a late answer cannot restore a logged-out account', async () => {
  const f = fixture(), gate = deferred();
  f.bridge.deviceAuthBootstrap = () => gate.promise;
  const canceled = assert.rejects(f.api.myModels(), { code: 'STALE_TASK_SCOPE' }); await flush();
  await f.api.clientLogout(); await canceled;
  gate.resolve(identity('alice')); await flush();
  assert.match(f.api.taskStorageKey('ops'), /@unbound$/);
  // This is a new bootstrap after logout, not the late, already-consumed IPC.
  // The main process now refuses renewal because the identity was logged out.
  f.bridge.deviceAuthBootstrap = async () => ({ ok: false, stored: true, status: 401, error: 'login required' });
  f.context.fetch = async (url, options) => {
    assert.equal(options.headers.Authorization, undefined);
    return { ok: false, status: 401, text: async () => '{"detail":"login required"}' };
  };
  await assert.rejects(f.api.myModels(), { status: 401 });
  assert.match(f.api.taskStorageKey('ops'), /@unbound$/);
});

test('a late rejected IPC is consumed without invalidating the successful retry', async () => {
  const f = fixture(), old = deferred();
  f.bridge.deviceAuthBootstrap = () => old.promise;
  const failed = assert.rejects(f.api.myModels(), { code: 'DEVICE_AUTH_INIT_TIMEOUT' });
  await flush(); await f.advance(8000); await failed;
  f.bridge.deviceAuthBootstrap = async () => identity('bob');
  await f.api.myModels();
  old.reject(new Error('old IPC closed')); await flush();
  await f.api.myModels();
  assert.ok(f.requests.every(row => row.options.headers.Authorization === 'Device fixture-session-bob'));
});

test('a canceled refresh cannot erase the new Hub refresh slot or send its original read to the new Hub', async () => {
  const f = fixture(), old = deferred(), current = deferred(); let bootstraps = 0;
  f.bridge.deviceAuthBootstrap = () => ++bootstraps === 1 ? old.promise : current.promise;
  const canceled = assert.rejects(f.api.myModels(), { code: 'STALE_TASK_SCOPE' }); await flush();
  f.api.setHubEnvironment('development', 'http://127.0.0.1:9876');
  const second = f.api.myModels();
  await canceled; await flush();
  const third = f.api.myModels(); await flush();
  assert.equal(bootstraps, 2, 'old finally must not clear the new pending refresh');
  old.resolve(identity('alice')); await flush(); assert.equal(f.requests.length, 0);
  current.resolve(identity('bob')); await Promise.all([second, third]);
  assert.equal(f.requests.length, 2);
  assert.ok(f.requests.every(row => row.url.startsWith('http://127.0.0.1:9876/') && row.options.headers.Authorization === 'Device fixture-session-bob'));
});

test('a Hub switch before the refresh microtask starts prevents that obsolete initialization from starting', async () => {
  const f = fixture();
  const canceled = assert.rejects(f.api.myModels(), { code: 'STALE_TASK_SCOPE' });
  f.api.setHubEnvironment('development', 'http://127.0.0.1:9876');
  await canceled;
  assert.deepEqual(f.calls, []); assert.deepEqual(f.requests, []);
  await f.api.myModels(); assert.equal(f.requests.length, 1);
});

for (const method of ['myModels', 'saveMyModels', 'testMyModel', 'checkMyModelCapabilities']) {
  test(`${method} retains its Hub scope while local ownership is being read`, async () => {
    const f = fixture(), catalog = deferred();
    f.bridge.localModels = { get: () => catalog.promise };
    const input = method === 'testMyModel' ? 'managed-provider' : {
      providerId: 'managed-provider', keys: { 'managed-provider': 'fixture-key' },
    };
    const canceled = assert.rejects(f.api[method](input), { code: 'STALE_TASK_SCOPE' });
    f.api.setHubEnvironment('development', 'http://127.0.0.1:9876');
    catalog.resolve({ providers: [], myModels: [], revision: 1 });
    await canceled;
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.requests, []);
  });
}

test('a Hub switch during a local save prevents its managed portion from reaching the new Hub', async () => {
  const f = fixture(), saved = deferred();
  f.bridge.localModels = { get: async () => ({ providers: [], myModels: [], revision: 1 }),
    save: () => saved.promise };
  const canceled = assert.rejects(f.api.saveMyModels({ providers: [], models: [],
    expectedRevision: 'hub-revision', localProviders: [], localModels: [], localRevision: 1 }),
  { code: 'STALE_TASK_SCOPE' });
  await flush();
  f.api.setHubEnvironment('development', 'http://127.0.0.1:9876');
  saved.resolve({ ok: true });
  await canceled;
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.requests, []);
});

test('a local catalog cannot hide a stale Hub domain read', async () => {
  const f = fixture(), result = deferred();
  await f.api.registerClient();
  f.bridge.localModels = { get: async () => ({ providers: [{ id: 'local-fixture', localOnly: true }], myModels: [] }) };
  f.bridge.clientDomainRead = () => result.promise;
  const canceled = assert.rejects(f.api.myModels(), { code: 'STALE_TASK_SCOPE' });
  await flush();
  f.api.setHubEnvironment('development', 'http://127.0.0.1:9876');
  result.resolve({ ok: true, value: { providers: [] } });
  await canceled;
  assert.deepEqual(f.requests, []);
});

test('401 renewal has the same bounded failure and the next explicit attempt can recover', async () => {
  const f = fixture(); await f.api.registerClient();
  const gate = deferred(); f.bridge.deviceAuthBootstrap = () => gate.promise;
  let count = 0;
  f.context.fetch = async () => ++count === 1 ? { ok: false, status: 401, text: async () => '{"detail":"expired session"}' }
    : { ok: true, status: 200, text: async () => '{"providers":[],"usable":[],"myModels":[]}' };
  const failed = assert.rejects(f.api.myModels(), { code: 'DEVICE_AUTH_INIT_TIMEOUT' });
  await flush(); await f.advance(8000); await failed;
  assert.equal(count, 1);
  f.bridge.deviceAuthBootstrap = async () => identity();
  await f.api.myModels(); assert.equal(count, 2);
});

test('secure Hub restoration shares the initialization deadline and ignores a late saved profile', async () => {
  const f = fixture(), status = deferred(), bootstrap = deferred();
  f.bridge.deviceAuthStatus = () => status.promise;
  f.bridge.deviceAuthBootstrap = () => bootstrap.promise;
  const failed = assert.rejects(f.api.myModels(), { code: 'DEVICE_AUTH_INIT_TIMEOUT' });
  await flush(); await f.advance(3000);
  status.resolve({ ready: true, hub: 'https://saved.example.com' }); await flush();
  await f.advance(5000); await failed;
  assert.equal(f.requests.length, 0);
  const late = fixture(), previous = deferred();
  late.bridge.deviceAuthStatus = () => previous.promise;
  const expired = assert.rejects(late.api.registerClient(), { code: 'DEVICE_AUTH_INIT_TIMEOUT' });
  await flush(); await late.advance(8000); await expired;
  late.api.setHubEnvironment('production', 'https://chosen.example.com');
  previous.resolve({ ready: true, hub: 'https://obsolete.example.com' }); await flush();
  assert.equal(late.api.hubBase(), 'https://chosen.example.com');
  assert.equal(late.calls.length, 0);
});

test('a sibling window changing shared Hub storage cannot leak this window session into that Hub', async () => {
  const f = fixture(); await f.api.registerClient();
  f.values.set('soduwork_work_hub_connections_v2', JSON.stringify({ environment: 'production', productionHub: 'https://other.example.com' }));
  f.bridge.deviceAuthBootstrap = async () => identity('new-hub');
  await f.api.myModels();
  assert.equal(f.requests.at(-1).options.headers.Authorization, 'Device fixture-session-new-hub');
  assert.ok(f.requests.at(-1).url.startsWith('https://other.example.com/'));
});
