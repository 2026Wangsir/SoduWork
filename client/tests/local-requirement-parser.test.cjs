'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLocalRequirementParser } = require('../main/local-requirement-parser.cjs');

function identity() {
  const now = Math.floor(Date.now() / 1000);
  const claims = { typ: 'device', uid: 'local-parser-user', cid: 'local-parser-device', iat: now - 1, exp: now + 3600 };
  return { hub: 'https://hub.fixture.invalid', clientId: 'local-parser-device',
    session: Buffer.from(JSON.stringify(claims)).toString('base64url') + '.' + 'a'.repeat(64), secret: 'synthetic-secret' };
}

test('local requirement parsing uses the private endpoint and never authorizes with Hub', async () => {
  const requests = [], model = { id: 'local:model-0123456789abcdef0123456789abcdef', wireModelId: 'private-wire-model',
    localOnly: true, baseUrl: 'http://127.0.0.1:43123/v1', key: 'private-key', input: ['text'], maxOutputTokens: 2048 };
  const parser = createLocalRequirementParser({ app: {}, identityOf: async () => identity(),
    resolveModel: async () => ({ ok: true, localOnly: true, model }),
    fetchImpl: async (url, init) => {
      requests.push({ url, body: JSON.parse(init.body), headers: init.headers });
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"title":"Local requirement"}' }, finish_reason: 'stop' }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } });
    } });
  const result = await parser({ model: model.id, input: '原始需求', instructions: '只返回 JSON',
    requestId: 'local-parser-1', maxOutputTokens: 256, timeoutMs: 1000 });
  assert.equal(result.ok, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, model.baseUrl + '/chat/completions');
  assert.equal(requests[0].body.model, model.wireModelId);
  assert.equal(requests[0].headers.Authorization, 'Bearer private-key');
});

test('the local parser rejects hosted model references before any network request', async () => {
  let called = false;
  const parser = createLocalRequirementParser({ app: {}, identityOf: async () => identity(),
    fetchImpl: async () => { called = true; throw Error('unexpected network'); } });
  const result = await parser({ model: 'managed-model', input: '原始需求', instructions: '只返回 JSON', requestId: 'local-parser-2' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'APP_AI_LOCAL_MODEL_REQUIRED');
  assert.equal(called, false);
});
