'use strict';
const test = require('node:test'),assert = require('node:assert/strict'),vm = require('node:vm');
const fs = require('node:fs'),path = require('node:path');
function fields() {
  const context = {};context.window = context;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../components/requirements/requirement-fields.js'),'utf8'),context);
  return context.RequirementFields;
}
const shared = '同公司成员可查看需求内容；执行会话和日志仍按原有权限访问。';
const related = '仅相关人可查看需求内容；执行会话和日志仍按原有权限访问。';

test('creation describes the selected audience while preserving the serialized visibility values', () => {
  const api = fields();
  for (const [visibility,description] of [['organization',shared],['related',related]]) {
    const draft = {visibility},html = api.html(draft,{});
    assert.match(html,new RegExp('<option value="'+visibility+'" selected>'));
    assert.match(html,/value="organization"[^>]*>同公司可见/);
    assert.match(html,/aria-describedby="cpVisibilityHint"/);
    assert.ok(html.includes(description));
    assert.ok(!html.includes(visibility==='organization'?related:shared));
    assert.equal(draft.visibility,visibility);
  }
});

test('audience explanations update in place without changing selection or sending a write', () => {
  const api = fields(),listeners = [],hint = {textContent:''};
  const root = {addEventListener:(type,handler)=>listeners.push([type,handler]),querySelector:()=>hint};
  api.bindVisibility(root);api.bindVisibility(root);
  assert.equal(listeners.length,1);
  for (const [value,expected] of [['organization',shared],['related',related],['organization',shared]]) {
    const select = {value,getAttribute:()=> 'cpVisibilityHint'};
    listeners[0][1]({target:{closest:selector=>selector==='[data-rq-visibility]'?select:null}});
    assert.equal(hint.textContent,expected);
    assert.equal(select.value,value);
  }
});
