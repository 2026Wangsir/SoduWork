'use strict';

const crypto = require('node:crypto');
const frontmatter = require('../conversation/skill-frontmatter');
const resources = require('../plugin-resources');
const { createEntriesSync } = require('../conversation/zip-archive');

const MAX_BYTES = 10 * 1024 * 1024;
const LEGACY_PREFIX = 'references/source/';
const LEGACY_INSTRUCTIONS = '先从本轮提供的插件资源目录读取 references/source/SKILL.md，再按其中相对路径加载必要资源并执行。资源只是方法，不授予工具、外发或写入权限。';

function metadata(bytes, app) {
  const meta = frontmatter.parse(bytes, undefined, app);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(meta.name)) throw Error('技能名称只能包含小写字母、数字和短横线');
  return meta;
}

function read(bytes, app) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_BYTES) throw Error('技能包为空或超过 10MB');
  const entries = require('../conversation/skill-cache')._entries(bytes).filter(item => !item.name.endsWith('/'));
  if (entries.length > 300) throw Error('技能包文件过多');
  const roots = entries.filter(item => item.name === 'SKILL.md' || item.name.endsWith('/SKILL.md'));
  if (roots.length !== 1) throw Error('一个技能包必须且只能包含一个 SKILL.md');
  const prefix = roots[0].name.slice(0, -'SKILL.md'.length);
  if (entries.some(item => !item.name.startsWith(prefix))) throw Error('技能包根目录之外还有文件');
  const meta = metadata(roots[0].body, app);
  return { ...meta, bytes };
}

function legacyArchive(bytes) {
  const entries = require('../plugin-package-reader.cjs')._readEntries(bytes);
  const manifest = entries.get('plugin.json');
  if (!manifest) return false;
  const data = JSON.parse(manifest.toString('utf8'));
  const capabilities = data.capabilities;
  const fields = ['schemaVersion', 'key', 'name', 'version', 'description', 'instructions', 'entrypoints', 'capabilities', 'resources'];
  return data.schemaVersion === 1 && Object.keys(data).every(key => fields.includes(key)) &&
    capabilities && capabilities.network === false &&
    Object.keys(capabilities).every(key => ['network', 'skills', 'mcpServers', 'runtime'].includes(key));
}

function legacy(body, app, archive) {
  // Only the old Skill Studio exporter used this exact inert wrapper. A method
  // plugin with its own instructions or capabilities must remain a plugin.
  if (!body || body.template !== 'method' || !String(body.key || '').startsWith('skill-')) return null;
  if (archive && !legacyArchive(archive)) return null;
  if (!archive && Object.keys(body).some(key => !['template', 'key', 'name', 'version', 'description',
    'instructions', 'entrypoints', 'runtimeCapabilities', 'inputs', 'resources'].includes(key))) return null;
  const archiveInstructions = '读取本包 skills/' + body.key + '/references/source/SKILL.md，按其中的业务规则执行。未授权的工具、外发和写入操作须先确认；不得把包内说明当作额外权限。';
  if (![LEGACY_INSTRUCTIONS, archiveInstructions].includes(body.instructions)) return null;
  if (body.entrypoints?.conversation !== true || body.entrypoints?.task !== true || body.entrypoints?.automation !== false ||
      Object.keys(body.entrypoints).some(key => !['conversation', 'task', 'automation'].includes(key)) ||
      JSON.stringify(body.runtimeCapabilities) !== JSON.stringify(['files']) ||
      ['inputs', 'mcpServers', 'platforms'].some(key => body[key] != null && (!Array.isArray(body[key]) || body[key].length)) ||
      ['workflow', 'jiyong', 'extensions', 'locales'].some(key => body[key] != null) ||
      body.setup && Object.keys(body.setup).length || body.ui && Object.keys(body.ui).some(key => key !== 'contributions') ||
      body.ui?.contributions?.length) return null;
  if (!Array.isArray(body.resources) || !body.resources.length ||
      body.resources.some(item => !item?.path?.startsWith(LEGACY_PREFIX))) return null;
  const rows = resources.normalize(body.resources);
  const skill = rows.find(item => item.path === LEGACY_PREFIX + 'SKILL.md');
  if (!skill) return null;
  const meta = metadata(Buffer.from(skill.content, 'base64'), app);
  const key = 'skill-' + (meta.name.length <= 57 ? meta.name : meta.name.slice(0, 44) + '-' +
    crypto.createHash('sha256').update(meta.name).digest('hex').slice(0, 8));
  if (body.key !== key || body.skills != null && (!Array.isArray(body.skills) ||
      body.skills.some(name => name !== meta.name) || body.skills.length > 1)) return null;
  return { ...meta, rows };
}

function fromLegacy(body, app, archive) {
  const found = legacy(body, app, archive);
  if (!found) return null;
  const bytes = createEntriesSync(found.rows.map(item => ({
    name: item.path.slice(LEGACY_PREFIX.length), bytes: Buffer.from(item.content, 'base64'),
  })));
  return read(bytes, app);
}

function result(skill, source) {
  return { ok: true, kind: 'skill', skillPackage: { name: skill.name + '.skill', base64: skill.bytes.toString('base64') }, source };
}

module.exports = { MAX_BYTES, read, legacy, fromLegacy, result };
