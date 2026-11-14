'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const privacy = require('../main/pi-session/local-model-runtime-privacy.cjs');
const config = require('../main/pi-session/model-config');
const selection = require('../main/conversation/model-selection');

async function fixture(t, respond) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      requests.push({ body, headers: req.headers });
      respond(req, res, body);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-private-runtime-'));
  const next = { id: 'local:model-' + 'a'.repeat(32), modelRef: 'local:model-' + 'a'.repeat(32),
    wireModelId: 'private-model-name', label: 'Private model label', localOnly: true,
    key: 'private-fixture-key', baseUrl: 'http://127.0.0.1:' + server.address().port + '/private-endpoint/v1',
    input: ['text'], contextWindow: 32000 };
  const sdk = await import('../node_modules/@earendil-works/pi-coding-agent/dist/index.js');
  const file = config.writeModels(root, next);
  const runtime = await sdk.ModelRuntime.create({ modelsPath: file, authPath: path.join(root, 'auth.json') });
  runtime.registerProvider('soduwork', selection.piProvider(next));
  const model = privacy.configure(runtime, runtime.getModel('soduwork', next.id), next);
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, sdk, next, model, runtime, requests, file };
}

const context = { systemPrompt: 'Use tools when necessary.', messages: [
  { role: 'user', content: [{ type: 'text', text: 'Read the fixture.' }], timestamp: 1 },
] };

function assertPrivate(value, next) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of [next.wireModelId, next.label, next.key, next.baseUrl, '/private-endpoint']) {
    assert.ok(!text.includes(secret), 'private configuration must not be persisted: ' + secret);
  }
}

test('local provider wire credentials and tools work while SDK metadata and files remain opaque', { timeout: 20000 }, async t => {
  const f = await fixture(t, (_req, res, body) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'x-private-model': body.model });
    const chunk = { id: body.model + '-response-id', model: body.model, object: 'chat.completion.chunk',
      endpoint: '/private-endpoint', choices: [{ index: 0, delta: { role: 'assistant',
        content: 'Ready.', tool_calls: [{ index: 0, id: 'call-fixture', type: 'function',
          function: { name: 'read', arguments: '{"path":"fixture.txt"}' } }] }, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } };
    res.end('data: ' + JSON.stringify(chunk) + '\n\ndata: [DONE]\n\n');
  });
  const observations = [];
  const source = f.runtime.streamSimple(f.model, { ...context,
    tools: [{ name: 'read', description: 'Read a fixture', parameters: {
      type: 'object', properties: { path: { type: 'string' } }, required: ['path'],
    } }] }, {
    onPayload: (payload, model) => { observations.push({ payload: structuredClone(payload), model }); return payload; },
    onResponse: (response, model) => observations.push({ response, model }),
    onProviderStreamEvent: (chunk, model) => observations.push({ chunk, model }),
  });
  const events = [];
  for await (const event of source) events.push(structuredClone(event));
  const result = await source.result();
  assert.equal(result.stopReason, 'toolUse');
  assert.equal(result.model, f.next.id);
  assert.equal(result.responseModel, undefined);
  assert.equal(result.responseId, undefined);
  assert.equal(result.usage.totalTokens, 13);
  assert.deepEqual(result.content.find(block => block.type === 'toolCall').arguments, { path: 'fixture.txt' });
  assert.equal(f.requests[0].body.model, f.next.wireModelId);
  assert.equal(f.requests[0].headers.authorization, 'Bearer ' + f.next.key);
  assert.equal(f.requests[0].body.tools[0].function.name, 'read');
  assert.equal(f.model.baseUrl, privacy.LOCAL_ENDPOINT);
  assertPrivate(events, f.next);
  assertPrivate(observations, f.next);
  assertPrivate(result, f.next);
  assertPrivate(fs.readFileSync(f.file, 'utf8'), f.next);
  const bootstrap = JSON.parse(fs.readFileSync(f.file, 'utf8')).providers.soduwork;
  assert.equal(bootstrap.models[0].contextWindow, config.DEFAULT_CTX);
  assert.equal(bootstrap.models[0].reasoning, false);
  assert.equal(bootstrap.compat.thinkingFormat, undefined);
  if (process.platform !== 'win32') assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
  const manager = f.sdk.SessionManager.create(f.root, path.join(f.root, 'sessions'));
  manager.appendModelChange('soduwork', f.model.id);
  manager.appendMessage(context.messages[0]);
  manager.appendMessage(result);
  assertPrivate(fs.readFileSync(manager.getSessionFile(), 'utf8'), f.next);
});

test('local provider error bodies stay private while retry and capacity classification survive', { timeout: 20000 }, async t => {
  let mode = 'auth';
  const f = await fixture(t, (_req, res, body) => {
    res.writeHead(mode === 'auth' ? 401 : 400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: (mode === 'auth' ? 'credential expired' :
      'context_length_exceeded; maximum context length is 8192') +
      ' private-fixture-key /private-endpoint ' + body.model } }));
  });
  const first = await f.runtime.streamSimple(f.model, context, { maxRetries: 0 }).result();
  assert.equal(first.stopReason, 'error');
  assert.equal(require('../main/pi-session/model-errors').describe(first.errorMessage).authExpired, true);
  assertPrivate(first, f.next);
  mode = 'context';
  const second = await f.runtime.stream(f.model, context, { maxRetries: 0 }).result();
  assert.equal(second.stopReason, 'error');
  assert.equal(require('../main/pi-session/context-recovery').errorWindow(second.errorMessage), 8192);
  assert.match(second.errorMessage, /context_length_exceeded/);
  assertPrivate(second, f.next);
});

test('a pending local request keeps its own endpoint and credentials after a managed provider switch', { timeout: 20000 }, async t => {
  const f = await fixture(t, (_req, res, body) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: ' + JSON.stringify({ model: body.model, choices: [{ index: 0,
      delta: { role: 'assistant', content: 'Local completion.' }, finish_reason: 'stop' }] }) +
      '\n\ndata: [DONE]\n\n');
  });
  f.runtime.registerProvider('soduwork', selection.piProvider({ id: 'managed',
    baseUrl: 'https://managed.invalid/v1', key: 'managed-fixture-key' }));
  const result = await f.runtime.streamSimple(f.model, context).result();
  assert.equal(result.stopReason, 'stop');
  assert.equal(f.requests[0].headers.authorization, 'Bearer ' + f.next.key);
  assert.equal(f.requests[0].body.model, f.next.wireModelId);
  assert.equal(result.model, f.next.id);
});

test('native SDK retry persists only safe local error metadata and keeps the private wire selection', { timeout: 20000 }, async t => {
  let calls = 0;
  const f = await fixture(t, (_req, res, body) => {
    calls++;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = calls === 1 ? { error: { message: 'HTTP 503: temporary failure ' + body.model +
      ' private-fixture-key /private-endpoint', code: 503 } } : {
      model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: 'Retry completed.' }, finish_reason: 'stop' }],
    };
    res.end('data: ' + JSON.stringify(chunk) + '\n\ndata: [DONE]\n\n');
  });
  const settings = f.sdk.SettingsManager.inMemory({ compaction: { enabled: false },
    retry: { enabled: true, maxRetries: 2, baseDelayMs: 1, delayScheduleMs: [1, 1] } });
  const resources = new f.sdk.DefaultResourceLoader({ cwd: f.root, agentDir: f.root, settingsManager: settings,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    systemPrompt: 'A deterministic local privacy test.' });
  await resources.reload();
  const manager = f.sdk.SessionManager.create(f.root, path.join(f.root, 'sessions'));
  const { session } = await f.sdk.createAgentSession({ cwd: f.root, agentDir: f.root,
    modelRuntime: f.runtime, model: f.model, settingsManager: settings, resourceLoader: resources,
    sessionManager: manager, tools: [] });
  t.after(() => session.dispose());
  const events = [];
  session.subscribe(event => events.push(structuredClone(event)));
  await session.prompt('Retry once if necessary.');
  assert.equal(calls, 2);
  assert.ok(events.some(event => event.type === 'auto_retry_start'));
  assert.ok(f.requests.every(request => request.body.model === f.next.wireModelId));
  assertPrivate(events, f.next);
  assertPrivate(fs.readFileSync(manager.getSessionFile(), 'utf8'), f.next);
});

test('privacy changes only model metadata and never assistant text or tool arguments', () => {
  const next = { id: 'local:model-' + 'b'.repeat(32), wireModelId: 'private-model-name',
    baseUrl: 'http://private.invalid/v1', key: 'secret', localOnly: true };
  const message = { role: 'assistant', model: next.wireModelId, content: [
    { type: 'text', text: 'Discuss private-model-name without rewriting this answer.' },
    { type: 'toolCall', id: 'call', name: 'read', arguments: { path: 'private-model-name.txt' } },
  ], stopReason: 'stop' };
  const runtime = { stream: () => ({ async *[Symbol.asyncIterator]() { yield { type: 'done', message }; },
    result: async () => message }) };
  const model = privacy.configure(runtime, { provider: 'soduwork', id: next.id }, next);
  return runtime.stream(model, context).result().then(result => {
    assert.equal(result.model, next.id);
    assert.equal(result.content[0].text, 'Discuss private-model-name without rewriting this answer.');
    assert.deepEqual(result.content[1].arguments, { path: 'private-model-name.txt' });
  });
});

test('legacy local selections and saved preferences use the encrypted catalog alias', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-private-selection-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const legacy = 'local:fixture:private-model-name', opaque = 'local:model-' + 'c'.repeat(32);
  const store = require('../main/local-model-store.cjs');
  t.mock.method(store, 'canonicalReference', name => name === legacy ? opaque : '');
  const preference = selection.preference({ getPath: () => root }, 'fixture');
  preference.write(legacy);
  assert.equal(preference.read(), opaque);
  const applied = [];
  const choice = selection.create({ name: 'managed', model: { id: 'managed' },
    resolve: async () => ({ ok: true, model: { id: opaque, modelRef: opaque, localOnly: true } }),
    persist: name => preference.write(name), apply: model => applied.push(model.id) });
  assert.equal((await choice.select(legacy)).ok, true);
  assert.equal(choice.capture(), opaque);
  await choice.applyForTurn();
  assert.deepEqual(applied, [opaque]);
  const file = path.join(root, 'conversation-models', fs.readdirSync(path.join(root, 'conversation-models'))[0]);
  assert.equal(fs.readFileSync(file, 'utf8').includes('private-model-name'), false);
  assert.throws(() => preference.write('local:missing:private-name'), /reference is unavailable/);
  assert.equal(preference.read(), opaque);
});

test('opaque local IDs preserve model family thinking and live configuration revisions', async t => {
  const store = require('../main/local-model-store.cjs');
  const ref = 'local:model-' + 'e'.repeat(32);
  let name = 'qwen3', revision = 1, key = 'fixture-old-key';
  t.mock.method(store, 'resolve', () => ({ id: ref, runtimeId: ref, modelRef: ref, name,
    provider: 'fixture-provider', providerName: 'Fixture provider', key,
    baseUrl: 'http://fixture.invalid/v1', configRevision: revision }));
  const first = await config.fetchModel(null, ref, undefined, undefined, false, 'pi', { allowLocal: true });
  assert.equal(first.model.id, ref);
  assert.equal(first.model.wireModelId, 'qwen3');
  assert.equal(first.model.reasoning, true);
  assert.equal(first.model.format, 'qwen');
  assert.equal(selection.piProvider(first.model).compat.thinkingFormat, 'qwen');
  const applied = [];
  const choice = selection.create({ name: ref, model: first.model,
    resolve: value => config.fetchModel(null, value, undefined, undefined, false, 'pi', { allowLocal: true }), apply: model => applied.push(model) });
  revision = 2; key = '';
  assert.equal((await choice.select(ref)).ok, true);
  assert.equal(choice.needsApply(), true, 'same-reference edits must update the next turn');
  await choice.applyForTurn();
  assert.equal(applied[0].key, '');
  assert.equal(applied[0].configRevision, 2);
  assert.equal(choice.needsApply(), false);
  name = 'deepseek-reasoner';
  const second = await config.fetchModel(null, ref, undefined, undefined, false, 'pi', { allowLocal: true });
  assert.equal(second.model.reasoning, true);
  assert.equal(second.model.format, 'deepseek');
  assert.equal(selection.piProvider(second.model).compat.thinkingFormat, 'deepseek');
});
