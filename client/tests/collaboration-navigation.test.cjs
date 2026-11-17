const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('collaboration entries are ordered, unique and use the same page and window names', () => {
  const shell = read('components/workspace/workspace-shell.js');
  const home = vm.runInNewContext(shell.match(/const HOME_GROUPS = (\[[\s\S]*?\n  \]);/)[1]);
  const settings = vm.runInNewContext(shell.match(/const SETTINGS_GROUPS = (\[[\s\S]*?\n  \]);/)[1]);
  assert.equal(JSON.stringify(home.find(group => group[0] === '协作')[1]),
    JSON.stringify(['history']));
  const more = vm.runInNewContext(shell.match(/const RAIL_MORE_ITEMS = (\[[\s\S]*?\n  \]);/)[1]);
  assert.equal(more.some(([key]) => key === 'aidesk'), false);
  assert.equal(more.some(([key]) => key === 'memory'), true);
  assert.equal(home.flatMap(group => group[1]).filter(key => key === 'briefs').length, 0);
  for (const key of ['briefs', 'team', 'memory']) {
    assert.equal(settings.flatMap(group => group[1]).filter(item => item === key).length, 0);
  }
  assert.equal(settings.some(group => group[0] === '个人账户'), false);
  const accountGroup = settings.find(group => group[0] === 'AI 与账号');
  assert.equal(JSON.stringify(accountGroup[1].slice(0, 2)), JSON.stringify(['account', 'usage']));
  const settingsKeys = settings.flatMap(group => group[1]);
  assert.equal(settingsKeys.filter(key => key === 'account').length, 1);
  assert.equal(settingsKeys.indexOf('account') < settingsKeys.indexOf('usage'), true);
  assert.equal(JSON.stringify(settings.find(group => group[0] === '偏好')[1]), JSON.stringify(['shortcuts', 'skin', 'settings']));
  const titles = { history: '需求池', aidesk: 'AI 团队', briefs: '简报' };
  const specs = require('../main/window-specs.js');
  const html = read('desk.html');
  for (const [key, title] of Object.entries(titles)) {
    assert.match(shell, new RegExp(key + ": \\['" + title + "'"));
    assert.match(html, new RegExp(key + ":'" + title + "'"));
    assert.equal(specs[key].title, title);
  }
});

test('one requirement board retains Task statuses and exposes no second pool entry', () => {
  const board = read('components/requirements/requirements-board.js');
  assert.match(board, /id="hbTitleText">需求池<\/span>/);
  assert.match(board, /global\.openHistoryBoard = open; global\.openTaskCenter = open/);
  assert.doesNotMatch(read('components/workspace/workspace-shell.js'), /workitems:/);
  assert.match(read('core/store.js'), /todo:'待办'/);
  assert.match(read('components/reports/work-briefs.js'), /<h1>简报<\/h1>/);
  assert.match(read('components/panels/panels-desk.js'), /<span class="dk-title-name">AI 团队<\/span>/);
  assert.doesNotMatch(read('components/workspace/workspace-shell.js'), /请从待办重试/);
});
