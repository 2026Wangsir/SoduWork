'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { piProvider } = require('../main/conversation/model-selection');
const privacy = require('../main/pi-session/local-model-runtime-privacy.cjs');

test('Pi sends no Authorization header for a local no-key model', { timeout: 20000 }, async t => {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.headers);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: ' + JSON.stringify({ id: 'local', object: 'chat.completion.chunk', model: 'qwen3',
      choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] }) +
      '\n\ndata: ' + JSON.stringify({ id: 'local', object: 'chat.completion.chunk', model: 'qwen3',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) +
      '\n\ndata: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-local-transport-'));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const sdk = await import('../node_modules/@earendil-works/pi-coding-agent/dist/index.js');
  const runtime = await sdk.ModelRuntime.create({ modelsPath: null,
    authPath: path.join(root, 'auth.json'), modelsStorePath: path.join(root, 'models.db') });
  const next = { id: 'local:model-' + '1'.repeat(32), wireModelId: 'qwen3', label: 'Qwen 3', key: '', localOnly: true,
    baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1' };
  runtime.registerProvider('soduwork', piProvider(next));
  const model = privacy.configure(runtime, runtime.getModel('soduwork', next.id), next);
  const result = await runtime.stream(model, { systemPrompt: '', messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }] }).result();
  assert.equal(result.stopReason, 'stop');
  assert.equal(result.content[0].text, 'ok');
  assert.equal(result.model, next.id);
  assert.equal(result.responseModel, undefined);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].authorization, undefined);
});
