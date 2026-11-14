'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const store = require('../main/local-automation-model-store.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-automation-models-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const safeStorage = {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'libsecret',
    encryptString: value => Buffer.from(value, 'utf8'),
    decryptString: value => Buffer.from(value).toString('utf8'),
  };
  store.configure({ app: { getPath: () => root }, safeStorage });
  return { root, safeStorage };
}

const scope = { hub: 'https://hub.example', clientId: 'device', owner: 'account:alice' };
const model = 'local:model-0123456789abcdef0123456789abcdef';

function writePayload(root, payload) {
  fs.writeFileSync(path.join(root, 'automation-models.secure.json'), JSON.stringify({
    schema: 1,
    cipher: Buffer.from(JSON.stringify(payload), 'utf8').toString('base64'),
  }));
}

test('automation model selections are encrypted, scoped, and removable', t => {
  const f = fixture(t);
  assert.deepEqual(store.get({ ...scope, scheduleId: 'schedule-1' }), {
    ok: true, modelName: '', configured: false,
  });
  assert.deepEqual(store.set({ ...scope, scheduleId: 'schedule-1', modelName: model }), {
    ok: true, modelName: model,
  });
  assert.deepEqual(store.get({ ...scope, scheduleId: 'schedule-1' }), {
    ok: true, modelName: model, configured: true,
  });
  assert.equal(store.get({ ...scope, scheduleId: 'schedule-2' }).modelName, '');
  assert.equal(store.get({ ...scope, hub: 'https://other.example', scheduleId: 'schedule-1' }).modelName, '');
  assert.equal(store.get({ ...scope, owner: 'account:bob', scheduleId: 'schedule-1' }).modelName, '');
  const raw = fs.readFileSync(path.join(f.root, 'automation-models.secure.json'), 'utf8');
  assert.doesNotMatch(raw, new RegExp(model));
  assert.deepEqual(store.remove({ ...scope, scheduleId: 'schedule-1' }), { ok: true, modelName: '' });
  assert.deepEqual(store.get({ ...scope, scheduleId: 'schedule-1' }), {
    ok: true, modelName: '', configured: false,
  });
});

test('automation model selections reject malformed references and scopes', t => {
  fixture(t);
  assert.throws(() => store.set({ ...scope, scheduleId: 'schedule-1', modelName: 'local:provider:model' }), /本地模型引用无效/);
  assert.throws(() => store.get({ ...scope, hub: 'file:///private', scheduleId: 'schedule-1' }), /作用域无效/);
  assert.throws(() => store.get({ ...scope, owner: '', scheduleId: 'schedule-1' }), /账号作用域无效/);
});

test('automation model storage fails closed when an entry is corrupted', t => {
  const f = fixture(t);
  writePayload(f.root, {
    schema: 1,
    entries: {
      'https://hub.example\ndevice\nschedule-1': 'local:provider:model',
    },
  });
  assert.throws(() => store.get({ ...scope, scheduleId: 'schedule-1' }), /数据损坏/);
  assert.throws(() => store.set({ ...scope, scheduleId: 'schedule-2', modelName: model }), /数据损坏/);
});

test('automation model storage rejects malformed entry scopes', t => {
  const f = fixture(t);
  writePayload(f.root, {
    schema: 1,
    entries: {
      'https://hub.example\ndevice\nschedule-1\nextra': model,
    },
  });
  assert.throws(() => store.get({ ...scope, scheduleId: 'schedule-1' }), /数据损坏/);
});

test('legacy mappings remain encrypted and require explicit owner binding without being discarded', t => {
  const f = fixture(t), legacyKey = 'https://hub.example\ndevice\nschedule-1';
  writePayload(f.root, { schema: 1, entries: { [legacyKey]: model } });
  assert.deepEqual(store.get({ ...scope, scheduleId: 'schedule-1' }), {
    ok: true, modelName: '', configured: false, needsReselection: true,
  });
  assert.deepEqual(store.get({ ...scope, scheduleIds: ['schedule-1'] }), {
    ok: true, models: {}, unavailableScheduleIds: ['schedule-1'],
  });
  assert.deepEqual(store.get(scope), { ok: true, models: {} }, 'unknown-owner schedule IDs must not be enumerated');
  store.set({ ...scope, scheduleId: 'schedule-1', modelName: model });
  assert.equal(store.get({ ...scope, scheduleId: 'schedule-1' }).modelName, model);
  assert.equal(store.get({ ...scope, owner: 'account:bob', scheduleId: 'schedule-1' }).modelName, '');
  const raw = JSON.parse(fs.readFileSync(path.join(f.root, 'automation-models.secure.json')));
  assert.equal(raw.schema, 2);
  const decoded = JSON.parse(f.safeStorage.decryptString(Buffer.from(raw.cipher, 'base64')));
  assert.equal(decoded.legacyEntries[legacyKey], model, 'migration must preserve the unknown-owner mapping');
  store.remove({ ...scope, scheduleId: 'schedule-1' });
  assert.equal(JSON.parse(f.safeStorage.decryptString(Buffer.from(JSON.parse(fs.readFileSync(
    path.join(f.root, 'automation-models.secure.json'))).cipher, 'base64'))).legacyEntries[legacyKey], model);
});
