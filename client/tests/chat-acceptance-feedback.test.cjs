'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture() {
  function element(tagName) {
    const attributes = {}, node = {tagName, dataset: {}, children: [], value: '', disabled: false,
      setAttribute(name, value) { attributes[name] = String(value); },
      getAttribute(name) { return attributes[name] || null; },
      removeAttribute(name) { delete attributes[name]; },
      append(child) { child.remove?.(); this.children.push(child); child.parentElement = this; },
      insertBefore(child, next) { child.remove?.(); this.children.splice(this.children.indexOf(next), 0, child); child.parentElement = this; },
      remove() { if (this.parentElement) this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1); this.parentElement = null; },
      replaceChildren(...children) { this.children = []; children.forEach(child => this.append(child)); },
      focus() { node.focused = true; },
    };
    return node;
  }
  const listeners = {}, note = element('textarea'), analysis = element('textarea');
  const noteLabel = element('label'), analysisLabel = element('label'), buttons = element('div');
  noteLabel.append(note); analysisLabel.append(analysis);
  const card = element('div'); card.append(noteLabel); card.append(analysisLabel); card.append(buttons);
  const controls = [note, analysis], calls = [];
  const all = root => root.children.flatMap(child => [child, ...all(child)]);
  card.querySelector = selector => selector === '[data-acceptance-result-note]' ? note
    : selector === '[data-acceptance-result-analysis]' ? analysis
      : selector === '.nacceptance-result-buttons' ? buttons
        : selector === '[data-acceptance-result-error]' ? all(card).find(node => 'acceptanceResultError' in node.dataset) || null : null;
  card.querySelectorAll = selector => selector === 'button,input,textarea' ? controls : [note, analysis];
  for (const [key, value] of Object.entries({'data-acceptance-result-task':'task', 'data-acceptance-result-approval':'review',
    'data-acceptance-result-key':'task:review:analysis:1:0', 'data-acceptance-message-key':'1:0'})) card.setAttribute(key, value);
  note.closest = analysis.closest = () => card;
  const window = {document: {createElement: element}, SoduWorkAPI: {decideApproval: async (...args) => {
    calls.push(args); if (window.fail) throw Error('Temporary offline'); return {ok:true,request:{status:'rejected'}};
  }}};
  window.window = window;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../components/panels/chat-acceptance-results.js'), 'utf8'), window);
  const ctx = {_snap:{messages:[{role:'user'},{role:'assistant'}]}, _sessionOptions:{taskRef:'task'},
    _collaborationTask:{id:'task',status:'doing',canReview:true},
    _collaborationTrace:{approvals:[{id:'review',action:'review',status:'pending'}]},
    esc: value => String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')};
  const helper = window.ChatAcceptanceResults.create(ctx, {rich:String,invalidate(){}});
  helper.html('【验收分析结果】\nChecked', '1:0');
  helper.bind({dataset:{},addEventListener(type, callback){listeners[type] = callback;}});
  return {window, ctx, helper, card, note, analysis, noteLabel, analysisLabel, buttons, controls, calls,
    error: () => card.querySelector('[data-acceptance-result-error]'),
    input(field) { listeners.input?.({target:field}); },
    async click(decision) {
      const button = {closest:()=>card, getAttribute:()=>decision};
      listeners.click({target:{closest:()=>button}, preventDefault(){}});
      await new Promise(setImmediate);
    }};
}

for (const [decision, field] of [['reject','note'],['analyze','analysis']]) {
  test(`${decision} validation stays beside its field and clears when corrected`, async () => {
    const f = fixture(), input = f[field];
    input.setAttribute('aria-describedby', 'existing-hint');
    await f.click(decision);
    assert.equal(f.calls.length, 0);
    assert.equal(f.error().parentElement, f[field+'Label']);
    assert.equal(f.error().className, 'nacceptance-result-error');
    assert.equal(f.error().getAttribute('role'), 'alert');
    assert.equal(input.getAttribute('aria-invalid'), 'true');
    assert.ok(input.getAttribute('aria-describedby').split(' ').includes(f.error().id));
    assert.equal(input.focused, true);
    input.value = 'Keep this correction\nincluding its second line'; f.input(input);
    assert.equal(f.error(), null);
    assert.equal(input.getAttribute('aria-invalid'), null);
    assert.equal(input.getAttribute('aria-describedby'), 'existing-hint');
    assert.equal(input.value, 'Keep this correction\nincluding its second line');
  });
}

test('failed rejection retains both drafts and permits a clean retry with literal multiline feedback', async () => {
  const f = fixture();
  f.note.value = 'Fix <img src=x>\n  Keep the second line';
  f.analysis.value = 'Do not discard this analysis'; f.window.fail = true;
  await f.click('reject');
  assert.equal(f.error().getAttribute('role'), 'alert');
  assert.equal(f.error().parentElement, f.card);
  assert.ok(f.card.children.indexOf(f.error()) < f.card.children.indexOf(f.buttons));
  assert.equal(f.note.value, 'Fix <img src=x>\n  Keep the second line');
  assert.equal(f.analysis.value, 'Do not discard this analysis');
  assert.ok(f.controls.every(node => !node.disabled));
  f.window.fail = false; await f.click('reject');
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1][2], f.note.value);
  const html = f.helper.html('【验收分析结果】\nChecked', '1:0');
  assert.match(html, /class="nacceptance-result-outcome"/);
  assert.ok(html.includes('Fix &lt;img src=x&gt;\n  Keep the second line'));
  assert.doesNotMatch(html, /<img|data-acceptance-result-action/);
});
