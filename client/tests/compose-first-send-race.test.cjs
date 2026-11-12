'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { makeGlobals, stubGlobals, El } = require('./fixture/chat-draft-harness.cjs');
const ROOT = path.join(__dirname, '..');
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function until(check) { for (let i = 0; i < 40 && !check(); i++) await tick(); assert.ok(check()); }

function fixture(t, { modelReady = Promise.resolve(true), send } = {}) {
  const calls = [], releases = [], opens = [];
  let owner = 'account-a', compose, picked = [], modelRequests = 0;
  let runtime = 'pi', location = 'local', executionRevision = 0;
  const api = {
    open: async options => { opens.push(options); return { ok: true, ref: 'ref-first', sessionId: 'first-chat', snapshot: { messages: [] } }; },
    snapshot: async () => ({ ok: true, snapshot: { messages: [] } }),
    send: async (...args) => { calls.push(args); return send ? send(...args) : { ok: true }; },
    onEvent() { return () => {}; }, release: async ref => { releases.push(ref); return { ok: true }; },
    history: async () => ({ ok: true, chats: [] }),
  };
  const f = makeGlobals(); stubGlobals(f.g, { piSession: api });
  f.g.SessionMemoryEntry.options = () => ({});
  f.g.SoduWorkAPI.taskStorageKey = () => owner;
  f.g.window = f.g;
  function publish() {
    for (const key of Object.keys(f.g)) {
      if (['require', 'setTimeout', 'clearTimeout'].includes(key)) continue;
      Object.defineProperty(globalThis, key, { value: f.g[key], configurable: true, writable: true });
    }
  }
  function load(name) {
    new Function('window', fs.readFileSync(path.join(ROOT, 'components/panels', name + '.js'), 'utf8'))(f.g);
    publish();
  }
  publish();
  // Use the production composer, NativeChat, draft store and session controller.
  // Only DOM rendering and the native runtime boundary use the existing fixture.
  for (const name of ['chat-draft-recovery', 'chat-composer-bindings', 'chat-session-controller',
    'panels-chat', 'compose-surface', 'panels-compose-work-actions']) load(name);
  const panel = f.document.getElementById('composePanel'), input = new El('textarea', 'cpInput');
  panel.appendChild(input);
  const create = f.g.ComposeSurface.create;
  f.g.ComposeSurface.create = context => {
    compose = context;
    return { ...create(context), _panel: () => panel, _paintSetup() {}, refreshComposeRecommendations() {} };
  };
  f.g.ComposeRuntime = { value: () => runtime, ready: async () => true, accessSupported: () => false };
  f.g.ComposeExecution = { value: () => location, revision: () => executionRevision,
    reset() { location = 'local'; executionRevision++; }, bind() {}, paint() {} };
  f.g.ComposeModelPicker = { ready: () => { modelRequests++; return modelReady; },
    value: () => ({ modelName: 'fixture-model' }), refresh() {} };
  publish(); load('panels-compose');
  compose._pluginMention = { selected: () => picked.slice(), draft: () => picked.slice(), action: () => null,
    clear: () => { picked = []; }, restore: rows => { picked = rows.slice(); },
    resolve: async (_chat, _project, text) => ({ text, items: picked.slice() }) };
  input.addEventListener('input', () => compose._rememberComposeDraft());
  f.g.openComposePanel({ newSession: true });
  t.after(() => f.g.NativeChat.reset());
  return { ...f, input, panel, calls, releases, opens, compose,
    readyCalls: () => modelRequests,
    owner: value => { owner = value; },
    runtime: value => { runtime = value; },
    location: value => { if (value !== location) executionRevision++; location = value; },
    type(text, plugins = []) { picked = plugins.slice(); input.value = text; input.dispatchEvent(new Event('input')); },
    plugins: () => picked.slice(),
    draft: key => f.g.NativeChat.getDraft(key || 'new'),
    submit: () => compose.makeDraft(),
    newSession: () => f.g.openComposePanel({ newSession: true }),
  };
}
const oldPlugin = { pluginId: 'local:app-developer', name: '即用开发' };
const newPlugin = { pluginId: 'local:new-plugin', name: 'New draft plugin' };

test('new-session navigation during model preparation cannot send old text or clear the newer draft and plugin', async t => {
  const ready = deferred(), f = fixture(t, { modelReady: ready.promise });
  f.type('original submitted text', [oldPlugin]);
  const pending = f.submit(); await until(() => f.readyCalls());
  f.newSession(); f.type('new unsent text', [newPlugin]);
  ready.resolve(true); await pending;
  assert.equal(f.calls.length, 0);
  assert.equal(f.panel.dataset.stage, 'compose');
  assert.equal(f.input.value, 'new unsent text');
  assert.equal(f.draft(), 'new unsent text');
  assert.deepEqual(f.plugins(), [newPlugin]);
});

test('account changes during model preparation reject the old request even before the scope event arrives', async t => {
  const ready = deferred(), f = fixture(t, { modelReady: ready.promise });
  f.type('account A request'); const pending = f.submit(); await until(() => f.readyCalls());
  f.owner('account-b'); ready.resolve(true); await pending;
  assert.equal(f.calls.length, 0);
  assert.equal(f.input.value, 'account A request');
  assert.equal(f.panel.dataset.stage, 'compose');
});

for (const selection of ['runtime', 'execution']) test(selection + ' changes during model preparation cannot dispatch the earlier draft', async t => {
  const ready = deferred(), f = fixture(t, { modelReady: ready.promise });
  f.type('request under original selection', [oldPlugin]);
  const pending = f.submit(); await until(() => f.readyCalls());
  if (selection === 'runtime') f.runtime('codex');
  else { f.location('cloud'); f.location('local'); }
  ready.resolve(true); await pending;
  assert.equal(f.opens.length, 0, 'changed selection must be rejected before opening a runtime');
  assert.equal(f.calls.length, 0);
  assert.equal(f.panel.dataset.stage, 'compose');
  assert.equal(f.input.value, 'request under original selection');
  assert.equal(f.draft(), 'request under original selection');
  assert.deepEqual(f.plugins(), [oldPlugin]);
});

test('ordinary attachment preparation cannot start a stale first send after new-session navigation', async t => {
  const analysis = deferred(), f = fixture(t); let analysing = false;
  f.compose._attachments = { files: () => [], has: () => true, clear() {},
    analysis: () => { analysing = true; return analysis.promise; }, refs: async () => [],
    names: () => [], libraryItems: () => [], submissionText: text => text };
  f.type('old attachment request'); const pending = f.submit(); await until(() => analysing);
  f.newSession(); f.type('new attachment draft'); analysis.resolve([]); await pending;
  assert.equal(f.calls.length, 0);
  assert.equal(f.input.value, 'new attachment draft');
  assert.equal(f.draft(), 'new attachment draft');
});

test('a normal accepted first send consumes only its original draft and plugin selection', async t => {
  const f = fixture(t); f.type('normal request', [oldPlugin]); await f.submit();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0][1], 'normal request');
  assert.equal(f.calls[0][3].plugins[0].pluginId, oldPlugin.pluginId);
  assert.equal(f.input.value, ''); assert.equal(f.draft(), ''); assert.deepEqual(f.plugins(), []);
});

for (const accepted of [true, false]) test('navigation after actual send preserves the new draft when its late receipt is ' + accepted, async t => {
  const ack = deferred(), f = fixture(t, { send: () => ack.promise });
  f.type('already dispatched request', [oldPlugin]); const pending = f.submit();
  await until(() => f.calls.length === 1);
  f.newSession();
  assert.equal(f.input.value, ''); assert.deepEqual(f.plugins(), []);
  f.type('independent new draft', [newPlugin]);
  ack.resolve({ ok: accepted, reason: accepted ? '' : 'Synthetic refusal' }); await pending;
  assert.equal(f.calls.length, 1, 'no duplicate send');
  assert.deepEqual(f.releases, ['ref-first'], 'navigation releases the renderer handle only');
  assert.equal(f.panel.dataset.stage, 'compose');
  assert.equal(f.input.value, 'independent new draft'); assert.equal(f.draft(), 'independent new draft');
  assert.deepEqual(f.plugins(), [newPlugin]);
  if (!accepted) assert.equal(f.draft('first-chat'), 'already dispatched request');
});

test('a refused first send retains the unsent input in its original conversation', async t => {
  const f = fixture(t, { send: async () => ({ ok: false, reason: 'Synthetic refusal' }) });
  f.type('unsent original request'); await f.submit();
  assert.equal(f.calls.length, 1);
  assert.equal(f.document.getElementById('nchatInput').value, 'unsent original request');
  assert.equal(f.draft('first-chat'), 'unsent original request');
});
