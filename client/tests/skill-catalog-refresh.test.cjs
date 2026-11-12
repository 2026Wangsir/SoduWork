'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const read = name => fs.readFileSync(path.join(__dirname, '../components/panels', name), 'utf8');
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function fixture() {
  const events = new Map(), requests = [], paints = [];
  const g = { setTimeout, clearTimeout, document: {}, addEventListener(name, fn) {
    if (!events.has(name)) events.set(name, []); events.get(name).push(fn);
  }, soduWorkAPI: { conversationSession: { capabilities(options) {
    return new Promise(resolve => requests.push({ options, resolve }));
  } } } };
  g.window = g;
  vm.runInNewContext(read('chat-composer-bindings.js'), g);
  const ctx = { _skillLoadSeq: 0, _sessionOptions: {}, _skillPicker: {
    setLoading() {}, setError(value) { paints.push(value); }, setItems(rows) { paints.push(Array.from(rows, row => row.name)); },
  } };
  const binding = g.ChatComposerBindings.create(ctx);
  return { ctx, binding, requests, paints, emit(name) { for (const fn of events.get(name) || []) fn(); } };
}
function composeFixture() {
  const events = new Map(), requests = [], paints = []; let ctx;
  const g = { setTimeout, clearTimeout, document: { getElementById: () => null },
    addEventListener(name, fn) { events.set(name, fn); },
    ComposeSurface: { create(value) { ctx = value; return { _paintSetup() {}, _restoreComposeDraft() {} }; } },
    ComposeCapabilities: { render() {} },
    soduWorkAPI: { conversationSession: { capabilities(options) {
      return new Promise(resolve => requests.push({ options, resolve }));
    } } } };
  g.window = g; vm.runInNewContext(read('panels-compose.js'), g);
  ctx._skillPicker = { setLoading() {}, setError() {}, setItems(rows) { paints.push(Array.from(rows, row => row.name)); } };
  return { ctx, requests, paints, emit(name) { events.get(name)?.(); } };
}
const result = name => ({ ok: true, skills: [{ name, selectable: true }] });

test('installed-skill invalidation coalesces a trailing current catalog and discards the older response', async () => {
  const f = fixture();
  const initial = f.binding._loadChatSkills(false);
  for (let i = 0; i < 100; i++) f.emit('soduwork:skills-changed');
  assert.equal(f.requests.length, 1, 'one active request must remain bounded');
  f.requests[0].resolve(result('old-builtin')); await initial; await flush();
  assert.equal(f.requests.length, 2, 'successful installation must request a fresh catalog');
  assert.equal(f.requests[1].options.force, true);
  assert.deepEqual(f.paints, [], 'late initial metadata must not overwrite invalidated choices');
  f.requests[1].resolve(result('code-motion-film')); await flush();
  assert.deepEqual(f.paints, [['code-motion-film']]);
});

test('account changes clear old catalog and fence its pending response without creating an extra burst', async () => {
  const f = fixture();
  const first = f.binding._loadChatSkills();
  f.emit('soduwork-data-scope-changed');
  assert.deepEqual(f.paints, [[]]);
  f.requests[0].resolve(result('private-account-a')); await first; await flush();
  assert.equal(f.requests.length, 2);
  f.requests[1].resolve(result('private-account-b')); await flush();
  assert.deepEqual(f.paints, [[], ['private-account-b']]);
});

test('closing the old composer prevents a queued refresh from repainting a replaced picker', async () => {
  const f = fixture();
  const first = f.binding._loadChatSkills();
  f.emit('soduwork:skills-changed');
  f.ctx._skillPicker = null; f.ctx._skillLoadSeq++;
  f.requests[0].resolve(result('old')); await first; await flush();
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.paints, []);
});

test('the starter refreshes a same-model catalog without re-enabling deselected tool capabilities', async () => {
  const f = composeFixture();
  const first = f.ctx._loadCapabilities();
  const tool = { id: 'browser', selectable: true, deviceGranted: true, selected: true };
  f.requests[0].resolve({ ...result('builtin'), items: [tool] }); await first;
  f.ctx._pickedCapabilities.clear();
  f.emit('soduwork:skills-changed');
  for (let i = 0; i < 100; i++) f.emit('soduwork:skills-changed');
  assert.equal(f.requests.length, 2);
  f.requests[1].resolve({ ...result('old'), items: [tool] }); await flush();
  assert.equal(f.requests.length, 3);
  assert.deepEqual(f.paints, [['builtin']]);
  f.requests[2].resolve({ ...result('code-motion-film'), items: [tool] }); await flush();
  assert.deepEqual(f.paints, [['builtin'], ['code-motion-film']]);
  assert.equal(f.ctx._pickedCapabilities.size, 0, 'catalog refresh must preserve the user tool selection');
});

test('the starter fences account A to B to A replies even when model and runtime keys are identical', async () => {
  const f = composeFixture();
  const first = f.ctx._loadCapabilities();
  f.emit('soduwork-data-scope-changed'); f.emit('soduwork-data-scope-changed');
  f.requests[0].resolve(result('stale-a')); await first; await flush();
  assert.equal(f.requests.length, 2);
  f.requests[1].resolve(result('current-a')); await flush();
  assert.deepEqual(f.paints, [[], [], ['current-a']]);
});

test('opening a stale menu refreshes once while typing and fresh reopen remain local', () => {
  let now = 100000, refreshed = 0;
  function element() {
    const classes = new Set(), listeners = new Map();
    return { value: '', selectionStart: 0, children: [], style: {}, scrollHeight: 1,
      classList: { add: x => classes.add(x), remove: x => classes.delete(x), contains: x => classes.has(x), toggle() {} },
      setAttribute() {}, removeAttribute() {}, appendChild(node) { this.children.push(node); },
      addEventListener(name, fn) { listeners.set(name, fn); }, emit(name) { listeners.get(name)?.(); } };
  }
  const g = { document: { createElement: element, addEventListener() {} },
    localStorage: { getItem: () => null }, Date: { now: () => now } };
  g.window = g;
  for (const file of ['compose-candidate-navigation.js', 'panels-compose-skills.js']) vm.runInNewContext(read(file), g);
  const input = element(), host = element();
  const picker = g.ComposeSkills.create({ input, host, onRefresh() { refreshed++; picker.setLoading(true); } });
  picker.setItems([{ name: 'builtin', selectable: true }]); picker.restore(['kept-draft']);
  now += 30001;
  input.value = '#'; input.selectionStart = 1; input.emit('input');
  for (let i = 0; i < 1000; i++) { input.value = '#code'; input.selectionStart = 5; input.emit('input'); }
  assert.equal(refreshed, 1);
  picker.setItems([{ name: 'code-motion-film', selectable: true }]);
  assert.match(host.children[1].innerHTML, /code-motion-film/);
  picker.close(); input.emit('input'); assert.equal(refreshed, 1);
  assert.deepEqual(Array.from(picker.selected()), ['kept-draft']);
});

function apiFixture() {
  let user = 'alice'; const values = new Map([['soduwork_work_hub_url', 'http://fixture.invalid']]);
  const events = new Map(), notifications = [], calls = [];
  const f = { fetch: async () => new Response('{"ok":true}'), calls, notifications };
  class Event { constructor(type) { this.type = type; } }
  const g = { CustomEvent: Event, addEventListener(name, fn) { events.set(name, fn); },
    dispatchEvent(event) { notifications.push(event.type); events.get(event.type)?.(event); },
    soduWorkAPI: { deviceAuthBootstrap: async () => ({ ok: true, stored: true, clientId: 'device-1',
      user: { id: user }, session: 'session-' + user, expiresIn: 1800 }) } };
  vm.runInNewContext(require('./renderer-source.cjs').readFileSync(path.join(__dirname, '../api.js'), 'utf8'), {
    window: g, User: { id: 'device-1' }, navigator: { platform: 'test' }, CustomEvent: Event,
    localStorage: { getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, String(v)), removeItem: k => values.delete(k) },
    fetch: async (url, options) => { calls.push({ url, options }); return f.fetch(url, options); },
    URL, URLSearchParams, FormData, Blob, File, Response, AbortController,
    console: { log() {}, error() {} }, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0,
  });
  f.api = g.SoduWorkAPI;
  f.signIn = async next => { user = next; await f.api.registerClient(); };
  return f;
}
const mutations = [a => a.createMySkill({ name: 'code-motion-film' }),
  a => a.importMySkill(new File(['fixture'], 'fixture.skill')),
  a => a.deleteMySkill('code-motion-film', 'checksum'), a => a.setMySkills(['code-motion-film']),
  a => a.refreshMySkills()];

test('successful skill mutations notify mounted pickers; failed and silent refresh requests do not', async () => {
  const f = apiFixture(); await f.signIn('alice'); f.notifications.length = 0;
  for (const mutate of mutations) await mutate(f.api);
  assert.equal(f.notifications.filter(x => x === 'soduwork:skills-changed').length, mutations.length);
  await f.api.refreshMySkills({ notify: false });
  assert.equal(f.notifications.filter(x => x === 'soduwork:skills-changed').length, mutations.length);
  f.fetch = async () => new Response('{"detail":"denied"}', { status: 403 });
  for (const mutate of mutations) await assert.rejects(mutate(f.api));
  assert.equal(f.notifications.filter(x => x === 'soduwork:skills-changed').length, mutations.length);
});

test('late mutation success cannot notify a different account or a later login of the same account', async () => {
  for (const returnToA of [false, true]) for (const mutate of mutations) {
    const f = apiFixture(); await f.signIn('alice');
    let complete; f.fetch = () => new Promise(resolve => { complete = resolve; });
    const pending = mutate(f.api); await flush();
    await f.signIn('bob'); if (returnToA) await f.signIn('alice');
    f.notifications.length = 0;
    complete(new Response('{"ok":true}'));
    if (returnToA) await pending;
    else await assert.rejects(pending, error => error.code === 'STALE_TASK_SCOPE');
    assert.equal(f.notifications.includes('soduwork:skills-changed'), false);
  }
});

test('a replacement conversation picker gets the coalesced catalog after the old view closes', async () => {
  const f = fixture(); const first = f.binding._loadChatSkills();
  f.ctx._skillLoadSeq++;
  const fresh = [];
  f.ctx._skillPicker = { setLoading() {}, setError() {}, setItems: rows => fresh.push(Array.from(rows, row => row.name)) };
  f.binding._loadChatSkills(); f.requests[0].resolve(result('old'));
  await first; await flush(); assert.equal(f.requests.length, 2);
  f.requests[1].resolve(result('current')); await flush();
  assert.deepEqual(f.paints, []); assert.deepEqual(fresh, [['current']]);
});
