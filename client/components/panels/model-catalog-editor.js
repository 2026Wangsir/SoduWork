/* Model rows and capability editing share the provider page's save/revision flow. */
const _mdDrafts = new Map();
const _mdChecks = new Map();
function _mdCheckKey(pid, name) { return JSON.stringify([pid, name]); }
function _mdReconcileChecks(data) {
  const models = new Map((data.myModels || []).map(row => [_mdCheckKey(row.providerId, row.name), row]));
  for (const provider of data.providers || []) for (const row of provider.modelDefs || [])
    models.set(_mdCheckKey(provider.id, row.name), row);
  for (const [key, check] of _mdChecks) {
    if (check.pending) continue;
    const model = models.get(key);
    if (!model || (model.configRevision && check.configRevision !== model.configRevision)) _mdChecks.delete(key);
  }
}
function _mdModelListHtml(p, models, own) {
  const rows = models.map(model => ({ model, index: -1 })).concat(own.map((model, index) => ({ model, index })));
  if (!rows.length) return '<p class="md-model-help">添加模型后可配置能力并进行检测。</p>';
  return '<div class="md-model-list">' + rows.map(({ model, index }) => {
    const id = _mdCheckKey(p.id, model.name), check = _mdChecks.get(id);
    const item = p._capStale ? { ...model, capabilityProfile: undefined, capabilityCheck: null } : model;
    return '<article class="md-model-row md-mtag' + (index >= 0 ? ' is-own' : '') + '" data-md-model="' + esc(id) + '">' +
      '<div><div class="md-model-name"><i class="md-model-type is-' + _mdType(model.modality) + '">' + _MD_TYPES[_mdType(model.modality)] + '</i>' +
      '<span data-user-content>' + esc(model.label || model.name) + '</span></div>' +
      (model.label && model.label !== model.name ? '<span class="md-model-id" data-user-content>' + esc(model.name) + '</span>' : '') +
      ModelCapabilitiesUI.badges(item) + '</div><div class="md-model-actions">' +
      (_mdType(model.modality) === 'chat' ? '<button type="button" data-mdcheck' + (check?.pending ? ' disabled' : '') + '>' + (check?.pending ? '检测中…' : '检测能力') + '</button>' : '') +
      (index >= 0 ? '<button type="button" data-mdedit="' + esc(p.id) + '|' + index + '">编辑</button>' +
        '<button type="button" data-mdel="' + esc(p.id) + '|' + index + '" title="移除模型" aria-label="移除模型">移除</button>' : '<span class="md-cap-unchecked">组织管理</span>') +
      '</div>' + (_mdType(model.modality) === 'chat' ? '<div class="md-model-report">' + ModelCapabilitiesUI.report(check || item.capabilityCheck) + '</div>' : '') + '</article>';
  }).join('') + '</div>';
}
function _mdModelEditorHtml(p) {
  const draft = _mdDrafts.get(p.id), model = draft?.model || {}, config = model.config || {}, type = _mdType(model.modality);
  return '<details class="md-model-editor" data-mdeditor="' + esc(p.id) + '"' + (draft?.open ? ' open' : '') + '><summary>' +
    (draft?.original ? '编辑模型' : '添加模型') + '</summary><div class="md-addgrid">' +
    '<label class="md-cap-field"><span>模型用途</span><select class="md-addselect" data-paddtype="' + esc(p.id) + '">' + _mdTypeOptions(type) + '</select></label>' +
    '<label class="md-cap-field"><span>模型 ID</span><input class="md-addin" data-padd="' + esc(p.id) + '" aria-label="添加模型 ID" placeholder="输入准确的模型 ID" maxlength="160" value="' + esc(model.name || '') + '"></label>' +
    '<label class="md-addthinking" data-paddthinkingwrap="' + esc(p.id) + '"><span>思考模式</span><select class="md-addselect" data-paddthinking="' + esc(p.id) + '">' + _mdThinkingOptions(config.thinkingMode || (config.thinkingAlwaysOn ? 'always' : 'auto')) + '</select></label>' +
    '<label class="md-cap-field" data-mdchat><span>显示名称</span><input class="md-in" data-mdlabel value="' + esc(model.label || '') + '" placeholder="默认使用模型 ID"></label>' +
    ModelCapabilitiesUI.fields(model) +
    '<input class="md-addin md-addpath" data-paddpath="' + esc(p.id) + '" aria-label="生成接口路径" value="' + esc(config.endpointPath || '') + '" placeholder="生成接口路径">' +
    '<input class="md-addin md-addstatus" data-paddstatus="' + esc(p.id) + '" aria-label="异步任务查询路径" value="' + esc(config.statusPath || '') + '" placeholder="/contents/generations/tasks/{id}">' +
    '<input class="md-addin md-addresult" data-paddresult="' + esc(p.id) + '" aria-label="结果下载路径" value="' + esc(config.resultPath || '') + '" placeholder="状态接口直接返回视频地址时留空">' +
    '<textarea class="md-addin md-adddefaults" data-padddefaults="' + esc(p.id) + '" aria-label="默认生成参数" rows="3">' + esc(JSON.stringify(config.defaults || {}, null, 2)) + '</textarea>' +
    '<div class="md-model-editor-actions"><button type="button" class="md-model-add" data-madd="' + esc(p.id) + '">' + (draft?.original ? '应用修改' : '添加模型') + '</button>' +
    (draft?.original ? '<button type="button" class="md-model-add-cancel" data-mdcancel="' + esc(p.id) + '">取消</button>' : '') + '</div></div></details>';
}
function _mdBindModels(box) {
  box.querySelectorAll('[data-mdedit]').forEach(button => button.addEventListener('click', () => {
    if (button.isConnected === false) return;
    const [pid, index] = button.dataset.mdedit.split('|'), model = _mdMyModels.filter(row => row.providerId === pid)[+index];
    if (!model) return;
    _mdDrafts.set(pid, { original: model.name, model: structuredClone(model), open: true });
    _mdRender();
    box.querySelector('[data-padd]')?.focus();
  }));
  box.querySelectorAll('[data-mdcancel]').forEach(button => button.addEventListener('click', () => {
    if (button.isConnected === false) return;
    _mdDrafts.delete(button.dataset.mdcancel); _mdRender();
  }));
  box.querySelectorAll('[data-mdeditor]').forEach(editor => {
    const pid = editor.dataset.mdeditor;
    const restored = _mdDrafts.get(pid);
    for (const [selector, value] of Object.entries(restored?.fields || {})) {
      const field = editor.querySelector(selector); if (field) field.value = value;
    }
    if (restored?.advanced) editor.querySelector('.md-cap-advanced')?.setAttribute('open', '');
    function capture() {
      if (!editor.isConnected) return;
      const fields = {};
      editor.querySelectorAll('input,select,textarea').forEach(field => {
        const attr = [...field.attributes].find(attribute => attribute.name.startsWith('data-'));
        if (attr) fields['[' + attr.name + '="' + CSS.escape(attr.value) + '"]'] = field.value;
      });
      _mdDrafts.set(pid, { ...(_mdDrafts.get(pid) || {}), open: editor.open, fields, advanced: !!editor.querySelector('.md-cap-advanced')?.open });
    }
    editor.addEventListener('input', capture);
    editor.addEventListener('change', capture);
    editor.addEventListener('toggle', event => { if (event.target === editor) capture(); });
    editor.querySelector('.md-cap-advanced')?.addEventListener('toggle', capture);
    const select = editor.querySelector('[data-paddtype]');
    function typeChange() {
      const type = select.value;
      editor.querySelectorAll('[data-mdchat],[data-paddthinkingwrap]').forEach(el => { el.hidden = type !== 'chat'; });
      editor.querySelectorAll('[data-paddpath],[data-padddefaults],[data-paddstatus],[data-paddresult]').forEach(el => {
        const visible = type !== 'chat' && (!el.matches('[data-paddstatus],[data-paddresult]') || type === 'video');
        el.hidden = !visible; el.disabled = !visible;
      });
      const path = editor.querySelector('[data-paddpath]'), status = editor.querySelector('[data-paddstatus]');
      if (!path.value && type !== 'chat') path.value = type === 'image' ? '/images/generations' : pid === 'volcengine' ? '/contents/generations/tasks' : '/videos/generations';
      if (!status.value && type === 'video' && pid === 'volcengine') status.value = '/contents/generations/tasks/{id}';
    }
    select.addEventListener('change', typeChange); typeChange();
    editor.querySelector('[data-madd]').addEventListener('click', () => _mdApplyModel(editor));
    editor.querySelector('[data-padd]').addEventListener('keydown', event => {
      if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229) return;
      event.preventDefault(); _mdApplyModel(editor);
    });
  });
  box.querySelectorAll('[data-mdcheck]').forEach(button => button.addEventListener('click', () => {
    if (button.isConnected === false) return;
    const [pid, name] = JSON.parse(button.closest('[data-md-model]').dataset.mdModel);
    _mdCheckModel(pid, name);
  }));
}
function _mdApplyModel(editor) {
  if (_mdSaveFlight || editor.isConnected === false) return;
  const pid = editor.dataset.mdeditor, draft = _mdDrafts.get(pid), original = draft?.original;
  const old = _mdMyModels.find(row => row.providerId === pid && row.name === original);
  // A removed edit target must not become an implicit new model.
  if (!_mdProvider(pid) || (original && !old)) return;
  const value = selector => editor.querySelector(selector)?.value.trim() || '';
  const name = value('[data-padd]'), modality = _mdType(value('[data-paddtype]'));
  if (!name) return;
  if (_mdMyModels.some(row => row !== old && row.providerId === pid && row.name === name) || _mdCatalogModels(_mdProvider(pid)).some(row => row.name === name)) {
    petSay('这个模型已经在清单里了'); return;
  }
  try {
    let config, ctxWindow;
    if (modality === 'chat') {
      ({ config, ctxWindow } = ModelCapabilitiesUI.read(editor, old));
      config.thinkingMode = value('[data-paddthinking]') || 'auto';
      // Changing a thinking declaration must clear incompatible derived values.
      if (config.thinkingMode !== old?.config?.thinkingMode) {
        delete config.reasoning; delete config.thinkingAlwaysOn; delete config.thinkingLevelMap;
      }
    } else {
      const endpointPath = value('[data-paddpath]'), statusPath = value('[data-paddstatus]'), resultPath = value('[data-paddresult]');
      if (!endpointPath.startsWith('/')) throw Error('生成接口路径要以 / 开头');
      if (modality === 'video' && [statusPath,resultPath].some(path => path && (!path.startsWith('/') || !path.includes('{id}')))) throw Error('视频任务路径要以 / 开头，并包含 {id}');
      let defaults;
      try { defaults = JSON.parse(value('[data-padddefaults]') || '{}'); if (!defaults || Array.isArray(defaults) || typeof defaults !== 'object') throw Error(); }
      catch (_) { throw Error('默认参数要填写合法的 JSON 对象'); }
      config = { endpointPath, defaults, ...(modality === 'video' ? { statusPath, resultPath } : {}) };
    }
    const model = { ...(old || {}), providerId: pid, name, label: value('[data-mdlabel]') || name, modality, config, ...(ctxWindow !== undefined ? { ctxWindow } : {}) };
    delete model.capabilityProfile; delete model.capabilityCheck;
    if (old) _mdMyModels.splice(_mdMyModels.indexOf(old), 1, model); else _mdMyModels.push(model);
    _mdChecks.delete(_mdCheckKey(pid, name));
    if (original) _mdChecks.delete(_mdCheckKey(pid, original));
    _mdDrafts.delete(pid); _mdMarkOwnedDirty(_mdProvider(pid) || pid); _mdRender();
  } catch (error) { petSay(error.message); }
}
async function _mdCheckModel(pid, name) {
  const key = _mdCheckKey(pid, name);
  if (_mdChecks.get(key)?.pending) return;
  const pending = { pending: true };
  _mdChecks.set(key, pending); _mdRender();
  try {
    if ((_mdDirty || Object.keys(_mdKeyEdits).length) && !await _mdSave(false)) throw Error('请先保存模型配置，再检测能力');
    const report = await SoduWorkAPI.checkMyModelCapabilities({ providerId: pid, model: name,
      localOnly: _mdProvider(pid)?.localOnly === true, checks: ['connection', 'imageInput', 'toolCalling', 'streaming'] });
    if (_mdChecks.get(key) !== pending) return;
    _mdChecks.set(key, report);
    const row = _mdMyModels.find(item => item.providerId === pid && item.name === name) || _mdProvider(pid)?.modelDefs?.find(item => item.name === name);
    if (row && report.capabilityProfile) row.capabilityProfile = report.capabilityProfile;
    if (globalThis.ComposeModelPicker?.refresh) await ComposeModelPicker.refresh(true);
    globalThis.soduWorkAPI?.broadcast?.('models', { providerId: pid });
  } catch (error) { if (_mdChecks.get(key) === pending) _mdChecks.set(key, { error: _humanErr(error, '能力检测未完成，请重试') }); }
  _mdRender();
}
