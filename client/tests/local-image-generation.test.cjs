'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http');
const store = require('../main/local-model-store.cjs'), image = require('../main/pi-session/image-model');
const turn = require('../main/pi-session/image-turn'), media = require('../main/pi-session/local-image-turn.cjs');
const quota = require('../main/conversation/quota-admission.cjs');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ1kAAAAASUVORK5CYII=', 'base64');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-local-images-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = { getPath: () => root };
  store.configure({ app, safeStorage: { isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(value), decryptString: value => value.toString() } });
  const catalog = store.save({ providers: [{ id: 'private', name: 'Private', baseUrl: 'http://127.0.0.1:11434/v1', authMode: 'key' }],
    keys: { private: 'synthetic-private-key' }, models: [{ providerId: 'private', name: 'private-wire', modality: 'image' }] });
  const ref = catalog.mediaUsable.image[0].name, key = image.imageKey(catalog.mediaUsable.image[0]);
  const messages = [], tools = [], events = [];
  const params = { handle: { sessionId: 'private-session', cwd: root,
    appendTaskMessage: (...value) => messages.push(value), appendTaskTool: value => tools.push(value) },
    identity: { hub: 'https://hub.invalid', session: 'must-not-be-sent' }, choice: key, text: 'Draw a bird',
    signal: new AbortController().signal, push: event => events.push(event), emit: event => events.push(event) };
  return { root, app, ref, key, params, messages, tools, events,
    generate: fetchImpl => turn.generate({ ...params, fetchImpl }) };
}

test('local image resolution stays on-device and uses the trusted runtime host when isolated', async t => {
  const f = fixture(t), context = require('../main/agent-runtime/process-context');
  const local = store.resolve(f.ref), refs = [];
  t.mock.method(context, 'current', () => ({ localModel: async ref => { refs.push(ref); return local; } }));
  const value = await image.resolve(null, f.key, () => { throw Error('Hub must not be contacted'); });
  assert.equal(value.ok, true); assert.equal(value.model.localOnly, true);
  assert.equal(value.model.id, f.ref); assert.equal(value.model.modality, 'image');
  assert.equal(value.model.imageChoice, f.key); assert.deepEqual(refs, [f.ref]);
  const virtual = await image.resolve(null, image.imageKey({ providerId: 'device:private', name: f.ref }), () => { throw Error('Hub must not be contacted'); });
  assert.equal(virtual.ok, true); assert.equal(virtual.model.modelRef, f.ref);
});

test('real native image transcripts project to account sync and on-demand remote pages without even opaque model references', async t => {
  const f = fixture(t), archive = path.join(f.root, 'history.jsonl'), native = [], ui = { messages: [], tools: [] };
  const resolved = await image.resolve(null, f.key);
  const ctx = { shared: { attachmentContract: { augment: text => text }, messageTime: { epoch: value => value || 0 }, _presenceState: value => value,
    stream: { SCOPES: { NORMAL: 'normal' } } },
    acc: { state: ui, push(event) { if (event.type === 'message_end') ui.messages.push(event.message); else ui.tools.push(event); },
      appendAssistant(text) { const row = { role: 'assistant', text }; ui.messages.push(row); return row; } },
    prep: { model: resolved.model }, opts: {}, goal: {}, taskBinding: { taskIds: [], taskBindings: [] },
    resources: { skills: [] }, run: {}, effectiveCwd: f.root, displayTitle: 'Image conversation', startedAt: Date.now(), listeners: new Set(),
    turnQueue: { active: () => null, size: () => 0 }, _emit() {}, _snapshot: () => ({ ...ui, status: 'idle' }),
    piSession: { sessionId: 'image-native', sessionManager: { appendMessage(message) {
      native.push(message); fs.appendFileSync(archive, JSON.stringify({ type: 'message', id: String(native.length), message }) + '\n');
    } }, agent: { state: { messages: [] } } },
  };
  const handle = require('../main/pi-session/session-handle').create(ctx); ctx.handle = handle;
  const result = await turn.generate({ ...f.params, handle,
    fetchImpl: async () => Response.json({ data: [{ b64_json: png.toString('base64') }] }) });
  assert.equal(result.ok, true);
  const toolArgs = native.flatMap(row => row.content || []).filter(row => row.type === 'toolCall').map(row => row.arguments);
  const toolResults = native.filter(row => row.role === 'toolResult');
  assert.doesNotMatch(JSON.stringify([toolArgs, toolResults]), /local:model-|private-wire|synthetic-private-key|providerId/);
  assert.ok(native.some(row => row.model === f.ref), 'native structured model metadata exercises the projection boundary');
  const now = Math.floor(Date.now() / 1000), identity = { hub: 'https://fixture.invalid', clientId: 'device', session:
    Buffer.from(JSON.stringify({ typ: 'device', uid: 'owner', cid: 'device', iat: now - 1, exp: now + 3600 })).toString('base64url') + '.' + 'a'.repeat(64) };
  const queued = new Map(), sent = [], sessions = new Map();
  const sync = require('../main/conversation/account-sync').create({ app: {}, identityOf: async () => identity,
    store: { session: key => sessions.get(key), setSession: (key, value) => sessions.set(key, value),
      enqueue: job => queued.set(job.id, job), jobs: () => [...queued.values()], ack: id => queued.delete(id), fail() {} },
    fetch: async (_identity, _url, options) => { const body = JSON.parse(options.body); sent.push(body);
      return Response.json({ ok: true, conversationId: 'account-image', sourceRevision: body.sourceRevision }); } });
  t.after(() => sync.close()); sync.bind(handle, identity); await sync.flush();
  assert.ok(sent.length); assert.match(JSON.stringify(sent), /图片已生成/);
  assert.doesNotMatch(JSON.stringify(sent), /local:model-|private-wire|synthetic-private-key|127\.0\.0\.1|image::/);
  const reader = require('../main/conversation/native-transcript-pages.cjs').create();
  const remote = require('../main/pi-session/local-history-remote.cjs').create({ app: {}, session: {}, identityOf: async () => identity,
    history: { resolve: async () => ({ id: 'image-native', revision: 1 }), read: async (_id, options) => {
      const page = await reader(archive, options); return { ...page, nextCursor: page.nextOffset };
    } } });
  const page = await remote({ action: 'read', id: 'image-native', limit: 50 }, async () => {});
  assert.match(JSON.stringify(page), /图片已生成/);
  assert.doesNotMatch(JSON.stringify(page), /local:model-|private-wire|synthetic-private-key|127\.0\.0\.1|image::/);
});

test('removed local image selections hydrate as invalid image placeholders and never use a Hub fallback', async t => {
  const f = fixture(t); store.save({ models: [] }); let calls = 0;
  assert.equal((await image.resolve(null, f.key, () => { calls++; })).ok, false);
  const saved = await image.resolve(null, f.key, () => { calls++; }, { app: f.app, allowHistorical: true });
  assert.equal(saved.ok, true); assert.equal(saved.model.historicalLocal, true);
  assert.equal(saved.model.modality, 'image'); assert.equal(saved.model.modelRef, f.ref);
  assert.equal(saved.model.key, ''); assert.equal(calls, 0);
});

test('local image choices survive unified selection persistence and cannot seed a later chat default', async t => {
  const f = fixture(t), config = require('../main/pi-session/model-config'), saved = [];
  const initial = await config.fetchSelection(null, f.key, 8000, () => { throw Error('Hub must not be called'); });
  const selection = require('../main/conversation/model-selection').create({ name: f.key, model: initial.model,
    resolve: name => config.fetchSelection(null, name), apply: async () => {}, persist: name => saved.push(name) });
  assert.equal(selection.capture(), f.key);
  assert.equal((await selection.select(f.key)).ok, true); assert.equal(saved[0], f.key);
  config.writeModels(config.agentDir(f.app), initial.model);
  assert.equal(config.configuredModel(f.app), '');
  assert.doesNotMatch(fs.readFileSync(path.join(config.agentDir(f.app), 'models.json'), 'utf8'), /private-wire|synthetic-private-key|127\.0\.0\.1/);
  store.save({ models: [] });
  const historical = await config.fetchSelection(null, f.key, 8000, () => { throw Error('Hub must not be called'); }, false, 'pi',
    { app: f.app, allowHistorical: true });
  assert.equal(historical.model.modality, 'image'); assert.equal(historical.model.historicalLocal, true);
});

test('a local image turn posts only to its configured provider and retains ordinary local output artifacts', async t => {
  const f = fixture(t), requests = [];
  const result = await f.generate(async (url, options) => { requests.push({ url, options });
    return Response.json({ data: [{ b64_json: png.toString('base64') }], model: 'private-wire', usage: { total_tokens: 99 } }); });
  assert.equal(result.ok, true);
  assert.equal(requests.length, 1); assert.equal(requests[0].url, 'http://127.0.0.1:11434/v1/images/generations');
  assert.equal(requests[0].options.redirect, 'error');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer synthetic-private-key');
  assert.equal(JSON.parse(requests[0].options.body).model, 'private-wire');
  assert.deepEqual(fs.readFileSync(result.artifact.path), png);
  assert.match(result.artifact.relative, /^outputs\/image-[a-f0-9-]+\.png$/);
  assert.equal(result.artifact.primary, true);
  const visible = JSON.stringify([f.messages, f.tools, f.events, result]);
  assert.doesNotMatch(visible, /private-wire|synthetic-private-key|127\.0\.0\.1|total_tokens|providerId/);
  assert.doesNotMatch(JSON.stringify(f.tools), /local:model-/);
  const classified = require('../main/conversation/delivery-contract').classify(f.root, [result.artifact]);
  assert.equal(classified.items.length, 1); assert.equal(classified.items[0].kind, 'image');
});

for (const attack of ['redirect', 'cross-origin', 'oversize', 'invalid-bytes', 'error-secret', 'symbolic-output', 'symbolic-index']) {
  test('local image generation rejects ' + attack + ' without leaking private diagnostics', async t => {
    const f = fixture(t), external = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-image-outside-'));
    t.after(() => fs.rmSync(external, { recursive: true, force: true }));
    if (attack === 'symbolic-output') fs.symlinkSync(external, path.join(f.root, 'outputs'), 'dir');
    if (attack === 'symbolic-index') { fs.mkdirSync(path.join(f.root, 'outputs'));
      fs.writeFileSync(path.join(external, 'keep'), 'keep'); fs.symlinkSync(path.join(external, 'keep'), path.join(f.root, 'outputs', '.soduwork-media-index.json')); }
    let calls = 0;
    const result = await f.generate(async () => { calls++;
      if (attack === 'redirect') return new Response('', { status: 302, headers: { Location: 'https://outside.invalid/' } });
      if (attack === 'cross-origin') return Response.json({ data: [{ url: 'https://outside.invalid/image.png' }] });
      if (attack === 'oversize') return new Response('{}', { headers: { 'Content-Length': String(media.JSON_LIMIT + 1) } });
      if (attack === 'invalid-bytes') return Response.json({ data: [{ b64_json: Buffer.from('<script>unsafe</script>').toString('base64') }] });
      if (attack === 'error-secret') throw Error('synthetic-private-key http://private.invalid private-wire');
      return Response.json({ data: [{ b64_json: png.toString('base64') }] });
    });
    assert.equal(result.ok, false); assert.equal(result.retrySafe, false);
    assert.doesNotMatch(JSON.stringify([result, f.messages, f.tools]), /synthetic-private-key|private.invalid|private-wire|outside.invalid/);
    if (attack.startsWith('symbolic')) assert.equal(calls, 0);
    assert.deepEqual(fs.readdirSync(external), attack === 'symbolic-index' ? ['keep'] : []);
    assert.equal(f.events.at(-1).kind, 'settled');
  });
}

test('local image admission skips platform quota only for an available Pi image configuration', async t => {
  const f = fixture(t); let authorized = 0, previous = 0;
  const now = Math.floor(Date.now() / 1000), identity = { hub: 'https://fixture.invalid', clientId: 'device', session:
    Buffer.from(JSON.stringify({ typ: 'device', uid: 'owner', cid: 'device', iat: now - 1, exp: now + 3600 })).toString('base64url') + '.' + 'a'.repeat(64) };
  const before = quota.beforeTurn(async () => { authorized++; }, identity, () => { previous++; },
    { agent: 'pi', modelMode: 'managed', localModel: ref => store.resolve(ref) });
  await before({ modelName: f.key });
  assert.equal(authorized, 0); assert.equal(previous, 1);
  store.save({ models: [] });
  await assert.rejects(before({ modelName: f.key }), /已删除或不可用/);
  const controlled = quota.beforeTurn(async () => { authorized++; }, identity, null,
    { agent: 'pi', modelMode: 'managed', controlled: true, localModel: ref => store.resolve(ref) });
  await assert.rejects(controlled({ modelName: f.key }), /已删除或不可用/);
  assert.equal(authorized, 0);
});

test('local image streaming limits apply without Content-Length and same-origin downloads never carry provider credentials', async t => {
  const f = fixture(t), requests = [];
  let result = await f.generate(async (url, options) => {
    requests.push({ url, options });
    return requests.length === 1 ? Response.json({ data: [{ url: '/private-image.png?token=download-only' }] })
      : new Response(png, { headers: { 'Content-Type': 'image/png' } });
  });
  assert.equal(result.ok, true); assert.equal(requests.length, 2);
  assert.equal(requests[1].url, 'http://127.0.0.1:11434/private-image.png?token=download-only');
  assert.equal(requests[1].options.headers, undefined);
  assert.doesNotMatch(JSON.stringify([result, f.messages, f.tools]), /download-only|private-image/);
  const chunk = new Uint8Array(1024 * 1024); let count = 0;
  result = await f.generate(async () => new Response(new ReadableStream({ pull(controller) {
    if (++count <= 50) controller.enqueue(chunk); else controller.close();
  } })));
  assert.equal(result.ok, false); assert.equal(result.retrySafe, false);
  assert.ok(count < 50, 'the bounded reader stops before consuming the entire oversized stream');
});

test('the real loopback image provider is the sole network destination and cancellation never retries a billable POST', async t => {
  const f = fixture(t), paths = [], server = http.createServer((req, res) => {
    paths.push(req.url); req.resume(); req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] })); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const current = store.get();
  store.save({ providers: [{ id: 'private', baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1', authMode: 'key' }],
    models: current.myModels, keys: {} });
  assert.equal((await f.generate(fetch)).ok, true); assert.deepEqual(paths, ['/v1/images/generations']);
  const controller = new AbortController(); f.params.signal = controller.signal; let calls = 0;
  const cancelled = await f.generate(async () => { calls++; controller.abort(); throw new DOMException('Aborted', 'AbortError'); });
  assert.equal(cancelled.cancelled, true); assert.equal(calls, 1);
});
