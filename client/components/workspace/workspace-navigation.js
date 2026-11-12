/* Per-process workspace restoration. Messages and execution stay in NativeChat;
   only the selected destination and reading position cross this IPC boundary. */
(function (global) {
  'use strict';
  let context = null, contextRequest = null, epoch = 0, reportSequence = 0;
  let view = '', selected = '', restoring = 0, scrollTimer = null;
  let ready = !global.__deskArgs, markReady;
  const workspaceReady = ready ? Promise.resolve() : new Promise(resolve => { markReady = resolve; });
  global.addEventListener?.('soduwork-workspace-ready', () => { ready = true; markReady?.(); });
  const api = () => global.soduWorkAPI;
  const scope = () => String(global.SoduWorkAPI?.taskStorageKey?.('ops') || '');
  const info = () => global.NativeChat?.sessionInfo?.() || {};

  function readContext(fresh = false) {
    if (!fresh && context) return Promise.resolve(context);
    if (!fresh && contextRequest) return contextRequest;
    const requestEpoch = epoch;
    const request = Promise.resolve().then(() => api()?.workspaceContext?.()).then(value => {
      if (requestEpoch !== epoch) return null;
      context = value && typeof value.owner === 'string' && Number.isSafeInteger(value.generation) ? value : null;
      return context;
    }).catch(() => null).finally(() => { if (contextRequest === request) contextRequest = null; });
    contextRequest = request;
    return request;
  }

  function capture(key) {
    const row = { view: String(key || view || global.WorkspaceShell?.active || '') };
    const panel = global.document?.getElementById('composePanel');
    if (row.view !== 'create' || panel?.dataset.stage !== 'chat') return row;
    const current = info();
    const chatId = selected || current.sessionId || global.WorkspaceShell?.activeChatId || '';
    if (!chatId) return row;
    row.chatId = String(chatId);
    const scroll = global.document?.getElementById('nchatScroll');
    if (scroll && String(current.sessionId || '') === row.chatId) {
      row.reading = global.NativeChat?.readingPosition?.() || { top: Math.max(0, Number(scroll.scrollTop) || 0),
        follow: scroll.__soduworkScrollFollow ? scroll.__soduworkScrollFollow.follow === true :
          scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight <= 48 };
    }
    return row;
  }

  function record(key) {
    view = String(key || view || global.WorkspaceShell?.active || '');
    if (restoring || !view) return Promise.resolve(false);
    const row = capture(view), sequence = ++reportSequence, capturedEpoch = epoch, capturedScope = scope();
    const publish = current => {
      if (!current || sequence !== reportSequence || capturedEpoch !== epoch || capturedScope !== scope() || restoring) return false;
      try { api()?.reportWorkspaceView?.({ ...row, ...current }); return true; }
      catch (_) { return false; }
    };
    // A close/unload must publish synchronously once identity has been resolved.
    return context ? Promise.resolve(publish(context)) : readContext().then(publish);
  }

  function chatChanged(id) {
    selected = String(id || '');
    return record(view || global.WorkspaceShell?.active);
  }

  function parseRestore(value) {
    if (!value) return null;
    try {
      const row = typeof value === 'string' ? JSON.parse(value) : value;
      return row && typeof row.owner === 'string' && Number.isSafeInteger(row.generation) ? row : null;
    } catch (_) { return null; }
  }

  function active(ticket) {
    if (ticket === epoch) return true;
    if (restoring === ticket) restoring = 0;
    return false;
  }

  async function restore(viewKey, payload, saved, opener, ticket) {
    if (saved.chatId && !ready) await workspaceReady;
    if (!active(ticket)) return false;
    const current = await readContext(true);
    if (!active(ticket)) return false;
    if (!current || current.owner !== saved.owner || current.generation !== saved.generation ||
        (saved.chatId && !current.owner)) {
      restoring = 0;
      return open('create', { newSession: true }, opener);
    }
    const opened = await opener(viewKey, payload);
    if (!active(ticket)) return false;
    const verified = await readContext(true);
    if (!active(ticket)) return false;
    if (opened === false || !verified || verified.owner !== saved.owner || verified.generation !== saved.generation) {
      restoring = 0;
      return open('create', { newSession: true }, opener);
    }
    if (saved.chatId && String(info().sessionId || '') === saved.chatId && saved.reading?.follow === false &&
        global.NativeChat?.restoreReadingPosition) {
      await global.NativeChat.restoreReadingPosition(saved.reading, () => active(ticket));
      if (!active(ticket)) return false;
      restoring = 0; record(viewKey); return opened;
    }
    restoring = 0;
    const apply = () => {
      if (!active(ticket)) return;
      if (saved.chatId && String(info().sessionId || '') === saved.chatId && saved.reading?.follow === false) {
        const scroll = global.document?.getElementById('nchatScroll');
        if (scroll && Number.isFinite(saved.reading.top)) {
          if (scroll.__soduworkScrollFollow?.pause) scroll.__soduworkScrollFollow.pause();
          else if (scroll.__soduworkScrollFollow) scroll.__soduworkScrollFollow.follow = false;
          scroll.scrollTop = Math.max(0, saved.reading.top);
        }
      }
      record(viewKey);
    };
    if (global.requestAnimationFrame) global.requestAnimationFrame(apply);
    else global.setTimeout(apply, 0);
    return opened;
  }

  function open(viewKey, raw, opener) {
    const payload = { ...(raw || {}) }, saved = parseRestore(payload.workspaceRestore);
    delete payload.workspaceRestore;
    const ticket = ++epoch;
    const begin = () => {
      reportSequence++; view = viewKey; selected = String(payload.chatId || '');
      restoring = saved ? ticket : 0;
      if (saved) return restore(viewKey, payload, saved, opener, ticket).catch(() => {
        if (!active(ticket)) return false;
        restoring = 0;
        return open('create', { newSession: true }, opener);
      });
      const opened = opener(viewKey, payload);
      record(viewKey);
      return opened;
    };
    const openApplication = api()?.conversationSession?.openApplication;
    if (viewKey !== 'create' || !payload.chatId || payload.taskRef || payload.taskId || !openApplication) return begin();
    const capturedScope = scope();
    return Promise.resolve(openApplication(String(payload.chatId))).then(result => {
      if (!active(ticket) || scope() !== capturedScope) return false;
      if (!result?.ok) throw Error(result?.reason || '应用会话暂时无法打开');
      // Keep the current main page, draft and attachment intact when another
      // native application window owns this conversation.
      return result.handled ? true : begin();
    }).catch(error => {
      if (active(ticket) && scope() === capturedScope) global.petSay?.(String(error.message || error));
      return false;
    });
  }

  function scopeChanged() {
    epoch++; reportSequence++; restoring = 0; selected = ''; context = null; contextRequest = null;
    const ticket = epoch;
    Promise.resolve(api()?.resetWorkspaceState?.()).then(value => {
      if (ticket !== epoch) return;
      context = value || null;
      record(view);
    }).catch(() => {});
    global.WorkspaceHost?.open('create', { newSession: true });
  }

  global.WorkspaceNavigation = { record, chatChanged, open, scopeChanged };
  if (global.__deskPanel !== 'workspace') return;
  global.addEventListener?.('soduwork-data-scope-changed', scopeChanged);
  global.addEventListener?.('soduwork-device-auth', () => {
    context = null; contextRequest = null;
    record(view);
  });
  const flush = () => { if (scrollTimer) global.clearTimeout(scrollTimer); scrollTimer = null; record(view); };
  global.addEventListener?.('beforeunload', flush);
  global.addEventListener?.('pagehide', flush);
  global.document?.addEventListener('scroll', event => {
    if (event.target?.id !== 'nchatScroll' || scrollTimer) return;
    scrollTimer = global.setTimeout(flush, 100);
  }, true);
})(window);
