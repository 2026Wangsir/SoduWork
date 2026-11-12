/* Autosave and live discovery lifecycle for the local Skill catalog. */
(function (global) {
  'use strict';
  function runtimeApi() {
    return global.soduWorkAPI &&
      (global.soduWorkAPI.conversationSession || global.soduWorkAPI.piSession);
  }

  function runtimeMap(view) {
    const value = view || {};
    const base = (value.items || []).map(item => ({
      name: item.skillName,
      installed: Boolean(item.available),
      installState: item.available ? 'installed' : 'missing',
      reason: item.reason || '',
    }));
    return new Map([...base, ...(value.skills || [])]
      .filter(item => item && item.name).map(item => [String(item.name), item]));
  }

  function syncView(doc, selected, rows, runtime, state) {
    const text = (node, value) => { if (node && node.textContent !== value) node.textContent = value; };
    const refresh = doc.getElementById('capSkillRefresh');
    if (refresh) {
      refresh.disabled = state.refreshing;
      refresh.classList.toggle('is-refreshing', state.refreshing);
      refresh.setAttribute('aria-busy', String(state.refreshing));
      text(refresh.querySelector('span'), state.refreshing ? '正在刷新' : '刷新本机');
    }
    const status = doc.getElementById('capSkillSaveState');
    if (status) status.title = state.error;
    text(status, state.error ? '自动保存失败' : state.saving || state.dirty ? '正在自动保存…' : '已自动保存');
    text(doc.querySelector('[data-cap-tab="skills"] i'), String(selected.size));
    const byName = new Map((rows || []).map(row => [row.name, row]));
    doc.querySelectorAll('[data-skill]').forEach(button => {
      const name = button.getAttribute('data-skill'), on = selected.has(name);
      const card = button.closest('.cap-skill-card');
      if (button.getAttribute('aria-pressed') !== String(on)) {
        button.classList.toggle('on', on); card.classList.toggle('on', on);
        button.setAttribute('aria-pressed', String(on));
      }
      const installed = byName.get(name)?.runtimeAvailable || runtime.get(name)?.installed;
      const badge = card.querySelector('.cap-passport > span');
      if (badge) {
        const className = installed ? 'ok' : 'warn';
        if (badge.className !== className) badge.className = className;
        text(badge, installed ? '本机已安装' : on ? '等待同步到本机' : '启用后同步到本机');
      }
    });
  }

  function create(options) {
    const opts = options || {};
    const saveDelay = Math.max(0, Number(opts.saveDelay == null ? 350 : opts.saveDelay));
    const refreshInterval = Math.max(1000, Number(opts.refreshInterval || 30000));
    let saveTimer = null;
    let pollTimer = null;
    let saveRunning = false;
    let refreshRunning = false;
    let revision = 0;
    let error = '';

    function isDirty() { return Boolean(opts.isDirty && opts.isDirty()); }
    function isActive() { return !opts.isActive || opts.isActive(); }
    function state() {
      return { saving: saveRunning, refreshing: refreshRunning, error, dirty: isDirty() };
    }
    function emit() { if (opts.onState) opts.onState(state()); }
    function clearSave() {
      if (saveTimer !== null) global.clearTimeout(saveTimer);
      saveTimer = null;
    }
    function clearPoll() {
      if (pollTimer !== null) global.clearTimeout(pollTimer);
      pollTimer = null;
    }
    function sync() {
      clearPoll();
      if (!isActive()) return;
      pollTimer = global.setTimeout(function () {
        pollTimer = null;
        refresh({ silent: true }).finally(sync);
      }, refreshInterval);
    }
    function scheduleSave() {
      revision += 1;
      error = '';
      clearSave();
      saveTimer = global.setTimeout(function () {
        saveTimer = null;
        save();
      }, saveDelay);
      emit();
    }
    async function save() {
      clearSave();
      if (!isDirty()) { emit(); return true; }
      if (saveRunning) return false;
      saveRunning = true;
      const current = revision;
      const selection = opts.selection ? opts.selection() : [];
      emit();
      let ok = false;
      try {
        const result = await opts.saveSelection(selection);
        if (opts.onSaved) opts.onSaved(selection, result, current === revision);
        error = '';
        if (current === revision && opts.refreshRuntime) {
          try {
            await opts.refreshRuntime();
            if (opts.onChanged) opts.onChanged('save');
          } catch (_) {
            /* A later heartbeat or manual refresh reconciles runtime inventory. */
          }
        }
        ok = true;
      } catch (failure) {
        error = opts.errorText ? opts.errorText(failure, 'Skill 没保存上') :
          String((failure && failure.message) || 'Skill 没保存上');
        if (opts.onSaveError) opts.onSaveError(error, failure);
      } finally {
        saveRunning = false;
        emit();
        if (isDirty() && current !== revision) {
          saveTimer = global.setTimeout(function () {
            saveTimer = null;
            save();
          }, 0);
        }
      }
      return ok;
    }
    async function refresh(meta) {
      const detail = meta || {};
      if (refreshRunning) return false;
      if (isDirty()) {
        await save();
        if (isDirty()) return false;
      }
      refreshRunning = true;
      const current = revision;
      emit();
      try {
        const catalog = await opts.refreshCatalog(detail);
        // A catalog requested before a click must not erase that newer choice.
        if (current !== revision || isDirty()) return false;
        if (opts.onRefreshed) opts.onRefreshed(catalog);
        if (opts.refreshRuntime) await opts.refreshRuntime();
        error = '';
        if (opts.onChanged) opts.onChanged('refresh');
        if (!detail.silent && opts.onRefreshSuccess) opts.onRefreshSuccess(catalog);
        return true;
      } catch (failure) {
        if (opts.onRefreshError) opts.onRefreshError(failure, detail);
        return false;
      } finally {
        refreshRunning = false;
        emit();
      }
    }
    function stop() { clearPoll(); }

    return { sync, stop, scheduleSave, save, refresh, state };
  }

  global.SoduWorkSkillCatalogSync = { create, runtimeApi, runtimeMap, syncView };
})(window);
