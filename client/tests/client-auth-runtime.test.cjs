'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('./renderer-source.cjs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(
  path.resolve(__dirname, '..', 'api.js'),
  'utf8',
);

function runtime(loginResult) {
  const requests = [];
  const values = new Map([
    ['soduwork_work_hub_environment_v1', 'production'],
    ['soduwork_work_user_id', 'client-auth-runtime'],
  ]);
  const events = [];
  let cleared = 0;
  let quotaExceeded;
  let quotaChanged, serverQuota = loginResult.quota, requestOverride;
  const localStorage = {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
  class CustomEvent {
    constructor(type, options) {
      this.type = type;
      this.detail = options && options.detail;
    }
  }
  const window = {
    soduWorkAPI: {
      onDeviceAuthQuotaExceeded(callback) { quotaExceeded = callback; },
      onDeviceAuthQuotaChanged(callback) { quotaChanged = callback; },
      async deviceAuthLogin() { return loginResult; },
      async deviceAuthClearSession() { cleared += 1; return { ok: true }; },
      async configureRunner() { return { ok: true }; },
      async getAppVersion() { return 'test'; },
      async getSysInfo() {
        return { username: 'employee', hostname: 'workstation',
          platform: 'win32', arch: 'x64' };
      },
    },
    dispatchEvent(event) { events.push(event); },
  };
  const context = {
    window,
    localStorage,
    CustomEvent,
    URL,
    AbortController,
    setTimeout,
    clearTimeout,
    console,
    fetch: async (url, options) => {
      requests.push({ url, options });
      return requestOverride ? requestOverride(url, options) : new Response(JSON.stringify({ user: loginResult.user, quota: serverQuota }));
    },
  };
  vm.runInNewContext(source, context);
  return {
    api: window.SoduWorkAPI,
    events,
    requests,
    cleared: () => cleared,
    exceed: detail => quotaExceeded(detail),
    changed: detail => quotaChanged(detail),
    quota: value => { serverQuota = value; },
    request: callback => { requestOverride = callback; },
    login: value => { loginResult = value; serverQuota = value.quota; },
  };
}

test('failed login requests the client auth gate without a scope error', async () => {
  const harness = runtime({
    ok: false,
    status: 401,
    code: 'ACCOUNT_OR_PASSWORD_INVALID',
    error: 'invalid account',
  });
  const result = await harness.api.clientLogin({
    account: 'employee',
    password: 'wrong password',
  });

  assert.equal(result.ok, false);
  assert.equal(harness.cleared(), 1);
  assert.equal(harness.events.at(-1).type, 'soduwork-client-auth-required');
  assert.equal(
    harness.events.at(-1).detail.code,
    'ACCOUNT_OR_PASSWORD_INVALID',
  );
});

test('quota exhaustion clears the short session and exposes quota state', async () => {
  const quota = { enabled: true, limit: 100, used: 100, exceeded: true };
  const harness = runtime({
    ok: false,
    status: 403,
    code: 'TOKEN_QUOTA_EXCEEDED',
    error: 'quota exhausted',
    quota,
  });
  const result = await harness.api.clientLogin({
    account: 'employee',
    password: 'password',
  });

  assert.equal(result.ok, false);
  assert.equal(harness.api.clientAuthSnapshot().state, 'quota');
  assert.equal(harness.api.clientAuthSnapshot().quota.used, 100);
  assert.equal(harness.events.at(-1).detail.state, 'quota');
});

test('successful login keeps only the short session and safe profile in renderer', async () => {
  const harness = runtime({
    ok: true,
    session: 'short-session',
    expiresIn: 1800,
    clientId: 'client-auth-runtime',
    user: { id: 'user-1', username: 'employee', displayName: 'Employee' },
    quota: { enabled: false },
  });
  const result = await harness.api.clientLogin({
    account: 'employee',
    password: 'password',
  });

  assert.equal(result.ok, true);
  assert.equal(harness.api.clientAuthSnapshot().state, 'active');
  assert.equal(harness.api.clientAuthSnapshot().user.id, 'user-1');
  assert.equal(harness.cleared(), 0);
});

test('exhaustion during an authenticated session preserves access to history', async () => {
  const harness = runtime({ ok: true, session: 'short-session', expiresIn: 1800,
    clientId: 'client-auth-runtime', user: { id: 'quota-user' }, quota: { enabled: false } });
  await harness.api.clientLogin({ account: 'employee', password: 'password' });
  harness.quota({ enabled: true, limit: 0, used: 0, exceeded: true });
  await harness.exceed({ quota: { enabled: true, limit: 0, used: 0, exceeded: true } });
  assert.equal(harness.cleared(), 0);
  assert.equal(harness.api.clientAuthSnapshot().state, 'active');
  assert.equal(harness.api.clientAuthSnapshot().quota.limit, 0);
  assert.equal(harness.events.at(-1).type, 'soduwork-device-auth');
  assert.equal(harness.events.at(-1).detail.user.id, 'quota-user');
  const count = harness.events.length;
  harness.exceed({ hub: 'http://another-local-hub', clientId: 'other-device', quota: { enabled: true, limit: 50 } });
  assert.equal(harness.events.length, count);
  assert.equal(harness.api.clientAuthSnapshot().quota.limit, 0);
});

test('successful admission refreshes restored account quota and a late denial cannot replace it', async () => {
  const old = { enabled: true, exceeded: true, limit: 100, used: 100 };
  const harness = runtime({ ok: true, session: 'short-session', expiresIn: 1800,
    clientId: 'client-auth-runtime', user: { id: 'quota-user' }, quota: old });
  await harness.api.clientLogin({ account: 'employee', password: 'password' });
  harness.quota({ ...old, exceeded: false, limit: 1000 });
  await harness.changed({ clientId: 'client-auth-runtime' });
  assert.equal(harness.api.clientAuthSnapshot().quota.exceeded, false);
  await harness.exceed({ clientId: 'client-auth-runtime', quota: old });
  assert.equal(harness.api.clientAuthSnapshot().quota.exceeded, false);
  assert.equal(harness.api.clientAuthSnapshot().quota.limit, 1000);
  assert.equal(harness.api.clientAuthSnapshot().state, 'active');
  assert.equal(harness.cleared(), 0);
});

test('personal model admission cannot mark the global platform budget restored', async () => {
  const quota = { enabled: true, exceeded: true, limit: 100, used: 100,
    quotaVersion: 2, personalModelsAllowed: true };
  const harness = runtime({ ok: true, session: 'short-session', expiresIn: 1800,
    clientId: 'client-auth-runtime', user: { id: 'quota-user' }, quota });
  await harness.api.clientLogin({ account: 'employee', password: 'password' });
  await harness.changed({ quota: { ...quota, exceeded: false }, quotaScope: 'personal' });
  assert.equal(harness.api.clientAuthSnapshot().quota.exceeded, true);
  assert.equal(harness.api.clientAuthSnapshot().quota.personalModelsAllowed, true);
  assert.equal(harness.cleared(), 0);
});

test('offline quota refresh retains the last confirmation while a real 401 still clears authentication', async () => {
  const harness = runtime({ ok: true, session: 'short-session', expiresIn: 1800,
    clientId: 'client-auth-runtime', user: { id: 'quota-user' }, quota: { enabled: true, exceeded: false } });
  await harness.api.clientLogin({ account: 'employee', password: 'password' });
  harness.request(async () => { throw Error('offline'); });
  await harness.exceed({ quota: { enabled: true, exceeded: true } });
  assert.equal(harness.api.clientAuthSnapshot().quota.exceeded, false);
  assert.equal(harness.cleared(), 0);
  harness.request(async () => new Response(JSON.stringify({ detail: { code: 'ACCOUNT_DISABLED', message: 'Account disabled' } }), { status: 401 }));
  await harness.exceed({ quota: { enabled: true, exceeded: true } });
  assert.equal(harness.api.clientAuthSnapshot().state, 'pending');
  assert.equal(harness.cleared(), 1);
});

test('a quota signal received during refresh requests the latest state before settling', async () => {
  const harness = runtime({ ok: true, session: 'short-session', expiresIn: 1800,
    clientId: 'client-auth-runtime', user: { id: 'quota-user' }, quota: { enabled: true, exceeded: true } });
  await harness.api.clientLogin({ account: 'employee', password: 'password' });
  let finish, reads = 0;
  harness.request(async () => {
    reads++;
    if (reads === 1) return new Promise(resolve => { finish = resolve; });
    return Response.json({ user: { id: 'quota-user' }, quota: { enabled: true, exceeded: false } });
  });
  const first = harness.exceed({});
  while (!finish) await new Promise(setImmediate);
  const second = harness.changed({});
  finish(Response.json({ user: { id: 'quota-user' }, quota: { enabled: true, exceeded: true } }));
  await Promise.all([first, second]);
  assert.equal(reads, 2);
  assert.equal(harness.api.clientAuthSnapshot().quota.exceeded, false);
});

test('an old account quota refresh cannot overwrite a later signed-in account', async () => {
  const harness = runtime({ ok: true, session: 'first-session', expiresIn: 1800,
    clientId: 'client-auth-runtime', user: { id: 'first-user' }, quota: { enabled: true, exceeded: true } });
  await harness.api.clientLogin({ account: 'first', password: 'password' });
  let finish;
  harness.request(async () => new Promise(resolve => { finish = resolve; }));
  const old = harness.exceed({});
  while (!finish) await new Promise(setImmediate);
  harness.login({ ok: true, session: 'next-session', expiresIn: 1800,
    clientId: 'client-auth-runtime', user: { id: 'next-user' }, quota: { enabled: true, exceeded: false, limit: 1000 } });
  await harness.api.clientLogin({ account: 'next', password: 'password' });
  finish(Response.json({ user: { id: 'first-user' }, quota: { enabled: true, exceeded: true, limit: 0 } }));
  await old;
  assert.equal(harness.api.clientAuthSnapshot().user.id, 'next-user');
  assert.equal(harness.api.clientAuthSnapshot().quota.limit, 1000);
  assert.equal(harness.api.clientAuthSnapshot().quota.exceeded, false);
  assert.equal(harness.cleared(), 0);
});

test('a new account restoration starts its own refresh and old cleanup cannot release that flight', async () => {
  const exhausted = { enabled: true, exceeded: true, limit: 10, used: 10 };
  const harness = runtime({ ok: true, session: 'first-session', expiresIn: 1800,
    clientId: 'client-auth-runtime', user: { id: 'first-user' }, quota: exhausted });
  await harness.api.clientLogin({ account: 'first', password: 'password' });
  let finishFirst, finishNext, reads = 0;
  const restored = () => Response.json({ user: { id: 'next-user' }, quota: { ...exhausted, exceeded: false, limit: 100 } });
  harness.request(async () => {
    reads++;
    if (reads === 1) return new Promise(resolve => { finishFirst = resolve; });
    if (reads === 2) return new Promise(resolve => { finishNext = resolve; });
    return restored();
  });
  const old = harness.exceed({});
  while (!finishFirst) await new Promise(setImmediate);
  harness.login({ ok: true, session: 'next-session', expiresIn: 1800,
    clientId: 'client-auth-runtime', user: { id: 'next-user' }, quota: exhausted });
  await harness.api.clientLogin({ account: 'next', password: 'password' });
  const next = harness.changed({});
  await new Promise(setImmediate);
  assert.equal(reads, 2, 'B must read its restored allowance while A is still waiting');
  finishFirst(Response.json({ user: { id: 'first-user' }, quota: exhausted }));
  await old;
  const repeat = harness.changed({});
  await new Promise(setImmediate);
  assert.equal(reads, 2, 'A cleanup must not release B and create a concurrent B refresh');
  finishNext(restored());
  await Promise.all([next, repeat]);
  assert.equal(reads, 3, 'a hint received during B refresh requests a trailing current read');
  assert.equal(harness.api.clientAuthSnapshot().user.id, 'next-user');
  assert.equal(harness.api.clientAuthSnapshot().quota.limit, 100);
  assert.equal(harness.api.clientAuthSnapshot().quota.exceeded, false);
  assert.equal(harness.cleared(), 0);
});
