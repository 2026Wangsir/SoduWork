'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const renderer = require('./renderer-source.cjs');
const store = require('../main/local-model-store.cjs');

async function fixture(t, { collision = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-save-outcome-'));
  const timers = new Set();
  store.configure({ app: { getPath: () => root }, safeStorage: {
    isEncryptionAvailable: () => true, encryptString: text => Buffer.from(text),
    decryptString: bytes => bytes.toString(),
  } });
  t.after(() => { for (const timer of timers) clearTimeout(timer); store.configure(null); fs.rmSync(root, { recursive: true, force: true }); });
  store.save({ providers: [{ id: 'custom-private', name: 'Private service',
    baseUrl: 'http://127.0.0.1:1/v1', authMode: 'none' }],
  models: [{ providerId: 'custom-private', name: 'private-model' }] });
  const managedId = collision ? 'custom-private' : 'managed';
  const managed = { revision: 'hub-1', providers: [{ id: managedId, name: 'Managed service',
    baseUrl: 'https://fixture.invalid/v1', modelNames: [], personal: false }],
    myModels: collision ? [{ providerId: managedId, name: 'hub-model' }] : [],
    usable: collision ? [{ providerId: managedId, name: 'hub-model' }] : [] };
  const state = { failHubWrite: false, failHubRead: false, localInputs: [], hubInputs: [], probes: [], notices: [], gate: null };
  const values = new Map(), button = { disabled: false, textContent: '' }, field = { disabled: false };
  const body = { innerHTML: '', setAttribute() {}, removeAttribute() {}, querySelector: () => null,
    querySelectorAll: selector => selector === 'input,select,textarea,button' ? [field] : [] };
  const box = { URL, URLSearchParams, AbortController, Response, CustomEvent: class {}, structuredClone,
    __SODUWORK_TEST_HUB_CONFIG__: { allowSwitch: true },
    setTimeout: (...args) => { const timer = setTimeout(...args); timers.add(timer); return timer; },
    clearTimeout, setInterval: () => 0, navigator: { platform: 'test' },
    console: { log() {}, error() {} }, dispatchEvent() {}, addEventListener() {},
    localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)),
      removeItem: key => values.delete(key) },
    document: { getElementById: id => id === 'mdBody' ? body : id === 'mdSave' ? button : null },
    petSay: message => state.notices.push(message), _humanErr: (error, fallback) => error.message || fallback,
    esc: value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;'),
    soduWorkAPI: { localModels: { get: async () => store.get(), save: async input => {
      state.localInputs.push(structuredClone(input));
      if (state.gate) await state.gate;
      return store.save(input);
    } } },
    fetch: async (url, options = {}) => {
      if (options.method === 'POST') {
        state.probes.push({ url, body: JSON.parse(options.body) });
        return new Response('{"ok":true}');
      }
      if (options.method === 'PUT') {
        const input = JSON.parse(options.body); state.hubInputs.push(input);
        if (state.failHubWrite) throw Error('Synthetic Hub write failure');
        assert.equal(input.expectedRevision, managed.revision);
        managed.providers = input.providers; managed.myModels = input.models;
        managed.revision = 'hub-' + (Number(managed.revision.split('-')[1]) + 1);
        return new Response('{"ok":true}');
      }
      if (state.failHubRead) throw Error('Synthetic Hub read failure');
      return new Response(JSON.stringify(managed));
    },
  };
  box.window = box; vm.createContext(box);
  vm.runInContext(renderer.readFileSync(path.join(__dirname, '../api.js'), 'utf8'), box);
  for (const file of ['model-capabilities.js', 'model-catalog-editor.js', 'panels-models.js'])
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../components/panels', file), 'utf8'), box, { filename: file });
  const evaluate = source => vm.runInContext(source, box);
  await evaluate('_mdLoad()');
  return { state, box, button, field, body, evaluate, snapshot: () => store.get(),
    touch: (id, patch) => evaluate(`_mdTouchProvider(${JSON.stringify(id)}, ${JSON.stringify(patch)})`),
    async removeProvider(id) {
      let click;
      const target = { isConnected: true, getAttribute: () => id, addEventListener: (name, handler) => { click = handler; } };
      box.removeBox = { querySelectorAll: selector => selector === '[data-pdelete]' ? [target] : [] };
      evaluate('{ const save = _mdSave; _mdSave = (...args) => { window.removalResult = save(...args); return window.removalResult; }; }');
      evaluate('_mdBind(removeBox)'); click(); click();
      return box.removalResult;
    } };
}

test('a partial mixed save retains Hub edits and retries without rewriting committed local models', async t => {
  const f = await fixture(t);
  f.touch('managed', { baseUrl: 'https://edited.fixture.invalid/v1' });
  f.touch('device:custom-private', { name: 'Saved local edit' });
  f.state.failHubWrite = true;
  assert.equal(await f.evaluate('_mdSave(false)'), false);
  assert.equal(f.snapshot().providers[0].name, 'Saved local edit');
  assert.equal(f.snapshot().revision, 2);
  assert.equal(f.evaluate('_mdData.localRevision'), 2);
  assert.equal(f.evaluate('_mdLocalDirty'), false);
  assert.equal(f.evaluate('_mdManagedDirty'), true);
  assert.equal(f.evaluate('_mdProvider("managed").baseUrl'), 'https://edited.fixture.invalid/v1');
  assert.ok(f.state.notices.includes('本地模型配置已保存，Hub 模型配置未保存，请重试。'));
  f.state.failHubWrite = false;
  assert.equal(await f.evaluate('_mdSave(false)'), true);
  assert.equal(f.state.localInputs.length, 1, 'retry must not replay the already committed local revision');
  assert.equal(f.state.hubInputs.length, 2);
  assert.equal(f.evaluate('_mdManagedDirty'), false);
  assert.equal(JSON.stringify(f.state.hubInputs).includes('custom-private'), false);
});

test('same-ID local and Hub providers keep distinct catalog, edits, and deletions', async t => {
  const f = await fixture(t, { collision: true });
  const api = f.box.SoduWorkAPI, catalog = await api.myModels();
  assert.deepEqual(Array.from(catalog.providers, row => row.id), ['device:custom-private', 'custom-private']);
  assert.equal(catalog.providers[0].localProviderId, 'custom-private');
  assert.equal(catalog.usable.find(row => row.localOnly).providerId, 'device:custom-private');
  assert.match(catalog.usable.find(row => row.localOnly).name, /^local:model-[a-f0-9]{32}$/);
  assert.equal(catalog.usable.find(row => !row.localOnly).name, 'hub-model');
  await assert.rejects(api.saveMyModels({ keys: { 'custom-private': 'ambiguous-secret' } }), /来源不明确/);
  assert.equal(f.state.localInputs.length, 0); assert.equal(f.state.hubInputs.length, 0);
  f.touch('device:custom-private', { name: 'Private edit', baseUrl: 'http://127.0.0.1:2/v1' });
  f.touch('custom-private', { baseUrl: 'https://edited.fixture.invalid/v1' });
  assert.equal(await f.evaluate('_mdSave(false)'), true);
  assert.equal(f.snapshot().providers[0].id, 'custom-private');
  assert.equal(f.snapshot().providers[0].name, 'Private edit');
  assert.equal(f.state.hubInputs[0].providers[0].id, 'custom-private');
  assert.equal(f.state.hubInputs[0].models[0].name, 'hub-model');
  assert.doesNotMatch(JSON.stringify(f.state.hubInputs), /device:|local:model-|127\.0\.0\.1:2|Private edit|private-model/);
  assert.equal(await f.removeProvider('device:custom-private'), true);
  assert.equal(f.snapshot().providers.length, 0);
  const remaining = await api.myModels();
  assert.equal(remaining.providers.length, 1); assert.equal(remaining.providers[0].id, 'custom-private');
  assert.equal(remaining.myModels[0].name, 'hub-model');
});

test('same-ID provider probes and explicit key patches use their declared ownership', async t => {
  const f = await fixture(t, { collision: true }), api = f.box.SoduWorkAPI, localProbes = [];
  f.box.soduWorkAPI.localModels.test = async (providerId, model) => { localProbes.push({ providerId, model }); return { ok: true }; };
  await assert.rejects(api.testMyModel('custom-private'), /来源不明确/);
  await assert.rejects(api.checkMyModelCapabilities({ providerId: 'custom-private', model: 'private-model' }), /来源不明确/);
  assert.equal(f.state.probes.length, 0); assert.equal(localProbes.length, 0);
  await api.testMyModel('device:custom-private');
  await api.checkMyModelCapabilities({ providerId: 'device:custom-private', model: 'private-model' });
  assert.equal(localProbes.length, 2); assert.equal(localProbes[0].providerId, 'custom-private');
  assert.equal(f.state.probes.length, 0);
  await api.testMyModel('custom-private', { localOnly: false });
  await api.checkMyModelCapabilities({ providerId: 'custom-private', localOnly: false, model: 'hub-model' });
  assert.equal(f.state.probes.length, 2);
  assert.doesNotMatch(JSON.stringify(f.state.probes), /device:|private-model/);
  const catalog = await api.myModels();
  await api.saveMyModels({ providers: catalog.providers, models: catalog.myModels, expectedRevision: catalog.revision,
    localProviders: catalog.providers.filter(row => row.localOnly), localModels: catalog.myModels.filter(row => row.localOnly),
    keys: { 'custom-private': 'hub-secret' }, localKeys: { 'device:custom-private': 'device-secret' }, localRevision: catalog.localRevision });
  assert.equal(f.state.localInputs.at(-1).keys['custom-private'], 'device-secret');
  assert.equal(f.state.hubInputs.at(-1).keys['custom-private'], 'hub-secret');
  assert.doesNotMatch(JSON.stringify(f.state.hubInputs), /device-secret|device:|local:model-/);
});

test('deleting the last local service never sends its removal key to a later managed save', async t => {
  const f = await fixture(t);
  f.touch('managed', { baseUrl: 'https://edited.fixture.invalid/v1' });
  assert.equal(await f.removeProvider('device:custom-private'), true);
  assert.equal(f.snapshot().providers.length, 0);
  assert.equal(f.state.localInputs.length, 1);
  assert.equal(f.state.hubInputs.length, 1);
  assert.equal(JSON.stringify(f.state.hubInputs).includes('custom-private'), false);
});

test('last-provider deletion survives a failed Hub reload and keeps local editing usable', async t => {
  const f = await fixture(t);
  f.state.failHubRead = true;
  assert.equal(await f.removeProvider('device:custom-private'), true);
  assert.equal(f.snapshot().providers.length, 0);
  assert.equal(f.evaluate('_mdData.localRevision'), 2);
  assert.equal(f.evaluate('_mdData.usable.length'), 0);
  assert.equal(f.evaluate('_mdLoadState'), 'ready');
  assert.equal(f.evaluate('_mdDirty'), false);
  assert.doesNotMatch(f.body.innerHTML, /data-md-load-error/);
  assert.ok(f.state.notices.includes('模型配置已保存，但模型清单刷新失败，请重新打开模型页面。'));
  f.evaluate('_mdAddService()');
  const id = f.evaluate('_mdNew.id');
  f.touch(id, { name: 'Replacement local', baseUrl: 'http://127.0.0.1:2/v1', authMode: 'none' });
  assert.equal(await f.evaluate('_mdSave(false)'), true);
  assert.equal(f.snapshot().providers[0].name, 'Replacement local');
  assert.equal(f.state.hubInputs.length, 0);
});

test('pending local persistence disables edits and joins reentrant saves without losing a later edit', async t => {
  const f = await fixture(t);
  let release;
  f.state.gate = new Promise(resolve => { release = resolve; });
  f.touch('device:custom-private', { name: 'First explicit edit' });
  const first = f.evaluate('_mdSave(false)'), second = f.evaluate('_mdSave(false)');
  assert.equal(f.button.disabled, true);
  assert.equal(f.field.disabled, true);
  for (let i = 0; !f.state.localInputs.length && i < 20; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.state.localInputs.length, 1);
  f.touch('device:custom-private', { name: 'Unaccepted in-flight event' });
  assert.equal(f.evaluate('_mdProvider("device:custom-private").name'), 'First explicit edit');
  release();
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(f.state.localInputs.length, 1);
  assert.equal(f.field.disabled, false);
  f.touch('device:custom-private', { name: 'Second explicit edit' });
  assert.equal(await f.evaluate('_mdSave(false)'), true);
  assert.equal(f.snapshot().providers[0].name, 'Second explicit edit');
  assert.equal(f.snapshot().revision, 3);
});

test('a committed local save stays successful when catalog rendering fails', async t => {
  const f = await fixture(t);
  f.touch('device:custom-private', { name: 'Persisted before render failure' });
  f.evaluate('_mdRender = () => { throw Error("Synthetic rendering failure"); }');
  assert.equal(await f.evaluate('_mdSave(false)'), true);
  assert.equal(f.snapshot().providers[0].name, 'Persisted before render failure');
  assert.equal(f.evaluate('_mdLocalDirty'), false);
  assert.ok(f.state.notices.includes('模型配置已保存，但模型清单刷新失败，请重新打开模型页面。'));
});

for (const change of ['hub', 'panel']) test(`a ${change} switch during local persistence cannot send the old managed draft`, async t => {
  const f = await fixture(t);
  let release;
  f.state.gate = new Promise(resolve => { release = resolve; });
  f.touch('managed', { baseUrl: 'https://previous.fixture.invalid/v1' });
  f.touch('device:custom-private', { name: 'Local edit' });
  const saved = f.evaluate('_mdSave(false)');
  for (let i = 0; !f.state.localInputs.length && i < 20; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.state.localInputs.length, 1);
  if (change === 'hub') f.box.SoduWorkAPI.setHubEnvironment('development', 'http://127.0.0.1:9876');
  else f.evaluate('closeModelsPanel()');
  release();
  assert.equal(await saved, false);
  assert.equal(f.snapshot().providers[0].name, 'Local edit');
  assert.equal(f.state.hubInputs.length, 0);
});
