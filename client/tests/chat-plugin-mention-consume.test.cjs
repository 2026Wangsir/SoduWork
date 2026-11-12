'use strict';
/* Follow-up-turn semantics regression (second round in one session): after a successful send, consume
   keeps workflow plugins selected while plain plugins stay one-shot; the all-kept case must not
   replace a pending restored draft. */
const test = require('node:test');
const assert = require('node:assert/strict');

/* Minimal DOM stub: create() only needs the createElement/host/insertBefore/input skeleton. */
function makeElement() {
  const el = {
    className: '', hidden: false, textContent: '', innerHTML: '', title: '',
    dataset: {}, style: {}, children: [],
    ownerDocument: null,
    setAttribute() {}, getAttribute() { return ''; }, removeAttribute() {},
    addEventListener() {}, removeEventListener() {},
    append() {}, appendChild() {}, insertBefore() {}, removeChild() {},
    replaceChildren() {},
    contains() { return true; },
    remove() {}, focus() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    closest() { return null; },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
  };
  return el;
}

global.window = {
  addEventListener() {}, removeEventListener() {},
};
global.document = {
  createElement() { return makeElement(); },
  addEventListener() {}, removeEventListener() {},
};
global.Event = class { constructor(type) { this.type = type; } };

const mention = require('../components/panels/chat-plugin-mention');

const input = makeElement();
input.ownerDocument = { defaultView: null };
const host = makeElement();

const catalogItems = () => ({ items: [
  {
    pluginId: 'local:wf-doc', name: '文档流水线', installed: true, personal: true,
    workflow: [{ key: 'collect', type: 'ai', name: '资料收集' },
      { key: 'draft', type: 'ai', name: '汇总撰写' }],
  },
  {
    pluginId: 'local:plain', name: '普通小工具', installed: true, personal: true,
  },
] });

async function pickTwo() {
  const api = mention.create({ input, host, actions: [], catalog: catalogItems });
  assert.ok(api, 'create returns an instance');
  assert.ok(await api.select('local:wf-doc', () => true, { keepText: true }), 'workflow plugin selected');
  assert.ok(await api.select('local:plain', () => true, { keepText: true }), 'plain plugin selected');
  return api;
}

test('consume keeps workflow plugins selected for follow-up turns', async () => {
  const api = await pickTwo();
  assert.equal(api.selected().length, 2, 'both plugins selected before the send');
  api.consume([
    { pluginId: 'local:wf-doc', name: '文档流水线', version: '', scopeLabel: '仅自己' },
    { pluginId: 'local:plain', name: '普通小工具', version: '', scopeLabel: '仅自己' },
  ]);
  const rest = api.selected();
  assert.equal(rest.length, 1, 'plain plugin consumed');
  assert.equal(rest[0].pluginId, 'local:wf-doc', 'workflow plugin kept in the composer for a direct follow-up round');
  assert.equal(api.draft()[0].pluginId, 'local:wf-doc', 'parameter draft kept along with the retained selection');
});

test('consume keeps everything untouched when only workflow plugins were sent', async () => {
  const api = await pickTwo();
  // consume the plain plugin first, leaving only workflow; the next send hands consume workflow only.
  api.consume([{ pluginId: 'local:plain', name: '普通小工具', version: '', scopeLabel: '仅自己' }]);
  assert.equal(api.selected().length, 1);
  // Verify the all-kept branch by consuming workflow again and checking the selection survives.
  api.consume([{ pluginId: 'local:wf-doc', name: '文档流水线', version: '', scopeLabel: '仅自己' }]);
  assert.equal(api.selected().length, 1, 'all-workflow send does not clear the selection');
  assert.equal(api.selected()[0].pluginId, 'local:wf-doc');
});

test('restore of a failed draft still brings back consumed plain plugins', async () => {
  const api = await pickTwo();
  api.consume([
    { pluginId: 'local:wf-doc' }, { pluginId: 'local:plain' },
  ]);
  assert.equal(api.selected().length, 1, 'send succeeded: plain plugin consumed, workflow retained');
  // send failed, retrying: the failed draft carries all plugins back, restore must re-add the plain one.
  api.restore([
    { pluginId: 'local:wf-doc', inputValues: {} },
    { pluginId: 'local:plain', inputValues: {} },
  ]);
  const ids = api.selected().map((item) => item.pluginId).sort();
  assert.deepEqual(ids, ['local:plain', 'local:wf-doc'], 'both plugins back after failed-draft restore');
});

test('restore retains personal parameters when only the enterprise catalog is available', async () => {
  const api = mention.create({ input, host, actions: [], catalog: async () => ({
    personalComplete: false,
    items: [{ pluginId: 'enterprise-a', name: 'Enterprise A', installed: true, organizationWide: true }],
  }) });
  api.restore([{ pluginId: 'enterprise-a' }, { pluginId: 'local:offline', inputValues: { retained: 'value' } }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(api.draft().map(item => item.pluginId), ['enterprise-a', 'local:offline']);
  assert.deepEqual(api.draft()[1].inputValues, { retained: 'value' });
  assert.equal(api.selected()[0].name, 'Enterprise A');
  api.destroy();
});

test('restore removes missing personal plugins only after a complete catalog confirms their absence', async () => {
  const api = mention.create({ input, host, actions: [], catalog: async () => ({
    personalComplete: true,
    items: [{ pluginId: 'enterprise-a', name: 'Enterprise A', installed: true, organizationWide: true }],
  }) });
  api.restore([{ pluginId: 'enterprise-a' }, { pluginId: 'local:deleted', inputValues: { retained: 'value' } }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(api.draft().map(item => item.pluginId), ['enterprise-a']);
  api.destroy();
});

test('a pending restored catalog cannot resurrect a cleared draft', async () => {
  let finish;
  const api = mention.create({ input, host, actions: [], catalog: () => new Promise(resolve => { finish = resolve; }) });
  api.restore([{ pluginId: 'local:pending', inputValues: { retained: 'value' } }]);
  assert.equal(api.draft()[0].pluginId, 'local:pending');
  await new Promise(resolve => setImmediate(resolve));
  api.clear();
  finish({ personalComplete: true, items: [{ pluginId: 'local:pending', installed: true, personal: true }] });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(api.draft(), []);
  api.destroy();
});

test('a pending restored catalog reconciles the latest draft without reviving previous selections', async () => {
  let finish;
  const api = mention.create({ input, host, actions: [], catalog: () => new Promise(resolve => { finish = resolve; }) });
  api.restore([{ pluginId: 'local:previous' }]);
  await new Promise(resolve => setImmediate(resolve));
  api.restore([{ pluginId: 'local:current', inputValues: { retained: 'current value' } }]);
  finish({ personalComplete: true, items: [
    { pluginId: 'local:previous', installed: true, personal: true },
    { pluginId: 'local:current', name: 'Current plugin', installed: true, personal: true },
  ] });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(api.draft().map(item => item.pluginId), ['local:current']);
  assert.equal(api.selected()[0].name, 'Current plugin');
  assert.deepEqual(api.draft()[0].inputValues, { retained: 'current value' });
  api.destroy();
});
