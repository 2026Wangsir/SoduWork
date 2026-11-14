'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const store = require('../main/local-model-store.cjs');
const privacy = require('../main/local-model-privacy.cjs');
const OPAQUE = /^local:model-[a-f0-9]{32}$/;
const provider = { id: 'private', name: 'Synthetic private provider', baseUrl: 'https://private-fixture.invalid/v1' };
const model = { providerId: provider.id, name: 'synthetic-private-model', label: 'Synthetic private label' };
const legacy = store.ref(provider.id, model.name);
const selection = name => ({ type: 'custom', customType: 'soduwork.model.selection', data: { name } });
const assistant = (name = model.name, extra = {}) => ({ type: 'message', message: {
  role: 'assistant', provider: 'soduwork', model: name, responseModel: 'synthetic-response-alias',
  content: [{ type: 'text', text: 'Preserved answer' }], usage: { input: 7, output: 3, cost: { total: 0.25 } }, ...extra,
} });
const context = name => ({ type: 'custom', customType: 'soduwork.context-window',
  data: { key: 'soduwork|' + name + '|' + provider.baseUrl, window: 4096 } });

function fixture(t, { seed = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-private-migration-')), key = crypto.randomBytes(32);
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
  const app = { getPath: () => root };
  const write = (name, value) => {
    const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 }); return file;
  };
  const archive = (rows, name = 'pi-agent/sessions/work/session.jsonl') => write(name, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  store.configure({ app, safeStorage });
  if (seed) {
    const value = { schema: 1, revision: 5, providers: [provider], models: [model], keys: { private: 'synthetic-private-key' } };
    write('local-models.secure.json', { schema: 1, cipher: safeStorage.encryptString(JSON.stringify(value)).toString('base64') });
  }
  t.after(() => { store.configure(null); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, app, safeStorage, write, archive };
}
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const rows = file => fs.readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));

test('legacy catalogs and owned metadata migrate to one opaque identity without rewriting user content or usage', t => {
  const f = fixture(t), managedProvider = { baseUrl: 'https://managed.invalid/v1', models: [{ id: model.name }] };
  const runtime = f.write('pi-agent/models.json', { providers: {
    soduwork: { localOnly: true, localRef: legacy, baseUrl: provider.baseUrl, apiKey: '$SODUWORK_PROXY_KEY',
      models: [{ id: model.name, name: model.label, localRef: legacy, contextWindow: 16384 }] }, managed: managedProvider,
  } });
  const preference = f.write('conversation-models/local.json', { name: legacy, reasoningEffort: 'high' });
  const managedPreference = f.write('conversation-models/managed.json', ' {"name":"managed","reasoningEffort":"low"}\n');
  const managedBefore = fs.readFileSync(managedPreference, 'utf8');
  const user = { type: 'message', message: { role: 'user', content: [{ type: 'text', text: legacy + ' ' + provider.baseUrl }] } };
  const tool = { type: 'message', message: { role: 'toolResult', content: [{ type: 'text', text: model.name }],
    arguments: { name: legacy, model: model.name, endpoint: provider.baseUrl } } };
  const localResponse = assistant(model.name, { usageLocalOnly: true });
  const managedResponse = assistant(model.name, { usageLocalOnly: false, usageProvider: 'managed', quotaUsageToken: 'synthetic-receipt' });
  const record = f.archive([
    { type: 'session', id: 'synthetic-session' }, { type: 'model_change', provider: 'soduwork', modelId: model.name },
    selection(legacy), user, tool, localResponse, context(model.name), context('other-managed-model'),
    managedResponse, selection('managed-model'), { type: 'model_change', provider: 'soduwork', modelId: model.name }, assistant(),
  ]);
  const usage = f.write('usage-outbox/confirmed.json', { model: legacy, confirmed: true, total: 10 });
  const usageBefore = fs.readFileSync(usage);
  privacy.ensure(f.app);
  const id = store.canonicalReference(legacy), migrated = rows(record);
  assert.match(id, OPAQUE);
  assert.equal(store.get().revision, 6);
  assert.equal(store.resolve(id).key, 'synthetic-private-key');
  const localRuntime = json(runtime).providers.soduwork;
  assert.equal(localRuntime.baseUrl, 'https://local-model.invalid/v1');
  assert.equal(localRuntime.models[0].id, id);
  assert.equal(localRuntime.models[0].localRef, id);
  assert.equal(localRuntime.models[0].name, 'Local model');
  assert.deepEqual(json(runtime).providers.managed, managedProvider);
  assert.deepEqual(json(preference), { name: id, reasoningEffort: 'high' });
  assert.equal(fs.readFileSync(managedPreference, 'utf8'), managedBefore);
  assert.equal(migrated[1].modelId, id);
  assert.equal(migrated[2].data.name, id);
  assert.deepEqual(migrated[3], user);
  assert.deepEqual(migrated[4], tool);
  assert.equal(migrated[5].message.model, id);
  assert.equal(migrated[5].message.responseModel, id);
  assert.deepEqual(migrated[5].message.usage, localResponse.message.usage);
  assert.equal(migrated[5].message.usageLocalOnly, true);
  assert.equal(migrated[6].data.key, 'soduwork|' + id);
  assert.deepEqual(migrated[7], context('other-managed-model'));
  assert.deepEqual(migrated[8], managedResponse);
  assert.equal(migrated[10].modelId, model.name);
  assert.deepEqual(migrated[11], assistant());
  assert.deepEqual(fs.readFileSync(usage), usageBefore);
  const before = [runtime, preference, record].map(file => fs.readFileSync(file));
  privacy.ensure(f.app);
  assert.deepEqual([runtime, preference, record].map(file => fs.readFileSync(file)), before);
});

test('a later local selection cannot relabel earlier managed responses or initial model changes', t => {
  const f = fixture(t), early = assistant(), earlyChange = { type: 'model_change', provider: 'soduwork', modelId: model.name };
  const file = f.archive([earlyChange, early, selection(legacy), assistant()]);
  privacy.ensure(f.app);
  const migrated = rows(file), id = store.canonicalReference(legacy);
  assert.deepEqual(migrated[0], earlyChange);
  assert.deepEqual(migrated[1], early);
  assert.equal(migrated[2].data.name, id);
  assert.equal(migrated[3].message.model, id);
});

test('runtime segment references and proven local receipts migrate while text and managed receipts remain intact', t => {
  const f = fixture(t), untouched = { model: model.name, provider: 'managed', quotaUsageToken: 'synthetic-confirmed-token',
    usage: { input: 9, output: 2 } };
  const prefix = { messages: [
    { role: 'user', text: legacy, usageModel: model.name },
    { role: 'assistant', text: model.name, usageModel: model.name, usageLocalOnly: true,
      responseId: 'response-' + model.name, errorMessage: 'HTTP 401 at ' + provider.baseUrl,
      usageProvider: provider.id, modelLabel: model.label, usage: { input: 4, output: 2 } },
  ], tools: [{ args: { model: legacy } }], usageReceipts: [
    { model: legacy, localOnly: true, provider: provider.id, usage: { input: 3, output: 1 } }, untouched,
  ] };
  const record = f.write('conversation-runtime-segments/synthetic.json', { version: 1, id: 'synthetic', model: legacy,
    active: { modelName: legacy }, segments: [{ modelRef: legacy }, { modelName: 'managed' }], prefix });
  privacy.ensure(f.app);
  const migrated = json(record), id = store.canonicalReference(legacy);
  assert.equal(migrated.model, id);
  assert.equal(migrated.active.modelName, id);
  assert.equal(migrated.segments[0].modelRef, id);
  assert.equal(migrated.segments[1].modelName, 'managed');
  assert.deepEqual(migrated.prefix.messages[0], prefix.messages[0]);
  assert.equal(migrated.prefix.messages[1].usageModel, id);
  assert.equal(migrated.prefix.messages[1].usageProvider, 'local');
  assert.equal(migrated.prefix.messages[1].modelLabel, 'Local model');
  assert.equal(migrated.prefix.messages[1].text, model.name);
  assert.equal('responseId' in migrated.prefix.messages[1], false);
  assert.equal(migrated.prefix.messages[1].errorMessage.includes(provider.baseUrl), false);
  assert.deepEqual(migrated.prefix.messages[1].usage, prefix.messages[1].usage);
  assert.deepEqual(migrated.prefix.tools, prefix.tools);
  assert.equal(migrated.prefix.usageReceipts[0].model, id);
  assert.deepEqual(migrated.prefix.usageReceipts[0].usage, prefix.usageReceipts[0].usage);
  assert.deepEqual(migrated.prefix.usageReceipts[1], untouched);
});

test('security storage and publication failures retain the original bytes and allow a later retry', t => {
  const f = fixture(t), file = f.write('conversation-models/local.json', { name: legacy }), before = fs.readFileSync(file);
  const catalog = path.join(f.root, 'local-models.secure.json'), catalogBefore = fs.readFileSync(catalog);
  f.safeStorage.isEncryptionAvailable = () => false;
  assert.throws(() => privacy.ensure(f.app), /迁移未完成/);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.deepEqual(fs.readFileSync(catalog), catalogBefore);
  f.safeStorage.isEncryptionAvailable = () => true;
  const rename = fs.renameSync;
  fs.renameSync = (source, target) => {
    if (target === file) throw Object.assign(Error('Synthetic publication failure'), { code: 'EXDEV' });
    return rename(source, target);
  };
  try {
    assert.throws(() => privacy.ensure(f.app), /迁移未完成/);
    assert.deepEqual(fs.readFileSync(file), before);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['local.json']);
  } finally { fs.renameSync = rename; }
  privacy.ensure(f.app);
  assert.match(json(file).name, OPAQUE);
});

test('malformed unrelated files do not require secure storage while malformed local metadata fails closed', t => {
  const f = fixture(t, { seed: false });
  f.safeStorage.isEncryptionAvailable = () => false;
  const files = [f.write('pi-agent/models.json', '{"providers":'),
    f.write('conversation-models/bad.json', '{"name":"managed"'),
    f.write('conversation-runtime-segments/bad.json', '{"version":1'),
    f.write('pi-agent/sessions/bad.jsonl', '{"type":"message","message":{"role":"user","text":"incomplete"')];
  const original = files.map(file => fs.readFileSync(file));
  assert.doesNotThrow(() => privacy.ensure(f.app));
  assert.deepEqual(files.map(file => fs.readFileSync(file)), original);
  const local = f.write('conversation-models/local.json', '{"name":' + JSON.stringify(legacy));
  const before = fs.readFileSync(local);
  assert.throws(() => privacy.ensure(f.app), /迁移未完成/);
  assert.deepEqual(fs.readFileSync(local), before);
  assert.equal(fs.existsSync(path.join(f.root, 'local-models.secure.json')), false);
});

test('malformed local session tails cannot publish a partial migration', t => {
  const f = fixture(t), file = f.archive([selection(legacy), assistant()]);
  fs.appendFileSync(file, '{"type":"message",');
  const before = fs.readFileSync(file);
  assert.throws(() => privacy.ensure(f.app), /迁移未完成/);
  assert.deepEqual(fs.readFileSync(file), before);
});

test('linked metadata directories and files never access or rewrite external targets', t => {
  const f = fixture(t, { seed: false }), outside = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-private-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, 'models.json'), JSON.stringify({ providers: { soduwork: { localOnly: true,
    baseUrl: provider.baseUrl, localRef: legacy, models: [{ id: model.name, localRef: legacy }] } } }));
  const original = fs.readFileSync(path.join(outside, 'models.json'));
  fs.symlinkSync(outside, path.join(f.root, 'pi-agent'), process.platform === 'win32' ? 'junction' : 'dir');
  fs.mkdirSync(path.join(f.root, 'conversation-models'));
  fs.linkSync(path.join(outside, 'models.json'), path.join(f.root, 'conversation-models', 'hardlink.json'));
  f.safeStorage.isEncryptionAvailable = () => false;
  assert.doesNotThrow(() => privacy.ensure(f.app));
  assert.deepEqual(fs.readFileSync(path.join(outside, 'models.json')), original);
  assert.deepEqual(fs.readdirSync(outside), ['models.json']);
  assert.equal(fs.existsSync(path.join(f.root, 'local-models.secure.json')), false);
});

test('symbolic links to individual metadata files are never followed', t => {
  const f = fixture(t, { seed: false }), outside = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-private-file-link-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const target = path.join(outside, 'local.json'), link = path.join(f.root, 'conversation-models', 'local.json');
  fs.writeFileSync(target, JSON.stringify({ name: legacy }));
  fs.mkdirSync(path.dirname(link));
  try { fs.symlinkSync(target, link, 'file'); }
  catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code))
      return t.skip('Windows does not grant file symbolic-link privileges; directory junctions and hard links are tested separately');
    throw error;
  }
  const before = fs.readFileSync(target);
  f.safeStorage.isEncryptionAvailable = () => false;
  assert.doesNotThrow(() => privacy.ensure(f.app));
  assert.deepEqual(fs.readFileSync(target), before);
  assert.equal(fs.existsSync(path.join(f.root, 'local-models.secure.json')), false);
});

test('later imported archives migrate and unavailable legacy identities remain encrypted tombstones', t => {
  const f = fixture(t, { seed: false });
  privacy.ensure(f.app);
  const retired = store.ref('retired', 'retired-synthetic-private-model');
  const file = f.archive([selection(retired), assistant('retired-synthetic-private-model')]);
  privacy.ensure(f.app);
  const id = rows(file)[0].data.name;
  assert.match(id, OPAQUE);
  assert.equal(rows(file)[1].message.model, id);
  assert.equal(store.resolve(id), null);
  assert.equal(store.resolve(retired), null);
  const catalog = fs.readFileSync(path.join(f.root, 'local-models.secure.json'), 'utf8');
  assert.equal(catalog.includes('retired-synthetic-private-model'), false);
  assert.equal(catalog.includes(retired), false);
});

test('already opaque metadata does not require decrypting a locked catalog during managed startup', t => {
  const f = fixture(t), id = store.get().myModels[0].id;
  const file = f.archive([{ type: 'model_change', provider: 'soduwork', modelId: id }, selection(id),
    assistant(id, { usageLocalOnly: true }), { type: 'custom', customType: 'soduwork.context-window',
      data: { key: 'soduwork|' + id, window: 4096 } }]);
  f.write('conversation-models/local.json', { name: id });
  f.write('conversation-runtime-segments/local.json', { version: 1, segments: [], active: { modelName: id },
    prefix: { messages: [{ usageModel: id, usageLocalOnly: true }], usageReceipts: [{ model: id, localOnly: true }] } });
  privacy.ensure(f.app);
  const before = fs.readFileSync(file), decrypt = f.safeStorage.decryptString;
  let decrypted = false;
  f.safeStorage.isEncryptionAvailable = () => false;
  f.safeStorage.decryptString = () => { decrypted = true; throw Error('Synthetic locked catalog'); };
  delete require.cache[require.resolve('../main/local-model-privacy.cjs')];
  const freshPrivacy = require('../main/local-model-privacy.cjs');
  assert.doesNotThrow(() => freshPrivacy.ensure(f.app));
  assert.equal(decrypted, false);
  assert.deepEqual(fs.readFileSync(file), before);
  f.safeStorage.decryptString = decrypt;
});

test('already normalized local runtime metadata does not publish a replacement on startup', t => {
  const f = fixture(t), id = store.get().myModels[0].id;
  const file = f.write('pi-agent/models.json', { providers: {
    soduwork: { localOnly: true, localRef: id, baseUrl: 'https://local-model.invalid/v1',
      apiKey: 'soduwork-local-no-key', models: [{ id, localRef: id, name: 'Local model' }] },
  } });
  const rename = fs.renameSync;
  fs.renameSync = () => { throw Object.assign(Error('Synthetic startup publication failure'), { code: 'EPERM' }); };
  try { assert.doesNotThrow(() => privacy.ensure(f.app)); }
  finally { fs.renameSync = rename; }
  assert.deepEqual(json(file), { providers: {
    soduwork: { localOnly: true, localRef: id, baseUrl: 'https://local-model.invalid/v1',
      apiKey: 'soduwork-local-no-key', models: [{ id, localRef: id, name: 'Local model' }] },
  } });
});

test('legacy runtime metadata can recover a local reference from the encrypted catalog', t => {
  const f = fixture(t);
  const file = f.write('pi-agent/models.json', { providers: {
    soduwork: { localOnly: true, baseUrl: provider.baseUrl,
      models: [{ id: model.name, name: model.label }] },
  } });
  privacy.ensure(f.app);
  const id = store.canonicalReference(legacy), migrated = json(file).providers.soduwork.models[0];
  assert.equal(migrated.id, id);
  assert.equal(migrated.localRef, id);
  assert.equal(migrated.name, 'Local model');
});

test('unchanged inspected archives avoid full reads while changed files and later imports are checked', t => {
  const f = fixture(t), file = f.archive([selection(legacy), assistant()]);
  privacy.ensure(f.app);
  privacy.ensure(f.app);
  const read = fs.readFileSync;
  let archiveReads = 0;
  fs.readFileSync = (target, ...options) => {
    if (target === file) archiveReads++;
    return read(target, ...options);
  };
  try {
    privacy.ensure(f.app);
    assert.equal(archiveReads, 0);
    fs.appendFileSync(file, JSON.stringify(selection(legacy)) + '\n');
    privacy.ensure(f.app);
    assert.ok(archiveReads > 0);
    assert.equal(rows(file).at(-1).data.name, store.canonicalReference(legacy));
    const imported = f.archive([selection(legacy)], 'pi-agent/sessions/imported/session.jsonl');
    privacy.ensure(f.app);
    assert.match(rows(imported)[0].data.name, OPAQUE);
  } finally { fs.readFileSync = read; }
});

test('a native append after inspection cannot be cached as already migrated', t => {
  const f = fixture(t), file = f.archive([selection('managed-model'), assistant()]), read = fs.readFileSync;
  let appended = false;
  fs.readFileSync = (target, ...options) => {
    const result = read(target, ...options);
    if (target === file && !appended) {
      appended = true;
      fs.appendFileSync(file, JSON.stringify(selection(legacy)) + '\n');
    }
    return result;
  };
  try { privacy.ensure(f.app); } finally { fs.readFileSync = read; }
  assert.equal(appended, true);
  assert.equal(rows(file).at(-1).data.name, legacy);
  privacy.ensure(f.app);
  assert.equal(rows(file).at(-1).data.name, store.canonicalReference(legacy));
});

test('confirmed local responses retain active ownership after future managed selection and sanitize error metadata', t => {
  const f = fixture(t), text = 'Preserved user content mentioning ' + provider.baseUrl;
  const response = assistant(model.name, { usageLocalOnly: true, responseId: 'completion-' + model.name,
    errorMessage: 'HTTP 401 synthetic-private-key at ' + provider.baseUrl + ' model ' + model.name,
    content: [{ type: 'text', text }, { type: 'toolCall', name: 'fixture', arguments: { model: model.name } }] });
  const managed = assistant(model.name, { usageLocalOnly: false, responseId: 'managed-response',
    errorMessage: 'Managed error', quotaUsageToken: 'synthetic-confirmed-token' });
  const file = f.archive([selection(legacy), selection('managed-model'), response, managed]);
  privacy.ensure(f.app);
  const migrated = rows(file), id = store.canonicalReference(legacy);
  assert.equal(migrated[2].message.model, id);
  assert.equal(migrated[2].message.responseModel, id);
  assert.equal('responseId' in migrated[2].message, false);
  assert.equal(migrated[2].message.errorMessage, require('../main/pi-session/local-model-runtime-privacy.cjs')
    .safeError(response.message.errorMessage));
  for (const sentinel of [provider.baseUrl, model.name, 'synthetic-private-key'])
    assert.equal(migrated[2].message.errorMessage.includes(sentinel), false);
  assert.deepEqual(migrated[2].message.content, response.message.content);
  assert.deepEqual(migrated[2].message.usage, response.message.usage);
  assert.equal(migrated[2].message.usageLocalOnly, true);
  assert.deepEqual(migrated[3], managed);
});

test('local ownership metadata is sufficient without a saved selection and ambiguous raw identities fail closed', t => {
  const f = fixture(t), response = assistant(model.name, { usageLocalOnly: true, responseId: 'local-' + model.name });
  const file = f.archive([selection('managed-model'), response]);
  privacy.ensure(f.app);
  assert.equal(rows(file)[1].message.model, store.canonicalReference(legacy));
  assert.equal('responseId' in rows(file)[1].message, false);
  const current = store.get();
  store.save({ providers: [...current.providers, { id: 'second', baseUrl: 'https://second-fixture.invalid/v1', authMode: 'none' }],
    models: [...current.myModels, { providerId: 'second', name: model.name }], expectedRevision: current.revision });
  const ambiguous = f.archive([selection(legacy), selection('managed-model'), response], 'pi-agent/sessions/ambiguous/session.jsonl');
  const before = fs.readFileSync(ambiguous);
  assert.throws(() => privacy.ensure(f.app), /迁移未完成/);
  assert.deepEqual(fs.readFileSync(ambiguous), before);
});
