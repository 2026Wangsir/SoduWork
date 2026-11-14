const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const automation = read('components', 'panels', 'work-automation-sheet.js');
const cardState = read('components', 'panels', 'work-automation-card-state.js');
const workEntry = read('components', 'panels', 'work-entry-sheet.js');
const css = read('components', 'panels', 'work-automation-sheet.css');

test('automation is the third built-in conversation work action', () => {
  const actions = [];
  const pluginHost = { registerAction: definition => actions.push(definition) };
  const window = {
    PluginUIHost: pluginHost,
  };
  vm.runInNewContext(automation, { window, PluginUIHost: pluginHost, Intl, setTimeout, clearTimeout });
  assert.equal(actions.length, 1);
  assert.equal(actions[0].id, 'work.automation.create');
  assert.equal(actions[0].command, '自动化');
  assert.deepEqual(
    Array.from(actions[0].aliases),
    ['自动化任务', '定时任务', '定时', '巡检', 'automation'],
  );
  assert.equal(actions[0].priority, 30);
  assert.match(actions[0].description, /Agent/);
});

test('automation form uses the existing commercial schedule contract', () => {
  assert.match(cardState, /A\.listAIAgents/);
  assert.match(cardState, /A\.listRepos/);
  assert.match(automation, /SoduWorkAPI\.preflightSchedule/);
  assert.match(automation, /SoduWorkAPI\.createSchedule/);
  assert.match(automation, /Intl\.DateTimeFormat\(\)\.resolvedOptions\(\)\.timeZone/);
  assert.match(automation, /personalPluginVersionPolicy: method \? 'pinned'/);
  assert.match(automation, /personalPluginChecksum:/);
  assert.match(automation, /requiredCapabilities:/);
  assert.match(automation, /retryDelayMinutes:/);
  assert.match(automation, /pluginInputs:/);
  assert.match(automation, /flow: Boolean\(value\.repoId && value\.flow\)/);
});

test('conversation automation persists an independent model selection', () => {
  assert.match(cardState, /modelOptions/);
  assert.match(cardState, /defaultModel/);
  assert.match(automation, /name="modelName"/);
  assert.match(automation, /const submittedModel = data\.get\('modelName'\)/);
  assert.match(automation, /modelName:\s*value\.modelName/);
});

test('automation sheet translates model selector text on initial render and refresh', () => {
  const translations = {
    '模型': 'Model',
    '可独立选择': 'Choose independently',
    '请选择模型': 'Choose a model',
    '当前没有可用模型': 'No models are available',
    '（已保存，当前不可用）': ' (saved; currently unavailable)',
    '由底座自身管理模型': 'Managed by this runtime',
    '当前底座自行管理模型': 'This runtime manages its model',
    '模型与执行底座独立保存，每次自动化运行使用这里的选择': 'The model is saved independently and each run uses this choice',
  };
  const context = { Intl, setTimeout, clearTimeout, document: { createElement: tag => ({ tagName: tag }) } };
  context.window = context;
  context.SoduWorkI18n = { translateText: value => translations[value] || value };
  const marker = '  global.WorkAutomationSheet = { open, active, refine, close };';
  vm.runInNewContext(cardState + '\n' + automation.replace(marker,
    '  global.probe = { state, modelRows, modelField, refreshModelField };\n' + marker), context);
  const { state, modelRows, modelField, refreshModelField } = context.probe;
  state.agents = [
    { id: 'local:pi', modelPick: true },
    { id: 'local:codex', modelPick: false, nativeModelPick: false },
  ];
  state.modelOptions = [{ name: 'gpt-5', label: 'gpt-5' }];

  const initial = modelField('', 'local:pi');
  assert.match(initial, /value="gpt-5" selected/);
  assert.match(initial, /The model is saved independently and each run uses this choice/);
  assert.doesNotMatch(initial, /请选择模型|模型与执行底座独立保存/);
  assert.match(modelRows('missing-model', 'local:pi'), /value="gpt-5" selected/);
  state.modelOptions = [];
  assert.match(modelRows('missing-model', 'local:pi'), /missing-model \(saved; currently unavailable\)/);
  state.modelOptions = [{ name: 'gpt-5', label: 'gpt-5' }];

  const select = { value: '', options: [], disabled: false, replaceChildren(...options) { this.options = options; } };
  const form = { elements: { modelName: select, assigneeId: { value: 'local:pi' } } };
  state.layer = { querySelector(selector) { return selector === '#wazForm' ? form : null; } };
  refreshModelField();
  assert.equal(select.options[0].textContent, 'gpt-5');
  assert.equal(select.options[0].disabled, false);
  assert.equal(select.value, 'gpt-5');
  assert.equal(select.disabled, false);

  assert.match(modelField('', 'local:codex'), /Managed by this runtime/);
  assert.match(modelField('', 'local:codex'), /This runtime manages its model/);
  assert.doesNotMatch(modelField('', 'local:codex'), /由底座自身管理模型|当前底座自行管理模型/);
  state.modelOptions = [];
  assert.match(modelRows('', 'local:pi'), /No models are available/);
});

test('automation sheet exposes local models for Pi even when modelPick is false', () => {
  const context = { Intl, setTimeout, clearTimeout, document: { createElement: tag => ({ tagName: tag }) } };
  context.window = context;
  const marker = '  global.WorkAutomationSheet = { open, active, refine, close };';
  vm.runInNewContext(cardState + '\n' + automation.replace(marker,
    '  global.probe = { state, modelField };\n' + marker), context);
  const { state, modelField } = context.probe;
  state.agents = [{ id: 'local:pi', cli: 'pi', modelPick: false, nativeModelPick: false }];
  state.modelOptions = [
    { name: 'local:model-abcdefabcdefabcdefabcdefabcdefab', label: 'glm5.2 · 本机', localOnly: true },
    { name: 'managed-model', label: '托管模型' },
  ];
  const field = modelField('', 'local:pi');
  assert.match(field, /local:model-abcdefabcdefabcdefabcdefabcdefab/);
  assert.doesNotMatch(field, /<select[^>]+disabled/);
  assert.doesNotMatch(field, /由底座自身管理模型/);
});

test('automation remains an iterative plugin form inside the conversation', () => {
  assert.match(automation, /PluginUIHost\.mount/);
  assert.match(automation, /PluginUIHost\.checkpointCurrent/);
  assert.match(automation, /async function refineNow/);
  assert.match(automation, /label: '自动化表单'/);
  assert.match(workEntry, /WorkAutomationSheet\.active\(\)/);
  assert.match(workEntry, /WorkAutomationSheet\.refine\(text, options/);
  assert.match(workEntry, /const automation = global\.WorkAutomationSheet/);
  assert.match(workEntry, /automation\.hasSurface\(\).*automation\.close\(silent\)/);
  // Inline sheets follow conversation content; standalone sheets own scrolling, with interaction boundaries covered by Electron tests.
  assert.match(css, /(?:^|\n)\.waz-body\{[^}]*overflow\s*:\s*visible/);
});

test('a requirement can seed the automation form without losing its acceptance contract', () => {
  const detail = read('components', 'requirements', 'requirements-detail.js');
  assert.match(detail, /data-rq-automation/);
  assert.match(detail, /WorkAutomationSheet\.open/);
  assert.match(automation, /fromContext\(s\.proposal \|\| \{\}, s\.bindingContext, context\)/);
  assert.match(automation, /proposalOf\(parsed, directive, prior, instruction, context\)/);
  assert.match(detail, /acceptanceCriteria/);
  assert.match(detail, /sourceRequirement:/);
  assert.match(detail, /requirementVersion:/);
  assert.doesNotMatch(detail, /patchTask\(id, \{ automationScheduleId:/);
});

test('both desktop entrypoints load automation styles and runtime in dependency order', () => {
  for (const name of ['desk.html', 'index.html']) {
    const html = read(name);
    assert.match(html, /work-automation-sheet\.css/);
    assert.match(html, /work-automation-sheet\.js/);
    for (const helper of ['work-automation-bindings.js', 'work-automation-view.js']) {
      assert.ok(html.indexOf(helper) >= 0 && html.indexOf(helper) < html.indexOf('work-automation-sheet.js'));
    }
    assert.ok(
      html.indexOf('plugin-ui-host.js') < html.indexOf('work-automation-sheet.js'),
      name + ' must load PluginUIHost first',
    );
    assert.ok(
      html.indexOf('panels-schedules-methods.js') < html.indexOf('work-automation-sheet.js'),
      name + ' must load schedule methods first',
    );
  }
});

test('automation payload permissions come from explicit choices and the selected method', () => {
  const context = { Intl, setTimeout, clearTimeout }; context.window = context;
  for (const name of ['schedule-timing.js', 'work-automation-bindings.js', 'work-automation-card-state.js']) {
    vm.runInNewContext(read('components', 'panels', name), context);
  }
  const marker = '  global.WorkAutomationSheet = { open, active, refine, close };';
  vm.runInNewContext(cardState + '\n' + automation.replace(marker,
    '  global.probe = { state, proposalOf, bodyOf };\n' + marker), context);
  const { state, proposalOf, bodyOf } = context.probe;
  state.agents = [{ id: 'local:pi', available: true }];
  for (const text of ['输出到桌面上', '用鼠标操作桌面软件', '浏览网页并生成Word报告']) {
    const draft = proposalOf({ title: '自动化', requiredCapabilities: ['computer'] }, text, {});
    assert.deepEqual(Array.from(draft.requiredCapabilities), []);
    assert.deepEqual(Array.from(bodyOf(draft).requiredCapabilities), []);
  }
  state.methods = [{ key: 'report', version: '1', capabilities: { runtime: ['office'] } }];
  const manual = proposalOf({}, '输出到桌面上', {
    personalPluginKey: 'report', requiredCapabilities: ['computer'],
  });
  assert.deepEqual(Array.from(manual.requiredCapabilities), ['computer']);
  assert.deepEqual(Array.from(bodyOf(manual).requiredCapabilities), ['computer', 'office']);
  assert.deepEqual(Array.from(manual.requiredCapabilities), ['computer'], 'derived method permissions stay out of editable choices');
  const model = 'local:model-0123456789abcdef0123456789abcdef';
  state.defaultModels = { pi: model }; state.defaultModelErrors = { pi: 'Deleted local default' };
  state.modelOptions = [{ name: 'managed-alternative' }];
  assert.equal(proposalOf({}, 'Choose the sole available model', {}).modelName, 'managed-alternative');
  assert.equal(proposalOf({ modelName: 'unavailable:default' }, 'Do not persist a UI placeholder', {}).modelName, 'managed-alternative');
  const invalid = proposalOf({}, 'Keep the explicitly saved model', { modelName: model });
  assert.equal(invalid.modelName, 'managed-alternative');
  assert.equal(bodyOf(invalid).modelName, 'managed-alternative');
  state.defaultModelErrors = {}; state.modelOptions.push({ name: model, localOnly: true });
  assert.equal(bodyOf(proposalOf({}, 'Use the configured model', {})).modelName, model);
});

test('automation editor keeps a saved model when the model control is temporarily disabled', () => {
  const context = { Intl, setTimeout, clearTimeout };
  context.window = context;
  for (const name of ['schedule-timing.js', 'work-automation-bindings.js']) {
    vm.runInNewContext(read('components', 'panels', name), context);
  }
  class FakeFormData {
    constructor(form) { this.values = form.values; }
    get(key) { return Object.hasOwn(this.values, key) ? this.values[key] : null; }
  }
  context.FormData = FakeFormData;
  const marker = '  global.WorkAutomationSheet = { open, active, refine, close };';
  vm.runInNewContext(cardState + '\n' + automation.replace(marker,
    '  global.probe = { state, valueFromForm };\n' + marker), context);
  const form = {
    values: {
      title: '自动化', note: '执行说明', every: 'daily', clock: '18:00',
      weekday: '1', assigneeId: 'local:pi', repoId: '', retryLimit: '2',
      retryDelayMinutes: '5', enabled: 'on',
      // Disabled controls are omitted by the browser FormData API.
    },
    querySelectorAll() { return []; },
  };
  context.probe.state.layer = { querySelector(selector) { return selector === '#wazForm' ? form : null; } };
  context.probe.state.proposal = { modelName: 'chosen-model', timeZone: 'Asia/Shanghai' };
  assert.equal(context.probe.valueFromForm().modelName, 'chosen-model');
});

test('rhythm parser reads Chinese clocks and preserves periodic scheduling', () => {
  const window = {};
  vm.runInNewContext(read('components','panels','schedule-timing.js'), {window,Intl});
  const rhythm = (text, previous) => {
    const r = window.ScheduleTiming.infer(text, previous);
    return r.every + ' ' + String(r.atHour).padStart(2, '0') + ':' +
      String(r.atMinute).padStart(2, '0');
  };

  assert.equal(rhythm('每天下午两点十分打卡'), 'daily 14:10');
  assert.equal(rhythm('每天上午九点整开晨会'), 'daily 09:00');
  assert.equal(rhythm('每天晚上十点半写日报'), 'daily 22:30');
  assert.equal(rhythm('每天八点一刻提醒喝水'), 'daily 08:15');
  assert.equal(rhythm('每天二十三点五十分睡觉'), 'daily 23:50');
  assert.equal(rhythm('每天中午十一点半吃饭'), 'daily 11:30');
  assert.equal(rhythm('每周五下午四点开周会'), 'weekly 16:00');
  /* Preserve numeric time parsing. */
  assert.equal(rhythm('每天14:10打卡提醒'), 'daily 14:10');
  assert.equal(rhythm('每天下午14:10打卡'), 'daily 14:10');
  assert.equal(rhythm('每天下午2点10分打卡'), 'daily 14:10');
  assert.equal(rhythm('每小时第10分巡检'), 'hourly 18:10');
  /* Use the default time only when no explicit time is present. */
  assert.equal(rhythm('每天提醒我喝水'), 'daily 18:00');
});
