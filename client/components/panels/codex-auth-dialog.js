/* Explicit native Codex authorization. Only public device-flow metadata reaches this UI. */
(function (global) {
  'use strict';
  let active = null;
  let scope = 0;
  const terminal = new Set(['succeeded', 'failed', 'cancelled', 'expired']);
  const allowedUrls = new Set(['https://auth.openai.com/codex/device', 'https://auth.openai.com/device']);
  const failureReasons = Object.freeze({
    runtime_missing: '这台机器上的 Codex 尚不可用，请先检查安装。',
    status_unavailable: '暂时无法确认登录状态。可以重试，或使用独立授权连接 SoduWork。',
    authorization_failed: 'OpenAI 授权未完成，请确认账号允许设备码登录并完成官方页面授权。',
    auth_not_verified: '授权流程已结束，但尚未确认有效登录，请重新检查。',
    access_denied: '无法访问所选执行机的 Codex 程序或登录目录，请检查该机器的访问权限。',
    login_busy: '这台机器已有 Codex 授权正在进行，请先完成或取消。',
    connection_failed: '连接未完成，请重试；可在 Agent 管理中检查所选执行机的安装状态。',
  });
  const copy = {
    checking: ['正在检查登录状态', '优先使用这台机器已有的 Codex 登录。'],
    ready: ['连接你的 Codex 账号', '继续后，在 OpenAI 官方页面完成授权。'],
    starting: ['正在准备授权', '正在向 Codex 请求一次性设备码。'],
    waiting: ['等待你完成授权', '复制设备码，打开官方授权页并按提示登录。'],
    succeeded: ['已检测到 Codex 登录', '无需重复授权，可以测试连接。'],
    failed: ['连接未完成', '请检查网络和执行机状态，然后重试。'],
    expired: ['设备码已过期', '重新连接以获取新的设备码。'],
    cancelled: ['已取消授权', '需要时可以重新连接 Codex。'],
    cancelling: ['正在取消授权', '正在停止这台机器上的登录请求。'],
  };
  const tr = value => global.SoduWorkI18n?.translateText?.(value) || value;
  function node(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text != null) el.textContent = tr(text);
    return el;
  }
  function metadata(value) {
    if (!value || !['checking', 'waiting', ...terminal].includes(value.state)) return null;
    if (value.state !== 'waiting') {
      const result = { state: value.state };
      if (value.state === 'failed' && typeof value.reason === 'string'
          && Object.hasOwn(failureReasons, value.reason)) result.reason = value.reason;
      return result;
    }
    if (!allowedUrls.has(value.verificationUrl) || !/^[A-Z0-9]{4,6}-[A-Z0-9]{4,6}$/.test(value.userCode || '')
        || !Number.isFinite(value.expiresAt) || value.expiresAt <= 0) return null;
    return { state: 'waiting', verificationUrl: value.verificationUrl, userCode: value.userCode, expiresAt: value.expiresAt };
  }
  function open(options) {
    const opts = options || {};
    if (active) { active.dialog.querySelector('button:not(:disabled)')?.focus(); return active.promise; }
    const epoch = scope, restoreTo = document.activeElement, api = global.SoduWorkAPI;
    const runnerId = String(opts.runnerId || '');
    let phase = 'checking', detail = '', auth = null, jobId = '', jobTerminal = false;
    let isolatedAvailable = false, isolated = false, uncertain = false;
    let busy = false, closing = false, settled = false, timer = null, generation = 0, failures = 0, pollSequence = 0;
    let resolveResult;
    const promise = new Promise(resolve => { resolveResult = resolve; });
    const dialog = node('dialog', 'codex-auth-dialog');
    dialog.setAttribute('aria-labelledby', 'codexAuthTitle');
    dialog.setAttribute('aria-describedby', 'codexAuthDescription');
    const card = node('section', 'codex-auth-card');
    const head = node('header', 'codex-auth-head');
    const brand = node('span', 'codex-auth-brand');
    const logo = node('img'); logo.src = 'assets/agent-brands/codex.svg'; logo.alt = '';
    logo.setAttribute('aria-hidden', 'true'); brand.append(logo);
    const heading = node('div', 'codex-auth-heading');
    const title = node('h2', '', '连接 Codex'); title.id = 'codexAuthTitle';
    const machine = node('p', 'codex-auth-machine'); machine.textContent = String(opts.machine || tr('本机'));
    machine.setAttribute('data-user-content', ''); machine.title = machine.textContent;
    heading.append(title, machine);
    const close = node('button', 'codex-auth-close', '×'); close.type = 'button'; close.setAttribute('aria-label', tr('关闭'));
    head.append(brand, heading, close);
    const body = node('div', 'codex-auth-body');
    const status = node('div', 'codex-auth-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const mark = node('i', 'codex-auth-mark'); mark.setAttribute('aria-hidden', 'true');
    const statusTitle = node('h3'); status.append(mark, statusTitle);
    const description = node('p', 'codex-auth-description'); description.id = 'codexAuthDescription';
    const device = node('div', 'codex-auth-device');
    const codeLabel = node('span', 'codex-auth-code-label', '一次性设备码');
    const code = node('strong', 'codex-auth-code'); code.setAttribute('data-user-content', '');
    const copyButton = node('button', 'codex-auth-copy', '复制设备码'); copyButton.type = 'button';
    const expiry = node('span', 'codex-auth-expiry');
    const codeRow = node('div', 'codex-auth-code-row'); codeRow.append(code, copyButton);
    device.append(codeLabel, codeRow, expiry);
    const feedback = node('p', 'codex-auth-feedback'); feedback.setAttribute('role', 'status');
    const privacy = node('p', 'codex-auth-privacy', '账号授权由 OpenAI 完成。SoduWork 不会显示或索取你的密码。');
    body.append(status, description, device, feedback, privacy);
    const foot = node('footer', 'codex-auth-foot');
    const cancel = node('button', 'codex-auth-secondary', '取消'); cancel.type = 'button';
    const primary = node('button', 'codex-auth-primary', '继续登录'); primary.type = 'button';
    const recovery = node('button', 'codex-auth-secondary', '使用独立授权'); recovery.type = 'button';
    foot.append(cancel, recovery, primary); card.append(head, body, foot); dialog.append(card);
    const current = () => !settled && epoch === scope && active?.dialog === dialog;
    function finish(result) {
      if (settled) return;
      settled = true; generation++; clearTimeout(timer);
      if (active?.dialog === dialog) active = null;
      if (dialog.open) dialog.close(); dialog.remove();
      if (epoch === scope && restoreTo?.isConnected) restoreTo.focus({ preventScroll: true });
      resolveResult(result);
    }
    function render() {
      if (!current()) return;
      dialog.dataset.state = phase;
      const value = phase === 'starting' && uncertain ? copy.checking : copy[phase] || copy.failed;
      statusTitle.textContent = tr(value[0]); description.textContent = tr(detail || value[1]);
      const waiting = phase === 'waiting';
      device.hidden = !waiting; privacy.hidden = phase === 'succeeded';
      code.textContent = waiting ? auth?.userCode || '' : '';
      const seconds = Math.max(0, Math.ceil((auth?.expiresAt || 0) - Date.now() / 1000));
      expiry.textContent = waiting ? tr('有效时间') + ' ' + Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0') : '';
      copyButton.disabled = !waiting || !seconds;
      mark.textContent = phase === 'succeeded' ? '✓' : terminal.has(phase) ? '!' : '';
      primary.hidden = ['checking', 'starting', 'cancelling'].includes(phase);
      primary.textContent = tr(waiting ? '打开官方授权页' : phase === 'succeeded' ? (opts.onProbe ? '测试连接' : '完成') : phase === 'ready' ? (isolated ? '开始独立授权' : uncertain ? '继续检查' : '继续登录') : '重试');
      primary.disabled = busy || (waiting && !seconds);
      cancel.hidden = phase === 'succeeded' && (!isolatedAvailable || isolated); cancel.disabled = closing;
      cancel.textContent = tr(phase === 'succeeded' ? '使用独立授权' : jobId && !jobTerminal ? '取消授权' : '取消');
      recovery.hidden = !(phase === 'failed' || (phase === 'ready' && uncertain)) || !isolatedAvailable || isolated || !!(jobId && !jobTerminal);
      recovery.disabled = busy || closing;
      close.disabled = closing;
    }
    function fail(message) { phase = 'failed'; detail = message || ''; busy = false; render(); }
    function prepareIsolated() {
      isolated = true; uncertain = false; jobId = ''; auth = null; jobTerminal = false;
      phase = 'ready'; detail = '仅当本机登录无法用于 SoduWork 时使用。授权成功后请新建对话，已有对话保留原登录。'; render();
    }
    async function check(keepIsolated = false) {
      const version = ++generation;
      isolated = false; isolatedAvailable = false; uncertain = false; phase = 'checking'; detail = ''; render();
      try {
        const result = await api.agentSetup(runnerId);
        if (!current() || version !== generation) return;
        const machines = result?.machines?.length ? result.machines : [{ runnerId: '', agents: result?.agents || [] }];
        const found = machines.find(item => String(item.runnerId || '') === runnerId)?.agents?.find(item => item.key === 'codex');
        if (!found || !found.installed) { fail('这台机器上的 Codex 尚不可用，请先检查安装。'); return; }
        isolatedAvailable = found.isolatedLoginAvailable === true && found.loginFlowVersion === 1;
        if (keepIsolated && isolatedAvailable) { prepareIsolated(); return; }
        if (found.auth === 'authed') { phase = 'succeeded'; detail = '已检测到这台机器的 Codex 登录，无需再次授权。'; render(); return; }
        if (found.loginAvailable !== true || found.loginFlowVersion !== 1) { fail('执行机暂不支持此登录窗口，请更新 SoduWork 后重试。'); return; }
        uncertain = found.authStatus === 'unknown' || (found.auth !== 'unauthed' && found.state !== 'unauthed');
        // Explicit continuation may prepare a missing account directory. The
        // server still requires native unauthed status before starting OAuth.
        if (uncertain) detail = '暂时无法确认登录状态。继续后会先检查，确认未登录时才请求授权。';
        phase = 'ready'; render();
      } catch (_) { if (current() && version === generation) fail(); }
    }
    function schedule() { clearTimeout(timer); if (current() && jobId && !jobTerminal) timer = setTimeout(poll, 900); }
    async function poll() {
      const version = generation, expectedJob = jobId, sequence = ++pollSequence;
      try {
        const result = await api.agentJob(expectedJob);
        if (!current() || version !== generation || expectedJob !== jobId || sequence !== pollSequence) return;
        failures = 0;
        const next = metadata(result?.auth);
        if (!next) {
          jobTerminal = result?.state === 'done';
          fail('执行机返回的授权信息不完整，请更新 SoduWork 后重试。');
          return;
        }
        auth = next; jobTerminal = terminal.has(next.state);
        if (!closing) phase = next.state === 'checking' ? 'starting' : next.state;
        if (jobTerminal) {
          closing = false; phase = next.state;
          opts.onDone?.(next.state === 'succeeded');
        }
        detail = next.state === 'succeeded' && isolated ? '独立授权已完成。请新建对话使用；已有对话保留原登录。'
          : failureReasons[next.reason] || ''; render();
        if (next.state === 'cancelled' && retryRequested) { jobId = ''; auth = null; retryRequested = false; closingRequested = false; await check(isolated); return; }
        if (next.state === 'cancelled' && closingRequested) { finish(false); return; }
      } catch (_) {
        if (!current() || version !== generation || expectedJob !== jobId || sequence !== pollSequence) return;
        failures++;
        if (failures >= 4) { closing = false; fail('暂时无法连接执行机。重试或取消前将再次确认授权状态。'); return; }
      }
      schedule();
    }
    let closingRequested = false, retryRequested = false;
    async function stop() {
      if (!jobId || jobTerminal) return true;
      await api.agentInstall('codex', 'login-cancel', runnerId, { jobId });
      return false;
    }
    async function dismiss(retry = false) {
      if (!current() || closing) return;
      retryRequested = retry;
      if (busy && !jobId) { closingRequested = true; closing = true; phase = 'cancelling'; render(); return; }
      if (!jobId || jobTerminal) { finish(phase === 'succeeded'); return; }
      closingRequested = true; closing = true; phase = 'cancelling'; detail = ''; render();
      try { await stop(); if (current()) { failures = 0; await poll(); } }
      catch (_) { if (current()) { closingRequested = false; closing = false; fail('取消未完成，请确认执行机在线后重试取消。'); } }
    }
    async function start() {
      if (!current() || busy) return;
      if (jobId && !jobTerminal) { await dismiss(); return; }
      const version = ++generation;
      busy = true; phase = 'starting'; detail = ''; auth = null; jobId = ''; jobTerminal = false; closingRequested = false; render();
      try {
        const result = await api.agentInstall('codex', isolated ? 'login-isolated' : 'login', runnerId);
        if (!current() || version !== generation) return;
        if (!result?.jobId) throw Error('Missing authorization job');
        jobId = String(result.jobId); busy = false;
        opts.onStart?.(jobId);
        if (closingRequested) { closing = false; await dismiss(); } else await poll();
      } catch (_) { if (current() && version === generation) { closing = false; if (closingRequested) finish(false); else fail(); } }
    }
    copyButton.addEventListener('click', async () => {
      if (phase !== 'waiting' || copyButton.disabled) return;
      const value = auth.userCode;
      try { await global.navigator.clipboard.writeText(value); if (current()) feedback.textContent = tr('设备码已复制'); }
      catch (_) { if (current()) feedback.textContent = tr('复制失败，请选中设备码后手动复制。'); }
    });
    primary.addEventListener('click', async () => {
      if (!current() || primary.disabled) return;
      feedback.textContent = '';
      if (phase === 'succeeded') { finish(true); opts.onProbe?.(); return; }
      if (phase === 'waiting') {
        try {
          const openExternal = global.soduWorkAPI?.openExternal;
          if (!openExternal || !allowedUrls.has(auth.verificationUrl)) throw Error('Unavailable');
          const result = await openExternal(auth.verificationUrl);
          if (result?.ok === false) throw Error('Rejected');
          if (current()) feedback.textContent = tr('授权页已打开，完成后会自动更新。');
        } catch (_) { if (current()) feedback.textContent = tr('无法打开浏览器，请稍后重试。'); }
      } else if (phase === 'ready') await start();
      else if (jobId && !jobTerminal) await dismiss(true);
      else { jobId = ''; auth = null; await check(isolated); }
    });
    close.addEventListener('click', () => void dismiss());
    recovery.addEventListener('click', () => {
      if (!recovery.hidden && !recovery.disabled) prepareIsolated();
    });
    cancel.addEventListener('click', () => {
      if (phase === 'succeeded' && isolatedAvailable && !isolated) prepareIsolated();
      else void dismiss();
    });
    dialog.addEventListener('cancel', event => { event.preventDefault(); event.stopPropagation(); void dismiss(); });
    dialog.addEventListener('keydown', event => { if (event.key === 'Escape') event.stopPropagation(); });
    active = { dialog, promise, finish };
    document.body.append(dialog); dialog.showModal(); render(); cancel.focus({ preventScroll: true });
    void check();
    return promise;
  }
  global.addEventListener('soduwork-data-scope-changed', () => { scope++; active?.finish(false); });
  global.CodexAuthDialog = { open, metadata };
})(window);
