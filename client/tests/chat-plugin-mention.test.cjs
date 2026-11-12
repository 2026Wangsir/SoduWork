const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('./renderer-source.cjs');
const path = require('node:path');
const vm = require('node:vm');
const mention = require('../components/panels/chat-plugin-mention');

const root = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

test('slash mention only opens at a line start or after whitespace', () => {
  assert.deepEqual(mention.mentionQuery('please use /weekly', 18), {
    start: 11, end: 18, query: 'weekly',
  });
  assert.deepEqual(mention.mentionQuery('/weekly', 7), { start: 0, end: 7, query: 'weekly' });
  /* Do not open slash menus for URLs, Windows paths, or dates; prefixes distinguish plugins, colleagues, and skills. */
  assert.equal(mention.mentionQuery('see https://x.com/a', 19), null);
  assert.equal(mention.mentionQuery('open C:/tools', 13), null);
  assert.equal(mention.mentionQuery('mail a@b.com', 12), null);
  assert.equal(mention.mentionQuery('plain text', 10), null);
  assert.deepEqual(mention.mentionQuery('请总结 /周报', 7), { start: 4, end: 7, query: '周报' });
});

test('conversation plugin picker exposes an explicit open entry without changing the draft', () => {
  // The picker remains an explicit composer action. Acceptance sessions use
  // that same entry and must not render a second plugin sub-card.
  assert.match(read('components/panels/chat-plugin-mention.js'), /openPicker/);
  assert.doesNotMatch(read('components/panels/chat-task-controller.js'), /data-acceptance-plugin-picker/);
  assert.match(read('components/panels/chat-composer-bindings.js'), /_pluginMention\.open/);
});

test('requirement dispatch card no longer exposes the low-value raw-text preview', () => {
  const source = read('components/panels/panels-forward-options.js');
  assert.doesNotMatch(source, /data-act="fwd-preview"|>查看原文</,
    '需求执行卡片不再显示查看原文入口');
});

test('built-in work forms share the slash picker without becoming selected plugins', () => {
  const actions = mention.normalizeActions([{
    id: 'work.requirement.create', command: '/需求', aliases: ['Bug', '工单'],
    name: '沉淀为需求', description: '先进入需求池', icon: '需',
  }, {
    actionId: 'work.task.create', command: '任务', name: '创建任务',
  }]);
  assert.equal(actions.length, 2);
  assert.equal(actions[0].command, '需求');
  assert.equal(actions[0].kind, 'action');
  assert.match(actions[0].searchText, /bug/i);
  assert.equal(actions[1].actionId, 'work.task.create');
  assert.equal(mention.commandText(actions[0], '登录页提交没有反馈'), '/需求 登录页提交没有反馈');
  assert.equal(mention.commandText(null, '普通对话'), '普通对话');
});

test('plugin catalog normalization exposes only the compact conversation picker contract', () => {
  const items = mention.normalizeCatalog({ items: [{
    pluginId: 'p1', key: 'weekly', name: 'Weekly report', icon: 'data:image/png;base64,icon', description: 'Summarize work',
    version: '1.2.0', organizationWide: true, projectCount: 0,
    installed: true,
    workflow: [{ key: 'draft', type: 'ai', name: 'Draft' }], secretRefs: { x: 'hidden' },
  }] });
  assert.equal(items.length, 1);
  assert.equal(items[0].pluginId, 'p1');
  assert.equal(items[0].organizationWide, true);
  assert.equal(items[0].icon, 'data:image/png;base64,icon');
  assert.equal(items[0].template, '');
  const nestedIcon = mention.normalizeCatalog({ items: [{
    pluginId: 'nested', name: 'Nested icon', manifest: { icon: 'data:image/png;base64,nested' },
  }] })[0];
  assert.equal(nestedIcon.icon, 'data:image/png;base64,nested');
  assert.equal('secretRefs' in items[0], false);
  const personal = mention.normalizeCatalog({ items: [{
    pluginId: 'local:p2', name: '我的方法', personal: true, enabled: false,
  }] })[0];
  assert.equal(personal.personal, true);
  assert.equal(personal.enabled, false);
  assert.equal(mention.catalogWarning({ remoteError: 'offline' }), 'offline');
  const unavailable = mention.normalizeCatalog({ items: [{
    pluginId: 'enterprise-uninstalled', name: 'Not installed', installed: false,
    versionId: 'version-1', marketPolicy: { installation: 'self_service' },
  }] });
  assert.equal(unavailable.length, 1);
  assert.equal(unavailable[0].versionId, 'version-1');
  assert.equal(unavailable[0].conversationUse.code, 'install_required');
  const apps = mention.normalizeCatalog({ items: [
    { pluginId: 'app-1', key: 'todo-workbench', name: '待办工作台', template: 'app', ui: { contributions: [] } },
    { pluginId: 'legacy-app-1', key: 'legacy-workbench', name: '旧版待办工作台', ui: { contributions: [
      { id: 'main', slot: 'workspace.navigation', source: { type: 'external', url: 'https://example.invalid/app' } },
    ] } },
    { pluginId: 'plugin-1', key: 'todo-helper', name: '待办插件', template: 'plugin', installed: true },
  ] });
  assert.deepEqual(apps.map(item => item.pluginId), ['plugin-1'],
    '应用模板或旧版 workspace.navigation 应用不能进入仅插件的对话起手式');
  assert.equal(apps[0].template, 'plugin');
  const pendingUpgrade = mention.normalizeCatalog({ items: [{
    pluginId: 'enterprise-update', name: 'Needs update',
    installed: true, updateAvailable: true,
  }] });
  assert.equal(pendingUpgrade.length, 1);
  assert.equal(pendingUpgrade[0].enabled, true);
  assert.equal(pendingUpgrade[0].conversationUse.available, true);
  assert.equal(pendingUpgrade[0].updateAvailable, true);
  assert.equal(mention.catalogWarning({ items: [] }), '');
});

test('all installed plugin shapes expose a truthful conversation state', () => {
  const items = mention.normalizeCatalog({ items: [{
    pluginId: 'workflow', name: 'Release flow', installed: true,
    organizationWide: true, entrypoints: { conversation: true },
    workflow: [{ key: 'build', type: 'ai', name: 'Build' }],
    capabilities: { hasWorkflow: true, executionMode: 'workflow', skills: ['review'] },
    conversationUse: { available: true, code: 'ready', label: 'Ready' },
  }, {
    pluginId: 'connector', name: 'GitLab helper', installed: true,
    organizationWide: true, capabilities: { mcpServers: ['gitlab'] },
    conversationUse: { available: true, code: 'ready', label: 'Ready' },
  }, {
    pluginId: 'task-only', name: 'Production deploy', installed: true,
    entrypoints: { conversation: false },
    conversationUse: { available: false, code: 'entrypoint_disabled', label: 'Task only' },
  }, {
    pluginId: 'scoped', name: 'Project delivery', installed: true, projectCount: 2,
    conversationUse: {
      available: false, code: 'project_required', label: 'Choose project',
      requiresProject: true,
    },
  }] });
  const byId = Object.fromEntries(items.map((item) => [item.pluginId, item]));
  assert.equal(byId.workflow.kind, 'workflow');
  assert.equal(byId.connector.kind, 'connector');
  assert.match(byId.connector.searchText, /gitlab/);
  assert.equal(mention.availability(byId['task-only'], '').available, false);
  assert.equal(mention.availability(byId.scoped, '').available, false);
  assert.equal(mention.availability(byId.scoped, 'project-1').available, true);
  assert.equal(mention.availability(byId.scoped, 'project-1').code, 'ready_for_project');
});

test('only preflight plugin grant failures are marked safe to restore', () => {
  assert.equal(mention.retryableGrantFailure({
    kind: 'error', failureKind: 'plugin-grant', retrySafe: true, submissionId: 'ui-1',
  }), true);
  assert.equal(mention.retryableGrantFailure({
    kind: 'error', failureKind: 'runtime', retrySafe: true, submissionId: 'ui-2',
  }), false);
  assert.equal(mention.retryableGrantFailure({
    kind: 'error', failureKind: 'plugin-grant', retrySafe: false, submissionId: 'ui-3',
  }), false);
});

test('desktop chat sends a display-safe selection and leaves trusted resolution to main process', () => {
  const desk = read('desk.html');
  const chat = read('components', 'panels', 'panels-chat.js');
  const api = read('api.js');
  assert.match(desk, /chat-plugin-mention\.css/);
  assert.match(desk, /chat-plugin-mention\.js/);
  assert.match(chat, /ChatPluginMention\.create/);
  assert.match(chat, /ComposeSkills\.create/);
  assert.match(chat, /(?:ctx\.)?_loadChatSkills/);
  assert.match(read('components', 'panels', 'chat-plugin-mention.js'), /SoduWorkPluginIcon/);
  assert.match(read('components', 'panels', 'panels-compose-skills.js'), /SoduWorkPluginIcon\.image/);
  assert.match(chat, /(?:ctx\.)?_pluginResolveBusy/);
  assert.match(chat, /sendEpoch !== (?:ctx\.)?_viewEpoch/);
  assert.match(read('components', 'panels', 'chat-plugin-mention.js'), /event\.isComposing/);
  assert.match(read('components', 'panels', 'chat-plugin-mention.js'), /async select\(pluginId(?:, isCurrent)?(?:, options)?\)/);
  assert.match(read('components', 'panels', 'chat-plugin-mention.js'), /actions\.find\(\(row\) => row\.actionId === key\)/);
  assert.match(read('components', 'panels', 'chat-plugin-mention.js'), /selectedAction = action/);
  assert.match(read('components', 'panels', 'chat-plugin-mention.js'), /企业插件暂时不可用，个人插件仍可使用/);
  assert.match(read('components', 'panels', 'chat-plugin-mention.js'), /Electron main[\s\S]*queue head/);
  assert.match(read('components', 'panels', 'chat-plugin-mention.js'), /openInline/);
  assert.match(read('components', 'panels', 'chat-plugin-mention.js'), /dataset\.installable/);
  assert.match(read('components', 'panels', 'chat-plugin-mention.js'), /work\.plugin\.create/);
  assert.match(chat, /const submissionRef = retainedRef \|\| (?:ctx\.)?_ref/);
  assert.match(chat, /api\.send\(submissionRef, text, attachmentRefs, \{\s*plugins: resolvedPlugins,\s*sentAt,\s*projectId:[\s\S]*submissionId/);
  assert.match(chat, /data-plugin-retry/);
  assert.match(chat, /(?:ctx\.)?_submissionDrafts/);
  assert.doesNotMatch(chat, /SoduWorkAPI\.resolveConversationPlugins/);
  assert.match(api, /resolveConversationPlugins\(pluginIds, projectId, conversationId\)/);
});

test('custom plugin icons are parsed into DOM nodes before appendChild', () => {
  const picker = read('components', 'panels', 'chat-plugin-mention.js');
  assert.match(picker, /function appendPluginIcon\(target, markup\)/);
  assert.match(picker, /template\.content && template\.content\.firstElementChild/);
  assert.match(picker, /appendPluginIcon\(mark, custom\)/);
  assert.match(picker, /appendPluginIcon\(icon, custom\)/);
  assert.doesNotMatch(picker, /mark\.appendChild\(custom\)/);
  assert.doesNotMatch(picker, /icon\.appendChild\(custom\)/);
});

test('all plugin chooser surfaces use the shared artwork resolver', () => {
  const compose = read('components', 'panels', 'panels-compose.js');
  const css = read('components', 'panels', 'work-composer.css');
  const picker = read('components', 'panels', 'chat-plugin-mention.js');
  const shared = read('components', 'panels', 'work-composer.js');
  assert.match(compose, /WorkComposer\.pluginRows\(/);
  assert.match(shared, /icons\?\.markup\?\.\(item\)/);
  assert.match(picker, /typeof icons\.markup === 'function'/);
  assert.match(picker, /item\.name\.slice\(0, 1\)/);
  assert.match(css, /wc-plugin-icon \.cap-plugin-custom-icon/);
  assert.match(shared, /icons\?\.imageFor\?\.\(item\) \|\| ICONS\.ability/);
});

test('retry restores a plugin identity even before the picker catalog is ready', () => {
  const picker = read('components', 'panels', 'chat-plugin-mention.js');
  assert.match(picker, /function reconcileSelection\(payload\)/);
  assert.match(picker, /conversationUse: \{ available: true, code: 'restored'/);
  assert.match(picker, /selected = catalog\.filter\(\(item\) => ids\.has\(item\.pluginId\)\)/);
  assert.match(picker, /const catalogHasAll = \[\.\.\.ids\]\.every/);
  assert.match(picker, /selected = selected\.filter\(item => !missing\.has\(item\.pluginId\)\)\.map/);
  assert.match(picker, /payload\.personalComplete === true/);
  assert.match(picker, /let loadTask = null/);
  assert.match(picker, /if \(loading\) return loadTask \|\| undefined/);
  assert.match(picker, /loadTask = task/);
  assert.match(picker, /async select\(pluginId, isCurrent, options\)/);
  assert.match(picker, /const current = typeof isCurrent === 'function'/);
});
test('new composer routes picked work action capsules while preserving literal slash body text', () => {
  const compose = read('components', 'panels', 'panels-compose.js');
  const chat = read('components', 'panels', 'panels-chat.js');
  const picker = read('components', 'panels', 'chat-plugin-mention.js');
  const workActions = read('components', 'panels', 'panels-compose-work-actions.js');
  const chatActions = read('components', 'panels', 'panels-chat-work-actions.js');
  const desk = read('desk.html');
  assert.match(compose, /ChatPluginMention\.create/);
  assert.match(compose, /actions: \(\) => global\.PluginUIHost/);
  assert.match(picker, /let selectedAction = null/);
  assert.match(picker, /function selectAction\(item\)/);
  assert.match(picker, /chip\.className = 'nplugin-chip' \+ \(action \? ' is-action' : ''\)/);
  assert.match(picker, /commandText: value => commandText\(selectedAction, value\)/);
  assert.match(picker, /clearAction\(\)/);
  assert.doesNotMatch(compose + chat, /onAction:\s*\(id\)/);
  assert.match(chatActions, /async function route\(/);
  assert.match(chat, /function (?:ctx\.)?_workModel\(\)/);
  assert.match(chat, /open: (?:ctx\.)?_openWorkAction, model: (?:ctx\.)?_workModel,[\s\S]{0,100}conversationContext: (?:ctx\.)?_workConversationContext/);
  assert.match(compose, /ComposeWorkActions\.route\(/);
  assert.match(workActions, /NativeChat\.openWorkAction\(command/);
  assert.match(desk, /panels-compose-work-actions\.js/);
  assert.match(chat, /openWorkAction: (?:ctx\.)?_openWorkAction/);
  assert.match(compose + chat + chatActions, /clearAction\(\)/);
  assert.match(compose, /await (?:ctx\.)?_pluginMention\.resolve/);
  assert.doesNotMatch(compose, /SoduWorkAPI\.resolveConversationPlugins/);
  assert.match(compose, /initialPlugins/);
  assert.match(chat, /delete launchOptions\.initialPlugins/);
  assert.match(chat, /(?:ctx\.)?_send\(first,\s*\{\s*plugins: initialPlugins,\s*skills: initialSkills,\s*attachments: Array\.isArray\(_sessionOptions\.attachments\) \? _sessionOptions\.attachments : \[\],?\s*\}\)/,
    'first-turn handoff preserves both plugin/skill selections and compose-stage attachments');
  const scope = {}; scope.window = scope;
  vm.runInNewContext(read('components', 'panels', 'plugin-ui-host.js'), scope);
  scope.PluginUIHost.registerAction({ id: 'work.requirement.create', command: '需求', open() {} });
  const body = '/自动化 是原文中的例子，实际记录这个需求。';
  assert.equal(scope.PluginUIHost.commandFromSelection(null, body), null,
    'slash text alone cannot select a work action');
  const command = scope.PluginUIHost.commandFromSelection({ actionId: 'work.requirement.create' }, body);
  assert.equal(command.id, 'work.requirement.create');
  assert.equal(command.text, body, 'picker metadata chooses the action without rewriting its body');
});

test('conversation picker keeps the full catalog available for scrolling and search', () => {
  const picker = read('components', 'panels', 'chat-plugin-mention.js');
  const css = read('components', 'panels', 'chat-plugin-mention.css');
  assert.doesNotMatch(picker, /\.slice\(0, 8\)/);
  assert.match(css, /\.nplugin-menu[\s\S]*overflow:auto/);
  assert.match(css, /\.nplugin-menu\{position:fixed/,
    'the picker must escape clipped composer containers');
  assert.match(picker, /function positionMenu\(\)/,
    'the picker must position itself against the viewport before opening');
});

test('plugin mutations invalidate every open conversation picker', () => {
  const api = read('api.js');
  const picker = read('components', 'panels', 'chat-plugin-mention.js');
  assert.match(api, /CustomEvent\('soduwork:plugins-changed'/);
  assert.match(api, /createPluginDraft[\s\S]*pluginsChanged/);
  assert.match(api, /setEnterprisePluginInstalled[\s\S]*pluginsChanged/);
  assert.match(picker, /addEventListener\('soduwork:plugins-changed'/);
  assert.match(picker, /removeEventListener\('soduwork:plugins-changed'/);
  assert.match(picker, /input\.ownerDocument[\s\S]*defaultView/);
  assert.doesNotMatch(picker, /\bglobal\.(?:add|remove)EventListener/);
});

test('programmatic select keeps the entry prefill that openComposePanel just wrote', () => {
  const source = read('components', 'panels', 'chat-plugin-mention.js');
  const compose = read('components', 'panels', 'panels-compose.js');


  assert.match(source, /async select\(pluginId, isCurrent, options\)/);
  assert.match(source, /const keepText = Boolean\(options && options\.keepText\)/);
  const selectBody = source.slice(source.indexOf('async select('), source.indexOf('restore(items)'));
  assert.equal(
    (selectBody.match(/if \(!keepText\) \{\s*input\.value = '';/g) || []).length, 2,
    'both action branches must honour keepText');
  assert.match(compose, /(?:ctx\.)?_pluginMention\.select\(String\(q\.pluginId\), \(\) => selectionSeq === (?:ctx\.)?_pluginSelectSeq, \{ keepText: true \}\)/);
  /* Add-menu selection preserves text; explicit slash-query selection consumes its query. */
  assert.match(compose, /const current = ctx\.menuSelectionGuard\(\)/);
  assert.match(compose, /await (?:ctx\.)?_pluginMention\.select\(button\.dataset\.morePlugin, current, \{ keepText: true \}\)/);
});
