'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const personal = require('../main/personal-plugins');
const resources = require('../main/plugin-resources');
const { build, cli } = require('../../skills/skill-studio/scripts/skill-package.cjs');
const { validate } = require('../../skills/skill-studio/scripts/skill-validate.cjs');
const example = path.resolve(__dirname, '../../skills/skill-studio/assets/purchase-check');
const writer = path.resolve(__dirname, '../../skills/skill-studio/scripts/skill-package.cjs');

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-skill-studio-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'purchase-check');
  await fs.promises.cp(example, source, { recursive: true });
  // Mutation fixtures use LF delimiters regardless of the checkout's line endings.
  const skill = path.join(source, 'SKILL.md');
  fs.writeFileSync(skill, fs.readFileSync(skill, 'utf8').replace(/\r\n/g, '\n'));
  const write = (name, data) => {
    const file = path.join(source, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, data);
  };
  const edit = fn => write('SKILL.md', fn(fs.readFileSync(path.join(source, 'SKILL.md'), 'utf8')));
  return { root, source, write, edit, out: path.join(root, 'delivery'), app: { getPath: () => root } };
}
test('built-in is usable in the existing conversation catalog, without any enterprise install', async t => {
  const f = await fixture(t), item = personal.catalog(f.app).find(x => x.pluginId === personal.SKILL_STUDIO_ID);
  assert.equal(item.name, 'Skill 创建与优化');
  assert.equal(item.builtIn, true);
  assert.equal(item.capabilities.hasWorkflow, false);
  assert.equal(item.entrypoints.automation, false);
  assert.equal(item.inputs.length, 3);
  assert.equal(item.capabilities.resources.length, 8);
  const detail = personal.get(f.app, item.pluginId);
  const resolved = personal.resolve(f.app, [item.pluginId], { cwd: f.root });
  assert.match(resolved.items[0].context, /references\/studio\/SKILL.md/);
  const bundle = resources.materialize(detail.localDraft.resources, f.root, 'skill-studio');
  const executable = path.join(bundle.directory, 'references/studio/scripts/skill-package.cjs');
  const run = spawnSync(process.execPath, [executable, 'build', '--source', f.source, '--out', f.out], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).exports.length, 5);
  assert.equal(fs.existsSync(path.join(f.root, 'personal-plugins.json')), false);
});
test('all targets contain real packages and SoduWork exports a native skill package', async t => {
  const f = await fixture(t);
  f.write('assets/报价.csv', '物料,数量\n灯具,2\n');
  const report = build(f);
  assert.deepEqual(report.exports.map(x => x.target), ['portable', 'codex', 'claude', 'copilot', 'soduwork']);
  assert.equal(report.runtimeTested, false);
  for (const row of report.exports) {
    const data = fs.readFileSync(path.join(f.out, row.file));
    assert.equal(data.readUInt32LE(0), 0x04034b50);
    assert.ok(row.files.includes(row.skillRoot + 'SKILL.md'));
    assert.ok(row.files.includes(row.skillRoot + 'assets/报价.csv'));
  }
  const native = report.exports.find(row => row.target === 'soduwork');
  assert.match(native.file, /-soduwork\.skill$/);
  assert.equal(native.skillRoot, 'purchase-check/');
  const entries = require('../main/plugin-package-reader.cjs')._readEntries(fs.readFileSync(path.join(f.out, native.file)));
  for (const [name, bytes] of Object.entries(validate(f.source).files)) {
    assert.deepEqual(entries.get(native.skillRoot + name), bytes);
  }
  assert.equal(entries.has('plugin.json'), false);
  assert.equal(fs.existsSync(path.join(f.out, 'soduwork-plugin-draft.json')), false);
  assert.equal(fs.readdirSync(f.out).some(name => name.endsWith('.soduwork-plugin')), false);
});
test('adjustment preserves all original materials and reports only actual changes', async t => {
  const f = await fixture(t), original = path.join(f.root, 'original', 'purchase-check');
  f.write('assets/约束.txt', '保留原业务条款');
  await fs.promises.cp(f.source, original, { recursive: true });
  const before = fs.readFileSync(path.join(original, 'SKILL.md'));
  f.edit(text => text + '\n新增：交付前复核数量单位。\n');
  const report = build({ ...f, baseline: original, version: '1.0.1' });
  assert.deepEqual(report.changes.filter(x => x.status === 'changed').map(x => x.path), ['SKILL.md']);
  assert.equal(report.changes.find(x => x.path === 'assets/约束.txt').status, 'unchanged');
  assert.deepEqual(fs.readFileSync(path.join(original, 'SKILL.md')), before);
  assert.equal(fs.readFileSync(path.join(f.out, 'source/purchase-check/assets/约束.txt'), 'utf8'), '保留原业务条款');
});
test('removal is blocked until explicitly acknowledged; original remains intact', async t => {
  const f = await fixture(t), baseline = path.join(f.root, 'original', 'purchase-check');
  await fs.promises.cp(f.source, baseline, { recursive: true });
  fs.writeFileSync(path.join(baseline, 'LICENSE'), 'An existing license');
  assert.throws(() => build({ ...f, baseline }), /remove files/);
  assert.equal(fs.existsSync(f.out), false);
  assert.ok(build({ ...f, baseline, allowRemovals: true }).changes.some(x => x.status === 'removed'));
  assert.ok(fs.existsSync(path.join(baseline, 'LICENSE')));
});
test('building is deterministic and never overwrites previous outputs', async t => {
  const f = await fixture(t);
  const a = build(f), b = build({ ...f, out: path.join(f.root, 'second') });
  assert.deepEqual(a.exports, b.exports);
  assert.throws(() => build(f), /already exists/);
  assert.throws(() => build({ ...f, out: path.join(f.source, 'output') }), /inside the source/);
});
test('package scripts are not executed during validation or export', async t => {
  const f = await fixture(t), sentinel = path.join(f.root, 'must-not-exist');
  f.write('scripts/business.cjs', 'require("node:fs").writeFileSync(' + JSON.stringify(sentinel) + ',"BAD");');
  build(f);
  assert.equal(fs.existsSync(sentinel), false);
});
test('Claude invocation policy is preserved and cannot be silently lost in other formats', async t => {
  const f = await fixture(t);
  f.edit(text => text.replace('\n---\n\n', '\ndisable-model-invocation: true\n---\n\n'));
  assert.throws(() => build(f), /Claude-only/);
  const report = build({ ...f, targets: 'portable,claude' });
  assert.equal(report.exports.length, 2);
  assert.match(fs.readFileSync(path.join(f.out, 'source/purchase-check/SKILL.md'), 'utf8'), /disable-model-invocation: true/);
});
test('existing Codex policy/dependencies are preserved and require deliberate cross-host adaptation', async t => {
  const f = await fixture(t), yaml = 'policy:\n  allow_implicit_invocation: false\n';
  f.write('agents/openai.yaml', yaml);
  assert.throws(() => build(f), /Codex configuration/);
  build({ ...f, targets: 'portable,codex' });
  assert.equal(fs.readFileSync(path.join(f.out, 'source/purchase-check/agents/openai.yaml'), 'utf8'), yaml);
});
for (const [label, change, pattern] of [
  ['missing description', s => s.replace(/^description:.*\n/m, ''), /description/],
  ['duplicate frontmatter', s => s.replace(/^name: /m, 'name: purchase-check\nname: '), /Duplicate/],
  ['empty body', s => s.slice(0, s.indexOf('\n---\n\n') + 5), /empty/],
  ['folder/name mismatch', s => s.replace('name: purchase-check', 'name: other-skill'), /folder/],
  ['YAML object unsafe tag', s => s.replace(/^description:.*$/m, 'description: !!js/function unsafe'), /Unsupported/],
  ['missing reference', s => s + '\n[缺项](references/missing.md)\n', /Missing/],
  ['path escaping link', s => s + '\n[外部](..%2F..%2Foutside.txt)\n', /out-of-package/],
  ['absolute link', s => s + '\n[外部](file:///C:/private.txt)\n', /Non-portable/],
]) {
  test('rejects ' + label + ' without writing output', async t => {
    const f = await fixture(t); f.edit(change);
    assert.throws(() => build(f), pattern);
    assert.equal(fs.existsSync(f.out), false);
  });
}
test('folded descriptions and flat metadata are accepted without rewriting source', async t => {
  const f = await fixture(t);
  f.edit(s => s.replace(/^description:.*$/m, 'description: >-\n  Check purchasing inputs.\n  Report missing evidence.\nmetadata:\n  version: "1.0"\n  owner: "Operations"'));
  const report = build(f);
  assert.equal(report.exports.length, 5);
  assert.deepEqual(fs.readFileSync(path.join(f.out, 'source/purchase-check/SKILL.md')), fs.readFileSync(path.join(f.source, 'SKILL.md')));
});
test('unknown extensions remain portable-only', async t => {
  const f = await fixture(t);
  f.edit(s => s.replace('\n---\n\n', '\ncustom-execution: special\n---\n\n'));
  assert.throws(() => build(f), /Unknown frontmatter/);
  assert.equal(build({ ...f, targets: 'portable' }).exports.length, 1);
});
test('SoduWork rejects multiple skill roots before exporting an unimportable archive', async t => {
  const f = await fixture(t);
  f.write('assets/example/SKILL.md', '---\nname: example\ndescription: A nested example\n---\n\nCheck the example.\n');
  assert.throws(() => build(f), /exactly one SKILL.md/);
  assert.equal(fs.existsSync(f.out), false);
  assert.equal(build({ ...f, targets: 'portable' }).exports.length, 1);
});
test('secrets are rejected without echoing their contents', async t => {
  const f = await fixture(t), secret = 'sk-' + 'abcdefghijklmnopqr';
  f.write('references/bad.txt', secret);
  const result = spawnSync(process.execPath, [writer, 'validate', '--source', f.source], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /credential/);
  assert.ok(!result.stderr.includes(secret));
});
test('package file/byte limits, hidden and installer files are enforced', async t => {
  const f = await fixture(t);
  f.write('assets/large.bin', Buffer.alloc(8 * 1024 * 1024));
  assert.throws(() => validate(f.source), /8 MiB/);
  fs.unlinkSync(path.join(f.source, 'assets/large.bin'));
  f.write('.env', 'private config');
  assert.throws(() => validate(f.source), /Unsafe/);
  fs.unlinkSync(path.join(f.source, '.env'));
  f.write('assets/install.exe', 'inert fixture');
  assert.throws(() => validate(f.source), /Unsafe/);
  fs.unlinkSync(path.join(f.source, 'assets/install.exe'));
  for (let i = 0; i < 64; i++) f.write('assets/f' + i + '.txt', 'x');
  assert.throws(() => validate(f.source), /64 files/);
});
test('directory junctions cannot import external files', async t => {
  const f = await fixture(t), outside = path.join(f.root, 'outside');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(f.source, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => validate(f.source), /links/);
});
test('invalid CLI flags, targets and SemVer are actionable failures', async t => {
  const f = await fixture(t);
  assert.throws(() => cli(['build', '--source']), /missing/);
  assert.throws(() => cli(['validate', '--source', f.source, '--version', '1.0.0']), /only/);
  assert.throws(() => build({ ...f, targets: 'unknown' }), /Unsupported target/);
  for (const v of ['01.0.0', '1.0', '1.0.0-01']) assert.throws(() => build({ ...f, version: v }), /SemVer/);
  assert.equal(build({ ...f, version: '1.0.0-beta.1+build.2' }).version, '1.0.0-beta.1+build.2');
});

test('missing optional studio resources do not break the existing builder or ordinary plugin resolution', async t => {
  const f = await fixture(t), app = { ...f.app, isPackaged: true };
  const original = console.warn;
  console.warn = () => {};
  try {
    assert.equal(personal.get(app, personal.BUILDER_ID).key, 'plugin-builder');
    assert.deepEqual(personal.resolve(app, []).items, []);
    assert.equal(personal.catalog(app).length, 1);
    assert.throws(() => personal.get(app, personal.SKILL_STUDIO_ID), /资源不完整/);
  } finally { console.warn = original; }
});
test('malformed metadata and YAML sequence scalars are not accepted as valid Skills', async t => {
  const f = await fixture(t), original = fs.readFileSync(path.join(f.source, 'SKILL.md'), 'utf8');
  f.write('SKILL.md', original.replace('\n---\n\n', '\nmetadata: invalid\n---\n\n'));
  assert.throws(() => validate(f.source), /metadata/);
  f.write('SKILL.md', original.replace(/^description:.*$/m, 'description: - invalid sequence'));
  assert.throws(() => validate(f.source), /Unsupported/);
});


test('duplicate current skill-studio targets are collapsed', async t => {
  const f = await fixture(t), report = build({ ...f, targets: 'soduwork,soduwork' });
  assert.equal(report.exports.length, 1);
  assert.equal(report.exports[0].target, 'soduwork');
  assert.match(report.exports[0].file, /-soduwork\.skill$/);
  assert.ok(fs.existsSync(path.join(f.out, report.exports[0].file)));
  assert.equal(fs.existsSync(path.join(f.out, 'soduwork-plugin-draft.json')), false);
});


test('Skill Studio exports remain skill install candidates after renaming', async t => {
  const f = await fixture(t);
  const report = build(f);
  const candidates = require('../main/pi-session/plugin-draft-candidates');
  const files = fs.readdirSync(f.out).map(name => ({ path: path.join(f.out, name) }));
  const rows = candidates.collect(f.out, { files });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].skillPackage, true);
  assert.equal(rows[0].pluginIdentity, 'skill:purchase-check');
  const archive = path.join(f.out, report.exports.find(row => row.target === 'soduwork').file);
  const renamed = path.join(f.out, 'arbitrary-export-name.skill');
  fs.renameSync(archive, renamed);
  const onlyArchive = candidates.collect(f.out, { files: [{ path: renamed }] });
  assert.equal(onlyArchive.length, 1);
  assert.equal(onlyArchive[0].skillPackage, true);
  assert.equal(onlyArchive[0].pluginIdentity, rows[0].pluginIdentity);
});
