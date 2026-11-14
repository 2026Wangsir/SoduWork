'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { pathToFileURL } = require('node:url');
const { install } = require('../main/local-automation-model-ipc.cjs');
const store = require('../main/local-automation-model-store.cjs');

const model = 'local:model-0123456789abcdef0123456789abcdef';
const scope = { hub: 'https://hub.example', clientId: 'device', owner: 'account:alice' };
function identity(user = 'alice', hub = scope.hub) {
  return { hub, clientId: scope.clientId,
    session: Buffer.from(JSON.stringify({ typ: 'device', cid: scope.clientId, uid: user })).toString('base64url') + '.fixture' };
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-automation-model-ipc-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const handlers = new Map(), state = { identity: identity(), resolveIdentity: null };
  const app = { getPath: () => root };
  const safeStorage = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'libsecret',
    encryptString: value => Buffer.from(value), decryptString: value => value.toString() };
  install({ app, safeStorage, ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    identityOf: () => state.resolveIdentity ? state.resolveIdentity() : state.identity,
    currentIdentityOf: () => state.identity });
  const frame = { url: pathToFileURL(path.resolve(__dirname, '../desk.html')).href };
  const event = { senderFrame: frame, sender: { mainFrame: frame } };
  return { state, event, call: (action, input) => handlers.get('automation-models-' + action)(event, input) };
}

test('automation model IPC validates the trusted owner for reads, writes, and removal', async t => {
  const f = fixture(t), input = { ...scope, scheduleId: 'schedule-1', modelName: model };
  await f.call('set', input);
  assert.equal((await f.call('get', input)).modelName, model);
  for (const action of ['get', 'set', 'remove']) {
    for (const changed of [{ owner: 'account:bob' }, { hub: 'https://other.example' }, { clientId: 'other' }]) {
      await assert.rejects(f.call(action, { ...input, ...changed }), error => error.code === 'STALE_TASK_SCOPE');
    }
  }
  assert.equal(store.get(input).modelName, model);
  await f.call('remove', input);
  assert.equal(store.get(input).configured, false);
});

test('an identity refresh cannot authorize a stale write after the active account changes', async t => {
  const f = fixture(t), original = f.state.identity;
  let resolve;
  f.state.resolveIdentity = () => new Promise(done => { resolve = done; });
  const input = { ...scope, scheduleId: 'schedule-1', modelName: model };
  const pending = f.call('set', input);
  f.state.identity = identity('bob'); resolve(original);
  await assert.rejects(pending, error => error.code === 'STALE_TASK_SCOPE');
  assert.equal(store.get(input).configured, false);
  assert.equal(store.get({ ...input, owner: 'account:bob' }).configured, false);
});

test('a subframe cannot access automation model mappings', async t => {
  const f = fixture(t);
  f.event.senderFrame = { url: f.event.sender.mainFrame.url };
  await assert.rejects(f.call('get', scope), /主工作台/);
});
