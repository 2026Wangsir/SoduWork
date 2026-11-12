'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { create } = require('../main/conversation/cloud-handoff');
const catalog = require('../main/agent-runtime/runtime-catalog');
const account = uid => ({ hub: 'https://example.invalid', clientId: 'device', session: Buffer.from(JSON.stringify({
  typ: 'device', uid, cid: 'device', iat: 1, exp: 9999999999 })).toString('base64url') + '.' + 'a'.repeat(64) });
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'soduwork-cloud-start-'));
  const app = { getPath: () => root };
  let current = account('alice'), lost = false, remote = null, starts = 0, sends = 0, status = 'running', statusWait = null;
  const requests = [], views = [];
  const request = async (_identity, route, options = {}) => {
    requests.push(route);
    if (route.startsWith('/cloud-conversations/')) {
      const config = JSON.parse(options.body.get('options'));
      const files = options.body.getAll('files');
      if (!remote) {
        starts++; remote = { transferId: route.split('/').at(-1), phase: 'committed', taskId: 'task1', ref: 'run1',
          target: { id: 'runner:remote:' + config.agentId, agentId: config.agentId, name: 'Remote', model: config.model }, config,
          source: { sessionId: config.sessionId, adapterId: config.agentId, entryKind: 'cloud' },
          files: await Promise.all(files.map(async file => ({ name: file.name, text: await file.text() }))) };
      }
      if (lost) { lost = false; throw Error('connection lost after commit'); }
      return remote;
    }
    if (route.includes('/ai-session')) return { ok: true, ref: 'run1', status, last: 2, items: [
      { kind: 'user', seq: 1, text: remote.config.text, attachments: remote.files },
      { kind: 'say', seq: 2, text: 'Cloud result 42' }] };
    if (route.endsWith('/ai-say')) { sends++; return { ok: true }; }
    if (route.endsWith('/ai-status')) { if (statusWait) await statusWait; return { ok: true, status }; }
    if (route.endsWith('/attachments')) return [];
    if (route.startsWith('/conversation-handoffs/')) return remote;
    assert.fail('unexpected request ' + route);
  };
  const controller = () => create({ app, identityOf: async () => current, request,
    workspace: { scan: () => assert.fail('no local scan'), create: () => assert.fail('no workspace upload') } });
  const open = async (cloud, id) => { const view = await cloud.reopen(id, crypto.randomUUID()); views.push(view);
    for (let i = 0; i < 20 && !view.snapshot().messages.some(row => row.role === 'assistant'); i++) await new Promise(r => setTimeout(r, 5)); return view; };
  t.after(async () => {
    views.forEach(view => view?.close());
    // close fences new polling; an already-started atomic receipt write may
    // still be finishing. Allow bounded Windows handle-release retries here.
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return { controller, open, root, requests, starts: () => starts, sends: () => sends, remote: () => remote,
    lose: () => { lost = true; }, switchUser: () => { current = account('bob'); }, finish: () => { status = 'completed'; },
    holdStatus: () => { let release; statusWait = new Promise(resolve => { release = resolve; }); return () => { release(); statusWait = null; }; } };
}
for (const runtime of catalog.runtimes()) test(runtime.id + ': starts in cloud without local execution and reopens exactly once', async t => {
  const f = await fixture(t), cloud = f.controller();
  const input = { requestId: crypto.randomUUID(), agentId: runtime.id, text: 'Calculate 17 + 25', model: runtime.modelMode === 'account' ? '' : 'model1',
    attachments: [{ name: 'input.md', type: 'text/markdown', data: Buffer.from('17 + 25') }] };
  const reply = await cloud.start(input);
  assert.equal(reply.ok, true); assert.equal(reply.handoff.entryKind, 'cloud');
  assert.equal(f.remote().files[0].text, '17 + 25');
  const restarted = f.controller(), view = await f.open(restarted, reply.sessionId);
  assert.equal(view.passiveCloudView, true); assert.equal(view.snapshot().messages.filter(row => row.role === 'user').length, 1);
  assert.equal(view.snapshot().messages[0].attachments[0].name, 'input.md');
  assert.equal(view.snapshot().messages[0].attachments[0].type, 'text/markdown');
  assert.equal(view.snapshot().messages[0].attachments[0].size, Buffer.byteLength('17 + 25'));
  assert.equal(view.snapshot().cloudHandoff.target.agentId, runtime.id);
  assert.equal((await restarted.start(input)).sessionId, reply.sessionId); assert.equal(f.starts(), 1);
  assert.equal((await restarted.send(view, 'Continue', [])).accepted, true); assert.equal(f.sends(), 1);
  const history = await restarted.history(); assert.equal(history.chats[0].id, reply.sessionId);
  assert.equal(history.chats[0].cloud, true);
  assert.equal(history.chats[0].location, 'cloud');
  assert.equal(history.chats[0].locationMode, 'remote');
  assert.equal(history.chats[0].cwd, '', 'remote replay cache must never become a local workspace');
});
test('cloud creation rejects local model references before network or durable writes', async t => {
  const f = await fixture(t), cloud = f.controller();
  for (const model of ['local:private:model', 'image::private::local:private:image']) {
    await assert.rejects(cloud.start({ requestId: crypto.randomUUID(), agentId: 'pi',
      text: 'Private local work', model }), /本地模型只能在本机使用/);
  }
  assert.deepEqual(f.requests, []);
  assert.deepEqual(await fs.readdir(f.root), []);
});
test('retrying an older cloud receipt cannot transmit a stored local model reference', async () => {
  const cloud = require('../main/conversation/cloud-start').create({
    identity: () => assert.fail('local model retry must fail before Hub identity lookup'),
    request: () => assert.fail('local model retry must not reach Hub'),
  });
  await assert.rejects(cloud.retry({ cloudStart: { options: { model: 'local:private:model' } } }), /本地模型只能在本机使用/);
});
test('forget checks the latest execution of a locally started cloud chat', async t => {
  const f = await fixture(t), cloud = f.controller();
  const { sessionId } = await cloud.start({ requestId: crypto.randomUUID(), agentId: 'pi', text: 'hello' });
  await assert.rejects(cloud.forget(sessionId), /仍在执行/);
  f.finish();
  assert.deepEqual(await cloud.forget(sessionId), { ok: true, id: sessionId });
  assert.equal((await f.controller().history()).chats.length, 0);
  assert.ok(f.requests.includes('/tasks/task1/ai-session?since=2147483647'));
});

test('lost acceptance can recover after restart without a new task or changed prompt', async t => {
  const f = await fixture(t), cloud = f.controller(), input = { requestId: crypto.randomUUID(), agentId: 'pi', text: 'Only once' };
  f.lose(); await assert.rejects(cloud.start(input), /connection lost/);
  const restarted = f.controller();
  await assert.rejects(restarted.start({ ...input, text: 'Different' }), /保持原消息/);
  const view = await f.open(restarted, 'cloud-' + input.requestId);
  const result = await restarted.recover(view);
  assert.equal(result.ok, true); assert.equal(f.starts(), 1);
});

test('EXDEV cloud receipts and display snapshots survive a lost reply and restart without duplicate dispatch', async t => {
  const f = await fixture(t), input = { requestId: crypto.randomUUID(), agentId: 'pi', text: 'Only once with EXDEV' };
  const renamed = [];
  t.mock.method(fs, 'rename', async (source, target) => {
    renamed.push(target); throw Object.assign(Error('managed volume'), { code: 'EXDEV' });
  });
  f.lose();
  await assert.rejects(f.controller().start(input), /connection lost/);
  const restarted = f.controller(), result = await restarted.start(input);
  assert.equal(result.ok, true); assert.equal(f.starts(), 1);
  assert.equal((await restarted.history()).chats[0].id, result.sessionId);
  const entries = await fs.readdir(path.join(f.root, 'conversation-handoffs'));
  assert.equal(entries.filter(name => name.endsWith('.view.json')).length, 1);
  assert.equal(entries.filter(name => /^[a-f0-9]{64}\.json$/.test(name)).length, 1);
  assert.equal(entries.some(name => /\.(tmp|bak)$/.test(name)), false);
  assert.ok(renamed.some(name => name.endsWith('.view.json')), 'the display snapshot uses the same verified publication');
});

test('a failed EXDEV receipt copy prevents dispatch and permits a clean retry', async t => {
  const f = await fixture(t), input = { requestId: crypto.randomUUID(), agentId: 'pi', text: 'No partial receipt' };
  const copy = fs.copyFile.bind(fs); let fail = true;
  t.mock.method(fs, 'rename', async () => { throw Object.assign(Error('managed volume'), { code: 'EXDEV' }); });
  t.mock.method(fs, 'copyFile', async (source, target, ...args) => {
    if (fail && /^[a-f0-9]{64}\.json$/.test(path.basename(target))) {
      await fs.writeFile(target, '{partial'); throw Object.assign(Error('receipt copy failed'), { code: 'EIO' });
    }
    return copy(source, target, ...args);
  });
  const cloud = f.controller();
  await assert.rejects(cloud.start(input), /receipt copy failed/);
  assert.equal(f.starts(), 0);
  assert.equal((await cloud.history()).chats.length, 0);
  fail = false;
  assert.equal((await cloud.start(input)).ok, true); assert.equal(f.starts(), 1);
});
test('attachments and unsupported local selections cannot be silently dropped', async t => {
  const f = await fixture(t), cloud = f.controller(), base = { requestId: crypto.randomUUID(), agentId: 'pi', text: 'input' };
  await assert.rejects(cloud.start({ ...base, skills: ['local'] }), /本机技能/);
  await assert.rejects(cloud.start({ ...base, attachments: Array.from({ length: 21 }, () => ({})) }), /20/);
  await assert.rejects(cloud.start({ ...base, attachments: [{ name: '../secret', data: Buffer.from('x') }] }), /普通文件/);
  await assert.rejects(cloud.start({ ...base, attachments: [{ name: 'dir', path: f.root }] }), /文件夹/);
  await assert.rejects(cloud.start({ ...base, attachments: [{ name: 'missing', path: path.join(f.root, 'absent') }] }));
  assert.equal(f.starts(), 0);
});
test('cloud history and recovered requests remain scoped to the logged in account', async t => {
  const f = await fixture(t), cloud = f.controller(), input = { requestId: crypto.randomUUID(), agentId: 'pi', text: 'private' };
  const result = await cloud.start(input); f.switchUser();
  assert.equal((await cloud.history()).chats.length, 0);
  await assert.rejects(cloud.start(input), /其他账号/);
  await assert.rejects(cloud.reopen(result.sessionId, 'view'), /其他账号/);
  assert.equal(f.starts(), 1);
});

test('a lost reply retries cached input bytes after the original file is moved', async t => {
  const f = await fixture(t), cloud = f.controller(), source = path.join(f.root, 'input.md');
  await fs.writeFile(source, 'saved bytes');
  const input = { requestId: crypto.randomUUID(), agentId: 'pi', text: 'retry', attachments: [{ name: 'input.md', path: source }] };
  f.lose(); await assert.rejects(cloud.start(input), /connection lost/); await fs.unlink(source);
  assert.equal((await f.controller().start(input)).ok, true);
  assert.equal(f.remote().files[0].text, 'saved bytes'); assert.equal(f.starts(), 1);
});

test('a malformed receipt does not hide other history and remains fenced against replay', async t => {
  const f = await fixture(t), cloud = f.controller(), input = { requestId: crypto.randomUUID(), agentId: 'pi', text: 'retained' };
  const result = await cloud.start(input);
  const id = 'cloud-damaged', name = crypto.createHash('sha256').update(id).digest('hex') + '.json';
  await fs.writeFile(path.join(f.root, 'conversation-handoffs', name), '{bad');
  assert.equal((await cloud.history()).chats[0].id, result.sessionId);
  await assert.rejects(f.controller().reopen(id, 'bad'), /无法读取/);
});

test('incomplete accepted receipts cannot become apparently usable sessions', async t => {
  const f = await fixture(t), cloud = f.controller(), input = { requestId: crypto.randomUUID(), agentId: 'pi', text: 'verify receipt' };
  f.lose(); await assert.rejects(cloud.start(input));
  f.remote().ref = '';
  await assert.rejects(cloud.start(input), /回执不完整/);
  assert.equal((await cloud.history()).chats[0].state, 'waiting');
});

test('a followup arriving during artifact collection wakes the stream immediately instead of waiting for the idle timer', async t => {
  const f = await fixture(t), cloud = f.controller();
  const result = await cloud.start({ requestId: crypto.randomUUID(), agentId: 'pi', text: 'first' });
  f.finish(); const release = f.holdStatus();
  const view = await f.open(cloud, result.sessionId);
  assert.equal(view.snapshot().deliveryPending,true,'completed transcript still waits for attachment collection');
  assert.equal((await cloud.send(view, 'next', [])).ok, true);
  const before = f.requests.filter(route => route.includes('/ai-session?')).length;
  release();
  for (let i = 0; i < 40 && f.requests.filter(route => route.includes('/ai-session?')).length === before; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(f.requests.filter(route => route.includes('/ai-session?')).length > before);
  for(let i=0;i<40&&view.snapshot().deliveryPending;i++)await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(view.snapshot().deliveryPending,false,'completed collection releases the new result');
});
