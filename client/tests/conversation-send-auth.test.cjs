'use strict';

// Production identity, owner persistence, IPC send, and runtime adapters. Only
// Electron windows, Hub responses, Runner RPC, and the Pi inference engine are
// isolated fixtures; this does not claim paid-model or installed-CLI coverage.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const memory = require('../main/conversation/session-memory');
const catalog = require('../main/agent-runtime/runtime-catalog');
const { createPiSessionBridge } = require('../main/agent-runtime/pi-session-bridge');
const { createRunnerRuntimeAdapter, _uuidV5 } = require('../main/agent-runtime/runner-adapter');
const { scope } = require('../main/platform-connections/runtime.cjs');
const { createSafeStorage } = require('./helpers/device-safe-storage-fixture.cjs');

function loadIpc(bridge) {
  const file = require.resolve('../main/pi-session/ipc');
  const nativeRequire = createRequire(file);
  const module = { exports: {} };
  const requireFixture = name => {
    if (name === '../agent-runtime/pi-session-bridge') return bridge;
    if (name === 'electron') return { shell: {}, dialog: {} };
    return nativeRequire(name);
  };
  vm.runInThisContext('(function(require,module,exports,__filename,__dirname){\n' +
    fs.readFileSync(file, 'utf8') + '\n})', { filename: file })(
    requireFixture, module, module.exports, file, path.dirname(file));
  return module.exports;
}

function newAuth() {
  const file = require.resolve('../main/device-auth');
  delete require.cache[file];
  return require(file);
}

async function fixture(t, spec, legacySendIdentity = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-send-auth-'));
  const app = new EventEmitter();
  app.getPath = () => root;
  app.getVersion = () => '1.12.51-test';
  const handlers = new Map(), listeners = new Map(), frames = [];
  const ipcMain = { handle: (name, callback) => handlers.set(name, callback),
    on: (name, callback) => listeners.set(name, callback) };
  const mainFrame = {}, sender = { id: 1, mainFrame, isDestroyed: () => false,
    getURL: () => require('node:url').pathToFileURL(path.resolve(__dirname, '../desk.html')).href,
    send: (channel, data) => frames.push({ channel, data }) };
  const window = new EventEmitter();
  window.webContents = sender; window.isDestroyed = () => false;
  const event = { sender, senderFrame: mainFrame };
  const BrowserWindow = { getAllWindows: () => [window], fromWebContents: contents => contents === sender ? window : null };
  const safeStorage = createSafeStorage();
  let auth = newAuth(), uid = 'fixture-account-a', enrollmentCount = 0, loggedOut = false;
  let failure = '', now = Date.now();
  const originalNow = Date.now, originalFetch = global.fetch;
  let bridge, installed;
  t.after(async () => {
    try {
      app.emit('before-quit');
      await installed?.dispose();
      await bridge?.dispose();
      await new Promise(resolve => setImmediate(resolve));
    } finally {
      global.fetch = originalFetch;
      Date.now = originalNow;
      assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
      assert.ok(path.basename(root).startsWith('soduwork-send-auth-'));
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  Date.now = () => now;
  function authResponse(body, account = uid) {
    const issued = Math.floor(Date.now() / 1000);
    const claims = { typ: 'device', uid: account, cid: body.device, iat: issued, exp: issued + 1800 };
    const session = Buffer.from(JSON.stringify(claims)).toString('base64url') + '.' + '0'.repeat(64);
    return { ok: true, status: 200, text: async () => JSON.stringify({
      authState: 'active', activationRequired: false, session, expiresIn: 1800, user: { id: account },
    }) };
  }
  global.fetch = async (url, options = {}) => {
    if (String(url).endsWith('/api/v1/clients/enroll')) {
      enrollmentCount++;
      await new Promise(resolve => setImmediate(resolve));
      if (failure) return { ok: false, status: 503,
        text: async () => JSON.stringify({ detail: failure }) };
      if (loggedOut) return { ok: true, status: 200, text: async () => JSON.stringify({
        authState: 'pending', activationRequired: true,
      }) };
      return authResponse(JSON.parse(options.body));
    }
    if (String(url).endsWith('/api/v1/client-auth/logout')) {
      loggedOut = true;
      return { ok: true, status: 200, text: async () => '{"ok":true}' };
    }
    if (String(url).endsWith('/api/v1/client-auth/login')) {
      const body = JSON.parse(options.body);
      uid = body.account;
      loggedOut = false;
      return authResponse(body);
    }
    // A real optional usage reporter may flush fixture completion counters.
    if (String(url).endsWith('/api/v1/usage/events')) return {
      ok: true, status: 200, text: async () => '{"ok":true}',
    };
    throw Error('Unexpected network request in isolated authentication fixture');
  };
  const installAuth = () => auth.install({ app, ipcMain, safeStorage });
  installAuth();
  const enrollment = await auth.enroll(app, { hub: 'http://127.0.0.1:9' });
  assert.equal(enrollment.ok, true);
  const identityOf = (...args) => auth.authenticatedIdentity(...args);
  const model = { id: 'fixture-model', key: 'fixture-only', baseUrl: 'http://model.invalid' };
  const turns = [], piHistory = new Map(), runnerHistory = new Map(), runnerInventory = new Map(), nativeHandles = new Map(), controls = [];
  let openedNumber = 0;

  const engine = {
    probe: () => ({ ok: true }),
    async historyEntry(_app, id) {
      return piHistory.has(id) ? { ok: true, entry: { id, path: id, cwd: root, adapterId: 'pi' } }
        : { ok: false, notFound: true };
    },
    async open(options) {
      const sessionId = options.resumePath || 'fixture-pi-' + (++openedNumber);
      const messages = piHistory.get(sessionId) || [];
      piHistory.set(sessionId, messages);
      const listeners = new Set();
      const handle = {
        adapterId: 'pi', displayName: 'Pi',
        ref: options.ref, sessionId, cwd: root, ui: {},
        on: callback => { listeners.add(callback); return () => listeners.delete(callback); },
        status: () => 'idle', inFlight: () => false,
        snapshot: () => ({ status: 'idle', messages: messages.slice(), tools: [] }),
        historyRow: () => ({ id: sessionId, adapterId: 'pi', cwd: root }),
        cancel() { controls.push('cancel'); },
        cancelQueued() { controls.push('cancelQueued'); return { ok: true }; },
        updateQueue() { controls.push('updateQueue'); return { ok: true }; },
        submit(text) {
          turns.push({ adapter: 'pi', text });
          messages.push({ role: 'user', text });
          listeners.forEach(fn => fn({ kind: 'turn-dequeued' }));
          messages.push({ role: 'assistant', text: 'Fixture reply: ' + text, done: true });
          listeners.forEach(fn => fn({ kind: 'turn-finished' }));
          return { accepted: true, completion: Promise.resolve({ ok: true }) };
        },
        async close() {
          const dispose = handle.ui.memorySubscription;
          delete handle.ui.memorySubscription;
          if (dispose) await dispose();
          listeners.clear();
        },
      };
      nativeHandles.set(handle.ref, { handle, emit: kind => listeners.forEach(fn => fn({ kind }, handle.snapshot())) });
      return { ok: true, session: handle };
    },
  };
  const runtime = { async rpc(op, input) {
    if (op === 'runtime.detect') return { ok: true, data: { installed: true, state: 'ready' } };
    if (op === 'job.dispatch') {
      const ref = _uuidV5('9af442c8-cd1d-4b91-a668-22da2b2635bf', 'chat:' + input.task.id + ':' + input.cli);
      turns.push({ adapter: input.cli, text: input.ctx.conversationUserText });
      runnerHistory.set(ref, [{ seq: 1, kind: 'say', text: 'Fixture first reply' }]);
      runnerInventory.set(ref, { ref, cli: input.cli, taskId: input.task.id, workDir: root,
        state: 'done', started: Date.now() / 1000 });
      return { ok: true, data: { ref } };
    }
    if (op === 'job.comment') {
      turns.push({ adapter: spec.id, text: input.text });
      const rows = runnerHistory.get(input.ref) || [];
      rows.push({ seq: rows.length + 1, kind: 'say', text: 'Fixture reply: ' + input.text });
      runnerHistory.set(input.ref, rows);
      return { ok: true, data: { ok: true } };
    }
    if (op === 'job.session') {
      const items = runnerHistory.get(input.ref) || [];
      return { ok: true, data: { status: 'done', round: items.length, items } };
    }
    if (op === 'job.stop') return { ok: true, data: { ok: true } };
    if (op === 'runtime.sessions') return { ok: true, data: { runs: [...runnerInventory.values()] } };
    throw Error('Unexpected isolated RPC: ' + op);
  } };
  bridge = createPiSessionBridge({ app, sessionModule: engine,
    runnerAdapters: catalog.runtimes().filter(row => row.transport === 'runner').map(row => createRunnerRuntimeAdapter({
      app, runtimeSpec: row, runnerRuntime: runtime,
      modelConfig: { fetchModel: async () => ({ ok: true, model }) },
    })),
  });
  installed = loadIpc(bridge).install({ app, ipcMain, BrowserWindow, identityOf,
    // The explicit legacy shape is a negative control: the original production
    // callback returned a device key without the already-cached session.
    sendIdentityOf: legacySendIdentity ? (...args) => auth.identity(...args) : identityOf,
  });
  const memories = memory.install({ app, ipcMain: { handle() {} }, identityOf });
  async function open(resume) {
    const result = await installed.open({ adapterId: spec.id, cwd: root, capabilities: [],
      ...(resume ? { chatId: resume } : {}) });
    assert.equal(result.ok, true, result.reason);
    const handle = bridge.get(result.ref);
    assert.ok(handle);
    return handle;
  }
  async function send(handle, text) {
    // Call the installed production IPC handler; there is no alternate test send path.
    const result = await handlers.get('pi-session-send')(null, handle.ref, text, [], {});
    if (result.ok) {
      // IPC deliberately returns before inference completes. Wait for the real
      // adapter's terminal snapshot before opening/closing the next fixture turn.
      for (let i = 0; i < 200 && handle.inFlight?.(); i++) await new Promise(r => setTimeout(r, 10));
      assert.equal(Boolean(handle.inFlight?.()), false, 'adapter must reach its terminal state');
      assert.equal(handle.snapshot().status, 'idle', 'adapter completion must succeed, not merely stop');
    }
    return result;
  }
  return { root, app, open, send, installed, bridge, turns, memories, handlers,
    event, listeners, frames, controls, closeWindow: () => window.emit('closed'),
    emit: (handle, kind) => nativeHandles.get(handle.ref).emit(kind),
    openInstalled: options => handlers.get('pi-session-open')(event, { capabilities: [], ...options }),
    identity: () => auth.authenticatedIdentity(app), localIdentity: () => auth.identity(app),
    sessionReady: () => Boolean(auth.session(app)), enrollments: () => enrollmentCount,
    expire: () => { now += 3600 * 1000; },
    fail: reason => { failure = reason; },
    switchAccount: () => { uid = 'fixture-account-b'; auth.clearSession(app); },
    restartAuth: () => { auth = newAuth(); installAuth(); },
    selectHub: hub => auth.selectHub(app, hub),
    enrollHub: hub => auth.enroll(app, { hub }),
    sessionFor: hub => auth.session(app, hub),
    clear: () => auth.clearSession(app),
    logout: () => auth.logout(app),
    login: () => auth.login(app, { hub: auth.identity(app).hub,
      account: 'fixture-account-b', password: 'fixture-only' }),
  };
}


async function openCachedCopy(f) {
  await f.bridge.indexedHistoryRow('imported-snapshot');
  const store = require('../main/conversation/replica-store.cjs').createWorker(path.join(f.root, 'conversation-replicas', 'history.sqlite'));
  const body = Buffer.from(JSON.stringify([{ role: 'user', text: 'Cached private prompt' }, { role: 'assistant', text: 'Cached private answer' }]));
  const pointer = { sha256: require('node:crypto').createHash('sha256').update(body).digest('hex'), size: body.length };
  try {
    assert.equal((await store.importChunk('imported-snapshot', pointer, 0, body.toString('base64'))).ok, true);
    assert.equal((await store.sealImport('imported-snapshot', pointer, { title: 'Cached snapshot', adapterId: 'pi',
      creator: { account: 'fixture-account-a', hub: f.localIdentity().hub }, importedHistory: true })).ok, true);
  } finally { await store.close(); }
  const opened = await f.openInstalled({ chatId: 'imported-snapshot' });
  assert.equal(opened.ok, true, opened.reason);
  const handle = f.bridge.get(opened.ref);
  assert.equal(handle.localReplica, true);
  return handle;
}

test('production installed cached readonly snapshots load the original transcript without invoking a model', async t => {
  const f = await fixture(t, catalog.runtime('pi')), handle = await openCachedCopy(f);
  const snapshot = () => f.handlers.get('pi-session-snapshot')(f.event, handle.ref, { messageLimit: 200 });
  const result = await snapshot();
  assert.equal(result.ok, true);
  assert.deepEqual(result.snapshot.messages.map(row => row.text), ['Cached private prompt', 'Cached private answer']);
  assert.equal(result.snapshot.execution.readOnly, true);
  const calls = [], restore = [];
  for (const [name, key] of [['../main/pi-session/skill-turn', 'names'],
    ['../main/pi-session/plugin-context', 'inputSelections'], ['../main/pi-session/task-input', 'prepare'],
    ['../main/pi-session/attachments', 'stage']]) {
    const dependency = require(name), original = dependency[key];
    dependency[key] = (...args) => { calls.push(key); return original(...args); };
    restore.push(() => { dependency[key] = original; });
  }
  const originalSend = handle.send;
  handle.send = (...args) => { calls.push('send'); return originalSend(...args); };
  let denied;
  try {
    denied = await f.handlers.get('pi-session-send')(f.event, handle.ref, 'Cannot execute a cached copy', [],
      { skills: ['fixture-skill'], plugins: [{ pluginId: 'fixture-plugin', inputValues: { key: 'value' } }], taskId: 'fixture-task' });
  } finally { for (const undo of restore) undo(); handle.send = originalSend; }
  assert.equal(denied.ok, false); assert.equal(denied.accepted, false); assert.equal(denied.notSent, true);
  assert.match(denied.reason, /只读/);
  assert.deepEqual(calls, [], 'trusted passive views are rejected before skills, plugins, tasks, attachment staging or send');
  assert.deepEqual(f.turns, []);
  f.expire(); await f.identity();
  assert.equal((await snapshot()).ok, true, 'renewing the same account preserves passive snapshot access');
});

test('an expired cached readonly view cannot publish a transcript before credentials are renewed', async t => {
  const f = await fixture(t, catalog.runtime('pi')), handle = await openCachedCopy(f);
  f.expire();
  await assert.rejects(Promise.resolve().then(() => f.handlers.get('pi-session-snapshot')(f.event, handle.ref)),
    /账号|服务|切换|失效|登录/);
  assert.deepEqual(f.turns, []);
});

test('a pending cached readonly snapshot accepts same-account renewal without granting send authority', async t => {
  const f = await fixture(t, catalog.runtime('pi')), handle = await openCachedCopy(f);
  const original = handle.loadHistory.bind(handle);
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  handle.loadHistory = async options => { await original(options); entered(); await gate; };
  const pending = Promise.resolve().then(() => f.handlers.get('pi-session-snapshot')(f.event, handle.ref));
  await started;
  f.expire(); await f.identity(); release();
  const result = await pending;
  assert.equal(result.ok, true);
  assert.deepEqual(result.snapshot.messages.map(row => row.text), ['Cached private prompt', 'Cached private answer']);
  assert.equal(result.snapshot.execution.readOnly, true);
  const denied = await f.handlers.get('pi-session-send')(f.event, handle.ref, 'Cannot execute after renewal', [], {});
  assert.equal(denied.ok, false); assert.equal(denied.notSent, true);
  assert.deepEqual(f.turns, []);
});

test('closing the owning desktop window detaches a passive cached view without treating it as active execution', async t => {
  const f = await fixture(t, catalog.runtime('pi')), handle = await openCachedCopy(f);
  assert.doesNotThrow(() => f.closeWindow(), 'the installed window-close handler must detach a passive history view');
  assert.equal(handle.status(), 'idle');
  assert.equal(handle.inFlight(), false);
  assert.deepEqual(f.turns, []);
});

test('an in-flight cached snapshot cannot return content after account, Hub or logout scope changes', async t => {
  for (const change of ['account', 'hub', 'logout']) await t.test(change, async t => {
    const f = await fixture(t, catalog.runtime('pi')), handle = await openCachedCopy(f);
    const original = handle.loadHistory.bind(handle);
    let release, entered;
    const gate = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    handle.loadHistory = async options => { await original(options); entered(); await gate; };
    const pending = Promise.resolve().then(() => f.handlers.get('pi-session-snapshot')(f.event, handle.ref));
    const outcome = pending.then(value => ({ value }), error => ({ error }));
    await Promise.race([started, outcome.then(result => { if (result.error) throw result.error; throw Error('Expected a pending history read'); })]);
    if (change === 'account') assert.equal((await f.login()).ok, true);
    else if (change === 'hub') assert.equal((await f.enrollHub('http://127.0.0.1:10')).ok, true);
    else assert.equal((await f.logout()).ok, true);
    release();
    const result = await outcome;
    assert.ok(result.error, 'a captured readonly snapshot cannot cross an identity change');
    assert.match(result.error.message, /账号|服务|切换|登录/);
    assert.deepEqual(f.turns, []);
  });
});

test('production installed open keeps token refresh usable and blocks old-account events and ref controls', async t => {
  const f = await fixture(t, catalog.runtime('pi'));
  const opened = await f.openInstalled({ adapterId: 'pi' });
  assert.equal(opened.ok, true, opened.reason);
  const handle = f.bridge.get(opened.ref);
  assert.ok(handle, 'the production open registers its runtime handle');
  const snapshot = () => f.handlers.get('pi-session-snapshot')(f.event, handle.ref);
  assert.equal(snapshot().ok, true);

  f.expire();
  await f.identity();
  assert.equal(snapshot().ok, true, 'renewing the same account token preserves access to the handle');
  f.emit(handle, 'turn-finished');
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(f.frames.some(row => row.channel === 'pi-session-event' && row.data.ref === handle.ref),
    'the installed observer publishes while its account still owns the handle');

  f.frames.length = 0;
  f.emit(handle, 'block');
  assert.equal((await f.login()).ok, true);
  await new Promise(resolve => setTimeout(resolve, 30));
  f.emit(handle, 'turn-finished');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.frames.filter(row => row.channel === 'pi-session-event').length, 0,
    'both the scheduled pre-switch frame and the later old-account event are dropped');
  assert.equal(snapshot().ok, false, 'a remembered ref cannot read the previous account snapshot');
  assert.equal(f.installed.find(handle.sessionId), null, 'session-id lookups use the same owner scope');
  f.listeners.get('pi-session-cancel')(f.event, handle.ref);
  assert.equal((await f.handlers.get('pi-session-queue-cancel')(f.event, handle.ref, 'queued')).ok, false);
  assert.equal((await f.handlers.get('pi-session-queue-update')(f.event, handle.ref, 'queued', 'resume')).ok, false);
  assert.deepEqual(f.controls, [], 'stale-account controls never reach the native runtime');
});

test('production cloud handoff IPC rejects stale-account conversations before scanning or uploading', async t => {
  const f = await fixture(t, catalog.runtime('pi')), h = await f.open();
  const mainFrame = {}, sender = { mainFrame, isDestroyed: () => false,
    getURL: () => require('node:url').pathToFileURL(path.resolve(__dirname, '../desk.html')).href };
  const event = { sender, senderFrame: mainFrame };
  assert.equal((await f.handlers.get('conversation-cloud-preview')({ ...event, senderFrame: {} }, h.ref)).ok, false);
  f.switchAccount();
  const preview = await f.handlers.get('conversation-cloud-preview')(event, h.ref);
  assert.equal(preview.ok, false); assert.equal(preview.reason, '会话已关闭，请重新打开后再试');
  const confirm = await f.handlers.get('conversation-cloud-confirm')(event, h.ref, { previewId: 'stale', instruction: 'Continue' });
  assert.equal(confirm.ok, false); assert.equal(confirm.reason, '会话已关闭，请重新打开后再试');
  assert.equal(fs.existsSync(path.join(f.root, 'conversation-handoffs')), false);
  assert.equal(f.turns.length, 0);
});

test('installed IPC rejects the same account old-Hub ref and native history fallback, then restores access on return', async t => {
  const f = await fixture(t, catalog.runtime('pi')), originalHub = f.localIdentity().hub;
  const opened = await f.openInstalled({ adapterId: 'pi' });
  assert.equal(opened.ok, true, opened.reason);
  const handle = f.bridge.get(opened.ref);
  assert.equal((await f.send(handle, 'Original Hub private conversation')).ok, true);
  await new Promise(resolve => setTimeout(resolve, 50));
  const before = f.turns.length;
  assert.equal((await f.enrollHub('http://127.0.0.1:10')).ok, true);
  const other = await f.identity(); assert.equal(other.hub, 'http://127.0.0.1:10');
  assert.equal(f.handlers.get('pi-session-snapshot')(f.event, handle.ref).ok, false);
  const denied = await f.openInstalled({ chatId: handle.sessionId, adapterId: 'pi' });
  assert.equal(denied.ok, false); assert.match(denied.reason, /账号或服务|原连接/);
  assert.equal(f.turns.length, before);
  await f.selectHub(originalHub); await f.identity();
  assert.equal(f.handlers.get('pi-session-snapshot')(f.event, handle.ref).ok, true);
});

test('production IPC switches Pi -> OpenCode -> Qwen -> Pi and authenticates model selection', async t => {
  const f = await fixture(t, catalog.runtime('pi')), h = await f.open(), id = h.sessionId;
  const mainFrame = {}, sender = { mainFrame, isDestroyed: () => false,
    getURL: () => require('node:url').pathToFileURL(path.resolve(__dirname, '../desk.html')).href };
  const event = { sender, senderFrame: mainFrame }, select = f.handlers.get('pi-session-select-agent');
  const models = f.handlers.get('pi-session-select-model');
  assert.equal((await f.handlers.get('pi-session-conversation-runtimes')(event, h.ref)).ok, true);
  await f.send(h, 'First turn');
  for (const agentId of ['opencode', 'qwen', 'pi']) {
    const result = await select(event, h.ref, agentId); assert.equal(result.ok, true, result.reason);
    assert.equal(h.sessionId, id); assert.equal(h.adapterId, agentId);
    if (agentId !== 'pi') { const modelResult = await models(event, h.ref, 'next-model'); assert.equal(modelResult.ok, true, modelResult.reason); }
    const sent = await f.send(h, 'Continue ' + agentId); assert.equal(sent.ok, true, sent.reason);
  }
  assert.equal(h.snapshot().messages.filter(row => row.role === 'user').length, 4);
  assert.equal((await select({ ...event, senderFrame: {} }, h.ref, 'qwen')).ok, false);
  f.switchAccount(); assert.equal((await select(event, h.ref, 'qwen')).ok, false);
  assert.equal((await models(event, h.ref, 'forbidden')).ok, false); assert.equal(h.adapterId, 'pi');
});

for (const spec of catalog.runtimes()) {
  test(spec.id + ': cached authenticated IPC first-send, expired renewal, history resume and uid isolation', async t => {
    const f = await fixture(t, spec);
    const handle = await f.open();
    assert.equal(Object.hasOwn(f.localIdentity(), 'session'), false, 'keep the production device-only identity shape');
    assert.equal(f.sessionReady(), true);
    assert.deepEqual(f.memories.assertOwner(await f.identity(), handle.sessionId), []);
    const files = fs.readdirSync(path.join(f.root, 'session-memory-bindings'));
    assert.equal(files.length, 1, 'new conversation persists an owner even without selected memories');
    const binding = JSON.parse(fs.readFileSync(path.join(f.root, 'session-memory-bindings', files[0]), 'utf8'));
    assert.deepEqual(binding.ids, []);
    assert.equal(binding.owner, scope(await f.identity()));

    assert.equal((await f.send(handle, 'First message')).ok, true);
    assert.equal(f.turns.length, 1, 'the actual selected adapter received the turn');
    assert.equal(f.enrollments(), 1, 'valid cached identity adds no enrollment request');
    f.expire();
    assert.equal(f.sessionReady(), false);
    assert.equal((await f.send(handle, 'After expiry')).ok, true);
    assert.equal(f.enrollments(), 2, 'expired cache renews exactly once');
    assert.equal(f.turns.length, 2);

    const sessionId = handle.sessionId;
    await handle.close();
    assert.equal(f.bridge.get(handle.ref), null);
    const resumed = await f.open(sessionId);
    assert.equal(resumed.sessionId, sessionId);
    assert.equal((await f.send(resumed, 'Continue prior conversation')).ok, true);
    assert.equal(f.turns.length, 3);
    assert.equal(f.enrollments(), 2);

    const device = f.localIdentity().clientId;
    f.switchAccount();
    assert.equal(f.localIdentity().clientId, device, 'account changes on the same device');
    const rejected = await f.send(resumed, 'Must not enter account A conversation');
    assert.equal(rejected.ok, false);
    // The shared IPC lookup now hides other accounts' refs before callers can
    // inspect the runtime or enter their more specific ownership branches.
    assert.equal(rejected.reason, '这条对话已经不在了（可能已关闭）');
    const otherIdentity = await f.identity();
    assert.throws(() => f.memories.assertOwner(otherIdentity, resumed.sessionId), /另一个账号/);
    assert.equal(f.turns.length, 3, 'account mismatch never reaches a model or Runner');
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'session-memory-bindings', files[0]), 'utf8')).owner,
      binding.owner, 'rejected send cannot relabel prior ownership');
  });
}

test('negative control reproduces original failure despite a valid cached session', async t => {
  const f = await fixture(t, catalog.runtime('codex-harness'), true);
  const handle = await f.open();
  assert.equal(f.sessionReady(), true);
  const result = await f.send(handle, 'Legacy callback shape');
  assert.equal(result.ok, false);
  assert.equal(result.reason, '请先登录 SoduWork');
  assert.equal(f.turns.length, 0);
});

test('a fresh auth module restores the stored device and deduplicates missing-session renewal', async t => {
  const f = await fixture(t, catalog.runtime('pi'));
  const original = f.localIdentity();
  f.restartAuth();
  assert.equal(f.sessionReady(), false);
  assert.equal(f.localIdentity().clientId, original.clientId);
  const results = await Promise.all(Array.from({ length: 7 }, () => f.identity()));
  assert.equal(f.enrollments(), 2);
  assert.equal(new Set(results.map(row => row.session)).size, 1);
  assert.ok(results.every(row => scope(row) === scope(results[0])));
});

test('renewal outage preserves the service error and never enters an adapter', async t => {
  const f = await fixture(t, catalog.runtime('codex-harness'));
  const handle = await f.open();
  f.expire();
  f.fail('Isolated Hub unavailable');
  const result = await f.send(handle, 'Must remain unsent');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'Isolated Hub unavailable');
  assert.equal(f.turns.length, 0);
});

function holdNextResponse(suffix = '/clients/enroll') {
  const original = global.fetch;
  let reached, release, consumed = false;
  const entered = new Promise(resolve => { reached = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  global.fetch = async (...args) => {
    const response = await original(...args);
    if (!consumed && String(args[0]).endsWith(suffix)) {
      consumed = true;
      reached();
      await gate; // The server has issued this response, but the client has not received it.
    }
    return response;
  };
  return { entered, release };
}

test('switching Hub during renewal rejects the pending IPC send and cannot refill the old cache', async t => {
  const f = await fixture(t, catalog.runtime('codex-harness'));
  const handle = await f.open(), originalHub = f.localIdentity().hub;
  f.expire();
  const held = holdNextResponse(), sent = f.send(handle, 'Do not cross environments');
  try {
    await held.entered;
    assert.equal(f.selectHub('http://127.0.0.1:19').ok, true);
    assert.equal(f.localIdentity(), null);
  } finally { held.release(); }
  const rejected = await sent;
  assert.equal(rejected.ok, false);
  assert.match(rejected.reason, /账号或服务已变化/);
  assert.equal(f.sessionFor(originalHub), '');
  assert.equal(f.turns.length, 0);
});

test('switching away and back starts a new coalesced renewal; old finally cannot delete the newer request', async t => {
  const f = await fixture(t, catalog.runtime('pi')), originalHub = f.localIdentity().hub;
  f.expire();
  const old = holdNextResponse(), oldIdentity = f.identity().then(() => null, error => error);
  await old.entered;
  f.selectHub('http://127.0.0.1:19'); f.selectHub(originalHub);
  const next = holdNextResponse(), fresh = Array.from({ length: 7 }, () => f.identity());
  try {
    await next.entered;
    old.release();
    assert.match((await oldIdentity).message, /账号或服务已变化/);
    const late = f.identity();
    assert.equal(f.enrollments(), 3, 'old request plus exactly one new request after initial enrollment');
    next.release();
    const identities = await Promise.all([...fresh, late]);
    assert.equal(f.enrollments(), 3);
    assert.equal(new Set(identities.map(row => row.session)).size, 1);
    assert.equal(f.sessionReady(), true);
  } finally { old.release(); next.release(); }
});

test('successful logout invalidates an already-issued renewal before it can resume a send', async t => {
  const f = await fixture(t, catalog.runtime('codex-harness')), handle = await f.open();
  f.expire();
  const held = holdNextResponse(), sent = f.send(handle, 'Do not send after logout');
  try {
    await held.entered;
    assert.equal((await f.logout()).ok, true);
    assert.equal(f.sessionReady(), false);
  } finally { held.release(); }
  const rejected = await sent;
  assert.equal(rejected.ok, false);
  assert.match(rejected.reason, /账号或服务已变化/);
  assert.equal(f.sessionReady(), false, 'late enrollment cannot restore the logged-out session');
  assert.equal(f.turns.length, 0);
});

test('same-device login cannot be overwritten by the previous account renewal', async t => {
  const f = await fixture(t, catalog.runtime('codex-harness')), handle = await f.open();
  const previousOwner = scope(await f.identity());
  f.expire();
  const held = holdNextResponse(), sent = f.send(handle, 'Do not send from previous account');
  let ownerAfterLogin;
  try {
    await held.entered;
    assert.equal((await f.login()).ok, true);
    ownerAfterLogin = scope(await f.identity());
    assert.notEqual(ownerAfterLogin, previousOwner);
  } finally { held.release(); }
  assert.equal((await sent).ok, false);
  assert.equal(scope(await f.identity()), ownerAfterLogin, 'late old response cannot replace the new account');
  assert.equal((await f.send(handle, 'Wrong historical owner')).ok, false);
  assert.equal(f.turns.length, 0);
  assert.equal((await f.send(await f.open(), 'New account own conversation')).ok, true);
});

for (const action of ['login', 'logout']) test(action + ' in flight blocks cached sends until its account transition settles', async t => {
  const f = await fixture(t, catalog.runtime('pi')), handle = await f.open();
  const held = holdNextResponse('/client-auth/' + action), changed = f[action]();
  try {
    await held.entered;
    assert.equal(f.sessionReady(), false, 'an intermediate pre-login enrollment is not cached');
    const rejected = await f.send(handle, 'Must wait for account transition');
    assert.equal(rejected.ok, false);
    assert.equal(rejected.reason, '这条对话已经不在了（可能已关闭）');
    assert.equal(f.turns.length, 0);
  } finally { held.release(); }
  assert.equal((await changed).ok, true);
});

test('clearing a session also invalidates the cached-identity microtask without an enrollment request', async t => {
  const f = await fixture(t, catalog.runtime('pi'));
  const pending = f.identity();
  f.clear();
  await assert.rejects(pending, /账号或服务已变化/);
  assert.equal(f.enrollments(), 1);
  assert.equal(f.sessionReady(), false);
});
