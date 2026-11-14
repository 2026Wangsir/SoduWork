'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function node(tag = '') {
  const attributes = new Map();
  const value = {
    children: [],
    tag,
    dataset: {},
    hidden: false,
    isConnected: false,
    textContent: '',
    disabled: false,
    className: '',
    setAttribute(name, text) {
      attributes.set(name, String(text));
      if (name === 'class') this.className = String(text);
      if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = String(text);
    },
    getAttribute(name) { return attributes.get(name) || null; },
    append(...children) { this.children.push(...children); },
    appendChild(child) { this.children.push(child); },
    before(child) { this.parentElement?.children?.push(child); child.isConnected = true; },
    listeners: {},
    addEventListener(name, handler) { this.listeners[name] = handler; },
    querySelector(selector) {
      const matches = child => {
        if (selector.startsWith('[data-')) {
          const key = selector.slice(6, -1).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
          return Object.hasOwn(child.dataset || {}, key);
        }
        return child.tag === selector;
      };
      const visit = children => {
        for (const child of children || []) {
          if (matches(child)) return child;
          const found = visit(child.children);
          if (found) return found;
        }
        return null;
      };
      return visit(this.children);
    },
  };
  Object.defineProperty(value, 'classList', { value: { contains: name => String(value.className).split(/\s+/).includes(name) } });
  return value;
}

function fixture() {
  const calls = [];
  const events = {};
  const document = { createElement: tag => node(tag) };
  const ctx = {
    window: null,
    console,
    document,
    addEventListener(name, handler) { events[name] = handler; },
    SoduWorkI18n: { translateText: value => value, getLocale: () => 'zh-CN' },
    SoduWorkQuota: {
      detail: value => ({ code: 'TOKEN_QUOTA_EXCEEDED', quota: value.quota }),
      copy: () => ({ title: '本期额度已用完', guidance: '联系管理员调整额度后，即可继续。', used: '已用 100 / 100', timing: '' }),
    },
    SoduWorkAPI: {
      clientAuthSnapshot: () => ({ user: { id: 'user-a' } }),
      clientAuthMe: async () => ({ user: { id: 'user-a' }, quota: { enabled: true, exceeded: false, remaining: 100 } }),
      hubConfig: () => ({ hub: 'test' }),
    },
    ClientAuth: {
      clearQuotaNotice: () => calls.push('clear'),
      updateIdentity: (_user, quota) => calls.push(['identity', quota.exceeded]),
    },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../components/client-auth/quota-notice.js'), 'utf8'), ctx);
  return { ctx, calls, events };
}

test('the built-in trial label follows the locale while custom plan names remain unchanged', () => {
  const f = fixture();
  const english = require('../core/locales/en-US');
  f.ctx.SoduWorkI18n = { getLocale: () => 'en-US', translateText: value => english[value] || value };
  f.ctx.SoduWorkQuota = require('../core/token-quota');
  const composer = { parentElement: {}, previousElementSibling: null, before(card) { card.isConnected = true; } };
  const card = f.ctx.SoduWorkQuotaNotice.mount(composer);
  const base = { enabled: true, exceeded: true, limit: 100000, used: 101614, period: 'trial' };
  for (const [planId, planName, expected] of [
    ['trial', '试用', 'Trial'], ['trial', '销售团队试用', '销售团队试用'], ['custom', '试用', '试用'],
  ]) {
    f.ctx.SoduWorkQuotaNotice.update({ quota: { ...base, planId, planName } });
    assert.equal(card.querySelector('[data-quota-detail]').textContent.split('\n')[0], expected);
  }
  f.ctx.SoduWorkI18n = { getLocale: () => 'zh-CN', translateText: value => value };
  f.ctx.SoduWorkQuotaNotice.update({ quota: { ...base, planId: 'trial', planName: '试用' } });
  assert.equal(card.querySelector('[data-quota-detail]').textContent.split('\n')[0], '试用');
});

test('a recovery hint keeps the quota card until the Hub confirms the new allowance', async () => {
  const f = fixture(), composer = { parentElement: {}, previousElementSibling: null, before(card) { card.isConnected = true; this.card = card; } };
  const card = f.ctx.SoduWorkQuotaNotice.mount(composer);
  f.ctx.SoduWorkQuotaNotice.update({ quota: { enabled: true, exceeded: true, used: 100, limit: 100 } });
  assert.equal(card.hidden, false);
  const refresh = f.ctx.SoduWorkQuotaNotice.markRestored();
  assert.equal(card.hidden, false, 'a notification cannot assert that quota has recovered');
  assert.deepEqual(f.calls, []);
  await refresh;
  assert.equal(card.hidden, true);
  assert.deepEqual(f.calls, [['identity', false]]);
});

test('没有额度卡时恢复通知不会触发无意义的刷新请求', () => {
  const f = fixture();
  assert.equal(f.ctx.SoduWorkQuotaNotice.markRestored(), false);
  assert.deepEqual(f.calls, []);
});

test('selected personal Pi hides only the platform budget card and never clears the global budget', () => {
  const f = fixture();
  f.ctx.SoduWorkQuota = require('../core/token-quota');
  const composer = { parentElement: {}, before(card) { card.isConnected = true; } };
  const card = f.ctx.SoduWorkQuotaNotice.mount(composer), notice = f.ctx.SoduWorkQuotaNotice;
  const platform = { enabled: true, exceeded: true, reason: 'total_exhausted', limit: 10, used: 10,
    quotaVersion: 2, personalModelsAllowed: true };
  delete platform.reason; // Legacy monthly quotas rely on the explicit v2 allowance flag.
  const personal = { id: 'mine', quotaVersion: 2, quotaScope: 'personal' };
  notice.update({ quota: platform });
  notice.modelChanged({ id: 'org', quotaVersion: 2, quotaScope: 'platform' }, 'pi', composer);
  assert.equal(card.hidden, false);
  assert.match(card.querySelector('[data-quota-guidance]').textContent, /\u4e2a\u4eba\u6a21\u578b/);
  notice.modelChanged(personal, 'pi', composer);
  assert.equal(card.hidden, true);
  assert.deepEqual(f.calls, [], 'choosing personal must not mark the global account quota restored');
  notice.modelChanged({ id: 'org', quotaVersion: 2, quotaScope: 'platform' }, 'pi', composer);
  assert.equal(card.hidden, false, 'switching back still shows exhausted platform budget');
  notice.modelChanged(personal, 'codex-harness', composer);
  assert.equal(card.hidden, false);
  assert.doesNotMatch(card.querySelector('[data-quota-guidance]').textContent, /\u4e2a\u4eba\u6a21\u578b/);
  for (const patch of [{ reason: 'trial_expired' }, { limit: 0 }, { restrictModels: true }, { quotaVersion: 1 }]) {
    notice.update({ quota: { ...platform, ...patch } });
    notice.modelChanged(personal, 'pi', composer);
    assert.equal(card.hidden, false);
    assert.doesNotMatch(card.querySelector('[data-quota-guidance]').textContent, /\u4e2a\u4eba\u6a21\u578b/);
  }
});

test('selected local Pi hides a platform quota card without changing the authoritative quota state', () => {
  const f = fixture();
  const composer = { parentElement: {}, before(card) { card.isConnected = true; } };
  const notice = f.ctx.SoduWorkQuotaNotice, card = notice.mount(composer);
  const exhausted = { enabled: true, exceeded: true, reason: 'total_exhausted', limit: 10, used: 10 };
  notice.update({ quota: exhausted });
  notice.modelChanged({ id: 'local:model-0123456789abcdef0123456789abcdef', localOnly: true }, 'pi', composer);
  assert.equal(card.hidden, true);
  notice.modelChanged({ id: 'managed-model' }, 'pi', composer);
  assert.equal(card.hidden, false, 'switching back to a managed model must restore the exhausted card');
  assert.deepEqual(f.calls, [], 'local model selection must not clear or acknowledge platform quota');
});

test('an allowed personal conversation does not hide another mounted composer quota card', () => {
  const f = fixture(); f.ctx.SoduWorkQuota = require('../core/token-quota');
  const notice = f.ctx.SoduWorkQuotaNotice;
  const one = { parentElement: {}, before(card) { card.isConnected = true; } };
  const two = { parentElement: {}, before(card) { card.isConnected = true; } };
  const a = notice.mount(one), b = notice.mount(two);
  notice.update({ quota: { enabled: true, exceeded: true, limit: 10, used: 10,
    quotaVersion: 2, personalModelsAllowed: true } });
  notice.modelChanged({ id: 'mine', quotaVersion: 2, quotaScope: 'personal' }, 'pi',
    { querySelector: selector => selector === '.work-composer' ? one : null });
  notice.modelChanged({ id: 'org', quotaVersion: 2, quotaScope: 'platform' }, 'pi', two);
  assert.equal(a.hidden, true);
  assert.equal(b.hidden, false);
  notice.modelChanged();
  assert.equal(a.hidden, false, 'leaving a conversation clears its allowance presentation');
  assert.equal(b.hidden, false);
});

test('a delayed trial denial cannot replace a confirmed custom allowance', async () => {
  const f = fixture(), notice = f.ctx.SoduWorkQuotaNotice;
  const card = notice.mount({ parentElement: {}, before(card) { card.isConnected = true; } });
  const quota = { enabled: true, exceeded: false, limit: 1000000000, used: 12855, planId: 'custom' };
  notice.update({ quota });
  let resolve;
  f.ctx.SoduWorkAPI.clientAuthMe = () => new Promise(done => { resolve = done; });
  assert.equal(notice.show({ quota: { enabled: true, exceeded: true, limit: 10, used: 12855, planId: 'trial' } }), true);
  assert.equal(card.hidden, true);
  const pending = notice.refresh();
  await Promise.resolve();
  resolve({ user: { id: 'user-a' }, quota });
  await pending;
  assert.equal(card.hidden, true);
  assert.deepEqual(f.calls, [['identity', false]]);
});

test('failed recovery verification retains the warning and can be retried', async () => {
  const f = fixture(), notice = f.ctx.SoduWorkQuotaNotice;
  const card = notice.mount({ parentElement: {}, before(card) { card.isConnected = true; } });
  notice.update({ quota: { enabled: true, exceeded: true, limit: 10, used: 12855 } });
  let calls = 0;
  f.ctx.SoduWorkAPI.clientAuthMe = async () => { calls++; throw Error('offline'); };
  await notice.markRestored();
  assert.equal(card.hidden, false);
  assert.equal(notice.isBlocked(), true);
  assert.equal(card.dataset.feedback, 'failed');
  await notice.refreshIfBlocked();
  assert.equal(calls, 2);
  assert.deepEqual(f.calls, []);
});

test('a denial followed by a failed refresh shows uncertainty without restoring an old trial', async () => {
  const f = fixture(), notice = f.ctx.SoduWorkQuotaNotice;
  const card = notice.mount({ parentElement: {}, before(card) { card.isConnected = true; } });
  const quota = { enabled: true, exceeded: false, limit: 1000000000, planId: 'custom' };
  notice.update({ quota });
  f.ctx.SoduWorkAPI.clientAuthMe = async () => { throw Error('offline'); };
  notice.show({ quota: { enabled: true, exceeded: true, limit: 10, planId: 'trial' } });
  // Repainting the same known identity must not acknowledge the unresolved denial.
  notice.update({ quota });
  await notice.refresh();
  assert.equal(card.hidden, false);
  assert.equal(card.querySelector('[data-quota-title]').textContent, '请刷新查看当前额度');
  assert.equal(card.querySelector('[data-quota-detail]').textContent, '');
  assert.equal(notice.isBlocked(), true);
  f.ctx.SoduWorkAPI.clientAuthMe = async () => ({ quota: { ...quota } });
  await notice.refreshIfBlocked();
  assert.equal(card.hidden, true); assert.equal(notice.isBlocked(), false);
});

test('model allowance belongs to each composer and survives aggregate refreshes', async () => {
  const f = fixture(), notice = f.ctx.SoduWorkQuotaNotice;
  const composer = () => ({ parentElement: {}, before(card) { card.isConnected = true; } });
  const one = composer(), two = composer(), a = notice.mount(one), b = notice.mount(two);
  const quota = { enabled: true, exceeded: false, limit: 1000, used: 100, models: [
    { provider: 'p', model: 'a', limit: 100, used: 100, remaining: 0, exceeded: true },
    { provider: 'p', model: 'b', limit: 500, used: 0, remaining: 500, exceeded: false },
  ] };
  notice.update({ quota });
  notice.modelChanged({ id: 'b', quotaProvider: 'p' }, 'pi', two);
  notice.modelChanged({ id: 'a', quotaProvider: 'p' }, 'pi', one);
  assert.equal(a.hidden, false); assert.equal(b.hidden, true);
  notice.modelChanged({ id: 'b', quotaProvider: 'p' }, 'pi', two);
  assert.equal(a.hidden, false); assert.equal(b.hidden, true);
  assert.equal(notice.isBlocked(), true);
  f.ctx.SoduWorkAPI.clientAuthMe = async () => ({ quota });
  await notice.refresh();
  assert.equal(a.hidden, false); assert.equal(b.hidden, true);
  f.ctx.SoduWorkAPI.clientAuthMe = async () => ({ quota: { ...quota, models: quota.models.map(row => ({ ...row, exceeded: false })) } });
  await notice.refresh();
  assert.equal(a.hidden, true); assert.equal(b.hidden, true);
  assert.equal(notice.isBlocked(), false);
});

test('a quota domain hint refreshes the current account without asserting restoration', async () => {
  const f = fixture(), notice = f.ctx.SoduWorkQuotaNotice;
  const card = notice.mount({ parentElement: {}, before(card) { card.isConnected = true; } });
  notice.update({ quota: { enabled: true, exceeded: true, limit: 10 } });
  f.events['soduwork-domain-changed']({ detail: { domain: 'quota' } });
  assert.equal(card.hidden, false);
  await notice.refresh();
  assert.equal(card.hidden, true);
  assert.deepEqual(f.calls, [['identity', false]]);
});

test('an old account refresh cannot repaint a new account card', async () => {
  const f = fixture(), notice = f.ctx.SoduWorkQuotaNotice;
  const card = notice.mount({ parentElement: {}, before(card) { card.isConnected = true; } });
  notice.update({ quota: { enabled: true, exceeded: true, limit: 10 } });
  let resolve;
  f.ctx.SoduWorkAPI.clientAuthMe = () => new Promise(done => { resolve = done; });
  const pending = notice.refresh(); await Promise.resolve();
  f.ctx.SoduWorkAPI.clientAuthSnapshot = () => ({ user: { id: 'user-b' } });
  f.events['soduwork-data-scope-changed']();
  resolve({ user: { id: 'user-a' }, quota: { enabled: true, exceeded: true, limit: 10 } });
  await pending;
  assert.equal(card.hidden, true); assert.deepEqual(f.calls, []);
});

test('the legacy floating warning follows authoritative quota and keeps dismissal', () => {
  const f = fixture(), document = f.ctx.document;
  Object.assign(document, { readyState: 'loading', addEventListener() {},
    documentElement: { classList: { add() {} } }, body: node(),
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] });
  f.ctx.SoduWorkQuota = require('../core/token-quota');
  // Expose the private event handler without running the unrelated login form.
  const source = fs.readFileSync(path.join(__dirname, '../components/client-auth/client-auth.js'), 'utf8')
    .replace('global.ClientAuth = {', 'global.ClientAuth = { handleAuthEvent: show,');
  vm.runInContext(source, f.ctx);
  const auth = f.ctx.ClientAuth, user = { id: 'user-a' };
  const quota = { enabled: true, exceeded: true, period: 'trial', limit: 10, used: 12855 };
  auth.handleAuthEvent({ authenticated: true, state: 'quota', user, quota });
  const toast = document.body.children[0];
  assert.equal(toast.hidden, false);
  assert.doesNotMatch(toast.querySelector('span').textContent, /下月恢复/);
  toast.querySelector('button').listeners.click();
  auth.updateIdentity(user, quota);
  assert.equal(toast.hidden, true, 'ordinary identity updates retain dismissal');
  auth.updateIdentity(user, { ...quota, limit: 1000000000, exceeded: false });
  assert.equal(toast.hidden, true);
  auth.handleAuthEvent({ authenticated: true, state: 'quota', user, quota });
  assert.equal(toast.hidden, false);
  auth.updateIdentity(user, { ...quota, limit: 1000000000, exceeded: false });
  assert.equal(toast.hidden, true, 'the visible warning clears on verified recovery');
});
