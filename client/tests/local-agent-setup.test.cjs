'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('./renderer-source.cjs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../api.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const stale = error => error.code === 'STALE_TASK_SCOPE';
const plain = value => JSON.parse(JSON.stringify(value));
const reply = value => new Response(JSON.stringify(value));
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
const localRunner = { runnerId: 'desktop/source', scope: 'current-instance', online: true };
const localMachine = { runnerId: 'desktop/source', scope: 'current-instance',
  env: { node: 'v22', ok: true }, agents: [{ key: 'pi' }] };
const cloudRunner = { runnerId: 'cloud', scope: 'personal-cloud', online: true, isCurrentDevice: true };
const cloudMachine = { runnerId: 'cloud', scope: 'personal-cloud', env: { node: 'cloud-node' }, agents: [{ key: 'cloud-agent' }] };

async function fixture(runners = [cloudRunner, localRunner], data = { machines: [cloudMachine, localMachine],
  agents: cloudMachine.agents, env: cloudMachine.env, models: [{ name: 'fixture-model' }], modelCount: 1 }) {
  let user = 'alice';
  const values = new Map([['soduwork_work_hub_url', 'http://hub-a:8989']]);
  const h = { calls: [], now: Date.now(), data, runners };
  const bridge = {
    deviceAuthBootstrap: async () => ({ ok: true, stored: true, clientId: 'device-1',
      user: { id: user }, session: 'session-' + user, expiresIn: 1800 }),
    runnerStatus: async () => ({ connected: true, running: true }),
  };
  h.fetch = async url => new URL(url).pathname.endsWith('/runners') ? reply({ runners: h.runners }) : reply(h.data);
  const window = { __SODUWORK_TEST_HUB_CONFIG__: { allowSwitch: true }, soduWorkAPI: bridge, dispatchEvent() {} };
  vm.runInNewContext(source, {
    window, User: { id: 'device-1', name: 'Fixture' }, navigator: { platform: 'fixture' },
    localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)),
      removeItem: key => values.delete(key) },
    fetch: async (url, options) => { h.calls.push({ url, options }); return h.fetch(url, options); },
    Date: class extends Date { static now() { return h.now; } },
    URL, URLSearchParams, Response, AbortController, CustomEvent: class {},
    console: { log() {}, error() {} }, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0,
  });
  h.api = window.SoduWorkAPI;
  h.bridge = bridge;
  h.signIn = async next => { user = next; await h.api.registerClient(); };
  h.switch = async kind => kind === 'account' ? h.signIn('bob') : h.api.setHubEnvironment('development', 'http://hub-b:8989');
  await h.signIn('alice');
  h.calls.length = 0;
  return h;
}

test('local setup requests only the authenticated current Runner and removes older Hub compatibility data', async () => {
  const h = await fixture();
  const result = await h.api.localAgentSetup();
  assert.deepEqual(h.calls.map(call => new URL(call.url).pathname), ['/api/v1/runners', '/api/v1/agent-setup']);
  assert.equal(new URL(h.calls[1].url).searchParams.get('runnerId'), localRunner.runnerId);
  assert.deepEqual(Array.from(result.machines, row => row.runnerId), [localRunner.runnerId]);
  assert.deepEqual(plain(result.agents), localMachine.agents);
  assert.deepEqual(plain(result.env), localMachine.env);
  assert.equal(result.machines[0].isCurrentDevice, true);
  assert.equal(result.modelCount, 1);
  assert.deepEqual(plain(result.models), [{ name: 'fixture-model' }]);
  assert.doesNotMatch(JSON.stringify(result), /cloud-agent|cloud-node/);
});

test('local-only Agent discovery counts device models without transmitting their references or credentials', async () => {
  const h = await fixture([localRunner], { machines: [localMachine], models: [], modelCount: 0 });
  const model = 'local:model-0123456789abcdef0123456789abcdef';
  h.bridge.localModels = { get: async () => ({ providers: [{ id: 'private-provider' }], usable: [
    { name: model, label: 'Private model', localOnly: true, modality: 'chat', baseUrl: 'http://private-endpoint.invalid', key: 'private-key' },
  ] }) };
  const result = await h.api.localAgentSetup();
  assert.equal(result.modelCount, 1); assert.equal(result.localModelCount, 1);
  assert.equal(result.models[0].name, model);
  assert.equal(Object.hasOwn(result.models[0], 'key'), false);
  assert.equal(Object.hasOwn(result.models[0], 'baseUrl'), false);
  assert.equal(new URL(h.calls[1].url).searchParams.get('hasLocalModel'), '1');
  assert.doesNotMatch(JSON.stringify(h.calls), /local:model-|private-provider|private-endpoint|private-key/);
});

test('local Agent defaults stay on the device and survive a missing model without a Hub fallback', async () => {
  const h = await fixture([localRunner], { machines: [{ ...localMachine, agents: [
    { key: 'qwen', modelPick: true, state: 'ready' }, { key: 'codex', modelPick: false },
  ] }], models: [{ name: 'hub-model' }], modelCount: 1 });
  const model = 'local:model-0123456789abcdef0123456789abcdef';
  let selected = null;
  const mutations = [];
  h.bridge.localAgentModels = {
    get: async () => ({ ok: true, scopeKey: 'scope-a', revision: 2,
      selections: selected ? { qwen: { configured: true, modelName: model, unavailable: true } } : {} }),
    set: async input => { mutations.push(plain(input)); selected = model; return { ok: true }; },
    remove: async input => { mutations.push(plain(input)); selected = null; return { ok: true }; },
  };
  await h.api.setAgentModel('qwen', model);
  assert.equal(h.calls.length, 0);
  assert.deepEqual(mutations[0], { agentId: 'qwen', modelName: model, scopeKey: 'scope-a', expectedRevision: 2 });
  const setup = await h.api.localAgentSetup();
  assert.equal(setup.agents[0].model, model);
  assert.equal(setup.agents[0].modelGone, true);
  assert.equal(setup.agents[0].state, 'nollm');
  assert.equal(setup.machines[0].agents[0].model, model);
  assert.equal(setup.agents[1].model, undefined);
  assert.doesNotMatch(JSON.stringify(h.calls), /local:model-/);
  h.calls.length = 0;
  await h.api.setAgentModel('qwen', 'hub-model');
  assert.equal(h.calls.length, 1);
  assert.equal(new URL(h.calls[0].url).pathname, '/api/v1/agent-setup/model');
  assert.equal(JSON.parse(h.calls[0].options.body).model, 'hub-model');
  assert.equal(selected, null);
  assert.equal(mutations[1].scopeKey, 'scope-a');
});

test('device default availability updates all Agent readiness fields without masking runtime or account failures', async () => {
  const managed = ['pi', 'qwen', 'opencode', 'dsh', 'kimi', 'harness2', 'codex-harness'];
  const model = 'local:model-0123456789abcdef0123456789abcdef';
  for (const unavailable of [false, true]) {
    const agents = managed.map(key => ({ key, modelPick: true, installed: true, present: true,
      state: unavailable ? 'ready' : 'nollm', setupState: unavailable ? 'ready' : 'needmodel',
      displayState: unavailable ? 'ready' : 'nollm', why: 'Hub model missing' }));
    const h = await fixture([localRunner], { machines: [{ ...localMachine, agents }], models: [], modelCount: 0 });
    h.bridge.localAgentModels = { get: async () => ({ ok: true, scopeKey: 'scope-a', revision: 1,
      selections: Object.fromEntries(managed.map(key => [key, { configured: true, modelName: model, unavailable }])) }) };
    const result = await h.api.localAgentSetup();
    for (const agent of result.agents) {
      assert.equal(agent.state, unavailable ? 'nollm' : 'ready');
      assert.equal(agent.setupState, agent.state);assert.equal(agent.displayState, agent.state);
      assert.equal(agent.model, model);assert.equal(agent.modelGone, unavailable);
      assert.equal(agent.localModelDefault, true);
      assert.equal(agent.why, unavailable ? '原本地默认模型已删除或不可用，请重新选择' : '');
    }
    assert.deepEqual(plain(result.machines[0].agents), plain(result.agents));
  }
  const failures = ['missing', 'setup', 'disabled', 'broken', 'unauthed', 'unknown', 'bad'];
  for (const unavailable of [false, true]) {
    const agents = failures.map((state, index) => ({ key: managed[index], modelPick: true,
      state, setupState: state, why: 'Preserved non-model failure', installed: state !== 'missing' }));
    agents.push({ key: 'custom-partial', modelPick: true, state: 'nollm', setupState: 'nollm', installed: false });
    agents.push({ key: 'custom-runtime', modelPick: true, state: 'bad', setupState: 'nollm', installed: true });
    agents.push({ key: 'codex', modelPick: false, state: 'unauthed', setupState: 'unauthed' });
    agents.push({ key: 'claude', modelPick: false, state: 'ready', setupState: 'ready' });
    const h = await fixture([localRunner], { machines: [{ ...localMachine, agents }], models: [], modelCount: 0 });
    h.bridge.localAgentModels = { get: async () => ({ ok: true, scopeKey: 'scope-a', revision: 1,
      selections: Object.fromEntries(agents.map(agent => [agent.key, { configured: true, modelName: model, unavailable }])) }) };
    const result = await h.api.localAgentSetup();
    for (const [index, agent] of result.agents.entries()) {
      assert.equal(agent.state, agents[index].state);assert.equal(agent.setupState, agents[index].setupState);
      assert.equal(agent.why, agents[index].why);
      if (['codex', 'claude'].includes(agent.key)) assert.deepEqual(plain(agent), agents[index]);
    }
  }
});

for (const kind of ['hub', 'account']) test(`local Agent default mutation stops after ${kind} changes during lookup`, async () => {
  const h = await fixture(), gate = deferred(), mutations = [];
  h.bridge.localAgentModels = { get: () => gate.promise,
    set: async value => mutations.push(value), remove: async value => mutations.push(value) };
  const changing = h.api.setAgentModel('qwen', 'local:model-0123456789abcdef0123456789abcdef');
  const rejected = assert.rejects(changing, stale);
  await h.switch(kind);
  gate.resolve({ ok: true, scopeKey: 'old-scope', revision: 1 });
  await rejected;
  assert.equal(mutations.length, 0);
  assert.equal(h.calls.length, 0);
});

test('local model probes verify the current Runner and never send a model reference to Hub', async () => {
  const h = await fixture([localRunner], { machines: [localMachine], models: [], modelCount: 0 });
  const model = 'local:model-0123456789abcdef0123456789abcdef', probes = [];
  h.bridge.localAgentModels = { get: async () => ({ ok: true, scopeKey: 'scope-a', selections: {} }),
    probe: async input => { probes.push(plain(input)); return { ok: true, localOnly: true, probeKind: 'model-connectivity' }; } };
  const result = await h.api.agentProbe('qwen', model, localRunner.runnerId);
  assert.equal(result.ok, true);
  assert.equal(probes[0].modelName, model);
  assert.doesNotMatch(JSON.stringify(h.calls), /local:model-/);
  await assert.rejects(h.api.agentProbe('qwen', model, 'remote-runner'), /当前设备测试/);
  assert.equal(probes.length, 1);
});

test('empty Agent probes inherit only this device default and cannot fall back after its deletion', async () => {
  const h = await fixture([localRunner], { machines: [localMachine], models: [], modelCount: 0 });
  const model = 'local:model-0123456789abcdef0123456789abcdef', probes = [];
  let unavailable = false;
  h.bridge.localAgentModels = { get: async () => ({ ok: true, scopeKey: 'scope-a', revision: 3,
    selections: { qwen: { configured: true, modelName: model, unavailable } } }),
    probe: async input => { probes.push(plain(input)); return { ok: true, localOnly: true, probeKind: 'agent-execution' }; } };
  assert.equal((await h.api.agentProbe('qwen', '', localRunner.runnerId)).ok, true);
  assert.equal(probes[0].modelName, model);
  assert.equal(probes[0].expectedRevision, 3);
  assert.equal(h.calls.some(row => row.url.includes('/agent-setup/probe')), false);
  unavailable = true;
  await assert.rejects(h.api.agentProbe('qwen', '', localRunner.runnerId), /已删除或不可用/);
  assert.equal(probes.length, 1);
  await h.api.agentProbe('qwen', '', 'remote-runner');
  const remote = h.calls.find(row => row.url.includes('/agent-setup/probe'));
  assert.equal(JSON.parse(remote.options.body).model, '');
  assert.doesNotMatch(JSON.stringify(h.calls), /local:model-/);
});

test('legacy exact identity may supplement missing machine scope without guessing from names', async () => {
  const runner = { ...localRunner, scope: undefined, isCurrentDevice: true };
  const machine = { ...localMachine, scope: undefined, isCurrentDevice: undefined };
  const h = await fixture([runner], { machines: [{ ...machine, runnerId: 'other', label: '我的电脑' }, machine] });
  const result = await h.api.localAgentSetup();
  assert.equal(result.machines.length, 1);
  assert.equal(result.machines[0].scope, 'current-instance');
  assert.equal(result.machines[0].isCurrentDevice, true);
  assert.equal(result.machines[0].runnerId, localRunner.runnerId);
  assert.equal(result.modelCount, null);
});

test('explicit current-instance identity takes precedence over a legacy current-device flag', async () => {
  const h = await fixture([{ ...localRunner, runnerId: 'legacy', scope: undefined, isCurrentDevice: true }, localRunner]);
  await h.api.localAgentSetup();
  assert.equal(new URL(h.calls[1].url).searchParams.get('runnerId'), localRunner.runnerId);
});

test('cloud, backend, foreign, unverified, empty-ID and offline Runners never trigger Agent RPC', async () => {
  const candidates = [cloudRunner, { ...localRunner, scope: 'backend', isCurrentDevice: true },
    { ...localRunner, scope: 'bound-runner', isCurrentDevice: true },
    { ...localRunner, scope: undefined, label: '我的电脑', host: 'same-host', isCurrentDevice: undefined },
    { ...localRunner, runnerId: '  ' }, { ...localRunner, online: false }, { ...localRunner, online: undefined },
    { ...localRunner, execution: 'backend' }, { ...localRunner, scope: 0, isCurrentDevice: true }];
  for (const candidate of candidates) {
    const h = await fixture([candidate]);
    const result = await h.api.localAgentSetup();
    assert.equal(h.calls.length, 1, JSON.stringify(candidate));
    assert.deepEqual(plain(result.machines), []);
    assert.deepEqual(plain(result.agents), []);
    assert.deepEqual(plain(result.models), []);
    assert.equal(result.modelCount, null);
    assert.equal(result.env.why, '当前客户端的 Runner 尚未连接，连接后会显示本机底座。');
  }
});

test('an unavailable local Runner reports native status without fabricating missing models', async () => {
  const h = await fixture([cloudRunner]);
  h.bridge.runnerStatus = async () => ({ connected: false, running: true, error: 'fixture local Runner reconnecting' });
  const result = await h.api.localAgentSetup();
  assert.equal(result.env.why, 'fixture local Runner reconnecting');
  assert.equal(result.modelCount, null);
  assert.equal(h.calls.length, 1);
});

test('matching machine ID cannot override explicit foreign or backend scope', async () => {
  for (const invalid of [{ scope: 'personal-cloud', isCurrentDevice: true }, { scope: 'backend' },
    { scope: 'bound-runner' }, { scope: undefined, isCurrentDevice: false },
    { scope: undefined, isCurrentDevice: 'true' }, { execution: 'backend' }, { online: false }]) {
    const h = await fixture([localRunner], { machines: [{ ...localMachine, ...invalid }],
      agents: cloudMachine.agents, env: cloudMachine.env, modelCount: 0 });
    const result = await h.api.localAgentSetup();
    assert.equal(result.machines.length, 0, JSON.stringify(invalid));
    assert.equal(result.agents.length, 0);
    assert.equal(result.modelCount, null);
    assert.equal(h.calls.length, 2);
  }
});

test('a legacy top-level Agent list without an identified machine is never a local fallback', async () => {
  const h = await fixture([localRunner], { agents: [{ key: 'pi' }], env: { ok: true }, models: [], modelCount: 0 });
  const result = await h.api.localAgentSetup();
  assert.equal(result.machines.length, 0);
  assert.equal(result.agents.length, 0);
  assert.equal(result.modelCount, null);
});

test('exact Runner failure is propagated without retrying the cloud or full inventory', async () => {
  const h = await fixture();
  h.fetch = async url => new URL(url).pathname.endsWith('/runners') ? reply({ runners: h.runners }) :
    new Response('{"detail":"Runner disconnected"}', { status: 503 });
  await assert.rejects(h.api.localAgentSetup(), error => error.status === 503);
  assert.equal(h.calls.length, 2);
  assert.ok(new URL(h.calls[1].url).searchParams.has('runnerId'));
});

for (const kind of ['account', 'hub']) for (const stage of ['runners', 'setup', 'reason']) {
  test(`local setup discards a stale ${stage} result after a ${kind} switch`, async () => {
    const h = await fixture(stage === 'reason' ? [] : undefined), wait = deferred();
    h.fetch = async url => {
      const listing = new URL(url).pathname.endsWith('/runners');
      if (stage === 'runners' && listing || stage === 'setup' && !listing) return wait.promise;
      return reply(listing ? { runners: h.runners } : h.data);
    };
    if (stage === 'reason') h.bridge.runnerStatus = () => wait.promise;
    const pending = h.api.localAgentSetup();
    await tick();
    await h.switch(kind);
    wait.resolve(stage === 'reason' ? { connected: false, running: false } :
      reply(stage === 'runners' ? { runners: h.runners } : h.data));
    await assert.rejects(pending, stale);
    assert.equal(h.calls.length, stage === 'setup' ? 2 : 1);
    assert.ok(h.calls.every(call => call.options.headers.Authorization === 'Device session-alice'));
  });
}

test('authentication refresh between listing and setup cannot send the old Runner ID as another account', async () => {
  const h = await fixture();
  h.bridge.deviceAuthBootstrap = async () => ({ ok: true, stored: true, clientId: 'device-1',
    user: { id: 'bob' }, session: 'session-bob', expiresIn: 1800 });
  h.fetch = async () => ({ ok: true, status: 200, text: async () => {
    h.now += 31 * 60 * 1000;
    return JSON.stringify({ runners: h.runners });
  } });
  await assert.rejects(h.api.localAgentSetup(), stale);
  assert.equal(h.calls.length, 1);
});

test('the existing explicit Agent setup API still supports cloud consumers', async () => {
  const h = await fixture();
  const result = await h.api.agentSetup('cloud');
  assert.equal(h.calls.length, 1);
  assert.equal(new URL(h.calls[0].url).searchParams.get('runnerId'), 'cloud');
  assert.equal(result.machines[0].scope, 'personal-cloud');
});

const scopedOperations = [
  ['agentSetup', api => api.agentSetup('cloud'), '/agent-setup?runnerId=cloud', 'GET'],
  ['agentInstall', api => api.agentInstall('codex-harness', 'install', 'cloud'), '/agent-setup/install', 'POST',
    { key: 'codex-harness', action: 'install', runnerId: 'cloud' }],
  ['cancel Codex login', api => api.agentInstall('codex', 'login-cancel', 'cloud', { jobId: 'cloud|job-1' }), '/agent-setup/install', 'POST',
    { key: 'codex', action: 'login-cancel', runnerId: 'cloud', jobId: 'cloud|job-1' }],
  ['agentProbe', api => api.agentProbe('opencode', 'fixture-model', 'cloud'), '/agent-setup/probe', 'POST',
    { key: 'opencode', model: 'fixture-model', runnerId: 'cloud' }],
  ['agentJob', api => api.agentJob('cloud|job-1'), '/agent-setup/job/cloud%7Cjob-1', 'GET'],
  ['setAgentModel', api => api.setAgentModel('pi', 'fixture-model'), '/agent-setup/model', 'PUT',
    { key: 'pi', model: 'fixture-model' }],
  ['cloudEnvironments', api => api.cloudEnvironments(), '/cloud-environments', 'GET'],
  ['updateCloudEnvironment', api => api.updateCloudEnvironment('cloud', { mode: 'draining' }), '/cloud-environments/cloud', 'PATCH',
    { mode: 'draining' }],
  ['removeCloudEnvironment', api => api.removeCloudEnvironment('cloud'), '/cloud-environments/cloud', 'DELETE'],
];

for (const [name, invoke, route, method, body] of scopedOperations) {
  test(`${name} sends no request when expired authentication restores another account`, async () => {
    const h = await fixture();
    let refreshes = 0;
    h.now += 31 * 60 * 1000;
    h.bridge.deviceAuthBootstrap = async () => {
      refreshes++;
      return { ok: true, stored: true, clientId: 'device-1', user: { id: 'bob' },
        session: 'session-bob', expiresIn: 1800 };
    };
    await assert.rejects(invoke(h.api), stale);
    assert.equal(refreshes, 1);
    assert.equal(h.calls.length, 0);
  });

  test(`${name} keeps its target and payload when authentication refreshes the same account`, async () => {
    const h = await fixture();
    let refreshes = 0;
    h.now += 31 * 60 * 1000;
    h.bridge.deviceAuthBootstrap = async () => {
      refreshes++;
      return { ok: true, stored: true, clientId: 'device-1', user: { id: 'alice' },
        session: 'renewed-alice', expiresIn: 1800 };
    };
    const result = await invoke(h.api);
    assert.deepEqual(plain(result), h.data);
    assert.equal(refreshes, 1);
    assert.equal(h.calls.length, 1);
    const request = h.calls[0], url = new URL(request.url);
    assert.equal(url.pathname + url.search, '/api/v1' + route);
    assert.equal(request.options.method || 'GET', method);
    assert.equal(request.options.headers.Authorization, 'Device renewed-alice');
    assert.equal(Object.hasOwn(request.options, 'taskScope'), false);
    assert.deepEqual(request.options.body ? JSON.parse(request.options.body) : undefined, body);
  });

  test(`${name} never replays an unauthorized request as another account`, async () => {
    const h = await fixture();
    h.fetch = async () => new Response('{"detail":"expired"}', { status: 401 });
    h.bridge.deviceAuthBootstrap = async () => ({ ok: true, stored: true, clientId: 'device-1',
      user: { id: 'bob' }, session: 'session-bob', expiresIn: 1800 });
    await assert.rejects(invoke(h.api), stale);
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].options.headers.Authorization, 'Device session-alice');
  });
}

test('explicit Agent setup discards native fallback diagnostics after an account switch', async () => {
  const h = await fixture([], { machines: [], agents: [], env: {} }), wait = deferred();
  h.bridge.runnerStatus = () => wait.promise;
  const pending = h.api.agentSetup('cloud');
  await tick();
  await h.signIn('bob');
  wait.resolve({ connected: false, running: false, error: 'old account diagnostic' });
  await assert.rejects(pending, stale);
  assert.equal(h.calls.length, 1);
});
