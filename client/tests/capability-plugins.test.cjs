'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('./renderer-source.cjs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('插件成为能力中心默认入口并在两个 Electron 页面完整加载', () => {
  const panel = read('components/panels/panels-capabilities.js');
  const index = read('index.html');
  const desk = read('desk.html');
  assert.match(panel, /let tab = 'plugins'/);
  assert.match(panel, /导入插件/);
  assert.match(panel, /\u5236\u4f5c\u63d2\u4ef6/);
  for (const key of ['plugins', 'connections', 'skills', 'market']) {
    assert.match(panel, new RegExp("tabButton\\('" + key + "'"));
  }
  assert.doesNotMatch(panel, /tabButton\('apps'/);
  assert.doesNotMatch(panel, /tabButton\('mcp'/);
  for (const html of [index, desk]) {
    assert.match(html, /panels-capability-plugins\.css/);
    assert.match(html, /panels-capability-plugins\.js/);
    assert.match(html, /panels-capability-directory\.js/);
    assert.match(html, /plugin-route-directory\.js/);
    assert.match(html, /plugin-dependency-ux\.js/);
    assert.match(html, /plugin-publication-ux\.js/);
    assert.match(html, /plugin-catalog-format\.js/);
    assert.ok(html.indexOf('plugin-publication-ux.js') <
      html.indexOf('panels-capability-plugins.js'));
    assert.ok(html.indexOf('plugin-dependency-ux.js') <
      html.indexOf('panels-capability-plugins.js'));
    assert.ok(html.indexOf('plugin-route-directory.js') <
      html.indexOf('panels-plugin-maker.js'));
    assert.ok(html.indexOf('plugin-route-directory.js') <
      html.indexOf('panels-forward-plugin.js'));
    assert.ok(html.indexOf('panels-capability-plugins.js') <
      html.indexOf('panels-capability-directory.js'));
    assert.ok(html.indexOf('panels-capability-directory.js') <
      html.indexOf('panels-capabilities.js'));
  }
});

test('插件详情保留能力包、Skill、连接器、可选工作流与 Runner 的关系', () => {
  const source = read('components/panels/plugin-dependency-ux.js') +
    read('components/panels/plugin-catalog-format.js') +
    read('components/panels/plugin-publication-ux.js') +
    read('components/panels/panels-capability-plugins.js') +
    read('components/panels/panels-plugin-maker.js');
  assert.match(source, /包含的 Skill/);
  assert.match(source, /依赖的连接器/);
  assert.match(source, /cap\.hasWorkflow !== false/);
  assert.match(source, /能力包内容/);
  assert.match(source, /权限与风险/);
  assert.match(source, /Skill/);
  assert.match(source, /连接器/);
  assert.match(source, /工作流/);
  assert.match(source, /Runner/);
  assert.match(source, /需要的执行能力/);
  assert.match(source, /data-runtime="browser"/);
  assert.match(source, /data-runtime="computer"/);
  assert.doesNotMatch(read('components/panels/panels-plugin-maker.js'), /data-runtime="office"/);
  assert.match(source, /代表性评测试题/);
  assert.match(source, /验收标准/);
  assert.match(source, /发布质量/);
  assert.match(source, /quality\.verified/);
  assert.match(source, /已验证/);
  assert.match(source, /Codex/);
  assert.match(source, /Claude Code/);
  assert.match(source, /\/ 快速使用/);
  assert.match(source, /完整审批与发布仍从需求启动/);
  assert.match(source, /从项目需求使用/);
});

test('第三方包先安装为个人插件，确认后再显式上传企业', () => {
  const source = read('components/panels/panels-capability-plugins.js');
  const publication = read('components/panels/plugin-publication-ux.js');
  const api = read('api.js');
  const maker = read('components/panels/panels-plugin-maker.js');
  const routes = read('components/panels/plugin-route-directory.js');
  assert.match(source, /SoduWorkPluginMakerUtils\.choosePackage\(SoduWorkAPI/);
  assert.match(read('components/panels/panels-plugin-maker-utils.js'), /api\.preflightPlugin\(file\)/);
  assert.match(source, /preview\.personalDraft/);
  assert.match(source, /SoduWorkAPI\.createPluginDraft\(personalDraft\)/);
  assert.match(source, /安装并试用只保存在本机/);
  assert.match(source, /安装不会执行脚本；未适配的第三方组件不会启用/);
  assert.match(source, /SoduWorkAPI\.submitPlugin\(file\)/);
  assert.match(source, /capUploadSubmit/);
  assert.match(source, /平台隔离区/);
  assert.match(maker, /templateButton\('method'/);
  assert.match(maker, /templateButton\('connector'/);
  assert.match(maker, /templateButton\('workflow'/);
  assert.match(maker, /capMakerStandalone/);
  assert.match(maker, /standaloneNodes/);
  assert.match(api, /uploadFile\('\/plugins\/preflight'/);
  assert.match(api, /publishPersonalPlugin/);
  assert.match(maker, /SoduWorkAPI\.preflightPluginDraft/);
  assert.match(maker, /生成预检/);
  assert.match(maker, /capPluginVersion/);
  assert.match(maker, /安装并试用/);
  assert.match(source, /仅自己可用/);
  assert.match(source, /编辑新版本/);
  assert.match(maker, /需求公开参数/);
  assert.match(maker, /旧版本和既有需求记录保持不变/);
  assert.match(maker, /保存新版本/);
  assert.match(maker, /让 SoduWork 帮你起草/);
  assert.match(maker, /SoduWorkAPI\.listAIAgents/);
  assert.match(maker, /onlineSeats/);
  assert.match(maker, /capMakerModels/);
  assert.match(maker, /SoduWorkPluginRoutes/);
  assert.match(routes, /isPortableAgentKind/);
  assert.match(routes, /onlineSeats/);
  assert.match(source, /上传到企业/);
  assert.match(publication, /指定人员/);
  assert.match(publication, /signed\.identity/);
  assert.match(publication, /一键登记发布身份/);
  assert.match(api, /publisher: publisher \|\| \{\}/);
  assert.match(source, /openPersonalDelete/);
  assert.match(source, /已经上传到企业、正在运行的需求与历史记录不会受影响/);
  assert.doesNotMatch(source, /window\.confirm/);
  assert.match(source, /openLocalImport/);
  assert.match(api, /pluginAudienceCandidates/);
  assert.match(api, /publishPersonalPlugin/);
  assert.match(api, /bridge\.preflight/);
  assert.match(api, /bridge\.create/);
  assert.match(api, /jfetch\('\/plugins\/drafts\/signing-payload'/);
  assert.doesNotMatch(api, /jfetch\('\/plugins\/drafts',/);
});

test('插件作者能看到从隔离入库到企业目录的真实发布进度', () => {
  const source = read('components/panels/plugin-publication-ux.js') +
    read('components/panels/panels-capability-plugins.js');
  const css = read('components/panels/panels-capability-plugins.css');
  for (const label of [
    '隔离入库', '发布身份', '发布评测', '管理员审核', '企业目录',
  ]) {
    assert.match(source, new RegExp(label));
  }
  assert.match(source, /qualitySummary/);
  assert.match(source, /catalogReady/);
  assert.match(source, /function progress/);
  assert.match(source, /function currentStep/);
  assert.match(source, /当前节点/);
  assert.match(source, /管理员已确认无代表性评测的风险/);
  assert.match(css, /\.cap-publication-progress/);
  assert.match(css, /\.cap-publication-current/);
  assert.match(css, /\.cap-submission-stage/);
});

test('应用类插件从插件列表、计数与市场中隐藏，只能从应用菜单进入', async () => {
  const sandbox = { window: { addEventListener() {} } };
  vm.runInNewContext(read('components/panels/plugin-catalog-format.js'), sandbox);
  vm.runInNewContext(read('components/panels/plugin-presentation.js'), sandbox);
  sandbox.SoduWorkAPI = { pluginCatalog: async () => catalog };
  vm.runInNewContext(read('components/panels/panels-capability-plugins.js'), sandbox);
  const plugins = sandbox.window.SoduWorkCapabilityPlugins;
  const external = { type: 'external', url: 'https://example.invalid/' };
  const catalog = { items: [
    { pluginId: 'plain', installed: true, name: '普通插件', capabilities: {} },
    { pluginId: 'app-one', installed: true, name: '应用插件',
      ui: { contributions: [{ id: 'main', slot: 'workspace.navigation', source: external }] } },
    { pluginId: 'market-app', name: '市场应用', listed: true,
      ui: { contributions: [{ slot: 'workspace.navigation', source: external }] } },
    { pluginId: 'market-plain', name: '市场插件', listed: true, capabilities: {} },
  ] };
  await plugins.load();
  assert.deepEqual(plugins.marketItems().map(item => item.pluginId), ['plain', 'market-plain'],
    '已安装且上架的普通插件留在市场，应用类插件被隐藏');
  assert.equal(plugins.marketCount(), 2);
  assert.equal(plugins.managedCount(), 1, '应用类插件不占插件 tab 计数');
  assert.equal(plugins.count(), 2, '应用类插件不占目录总数');
});

test('插件发布当前节点优先显示阻断或等待项，不把完成进度误报成可用', () => {
  const sandbox = { window: {} };
  vm.runInNewContext(read('components/panels/plugin-publication-ux.js'), sandbox);
  const publication = sandbox.window.SoduWorkPluginPublication;
  assert.equal(publication.currentStep({ reviewDecision: 'reject' }).label, '管理员审核');
  assert.equal(publication.currentStep({ trustState: 'pending' }).label, '发布身份');
  assert.equal(publication.currentStep({ trustState: 'approved', enabled: true,
    catalogReady: true, provenance: { signatureState: 'verified' },
    qualitySummary: { verified: true, caseCount: 1 } }).label, '企业目录');
});

test('企业插件由员工显式安装、升级和停用后才进入普通对话工具箱', () => {
  const publication = read('components/panels/plugin-publication-ux.js');
  const source = read('components/panels/plugin-dependency-ux.js') +
    read('components/panels/panels-capability-plugins.js') +
    read('components/panels/plugin-install-setup.js');
  const css = read('components/panels/panels-capability-plugins.css');
  const mention = read('components/panels/chat-plugin-mention.js');
  const api = read('api.js');
  assert.match(source, /可安装/);
  assert.match(source, /有更新/);
  assert.match(source, /setEnterprisePluginInstalled/);
  assert.match(source, /item\.versionId/);
  assert.match(source, /SoduWorkPluginPublication\.openUpgrade/);
  assert.match(source, /企业需求和自动化不受影响/);
  assert.match(css, /\.cap-plugin-install-state/);
  assert.match(css, /\.cap-upgrade-level\.breaking/);
  assert.match(css, /\.cap-upgrade-confirm/);
  assert.match(mention, /item\.pluginId\);/);
  assert.match(api, /\/plugins\/.*\/installation/);
  assert.match(api, /expectedVersionId/);
  assert.match(publication, /upgradeImpact/);
  assert.match(publication, /破坏性变化/);
  assert.match(publication, /capUpgradeConsent/);
  assert.match(publication, /同意将个人工具箱升级到这个不可变版本/);
  assert.match(source, /installed_by_default/);
  assert.match(source, /not_available/);
  assert.match(source, /受控需求专用/);
  assert.match(source, /dependencyReadiness/);
  assert.match(source, /missingMcp/);
  assert.match(source, /企业连接未就绪/);
  assert.match(source, /安装前必须恢复连接/);
  assert.match(source, /可以先安装，调用前必须恢复连接/);
  assert.match(source, /插件不会降级为提示词假装成功/);
  assert.match(source, /capCopyMissingMcp/);
  assert.match(source, /item\.conversationUse\.available/);
  assert.match(source, /const canTry = platformReady && !taskOnly && !isBuilder && item\.enabled !== false/);
  assert.match(css, /\.cap-dependency-blocker/);
  assert.match(css, /\.cap-plugin-install-state\.blocked/);
  assert.match(css, /\.cap-plugin-install-state\.degraded/);
  assert.match(css, /\.cap-plugin-install-state\.task_only/);
});

test('插件、连接器和基础能力使用紧凑、响应式、低干扰目录', () => {
  const pluginCss = read('components/panels/panels-capability-plugins.css');
  const pluginJs = read('components/panels/panels-capability-plugins.js');
  const catalogCss = read('components/panels/panels-capabilities.css');
  const directory = read('components/panels/panels-capability-directory.js');
  assert.match(pluginCss, /\.cap-plugin-grid\{display:grid;grid-template-columns:repeat\(2/);
  assert.match(pluginCss, /min-height:86px/);
  assert.match(pluginCss, /\.cap-plugin-side/);
  assert.match(pluginJs, /global\.SoduWorkPluginPresentation/);
  assert.match(pluginJs, /presentation\.libraryModel/);
  assert.doesNotMatch(pluginJs, /function installedShelf|发现更多企业能力/);
  assert.match(pluginJs, /toneClass/);
  assert.match(pluginCss, /max-width:1280px/);
  assert.match(pluginCss, /\.cap-plugin-quality/);
  assert.match(catalogCss, /\.cap-toolbar-inner/);
  assert.match(catalogCss, /\.cap-tab-market \.cap-category-filters/,
    '市场筛选条必须使用与其他标签页相同的阅读宽度');
  assert.match(catalogCss, /\.cap-tab-market \.cap-market-list/,
    '市场内容列表必须使用与其他标签页相同的阅读宽度');
  assert.doesNotMatch(catalogCss, /\.cap-tab-market>\.cap-(?:category-filters|market-list)/,
    '市场宽度规则不能只匹配错误的直接子节点');
  assert.doesNotMatch(pluginCss, /min-height:170px/);
  assert.match(pluginCss, /@media\(max-width:720px\)/);
  assert.match(catalogCss, /min-height:76px/);
  assert.match(catalogCss, /\.cap-mcp-list\{display:grid/);
  assert.match(catalogCss, /\.cap-directory-list/);
  assert.match(catalogCss, /:focus-visible/);
  assert.match(directory, /ctx\.mcp/);
  assert.match(directory, /ctx\.catalog/);
  assert.doesNotMatch(directory, /fetch\(/);
  assert.match(directory, /Codex 兼容/);
  assert.match(directory, /Claude Code 兼容/);
  assert.match(directory, /发现企业已发布的插件，查看详情后按需安装。/);
  assert.doesNotMatch(pluginCss, /linear-gradient\(145deg/);
});

test('员工技能目录只展示当前可用或可立即同步的工作方法', () => {
  const shell = read('components/panels/panels-capabilities.js');
  const css = read('components/panels/panels-capabilities.css');
  assert.match(shell, /filter\(skillSelectable\)\.filter\(matches\)/);
  assert.doesNotMatch(shell, /blocked\.map\(skillCard\)|暂不可用|classList\.contains\('blocked'\)/);
  assert.doesNotMatch(css, /cap-blocked-section|cap-blocked-head|cap-blocked-body/);
});

test('插件管理与企业市场各自承担一个清晰需求', () => {
  const shell = read('components/panels/panels-capabilities.js');
  const plugins = read('components/panels/panels-capability-plugins.js');
  const directory = read('components/panels/panels-capability-directory.js');
  assert.match(shell, /SoduWorkCapabilityPlugins\.managedCount/);
  assert.match(shell, /SoduWorkCapabilityPlugins\.marketCount/);
  assert.match(plugins, /企业插件/);
  assert.match(plugins, /item\.qualifiedKey/);
  assert.match(plugins, /item\.personal \|\| item\.installed/);
  assert.match(read('components/panels/plugin-presentation.js'), /浏览市场/);
  assert.match(plugins, /ctx\.openMarket/);
  assert.match(directory, /filter\(item =>[\s\S]*!item\.personal && item\.listed !== false && \!\(isWorkspaceApp && isWorkspaceApp\(item\)\)\)/,
    '市场列表过滤下架项与应用类插件');
  assert.match(directory, /!\(isWorkspaceApp && isWorkspaceApp\(item\)\)\)\.length/, '市场计数同样排除应用类插件');
  assert.match(directory, /自动化流程/);
  assert.match(directory, /业务连接/);
  assert.match(directory, /专业方法/);
  assert.match(directory, /data-cap-market-open/);
  assert.match(directory, /ctx\.onOpenPlugin/);
  assert.doesNotMatch(directory, /目录来源/);
  assert.match(directory, /marketPolicy/);
  assert.match(directory, /需求专用/);
  assert.match(directory, /企业默认/);
});
test('插件开发助手从详情和制作页进入统一的新建导航', () => {
  const catalog = read('components/panels/panels-capabilities.js');
  const plugins = read('components/panels/panels-capability-plugins.js');
  assert.match(catalog, /WorkspaceHost\.open\('create', payload\)/);
  assert.match(catalog, /pluginId: 'local:plugin-builder'/);
  assert.match(plugins, /id="capBuilderStart">开始制作/);
  assert.match(plugins, /ctx\.createWithAgent\(\)/);
});

test('task handoff only shows approved, runnable methods and current-device agents', () => {
  const source = read('components/panels/panels-forward-plugin.js');
  const options = read('components/panels/panels-forward-options.js');
  const picker = read('components/panels/panels-forward-picker.js');
  const css = read('components/panels/panels-forward-plugin.css');
  assert.match(source, /data-fwp-mode/);
  assert.match(source, /fwp-direct-use/);
  assert.match(source, /capabilitySets/);
  assert.match(source, /function _fwpReady/);
  assert.match(source, /plugin\.runnable === false \|\| blockers\.length/);
  assert.match(source, /plugin\.runnable !== false && autoReady/);
  assert.match(source, /requirements\.every\(required/);
  assert.match(source, /data-fwp-ready/);
  assert.doesNotMatch(source, /SoduWorkPluginRoutes/);
  assert.doesNotMatch(source, /runner:/);
  assert.match(source, /data-fwp-model/);
  assert.match(source, /execution: \(kind \|\| model\)/);
  assert.match(source, /fwp-input-note/);
  assert.match(source, /function _fwpPayload/);
  assert.match(options, /taskExecutionOptions\(\{ taskId: tid/);
  assert.match(options, /\['workflows', 'blockedWorkflows'\]/);
  assert.match(options, /\.filter\(_fwdInstalledMethod\)/);
  assert.match(options, /_fwdRenderAIPickers\(tid, box\)/);
  assert.match(picker, /_fwpBind\(tid, box, null, _fwdOptions\)/);
  assert.match(picker, /id="fwdPluginSelect"/);
  assert.match(picker, /id="fwdAgentSelect"/);
  assert.match(picker, /默认不用插件，可选择内置或已安装的插件/);
  assert.doesNotMatch(picker, /暂无可选插件，可以直接交给 Agent 执行/);
  assert.match(picker, /const ready = _fwpReady\(plugin, _fwdOptions\)/);
  assert.match(picker, /_fwdPickerOption\(plugin\.bindingId, _fwdLocalizedLabel\(parts\), selectedId, !ready, parts\)/);
  assert.match(options, /TaskPluginInput\.start\(tid/);
  assert.match(picker, /agentReason/);
  assert.match(css, /\.fwp-direct-use/);
  assert.match(css, /\.fwp-runtime/);
  assert.match(css, /\.fwp-model/);
  assert.match(source, /单 Agent 能力/);
  assert.match(source, /按这套企业方法完成当前需求，并保留结果与证据/);
  assert.match(source, /选择工作方法/);
  assert.match(source, /plugin\.runnable !== false/);
  assert.match(source, /data-fwp-ready/);
  assert.doesNotMatch(source, /SoduWorkPluginRoutes/);
  assert.doesNotMatch(source, /const _FWP_CLI/);
  assert.match(source, /data-fwp-model/);
  assert.match(source, /data-fwp-kind/);
  assert.match(source, /当前设备没有满足节点要求的 Agent/);
  assert.match(source, /execution: \(kind \|\| model\)/);
  assert.match(source, /function _fwpSyncModel/);
  assert.match(source, /model\.disabled = !allowed/);
  assert.match(source, /if \(!allowed\) model\.value = ''/);
  assert.match(css, /\.fwp-direct-use/);
  assert.match(css, /\.fwp-readiness\.is-blocked/);
  assert.match(css, /\.fwp-runtime/);
  assert.match(css, /\.fwp-step small/);
});

test('plugin authoring and imports enter a real trial immediately after install', () => {
  const maker = read('components/panels/panels-plugin-maker.js');
  const plugins = read('components/panels/panels-capability-plugins.js');
  const installer = read('components/panels/plugin-install-setup.js');
  assert.match(maker, /createPluginDraft\(body\)[\s\S]*ctx\.tryPlugin\(result\.plugin\)/);
  assert.match(maker, /安装并试用/);
  assert.match(plugins, /createPluginDraft\(body\)[\s\S]*ctx\.tryPlugin\(result\.plugin\)/);
  assert.match(plugins,
    /createPluginDraft\(personalDraft\)[\s\S]*ctx\.tryPlugin\(result\.plugin\)/);
  assert.match(plugins, /id="capLocalInstall">'[\s\S]*application \? '安装并打开' : '安装并试用'/);
  assert.match(plugins, /id="capUploadDo"[\s\S]*安装并试用/);
  assert.match(installer,
    /setEnterprisePluginInstalled[\s\S]*entrypoints\.conversation !== false[\s\S]*ctx\.tryPlugin\(item\)/);
  assert.match(installer, /entrypoints\.conversation !== false/);
  assert.match(installer, /item\.marketPolicy\.installation !== 'not_available'/);
  assert.doesNotMatch(installer, /item\.organizationWide \|\| Number\(item\.projectCount \|\| 0\) === 1/);
});

test('办公文件交付不暴露 Office 技术项也不触发额外授权', () => {
  const maker = read('components/panels/panels-plugin-maker.js');
  assert.doesNotMatch(maker, /data-runtime="office"|申请授权/);
  assert.match(maker, /Word、Excel、PPT 等交付按输出格式生成/);
});

test('插件详情保留开源许可证与上游来源，卡片不堆叠治理徽章', () => {
  const panel = read('components/panels/panels-capability-plugins.js');
  const css = read('components/panels/panels-capability-plugins.css');
  assert.match(panel, /openSource\.license/);
  assert.match(panel, /开源适配/);
  assert.match(panel, /openSource\.repository/);
  assert.match(css, /cap-plugin-quality\.is-open-source/);
  const card = panel.slice(panel.indexOf('function card('), panel.indexOf('function render('));
  assert.doesNotMatch(card, /qualityBadge|openSourceBadge/);
});

test('企业提交按轻审核显示三步，缺少评测不伪装成发布阻断', () => {
  const sandbox = { window: {} };
  vm.runInNewContext(read('components/panels/plugin-publication-ux.js'), sandbox);
  const publication = sandbox.window.SoduWorkPluginPublication;
  const row = { scope: 'organization', trustState: 'quarantined',
    provenance: { signatureState: 'verified' }, qualitySummary: { caseCount: 0 } };
  assert.equal(publication.progress(row).length, 3);
  assert.equal(publication.currentStep(row).label, '管理员审核');
  const unknown = publication.currentStep({ ...row, provenance: { signatureState: 'unknown-key' } });
  assert.match(unknown.detail, /核对发布身份/);
  assert.equal(unknown.state, 'waiting');
  const strict = publication.progress({ ...row, reviewMode: 'platform-strict' });
  assert.equal(strict.length, 5);
  assert.equal(publication.currentStep({ ...row, scope: 'platform' }).label, '发布评测');
});

test('已审核企业插件无需需求绑定即可安装，撤销不能误报开放', () => {
  const sandbox = { window: {} };
  vm.runInNewContext(read('components/panels/plugin-publication-ux.js'), sandbox);
  const publication = sandbox.window.SoduWorkPluginPublication;
  const row = { scope: 'organization', trustState: 'approved', enabled: true,
    catalogReady: true, bindingCount: 0, qualitySummary: { caseCount: 0 } };
  const steps = publication.progress(row);
  assert.ok(steps.every(x => x.state === 'done'));
  assert.match(steps[2].detail, /按选定范围安装使用/);
  const revoked = publication.progress({ ...row, trustState: 'revoked', reviewDecision: 'revoke' });
  assert.equal(revoked[1].state, 'bad');
  assert.equal(revoked[2].state, 'waiting');
  const taskOnly = { ...row, catalogReady: false, marketPolicy: { installation: 'not_available' } };
  assert.equal(publication.progress(taskOnly)[2].state, 'waiting');
  const bound = publication.progress({ ...taskOnly, bindingCount: 1 })[2];
  assert.equal(bound.state, 'done');
  assert.match(bound.detail, /不开放个人安装/);
});

test('提交摘要根据真实流程显示分母，并转义用户内容', () => {
  const sandbox = { window: {} };
  vm.runInNewContext(read('components/panels/plugin-publication-ux.js'), sandbox);
  const publication = sandbox.window.SoduWorkPluginPublication;
  const html = publication.submissionStrip([{ scope: 'organization', pluginId: 'p',
    name: '<script>bad</script>', version: '1.0.0' }], () => ['审核中', 'waiting']);
  assert.match(html, /1\/3 · 管理员审核/);
  assert.doesNotMatch(html, /\/5|预检、模拟|<script>/);
  assert.match(html, /&lt;script&gt;/);
});

test('退回后的继续改进使用插件详情回调，不误入旧需求详情', () => {
  const sandbox = { window: {} };
  vm.runInNewContext(read('components/panels/plugin-publication-ux.js'), sandbox);
  const publication = sandbox.window.SoduWorkPluginPublication;
  const handlers = {};
  const local = { pluginId: 'local:test', personal: true, key: 'test', name: '本机插件' };
  let closed = 0, opened = null, bodyHtml = '';
  const ctx = {
    openModal(_title, _subtitle, body, footer) {
      bodyHtml = body;
      return { querySelector(selector) {
        if (!footer.includes('id="' + selector.slice(1) + '"')) return null;
        return { addEventListener(event, fn) { handlers[selector + ':' + event] = fn; } };
      } };
    },
    closeModal() { closed += 1; },
  };
  publication.openSubmission({ scope: 'organization', key: 'test', name: '本机插件',
    version: '1.0.0', reviewDecision: 'reject' }, ctx, {
    items: [local], trustName: () => ['已退回', 'bad'], sourceName: () => '员工提交',
    openDetail(item, context) { opened = item; assert.equal(context, ctx); },
  });
  assert.match(bodyHtml, /--cap-publication-steps:3/);
  handlers['#capSubmissionImprove:click']();
  assert.equal(closed, 1);
  assert.equal(opened, local);
  assert.match(read('components/panels/panels-capability-plugins.js'), /choosePackage, openDetail,/);
});

test('共享弹窗切换到发布回执前清理详情、版本和制作器布局', () => {
  const source = read('components/panels/panels-capabilities.js');
  const start = source.indexOf('  function openModal(title, sub, body, foot)');
  const end = source.indexOf('  function closeModal()', start);
  assert.ok(start > 0 && end > start);
  const stale = new Set(['cap-plugin-detail-modal', 'cap-plugin-maker-modal', 'cap-plugin-version-modal']);
  const node = { classList: { remove(...names) { names.forEach(x => stale.delete(x)); } } };
  const fields = {};
  const layer = { hidden: true, querySelector(selector) {
    if (selector === '.cap-modal') return node;
    return fields[selector] || (fields[selector] = {});
  } };
  const previousFocus = {};
  const sandbox = { viewRevision: 0, ensureModal: () => layer, document: { activeElement: previousFocus }, setTimeout() {} };
  vm.runInNewContext(source.slice(start, end) + '\nthis.open = openModal;', sandbox);
  assert.equal(sandbox.open('企业发布进度', 'v1.0.0', 'body', 'footer'), layer);
  assert.equal(stale.size, 0);
  assert.equal(layer.hidden, false);
  assert.equal(fields['#capModalBody'].innerHTML, 'body');
  assert.equal(layer._returnFocus, previousFocus);
});
