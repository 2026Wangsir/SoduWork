'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const skillRoots = require('../main/conversation/skill-roots');
const runnerRuntime = require('../main/runner-runtime');

function writeSkill(dir, name) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), [
    '---', 'name: ' + name, 'description: test skill', '---', '',
  ].join('\n'));
  return path.normalize(dir).toLowerCase();
}

test('SoduWork discovers native substrate Skill roots without a restart', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-live-skills-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const userData = path.join(root, 'user-data');
  const codexHome = path.join(root, 'codex-home');
  const app = {
    isPackaged: false,
    getPath(name) {
      assert.equal(name, 'userData');
      return userData;
    },
  };
  const expected = [
    writeSkill(path.join(userData, 'runner', 'data', 'skills', 'soduwork-runner'), 'soduwork-runner'),
    writeSkill(path.join(userData, 'skills', 'soduwork-user'), 'soduwork-user'),
    writeSkill(path.join(home, '.pi', 'agent', 'skills', 'pi-native'), 'pi-native'),
    writeSkill(path.join(home, '.agents', 'skills', 'agent-standard'), 'agent-standard'),
    writeSkill(path.join(codexHome, 'skills', 'codex-native'), 'codex-native'),
    writeSkill(path.join(home, '.claude', 'skills', 'claude-native'), 'claude-native'),
  ];
  const options = { home, env: { CODEX_HOME: codexHome } };
  const first = skillRoots.discover(app, options)
    .map((item) => path.normalize(item).toLowerCase());
  expected.forEach((item) => assert.ok(first.includes(item), item));

  const late = writeSkill(
    path.join(home, '.pi', 'agent', 'skills', 'installed-after-open'), 'installed-after-open');
  const second = skillRoots.discover(app, options)
    .map((item) => path.normalize(item).toLowerCase());
  assert.ok(second.includes(late), 'a later installation must be visible on the next probe');
});

test('Skill capability UI auto-saves and refreshes instead of requiring a save button', () => {
  const source = fs.readFileSync(path.join(
    __dirname, '..', 'components', 'panels', 'panels-capabilities.js'), 'utf8');
  const controller = fs.readFileSync(path.join(
    __dirname, '..', 'components', 'panels', 'skill-catalog-sync.js'), 'utf8');
  assert.match(source, /skillController\(\)\.scheduleSave\(\)/);
  assert.match(controller, /function scheduleSave\(\)/);
  assert.match(source, /refreshMySkills\(\{ notify: !meta\?\.silent \}\)/);
  assert.match(source, /if \(tab === 'skills'\) skillController\(\)\.refresh\(\{ silent: true \}\)/);
  assert.match(source, /if \(enteredSkills\) skillController\(\)\.refresh\(\{ silent: true \}\)/);
  assert.match(source, /\u81ea\u52a8\u4fdd\u5b58|自动保存/u);
  assert.doesNotMatch(source, /capSaveSkills/);
  assert.doesNotMatch(source, />浏览目录</);
});

test('Packaged SoduWork passes shared Skill roots to its embedded Runner', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-runner-skill-roots-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const userData = path.join(root, 'user-data');
  const resources = path.join(root, 'resources');
  const app = { isPackaged: true, getPath() { return userData; } };
  const roots = runnerRuntime._skillRoots(app, resources);
  assert.deepEqual(roots, [
    path.resolve(resources, 'skills'),
    path.resolve(userData, 'skills'),
  ]);
  const env = runnerRuntime._runnerEnv({}, 'device-secret', app, resources);
  assert.deepEqual(env.SODUWORK_SKILL_ROOTS.split(path.delimiter), roots);
});
