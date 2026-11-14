/* Account allowance guidance lives beside the composer, outside the transcript. */
(function (global) {
  'use strict';
  const cards = new Set();
  let current = null, owner = '', revision = 0, refreshFlight = null;
  let denialPending = false;
  let selections = new WeakMap();
  let fallbackSelection = null;
  const composerCards = new WeakMap();
  const tx = value => global.SoduWorkI18n?.translateText?.(value) || value;
  const locale = () => global.SoduWorkI18n?.getLocale?.() || 'zh-CN';
  const localSelection = card => {
    const selected = (selections.get(card) || fallbackSelection)?.model;
    if (selected?.localOnly === true) return true;
    const value = typeof selected === 'string' ? selected : selected?.id || selected?.modelRef || selected?.name || '';
    return String(value).trim().startsWith('local:');
  };
  const scope = () => {
    const api = global.SoduWorkAPI;
    const user = api?.clientAuthSnapshot?.()?.user;
    const config = api?.hubConfig?.();
    return [config?.hub || '', user?.id || ''].join('|');
  };
  const copy = (card, quota) => global.SoduWorkQuota.copy({ ...quota,
    personalModelsAllowed: quota?.personalModelsAllowed === true && (selections.get(card) || fallbackSelection)?.adapterId === 'pi' }, tx, locale());
  const personalSelectionAllowed = (card, quota) => {
    const selected = selections.get(card) || fallbackSelection;
    return selected?.adapterId === 'pi' && selected.model?.quotaVersion === 2 &&
      selected.model.quotaScope === 'personal' && global.SoduWorkQuota.allowsPersonal?.(quota);
  };
  const setText = (node, value) => { if (node.textContent !== value) node.textContent = value; };

  function quotaFor(card) {
    if (!current) return null;
    if (current.exceeded && !/^(model_exhausted|model_not_allowed)$/.test(current.reason || '')) return current;
    const selected = (selections.get(card) || fallbackSelection)?.model;
    const model = typeof selected === 'string' ? selected : selected?.id || '';
    if (!model) return current;
    const provider = selected?.quotaProvider || '';
    const rows = (current.models || []).filter(row => row.model === model && (!provider || row.provider === provider));
    const quota = { ...current, exceeded: false, reason: '', model: null, requestedModel: null };
    // Each composer derives its own model limit; it never changes account truth.
    if (rows.length === 1 && rows[0].exceeded) return { ...quota, exceeded: true, reason: 'model_exhausted', model: rows[0] };
    if (!rows.length && current.restrictModels) return { ...quota, exceeded: true,
      reason: 'model_not_allowed', requestedModel: { provider, model } };
    return quota;
  }

  function render(card) {
    const quota = quotaFor(card);
    const unconfirmed = denialPending && card.dataset.feedback === 'failed';
    const show = (unconfirmed || quota?.exceeded === true && !personalSelectionAllowed(card, quota)) && !localSelection(card);
    card.hidden = !show;
    if (!show) return;
    const value = unconfirmed ? { title: tx('请刷新查看当前额度'),
      guidance: tx('暂时无法刷新，请稍后重试。'), used: '', timing: '' } : copy(card, quota);
    setText(card.querySelector('[data-quota-title]'), value.title);
    setText(card.querySelector('[data-quota-guidance]'), value.guidance);
    setText(card.querySelector('[data-quota-summary]'), tx('额度详情'));
    const detail = card.querySelector('[data-quota-detail]');
    const planName = unconfirmed ? '' : quota?.planId === 'trial' && quota?.planName === '试用'
      ? tx('试用') : quota?.planName || '';
    const rows = [planName, value.used, value.timing];
    for (const model of (unconfirmed ? [] : quota?.models || []).slice(0, 100)) {
      const remaining = model.remaining === null ? tx('不限额') :
        tx('剩余 {tokens} Tokens').replace('{tokens}', new Intl.NumberFormat(locale()).format(model.remaining || 0));
      rows.push([model.provider, model.model].filter(Boolean).join(' / ') + ' · ' + remaining);
      if (Number(model.unattributedUsed) > 0) rows.push(tx('其中 {tokens} Tokens 来自旧版用量，已计入当前模型额度')
        .replace('{tokens}', new Intl.NumberFormat(locale()).format(model.unattributedUsed)));
    }
    setText(detail, rows.filter(Boolean).join('\n'));
    const button = card.querySelector('[data-quota-refresh]');
    button.disabled = Boolean(refreshFlight);
    setText(button, refreshFlight ? tx('正在刷新') : tx('刷新额度'));
    setText(card.querySelector('[data-quota-feedback]'), card.dataset.feedback === 'failed'
      ? tx('暂时无法刷新，请稍后重试。') : '');
  }

  function paint() {
    for (const card of cards) {
      if (!card.isConnected) { cards.delete(card); continue; }
      render(card);
    }
  }

  function update(detail = {}) {
    const userId = global.SoduWorkAPI?.clientAuthSnapshot?.()?.user?.id;
    if (detail.user?.id && userId && detail.user.id !== userId) return;
    const nextOwner = scope();
    if (owner !== nextOwner) reset();
    if (detail.quota && typeof detail.quota === 'object') {
      if (detail.quota !== current) denialPending = false;
      current = detail.quota;
    }
    paint();
  }

  function show(value) {
    const found = global.SoduWorkQuota?.detail(value);
    if (!found) return false;
    if (owner !== scope()) reset();
    // Delayed failures are refresh hints, not newer account snapshots. A first
    // failure can explain the rejected turn until the authenticated read ends.
    if (!current) update({ quota: found.quota || { enabled: true, exceeded: true } });
    denialPending = true;
    void refresh(true);
    return true;
  }

  async function refresh(recheck = false) {
    if (owner !== scope()) reset();
    const api = global.SoduWorkAPI;
    if (typeof api?.clientAuthMe !== 'function' || !api.clientAuthSnapshot?.()?.user?.id) return;
    if (refreshFlight) {
      // A new hint must also reach the shared API coordinator while this card
      // awaits an older read. All callers then receive its final recheck result.
      if (recheck === true) void api.clientAuthMe().catch(() => {});
      return refreshFlight;
    }
    const requestScope = scope(), requestRevision = revision;
    const flight = Promise.resolve().then(() => api.clientAuthMe()).then(result => {
      if (requestScope !== scope() || requestRevision !== revision) return;
      if (!result?.quota) throw Error('Allowance response missing');
      for (const card of cards) delete card.dataset.feedback;
      global.ClientAuth?.updateIdentity?.(result.user, result.quota);
      update(result);
    }).catch(() => {
      if (requestScope !== scope() || requestRevision !== revision) return;
      for (const card of cards) card.dataset.feedback = 'failed';
    }).finally(() => { if (refreshFlight === flight) refreshFlight = null; paint(); });
    refreshFlight = flight;
    paint();
    return refreshFlight;
  }

  function mount(composer) {
    if (!composer?.parentElement) return null;
    if (owner !== scope()) reset();
    const previous = composer.previousElementSibling;
    if (previous?.classList.contains('soduwork-quota-card')) { composerCards.set(composer, previous); return previous; }
    const card = document.createElement('aside');
    card.className = 'soduwork-quota-card'; card.hidden = true;
    const element = (tag, attributes, children = []) => {
      const node = document.createElement(tag);
      for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
      node.append(...children);
      return node;
    };
    card.append(
      element('div', { class: 'quota-card-copy', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' }, [
        element('b', { 'data-quota-title': '' }), element('p', { 'data-quota-guidance': '' }),
      ]),
      element('div', { class: 'quota-card-actions' }, [
        element('details', {}, [element('summary', { 'data-quota-summary': '' }), element('p', { 'data-quota-detail': '' })]),
        element('button', { type: 'button', 'data-quota-refresh': '' }),
      ]),
      element('p', { class: 'quota-card-feedback', 'data-quota-feedback': '', role: 'status', 'aria-live': 'polite' }),
    );
    card.querySelector('[data-quota-refresh]').addEventListener('click', refresh);
    composer.before(card); cards.add(card); composerCards.set(composer, card); paint();
    return card;
  }

  function modelChanged(selection, adapterId = '', surface) {
    if (owner !== scope()) reset();
    const composer = composerCards.has(surface) ? surface : surface?.querySelector?.('.work-composer');
    const card = composer && composerCards.get(composer);
    if (card) selections.set(card, { model: selection || null, adapterId });
    else if (!selection) { selections = new WeakMap(); fallbackSelection = null; }
    else fallbackSelection = { model: selection, adapterId };
    paint();
  }
  function isBlocked() { return denialPending || current?.exceeded === true || [...cards].some(card => card.isConnected && quotaFor(card)?.exceeded); }
  function refreshIfBlocked() { if (isBlocked()) return refresh(); }
  function markRestored() {
    if (!isBlocked()) return false;
    // Compatibility entry point: only a successful Hub read confirms recovery.
    return refresh(true);
  }
  function reset() { current = null; denialPending = false; selections = new WeakMap(); fallbackSelection = null; refreshFlight = null; owner = scope(); revision++; paint(); }
  global.addEventListener('soduwork-data-scope-changed', reset);
  global.addEventListener('soduwork-domain-changed', event => {
    if (event?.detail?.domain === 'quota') void refresh(true);
  });
  global.addEventListener('soduwork-locale-change', paint);
  global.SoduWorkQuotaNotice = { mount, update, show, reset, refresh, refreshIfBlocked, isBlocked, markRestored, modelChanged };
})(window);
