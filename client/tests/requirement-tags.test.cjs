'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
function fixture(initial = [], disabled = false) {
  const scope = {Event,document:{createElement(tag){
    const node={tag,children:[],attributes:{},dataset:{},textContent:'',
      setAttribute(name,value){this.attributes[name]=value;if(name==='data-rq-tag-remove')this.dataset.rqTagRemove=value;},
      append(...children){this.children.push(...children);},
      closest(selector){return selector==='[data-rq-tag-editor]'?editor:selector==='[data-rq-tag-remove]'&&Object.hasOwn(this.attributes,'data-rq-tag-remove')?this:null;}};
    return node;
  }}}; scope.window = scope;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../components/requirements/requirement-fields.js'), 'utf8'), scope);
  const handlers = {}, warning = {hidden: true}, chips = {innerHTML: '', writes: 0};
  chips.replaceChildren=(...children)=>{chips.children=children;};
  let markup = '';
  Object.defineProperty(chips, 'innerHTML', {get: () => markup, set(value) { markup = value; chips.writes++; }});
  const field = {value: JSON.stringify(initial), dispatchEvent() {}};
  const editor = {querySelector: selector => ({
    '[data-rq-tag-value]': field, '[data-rq-tag-input]': input,
    '[data-rq-tag-chips]': chips, '[data-rq-tag-limit]': warning,
  })[selector]};
  const input = {value: '', disabled, focus() {}, closest: selector => selector === '[data-rq-tag-input]' ? input : editor};
  field.closest = () => editor;
  const root = {addEventListener: (name, handler) => { handlers[name] = handler; }, querySelectorAll: () => [editor]};
  scope.RequirementFields.bindTags(root);
  const event = (name, extra = {}) => handlers[name]?.({target: input, key: 'Enter', preventDefault() {}, stopPropagation() {}, ...extra});
  const remove = index => ({disabled, dataset: {rqTagRemove: String(index)},
    closest: selector => selector === '[data-rq-tag-remove]' ? button : editor});
  let button;
  return {api: scope.RequirementFields, input, field, chips, warning, root, event,
    remove: index => {button = remove(index); event('click', {target: {closest: () => button}});},
    focusRemove: index => {button = remove(index); event('focusout', {relatedTarget: button});},
  };
}

test('legacy delimited strings and serialized tag arrays preserve their original labels', () => {
  const f = fixture();
  for (const raw of ['旧标签，另一个\n第三个', '["旧标签","另一个","第三个"]', ['旧标签', '另一个', '第三个']]) {
    assert.deepEqual(Array.from(f.api.normalizeTags(raw)), ['旧标签', '另一个', '第三个']);
  }
  f.field.value = '旧标签，另一个';
  f.input.value = '未按回车';
  assert.deepEqual(Array.from(f.api.readTags(f.field)), ['旧标签', '另一个', '未按回车']);
});

test('blurring an empty editor does not recreate the chip buttons under a pointer', () => {
  const f = fixture(['保留']);
  f.event('focusout');
  assert.equal(f.chips.writes, 0);
});

test('focus moving to a chip removal does not replace its button or consume pending text', () => {
  const f = fixture(['删除这个', '保留']);
  f.input.value = '保存时补上'; f.focusRemove(0);
  assert.equal(f.chips.writes, 0);
  assert.equal(f.input.value, '保存时补上');
  f.remove(0);
  assert.deepEqual(Array.from(f.api.readTags(f.field)), ['保留', '保存时补上']);
});

test('composition lifecycle prevents candidate Enter and blur from committing partial Chinese text', () => {
  const f = fixture();
  f.event('compositionstart'); f.input.value = '中文候选';
  f.event('keydown'); f.event('focusout');
  assert.deepEqual(JSON.parse(f.field.value), []);
  assert.equal(f.input.value, '中文候选');
  f.event('compositionend'); f.event('keydown');
  assert.deepEqual(JSON.parse(f.field.value), ['中文候选']);
});

test('disabled tags retain their values and reject keyboard, blur and removal mutations', () => {
  const f = fixture(['锁定'], true);
  f.input.value = '不能加入'; f.event('keydown'); f.event('focusout'); f.remove(0);
  assert.deepEqual(JSON.parse(f.field.value), ['锁定']);
  assert.deepEqual(Array.from(f.api.readTags(f.field)), ['锁定']);
  assert.equal(f.chips.writes, 0);
  const html = f.api.tagHtml(['锁定'], {id: 'locked', name: 'tags', disabled: true});
  assert.match(html, /aria-disabled="true"/);
  assert.match(html, /data-rq-tag-remove="0"[^>]* disabled data-rq-locked/);
  assert.match(html, /data-rq-tag-input[^>]* disabled data-rq-locked/);
});

test('unconfirmed tail participates in validation so save never silently drops a twenty-first tag', () => {
  const f = fixture(Array.from({length: 20}, (_, i) => '标签' + i));
  f.input.value = '尾项';
  assert.equal(f.api.validateTags(f.root), false);
  assert.equal(f.warning.hidden, false);
  assert.equal(f.input.value, '尾项');
  f.remove(0);
  assert.equal(f.api.validateTags(f.root), true);
  assert.equal(f.api.readTags(f.field).length, 20);
  assert.equal(f.api.readTags(f.field).at(-1), '尾项');
});

test('reloading tags uses plain DOM text and preserves delegated removal',()=>{
  const f=fixture();f.api.setTags(f.field,['<img src=x onerror=alert(1)>','保留']);
  assert.equal(f.chips.writes,0);assert.equal(f.chips.children.length,2);
  const chip=f.chips.children[0],label=chip.children[0],button=chip.children[1];
  assert.equal(label.textContent,'<img src=x onerror=alert(1)>');assert.equal(label.children.length,0);
  assert.ok(Object.hasOwn(label.attributes,'data-user-content'));assert.equal(button.dataset.rqTagRemove,'0');
  assert.equal(button.attributes['aria-label'],'删除标签：<img src=x onerror=alert(1)>');
  f.event('click',{target:button});assert.deepEqual(JSON.parse(f.field.value),['保留']);
});
