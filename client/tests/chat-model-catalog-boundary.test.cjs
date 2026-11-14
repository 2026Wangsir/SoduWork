'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../components/panels/chat-composer-controls.js'), 'utf8');
const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(settings = {}) {
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
  const requests = [], calls = [], selections = [];
  const window = { ...node(), innerWidth: 1000, innerHeight: 800, SoduWorkModelChoice: require('../core/model-choice'),
    SoduWorkAPI: { taskStorageKey: () => owner, myModels: () => { const item = deferred(); requests.push(item); return item.promise; } },
    soduWorkAPI: { conversationSession: {
      runtimes: async () => ({ ok: true, runtimes: [{ id: 'pi', modelMode: 'managed' }, { id: 'qwen', modelMode: 'managed' }, { id: 'codex', modelMode: 'account' }, { id: 'claude', modelMode: 'account' }] }),
      runtimeModels: async id => { calls.push(id); return { models: [{ id: 'account-choice' }] }; },
      selectModel: async (ref, name) => { selections.push({ ref, name });
        if (settings.selectModel) return settings.selectModel(ref, name);
        return { ok: true, selection: { name, model: { id: name, label: name } } }; },
      onModelsChanged: fn => { changed = fn; return () => {}; },
    } } };
  vm.runInNewContext(source, { window, SoduWorkModelChoice: window.SoduWorkModelChoice, document: node(), AbortController });
  const controls = window.ChatComposerControls.create(el, { state: () => state, say() {},
    modelSelected: selection => { state.selection = selection; },
    modelAvailabilityChanged: selection => { state.selection = selection; } }); controls.render();
  return { state, requests, calls, selections, field, label, controls, changed: () => changed(),
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
  assert.equal(f.label.textContent, 'fresh');
});

test('a confirmed local model deletion selects the first usable replacement but storage failure does not', async () => {
  const f = fixture(); f.state.selection = { name: 'local:private', model: { id: 'local:private', label: 'Private model', localOnly: true } };
  const opened = f.open(); await tick(); f.requests[0].resolve(catalog); await opened;
  assert.equal(f.state.selection.model.unavailable, undefined);
  f.changed(); await tick(); f.requests[1].reject(Error('Secure storage unavailable')); await tick();
  assert.equal(f.state.selection.model.unavailable, undefined, 'a failed lookup is not a deletion');
  f.changed(); await tick(); f.requests[2].resolve({ usable: [{ name: 'managed', label: 'Hub default' }] }); await tick();
  assert.equal(f.state.selection.name, 'managed');
  assert.equal(f.state.selection.model.unavailable, undefined);
  assert.deepEqual(f.selections, [{ ref: 'chat', name: 'managed' }]);
  assert.equal(f.label.textContent, 'Hub default');
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

test('removing an active local image model selects an available replacement through normal IPC', async () => {
  const f = fixture(), reference = 'local:model-0123456789abcdef0123456789abcdef';
  const choice = 'image::private::' + reference;
  f.state.adapterId = 'pi';
  f.state.selection = { name: choice, model: { id: reference, label: 'Private image', modality: 'image', localOnly: true } };
  const opened = f.open(); await tick();
  f.requests[0].resolve({ usable: [], mediaUsable: { image: [{ providerId: 'device:private', name: reference, label: 'Private image', localOnly: true }] } });
  await opened;
  assert.equal(f.state.selection.model.unavailable, undefined);
  f.changed(); await tick(); f.requests[1].resolve({ usable: [{ name: 'managed', label: 'Hub model' }], mediaUsable: { image: [] } }); await tick();
  assert.equal(f.state.selection.name, 'managed');
  assert.equal(f.state.selection.model.id, 'managed');
  assert.equal(f.state.selection.model.unavailable, undefined);
  assert.equal(f.label.textContent, 'Hub model');
});

test('sending refreshes the directory and replaces a removed choice with the first local model', async () => {
  const f = fixture();
  f.state.selection = { name: 'managed', model: { id: 'managed', label: 'Managed' } };
  const opened = f.open(); await tick(); f.requests[0].resolve(catalog); await opened;
  assert.deepEqual(f.selections, [], 'A valid current choice stays selected');
  const ready = f.controls.waitForAccess(); await tick();
  f.requests[1].resolve({ usable: [{ name: 'hub-other' }, { name: 'local:first', localOnly: true },
    { name: 'local:second', localOnly: true }] });
  assert.equal(await ready, true);
  assert.deepEqual(f.selections, [{ ref: 'chat', name: 'local:first' }]);
  assert.equal(f.state.selection.name, 'local:first');
});

test('an existing conversation without a selected model chooses the first local row instead of a Hub default', async () => {
  const f = fixture(); f.state.model = null; f.state.selection = { name: '' };
  const pending = f.controls.waitForAccess(); await tick();
  f.requests[0].resolve({ usable: [{ name: 'hub' }, { name: 'local:first', localOnly: true },
    { name: 'local:second', localOnly: true }], defaultModels: { qwen: 'hub' } });
  assert.equal(await pending, true);
  assert.equal(f.state.selection.name, 'local:first');
  assert.deepEqual(f.selections, [{ ref: 'chat', name: 'local:first' }]);
});

test('rendering a restored conversation without a model displays its first available model before Send', async () => {
  const f = fixture(); f.state.model = null; f.state.selection = { name: '' }; f.controls.render(); await tick();
  assert.equal(f.requests.length, 1);
  f.requests[0].resolve(catalog); await tick();
  assert.equal(f.state.selection.name, 'local:private');
  assert.equal(f.label.textContent, 'Private choice');
});

test('partial and rejected catalogs preserve an absent Hub choice while local offline choices remain available', async () => {
  const f = fixture(); f.state.selection = { name: 'hub', model: { id: 'hub', label: 'Hub' } };
  const partial = { usable: [{ name: 'local:first', localOnly: true }], managedCatalogUnavailable: true };
  let pending = f.controls.waitForAccess(); await tick(); f.requests[0].resolve(partial);
  assert.equal(await pending, false); assert.equal(f.state.selection.name, 'hub'); assert.deepEqual(f.selections, []);
  pending = f.controls.waitForAccess(); await tick(); f.requests[1].resolve({ ok: false, usable: partial.usable });
  assert.equal(await pending, false); assert.equal(f.state.selection.name, 'hub'); assert.deepEqual(f.selections, []);
  f.state.selection = { name: 'local:first', model: { id: 'local:first' } };
  pending = f.controls.waitForAccess(); await tick(); f.requests[2].resolve(partial);
  assert.equal(await pending, true); assert.deepEqual(f.selections, []);
  f.state.selection = { name: '' }; f.state.model = null;
  pending = f.controls.waitForAccess(); await tick(); f.requests[3].resolve(partial);
  assert.equal(await pending, true); assert.equal(f.state.selection.name, 'local:first');
});

test('a same-scope directory refresh preserves the pending IPC acknowledgement but blocks stale send readiness', async () => {
  const request = deferred(), f = fixture({ selectModel: () => request.promise });
  const pending = f.controls.waitForAccess(); await tick(); f.requests[0].resolve(catalog); await tick();
  f.changed(); await tick(); f.requests[1].resolve(catalog); await tick();
  request.resolve({ ok: true, selection: { name: 'local:private', model: { id: 'local:private' } } });
  assert.equal(await pending, false);
  assert.equal(f.state.selection.name, 'local:private');
  assert.equal(f.selections.length, 1);
});

test('a delayed automatic choice cannot overwrite a newer explicit choice or a different owner', async () => {
  for (const changeOwner of [false, true]) {
    const request = deferred(), f = fixture({ selectModel: () => request.promise });
    const pending = f.controls.waitForAccess(); await tick(); f.requests[0].resolve(catalog); await tick();
    f.state.selection = { name: 'new-choice', model: { id: 'new-choice' } };
    if (changeOwner) f.owner('hub/device/bob');
    request.resolve({ ok: true, selection: { name: 'local:private', model: { id: 'local:private' } } });
    assert.equal(await pending, false);
    assert.equal(f.state.selection.name, 'new-choice');
  }
});

test('sending fails closed on a storage error and an empty confirmed catalog without changing the saved choice', async () => {
  const f = fixture();
  f.state.selection = { name: 'local:private', model: { id: 'local:private', label: 'Private' } };
  const failed = f.controls.waitForAccess(); await tick(); f.requests[0].reject(Error('Secure storage unavailable'));
  assert.equal(await failed, false); assert.deepEqual(f.selections, []);
  assert.equal(f.state.selection.name, 'local:private');
  const empty = f.controls.waitForAccess(); await tick(); f.requests[1].resolve({ usable: [] });
  assert.equal(await empty, false); assert.deepEqual(f.selections, []);
  assert.equal(f.state.selection.model.unavailable, true);
  const restored = f.controls.waitForAccess(); await tick();
  f.requests[2].resolve({ usable: [{ name: 'local:first' }, { name: 'local:private', localOnly: true }] });
  assert.equal(await restored, true);
  assert.equal(f.state.selection.name, 'local:private', 'A restored current model stays selected even when it is not first');
  assert.equal(f.state.selection.model.unavailable, undefined);
  assert.deepEqual(f.selections, [{ ref: 'chat', name: 'local:private' }]);
});
