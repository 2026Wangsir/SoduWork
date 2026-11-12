'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const store = require('../main/local-model-store.cjs');
const OPAQUE = /^local:model-[a-f0-9]{32}$/;
const provider = { id: 'private', name: 'Private provider fixture', baseUrl: 'https://private-provider.invalid/v1' };
const model = { providerId: 'private', name: 'private-model-fixture', label: 'Private model fixture' };

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-model-reference-'));
  const key = crypto.randomBytes(32);
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString(value) {
      const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const bytes = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), bytes]);
    },
    decryptString(bytes) {
      const cipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      cipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8');
    },
  };
  const app = { getPath: () => root }, file = path.join(root, 'local-models.secure.json');
  store.configure({ app, safeStorage });
  t.after(() => { store.configure(null); fs.rmSync(root, { recursive: true, force: true }); });
  const seed = value => fs.writeFileSync(file, JSON.stringify({ schema: value.schema,
    cipher: safeStorage.encryptString(JSON.stringify(value)).toString('base64') }), { mode: 0o600 });
  return { root, app, file, safeStorage, seed };
}
function create() { return store.save({ providers: [provider], models: [model], keys: { private: 'synthetic-private-key' } }); }
function assertCipherOnly(file) {
  const encoded = fs.readFileSync(file, 'utf8'), value = JSON.parse(encoded);
  assert.deepEqual(Object.keys(value).sort(), ['cipher', 'schema']);
  assert.equal(value.schema, 2);
  for (const text of [provider.baseUrl, provider.name, model.name, model.label, 'synthetic-private-key', 'local:private:']) {
    assert.equal(encoded.includes(text), false, 'The on-disk envelope cannot contain private model metadata');
  }
}

test('opaque identities persist across edits, encrypted reloads and model discovery', async t => {
  const f = fixture(t), first = create(), id = first.myModels[0].id;
  assert.match(id, OPAQUE);
  assert.equal(first.usable[0].name, id);
  assert.equal(first.usable[0].id, id);
  assert.equal(first.providers[0].modelDefs[0].id, id);
  assert.equal(store.resolve(id).runtimeId, id);
  assert.equal(store.resolve(id).name, model.name);
  assert.equal(store.resolve(id).key, 'synthetic-private-key');
  assert.equal(store.resolve(id).configRevision, first.revision);
  assertCipherOnly(f.file);
  store.configure({ app: f.app, safeStorage: f.safeStorage });
  const renamed = { ...first.myModels[0], name: 'renamed-private-model', label: 'Renamed private model' };
  const saved = store.save({ models: [renamed], expectedRevision: first.revision });
  assert.equal(saved.myModels[0].id, id);
  assert.equal(store.resolve(id).configRevision, saved.revision);
  assert.ok(saved.revision > first.revision);
  assert.equal(store.canonicalReference(store.ref(provider.id, model.name)), id);
  assert.equal(store.canonicalReference(store.ref(provider.id, renamed.name)), id);
  assert.equal(store.resolve(store.ref(provider.id, model.name)).name, renamed.name);
  const discovered = await store.test(provider.id, '', async () => new Response(JSON.stringify({ data: [
    { id: renamed.name }, { id: 'discovered-private-model' },
  ] }), { status: 200 }));
  assert.equal(discovered.ok, true);
  const rows = store.get().myModels;
  assert.equal(rows.find(row => row.name === renamed.name).id, id);
  assert.match(rows.find(row => row.name === 'discovered-private-model').id, OPAQUE);
  assert.notEqual(rows[0].id, rows[1].id);
  assertCipherOnly(f.file);
});

test('legacy encrypted catalogs migrate once without losing credentials or changing source metadata', t => {
  const f = fixture(t);
  f.seed({ schema: 1, revision: 7, providers: [provider], models: [model], keys: { private: 'synthetic-private-key' } });
  const migrated = store.get(), id = migrated.myModels[0].id;
  assert.match(id, OPAQUE);
  assert.equal(migrated.revision, 8);
  assert.equal(migrated.myModels[0].name, model.name);
  assert.equal(migrated.providers[0].baseUrl, provider.baseUrl);
  assert.equal(store.resolve(store.ref(provider.id, model.name)).key, 'synthetic-private-key');
  assert.equal(store.resolve(id).modelRef, id);
  assert.equal(store.canonicalReference(store.ref(provider.id, model.name)), id);
  const after = fs.readFileSync(f.file);
  assert.deepEqual(store.get(), migrated);
  assert.deepEqual(fs.readFileSync(f.file), after, 'A second read must not rewrite the migrated snapshot');
  assert.throws(() => store.save({ models: [], expectedRevision: 7 }), /已变化/);
  assert.deepEqual(fs.readFileSync(f.file), after);
  assertCipherOnly(f.file);
});

test('failed encryption or file publication preserves a legacy snapshot and exposes no temporary identity', t => {
  const f = fixture(t), legacy = { schema: 1, revision: 4, providers: [provider], models: [model], keys: { private: 'synthetic-private-key' } };
  f.seed(legacy);
  const before = fs.readFileSync(f.file), encrypt = f.safeStorage.encryptString, rename = fs.renameSync;
  f.safeStorage.encryptString = () => { throw Error('Synthetic encryption failure'); };
  assert.throws(() => store.get(), /无法读取/);
  assert.deepEqual(fs.readFileSync(f.file), before);
  f.safeStorage.encryptString = encrypt;
  fs.renameSync = (source, target) => {
    if (target === f.file) throw Object.assign(Error('Synthetic publication failure'), { code: 'ENOENT' });
    return rename(source, target);
  };
  try {
    assert.throws(() => store.canonicalReference(store.ref(provider.id, model.name)), /无法读取/);
    assert.deepEqual(fs.readFileSync(f.file), before);
    assert.deepEqual(fs.readdirSync(f.root), ['local-models.secure.json']);
  } finally { fs.renameSync = rename; }
  assert.equal(store.get().revision, 5);
});

test('deleted aliases remain unavailable after the same provider and model are recreated', t => {
  const f = fixture(t), initial = create(), oldId = initial.myModels[0].id, legacy = store.ref(provider.id, model.name);
  store.save({ providers: [], models: [], expectedRevision: initial.revision });
  assert.equal(store.resolve(oldId), null);
  assert.equal(store.resolve(legacy), null);
  assert.equal(store.canonicalReference(legacy), oldId);
  assert.deepEqual(store.referenceAliases(), [{ legacyRef: legacy, modelRef: oldId, runtimeId: oldId,
    providerId: provider.id, modelName: model.name, active: false }]);
  const recreated = create(), newId = recreated.myModels[0].id;
  assert.notEqual(newId, oldId);
  assert.equal(store.resolve(legacy), null, 'Old history cannot silently use a recreated model');
  assert.equal(store.resolve(oldId), null);
  assert.equal(store.resolve(newId).name, model.name);
  assert.equal(store.canonicalReference(legacy), oldId);
  assertCipherOnly(f.file);
});

test('unavailable legacy references get durable encrypted tombstones only through the explicit host migration option', t => {
  const f = fixture(t), legacy = store.ref('retired', 'previous-private-model');
  assert.equal(store.canonicalReference(legacy), '');
  assert.equal(fs.existsSync(f.file), false);
  const tombstone = store.canonicalReference(legacy, { rememberMissing: true });
  assert.match(tombstone, OPAQUE);
  assert.equal(store.resolve(legacy), null);
  assert.equal(store.resolve(tombstone), null);
  assert.equal(store.canonicalReference(legacy), tombstone);
  assert.equal(store.get().revision, 1);
  assert.deepEqual(store.get().myModels, []);
  assert.equal(store.canonicalReference(legacy, { rememberMissing: true }), tombstone);
  assert.equal(store.get().revision, 1);
  for (const invalid of ['managed-model', 'local::invalid', 'local:x:%E0%A4%A', 'local:x:invalid\nmodel']) {
    assert.equal(store.canonicalReference(invalid, { rememberMissing: true }), '');
  }
  assert.equal(store.get().revision, 1);
  assertCipherOnly(f.file);
});

test('forged identities and duplicate reuse cannot replace an encrypted valid configuration', t => {
  const f = fixture(t), saved = create(), current = saved.myModels[0], before = fs.readFileSync(f.file);
  const foreign = 'local:model-' + 'f'.repeat(32);
  const changes = [
    [{ ...current, id: foreign }],
    [{ ...current, id: 'invalid' }],
    [current, { ...current, name: 'another-model' }],
    [{ ...current, id: store.ref('other', model.name) }],
  ];
  for (const models of changes) {
    assert.throws(() => store.save({ models, expectedRevision: saved.revision }), /模型引用/);
    assert.deepEqual(fs.readFileSync(f.file), before);
  }
  assert.equal(store.resolve(current.id).key, 'synthetic-private-key');
});

test('unsupported or corrupt schema-two references fail closed without replacing the ciphertext', t => {
  const f = fixture(t), valid = { schema: 2, revision: 1, providers: [provider],
    models: [{ ...model, id: 'local:model-' + 'a'.repeat(32) }], keys: {}, aliases: {} };
  for (const value of [
    { ...valid, schema: 3 }, { ...valid, aliases: null },
    { ...valid, models: [{ ...model, id: store.ref(provider.id, model.name) }] },
    { ...valid, aliases: { [store.ref(provider.id, model.name)]: 'raw-private-model' } },
    { ...valid, models: [{ ...model }] },
  ]) {
    f.seed(value); const before = fs.readFileSync(f.file);
    assert.throws(() => store.get(), /无法读取/);
    assert.throws(() => store.save({ models: [] }), /无法读取/);
    assert.deepEqual(fs.readFileSync(f.file), before);
  }
});

test('secure storage failure does not fall back to plaintext or discard tombstones', t => {
  const f = fixture(t); create();
  const before = fs.readFileSync(f.file);
  f.safeStorage.isEncryptionAvailable = () => false;
  assert.throws(() => store.get(), /系统安全存储不可用/);
  assert.throws(() => store.save({ models: [] }), /系统安全存储不可用/);
  assert.throws(() => store.canonicalReference(store.ref('retired', 'model'), { rememberMissing: true }), /系统安全存储不可用/);
  assert.deepEqual(fs.readFileSync(f.file), before);
});
