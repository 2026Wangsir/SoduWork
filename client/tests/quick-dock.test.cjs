'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const vm = require('node:vm');
const read = (...parts) => fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8');

test('native startup defaults the quick dock off and restores explicit saved preferences', () => {
  let saved = null;
  const fs = {
    readFileSync() {
      if (saved === null) throw Object.assign(Error('missing'), { code: 'ENOENT' });
      return saved;
    },
    writeFileSync(_file, value) { saved = value; },
  };
  function startup() {
    const module = { exports: {} };
    vm.runInNewContext(read('main', 'desk-flags.js'), {
      module, console, require: name => ({
        path, fs, electron: { app: { getPath: () => 'isolated-profile' } },
      })[name],
    });
    return module.exports;
  }
  const first = startup();
  assert.deepEqual({ ...first.all() }, { dock: false, pet: true, tray: true });
  first.merge({ dock: true });
  assert.equal(startup().all().dock, true);
  startup().merge({ dock: false });
  assert.equal(startup().all().dock, false);
  saved = JSON.stringify({ pet: false, tray: true });
  assert.deepEqual({ ...startup().all() }, { dock: false, pet: false, tray: true });
});

test('quick dock keeps four daily entries; confirmations live inside tasks', () => {
  const dock = read('components', 'pet', 'pet-dock.js');
  const items = dock.slice(dock.indexOf('const items = ['), dock.indexOf("dock.innerHTML ="));
  const order = ['workspace', 'schedules', 'requirements', 'notices'];
  const positions = order.map((act) => items.indexOf('data-act="' + act + '"'));

  assert.ok(positions.every((position) => position >= 0), 'every daily entry should exist');
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
  assert.doesNotMatch(items, /data-act="(?:newtask|aidesk|skin|approvals)"/);
});

test('quick dock icons share an optical system and accessible names', () => {
  const dock = read('components', 'pet', 'pet-dock.js');
  const css = read('components', 'pet', 'pet.css');

  for (const label of ['对话', '自动化', '需求池', '通知']) {
    assert.match(dock, new RegExp('aria-label="' + label + '"'));
  }
  assert.match(dock, /openDeskWindow\(\{ panel: 'workspace', view: 'create' \}\)/);
  assert.match(css, /\.edge-dock \.ed-view svg\{[\s\S]*?width:18px;height:18px;[\s\S]*?stroke-width:1\.75;/);
  assert.match(css, /vector-effect:non-scaling-stroke/);
});
