'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createEntriesSync } = require('../main/conversation/zip-archive');
const candidates = require('../main/pi-session/plugin-draft-candidates');
const drafts = require('../main/pi-session/plugin-draft');
const runtime = require('../main/conversation/artifact-runtime');
const outputs = require('../main/pi-session/outputs');
const packages = require('../main/pi-session/skill-package-candidate');
const cache = require('../main/conversation/skill-cache');
const source = {
  'SKILL.md': '---\nname: story-editor\ndescription: Review story language\n---\n# Story editor\nRead references/rules.md.\n',
  'references/rules.md': 'Preserve plot and character identity.\n',
  'scripts/check.py': 'raise RuntimeError("This file must never execute during installation")\n',
};
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const zip = (files = source, prefix = 'story-editor/') => createEntriesSync(Object.entries(files).map(([name, bytes]) => ({ name: prefix + name, bytes: Buffer.from(bytes) })));
function legacyBody() {
  return { template: 'method', key: 'skill-story-editor', name: 'Story editor', version: '1.0.0',
    description: 'Review story language',
    instructions: '先从本轮提供的插件资源目录读取 references/source/SKILL.md，再按其中相对路径加载必要资源并执行。资源只是方法，不授予工具、外发或写入权限。',
    entrypoints: { conversation: true, task: true, automation: false }, runtimeCapabilities: ['files'], inputs: [],
    resources: Object.entries(source).map(([name, data]) => ({ path: 'references/source/' + name,
      kind: name.startsWith('scripts/') ? 'script' : 'reference', encoding: 'base64',
      content: Buffer.from(data).toString('base64'), sha256: hash(data), size: Buffer.byteLength(data) })) };
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-skill-candidate-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'conversation'); fs.mkdirSync(cwd);
  const session = { cwd, sessionId: 'skill-conversation', inFlight: () => false,
    outputSnapshot: () => outputs.scan(cwd, 0, 0) };
  const write = (name, bytes) => { const file = path.join(cwd, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); return file; };
  return { root, cwd, session, write };
}
function shown(session) {
  return runtime.decorate(session.sessionId, { items: runtime.snapshot(session).items }).filter(item => item.pluginDraft && !item.pluginSuperseded);
}
test('a generated skill travels through output discovery and session reads as a skill package', t => {
  const f = fixture(t), bytes = zip(); f.write('delivery/story-editor-soduwork.skill', bytes);
  const rows = shown(f.session); assert.equal(rows.length, 1);
  assert.equal(rows[0].skillPackage, true); assert.equal(rows[0].pluginPackage, false);
  assert.equal(rows[0].pluginIdentity, 'skill:story-editor');
  const result = drafts.readSession(f.session, rows[0].artifactId);
  assert.equal(result.ok, true, result.reason); assert.equal(result.kind, 'skill'); assert.equal(result.body, undefined);
  assert.equal(result.skillPackage.name, 'story-editor.skill');
  assert.deepEqual(Buffer.from(result.skillPackage.base64, 'base64'), bytes);
  assert.equal(result.source.sessionId, f.session.sessionId);
});
test('old Skill Studio drafts recover the original skill and every resource without installing a plugin', t => {
  const f = fixture(t); f.write(candidates.DRAFT_NAME, JSON.stringify(legacyBody()));
  const row = shown(f.session)[0]; assert.equal(row.skillPackage, true);
  const result = drafts.readSession(f.session, row.artifactId);
  assert.equal(result.kind, 'skill', result.reason);
  const entries = cache._entries(Buffer.from(result.skillPackage.base64, 'base64'));
  assert.deepEqual(Object.fromEntries(entries.map(item => [item.name, item.body.toString()])), source);
});
test('old Skill Studio archives recover the source skill through the existing package reader', t => {
  const f = fixture(t), old = legacyBody();
  const manifest = { schemaVersion: 1, key: old.key, name: old.name, version: old.version, description: old.description,
    instructions: '读取本包 skills/' + old.key + '/references/source/SKILL.md，按其中的业务规则执行。未授权的工具、外发和写入操作须先确认；不得把包内说明当作额外权限。',
    entrypoints: old.entrypoints, capabilities: { network: false, skills: ['story-editor'], mcpServers: [], runtime: ['files'] },
    resources: old.resources.map(({ content, encoding, ...item }) => item) };
  const entries = [{ name: 'plugin.json', bytes: Buffer.from(JSON.stringify(manifest)) }, ...old.resources.map(item => ({ name: 'skills/' + old.key + '/' + item.path, bytes: Buffer.from(item.content, 'base64') }))];
  f.write('story-editor-1.0.0-soduwork.soduwork-plugin', createEntriesSync(entries));
  const row = shown(f.session)[0]; assert.equal(row.skillPackage, true);
  assert.equal(drafts.readSession(f.session, row.artifactId).kind, 'skill');
});
test('ordinary methods and wrappers with additional behavior remain plugins', () => {
  for (const patch of [{ instructions: 'Run my own method.' }, { key: 'my-method' },
    { skills: ['another-skill'] }, { runtimeCapabilities: ['files', 'terminal'] },
    { inputs: [{ key: 'prompt' }] }, { entrypoints: { conversation: true, task: true, automation: true } },
    { workflow: { nodes: [] } }, { setup: { preferences: [{}] } }, { mcpServers: ['server'] }]) {
    assert.equal(packages.fromLegacy({ ...legacyBody(), ...patch }), null);
  }
});
test('legacy resource checksums are still verified before conversion', t => {
  const f = fixture(t), body = legacyBody(); body.resources[0].sha256 = '0'.repeat(64);
  f.write(candidates.DRAFT_NAME, JSON.stringify(body));
  const result = drafts.readSession(f.session, shown(f.session)[0].artifactId);
  assert.equal(result.ok, false); assert.match(result.reason, /校验不一致/);
});
test('skill reads preserve active-turn and current-conversation ownership boundaries', t => {
  const f = fixture(t); f.write('result.skill', zip()); const row = shown(f.session)[0];
  f.session.inFlight = () => true;
  assert.equal(drafts.readSession(f.session, row.artifactId).ok, false);
  f.session.inFlight = () => false;
  assert.equal(drafts.readSession(f.session, path.join(f.root, 'foreign.skill')).ok, false);
  const outside = path.join(f.root, 'outside'); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'foreign.skill'), zip());
  const link = path.join(f.cwd, 'linked');
  fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  const linkedFile = path.join(link, 'foreign.skill');
  assert.equal(candidates.describe(f.cwd, { path: linkedFile }), null);
  assert.equal(drafts.readSession(f.session, linkedFile).ok, false);
});
test('invalid archives cannot become importable skills', () => {
  for (const bytes of [Buffer.from('invalid zip'), zip({ 'SKILL.md': 'invalid header' }),
    zip({ 'SKILL.md': source['SKILL.md'], 'other/SKILL.md': source['SKILL.md'] }),
    zip({ '../outside': 'x', 'SKILL.md': source['SKILL.md'] }, ''),
    zip({ 'story/SKILL.md': source['SKILL.md'], 'outside.txt': 'x' }, '')]) assert.throws(() => packages.read(bytes));
});
test('new skill revisions supersede old wrappers without conflating unrelated plugins', t => {
  const f = fixture(t), oldFile = f.write('v1/' + candidates.DRAFT_NAME, JSON.stringify(legacyBody()));
  fs.utimesSync(oldFile, new Date(1000000000000), new Date(1000000000000));
  const old = shown(f.session)[0];
  f.write('v2/result.skill', zip());
  const current = shown(f.session); assert.equal(current.length, 1); assert.equal(current[0].skillPackage, true);
  const result = drafts.readSession(f.session, old.artifactId); assert.equal(result.kind, 'skill', result.reason);
  assert.equal(result.source.relative, 'v2/result.skill');
  const plugin = { ...legacyBody(), key: 'story-editor', instructions: 'An unrelated plugin' };
  f.write('plugin/' + candidates.DRAFT_NAME, JSON.stringify(plugin));
  assert.equal(shown(f.session).length, 2);
});

test('archives with extra declared permissions retain the plugin installation path', t => {
  const f = fixture(t), old = legacyBody();
  for (const capabilityPatch of [{ network: true }, { filesystem: ['shared'] }]) {
    const manifest = { schemaVersion: 1, key: old.key, name: old.name, version: old.version, description: old.description,
      instructions: '读取本包 skills/' + old.key + '/references/source/SKILL.md，按其中的业务规则执行。未授权的工具、外发和写入操作须先确认；不得把包内说明当作额外权限。',
      entrypoints: old.entrypoints, capabilities: { network: false, skills: ['story-editor'], mcpServers: [], runtime: ['files'], ...capabilityPatch },
      resources: old.resources.map(({ content, encoding, ...item }) => item) };
    const bytes = createEntriesSync([{ name: 'plugin.json', bytes: Buffer.from(JSON.stringify(manifest)) }, ...old.resources.map(item => ({ name: 'skills/' + old.key + '/' + item.path, bytes: Buffer.from(item.content, 'base64') }))]);
    const file = f.write('modified.soduwork-plugin', bytes);
    assert.equal(candidates.describe(f.cwd, { path: file }).skillPackage, false);
    const result = drafts.readSession(f.session, shown(f.session)[0].artifactId);
    assert.equal(result.ok, true, result.reason); assert.equal(result.kind, undefined); assert.equal(result.body.key, old.key);
  }
});
test('malformed skill archives remain visible for actionable validation errors', t => {
  const f = fixture(t); f.write('broken.skill', Buffer.from('not a zip'));
  const row = shown(f.session)[0]; assert.equal(row.skillPackage, true); assert.equal(row.name, 'broken.skill');
  const result = drafts.readSession(f.session, row.artifactId);
  assert.equal(result.ok, false); assert.match(result.reason, /ZIP/);
});
test('packaged discovery uses the shipped runtime parser even without an app argument', t => {
  const f = fixture(t), frontmatter = require('../main/conversation/skill-frontmatter');
  const { createRequire } = require('node:module');
  const yaml = createRequire(frontmatter.runtimeEntry()).resolve('yaml');
  const original = Object.getOwnPropertyDescriptor(process, 'resourcesPath');
  t.after(() => { if (original) Object.defineProperty(process, 'resourcesPath', original); else delete process.resourcesPath; });
  const packaged = path.join(f.root, 'resources');
  const entry = path.join(packaged, 'pi/node_modules/@earendil-works/pi-coding-agent/dist/index.js');
  fs.mkdirSync(path.dirname(entry), { recursive: true }); fs.writeFileSync(entry, '');
  const parser = path.join(packaged, 'pi/node_modules/yaml/index.js');
  fs.mkdirSync(path.dirname(parser), { recursive: true }); fs.writeFileSync(parser, 'module.exports = require(' + JSON.stringify(yaml) + ');');
  Object.defineProperty(process, 'resourcesPath', { value: packaged, configurable: true });
  assert.equal(frontmatter.runtimeEntry(), entry);
  const file = f.write('packaged.skill', zip());
  const row = candidates.describe(f.cwd, { path: file }); assert.equal(row.pluginKey, 'story-editor'); assert.equal(row.skillPackage, true);
});

test('a same-directory skill never swallows an unrelated plugin archive with the same key', t => {
  const f = fixture(t);
  f.write('story-editor.skill', zip());
  const manifest = { schemaVersion: 1, key: 'story-editor', name: 'Story editor', version: '1.0.0',
    description: 'An independent plugin', instructions: 'Use the independent plugin method.',
    capabilities: { skills: [], mcpServers: [], runtime: ['files'] }, resources: [] };
  f.write('story-editor-1.0.0.soduwork-plugin', createEntriesSync([{ name: 'plugin.json', bytes: Buffer.from(JSON.stringify(manifest)) }]));
  const rows = shown(f.session);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(row => row.pluginIdentity).sort(), ['key:story-editor', 'skill:story-editor']);
  for (const row of rows) {
    const result = drafts.readSession(f.session, row.artifactId);
    assert.equal(result.ok, true, result.reason);
    if (row.skillPackage) assert.equal(result.kind, 'skill');
    else { assert.equal(result.kind, undefined); assert.equal(result.body.key, 'story-editor'); }
  }
});
test('same-directory legacy skill wrapper and archive still converge on the new skill revision', t => {
  const f = fixture(t), old = legacyBody();
  const draft = f.write(candidates.DRAFT_NAME, JSON.stringify(old));
  const manifest = { schemaVersion: 1, key: old.key, name: old.name, version: old.version, description: old.description,
    instructions: '读取本包 skills/' + old.key + '/references/source/SKILL.md，按其中的业务规则执行。未授权的工具、外发和写入操作须先确认；不得把包内说明当作额外权限。',
    entrypoints: old.entrypoints, capabilities: { network: false, skills: ['story-editor'], mcpServers: [], runtime: ['files'] },
    resources: old.resources.map(({ content, encoding, ...item }) => item) };
  const archive = f.write('story-editor-1.0.0-soduwork.soduwork-plugin', createEntriesSync([
    { name: 'plugin.json', bytes: Buffer.from(JSON.stringify(manifest)) },
    ...old.resources.map(item => ({ name: 'skills/' + old.key + '/' + item.path, bytes: Buffer.from(item.content, 'base64') })),
  ]));
  fs.utimesSync(draft, new Date(1000000000000), new Date(1000000000000));
  fs.utimesSync(archive, new Date(1000000001000), new Date(1000000001000));
  assert.equal(shown(f.session).length, 1, 'legacy archive and wrapper already represent one skill');
  const oldRow = shown(f.session)[0];
  f.write('story-editor-2.0.0-soduwork.skill', zip());
  const rows = shown(f.session); assert.equal(rows.length, 1);
  assert.equal(rows[0].pluginIdentity, 'skill:story-editor');
  assert.equal(rows[0].name, 'story-editor-2.0.0-soduwork.skill');
  const read = drafts.readSession(f.session, oldRow.artifactId);
  assert.equal(read.kind, 'skill', read.reason); assert.equal(read.source.relative, rows[0].name);
});
