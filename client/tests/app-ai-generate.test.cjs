'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { create, normalize } = require('../main/app-ai-generate.cjs');
const contract = require('../main/soduwork-app-bridge-contract.cjs');
const defaults = { input: '头脑风暴', instructions: '围绕输入输出5个创意词，勿调用工具。', requestId: 'brainstorm-1' };
function fixture(overrides = {}) {
  let identity = { hub: 'https://fixture.invalid', clientId: 'device',
    session: require('./helpers/platform-session-fixture.cjs').sessions().renewed };
  const calls = [], wc = new EventEmitter();
  const item = { appBridge: { appId: 'local:brainstorm' }, view: { webContents: wc } };
  const deps = { app: {}, authenticatedIdentityOf: async () => identity,
    configuredModel: () => 'host-choice',
    resolveModel: async (_identity, name) => { calls.push(['selection', name]); return { ok: true,
      model: { id: name, baseUrl: 'https://fixture.invalid/proxy/v1', key: 'private-ticket', maxOutputTokens: 1024 } }; },
    authorizeAI: async () => { calls.push(['quota']); },
    fetchImpl: async (url, options) => { calls.push(['post', url, options]);
      return Response.json({ choices: [{ message: { content: '星轨、潮汐、火花、漫游、回声' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 24, completion_tokens: 16, total_tokens: 40, secret: 'private' }, key: 'private-ticket' }); }, ...overrides };
  return { generate: create(deps), item, calls, wc, switchAccount() { identity = { ...identity, clientId: 'another-device' }; } };
}
test('one-shot inference sends exactly the explicit skill and input through the authorized host model, no conversation or tools', async () => {
  const f = fixture(), r = await f.generate(f.item, defaults);
  assert.equal(r.ok, true); assert.equal(r.text.split('、').length, 5);
  assert.equal(r.model, 'host-choice'); assert.deepEqual(r.usage, { inputTokens: 24, outputTokens: 16, totalTokens: 40 });
  assert.deepEqual(f.calls.map(c => c[0]), ['selection', 'quota', 'post']);
  const [, url, options] = f.calls[2], body = JSON.parse(options.body);
  assert.equal(url, 'https://fixture.invalid/proxy/v1/chat/completions');
  assert.equal(options.headers.Authorization, 'Bearer private-ticket');
  assert.equal(options.signal.aborted, true, 'completion releases the transport even on early guard failures');
  assert.deepEqual(body, { model: 'host-choice', stream: false, max_tokens: 256,
    messages: [{ role: 'system', content: defaults.instructions }, { role: 'user', content: defaults.input }] });
  assert.doesNotMatch(JSON.stringify(r), /private|https:|ticket|session/);
  assert.equal(f.wc.listenerCount('destroyed'), 0);
});
test('contract rejects context, tool, message arrays and out-of-bounds inputs; model output limit is honored', async () => {
  for (const extra of [{ messages: [] }, { tools: [] }, { context: 'history' }, { input: '' }, { instructions: 'x'.repeat(16001) },
    { maxOutputTokens: 2049 }, { maxOutputTokens: 0 }, { timeoutMs: 60001 }, { requestId: '' }, { model: {} }])
    assert.throws(() => contract.normalizeRequest({ id: 'i', method: 'ai.generate', params: { ...defaults, ...extra } }));
  assert.equal(contract.METHOD_CAPABILITY['ai.generate'], 'ai.generate');
  const f = fixture(); await f.generate(f.item, { ...defaults, maxOutputTokens: 2048 });
  assert.equal(JSON.parse(f.calls[2][2].body).max_tokens, 1024);
  assert.equal(normalize(defaults).timeoutMs, 30000);
});
test('parallel repeats of the same request ID are charged once and conflicts are rejected', async () => {
  const f = fixture();
  const [a, b] = await Promise.all([f.generate(f.item, defaults), f.generate(f.item, defaults)]);
  assert.deepEqual(a, b); assert.equal(f.calls.filter(c => c[0] === 'post').length, 1);
  assert.equal((await f.generate(f.item, { ...defaults, input: 'changed' })).code, 'APP_AI_REQUEST_CONFLICT');
});
test('quota rejection and missing host authorization never dispatch inference', async () => {
  const f = fixture({ authorizeAI: async () => { throw Object.assign(Error('quota'), { code: 'TOKEN_QUOTA_EXCEEDED' }); } });
  assert.equal((await f.generate(f.item, defaults)).code, 'TOKEN_QUOTA_EXCEEDED');
  assert.equal(f.calls.filter(c => c[0] === 'post').length, 0);
  const g = fixture({ authenticatedIdentityOf: async () => null });
  assert.equal((await g.generate(g.item, defaults)).code, 'APP_AI_UNAVAILABLE'); assert.deepEqual(g.calls, []);
});
test('local no-key models bypass Hub admission and omit the Authorization header', async () => {
  const localRef = 'local:model-' + 'a'.repeat(32);
  const f = fixture({
    configuredModel: () => localRef,
    authorizeAI: async () => { throw Object.assign(Error('quota'), { code: 'TOKEN_QUOTA_EXCEEDED' }); },
    resolveModel: async () => ({ ok: true, localOnly: true,
      model: { id: localRef, wireModelId: 'qwen3', baseUrl: 'http://127.0.0.1:8686/v1', key: '', maxOutputTokens: 1024, localOnly: true } }),
  });
  const result = await f.generate(f.item, defaults);
  assert.equal(result.ok, true);
  assert.equal(f.calls.some(row => row[0] === 'quota'), false);
  const request = f.calls.find(row => row[0] === 'post')[2];
  assert.equal('Authorization' in request.headers, false);
  assert.equal(JSON.parse(request.body).model, 'qwen3', 'the private endpoint receives its actual model name');
  assert.equal(result.model, localRef, 'the app result retains only the opaque model identity');
});
test('local one-shot inference retains the client login requirement', async () => {
  const f = fixture({
    authenticatedIdentityOf: async () => null,
    configuredModel: () => 'local:custom-local:qwen3',
    resolveModel: async () => ({ ok: true, localOnly: true,
      model: { id: 'local:model-' + 'a'.repeat(32), wireModelId: 'qwen3',
        baseUrl: 'http://127.0.0.1:8686/v1', key: '', localOnly: true } }),
  });
  const result = await f.generate(f.item, defaults);
  assert.equal(result.code, 'APP_AI_UNAVAILABLE');
  assert.deepEqual(f.calls, []);
});
test('local one-shot calls keep account fences and never send an opaque ID as a fallback wire name', async () => {
  const localRef = 'local:model-' + 'a'.repeat(32);
  const localModel = { id: localRef, wireModelId: 'private-wire-model',
    baseUrl: 'http://127.0.0.1:8686/v1', key: 'synthetic-provider-key', localOnly: true };
  const missing = fixture({ configuredModel: () => localRef,
    resolveModel: async () => ({ ok: true, model: { ...localModel, wireModelId: undefined } }) });
  assert.equal((await missing.generate(missing.item, defaults)).code, 'APP_AI_NOT_SENT');
  assert.deepEqual(missing.calls, []);
  let release, request;
  const active = fixture({ configuredModel: () => localRef,
    resolveModel: async () => ({ ok: true, model: localModel }),
    fetchImpl: (_url, options) => { request = options; return new Promise(resolve => { release = resolve; }); } });
  const pending = active.generate(active.item, defaults);
  while (!release) await new Promise(resolve => setImmediate(resolve));
  assert.equal(JSON.parse(request.body).model, localModel.wireModelId);
  assert.equal(request.headers.Authorization, 'Bearer synthetic-provider-key');
  active.switchAccount();
  release(Response.json({ choices: [{ message: { content: 'Earlier account private response' } }] }));
  const result = await pending;
  assert.equal(result.code, 'APP_AI_CONTEXT_CHANGED');
  assert.equal(result.text, undefined);
});
test('account and installation changes discard in-flight model results and cached receipts', async () => {
  let release; const f = fixture({ fetchImpl: () => new Promise(resolve => { release = resolve; }) });
  const pending = f.generate(f.item, defaults);
  while (!release) await new Promise(resolve => setImmediate(resolve));
  f.switchAccount(); release(Response.json({ choices: [{ message: { content: 'old private account result' } }] }));
  const r = await pending; assert.equal(r.code, 'APP_AI_CONTEXT_CHANGED'); assert.equal(r.text, undefined);
  let current = true; const g = fixture();
  const check = () => { if (!current) throw Error('uninstalled'); };
  await g.generate(g.item, defaults, check); current = false;
  assert.equal((await g.generate(g.item, defaults, check)).ok, false);
});
test('timeouts after dispatch stay uncertain and reusing their ID never sends another request', async () => {
  let posts = 0; const f = fixture({ fetchImpl: (_url, { signal }) => {
    posts++; return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Error('private-ticket'))));
  } });
  const p = { ...defaults, timeoutMs: 1000 }, r = await f.generate(f.item, p);
  assert.equal(r.uncertain, true); assert.equal(r.code, 'APP_AI_RESULT_UNKNOWN');
  assert.deepEqual(await f.generate(f.item, p), r); assert.equal(posts, 1);
});
test('navigation before quota authorization completes cancels without a late model call', async () => {
  let release, checked; const f = fixture({ authorizeAI: () => new Promise(resolve => { checked = true; release = resolve; }) });
  const pending = f.generate(f.item, defaults);
  while (!checked) await new Promise(resolve => setImmediate(resolve));
  f.wc.emit('did-start-navigation', {}, 'https://another.invalid', false, true);
  assert.equal((await pending).code, 'APP_AI_CANCELLED'); release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.filter(c => c[0] === 'post').length, 0);
});
test('two simultaneous calls per app limit admission without queuing stale requests', async () => {
  const releases = []; const f = fixture({ fetchImpl: () => new Promise(resolve => releases.push(resolve)) });
  const one = f.generate(f.item, defaults), two = f.generate(f.item, { ...defaults, requestId: 'two' });
  while (releases.length < 2) await new Promise(resolve => setImmediate(resolve));
  assert.equal((await f.generate(f.item, { ...defaults, requestId: 'three' })).code, 'APP_AI_BUSY');
  releases.forEach(resolve => resolve(Response.json({ choices: [{ message: { content: 'done' } }] })));
  assert.ok((await one).ok); assert.ok((await two).ok);
});
test('provider errors and malformed or excessive responses never expose raw server diagnostics', async () => {
  for (const response of [new Response('private-ticket', { status: 500 }), Response.json({ choices: [] }),
    new Response('private-ticket'), new Response('x'.repeat(1048577))]) {
    const f = fixture({ fetchImpl: async () => response }); const r = await f.generate(f.item, defaults);
    assert.equal(r.ok, false); assert.doesNotMatch(JSON.stringify(r), /private-ticket/);
  }
});
test('fast inference uses authorized thinking profiles and modern reasoning output limits without forcing always-on models off', () => {
  const { payload } = require('../main/app-ai-generate.cjs'), p = normalize(defaults);
  const qwen = payload({ id: 'qwen', reasoning: true }, p);
  assert.equal(qwen.enable_thinking, false); assert.equal(qwen.max_tokens, 256);
  const always = payload({ id: 'qwen', reasoning: true, thinkingAlwaysOn: true }, p);
  assert.equal(always.enable_thinking, undefined);
  const openai = payload({ id: 'gpt-5', thinkingLevelMap: { off: 'none' } }, p);
  assert.equal(openai.max_completion_tokens, 256); assert.equal(openai.max_tokens, undefined);
  assert.equal(openai.reasoning_effort, 'none');
  assert.equal(payload({ id: 'gpt-5', thinkingAlwaysOn: true }, p).reasoning_effort, undefined);
});
