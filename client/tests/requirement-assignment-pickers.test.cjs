'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture(options = {}, helpers = {}) {
  const notices = [], nodes = new Map();
  const ctx = vm.createContext({window: {addEventListener() {}, RequirementAssignment: {scope: () => 1}},
    document: {getElementById: id => nodes.get(id) || null},
    esc: value => String(value || ''), _svg: () => '', ...helpers});
  for (const name of ['panels-forward-plugin', 'panels-forward-picker', 'panels-forward-options']) {
    const file = path.join(__dirname, '../components/panels/' + name + '.js');
    vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, {filename: file});
  }
  ctx._fwdSetStatus = (...args) => notices.push(args);
  function update(value) { ctx.options = value; vm.runInContext('_fwdOptions = options', ctx); }
  update(options);
  return {ctx, notices, nodes, update, run: source => vm.runInContext(source, ctx)};
}

const agent = (key, extra = {}) => ({key, name: key, available: true, ...extra});
const flow = (bindingId, extra = {}) => ({bindingId, name: bindingId, runnable: true,
  selectionSource: 'installed', workflow: [{type: 'ai', route: {agentSource: 'runtime'}}], ...extra});

test('assignment picker renders untrusted catalog names, identifiers and diagnostics as escaped text', () => {
  const definition = fs.readFileSync(path.join(__dirname, '../core/store.js'), 'utf8')
    .split(/\r?\n/).find(line => line.startsWith('const esc='));
  assert.ok(definition, 'exercise the production shared HTML escape function');
  const escape = vm.runInNewContext(definition + ';esc');
  const payload = '"></option><img src=x onerror="window.fixtureXss=1"><script>fixtureXss=1</script>';
  const h = fixture({substrates: [agent(payload, {name: payload, locationLabel: payload})],
    workflows: [flow(payload, {name: payload})], models: []}, {esc: escape});
  h.ctx.payload = payload;
  h.run('_fwdLocalFailures = [{name: payload, reason: payload}]');
  h.ctx._fwdPaintSelection = h.ctx._fwdSyncConfirm = () => {};
  let markup;
  const box = {set innerHTML(value) {markup = value;},
    querySelector: () => ({addEventListener() {}}), querySelectorAll: () => []};
  h.ctx._fwdRenderAIPickers('fixture-task', box);
  assert.ok(markup.includes(escape(payload)), 'catalog values remain visible as text');
  assert.ok(!markup.includes(payload), 'no raw catalog value reaches HTML');
  assert.doesNotMatch(markup, /<(?:img|script)\b/i);
});

test('assignment methods require builtin or installed provenance plus a binding', () => {
  const h = fixture();
  for (const [item, expected] of [
    [null, false], [{}, false], [{selectionSource: 'installed'}, false],
    [{bindingId: 'builtin', selectionSource: 'builtin'}, true],
    [{bindingId: 'installed', selectionSource: 'installed'}, true],
    [{bindingId: 'legacy', sourceKind: 'builtin'}, true],
    [{bindingId: 'market', selectionSource: 'market', installed: true}, false],
    [{bindingId: 'legacy-market', sourceKind: 'market', installed: true}, false],
    [{bindingId: 'unknown', runnable: true, approved: true}, false],
    [{bindingId: 'legacy-installed', sourceKind: 'installed'}, false],
  ]) assert.equal(h.ctx._fwdInstalledMethod(item), expected, JSON.stringify(item));
});

test('plain execution defaults to a currently available Agent and never to a native conversation', () => {
  const h = fixture({substrates: [agent('offline', {available: 'offline'}), agent('first'), agent('preferred')],
    recommendation: {substrateKey: 'preferred'}});
  h.ctx._fwdRestoreAIChoice();
  assert.equal(h.run('_fwdSelection.ai.type'), 'direct');
  assert.equal(h.run('_fwdSelection.ai.id'), 'preferred');
  assert.equal(h.ctx._fwdChoiceIsCurrent({type: 'native', id: 'pi', available: true}), false);

  h.run('_fwdResetMethodChoice(); _fwdSelection.ai = null');
  h.update({substrates: [agent('offline', {available: false}), agent('first')],
    recommendation: {substrateKey: 'offline'}});
  h.ctx._fwdRestoreAIChoice();
  assert.equal(h.run('_fwdSelection.ai.id'), 'first', 'an unavailable recommendation cannot win');

  h.run('_fwdResetMethodChoice(); _fwdSelection.ai = null');
  h.update({substrates: [agent('offline', {available: false})]});
  h.ctx._fwdRestoreAIChoice();
  assert.equal(h.run('_fwdSelection.ai'), null, 'no available Agent means no default execution target');
});

test('refresh preserves a manual Agent and requires a new choice when that Agent disappears', () => {
  const h = fixture({substrates: [agent('chosen'), agent('replacement')],
    recommendation: {substrateKey: 'replacement'}});
  h.ctx._fwdChoose('task', {type: 'direct', id: 'chosen', name: 'Chosen', available: true});
  h.ctx._fwdRestoreAIChoice();
  assert.equal(h.run('_fwdSelection.ai.id'), 'chosen');
  h.update({substrates: [agent('replacement')], recommendation: {substrateKey: 'replacement'}});
  h.ctx._fwdRestoreAIChoice();
  assert.equal(h.run('_fwdSelection.ai'), null);
  assert.match(h.notices.at(-1)[0], /原执行选项已不可用.*重新选择/);
  h.ctx._fwdRestoreAIChoice();
  assert.equal(h.run('_fwdSelection.ai'), null, 'later refreshes must not silently replace a manual choice');
});

test('workflow Agent and model choices survive switches and become stale instead of falling back', () => {
  const first = flow('first'), second = flow('second');
  const h = fixture({substrates: [agent('replacement'), agent('chosen')], models: ['chosen-model'], workflows: [first, second]});
  h.ctx._fwdChoose('task', {type: 'direct', id: 'chosen', name: 'Chosen', available: true});
  h.ctx._fwdChoose('task', {type: 'workflow', id: first.bindingId, name: first.name, available: true});
  const initial = h.ctx._fwdAgentPickerState(first);
  assert.equal(initial.value, 'chosen', 'a new workflow keeps the chosen Agent instead of the first catalog entry');
  assert.equal(initial.stale, false);
  // The picker change handlers write this state object; refresh must retain it.
  initial.state.kind = 'chosen'; initial.state.model = 'chosen-model';
  h.ctx._fwdAgentPickerState(second).state.kind = 'replacement';
  const restored = h.ctx._fwdAgentPickerState(first);
  assert.equal(restored.value, 'chosen');
  assert.equal(restored.state.model, 'chosen-model');
  h.update({substrates: [agent('chosen', {available: false}), agent('replacement')], models: ['chosen-model']});
  const stale = h.ctx._fwdAgentPickerState(first);
  assert.equal(stale.value, 'chosen', 'retain the unavailable identity so it cannot become automatic routing');
  assert.equal(stale.state.model, 'chosen-model');
  assert.equal(stale.stale, true);
  assert.equal(stale.rows.some(row => row.value === ''), true, 'automatic routing is available but must not replace the choice');
  assert.match(h.ctx._fwdAgentSummary(stale, first), /原 Agent 已不可用.*重新选择/);
  assert.equal(h.ctx._fwdAgentPickerState(first).stale, true);
});

function payloadFixture(kindValue, pickerValue, model = {value: 'chosen-model'}) {
  const kind = {value: kindValue}, wrap = {hidden: false};
  const picker = {value: pickerValue, focus() { this.focused = true; }};
  const card = {getAttribute: name => ({'data-fwp-card': 'flow', 'data-fwp-ready': '1', 'data-fwp-name': 'Workflow'})[name],
    querySelector: selector => ({'[data-fwp-kind]': kind, '[data-fwp-model]': model, '[data-fwp-model-wrap]': wrap})[selector]};
  const box = {querySelectorAll: () => [card], querySelector: selector => selector === '#fwdAgentSelect' ? picker : null};
  return {kind, model, wrap, picker, card, box};
}

test('stale or mismatched workflow Agent selections cannot produce an execution payload', () => {
  const h = fixture();
  for (const selected of ['__unselected__', 'replacement']) {
    const f = payloadFixture('chosen', selected);
    const result = h.ctx._fwpPayload(f.box, 'flow', true);
    assert.equal(result.ok, false);
    assert.match(result.reason, /原 Agent 已不可用.*重新选择/);
    assert.equal(f.picker.focused, true);
  }
  const valid = payloadFixture('chosen', 'chosen');
  const result = h.ctx._fwpPayload(valid.box, 'flow', false);
  assert.equal(result.ok, true);
  assert.equal(result.body.execution.agentKind, 'chosen');
  assert.equal(result.body.execution.model, 'chosen-model');
});

test('Agents that disallow model overrides clear the old workflow model before payload creation', () => {
  const h = fixture(), f = payloadFixture('fixed-model', 'fixed-model');
  h.ctx._fwpSyncModel(f.card, {substrates: [agent('fixed-model', {modelPick: false})]});
  assert.equal(f.model.value, '');
  assert.equal(f.model.disabled, true);
  assert.equal(f.wrap.hidden, true);
  const result = h.ctx._fwpPayload(f.box, 'flow', false);
  assert.equal(result.ok, true);
  assert.equal(result.body.execution.agentKind, 'fixed-model');
  assert.equal(result.body.execution.model, '');
});

// Model the native select rule that caused the bug: assigning a removed option
// produces an empty value. Actual browser change/focus behavior is covered by E2E.
function selectFromHtml(html) {
  const options = [...html.matchAll(/<option value="([^"]*)"([^>]*)>([^<]*)<\/option>/g)]
    .map(([, value, attrs, text]) => ({value, selected: /\bselected\b/.test(attrs), disabled: /\bdisabled\b/.test(attrs), text}));
  let value = (options.find(row => row.selected) || options[0])?.value || '';
  const listeners = new Map();
  return {options, disabled: /<select[^>]*\bdisabled\b/.test(html),
    get value() {return value;}, set value(next) {value = options.some(row => row.value === next) ? next : '';},
    addEventListener(type, fn) {listeners.set(type, fn);}, focus() {this.focused = true;},
    change(next) {this.value = next; listeners.get('change')?.({target: this});}};
}

function directModelFixture() {
  const options = {substrates: [agent('chosen')], models: ['chosen-model']};
  const h = fixture(options), dispatches = [];
  const button = {dataset: {}, disabled: true, textContent: ''};
  let markup = '';
  h.nodes.set('fwdConfirm', button);
  h.nodes.set('fwdDecision', {get innerHTML() {return markup;}, set innerHTML(html) {
    markup = html;
    const match = html.match(/<select id="fwdModel"[^>]*>[\s\S]*?<\/select>/);
    if (match) h.nodes.set('fwdModel', selectFromHtml(match[0]));
    else h.nodes.delete('fwdModel');
  }});
  h.ctx._dispatchAITo = (...args) => dispatches.push(args);
  h.ctx._fwdChoose('task', {type: 'direct', id: 'chosen', name: 'Chosen', available: true});
  h.run("_fwdModel = 'chosen-model'");
  h.ctx._fwdSyncConfirm('task');
  return {...h, options, button, dispatches};
}

test('new requirement execution explicitly selects the sole usable model and excludes unavailable default placeholders', () => {
  for (const name of ['only-hub-model', 'local:model-0123456789abcdef0123456789abcdef']) {
    const h = directModelFixture();
    h.update({ substrates: [agent('chosen', { cli: 'qwen', localConversationAvailable: true })],
      defaultModel: 'unavailable:default', defaultModelErrors: { qwen: 'No default' },
      modelOptions: [{ name, localOnly: name.startsWith('local:') }] });
    h.run('_fwdModel = ""'); h.ctx._fwdSyncConfirm('task');
    assert.equal(h.run('_fwdModel'), name);
    assert.equal(h.nodes.get('fwdModel').value, name);
    assert.equal(h.button.disabled, false);
    h.run('_fwdModel = "local:model-fedcba9876543210fedcba9876543210"');
    h.ctx._fwdSyncConfirm('task');
    assert.equal(h.button.disabled, false, 'a deleted choice resolves to the first available replacement');
    assert.equal(h.run('_fwdModel'), name);
  }
});

test('direct model removal resolves its replacement before both display and confirmation', async () => {
  const h = directModelFixture();
  h.update({...h.options, models: ['replacement-model', 'another-model']});
  h.ctx._fwdSyncConfirm('task');
  assert.equal(h.nodes.get('fwdModel').value, 'replacement-model');
  assert.equal(h.run('_fwdModel'), 'replacement-model');
  assert.equal(h.button.disabled, false);
  h.run("_fwdModel='deleted-after-display'");
  await h.ctx._fwdConfirm('task');
  assert.equal(h.run('_fwdModel'), 'replacement-model');
  assert.equal(h.dispatches.length, 1);
  h.nodes.get('fwdModel').change('another-model');
  assert.equal(h.run('_fwdModel'), 'another-model');
  await h.ctx._fwdConfirm('task');
  assert.equal(h.dispatches.length, 2);
  const empty = directModelFixture();
  empty.update({...empty.options, models: []});
  empty.ctx._fwdSyncConfirm('task');
  assert.equal(empty.button.disabled, true);
  assert.equal(empty.run('_fwdModel'), 'chosen-model');
  await empty.ctx._fwdConfirm('task');
  assert.equal(empty.dispatches.length, 0);
});

test('model controls rebuilt while dispatch is busy stay disabled and ignore changes', () => {
  const h = directModelFixture();
  h.button.dataset.idleLabel = 'Confirm';
  h.ctx._fwdSyncConfirm('task');
  assert.equal(h.nodes.get('fwdModel').disabled, true);
  h.nodes.get('fwdModel').change('');
  assert.equal(h.run('_fwdModel'), 'chosen-model');
  assert.equal(h.button.disabled, true);
  h.ctx._fwdSetBusy(false);
  assert.equal(h.nodes.get('fwdModel').disabled, false);
  assert.equal(h.button.disabled, false);
});

test('returning from a workflow retains an unavailable direct model instead of changing to default', () => {
  const h = directModelFixture(), plugin = flow('flow');
  h.update({...h.options, workflows: [plugin]});
  h.ctx._fwdChoose('task', {type: 'workflow', id: 'flow', name: 'Workflow', available: true});
  h.update({...h.options, workflows: [plugin], models: []});
  h.ctx._fwdChooseNoPlugin('task');
  assert.equal(h.run('_fwdModel'), 'chosen-model');
  assert.equal(h.nodes.get('fwdModel').value, '__unselected__');
  assert.equal(h.button.disabled, true);
});

test('workflow model removal renders a visible stale choice even without a model catalog and refuses its payload', () => {
  for (const models of [['replacement-model'], []]) {
    const plugin = flow('flow'), h = fixture({substrates: [agent('chosen')], models: ['chosen-model']});
    const saved = h.ctx._fwdAgentPickerState(plugin).state;
    saved.model = 'chosen-model';
    h.update({substrates: [agent('chosen')], models});
    const state = h.ctx._fwdAgentPickerState(plugin);
    assert.equal(state.state.model, 'chosen-model');
    assert.equal(state.modelStale, true);
    const markup = h.ctx._fwpCard(plugin, h.ctx.options, true, state.state);
    assert.match(markup, /aria-expanded="true"/);
    const modelHtml = markup.match(/<select data-fwp-model[^>]*>[\s\S]*?<\/select>/)?.[0];
    assert.ok(modelHtml, 'the stale selector stays visible when the catalog is empty');
    const model = selectFromHtml(modelHtml), f = payloadFixture('chosen', 'chosen', model);
    assert.equal(model.value, '__unselected__');
    assert.equal(model.options[0].disabled, true);
    const result = h.ctx._fwpPayload(f.box, 'flow', true);
    assert.equal(result.ok, false);
    assert.match(result.reason, /原模型已不可用，请重新选择/);
    assert.equal(model.focused, true);
    for (const recovery of ['', ...models]) {
      model.value = recovery;
      const valid = h.ctx._fwpPayload(f.box, 'flow', false);
      assert.equal(valid.ok, true);
      assert.equal(valid.body.execution.model, recovery);
    }
  }
});

test('modelPick false still clears stale direct and workflow model overrides', () => {
  const direct = directModelFixture();
  direct.update({substrates: [agent('chosen', {modelPick: false})], models: []});
  direct.ctx._fwdSyncConfirm('task');
  assert.equal(direct.run('_fwdModel'), '');
  assert.equal(direct.nodes.has('fwdModel'), false);
  assert.equal(direct.button.disabled, false);

  const plugin = flow('flow'), h = fixture({substrates: [agent('chosen')], models: ['chosen-model']});
  h.ctx._fwdAgentPickerState(plugin).state.model = 'chosen-model';
  h.update({substrates: [agent('chosen', {modelPick: false})], models: []});
  const state = h.ctx._fwdAgentPickerState(plugin);
  assert.equal(state.state.model, '');
  assert.equal(state.modelStale, false);
});

test('local model catalog is optional, source-labeled and kept beside Hub choices', async () => {
  const h = fixture({modelOptions: [{name: 'hub-model', providerId: 'hub-provider', providerName: 'Example Hub'}]});
  h.ctx.window.soduWorkAPI = {localModels: {get: async () => ({usable: [
    {name: 'local:model-abc', modelName: 'qwen-local', label: 'Qwen Local',
      providerId: 'ollama', providerName: '本机 Ollama', localOnly: true, modality: 'chat'},
    {name: 'local:image-abc', localOnly: true, modality: 'image'},
  ]})}};
  const rows = await h.ctx._fwdLocalModelChoices();
  assert.deepEqual(rows.map(row => [row.name, row.source, row.localOnly]),
    [['local:model-abc', 'local', true]]);
  h.ctx._fwdMergeLocalModelChoices(rows);
  assert.deepEqual(h.ctx.options.modelOptions.map(row => row.name), ['local:model-abc', 'hub-model']);
  h.run("_fwdLocalAgents = [{key:'local:pi', name:'Pi', executionSource:'conversation', modelPick:true}]");
  h.ctx.options.substrates = [agent('local:pi', {name: 'Hub Pi', remote: false})];
  const merged = h.ctx._fwdDirectAgents()[0];
  assert.equal(merged.remote, false, 'Hub routing metadata remains intact');
  assert.equal(merged.localConversationAvailable, true);
  assert.equal(h.ctx._fwdLocalModelAllowed(merged), true);
  assert.equal(h.ctx._fwdCanPickModel({...merged, modelPick: false}), true,
    'a managed local probe restores model selection for a stale Hub row');
  assert.equal(h.ctx._fwdLocalModelAllowed({...merged, remote: true}), false,
    'a remote Runner never receives a device-owned model reference');
  assert.equal(h.ctx._fwdCanPickModel({...merged, modelPick: false, remote: true}), false);
});

test('local model choices render for a local Agent and disappear for a remote Runner', async () => {
  const h = directModelFixture();
  h.ctx.window.soduWorkAPI = {localModels: {get: async () => ({usable: [
    {name: 'local:model-abc', modelName: 'qwen-local', label: 'Qwen Local',
      providerName: '本机 Ollama', localOnly: true, modality: 'chat'},
  ]})}};
  h.ctx.options.substrates = [agent('chosen', {name: 'Pi', cli: 'pi', executionSource: 'conversation', modelPick: true, local: true, remote: false})];
  h.ctx._fwdMergeLocalModelChoices(await h.ctx._fwdLocalModelChoices());
  h.run("_fwdModel = ''");
  h.ctx._fwdSyncConfirm('task');
  assert.match(h.nodes.get('fwdDecision').innerHTML, /value="local:model-abc"/);
  assert.match(h.nodes.get('fwdDecision').innerHTML, /Qwen Local/);

  h.ctx.options.substrates = [agent('chosen', {name: 'Remote Pi', modelPick: true, remote: true})];
  h.ctx._fwdSyncConfirm('task');
  assert.doesNotMatch(h.nodes.get('fwdDecision').innerHTML, /value="local:model-abc"/);
});


function currentDeviceFixture({clientId = 'fixture-client', mode = 'local', available = true, cli = 'pi', selection = {}, task = {id: 'task'}, local = true} = {}) {
  const endpoint = 'runner:fixture-device:' + cli;
  const h = fixture({selection, substrates: [agent('local:' + cli, {cli, name: 'Fixture Agent', available,
    locations: [{id: endpoint, assigneeId: endpoint, mode, label: 'Local · Fixture computer',
      runnerId: 'fixture-runner', clientId, machineKey: 'fixture-machine'}]})],
    recommendation: {substrateKey: endpoint}, models: ['chosen-model']}, {tasks: [task]});
  for (const file of ['components/panels/task-execution-context.js', 'components/panels/task-execution-client.js',
    'components/requirements/requirement-session-choice.js']) {
    const source = path.join(__dirname, '..', file);
    vm.runInContext(fs.readFileSync(source, 'utf8'), h.ctx, {filename: source});
  }
  h.ctx.TaskExecutionClient = h.ctx.window.TaskExecutionClient;
  h.ctx.window.SoduWorkAPI = {clientId: 'fixture-client'};
  h.ctx.window.NativeChat = {enqueueTask() {throw Error('Discovery must not execute a task');}};
  h.ctx.window.soduWorkAPI = {conversationSession: {runtimes() {}, probe() {}}};
  h.run("_fwdTaskId = 'task'");
  h.discover = () => h.run("_fwdLocalAgents = [{key:'local:pi', cli:'pi', name:'Pi', available:true, local:true, remote:false, locationMode:'local', executionSource:'conversation', modelPick:true}]");
  if (local) h.discover();
  h.endpoint = endpoint;
  return h;
}

test('a verified current-device Runner and native probe appear once for the same Agent', () => {
  const h = currentDeviceFixture();
  const rows = h.ctx._fwdDirectAgents();
  assert.equal(rows.filter(row => row.cli === 'pi').length, 1,
    'the location-specific Hub ID must not create a second row for the same local Agent');
  const chosen = rows[0];
  assert.equal(chosen.key, 'local:pi');
  assert.equal(chosen.locationLabel, 'Local · Fixture computer', 'retain the verified device display label');
  const context = h.ctx.TaskExecutionClient.context({substrates: rows}, {agentId: chosen.key, model: 'local:model-abc'});
  assert.equal(context.runner.runnerId, '', 'a native conversation must not inherit Hub transport identity');
  assert.equal(context.runner.clientId, '');
  assert.equal(context.agent.id, 'local:pi', 're-expanding locations must not restore the hidden Runner ID');
  assert.equal(context.model, 'local:model-abc');
  const spec = require('../main/pi-session/controlled-task-turn').executionSpec({id: 'task'},
    {agentId: chosen.key, executionContext: context, model: context.model});
  assert.equal(spec.mode, 'native', 'a device-owned model stays in the native execution path');
});

test('late current-device discovery maps only the automatic choice and preserves its model override', () => {
  const h = currentDeviceFixture({local: false});
  h.ctx._fwdRestoreAIChoice();
  assert.equal(h.run('_fwdSelection.ai.id'), h.endpoint);
  h.run("_fwdModel = 'chosen-model'");
  h.discover();
  h.ctx._fwdRestoreAIChoice();
  assert.equal(h.run('_fwdSelection.ai.id'), 'local:pi');
  assert.equal(h.run('_fwdModel'), 'chosen-model');
});

test('late current-device discovery retains a manual Runner choice and its controlled execution path', () => {
  const h = currentDeviceFixture({local: false});
  h.ctx._fwdChoose('task', {type: 'direct', id: h.endpoint, cli: 'pi', name: 'Fixture Agent', available: true});
  h.run("_fwdModel = 'chosen-model'");
  h.discover();
  h.ctx._fwdRestoreAIChoice();
  const rows = h.ctx._fwdDirectAgents();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].key, h.endpoint);
  assert.equal(h.run('_fwdSelection.ai.id'), h.endpoint);
  assert.equal(h.run('_fwdModel'), 'chosen-model');
  assert.equal(h.ctx._fwdLocalModelAllowed(rows[0]), false,
    'a controlled Runner must not advertise device-owned model execution');
  const context = h.ctx.TaskExecutionClient.context({substrates: rows}, {agentId: h.endpoint, model: 'chosen-model'});
  const spec = require('../main/pi-session/controlled-task-turn').executionSpec({id: 'task'},
    {agentId: h.endpoint, executionContext: context});
  assert.equal(spec.mode, 'dispatch');
});

test('current-device discovery cannot override an explicitly unavailable Hub Agent', () => {
  const h = currentDeviceFixture({available: false});
  const rows = h.ctx._fwdDirectAgents();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].key, h.endpoint);
  assert.equal(rows[0].available, false);
  h.ctx._fwdRestoreAIChoice();
  assert.equal(h.run('_fwdSelection.ai'), null);
});

test('Agent matching never combines another device, an unknown owner, a remote target or a different CLI', () => {
  for (const options of [
    {clientId: 'another-client'}, {clientId: ''}, {mode: 'remote'}, {cli: 'codex'},
  ]) {
    const h = currentDeviceFixture(options);
    const rows = h.ctx._fwdDirectAgents();
    assert.equal(rows.length, 2, JSON.stringify(options));
    assert.ok(rows.some(row => row.key === h.endpoint));
    assert.ok(rows.some(row => row.key === 'local:pi'));
  }
});

test('the native duplicate never replaces a repository, workflow or saved Runner requirement', () => {
  for (const options of [
    {selection: {repoId: 'repo'}}, {task: {id: 'task', workflowBindingId: 'flow'}},
    {task: {id: 'task', agentId: 'runner:fixture-device:pi'}},
  ]) {
    const h = currentDeviceFixture(options);
    const rows = h.ctx._fwdDirectAgents();
    assert.equal(rows.find(row => row.key === h.endpoint)?.key, h.endpoint, JSON.stringify(options));
    assert.equal(rows.find(row => row.key === h.endpoint)?.executionSource, undefined);
    assert.equal(rows.length, 1, 'stale local probes cannot bypass a newly constrained task');
  }
});


test('a verified local managed Agent advertises device-owned models while account Agents remain isolated', () => {
  const h = directModelFixture();
  h.ctx._fwdMergeLocalModelChoices([{name: 'local:model-fixture', label: 'Fixture local model', localOnly: true}]);
  for (const cli of ['qwen', 'codex-harness', 'opencode', 'dsh', 'harness2', 'custom-runtime']) {
    h.ctx.options.substrates = [agent('local:' + cli, {name: cli, cli, executionSource: 'conversation', modelPick: true})];
    h.run("_fwdSelection.ai = {type:'direct',id:'previous-pi',available:true};_fwdModel = 'local:model-fixture'");
    h.ctx._fwdChoose('task', {type:'direct',id:'local:'+cli,available:true});
    assert.equal(h.run('_fwdModel'), 'local:model-fixture', 'managed runtime keeps the local override: ' + cli);
    assert.match(h.nodes.get('fwdDecision').innerHTML, /value="local:model-fixture"/,
      'local choice remains visible: ' + cli);
    assert.equal(h.button.disabled, false);
  }
  for (const cli of ['codex', 'claude']) {
    h.ctx.options.substrates = [agent('local:' + cli, {name: cli, cli, executionSource: 'conversation', modelMode: 'account', modelPick: true})];
    h.run("_fwdSelection.ai = {type:'direct',id:'previous-pi',available:true};_fwdModel = 'local:model-fixture'");
    h.ctx._fwdChoose('task', {type:'direct',id:'local:'+cli,available:true});
    assert.equal(h.run('_fwdModel'), '', 'account runtime cannot retain a local override: ' + cli);
    assert.doesNotMatch(h.nodes.get('fwdDecision').innerHTML, /value="local:model-fixture"/);
  }
  assert.equal(h.ctx._fwdLocalModelAllowed({key: 'local:pi', local: true}), false,
    'a local label without successful discovery does not prove conversation readiness');
  assert.equal(h.ctx._fwdLocalModelAllowed({key: 'local:pi', executionSource: 'conversation'}), true);
});


test('a remembered direct model survives local discovery while a workflow is selected', () => {
  const h = currentDeviceFixture({local: false});
  h.ctx.options.workflows = [flow('fixture-method')];
  h.ctx._fwdRestoreAIChoice();
  assert.equal(h.run('_fwdSelection.ai.id'), h.endpoint);
  h.run("_fwdModel = 'chosen-model'");
  h.ctx._fwdChoose('task', {type: 'workflow', id: 'fixture-method', name: 'Fixture method', available: true});
  h.discover();h.ctx._fwdRestoreAIChoice();
  assert.equal(h.run('_fwdSelection.ai.id'), 'fixture-method');
  h.ctx._fwdChooseNoPlugin('task');
  assert.equal(h.run('_fwdSelection.ai.id'), 'local:pi');
  assert.equal(h.run('_fwdModel'), 'chosen-model');
});


test('legacy local model selection survives pending, failed and recovered runtime discovery', () => {
  for (const modelPick of [true, false]) {
    const h = directModelFixture();
    const local = {name:'local:model-fixture',localOnly:true};
    h.ctx.options.substrates = [agent('local:pi', {cli:'pi',local:true,modelPick,localConversationAvailable:true,localModelPick:true})];
    h.ctx.options.modelOptions = [local];
    h.run("_fwdSelection.ai.id='local:pi';_fwdModel='local:model-fixture'");
    h.ctx._fwdSyncConfirm('task');assert.equal(h.run('_fwdModel'),local.name);
    h.ctx.options.substrates = [agent('local:pi', {cli:'pi',local:true,modelPick})];
    h.ctx.options.modelOptions = [];
    h.run('_fwdLocalLoading=true;_fwdLocalAgents=[]');
    h.ctx._fwdSyncConfirm('task');
    assert.equal(h.run('_fwdModel'),local.name);
    assert.equal(h.button.disabled,true);
    h.run('_fwdLocalLoading=false');h.ctx._fwdSyncConfirm('task');
    assert.equal(h.run('_fwdModel'),local.name);
    assert.equal(h.nodes.get('fwdModel').value,'__unselected__');
    assert.equal(h.button.disabled,true,'failed discovery cannot dispatch with a different default');
    h.ctx.options.substrates[0].localConversationAvailable=true;
    h.ctx.options.substrates[0].localModelPick=true;
    h.ctx.options.modelOptions=[local];
    h.ctx._fwdSyncConfirm('task');
    assert.equal(h.run('_fwdModel'),local.name);
    assert.equal(h.nodes.get('fwdModel').value,local.name);
    assert.equal(h.button.disabled,false);
  }
});


test('a delayed local catalog cannot overwrite a newer task, loading state or closed assignment', async () => {
  for (const closed of [false,true]) {
    const h = fixture({modelOptions:[]}), box = {}, painted=[];
    h.nodes.set('fwdList',box);h.run('_fwdLoadSeq=1;_fwdTab="ai";_fwdLocalLoading=true');
    let release;
    h.ctx.window.soduWorkAPI={localModels:{get:()=>new Promise(resolve=>{release=resolve;})}};
    h.ctx.window.RequirementSessionChoice={localAgents:async()=>({failures:[]})};
    h.ctx._fwdRestoreAIChoice=()=>{};h.ctx._fwdSyncConfirm=()=>{};
    h.ctx._fwdRenderAIPickers=tid=>painted.push(tid);
    const request=h.ctx._fwdLoadLocalAgents('old-task',{},box,1);
    await new Promise(resolve=>setImmediate(resolve));
    h.run('_fwdLoadSeq=2;_fwdLocalLoading=true');
    h.update({modelOptions:[{name:'new-scope-hub-model'}]});
    if (closed) h.nodes.delete('fwdList');
    release({usable:[{name:'local:old-scope-model',localOnly:true}]});
    await request;
    assert.deepEqual(h.ctx.options.modelOptions,[{name:'new-scope-hub-model'}]);
    assert.deepEqual(painted,[]);
    assert.equal(h.run('_fwdLocalLoading'),true,'the superseded response does not settle the new request');
  }
});

test('switching to a workflow keeps its confirmation usable and restores the remembered direct local model', () => {
  const h = directModelFixture();
  h.update({substrates:[agent('chosen', {cli:'pi',modelPick:true,executionSource:'conversation'})],
    models:['hub-model'],modelOptions:[{name:'local:model-fixture',localOnly:true}],workflows:[flow('method')]});
  h.run("_fwdModel='local:model-fixture'");h.ctx._fwdSyncConfirm('task');
  h.ctx._fwdChoose('task',{type:'workflow',id:'method',name:'Method',available:true});
  assert.equal(h.run('_fwdModel'),'');
  assert.equal(h.button.disabled,false);
  assert.doesNotMatch(h.nodes.get('fwdDecision').innerHTML,/id="fwdModel"/);
  h.ctx._fwdChooseNoPlugin('task');
  assert.equal(h.run('_fwdModel'),'local:model-fixture');
  assert.equal(h.nodes.get('fwdModel').value,'local:model-fixture');
  assert.equal(h.button.disabled,false);
});

test('workflow model selection excludes device-owned references while preserving stale choices and managed models', () => {
  const h = fixture({substrates:[agent('local:pi',{cli:'pi',modelPick:true})],
    defaultModel:'local:default',models:['local:legacy','managed-model'],modelOptions:[
      {name:'local:model-fixture',localOnly:true},{name:'flagged-local',localOnly:true},{name:'managed-model'}]});
  const plugin=flow('method');
  const direct=h.ctx._fwpModelState(h.ctx.options,'local:model-fixture');
  assert.equal(direct.stale,false);
  const html=h.ctx._fwpCard(plugin,h.ctx.options,false,{kind:'local:pi',model:'local:model-fixture'});
  assert.match(html,/value="__unselected__" disabled selected/);
  assert.match(html,/value="managed-model"/);
  const modelSelect=html.match(/<select data-fwp-model>[\s\S]*?<\/select>/)[0];
  assert.doesNotMatch(modelSelect,/value="(?:local:|flagged-local)/);
  const state=h.ctx._fwdAgentPickerState(plugin);
  state.state.model='local:model-fixture';
  assert.equal(h.ctx._fwdAgentPickerState(plugin).modelStale,true);
});
