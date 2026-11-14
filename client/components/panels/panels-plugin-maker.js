/* Client-first plugin authoring: structured workflow, typed handoff and route preview. */
(function (global) {
  'use strict';

  const ROUTES = global.SoduWorkPluginRoutes;
  const SKILLS = global.SoduWorkPluginMakerSkills;
  const UTILS = global.SoduWorkPluginMakerUtils;
  const FIELDS = global.SoduWorkPluginMakerFields;
  const { html: h, values, clone, compareVersions, nextVersion } = UTILS || {};
  const TYPES = {
    ai: ['AI 执行', '完成分析、创作或操作'],
    ai_review: ['AI 审查', '独立复核上游结果'],
    spec: ['需求基线', '形成并审批需求范围'],
    quality: ['质量门禁', '运行项目权威检查'],
    approval: ['人工审批', '对合并或发布显式放行'],
    merge: ['代码合并', '合并已审查的固定版本'],
    deploy_chain: ['企业发布链', '按环境中心配置依次上线'],
    validate: ['上线核对', '核对版本、健康状态与证据'],
    human_review: ['人工验收', '只在最终确认时请人处理'],
    publish: ['办结沉淀', '固化结果与全过程证据'],
  };
  const ENTERPRISE_CONFIG = {
    spec: { summary: '确认需求范围、假设与逐条验收标准' },
    quality: { commands: [{ name: '工程真实自测', argv: ['project:selftest'], timeoutSeconds: 1200 }] },
    approval: { action: 'merge' }, merge: { autoSubmit: true }, deploy_chain: {},
    validate: { deployVerify: true, shaCheck: true, http: [] },
  };
  const OUTPUTS = [
    ['evidence', '证据 / 成果'], ['file', '指定文件'], ['git', '代码提交'],
    ['url', '可访问地址'], ['decision', '结构化决策'],
  ];
  let sequence = 0;
  let makerSequence = 0;
  function icon(path) {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="' + path + '"/></svg>';
  }
  const ICON = {
    maker: icon('M4 20h4L19 9l-4-4L4 16zM13 7l4 4M5 4h5M7.5 1.5v5'),
    method: icon('M5 4h14v16H5zM8 8h8M8 12h8M8 16h5'),
    connector: icon('M8 12h8M6 9v6M18 9v6M3 12h3M18 12h3'),
    workflow: icon('M5 5h5v5H5zM14 14h5v5h-5zM10 7.5h2a4 4 0 0 1 4 4V14'),
  };
  function defaultNodes() {
    return [
      node('understand', 'ai', '理解与规划', [], '理解目标、输入、限制和完成标准，形成可执行计划后继续。',
        [{ key: 'plan', kind: 'evidence', label: '执行计划', required: true }]),
      node('work', 'ai', '完成工作', ['understand'], '依据上游计划和插件工作方法完成工作，交付可直接验收的结果。',
        [{ key: 'result', kind: 'evidence', label: '交付成果', required: true }]),
      node('accept', 'human_review', '人工验收', ['work'], '', []),
      node('complete', 'publish', '办结沉淀', ['accept'], '', []),
    ];
  }
  function standaloneNodes() {
    const readiness = node(
      'readiness', 'ai', '发布前就绪检查', [],
      '检查已合并的代码版本和发布前条件，输出可审核的就绪结论。',
      [{ key: 'result', kind: 'evidence', label: '就绪结论', required: true }]);
    const approval = node('approval', 'approval', '发布审批', ['readiness'], '', []);
    approval.configJson = JSON.stringify({ action: 'deploy' }, null, 2);
    const deploy = node('deploy', 'deploy_chain', '环境发布链', ['approval'], '', []);
    deploy.configJson = JSON.stringify({ strategy: 'environment-center' }, null, 2);
    const validate = node('validate', 'validate', '上线后核对', ['deploy'], '', []);
    validate.configJson = JSON.stringify({ deployVerify: true, shaCheck: true, http: [] }, null, 2);
    const publish = node('publish', 'publish', '独立插件办结', ['validate'], '', []);
    return [readiness, approval, deploy, validate, publish];
  }
  function node(key, type, name, dependsOn, prompt, outputs) {
    return {
      key, type, name, dependsOn: dependsOn.slice(), inputs: [], outputs: outputs.slice(),
      prompt, agentKind: '', model: '', fallbackMode: 'best-effort', runnerTags: '',
      timeoutSeconds: 3600, maxAttempts: type === 'ai' || type === 'ai_review' ? 2 : 1,
      skills: null, mcpServers: null, runtime: null,
      action: 'uat', summary: '按需求完成标准验收本次交付',
      message: '成果已验收，需求完成并保留全过程证据',
      configJson: JSON.stringify(ENTERPRISE_CONFIG[type] || {}, null, 2),
    };
  }
  function newNode(type) {
    sequence += 1;
    const key = 'step_' + sequence;
    const name = TYPES[type][0];
    return node(key, type, name, [], type === 'ai_review'
      ? '独立审查上游交付，对照完成标准给出明确结论和证据。'
      : type === 'ai' ? '按照插件工作方法完成这一环，并交付可供下游使用的结果。' : '',
    type === 'ai' || type === 'ai_review'
      ? [{ key: type === 'ai_review' ? 'review' : 'result', kind: 'evidence', label: name + '结果', required: true }]
      : []);
  }
  function templateButton(key, title, detail, svg, on) {
    return '<button type="button" class="cap-maker-type' + (on ? ' on' : '') +
      '" data-maker-type="' + key + '"><span>' + svg + '</span><b>' + title +
      '</b><em>' + detail + '</em></button>';
  }
  function entrypointState(value, kind) {
    const defaults = kind === 'workflow'
      ? { conversation: false, task: true, automation: true }
      : { conversation: true, task: true, automation: false };
    const raw = value && typeof value === 'object' ? value : {};
    return {
      conversation: raw.conversation == null ? defaults.conversation : Boolean(raw.conversation),
      task: raw.task == null ? defaults.task : Boolean(raw.task),
      automation: raw.automation == null ? defaults.automation : Boolean(raw.automation),
    };
  }
  function editorNode(raw, index) {
    raw = raw && typeof raw === 'object' ? raw : {};
    if (!TYPES[raw.type]) throw new Error('当前编辑器不支持节点类型：' + raw.type + '；原插件未被修改，请用对话助手继续编辑。');
    const type = raw.type;
    const config = raw.config && typeof raw.config === 'object' ? raw.config : {};
    const execution = config.execution && typeof config.execution === 'object' ? config.execution : {};
    const result = node(
      String(raw.key || ('step_' + (index + 1))), type,
      String(raw.name || TYPES[type][0]),
      Array.isArray(raw.dependsOn) ? raw.dependsOn.map(String) : [],
      String(config.prompt || ''),
      Array.isArray(raw.outputs) ? clone(raw.outputs) : []
    );
    result.inputs = Array.isArray(raw.inputs) ? clone(raw.inputs) : [];
    result.agentKind = String(execution.agentKind || config.agentKind || '');
    result.model = String(execution.model || config.model || '');
    result.fallbackMode = String(execution.fallbackMode || config.fallbackMode || 'best-effort');
    const runnerTags = execution.runnerTags || config.runnerTags || [];
    result.runnerTags = Array.isArray(runnerTags) ? runnerTags.join(', ') : String(runnerTags);
    result.timeoutSeconds = Number(config.timeoutSeconds || 3600);
    result.maxAttempts = Number((raw.retry || {}).maxAttempts || (type === 'ai' || type === 'ai_review' ? 2 : 1));
    if (raw.capabilities && typeof raw.capabilities === 'object') {
      result.skills = Array.isArray(raw.capabilities.skills) ? raw.capabilities.skills.map(String) : [];
      result.mcpServers = Array.isArray(raw.capabilities.mcpServers) ? raw.capabilities.mcpServers.map(String) : [];
      result.runtime = Array.isArray(raw.capabilities.runtime) ? raw.capabilities.runtime.map(String) : [];
    }
    result.action = String(config.action || 'uat');
    result.summary = String(config.summary || '按需求完成标准验收本次交付');
    result.message = String(config.message || '成果已验收，需求完成并保留全过程证据');
    result.configJson = JSON.stringify(config, null, 2);
    return result;
  }
  function open(ctx, deps, initial, existingVersions) {
    if (!ROUTES || !SKILLS || !UTILS || !FIELDS) {
      if (ctx && typeof ctx.say === 'function') ctx.say('插件制作组件没有完整加载，请重启 SoduWork 后再试');
      return;
    }
    deps = deps || {};
    const draft = initial && typeof initial === 'object' ? clone(initial) : {};
    let pluginIcon = draft.icon || '';
    let iconLoading = false;
    const preservedResources = clone(draft.resources || []);
    const preservedUi = clone(draft.ui || { contributions: [] });
    const versions = Array.isArray(existingVersions) ? existingVersions : [];
    const editing = Boolean(draft.key && draft.version);
    const originalVersion = String(draft.version || '');
    const pluginKey = String(draft.key || '');
    const provenance = {
      sourceKind: draft.sourceKind, importChecksum: draft.importChecksum,
      importWarnings: clone(draft.importWarnings || []),
      unsupportedComponents: clone(draft.unsupportedComponents || []),
    };
    let template = ['method', 'connector', 'workflow', 'app'].includes(draft.template)
      ? draft.template : 'method';
    let distribution = draft.distribution === 'standalone' ? 'standalone' : '';
    let nodes = template === 'workflow' && draft.workflow && Array.isArray(draft.workflow.nodes)
      ? draft.workflow.nodes.map(editorNode) : defaultNodes();
    if (distribution === 'standalone' && template === 'workflow' && !draft.workflow) {
      nodes = standaloneNodes();
    }
    const setupDraft = draft.setup && typeof draft.setup === 'object' ? draft.setup : {};
    const pluginSkills = new Set(values(draft.skills));
    nodes.forEach(item => {
      if (Array.isArray(item.skills)) item.skills = item.skills.filter(name => name !== pluginKey);
    });
    let entrypoints = entrypointState(draft.entrypoints, template);
    let selected = 0;
    let previewSignature = '';
    let routeData = ROUTES.normalize(null);
    const modelListId = 'capMakerModels' + (++makerSequence);
    const runtimeSet = new Set(values(draft.runtimeCapabilities || draft.runtime));
    const versionValue = editing ? nextVersion(originalVersion, versions) : '0.1.0';
    const criteriaValue = Array.isArray(draft.evaluationCriteria)
      ? draft.evaluationCriteria.join('\n') : String(draft.evaluationCriteria || '');
    const layer = ctx.openModal(
      editing ? '编辑插件新版本' : '制作插件',
      editing
        ? '基于当前版本创建新的不可变版本；旧版本和既有需求记录保持不变。'
        : '在本机完成设计和预检；上传后仍需企业审核、授权和绑定。',
      '<div class="cap-maker-shell">' +
        '<div class="cap-maker-agent"><span>' + ICON.maker + '</span><div><b>' +
        (editing ? '让 SoduWork 帮你改进' : '让 SoduWork 帮你起草') + '</b>' +
        '<em>先描述做法，再用结构化编辑器校准参数、节点、上下文和执行偏好。</em></div>' +
        (!editing ? '<button class="btn-mini" id="capMakerRecent">安装最近草稿</button>' : '') +
        '<button class="btn-mini" id="capMakerAgent">' + (editing ? '对话改进' : '对话创建') + '</button></div>' +
        UTILS.resourceMarkup(preservedResources) +
        '<div class="cap-maker-types" id="capMakerTypes">' +
          templateButton('method', '工作方法', '沉淀一套可复用 Skill', ICON.method, template === 'method') +
          templateButton('connector', '系统连接', '组合方法、连接器与工具', ICON.connector, template === 'connector') +
          templateButton('workflow', '自动化流程', '编排 Agent、人审与交付', ICON.workflow, template === 'workflow') +
          (draft.template === 'app' ? templateButton('app', '应用', '独立窗口、页面与对话', ICON.maker, template === 'app') : '') +
        '</div>' +
        '<label class="cap-maker-standalone-toggle"><input type="checkbox" id="capMakerStandalone"' +
          (distribution === 'standalone' ? ' checked' : '') + '>独立上线插件 <em>发布链由企业环境中心执行，可作为独立插件安装、审核和升级</em></label>' +
        (editing ? '<div class="cap-maker-version-note"><span>基于 v' + h(originalVersion) +
          '</span><b>保存为新版本，原版本不会被覆盖</b><em>已保留 ' + versions.length + ' 个版本</em></div>' : '') +
        '<section class="cap-maker-basics"><div class="cap-fields">' +
          '<div class="cap-maker-icon-field wide"><span class="cap-plugin-brand" id="capPluginIconPreview" aria-label="插件图标预览"></span>' +
            '<div class="cap-maker-icon-copy"><b>插件图标 <em>可选</em></b><span>PNG、JPG 或 WebP，最大 2 MB；未设置时保留默认图标。</span>' +
            '<div class="cap-maker-icon-actions"><button type="button" class="btn-mini" id="capPluginIconUpload">上传图标</button>' +
            '<button type="button" class="btn-mini" id="capPluginIconReset">恢复默认</button></div>' +
            '<span id="capPluginIconStatus" role="status" aria-live="polite"></span></div>' +
            '<input type="file" id="capPluginIconFile" accept="image/png,image/jpeg,image/webp" hidden></div>' +
          '<label class="cap-field"><span>插件名称</span><input class="cap-input" id="capPluginName" maxlength="120" value="' + h(draft.name || '') + '" placeholder="例如：产品原型交付"></label>' +
          '<label class="cap-field"><span>版本</span><input class="cap-input" id="capPluginVersion" maxlength="40" value="' + h(versionValue) + '"></label>' +
          '<label class="cap-field"><span>作者</span><input class="cap-input" id="capPluginAuthor" maxlength="120" value="' + h(draft.author || (global.User && global.User.name) || '') + '" placeholder="显示在插件目录中的作者名称"></label>' +
          '<label class="cap-field wide"><span>用途 <em>什么时候用、最终交付什么</em></span><input class="cap-input" id="capPluginDesc" maxlength="600" value="' + h(draft.description || '') + '" placeholder="把零散需求整理成可验收的 HTML 产品原型"></label>' +
          '<label class="cap-field wide"><span>工作方法与完成标准</span><textarea class="cap-textarea" id="capPluginInstructions" placeholder="写清楚输入、判断规则、交付格式、验证方式和失败边界。">' + h(draft.instructions || '') + '</textarea></label>' +
          '<div class="cap-maker-config">' +
          '<details class="cap-maker-group" data-maker-group="dependencies"><summary><b>能力与连接</b><span>复用技能 · 连接器 · 运行权限</span></summary><div class="cap-maker-group-body">' +
          '<label class="cap-field wide cap-maker-mcp"' + (template === 'method' ? ' hidden' : '') + '><span>依赖的连接器 <em>选择已配置连接或填写逻辑名称</em></span><div class="cap-maker-mcp-row"><input class="cap-input" id="capPluginMcp" list="capPluginMcpOptions" value="' + h(values(draft.mcpServers).filter(name => name !== 'soduwork-media').join(', ')) + '" placeholder="knowledge-base, figma"><select class="cap-input" id="capPluginMcpPicker" aria-label="从连接中心选择"><option value="">从连接中心选择</option></select></div><datalist id="capPluginMcpOptions"></datalist><i class="cap-help" id="capPluginMcpHint">已配置连接会自动带入逻辑名称；地址和授权在连接中心统一管理</i></label>' +
          '<div class="cap-field wide cap-maker-builtins"><span>SoduWork 内置能力 <em>沿用「我的模型」配置，无需另配连接器</em></span><div class="cap-runtime-options"><label title="生成可预览和下载的图片或视频"><input type="checkbox" id="capPluginSoduWorkMedia"' + (values(draft.mcpServers).includes('soduwork-media') ? ' checked' : '') + '>图片与视频生成（soduwork-media）</label></div><em>图片调用 generate_image，视频调用 generate_video。请先配置相应类型的模型。</em></div>' +
          '<div class="cap-field wide"><span>复用平台账号 <em>安装后在 SoduWork 中连接，每位用户使用自己的账号</em></span><div class="cap-runtime-options">' +
            Object.entries(global.SoduWorkPluginPlatforms.labels).map(([key, label]) =>
              '<label><input type="checkbox" data-plugin-platform="' + key + '"' +
              ((draft.platforms || []).includes(key) ? ' checked' : '') + '>' + label + '</label>').join('') + '</div></div>' +
          '<div class="cap-field wide cap-maker-skills"><header><span>复用 Skill <em>选择团队已开放的方法，执行需求时会随节点一起加载</em></span>' +
            '<small id="capSkillCount" role="status">正在读取…</small></header>' +
            '<div class="cap-skill-search"><input type="search" id="capSkillSearch" placeholder="搜索 Skill 名称或用途" aria-label="搜索 Skill">' +
            '<label><input type="checkbox" id="capSkillSelectedOnly">只看已选</label></div>' +
            '<div class="cap-skill-options" id="capPluginSkills">' +
            '<span class="cap-skill-empty">正在读取可用 Skill…</span></div></div>' +
          '<div class="cap-field wide"><span>运行能力 <em>按最小权限声明</em></span><div class="cap-runtime-options">' +
            '<label><input type="checkbox" data-runtime="browser"' + (runtimeSet.has('browser') ? ' checked' : '') + '>浏览网页</label>' +
            '<label><input type="checkbox" data-runtime="computer"' + (runtimeSet.has('computer') ? ' checked' : '') + '>操作电脑</label>' +
            '<label><input type="checkbox" data-runtime="repository"' + (runtimeSet.has('repository') ? ' checked' : '') + '>代码仓库</label>' +
            '<em>Word、Excel、PPT 等交付按输出格式生成，不需要单独选择技术能力。</em>' +
          '</div></div>' +
          '</div></details><details class="cap-maker-group" data-maker-group="inputs"><summary><b>使用场景与参数</b><span>调用入口 · 需求输入 · 安装设置</span></summary><div class="cap-maker-group-body">' +
          '<div class="cap-field wide cap-maker-entrypoints"><span>使用场景 <em>决定插件允许在哪类工作中调用，不会自动增加菜单或页面</em></span>' +
            '<div class="cap-entrypoint-options" id="capEntrypoints">' +
              '<label><input type="checkbox" data-entrypoint="conversation"' + (entrypoints.conversation ? ' checked' : '') + '>普通会话</label>' +
              '<label><input type="checkbox" data-entrypoint="task"' + (entrypoints.task ? ' checked' : '') + '>需求执行</label>' +
              '<label><input type="checkbox" data-entrypoint="automation"' + (entrypoints.automation ? ' checked' : '') + '>自动化</label>' +
            '</div><em>表单显示在对应工作内容区，不进入消息输入框或派活弹层；公开参数只在真正启动工作时收集。</em></div>' +
          '<section class="cap-field wide cap-maker-inputs"><header><div><span>需求公开参数</span>' +
            '<em>启动需求或自动化时填写，不用于收集账号和密钥</em></div>' +
            '<button type="button" class="btn-mini" id="capInputAdd">＋ 参数</button></header>' +
            '<div id="capInputRows"></div></section>' +
          '<section class="cap-field wide cap-maker-setup"><header><div><span>安装设置（可选）</span>' +
            '<em>安装到企业后由每位同事配置一次；账号、OAuth、密钥改在连接中心绑定</em></div>' +
            '<button type="button" class="btn-mini" id="capSetupAdd">＋ 设置项</button></header>' +
            '<div class="cap-setup-contract-meta">' +
              '<input class="cap-input" id="capSetupTitle" maxlength="120" value="' + h(setupDraft.title || '') + '" placeholder="配置表单标题，例如：配置报告偏好">' +
              '<input class="cap-input" id="capSetupDescription" maxlength="500" value="' + h(setupDraft.description || '') + '" placeholder="告诉使用者这些设置会怎样影响结果">' +
            '</div><div id="capSetupRows"></div></section>' +
          '</div></details><details class="cap-maker-group" data-maker-group="quality"><summary><b>评测与验收</b><span>代表性试题 · 明确的通过标准</span></summary><div class="cap-maker-group-body">' +
          '<label class="cap-field wide"><span>代表性评测试题 <em>与验收标准一起填写</em></span><input class="cap-input" id="capPluginEval" maxlength="2000" value="' + h(draft.evaluationInstruction || '') + '" placeholder="给一份真实输入，插件应完成什么"></label>' +
          '<label class="cap-field wide"><span>验收标准 <em>每行一条，可明确判断</em></span><textarea class="cap-textarea compact" id="capPluginCriteria" placeholder="产出格式可以直接使用\n关键结论有依据\n失败时说明原因与下一步">' + h(criteriaValue) + '</textarea></label>' +
        '</div></details></div></div></section>' +
        '<section class="cap-workflow" id="capWorkflow" hidden></section>' +
        '<section class="cap-maker-preview" id="capMakerPreview" hidden></section>' +
        '<p class="cap-governance-note"><b>个人定义表达方法，不控制企业基础设施。</b>公开参数随版本固化；密钥、机器和环境只在企业发布后绑定。节点可选择 Agent、模型和执行标签，管理员仍可在项目绑定中覆盖。</p>' +
      '</div>',
      '<button class="btn-mini" id="capMakerCancel">取消</button><span class="push"></span>' +
      '<button class="btn-mini primary" id="capMakerDo" aria-label="生成预检并继续">检查并继续</button>'
    );
    const makerModal = layer.querySelector('.cap-modal'); if (makerModal) makerModal.classList.add('cap-plugin-maker-modal');
    global.SoduWorkPluginPresentation.dialog(layer, ctx);
    const workflowEl = layer.querySelector('#capWorkflow');
    const skillRowsEl = layer.querySelector('#capPluginSkills');
    const previewEl = layer.querySelector('#capMakerPreview');
    const submit = layer.querySelector('#capMakerDo');
    const standaloneToggle = layer.querySelector('#capMakerStandalone');
    const iconFile = layer.querySelector('#capPluginIconFile');
    const iconUpload = layer.querySelector('#capPluginIconUpload');
    const iconReset = layer.querySelector('#capPluginIconReset');
    const iconStatus = layer.querySelector('#capPluginIconStatus');
    const mcpInput = layer.querySelector('#capPluginMcp');
    const mcpPicker = layer.querySelector('#capPluginMcpPicker');
    const mcpHint = layer.querySelector('#capPluginMcpHint');
    async function loadMcpConnections() {
      if (!mcpPicker || !ctx.api || typeof ctx.api.myMcpServers !== 'function') return;
      try {
        const catalog = await ctx.api.myMcpServers();
        const rows = [...(catalog && catalog.personal || []), ...(catalog && catalog.company || [])]
          .filter(item => item && item.enabled !== false && item.name).slice(0, 100);
        const names = [...new Set(rows.map(item => String(item.name).trim()).filter(Boolean))];
        mcpPicker.innerHTML = '<option value="">从连接中心选择</option>' + names.map(name => '<option value="' + h(name) + '">' + h(name) + '</option>').join('');
        const list = layer.querySelector('#capPluginMcpOptions');
        if (list) list.innerHTML = names.map(name => '<option value="' + h(name) + '"></option>').join('');
        if (mcpHint) mcpHint.textContent = names.length ? '已加载 ' + names.length + ' 个可用连接；地址和授权在连接中心统一管理' : '还没有已配置连接，可先到连接器页面添加';
      } catch (_) { /* The maker remains usable with a logical name. */ }
    }
    if (mcpPicker) mcpPicker.addEventListener('change', function () {
      const name = String(this.value || '').trim();
      if (!name || !mcpInput) return;
      const current = values(mcpInput.value);
      if (!current.includes(name)) current.push(name);
      mcpInput.value = current.join(', ');
      this.value = '';
      resetPreview();
    });
    loadMcpConnections();
    function saveLabel() {
      return editing ? '保存新版本' : distribution === 'standalone' ? '保存独立插件' : '安装并试用';
    }
    function renderIcon() {
      const item = { ...base(), icon: pluginIcon };
      const art = global.SoduWorkCapabilityPlugins;
      const preview = layer.querySelector('#capPluginIconPreview');
      const flow = template === 'workflow';
      preview.className = 'cap-plugin-brand ' + art.toneClass(item, flow) + ' icon-' + art.iconKind(item, flow);
      preview.innerHTML = art.brandIcon(item, flow);
      iconReset.hidden = !pluginIcon;
      iconUpload.textContent = pluginIcon ? '更换图标' : '上传图标';
    }
    iconUpload.addEventListener('click', () => iconFile.click());
    iconReset.addEventListener('click', () => {
      pluginIcon = ''; iconFile.value = ''; iconStatus.textContent = '已恢复默认，保存后生效';
      renderIcon(); resetPreview();
    });
    iconFile.addEventListener('change', async () => {
      const file = iconFile.files[0]; if (!file || iconLoading) return;
      iconLoading = true; iconUpload.disabled = true; iconReset.disabled = true;
      submit.disabled = true; iconStatus.textContent = '正在处理图标…';
      try {
        const value = await global.SoduWorkPluginIcon.readFile(file);
        if (layer.hidden || !iconFile.isConnected) return;
        pluginIcon = value; renderIcon(); resetPreview();
        iconStatus.textContent = '图标已准备好，将随插件版本保存';
      } catch (error) { iconStatus.textContent = error.message; }
      finally {
        iconFile.value = ''; iconLoading = false;
        iconUpload.disabled = false; iconReset.disabled = false; submit.disabled = false;
      }
    });
    function base() {
      const platforms = Array.from(layer.querySelectorAll('[data-plugin-platform]:checked')).map(x => x.dataset.pluginPlatform);
      const mcp = values(layer.querySelector('#capPluginMcp').value);
      const media = layer.querySelector('#capPluginSoduWorkMedia');
      if (media && media.checked && !mcp.includes('soduwork-media')) mcp.push('soduwork-media');
      if (media && !media.checked) {
        const index = mcp.indexOf('soduwork-media');
        if (index >= 0) mcp.splice(index, 1);
      }
      if (platforms.includes('feishu') && !mcp.includes('feishu')) mcp.push('feishu');
      const runtime = Array.from(layer.querySelectorAll('[data-runtime]:checked')).map(x => x.dataset.runtime);
      if (platforms.length) for (const name of ['files', 'terminal']) if (!runtime.includes(name)) runtime.push(name);
      return {
        name: layer.querySelector('#capPluginName').value.trim(),
        ...(standaloneToggle && standaloneToggle.checked ? { distribution: 'standalone' } : {}),
        ...(pluginIcon ? { icon: pluginIcon } : {}),
        version: layer.querySelector('#capPluginVersion').value.trim(),
        author: layer.querySelector('#capPluginAuthor').value.trim(),
        description: layer.querySelector('#capPluginDesc').value.trim(),
        instructions: layer.querySelector('#capPluginInstructions').value.trim(),
        skills: [...pluginSkills],
        mcpServers: mcp.join(', '), platforms, runtimeCapabilities: runtime,
        evaluationInstruction: layer.querySelector('#capPluginEval').value.trim(),
        evaluationCriteria: layer.querySelector('#capPluginCriteria').value.trim(),
      };
    }
    const skillPicker = SKILLS.create({
      root: skillRowsEl, count: layer.querySelector('#capSkillCount'),
      selected: pluginSkills, pluginKey, deps,
      search: layer.querySelector('#capSkillSearch'), selectedOnly: layer.querySelector('#capSkillSelectedOnly'),
      onChange: function (name, enabled) {
        if (!enabled) nodes.forEach(item => {
          if (Array.isArray(item.skills)) item.skills = item.skills.filter(value => value !== name);
        });
        resetPreview(); renderWorkflow();
      },
    });
    function serializeNode(item) {
      const rawBase = base();
      const ai = item.type === 'ai' || item.type === 'ai_review';
      const result = {
        key: item.key, type: item.type, name: item.name, dependsOn: item.dependsOn.slice(),
        inputs: item.inputs.map(input => ({ ...input })),
        outputs: item.outputs.map(output => ({ ...output })), retry: { maxAttempts: Number(item.maxAttempts) || 1 },
      };
      if (ai) {
        const allSkills = rawBase.skills;
        const allMcp = values(rawBase.mcpServers);
        const allRuntime = rawBase.runtimeCapabilities;
        result.config = {
          prompt: item.prompt, timeoutSeconds: Number(item.timeoutSeconds) || 3600,
          ...(item.agentKind ? { agentKind: item.agentKind } : {}),
          ...(item.model ? { model: item.model } : {}),
          ...(item.fallbackMode ? { fallbackMode: item.fallbackMode } : {}),
          ...(values(item.runnerTags).length ? { runnerTags: values(item.runnerTags) } : {}),
        };
        result.capabilities = {
          skills: item.skills == null ? allSkills : item.skills.filter(x => allSkills.includes(x)),
          secrets: [],
          mcpServers: item.mcpServers == null ? allMcp : item.mcpServers.filter(x => allMcp.includes(x)),
          runtime: item.runtime == null ? allRuntime : item.runtime.filter(x => allRuntime.includes(x)),
          network: (item.mcpServers == null ? allMcp : item.mcpServers).length > 0 || rawBase.platforms.length > 0,
        };
      } else if (item.type === 'human_review') {
        result.config = { action: item.action, summary: item.summary };
      } else if (item.type === 'publish') {
        result.config = { message: item.message };
      } else {
        try { result.config = JSON.parse(item.configJson || '{}'); }
        catch (_) { throw new Error('节点“' + item.name + '”的配置必须是合法 JSON'); }
      }
      return result;
    }

    function readBody() {
      const raw = base();
      return {
        template, entrypoints: { ...entrypoints }, ...(pluginKey ? { key: pluginKey } : {}), ...raw,
        ...(draft.sourcePluginId ? { sourcePluginId: draft.sourcePluginId } : {}),
        inputs: fieldEditor.inputs(),
        setup: fieldEditor.setup(),
        ui: clone(preservedUi),
        ...(draft.extensions != null ? {extensions:clone(draft.extensions)} : {}),
        ...(draft.appCategory != null ? {appCategory:draft.appCategory} : {}),
        ...(draft.jiyong != null ? {jiyong:clone(draft.jiyong)} : {}),
        ...(draft.locales != null ? {locales:clone(draft.locales)} : {}),
        ...(draft.appWindow != null ? { appWindow: clone(draft.appWindow) } : {}),
        ...(draft.coverUrl ? { coverUrl: draft.coverUrl } : {}),
        ...(preservedResources.length ? { resources: clone(preservedResources) } : {}),
        ...(provenance.sourceKind ? { sourceKind: provenance.sourceKind } : {}),
        ...(provenance.importChecksum ? { importChecksum: provenance.importChecksum } : {}),
        ...(provenance.importWarnings.length ? { importWarnings: provenance.importWarnings } : {}),
        ...(provenance.unsupportedComponents.length
          ? { unsupportedComponents: provenance.unsupportedComponents } : {}),
        ...(template === 'workflow' ? { workflow: { nodes: nodes.map(serializeNode) } } : {}),
      };
    }

    function resetPreview() {
      previewSignature = '';
      previewEl.hidden = true;
      previewEl.innerHTML = '';
      submit.textContent = '检查并继续';
    }

    function option(value, label, selectedValue) {
      return '<option value="' + h(value) + '"' + (value === selectedValue ? ' selected' : '') + '>' + h(label) + '</option>';
    }

    function routeMeta(key) {
      return routeData.kinds.find(item => item.key === key) || {
        key, name: key || '跟随企业默认', modelPick: true, onlineSeats: 0,
      };
    }

    function routeOptions(selectedValue) {
      const list = routeData.kinds.slice();
      if (selectedValue && !list.some(item => item.key === selectedValue) &&
          ROUTES.isPortableAgentKind(selectedValue)) {
        list.splice(1, 0, {
          key: selectedValue, name: selectedValue + '（导入类型）',
          modelPick: true, onlineSeats: 0,
        });
      }
      return list.map(function (item) {
        let label = item.name || item.key;
        if (item.key && routeData.loaded) {
          label += item.onlineSeats ? ' · ' + item.onlineSeats + ' 个在线席位' : ' · 当前环境未在线';
        }
        return option(item.key, label, selectedValue);
      }).join('');
    }

    function routeStatus() {
      if (!routeData.loaded) return '正在读取当前环境的 Agent 与模型';
      const online = routeData.kinds.filter(item => item.key && item.onlineSeats > 0).length;
      if (online) return online + ' 类底座在线 · ' + routeData.models.length + ' 个可选模型';
      return routeData.reason || '当前环境暂无在线 Agent；仍可编辑，发布前会再次预检';
    }

    function previewRouteText(item) {
      if (!item.route) return '';
      const kind = String(item.route.agentKind || '');
      const meta = routeMeta(kind);
      const parts = [kind ? meta.name : '企业默认'];
      if (item.route.model) parts.push(item.route.model);
      if (routeData.loaded && kind) {
        parts.push(meta.onlineSeats ? '检测到在线席位' : '当前环境未在线');
      }
      return ' · ' + parts.join(' · ');
    }

    function syncRouteDirectory() {
      if (!layer.isConnected || template !== 'workflow') return;
      const item = nodes[selected]; if (!item) return;
      const select = workflowEl.querySelector('[data-node-field="agentKind"]');
      if (select) select.innerHTML = routeOptions(item.agentKind);
      const status = workflowEl.querySelector('[data-route-status]');
      if (status) status.textContent = routeStatus();
      const model = workflowEl.querySelector('[data-node-field="model"]');
      const list = workflowEl.querySelector('#' + modelListId);
      const meta = routeMeta(item.agentKind);
      if (model) {
        model.disabled = meta.modelPick === false;
        model.placeholder = meta.modelPick === false
          ? '该底座使用自身模型' : (routeData.defaultModel
            ? '跟随默认 · ' + routeData.defaultModel : '跟随底座默认');
      }
      if (list) list.innerHTML = routeData.models.map(
        value => '<option value="' + h(value) + '"></option>').join('');
    }

    function loadRouteDirectory() {
      if (!global.SoduWorkAPI || typeof global.SoduWorkAPI.listAIAgents !== 'function') {
        routeData = ROUTES.normalize({ reason: '当前客户端没有 Agent 目录接口' });
        syncRouteDirectory(); return;
      }
      Promise.resolve(global.SoduWorkAPI.listAIAgents()).then(function (data) {
        routeData = ROUTES.normalize(data || {});
        syncRouteDirectory();
      }).catch(function () {
        routeData = ROUTES.normalize({ reason: '暂时没有读取到当前环境的 Agent 目录' });
        syncRouteDirectory();
      });
    }
    function nodeList() {
      return '<nav class="cap-workflow-list"><header><div><b>执行节点</b><em>' + nodes.length + ' 个</em></div>' +
        '<select id="capNodeType" aria-label="新增节点类型">' + Object.entries(TYPES).map(x => option(x[0], x[1][0], '')).join('') + '</select>' +
        '<button type="button" class="btn-mini" data-node-action="add">添加</button></header>' +
        nodes.map(function (item, index) {
          return '<button type="button" class="cap-workflow-node' + (index === selected ? ' on' : '') +
            '" data-node-index="' + index + '"><i>' + (index + 1) + "</i><span><b data-user-content>" + h(item.name) +
            '</b><em>' + h(TYPES[item.type][0]) + (item.dependsOn.length ? ' · 接 ' + item.dependsOn.length + ' 项' : ' · 起点') +
            '</em></span></button>';
        }).join('') + '</nav>';
    }

    function dependencyRows(item) {
      const candidates = nodes.filter(x => x !== item);
      if (!candidates.length) return '<em class="cap-workflow-empty">这是唯一节点，无上游依赖。</em>';
      return candidates.map(function (candidate) {
        return '<label><input type="checkbox" data-node-dependency="' + h(candidate.key) + '"' +
          (item.dependsOn.includes(candidate.key) ? ' checked' : '') + "><span data-user-content>" + h(candidate.name) +
          '</span><small>' + h(candidate.key) + '</small></label>';
      }).join('');
    }

    function outputRows(item) {
      if (!item.outputs.length) return '<em class="cap-workflow-empty">这一节点不产生新的交接物。</em>';
      return item.outputs.map(function (output, index) {
        const needsPath = output.kind === 'file' || output.kind === 'decision';
        return '<div class="cap-output-row" data-output-index="' + index + '">' +
          '<input value="' + h(output.label) + '" data-output-field="label" maxlength="100" aria-label="产出名称">' +
          '<select data-output-field="kind" aria-label="产出类型">' + OUTPUTS.map(x => option(x[0], x[1], output.kind)).join('') + '</select>' +
          (needsPath ? '<input value="' + h(output.path || '') + '" data-output-field="path" placeholder="相对路径" aria-label="相对路径">' : '') +
          '<label title="下游必须收到"><input type="checkbox" data-output-field="required"' + (output.required ? ' checked' : '') + '>必需</label>' +
          '<button type="button" data-output-remove="' + index + '" aria-label="删除产出">×</button></div>';
      }).join('');
    }

    function capabilityRows(item, field, available, label) {
      if (!available.length) return '';
      const selectedValues = item[field] == null ? available : item[field];
      return '<div class="cap-node-capabilities"><b>' + label + '</b>' + available.map(function (value) {
        return '<label><input type="checkbox" data-node-capability="' + field + '" value="' + h(value) + '"' +
          (selectedValues.includes(value) ? ' checked' : '') + '>' + h(value) + '</label>';
      }).join('') + '</div>';
    }

    function inspector() {
      const item = nodes[selected];
      if (!item) return '<div class="cap-workflow-inspector"></div>';
      const ai = item.type === 'ai' || item.type === 'ai_review';
      const rawBase = base();
      const skills = rawBase.skills, mcp = values(rawBase.mcpServers), runtime = rawBase.runtimeCapabilities;
      const agent = routeMeta(item.agentKind);
      const canPickModel = agent.modelPick !== false;
      return '<section class="cap-workflow-inspector"><header><div><span>' + h(item.key) + '</span><b>' + h(TYPES[item.type][0]) +
        '</b></div><nav><button type="button" data-node-action="up"' + (selected === 0 ? ' disabled' : '') + '>↑</button>' +
        '<button type="button" data-node-action="down"' + (selected === nodes.length - 1 ? ' disabled' : '') + '>↓</button>' +
        '<button type="button" class="danger" data-node-action="delete"' + (nodes.length === 1 ? ' disabled' : '') + '>删除</button></nav></header>' +
        '<div class="cap-node-grid"><label><span>节点名称</span><input data-node-field="name" value="' + h(item.name) + '" maxlength="100"></label>' +
        '<label><span>节点类型</span><select data-node-field="type">' + Object.entries(TYPES).map(x => option(x[0], x[1][0], item.type)).join('') + '</select></label></div>' +
        '<section class="cap-node-section"><header><b>上游与上下文</b><em>只传递直接上游声明过的结果</em></header><div class="cap-dependency-list">' + dependencyRows(item) + '</div></section>' +
        (ai ? '<section class="cap-node-section"><header><b>工作指令</b><em>当前节点自己的职责与完成标准</em></header>' +
          '<textarea data-node-field="prompt" maxlength="12000">' + h(item.prompt) + '</textarea></section>' +
          '<section class="cap-node-section"><header><b>执行偏好</b><em class="cap-route-state" data-route-status>' + h(routeStatus()) + '</em></header>' +
          '<div class="cap-node-grid route"><label><span>Agent</span><select data-node-field="agentKind">' + routeOptions(item.agentKind) + '</select></label>' +
          '<label><span>模型 <em>' + (canPickModel ? '留空跟随底座' : '由底座自身管理') + '</em></span>' +
          '<input data-node-field="model" list="' + modelListId + '" value="' + h(item.model) + '" maxlength="160"' +
          (canPickModel ? '' : ' disabled') + ' placeholder="' + h(canPickModel ? (routeData.defaultModel ? '跟随默认 · ' + routeData.defaultModel : '跟随底座默认') : '该底座使用自身模型') + '">' +
          '<datalist id="' + modelListId + '">' + routeData.models.map(value => '<option value="' + h(value) + '"></option>').join('') + '</datalist></label>' +
          '<label><span>失败策略</span><select data-node-field="fallbackMode">' + option('best-effort', '可换同类底座继续', item.fallbackMode) + option('strict', '严格使用指定底座', item.fallbackMode) + '</select></label>' +
          '<label><span>Runner 标签</span><input data-node-field="runnerTags" value="' + h(item.runnerTags) + '" placeholder="gpu, windows"></label>' +
          '<label><span>超时（秒）</span><input type="number" min="60" max="86400" data-node-field="timeoutSeconds" value="' + item.timeoutSeconds + '"></label>' +
          '<label><span>最多尝试</span><input type="number" min="1" max="5" data-node-field="maxAttempts" value="' + item.maxAttempts + '"></label></div>' +
          capabilityRows(item, 'skills', skills, '本节点 Skill') +
          capabilityRows(item, 'mcpServers', mcp, '本节点连接器') +
          capabilityRows(item, 'runtime', runtime, '本节点运行能力') + '</section>' : '') +
        ((!ai && item.type !== 'human_review' && item.type !== 'publish')
          ? '<section class="cap-node-section"><header><b>企业执行配置</b><em>审核发布后由 Hub 按项目权限执行</em></header>' +
            '<textarea data-node-field="configJson" spellcheck="false">' + h(item.configJson) + '</textarea></section>' : '') +
        '<section class="cap-node-section"><header><b>交付给下游</b><button type="button" data-node-action="add-output"' + (!ai ? ' disabled' : '') + '>＋ 添加产出</button></header>' +
          '<div class="cap-output-list">' + outputRows(item) + '</div></section>' +
        '<section class="cap-node-handoff"><b>本节点将收到</b><p>' + (item.dependsOn.length ? item.dependsOn.map(key => {
          const source = nodes.find(x => x.key === key); return source ? source.name + '的 ' + (source.outputs.map(x => x.label).join('、') || '完成状态') : key;
        }).join('；') : '需求原始输入') + '</p></section></section>';
    }

    function renderWorkflow() {
      workflowEl.hidden = template !== 'workflow';
      if (workflowEl.hidden) return;
      selected = Math.max(0, Math.min(selected, nodes.length - 1));
      workflowEl.innerHTML = '<div class="cap-workflow-head"><div><b>执行编排</b><span>节点可以选择不同 Agent 和模型；上下文按产出契约交接。</span></div><em>结构化 DAG · 发布前无副作用预检</em></div>' +
        '<div class="cap-workflow-layout">' + nodeList() + inspector() + '</div>';
    }

    function setNodeType(item, type) {
      item.type = type; item.name = TYPES[type][0];
      item.inputs = [];
      if (type === 'ai' || type === 'ai_review') {
        if (!item.prompt) item.prompt = type === 'ai_review' ? '独立审查上游结果并给出明确结论。' : '完成本节点工作并交付可验证结果。';
        if (!item.outputs.length) item.outputs = [{ key: type === 'ai_review' ? 'review' : 'result', kind: 'evidence', label: TYPES[type][0] + '结果', required: true }];
      } else { item.outputs = []; item.configJson = JSON.stringify(ENTERPRISE_CONFIG[type] || {}, null, 2); }
      resetDependentInputs(item.key);
    }

    function resetDependentInputs(sourceKey) {
      nodes.filter(node => node.dependsOn.includes(sourceKey)).forEach(node => { node.inputs = []; });
    }

    workflowEl.addEventListener('click', function (event) {
      const row = event.target.closest('[data-node-index]');
      if (row) { selected = Number(row.dataset.nodeIndex); renderWorkflow(); return; }
      const remove = event.target.closest('[data-output-remove]');
      if (remove) {
        const source = nodes[selected];
        source.outputs.splice(Number(remove.dataset.outputRemove), 1);
        resetDependentInputs(source.key);
        resetPreview(); renderWorkflow(); return;
      }
      const action = event.target.closest('[data-node-action]');
      if (!action || action.disabled) return;
      const kind = action.dataset.nodeAction;
      if (kind === 'add') { nodes.push(newNode(workflowEl.querySelector('#capNodeType').value)); selected = nodes.length - 1; }
      if (kind === 'delete') {
        const removed = nodes[selected].key; nodes.splice(selected, 1);
        nodes.forEach(item => {
          item.dependsOn = item.dependsOn.filter(key => key !== removed);
          item.inputs = [];
        });
        selected = Math.min(selected, nodes.length - 1);
      }
      if (kind === 'up' && selected > 0) { [nodes[selected - 1], nodes[selected]] = [nodes[selected], nodes[selected - 1]]; selected -= 1; }
      if (kind === 'down' && selected < nodes.length - 1) { [nodes[selected + 1], nodes[selected]] = [nodes[selected], nodes[selected + 1]]; selected += 1; }
      if (kind === 'add-output') {
        const source = nodes[selected];
        source.outputs.push({ key: 'output_' + (source.outputs.length + 1), kind: 'evidence', label: '新产出', required: true });
        resetDependentInputs(source.key);
      }
      resetPreview(); renderWorkflow();
    });

    workflowEl.addEventListener('input', function (event) {
      const item = nodes[selected]; if (!item) return;
      const field = event.target.dataset.nodeField;
      if (field) item[field] = event.target.type === 'number' ? Number(event.target.value) : event.target.value;
      const outputField = event.target.dataset.outputField;
      if (outputField) {
        const row = event.target.closest('[data-output-index]'); const output = item.outputs[Number(row.dataset.outputIndex)];
        output[outputField] = event.target.type === 'checkbox' ? event.target.checked : event.target.value;
        if (outputField === 'kind' && !['file', 'decision'].includes(output.kind)) delete output.path;
      }
      resetPreview();
    });

    workflowEl.addEventListener('change', function (event) {
      const item = nodes[selected]; if (!item) return;
      if (event.target.dataset.nodeField === 'type') { setNodeType(item, event.target.value); resetPreview(); renderWorkflow(); return; }
      if (event.target.dataset.nodeField === 'agentKind') {
        const meta = routeMeta(item.agentKind);
        if (meta.modelPick === false) item.model = '';
        resetPreview(); renderWorkflow(); return;
      }
      const dep = event.target.dataset.nodeDependency;
      if (dep) {
        item.dependsOn = event.target.checked ? [...new Set([...item.dependsOn, dep])] : item.dependsOn.filter(x => x !== dep);
        item.inputs = [];
        resetPreview(); renderWorkflow(); return;
      }
      const cap = event.target.dataset.nodeCapability;
      if (cap) {
        const raw = base();
        const available = cap === 'skills' ? raw.skills
          : cap === 'mcpServers' ? values(raw.mcpServers) : raw.runtimeCapabilities;
        if (item[cap] == null) item[cap] = available.slice();
        item[cap] = event.target.checked ? [...new Set([...item[cap], event.target.value])] : item[cap].filter(x => x !== event.target.value);
        resetPreview();
      }
      const outputField = event.target.dataset.outputField;
      if (outputField === 'kind') renderWorkflow();
    });

    function renderPreview(preview) {
      const manifest = preview.manifest || {};
      const simulation = preview.simulation || {};
      const rows = simulation.order || [];
      previewEl.innerHTML = '<header class="cap-preview-head"><span>预检通过</span><b>' + h(manifest.name) + ' · v' + h(manifest.version) + '</b><em>不执行真实操作</em></header>' +
        '<div class="cap-simulation">' + rows.map(function (item) {
          return '<div><i>' + item.index + "</i><span><b data-user-content>" + h(item.name) + '</b><em>' + h(TYPES[item.type] ? TYPES[item.type][0] : item.type) +
            h(previewRouteText(item)) + '</em></span><small>' +
            h(item.handoffs.length ? item.handoffs.join('；') : '接收需求原始输入') + '</small></div>';
        }).join('') + '</div>' +
        '<div class="cap-checks">' + (preview.checks || []).map(x => "<span class=\"cap-check\">" + h(x.label) + '</span>').join('') + '</div>';
      previewEl.hidden = false;
    }

    const fieldEditor = FIELDS.create({ layer, inputs: draft.inputs, setup: setupDraft,
      onChange: resetPreview, option });

    layer.querySelectorAll('[data-maker-type]').forEach(function (button) {
      button.addEventListener('click', function () {
        template = button.dataset.makerType;
        if (template !== 'workflow' && standaloneToggle && standaloneToggle.checked) {
          standaloneToggle.checked = false;
          distribution = '';
        }
        entrypoints = entrypointState(null, template);
        layer.querySelectorAll('[data-entrypoint]').forEach(x => { x.checked = Boolean(entrypoints[x.dataset.entrypoint]); });
        layer.querySelectorAll('[data-maker-type]').forEach(x => x.classList.toggle('on', x === button));
        layer.querySelector('.cap-maker-mcp').hidden = template === 'method';
        resetPreview(); renderWorkflow(); renderIcon();
      });
    });
    if (standaloneToggle) standaloneToggle.addEventListener('change', function () {
      distribution = standaloneToggle.checked ? 'standalone' : '';
      if (standaloneToggle.checked) {
        template = 'workflow';
        entrypoints = { conversation: false, task: true, automation: true };
        nodes = standaloneNodes();
        layer.querySelectorAll('[data-maker-type]').forEach(function (x) {
          x.classList.toggle('on', x.dataset.makerType === 'workflow');
        });
        layer.querySelectorAll('[data-entrypoint]').forEach(function (x) {
          x.checked = Boolean(entrypoints[x.dataset.entrypoint]);
        });
        const mcp = layer.querySelector('.cap-maker-mcp');
        if (mcp) mcp.hidden = false;
      }
      resetPreview(); renderWorkflow(); renderIcon();
    });
    layer.querySelectorAll('[data-entrypoint]').forEach(function (field) {
      field.addEventListener('change', function () {
        const activeCount = Object.values(entrypoints).filter(Boolean).length;
        if (!this.checked && activeCount === 1) {
          this.checked = true; return ctx.say('至少保留一个使用场景');
        }
        entrypoints[this.dataset.entrypoint] = this.checked; resetPreview();
      });
    });
    layer.querySelectorAll('.cap-input,.cap-textarea,[data-runtime],[data-plugin-platform],#capPluginSoduWorkMedia').forEach(function (field) {
      field.addEventListener(field.matches('[type="checkbox"]') ? 'change' : 'input', function () {
        resetPreview();
        if (field.id === 'capPluginName' || field.id === 'capPluginDesc') renderIcon();
        if (template === 'workflow' && (field.id === 'capPluginMcp' || field.id === 'capPluginSoduWorkMedia' || field.dataset.runtime || field.dataset.pluginPlatform)) renderWorkflow();
      });
    });
    layer.querySelector('#capMakerCancel').addEventListener('click', ctx.closeModal);
    layer.querySelector('#capMakerAgent').addEventListener('click', function () {
      if (ctx.createWithAgent) ctx.createWithAgent(editing ? draft : undefined);
    });
    const recent = layer.querySelector('#capMakerRecent');
    if (recent) recent.addEventListener('click', async function () {
      const scope = SoduWorkAPI.taskStorageKey?.('ops');
      const isCurrent = () => scope === SoduWorkAPI.taskStorageKey?.('ops');
      const api = global.soduWorkAPI && (global.soduWorkAPI.conversationSession || global.soduWorkAPI.piSession);
      if (!api || typeof api.recentPluginDraft !== 'function') return ctx.say('当前没有可读取的会话插件草稿');
      this.disabled = true;
      try {
        const got = await api.recentPluginDraft();
        if (!isCurrent()) return;
        if (!got || got.ok === false) throw new Error(got && got.reason || '没有找到插件草稿');
        if (got.kind === 'skill') return await UTILS.openSkillPackage(got, ctx, isCurrent);
        const preview = await SoduWorkAPI.preflightPluginDraft(got.body);
        ctx.closeModal(); deps.openLocalImport(got.body, preview, ctx);
      } catch (error) {
        ctx.say(ctx.errorText(error, '最近会话里没有可安装的插件草稿'));
        this.disabled = false;
      }
    });
    submit.addEventListener('click', async function () {
      if (iconLoading) return;
      const body = readBody();
      if (!body.name || !body.version || !body.description || !body.instructions) {
        return ctx.say('名称、版本、用途和工作方法要填写完整');
      }
      if (template === 'connector' && !global.SoduWorkPluginPlatforms.connectorReady(
          values(body.mcpServers), body.runtimeCapabilities, body.resources || [], body.platforms)) {
        return ctx.say('请选择平台账号、填写连接器，或通过对话制作带 CLI 脚本的系统连接插件');
      }
      if (editing && compareVersions(body.version, originalVersion) <= 0) {
        return ctx.say('新版本必须高于当前 v' + originalVersion + '，旧版本不会被覆盖');
      }
      if (editing && versions.some(item => String(item.version || item) === body.version)) {
        return ctx.say('v' + body.version + ' 已存在，请使用新的 SemVer 版本号');
      }
      const signature = JSON.stringify(body);
      this.disabled = true;
      if (previewSignature !== signature) {
        this.textContent = '正在预检…';
        try {
          const preview = await SoduWorkAPI.preflightPluginDraft(body);
          renderPreview(preview); previewSignature = signature;
          this.textContent = saveLabel();
        } catch (error) {
          ctx.say(ctx.errorText(error, '插件预检没有通过'));
          this.textContent = '检查并继续';
        }
        this.disabled = false; return;
      }
      this.textContent = editing ? '正在保存…' : '正在安装…';
      try {
        const result = await SoduWorkAPI.createPluginDraft(body);
        ctx.closeModal();
        ctx.say(editing
          ? '已保存 v' + body.version + '，v' + originalVersion + ' 与历史需求记录保持不变'
          : body.distribution === 'standalone'
            ? '独立插件已保存，可从插件详情提交平台审核或导出压缩包'
            : (result.message || '个人插件已安装'));
        if (deps.load) await deps.load();
        if (ctx.refresh) ctx.refresh();
        if (!editing && body.distribution !== 'standalone' && result.plugin &&
            typeof ctx.tryPlugin === 'function') {
          ctx.tryPlugin(result.plugin);
        }
      } catch (error) {
        ctx.say(ctx.errorText(error, editing ? '新版本没有保存成功' : '插件没有安装成功'));
        this.disabled = false;
        this.textContent = saveLabel();
      }
    });
    renderIcon();
    fieldEditor.render();
    skillPicker.render();
    renderWorkflow();
    loadRouteDirectory();
    skillPicker.load();
  }

  global.SoduWorkPluginMaker = { open };
})(window);
