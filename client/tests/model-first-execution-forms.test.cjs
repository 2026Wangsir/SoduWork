'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = name => fs.readFileSync(path.join(__dirname, '../components/panels', name + '.js'), 'utf8');
const first = 'local:model-0123456789abcdef0123456789abcdef';
const second = 'local:model-fedcba9876543210fedcba9876543210';
const rows = [{ name: first, localOnly: true }, { name: second, localOnly: true }, { name: 'hub-model' }];

test('automation cards resolve managed form choices independently of runtime defaults and preserve ownership sentinels', () => {
  const window = {};
  vm.runInNewContext(source('work-automation-card-state'), { window });
  const catalog = { agents: [{ id: 'local:qwen', cli: 'qwen', modelPick: true },
    { id: 'runner:other:qwen', cli: 'qwen', mode: 'remote', modelPick: true },
    { id: 'local:codex', cli: 'codex', modelPick: false }], modelOptions: rows,
    defaultModels: { qwen: second }, hubDefaultModel: 'hub-model' };
  const resolve = (id, value) => window.WorkAutomationCardState.defaultModelFor(catalog, id, value);
  assert.equal(resolve('local:qwen', ''), first);
  assert.equal(resolve('local:qwen', 'deleted'), first);
  assert.equal(resolve('local:qwen', second), second);
  assert.equal(resolve('local:qwen', 'hub-model'), 'hub-model');
  assert.equal(resolve('local:qwen', 'local:unavailable'), 'local:unavailable');
  assert.equal(resolve('runner:other:qwen', first), 'hub-model');
  assert.equal(resolve('local:codex', first), '');
  catalog.modelCatalogError = true;
  assert.equal(resolve('local:qwen', ''), '');
  assert.equal(resolve('local:qwen', 'deleted'), 'deleted');
  assert.equal(resolve('runner:other:qwen', ''), 'hub-model');
});

test('the schedule editor distinguishes a secure catalog failure from a successful deletion', async () => {
  let failed = true;
  const window = { addEventListener() {} }, api = {
    taskExecutionOptions: async () => ({ substrates: [
      { key: 'local:qwen', cli: 'qwen', modelPick: true },
      { key: 'runner:other:qwen', cli: 'qwen', locationMode: 'remote', modelPick: true },
    ], modelOptions: [{ name: 'hub-model' }] }),
    myModels: async () => { if (failed) throw Error('Secure store unreadable'); return { usable: [] }; },
  };
  const ctx = vm.createContext({ window, SoduWorkAPI: api, esc: String, Intl, Event,
    document: { getElementById: () => null } });
  for (const name of ['panels-schedules-methods', 'panels-schedules', 'panels-schedules-editor']) {
    vm.runInContext(source(name), ctx);
  }
  const run = value => vm.runInContext(value, ctx);
  await run('_schLoadExecutionAgents({})');
  assert.equal(run('_schModelCatalogError'), true);
  assert.equal(run('_schResolveModelFor("local:qwen", "deleted")'), 'deleted');
  assert.equal(run('_schResolveModelFor("local:qwen", "")'), '');
  assert.equal(run('_schResolveModelFor("runner:other:qwen", "")'), 'hub-model');
  failed = false;
  await run('_schLoadExecutionAgents({})');
  assert.equal(run('_schModelCatalogError'), false);
  assert.equal(run('_schResolveModelFor("local:qwen", "deleted")'), 'hub-model');
  assert.equal(run('_schResolveModelFor("local:qwen", "local:unavailable")'), 'local:unavailable');
});

test('requirement dispatch submits the resolved local-first model and refuses unreadable local catalogs', async () => {
  for (const scenario of ['empty', 'deleted', 'explicit', 'remote', 'account', 'unreadable']) {
    const calls = [], notices = [];
    const key = scenario === 'remote' ? 'runner:other:qwen' : scenario === 'account' ? 'local:codex' : 'local:qwen';
    const agent = { key, cli: scenario === 'account' ? 'codex' : 'qwen', available: true,
      modelPick: scenario !== 'account', remote: scenario === 'remote',
      localConversationAvailable: scenario !== 'remote' };
    const selected = scenario === 'explicit' ? second : scenario === 'empty' ? '' : 'deleted';
    const window = { addEventListener() {}, RequirementAssignment: { scope: () => 1, inScope: () => true,
      completed: async () => true } };
    const ctx = vm.createContext({ window, esc: String, _svg: () => '',
      document: { getElementById: id => id === 'fwdModel' ? { value: selected } : null },
      SoduWorkAPI: { dispatchToAI: async (...args) => { calls.push(args); return { ok: true }; } } });
    for (const name of ['panels-forward-plugin', 'panels-forward-picker', 'panels-forward-options', 'panels-forward']) {
      vm.runInContext(source(name), ctx);
    }
    ctx.options = { substrates: [agent], modelOptions: rows, models: [], defaultModel: 'hub-model',
      localModelCatalogError: scenario === 'unreadable' };
    vm.runInContext('_fwdOptions=options', ctx);
    ctx._pickedRepo = () => null; ctx._fwdSetBusy = ctx._closeFwd = () => {};
    ctx._fwdSetStatus = value => notices.push(value);
    await ctx._dispatchAITo('task', { id: key, type: 'agent' }, key);
    if (scenario === 'unreadable') {
      assert.equal(calls.length, 0);
      assert.match(notices.at(-1), /配置暂时无法读取/);
    } else {
      assert.equal(calls.length, 1);
      assert.equal(calls[0][4], scenario === 'account' ? '' : scenario === 'remote' ? 'hub-model'
        : scenario === 'explicit' ? second : first);
    }
  }
});
