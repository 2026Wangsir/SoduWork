'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const panels = path.join(__dirname, '../components/panels');
function runtime() {
  const context = { Intl, setTimeout, clearTimeout }; context.window = context;
  const helper = path.join(panels, 'work-automation-bindings.js');
  if (fs.existsSync(helper)) vm.runInNewContext(fs.readFileSync(helper, 'utf8'), context);
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../components/panels/schedule-timing.js'), 'utf8'), context);
  vm.runInNewContext(fs.readFileSync(path.join(panels, 'work-automation-card-state.js'), 'utf8'), context);
  vm.runInNewContext(fs.readFileSync(path.join(panels, 'work-automation-sheet.js'), 'utf8').replace(
    '  global.WorkAutomationSheet = { open, active, refine, close };',
    '  global.probe = { state, proposalOf, bodyOf, validate };'), context);
  Object.assign(context.probe.state, {
    methods: [{ key:'games', name:'小游戏', version:'1.2.3', checksum:'a'.repeat(64), inputs:[] }],
    repos: [{id:'repo-games',name:'游戏工程'}],
    agents: [{id:'local:pi',name:'Pi',available:true},{id:'local:codex',name:'Codex',available:true}],
  });
  return context.probe;
}
test('explicit automation method, repo and substrate become actual saved bindings', () => {
  const {proposalOf,bodyOf} = runtime();
  const text = '每天12点，使用小游戏插件，在游戏工程开发，由Codex执行';
  const draft = proposalOf({title:'开发纸牌',note:text}, text, {});
  assert.equal(draft.personalPluginKey, 'games');
  assert.equal(draft.repoId, 'repo-games');
  assert.equal(draft.assigneeId, 'local:codex');
  const body = bodyOf(draft);
  assert.equal(body.personalPluginVersionPolicy, 'pinned');
  assert.equal(body.personalPluginVersion, '1.2.3');
  assert.equal(body.personalPluginChecksum, 'a'.repeat(64));
});
test('a missing saved method is blocked instead of silently becoming free execution', () => {
  const {validate} = runtime();
  assert.match(validate({title:'开发纸牌',note:'开发纸牌',assigneeId:'local:pi',personalPluginKey:'removed'}), /插件|工作方法/);
});
