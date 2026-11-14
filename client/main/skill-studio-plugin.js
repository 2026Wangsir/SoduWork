'use strict';
const fs = require('node:fs');
const path = require('node:path');

// The same canonical skill is shipped to desktop and Runner. Nothing is executed
// when cataloging/installing: resources only materialize in an authorized chat.
const FILES = [
  'SKILL.md', 'references/authoring.md', 'references/formats.md',
  'scripts/skill-package.cjs', 'scripts/skill-validate.cjs', 'scripts/skill-zip.cjs',
  'assets/purchase-check/SKILL.md', 'assets/purchase-check/references/rules.md',
];
let cached;
function body(app) {
  const root = app.isPackaged
    ? path.join(process.resourcesPath, 'skills', 'skill-studio')
    : path.resolve(__dirname, '../../skills/skill-studio');
  const stamp = root + FILES.map(p => { const s = fs.statSync(path.join(root, p)); return ':' + s.mtimeMs + ':' + s.size; }).join('');
  if (cached?.stamp === stamp) return cached.body;
  const value = {
    template: 'method', key: 'skill-studio', name: 'Skill 创建与优化', version: '1.0.0',
    description: '把业务流程变成可复用 Skill；创建、调整、校验并导出 Codex、Claude Code、Copilot 和 SoduWork 技能包。',
    instructions: [
      '你是 Skill 创建与优化助手。在当前会话中使用用户提供的业务资料，新建、调整、检查或导出 Skill；不创建第二条会话。',
      '先读取本轮插件资源目录内的 references/studio/SKILL.md，遵循其中的梳理、编写、校验、业务测试与交付步骤。',
      '辅助脚本位于同一资源目录的 references/studio/scripts/skill-package.cjs，需要 Node.js 18+。不得执行导入包中的未知脚本。',
      '支持 portable、codex、claude、copilot、soduwork 五种目标布局；默认 all。只有缺少会改变结果的信息时才询问。',
      '产出真实 SKILL.md、资源、可下载的目标包、检查报告及变更说明，不能只返回 JSON。SoduWork 目标交付 .skill 技能包，通过技能导入入口安装并在技能列表使用。',
      '更新已有 Skill 时先复制到新候选目录、保留原材料和权限；跨平台不兼容配置必须说明并单独调整，不能静默丢弃。',
      '使用现有成果登记并保留其他成果。安装和发布必须经用户确认，企业审核流程保持不变。没有实际运行的宿主不得写成已验证。',
    ].join('\n'),
    runtimeCapabilities: ['files', 'terminal'],
    entrypoints: { conversation: true, task: true, automation: false },
    inputs: [
      { key: 'operation', label: '本次工作', type: 'select', default: 'create',
        options: [{ value: 'create', label: '创建 Skill' }, { value: 'improve', label: '调整已有 Skill' }, { value: 'review', label: '检查与导出' }] },
      { key: 'target', label: '目标平台', type: 'select', default: 'all',
        options: [{ value: 'all', label: '全部兼容格式' }, { value: 'portable', label: '通用 Agent Skills' }, { value: 'codex', label: 'Codex' },
          { value: 'claude', label: 'Claude Code' }, { value: 'copilot', label: 'GitHub Copilot' }, { value: 'soduwork', label: 'SoduWork' }] },
      { key: 'brief', label: '业务说明或调整要求', type: 'textarea', placeholder: '说明业务步骤、输入材料和希望生成的成果；已有 Skill 可以作为附件提供。' },
    ],
    resources: FILES.map(p => ({
      path: 'references/studio/' + p,
      kind: p.startsWith('scripts/') ? 'script' : p.startsWith('assets/') ? 'example' : 'reference',
      encoding: 'base64', content: fs.readFileSync(path.join(root, p)).toString('base64'),
    })),
  };
  cached = { stamp, body: value };
  return value;
}
module.exports = { body, FILES };
