'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../components/panels/work-automation-sheet.js'), 'utf8');
// Expose the closure only inside this VM; exercise the production async reducer
// with a deferred parser and real state transitions, without a model call.
const instrumented = source.replace('  global.WorkAutomationSheet = { open, active, refine, close };',
  '  global.__lifecycle = { state, refineNow };\n  global.WorkAutomationSheet = { open, active, refine, close };');

for (const stage of ['saving', 'saved']) test('late automation refinement cannot replace a ' + stage + ' proposal', async () => {
  let finish;
  const body = {innerHTML: ''}, layer = {isConnected: true, querySelector: selector => selector === '#wazBody' ? body : null};
  const context = {Intl, setTimeout, clearTimeout, addEventListener() {},
    SoduWorkAPI: {parseTaskText: () => new Promise(resolve => {finish = resolve;})}};
  context.window = context;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../components/panels/schedule-timing.js'), 'utf8'), context);
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../components/panels/work-automation-bindings.js'), 'utf8'), context);
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../components/panels/work-automation-card-state.js'), 'utf8'), context);
  vm.runInNewContext(instrumented, context);
  const {state, refineNow} = context.__lifecycle;
  Object.assign(state, {layer, proposal: {title:'Confirmed source',note:'Submitted background'}, seed:{}, saved:false, saving:false});
  const pending = refineNow('older edit');
  state[stage] = true;
  finish({title:'Outdated parse result',note:'Must not replace submitted fields'});
  assert.equal(await pending, false);
  assert.equal(state.proposal.title, 'Confirmed source');
  assert.equal(state.proposal.note, 'Submitted background');
});
