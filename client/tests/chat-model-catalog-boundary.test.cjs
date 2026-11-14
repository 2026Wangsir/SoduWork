'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../components/panels/chat-composer-controls.js'), 'utf8');
const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  let owner = 'hub/device/alice', changed;
  const node = () => ({ hidden: true, dataset: {}, style: {}, handlers: new Map(), innerHTML: '', textContent: '',
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener(type, callback) { this.handlers.set(type, callback); },
    setAttribute() {}, removeAttribute() {}, focus() {}, contains: () => false, querySelector: () => null,
    getBoundingClientRect: () => ({ left: 200, right: 300, top: 500 }) });
  const queue = node(), pop = node(), button = node(), label = node(), wrap = node(), el = node(), field = node();
  pop.querySelector = () => field; button.querySelector = () => label;
  wrap.querySelector = selector => selector === 'button' ? button : selector === '.nmodel-pop' ? pop : null;
  el.querySelector = selector => selector === '#nchatQueue' ? queue : selector === '#nchatModel' ? wrap : null;
  const state = { ref: 'chat', adapterId: 'qwen', model: { id: 'selected', label: 'Selected' } };
  const requests = [], calls = [];
  const window = { ...node(), innerWidth: 1000, innerHeight: 800, SoduWorkModelChoice: require('../core/model-choice'),
    SoduWorkAPI: { taskStorageKey: () => owner, myModels: () => { const item = deferred(); requests.push(item); return item.promise; } },
    soduWorkAPI: { conversationSession: {
      runtimes: async () => ({ ok: true, runtimes: [{ id: 'pi', modelMode: 'managed' }, { id: 'qwen', modelMode: 'managed' }, { id: 'codex', modelMode: 'account' }, { id: 'claude', modelMode: 'account' }] }),
      runtimeModels: async id => { calls.push(id); return { models: [{ id: 'account-choice' }] }; },
      onModelsChanged: fn => { changed = fn; return () => {}; },
    } } };
  vm.runInNewContext(source, { window, SoduWorkModelChoice: window.SoduWorkModelChoice, document: node(), AbortController });
  const controls = window.ChatComposerControls.create(el, { state: () => state, say() {},
    modelAvailabilityChanged: selection => { state.selection = selection; } }); controls.render();
  return { state, requests, calls, field, label, controls, changed: () => changed(),
    owner: value => { owner = value; controls.render(); },
    open: () => button.handlers.get('click')(),
  };
}
const catalog = { usable: [{ name: 'managed', label: 'Managed choice' }, { name: 'local:private', localOnly: true, label: 'Private choice' }] };

test('existing local managed conversations show both model sources while committed cloud conversations exclude device models', async () => {
  for (const cloud of [false, true]) {
    const f = fixture(); if (cloud) f.state.cloudHandoff = { phase: 'committed' };
    f.controls.render();
    const pending = f.open(); await tick(); f.requests[0].resolve(catalog); await pending;
    assert.match(f.field.innerHTML, /Managed choice/);
    assert.equal(f.field.innerHTML.includes('Private choice'), !cloud);
  }
});

for (const id of ['codex', 'claude']) test('existing ' + id + ' conversations query only the account catalog', async () => {
  const f = fixture(); f.state.adapterId = id;
  f.controls.render();
  await f.open(); assert.deepEqual(f.calls, [id]); assert.equal(f.requests.length, 0);
  assert.match(f.field.innerHTML, /account-choice/);
  assert.doesNotMatch(f.field.innerHTML, /Private choice|Managed choice/);
});

test('late existing-chat model catalogs cannot overwrite a newer directory or another account', async () => {
  const f = fixture(); const first = f.open(); await tick(); f.changed(); await tick();
  f.requests[1].resolve({ usable: [{ name: 'fresh', label: 'Fresh' }] }); await tick();
  f.requests[0].resolve({ usable: [{ name: 'old', label: 'Old' }] }); await first;
  assert.match(f.field.innerHTML, /Fresh/); assert.doesNotMatch(f.field.innerHTML, />Old</);
  f.changed(); await tick(); f.owner('hub/device/bob');
  f.requests[2].resolve({ usable: [{ name: 'alice-private', label: 'Alice private' }] }); await tick();
  assert.doesNotMatch(f.field.innerHTML, /Alice private/);
  assert.equal(f.label.textContent, 'Selected');
});

test('a successful catalog removal marks the existing local selection unavailable without choosing its Hub default', async () => {
  const f = fixture(); f.state.selection = { name: 'local:private', model: { id: 'local:private', label: 'Private model', localOnly: true } };
  const opened = f.open(); await tick(); f.requests[0].resolve(catalog); await opened;
  assert.equal(f.state.selection.model.unavailable, undefined);
  f.changed(); await tick(); f.requests[1].reject(Error('Secure storage unavailable')); await tick();
  assert.equal(f.state.selection.model.unavailable, undefined, 'a failed lookup is not a deletion');
  f.changed(); await tick(); f.requests[2].resolve({ usable: [{ name: 'managed', label: 'Hub default' }] }); await tick();
  assert.equal(f.state.selection.name, 'local:private');
  assert.equal(f.state.selection.model.unavailable, true);
  assert.equal(f.state.selection.model.historicalLocal, true);
  assert.equal(f.label.textContent, '原本地模型已删除或不可用');
});

test('a catalog requested before an explicit model change cannot invalidate the new selection', async () => {
  const f = fixture(); f.state.selection = { name: 'local:old', model: { id: 'local:old', label: 'Old model' } };
  const opened = f.open(); await tick();
  f.state.selection = { name: 'local:new', model: { id: 'local:new', label: 'New model' } };
  f.requests[0].resolve({ usable: [{ name: 'managed', label: 'Hub model' }] }); await opened;
  assert.equal(f.state.selection.name, 'local:new');
  assert.equal(f.state.selection.model.unavailable, undefined);
  assert.equal(f.label.textContent, 'New model');
});

test('removing an active local image model preserves its qualified selection and displays an unavailable placeholder', async () => {
  const f = fixture(), reference = 'local:model-0123456789abcdef0123456789abcdef';
  const choice = 'image::private::' + reference;
  f.state.adapterId = 'pi';
  f.state.selection = { name: choice, model: { id: reference, label: 'Private image', modality: 'image', localOnly: true } };
  const opened = f.open(); await tick();
  f.requests[0].resolve({ usable: [], mediaUsable: { image: [{ providerId: 'device:private', name: reference, label: 'Private image', localOnly: true }] } });
  await opened;
  assert.equal(f.state.selection.model.unavailable, undefined);
  f.changed(); await tick(); f.requests[1].resolve({ usable: [{ name: 'managed', label: 'Hub model' }], mediaUsable: { image: [] } }); await tick();
  assert.equal(f.state.selection.name, choice);
  assert.equal(f.state.selection.model.id, reference);
  assert.equal(f.state.selection.model.unavailable, true);
  assert.equal(f.label.textContent, '原本地模型已删除或不可用');
});
