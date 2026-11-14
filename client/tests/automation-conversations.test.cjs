const test = require('node:test');
const assert = require('node:assert/strict');
const { createWorker, keyOf, pluginSelection, diskJournal } = require('../main/automation-conversations');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');

function fixture() {
  const identity = { hub: 'http://example.invalid', clientId: 'device' }, store = new Map(), calls = [], acks = [];
  let finish, reject, status = 'streaming', ackOffline = false;
  const completion = new Promise((resolve, fail) => { finish = resolve; reject = fail; });
  const input = { runId: 'run-1', title: '测试', conversationTitle: '自动化 · 测试 · 2026-10-26 10:20', text: '完整说明\n验收要求\n参数：中文', adapterId: 'pi',
    attachments: [{ name: 'input.txt', data: 'materials' }], projectId: 'project', repoId: 'repo-1' };
  const journal = { read: key => store.get(key), write: (key, record) => store.set(key, { ...record }) };
  const request = async (_identity, route, body) => {
    if (route.endsWith('/inbox')) return { items: [{ id: input.runId }] };
    if (route.endsWith('/claim')) return { ok: true, input };
    if (ackOffline) throw Error('offline');
    acks.push(body); return { ok: true };
  };
  const conversation = {
    open: async (options, owner) => { calls.push(['open', options, owner]); return { ok: true, sessionId: 'chat-1', ref: 'ref-1' }; },
    send: async (...args) => { calls.push(['send', ...args]); return { ok: true, completion }; },
    find: () => ({ status: () => status }),
  };
  const deps = { identityOf: async () => identity, request, journal, conversation, catalog: async () => [], instanceId: 'worker' };
  return { identity, store, calls, acks, input, deps, journal, finish, reject,
    setStatus: value => { status = value; }, setOffline: value => { ackOffline = value; },
    get record() { return journal.read(keyOf(identity, input.runId)); } };
}

test('automation opens and sends an ordinary chat, with complete materials and no Task or goal', async () => {
  const f = fixture(), worker = createWorker(f.deps);
  await worker.tick();
  const open = f.calls[0][1], send = f.calls[1];
  assert.equal(open.intent, 'chat'); assert.equal(open.taskRef, undefined);
  assert.equal(open.sessionTitle, f.input.conversationTitle);
  assert.equal(Object.hasOwn(open, 'modelName'), true);
  assert.equal(open.modelName, '',
    'an empty automation model must explicitly select the current runtime default');
  assert.equal(send[2], f.input.text); assert.deepEqual(send[3], f.input.attachments);
  assert.equal(send[4].taskId, undefined); assert.equal(send[4].projectId, f.input.projectId);
  assert.equal(send[4].repoId, f.input.repoId);
  assert.equal(send[4].source, 'automation',
    'scheduled prompts must stay on the ordinary conversation path');
  assert.equal(open.projectId, f.input.projectId);
  assert.equal(open.repoId, f.input.repoId);
  assert.equal(send[4].submissionId, 'automation-run-1');
  assert.equal(f.record.conversationId, 'chat-1');
  assert.equal(f.record.phase, 'sending');
  await worker.tick(); assert.equal(f.calls.length, 2);
  f.finish({ ok: true }); await Promise.resolve(); await worker.tick();
  assert.equal(f.acks.at(-1).state, 'succeeded');
  await worker.tick(); assert.equal(f.calls.length, 2);
});

test('automation injects the locally stored model only after Hub claim', async () => {
  const f = fixture();
  f.input.scheduleId = 'schedule-1';
  f.deps.request = async (_identity, route, body) => {
    if (route.endsWith('/inbox')) return { items: [{ id: f.input.runId }] };
    if (route.endsWith('/claim')) return { ok: true, input: f.input, scheduleId: f.input.scheduleId };
    f.acks.push(body); return { ok: true };
  };
  f.deps.localModelOf = async (_identity, scheduleId) => {
    assert.equal(scheduleId, 'schedule-1');
    return 'local:model-0123456789abcdef0123456789abcdef';
  };
  await createWorker(f.deps).tick();
  assert.equal(f.calls[0][1].modelName, 'local:model-0123456789abcdef0123456789abcdef');
});

test('automation executes a deleted managed selection with its resolved local replacement without uploading it', async () => {
  const f = fixture(), replacement = 'local:model-' + 'a'.repeat(32);
  f.input.modelSource = 'managed';
  f.input.modelName = 'deleted-hub-model';
  f.deps.selectModel = async (identity, adapter, selected) => {
    assert.equal(identity, f.identity);
    assert.equal(adapter, 'pi');
    assert.equal(selected, 'deleted-hub-model');
    return replacement;
  };
  await createWorker(f.deps).tick();
  assert.equal(f.calls[0][1].modelName, replacement);
  assert.equal(f.input.modelName, 'deleted-hub-model');
  assert.equal(JSON.stringify(f.acks).includes(replacement), false);
  assert.equal(JSON.stringify([...f.store.values()]).includes(replacement), false);
  f.finish({ ok: true });
});

test('automation checks the account again after asynchronous model selection before opening a chat', async () => {
  const f = fixture();
  let identity = f.identity;
  f.deps.identityOf = async () => identity;
  f.deps.selectModel = async () => {
    identity = { ...f.identity, clientId: 'another-device' };
    return 'replacement-model';
  };
  await createWorker(f.deps).tick();
  assert.equal(f.calls.length, 0);
});

test('missing device-owned mapping cannot invoke model fallback', async () => {
  const f = fixture();
  f.input.modelSource = 'device';
  f.deps.request = async (_identity, route, body) => {
    if (route.endsWith('/inbox')) return { items: [{ id: f.input.runId }] };
    if (route.endsWith('/claim')) return { ok: true, input: f.input, scheduleId: 'schedule' };
    f.acks.push(body); return { ok: true };
  };
  f.deps.localModelOf = async () => { throw Error('unverified ownership'); };
  f.deps.selectModel = async () => { assert.fail('unowned mappings must not choose a replacement'); };
  await createWorker(f.deps).tick();
  assert.equal(f.calls.length, 0);
});

test('a verified device selection whose model was removed uses the next local model at execution', async () => {
  const f = fixture(), removed = 'local:model-' + 'a'.repeat(32), replacement = 'local:model-' + 'b'.repeat(32);
  f.input.modelSource = 'device';
  f.deps.request = async (_identity, route, body) => {
    if (route.endsWith('/inbox')) return { items: [{ id: f.input.runId }] };
    if (route.endsWith('/claim')) return { ok: true, input: f.input, scheduleId: 'schedule' };
    f.acks.push(body); return { ok: true };
  };
  f.deps.localModelOf = async () => removed;
  f.deps.selectModel = require('../main/automation-model-selection.cjs').createSelector({
    localCatalog: () => ({ usable: [{ name: replacement }] }),
    request() { assert.fail('a local replacement must not query Hub'); },
  });
  await createWorker(f.deps).tick();
  assert.equal(f.calls[0][1].modelName, replacement);
  assert.equal(JSON.stringify(f.acks).includes('local:model-'), false);
  f.finish({ ok: true });
});

test('automation fails closed when a saved local model selection disappears', async () => {
  const f = fixture();
  f.input.scheduleId = 'schedule-1';
  f.deps.request = async (_identity, route, body) => {
    if (route.endsWith('/inbox')) return { items: [{ id: f.input.runId }] };
    if (route.endsWith('/claim')) return { ok: true, input: f.input, scheduleId: f.input.scheduleId };
    f.acks.push(body); return { ok: true };
  };
  f.deps.localModelOf = async () => { throw Error('本地模型选择不可用，请在自动化设置中重新选择'); };
  await createWorker(f.deps).tick();
  assert.equal(f.calls.length, 0);
  assert.equal(f.record.state, 'failed');
  assert.match(f.record.error, /本地模型选择不可用/);
});

test('a legacy managed schedule with no local mapping retains its explicit runtime default', async () => {
  const f = fixture();
  f.deps.request = async (_identity, route, body) => {
    if (route.endsWith('/inbox')) return { items: [{ id: f.input.runId }] };
    if (route.endsWith('/claim')) return { ok: true, input: f.input, scheduleId: 'schedule-1' };
    f.acks.push(body); return { ok: true };
  };
  f.deps.localModelOf = async (_identity, _scheduleId, source) => {
    if (source === 'device') throw Error('An explicit device source requires a saved mapping');
    return '';
  };
  await createWorker(f.deps).tick();
  assert.equal(f.calls[0][1].modelName, '');
  assert.equal(f.record.phase, 'sending');
});

test('device-owned automation refuses an old claim without schedule identity', async () => {
  const f = fixture();
  f.input.modelSource = 'device';
  f.deps.request = async (_identity, route) => {
    if (route.endsWith('/inbox')) return { items: [{ id: f.input.runId }] };
    if (route.endsWith('/claim')) return { ok: true, input: f.input };
    f.acks.push({}); return { ok: true };
  };
  f.deps.localModelOf = async () => { throw Error('must not read an unscoped local mapping'); };
  await createWorker(f.deps).tick();
  assert.equal(f.calls.length, 0);
  assert.equal(f.record.state, 'failed');
  assert.match(f.record.error, /升级 Hub/);
});

test('managed automation rejects wrapped local image references without leaking them in receipts', async () => {
  for (const modelName of ['image::private::local:model-secret', 'image::device:private::local:model-secret']) {
    const f = fixture();
    f.input.modelSource = 'managed';
    f.input.modelName = modelName;
    await createWorker(f.deps).tick();
    assert.equal(f.calls.length, 0);
    assert.equal(f.record.state, 'failed');
    assert.match(f.record.error, /本地模型自动化协议不完整/);
    assert.equal(JSON.stringify(f.acks).includes('model-secret'), false);
    assert.equal(JSON.stringify(f.acks).includes('private'), false);
  }
});

test('automation publishes the conversation as soon as the ordinary chat is created', async () => {
  const f = fixture();
  await createWorker(f.deps).tick();
  assert.deepEqual(f.acks.map(item => [item.state, item.conversationId]), [
    ['starting', 'chat-1'],
    ['running', 'chat-1'],
  ]);
  assert.deepEqual(f.calls.map(item => item[0]), ['open', 'send']);
});

test('a restarted client adopts a cross-client conversation without reporting a dispatch failure', async () => {
  const f = fixture();
  let claims = 0;
  f.deps.request = async (_identity, route, body) => {
    if (route.endsWith('/inbox')) return { items: [{ id: f.input.runId }] };
    if (route.endsWith('/claim')) { claims++; return { ok: true, input: f.input, conversationId: 'chat-from-another-client' }; }
    f.acks.push(body); return { ok: true, state: body.state };
  };
  await createWorker(f.deps).tick();
  assert.equal(f.calls.length, 0, 'adopting an existing receipt must never open or send another prompt');
  assert.equal(f.record.phase, 'adopted');
  assert.equal(f.record.state, 'running');
  assert.equal(f.record.conversationId, 'chat-from-another-client');
  assert.equal(f.record.error, '');
  assert.equal(f.acks.length, 0, 'an observer cannot report that another worker is executing');
  await createWorker(f.deps).tick();
  assert.equal(f.calls.length, 0, 'an adopted receipt must stay read-only on subsequent polling');
  assert.equal(claims, 1, 'old Hubs must not receive repeated lease takeover requests');
  assert.equal(f.acks.length, 0);
});

test('a lease observer neither starts work nor renews a missing execution', async () => {
  for (const journal of [null, { phase: 'sending', state: 'running', conversationId: 'chat-1', workerId: 'old-worker' }]) {
    const f = fixture(); let claims = 0;
    if (journal) f.journal.write(keyOf(f.identity, f.input.runId), journal);
    f.deps.request = async (_identity, route, body) => {
      if (route.endsWith('/inbox')) return { items: [{ id: f.input.runId }] };
      if (route.endsWith('/claim')) {
        claims++;
        return { ok: true, observeOnly: true, state: 'running', conversationId: 'chat-1' };
      }
      f.acks.push(body); return { ok: true };
    };
    const worker = createWorker({ ...f.deps, instanceId: 'replacement' });
    await worker.tick(); await worker.tick();
    assert.equal(f.record.phase, 'adopted');
    assert.equal(f.calls.length, 0); assert.equal(f.acks.length, 0); assert.equal(claims, 1);
  }
});

test('a restarted worker retries only its durable terminal receipt using the original owner', async () => {
  for (const state of ['succeeded', 'failed']) {
    const f = fixture(), original = createWorker(f.deps);
    await original.tick(); f.setOffline(true); f.finish({ ok: state === 'succeeded' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.record.workerId, 'worker'); assert.equal(f.record.state, state);
    f.deps.request = async (_identity, route, body) => {
      if (route.endsWith('/inbox')) return { items: [{ id: f.input.runId }] };
      if (route.endsWith('/claim')) return { ok: true, observeOnly: true, state: 'running', conversationId: 'chat-1' };
      f.acks.push(body); return { ok: true };
    };
    await createWorker({ ...f.deps, instanceId: 'replacement' }).tick();
    assert.equal(f.acks.at(-1).state, state); assert.equal(f.acks.at(-1).instanceId, 'worker');
    assert.equal(f.calls.filter(call => call[0] === 'send').length, 1);
  }
});

test('only a matching successful receipt can repair an expired lease after restart', async () => {
  for (const [code, conversationId, localState, workerId, retry] of [
    ['AUTOMATION_RECEIPT_TIMEOUT', 'chat-1', 'succeeded', 'original', true],
    ['AUTOMATION_RECEIPT_TIMEOUT', 'chat-1', 'failed', 'original', false],
    ['AUTOMATION_RECEIPT_TIMEOUT', 'chat-other', 'succeeded', 'original', false],
    ['AUTOMATION_RECEIPT_TIMEOUT', 'chat-1', 'succeeded', undefined, false],
    ['EXECUTION_FAILED', 'chat-1', 'succeeded', 'original', false],
  ]) {
    const f = fixture();
    f.journal.write(keyOf(f.identity, f.input.runId), {
      phase: 'sending', state: localState, workerId, conversationId: 'chat-1' });
    f.deps.request = async (_identity, route, body) => {
      if (route.endsWith('/inbox')) return { items: [{ id: f.input.runId }] };
      if (route.endsWith('/claim')) return { ok: true, terminal: true, state: 'failed', errorCode: code, conversationId };
      f.acks.push(body); return { ok: true };
    };
    await createWorker(f.deps).tick();
    assert.equal(f.acks.length, retry ? 1 : 0);
    if (retry) assert.equal(f.acks[0].instanceId, 'original');
    assert.equal(f.calls.length, 0);
  }
});

test('a failure before chat creation is retried by the newly granted owner without sending', async () => {
  const f = fixture();
  f.journal.write(keyOf(f.identity, f.input.runId), {
    state: 'failed', workerId: 'original', error: 'model unavailable' });
  await createWorker({ ...f.deps, instanceId: 'replacement' }).tick();
  assert.equal(f.acks.at(-1).state, 'failed');
  assert.equal(f.acks.at(-1).instanceId, 'replacement');
  assert.equal(f.record.workerId, 'replacement'); assert.equal(f.calls.length, 0);
});

test('live execution renews only its own journal owner and still publishes completion', async () => {
  const f = fixture(), worker = createWorker(f.deps);
  await worker.tick(); await worker.tick();
  assert.equal(f.acks.at(-1).instanceId, 'worker'); assert.equal(f.acks.at(-1).state, 'running');
  f.journal.write(keyOf(f.identity, f.input.runId), { ...f.record, workerId: 'replacement' });
  const count = f.acks.length;
  await worker.tick(); assert.equal(f.acks.length, count);
  f.finish({ ok: true }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.acks.at(-1).state, 'succeeded'); assert.equal(f.acks.at(-1).instanceId, 'worker');
});

test('manual runs freeze the device access choice before opening the ordinary conversation', async () => {
  for (const mode of ['standard', 'readonly']) {
    const f = fixture();
    f.deps.request = async (_identity, route, body) => {
      if (route.endsWith('/inbox')) return { items: [{ id: f.input.runId }] };
      if (route.endsWith('/claim')) return { ok: true, trigger: 'manual', input: f.input };
      f.acks.push(body); return { ok: true };
    };
    f.deps.conversation.captureAutomationAccess = () => ({ mode });
    f.deps.conversation.openAutomation = async (options, identity, choice) => {
      assert.equal(f.record.accessChoice.mode, mode, 'the selection must be durable before opening');
      return f.deps.conversation.open({ ...options, accessMode: choice.mode }, identity);
    };
    await createWorker(f.deps).tick();
    assert.equal(f.calls[0][1].accessMode, mode);
  }
});

test('automation records the actionable model error when chat startup is rejected', async () => {
  const f = fixture();
  f.deps.conversation.open = async () => ({ ok: false, reason: '模型「旧模型」现在不可用，请重新选择' });
  await createWorker(f.deps).tick();
  assert.equal(f.record.state, 'failed');
  assert.match(f.record.error, /旧模型/);
});

test('automation opening does not forward policy or consent objects from its envelope', async () => {
  const f = fixture();
  Object.assign(f.input, { accessPolicy: { mode: 'full' }, accessConsentId: 'forged', accessDraftId: 'forged' });
  await createWorker(f.deps).tick();
  assert.equal(f.calls[0][1].accessPolicy, undefined);
  assert.equal(f.calls[0][1].accessConsentId, undefined);
  assert.equal(f.calls[0][1].accessDraftId, undefined);
});

function manualFixture(t, mode = 'full') {
  const f = fixture(), root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-worker-access-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = { getPath: () => root }, rules = require('../main/access-control/automation-access');
  const identity = uid => {
    const now = Math.floor(Date.now() / 1000);
    return { ...f.identity, session: Buffer.from(JSON.stringify({ typ: 'device', uid, cid: 'device', iat: now - 60, exp: now + 3600 })).toString('base64url') + '.' + 'a'.repeat(64) };
  };
  Object.assign(f.identity, identity('owner'));
  const preference = next => fs.writeFileSync(path.join(root, 'access-preferences.json'), JSON.stringify({ schema: 1, mode: next, revision: 1, fullConsentVersion: 1 }));
  preference(mode);
  let trigger = 'manual', current = f.identity, ackOffline = false;
  f.deps.identityOf = async () => current;
  f.deps.request = async (_owner, route, body) => {
    if (route.endsWith('/inbox')) return { items: [{ id: f.input.runId }] };
    if (route.endsWith('/claim')) return { ok: true, trigger, input: f.input };
    if (ackOffline) throw Error('offline');
    f.acks.push(body); return { ok: true };
  };
  Object.assign(f.deps.conversation, rules.service(app, async (_event, options, owner, context) => {
    rules.assertCurrent(context, current);
    return f.deps.conversation.open(rules.apply(options, context), owner);
  }));
  return { ...f, get record() { return f.record; }, preference, setTrigger: next => { trigger = next; },
    setAccount: uid => { current = identity(uid); }, setOffline: next => { ackOffline = next; } };
}
test('a manually created conversation retries its receipt with the same frozen choice and sends once', async t => {
  const f = manualFixture(t), worker = createWorker(f.deps); f.setOffline(true);
  await worker.tick(); assert.equal(f.record.phase, 'created');
  assert.equal(f.record.accessChoice.mode, 'full');
  f.preference('readonly'); f.setOffline(false); await worker.tick();
  assert.equal(f.calls[1][1].chatId, 'chat-1'); assert.equal(f.calls[1][1].accessMode, undefined,
    'the saved chat owns its policy when reattaching');
  assert.equal(f.calls.filter(call => call[0] === 'send').length, 1);
  f.finish({ ok: true }); await Promise.resolve(); await worker.tick(); await worker.tick();
  assert.equal(f.record.accessChoice.mode, 'full');
  assert.equal(f.calls.filter(call => call[0] === 'send').length, 1);
});
test('timer and missing-trigger runs ignore full access fields in the Hub input', async t => {
  for (const trigger of ['timer', undefined]) {
    const f = manualFixture(t); f.setTrigger(trigger);
    Object.assign(f.input, { accessMode: 'full', trigger: 'manual', accessPolicy: { mode: 'full' } });
    await createWorker(f.deps).tick();
    assert.equal(f.record.accessChoice, null);
    assert.equal(f.calls[0][1].accessMode, undefined);
    assert.equal(f.calls.filter(call => call[0] === 'send').length, 1);
  }
});
test('a legacy journal with no recorded choice cannot inherit a later full default', async t => {
  const f = manualFixture(t);
  f.journal.write(keyOf(f.identity, f.input.runId), { phase: 'created', state: 'running', conversationId: 'chat-1' });
  await createWorker(f.deps).tick();
  assert.equal(f.calls[0][1].chatId, 'chat-1'); assert.equal(f.calls[0][1].accessMode, undefined);
  assert.equal(f.record.accessChoice, undefined);
});
test('switching accounts after manual creation cannot resend from the original choice', async t => {
  const f = manualFixture(t), worker = createWorker(f.deps); f.setOffline(true);
  await worker.tick(); assert.equal(f.record.phase, 'created');
  f.setAccount('other'); f.setOffline(false); await worker.tick();
  assert.equal(f.record.state, 'failed'); assert.equal(f.calls.filter(call => call[0] === 'send').length, 0);
});

test('waiting for ordinary in-chat input remains an executing conversation', async () => {
  const f = fixture(), worker = createWorker(f.deps);
  await worker.tick(); f.setStatus('waiting-user'); await worker.tick();
  assert.equal(f.acks.at(-1).state, 'running');
  f.setStatus('streaming'); await worker.tick(); assert.equal(f.acks.at(-1).state, 'running');
  f.finish({ ok: true }); await Promise.resolve(); await worker.tick();
  assert.equal(f.acks.at(-1).state, 'succeeded');
});

test('lost completion receipt retries only the receipt, including after worker restart', async () => {
  const f = fixture(), worker = createWorker(f.deps);
  await worker.tick(); f.setOffline(true); f.finish({ ok: true }); await Promise.resolve();
  await worker.tick(); assert.equal(f.record.state, 'succeeded');
  f.setOffline(false); await createWorker(f.deps).tick();
  assert.equal(f.acks.at(-1).state, 'succeeded'); assert.equal(f.calls.length, 2);
});

test('losing the running receipt never drops an accepted turn completion', async () => {
  const f = fixture(), request = f.deps.request;
  f.deps.request = async (identity, route, body) => {
    if (body?.state === 'running') throw Error('running receipt disconnected');
    return request(identity, route, body);
  };
  const worker = createWorker(f.deps);
  await worker.tick();
  f.finish({ ok: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.record.state, 'succeeded');
  assert.equal(f.acks.at(-1).state, 'succeeded');
  await worker.tick();
  assert.equal(f.calls.filter(call => call[0] === 'send').length, 1);
});

test('completion is durable while a slow running receipt remains in flight', async () => {
  const f = fixture(), request = f.deps.request;
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  f.deps.request = async (identity, route, body) => {
    if (body?.state === 'running') { entered(); await blocked; }
    return request(identity, route, body);
  };
  const worker = createWorker(f.deps), ticking = worker.tick();
  await ready;
  f.finish({ ok: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.record.state, 'succeeded');
  release(); await ticking;
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.acks.map(item => item.state), ['starting', 'running', 'succeeded']);
});

test('connection failure before send preserves created chat and resumes it once', async () => {
  const f = fixture(), worker = createWorker(f.deps); f.setOffline(true);
  await worker.tick(); assert.equal(f.record.phase, 'created'); assert.equal(f.calls.length, 1);
  f.setOffline(false); await worker.tick();
  assert.equal(f.calls[1][1].chatId, 'chat-1'); assert.equal(f.calls.filter(c => c[0] === 'send').length, 1);
});

test('ambiguous process crash never resends tool side effects', async () => {
  const f = fixture(); await createWorker(f.deps).tick();
  await createWorker(f.deps).tick();
  assert.equal(f.calls.length, 2); assert.equal(f.record.state, 'failed');
  assert.equal(f.acks.at(-1).conversationId, 'chat-1'); assert.match(f.record.error, /避免重复/);
  assert.match(f.record.error, /在最近聊天中查看原会话/);
  assert.doesNotMatch(f.record.error, /请打开|后重试/);
});

test('interrupted legacy records without a conversation do not invent a chat link', async () => {
  const f = fixture();
  f.journal.write(keyOf(f.identity, f.input.runId), { phase: 'sending', state: 'running' });
  await createWorker(f.deps).tick();
  assert.match(f.record.error, /检查客户端状态/);
  assert.doesNotMatch(f.record.error, /原会话|对话|最近聊天/);
  assert.equal(f.calls.length, 0);
});

test('a resolved pause requires attention without being overwritten as a crashed execution', async () => {
  for (const result of [{ ok: true, paused: true }, { ok: true, recovering: true }]) {
    const f = fixture(), worker = createWorker(f.deps);
    await worker.tick(); f.finish(result); await Promise.resolve(); await worker.tick();
    assert.equal(f.record.state, 'failed');
    assert.match(f.record.error, /已暂停/);
    assert.match(f.record.error, /最近聊天.*不会自动重发/);
    assert.doesNotMatch(f.record.error, /重试|请打开/);
    await worker.tick();
    assert.match(f.acks.at(-1).error, /已暂停/);
    assert.equal(f.calls.filter(call => call[0] === 'send').length, 1);
  }
});

test('failed or cancelled turns are not reported as completed', async () => {
  for (const [result, detail] of [[{ ok: false }, /未完成/], [{ ok: true, cancelled: true }, /已停止/]]) {
    const f = fixture(), worker = createWorker(f.deps); await worker.tick();
    f.finish(result); await Promise.resolve(); await worker.tick();
    assert.equal(f.acks.at(-1).state, 'failed');
    assert.match(f.acks.at(-1).error, detail);
    assert.match(f.acks.at(-1).error, /最近聊天.*原会话/);
    assert.doesNotMatch(f.acks.at(-1).error, /请打开|重试/);
  }
});

test('send refusal and completion rejection direct users to the saved chat without replay', async () => {
  for (const rejectedBeforeAcceptance of [true, false]) {
    const f = fixture();
    if (rejectedBeforeAcceptance) f.deps.conversation.send = async () => ({ ok: false });
    const worker = createWorker(f.deps); await worker.tick();
    if (!rejectedBeforeAcceptance) {
      f.reject(Error('execution lost'));
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.match(f.record.error, /最近聊天.*原会话/);
    assert.doesNotMatch(f.record.error, /请打开|重试/);
    await worker.tick();
    assert.equal(f.calls.filter(call => call[0] === 'send').length, rejectedBeforeAcceptance ? 0 : 1);
  }
});

test('terminal conversation results acknowledge the run without waiting for another worker tick', async () => {
  const f = fixture();
  await createWorker(f.deps).tick();
  f.finish({ ok: false });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.acks.at(-1).state, 'failed');
  assert.equal(f.record.state, 'failed');
});

test('authentication failure backs off inbox polling and resumes after identity changes', async () => {
  const f = fixture();
  let calls = 0, notices = 0, current = f.identity;
  f.deps.request = async () => {
    calls++;
    throw Object.assign(new Error('expired'), { status: 401, authRequired: true });
  };
  f.deps.identityOf = async () => current;
  const worker = createWorker({ ...f.deps, onError: () => { notices++; } });
  await worker.tick(); await worker.tick();
  assert.equal(calls, 1);
  assert.equal(notices, 1);
  current = { ...f.identity, clientId: 'new-device' };
  await worker.tick();
  assert.equal(calls, 2);
  assert.equal(notices, 2);
});

test('polling distinguishes empty inbox, active work and transient inbox or receipt failures', async () => {
  const f = fixture();
  const scope = 'http://example.invalid\ndevice';
  const originalRequest = f.deps.request;
  let mode = 'idle';
  f.deps.request = async (...args) => {
    if (args[1].endsWith('/inbox')) {
      if (mode === 'offline') throw Object.assign(Error('unavailable'), { status: 503 });
      if (mode === 'idle') return { items: [] };
    }
    return originalRequest(...args);
  };
  const worker = createWorker(f.deps);
  assert.deepEqual(await worker.tick(), { state: 'idle', scope });
  mode = 'offline';
  assert.deepEqual(await worker.tick(), { state: 'error', scope });
  mode = 'running';
  assert.deepEqual(await worker.tick(), { state: 'active', scope });
  f.setOffline(true);
  assert.deepEqual(await worker.tick(), { state: 'error', scope });
  f.setOffline(false);
  assert.deepEqual(await worker.tick(), { state: 'active', scope });
  assert.equal(f.calls.filter(call => call[0] === 'send').length, 1);
  mode = 'idle';
  assert.deepEqual(await worker.tick(), { state: 'active', scope }, 'an accepted local turn remains active');
  f.finish({ ok: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(await worker.tick(), { state: 'idle', scope });
});

test('same-device account switches fence a prepared automation before native send', async () => {
  const f = fixture();
  const token = uid => Buffer.from(JSON.stringify({ typ: 'device', cid: 'device', uid, ver: 1 })).toString('base64url') + '.test';
  let current = { ...f.identity, session: token('alice') };
  f.deps.identityOf = async () => current;
  f.deps.conversation.open = async () => {
    current = { ...current, session: token('bob') };
    return { ok: true, sessionId: 'chat-1', ref: 'ref-1' };
  };
  const worker = createWorker(f.deps);
  await worker.tick();
  assert.equal(f.calls.filter(call => call[0] === 'send').length, 0);
  assert.equal(f.record.state, 'failed');
  worker.stop();
});

for (const failedRoute of ['inbox', 'claim', 'state']) {
  test('authentication failure in ' + failedRoute + ' preserves a full minute of polling suppression', async () => {
    const f = fixture(), originalRequest = f.deps.request;
    let time = 1000, requests = 0;
    f.deps.request = async (...args) => {
      requests++;
      if (args[1].endsWith('/' + failedRoute)) throw Object.assign(Error('expired'), { status: 401 });
      return originalRequest(...args);
    };
    const worker = createWorker({ ...f.deps, now: () => time });
    assert.equal((await worker.tick()).retryAfterMs, 60_000);
    const blockedRequests = requests;
    time += 59_000;
    assert.equal((await worker.tick()).retryAfterMs, 1000);
    assert.equal(requests, blockedRequests);
    time += 1000;
    assert.equal((await worker.tick()).state, 'blocked');
    assert.ok(requests > blockedRequests);
  });
}

test('worker coalesces slow inbox calls and never starts execution after shutdown', async () => {
  const f = fixture();
  let release, requests = 0;
  f.deps.request = () => { requests++; return new Promise(resolve => { release = resolve; }); };
  const worker = createWorker(f.deps);
  const running = worker.tick();
  await Promise.resolve();
  await worker.tick();
  assert.equal(requests, 1);
  worker.stop();
  release({ items: [{ id: f.input.runId }] });
  await running;
  await worker.tick();
  assert.equal(requests, 1);
  assert.equal(f.calls.length, 0);
});

test('same occurrence on another owner or Hub uses a separate idempotency key', () => {
  const id = { hub: 'http://a', clientId: 'one' };
  assert.equal(keyOf(id, 'r'), keyOf({ ...id, hub: 'http://a/' }, 'r'));
  assert.notEqual(keyOf(id, 'r'), keyOf({ ...id, hub: 'http://b' }, 'r'));
  assert.notEqual(keyOf(id, 'r'), keyOf({ ...id, clientId: 'two' }, 'r'));
});

test('oversized prompts are rejected without truncation or execution', async () => {
  const f = fixture(); f.input.text = 'x'.repeat(50001);
  await createWorker(f.deps).tick(); assert.equal(f.calls.length, 0); assert.match(f.record.error, /未被截断/);
});

test('plugin metadata is resolved locally; missing, disabled and changed pinned versions fail closed', () => {
  const plugin = { key: 'report', pluginId: 'local:one', version: '1.0.0', checksum: 'hash', enabled: true,
    entrypoints: { automation: true } };
  const spec = { key: 'report', versionPolicy: 'pinned', version: '1.0.0', checksum: 'hash' };
  assert.equal(pluginSelection(spec, [plugin]).pluginId, 'local:one');
  assert.throws(() => pluginSelection(spec, []));
  assert.throws(() => pluginSelection(spec, [{ ...plugin, enabled: false }]));
  assert.throws(() => pluginSelection(spec, [{ ...plugin, checksum: 'changed' }]));
  assert.throws(() => pluginSelection(spec, [{ ...plugin, entrypoints: { automation: false } }]));
  assert.equal(pluginSelection({ key: 'report', versionPolicy: 'latest' }, [plugin]).version, '1.0.0');
});

test('durable journal is owner-scoped, contains no prompt and does not ignore corrupt records', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-automation-journal-test-'));
  try {
    const key = 'a'.repeat(64), journal = diskJournal(directory);
    assert.equal(journal.read(key), null);
    journal.write(key, { conversationId: 'chat', phase: 'sending' });
    assert.equal(diskJournal(directory).read(key).phase, 'sending');
    assert.throws(() => journal.write('../outside', {}));
    fs.writeFileSync(path.join(directory, key + '.json'), '{');
    assert.throws(() => journal.read(key));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('run history renders ordinary chat links and does not expose task links', () => {
  const context = { _schRunRows: { s: [
    { state: 'succeeded', conversationId: 'chat', conversationTitle: '<ordinary>', receipt: { executionMode: 'soduwork.automation-conversation/v1' } },
    { state: 'waiting', taskId: 'legacy-task', taskTitle: 'Legacy' },
    { state: 'failed', conversationId: 'chat-failed' },
    { state: 'cancelled', receipt: { conversationId: 'chat-cancelled' } },
    { state: 'starting', conversationId: '   ' },
  ] }, _schRunLoading: {}, _schRunErrors: {}, SCH_RUN_STATE: { succeeded: ['完成', 'done'] }, SCH_RUN_TRIGGER: {},
  _schRunDuration: () => '', _schLocal: () => '', _schmRunProofHtml: () => '',
  esc: value => String(value).replace(/</g, '&lt;').replace(/>/g, '&gt;') };
  vm.createContext(context); vm.runInContext(fs.readFileSync(path.join(__dirname, '../components/panels/panels-schedules-runs.js'), 'utf8'), context);
  const html = context._schRunRowsHtml('s');
  assert.match(html, /data-run-chat="chat"/); assert.doesNotMatch(html, /data-run-chat=""/); assert.match(html, /\u6253\u5f00\u4f1a\u8bdd/);
  assert.equal((html.match(/data-run-chat=/g) || []).length, 1);
  assert.doesNotMatch(html, /data-run-task="legacy-task"/); assert.match(html, /&lt;ordinary&gt;/);
});
