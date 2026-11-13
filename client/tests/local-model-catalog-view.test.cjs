'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const store = require('../main/local-model-store.cjs');

function localCatalog(names = ['shared-model']) {
  return store.publicCatalog(store.normalize({
    providers: [{ id: 'local-fixture', name: 'Local fixture', baseUrl: 'http://127.0.0.1:1/v1', authMode: 'none' }],
    models: names.map(name => ({ providerId: 'local-fixture', name, label: name })), keys: {},
  }));
}

function fixture(catalog = localCatalog()) {
  const messages = [];
  const context = { URL, structuredClone, setTimeout, clearTimeout, addEventListener() {},
    document: { getElementById: () => null }, petSay: message => messages.push(message),
    esc: value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;'),
    catalog: structuredClone(catalog) };
  context.window = context;
  vm.createContext(context);
  for (const file of ['model-capabilities.js', 'model-catalog-editor.js', 'panels-models.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../components/panels', file), 'utf8'), context, { filename: file });
  }
  const evaluate = source => vm.runInContext(source, context);
  evaluate('_mdData = catalog; _mdMyModels = catalog.myModels.slice();');
  return { context, messages, evaluate,
    detail: (id = 'local-fixture') => evaluate(`_mdDetailHtml(_mdProvider(${JSON.stringify(id)}))`),
    nav: (id = 'local-fixture') => evaluate(`_mdNavItemHtml(_mdProvider(${JSON.stringify(id)}))`),
    apply({ provider = 'local-fixture', original, name, label = name, connected = true }) {
      if (original) evaluate(`_mdDrafts.set(${JSON.stringify(provider)}, {original:${JSON.stringify(original)}});`);
      const values = { '[data-padd]': name, '[data-paddtype]': 'chat', '[data-mdlabel]': label };
      context.editor = { isConnected: connected, dataset: { mdeditor: provider }, querySelector: selector => ({ value: values[selector] || '' }) };
      evaluate('_mdApplyModel(editor)');
    } };
}
const rows = html => (html.match(/<article class="md-model-row/g) || []).length;

function removal(f, attribute, value) {
  const handlers = new Map();
  const button = { isConnected: true, getAttribute: name => name === attribute ? value : null,
    addEventListener: (name, handler) => handlers.set(name, handler) };
  f.context.saves = [];
  f.context.box = { querySelectorAll: selector => selector === '[' + attribute + ']' ? [button] : [], querySelector: () => null };
  f.evaluate('_mdSave = async () => { saves.push(JSON.stringify(_mdPayload())); return true; }; _mdBind(box);');
  return { button, click: () => handlers.get('click')() };
}

test('a saved local model is counted once and remains editable despite its catalog mirror', () => {
  const catalog = localCatalog(), before = JSON.stringify(catalog), f = fixture(catalog);
  assert.equal(catalog.providers[0].modelDefs.length, 1, 'execution consumers retain their existing catalog');
  assert.equal(catalog.usable.length, 1);
  assert.equal(catalog.myModels.length, 1);
  assert.match(f.nav(), /1 模型/);
  assert.match(f.detail(), /模型数量<\/small><b>1 个/);
  assert.equal(rows(f.detail()), 1);
  assert.equal((f.detail().match(/data-mdedit=/g) || []).length, 1);
  assert.doesNotMatch(f.detail(), /组织管理/);
  assert.equal(JSON.stringify(catalog), before, 'presentation does not rewrite persisted or execution catalogs');
});

test('canonical built-in provider names are localizable while renamed providers remain user content', () => {
  const f = fixture();
  f.evaluate(`_mdData.providers.push(
    {id:'volcengine', name:'字节跳动 · 火山引擎方舟', builtin:true, baseUrl:'https://ark.example/v1', modelNames:[]},
    {id:'company-gateway', name:'公司网关', builtin:true, baseUrl:'https://gateway.example/v1', modelNames:[]}
  ); _mdOpen = 'volcengine';`);
  assert.match(f.nav('volcengine'), /data-i18n="字节跳动 · 火山引擎方舟"/);
  assert.doesNotMatch(f.nav('volcengine'), /data-user-content/);
  assert.match(f.detail('volcengine'), /data-i18n="字节跳动 · 火山引擎方舟"/);
  assert.match(f.nav('company-gateway'), /data-user-content/);
  assert.doesNotMatch(f.nav('company-gateway'), /data-i18n=/);
});

test('editing a local model without changing its ID does not collide with its saved mirror', () => {
  const f = fixture();
  f.apply({ original: 'shared-model', name: 'shared-model', label: 'Edited local label' });
  assert.deepEqual(f.messages, []);
  assert.equal(f.evaluate('_mdMyModels.length'), 1);
  assert.equal(f.evaluate('_mdMyModels[0].label'), 'Edited local label');
  assert.match(f.detail(), /Edited local label/);
  assert.equal(rows(f.detail()), 1);
});

test('renaming a local model replaces its visible ID and leaves no stale read-only row', () => {
  const f = fixture();
  f.apply({ original: 'shared-model', name: 'renamed-model' });
  assert.deepEqual(f.messages, []);
  assert.equal(f.evaluate('_mdMyModels[0].name'), 'renamed-model');
  assert.equal(rows(f.detail()), 1);
  assert.doesNotMatch(f.detail(), /shared-model/);
  assert.match(f.nav(), /1 模型/);
});

test('removing the editable local row immediately removes its saved mirror from the view', () => {
  const f = fixture();
  f.evaluate('_mdMyModels.splice(0, 1)');
  assert.equal(rows(f.detail()), 0);
  assert.match(f.nav(), /0 模型/);
  assert.doesNotMatch(f.detail(), /shared-model|组织管理/);
});

test('legacy local modelNames are mirrors rather than extra organization-owned rows', () => {
  const catalog = localCatalog();
  delete catalog.providers[0].modelDefs;
  const f = fixture(catalog);
  assert.equal(rows(f.detail()), 1);
  assert.match(f.nav(), /1 模型/);
  f.evaluate('_mdMyModels = []');
  assert.equal(rows(f.detail()), 0);
});

test('a no-key local service can discover its first model without a manual model ID', async () => {
  const provider = { id: 'legacy-local', name: 'Legacy local', baseUrl: 'http://127.0.0.1:8686/v1',
    authMode: 'none', localOnly: false, modelNames: [] };
  const catalog = { providers: [provider], myModels: [], usable: [], mediaUsable: {} };
  const f = fixture(catalog);
  const calls = [];
  let pickerRefreshes = 0;
  f.context.ComposeModelPicker = { refresh: async () => { pickerRefreshes++; } };
  f.context.SoduWorkAPI = {
    testMyModel: async id => { calls.push(id); return { ok: true, models: ['qwen3'], detail: '连接通过，已读取模型列表' }; },
    myModels: async () => ({ providers: [provider], myModels: [{ providerId: provider.id, name: 'qwen3', label: 'qwen3', localOnly: true }], usable: [], mediaUsable: {} }),
  };
  await f.evaluate('_mdDoTest({ getAttribute: () => "legacy-local" })');
  assert.deepEqual(calls, ['legacy-local']);
  assert.equal(f.evaluate('_mdTest["legacy-local"].state'), 'ok');
  assert.equal(f.evaluate('_mdMyModels[0].name'), 'qwen3');
  assert.equal(pickerRefreshes, 1);
});

test('an incomplete local catalog fails loading instead of promoting mirrored definitions', async () => {
  const f = fixture(), incomplete = localCatalog();
  delete incomplete.myModels;
  const body = { innerHTML: '', setAttribute() {}, removeAttribute() {} };
  f.context.document.getElementById = id => id === 'mdBody' ? body : null;
  f.context.SoduWorkAPI = { myModels: async () => incomplete };
  f.evaluate('_mdData = null; _mdMyModels = []');
  assert.equal(await f.context._mdLoad(), false);
  assert.match(body.innerHTML, /data-md-load-error/);
  assert.equal(rows(body.innerHTML), 0);
  assert.equal(f.evaluate('_mdMyModels.length'), 0);
  assert.equal(incomplete.providers[0].modelDefs.length, 1, 'the original catalog is left untouched');
});

test('the local ownership rule covers chat, image and video models', () => {
  const catalog = store.publicCatalog(store.normalize({ providers: [{ id: 'local-fixture',
    baseUrl: 'http://127.0.0.1:1/v1', authMode: 'none' }], models: ['chat', 'image', 'video'].map(modality =>
      ({ providerId: 'local-fixture', name: modality + '-model', modality })), keys: {} }));
  const f = fixture(catalog);
  assert.equal(rows(f.detail()), 3);
  assert.match(f.nav(), /3 模型/);
  assert.equal((f.detail().match(/data-mdedit=/g) || []).length, 3);
});

test('matching names in another local service or Hub ownership remain separate models', () => {
  const catalog = localCatalog();
  const second = store.publicCatalog(store.normalize({ providers: [{ id: 'local-second',
    baseUrl: 'http://127.0.0.1:2/v1', authMode: 'none' }], models: [{ providerId: 'local-second', name: 'shared-model' }], keys: {} }));
  catalog.providers.push(...second.providers, { id: 'hub-provider', name: 'Hub provider', personal: true,
    baseUrl: 'https://fixture.invalid/v1', myKeySet: true,
    modelDefs: [{ name: 'shared-model', label: 'Organization model' }], modelNames: ['shared-model'] });
  catalog.myModels.push(...second.myModels, { providerId: 'hub-provider', name: 'shared-model', label: 'Hub personal model' });
  const f = fixture(catalog);
  assert.equal(rows(f.detail()), 1);
  assert.equal(rows(f.detail('local-second')), 1);
  assert.equal(rows(f.detail('hub-provider')), 2, 'different owners are not deduplicated by ID or display name');
  assert.match(f.detail('hub-provider'), /Organization model/);
  assert.match(f.detail('hub-provider'), /Hub personal model/);
  assert.match(f.detail('hub-provider'), /组织管理/);
  assert.match(f.nav('hub-provider'), /2 模型/);
});

test('genuine duplicate local IDs still reject additions and renames within the same provider', () => {
  const f = fixture(localCatalog(['first', 'second']));
  f.apply({ name: 'first' });
  f.apply({ original: 'second', name: 'first' });
  assert.deepEqual(f.messages, ['这个模型已经在清单里了', '这个模型已经在清单里了']);
  assert.equal(f.evaluate('JSON.stringify(_mdMyModels.map(model => model.name))'), '["first","second"]');
});

test('Hub catalog definitions still prevent colliding personal edits', () => {
  const f = fixture({ providers: [{ id: 'managed', personal: true, baseUrl: 'https://fixture.invalid/v1',
    modelDefs: [{ name: 'managed-model' }], modelNames: ['managed-model'] }],
  myModels: [{ providerId: 'managed', name: 'custom-model' }], usable: [] });
  f.apply({ provider: 'managed', original: 'custom-model', name: 'managed-model' });
  assert.deepEqual(f.messages, ['这个模型已经在清单里了']);
  assert.equal(f.evaluate('_mdMyModels[0].name'), 'custom-model');
});

test('removing the model being edited clears only its edit draft before saving', async () => {
  const f = fixture();
  f.evaluate('_mdDrafts.set("local-fixture", {original:"shared-model", model:{name:"shared-model"}}); _mdDrafts.set("other-provider", {original:"other-model"});');
  await removal(f, 'data-mdel', 'local-fixture|0').click();
  assert.equal(f.evaluate('_mdDrafts.has("local-fixture")'), false);
  assert.equal(f.evaluate('_mdDrafts.has("other-provider")'), true);
  assert.equal(f.evaluate('_mdMyModels.length'), 0);
  assert.doesNotMatch(f.detail(), /shared-model|应用修改/);
  assert.equal(JSON.parse(f.context.saves[0]).models.length, 0);
});

test('removing another model preserves the current edit draft and its unsaved fields', async () => {
  const f = fixture(localCatalog(['first', 'second']));
  f.evaluate('_mdDrafts.set("local-fixture", {original:"second", fields:{"[data-mdlabel]":"Retained draft"}});');
  await removal(f, 'data-mdel', 'local-fixture|0').click();
  assert.equal(f.evaluate('_mdDrafts.get("local-fixture").original'), 'second');
  assert.equal(f.evaluate('_mdDrafts.get("local-fixture").fields["[data-mdlabel]"]'), 'Retained draft');
  f.apply({ original: 'second', name: 'second', label: 'Retained draft' });
  assert.equal(f.evaluate('_mdMyModels[0].label'), 'Retained draft');
  assert.equal(f.evaluate('_mdMyModels.length'), 1);
});

test('confirmed provider removal clears that provider draft without clearing other drafts', async () => {
  const f = fixture();
  f.evaluate('_mdDrafts.set("local-fixture", {original:"shared-model"}); _mdDrafts.set("other-provider", {original:"other-model"});');
  const action = removal(f, 'data-pdelete', 'local-fixture');
  await action.click(); assert.equal(f.evaluate('_mdDrafts.has("local-fixture")'), true, 'confirmation has not deleted anything');
  await action.click();
  assert.equal(f.evaluate('_mdDrafts.has("local-fixture")'), false);
  assert.equal(f.evaluate('_mdDrafts.has("other-provider")'), true);
  assert.equal(f.evaluate('_mdData.providers.length'), 0);
  assert.equal(f.evaluate('_mdMyModels.length'), 0);
});

test('a detached editor cannot add a row after its previous draft was removed', () => {
  const f = fixture(); f.evaluate('_mdMyModels = []; _mdDrafts.clear();');
  f.apply({ name: 'shared-model', connected: false });
  assert.equal(f.evaluate('_mdMyModels.length'), 0);
});

test('an edit whose original model or provider disappeared cannot turn into an addition', () => {
  const f = fixture(); f.evaluate('_mdMyModels = [];');
  f.apply({ original: 'shared-model', name: 'shared-model' });
  assert.equal(f.evaluate('_mdMyModels.length'), 0);
  f.evaluate('_mdData.providers = []; _mdDrafts.clear();');
  f.apply({ name: 'new-model' });
  assert.equal(f.evaluate('_mdMyModels.length'), 0);
});

test('detached removal buttons cannot delete a replacement row at an old index', async () => {
  const f = fixture(localCatalog(['first', 'second']));
  const action = removal(f, 'data-mdel', 'local-fixture|0');
  action.button.isConnected = false;
  await action.click();
  assert.equal(f.evaluate('_mdMyModels.length'), 2);
  assert.equal(f.context.saves.length, 0);
});
