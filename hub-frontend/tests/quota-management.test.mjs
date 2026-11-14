import './helpers/chinese-locale.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createComponentHarness } from './helpers/react-harness.mjs'
import * as model from '../src/screens/quota-model.js'
import english, { ja, ko } from '../src/locales/quota-management.js'
import { translateText as tx, setLocale, t } from '../src/i18n.js'

const choices = [{ provider: 'first', model: 'model/a', label: 'Model A' }, { provider: 'second', model: 'model/a', label: 'Model B' }]
const trial = { id: 'trial', name: '试用', description: '', period: 'once', durationDays: 7, totalLimit: 100000, models: [], restrictModels: false }
const standard = { ...trial, id: 'standard', name: 'Standard', period: 'monthly', totalLimit: 1000000 }
const config = { revision: 4, plans: [trial, standard], defaultLimit: null, models: choices }
const baseAllowance = { totalLimit: 1000, models: [], restrictModels: false }

test('allowances distinguish an explicit zero pause from unlimited and validate integers', () => {
  assert.equal(model.validateAllowance({ ...baseAllowance, totalLimit: 0 }, choices).totalLimit, 0)
  assert.equal(model.validateAllowance({ ...baseAllowance, totalLimit: null }, choices).totalLimit, null)
  for (const value of ['', '  ', false, -1, 1.5, Infinity, 10000000000001]) {
    assert.throws(() => model.validateAllowance({ ...baseAllowance, totalLimit: value }, choices), /整数/)
  }
  assert.equal(model.validateAllowance({ ...baseAllowance, totalLimit: '100000' }, choices).totalLimit, 100000)
})

test('models are keyed by provider and model; duplicates, missing models and an empty allow-list cannot save', () => {
  const rows = choices.map(row => ({ ...row, limit: '500' }))
  const next = model.validateAllowance({ ...baseAllowance, models: rows, restrictModels: true }, choices)
  assert.equal(next.models.length, 2)
  assert.equal(next.models[0].limit, 500)
  assert.equal('label' in next.models[0], false)
  assert.throws(() => model.validateAllowance({ ...baseAllowance, models: [rows[0], rows[0]] }, choices), /一条额度/)
  assert.throws(() => model.validateAllowance({ ...baseAllowance, models: [{ ...rows[0], model: 'deleted' }] }, choices), /可用的模型/)
  assert.throws(() => model.validateAllowance({ ...baseAllowance, restrictModels: true }, choices), /至少/)
  assert.throws(() => model.validateAllowance({ ...baseAllowance, models: [{ ...rows[0], limit: '' }] }, choices), /整数/)
})

test('trial stays a one-time positive allowance; monthly plan payload honors the backend duration bounds', () => {
  const next = model.validatePlan(trial, choices)
  assert.equal(next.durationDays, 7); assert.equal(next.totalLimit, 100000); assert.equal(next.period, 'once')
  for (const durationDays of [0, '', 366, 1.5]) assert.throws(() => model.validatePlan({ ...trial, durationDays }, choices), /365/)
  for (const totalLimit of [0, null]) assert.throws(() => model.validatePlan({ ...trial, totalLimit }, choices), /大于 0/)
  const monthly = model.validatePlan({ ...standard, period: 'once', durationDays: 0 }, choices)
  assert.equal(monthly.period, 'monthly'); assert.equal(monthly.durationDays, 7)
})

test('catalog saves preserve other plans, the legacy default and revision without writing model choices', () => {
  const changed = { ...standard, totalLimit: 2500000 }
  const body = model.replacePlan(config, changed)
  assert.deepEqual(body, { revision: 4, plans: [trial, changed], defaultLimit: null })
  assert.equal(config.plans[1].totalLimit, 1000000)
  const newPlan = { ...standard, id: 'custom' }
  assert.equal(model.replacePlan(config, newPlan).plans.length, 3)
})

test('individual assignments retain the assignment revision and do not issue a trial to an old account', () => {
  const member = { assignment: { revision: 8, hasTrial: false } }
  assert.deepEqual(model.validateAssignment(member, { mode: 'inherit' }, choices), { revision: 8, mode: 'inherit' })
  assert.throws(() => model.validateAssignment(member, { mode: 'plan', planId: 'trial' }, choices), /可分配/)
  assert.deepEqual(model.validateAssignment({ assignment: { revision: 9, hasTrial: true } }, { mode: 'plan', planId: 'trial' }, choices), { revision: 9, mode: 'plan', planId: 'trial' })
  assert.deepEqual(model.validateAssignment(member, { mode: 'custom', custom: { ...baseAllowance, totalLimit: 0 } }, choices), { revision: 8, mode: 'custom', custom: { ...baseAllowance, totalLimit: 0 } })
  assert.throws(() => model.validateAssignment(member, { mode: 'unknown' }, choices), /额度规则/)
})

test('usage displays a bounded progress bar without altering ledger totals', () => {
  const quota = { totalLimited: true, limit: 100, used: 340 }
  assert.equal(model.usagePercent(quota), 100); assert.equal(quota.used, 340)
  assert.equal(model.usagePercent({ totalLimited: true, limit: 0, used: 300 }), 0)
  assert.equal(model.usagePercent({ totalLimited: false, limit: 0, used: 300 }), 0)
})

test('quota copy is fully translated in all four locales and preserves placeholders', (context) => {
  context.after(() => setLocale('zh-CN'))
  const placeholders = value => [...value.matchAll(/\{\d+\}/g)].map(row => row[0]).sort()
  for (const [locale, messages] of [['en-US', english], ['ja-JP', ja], ['ko-KR', ko]]) {
    setLocale(locale)
    for (const [source, translated] of Object.entries(english)) {
      assert.ok(messages[source], locale + ': ' + source)
      assert.deepEqual(placeholders(messages[source]), placeholders(source))
      assert.equal(tx(source), messages[source])
      if (locale === 'en-US') assert.equal(tx(source), translated)
    }
    assert.notEqual(t('nav.quotas'), '额度管理')
  }
  setLocale('zh-CN'); assert.equal(tx('额度管理'), '额度管理')
})

test('quota validators preserve stable error keys for current-language presentation', (context) => {
  context.after(() => setLocale('zh-CN'))
  for (const [locale, messages] of [['zh-CN', null], ['en-US', english], ['ja-JP', ja], ['ko-KR', ko]]) {
    setLocale(locale)
    const expected = source => error => {
      assert.equal(error.message, source)
      assert.equal(tx(error.message), messages?.[source] || source)
      return true
    }
    assert.throws(() => model.validateAllowance({ ...baseAllowance, totalLimit: -1 }, choices),
      expected('请输入 0 到 10,000,000,000,000 的整数'))
    assert.throws(() => model.validateAllowance({ ...baseAllowance, restrictModels: true }, choices),
      expected('仅允许所列模型时，请至少添加一个模型'))
    assert.throws(() => model.validatePlan({ ...standard, name: ' ' }, choices),
      expected('请填写套餐名称，最多 60 字'))
    assert.throws(() => model.validateAssignment({ assignment: { revision: 1 } }, { mode: 'unknown' }, choices),
      expected('请选择额度规则'))
  }
})

const footerButtons = page => page.nodes(node => node.type === 'Modal')[0].props.foot.props.children
const fieldByLabel = (page, label) => page.nodes(node => node.type === 'label' && node.props.children?.[0]?.props.children === label)[0]?.props.children[1]

async function planHarness(overrides = {}) {
  let currentConfig = structuredClone(config)
  const saves = [], notices = []
  const page = await createComponentHarness(new URL('../src/screens/QuotaEditors.jsx', import.meta.url), { exportName: 'PlanEditor', props: {}, dependencies: {
    '../api.js': { api: {
      saveQuotaPlans: async body => { saves.push(body); return { ...body, revision: body.revision + 1 } },
      quotaPlans: async () => currentConfig,
      ...overrides,
    } },
    '../ui.jsx': { Modal: 'Modal', SelectMenu: 'SelectMenu', toast: value => notices.push(value) },
    './QuotaAllowanceFields.jsx': { __esModule: true, default: 'AllowanceFields', TotalLimitField: 'TotalLimitField' },
    './quota-model.js': model,
  } })
  function props() { return { plan: trial, config: currentConfig, onConfig: next => { currentConfig = next; page.render(props()) }, onClose() {}, onSaved() {} } }
  page.render(props())
  return { page, saves, notices, updateConfig: value => { currentConfig = value; page.render(props()) } }
}

test('plan editor saves an edited trial with revision, full retained catalog, and no read-only choices', async () => {
  const { page, saves } = await planHarness()
  page.act(() => fieldByLabel(page, '试用有效天数').props.onChange({ target: { value: '14' } }))
  page.act(() => footerButtons(page)[1].props.onClick()); await page.flush()
  assert.equal(saves.length, 1); assert.equal(saves[0].plans[0].durationDays, 14)
  assert.equal(saves[0].revision, 4); assert.equal(saves[0].plans[1].id, 'standard')
  assert.equal('models' in saves[0], false)
  page.unmount()
})

test('conflicts keep the draft, block blind retries and rebase just the edited plan after explicit reload', async () => {
  let first = true
  const latest = { ...config, revision: 9, plans: [{ ...trial, totalLimit: 150000 }, { ...standard, name: 'Changed by colleague' }] }
  const saved = []
  const { page } = await planHarness({
    saveQuotaPlans: async body => { if (first) { first = false; throw Object.assign(Error('conflict'), { status: 409 }) } saved.push(body); return { ...body, revision: 10 } },
    quotaPlans: async () => latest,
  })
  page.act(() => fieldByLabel(page, '套餐名称').props.onChange({ target: { value: 'My preserved draft' } }))
  page.act(() => footerButtons(page)[1].props.onClick()); await page.flush()
  assert.equal(footerButtons(page)[1].props.disabled, true)
  const feedback = page.nodes(node => typeof node.type === 'function' && node.type.name === 'EditorFeedback')[0]
  assert.equal(feedback.props.conflict, true)
  page.act(() => feedback.props.onRefresh()); await page.flush()
  assert.equal(fieldByLabel(page, '套餐名称').props.value, 'My preserved draft')
  assert.equal(footerButtons(page)[1].props.children, '覆盖此项并保存')
  page.act(() => footerButtons(page)[1].props.onClick()); await page.flush()
  assert.equal(saved[0].revision, 9); assert.equal(saved[0].plans[1].name, 'Changed by colleague')
  assert.equal(saved[0].plans[0].name, 'My preserved draft')
  page.unmount()
})

test('quota inputs are removed from user editing and login policy saves cannot change quotas', async () => {
  const users = fs.readFileSync(new URL('../src/screens/Users.jsx', import.meta.url), 'utf8')
  assert.doesNotMatch(users, /tokenQuota|quotaMode|quotaLimit/)
  const calls = []
  const page = await createComponentHarness(new URL('../src/screens/ClientAccessPolicy.jsx', import.meta.url), { dependencies: {
    '../api.js': { api: { clientAuthPolicy: async () => ({ allowSelfRegistration: true, defaultOrgId: '', defaultRoleId: '', tokenLimitEnabled: true, monthlyTokenLimit: 500 }), orgs: async () => [], roles: async () => [], saveClientAuthPolicy: async value => { calls.push(value); return value } } },
    '../ui.jsx': { Icon: 'Icon', SelectMenu: 'SelectMenu', toast() {} }, './client-access-policy.css': {},
  } })
  page.render(); await page.flush()
  page.act(() => page.nodes(node => node.type === 'button' && node.props.children?.[1] === '保存策略')[0].props.onClick()); await page.flush()
  assert.deepEqual(calls, [{ allowSelfRegistration: true, defaultOrgId: '', defaultRoleId: '' }])
  page.unmount()
})

test('member search debounces requests, ignores stale responses and does not update after unmount', async () => {
  const pending = []
  const page = await createComponentHarness(new URL('../src/screens/QuotaMembers.jsx', import.meta.url), { props: { config, revision: 0 }, dependencies: {
    '../api.js': { api: { quotaMembers: args => new Promise(resolve => pending.push({ args, resolve })) } },
    '../ui.jsx': { Icon: 'Icon' }, './QuotaEditors.jsx': { MemberEditor: 'MemberEditor' }, './quota-model.js': model,
  } })
  page.render(); await new Promise(resolve => setTimeout(resolve, 20)); await page.flush()
  assert.equal(pending.length, 1); assert.equal(pending[0].args.limit, 50)
  const input = () => page.nodes(node => node.type === 'input')[0]
  page.act(() => input().props.onChange({ target: { value: 'al' } }))
  page.act(() => input().props.onChange({ target: { value: 'alice' } }))
  await new Promise(resolve => setTimeout(resolve, 280)); await page.flush()
  assert.equal(pending.length, 2); assert.equal(pending[1].args.q, 'alice')
  pending[1].resolve({ items: [], total: 2 }); await page.flush()
  pending[0].resolve({ items: [], total: 999 }); await page.flush()
  assert.equal(page.nodes(node => node.props['aria-live'] === 'polite')[0].props.children, '共 2 位成员')
  page.act(() => input().props.onChange({ target: { value: 'bob' } }))
  await new Promise(resolve => setTimeout(resolve, 280)); page.unmount()
  pending[2].resolve({ items: [], total: 50 }); await new Promise(resolve => setImmediate(resolve))
})

test('the member editor rejects invalid caps, saves a zero pause and retains unlimited as null', async () => {
  const calls = []
  const member = { id: 'alice', username: 'alice', displayName: 'Alice', assignment: { revision: 8, mode: 'custom', hasTrial: false, custom: baseAllowance }, quota: { totalLimited: true, limit: 1000, models: [] } }
  const page = await createComponentHarness(new URL('../src/screens/QuotaEditors.jsx', import.meta.url), { exportName: 'MemberEditor', props: { member, config, onClose() {}, onSaved() {} }, dependencies: {
    '../api.js': { api: { assignQuota: async (id, body) => { calls.push([id, body]); return { ok: true } } } },
    '../ui.jsx': { Modal: 'Modal', SelectMenu: 'SelectMenu', toast() {} },
    './QuotaAllowanceFields.jsx': { __esModule: true, default: 'AllowanceFields', TotalLimitField: 'TotalLimitField' },
    './quota-model.js': model,
  } })
  page.render()
  const edit = value => page.act(() => page.nodes(node => node.type === 'AllowanceFields')[0].props.onChange({ ...baseAllowance, totalLimit: value }))
  for (const value of ['', '-1', '1.5', '10000000000001']) {
    edit(value); page.act(() => footerButtons(page)[1].props.onClick()); await page.flush()
    assert.equal(calls.length, 0)
  }
  edit('0'); page.act(() => footerButtons(page)[1].props.onClick()); await page.flush()
  assert.deepEqual(calls[0], ['alice', { revision: 8, mode: 'custom', custom: { ...baseAllowance, totalLimit: 0 } }])
  edit(null); page.act(() => footerButtons(page)[1].props.onClick()); await page.flush()
  assert.equal(calls[1][1].custom.totalLimit, null)
  page.unmount()
})

test('page refresh reloads member quotas without changing the catalog revision, search or open editor', async () => {
  const calls = []
  let member = { id: 'alice', username: 'alice', displayName: 'Alice', isActive: true,
    assignment: { revision: 8, mode: 'custom', hasTrial: false, custom: baseAllowance },
    quota: { totalLimited: true, limit: 1000, used: 1000, exceeded: true, models: [] } }
  const api = {
    quotaPlans: async () => structuredClone(config),
    quotaMembers: async args => { calls.push(args); return { items: [member], total: 1 } },
  }
  const page = await createComponentHarness(new URL('../src/screens/QuotaManagement.jsx', import.meta.url), { dependencies: {
    '../api.js': { api }, '../ui.jsx': { Icon: 'Icon', Loading: 'Loading' },
    './QuotaMembers.jsx': { __esModule: true, default: 'QuotaMembers' },
    './QuotaEditors.jsx': { DefaultEditor: 'DefaultEditor', PlanEditor: 'PlanEditor' },
    './quota-management.css': {},
  } })
  page.render(); await page.flush()
  page.act(() => page.nodes(node => node.props.id === 'qm-tab-members')[0].props.onClick())
  const memberProps = () => page.nodes(node => node.type === 'QuotaMembers')[0].props
  const members = await createComponentHarness(new URL('../src/screens/QuotaMembers.jsx', import.meta.url), { props: memberProps(), dependencies: {
    '../api.js': { api }, '../ui.jsx': { Icon: 'Icon' },
    './QuotaEditors.jsx': { MemberEditor: 'MemberEditor' }, './quota-model.js': model,
  } })
  const settleMembers = async () => { await new Promise(resolve => setTimeout(resolve, 280)); await members.flush() }
  members.render(); await settleMembers()
  members.act(() => members.nodes(node => node.type === 'input')[0].props.onChange({ target: { value: 'alice' } }))
  await settleMembers()
  members.act(() => members.nodes(node => node.type === 'button' && node.props.className === 'admin-text-action')[0].props.onClick())
  const editing = members.nodes(node => node.type === 'MemberEditor')[0].props.member
  const before = calls.length
  member = { ...member, assignment: { ...member.assignment, revision: 9 },
    quota: { ...member.quota, limit: 1000000, exceeded: false } }
  page.act(() => page.nodes(node => node.type === 'header')[0].props.children[1].props.onClick())
  await page.flush()
  assert.equal(memberProps().config.revision, config.revision)
  members.render(memberProps()); await settleMembers()
  assert.equal(calls.length, before + 1, 'refresh must reload assignments independently of catalog edits')
  assert.equal(calls.at(-1).q, 'alice')
  assert.equal(members.nodes(node => node.type === 'input')[0].props.value, 'alice')
  assert.equal(members.nodes(node => node.props.className === 'qm-status ')[0].props.children, '\u53ef\u4f7f\u7528')
  assert.equal(members.nodes(node => node.type === 'MemberEditor')[0].props.member, editing,
    'an open editor must retain its draft snapshot and original conflict revision')
  members.unmount(); page.unmount()
})
