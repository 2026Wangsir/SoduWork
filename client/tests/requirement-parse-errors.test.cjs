'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('./renderer-source.cjs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../api.js'), 'utf8');

function fixture(reply) {
  const calls = [], timers = [], values = new Map();
  const localStorage = { getItem: key => values.get(key) || null,
    setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  const window = { localStorage, addEventListener() {}, dispatchEvent() {} };
  const context = { window, localStorage, URL, AbortController, CustomEvent: class {},
    navigator: { onLine: true }, clearTimeout() {},
    setTimeout(fn, ms) { timers.push({ fn, ms }); return timers.length; },
    fetch: async (url, options) => { calls.push({ url, headers: options.headers, body: JSON.parse(options.body) }); return reply(options); } };
  vm.runInNewContext(source, context);
  return { api: window.SoduWorkAPI, calls, expire: (ms = 130000) => timers.find(timer => timer.ms === ms).fn() };
}
const response = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => body });

test('parse timeout is explicit and retains the one original model request', async () => {
  const f = fixture(options => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(options.signal.reason));
  }));
  const waiting = f.api.parseTaskText('完整原文\n最后一个要求', 'chosen-model', [], { instruction: '当前要求' });
  f.expire();
  const result = await waiting;
  assert.match(result._parseError, /需求解析超时，/);
  assert.doesNotMatch(result._parseError, /秒|130/);
  assert.match(result._parseError, /原文已保留.*重试.*手动填写/);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].body, { text: '完整原文\n最后一个要求', model: 'chosen-model', keepalive: true, locale: 'zh-CN', attachments: [], instruction: '当前要求' });
});

test('transport failure is a network error without exposing the exception or retrying', async () => {
  const f = fixture(() => { throw new TypeError('Failed to fetch https://private.invalid/?token=DO_NOT_EXPOSE'); });
  const result = await f.api.parseTaskText('原文', 'chosen-model');
  assert.match(result._parseError, /网络.*原文已保留/);
  assert.doesNotMatch(result._parseError, /DO_NOT_EXPOSE|private\.invalid/);
  assert.equal(f.api.online, false);
  assert.equal(f.calls.length, 1);
});

test('automation keeps its existing 90 second client budget', async () => {
  const f = fixture(options => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(options.signal.reason));
  }));
  const waiting = f.api.parseTaskText('自动化', '', [], { kind: 'automation' });
  f.expire(90000);
  assert.match((await waiting)._parseError, /超时.*90/);
});

test('HTTP failures retain their status and safe detail even if a proxy sends HTML', async () => {
  for (const body of ['<html>DO_NOT_EXPOSE upstream page</html>', '', '{broken']) {
    const f = fixture(() => response(503, body));
    const result = await f.api.parseTaskText('原文', 'chosen-model');
    assert.match(result._parseError, /HTTP 503/);
    assert.match(result._parseError, /原文已保留.*重试|重试.*原文已保留/);
    assert.doesNotMatch(result._parseError, /DO_NOT_EXPOSE|upstream|broken|无法连接/);
    assert.equal(f.api.online, true);
    assert.equal(f.calls.length, 1);
  }
  const f = fixture(() => response(422, JSON.stringify({ detail: '参考材料超过解析上限，请拆分后重试' })));
  const result = await f.api.parseTaskText('原文', 'chosen-model');
  assert.match(result._parseError, /HTTP 422.*参考材料超过解析上限/);
  assert.equal(f.api.online, true);
});

test('a known HTTP failure remains an HTTP error if its body cannot be read', async () => {
  const f = fixture(() => ({ ok: false, status: 502, text: async () => { throw new Error('DO_NOT_EXPOSE read failure'); } }));
  const result = await f.api.parseTaskText('原文', 'chosen-model');
  assert.match(result._parseError, /HTTP 502/);
  assert.equal(f.api.online, true);
  assert.doesNotMatch(result._parseError, /DO_NOT_EXPOSE/);
});

test('invalid successful response content is visible without marking the server offline', async () => {
  for (const body of ['<html>DO_NOT_EXPOSE</html>', '', 'null', '[]', '{}', '{"fields":null}',
    '{"fields":[]}', '{"fields":"DO_NOT_EXPOSE"}', '{"fields":5}']) {
    const f = fixture(() => response(200, body));
    const result = await f.api.parseTaskText('原文', 'chosen-model');
    assert.match(result._parseError || '', /格式.*原文已保留/);
    assert.doesNotMatch(result._parseError, /DO_NOT_EXPOSE|无法连接/);
    assert.equal(f.api.online, true);
    assert.equal(f.calls.length, 1);
  }
});

test('valid parsed fields and an empty manual draft preserve the response contract', async () => {
  for (const fields of [{ title: '已整理', note: '完整说明' }, {}]) {
    const f = fixture(() => response(200, JSON.stringify({ ok: Boolean(fields.title), fields })));
    assert.deepEqual(JSON.parse(JSON.stringify(await f.api.parseTaskText('原文', ''))), fields);
    assert.equal(f.calls[0].body.model, '');
    assert.equal(f.api.online, true);
  }
});

test('JSON whitespace keepalives preserve success and bounded server failure', async () => {
  for (const fields of [{ title: '慢模型结果', note: '完整正文' }, { _parseError: '需求解析超时，原文已保留，请重试' }]) {
    const f = fixture(() => response(200, ' \n'.repeat(6) + JSON.stringify({ ok: !fields._parseError, fields })));
    assert.deepEqual(JSON.parse(JSON.stringify(await f.api.parseTaskText('原文', 'chosen'))), fields);
    assert.equal(f.calls.length, 1, 'no duplicate automatic model invocation');
    assert.equal(f.calls[0].body.keepalive, true);
    assert.equal(f.api.online, true);
  }
});

test('parse negotiates keepalive JSON and accepts heartbeat whitespace before the result', async () => {
  const f = fixture(() => response(200, ' \n \n' + JSON.stringify({ok: true, fields: {title: '慢模型结果'}})));
  const result = await f.api.parseTaskText('完整原文', 'chosen-model');
  assert.equal(f.calls[0].headers.Accept, 'application/json; keepalive=1');
  assert.equal(result.title, '慢模型结果');
  assert.equal(f.calls.length, 1);
});

test('keepalive parse failure remains visible and never becomes a fabricated draft', async () => {
  const f = fixture(() => response(200, ' \n' + JSON.stringify({ok: false,
    fields: {_parseError: '需求解析超时；原文已保留，请重试或手动填写'}})));
  const result = await f.api.parseTaskText('原文', 'chosen-model');
  assert.match(result._parseError, /超时.*原文已保留/);
  assert.equal(result.title, undefined);
  assert.equal(f.api.online, true);
  assert.equal(f.calls.length, 1);
});
