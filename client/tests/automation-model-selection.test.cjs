'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const modelConfig = require('../main/pi-session/model-config');

test('the local model catalog still resolves explicit model selections', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-automation-model-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = { getPath: () => root };
  modelConfig.writeModels(path.join(root, 'pi-agent'), {
    id: 'soduwork-prd-large', label: 'GLM5.3Flash', baseUrl: 'https://example.invalid',
    key: 'ticket', input: ['text'], contextWindow: 128000,
  });
  assert.equal(modelConfig.configuredModel(app), 'soduwork-prd-large');
});

test('automation opening does not copy the ordinary composer model implicitly', () => {
  const source = fs.readFileSync(path.join(__dirname, '../main/pi-session/ipc.js'), 'utf8');
  assert.doesNotMatch(source, /automationContext[\s\S]{0,300}configuredModel\(app\)/,
    'automation must receive its model from the schedule envelope');
});

test('a missing or malformed local model profile leaves the server default path intact', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-automation-model-empty-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = { getPath: () => root };
  assert.equal(modelConfig.configuredModel(app), '');
  fs.mkdirSync(path.join(root, 'pi-agent'), { recursive: true });
  fs.writeFileSync(path.join(root, 'pi-agent', 'models.json'), '{');
  assert.equal(modelConfig.configuredModel(app), '');
});

const { createSelector } = require('../main/automation-model-selection.cjs');
const { runtimes } = require('../main/agent-runtime/runtime-catalog');
const first = 'local:model-' + 'a'.repeat(32), second = 'local:model-' + 'b'.repeat(32);
const removed = 'local:model-' + 'c'.repeat(32);
const identity = { hub: 'https://example.invalid', clientId: 'device' };

function fixture(local = [first, second], managed = ['hub-first', 'hub-second']) {
  const requests = [];
  const select = createSelector({
    localCatalog: () => ({ usable: local.map(name => ({ name, localOnly: true })) }),
    request: async (owner, route) => {
      requests.push({ owner, route });
      return { usable: managed.map(name => ({ name })) };
    },
  });
  return { select, requests };
}

test('unattended automations choose the first local model on every managed runtime', async () => {
  for (const runtime of runtimes().filter(row => row.modelMode === 'managed')) {
    const f = fixture();
    for (const model of ['', removed]) assert.equal(await f.select(identity, runtime.id, model), first);
    assert.equal(await f.select(identity, runtime.id, second), second);
    assert.equal(f.requests.length, 0);
  }
});

test('valid managed selections remain selected; removed selections prefer local models', async () => {
  const f = fixture();
  assert.equal(await f.select(identity, 'qwen', 'hub-second'), 'hub-second');
  assert.equal(await f.select(identity, 'qwen', 'removed-hub'), first);
  assert.deepEqual(f.requests, Array.from({ length: 2 }, () => ({ owner: identity, route: '/my-models' })));
});

test('missing selections use the first managed model when no local model is available', async () => {
  const f = fixture([]);
  for (const model of ['', removed, 'removed-hub']) assert.equal(await f.select(identity, 'pi', model), 'hub-first');
  await assert.rejects(fixture([], []).select(identity, 'pi', ''), /没有可用模型/);
});

test('account runtimes never read or substitute SoduWork models', async () => {
  const select = createSelector({ localCatalog() { throw Error('must not read'); }, request() { throw Error('must not request'); } });
  for (const adapter of ['codex', 'claude']) {
    assert.equal(await select(identity, adapter, ''), '');
    assert.equal(await select(identity, adapter, 'native-model'), 'native-model');
  }
});

test('unreadable local storage and failed managed catalog reads never imply deletion', async () => {
  let requests = 0;
  const unreadable = createSelector({ localCatalog() { throw Error('safe storage locked'); }, request() { requests++; } });
  await assert.rejects(unreadable(identity, 'pi', removed), /safe storage locked/);
  assert.equal(requests, 0);
  const offline = createSelector({ localCatalog: () => ({ usable: [{ name: first }] }), request() { throw Error('offline'); } });
  await assert.rejects(offline(identity, 'pi', 'hub-model'), /offline/);
});

test('malformed catalogs and Hub-supplied private references cannot become fallback models', async () => {
  const localCatalog = () => ({ usable: [] });
  const malformed = createSelector({ localCatalog, request: async () => ({}) });
  await assert.rejects(malformed(identity, 'pi', ''), /模型目录/);
  const select = createSelector({ localCatalog, request: async () => ({ usable: [
    { name: first }, { name: 'image::p::' + first }, { name: 'private', localOnly: true },
    { name: 'provider-private', providerId: 'device:secret' }, { name: 'hub-first' },
  ] }) });
  assert.equal(await select(identity, 'pi', ''), 'hub-first');
});

test('failed catalogs and unavailable placeholders cannot select replacements', async () => {
  for (const local of [{ ok: false, usable: [] }, { ok: false, usable: [{ name: first }] }]) {
    const select = createSelector({ localCatalog: () => local, request() { assert.fail('failed vault cannot fall back'); } });
    await assert.rejects(select(identity, 'pi', ''), /本地模型目录/);
  }
  const failedHub = createSelector({ localCatalog: () => ({ usable: [] }), request: async () => ({ ok: false, usable: [{ name: 'hub' }] }) });
  await assert.rejects(failedHub(identity, 'pi', ''), /模型目录/);
  const select = createSelector({ localCatalog: () => ({ usable: [
    { name: first, available: false }, { name: second, unavailable: true }, { name: 'local:unavailable' },
  ] }), request: async () => ({ usable: [
    { name: 'hub-unavailable', unavailable: true }, { name: 'disabled', available: false },
    { name: 'unavailable:removed' }, { name: 'hub-usable' },
  ] }) });
  assert.equal(await select(identity, 'pi', ''), 'hub-usable');
  await assert.rejects(select(identity, 'pi', 'local:unavailable'), /重新选择/);
});

test('image selections retain the Pi-only execution boundary', async () => {
  const imageName = 'image::provider::' + first;
  const select = createSelector({ localCatalog: () => ({ usable: [], mediaUsable: {
    image: [{ providerId: 'provider', name: first }],
  } }), request() { assert.fail('valid local image must not query Hub'); } });
  assert.equal(await select(identity, 'pi', imageName), imageName);
  for (const adapter of ['qwen', 'harness2', 'opencode']) {
    await assert.rejects(select(identity, adapter, imageName), /不支持图片模型/);
  }
});
