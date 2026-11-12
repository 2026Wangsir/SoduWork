'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const read = name => fs.readFileSync(path.join(__dirname, '../components/panels', name), 'utf8');

function fixture(ctx = {}, overrides = {}) {
  const opened = [], events = [], messages = [];
  const input = { value: 'original', dispatchEvent: event => events.push(event.type), focus: () => events.push('focus') };
  const window = { WorkspaceHost: { open: (view, payload) => opened.push({ view, payload }) }, ...overrides };
  const context = { window, document: { getElementById: () => input }, Event,
    petSay: message => messages.push(message) };
  for (const name of ['panels-plugin-builder-entry.js', 'chat-composer-bindings.js']) {
    vm.runInNewContext(read(name), context, { filename: name });
  }
  return { window, opened, input, events, messages, entry: window.ChatComposerBindings.create(ctx) };
}

test('new-session entries preserve the complete original prompt bytes and synchronous return', () => {
  // Captured from the original shared entry before consolidating the chat fallback.
  for (const [seed, context, expected] of [
    ['  Build reusable report  ', { attachmentNames: ['report.csv', 'plan.md'] }, '0807dfb198c26f276bcdefd6dae05a8eb09fa0a49b650858cd2eb113a0fb5c14'],
    ['', { attachmentNames: ['input.txt'] }, 'b88f7fb0606875c82a48ee0b566369c5bf0924d46455bfd5094f012ec42e6321'],
    ['', undefined, '09688882bb0c6ea5ed21fb4c5f61087788eaca56298599672c17b27658de1bb5'],
  ]) {
    const f = fixture();
    assert.equal(f.window.PluginBuilderEntry.open(seed, context), true);
    assert.equal(f.entry._openPluginBuilder(seed, context), true);
    for (const { view, payload } of f.opened) {
      assert.equal(view, 'create');
      assert.equal(crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex'), expected);
    }
    assert.deepEqual(f.opened[0].payload, f.opened[1].payload);
  }
});

test('attachment names retain normalization and the twelve-name limit in both entries', () => {
  const f = fixture(), names = ['', null, 7, ...Array.from({ length: 20 }, (_, i) => 'file-' + i)];
  for (const open of [f.window.PluginBuilderEntry.open, f.entry._openPluginBuilder]) open('seed', { attachmentNames: names });
  const expected = names.map(String).filter(Boolean).slice(0, 12).join('、');
  assert.ok(f.opened[0].payload.contextPrompts[2].includes(expected));
  assert.ok(!f.opened[0].payload.contextPrompts[2].includes('file-19'));
  assert.deepEqual(f.opened[0].payload, f.opened[1].payload);
  assert.equal(names.length, 23);
});

test('app creation displays the chosen storage and retains matching model guidance for every category', () => {
  const f = fixture();
  for (const [location, label] of [['local', '数据本地化'], ['cloud', '数据云端化']]) {
    for (const [appCategory, title] of [['office', '工具办公'], ['game', '小游戏'], ['robot', '机器人'], ['other', '其他']]) {
      f.window.PluginBuilderEntry.openApp(title + '：', { appCategory, storageLocation: location, attachmentNames: ['参考图.png'] }, 'lite');
      const { payload } = f.opened.at(-1);
      assert.equal(payload.prefill, '创建即用（' + label + '）：' + title + '：');
      const prompts = require('../main/pi-session/environment-ipc').entryContextPrompts(payload.contextPrompts).join('\n');
      assert.ok(prompts.includes('"location":"' + location + '"'));
      assert.ok(prompts.includes('appCategory=' + appCategory));
      if (location === 'local') assert.match(prompts, /不申请云端数据库，不自动上传业务数据/);
      assert.equal(payload.newSession, true);
      assert.equal(payload.pluginId, 'local:app-developer');
      assert.equal(payload.autoSend, undefined, 'creation remains an editable draft');
    }
  }
  for (const storageLocation of [undefined, '', 'invalid', '__proto__']) {
    assert.equal(f.window.PluginBuilderEntry.buildPayload('描述', { storageLocation }, true, 'lite').prefill, '创建即用：描述');
  }
  assert.equal(f.window.PluginBuilderEntry.buildPayload('', undefined, true, 'web').prefill, '创建网页类即用：');
});

test('new-session fallback uses the compose entry or throws synchronously when unavailable', () => {
  const calls = [], f = fixture({}, { WorkspaceHost: null, openComposePanel: payload => calls.push(payload) });
  assert.equal(f.entry._openPluginBuilder('seed'), true);
  assert.equal(calls[0].newSession, true);
  const unavailable = fixture({}, { WorkspaceHost: null });
  assert.throws(() => unavailable.entry._openPluginBuilder('seed'), /插件制作助手暂时没有加载完成/);
});

test('app creation localizes generated prefixes and storage choices without translating the user description', () => {
  for (const locale of ['en-US', 'ja-JP', 'ko-KR']) {
    const messages = require('../core/locales/' + locale + '-gap-pages.js');
    for (const label of ['数据本地化', '数据云端化', '工具办公', '小游戏', '机器人', '其他']) {
      assert.ok(messages[label], locale + ' must translate ' + label);
      if (locale === 'ja-JP') assert.match(messages[label], /[\u3040-\u30ff]/);
      if (locale === 'ko-KR') assert.match(messages[label], /[\uac00-\ud7af]/);
    }
    const translated = [];
    const f = fixture({}, { SoduWorkI18n: { getLocale: () => locale, translateText: text => {
      translated.push(text); return messages[text] || text;
    } } });
    const source = '保留原文 Original requirement';
    for (const kind of ['lite', 'web', 'desktop', undefined]) {
      for (const storageLocation of ['local', 'cloud', undefined]) {
        const payload = f.window.PluginBuilderEntry.buildPayload(source, { storageLocation, appCategory: 'office' }, true, kind);
        assert.ok(payload.prefill.endsWith(source));
        const prefix = payload.prefill.slice(0, -source.length);
        if (locale === 'en-US') assert.doesNotMatch(prefix, /[\u4e00-\u9fff]/);
        if (locale === 'ja-JP') assert.match(prefix, /[\u3040-\u30ff]/);
        if (locale === 'ko-KR') assert.match(prefix, /[\uac00-\ud7af]/);
        if (storageLocation) assert.ok(payload.contextPrompts[0].includes('"location":"' + storageLocation + '"'));
        assert.ok(payload.contextPrompts.join('\n').includes('appCategory=office'));
      }
    }
    assert.ok(!translated.includes(source));
  }
});

test('plugin authoring from an active conversation reuses it and returns a Promise', async () => {
  let complete, cleared = 0;
  const ctx = { _ref: 'existing', _pluginMention: {
    clearAction: () => cleared++, selected: () => [{ pluginId: 'local:plugin-builder' }],
    select: (id, current) => { assert.equal(id, 'local:plugin-builder'); assert.equal(current(), true);
      return new Promise(resolve => { complete = resolve; }); },
  } };
  const f = fixture(ctx), result = f.entry._openPluginBuilder(' keep history ');
  assert.equal(typeof result.then, 'function');
  assert.equal(f.input.value, 'original');
  complete({ pluginId: 'local:plugin-builder' });
  assert.equal(await result, true);
  assert.equal(cleared, 1);
  assert.equal(f.input.value, '制作插件：keep history');
  assert.deepEqual(f.events, ['input', 'focus']);
  assert.deepEqual(f.opened, []);
});

test('late or failed active selections do not open a new conversation or alter input', async () => {
  for (const failure of [false, true]) {
    let complete;
    const ctx = { _ref: 'old', _pluginMention: { selected: () => [{ pluginId: 'local:plugin-builder' }],
      select: () => new Promise((resolve, reject) => { complete = failure ? reject : resolve; }) } };
    const f = fixture(ctx), result = f.entry._openPluginBuilder('seed');
    if (failure) complete(new Error('selection failed'));
    else { ctx._ref = ''; complete({ pluginId: 'local:plugin-builder' }); }
    assert.equal(await result, false);
    assert.equal(f.input.value, 'original');
    assert.deepEqual(f.opened, []);
    assert.equal(f.messages.length, failure ? 1 : 0);
  }
});

test('the production workspace loads the shared entry before both composer clients', () => {
  const desk = fs.readFileSync(path.join(__dirname, '../desk.html'), 'utf8');
  const shared = desk.indexOf('src="components/panels/panels-plugin-builder-entry.js"');
  assert.ok(shared >= 0);
  for (const name of ['chat-composer-bindings.js', 'compose-surface.js']) {
    assert.ok(shared < desk.indexOf('src="components/panels/' + name + '"'));
  }
});


test('editing an instant app starts a fresh development chat like plugin improvement, with a full-source edit reference',async()=>{
 const draft={template:'app',key:'idea',name:'灵感扭蛋机'},f=fixture({}, {
   SoduWorkAPI:{personalPlugin:async()=>({plugin:{template:'app',name:draft.name,localDraft:draft}})},
   SoduWorkPluginAccess:{assertEditable:async value=>assert.equal(value,draft)}});
 await f.window.PluginBuilderEntry.editApp('local:idea');
 const opened=f.opened[0];assert.equal(opened.view,'create');assert.equal(opened.payload.newSession,true);
 assert.equal(opened.payload.pluginId,'local:app-developer');assert.equal(opened.payload.pluginEditId,'local:idea');
 assert.match(opened.payload.prefill,/修改即用/);assert.equal(opened.payload.sessionId,undefined);
});
