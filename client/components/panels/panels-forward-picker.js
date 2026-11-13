/* Candidate presentation only; dispatch and availability checks stay in forward-options. */

function _fwdNormalizeMates(raw) {
  const rows = Array.isArray(raw) ? raw : [];
  const byId = new Map();
  rows.forEach(item => {
    if (!item || typeof item !== 'object') return;
    const id = _fwdId(item.id || item.userId || item.uid);
    if (!id) return;
    const name = _fwdId(item.name || item.displayName || item.username) || '未命名同事';
    const org = _fwdId(item.org || item.orgName || item.department) || '未分组';
    const hasBox = Object.prototype.hasOwnProperty.call(item, 'canReceive')
      ? _fwdBool(item.canReceive)
      : Object.prototype.hasOwnProperty.call(item, 'hasBox')
        ? _fwdBool(item.hasBox)
        : _fwdBool(item.available) || _fwdBool(item.soduWorkEnabled);
    const deviceCount = Array.isArray(item.devices)
      ? item.devices.length
      : Math.max(0, Number(item.deviceCount || item.devices || 0) || 0);
    const key = id.toLocaleLowerCase();
    const previous = byId.get(key);
    if (previous) {
      previous.hasBox = previous.hasBox || hasBox;
      previous.deviceCount = Math.max(previous.deviceCount, deviceCount);
      if (previous.name === '未命名同事' && name !== '未命名同事') previous.name = name;
      if (previous.org === '未分组' && org !== '未分组') previous.org = org;
    } else {
      byId.set(key, { id, name, org, hasBox, deviceCount });
    }
  });
  return Array.from(byId.values()).sort((a, b) =>
    Number(b.hasBox) - Number(a.hasBox) ||
    a.org.localeCompare(b.org, 'zh-CN') ||
    a.name.localeCompare(b.name, 'zh-CN') ||
    a.id.localeCompare(b.id));
}

function _fwdMateVisible() {
  const query = _fwdMateQuery.toLocaleLowerCase();
  return _fwdMateRows.filter(row => {
    if (_fwdMateFilter === 'ready' && !row.hasBox) return false;
    if (!query) return true;
    return [row.name, row.org, row.id].some(value =>
      String(value || '').toLocaleLowerCase().includes(query));
  });
}

function _fwdMateOption(row) {
  return _fwdRow({
    id: row.id, type: 'mate', name: row.name, ico: 'user', tag: row.org,
    sub: row.hasBox
      ? (row.deviceCount > 1 ? row.deviceCount + ' 台设备可接收需求' : '可接收需求')
      : '尚未启用 SoduWork，暂时无法转交',
    meta: row.hasBox ? '可接收' : '不可用',
    off: !row.hasBox, disabled: !row.hasBox,
  });
}

function _fwdMateRowsHtml() {
  const rows = _fwdMateVisible();
  if (!rows.length) {
    const title = _fwdMateQuery ? '没有匹配的同事' :
      (_fwdMateFilter === 'ready' ? '暂无可接收需求的同事' : '暂无可显示的同事');
    const detail = _fwdMateReason || (_fwdMateQuery
      ? '试试姓名、部门或清空筛选。'
      : '同事需要先登录并启用 SoduWork，才可以接收需求。');
    return '<div class="fwd-mate-empty"><b>' + title + '</b><span>' + esc(detail) + '</span>' +
      (_fwdMateQuery ? '<button type="button" data-fwd-mate-clear>清空搜索</button>' : '') +
      '</div>';
  }
  const groups = new Map();
  rows.forEach(row => {
    if (!groups.has(row.org)) groups.set(row.org, []);
    groups.get(row.org).push(row);
  });
  return Array.from(groups.entries()).map(([org, members]) =>
    '<section class="fwd-mate-group"><div class="fwd-mate-group-head"><span>' +
      esc(org) + '</span><small>' + members.length + ' 人</small></div>' +
      members.map(_fwdMateOption).join('') + '</section>').join('');
}

function _fwdBindMateChoices(box, tid) {
  if (!box) return;
  box.querySelectorAll('[data-fwd-choice="mate"]:not([disabled])').forEach(button =>
    button.addEventListener('click', () => _fwdChoose(tid, {
      type: 'mate', id: _fwdId(button.getAttribute('data-aid')),
      name: button.getAttribute('data-aname') || '同事', available: true,
    })));
}

function _fwdRenderMateRows(box, tid) {
  const rowsBox = box && box.querySelector('#fwdMateRows');
  if (!rowsBox) return;
  rowsBox.innerHTML = _fwdMateRowsHtml();
  const count = box.querySelector('#fwdMateCount');
  if (count) count.textContent = '显示 ' + _fwdMateVisible().length + ' / ' + _fwdMateRows.length + ' 位同事';
  const clear = rowsBox.querySelector('[data-fwd-mate-clear]');
  if (clear) clear.addEventListener('click', () => {
    _fwdMateQuery = '';
    const search = box.querySelector('#fwdMateSearch');
    if (search) search.value = '';
    _fwdRenderMateRows(box, tid);
  });
  _fwdBindMateChoices(box, tid);
  _fwdPaintSelection(box);
  _fwdSyncConfirm(tid);
}

function _fwdRenderMatePanel(box, tid) {
  const ready = _fwdMateRows.filter(row => row.hasBox).length;
  const total = _fwdMateRows.length;
  if (!ready && total) _fwdMateFilter = 'all';
  box.innerHTML = '<section class="fwd-mates fwd-direct">' +
    '<div class="fwp-title"><span><b>转给同事</b>' +
      '<i>需求、附件和已有进展会一起转交，对方成为承办人</i></span>' +
      '<em>' + ready + ' 位可接收</em></div>' +
    '<div class="fwd-mate-toolbar">' +
      '<label class="fwd-mate-search"><span aria-hidden="true">⌕</span>' +
        '<input id="fwdMateSearch" type="search" maxlength="80" autocomplete="off" ' +
          'aria-label="搜索姓名或部门" placeholder="搜索姓名或部门" value="' + esc(_fwdMateQuery) + '"></label>' +
      '<div class="fwd-mate-filters" role="tablist" aria-label="同事筛选">' +
        '<button type="button" class="fwd-mate-filter' + (_fwdMateFilter === 'ready' ? ' on' : '') +
          '" data-fwd-mate-filter="ready" role="tab" aria-selected="' +
          (_fwdMateFilter === 'ready' ? 'true' : 'false') + '">可接收 <b>' + ready + '</b></button>' +
        '<button type="button" class="fwd-mate-filter' + (_fwdMateFilter === 'all' ? ' on' : '') +
          '" data-fwd-mate-filter="all" role="tab" aria-selected="' +
          (_fwdMateFilter === 'all' ? 'true' : 'false') + '">全部 <b>' + total + '</b></button>' +
      '</div>' +
    '</div>' +
    '<div class="fwd-mate-summary">未启用 SoduWork 的同事暂不可接收需求。</div>' +
    '<div class="fwd-result-count" id="fwdMateCount" role="status"></div>' +
    '<div id="fwdMateRows" class="fwd-mate-list">' + _fwdMateRowsHtml() + '</div></section>';
  const search = box.querySelector('#fwdMateSearch');
  if (search) search.addEventListener('input', () => {
    _fwdMateQuery = search.value || '';
    _fwdRenderMateRows(box, tid);
  });
  box.querySelectorAll('[data-fwd-mate-filter]').forEach(button =>
    button.addEventListener('click', () => {
      _fwdMateFilter = button.getAttribute('data-fwd-mate-filter') === 'all' ? 'all' : 'ready';
      box.querySelectorAll('[data-fwd-mate-filter]').forEach(item => {
        const active = item.getAttribute('data-fwd-mate-filter') === _fwdMateFilter;
        item.classList.toggle('on', active);
        item.setAttribute('aria-selected', active ? 'true' : 'false');
      });
      _fwdRenderMateRows(box, tid);
    }));
  _fwdRenderMateRows(box, tid);
}

function _fwdRow(option) {
  const state = option.off ? '<span class="fwd-state is-off">不可用</span>' :
    option.busy ? '<span class="fwd-state is-busy">忙碌</span>' : '';
  return '<button type="button" class="fwd-item' + (option.disabled ? ' is-disabled' : '') + '"' +
    (option.disabled ? ' disabled' : '') + ' data-fwd-choice="' + esc(option.type) +
    '" data-aid="' + esc(option.id) + '" data-aname="' + esc(option.name) +
    '" data-acli="' + esc(option.cli || '') + '">' +
    '<span class="fwd-radio"><i></i></span><span class="fwd-ava">' + _svg(option.ico) + '</span>' +
    '<span class="fwd-main"><span class="fwd-nm">' + esc(option.name) +
      (option.tag ? '<em class="fwd-tag ' + (option.tagCls || '') + '">' + esc(option.tag) + '</em>' : '') +
      (option.isDef ? '<em class="fwd-def">推荐</em>' : '') + state + '</span>' +
      (option.sub ? '<i class="fwd-sub">' + esc(option.sub) + '</i>' : '') + '</span>' +
    (option.meta ? '<span class="fwd-meta">' + esc(option.meta) + '</span>' : '') + '</button>';
}
// Keep repository association visible on execution pages; loading failures or unavailable candidates must not hide the feature.
function _fwdRepoLoadState(failed) {
  const box = document.getElementById('fwdRepo');
  const select = document.getElementById('fwdRepoSel');
  const hint = document.getElementById('fwdRepoHint');
  if (!box || !select) return;
  box.style.display = _fwdTab === 'ai' ? '' : 'none';
  select.disabled = failed || !_repoCache.length;
  if (!_repoCache.length) {
    const option = document.createElement('option'); option.value = '';
    option.textContent = failed ? '工程列表加载失败' : '正在加载工程…';
    select.replaceChildren(option);
  }
  if (hint) hint.textContent = failed ? '工程列表加载失败，请点击下方“重试”。' : '正在核对可关联工程…';
}

// Default to no plugin; remembered choices are local to this dispatch overlay and do not change the dispatch protocol.
let _fwdDefaultPending = true, _fwdNoPlugin = true, _fwdPlainChoice = null;
const _fwdWorkflowChoices = new Map(), _fwdLocalAliases = new Map();
let _fwdManualAgent = '';
function _fwdDirectAgents() {
  const rows = (window.TaskExecutionClient?.targets
    ? TaskExecutionClient.targets(_fwdOptions || {})
    : (_fwdOptions?.substrates || [])).map(row => ({...row}));
  _fwdLocalAliases.clear();
  const task = typeof tasks === 'undefined' ? null : tasks.find(row => _fwdSameId(row.id, _fwdTaskId));
  const ordinary = window.RequirementSessionChoice?.canUseLocalAgents?.(task, _fwdOptions) === true;
  const clientId = _fwdId(window.SoduWorkAPI?.clientId);
  if (window.RequirementSessionChoice?.canUseLocalAgents && !ordinary) return rows;
  for (const agent of _fwdLocalAgents) {
    const exact = rows.find(row => _fwdSameId(row.key, agent.key));
    const cli = _fwdId(agent.cli);
    // Only the authenticated device identity and an explicit location attest
    // that this Runner is another transport for the probed local runtime.
    const matches = ordinary && clientId && agent.executionSource === 'conversation' &&
      agent.available === true && /^[a-z][a-z0-9-]{0,39}$/.test(cli)
      ? rows.filter(row => row.cli === cli && row.locationMode === 'local' && row.remote !== true &&
        row.clientId === clientId && row.locations?.length === 1 &&
        row.locations[0].mode === 'local' && row.locations[0].clientId === clientId)
      : [];
    if (!exact && matches.length === 1) {
      const existing = matches[0];
      // A manual transport choice and an explicit Hub denial remain authoritative.
      if (!_fwdAvailable(existing) || _fwdSameId(existing.key, _fwdManualAgent)) continue;
      const merged = {...agent, locationLabel: existing.locationLabel || agent.locationLabel};
      // Keep display provenance only. Copying Runner locations back into targets()
      // would turn this native choice into a controlled dispatch again.
      rows[rows.indexOf(existing)] = merged;
      _fwdLocalAliases.set(_fwdId(existing.key), merged);
    } else if (!exact) rows.push(agent);
    else if (agent.executionSource === 'conversation') {
      exact.localConversationAvailable = true;
      exact.localModelPick = agent.modelPick !== false;
      exact.localConversationName = agent.name || exact.name || exact.cli || 'Agent';
    }
  }
  return rows;
}
function _fwdResetMethodChoice() {
  _fwdDefaultPending = true; _fwdNoPlugin = true; _fwdPlainChoice = null;
  _fwdManualAgent = ''; _fwdLocalAliases.clear();
  _fwdWorkflowChoices.clear();
}
function _fwdDefaultPlainChoice() {
  const current = _fwdSelection.ai;
  if (current?.type === 'direct' && _fwdChoiceIsCurrent(current)) return current;
  if (_fwdPlainChoice && _fwdChoiceIsCurrent(_fwdPlainChoice.choice)) return _fwdPlainChoice.choice;
  const rows = _fwdDirectAgents().filter(item => item?.key && _fwdAvailable(item));
  const recommended = _fwdLocalAliases.get(_fwdId(_fwdOptions?.recommendation?.substrateKey))?.key || _fwdOptions?.recommendation?.substrateKey;
  const agent = rows.find(item => _fwdSameId(item.key, recommended)) || rows[0];
  if (agent) return {type:'direct', id:agent.key, name:agent.name || agent.cli || 'Agent', cli:agent.cli || '', available:true};
  return null;
}
function _fwdRestoreAIChoice() {
  _fwdDirectAgents();
  const current = _fwdSelection.ai;
  for (const choice of [current, _fwdPlainChoice?.choice]) {
    const alias = choice?.type === 'direct' && _fwdLocalAliases.get(_fwdId(choice.id));
    if (alias) { choice.id = alias.key; choice.name = alias.name; choice.cli = alias.cli; }
  }
  if (!current || !_fwdChoiceIsCurrent(current)) {
    if (current?.type === 'direct' && _fwdLocalLoading) return;
    // Apply defaults only on initial catalog load; invalidated manual choices require reselection.
    _fwdSelection.ai = _fwdDefaultPending ? _fwdDefaultPlainChoice() : null;
    if (current) _fwdSetStatus('原执行选项已不可用，请重新选择。', true);
  }
  if (_fwdSelection.ai || !_fwdLocalLoading) _fwdDefaultPending = false;
}
function _fwdRememberMethodChoice(choice) {
  const previous = _fwdSelection.ai;
  if (previous?.type === 'direct') {
    _fwdPlainChoice = {choice:{...previous}, model:_fwdModel};
  }
  _fwdDefaultPending = false;
  _fwdNoPlugin = !choice || choice.type !== 'workflow';
}
function _fwdChooseNoPlugin(tid) {
  const choice = _fwdDefaultPlainChoice();
  const current = _fwdSelection.ai;
  const model = choice?.type === 'direct' && current?.type === 'direct' && _fwdSameId(current.id, choice.id)
    ? _fwdModel : choice && _fwdPlainChoice?.choice.type === choice.type &&
      _fwdSameId(_fwdPlainChoice.choice.id, choice.id) ? _fwdPlainChoice.model : '';
  _fwdChoose(tid, choice);
  if (choice?.type === 'direct') {
    _fwdModel = model; _fwdSyncConfirm(tid);
  }
}
function _fwdNoPluginRow() {
  return _fwdRow({id:'no-plugin', type:'no-plugin', name:'不用插件 · 直接执行', ico:'ai',
    sub:'使用下方选择的 Agent，需求和材料会一并带过去', meta:'默认方式'});
}
function _fwdPaintSelection(box) {
  if (!box) return;
  const choice = _fwdSelection[_fwdTab];
  box.querySelectorAll('[data-fwd-choice]').forEach(button => {
    const selected = button.dataset.fwdChoice === 'no-plugin' ? _fwdNoPlugin : Boolean(choice &&
      button.dataset.fwdChoice === choice.type && _fwdSameId(button.dataset.aid, choice.id));
    button.classList.toggle('is-selected', selected);
    button.setAttribute('aria-pressed', selected ? 'true' : 'false');
  });
  if (typeof _fwpSetSelected === 'function') _fwpSetSelected(box, choice?.type === 'workflow' ? choice.id : '');
}

function _fwdInstalledMethod(item) {
  return Boolean(item?.bindingId && (item.selectionSource === 'builtin' ||
    item.selectionSource === 'installed' || item.sourceKind === 'builtin'));
}

function _fwdPickedSummary(title, description, icon, badge = '') {
  return '<div class="fwd-picked"><span class="fwp-mark">' + _svg(icon) + '</span>' +
    '<span class="fwd-picked-copy"><b data-user-content title="' + esc(title) + '">' + esc(title) +
    '</b><small data-user-content title="' + esc(description) + '">' +
    esc(description) + '</small></span>' + (badge ? '<em>' + esc(badge) + '</em>' : '') + '</div>';
}

function _fwdPickerOption(value, label, selected, disabled = false) {
  return '<option value="' + esc(value) + '"' + (value === selected ? ' selected' : '') +
    (disabled ? ' disabled' : '') + '>' + esc(label) + '</option>';
}

function _fwdAgentPickerState(flow) {
  if (flow && !_fwpUsesRuntime(flow)) return {fixed:true, rows:[], value:''};
  if (flow) {
    const rows = _fwpSubstrates(_fwdOptions, flow);
    let state = _fwdWorkflowChoices.get(flow.bindingId);
    if (!state) {
      const preferred = _fwdPlainChoice?.choice?.id || _fwdDefaultPlainChoice()?.id;
      state = {kind:rows.find(row => row.value === preferred)?.value ?? rows[0]?.value ?? '', model:''};
      _fwdWorkflowChoices.set(flow.bindingId, state);
    }
    if (rows.find(row => row.value === state.kind)?.modelPick === false) state.model = '';
    return {rows, value:state.kind, stale:!rows.some(row => row.value === state.kind),
      modelStale:_fwpWorkflowModelState(_fwdOptions, state.model).stale, state};
  }
  return {rows:_fwdDirectAgents().filter(row => row?.key).map(row => ({
    value:row.key, label:row.name || row.cli || 'Agent', note:row.note || '',
    available:_fwdAvailable(row), modelPick:row.modelPick !== false,
    locationLabel:row.locationLabel || (row.remote ? '远程设备' : '本机'),
  })), value:_fwdSelection.ai?.type === 'direct' ? _fwdSelection.ai.id : null};
}

function _fwdAgentSummary(state, flow) {
  if (state.fixed) return _fwdPickedSummary('按插件配置执行',
    window.TaskExecutionClient?.nodeAgentLabel(flow) || '这套工作方式已指定执行 Agent', 'ai', '固定配置');
  const row = state.rows.find(item => item.value === state.value && item.available !== false);
  if (!row) {
    const available = state.rows.some(item => item.available !== false);
    if (!flow && _fwdLocalLoading) return _fwdPickedSummary('正在核对本机 Agent', '可用后会自动显示在下方列表', 'ai');
    return _fwdPickedSummary(state.stale ? '原 Agent 已不可用' : available ? '请选择 Agent' : '暂无可用 Agent',
      state.stale ? '请重新选择后再安排执行' : available ? '从下方列表选择执行 Agent' :
        (_fwdOptions.availability?.agentReason || '请先在 Agent 管理中安装并启动 Runner'), 'ai');
  }
  return _fwdPickedSummary(row.label, row.note || (row.value ? '需求和材料会一并交给此 Agent' : '各节点沿用插件路由和当前可用的 Agent'),
    'ai', row.value ? 'Agent' : '自动选择');
}

function _fwdRenderAIPickers(tid, box) {
  if (!box || !_fwdOptions || _fwdTab !== 'ai') return;
  const plugins = [...(_fwdOptions.workflows || []), ...(_fwdOptions.blockedWorkflows || [])];
  const selectedId = _fwdSelection.ai?.type === 'workflow' ? _fwdSelection.ai.id : '';
  const flow = plugins.find(row => _fwdSameId(row.bindingId, selectedId));
  const missingMethod = !_fwdNoPlugin && !flow;
  const agentState = _fwdAgentPickerState(flow);
  const pluginOptions = (missingMethod ? _fwdPickerOption('__unselected__', '请重新选择工作方式', '__unselected__', true) : '') +
    _fwdPickerOption('', '不用插件 · 直接执行', missingMethod ? null : selectedId) + plugins.map(plugin =>
    _fwdPickerOption(plugin.bindingId, plugin.name + (_fwpReady(plugin, _fwdOptions) ? '' : ' · 暂不可用'),
      selectedId, !_fwpReady(plugin, _fwdOptions))).join('');
  const placeholder = agentState.fixed ? '插件已指定 Agent' : agentState.stale ? '请重新选择 Agent' : '请选择可用 Agent';
  const agentOptions = (agentState.fixed || agentState.stale || agentState.value == null
    ? _fwdPickerOption('__unselected__', placeholder, '__unselected__', true) : '') + agentState.rows.map(row =>
    _fwdPickerOption(row.value, [row.label, row.locationLabel, row.available === false ? '未就绪' : ''].filter(Boolean).join(' · '),
      agentState.stale ? null : agentState.value, row.available === false)).join('');
  window.ForwardSelect?.destroy(box);
  box.innerHTML = '<section class="fwd-method-picker"><label class="fwd-picker-field"><span>选择插件</span>' +
    '<select id="fwdPluginSelect" aria-label="选择插件" aria-describedby="fwdPluginHint">' +
    pluginOptions + '</select></label><small class="fwd-picker-hint" id="fwdPluginHint">' +
    (_fwdOptions.pluginInstallationUnknown ? '暂未取得安装信息，仅显示内置插件' : '默认不用插件，可选择内置或已安装的插件') + '</small></section>' +
    '<section class="fwd-agent-picker"><div class="fwd-property-heading"><label for="fwdAgentSelect">选择 Agent</label>' +
    '<button type="button" class="btn-mini" data-fwd-recheck' + (_fwdLocalLoading ? ' disabled' : '') + '>' +
      (_fwdLocalLoading ? '检查中…' : '重新检查') + '</button></div>' +
    '<select id="fwdAgentSelect" aria-label="选择 Agent"' +
    (agentState.fixed || !agentState.rows.length ? ' disabled' : '') + '>' + agentOptions + '</select>' +
    '<small class="fwd-picker-hint" id="fwdAgentHint">' + esc(agentState.fixed ? '按插件各节点的配置执行' :
      _fwdLocalLoading ? '正在检查本机可用 Agent…' : agentState.rows.length ? '需求和材料会一并交给所选 Agent' :
      '未找到可执行的 Agent，请重新检查连接') + '</small>' +
    (_fwdLocalFailures.length ? '<details class="fwd-agent-diagnostics"><summary>' +
      _fwdLocalFailures.length + ' 个 Agent 连接未就绪</summary>' + _fwdLocalFailures.map(item =>
      '<p><b>' + esc(item.name) + '</b><span>' + esc(item.reason) + '</span></p>').join('') + '</details>' : '') + '</section>' +
    (flow ? _fwpCard(flow, _fwdOptions, true, agentState.state) : '');
  const pluginSelect = box.querySelector('#fwdPluginSelect');
  box.querySelector('[data-fwd-recheck]').addEventListener('click', () => {
    if (document.getElementById('fwdConfirm')?.dataset.idleLabel != null) return;
    _loadAIPickList(tid);
  });
  pluginSelect.addEventListener('change', () => {
    if (document.getElementById('fwdConfirm')?.dataset.idleLabel != null) return;
    const plugin = plugins.find(row => row.bindingId === pluginSelect.value);
    if (!pluginSelect.value) _fwdChooseNoPlugin(tid);
    else if (plugin && _fwpReady(plugin, _fwdOptions)) _fwdChoose(tid,
      {type:'workflow', id:plugin.bindingId, name:plugin.name, available:true});
    (document.querySelector('[data-fwd-select="fwdPluginSelect"]') || document.getElementById('fwdPluginSelect'))?.focus();
  });
  if (flow) {
    const card = _fwpCardById(box, flow.bindingId);
    const kind = card.querySelector('[data-fwp-kind]');
    const model = card.querySelector('[data-fwp-model]');
    if (kind) kind.value = agentState.stale ? '__unselected__' : agentState.value;
    if (model) model.value = agentState.modelStale ? '__unselected__' : agentState.state?.model || '';
    _fwpBind(tid, box, null, _fwdOptions);
    model?.addEventListener('change', () => {
      if (document.getElementById('fwdConfirm')?.dataset.idleLabel != null ||
          (model.value && !(_fwdOptions.models || []).includes(model.value))) return;
      agentState.state.model = model.value;
      agentState.modelStale = false;
      _fwdSetStatus('');
      _fwdSyncConfirm(tid);
    });
  }
  box.querySelector('#fwdAgentSelect').addEventListener('change', event => {
    if (document.getElementById('fwdConfirm')?.dataset.idleLabel != null) return;
    const value = event.target.value;
    const row = agentState.rows.find(item => item.value === value && item.available !== false);
    if (!row) return;
    _fwdSetStatus('');
    if (!flow) {
      const agent = _fwdSubstrateOf(value);
      _fwdChoose(tid, {type:'direct', id:agent.key, name:agent.name || agent.cli || 'Agent', cli:agent.cli || '', available:true});
      (document.querySelector('[data-fwd-select="fwdAgentSelect"]') || document.getElementById('fwdAgentSelect'))?.focus();
      return;
    }
    agentState.state.kind = value; agentState.value = value; agentState.stale = false;
    const agent = _fwdSubstrateOf(value);
    if (agent) _fwdPlainChoice = {choice:{type:'direct', id:agent.key, name:agent.name || agent.cli || 'Agent',
      cli:agent.cli || '', available:true}, model:_fwdPlainChoice?.choice?.id === value ? _fwdPlainChoice.model : ''};
    const card = _fwpCardById(box, flow.bindingId);
    card.querySelector('[data-fwp-kind]').value = value;
    _fwpSyncModel(card, _fwdOptions);
    const modelValue = card.querySelector('[data-fwp-model]')?.value || '';
    if (modelValue !== '__unselected__') agentState.state.model = modelValue;
    agentState.modelStale = _fwpWorkflowModelState(_fwdOptions, agentState.state.model).stale;
    _fwdSyncConfirm(tid);
  });
  if (agentState.stale) _fwdSetStatus('原 Agent 已不可用，请重新选择后再安排执行。', true);
  else if (agentState.modelStale) _fwdSetStatus('原模型已不可用，请重新选择', true);
  _fwdPaintSelection(box);
  window.ForwardSelect?.enhance(box);
}

