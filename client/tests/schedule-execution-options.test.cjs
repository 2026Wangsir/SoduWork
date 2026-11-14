const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function context(api, bridge) {
  const ctx = vm.createContext({ SoduWorkAPI: api, window: { addEventListener() {}, soduWorkAPI: bridge },
    esc: value => String(value), Intl, Event, document: { getElementById: () => null } });
  for (const file of ['panels-schedules-methods.js', 'panels-schedules.js', 'panels-schedules-editor.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../components/panels', file), 'utf8'), ctx);
  }
  return ctx;
}
const run = (ctx, code) => vm.runInContext(code, ctx);
const modern = { substrates: [
  { key: 'local:pi', name: 'Pi', available: true, onlineSeats: 2, modelPick: true },
  { key: 'local:codex', name: 'Codex', available: true, modelPick: false, nativeModelPick: true },
], modelOptions: [{ name: 'soduwork-prd-large', label: '生产大模型' }],
  models: [], defaultModel: 'soduwork-prd-large' };

test('all automation openings share stable substrate choices and coalesce pending requests', async () => {
  let resolve, requests = 0, legacy = 0;
  const ctx = context({
    taskExecutionOptions: () => { requests++; return new Promise(r => { resolve = r; }); },
    listAIAgents: async () => { legacy++; return { agents: [] }; },
  });
  const first = run(ctx, '_schLoadExecutionAgents({title:"日报"})');
  const second = run(ctx, '_schLoadExecutionAgents({})');
  resolve(modern);
  assert.deepEqual(Array.from(await first, item => item.id), ['local:pi', 'local:codex']);
  await second;
  assert.equal(requests, 1);
  assert.equal(legacy, 0);
  assert.equal(run(ctx, '_schDefaultAgentId()'), 'local:pi');
  assert.match(run(ctx, '_schAgentOptionsHtml("local:codex")'), /value="local:codex" selected/);
});

test('automation editor expands a substrate into stable remote target choices', async () => {
  const ctx = context({ taskExecutionOptions: async () => ({
    substrates: [{
      key: 'local:pi', cli: 'pi', name: 'Pi', available: true, modelPick: true, nativeModelPick: true,
      locations: [
        { assigneeId: 'local:pi', mode: 'local', label: '本机' },
        { assigneeId: 'runner:desk-1:pi', mode: 'remote', runnerId: 'desk-1',
          clientId: 'desktop-2', label: '工作电脑 · 北京' },
        { assigneeId: 'runner:cloud-1:pi', mode: 'remote', runnerId: 'cloud-1',
          runnerKind: 'cloud', label: '云端 Runner' },
      ],
    }],
  }) });
  const agents = await run(ctx, '_schLoadExecutionAgents({})');
  assert.deepEqual(Array.from(agents, item => item.id), [
    'local:pi', 'runner:desk-1:pi', 'runner:cloud-1:pi',
  ]);
  assert.equal(run(ctx, '_schDefaultAgentId()'), 'local:pi');
  assert.match(run(ctx, '_schAgentOptionsHtml("runner:desk-1:pi")'), /runner:desk-1:pi/);
  assert.match(run(ctx, '_schAgentOptionsHtml("runner:cloud-1:pi")'), /云端 Runner/);
});

test('empty unified result is authoritative and explains offline status', async () => {
  let legacy = 0;
  const ctx = context({ taskExecutionOptions: async () => ({
    substrates: [], availability: { agentReason: '执行机正在重连' },
  }), listAIAgents: async () => { legacy++; return { agents: [{ id: 'stale' }] }; } });
  assert.equal((await run(ctx, '_schLoadExecutionAgents({})')).length, 0);
  assert.equal(legacy, 0);
  assert.match(run(ctx, '_schAgentFieldHtml("")'), /disabled/);
  assert.match(run(ctx, '_schAgentFieldHtml("")'), /执行机正在重连/);
  assert.match(run(ctx, '_schAgentOptionsHtml("local:codex")'), /value="local:codex" selected/);
});

test('old Hub failure falls back to usable legacy agents and later recovers', async () => {
  const api = { taskExecutionOptions: async () => { throw Error('404'); },
    listAIAgents: async () => ({ agents: [{ id: 'off', off: true }, { id: 'legacy', name: 'Pi' }] }) };
  const ctx = context(api);
  assert.equal((await run(ctx, '_schLoadExecutionAgents({})'))[0].id, 'legacy');
  api.taskExecutionOptions = async () => modern;
  assert.equal((await run(ctx, '_schLoadExecutionAgents({})'))[0].id, 'local:pi');
});

test('refreshing executor options preserves an existing choice and updates only the select', async () => {
  const ctx = context({ taskExecutionOptions: async () => modern });
  await run(ctx, '_schLoadExecutionAgents({})');
  let changes = 0;
  const select = { value: 'old-seat', dispatchEvent() { changes++; } };
  const hint = {};
  ctx.document.getElementById = id => ({ schWho: select, schWhoHint: hint })[id] || null;
  run(ctx, '_schRefreshAgentField()');
  assert.match(select.innerHTML, /value="old-seat" selected/);
  assert.match(select.innerHTML, /local:pi/);
  assert.equal(select.disabled, false);
  assert.equal(changes, 1);
});

test('automation editor keeps model selection independent from the chosen Agent', async () => {
  const ctx = context({ taskExecutionOptions: async () => modern }, {
    conversationSession: { runtimeModels: async () => ({ models: [{ id: 'gpt-5-codex', label: 'Codex 默认模型' }] }) },
  });
  await run(ctx, '_schLoadExecutionAgents({})');
  assert.match(run(ctx, '_schModelFieldHtml("", "local:pi")'), /soduwork-prd-large/);
  assert.match(run(ctx, '_schModelFieldHtml("", "local:pi")'), /selected/);
  // Native catalogs load only when that substrate is selected.
  await run(ctx, '_schLoadNativeModelOptions(_schAgents.filter(item => item.id === "local:codex"))');
  assert.match(run(ctx, '_schModelFieldHtml("", "local:codex")'), /gpt-5-codex/);
  assert.doesNotMatch(run(ctx, '_schModelFieldHtml("", "local:codex")'), /soduwork-prd-large/);
  assert.doesNotMatch(run(ctx, '_schModelFieldHtml("", "local:codex")'), /<select[^>]+disabled/);
  assert.equal(run(ctx, '_schAgentAllowsModel("local:codex")'), true);
  assert.equal(run(ctx, '_schAgentAllowsModel("local:pi")'), true);
});

test('local Pi automation merges the saved local model catalog and keeps it off remote seats', async () => {
  const localRef = 'local:model-' + 'b'.repeat(32);
  const ctx = context({ taskExecutionOptions: async () => ({
    substrates: [{
      key: 'local:pi', cli: 'pi', name: 'Pi', available: true, modelPick: true,
      locations: [
        { assigneeId: 'local:pi', mode: 'local', label: 'Local device' },
        { assigneeId: 'runner:desk-1:pi', mode: 'remote', label: 'Runner' },
      ],
    }],
    modelOptions: [{ name: 'managed-model', label: 'Managed' }],
  }) }, {
    conversationSession: { runtimeModels: async () => ({ models: [{ id: 's1', label: 's1' }] }) },
    localModels: { get: async () => ({ usable: [
      { id: localRef, name: localRef, modelName: 'custom-medium', label: 'custom-medium', modality: 'chat', localOnly: true },
      { id: 'local:image', name: 'local:image', modality: 'image', localOnly: true },
    ] }) },
  });
  const agents = await run(ctx, '_schLoadExecutionAgents({})');
  assert.deepEqual(Array.from(agents, item => item.id), ['local:pi', 'runner:desk-1:pi']);
  assert.match(run(ctx, `_schModelFieldHtml("", "local:pi")`), new RegExp(localRef));
  assert.match(run(ctx, '_schModelFieldHtml("", "local:pi")'), /custom-medium/);
  assert.doesNotMatch(run(ctx, `_schModelFieldHtml("", "runner:desk-1:pi")`), new RegExp(localRef));
  assert.doesNotMatch(run(ctx, `_schModelFieldHtml("", "local:pi")`), /local:image/);
});

test('a current-device Runner seat uses the local Pi model catalog and a portable local route', async () => {
  const localRef = 'local:model-' + 'c'.repeat(32);
  let reads = 0;
  const ctx = context({ taskExecutionOptions: async () => ({
    substrates: [{ key: 'local:pi', cli: 'pi', name: 'Pi', available: true, modelPick: true,
      locations: [
        { assigneeId: 'runner:this-device:pi', mode: 'local', label: 'Local device' },
        { assigneeId: 'runner:other-device:pi', mode: 'remote', label: 'Other device' },
      ] }],
    modelOptions: [{ name: 'managed-model', label: 's1' }],
  }) }, { localModels: { get: async () => {
    reads++;
    return { usable: [{ name: localRef, label: 'Local custom model', localOnly: true, modality: 'chat' }] };
  } } });
  await run(ctx, '_schLoadExecutionAgents({})');
  const selected = run(ctx, '_schDefaultAgentId()');
  assert.match(run(ctx, `_schModelFieldHtml("", ${JSON.stringify(selected)})`), /Local custom model/);
  assert.equal(reads, 1);
  assert.equal(selected, 'local:pi', 'local model saves must use the owner-device conversation route');
  assert.doesNotMatch(run(ctx, '_schModelFieldHtml("", "runner:other-device:pi")'), /Local custom model/);
});

test('a new automation loads the default native substrate without loading unrelated catalogs', async () => {
  const queried = [];
  const ctx = context({ taskExecutionOptions: async () => ({ substrates: [
    { key: 'local:qwen', cli: 'qwen', available: false, nativeModelPick: true },
    { key: 'local:codex', cli: 'codex', available: true, nativeModelPick: true },
    { key: 'local:kimi', cli: 'kimi', available: true, nativeModelPick: true },
  ] }) }, { conversationSession: { runtimeModels: async id => {
    queried.push(id); return { models: [{ id: 'native-default' }] };
  } } });
  await run(ctx, '_schLoadExecutionAgents({})');
  assert.deepEqual(queried, ['codex']);
  assert.equal(run(ctx, '_schDefaultAgentId()'), 'local:codex');
  assert.match(run(ctx, '_schModelFieldHtml("", "local:codex")'), /native-default/);
});

test('automation model selector translates labels generated after the editor opens', async () => {
  const translations = {
    '模型': 'Model',
    '请选择模型': 'Choose a model',
    '当前没有可用模型': 'No models are available',
    '由底座自身管理模型': 'Managed by this runtime',
    '当前底座不接受自动化单独指定模型。': 'This runtime does not accept an automation-specific model.',
    '模型与执行底座独立保存；每次自动化运行都使用这里选择的模型。': 'The model is saved independently from the runtime; each run uses the selected model.',
  };
  const ctx = context({ taskExecutionOptions: async () => modern });
  ctx.window.SoduWorkI18n = { translateText: value => translations[value] || value };
  await run(ctx, '_schLoadExecutionAgents({})');

  const enabled = run(ctx, '_schModelFieldHtml("", "local:pi")');
  assert.match(enabled, /Choose a model/);
  assert.match(enabled, /The model is saved independently from the runtime/);
  assert.doesNotMatch(enabled, /请选择模型|模型与执行底座独立保存/);

  run(ctx, '_schAgents[1].nativeModelPick = false');
  const managed = run(ctx, '_schModelFieldHtml("", "local:codex")');
  assert.match(managed, /Managed by this runtime/);
  assert.match(managed, /This runtime does not accept an automation-specific model/);
  assert.doesNotMatch(managed, /由底座自身管理模型|当前底座不接受自动化单独指定模型/);
});

test('automation model selector strings exist in every supported locale catalog', () => {
  const keySet = [
    '模型', '可独立选择', '请选择模型', '当前没有可用模型', '（已保存，当前不可用）',
    '由底座自身管理模型', '当前底座不接受自动化单独指定模型。', '当前底座自行管理模型',
    '模型与执行底座独立保存；每次自动化运行都使用这里选择的模型。',
    '模型与执行底座独立保存，每次自动化运行使用这里的选择',
  ];
  const catalogs = {
    'en-US': require('../core/locales/en-US-runtime-pages.js'),
    'ja-JP': require('../core/locales/ja-JP-gap-pages.js'),
    'ko-KR': require('../core/locales/ko-KR-gap-pages.js'),
  };
  for (const [locale, catalog] of Object.entries(catalogs)) {
    for (const key of keySet) {
      assert.ok(catalog[key] && catalog[key] !== key, `${locale} is missing translation for ${key}`);
    }
  }
});

test('legacy conversation automation path uses the same execution contract', async () => {
  let body;
  const ctx = context({ taskExecutionOptions: async () => modern,
    createSchedule: async value => { body = value; } });
  ctx.petSay = () => {};
  await run(ctx, '_schmCreateAutomation("每天整理日报", {schedule:{every:"daily",atHour:9,atMinute:0,weekday:1},acceptance:"保留来源"})');
  assert.equal(body.assigneeId, 'local:pi');
  assert.equal(body.modelName, 'soduwork-prd-large');
  assert.match(body.note, /保留来源/);
});

test('conversation automation carries personal plugin defaults into the saved prompt inputs', async () => {
  let body;
  const ctx = context({
    taskExecutionOptions: async () => ({
      substrates: [{ key: 'local:pi', cli: 'pi', name: 'Pi', available: true, modelPick: true }],
      modelOptions: [{ name: 'default-model', label: 'Default' }], defaultModel: 'default-model',
    }),
    createSchedule: async value => { body = value; },
  }, { personalPlugins: { list: async () => ({ items: [{
    key: 'daily-report', name: '??', version: '1.0.0', checksum: 'a'.repeat(64), enabled: true,
    entrypoints: { automation: true }, capabilities: { runtime: [] },
    inputs: [{ key: 'format', type: 'select', default: 'brief' }],
  }] }) } });
  ctx.petSay = () => {};
  await run(ctx, '_schmCreateAutomation("??", {schedule:{every:"daily",atHour:9,atMinute:0,weekday:1,personalPluginKey:"daily-report"}})');
  assert.equal(body.pluginInputs.format, 'brief');
});

test('conversation automation preserves the explicitly selected substrate and model', async () => {
  let body;
  const ctx = context({
    taskExecutionOptions: async () => ({
      substrates: [
        { key: 'local:pi', cli: 'pi', name: 'Pi', available: true, modelPick: true },
        { key: 'local:qwen', cli: 'qwen', name: 'Qwen', available: true, modelPick: true },
      ],
      modelOptions: [{ name: 'default-model', label: 'Default' }, { name: 'chosen-model', label: 'Chosen' }],
      defaultModel: 'default-model',
    }),
    createSchedule: async value => { body = value; },
  });
  ctx.petSay = () => {};
  await run(ctx, `_schmCreateAutomation("每日整理日报", {
    schedule:{every:"daily",atHour:9,atMinute:0,weekday:1,repoId:"repo-1"}
  }, { adapterId: "qwen", modelName: "chosen-model" })`);
  assert.equal(body.assigneeId, 'local:qwen');
  assert.equal(body.modelName, 'chosen-model');
  assert.equal(body.repoId, 'repo-1');
});
