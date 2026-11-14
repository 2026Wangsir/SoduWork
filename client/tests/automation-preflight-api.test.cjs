'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('./renderer-source.cjs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../api.js'), 'utf8');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(r => setImmediate(r));
const copy = v => JSON.parse(JSON.stringify(v));
function harness() {
  const values = new Map([['soduwork_work_hub_url', 'http://hub-a:8989']]);
  const h = { user: 'alice', calls: [], native: [],
    result: { state: 'waiting', executionReady: true, deviceDependencies: { ownerClientId: 'device-1', plugin: { key: 'method', versionPolicy: 'latest' } } } };
  h.bridge = { deviceAuthBootstrap: async () => ({ ok: true, stored: true, clientId: 'device-1',
    user: { id: h.user }, session: 'test-session-' + h.user, expiresIn: 1800 }),
    automationPreflight: async payload => { h.native.push(payload); return { ...payload.server, state: 'ready' }; } };
  const window = { __SODUWORK_TEST_HUB_CONFIG__: { allowSwitch: true }, soduWorkAPI: h.bridge, dispatchEvent() {} };
  const context = { window, User: { id: 'device-1', name: 'Test' }, navigator: { platform: 'test' },
    localStorage: { getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, String(v)), removeItem: k => values.delete(k) },
    fetch: async (url, options) => { h.calls.push({ url, options }); return new Response(JSON.stringify(await h.result), { status: h.status || 200 }); },
    URL, URLSearchParams, FormData, Response, AbortController, CustomEvent: class {}, console: { log() {}, error() {} },
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0 };
  vm.runInNewContext(source, context, { filename: 'api.js' });
  h.api = window.SoduWorkAPI; h.login = () => h.api.registerClient();
  return h;
}
test('preflight merges native checks only after authenticated Hub runtime policy response', async () => {
  const h = harness(); await h.login();
  const result = await h.api.preflightSchedule({ personalPluginKey: 'method' }, { force: true });
  assert.equal(result.state, 'ready'); assert.equal(h.native.length, 1);
  assert.equal(h.native[0].force, true); assert.equal(h.native[0].hub, 'http://hub-a:8989');
  assert.deepEqual(copy(h.native[0].server), h.result);
  assert.equal(h.calls.length, 1); assert.match(h.calls[0].url, /schedules\/preflight$/);
  assert.equal(h.calls[0].options.headers.Authorization, 'Device test-session-alice');
});
test('older native bridge preserves backend waiting; direct schedule does not trigger local checks', async () => {
  const h = harness(); await h.login(); delete h.bridge.automationPreflight;
  assert.equal((await h.api.preflightSchedule({})).state, 'waiting');
  h.result = { state: 'ready', mode: 'direct' };
  h.bridge.automationPreflight = async () => { throw Error('unexpected'); };
  assert.equal((await h.api.preflightSchedule({})).state, 'ready');
});
for (const phase of ['hub', 'native']) for (const identity of ['account', 'hub']) {
  test('discard stale ' + phase + ' response after ' + identity + ' switch', async () => {
    const h = harness(), wait = deferred(); await h.login();
    const original = h.result;
    if (phase === 'hub') h.result = wait.promise;
    else h.bridge.automationPreflight = () => wait.promise;
    const work = h.api.preflightSchedule({ personalPluginKey: 'method' });
    await tick();
    if (identity === 'account') { h.user = 'bob'; await h.login(); }
    else h.api.setHubEnvironment('development', 'http://hub-b:8989');
    wait.resolve(original);
    await assert.rejects(work, error => error.code === 'STALE_TASK_SCOPE');
    if (phase === 'hub') assert.equal(h.native.length, 0);
  });
}

test('manual run wakes the native inbox only after the Hub accepts it, without waiting for the wake', async () => {
  const h = harness(), response = deferred(), wake = deferred(), wakes = [];
  await h.login();
  h.result = response.promise;
  h.bridge.automationConversationsWake = payload => { wakes.push(payload); return wake.promise; };
  const run = h.api.runSchedule('schedule/1', { instanceId: 'ui-owner' });
  await tick();
  assert.equal(wakes.length, 0);
  const accepted = { ok: true, runId: 'run-1', conversationInput: { text: 'work' } };
  response.resolve(accepted);
  assert.deepEqual(copy(await run), accepted);
  assert.deepEqual(copy(wakes), [{ hub: 'http://hub-a:8989' }]);
  assert.equal(h.calls.length, 1, 'waking must not create a second run request');
  assert.match(h.calls[0].url, /schedules\/schedule%2F1\/run$/);
  assert.deepEqual(JSON.parse(h.calls[0].options.body), { instanceId: 'ui-owner' });
  wake.resolve({ ok: true });
});

test('manual local automation runs use the device model before opening the direct chat', async () => {
  const h = harness(); await h.login();
  const model = 'local:model-0123456789abcdef0123456789abcdef';
  h.bridge.automationModels = {
    get: async input => { assert.equal(input.scheduleId, 'schedule-1'); return { ok: true, configured: true, modelName: model }; },
  };
  h.result = { ok: true, runId: 'run-1', conversationInput: { text: 'work', modelName: '' } };
  const result = await h.api.runSchedule('schedule-1');
  assert.equal(result.conversationInput.modelName, model);
});

test('manual local automation runs fail closed when the secure model bridge is unavailable', async () => {
  const h = harness(); await h.login();
  h.result = { ok: true, runId: 'run-1', modelSource: 'device', conversationInput: { text: 'work', modelSource: 'device', modelName: '' } };
  const result = await h.api.runSchedule('schedule-1');
  assert.equal(result.conversationInput, null);
  assert.equal(result.localModelUnavailable, true);
});

for (const adapter of ['pi', 'qwen', 'opencode', 'dsh', 'kimi', 'harness2', 'codex-harness']) {
  test('same-device Runner automation retains a local ' + adapter + ' selection only on the device', async () => {
    const h = harness(); await h.login();
    const model = 'local:model-0123456789abcdef0123456789abcdef', writes = [];
    h.bridge.automationModels = { set: async value => { writes.push(value); return { ok: true }; } };
    h.result = { id: 'schedule-local', modelSource: 'device' };
    const body = { assigneeId: 'runner:desk:' + adapter, assigneeMode: 'local', assigneeClientId: 'device-1', modelName: model };
    assert.equal((await h.api.createSchedule(body)).modelName, model);
    assert.equal(writes[0].modelName, model);
    const sent = JSON.parse(h.calls[0].options.body);
    assert.equal(sent.modelName, ''); assert.equal(sent.modelSource, 'device');
    assert.equal(Object.hasOwn(sent, 'assigneeClientId'), false);
    assert.doesNotMatch(h.calls[0].options.body, /local:model-/);
    await assert.rejects(h.api.createSchedule({ ...body, assigneeClientId: 'other-device' }), /本机托管型/);
    await assert.rejects(h.api.createSchedule({ ...body, assigneeMode: 'remote' }), /本机托管型/);
    assert.equal(h.calls.length, 1);
  });
}

test('a rejected secure-store write cannot report successful local automation creation', async () => {
  const h = harness(); await h.login();
  h.bridge.automationModels = { set: async () => ({ ok: false, reason: 'unavailable' }) };
  h.result = { id: 'schedule-local', modelSource: 'device' };
  await assert.rejects(h.api.createSchedule({ assigneeId: 'local:qwen', modelName: 'local:model-0123456789abcdef0123456789abcdef' }), /保存失败/);
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].options.method, 'DELETE');
});

test('device schedules without a readable mapping retain an explicit invalid model until the user reselects', async () => {
  const h = harness(); await h.login();
  h.bridge.automationModels = { get: async () => ({ ok: false }) };
  h.result = [{ id: 'lost-device-choice', modelSource: 'device', modelName: '' }];
  const row = (await h.api.listSchedules())[0];
  assert.equal(row.localModelUnavailable, true);
  assert.equal(row.modelName, 'local:unavailable');
  await assert.rejects(h.api.updateSchedule(row.id, { assigneeId: 'local:pi', modelName: row.modelName }), /可验证的本地模型/);
  assert.equal(h.calls.length, 1);
});

test('managed schedule rows do not inherit stale local model mappings', async () => {
  const h = harness(); await h.login();
  const model = 'local:model-0123456789abcdef0123456789abcdef';
  h.bridge.automationModels = { get: async () => ({ ok: true, models: { 'schedule-1': model, 'schedule-2': model, 'schedule-3': model } }) };
  h.result = [
    { id: 'schedule-1', modelSource: 'managed', modelName: 'managed-model' },
    { id: 'schedule-2', modelSource: 'device', modelName: '' },
    { id: 'schedule-3', modelName: '' },
    { id: 'schedule-4', modelName: 'legacy-model' },
  ];
  const rows = await h.api.listSchedules();
  assert.equal(rows[0].modelName, 'managed-model');
  assert.equal(rows[1].modelName, model);
  assert.equal(rows[2].modelName, model);
  assert.equal(rows[3].modelName, 'legacy-model');
});

test('manual local automation runs do not fall back when local storage cannot be read', async () => {
  const h = harness(); await h.login();
  h.bridge.automationModels = { get: async () => { throw Error('keychain unavailable'); } };
  h.result = { ok: true, runId: 'run-1', conversationInput: { text: 'work', modelName: '' } };
  const result = await h.api.runSchedule('schedule-1');
  assert.equal(result.conversationInput, null);
  assert.equal(result.localModelUnavailable, true);
});

for (const bridge of ['missing', 'throws', 'rejects']) {
  test('accepted manual run is preserved when native wake ' + bridge, async () => {
    const h = harness(); await h.login();
    h.result = { ok: true, runId: 'run-1' };
    if (bridge === 'throws') h.bridge.automationConversationsWake = () => { throw Error('unavailable'); };
    if (bridge === 'rejects') h.bridge.automationConversationsWake = async () => { throw Error('unavailable'); };
    assert.deepEqual(copy(await h.api.runSchedule('schedule-1')), h.result);
    await tick();
    assert.equal(h.calls.length, 1);
  });
}

for (const identity of ['account', 'hub']) {
  test('manual run response cannot wake a different ' + identity, async () => {
    const h = harness(), response = deferred(), wakes = [];
    await h.login();
    h.result = response.promise;
    h.bridge.automationConversationsWake = payload => { wakes.push(payload); return Promise.resolve({ ok: true }); };
    const run = h.api.runSchedule('schedule-1');
    await tick();
    if (identity === 'account') { h.user = 'bob'; await h.login(); }
    else h.api.setHubEnvironment('development', 'http://hub-b:8989');
    response.resolve({ ok: true, runId: 'run-1' });
    await assert.rejects(run, error => error.code === 'STALE_TASK_SCOPE');
    assert.equal(wakes.length, 0);
    assert.equal(h.calls.length, 1);
  });
}

test('failed manual run does not wake the native inbox', async () => {
  const h = harness(), wakes = []; await h.login();
  h.bridge.automationConversationsWake = payload => { wakes.push(payload); return { ok: true }; };
  h.result = { detail: 'service temporarily unavailable' }; h.status = 503;
  await assert.rejects(h.api.runSchedule('schedule-1'), error => error.status === 503);
  assert.equal(wakes.length, 0);
  h.status = 200; h.result = { ok: false, reason: 'run not created' };
  assert.deepEqual(copy(await h.api.runSchedule('schedule-1')), h.result);
  assert.equal(wakes.length, 0);
});

for (const phase of ['read', 'write']) for (const identity of ['account', 'hub']) {
  test('schedule updates stop after an identity switch during local mapping ' + phase + ': ' + identity, async () => {
    const h = harness(), wait = deferred(), writes = []; await h.login();
    h.bridge.automationModels = {
      get: async () => phase === 'read' ? wait.promise : { ok: true, configured: false, modelName: '' },
      set: async input => { writes.push(input); return phase === 'write' ? wait.promise : { ok: true }; },
      remove: async input => { writes.push(input); return { ok: true }; },
    };
    h.result = { id: 'schedule-1', modelSource: 'device' };
    const work = h.api.updateSchedule('schedule-1', { assigneeId: 'local:qwen', modelName: 'local:model-0123456789abcdef0123456789abcdef' });
    await tick();
    if (identity === 'account') { h.user = 'bob'; await h.login(); }
    else h.api.setHubEnvironment('development', 'http://hub-b:8989');
    wait.resolve({ ok: true, configured: false, modelName: '' });
    await assert.rejects(work, error => error.code === 'STALE_TASK_SCOPE');
    assert.equal(h.calls.length, 0, 'the stale update must never reach either Hub');
    assert.equal(writes.length, phase === 'read' ? 0 : 1);
    for (const input of writes) {
      assert.equal(input.hub, 'http://hub-a:8989'); assert.equal(input.owner, 'account:alice');
    }
  });
}

for (const operation of ['list', 'run']) {
  test('schedule ' + operation + ' cannot overlay another account mapping after the native read waits', async () => {
    const h = harness(), wait = deferred(), reads = [], wakes = []; await h.login();
    h.bridge.automationModels = { get: input => { reads.push(input); return wait.promise; } };
    h.bridge.automationConversationsWake = input => { wakes.push(input); return { ok: true }; };
    h.result = operation === 'list' ? [{ id: 'schedule-1', modelSource: 'device' }]
      : { ok: true, runId: 'run-1', modelSource: 'device', conversationInput: { modelSource: 'device' } };
    const work = operation === 'list' ? h.api.listSchedules() : h.api.runSchedule('schedule-1');
    await tick(); h.user = 'bob'; await h.login();
    wait.resolve({ ok: true, configured: true, modelName: 'local:model-0123456789abcdef0123456789abcdef', models: {} });
    await assert.rejects(work, error => error.code === 'STALE_TASK_SCOPE');
    assert.equal(reads[0].owner, 'account:alice'); assert.equal(wakes.length, 0);
  });
}

test('a stale create failure cannot compensate by deleting a schedule on the next Hub', async () => {
  const h = harness(), wait = deferred(), writes = []; await h.login();
  h.bridge.automationModels = { set: input => { writes.push(input); return wait.promise; } };
  h.result = { id: 'schedule-1', modelSource: 'device' };
  const work = h.api.createSchedule({ assigneeId: 'local:qwen', modelName: 'local:model-0123456789abcdef0123456789abcdef' });
  await tick(); h.api.setHubEnvironment('development', 'http://hub-b:8989');
  wait.resolve({ ok: false });
  await assert.rejects(work, error => error.code === 'STALE_TASK_SCOPE');
  assert.equal(h.calls.length, 1); assert.match(h.calls[0].url, /^http:\/\/hub-a:8989\//);
  assert.equal(writes[0].owner, 'account:alice');
});

test('unknown-owner legacy mappings display an unavailable placeholder instead of a managed fallback', async () => {
  const h = harness(); await h.login();
  h.bridge.automationModels = { get: async () => ({ ok: true, models: {}, unavailableScheduleIds: ['schedule-1'] }) };
  h.result = [{ id: 'schedule-1', modelName: '' }];
  assert.equal((await h.api.listSchedules())[0].modelName, 'local:unavailable');
});

test('concurrent updates of one schedule cannot interleave local mappings and Hub writes', async () => {
  const h = harness(), response = deferred(), writes = []; await h.login();
  let selected = '';
  h.bridge.automationModels = {
    get: async () => ({ ok: true, modelName: selected, configured: Boolean(selected) }),
    set: async input => { selected = input.modelName; writes.push(selected); return { ok: true }; },
    remove: async () => { selected = ''; return { ok: true }; },
  };
  h.result = response.promise;
  const first = 'local:model-0123456789abcdef0123456789abcdef', second = 'local:model-fedcba9876543210fedcba9876543210';
  const a = h.api.updateSchedule('schedule-1', { assigneeId: 'local:qwen', modelName: first });
  await tick();
  const b = h.api.updateSchedule('schedule-1', { assigneeId: 'local:qwen', modelName: second });
  await tick(); assert.deepEqual(writes, [first]); assert.equal(h.calls.length, 1);
  response.resolve({ id: 'schedule-1', modelSource: 'device' });
  await Promise.all([a, b]);
  assert.deepEqual(writes, [first, second]); assert.equal(selected, second); assert.equal(h.calls.length, 2);
});
