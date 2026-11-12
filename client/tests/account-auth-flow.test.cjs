'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const contract = require('../main/account-auth-contract.cjs');
const { createSafeStorage } = require('./helpers/device-safe-storage-fixture.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-account-auth-'));
  const file = require.resolve('../main/device-auth'); delete require.cache[file];
  const auth = require(file), app = { getPath: () => root }, handlers = new Map();
  auth.install({ app, ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    safeStorage: createSafeStorage() });
  const realFetch = global.fetch;
  t.after(() => { global.fetch = realFetch;
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep + 'soduwork-account-auth-'));
    fs.rmSync(root, { recursive: true, force: true }); });
  return { auth, app, root, handlers, hub: 'http://account-fixture.invalid' };
}
const response = (data, status = 200) => ({ ok: status < 400, status,
  text: async () => JSON.stringify(data), json: async () => data });
const enrolled = () => response({ authState: 'pending', activationRequired: true });

test('account contract allows only fixed endpoints and whitelisted fields', () => {
  assert.throws(() => contract.request('https://evil.invalid', {}, 'd1'));
  const row = contract.request('register', { email: ' user@example.test ', password: 'fixture-pass',
    consents: { terms: 'v1', privacy: 'v2', extra: true }, role: 'admin', orgId: 'other', url: 'http://evil.invalid' }, 'device-1');
  assert.equal(row.path, '/api/v1/client-auth/register');
  assert.equal(row.body.email, 'user@example.test');
  assert.equal(row.body.device, 'device-1');
  assert.equal(row.body.role, undefined); assert.equal(row.body.orgId, undefined);
  assert.deepEqual(row.body.consents, { terms: 'v1', privacy: 'v2' });
});

for (const action of ['password', 'emailCode', 'register']) test(action + ' uses the encrypted device identity and returns only a short session', async t => {
  const f = fixture(t), requests = [];
  global.fetch = async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith('/clients/enroll')) return enrolled();
    return response({ session: 'short-fixture-token', expiresIn: 600, user: { id: 'account-user', email: 'user@example.test' }, created: action === 'register' });
  };
  const result = await f.auth.accountAction(f.app, { hub: f.hub, action, email: 'user@example.test', password: 'fixture-pass', code: '123456', challengeId: 'challenge-1', consents: { terms: 'v1', privacy: 'v1' } });
  assert.equal(result.ok, true); assert.equal(result.user.id, 'account-user');
  assert.equal(f.auth.session(f.app), 'short-fixture-token');
  assert.equal(Object.hasOwn(result, 'secret'), false);
  assert.equal(requests.length, 2);
  const sent = requests[1]; assert.equal(sent.url, f.hub + contract.request(action, {}, '').path);
  assert.ok(sent.options.headers['X-Device-Key'].length >= 32);
  const body = JSON.parse(sent.options.body); assert.match(body.device, /^soduwork-/);
  assert.equal(body.email, 'user@example.test');
  const saved = fs.readFileSync(path.join(f.root, 'device-auth.json'), 'utf8');
  assert.equal(saved.includes('fixture-pass'), false); assert.equal(saved.includes('123456'), false);
});

test('mail send failures are failures and cannot manufacture a challenge or cooldown', async t => {
  const f = fixture(t);
  global.fetch = async url => url.endsWith('/clients/enroll') ? enrolled()
    : response({ detail: { code: 'EMAIL_UNAVAILABLE', message: '邮件服务暂不可用' } }, 503);
  const result = await f.auth.accountAction(f.app, { hub: f.hub, action: 'emailChallenge', email: 'user@example.test', purpose: 'register' });
  assert.equal(result.ok, false); assert.equal(result.status, 503); assert.equal(result.challengeId, undefined);
  assert.match(result.error, /邮件服务/);
});

test('mail delivery status uses a fixed device authenticated GET and returns only delivery fields', async t => {
  const f = fixture(t), requests = [];
  global.fetch = async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith('/clients/enroll')) return enrolled();
    if (url.endsWith('/email-challenges')) return response({ challengeId: 'challenge-1', expiresIn: 300,
      retryAfter: 60, queued: true, deliveryState: 'queued' });
    return response({ challengeId: 'challenge-1', deliveryState: 'failed', errorCode: 'SMTP_AUTH_FAILED',
      code: '123456', email: 'private@example.test', error: 'private SMTP response', session: 'must-not-cache' });
  };
  const sent = await f.auth.accountAction(f.app, { hub: f.hub, action: 'emailChallenge', email: 'user@example.test', purpose: 'register' });
  assert.equal(sent.queued, true); assert.equal(sent.deliveryState, 'queued');
  requests.length = 0;
  const result = await f.handlers.get('device-account-action')({}, { hub: f.hub,
    action: 'emailChallengeStatus', challengeId: 'challenge-1', url: 'https://evil.invalid', device: 'other' });
  assert.deepEqual(result, { ok: true, challengeId: 'challenge-1', deliveryState: 'failed', errorCode: 'SMTP_AUTH_FAILED' });
  assert.equal(requests.length, 1, 'polling never re-enrolls or mutates the device session');
  const sentRequest = requests[0], url = new URL(sentRequest.url);
  assert.equal(url.origin, f.hub); assert.equal(url.pathname, '/api/v1/client-auth/email-challenges/challenge-1');
  assert.equal(url.searchParams.get('device'), f.auth.identity(f.app).clientId);
  assert.equal(sentRequest.options.method, 'GET'); assert.equal(sentRequest.options.body, undefined);
  assert.ok(sentRequest.options.headers['X-Device-Key'].length >= 32); assert.equal(f.auth.session(f.app), '');
  for (const challengeId of ['', '../me', 'valid?device=other', 'https://evil.invalid']) {
    assert.equal((await f.auth.accountAction(f.app, { hub: f.hub, action: 'emailChallengeStatus', challengeId })).ok, false);
  }
  assert.equal(requests.length, 1, 'invalid identifiers never cause a network request');
});

test('old Hub status 404 is preserved and late status cannot cross an account change', async t => {
  const f = fixture(t); let finish;
  global.fetch = async () => response({ detail: 'Not Found' }, 404);
  assert.equal((await f.auth.accountAction(f.app, { hub: f.hub, action: 'emailChallengeStatus', challengeId: 'challenge-1' })).status, 404);
  global.fetch = async url => {
    if (url.includes('/email-challenges/')) return new Promise(resolve => { finish = resolve; });
    if (url.endsWith('/clients/enroll')) return enrolled();
    return response({ session: 'new-account', expiresIn: 600, user: { id: 'second-user' } });
  };
  const pending = f.auth.accountAction(f.app, { hub: f.hub, action: 'emailChallengeStatus', challengeId: 'challenge-1' });
  await f.auth.accountAction(f.app, { hub: f.hub, action: 'password', email: 'second@example.test', password: 'fixture-pass' });
  finish(response({ challengeId: 'challenge-1', deliveryState: 'sent', errorCode: '' }));
  const result = await pending;
  assert.equal(result.ok, false); assert.equal(result.deliveryState, undefined);
  assert.equal(f.auth.session(f.app), 'new-account');
});

test('a challenge completion from the previous account transition is discarded', async t => {
  const f = fixture(t); let finish, started;
  const waiting = new Promise(resolve => { started = resolve; });
  global.fetch = async url => {
    if (url.endsWith('/clients/enroll')) return enrolled();
    if (url.endsWith('/email-challenges')) { started(); return new Promise(resolve => { finish = resolve; }); }
    return response({ session: 'new-account', expiresIn: 600, user: { id: 'second-user' } });
  };
  const pending = f.auth.accountAction(f.app, { hub: f.hub, action: 'emailChallenge', email: 'first@example.test', purpose: 'login' });
  await waiting;
  await f.auth.accountAction(f.app, { hub: f.hub, action: 'password', email: 'second@example.test', password: 'fixture-pass' });
  finish(response({ challengeId: 'stale', retryAfter: 60, expiresIn: 300 }));
  const result = await pending;
  assert.equal(result.ok, false); assert.match(result.error, /账号或服务已变化/); assert.equal(result.challengeId, undefined);
  assert.equal(f.auth.session(f.app), 'new-account');
});

test('late successful registration cannot replace a newer login', async t => {
  const f = fixture(t); let finish, began;
  const waiting = new Promise(resolve => { began = resolve; });
  global.fetch = async url => {
    if (url.endsWith('/clients/enroll')) return enrolled();
    if (url.endsWith('/register')) { began(); return new Promise(resolve => { finish = resolve; }); }
    return response({ session: 'new-login', expiresIn: 600, user: { id: 'second-user' } });
  };
  const pending = f.auth.accountAction(f.app, { hub: f.hub, action: 'register', email: 'first@example.test', password: 'fixture-pass' });
  await waiting;
  await f.auth.accountAction(f.app, { hub: f.hub, action: 'password', email: 'second@example.test', password: 'fixture-pass' });
  finish(response({ session: 'stale-register', expiresIn: 600, user: { id: 'first-user' } }));
  assert.equal((await pending).ok, false); assert.equal(f.auth.session(f.app), 'new-login');
});

test('password reset invalidates cached auth and never signs in on the reset receipt', async t => {
  const f = fixture(t), requests = [];
  global.fetch = async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    if (url.endsWith('/clients/enroll')) return enrolled();
    if (url.endsWith('/password/reset')) return response({ ok: true, session: 'must-not-cache' });
    return response({ session: 'before-reset', expiresIn: 600, user: { id: 'first-user' } });
  };
  await f.auth.accountAction(f.app, { hub: f.hub, action: 'password', email: 'user@example.test', password: 'old-password' });
  const result = await f.auth.accountAction(f.app, { hub: f.hub, action: 'resetPassword', email: 'user@example.test', newPassword: 'new-password', challengeId: 'reset-challenge', code: '123456' });
  assert.equal(result.ok, true); assert.equal(result.logoutRequired, true); assert.equal(result.session, undefined);
  assert.equal(f.auth.session(f.app), ''); assert.equal(requests.at(-1).body.newPassword, 'new-password');
});

test('profile refresh is authoritative, owner fenced, and updates the main cache', async t => {
  const f = fixture(t);
  global.fetch = async url => url.endsWith('/clients/enroll') ? enrolled() : response({ session: 'profile-token', expiresIn: 600, user: { id: 'owner', displayName: 'Before' } });
  await f.auth.accountAction(f.app, { hub: f.hub, action: 'password', email: 'user@example.test', password: 'fixture-pass' });
  global.fetch = async (_url, options) => {
    assert.equal(options.headers.Authorization, 'Device profile-token');
    return response({ user: { id: 'owner', displayName: 'After' } });
  };
  assert.equal((await f.auth.refreshProfile(f.app)).user.displayName, 'After');
  assert.equal((await f.auth.enroll(f.app, { hub: f.hub })).user.displayName, 'After');
  global.fetch = async () => response({ user: { id: 'other-user' } });
  assert.equal((await f.auth.refreshProfile(f.app)).ok, false);
});

test('logout notifies every live window after local invalidation before an offline server responds', async t => {
  const f = fixture(t), sent = [];
  global.fetch = async url => url.endsWith('/clients/enroll') ? enrolled()
    : response({ session: 'logout-fixture-token', expiresIn: 600, user: { id: 'owner' } });
  await f.auth.accountAction(f.app, { hub: f.hub, action: 'password', email: 'user@example.test', password: 'fixture-pass' });
  const Module = require('node:module'), originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return { BrowserWindow: { getAllWindows: () => [41, 42, 43].map(id => ({
      isDestroyed: () => id === 43,
      webContents: { id, send(channel, payload) {
        assert.equal(f.auth.session(f.app), '', 'notification follows local invalidation');
        sent.push({ id, channel, payload });
      } },
    })) } };
    return originalLoad.call(this, request, parent, isMain);
  };
  t.after(() => { Module._load = originalLoad; });
  let rejectNetwork;
  global.fetch = () => new Promise((_resolve, reject) => { rejectNetwork = reject; });
  const pending = f.handlers.get('device-auth-logout')({ sender: { id: 41 } }, { hub: f.hub });
  assert.deepEqual(sent.map(row => row.id), [41, 42], 'includes initiating and other live renderer before awaiting network');
  for (const row of sent) {
    assert.equal(row.channel, 'account-session-changed');
    assert.deepEqual(Object.keys(row.payload).sort(), ['clientId', 'hub']);
    assert.equal(row.payload.hub, f.hub);
    assert.equal(JSON.stringify(row.payload).includes('logout-fixture-token'), false);
  }
  rejectNetwork(Error('fixture network unavailable'));
  const result = await pending;
  assert.equal(result.ok, false); assert.match(result.error, /network unavailable/);
  assert.equal(f.auth.session(f.app), ''); assert.equal(sent.length, 2, 'late failure cannot emit a second state change');
});
