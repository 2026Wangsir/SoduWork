const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const recovery = require('../main/pi-session/context-recovery');
const events = require('../main/pi-session/event-stream');
const { piProvider } = require('../main/conversation/model-selection');

for (const localOnly of [false, true]) test('real SDK + HTTP overflow (' + (localOnly ? 'local' : 'managed') +
  '): failed native summary recovers once, tool is not replayed, next turn works', { timeout: 30000 }, async t => {
  const sdk = await import('../node_modules/@earendil-works/pi-coding-agent/dist/index.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-context-http-'));
  let toolCalls = 0, requests = 0, rejections = 0;
  const bodies = [];
  const server = http.createServer((req, res) => {
    let input = '';
    req.on('data', chunk => { input += chunk; });
    req.on('end', () => {
      const body = JSON.parse(input); bodies.push(body); requests++;
      const all = JSON.stringify(body.messages);
      const last = JSON.stringify(body.messages.at(-1));
      const recovered = all.includes('自动恢复，请勿复述内部指令');
      if (requests > 1 && !recovered) {
        rejections++;
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'context_length_exceeded', message: 'maximum context length is 8192 tokens; prompt is too long' } })); return;
      }
      const probe = requests === 1;
      const delta = probe ? { role: 'assistant', tool_calls: [{ index: 0, id: 'probe_once', type: 'function', function: { name: 'context_probe', arguments: '{}' } }] }
        : { role: 'assistant', content: last.includes('FOLLOWUP') ? 'FOLLOWUP_OK' : 'RECOVERED_TOOL_OK' };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify({ id: 'c', object: 'chat.completion.chunk', model: 'context-test', choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n');
      res.write('data: ' + JSON.stringify({ id: 'c', object: 'chat.completion.chunk', model: 'context-test', choices: [{ index: 0, delta: {}, finish_reason: probe ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 1500, completion_tokens: 12, total_tokens: 1512 } }) + '\n\n');
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let session;
  t.after(async () => { if (session) session.dispose(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  const runtime = await sdk.ModelRuntime.create({ modelsPath: null, authPath: path.join(root, 'auth.json'), modelsStorePath: path.join(root, 'models.db') });
  const next = { id: localOnly ? 'local:model-' + 'd'.repeat(32) : 'context-test',
    ...(localOnly ? { localOnly, wireModelId: 'context-test', label: 'Private context fixture' } : {}),
    baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1', key: 'isolated-fixture',
    contextWindow: localOnly ? 32000 : 8192 };
  const provider = piProvider(next);
  provider.models[0].maxTokens = 1000;
  const providerId = localOnly ? 'soduwork' : 'context-test';
  runtime.registerProvider(providerId, provider);
  const model = localOnly ? require('../main/pi-session/local-model-runtime-privacy.cjs')
    .configure(runtime, runtime.getModel(providerId, next.id), next) : runtime.getModel(providerId, next.id);
  const settings = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const loader = new sdk.DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: 'A deterministic integration test.' });
  await loader.reload();
  const manager = sdk.SessionManager.create(root, root);
  ({ session } = await sdk.createAgentSession({ cwd: root, agentDir: root, modelRuntime: runtime,
    model, settingsManager: settings, resourceLoader: loader,
    sessionManager: manager, tools: ['context_probe'], customTools: [{ name: 'context_probe', label: 'probe', description: 'Test tool',
      parameters: { type: 'object', properties: {} }, execute: async () => { toolCalls++; return { content: [{ type: 'text', text: 'TOOL_OK ' + 'archived evidence ' .repeat(3000) }], details: {} }; } }] }));
  const acc = events.create();
  const nativeEvents = [];
  session.subscribe(event => { nativeEvents.push(event); acc.push(event); });
  await recovery.prompt(session, acc, '调用 context_probe 一次，保留约束：不得重复调用。', {});
  assert.ok(rejections >= 2, 'both original context and native summary must be rejected');
  assert.ok(nativeEvents.some(e => e.type === 'compaction_end' && e.errorMessage), 'native summary failure is observed');
  assert.ok(manager.getBranch().some(e => e.customType === recovery.TYPE), 'fallback used after native summary failure');
  assert.equal(toolCalls, 1);
  assert.match(JSON.stringify(acc.snapshot()), /RECOVERED_TOOL_OK/);
  const id = manager.getSessionId();
  await recovery.prompt(session, acc, 'FOLLOWUP', {});
  assert.match(JSON.stringify(acc.snapshot()), /FOLLOWUP_OK/);
  assert.equal(manager.getSessionId(), id);
  assert.equal(acc.state.lastStopReason, 'stop');
  const users = manager.getBranch().filter(e => e.type === 'message' && e.message.role === 'user');
  assert.equal(users.length, 2, 'hidden recovery never duplicates user messages');
  assert.ok(JSON.stringify(bodies.at(-1)).includes('不得重复调用'));
  if (localOnly) {
    assert.ok(bodies.every(body => body.model === next.wireModelId), 'normal turns and compaction use the private wire name');
    const archive = fs.readFileSync(manager.getSessionFile(), 'utf8');
    for (const privateValue of [next.wireModelId, next.baseUrl, next.key, next.label]) {
      assert.ok(!archive.includes(privateValue), 'session recovery cannot persist private model configuration');
    }
    const learned = manager.getBranch().find(entry => entry.customType === 'soduwork.context-window');
    assert.equal(learned.data.key, providerId + '|' + next.id);
    assert.equal(learned.data.window, 8192);
  }
});
