'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('./renderer-source.cjs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const assignment = read('components', 'panels', 'panels-add-assignment.js');
const submitSource = read('components', 'panels', 'panels-compose-submit.js');
const createRequirement = submitSource.slice(submitSource.indexOf('async function createRequirement'), submitSource.indexOf('async function handOff'));

test('创建需求把完成方式、工作流和执行底座分成三个稳定概念', () => {
  const html = read('desk.html');
  const panel = read('components', 'panels', 'panels-add.js');
  const api = read('api.js');

  for (const value of ['manual', 'direct', 'workflow']) {
    assert.ok(html.includes('name="addGoStrategy" value="' + value + '"'));
  }
  for (const id of ['addGoRepo', 'addGoWho', 'addGoMode']) {
    assert.ok(html.includes('id="' + id + '"'));
  }
  assert.ok(!html.includes('id="addGoChk"'));
  assert.ok(api.includes('taskExecutionOptions(body)'));
  assert.ok(api.includes("'/task-execution-options'"));
  assert.ok(!panel.includes("applicableFlows('')"));
  assert.ok(panel.includes('SoduWorkAPI.taskExecutionOptions'));
  assert.ok(panel.includes('clearTimeout(_addGoReloadTimer)'));
  assert.ok(panel.includes('function _goUnavailable()'));
  assert.ok(panel.includes('_addGoPending === safe'));
});

test('workflow and direct execution carry the same repository, inputs and model context', () => {
  const panel = read('components', 'panels', 'panels-add.js');
  const sync = read('core', 'task-sync.js');
  const start = panel.indexOf('startTaskPlugin(tid');
  const pluginStart = panel.slice(start, panel.indexOf('if (typeof petSay', start));

  assert.ok(start >= 0);
  assert.ok(pluginStart.includes('go.plugin.body'));
  assert.ok(pluginStart.includes('bindingId:'));
  assert.ok(pluginStart.includes('repoId:'));
  assert.ok(panel.includes("dispatchToAI(tid, go.who, '', go.repo, go.model || '', go.executionContext || null)"));
  assert.ok(panel.includes("_fwpPayload(document.getElementById('addGoPluginConfig')"));
  assert.ok(panel.includes('projectId: execution.projectId'));
  assert.ok(panel.includes('repoId: (execution.repo && execution.repo.id)'));
  assert.ok(panel.includes('workScenarioKey: execution.workScenarioKey'));
  assert.ok(sync.includes("'projectId', 'repoId'"));
  assert.ok(sync.includes("'workScenarioKey', 'workScenarioName', 'workRouting'"));
});

test('创建只保存内容，执行入口仍统一使用服务端预检合同', () => {
  const html = read('desk.html');
  const add = read('components', 'panels', 'panels-add.js');
  const compose = read('components', 'panels', 'panels-compose-draft.js');
  const forwardOptions = read('components', 'panels', 'panels-forward-options.js');
  const helper = read('components', 'panels', 'task-execution-client.js');
  const indexHtml = read('index.html');
  for (const documentHtml of [html, indexHtml]) {
    assert.ok(documentHtml.includes('components/panels/panels-forward-options.js'));
    assert.ok(documentHtml.indexOf('panels-forward-options.js') < documentHtml.indexOf('panels-forward.js'));
  }
  assert.ok(html.includes('components/panels/task-execution-client.js'));
  assert.ok(html.includes('components/panels/panels-compose-submit.js'));
  assert.ok(html.indexOf('task-execution-client.js') < html.indexOf('panels-compose-draft.js'));
  assert.ok(html.indexOf('panels-compose-submit.js') < html.indexOf('panels-compose-draft.js'));
  for (const id of ['addGoPluginConfig', 'addGoModel']) assert.ok(html.includes('id="' + id + '"'));
  assert.match(add, /SoduWorkAPI\.taskExecutionOptions\(request\)/);
  assert.match(add, /let go = assignee \? null : _addGoPayload\(true\)/);
  assert.ok(add.indexOf('_addGoPayload(true)') < add.indexOf('const newId = _addPendingTask.id'));
  assert.doesNotMatch(compose, /TaskExecutionClient\.load|_preflightExecution/);
  assert.doesNotMatch(compose, /listAIAgents|applicableFlows|listRepos/);
  assert.match(forwardOptions, /SoduWorkAPI\.taskExecutionOptions\(\{ taskId: tid/);
  assert.doesNotMatch(forwardOptions, /listAIAgents|applicableFlows|listRepos/);
  assert.match(helper, /modelPick: item\.modelPick !== false/);
  assert.match(helper, /agent && agent\.modelPick !== false/);
  assert.match(helper, /item\.runnable !== false/);
  const create = createRequirement;
  assert.match(compose, /ComposeDraftSubmit\.createRequirement\(\{ draft, options, state/);
  assert.match(create, /await submit\(state/);
  assert.match(create, /executionContext: null/);
  assert.match(create, /workRouting: \{\}/);
  assert.match(create, /projectId: \(Object\.prototype\.hasOwnProperty\.call\(draft, 'projectId'\) \? draft\.projectId : options\.projectId\) \|\| null/);
  assert.match(create, /repoId: draft\.repo/);
  assert.match(add, /let goWarning = ''/);
  assert.match(add, /if \(goWarning\) \{/);
  assert.match(add, /需求已创建，但 AI 暂未启动/);
  assert.doesNotMatch(compose, /_refreshExecutionOptions/);
  assert.match(add, /TaskExecutionClient\.runnableWorkflow\(definitions, mode\.value\)/);
  assert.match(add, /workScenarioName: execution\.workScenarioName/);
  assert.match(add, /workRouting: execution\.workRouting/);
  assert.doesNotMatch(create, /startTaskPlugin|dispatchToAI/);
  assert.match(add, /request\.execution = Object\.assign/);
  const addCreate = add.slice(add.indexOf('async function _submitAdd'));
  assert.ok(addCreate.indexOf('await _verifyAddPlugin(go)') >= 0);
  assert.ok(addCreate.indexOf('await _verifyAddPlugin(go)') < addCreate.indexOf('const newId = _addPendingTask.id'));
  assert.match(add, /direct:\s*!!availableSubstrates\.length/);
  assert.doesNotMatch(add, /if \(recommendation\.workflowRequired\)/);
  assert.doesNotMatch(forwardOptions, /directSection\.remove/);
  assert.doesNotMatch(forwardOptions, /if \(recommendation\.workflowRequired/);
});

test('chat task handoff uses the selected assignee and rejects false dispatch acknowledgements', () => {
  const api = read('api.js');
  const add = read('components', 'panels', 'panels-add.js');
  const compose = read('components', 'panels', 'panels-compose-draft.js');
  const submit = read('components', 'panels', 'panels-compose-submit.js');
  const forward = read('components', 'panels', 'panels-forward.js');
  const handoff = createRequirement;
  assert.match(compose, /ComposeDraftSubmit\.createRequirement/);

  assert.match(handoff, /A\.createAssignedTask\(/);
  assert.match(handoff, /assigneeUserId: w\.id/);
  assert.match(submit, /const run = await api\.startTaskPlugin/);
  assert.match(submit, /if \(!run \|\| run\.ok === false\)/);
  assert.match(submit, /const result = await api\.handoffTask/);
  assert.match(submit, /需求没有成功转交给同事/);
  assert.match(add, /const result = await SoduWorkAPI\.dispatchToAI/);
  assert.match(forward, /if \(!result \|\| result\.ok === false\)/);
  assert.match(api, /if \(r && r\.ok === false\)/);
  assert.match(api, /需求没有成功转交给同事/);
});

test('chat direct AI handoff reaches the selected substrate without a workflow', async () => {
  const source = read('components', 'panels', 'panels-compose-submit.js');
  let call = null;
  const context = { window: {
    SoduWorkAPI: {
      dispatchToAI: async (...args) => { call = args; return { ok: true, accepted: true }; },
    },
    TaskExecutionClient: { isAvailable: () => true, execution: () => ({}) },
  } };
  vm.runInNewContext(source, context);
  const result = await context.window.ComposeDraftSubmit.handOff({
    id: 'task-direct', brief: '整理这份材料', who: { kind: 'agent', id: 'local:pi' },
    agent: { id: 'local:pi', name: 'Pi', available: true, cliName: 'pi' },
    repo: null, model: '', executionContext: { strategy: 'direct' },
  });
  assert.equal(result.warn, '');
  assert.equal(result.who, 'Pi');
  assert.ok(call);
  assert.equal(call[0], 'task-direct');
  assert.equal(call[1].id, 'local:pi');
  assert.equal(call[1].type, 'agent');
  assert.equal(call[2], '整理这份材料');
});

test('chat task draft does not silently turn a scene recommendation into workflow dispatch', () => {
  const compose = read('components', 'panels', 'panels-compose-draft.js');
  assert.match(compose, /flow: '', flowExplicit: false/);
  assert.doesNotMatch(compose, /if \(!f\.flow\) f\.flow = _sceneDefaultKey\(f\.scene\)/);
  assert.doesNotMatch(compose, /preflightWarning/);
});

test('chat direct AI rejection includes the backend reason and remains retryable', async () => {
  const source = read('components', 'panels', 'panels-compose-submit.js');
  const context = { window: {
    SoduWorkAPI: { dispatchToAI: async () => ({ ok: false, reason: 'Runner is offline' }) },
    TaskExecutionClient: { isAvailable: () => true },
  } };
  vm.runInNewContext(source, context);
  const result = await context.window.ComposeDraftSubmit.handOff({
    id: 'task-rejected', who: { kind: 'agent', id: 'local:pi' },
    agent: { id: 'local:pi', name: 'Pi', available: true },
  });
  assert.equal(result.who, '');
  assert.match(result.warn, /Runner is offline/);
});

test('chat handoff keeps a failed task retryable and only drops local state after success', async () => {
  const source = read('components', 'panels', 'panels-compose-submit.js');
  let dropped = 0;
  const context = { window: { SoduWorkAPI: {
    handoffTask: async () => ({ ok: false, reason: '接收端暂时不可用' }),
  } } };
  vm.runInNewContext(source, context);
  const failed = await context.window.ComposeDraftSubmit.handOff({
    id: 'task-1', who: { kind: 'mate', id: 'user-1' },
    mate: { id: 'user-1', name: '同事甲' }, dropLocal: () => { dropped++; },
  });
  assert.equal(failed.who, '');
  assert.match(failed.warn, /接收端暂时不可用/);
  assert.equal(dropped, 0);

  context.window.SoduWorkAPI.handoffTask = async () => ({ ok: true });
  const succeeded = await context.window.ComposeDraftSubmit.handOff({
    id: 'task-1', who: { kind: 'mate', id: 'user-1' },
    mate: { id: 'user-1', name: '同事甲' }, dropLocal: () => { dropped++; },
  });
  assert.equal(succeeded.who, '同事甲');
  assert.equal(succeeded.warn, '');
  assert.equal(dropped, 1);
});


test('blocked workflow bindings remain explainable but cannot be selected', () => {
  const source = read('components', 'panels', 'task-execution-client.js');
  const context = { window: {} };
  vm.runInNewContext(source, context);
  const api = context.window.TaskExecutionClient;
  const blocked = { bindingId: 'blocked', key: 'project-release', runnable: false,
    readiness: { blockers: ['approval missing'] } };
  const options = {
    workflows: [blocked,
      { bindingId: 'ready', key: 'project-release-v2', runnable: true }],
    blockedWorkflows: [blocked]
  };
  assert.equal(api.workflows(options).length, 1);
  assert.equal(api.blockedWorkflows(options).length, 1);
  assert.equal(api.runnableWorkflow(api.workflows(options), 'blocked'), null);
  assert.equal(api.runnableWorkflow(options.workflows, 'project-release-v2').bindingId, 'ready');
  assert.equal(api.workflowProblem(options, 'blocked'), 'approval missing');
});

test('coworker assignment is atomic for chat and standalone task entry points', () => {
  const api = read('api.js');
  const add = read('components', 'panels', 'panels-add.js');
  const compose = read('components', 'panels', 'panels-compose-draft.js');

  assert.match(api, /async createAssignedTask\(body\)/);
  assert.match(api, /'\/tasks\/assigned'/);
  assert.match(assignment, /SoduWorkAPI\.listTeammates\(\)/);
  assert.match(add, /SoduWorkAPI\.createAssignedTask\(/);
  assert.doesNotMatch(add, /SoduWorkAPI\.createTeamTask\(/);
  assert.match(createRequirement, /A\.createAssignedTask\(/);

  const mateBranch = createRequirement.indexOf("if (w.kind === 'mate')");
  const localCreate = createRequirement.indexOf('tasks.push', mateBranch);
  assert.ok(mateBranch >= 0);
  assert.ok(localCreate > mateBranch);
});

test('chat task owner picker is searchable, refreshable, and rejects stale unavailable choices', () => {
  const compose = read('components', 'panels', 'panels-compose-draft.js');
  const css = read('components', 'workspace', 'workspace-shell.css');
  const api = read('api.js');

  assert.match(compose, /data-selsearch/);
  assert.match(compose, /_renderSelectionRows\('who'\)/);
  assert.match(compose, /async function _reloadMates\(\)/);
  assert.match(compose, /_mateLoadFailed/);
  assert.match(compose, /这个负责人当前不可用，请重新选择/);
  assert.match(compose, /_mateOf\(selectedId\)/);
  assert.doesNotMatch(compose, /_agentOf\(selectedId\)/);
  assert.match(css, /\.cp-selpop-who/);
  assert.match(css, /\.cp-selsearch/);
  assert.doesNotMatch(api, /createWorkItemDelivery/);
});

test('执行底座保存可迁移的 CLI 类型，不把某台机器写死在创建表单', () => {
  const panel = read('components', 'panels', 'panels-add.js');
  assert.ok(panel.includes('substrateKey'));
  assert.ok(panel.includes('自动选择'));
  assert.ok(!panel.includes("id: 'runner:"));
});

test('服务端未确认时不留下幽灵需求，取消会动态调用原生窗关闭包装', () => {
  const panel = read('components', 'panels', 'panels-add.js');
  const compose = read('components', 'panels', 'panels-compose-draft.js');
  const events = read('components', 'panels', 'panels.js');
  assert.match(panel, /if \(!persisted\) \{[\s\S]*Store\.pauseUnconfirmedTask\(newId\)/);
  assert.doesNotMatch(panel, /!persisted && \(!window\.SoduWorkAPI/);
  assert.match(createRequirement, /SoduWork 服务尚未确认创建需求/);
  assert.match(createRequirement, /if \(!state.stored[\s\S]*Store\.pauseUnconfirmedTask\(state.id\)/);
  assert.match(events, /addEventListener\('click', \(\) => window\.closeAdd\(\)\)/);
});

test('dispatch options and execution evidence use the current shared contracts', () => {
  const forwardOptions = read('components', 'panels', 'panels-forward-options.js');
  assert.match(forwardOptions, /taskExecutionOptions\(\{ taskId: tid/);
  assert.match(forwardOptions, /_fwpReady\(flow, _fwdOptions \|\| \{\}\)/);
  assert.doesNotMatch(forwardOptions, /listAIAgents|applicableFlows|listRepos/);
  const trace = read('components', 'panels', 'task-trace-view.js');
  assert.match(trace, /node\.finishedAt \? duration\(node\.startedAt, node\.finishedAt\) : '进行中'/);
});

test('客户端切换 Hub 时需求镜像和待同步队列使用独立命名空间', () => {
  const api = read('api.js');
  const store = read('core', 'store.js');
  const bridge = read('core', 'win-bridge.js');
  assert.match(api, /function taskStorageKey\(kind\)/);
  assert.match(api, /function adoptVerifiedTaskOperations/);
  assert.doesNotMatch(api, /function lsTasks\(/);
  assert.match(store, /_taskStorageKey\('tasks','soduwork_work_tasks_v5'\)/);
  assert.match(store, /_taskStorageKey\('ops','soduwork_work_task_ops_v1'\)/);
  assert.doesNotMatch(bridge, /LS_TASKS|taskStorageKey\('tasks'\)/);
  assert.match(bridge, /Store\.refreshTasks\(\)/);
});

test('task creation does not expose recurring controls', () => {
  const html = read('desk.html');
  const panel = read('components', 'panels', 'panels-add.js');
  const schedules = read('components', 'panels', 'panels-schedules.js');

  assert.doesNotMatch(html, /name="kind"/);
  assert.doesNotMatch(html, /kindPick|routineRow|name="recur2"/);
  assert.doesNotMatch(panel, /input\[name=kind\]|input\[name=recur2\]|kind === 'routine'/);
  assert.match(panel, /const recur = ''/);
  assert.match(panel, /const recurAt = null/);
  assert.match(schedules, /function openSchedulePanel\(options\)/);
  assert.match(schedules, /SCH_EVERY/);
});
test('从起手式创建需求并派活后自动收口到协作会话', () => {
  const compose = read('components', 'panels', 'panels-compose.js');
  assert.match(compose, /function _openCreatedTaskInCollaboration\(taskId, title, accessMode\)/);
  assert.match(compose, /onPersisted: \(id, title, outcome\) => openCreated\(id, title, outcome\)/);
  assert.match(compose, /NativeChat\.hasSession\(\)[\s\S]{0,220}NativeChat\.bindTask\(id, label\)/);
  assert.match(compose, /NativeChat\.openTask\(id, label, \{ source: 'task-create' \}\)/);
  assert.match(compose, /onCreated: \(id, title, outcome\) => \{[\s\S]{0,220}openCreated\(id, title, outcome\)/);
  assert.match(compose, /onOpen: \(id, title, outcome\) => openCreated\(id, title, outcome\)/);
});


test('task creation settles collaboration only after durable submission and checks current draft', () => {
  const draft = createRequirement;
  assert.ok(draft.indexOf('await submit(state') >= 0);
  assert.ok(draft.indexOf('await submit(state') < draft.indexOf('options.onPersisted?.'));
  assert.match(draft, /if \(!current\(\)\) return;[\s\S]*options.onPersisted/);
  assert.match(draft, /result.directlyAssigned && !out.warn/);
});

test('standalone task dispatch distinguishes transfers from local collaboration', () => {
  const add = read('components', 'panels', 'panels-add.js');
  assert.match(add, /_openCreatedTaskInChat\(assigned\.task\.id, assigned\.task\.title \|\| title, \{ \.\.\.assigned\.task, readOnly: true \}\)/);
  assert.match(add, /_goDispatch\(newId, title, go\)\.then\(\(result\) => \{[\s\S]{0,520}_openCreatedTaskInChat\(newId, title\)/);
});
