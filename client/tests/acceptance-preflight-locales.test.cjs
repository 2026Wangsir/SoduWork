'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function boot(locale) {
  const context = vm.createContext({
    console, JSON, Math, Date, RegExp, Object, Array, String, Number, Boolean, Error, TypeError, Intl,
    localStorage: {getItem: () => null, setItem() {}},
    addEventListener() {}, dispatchEvent() {},
    MutationObserver: class {observe() {} disconnect() {}},
    CustomEvent: class {constructor(type, init) {this.type = type; this.detail = init?.detail;}},
    document: {readyState: 'loading', documentElement: {dataset: {}}, querySelectorAll: () => []},
  });
  context.window = context;
  context.globalThis = context;
  const load = file => vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context, {filename: file});
  for (const file of JSON.parse(fs.readFileSync(path.join(__dirname, '../core/locales/manifest.json'), 'utf8')))
    load('core/locales/' + file);
  load('core/i18n.js');
  context.SoduWorkI18n.setLocale(locale);
  load('components/panels/task-trace-approval.js');
  return context;
}

test('automatic review preflight emits actionable errors in every supported locale before navigation', async () => {
  const messages = {
    'zh-CN': ['自动验收需要明确的验收标准和固定交付版本，请先补齐或选择手动验收', '暂时无法读取验收条件，请刷新后重试'],
    'en-US': ['Automatic review requires acceptance criteria and a fixed delivery version. Complete them first or choose manual review.', 'Review prerequisites could not be loaded. Refresh and try again.'],
    'ja-JP': ['自動検収には明確な検収基準と固定された納品バージョンが必要です。先に補うか、手動検収を選択してください。', '検収条件を読み込めませんでした。更新して再試行してください。'],
    'ko-KR': ['자동 검수에는 명확한 검수 기준과 고정된 납품 버전이 필요합니다. 먼저 해당 내용을 갖추거나 수동 검수를 선택하세요.', '검수 조건을 불러오지 못했습니다. 새로고침 후 다시 시도하세요.'],
  };
  for (const [locale, expected] of Object.entries(messages)) {
    const context = boot(locale);
    let opened = 0;
    context.openTaskConversation = async () => {opened++; return true;};
    context.SoduWorkAPI = {getAcceptanceContext: async () => ({artifactVersionId: 'v1', criteria: []})};
    await assert.rejects(context.TaskTraceApproval.openAcceptance({id: 'task-' + locale}, {acceptanceMode: 'auto'}),
      {message: expected[0]}, locale);
    delete context.SoduWorkAPI.getAcceptanceContext;
    await assert.rejects(context.TaskTraceApproval.openAcceptance({id: 'task-' + locale}, {acceptanceMode: 'auto'}),
      {message: expected[1]}, locale);
    assert.equal(opened, 0, locale);
  }
});
