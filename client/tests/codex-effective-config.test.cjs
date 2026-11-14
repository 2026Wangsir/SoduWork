'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { createInterface } = require('node:readline');
const { pathToFileURL } = require('node:url');
const { createRunnerRuntimeAdapter, getRunnerSessionDetails } = require('../main/agent-runtime/runner-adapter');
const native = require('../main/agent-runtime/native-model-catalog');
const catalog = require('../main/agent-runtime/runtime-catalog');
const { install } = require('../main/pi-session/runtime-selection-ipc');

// Only the vendor executable is synthetic. Selection IPC, queue admission,
// Runner dispatch/comment, command/env construction, spool and ACP are real.
const peerSource = String.raw`
import json, os, sys, time, uuid
from pathlib import Path
def emit(value):
    print(json.dumps(value), flush=True)
def observe(text, sid, config):
    row = dict(config, text=text, sid=sid, argv=sys.argv[2:], pid=os.getpid())
    with Path(os.environ['FIXTURE_LAUNCHES']).open('a', encoding='utf-8') as out:
        out.write(json.dumps(row) + '\n')
    if 'HOLD_CURRENT' in text:
        while not Path(os.environ['FIXTURE_RELEASE']).exists():
            time.sleep(.02)
if sys.argv[1] == 'native':
    args = sys.argv[2:]
    sid = args[args.index('resume') + 1] if 'resume' in args else str(uuid.uuid4())
    model = args[args.index('-m') + 1] if '-m' in args else ''
    effort = next((json.loads(v.split('=', 1)[1]) for v in args if v.startswith('model_reasoning_effort=')), '')
    text = sys.stdin.read()
    emit({'type':'thread.started', 'thread_id':sid})
    observe(text, sid, {'model':model, 'effort':effort, 'transport':'native'})
    emit({'type':'item.completed', 'item':{'type':'agent_message', 'text':'Synthetic native reply'}})
    emit({'type':'turn.completed', 'usage':{'input_tokens':20, 'output_tokens':5}})
else:
    sid = ''
    for raw in sys.stdin:
        message = json.loads(raw)
        method, params = message.get('method'), message.get('params') or {}
        if method == 'initialize':
            result = {'protocolVersion':1, 'agentCapabilities':{'loadSession':True, 'sessionCapabilities':{'resume':{}}}}
        elif method == 'session/new':
            sid = str(uuid.uuid4())
            result = {'sessionId':sid, 'modes':{'availableModes':[{'id':value} for value in ['read-only','agent','agent-full-access']]}}
        elif method in ('session/load', 'session/resume'):
            sid = params['sessionId']
            result = {'modes':{'availableModes':[{'id':value} for value in ['read-only','agent','agent-full-access']]}}
        elif method == 'session/set_mode':
            result = {}
        elif method == 'session/prompt':
            config = json.loads(os.environ['CODEX_CONFIG'])
            text = '\n'.join(item.get('text', '') for item in params['prompt'])
            observe(text, sid, {'model':config.get('model',''), 'effort':config.get('model_reasoning_effort',''), 'transport':'acp', 'config':config})
            emit({'jsonrpc':'2.0', 'method':'session/update', 'params':{'sessionId':sid,
                'update':{'sessionUpdate':'agent_message_chunk', 'content':{'type':'text', 'text':'Synthetic ACP reply'}}}})
            result = {'stopReason':'end_turn'}
        elif method and method.startswith('notifications/'):
            continue
        else:
            raise AssertionError(method)
        if 'id' in message:
            emit({'jsonrpc':'2.0', 'id':message['id'], 'result':result})
`;

const runnerSource = String.raw`
import asyncio, json, os, sys
from pathlib import Path
backend, root, peer = map(Path, sys.argv[1:])
sys.path.insert(0, str(backend))
os.environ.update(SODUWORK_DATA_ROOT=str(root/'data'), CODEX_HOME=str(root/'empty-auth'),
    DATABASE_URL='sqlite+aiosqlite:///:memory:', SODUWORK_LOCAL_STALL_RETRIES='0',
    FIXTURE_LAUNCHES=str(root/'launches.jsonl'), FIXTURE_RELEASE=str(root/'release'),
    PYTHONIOENCODING='utf-8', PYTHONUTF8='1')
for key in ('OPENAI_API_KEY','CODEX_API_KEY','CODEX_ACCESS_TOKEN','DEFAULT_AUTH_REQUEST','CODEX_CONFIG'):
    os.environ.pop(key, None)
from app.services import local_base, local_process, codex_account_acp
import runner_main
local_base._PROFILES['codex']['bin'] = lambda: sys.executable
local_base._codex_bin = lambda: sys.executable
codex_account_acp.adapter_bin = lambda: sys.executable
codex_account_acp.runtime_issue = lambda: ''
original_argv = local_process._command_argv
def argv(exe, args, ws, cfg, prof):
    actual = original_argv(exe, args, ws, cfg, prof)
    if '--' in actual:
        boundary = actual.index('--')
        return [*actual[:boundary + 1], sys.executable, str(peer), 'acp']
    return [sys.executable, str(peer), 'native', *actual[1:]]
local_process._command_argv = argv
async def main():
    work = root/'workspace'
    work.mkdir()
    machine = runner_main.Runner('http://127.0.0.1:1','fixture','fixture','fixture',str(work))
    machine._resource_budget.sampler = lambda: {'cpuCount':8,'cpuPercent':0,
        'memoryTotalBytes':16*1024**3,'memoryAvailableBytes':12*1024**3}
    pending = set()
    async def request(value):
        try:
            if value['op'] == 'runtime.detect':
                result = {'ok':True,'data':{'accessControl':{'schema':'soduwork.access-policy/v1',
                    'supported':True,'modes':['standard','readonly','full'],'canChangeDuringSession':True}}}
            else:
                result = await machine._job(value)
            print(json.dumps({'id':value['id'],'result':result}), flush=True)
        except Exception as exc:
            print(json.dumps({'id':value['id'],'failure':repr(exc)}), flush=True)
    print(json.dumps({'ready':True}), flush=True)
    while raw := await asyncio.to_thread(sys.stdin.readline):
        task = asyncio.create_task(request(json.loads(raw)))
        pending.add(task)
        task.add_done_callback(pending.discard)
    await asyncio.gather(*pending)
asyncio.run(main())
`;

const models = [
  { id: 'native-a', label: 'Native A', reasoningLevels: ['low', 'medium', 'high', 'xhigh'], defaultReasoning: 'medium' },
  { id: 'native-b', label: 'Native B', reasoningLevels: ['low', 'high'], defaultReasoning: 'high' },
];
const until = async check => {
  for (let n = 0; n < 700; n++) { const value = check(); if (value) return value; await new Promise(r => setTimeout(r, 20)); }
  throw Error('Synthetic native launch did not settle');
};

async function fixture(t, transport) {
  t.mock.method(native, 'list', () => ({ ok: true, models }));
  const backend = path.resolve(__dirname, '../../hub-backend');
  const python = process.env.SODUWORK_TEST_PYTHON || path.join(backend, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  assert.ok(fs.existsSync(python), 'Set SODUWORK_TEST_PYTHON to the backend virtualenv interpreter');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-effective-codex-'));
  const peer = path.join(root, 'peer.py'), controller = path.join(root, 'runner.py');
  fs.writeFileSync(peer, peerSource); fs.writeFileSync(controller, runnerSource);
  const child = spawn(python, ['-u', controller, backend, root, peer], { windowsHide: true,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } });
  const closed = new Promise(resolve => child.once('close', resolve));
  const pending = new Map(), calls = [], replies = [];
  let serial = 0, ready = false, errors = '';
  child.stderr.on('data', data => { errors += data; });
  createInterface({ input: child.stdout }).on('line', line => {
    let row; try { row = JSON.parse(line); } catch { errors += line + '\n'; return; }
    if (row.ready) { ready = true; return; }
    replies.push(row);
    const request = pending.get(row.id); pending.delete(row.id);
    if (request) row.failure ? request.reject(Error(row.failure)) : request.resolve(row.result);
  });
  child.on('exit', code => { for (const request of pending.values()) request.reject(Error('Runner exited ' + code + ': ' + errors)); pending.clear(); });
  const runtime = { rpc(op, input) {
    calls.push({ op, input });
    return new Promise((resolve, reject) => {
      const id = ++serial; pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ id, op, ...input }) + '\n');
    });
  } };
  const sessions = [];
  t.after(async () => {
    fs.writeFileSync(path.join(root, 'release'), 'release');
    for (const session of sessions) await session.dispose();
    child.stdin.end();
    await Promise.race([closed, new Promise(r => setTimeout(r, 2000))]);
    if (child.exitCode === null) {
      // Windows venv Python is a launcher: terminate the fixture's complete tree.
      if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'],
        { windowsHide: true, stdio: 'ignore', timeout: 10000 });
      else child.kill();
    }
    await Promise.race([closed, new Promise((_, reject) => {
      const timer = setTimeout(() => reject(Error('Fixture Runner did not close')), 10000);
      timer.unref();
    })]);
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  try { await until(() => ready); } catch (error) { throw Error(error.message + ': ' + errors); }
  const app = { getPath: () => path.join(root, 'profile') };
  const adapter = createRunnerRuntimeAdapter({ app, runtimeSpec: catalog.runtime('codex'), runnerRuntime: runtime });
  let session, handle;
  const open = async resume => {
    const work = path.join(root, 'workspace');
    session = await adapter[resume ? 'resumeSession' : 'createSession']({ native: { runner: { openOptions: {
      app, ref: 'effective-config-' + transport, cwd: work,
      ...(resume ? { resumePath: handle.sessionId } : { modelName: 'native-a', reasoningEffort: 'medium' }),
      ...(transport === 'acp' ? { accessPolicy: { schema: 'soduwork.access-policy/v1', mode: 'standard', revision: 1, workspaceRoot: work } } : {}),
    } } } });
    handle = getRunnerSessionDetails(session).handle; sessions.push(session);
    return session;
  };
  await open(false);
  const handlers = new Map(), now = Math.floor(Date.now() / 1000);
  const identity = { hub: 'http://fixture.invalid', clientId: 'fixture', session:
    Buffer.from(JSON.stringify({ typ: 'device', uid: 'fixture', cid: 'fixture', iat: now - 1, exp: now + 3600 })).toString('base64url') + '.' + 'a'.repeat(64) };
  const frame = {}, event = { senderFrame: frame, sender: { mainFrame: frame, isDestroyed: () => false,
    getURL: () => pathToFileURL(path.resolve(__dirname, '../desk.html')).href } };
  install({ app, ipcMain: { handle: (name, action) => handlers.set(name, action) },
    session: { get: () => handle }, identityOf: async () => identity,
    memories: { assertOwner() {} }, cloud: { guard: () => false }, publish() {} });
  return { root, calls, open, diagnostic: () => JSON.stringify({ errors, replies: replies.slice(-2).map(row => ({
    id: row.id, ok: row.result?.ok, status: row.result?.data?.status,
    error: row.failure || row.result?.error || row.result?.data?.error,
  })) }), get session() { return session; }, get handle() { return handle; },
    selectModel: name => handlers.get('pi-session-select-model')(event, handle.sessionId, name),
    setEffort: level => handlers.get('pi-session-set-thinking')(event, handle.sessionId, level),
    release: () => fs.writeFileSync(path.join(root, 'release'), 'release'),
    launches: () => { try { return fs.readFileSync(path.join(root, 'launches.jsonl'), 'utf8').trim().split('\n').map(JSON.parse); } catch { return []; } },
  };
}

for (const transport of ['native', 'acp']) test('Codex ' + transport + ' launches acknowledged and queued model/effort choices, then restores them on reopen', { timeout: 90000 }, async t => {
  const f = await fixture(t, transport);
  const first = f.session.send({ text: 'HOLD_CURRENT' });
  try { await until(() => f.launches().length === 1); }
  catch (error) { throw Error(error.message + ': ' + f.diagnostic()); }
  assert.equal((await f.setEffort('high')).ok, true);
  const second = f.session.send({ text: 'SAME_MODEL_HIGH' });
  assert.equal((await f.selectModel('native-b')).ok, true);
  assert.equal((await f.setEffort('low')).ok, true);
  const third = f.session.send({ text: 'CHANGED_MODEL_LOW' });
  assert.equal((await f.setEffort('high')).ok, true);
  assert.equal(f.launches().length, 1, 'editing future choices must not launch or interrupt the current turn');
  f.release();
  for (const turn of [first, second, third]) {
    const result = await turn.completion;
    assert.equal(result.ok, true, JSON.stringify(result));
  }
  assert.deepEqual(f.launches().map(({ model, effort, transport: kind }) => [model, effort, kind]),
    [['native-a', 'medium', transport], ['native-a', 'high', transport], ['native-b', 'low', transport]]);
  assert.deepEqual(f.calls.filter(row => row.op === 'job.comment').map(row => row.input.executionSelection), [
    { agentId: 'codex', modelName: 'native-a', reasoningEffort: 'high' },
    { agentId: 'codex', modelName: 'native-b', reasoningEffort: 'low' },
  ]);
  assert.equal(f.session.snapshot().thinking.level, 'high', 'draining an earlier queued choice cannot replace the latest picker preference');
  await f.session.dispose();
  await f.open(true);
  assert.equal(f.session.snapshot().modelSelection.name, 'native-b');
  assert.equal(f.session.snapshot().thinking.level, 'high');
  assert.equal((await f.session.send({ text: 'RESTORED_HIGH' }).completion).ok, true);
  const restored = f.launches().at(-1);
  assert.equal(restored.model, 'native-b'); assert.equal(restored.effort, 'high');
  if (transport === 'acp') assert.equal(restored.config.disable_response_storage, true);
});

test('an explicit task model and effort reach the native process together without changing the conversation preference', { timeout: 60000 }, async t => {
  const f = await fixture(t, 'native');
  const result = await f.session.send({ text: 'TASK_MODEL_OVERRIDE', options: {
    taskId: 'isolated-task', modelName: 'native-b', reasoningEffort: 'low',
  } }).completion;
  assert.equal(result.ok, true, JSON.stringify(result));
  const launch = f.launches().at(-1);
  assert.equal(launch.model, 'native-b');
  assert.equal(launch.effort, 'low', 'a task override must not inherit a different conversation model effort');
  assert.equal(f.session.snapshot().modelSelection.name, 'native-a');
  assert.equal(f.session.snapshot().thinking.level, 'medium');
});

function controlsFixture(api, initial = {}, settings = {}) {
  const node = () => ({ hidden: true, dataset: {}, style: {}, handlers: new Map(),
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener(type, callback) { this.handlers.set(type, callback); },
    setAttribute() {}, removeAttribute() {}, focus() {}, querySelector: () => null,
    getBoundingClientRect: () => ({ left: 300, right: 450, top: 500 }) });
  const queue = node(), pop = node(), button = node(), label = node(), wrap = node(), el = node();
  const field = node(); pop.querySelector = () => field;
  button.querySelector = () => label;
  wrap.querySelector = selector => selector === 'button' ? button : selector === '.nmodel-pop' ? pop : null;
  el.querySelector = selector => selector === '#nchatQueue' ? queue : selector === '#nchatModel' ? wrap : null;
  const state = { ref: 'fixture-chat', adapterId: 'codex', ...initial }, notices = [];
  const window = { ...node(), innerWidth: 1000, innerHeight: 800, soduWorkAPI: { conversationSession: api } };
  if (settings.myModels) window.SoduWorkAPI = { myModels: settings.myModels };
  if (settings.native) window.ComposeModelPicker = { nativeEffort: {
    levels: model => model?.reasoningLevels || [], defaultLevel: model => model?.defaultReasoning || '',
    html: () => '', paint() {},
  } };
  if (settings.runtimeWait) window.ChatRuntimePicker = { create: () => ({
    render() {}, wait: settings.runtimeWait, reset() {}, destroy() {},
  }) };
  require('node:vm').runInNewContext(fs.readFileSync(path.resolve(__dirname, '../components/panels/chat-composer-controls.js'), 'utf8'),
    { window, document: node(), AbortController });
  const controls = window.ChatComposerControls.create(el, { state: () => state, say: value => notices.push(value),
    modelSelected: selection => { state.selection = selection; }, thinkingChanged: thinking => { state.thinking = thinking; } });
  controls.render();
  return { state, notices, controls,
    open: () => button.handlers.get('click')(),
    effort(index) { pop.handlers.get('input')({ target: { value: String(index), matches: selector => selector === '[data-effort-slider]' } }); },
    choose(name) { return pop.handlers.get('click')({ stopPropagation() {}, target: {
      closest: selector => selector === '[data-model-name]' ? { dataset: { modelName: name } } : null,
    } }); },
  };
}

test('Send waits for a delayed model click and launches the model acknowledged through production IPC', { timeout: 60000 }, async t => {
  const f = await fixture(t, 'native');
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const ui = controlsFixture({ selectModel: async (_ref, name) => { await gate; return f.selectModel(name); } },
    { ref: f.handle.sessionId, selection: f.session.snapshot().modelSelection });
  t.after(() => ui.controls.destroy());
  const choosing = ui.choose('native-b');
  let readyBeforeAck = false;
  const sending = ui.controls.waitForAccess().then(ready => {
    readyBeforeAck = true;
    return ready ? f.session.send({ text: 'SEND_AFTER_MODEL_CLICK' }).completion : { ok: false };
  });
  await new Promise(resolve => setImmediate(resolve));
  const prematurelyReady = readyBeforeAck;
  release(); await choosing;
  const result = await sending;
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(prematurelyReady, false, 'Send must remain pending until the model choice is acknowledged');
  assert.equal(f.launches().at(-1).model, 'native-b', 'the downstream native process must receive the clicked model');
});

test('a rejected model click keeps Send closed instead of silently using the previous model', async t => {
  let release;
  const ui = controlsFixture({ selectModel: () => new Promise(resolve => { release = resolve; }) });
  t.after(() => ui.controls.destroy());
  const choosing = ui.choose('native-b'), ready = ui.controls.waitForAccess();
  release({ ok: false, reason: 'Model is unavailable' });
  await choosing;
  assert.equal(await ready, false);
  assert.deepEqual(ui.notices, ['Model is unavailable']);
});

test('an effort rejection during an earlier runtime wait prevents Send from silently using the previous effort', async t => {
  let releaseEffort, releaseRuntime;
  const runtime = new Promise(resolve => { releaseRuntime = resolve; });
  const ui = controlsFixture({
    runtimes: async () => ({ ok: true, runtimes: [{ id: 'codex', modelMode: 'account' }] }),
    runtimeModels: async () => ({ ok: true, models }),
    setThinking: () => new Promise(resolve => { releaseEffort = resolve; }),
  }, { selection: { name: 'native-a' }, thinking: { level: 'medium' } }, { native: true, runtimeWait: () => runtime });
  t.after(() => ui.controls.destroy());
  await ui.open();
  ui.effort(2);
  const ready = ui.controls.waitForAccess();
  releaseEffort({ ok: false, reason: 'Effort could not be saved' });
  await new Promise(resolve => setImmediate(resolve));
  releaseRuntime(true);
  assert.equal(await ready, false);
  assert.equal(ui.state.thinking.level, 'medium');
  assert.deepEqual(ui.notices, ['Effort could not be saved']);
});

test('Send can finish waiting for an intentional Agent switch without a stale model or effort request', async t => {
  let release;
  const runtime = new Promise(resolve => { release = resolve; });
  const ui = controlsFixture({ runtimes: async () => ({ ok: true, runtimes: [{ id: 'qwen', modelMode: 'managed' }] }) },
    { selection: { name: 'managed', model: { id: 'managed' } } },
    { runtimeWait: () => runtime, myModels: async () => ({ usable: [{ name: 'managed' }] }) });
  t.after(() => ui.controls.destroy());
  const ready = ui.controls.waitForAccess();
  ui.state.adapterId = 'qwen'; ui.controls.render();
  release(true);
  assert.equal(await ready, true);
});

test('a stale model acknowledgement cannot release or clear the new conversation model request', async t => {
  const releases = new Map();
  const ui = controlsFixture({ selectModel: (ref, name) => new Promise(resolve => { releases.set(ref, () => resolve({ ok: true, selection: { name } })); }) });
  t.after(() => ui.controls.destroy());
  const oldChoice = ui.choose('native-b');
  ui.state.ref = 'another-chat'; ui.controls.render();
  const newChoice = ui.choose('native-a');
  let ready = false;
  const sending = ui.controls.waitForAccess().then(result => { ready = true; return result; });
  releases.get('fixture-chat')(); await oldChoice;
  await new Promise(resolve => setImmediate(resolve));
  const prematurelyReady = ready, hasNewRequest = releases.has('another-chat');
  if (hasNewRequest) releases.get('another-chat')();
  await newChoice;
  assert.equal(await sending, true);
  assert.equal(hasNewRequest, true, 'switching conversation must allow its own model selection');
  assert.equal(prematurelyReady, false, 'an old model acknowledgement must not release Send for the new selection');
  assert.equal(ui.state.selection.name, 'native-a');
  assert.deepEqual(ui.notices, []);
});
