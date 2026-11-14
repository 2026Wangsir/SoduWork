'use strict';

const fs = require('node:fs');
const { createRequire } = require('node:module');
const { entryCandidates } = require('../pi-session/session-helpers');

function runtimeEntry(app, optional = false) {
  // Artifact scans also run without an app handle in packaged processes.
  const runtimeApp = app || { isPackaged: Boolean(process.resourcesPath) };
  const entry = runtimeApp.skillRuntimeEntry || entryCandidates(runtimeApp).find(fs.existsSync);
  if (!entry && !optional) throw Error('未找到会话内核，无法校验 Skill');
  return entry;
}

function parse(content, name, app) {
  const fail = reason => { throw Error('Skill ' + (name || 'SKILL.md') + '：' + reason + '。请修正 SKILL.md 后重新导入'); };
  // Resolve from the actual Pi entry, including packaged resources. A separate
  // parser dependency could disagree with the runtime or be absent in a build.
  const yaml = createRequire(runtimeEntry(app))('yaml');
  let decoded;
  try { decoded = Buffer.isBuffer(content) ? new TextDecoder('utf-8', { fatal: true }).decode(content) : String(content); }
  catch (_) { fail('SKILL.md 必须使用有效的 UTF-8 编码'); }
  const normalized = decoded.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const match = normalized.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (!match) fail('缺少有效的 YAML 文件头');
  const header = match[1];
  if (Buffer.byteLength(header, 'utf8') > 65536) fail('YAML 文件头超过 64KiB');
  let data;
  try {
    const document = yaml.parseDocument(header);
    if (document.errors.length || document.warnings.length) throw document.errors[0] || document.warnings[0];
    let nodes = 0;
    yaml.visit(document, (_key, node, ancestors) => {
      // PyYAML compose_node counts scalar/sequence/mapping nodes, including
      // keys. yaml.visit also visits Pair/Document wrappers; counting those
      // would reject metadata that the Hub correctly accepted.
      if (yaml.isNode(node) && (++nodes > 2048 || ancestors.filter(yaml.isNode).length + 1 > 32)) throw Error('文件头结构过于复杂');
      if (yaml.isAlias(node)) throw Error('不支持 YAML 别名');
      if (node && node.tag && !/^tag:yaml.org,2002:(?:str|int|float|bool|null|seq|map)$/.test(node.tag)) throw Error('不支持自定义 YAML 标签');
      if (yaml.isPair(node) && (!yaml.isScalar(node.key) || typeof node.key.value !== 'string')) throw Error('字段名必须是普通文本');
    });
    data = document.toJS({ maxAliasCount: 0 });
  } catch (error) {
    const at = error.linePos && error.linePos[0];
    fail('YAML 格式无效' + (at ? '（第 ' + at.line + ' 行，第 ' + at.col + ' 列）' : ''));
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) fail('YAML 文件头必须是字段映射');
  if (typeof data.name !== 'string' || !data.name.trim() || data.name.length > 64) fail('name 必须是 1–64 字符的文本');
  if (name !== undefined && data.name !== name) fail('name 与包清单名称不一致');
  if (typeof data.description !== 'string' || !data.description.trim()) fail('description 必须是非空文本');
  if (data.description.length > 1024) fail('description 超过 1024 字符');
  if (data.compatibility !== undefined && typeof data.compatibility !== 'string') fail('compatibility 必须是文本');
  if (data.compatibility && data.compatibility.length > 500) fail('compatibility 超过 500 字符');
  return data;
}

module.exports = { parse, runtimeEntry };
