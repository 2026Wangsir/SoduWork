(function (global) {
  'use strict';
  const labels = { queued: '排队中', pending: '未开始', running: '执行中', waiting: '等待你确认',
    blocked: '待处理', failed: '已暂停', completed: '已完成', cancelled: '已停止' };
  let active = null;
  let currentView = null, viewGeneration = 0;
  const api = () => global.soduWorkAPI && global.soduWorkAPI.personalPlugins;
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }
  function button(text, action, primary) {
    const node = el('button', 'pdebug-button' + (primary ? ' is-primary' : ''), text);
    node.type = 'button'; node.addEventListener('click', action); return node;
  }
  async function open(options) {
    viewGeneration++;
    const opts = options || {};
    const info = global.NativeChat && global.NativeChat.sessionInfo();
    const ref = opts.ref || info && info.ref;
    const host = opts.host || document.querySelector('#cpChat .nchat-draft');
    if (!ref || !host || !api() || !api().debug) {
      if (global.petSay) global.petSay('请先打开一条普通对话，再选择插件进行本机调试');
      return null;
    }
    if (active && active.ref === ref) {
      const existing = active;
      await existing.refresh();
      if (active !== existing) return null;
      existing.place();
      if (!existing.surface.root.hidden) existing.surface.root.scrollIntoView({ block: 'nearest' });
      return existing;
    }
    if (active) active.surface.destroy();
    let disposed = false, timer = null, run = null, recoverable = false, busy = false, editing = false, last = '';
    let requestSequence = 0, appliedSequence = 0, mutationEpoch = 0, needsAction = false, fallback = null;
    const surface = global.PluginUIHost.mount({ id: 'personal-plugin-debug', host,
      anchor: opts.anchor || host.querySelector('#nchatTaskSuggest'), className: 'pdebug',
      onDestroy() {
        disposed = true; mutationEpoch++; clearTimeout(timer); fallback?.remove();
        if (active?.surface === surface) active = null;
      } });
    surface.root.hidden = true; // No provisional debug card while an ordinary run is loading.
    const heading = el('header', 'pdebug-head');
    const mark = el('span', 'pdebug-mark');
    mark.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="3" y="3" width="6" height="6" rx="2"/><rect x="15" y="15" width="6" height="6" rx="2"/><path d="M6 9v6a3 3 0 0 0 3 3h6M9 6h6a3 3 0 0 1 3 3v6"/></svg>';
    const title = el('div', 'pdebug-title');
    title.append(el('strong', '', '插件本机调试'), el('span', '', '逐节点执行 · 过程保留在当前对话'));
    const close = button('×', () => surface.destroy()); close.classList.add('pdebug-close');
    close.setAttribute('aria-label', '收起调试卡，执行不会停止'); heading.append(mark, title, close);
    const body = el('div', 'pdebug-body'), error = el('p', 'pdebug-error');
    error.setAttribute('role', 'alert'); error.hidden = true;
    const status = el('span', 'pdebug-status'); status.setAttribute('role', 'status'); title.append(status);
    surface.content.replaceChildren(heading, body, error);
    function stillCurrent() {
      const info = global.NativeChat?.sessionInfo();
      return !disposed && active?.surface === surface && (!info?.ref || info.ref === ref);
    }
    function place() {
      if (!stillCurrent()) return;
      if (run?.mode !== 'conversation') {
        fallback?.remove();
        if (surface.inline) {
          if (surface.root.parentElement !== host) host.prepend(surface.root);
          host.classList.add('has-plugin-surface');
        }
        return;
      }
      const view = currentView?.ref === ref ? currentView : null;
      const list = view?.list;
      const messages = view?.snapshot?.messages || [];
      const node = run.nodes.find(item => item.status !== 'completed');
      const keys = [];
      if (node && run.status === 'failed') keys.push('plugin-debug:' + run.id + ':' + node.key + ':' + node.attempt + ':failed');
      if (node && run.status === 'waiting') keys.push('plugin-debug:' + run.id + ':' + node.key + ':waiting');
      keys.push(run.id + ':start');
      let target = null;
      for (const key of keys) {
        const index = messages.findIndex(message => message.taskOutputKey === key);
        if (index < 0 || !list?.isConnected) continue;
        const original = view.snapshot.history?.messageIndices?.[index];
        const owner = String(Number.isInteger(original) ? original : (Number(view.snapshot.history?.messageStart) || 0) + index);
        target = [...list.querySelectorAll('.nworkflow-message-slot')].find(slot =>
          slot.dataset.workflowMessageKey === key && slot.closest('.nmsg')?.dataset.messageOwner === owner);
        if (target) break;
      }
      if (target) {
        if (surface.root.parentElement !== target) target.append(surface.root);
        fallback?.remove();
      } else if (list?.isConnected && needsAction && !surface.root.hidden) {
        if (!fallback) { fallback = el('details', 'pdebug-history'); fallback.append(el('summary', '', '')); }
        if (fallback.dataset.workflowRun !== run.id) fallback.open = false;
        fallback.dataset.workflowRun = run.id;
        fallback.firstElementChild.textContent = '较早协作「' + run.name + '」待处理';
        if (surface.root.parentElement !== fallback) fallback.append(surface.root);
        const historical = [...list.querySelectorAll('.nworkflow-history-slot')]
          .find(slot => slot.dataset.workflowRef === ref);
        if (historical) { if (fallback.parentElement !== historical) historical.append(fallback); }
        else if (fallback.parentElement !== list || list.firstElementChild !== fallback) list.prepend(fallback);
      } else { surface.root.remove(); fallback?.remove(); }
      if (!host.querySelector('.pui-surface')) host.classList.remove('has-plugin-surface');
    }
    async function request(payload) {
      // An action invalidates every earlier poll even after busy is cleared.
      // Sequence order also protects same-ref refreshes that load a new run.
      const sequence = ++requestSequence, epoch = mutationEpoch;
      const current = () => stillCurrent() && epoch === mutationEpoch && sequence >= appliedSequence;
      let result;
      try { result = await api().debug(ref, payload); }
      catch (failure) { if (!current()) return null; throw failure; }
      if (!current()) return null;
      if (result?.run?.id === run?.id && Number(result?.run?.revision) < Number(run?.revision)) return null;
      appliedSequence = sequence;
      if (!result || !result.ok) throw new Error(result && result.reason || '调试服务暂时不可用，请重试');
      return result;
    }
    function showError(failure) {
      if (!stillCurrent()) return;
      error.textContent = failure.message; error.hidden = false;
      if (run?.mode !== 'conversation' || needsAction) surface.root.hidden = false;
      place();
    }
    async function change(command, node, payload = {}) {
      if (busy || !run || !stillCurrent()) return;
      mutationEpoch++;
      busy = true; error.hidden = true;
      body.querySelectorAll('button').forEach(item => { item.disabled = true; });
      try {
        const result = await request({ ...payload, command, runId: run.id, revision: run.revision, nodeKey: node && node.key });
        if (result) { last = ''; render(result); }
      } catch (failure) { showError(failure); }
      finally { busy = false; if (!disposed) body.querySelectorAll('button').forEach(item => { item.disabled = false; }); }
    }
    async function viewOutput(output, container, trigger) {
      const bridge = global.soduWorkAPI && global.soduWorkAPI.conversationSession;
      const runId = run?.id, epoch = mutationEpoch;
      const current = () => stillCurrent() && run?.id === runId && epoch === mutationEpoch;
      trigger.disabled = true; error.hidden = true;
      try {
        if (!bridge || !bridge.outputs) throw new Error('成果查看服务未就绪，请重新打开对话');
        const result = await bridge.outputs(ref);
        if (!current()) return;
        const file = (result.files || []).find(item => item.relative === output.path);
        if (!result.ok || !file) throw new Error('此成果文件已移动或不可访问，请检查本次工作目录');
        if (run?.mode !== 'conversation' && /\.(md|txt|json|csv|log)$/i.test(file.name || '')) {
          const preview = await bridge.readOutput(ref, file.path);
          if (!current()) return;
          if (!preview.ok) throw new Error(preview.reason || '暂时无法读取成果');
          const content = el('pre', 'pdebug-file-preview', preview.text || '文件没有文本内容');
          const close = button('收起预览', () => container.replaceChildren());
          container.replaceChildren(content, close);
          if (preview.tooBig) container.prepend(el('p', 'pdebug-meta', '文件较大，仅显示前一部分'));
        } else if (run?.mode === 'conversation') {
          if (!global.ChatWorkbench?.openOutput(file.path) && !global.ChatWorkbench?.openInput(file)) {
            throw new Error('成果承载区尚未就绪，请重新打开对话');
          }
        } else {
          const opened = await bridge.openOutput(ref, file.path);
          if (!current()) return;
          if (!opened || !opened.ok) throw new Error(opened && opened.reason || '暂时无法打开成果');
        }
      } catch (failure) {
        if (current()) showError(failure);
      } finally { trigger.disabled = false; }
    }
    function render(result) {
      if (!stillCurrent()) return;
      run = result.run; recoverable = result.recoverable;
      if (!run) return;
      const signature = run.id + ':' + run.revision + ':' + recoverable;
      if (signature === last) { place(); return; }
      error.hidden = true;
      last = signature; body.replaceChildren();
      const collaboration = run.mode === 'conversation';
      const node = run.nodes.find(item => item.status !== 'completed');
      // Ordinary replies show progress. Decisions and recovery controls belong
      // to the workflow's own message, including when later turns are running.
      needsAction = recoverable || ['blocked', 'waiting', 'failed'].includes(run.status) || node?.pendingPermissions?.length;
      surface.root.hidden = collaboration && !needsAction;
      heading.hidden = collaboration;
      surface.root.classList.toggle('is-collaboration', collaboration);
      title.querySelector('strong').textContent = collaboration ? run.name : '插件本机调试';
      title.querySelector('span:not(.pdebug-status)').textContent = collaboration
        ? run.nodes.filter(node => node.status === 'completed').length + ' / ' + run.nodes.length + ' 步完成'
        : '逐节点执行 · 过程保留在当前对话';
      close.setAttribute('aria-label', collaboration ? '收起协作卡，执行不会停止' : '收起调试卡，执行不会停止');
      status.textContent = labels[run.status] || run.status;
      status.dataset.state = run.status;
      if (!collaboration) body.append(el('h3', '', run.name), el('p', 'pdebug-meta', 'v' + run.version + ' · 仅本机调试，不会自动上架'));
      if (!collaboration) {
        const steps = el('ol', 'pdebug-steps');
        for (const node of run.nodes) {
          const row = el('li', 'pdebug-step'); row.dataset.state = node.status;
          const dot = el('span', 'pdebug-dot', node.status === 'completed' ? '✓' : node.status === 'failed' ? '!' : '');
          dot.setAttribute('aria-hidden', 'true');
          const copy = el('div', 'pdebug-step-copy');
          copy.append(el('strong', '', node.name), el('span', '', node.agent
            ? node.agent + ' · 本机' + (node.model ? ' · ' + node.model : '')
            : node.type === 'human_review' ? '由你确认后继续' : node.type === 'publish' ? '完成流程，保留结果' : '沿用节点配置'));
          row.append(dot, copy, el('span', 'pdebug-step-status', labels[node.status] || node.status));
          steps.append(row);
        }
        body.append(steps);
      }
      const actions = el('footer', 'pdebug-actions');
      for (const permission of node?.pendingPermissions || []) {
        const prompt = el('section', 'pdebug-confirm');
        prompt.append(el('strong', '', '需要你的许可'), el('p', '', permission.summary));
        if (permission.detail) prompt.append(el('pre', 'pdebug-permission-detail', permission.detail));
        if (permission.reviewable === false) prompt.append(el('p', 'pdebug-note', '操作内容未完整提供。请拒绝本次操作，并让 Agent 提供明确、简短的操作。'));
        const controls = el('div', 'pdebug-actions');
        controls.append(button('不允许', () => change('permission', node, { requestId: permission.requestId, allow: false })),
          ...(permission.reviewable === false ? [] : [button('仅允许本次', () => change('permission', node, { requestId: permission.requestId, allow: true }), true)]));
        prompt.append(controls); body.append(prompt);
      }
      if (run.status === 'blocked') {
        for (const issue of run.issues || []) body.append(el('p', 'pdebug-note is-warning', (issue.nodeName ? issue.nodeName + '：' : '') + issue.message));
        actions.append(button('重新检查', () => change(recoverable ? 'resume' : 'recheck'), true));
      } else if (recoverable) {
        body.append(el('p', 'pdebug-note', '上次调试记录已保留。恢复后会先核对执行状态，不会重新派发已完成步骤。'));
        actions.append(button(collaboration ? '恢复协作' : '恢复调试', () => change('resume'), true));
      } else if (run.status === 'waiting' && node) {
        const gate = el('section', 'pdebug-confirm');
        gate.append(el('strong', '', '检查成果后再继续'), el('p', '', node.summary || '请核对上游产出'));
        body.append(gate);
        actions.append(button('确认通过并继续', () => change('approve', node), true));
      } else if (run.status === 'failed' && node) {
        body.append(el('p', 'pdebug-note is-warning', run.reason || '节点未通过校验，后续步骤已暂停'));
        if (node.canReconnect) actions.append(button('核对执行状态', () => change('reconnect', node)));
        if (node.attempt < node.maxAttempts) actions.append(button('重试本步骤', () => change('retry', node), true));
        else body.append(el('p', 'pdebug-note', '已达到重试上限，请停止后修改插件，再重新调试。'));
      }
      const outputs = run.nodes.flatMap(item => item.outputs || []);
      if (outputs.length && (!collaboration || run.status === 'waiting' || run.status === 'failed')) {
        const details = el('details', 'pdebug-evidence');
        details.append(el('summary', '', '已校验成果 · ' + outputs.length + ' 项'));
        details.open = run.status === 'waiting';
        for (const output of outputs) {
          if (output.path) {
            const row = el('div', 'pdebug-file');
            const copy = el('div', 'pdebug-file-copy');
            copy.append(el('strong', '', output.label), el('span', '', output.path.split('/').pop()));
            const preview = el('div', 'pdebug-file-content');
            const view = button('查看' + output.label, () => viewOutput(output, preview, view));
            view.dataset.outputKey = output.key;
            row.append(copy, view);
            details.append(row, preview);
          } else details.append(el('p', '', output.label + '：' + (output.url || output.commit || '正文已回到会话')));
        }
        body.append(details);
      }
      if (!['completed', 'cancelled'].includes(run.status)) actions.append(button(collaboration ? '停止协作' : '停止调试', () => change('cancel')));
      else if (!collaboration) actions.append(button('新一轮调试', () => form(), true));
      body.append(actions);
      place();
    }
    async function form() {
      const epoch = ++mutationEpoch;
      surface.root.hidden = false; heading.hidden = false;
      editing = true; last = ''; status.textContent = '准备调试'; body.replaceChildren(); error.hidden = true;
      try {
        const result = await api().list({});
        if (!stillCurrent() || epoch !== mutationEpoch) return;
        const plugins = (result.items || []).filter(item => item.enabled && item.personal && (item.capabilities || {}).hasWorkflow);
        const select = el('select', 'pdebug-input'); select.setAttribute('aria-label', '选择工作流插件');
        for (const plugin of plugins) { const option = el('option', '', plugin.name + ' · v' + plugin.version);
          option.value = plugin.pluginId; select.append(option); }
        if (opts.pluginId && plugins.some(item => item.pluginId === opts.pluginId)) select.value = opts.pluginId;
        const parameters = el('div', 'pdebug-parameters');
        function parameterFields() {
          parameters.replaceChildren();
          const selected = plugins.find(item => item.pluginId === select.value);
          for (const field of selected && selected.inputs || []) {
            const control = el(field.type === 'textarea' ? 'textarea' : field.type === 'select' ? 'select' : 'input', 'pdebug-input');
            control.dataset.parameter = field.key; control.dataset.type = field.type;
            control.id = 'pdebug-parameter-' + field.key;
            if (field.type === 'boolean') { control.type = 'checkbox'; control.checked = field.default === true; control.className = ''; }
            else {
              if (field.type === 'number') control.type = 'number';
              if (field.type === 'select') {
                const empty = el('option', '', '请选择'); empty.value = ''; control.append(empty);
                for (const option of field.options || []) { const row = el('option', '', option.label); row.value = option.value; control.append(row); }
              }
              control.value = field.default == null ? '' : field.default;
              control.placeholder = field.placeholder || '';
            }
            const label = el('label', 'pdebug-label', field.label + (field.required ? ' *' : ''));
            label.htmlFor = control.id; parameters.append(label, control);
          }
        }
        select.addEventListener('change', parameterFields); parameterFields();
        const description = el('textarea', 'pdebug-input'); description.rows = 3;
        description.placeholder = '填写这次要验证的目标、输入和预期结果'; description.value = opts.text || '';
        description.maxLength = 20000; description.setAttribute('aria-label', '本次调试说明');
        const context = el('label', 'pdebug-context'), check = el('input'); check.type = 'checkbox'; check.checked = true;
        context.append(check, el('span', '', '带入当前会话文字和附件'));
        const note = el('p', 'pdebug-note', '将真实调用本机 Agent，可能产生模型用量和文件修改。人工确认不会被自动跳过。当前附加的文件和截图会随调试带入；校验失败会暂停。');
        const requestId = global.crypto.randomUUID();
        const start = button('开始本机调试', async () => {
          if (busy || !stillCurrent()) return;
          mutationEpoch++;
          busy = true; start.disabled = true; error.hidden = true;
          try {
            const values = {};
            parameters.querySelectorAll('[data-parameter]').forEach(control => {
              values[control.dataset.parameter] = control.dataset.type === 'boolean' ? control.checked :
                control.dataset.type === 'number' && control.value !== '' ? Number(control.value) : control.value;
            });
            const started = await request({ command: 'start', parameters: values, pluginId: select.value, prompt: description.value,
            includeContext: check.checked, attachments: opts.attachments || [], requestId });
            if (started) { editing = false; render(started); } }
          catch (failure) { showError(failure); }
          finally { busy = false; if (!disposed) start.disabled = false; }
        }, true);
        start.disabled = !plugins.length;
        body.append(el('label', 'pdebug-label', '工作流插件'), select, parameters, el('label', 'pdebug-label', '调试说明'), description, context, note, start);
        if (!plugins.length) body.append(el('p', 'pdebug-note', '还没有可调试的个人工作流。请先用插件开发助手制作并安装。'));
      } catch (failure) { if (epoch === mutationEpoch) showError(failure); }
    }
    async function refresh(showForm = false) {
      if (!stillCurrent() || busy || editing) return;
      try {
        const result = await request({ command: 'get' });
        if (!result) return;
        if (result.run) render(result);
        else if (showForm && opts.mode !== 'conversation') await form();
      } catch (failure) { showError(failure); }
    }
    async function poll() {
      if (disposed) return;
      await refresh();
      if (!disposed) timer = setTimeout(poll, 1200);
    }
    const opened = { ref, surface, refresh, place };
    active = opened;
    await refresh(true);
    if (!disposed) timer = setTimeout(poll, 1200);
    return active === opened ? opened : null;
  }
  async function restore(options) {
    if (!api() || !api().debug) return;
    const generation = ++viewGeneration;
    try {
      const result = await api().debug(options.ref, { command: 'get' });
      const current = global.NativeChat && global.NativeChat.sessionInfo();
      if (generation === viewGeneration && current && current.ref === options.ref && result.ok && result.run &&
          (result.run.mode === 'conversation' || !['completed', 'cancelled'].includes(result.run.status))) await open(options);
    } catch (_) { /* An older main process has no debug IPC; normal chat stays available. */ }
  }
  global.PluginDebugCard = { open, restore,
    reconcile(view) { currentView = view; if (active?.ref === view?.ref) active.place(); },
    close() { viewGeneration++; if (active) active.surface.destroy(); } };
  if (global.PluginUIHost) global.PluginUIHost.registerAction({
    id: 'work.plugin.debug', command: '调试插件', name: '调试插件', aliases: ['插件调试', 'debug-plugin'],
    description: '本机逐节点调试个人工作流，检查产出并确认下一步', icon: '◇', badge: '本机调试',
    open: context => open(context),
  });
})(window);
