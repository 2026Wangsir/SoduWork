'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('./renderer-source.cjs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../api.js'), 'utf8');

function fixture(response) {
  let body;
  const storage = new Map();
  const window = {addEventListener() {}, dispatchEvent() {}, localStorage: {
    getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value),
    removeItem: key => storage.delete(key),
  }};
  const context = {window, localStorage: window.localStorage, URL, AbortController,
    setTimeout: (fn, ms) => {const timer = setTimeout(fn, ms); timer.unref(); return timer;},
    clearTimeout, CustomEvent: class {}, navigator: {onLine: true},
    fetch: async (_url, init) => {body = JSON.parse(init.body); return response || {ok:true,
      text:async () => JSON.stringify({fields:{title:'draft'}})};}};
  vm.runInNewContext(source, context);
  return {api: window.SoduWorkAPI, window, body: () => JSON.parse(JSON.stringify(body))};
}

test('ordinary parse request preserves fields and opts into JSON keepalive', async () => {
  const f = fixture();
  await f.api.parseTaskText('old task', 'model-a', [{id:'attachment-a'}]);
  assert.deepEqual(f.body(), {text:'old task', model:'model-a', keepalive:true, locale:'zh-CN', attachments:[{id:'attachment-a'}]});
});

test('附件解析拒绝的具体原因返回表单，不能伪装成空的成功结果', async () => {
  const f = fixture({ ok: false, status: 422, text: async () => JSON.stringify({ detail: '参考材料文本超过解析上限，请拆分后重试' }) });
  assert.match((await f.api.parseTaskText('按材料修复', '', []))._parseError || '', /超过解析上限/);
});

test('automation parse forwards only the opt-in draft context', async () => {
  const f = fixture();
  const candidates = {methods:[{id:'mini-game',name:'Mini game'}], repos:[], agents:[]};
  await f.api.parseTaskText('form with prior text', 'model-a', [], {
    kind:'automation', instruction:'use Mini game', candidates, accessMode:'full',
  });
  assert.deepEqual(f.body(), {text:'form with prior text', model:'model-a', keepalive:true, locale:'zh-CN', attachments:[],
    kind:'automation', instruction:'use Mini game', candidates});
});

test('unknown parse options never activate automation mode', async () => {
  const f = fixture();
  await f.api.parseTaskText('task', '', [], {kind:'other',instruction:'use plugin', candidates:{}});
  assert.equal(f.body().kind, undefined);
  assert.equal(f.body().instruction, undefined);
});

test('requirement parsing separates the current instruction from reference material', async () => {
  for (const kind of [undefined, 'requirement']) {
    const f = fixture();
    await f.api.parseTaskText('当前要求及历史材料', '', [], { kind,
      instruction: '转给示例成员修复', candidates: { methods: [{ id: 'not-authority' }] } });
    assert.deepEqual(f.body(), { text: '当前要求及历史材料', model: '', keepalive: true, locale: 'zh-CN', attachments: [],
      instruction: '转给示例成员修复' });
  }
});

test('every parse reads the current UI locale, including refinement and automation', async () => {
  const f = fixture();
  for (const locale of ['en-US', 'ja-JP', 'ko-KR', 'zh-CN']) {
    f.window.SoduWorkI18n = {getLocale: () => locale};
    for (const options of [undefined, {instruction:'Refine the draft'}, {kind:'automation',instruction:'Every day'}]) {
      await f.api.parseTaskText('原文保持不变', '', [], options);
      assert.equal(f.body().locale, locale);
      assert.equal(f.body().text, '原文保持不变');
    }
  }
});
