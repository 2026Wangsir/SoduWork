const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('./renderer-source.cjs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'api.js'), 'utf8');

function load(fetchImpl, seed = {}, internal = false) {
  const values = new Map(Object.entries(seed));
  const localStorage = {
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
  };
  const window = { __SODUWORK_TEST_HUB_CONFIG__: { allowSwitch: internal } };
  const context = {
    window, localStorage, fetch: fetchImpl, User: { id: 'u-test' },
    navigator: { platform: 'test' }, console: { log() {}, error() {} },
    AbortController: class { constructor() { this.signal = {}; } abort() {} },
    FormData: class { append() {} }, WebSocket: class {},
    setTimeout: () => 0, clearTimeout() {},
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'api.js' });
  return window.SoduWorkAPI;
}

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, text: async () => body || '' };
}

test('business project lookup distinguishes a successful empty list from HTTP and malformed responses', async () => {
  assert.equal((await load(async()=>response(200,'[]')).getProjects()).length,0);
  for (const status of [403,404,500]) {
    await assert.rejects(()=>load(async()=>response(status,'{"detail":"Projects unavailable"}')).getProjects(),
      error=>error.status===status&&error.message==='Projects unavailable');
  }
  for (const body of ['null','{}','{"projects":[]}','[{"id":7,"name":"Invalid"}]']) {
    await assert.rejects(()=>load(async()=>response(200,body)).getProjects(),/项目列表/);
  }
});

test('activity reads the dedicated authenticated events endpoint and accepts an empty history', async () => {
  const calls = [];
  const api = load(async (url, options) => {calls.push({url, options}); return response(200, '{"events":[]}');});
  assert.equal((await api.getTaskEvents('task/slash')).length, 0);
  assert.match(calls[0].url, /\/tasks\/task%2Fslash\/events$/);
  assert.ok(calls[0].options.headers['X-Soduwork-Device']);
});

test('the existing activity API distinguishes read failure from an empty history', async () => {
  for (const status of [403, 404, 500]) {
    const api = load(async () => response(status, '{"detail":"Unavailable"}'));
    assert.equal(await api.getTaskEvents('task'), null);
  }
  assert.equal(await load(async () => {throw Error('Network unavailable');}).getTaskEvents('task'), null);
});

test('execution claim uses the authenticated task endpoint and returns fresh ownership', async () => {
  const requests = [];
  const api = load(async (url, options) => {
    requests.push({url,options});
    return response(200, JSON.stringify({id:'task/slash',status:'todo',readOnly:false}));
  });
  assert.equal((await api.prepareRequirementExecution('task/slash')).readOnly,false);
  assert.match(requests[0].url,/\/tasks\/task%2Fslash\/prepare-execution$/);
  assert.equal(requests[0].options.method,'POST');
  assert.deepEqual(JSON.parse(requests[0].options.body),{});
});

test('execution claim surfaces a server conflict without pretending the task is owned', async () => {
  const api = load(async () => response(409, JSON.stringify({detail:'需求已经开始执行'})));
  await assert.rejects(() => api.prepareRequirementExecution('task'),
    error => error.status === 409 && error.message === '需求已经开始执行');
});

test('业务错误保留后端可读原因和 HTTP 状态', async () => {
  const api = load(async () => response(502, JSON.stringify({ detail: '工程还没有配置 Git 地址' })));
  await assert.rejects(
    () => api.dispatchToAI('t-1', { id: 'local:pi', type: 'agent' }),
    (error) => error.message === '工程还没有配置 Git 地址' && error.status === 502,
  );
  assert.equal(api.online, true);
});

test('结构化派活错误保留重试和诊断字段', async () => {
  const detail = {
    message: '当前没有可接这条任务的在线 Runner', code: 'AI_DISPATCH_FAILED',
    phase: 'routing', phaseName: '选择执行机', retryable: true, attemptId: 'attempt-1',
  };
  const api = load(async () => response(409, JSON.stringify({ detail })));
  await assert.rejects(
    () => api.dispatchToAI('t-structured', { id: 'runner:r1:pi', type: 'agent' }),
    (error) => error.message === detail.message
      && error.status === 409
      && error.code === detail.code
      && error.phase === detail.phase
      && error.phaseName === detail.phaseName
      && error.retryable === true
      && error.attemptId === detail.attemptId,
  );
});

test('字段校验数组整理成人能读懂的一句话', async () => {
  const api = load(async () => response(422, JSON.stringify({
    detail: [{ msg: '任务标题不能为空' }, { msg: '请选择负责人' }],
  })));
  await assert.rejects(() => api.putTask('t-2', {}), {
    message: '任务标题不能为空；请选择负责人', status: 422,
  });
});

test('网络中断不把本地缓存冒充后台任务', async () => {
  const local = [{ id: 't-local', title: '离线任务' }];
  const api = load(async () => { throw new TypeError('network down'); }, {
    soduwork_work_tasks_v5: JSON.stringify(local),
  });
  assert.equal(JSON.stringify(await api.getTasks()), '[]');
  assert.equal(api.online, false);
});

test('任务缓存按 Hub 环境隔离，旧缓存不会冒充实时任务', async () => {
  const local = [{ id: 'legacy-task', title: '旧环境任务' }];
  const first = load(async () => { throw new TypeError('offline'); }, {
    soduwork_work_hub_url: 'HTTP://Hub-A:8989/',
    soduwork_work_tasks_v5: JSON.stringify(local),
  }, true);
  const second = load(async () => { throw new TypeError('offline'); }, {
    soduwork_work_hub_url: 'http://hub-b:8989',
  }, true);
  assert.equal(JSON.stringify(await first.getTasks()), '[]');
  assert.match(first.taskStorageKey('tasks'), /soduwork_work_tasks_v5@http%3A%2F%2Fhub-a%3A8989/);
  assert.notEqual(first.taskStorageKey('tasks'), second.taskStorageKey('tasks'));
  assert.equal(JSON.stringify(await second.getTasks()), '[]');
});

test('fresh and legacy clients always use the fixed production Hub', () => {
  const fresh = load(async () => response(200, '[]'));
  assert.equal(fresh.hubConfig().environment, 'production');
  assert.equal(fresh.hubBase(), 'http://127.0.0.1:18989');
  const fixed = load(async () => response(200, '[]'), {
    soduwork_work_hub_environment_v1: 'development',
    soduwork_work_development_hub_url_v1: 'http://127.0.0.1:9080',
    soduwork_work_hub_url: 'http://untrusted-old-override:9999',
  });
  assert.equal(fixed.hubBase(), 'http://127.0.0.1:18989');
  assert.equal(fixed.hubConfig().editable, false);
});

test('saved custom addresses cannot enable product environment switching', async () => {
  const api = load(async () => response(200, '[]'), { soduwork_work_hub_url: 'http://127.0.0.1:7777/' });
  assert.equal(api.hubBase(), 'http://127.0.0.1:18989');
  assert.throws(() => api.setHubEnvironment('development', 'http://localhost:9080'));
  await assert.rejects(api.connectHub('production', 'https://other.example.com'));
  assert.equal(api.hubBase(), 'http://127.0.0.1:18989');
});

test('定时任务断网向页面交付错误，不伪装成空清单', async () => {
  const api = load(async () => { throw new TypeError('schedule network down'); });
  await assert.rejects(() => api.listSchedules(), /schedule network down/);
  assert.equal(api.online, false);
});
