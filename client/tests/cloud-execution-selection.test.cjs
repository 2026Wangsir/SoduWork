'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { create } = require('../main/conversation/cloud-handoff');
const models = require('../main/pi-session/model-config');
const account = uid => ({ hub: 'http://localhost:18989', clientId: 'test', session:
  Buffer.from(JSON.stringify({ typ: 'device', uid, cid: 'test', iat: Math.floor(Date.now()/1000)-1, exp: Math.floor(Date.now()/1000)+3600 })).toString('base64url') + '.' + 'a'.repeat(64) });

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'soduwork-cloud-selection-')), app = { getPath: () => root };
  let identity = account('alice'), selection = { agentId: 'pi', modelName: 'a' }, lose = false, resolveGate = null;
  const requests = [], controllers = [], handles = [];
  const original = models.fetchModel;
  models.fetchModel = async (_identity, name) => { if (resolveGate) await resolveGate;
    return name === 'denied' ? { ok: false, reason: 'Model denied' } : { ok: true, model: { id: 'provider-' + name } }; };
  const request = async (_identity, route, options = {}) => {
    if (route.endsWith('/targets')) return { ok: true, targets: ['pi', 'opencode', 'qwen'].map(agentId => ({ agentId, runnerId: 'runner-a' })) };
    if (route.startsWith('/cloud-conversations/')) {
      const input = JSON.parse(options.body.get('options'));
      return { phase: 'committed', transferId: route.split('/').at(-1), taskId: 'task', ref: 'run', status: 'done',
        source: { sessionId: input.sessionId, adapterId: input.agentId, entryKind: 'cloud' },
        target: { runnerId: 'runner-a', agentId: 'pi', model: 'a' } };
    }
    if (route.includes('/ai-session?')) return { ok: true, status: 'done', last: 0, items: [], activeExecutionSelection: selection };
    if (route.endsWith('/attachments')) return [];
    if (route.endsWith('/ai-say')) {
      const input = JSON.parse(options.body); requests.push(input);
      if (lose) throw Error('Lost acknowledgement');
      if (input.executionSelection) selection = input.executionSelection;
      return { ok: true, messageId: input.messageId, acceptedSelection: selection };
    }
    throw Error('Unexpected route ' + route);
  };
  function controller() { const c = create({ app, identityOf: async () => identity, request, interval: 60000 }); controllers.push(c); return c; }
  const cloud = controller(), start = await cloud.start({ requestId: crypto.randomUUID(), agentId: 'pi', model: 'a', text: 'First turn' });
  async function open(c = cloud) { const h = await c.reopen(start.sessionId); assert.ok(h?.snapshot);
    handles.push(h); await new Promise(r => setTimeout(r, 15)); return h; }
  t.after(async () => { for (const h of handles) await h.close(); models.fetchModel = original; await fs.rm(root, { recursive: true, force: true, maxRetries: 4 }); });
  const handle = await open();
  return { cloud, handle, requests, open, controller, get selection() { return selection; },
    set lose(v) { lose = v; }, set resolveGate(v) { resolveGate = v; }, set identity(v) { identity = v; } };
}

test('cloud selection is committed with its message and survives reopen in the same conversation', async t => {
  const f = await fixture(t), id = f.handle.sessionId;
  for (const agentId of ['opencode', 'qwen', 'pi']) {
    const selected = await f.cloud.selectExecution(f.handle, { agentId }); assert.equal(selected.ok, true, selected.reason);
    assert.equal(selected.effective, 'next-turn'); assert.equal(f.requests.length, ['opencode', 'qwen', 'pi'].indexOf(agentId));
    const sent = await f.cloud.send(f.handle, 'Continue ' + agentId, []); assert.equal(sent.ok, true);
    assert.equal(f.requests.at(-1).executionSelection.agentId, agentId);
    assert.equal(f.handle.sessionId, id);
  }
  assert.equal((await f.cloud.selectExecution(f.handle, { modelName: 'b' })).ok, true);
  assert.equal((await f.cloud.send(f.handle, 'Use b', [])).ok, true);
  const restored = await f.open(f.controller());
  assert.equal(restored.snapshot().adapterId, 'pi'); assert.equal(restored.snapshot().modelSelection.name, 'b');
});

test('cloud selection serializes against sends and immutable retry retains its original choice', async t => {
  const f = await fixture(t); let release; f.resolveGate = new Promise(r => { release = r; });
  const selecting = f.cloud.selectExecution(f.handle, { agentId: 'qwen' });
  await new Promise(r => setImmediate(r));
  await assert.rejects(f.cloud.send(f.handle, 'Too early', []), /正在处理/);
  release(); assert.equal((await selecting).ok, true); f.resolveGate = null;
  f.lose = true; await assert.rejects(f.cloud.send(f.handle, 'Retry me', []), /Lost/);
  assert.equal((await f.cloud.selectExecution(f.handle, { agentId: 'pi' })).ok, false);
  f.lose = false; assert.equal((await f.cloud.send(f.handle, 'Retry me', [])).ok, true);
  assert.equal(f.requests[0].messageId, f.requests[1].messageId);
  assert.deepEqual(f.requests[0].executionSelection, f.requests[1].executionSelection);
  assert.equal(f.selection.agentId, 'qwen');
});

test('cloud rejects unavailable Agent, unauthorized model and changed account without changing selection', async t => {
  const f = await fixture(t);
  assert.equal((await f.cloud.selectExecution(f.handle, { agentId: 'codex' })).ok, false);
  assert.equal((await f.cloud.selectExecution(f.handle, { modelName: 'denied' })).ok, false);
  f.identity = account('bob');
  assert.equal((await f.cloud.selectExecution(f.handle, { agentId: 'qwen' })).ok, false);
  assert.equal(f.selection.agentId, 'pi'); assert.equal(f.requests.length, 0);
});

test('cloud rejects explicit device model references before resolution or persistence', async t => {
  const f = await fixture(t);
  const resolve = t.mock.method(models, 'fetchModel', async () => { throw Error('Must not resolve a device model'); });
  for (const modelName of ['local:model-0123456789abcdef0123456789abcdef',
    '  local:model-0123456789abcdef0123456789abcdef  ',
    'image::private::local:model-0123456789abcdef0123456789abcdef']) {
    const result = await f.cloud.selectExecution(f.handle, { modelName });
    assert.equal(result.ok, false);
    assert.match(result.reason, /云端暂不支持本地模型/);
  }
  assert.equal(resolve.mock.callCount(), 0);
  assert.equal(f.handle.snapshot().modelSelection.name, 'a');
  assert.equal(f.requests.length, 0);
});
