'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
function setup() {
  const listeners = new Map(), pending = [], timers = new Map();
  let now = 1000, calls = 0, timerId = 0;
  const window = {
    addEventListener(name, fn) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(fn);
    },
    SoduWorkAPI: { pluginCatalog: () => { calls++; return new Promise((resolve, reject) => pending.push({ resolve, reject })); } },
  };
  const document = { querySelectorAll: () => [] };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../components/panels/work-composer.js'), 'utf8'), {
    window, document, Date: { now: () => now }, Promise,
    setTimeout: fn => { const id = ++timerId; timers.set(id, fn); return id; },
    clearTimeout: id => timers.delete(id),
  });
  return { api: window.WorkComposer, pending, timers, get calls() { return calls; },
    advance: value => { now += value; },
    emit: name => listeners.get(name)?.forEach(fn => fn()),
  };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
const catalog = id => ({ items: [{ pluginId: id, personal: true, name: id }] });

test('menu warmup coalesces concurrent requests and exposes a synchronous snapshot for opening', async () => {
  const s = setup();
  const first = s.api.loadMenuPlugins(), second = s.api.loadMenuPlugins();
  await flush();
  assert.equal(s.calls, 1);
  s.pending[0].resolve(catalog('one')); await Promise.all([first, second]);
  assert.equal(s.api.peekMenuPlugins().items[0].pluginId, 'one');
  await s.api.loadMenuPlugins(); assert.equal(s.calls, 1);
});
test('expired menu data refreshes once while preserving same-account visible rows', async () => {
  const s = setup();
  const initial = s.api.loadMenuPlugins(); await flush(); s.pending[0].resolve(catalog('old')); await initial;
  s.advance(31000);
  const refresh = s.api.loadMenuPlugins(); await flush();
  assert.equal(s.api.peekMenuPlugins().items[0].pluginId, 'old');
  assert.equal(s.calls, 2);
  s.pending[1].resolve(catalog('new')); await refresh;
  assert.equal(s.api.peekMenuPlugins().items[0].pluginId, 'new');
});
for (const event of ['soduwork-data-scope-changed', 'soduwork:plugins-changed', 'soduwork-plugin-policy']) {
  test(event + ' clears cached menu grants and prevents old requests repopulating them', async () => {
    const s = setup();
    const initial = s.api.loadMenuPlugins(); await flush(); s.pending[0].resolve(catalog('old')); await initial;
    const stale = s.api.loadMenuPlugins(true).catch(error => error);
    await flush(); s.emit(event);
    assert.equal(s.api.peekMenuPlugins(), null);
    const current = s.api.loadMenuPlugins(); await flush();
    s.pending[2].resolve(catalog('new')); await current;
    s.pending[1].resolve(catalog('late')); await stale;
    assert.equal(s.api.peekMenuPlugins().items[0].pluginId, 'new');
  });
}
test('a failed warmup can be retried and never becomes a successful empty catalog', async () => {
  const s = setup();
  const first = s.api.loadMenuPlugins().catch(error => error); await flush();
  s.pending[0].reject(Error('offline')); assert.match((await first).message, /offline/);
  assert.equal(s.api.peekMenuPlugins(), null);
  const retry = s.api.loadMenuPlugins(); await flush();
  s.pending[1].resolve(catalog('recovered')); await retry;
  assert.equal(s.api.peekMenuPlugins().items[0].pluginId, 'recovered');
});
test('a hung warmup times out, releases its flight and ignores the eventual stale result', async () => {
  const s = setup();
  const first = s.api.loadMenuPlugins().catch(error => error); await flush();
  [...s.timers.values()].forEach(fn => fn()); await first;
  const retry = s.api.loadMenuPlugins(); await flush();
  s.pending[1].resolve(catalog('retry')); await retry;
  s.pending[0].resolve(catalog('late')); await flush();
  assert.equal(s.api.peekMenuPlugins().items[0].pluginId, 'retry');
});

function apiHarness(remote, authenticated = false) {
  const pending = [], listeners = new Map();
  const values = new Map([['soduwork_work_hub_url', 'http://hub-a:8989']]);
  let remoteCalls = 0, user = 'alice';
  const bridge = { personalPlugins: {
    list: () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
  } };
  if (authenticated) bridge.deviceAuthBootstrap = async () => ({
    ok: true, stored: true, clientId: 'menu-test', user: { id: user },
    session: 'session-' + user, expiresIn: 1800,
  });
  const window = {
    __SODUWORK_TEST_HUB_CONFIG__: { allowSwitch: true }, soduWorkAPI: bridge,
    addEventListener(name, listener) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(listener);
    },
    removeEventListener: (name, listener) => listeners.get(name)?.delete(listener),
    dispatchEvent: event => listeners.get(event.type)?.forEach(listener => listener(event)),
  };
  const context = vm.createContext({
    window, User: { id: 'menu-test' }, navigator: { platform: 'test' },
    localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) },
    console: { log() {}, error() {} }, URL, URLSearchParams,
    fetch: async () => { remoteCalls++; return remote(); },
    CustomEvent: class { constructor(type) { this.type = type; } },
    AbortController, FormData, Response, setTimeout: () => 0, clearTimeout() {}, WebSocket: class {},
  });
  for (const file of ['core/api-work-plugins.js', 'api.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context, {filename: file});
  }
  const api = window.SoduWorkAPI;
  const initialScopeListeners = new Set(listeners.get('soduwork-data-scope-changed') || []);
  return { api, pending, get remoteCalls() { return remoteCalls; },
    emit: type => window.dispatchEvent({ type }),
    signIn: async next => { user = next; await api.registerClient(); },
    switchHub: host => api.setHubEnvironment('development', 'http://' + host + ':8989'),
    scopeListenerCount: () => {
      const current = listeners.get('soduwork-data-scope-changed') || new Set();
      assert.ok([...initialScopeListeners].every(listener => current.has(listener)),
        'Catalog cleanup must retain the API lifetime scope listeners');
      return current.size - initialScopeListeners.size;
    },
  };
}
test('local plugin discovery and Hub catalog start concurrently, then merge both sources', async () => {
  const s = apiHarness(() => new Response(JSON.stringify(catalog('remote'))));
  const load = s.api.pluginCatalog(); await flush();
  assert.equal(s.remoteCalls, 1, 'Hub lookup must not wait for filesystem discovery');
  s.pending[0].resolve(catalog('local'));
  assert.deepEqual(Array.from((await load).items, item => item.pluginId), ['local', 'remote']);
});
test('parallel catalog retains personal plugins during a Hub outage and reports the partial failure', async () => {
  const s = apiHarness(() => { throw Error('offline'); });
  const load = s.api.pluginCatalog(); await flush(); s.pending[0].resolve(catalog('local'));
  const result = await load;
  assert.equal(result.items[0].pluginId, 'local');
  assert.match(result.remoteError, /offline/);
});
test('a Hub outage with no personal plugins remains a retryable error', async () => {
  const s = apiHarness(() => { throw Error('offline'); });
  const load = s.api.pluginCatalog(); await flush(); s.pending[0].resolve({ items: [] });
  await assert.rejects(load, /offline/);
});

for (const source of ['local', 'remote']) {
  for (const code of ['STALE_TASK_SCOPE', 'DEVICE_AUTH_INIT_TIMEOUT']) {
    test(`${source} catalog ${code} cannot be downgraded to partial success`, async () => {
      const boundary = Object.assign(Error('identity boundary'), { code });
      const s = apiHarness(() => {
        if (source === 'remote') throw boundary;
        return new Response(JSON.stringify(catalog('remote')));
      });
      const load = s.api.pluginCatalog(); await flush();
      if (source === 'local') s.pending[0].reject(boundary);
      else s.pending[0].resolve(catalog('local:old-owner'));
      await assert.rejects(load, error => error.code === code);
      assert.equal(s.scopeListenerCount(), 0);
    });
  }
}

for (const scope of ['account', 'hub']) {
  for (const first of ['local', 'remote']) {
    test(`catalog cannot merge a completed ${first} result after ${scope} changes`, async () => {
      let resolveRemote;
      const remote = new Promise(resolve => { resolveRemote = resolve; });
      const s = apiHarness(() => remote, true); await s.signIn('alice');
      const load = s.api.pluginCatalog(); await flush();
      assert.equal(s.remoteCalls, 1);
      if (first === 'local') s.pending[0].resolve(catalog('local:alice'));
      else resolveRemote(new Response(JSON.stringify(catalog('remote:alice'))));
      await flush();
      if (scope === 'account') await s.signIn('bob');
      else s.switchHub('hub-b');
      if (first === 'local') resolveRemote(new Response(JSON.stringify(catalog('remote:alice'))));
      else s.pending[0].resolve(catalog('local:alice'));
      await assert.rejects(load, error => error.code === 'STALE_TASK_SCOPE');
      assert.equal(s.scopeListenerCount(), 0);
    });
  }

  test(`changing ${scope} away and back still discards the in-flight catalog`, async () => {
    const s = apiHarness(() => new Response(JSON.stringify(catalog('remote:alice'))), true);
    await s.signIn('alice');
    const load = s.api.pluginCatalog(); await flush();
    if (scope === 'account') { await s.signIn('bob'); await s.signIn('alice'); }
    else { s.switchHub('hub-b'); s.switchHub('hub-a'); await s.signIn('alice'); }
    s.pending[0].resolve(catalog('local:alice'));
    await assert.rejects(load, error => error.code === 'STALE_TASK_SCOPE');
    assert.equal(s.scopeListenerCount(), 0);
  });
}

test('ordinary local discovery failure still permits the healthy Hub catalog', async () => {
  const s = apiHarness(() => new Response(JSON.stringify(catalog('remote'))));
  const load = s.api.pluginCatalog(); await flush(); s.pending[0].reject(Error('filesystem unavailable'));
  assert.deepEqual(Array.from((await load).items, item => item.pluginId), ['remote']);
  assert.equal(s.scopeListenerCount(), 0);
});

test('initial authentication cannot merge pre-auth local rows, and the authenticated retry succeeds', async () => {
  const s = apiHarness(() => new Response(JSON.stringify(catalog('remote:alice'))), true);
  const first = s.api.pluginCatalog(); await flush(); s.pending[0].resolve(catalog('local:unbound'));
  await assert.rejects(first, error => error.code === 'STALE_TASK_SCOPE');
  assert.equal(s.remoteCalls, 0, 'do not request a catalog under a newly substituted identity');
  const retry = s.api.pluginCatalog(); await flush(); s.pending[1].resolve(catalog('local:alice'));
  assert.deepEqual(Array.from((await retry).items, item => item.pluginId), ['local:alice', 'remote:alice']);
  assert.equal(s.scopeListenerCount(), 0);
});

test('simultaneous directory consumers share one local and remote read, but reopening revalidates', async () => {
  const s = apiHarness(() => new Response(JSON.stringify(catalog('remote'))));
  const first = s.api.pluginCatalog(), second = s.api.pluginCatalog(); await flush();
  assert.equal(s.remoteCalls, 1); assert.equal(s.pending.length, 1);
  assert.equal(s.scopeListenerCount(), 1, 'Coalesced consumers share one request scope listener');
  s.pending[0].resolve(catalog('local'));
  assert.deepEqual(await first, await second);
  const next = s.api.pluginCatalog(); await flush();
  assert.equal(s.remoteCalls, 2); s.pending[1].resolve(catalog('updated')); await next;
  assert.equal(s.scopeListenerCount(), 0);
});
for (const event of ['soduwork:plugins-changed', 'soduwork-plugin-policy']) {
  test(event + ' supersedes a shared in-flight directory and rejects all old consumers', async () => {
    const s = apiHarness(() => new Response(JSON.stringify(catalog('remote'))));
    const old = s.api.pluginCatalog(), sibling = s.api.pluginCatalog();
    const errors = Promise.all([assert.rejects(old, { code: 'STALE_TASK_SCOPE' }), assert.rejects(sibling, { code: 'STALE_TASK_SCOPE' })]);
    await flush(); s.emit(event);
    const current = s.api.pluginCatalog(); await flush();
    assert.equal(s.pending.length, 2); s.pending[1].resolve(catalog('new')); await current;
    s.pending[0].resolve(catalog('obsolete')); await errors;
    assert.equal(s.scopeListenerCount(), 0);
  });
}
test('concurrent team capability reads coalesce and later reads revalidate', async () => {
  const pending = [], s = apiHarness(() => new Promise(resolve => pending.push(resolve)));
  const first = s.api.getTeamCapability(), second = s.api.getTeamCapability(); await flush();
  assert.equal(s.remoteCalls, 1); pending[0](new Response('{"assigned":true}'));
  assert.equal((await first).assigned, true); assert.equal((await second).assigned, true);
  const again = s.api.getTeamCapability(); await flush();
  assert.equal(s.remoteCalls, 2); pending[1](new Response('{"assigned":false}')); assert.equal((await again).assigned, false);
});
