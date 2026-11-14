#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { zip } = require('./skill-zip.cjs');
const { validate, checkTargets, noLinks, hash, fail } = require('./skill-validate.cjs');
const TARGETS = ['portable', 'codex', 'claude', 'copilot', 'soduwork'];
const json = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const under = (parent, child) => {
  const rel = path.relative(parent, child);
  return !rel || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
};
function compare(before, after) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().map(name => ({
    path: name,
    status: !before[name] ? 'added' : !after[name] ? 'removed' : hash(before[name]) === hash(after[name]) ? 'unchanged' : 'changed',
    before: before[name] ? hash(before[name]) : null, after: after[name] ? hash(after[name]) : null,
  }));
}
function summary(result) {
  return {
    schemaVersion: 1, name: result.meta.name, validation: 'portable-structure-only',
    runtimeTested: false, fileCount: Object.keys(result.files).length, bytes: result.bytes,
    warnings: result.warnings,
    checks: ['frontmatter-subset', 'name', 'description', 'markdown-links', 'portable-paths', 'size', 'common-credential-patterns'],
    files: Object.keys(result.files).sort().map(name => ({ path: name, sha256: hash(result.files[name]), size: result.files[name].length })),
  };
}
function build(options) {
  if (!options.source || !options.out) fail('build requires --source and --out');
  const version = options.version || '1.0.0';
  const semver = version.match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/);
  if (!semver || semver[4]?.split('.').some(p => /^\d+$/.test(p) && p.length > 1 && p.startsWith('0'))) fail('version must be SemVer');
  const targets = [...new Set(options.targets === 'all' || !options.targets ? TARGETS : options.targets.split(',').map(t => t === 'soduwork' ? 'soduwork' : t))];
  if (!targets.length || targets.some(t => !TARGETS.includes(t))) fail('Unsupported target; choose ' + TARGETS.join(','));
  const source = validate(options.source), out = path.resolve(options.out);
  checkTargets(source, targets); noLinks(out);
  if (fs.existsSync(out)) fail('Output already exists; choose a new directory');
  if (!fs.statSync(path.dirname(out)).isDirectory()) fail('Output parent must exist');
  if (under(source.root, out)) fail('Output cannot be inside the source');
  const baseline = options.baseline ? validate(options.baseline) : null;
  if (baseline && (under(baseline.root, out) || baseline.meta.name !== source.meta.name)) fail('Baseline identity must match; output must be outside the original');
  const changes = compare(baseline ? baseline.files : {}, source.files);
  if (!options.allowRemovals && changes.some(c => c.status === 'removed')) fail('Update would remove files; review the baseline before using --allow-removals');
  const name = source.meta.name, title = (source.body.match(/^#\s+(.+)$/m)?.[1] || name).slice(0, 120);
  const artifacts = {}, exports = [], warnings = [...source.warnings];
  for (const target of targets) {
    const prefix = ({
      portable: name + '/', codex: '.agents/skills/' + name + '/',
      claude: '.claude/skills/' + name + '/', copilot: '.github/skills/' + name + '/',
      soduwork: name + '/',
    })[target];
    const entries = Object.fromEntries(Object.entries(source.files).map(([p, bytes]) => [prefix + p, bytes]));
    if (target === 'codex' && !source.files['agents/openai.yaml']) {
      entries[prefix + 'agents/openai.yaml'] = Buffer.from(
        'interface:\n  display_name: ' + JSON.stringify(title) +
        '\n  short_description: "Reusable business workflow with checked inputs and outputs"' +
        '\n  default_prompt: ' + JSON.stringify('Use $' + name + ' to complete this business task and verify the deliverables.') + '\n');
    }
    const filename = name + '-' + version + '-' + target + (target === 'soduwork' ? '.skill' : '.zip');
    artifacts[filename] = zip(entries);
    exports.push({ target, file: filename, skillRoot: prefix, sha256: hash(artifacts[filename]), files: Object.keys(entries).sort() });
  }
  const report = { ...summary(source), version, warnings, exports, changes,
    baseline: baseline ? { name: baseline.meta.name, files: summary(baseline).files } : null };
  artifacts['skill-report.json'] = json(report);
  artifacts['CHANGES.md'] = Buffer.from('# Skill 文件变更\n\n' +
    (baseline ? '原包未修改；以下为候选包相对原包的变化。' : '首次创建；下列文件包含在源包中。') +
    '\n\n' + changes.map(c => '- ' + c.status + ': ' + c.path).join('\n') +
    '\n\n本清单按文件校验值比较；业务行为变化需另外审阅。\n');
  artifacts['INSTALL.md'] = Buffer.from('# 安装与验证\n\n解压到项目根目录后按对应宿主的 Skill 入口使用；不要重复嵌套目录。\n\n' +
    exports.map(e => '- ' + e.target + ': ' + e.file + ' → ' + e.skillRoot).join('\n') +
    '\n\nSoduWork 使用 .skill 技能包，在会话成果中检查并导入，或在“插件 → 技能”中导入能力包。导入并启用后可在技能列表中找到；与公司共享时沿用技能共享流程。\n\n' +
    '本次仅完成结构、资源和常见敏感内容检查，没有自动执行业务脚本或验证外部 Agent。请使用脱敏样例完成正常、缺项和异常场景测试。权限声明由各宿主解释，不能跨平台视作等效授权。\n\n' +
    warnings.map(w => '- ' + w).join('\n') + '\n');
  // All validation/export serialization completes before creating the fresh output.
  fs.mkdirSync(out);
  for (const [p, data] of Object.entries(source.files)) {
    const dest = path.join(out, 'source', name, p);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, data, { flag: 'wx' });
  }
  for (const [p, data] of Object.entries(artifacts)) fs.writeFileSync(path.join(out, p), data, { flag: 'wx' });
  return report;
}
function cli(argv) {
  const [command, ...args] = argv;
  if (command === '--help' || !command) {
    return { usage: 'skill-package.cjs validate --source <skill-dir> | build --source <skill-dir> --out <new-dir> [--targets all|portable,codex,claude,copilot,soduwork] [--version 1.0.0] [--baseline <original-dir>] [--allow-removals]' };
  }
  if (!['validate', 'build'].includes(command)) fail('Unknown command');
  const options = {}, names = { '--source': 'source', '--out': 'out', '--targets': 'targets', '--version': 'version', '--baseline': 'baseline' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--allow-removals' && !options.allowRemovals) { options.allowRemovals = true; continue; }
    const key = names[args[i]];
    if (!key || options[key] || !args[i + 1] || args[i + 1].startsWith('--')) fail('Unknown, duplicate, or missing option value');
    options[key] = args[++i];
  }
  if (!options.source) fail('--source is required');
  if (command === 'validate' && Object.keys(options).some(k => k !== 'source')) fail('validate accepts only --source');
  return command === 'build' ? build(options) : summary(validate(options.source));
}
if (require.main === module) {
  try { process.stdout.write(JSON.stringify(cli(process.argv.slice(2)), null, 2) + '\n'); }
  catch (error) {
    // Never print stack traces, source contents, or secret matches.
    process.stderr.write(JSON.stringify({ ok: false, error: error.code ? 'File operation failed (' + error.code + ')' : error.message }) + '\n');
    process.exitCode = 1;
  }
}
module.exports = { build, cli, summary };
