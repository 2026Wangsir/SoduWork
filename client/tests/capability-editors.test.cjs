'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('./renderer-source.cjs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('capability editors load before the catalog shell in both renderers', () => {
  for (const page of ['index.html', 'desk.html']) {
    const html = read(page);
    assert.match(html, /panels-capability-editors\.js/);
    assert.ok(html.indexOf('panels-capability-directory.js') <
      html.indexOf('panels-capability-editors.js'));
    assert.ok(html.indexOf('panels-capability-editors.js') <
      html.indexOf('panels-capabilities.js'));
  }
});

test('catalog shell and editor module keep separate maintainable boundaries', () => {
  const shell = read('components/panels/panels-capabilities.js');
  const editors = read('components/panels/panels-capability-editors.js');
  const api = read('api.js');
  const connector = read('components/panels/connector-editor.js');
  assert.match(shell, /SoduWorkCapabilityEditors\.create/);
  assert.match(editors, /function openCreateSkill/);
  assert.match(editors, /function chooseSkillPackage/);
  assert.match(editors, /function openMcpEditor/);
  assert.match(connector, /String\(options\.name\s*\|\|\s*''\)/);
  assert.match(connector, /options\.onSaved/);
  assert.match(editors, /preflightMySkill/);
  assert.match(api, /preflightMyMcpServer/);
  assert.match(api, /probeMyMcpServer/);
  assert.match(connector, /probeMyMcpServer/);
  assert.match(connector, /capMcpProbe/);
  assert.match(connector, /SoduWorkConnectorConfig.status/);
  assert.match(connector, /ctx\.setState\(result,catalog\)/);
});

test('missing skill route gives an actionable version message without confusing a private/missing package', async () => {
  for (const [status, message, expected] of [
    [404, 'Not Found', '后台尚未提供技能内容接口'],
    [404, 'Skill 或文件不存在，或当前无权查看', 'Skill 或文件不存在，或当前无权查看'],
    [403, '没有权限', '没有权限'],
    [500, '服务器内部错误', '服务器内部错误'],
  ]) {
    const globals = { window: {} };
    vm.runInNewContext(read('components/panels/panels-capability-editors.js'), globals);
    const nodes = new Map();
    const layer = { hidden: false, querySelector(selector) {
      if (!nodes.has(selector)) nodes.set(selector, { classList: { add() {} }, textContent: '', innerHTML: '' });
      return nodes.get(selector);
    } };
    const editor = globals.window.SoduWorkCapabilityEditors.create({
      api: { skillDetails: async () => { throw Object.assign(new Error(message), { status }); } },
      h: String, errorText: e => e.message, openModal: () => layer,
    });
    await editor.openSkillDetails('fixture');
    assert.ok(nodes.get('#capModalBody').textContent.includes(expected));
    assert.match(nodes.get('#capModalFoot').innerHTML, /data-detail-retry/);
  }
});

test('skill installation commits once and keeps refresh failures separate from import failures', async () => {
  const globals = { window: {} }, messages = [], nodes = new Map();
  vm.runInNewContext(read('components/panels/panels-capability-editors.js'), globals);
  function node(selector) {
    if (!nodes.has(selector)) nodes.set(selector, { disabled: false, classList: { add() {} },
      addEventListener(type, fn) { this[type] = fn; }, querySelector: node, querySelectorAll: () => [] });
    return nodes.get(selector);
  }
  const layer = { hidden: false, querySelector: node };
  let imports = 0, resolveImport, scope = 'alice';
  const file = new File(['fixture'], 'weekly.skill');
  const editor = globals.window.SoduWorkCapabilityEditors.create({
    api: { taskStorageKey: () => scope, mySkills: async () => ({ skills: [] }), importMySkill: async got => {
      assert.equal(got, file); imports++; await new Promise(resolve => { resolveImport = resolve; });
    } }, h: String, say: message => messages.push(message), errorText: (_error, fallback) => fallback,
    openModal: (title, subtitle) => { assert.equal(title, '安装技能'); assert.match(subtitle, /个人技能库/); layer.hidden = false; return layer; },
    closeModal: () => { assert.equal(layer._installPending, false); layer.hidden = true; },
    load: async () => { throw Error('offline'); },
  });
  editor.openImportPreview(file, { ok: true, skill: { name: 'weekly', checksum: 'new-version', hasScripts: true }, files: [],
    checks: [{ key: 'scripts', ok: false, label: 'Contains scripts' }] });
  await new Promise(resolve => setImmediate(resolve));
  const button = node('#capImportDo');
  const pending = button.click();
  await button.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(imports, 1);
  assert.equal(layer._installPending, true);
  resolveImport(); await pending;
  assert.equal(layer.hidden, true);
  assert.match(messages[0], /技能已安装并启用/);
  assert.match(messages[1], /目录刷新失败/);
  editor.openImportPreview(file, { ok: true, skill: { name: 'weekly', checksum: 'new-version' }, files: [] });
  button.disabled = false; scope = 'bob';
  await button.click();
  assert.equal(imports, 1, 'A prior account preview cannot install into the next account');
  assert.throws(() => editor.openImportPreview(file, { checks: [{ ok: false }] }), /预检没有通过/);
});

test('skill preview reads remain bound to their account while installation is pending', async () => {
  const nodes = new Map(), calls = [], rendered = [];
  const files = ['SKILL.md', 'references/rules.md'];
  const buttons = files.map(path => ({ dataset: { packageFile: path },
    classList: { toggle() {} }, setAttribute() {} }));
  function node(selector) {
    if (!nodes.has(selector)) nodes.set(selector, { disabled: false, isConnected: true,
      classList: { add() {}, toggle() {} }, setAttribute() {},
      addEventListener(type, fn) { this[type] = fn; }, querySelector: node,
      querySelectorAll: selector => selector === '[data-package-file]' ? buttons : [],
      replaceChildren() {}, appendChild(child) { rendered.push(child.textContent); },
    });
    return nodes.get(selector);
  }
  const globals = { window: {}, document: { createElement: () => ({}) } };
  vm.runInNewContext(read('components/panels/panels-capability-editors.js'), globals);
  const layer = { hidden: false, querySelector: node };
  let scope = 'alice', finishImport, finishRead;
  const closeModal = () => {
    if (layer._installPending) return;
    layer.hidden = true; layer._skillView = null;
  };
  const editor = globals.window.SoduWorkCapabilityEditors.create({
    api: { taskStorageKey: () => scope, mySkills: async () => ({ skills: [] }),
      previewSkillContent: async (_file, path) => {
        calls.push({ scope, path });
        if (path === 'SKILL.md') return { kind: 'text', text: 'Initial preview' };
        return new Promise(resolve => { finishRead = resolve; });
      },
      importMySkill: async () => new Promise(resolve => { finishImport = resolve; }),
    }, h: String, say() {}, errorText: error => error.message,
    openModal: () => layer, closeModal, load: async () => {},
  });
  editor.openImportPreview(new File(['fixture'], 'weekly.skill'), {
    ok: true, skill: { name: 'weekly', checksum: 'new-version' }, files: files.map(path => ({ path })),
  });
  await new Promise(resolve => setImmediate(resolve));
  const pendingRead = buttons[1].onclick();
  const pendingImport = node('#capImportDo').click();
  await new Promise(resolve => setImmediate(resolve));
  scope = 'bob'; closeModal();
  assert.equal(layer.hidden, false, 'The installation keeps its dialog mounted while committing');
  assert.equal(layer._installPending, true);
  const before = calls.length;
  await buttons[0].onclick();
  assert.equal(calls.length, before, 'The old dialog cannot upload its package under the new account');
  finishRead({ kind: 'text', text: 'Private old-account response' });
  await pendingRead;
  assert.deepEqual(rendered, ['Initial preview'], 'An old response cannot paint into the mounted dialog after switching accounts');
  finishImport(); await pendingImport;
  assert.equal(layer.hidden, true);
});

function importHarness() {
  const nodes = new Map(), globals = { window: {} };
  vm.runInNewContext(read('components/panels/panels-capability-editors.js'), globals);
  const node = selector => {
    if (!nodes.has(selector)) nodes.set(selector, { disabled: false, classList: { add() {} },
      addEventListener(type, fn) { this[type] = fn; }, querySelector: node, querySelectorAll: () => [] });
    return nodes.get(selector);
  };
  const layer = { hidden: false, querySelector: node };
  const state = { skills: [], imports: 0, scope: 'alice', read: null };
  const editor = globals.window.SoduWorkCapabilityEditors.create({
    api: { taskStorageKey: () => state.scope, mySkills: async options => {
      assert.equal(options.strict, true);
      return state.read ? state.read() : { skills: state.skills };
    }, importMySkill: async () => { state.imports++; } },
    h: String, say() {}, errorText: e => e.message,
    openModal: () => { layer.hidden = false; return layer; },
    closeModal: () => { layer.hidden = true; }, load: async () => {},
  });
  const open = () => editor.openImportPreview(new File(['fixture'], 'weekly.skill'), {
    ok: true, skill: { name: 'weekly', checksum: 'new-version' }, files: [],
  });
  return { state, layer, open, button: node('#capImportDo'), note: node('#capImportState') };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('reopened packages reflect exact personal content and enabled state without reinstalling', async () => {
  for (const [entry, label, disabled] of [
    [{ scope: 'personal', checksum: 'new-version', enabled: true }, '已安装并启用', true],
    [{ scope: 'personal', checksum: 'new-version', enabled: false }, '已安装（未启用）', true],
    [{ scope: 'personal', checksum: 'old-version', enabled: true }, '替换并启用', false],
    [{ scope: 'company', checksum: 'new-version', enabled: true }, '安装并启用', false],
    [{ scope: 'company', sourceKey: 'builtin', checksum: 'new-version' }, '不能覆盖内置技能', true],
  ]) {
    const h = importHarness();
    h.state.skills = [{ name: 'weekly', ...entry }]; h.open();
    assert.equal(h.button.disabled, true, 'No mutation before an authoritative status read');
    await settle();
    assert.equal(h.button.textContent, label); assert.equal(h.button.disabled, disabled);
    if (disabled) await h.button.click();
    assert.equal(h.state.imports, 0);
    if (label === '替换并启用') {
      assert.match(h.note.textContent, /替换当前版本/);
      await h.button.click(); assert.equal(h.state.imports, 1);
    }
  }
});

test('failed status reads require a successful retry before allowing installation', async () => {
  const h = importHarness();
  h.state.read = async () => { throw Error('offline'); };
  h.open(); await settle();
  assert.equal(h.button.textContent, '重新检查安装状态');
  await h.button.click(); assert.equal(h.state.imports, 0);
  h.state.read = null;
  await h.button.click();
  assert.equal(h.button.textContent, '安装并启用'); assert.equal(h.state.imports, 0);
  await h.button.click(); assert.equal(h.state.imports, 1);
});

test('a status change before confirmation refreshes the action without replacing newer content', async () => {
  const h = importHarness(); h.open(); await settle();
  h.state.skills = [{ name: 'weekly', scope: 'personal', checksum: 'another-version', enabled: true }];
  await h.button.click();
  assert.equal(h.state.imports, 0); assert.equal(h.button.textContent, '替换并启用');
  h.state.skills[0].checksum = 'latest-version';
  await h.button.click(); assert.equal(h.state.imports, 0);
  await h.button.click(); assert.equal(h.state.imports, 1);
});

test('late status responses cannot update another account, a closed preview, or a replacement dialog', async () => {
  for (const invalidate of [h => { h.state.scope = 'bob'; }, h => { h.layer.hidden = true; },
    h => { h.layer._skillView = {}; }]) {
    const h = importHarness(); let finish;
    h.state.read = () => new Promise(resolve => { finish = resolve; });
    h.open(); invalidate(h);
    finish({ skills: [] }); await settle();
    assert.equal(h.button.disabled, true);
    await h.button.click(); assert.equal(h.state.imports, 0);
  }
});
