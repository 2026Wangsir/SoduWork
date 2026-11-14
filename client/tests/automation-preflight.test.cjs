'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { create, merge } = require('../main/automation-preflight.cjs');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function fixture(overrides = {}) {
  const state = {
    identity: { hub: 'http://hub.example', clientId: 'device', uid: 'owner' },
    plugin: { pluginId: 'personal:method', key: 'method', personal: true, enabled: true,
      version: '1.0.0', checksum: 'a'.repeat(64), setupState: 'ready',
      entrypoints: { automation: true }, capabilities: { platforms: ['wecom'], mcpServers: ['docs'] } },
    account: { state: 'connected', connected: true }, calls: [],
  };
  const service = create({ app: {}, identityOf: async () => state.identity,
    connectionScope: id => id.hub + '/' + id.clientId + '/' + id.uid,
    catalog: () => state.plugin ? [state.plugin] : [],
    resolvePlugin: () => state.calls.push('resources'), authorize: async () => state.calls.push('permission'),
    platformConnections: { refresh: async key => { state.calls.push(key); return state.account; } },
    connectorProbe: async (_, names) => { state.calls.push(names); return names.map(name => ({ key: 'connector', name, state: 'ready' })); },
    ...overrides,
  });
  const server = { state: 'waiting', mode: 'personal', executionReady: true, message: 'device dependencies waiting',
    checks: [{ key: 'runner', state: 'ready' }, { key: 'device-dependencies', state: 'waiting' }],
    deviceDependencies: { ownerClientId: 'device', plugin: { key: 'method', versionPolicy: 'latest' } } };
  return { state, server, run: extra => service.preflight({ server, ...extra }) };
}

test('personal dependencies use real catalog, setup, platform refresh and connector discovery', async () => {
  const f = fixture(); const result = await f.run();
  assert.equal(result.state, 'ready'); assert.equal(result.deviceDependencies.state, 'ready');
  assert.deepEqual(f.state.calls, ['permission', 'resources', 'wecom', ['docs']]);
  assert.ok(!result.checks.some(row => row.key === 'device-dependencies'));
});

for (const [name, mutate] of [
  ['missing', f => { f.state.plugin = null; }],
  ['disabled', f => { f.state.plugin.enabled = false; }],
  ['not automated', f => { f.state.plugin.entrypoints.automation = false; }],
  ['setup incomplete', f => { f.state.plugin.setupState = 'needs_setup'; }],
  ['pinned version', f => { f.server.deviceDependencies.plugin = { key: 'method', versionPolicy: 'pinned', version: '2.0.0', checksum: 'b'.repeat(64) }; }],
]) test(name + ' is blocked before refreshing connectors', async () => {
  const f = fixture(); mutate(f); assert.equal((await f.run()).state, 'blocked'); assert.deepEqual(f.state.calls, []);
});

test('latest policy follows current installed version; pinned exact match passes', async () => {
  const f = fixture();
  f.server.deviceDependencies.plugin = { key: 'method', versionPolicy: 'pinned', version: f.state.plugin.version, checksum: f.state.plugin.checksum };
  assert.equal((await f.run()).state, 'ready');
});
test('missing account authorization blocks saving without invoking business tools', async () => {
  const f = fixture(); f.state.account = { connected: false, state: 'needs_auth' };
  const result = await f.run(); assert.equal(result.state, 'blocked');
  assert.deepEqual(f.state.calls, ['permission', 'resources', 'wecom']);
});
test('platform errors and source access transport errors remain unverified, never ready', async () => {
  const f = fixture(); f.state.account = { connected: false, state: 'error', message: 'private upstream payload' };
  const result = await f.run(); assert.equal(result.state, 'waiting');
  assert.ok(!JSON.stringify(result).includes('private'));
  const source = fixture({ authorize: async () => { throw Error('private permission timeout'); } });
  assert.equal((await source.run()).state, 'waiting'); assert.deepEqual(source.state.calls, []);
});
test('invalid plugin resources are a definite blocker', async () => {
  const f = fixture({ resolvePlugin: () => { throw Error('private path'); } });
  const result = await f.run(); assert.equal(result.state, 'blocked'); assert.ok(!JSON.stringify(result).includes('private path'));
});
test('disabled or missing MCP checks propagate their actual state', async () => {
  const f = fixture({ connectorProbe: async () => [{ key: 'connector', state: 'blocked', label: 'missing' }] });
  assert.equal((await f.run()).state, 'blocked');
});
test('ready local dependencies cannot hide offline Runner or blocked Hub policy', async () => {
  const f = fixture(); f.server.executionReady = false; f.server.message = 'Runner offline';
  const result = await f.run(); assert.equal(result.state, 'waiting'); assert.equal(result.message, 'Runner offline');
  assert.equal(result.deviceDependencies.state, 'ready');
  assert.deepEqual(merge({ state: 'blocked', message: 'policy' }, { state: 'ready' }), { state: 'blocked', message: 'policy' });
});
test('another owner device or Hub does not inspect this device credentials', async () => {
  const f = fixture(); f.server.deviceDependencies.ownerClientId = 'other';
  assert.equal((await f.run()).state, 'waiting'); assert.deepEqual(f.state.calls, []);
  f.server.deviceDependencies.ownerClientId = 'device';
  assert.equal((await f.run({ hub: 'http://other.example' })).state, 'waiting'); assert.deepEqual(f.state.calls, []);
});
test('account switch during async checks cannot return ready', async () => {
  const wait = deferred(); const f = fixture({ authorize: () => wait.promise });
  const run = f.run(); await Promise.resolve(); f.state.identity.uid = 'other'; wait.resolve();
  assert.equal((await run).state, 'waiting'); assert.ok(!f.state.calls.includes('wecom'));
});
test('disable or change plugin while checking invalidates readiness', async () => {
  for (const disabled of [false, true]) {
    const wait = deferred(); const f = fixture({ connectorProbe: () => wait.promise });
    const run = f.run(); await new Promise(r => setImmediate(r));
    if (disabled) f.state.plugin.enabled = false; else f.state.plugin.version = '1.0.1';
    wait.resolve([]); assert.equal((await run).state, disabled ? 'blocked' : 'waiting');
  }
});
test('form checks deduplicate and cache briefly, while save forces a new account check', async () => {
  const f = fixture(); await Promise.all([f.run(), f.run()]); await f.run();
  assert.equal(f.state.calls.filter(x => x === 'wecom').length, 1);
  f.state.account = { state: 'needs_auth', connected: false };
  assert.equal((await f.run({ force: true })).state, 'blocked');
  assert.equal(f.state.calls.filter(x => x === 'wecom').length, 2);
});
test('save waits for an older in-flight check then checks the current account again', async () => {
  const wait = deferred(); let calls = 0;
  const f = fixture({ platformConnections: { refresh: async () => ++calls === 1 ? wait.promise : ({ state: 'needs_auth', connected: false }) } });
  const original = f.run(); await new Promise(r => setImmediate(r));
  const save = f.run({ force: true }); wait.resolve({ state: 'connected', connected: true });
  assert.equal((await original).state, 'ready'); assert.equal((await save).state, 'blocked'); assert.equal(calls, 2);
});

test('local disconnect invalidates the recent ready cache and blocks dependencies', async () => {
  let revision = 0, connected = true, calls = 0;
  const f = fixture({ platformConnections: { revision: () => revision, refresh: async () => {
    calls++; return { connected, state: connected ? 'connected' : 'error', disconnected: !connected };
  } } });
  assert.equal((await f.run()).state, 'ready'); assert.equal((await f.run()).state, 'ready');
  assert.equal(calls, 1); revision++; connected = false;
  assert.equal((await f.run()).state, 'blocked'); assert.equal(calls, 2);
});
test('disconnect during an in-flight dependency check cannot return or cache stale ready', async () => {
  let revision = 0, connected = true;
  const wait = deferred();
  const f = fixture({ platformConnections: { revision: () => revision,
    refresh: async () => ({ connected, state: connected ? 'connected' : 'disconnected', disconnected: !connected }) },
    connectorProbe: async () => wait.promise });
  const checking = f.run(); await new Promise(r => setImmediate(r));
  revision++; connected = false; wait.resolve([]);
  assert.equal((await checking).state, 'waiting'); assert.equal((await f.run()).state, 'blocked');
});

test('local automation models are verified on the owning desktop before plugin checks', async () => {
  const model = 'local:model-0123456789abcdef0123456789abcdef';
  let resolved = 0;
  const f = fixture({ localModelResolve: value => {
    resolved++;
    return value === model ? { modelRef: value, localOnly: true } : null;
  } });
  const ready = await f.run({ localModelName: model, assigneeId: 'local:pi' });
  assert.equal(ready.state, 'ready');
  assert.equal(resolved, 1);
  const missing = fixture({ localModelResolve: () => null });
  const result = await missing.run({ localModelName: model, assigneeId: 'local:pi' });
  assert.equal(result.state, 'blocked');
  assert.match(result.message, /本机模型已不可用/);
  assert.deepEqual(missing.state.calls, []);
});

test('local automation models cannot be preflighted for remote or non-Pi seats', async () => {
  const model = 'local:model-abcdefabcdefabcdefabcdefabcdefab';
  const f = fixture({ localModelResolve: () => ({ modelRef: model, localOnly: true }) });
  const result = await f.run({ localModelName: model, assigneeId: 'runner:desk:pi' });
  assert.equal(result.state, 'blocked');
  assert.match(result.message, /本地模型只能选择本机托管型/);
  assert.deepEqual(f.state.calls, []);
});

test('local automation models can use any same-device managed Runner', async () => {
  const model = 'local:model-abcdefabcdefabcdefabcdefabcdefab';
  const f = fixture({ localModelResolve: () => ({ modelRef: model, localOnly: true }) });
  const ready = await f.run({ localModelName: model, assigneeId: 'runner:desk:qwen',
    assigneeMode: 'local', assigneeClientId: 'device' });
  assert.equal(ready.state, 'ready');
});

test('local automation models accept a same-device Pi Runner seat only', async () => {
  const model = 'local:model-abcdefabcdefabcdefabcdefabcdefab';
  const f = fixture({ localModelResolve: () => ({ modelRef: model, localOnly: true }) });
  const ready = await f.run({ localModelName: model, assigneeId: 'runner:desk:pi',
    assigneeMode: 'local', assigneeClientId: 'device' });
  assert.equal(ready.state, 'ready');
  const remote = await f.run({ localModelName: model, assigneeId: 'runner:desk:pi',
    assigneeMode: 'local', assigneeClientId: 'other' });
  assert.equal(remote.state, 'blocked');
});
