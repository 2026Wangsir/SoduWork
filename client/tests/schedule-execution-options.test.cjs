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

for (const source of ['local', 'Hub']) test('new automation selects its only ' + source + ' model despite a missing Agent default', async () => {
  const name = source === 'local' ? 'local:model-0123456789abcdef0123456789abcdef' : 'only-hub-model';
  const ctx = context({ taskExecutionOptions: async () => ({ substrates: [{ key: 'local:qwen', cli: 'qwen', modelPick: true }],
    modelOptions: source === 'Hub' ? [{ name }] : [], defaultModel: '' }),
    myModels: async () => ({ usable: source === 'local' ? [{ name, localOnly: true }] : [],
      defaultModels: {}, defaultModelErrors: { qwen: 'No Hub default is configured' } }) });
  await run(ctx, '_schLoadExecutionAgents({})');
  assert.equal(run(ctx, '_schDefaultModelFor("local:qwen")'), name);
  const removed = 'local:model-fedcba9876543210fedcba9876543210';
  ctx.SoduWorkAPI.myModels = async () => ({ usable: source === 'local' ? [{ name, localOnly: true }] : [],
    defaultModels: { qwen: removed }, defaultModelErrors: { qwen: 'The old Agent default was deleted' } });
  await run(ctx, '_schLoadExecutionAgents({})');
  assert.equal(run(ctx, '_schDefaultModelFor("local:qwen")'), name, 'a new draft may choose the sole model despite a deleted Agent default');
  const saved = run(ctx, `_schModelFieldHtml(${JSON.stringify(removed)}, "local:qwen")`);
  assert.match(saved, new RegExp('value="' + name + '" selected'));
  assert.doesNotMatch(saved, new RegExp('value="' + removed + '"'));
});

test('a failed default catalog load remains unselected and a successful refresh selects the only local model', async () => {
  let failed = true;
  const name = 'local:model-0123456789abcdef0123456789abcdef';
  const ctx = context({ taskExecutionOptions: async () => ({ substrates: [{ key: 'local:qwen', cli: 'qwen', modelPick: true }], modelOptions: [] }),
    myModels: async () => { if (failed) throw Error('Temporary catalog failure');
      return { usable: [{ name, localOnly: true }], defaultModelErrors: { qwen: 'No Hub default' } }; } });
  await run(ctx, '_schLoadExecutionAgents({})');
  assert.equal(run(ctx, '_schDefaultModelFor("local:qwen")'), '');
  failed = false; await run(ctx, '_schLoadExecutionAgents({})');
  assert.equal(run(ctx, '_schDefaultModelFor("local:qwen")'), name);
  run(ctx, '_schEditing = { modelName: "unavailable:default" }');
  assert.match(run(ctx, '_schAgentFieldHtml("local:qwen")'), new RegExp('value="' + name + '" selected'));
  run(ctx, '_schEditing = { id: "saved", modelName: "local:unavailable" }');
  assert.match(run(ctx, '_schAgentFieldHtml("local:qwen")'), /value="local:unavailable" selected disabled/);
});

test('automation defaults use local-first candidates and preserve only valid explicit form selections', async () => {
  const first = 'local:model-0123456789abcdef0123456789abcdef', preferred = 'local:model-fedcba9876543210fedcba9876543210';
  const catalog = { usable: [{ name: first, localOnly: true }, { name: preferred, localOnly: true }],
    defaultModels: { pi: preferred }, defaultModelErrors: {} };
  const ctx = context({ taskExecutionOptions: async () => ({ ...modern, substrates: [
    ...modern.substrates, { key: 'runner:other:pi', cli: 'pi', locationMode: 'remote', modelPick: true },
  ] }), myModels: async () => catalog });
  await run(ctx, '_schLoadExecutionAgents({})');
  assert.equal(run(ctx, '_schDefaultModelFor("local:pi")'), first);
  assert.equal(run(ctx, '_schDefaultModelFor("runner:other:pi")'), modern.defaultModel);
  catalog.usable = [{ name: first, localOnly: true }]; catalog.defaultModelErrors.pi = 'Deleted';
  await run(ctx, '_schLoadExecutionAgents({})');
  assert.equal(run(ctx, '_schDefaultModelFor("local:pi")'), first);
  assert.match(run(ctx, '_schModelFieldHtml("' + preferred + '", "local:pi")'), new RegExp('value="' + first + '" selected'));
});

test('changing automation substrates starts from the first usable model and leaves native account defaults alone', async () => {
  const pi = 'local:model-0123456789abcdef0123456789abcdef', qwen = 'local:model-fedcba9876543210fedcba9876543210';
  const ctx = context({ taskExecutionOptions: async () => ({ ...modern, substrates: [
    ...modern.substrates, { key: 'local:qwen', cli: 'qwen', available: true, modelPick: true },
  ] }), myModels: async () => ({ usable: [{ name: pi, localOnly: true }, { name: qwen, localOnly: true }],
    defaultModels: { pi, qwen }, defaultModelErrors: {} }) });
  await run(ctx, '_schLoadExecutionAgents({})');
  assert.equal(run(ctx, '_schDefaultModelFor("local:pi")'), pi);
  assert.equal(run(ctx, '_schDefaultModelFor("local:qwen")'), pi);
  assert.equal(run(ctx, '_schResolveModelFor("local:qwen", "' + qwen + '")'), qwen);
  assert.equal(run(ctx, '_schDefaultModelFor("local:codex")'), '');
});

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
      key: 'local:pi', cli: 'pi', name: 'Pi', available: true, modelPick: true,
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
  const localModel = { id: 'local:model-0123456789abcdef0123456789abcdef', name: 'local:model-0123456789abcdef0123456789abcdef',
    modelName: 'glm5.2', label: 'glm5.2', providerName: '自己模型', localOnly: true };
  const ctx = context({ taskExecutionOptions: async () => modern,
    myModels: async () => ({ usable: [localModel, { name: 'soduwork-prd-large', label: '生产大模型' }] }) }, {
    conversationSession: { runtimeModels: async () => ({ models: [{ id: 'gpt-5-codex', label: 'Codex 默认模型' }] }) },
  });
  await run(ctx, '_schLoadExecutionAgents({})');
  const piModels = run(ctx, '_schModelFieldHtml("", "local:pi")');
  assert.ok(piModels.indexOf('local:model-0123456789abcdef0123456789abcdef') < piModels.indexOf('soduwork-prd-large'));
  assert.match(piModels, /glm5\.2 · 自己模型 · 本机/);
  assert.match(run(ctx, '_schModelFieldHtml("", "local:pi")'), /selected/);
  // Native catalogs load only when that substrate is selected.
  await run(ctx, '_schLoadNativeModelOptions(_schAgents.filter(item => item.id === "local:codex"))');
  assert.match(run(ctx, '_schModelFieldHtml("", "local:codex")'), /gpt-5-codex/);
  assert.doesNotMatch(run(ctx, '_schModelFieldHtml("", "local:codex")'), /soduwork-prd-large/);
  assert.doesNotMatch(run(ctx, '_schModelFieldHtml("", "local:codex")'), /<select[^>]+disabled/);
  assert.equal(run(ctx, '_schAgentAllowsModel("local:codex")'), true);
  assert.equal(run(ctx, '_schAgentAllowsModel("local:pi")'), true);
});

test('managed automation shares the model catalog, excludes image models and keeps device models off remote seats', async () => {
  const localRef = 'local:model-' + 'b'.repeat(32), imageRef = 'local:model-' + 'd'.repeat(32);
  for (const runtime of ['pi', 'qwen', 'opencode', 'dsh', 'kimi', 'harness2', 'codex-harness']) {
    const ctx = context({ taskExecutionOptions: async () => ({
      substrates: [{ key: 'local:' + runtime, cli: runtime, available: true, modelPick: true,
        locations: [{ assigneeId: 'local:' + runtime, mode: 'local', label: 'Local device' },
          { assigneeId: 'runner:other:' + runtime, mode: 'remote', label: 'Other device' }] }],
      modelOptions: [{ name: 'managed-model', label: 'Managed' }],
    }), myModels: async () => ({ usable: [
      { name: localRef, label: 'Local custom model', modality: 'chat', localOnly: true },
      { name: imageRef, label: 'Local image model', modality: 'image', localOnly: true },
    ] }) }, { localModels: { get: async () => assert.fail('The automation editor must use the shared model catalog') } });
    const agents = await run(ctx, '_schLoadExecutionAgents({})');
    assert.deepEqual(Array.from(agents, item => item.id), ['local:' + runtime, 'runner:other:' + runtime]);
    const local = run(ctx, `_schModelFieldHtml("", ${JSON.stringify('local:' + runtime)})`);
    const remote = run(ctx, `_schModelFieldHtml("", ${JSON.stringify('runner:other:' + runtime)})`);
    assert.match(local, new RegExp(localRef));assert.match(local, /Local custom model/);
    assert.match(local, /managed-model/);assert.match(remote, /managed-model/);
    assert.doesNotMatch(remote, new RegExp(localRef));assert.doesNotMatch(local, new RegExp(imageRef));
  }
});

test('a current-device Runner retains its verified identity while using the shared local model catalog', async () => {
  const localRef = 'local:model-' + 'c'.repeat(32);
  let reads = 0;
  const ctx = context({ taskExecutionOptions: async () => ({
    substrates: [{ key: 'local:pi', cli: 'pi', name: 'Pi', available: true, modelPick: true,
      locations: [
        { assigneeId: 'runner:this-device:pi', mode: 'local', clientId: 'fixture-device', label: 'Local device' },
        { assigneeId: 'runner:other-device:pi', mode: 'remote', clientId: 'other-device', label: 'Other device' },
      ] }], modelOptions: [{ name: 'managed-model', label: 'Managed' }],
  }), myModels: async () => {
    reads++;
    return { usable: [{ name: localRef, label: 'Local custom model', localOnly: true, modality: 'chat' }] };
  } });
  await run(ctx, '_schLoadExecutionAgents({})');
  const selected = run(ctx, '_schDefaultAgentId()');
  assert.equal(selected, 'runner:this-device:pi');assert.equal(reads, 1);
  assert.equal(run(ctx, '_schAgents.find(item => item.id === "runner:this-device:pi").clientId'), 'fixture-device');
  assert.match(run(ctx, `_schModelFieldHtml("", ${JSON.stringify(selected)})`), /Local custom model/);
  assert.doesNotMatch(run(ctx, '_schModelFieldHtml("", "runner:other-device:pi")'), /Local custom model/);
});

test('automation editor excludes local models from remote seats', async () => {
  const localModel = { name: 'local:model-abcdefabcdefabcdefabcdefabcdefab', label: '本地测试模型', localOnly: true };
  const ctx = context({ taskExecutionOptions: async () => ({
    substrates: [{ key: 'local:pi', cli: 'pi', name: 'Pi', available: true, modelPick: true,
      locations: [{ assigneeId: 'local:pi', mode: 'local', label: '本机' },
        { assigneeId: 'runner:desk-local:pi', mode: 'local', clientId: 'device', label: '本机 Runner' },
        { assigneeId: 'runner:desk:pi', mode: 'remote', label: '远程 Runner' }] }],
    modelOptions: [{ name: 'managed-model', label: '托管模型' }], defaultModel: 'managed-model',
  }), myModels: async () => ({ usable: [localModel] }) });
  await run(ctx, '_schLoadExecutionAgents({})');
  assert.match(run(ctx, '_schModelFieldHtml("", "local:pi")'), /local:model-abcdefabcdefabcdefabcdefabcdefab/);
  assert.match(run(ctx, '_schModelFieldHtml("", "runner:desk-local:pi")'), /local:model-abcdefabcdefabcdefabcdefabcdefab/);
  assert.doesNotMatch(run(ctx, '_schModelFieldHtml("", "runner:desk:pi")'), /local:model-abcdefabcdefabcdefabcdefabcdefab/);
  assert.match(run(ctx, '_schModelFieldHtml("", "runner:desk:pi")'), /managed-model/);
  run(ctx, '_schAgents.find(item => item.id === "runner:desk:pi").modelPick = false');
  assert.equal(run(ctx, '_schAgentAllowsModel("runner:desk:pi", "local:model-abcdefabcdefabcdefabcdefabcdefab")'), false);
});

test('local Pi keeps its local model picker when the runtime owns the default model', async () => {
  const localModel = { name: 'local:model-abcdefabcdefabcdefabcdefabcdefab', label: '本地测试模型', localOnly: true };
  const ctx = context({ taskExecutionOptions: async () => ({
    substrates: [{ key: 'local:pi', cli: 'pi', name: 'Pi', available: true, modelPick: false }],
    modelOptions: [{ name: 'managed-model', label: '托管模型' }], defaultModel: 'managed-model',
  }), myModels: async () => ({ usable: [localModel] }) });
  await run(ctx, '_schLoadExecutionAgents({})');
  assert.equal(run(ctx, '_schAgentAllowsModel("local:pi")'), true);
  const field = run(ctx, '_schModelFieldHtml("", "local:pi")');
  assert.match(field, /local:model-abcdefabcdefabcdefabcdefabcdefab/);
  assert.doesNotMatch(field, /<select[^>]+disabled/);
});

test('a deleted local automation model falls back to the first Hub model when the catalog was read successfully', async () => {
  const localName = 'local:model-abcdefabcdefabcdefabcdefabcdefab';
  const ctx = context({ taskExecutionOptions: async () => ({
    substrates: [{ key: 'local:pi', cli: 'pi', name: 'Pi', available: true, modelPick: false }],
    modelOptions: [{ name: 'managed-model', label: '托管模型' }], defaultModel: 'managed-model',
  }), myModels: async () => ({ usable: [] }) });
  await run(ctx, '_schLoadExecutionAgents({})');
  assert.equal(run(ctx, '_schAgentAllowsModel("local:pi", "' + localName + '")'), true);
  const field = run(ctx, '_schModelFieldHtml("' + localName + '", "local:pi")');
  assert.match(field, /value="managed-model" selected/);
  assert.doesNotMatch(field, new RegExp(localName));
  assert.doesNotMatch(field, /<select[^>]+disabled/);
});

test('a missing device automation mapping remains an invalid placeholder even without a local catalog', async () => {
  const ctx = context({ taskExecutionOptions: async () => ({
    substrates: [{ key: 'local:qwen', cli: 'qwen', modelPick: false }], modelOptions: [],
  }), myModels: async () => ({ usable: [] }) });
  await run(ctx, '_schLoadExecutionAgents({})');
  assert.equal(run(ctx, '_schAgentAllowsModel("local:qwen", "local:unavailable")'), true);
  const html = run(ctx, '_schModelFieldHtml("local:unavailable", "local:qwen")');
  assert.match(html, /value="local:unavailable" selected disabled/);
  assert.match(html, /本机模型选择已失效，请重新选择/);
});

test('late local catalog responses cannot repopulate a new scope or wedge refreshes', async () => {
  let resolveLocal;
  let calls = 0;
  const localCatalog = new Promise(resolve => { resolveLocal = resolve; });
  const ctx = context({
    taskExecutionOptions: async () => modern,
    myModels: async () => (++calls === 1 ? localCatalog : { usable: [] }),
  });
  const pending = run(ctx, '_schLoadExecutionAgents({})');
  // Let the unified options request reach the deferred local catalog.
  await new Promise(resolve => setImmediate(resolve));
  run(ctx, '_schScope++');
  resolveLocal({ usable: [{ name: 'local:model-abcdefabcdefabcdefabcdefabcdefab', localOnly: true }] });
  assert.equal((await pending).length, 0);
  assert.equal(run(ctx, '_schLocalModelOptions.length'), 0);

  // The stale promise must release the coalescing slot so a refresh can run.
  const refreshed = await run(ctx, '_schLoadExecutionAgents({})');
  assert.equal(calls, 2);
  assert.deepEqual(Array.from(refreshed, item => item.id), ['local:pi', 'local:codex']);
  assert.equal(run(ctx, '_schLocalModelOptions.length'), 0);
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
  assert.match(enabled, /value="soduwork-prd-large" selected/);
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

test('conversation automation can persist a local model for a Pi runtime with modelPick disabled', async () => {
  let body;
  const localName = 'local:model-abcdefabcdefabcdefabcdefabcdefab';
  const ctx = context({
    taskExecutionOptions: async () => ({
      substrates: [{ key: 'local:pi', cli: 'pi', name: 'Pi', available: true, modelPick: false }],
      modelOptions: [{ name: 'managed-model', label: '托管模型' }],
      defaultModel: 'managed-model',
    }),
    myModels: async () => ({ usable: [{ name: localName, label: '本地模型', localOnly: true }] }),
    createSchedule: async value => { body = value; },
  });
  ctx.petSay = () => {};
  await run(ctx, '_schmCreateAutomation("每日整理日报", ' +
    '{schedule:{every:"daily",atHour:9,atMinute:0,weekday:1}}, ' +
    '{ adapterId: "pi", modelName: "' + localName + '" })');
  assert.equal(body.assigneeId, 'local:pi');
  assert.equal(body.modelName, localName);
});
