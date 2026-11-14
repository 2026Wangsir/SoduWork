'use strict';

/* The workspace is evidence. Only a declared or inferred result is a deliverable. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const artifactTitle = require('./artifact-title');

const SCHEMA_VERSION = 1;
const MAX_ITEMS = 500;
const MANIFEST_RELATIVE = '.soduwork/delivery.json';
const KINDS = Object.freeze({
  '.docx': 'document',
  '.doc': 'document',
  '.odt': 'document',
  '.pptx': 'presentation',
  '.ppt': 'presentation',
  '.odp': 'presentation',
  '.xlsx': 'spreadsheet',
  '.xls': 'spreadsheet',
  '.ods': 'spreadsheet',
  '.csv': 'spreadsheet',
  '.pdf': 'pdf',
  '.html': 'website',
  '.htm': 'website',
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.webp': 'image',
  '.gif': 'image',
  '.svg': 'image',
  '.mp4': 'video',
  '.webm': 'video',
  '.mov': 'video',
  '.m4v': 'video',
  '.ogv': 'video',
  '.zip': 'archive',
  '.skill': 'archive',
  '.7z': 'archive',
  '.tar': 'archive',
  '.gz': 'archive',
  '.md': 'document',
  '.markdown': 'document',
  '.txt': 'document',
});
const DIRECT = new Set([
  'document', 'presentation', 'spreadsheet', 'pdf', 'video', 'archive',
]);
const PROCESS_DIRS = new Set([
  'src', 'source', 'test', 'tests', 'spec', 'specs', 'coverage',
  'node_modules', '.git', '.pi', '.soduwork', 'log', 'logs', 'tmp', 'temp',
]);
const PROCESS_FILES = new Set([
  'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock',
  'bun.lockb', 'pyproject.toml', 'requirements.txt', 'code-review.json',
  'delivery-review.json', 'workflow-decision.json',
  'readme.md', 'readme.txt', 'changelog.md', 'license.txt', 'agents.md', 'contributing.md',
]);
const PROCESS_PREFIXES = [
  'tsconfig', 'vite.config', 'webpack.config', 'eslint.config',
  'test-result', 'coverage',
];
const PROCESS_WORDS = [
  'test', 'spec', 'fixture', 'mock', 'cache', 'debug', 'trace', 'log',
  'screenshot', 'screen-shot', 'command-output', 'terminal-output',
  'browser-output', 'tool-output', '\u4e34\u65f6', '\u8349\u7a3f',
  '\u622a\u56fe',
];
// A deliverable title can legitimately name a test plan or a testing tool.
// Treat Chinese testing terms as process evidence only when
// it names a report/result, matching the server-side delivery classifier.
const PROCESS_PHRASES = ['\u6d4b\u8bd5\u62a5\u544a', '\u6d4b\u8bd5\u7ed3\u679c',
  '\u6d4b\u8bd5\u8bc1\u636e', '\u9a8c\u6536\u62a5\u544a', '\u9a8c\u6536\u8bc1\u636e'];
const FINAL_WORDS = [
  'final', 'result', 'report', 'summary', 'deliverable', 'output',
  'proposal', 'presentation', 'prototype', '\u6210\u679c', '\u7ed3\u679c',
  '\u62a5\u544a', '\u65b9\u6848', '\u4ea4\u4ed8', '\u6210\u54c1',
  '\u7ec8\u7a3f', '\u539f\u578b',
];

const clean = (value, limit) =>
  String(value == null ? '' : value).trim().slice(0, limit);
const relative = (value) =>
  String(value || '').replace(/\\/g, '/').replace(/^\/+/, '');
const kindOf = (value) =>
  KINDS[path.extname(String(value || '')).toLowerCase()] || '';
const previewOf = (kind) =>
  ['website', 'pdf', 'image', 'video'].includes(kind);

function artifactId(kind, value) {
  const key = String(kind || 'file') + '\0' + relative(value);
  return 'art_' + crypto.createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 24);
}

function actionsOf(kind) {
  return kind === 'website' || kind === 'video'
    ? ['preview', 'open', 'reveal']
    : ['open', 'reveal'];
}

function inside(root, target) {
  const base = path.resolve(root || '.');
  const part = path.relative(base, path.resolve(target || ''));
  return Boolean(part && !part.startsWith('..') && !path.isAbsolute(part));
}

function hasWord(value, words) {
  const text = String(value || '').toLowerCase();
  return words.some((word) => text.includes(word));
}

function isProcessName(value) {
  const text = String(value || '').toLowerCase();
  if (PROCESS_PHRASES.some((phrase) => text.includes(phrase))) return true;
  return PROCESS_WORDS.some((word) => {
    // Keep short ASCII markers boundary-aware so names like “latest.md” do
    // not become process evidence merely because they contain “test”.
    if (/^[a-z0-9-]+$/.test(word)) {
      const escaped = word.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&');
      return new RegExp('(^|[^a-z0-9])' + escaped + '([^a-z0-9]|$)', 'i').test(text);
    }
    return text.includes(word);
  });
}

function publicFile(file, spec, cwd) {
  const requestedKind = clean(spec && spec.kind, 32);
  const inferredKind = kindOf(file.name || file.path);
  /* "file" is the manifest's generic fallback, not an instruction to erase a
     format that can be determined from the real artifact.  Keeping .md as
     "file" made the document gate demand an unnecessary PDF repair cycle. */
  const kind = (!requestedKind || requestedKind === 'file')
    ? (inferredKind || 'file') : requestedKind;
  const requestedTitle = clean(spec && (spec.title || spec.label), 160);
  const rel = relative(file.relative || file.rel || file.name);
  return {
    ...file,
    artifactId: artifactId(kind, rel),
    relative: rel,
    kind,
    title: requestedTitle || artifactTitle.fromFile(cwd, file) || String(file.name || '\u672a\u547d\u540d\u6210\u679c'),
    summary: clean(spec && spec.summary, 500),
    preview: typeof (spec && spec.preview) === 'boolean'
      ? spec.preview
      : previewOf(kind),
    primary: !spec || spec.primary !== false,
    ...(spec?.role ? { role: spec.role } : {}),
    ...(Array.isArray(spec?.replaces) ? { replaces: spec.replaces.filter(value => typeof value === 'string') } : {}),
    actions: actionsOf(kind),
    runtime: kind === 'website'
      ? { type: 'static', autoStart: true }
      : null,
    changedInTurn: Boolean(file.changedInTurn),
  };
}

function readManifest(cwd) {
  try {
    const file = path.join(cwd || '', MANIFEST_RELATIVE);
    if (!fs.statSync(file).isFile()) return null;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const valid = raw &&
      Number(raw.schemaVersion) === SCHEMA_VERSION &&
      Array.isArray(raw.deliverables);
    if (valid) return raw;
    return {
      invalid: true,
      reason: '\u4ea4\u4ed8\u6e05\u5355\u683c\u5f0f\u4e0d\u7b26\u5408 SoduWork v1 \u534f\u8bae',
    };
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    return {
      invalid: true,
      reason: '\u4ea4\u4ed8\u6e05\u5355\u65e0\u6cd5\u8bfb\u53d6\uff1a' +
        String(error && error.message || error),
    };
  }
}

function fromManifest(cwd, files, manifest) {
  const byRel = new Map(
    (files || []).map((file) => [relative(file.relative), file]),
  );
  const items = [];
  const warnings = [];
  // Keep one overflow entry so packaging rejects an oversized manifest instead
  // of silently publishing a truncated delivery.
  const declared = manifest.presentation === 'summary' ? [] : (manifest.deliverables || []).slice(0, MAX_ITEMS + 1);
  declared.forEach((spec) => {
    const rel = relative(spec && (spec.path || spec.entry));
    const full = path.resolve(cwd, rel);
    if (!rel || rel.includes('../') || !inside(cwd, full)) {
      warnings.push(
        '\u5df2\u5ffd\u7565\u4e0d\u5b89\u5168\u7684\u4ea4\u4ed8\u8def\u5f84',
      );
      return;
    }
    let file = byRel.get(rel);
    if (!file) {
      try {
        const stat = fs.statSync(full);
        if (!stat.isFile()) throw new Error('\u4e0d\u662f\u6587\u4ef6');
        file = {
          path: full,
          relative: rel,
          name: path.basename(full),
          size: stat.size,
          at: Math.round(stat.mtimeMs),
        };
      } catch (_) {
        warnings.push(
          '\u4ea4\u4ed8\u6587\u4ef6\u4e0d\u5b58\u5728\uff1a' + rel,
        );
        return;
      }
    }
    items.push(publicFile(file, spec, cwd));
  });
  return {
    schemaVersion: SCHEMA_VERSION,
    source: 'manifest',
    presentation: manifest.presentation === 'summary' ? 'summary' : 'artifacts',
    summary: clean(manifest.summary, 800),
    items: items.slice(0, MAX_ITEMS + 1),
    warnings,
  };
}

function isProcess(file) {
  const rel = relative(file.relative || file.name);
  const name = path.basename(rel).toLowerCase();
  const stem = name.replace(/\.[^.]+$/, '');
  const inProcessDir = rel
    .toLowerCase()
    .split('/')
    .slice(0, -1)
    .some((part) => PROCESS_DIRS.has(part));
  const configured = PROCESS_FILES.has(name) ||
    PROCESS_PREFIXES.some((prefix) => {
      return stem === prefix || stem.startsWith(prefix + '.');
    });
  // Browser verification commonly uses numbered shots. Classify them here,
  // once, so the artifact index and every runtime's UI receive the same flag.
  // A delivery manifest can still explicitly declare a requested screenshot.
  const verificationShot = kindOf(name) === 'image' &&
    /^(?:verify|verification)[-_.](?:(?:shot|frame)(?:[-_.]?\d+)?|top|bottom|desktop|mobile|after[-_]click)$/i.test(stem);
  return inProcessDir || configured || verificationShot || isProcessName(stem);
}

function websiteRank(file) {
  const rel = relative(file.relative);
  const entry = /(?:^|\/)index\.html?$/i.test(rel) ? 2 : 0;
  const built = /(?:^|\/)(?:dist|build|public)(?:\/|$)/i.test(rel) ? 1 : 0;
  return entry + built;
}

function infer(files, cwd) {
  // A repository's entry HTML and documentation are source files. Explicit
  // manifests can still declare a standalone report/site produced in a repo.
  const project = Boolean(cwd && ['.git', 'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'pom.xml', 'CMakeLists.txt']
    .some(name => fs.existsSync(path.join(cwd, name))));
  const rows = (files || []).filter((file) => !isProcess(file) && (!project ||
    !['website', 'document'].includes(kindOf(file.name)) ||
    !/\.(?:html?|md|markdown|txt)$/i.test(file.name) ||
    /(?:^|\/)(?:outputs|deliverables|exports)\//i.test(relative(file.relative))));
  const sites = rows
    .filter((file) => kindOf(file.name) === 'website')
    .sort((a, b) => {
      return Number(Boolean(b.changedInTurn)) - Number(Boolean(a.changedInTurn)) ||
        websiteRank(b) - websiteRank(a) ||
        Number(b.at || 0) - Number(a.at || 0);
    });
  const items = [];
  if (sites[0]) {
    items.push(publicFile(sites[0], {
      kind: 'website',
      title: artifactTitle.fromFile(cwd, sites[0]) || (sites[0].name === 'index.html'
        ? '\u7f51\u7ad9\u9884\u89c8'
        : sites[0].name),
      summary: '\u53ef\u5728 SoduWork \u53f3\u4fa7\u5de5\u4f5c\u533a\u76f4\u63a5\u6253\u5f00',
      preview: true,
    }));
  }
  rows.forEach((file) => {
    if (items.some((item) => item.path === file.path)) return;
    const kind = kindOf(file.name);
    const stem = String(file.name || '').replace(/\.[^.]+$/, '');
    const namedResult = hasWord(stem, FINAL_WORDS);
    // A final-named image next to a website is ambiguous: it may be a browser
    // capture or a page asset. Only a manifest or the media index declares it
    // as a separate deliverable; dependency collection still includes site assets.
    if (DIRECT.has(kind) ||
        ((kind === 'document' || (kind === 'image' && !sites.length)) && namedResult)) {
      items.push(publicFile(file));
    }
  });
  return {
    schemaVersion: SCHEMA_VERSION,
    source: 'inferred',
    summary: '',
    items: items
      .sort((a, b) => Number(b.at || 0) - Number(a.at || 0))
      .slice(0, MAX_ITEMS),
    warnings: [],
  };
}

function classify(cwd, files) {
  const manifest = readManifest(cwd);
  const result = manifest && !manifest.invalid
    ? fromManifest(cwd, files, manifest)
    : infer(files, cwd);
  // A completed media download explicitly declares a deliverable. Match only
  // the actual workspace inventory and retain the existing delivery manifest.
  try {
    if (result.presentation === 'summary') return { ...result, workspaceFileCount: (files || []).length, omittedCount: (files || []).length };
    const indexFile = path.join(cwd, 'outputs', '.soduwork-media-index.json');
    if (fs.statSync(indexFile).size <= 256 * 1024) {
      const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
      const generated = new Set(Object.values(index).filter(value => typeof value === 'string')
        .map(value => 'outputs/' + value.replace(/\\/g, '/')));
      const present = new Set(result.items.map(item => item.relative));
      const media = (files || []).filter(file => generated.has(file.relative) && !present.has(file.relative) &&
        ['image', 'video'].includes(kindOf(file.relative)) && !isProcess(file));
      result.items = [...media.map(file => publicFile(file, { primary: true })), ...result.items].slice(0, MAX_ITEMS);
    }
  } catch (_) { /* No completed media index in ordinary workspaces. */ }
  if (manifest && manifest.invalid) {
    result.warnings.push(manifest.reason);
  }
  result.workspaceFileCount = (files || []).length;
  result.omittedCount = Math.max(
    0,
    result.workspaceFileCount - result.items.length,
  );
  return result;
}

function instructions() {
  return [
    '[SoduWork \u4ea4\u4ed8\u6e05\u5355\u534f\u8bae]',
    '先依据本次需求判断是否需要交付文件：说明、问答或代码变更不强制生成文件；明确要求网页、文档等成品时必须交付可实际使用的成果。最终交付、必需依赖和过程验证材料分开登记，不能用截图或测试报告代替用户要求的成品。',
    '工程开发、修复或代码审查以变更总结、验证结果和已有提交链接收尾，不要把源码、README 或专门生成的总结文档做成成果卡。此类任务将清单写为 {"schemaVersion":1,"presentation":"summary","summary":"变更摘要","deliverables":[]}；用户明确要求可下载文件或网页成品时才登记成果。',
    '单个文件直接交付原文件；多个文件组成一个保留结构的 ZIP。单 HTML 使用本地 HTTP 预览；需要服务的网页必须启动并验证实际运行 URL，右侧优先打开该 URL，不要用静态入口代替运行中的应用。',
    '同一成果的附属文件可在该 deliverable 的 files 数组中列出工作区相对文件路径，保留目录结构。只列最终运行所需文件，不包含输入材料、密钥、缓存、依赖目录和中间过程文件。多文件成果以一个交付包呈现。',
    '清单描述当前完整交付版本，不能不断追加会话中所有生成文件。修改或转换格式时更新对应条目，并用 replaces 数组记录被替代的旧相对路径；旧文件保留作历史，不再列为当前交付。用户明确要求保留两种格式时才同时列出。最终回复链接到当前成品。',
    '浏览器验证截图、测试报告、生成脚本放在 .soduwork/evidence 等过程目录，不列入 deliverables 或 files；已有过程文件可在 processFiles 数组中登记相对路径。网页只列入口与实际使用的资源。只有用户明确要求交付截图时才把截图作为独立成果，不能自行把验证图当成最终成品。',
    '网站如果依赖后端同源接口，在 runtime 中设置 networkPolicy:"online"，并用 externalDependencies 明确列出接口路径（如 ["/api/v1"]）。必须实际启动服务并验证接口；不要把接口伪造成静态文件。CSS、JS、图片和 Worker 仍须完整打包。',
    [
      '\u6e90\u7801\u3001\u4f9d\u8d56\u3001\u914d\u7f6e\u3001\u65e5\u5fd7\u3001\u6d4b\u8bd5\u3001',
      '\u5ba1\u67e5 JSON \u548c\u622a\u56fe\u5c5e\u4e8e\u8fc7\u7a0b\u8bc1\u636e\uff0c',
      '\u4e0d\u662f\u9ed8\u8ba4\u4ea4\u4ed8\u7269\u3002',
    ].join(''),
    [
      '\u5b8c\u6210\u5e76\u9a8c\u8bc1\u540e\u521b\u5efa .soduwork/delivery.json\uff0c',
      '\u53ea\u767b\u8bb0\u7528\u6237\u53ef\u76f4\u63a5\u6d88\u8d39\u7684\u6700\u7ec8\u6210\u679c\u3002',
    ].join(''),
    [
      '\u683c\u5f0f\uff1a{"schemaVersion":1,"summary":"\u4ea4\u4ed8\u6458\u8981",',
      '"deliverables":[{"path":"\u76f8\u5bf9\u8def\u5f84",',
      '"kind":"document|presentation|spreadsheet|pdf|website|image|video|archive|file",',
      '"title":"\u540d\u79f0","summary":"\u8bf4\u660e","primary":true}]}\u3002',
    ].join(''),
    [
      '\u6587\u6863\u3001PPT\u3001\u8868\u683c\u548c PDF \u767b\u8bb0\u6700\u7ec8\u6587\u4ef6\uff1b',
      '\u7f51\u7ad9\u53ea\u767b\u8bb0\u53ef\u6253\u5f00\u7684\u5165\u53e3 HTML\uff0c',
      '\u4f18\u5148\u6784\u5efa\u4ea7\u7269 index.html\uff0c',
      'CSS、JS、图片等运行依赖放入该入口的 files 清单，不登记为独立成果，也不能因其是源码而从交付包中遗漏。',
    ].join(''),
    [
      '\u666e\u901a\u95ee\u7b54\u6ca1\u6709\u6700\u7ec8\u6587\u4ef6\u65f6',
      '\u4e0d\u8981\u521b\u5efa\u6e05\u5355\uff1b',
      '\u6e05\u5355\u662f\u8fd0\u884c\u65f6\u4ea4\u4ed8\u4e8b\u5b9e\uff0c',
      '\u4e0d\u8981\u5728\u7528\u6237\u56de\u590d\u4e2d\u89e3\u91ca\u5b83\u3002',
    ].join(''),
  ].join('\n');
}

module.exports = {
  SCHEMA_VERSION,
  MANIFEST_RELATIVE,
  classify,
  infer,
  readManifest,
  instructions,
  _inside: inside,
  _isProcess: isProcess,
  _kindOf: kindOf,
  _artifactId: artifactId,
};
