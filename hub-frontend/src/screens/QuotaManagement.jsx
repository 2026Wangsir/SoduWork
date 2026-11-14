import React, { useEffect, useState } from 'react'
import { translateText as tx, useLocale } from '../i18n.js'
import { api } from '../api.js'
import { Icon, Loading } from '../ui.jsx'
import QuotaMembers from './QuotaMembers.jsx'
import { DefaultEditor, PlanEditor } from './QuotaEditors.jsx'
import './quota-management.css'

const TABS = ['plans', 'members', 'defaults']
export default function QuotaManagement() {
  const locale = useLocale()
  const [config, setConfig] = useState(null), [error, setError] = useState(''), [loading, setLoading] = useState(true)
  const [tab, setTab] = useState('plans'), [editor, setEditor] = useState(null), [revision, setRevision] = useState(0)
  async function load() {
    setLoading(true); setError('')
    try { setConfig(await api.quotaPlans()); setRevision(value => value + 1) } catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }
  useEffect(() => { let active = true; api.quotaPlans().then(next => { if (active) { setConfig(next); setLoading(false) } }).catch(e => { if (active) { setError(e.message); setLoading(false) } }); return () => { active = false } }, [])
  const number = value => Number(value || 0).toLocaleString(locale)
  const changed = () => setRevision(value => value + 1)
  const labels = { plans: tx('套餐设置'), members: tx('成员额度'), defaults: tx('原有账号默认规则') }
  if (loading && !config) return <Loading />
  if (!config) return <div className="qm-feedback" role="alert"><p>{error}</p><button className="btn btn-ghost" onClick={load}>{tx('重试')}</button></div>
  return <section className="quota-management" aria-label={tx('额度管理')}>
    <header className="qm-header"><div><span className="qm-eyebrow">{tx('AI 使用额度')}</span><h2>{tx('让每位成员都有合适的额度')}</h2><p>{tx('套餐统一配置，个人灵活调整；总量与模型额度同时管控。')}</p></div>
      <button className="btn btn-ghost" disabled={loading} onClick={load}><Icon name="refresh" />{tx('刷新')}</button></header>
    {error && <div className="qm-feedback" role="alert">{error}</div>}
    <div className="qm-tabs" role="tablist" aria-label={tx('额度管理')}>
      {TABS.map(id => <button id={'qm-tab-' + id} key={id} role="tab" aria-selected={tab === id} aria-controls={'qm-panel-' + id} tabIndex={tab === id ? 0 : -1}
        onClick={() => setTab(id)} onKeyDown={event => {
          const index = TABS.indexOf(id)
          const next = event.key === 'ArrowRight' ? TABS[(index + 1) % TABS.length] : event.key === 'ArrowLeft' ? TABS[(index + TABS.length - 1) % TABS.length] : event.key === 'Home' ? TABS[0] : event.key === 'End' ? TABS.at(-1) : null
          if (next) { event.preventDefault(); setTab(next); document.getElementById('qm-tab-' + next)?.focus() }
        }}>{labels[id]}</button>)}
    </div>
    <div id={'qm-panel-' + tab} role="tabpanel" aria-labelledby={'qm-tab-' + tab}>
      {tab === 'plans' && <>
        <div className="qm-section-heading"><p>{tx('新用户自动领取试用；其他套餐由管理员分配。')}</p><button className="btn btn-primary" disabled={config.plans.length >= 50} onClick={() => setEditor({ type: 'plan', plan: null })}><Icon name="plus" />{tx('新建套餐')}</button></div>
        <div className="qm-plan-grid">{config.plans.map(plan => <article key={plan.id} className={'qm-plan-card ' + (plan.id === 'trial' ? 'qm-trial' : '')}>
          <div className="qm-plan-title"><h3>{plan.name}</h3><span className="qm-pill">{plan.id === 'trial' ? tx('新用户默认') : tx('月度套餐')}</span></div>
          <p className="qm-description">{plan.description || (plan.id === 'trial' ? tx('注册后自动领取一次') : tx('按成员分配，可随时调整'))}</p>
          <div className="qm-plan-amount"><strong>{plan.totalLimit === null ? tx('不限额') : number(plan.totalLimit)}</strong><span>{plan.totalLimit === null ? tx('总量不限') : 'Tokens'} · {plan.id === 'trial' ? tx('{0} 天有效', [plan.durationDays]) : tx('每自然月')}</span></div>
          <div className="qm-plan-models"><span>{plan.models.length ? tx('{0} 个模型额度', [plan.models.length]) : tx('所有模型共用总额度')}</span>
            {plan.models.slice(0, 3).map(row => <div key={row.provider + '/' + row.model}><span title={row.provider + ' / ' + row.model}>{row.model}</span><b>{number(row.limit)}</b></div>)}
            {plan.models.length > 3 && <small>{tx('另有 {0} 个模型', [plan.models.length - 3])}</small>}
            {plan.restrictModels && <small>{tx('仅限所列模型')}</small>}
          </div>
          <footer><span>{plan.id === 'trial' ? tx('一次性试用，不自动续期') : tx('调整不清空已用量')}</span><button className="btn btn-ghost" aria-label={tx('编辑套餐：{0}', [plan.name])} onClick={() => setEditor({ type: 'plan', plan })}>{tx('编辑')}</button></footer>
        </article>)}</div>
        <p className="qm-note"><Icon name="shield" />{tx('额度耗尽只暂停新的 AI 请求；账号登录、历史对话、插件目录仍可正常使用。')}</p>
      </>}
      {tab === 'members' && <QuotaMembers config={config} revision={revision + config.revision} />}
      {tab === 'defaults' && <article className="qm-default-card"><Icon name="settings" /><div><h3>{tx('原有账号默认额度')}</h3><p>{tx('仅适用于未分配套餐、未设个人额度的原有账号。新注册用户使用试用套餐。')}</p>
        <div className="qm-plan-amount"><strong>{config.defaultLimit === null ? tx('不限额') : number(config.defaultLimit)}</strong><span>Tokens · {tx('每自然月')}</span></div>
        <p className="qm-help">{tx('已有的个人设置继续生效，不会被默认规则覆盖。')}</p>
        <button className="btn btn-primary" onClick={() => setEditor({ type: 'defaults' })}>{tx('调整默认额度')}</button></div></article>}
    </div>
    {editor?.type === 'plan' && <PlanEditor plan={editor.plan} config={config} onConfig={setConfig} onClose={() => setEditor(null)} onSaved={changed} />}
    {editor?.type === 'defaults' && <DefaultEditor config={config} onConfig={setConfig} onClose={() => setEditor(null)} onSaved={changed} />}
  </section>
}
