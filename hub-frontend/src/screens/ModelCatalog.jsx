import { translateText as tx, localeMap, useLocale } from '../i18n.js'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api.js'
import { useViewportHeight } from '../viewport-height.js'
import { Loading, ErrorState, Icon, Modal, Confirm, toast, SelectMenu } from '../ui.jsx'
import LlmSettings from './LlmSettings.jsx'
import ModelRuntime from './ModelRuntime.jsx'
import './model-catalog-actions.css'
import { CAPABILITY_LABELS, CAPABILITY_STATES, CapabilityBadges, ModelCapabilityStatus } from './ModelCapabilities.jsx'
import './model-capabilities.css'








const MODEL_TYPES = localeMap(() => ([
  ['chat', '对话模型'],
  ['image', '图片生成'],
  ['video', '视频生成'],
]))
const MODEL_TYPE_LABEL = localeMap(() => Object.fromEntries(MODEL_TYPES))
const THINKING_FORMATS = localeMap(() => ([
  ['', '自动识别（按模型名）'],
  ['openai', 'OpenAI reasoning_effort'],
  ['deepseek', 'DeepSeek thinking'],
  ['qwen', 'Qwen enable_thinking'],
  ['qwen-chat-template', 'Qwen chat_template_kwargs'],
  ['chat-template', '自定义 chat_template_kwargs'],
  ['zai', 'Z.ai thinking'],
  ['openrouter', 'OpenRouter reasoning'],
  ['together', 'Together reasoning'],
  ['baseten', 'Baseten reasoning'],
  ['ant-ling', 'Ant Ling thinking'],
  ['string-thinking', '字符串 thinking'],
]))

const KINDS = localeMap(() => ([['openai-compat', 'OpenAI 兼容'], ['anthropic', 'Anthropic']]))

export default function ModelCatalog() {
  const viewportRef = useViewportHeight()
  const listRef = useRef(null)
  const bindList = useCallback(element => {
    listRef.current = element
    viewportRef(element)
  }, [viewportRef])
  const uiLocale = useLocale();
  const [d, setD] = useState(null)
  const [editP, setEditP] = useState(null)     // provider | 'new'
  const [addM, setAddM] = useState(null)       // {providerId, model?}
  const [del, setDel] = useState(null)         // {kind:'p'|'m', id, name}
  const [defaultOpen, setDefaultOpen] = useState(false)
  // Keep provider cards compact and expand model lists on demand.
  const [expandedProviders, setExpandedProviders] = useState(() => new Set())
  const [error, setError] = useState(null)
  const [newProviderId, setNewProviderId] = useState('')
  const pendingProviderFocus = useRef('')

  const load = () => {
    setError(null)
    api.modelCatalog().then(setD).catch(setError)
  }
  useEffect(() => { load() }, [])
  const models = d?.models || []
  const byP = (pid) => models.filter((m) => m.providerId === pid)
  // Keep the newly created service in view for this visit without changing the saved catalog order.
  const providers = (d?.providers || []).slice().sort((a, b) =>
    Number(b.id === newProviderId) - Number(a.id === newProviderId) ||
    (b.enabled - a.enabled) || (b.builtin - a.builtin) || a.name.localeCompare(b.name))
  useEffect(() => {
    if (!pendingProviderFocus.current || !d?.providers?.some(p => p.id === pendingProviderFocus.current)) return
    const card = listRef.current?.querySelector('.model-provider.is-new-provider')
    if (!card) return
    pendingProviderFocus.current = ''
    // A card can be taller than the list viewport; reveal its identifying header.
    const heading = card.querySelector('.model-provider-head') || card
    heading.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    card.focus({ preventScroll: true })
  }, [d, newProviderId, listRef])
  const enabledProviders = providers.filter((p) => p.enabled).length
  const enabledModels = models.filter((m) => m.enabled).length
  const readyProviders = providers.filter((p) => p.enabled && p.baseUrl && p.keySet).length

  async function toggleP(p) {
    try { await api.saveModelProvider(p.id, { enabled: !p.enabled, expectedRevision: p.revision }); load() }
    catch (e) { toast(e.message || tx("保存失败")); load() }
  }
  async function toggleM(m) {
    try { await api.saveModelDef({ providerId: m.providerId, name: m.name, enabled: !m.enabled, expectedRevision: m.revision }); load() }
    catch (e) { toast(e.message || tx("保存失败")); load() }
  }

  return (
    <>
      <ModelRuntime providers={providers} models={models} catalogSummary={
        <section className="model-catalog-summary model-runtime-dimension" aria-label={tx("目录配置")} aria-busy={!d && !error}>
          <header className="model-dimension-head"><Icon name="box" /><h4>{tx("目录配置")}</h4></header>
          <div className="model-catalog-summary-card"><span>{tx("服务总数")}</span><strong>{d ? providers.length : '—'}</strong><small>{d ? tx("已启用 {0} · 已停用 {1}", [enabledProviders, providers.length - enabledProviders]) : error ? tx("目录读取失败") : tx("正在读取目录")}</small></div>
          <div className="model-catalog-summary-card"><span>{tx("模型总数")}</span><strong>{d ? models.length : '—'}</strong><small>{d ? tx("已启用 {0} · 已停用 {1}", [enabledModels, models.length - enabledModels]) : error ? tx("目录读取失败") : tx("正在读取目录")}</small></div>
          <div className="model-catalog-summary-card"><span>{tx("配置完整服务")}</span><strong>{d ? readyProviders : '—'}</strong><small>{tx("服务已启用，且地址与密钥均已填写。")}</small></div>
          <p className="model-dimension-note">{error ? tx("目录读取失败") : tx("配置完整仅表示设置已齐全。")}</p>
        </section>
      } catalogActions={<>
        <button className="btn btn-ghost" onClick={() => setDefaultOpen(true)}><Icon name="key" />{tx("组织默认调用")}</button>
        <button className="btn btn-primary" disabled={!d} onClick={() => setEditP('new')}><Icon name="plus" />{tx("接一个服务")}</button>
      </>} />
      {error && <ErrorState msg={error.message} onRetry={load} />}
      {!d && !error && <Loading />}
      <div ref={bindList} className="model-provider-grid" tabIndex={0} role="region" aria-label={tx("服务与模型列表，可滚动")}>
        {providers.map((p) => {
          const ms = byP(p.id)
          const modelsOpen = expandedProviders.has(p.id)
          const modelListId = `model-list-${String(p.id).replace(/[^a-zA-Z0-9_-]/g, '-')}`
          const ready = p.enabled && p.baseUrl && p.keySet
          const state = ready ? tx("已配置") : (!p.enabled ? tx("已停用") : (!p.baseUrl ? tx("缺地址") : tx("缺密钥")))
          return (
            <article key={p.id} tabIndex={p.id === newProviderId ? -1 : undefined}
              className={'model-provider' + (p.enabled ? '' : ' disabled') + (modelsOpen ? ' is-models-expanded' : '') + (p.id === newProviderId ? ' is-new-provider' : '')}>
              <header className="model-provider-head">
                <span className={'model-provider-glyph' + (ready ? ' ready' : '')}>{(p.name || p.id || '?').slice(0, 1)}</span>
                <div className="model-provider-title">
                  <div><h3>{p.name || p.id}</h3>{p.builtin && <span className="sysbadge">{tx("内置")}</span>}</div>
                  <code>{p.id}</code>
                </div>
                <span className={'model-state ' + (ready ? 'ready' : (!p.enabled ? 'off' : 'warn'))}><i />{state}</span>
              </header>

              <div className="model-provider-facts">
                <div><span>{tx("服务地址")}</span><code title={p.baseUrl || ''}>{p.baseUrl || tx("还没填写接口地址")}</code></div>
                <div><span>{tx("组织密钥")}</span><b>{p.keySet ? tx("已配置 · {0} 位", [p.keyLen]) : tx("尚未配置")}</b></div>
              </div>
              {p.note && <p className="model-provider-note">{p.note}</p>}

              <div className={'model-cloud' + (modelsOpen ? ' is-expanded' : ' is-collapsed')}>
                <div className="model-cloud-label">
                  <span>{tx("已启用模型")}</span><b>{ms.filter((m) => m.enabled).length}/{ms.length}</b>
                </div>
                <div id={modelListId} className="model-chips" hidden={!modelsOpen} tabIndex={0} role="region"
                  aria-label={tx("{0}的模型列表", [p.name || p.id])}>
                  {ms.map((m) => (
                    <div key={m.id} className={'model-chip' + (m.enabled ? '' : ' off')}>
                      <div className="model-chip-identity">
                        <div className="model-chip-heading"><i className={'model-kind kind-' + (m.modality || 'chat')}>
                          {MODEL_TYPE_LABEL[m.modality || 'chat']}
                        </i>
                        <code title={m.name}>{m.label || m.name}</code></div>
                        {m.label && m.label !== m.name && <span className="model-chip-id">{m.name}</span>}
                        {(m.modality || 'chat') === 'chat' && <CapabilityBadges model={m} />}
                      </div>
                      <div className="model-chip-actions" role="group" aria-label={tx("{0} 操作", [m.label || m.name])}>
                        <button type="button" className="admin-card-action" aria-label={tx("配置模型 {0}", [m.label || m.name])} onClick={() => setAddM({ providerId: p.id, model: m })}>{tx("配置")}</button>
                        <button type="button" className="admin-card-action" aria-label={tx("{0}模型 {1}", [m.enabled ? tx("停用") : tx("启用"), m.label || m.name])} title={m.enabled ? tx("停用后将不再供成员选择") : tx("启用模型")} onClick={() => toggleM(m)}>{m.enabled ? tx("停用") : tx("启用")}</button>
                        {!m.builtin && <span className="model-chip-danger"><button type="button" className="admin-card-action is-danger" aria-label={tx("删除模型 {0}", [m.label || m.name])} onClick={() => setDel({ kind: 'm', id: m.id, name: m.label || m.name, revision: m.revision })}>{tx("删除")}</button></span>}
                      </div>
                      {(m.modality || 'chat') === 'chat' && <ModelCapabilityStatus key={p.revision + ':' + m.revision}
                        model={m} disabled={!p.enabled || !m.enabled || !p.baseUrl || !p.keySet}
                        onChecked={(result) => setD(current => ({ ...current, models: current.models.map(item => item.id === m.id
                          ? { ...item, capabilityProfile: result.capabilityProfile, capabilityCheck: result } : item) }))} />}
                    </div>
                    ))}
                </div>
                {!modelsOpen && ms.length > 0 && <p className="model-cloud-collapsed-note">{tx("模型列表已收起，点击展开查看配置")}</p>}
                {ms.length === 0 && <span className="model-empty">{tx("这个服务还没有模型")}</span>}
              </div>

              <footer className="model-provider-actions admin-card-actions">
                <div className="model-card-action-group">
                  <button type="button" className="admin-card-action is-primary" onClick={() => setAddM({ providerId: p.id })}><Icon name="plus" />{tx("加模型")}</button>
                  <button type="button" className="admin-card-action" onClick={() => setEditP(p)}><Icon name="settings" />{tx("配置服务")}</button>
                  <button type="button" className="admin-card-action" onClick={() => toggleP(p)}>{p.enabled ? tx("停用服务") : tx("启用服务")}</button>
                </div>
                <div className="model-card-footer-controls">
                  {ms.length > 0 && <button type="button" className="model-cloud-toggle"
                    aria-expanded={modelsOpen} aria-controls={modelListId}
                    onClick={() => setExpandedProviders(current => {
                      const next = new Set(current)
                      if (next.has(p.id)) next.delete(p.id); else next.add(p.id)
                      return next
                    })}>
                    {modelsOpen ? tx("收起") : tx("展开")}<Icon name="chevron" aria-hidden="true" />
                  </button>}
                  {!p.builtin && <div className="model-card-danger-group"><button type="button" className="admin-card-action is-danger" onClick={() => setDel({ kind: 'p', id: p.id, name: p.name, revision: p.revision })}><Icon name="trash" />{tx("删除服务")}</button></div>}
                </div>
              </footer>
            </article>
          )
        })}
      </div>

      {defaultOpen && <Modal title={tx("组织默认调用")} icon="key" wide onClose={() => setDefaultOpen(false)}><LlmSettings embedded /></Modal>}
      {editP && <ProviderForm initial={editP === 'new' ? null : editP}
        onClose={() => setEditP(null)} onSaved={(providerId) => {
          if (editP === 'new') { setNewProviderId(providerId); pendingProviderFocus.current = providerId }
          setEditP(null); load()
        }} />}
      {addM && <ModelForm providerId={addM.providerId} initial={addM.model || null}
        onClose={() => setAddM(null)} onSaved={() => { setAddM(null); load() }} />}
      {del && <Confirm title={del.kind === 'p' ? tx("删除模型服务") : tx("删除模型")} danger confirmText={tx("删除")}
        text={del.kind === 'p'
          ? tx("确定删除「{0}」？它底下的模型会一起删掉，正在用这些模型的人会挑不到。", [del.name])
          : tx("确定删除「{0}」？正在用它的人会挑不到。", [del.name])}
        onClose={() => setDel(null)}
        onConfirm={async () => {
          try {
            if (del.kind === 'p') await api.deleteModelProvider(del.id, del.revision)
            else await api.deleteModelDef(del.id, del.revision)
            toast(tx("已删除"))
          } catch (e) { toast(tx("删不掉：") + (e.message || e)) }
          setDel(null); load()
        }} />}
    </>
  )
}

function ProviderForm({ initial, onClose, onSaved }) {
  const uiLocale = useLocale();
  const editing = !!initial
  const [id, setId] = useState(initial ? initial.id : '')
  const [name, setName] = useState(initial ? initial.name : '')
  const [kind, setKind] = useState(initial ? initial.kind : 'openai-compat')
  const [baseUrl, setBaseUrl] = useState(initial ? initial.baseUrl : '')
  const [note, setNote] = useState(initial ? initial.note : '')
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)

  async function save() {
    const pid = (editing ? initial.id : id).trim()
    if (!pid) { toast(tx("给这个服务起一个英文标识（如 my-gateway）")); return }
    if (!name.trim()) { toast(tx("填一个给人看的名字")); return }
    if (baseUrl && !/^https?:\/\//.test(baseUrl.trim())) { toast(tx("接口地址要以 http(s):// 开头")); return }
    setBusy(true)
    try {
      await api.saveModelProvider(pid, {
        expectedRevision: initial?.revision || 'new',
        name: name.trim(), kind, baseUrl: baseUrl.trim(), note: note.trim(),
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      })
      toast(apiKey.trim() ? tx("已保存，密钥已更新") : tx("已保存（密钥未改动）"))
      onSaved(pid)
    } catch (e) { toast(tx("保存失败：") + (e.message || e)) }
    setBusy(false)
  }

  return (
    <Modal title={editing ? tx("配置「{0}」", [initial.name]) : tx("接一个模型服务")} icon="plug" onClose={onClose}
      foot={<><button className="btn btn-ghost" onClick={onClose}>{tx("取消")}</button>
        <button className="btn btn-primary" disabled={busy} onClick={save}>{busy ? tx("保存中…") : tx("保存")}</button></>}>
      {!editing && (
        <div><label className="f-lbl">{tx("标识（英文，建好不改）")}</label>
          <input className="f-in" value={id} onChange={(e) => setId(e.target.value)}
            placeholder={tx("如 my-gateway")} autoFocus /></div>
      )}
      <div style={{ marginTop: editing ? 0 : 12 }}><label className="f-lbl">{tx("名字")}</label>
        <input className="f-in" value={name} onChange={(e) => setName(e.target.value)}
          placeholder={tx("给人看的名字，如「研发网关」")} autoFocus={editing} /></div>
      <div style={{ marginTop: 12 }}><label className="f-lbl">{tx("接口协议")}</label>
        <SelectMenu className="f-in" value={kind} disabled={editing && initial.builtin}
          onChange={(e) => setKind(e.target.value)}>
          {KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </SelectMenu>
        <div className="muted" style={{ fontSize: 14.5, marginTop: 6, lineHeight: 1.7 }}>{tx("绝大多数都选「OpenAI 兼容」：自建网关、vLLM、Ollama、各家中转、以及国内几家的兼容端点都走这一档。")}</div></div>
      <div style={{ marginTop: 12 }}><label className="f-lbl">{tx("接口地址（含 /v1）")}</label>
        <input className="f-in" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="https://gateway.example.com/v1" /></div>
      <div style={{ marginTop: 12 }}>
        <label className="f-lbl">API Key（{initial && initial.keySet ? tx("已配置 · {0} 位，留空则不改", [initial.keyLen]) : tx("未配置")}）</label>
        <input className="f-in" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)}
          placeholder={initial && initial.keySet ? tx("输入新密钥以轮换，留空保持现有") : tx("粘贴 API Key")}
          autoComplete="new-password" />
        <div className="muted" style={{ fontSize: 14.5, marginTop: 6, lineHeight: 1.7 }}>
          {/* Use JSX elements for emphasis; Markdown markers would render literally. */}{tx("此密钥由组织共用。员工可在自己的客户端配置个人密钥；已配置时使用个人额度，否则使用组织额度。密钥只保存在后台数据库，任何接口都不会返回明文。")}</div></div>
      <div style={{ marginTop: 12 }}><label className="f-lbl">{tx("说明（可选）")}</label>
        <input className="f-in" value={note} onChange={(e) => setNote(e.target.value)} placeholder={tx("一句话")} /></div>
    </Modal>
  )
}

function ModelForm({ providerId, initial, onClose, onSaved }) {
  const uiLocale = useLocale();
  const editing = !!initial
  const [name, setName] = useState(initial ? initial.name : '')
  const [label, setLabel] = useState(initial?.label || '')
  const [modality, setModality] = useState(initial ? (initial.modality || 'chat') : 'chat')
  const [endpointPath, setEndpointPath] = useState(
    initial?.config?.endpointPath || ''
  )
  const [statusPath, setStatusPath] = useState(
    initial?.config?.statusPath || ''
  )
  const [resultPath, setResultPath] = useState(
    initial?.config?.resultPath || ''
  )
  const [defaultsText, setDefaultsText] = useState(
    JSON.stringify(initial?.config?.defaults || {}, null, 2)
  )
  const [thinkingMode, setThinkingMode] = useState(initial?.config?.thinkingMode || (
    initial?.config?.thinkingAlwaysOn ? 'always' : 'auto'
  ))
  const [thinkingFormat, setThinkingFormat] = useState(initial?.config?.thinkingFormat || '')
  const [imageRouting, setImageRouting] = useState(initial?.config?.imageRouting || 'auto')
  const [capabilities, setCapabilities] = useState(initial?.config?.capabilities || {})
  const [ctxWindow, setCtxWindow] = useState(initial?.contextWindowKnown === false ? '' : initial?.ctxWindow || '')
  const [maxOutputTokens, setMaxOutputTokens] = useState(initial?.config?.maxOutputTokens || '')
  const [supportsReasoningEffort, setSupportsReasoningEffort] = useState(
    initial?.config?.supportsReasoningEffort !== false
  )
  const [busy, setBusy] = useState(false)

  function changeModality(next) {
    setModality(next)
    if (!endpointPath && next === 'image') setEndpointPath('/images/generations')
    if (!endpointPath && next === 'video') {
      setEndpointPath(providerId === 'volcengine'
        ? '/contents/generations/tasks' : '/videos/generations')
    }
    if (next === 'video' && providerId === 'volcengine' && !statusPath) {
      setStatusPath('/contents/generations/tasks/{id}')
    }
    if (next === 'chat') {
      setEndpointPath('')
      setStatusPath('')
      setResultPath('')
    }
  }

  async function save() {
    if (!name.trim()) { toast(tx("填模型标识（发给网关的那个名字）")); return }
    const retainedConfig = { ...initial?.config }
    const originalThinking = initial?.config?.thinkingMode || (initial?.config?.thinkingAlwaysOn ? 'always' : 'auto')
    if (thinkingMode !== originalThinking) for (const key of ['reasoning', 'thinkingAlwaysOn', 'thinkingLevelMap']) delete retainedConfig[key]
    for (const key of ['thinkingMode', 'thinkingFormat', 'supportsReasoningEffort', 'thinkingAlwaysOn']) delete retainedConfig[key]
    if (modality === 'chat') {
      if (imageRouting === 'native' && capabilities.imageInput === 'unsupported') {
        toast(tx('原生识图与不支持图片输入的配置冲突')); return
      }
      for (const [value, max] of [[ctxWindow, 10000000], [maxOutputTokens, 262144]]) {
        if (value !== '' && (!Number.isInteger(Number(value)) || Number(value) < 1024 || Number(value) > max)) {
          toast(tx('Token 上限必须填写允许范围内的整数')); return
        }
      }
      if (ctxWindow && Number(maxOutputTokens) > Number(ctxWindow)) { toast(tx('最大输出不能超过上下文窗口')); return }
    }
    delete retainedConfig.maxOutputTokens
    let defaults = {}
    if (modality !== 'chat') {
      try {
        defaults = JSON.parse(defaultsText || '{}')
        if (!defaults || Array.isArray(defaults) || typeof defaults !== 'object') throw new Error()
      } catch {
        toast(tx("默认参数要填写合法的 JSON 对象"))
        return
      }
      if (!endpointPath.trim().startsWith('/')) {
        toast(tx("生成接口路径要以 / 开头"))
        return
      }
      if (modality === 'video' && statusPath.trim() &&
          (!statusPath.trim().startsWith('/') || !statusPath.includes('{id}'))) {
        toast(tx("任务查询路径要以 / 开头，并包含 {id}"))
        return
      }
      if (modality === 'video' && resultPath.trim() &&
          (!resultPath.trim().startsWith('/') || !resultPath.includes('{id}'))) {
        toast(tx("结果下载路径要以 / 开头，并包含 {id}"))
        return
      }
    }
    setBusy(true)
    try {
      await api.saveModelDef({
        expectedRevision: initial?.revision || 'new',
        providerId,
        name: name.trim(),
        label: label.trim() || name.trim(),
        modality,
        ...(modality === 'chat' ? { ctxWindow: Number(ctxWindow) || 0 } : {}),
        config: modality === 'chat' ? {
          ...retainedConfig, imageRouting,
          capabilities: Object.fromEntries(Object.keys(CAPABILITY_LABELS).map(key => [key, capabilities[key] || 'unknown'])),
          ...(maxOutputTokens ? { maxOutputTokens: Number(maxOutputTokens) } : {}),
          ...(thinkingMode !== 'auto' ? { thinkingMode } : {}),
          ...(thinkingFormat ? { thinkingFormat } : {}),
          ...(thinkingMode === 'controllable' ? { supportsReasoningEffort } : {}),
        } : {
          endpointPath: endpointPath.trim(),
          ...(modality === 'video' && statusPath.trim()
            ? { statusPath: statusPath.trim() } : {}),
          ...(modality === 'video' && resultPath.trim()
            ? { resultPath: resultPath.trim() } : {}),
          defaults,
        },
        enabled: initial ? initial.enabled : true,
      })
      toast(editing ? tx("模型配置已更新") : tx("已加上"))
      onSaved()
    } catch (e) { toast(tx("保存失败：") + (e.message || e)) }
    setBusy(false)
  }

  return (
    <Modal title={editing ? tx("配置模型") : tx("加一个模型")} icon={editing ? 'pencil' : 'plus'}
      wide onClose={onClose}
      foot={<><button className="btn btn-ghost" onClick={onClose}>{tx("取消")}</button>
        <button className="btn btn-primary" disabled={busy} onClick={save}>{busy ? tx("保存中…") : tx("保存")}</button></>}>
      <div className="model-config-form"><div><label className="f-lbl">{tx("模型标识（发给网关的那个名字）")}</label>
        <input className="f-in" value={name} disabled={editing}
          onChange={(e) => setName(e.target.value)}
          placeholder={tx("如 deepseek-chat / gpt-image-1")} autoFocus={!editing} /></div>
      <div style={{ marginTop: 12 }}><label className="f-lbl">{tx("显示名（可选）")}</label>
        <input className="f-in" value={label} onChange={(e) => setLabel(e.target.value)}
          placeholder={tx("给人看的名字，留空就用模型标识")} autoFocus={editing} /></div>
      <div style={{ marginTop: 12 }}><label className="f-lbl">{tx("模型用途")}</label>
        <SelectMenu className="f-in" value={modality} onChange={(e) => changeModality(e.target.value)}>
          {MODEL_TYPES.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
        </SelectMenu>
        <div className="muted" style={{ fontSize: 14.5, marginTop: 6, lineHeight: 1.7 }}>{tx("对话模型可单独支持图片输入；图片生成和视频生成用于创作成果。")}</div></div>
      {modality === 'chat' && <>
        <section className="model-config-section"><h3>{tx('模型能力')}</h3>
          <p className="model-config-hint">{tx('按服务实际支持的能力设置，未知项可检测确认。')}</p>
          <div className="model-cap-grid">{Object.entries(CAPABILITY_LABELS).map(([key, title]) => <div key={key}>
            <label className="f-lbl" htmlFor={'model-cap-' + key}>{tx(title)}</label>
            <SelectMenu id={'model-cap-' + key} className="f-in" value={capabilities[key] || 'unknown'}
              onChange={event => setCapabilities(current => ({ ...current, [key]: event.target.value }))}>
              {Object.entries(CAPABILITY_STATES).map(([value, title]) => <option key={value} value={value}>{tx(title)}</option>)}
            </SelectMenu></div>)}</div>
        </section>
        <details className="model-config-advanced"><summary>{tx('高级设置')}</summary>
          <div className="model-cap-grid">
            <div><label className="f-lbl" htmlFor="model-image-routing">{tx('图片处理方式')}</label>
              <SelectMenu id="model-image-routing" className="f-in" value={imageRouting} onChange={event => setImageRouting(event.target.value)}>
                <option value="auto">{tx('自动选择')}</option><option value="native">{tx('模型原生识图')}</option>
                <option value="vision-fallback">{tx('独立视觉服务')}</option>
              </SelectMenu></div>
            <div><label className="f-lbl" htmlFor="model-context-window">{tx('上下文窗口')}</label>
              <input id="model-context-window" className="f-in" type="number" min="1024" max="10000000" step="1"
                placeholder={tx('自动')} value={ctxWindow} onChange={event => setCtxWindow(event.target.value)} /></div>
            <div><label className="f-lbl" htmlFor="model-max-output">{tx('最大输出 Token')}</label>
              <input id="model-max-output" className="f-in" type="number" min="1024" max="262144" step="1"
                placeholder="16384" value={maxOutputTokens} onChange={event => setMaxOutputTokens(event.target.value)} /></div>
          </div><p className="model-config-hint">{tx('自动选择优先使用已确认的原生视觉能力；兼容识图需要配置独立视觉服务。')}</p>
      {modality === 'chat' && <div className="model-thinking-config" style={{ marginTop: 14 }}>
        <div className="f-lbl">{tx("思考能力")}</div>
        <div className="muted" style={{ fontSize: 14.5, lineHeight: 1.7 }}>{tx("对于不支持关闭思考的模型请选择“始终开启”。客户端会显示固定思考状态，不再提供无效的关闭开关。")}</div>
        <div className="model-thinking-grid" style={{ marginTop: 8 }}>
          {[['auto', tx("自动识别")], ['always', tx("始终开启")], ['controllable', tx("可控制")], ['none', tx("不使用思考")]].map(([value, text]) =>
            <label className="f-check" key={value}><input type="radio" name="thinking-mode" value={value}
              checked={thinkingMode === value} onChange={() => setThinkingMode(value)} />{text}</label>)}
        </div>
        {thinkingMode === 'controllable' && <label className="f-check" style={{ marginTop: 8 }}><input type="checkbox"
          checked={supportsReasoningEffort} onChange={(e) => setSupportsReasoningEffort(e.target.checked)} />{tx("支持 reasoning_effort / 思考强度参数")}</label>}
        <label className="f-lbl" style={{ marginTop: 10 }}>{tx("思考协议格式")}</label>
        <SelectMenu className="f-in" value={thinkingFormat} onChange={(e) => setThinkingFormat(e.target.value)}>
          {THINKING_FORMATS.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
        </SelectMenu>
      </div>}
        </details></>}
      {modality !== 'chat' && <>
        <div style={{ marginTop: 12 }}><label className="f-lbl">{tx("生成接口路径")}</label>
          <input className="f-in" value={endpointPath}
            onChange={(e) => setEndpointPath(e.target.value)}
            placeholder={modality === 'image' ? '/images/generations' : '/videos/generations'} />
          <div className="muted" style={{ fontSize: 14.5, marginTop: 6, lineHeight: 1.7 }}>{tx("填服务地址下的相对路径，平台会沿用该服务的地址和密钥。")}</div></div>
        {modality === 'video' && <>
          <div style={{ marginTop: 12 }}><label className="f-lbl">{tx("异步任务查询路径（可选）")}</label>
            <input className="f-in" value={statusPath}
              onChange={(e) => setStatusPath(e.target.value)}
              placeholder="/contents/generations/tasks/{id}" />
            <div className="muted" style={{ fontSize: 14.5, marginTop: 6, lineHeight: 1.7 }}>{tx("Seedance 使用此路径查询生成进度；")}{'{id}'}{tx(" 会替换为创建接口返回的任务 ID。")}</div></div>
          <div style={{ marginTop: 12 }}><label className="f-lbl">{tx("结果下载路径（可选）")}</label>
            <input className="f-in" value={resultPath}
              onChange={(e) => setResultPath(e.target.value)}
              placeholder="/videos/{id}/content" />
            <div className="muted" style={{ fontSize: 14.5, marginTop: 6, lineHeight: 1.7 }}>{tx("状态接口直接返回视频地址时留空；需要单独下载内容的服务再填写。")}</div></div>
        </>}        <div style={{ marginTop: 12 }}><label className="f-lbl">{tx("默认生成参数（JSON）")}</label>
          <textarea className="f-in model-json-config" rows={7} value={defaultsText}
            onChange={(e) => setDefaultsText(e.target.value)}
            placeholder={'{\n  "size": "1024x1024"\n}'} />
          <div className="muted" style={{ fontSize: 14.5, marginTop: 6, lineHeight: 1.7 }}>{tx("可配置尺寸、时长、清晰度、比例等服务参数；每次调用仍可覆盖这些默认值。")}</div></div>
      </>}
      <div className="muted" style={{ fontSize: 14.5, marginTop: 10, lineHeight: 1.7 }}>{tx("密钥配置在模型服务上，这个服务底下的所有模型共用。")}</div></div>
    </Modal>
  )
}
