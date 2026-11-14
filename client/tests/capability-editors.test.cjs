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
    api: { taskStorageKey: () => scope, importMySkill: async got => {
      assert.equal(got, file); imports++; await new Promise(resolve => { resolveImport = resolve; });
    } }, h: String, say: message => messages.push(message), errorText: (_error, fallback) => fallback,
    openModal: (title, subtitle) => { assert.equal(title, '安装技能'); assert.match(subtitle, /个人技能库/); layer.hidden = false; return layer; },
    closeModal: () => { assert.equal(layer._installPending, false); layer.hidden = true; },
    load: async () => { throw Error('offline'); },
  });
  editor.openImportPreview(file, { ok: true, skill: { name: 'weekly', hasScripts: true }, files: [],
    checks: [{ key: 'scripts', ok: false, label: 'Contains scripts' }] });
  const button = node('#capImportDo');
  const pending = button.click();
  await button.click();
  assert.equal(imports, 1);
  assert.equal(layer._installPending, true);
  resolveImport(); await pending;
  assert.equal(layer.hidden, true);
  assert.match(messages[0], /技能已安装并启用/);
  assert.match(messages[1], /目录刷新失败/);
  editor.openImportPreview(file, { ok: true, skill: { name: 'weekly' }, files: [] });
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
    api: { taskStorageKey: () => scope,
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
    ok: true, skill: { name: 'weekly' }, files: files.map(path => ({ path })),
  });
  await new Promise(resolve => setImmediate(resolve));
  const pendingRead = buttons[1].onclick();
  const pendingImport = node('#capImportDo').click();
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
