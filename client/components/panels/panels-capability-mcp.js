/* MCP lifecycle additions use the existing panel/modal and theme, never a second settings app. */
(function (global) {
  'use strict';
  const icon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3v5m8-5v5M6 8h12v4a6 6 0 0 1-6 6v3m-6-9V8m6 10a6 6 0 0 1-6-6"/></svg>';
  function moreIcon() {
    const ns='http://www.w3.org/2000/svg',svg=document.createElementNS(ns,'svg');
    svg.setAttribute('class','connector-more-icon');svg.setAttribute('viewBox','0 0 24 24');
    svg.setAttribute('aria-hidden','true');svg.setAttribute('focusable','false');
    for(const x of [5,12,19]){const dot=document.createElementNS(ns,'circle');dot.setAttribute('cx',String(x));dot.setAttribute('cy','12');dot.setAttribute('r','1.5');svg.append(dot);}
    return svg;
  }
  function enhance(content, ctx) {
    const {api,h,say,errorText,openModal,closeModal,load,mcp,openMcpEditor} = ctx;
    const bar = document.createElement('div');
    bar.className = 'cap-mcp-manage-bar';
    bar.innerHTML = (ctx.compactConnections ? '<details class="connector-toolbar-menu"><summary aria-label="连接管理选项">更多</summary><div class="connector-menu-body">' : '<div><span>管理连接配置、检查状态或共享给团队</span></div>') +
      '<button class="btn-mini" data-mcp-import>' + icon + '导入配置</button>' +
      '<button class="btn-mini" data-mcp-export>导出配置</button>' +
      '<button class="btn-mini" data-mcp-submissions>共享记录</button>' + (ctx.compactConnections ? '</div></details>' : '');
    if(ctx.compactConnections){bar.querySelector('summary').append(moreIcon());bar.classList.add('connector-compact-tools');bar.addEventListener('click',event=>{if(event.target.closest('button'))bar.querySelector('details').open=false;});bar.addEventListener('keydown',event=>{if(event.key==='Escape'&&bar.querySelector('details').open){event.stopPropagation();bar.querySelector('details').open=false;bar.querySelector('summary').focus();}});}
    content.prepend(bar);
    bar.querySelector('[data-mcp-import]').onclick = () => openImport(ctx);
    bar.querySelector('[data-mcp-submissions]').onclick = history;
    const exportButton=bar.querySelector('[data-mcp-export]');
    exportButton.disabled=!(mcp.personal||[]).length;
    exportButton.onclick=()=>global.SoduWorkConnectorExport.open(ctx);
    if(!ctx.compactConnections) content.querySelectorAll('[data-toggle-mcp]').forEach(button=>{
      const row=(mcp.personal||[]).find(x=>x.id===button.dataset.toggleMcp);if(!row)return;
      const action=document.createElement('button');action.className='btn-mini';action.dataset.mcpExport=row.id;action.textContent='导出';
      action.onclick=()=>global.SoduWorkConnectorExport.open(ctx,{ids:[row.id]});button.parentElement.append(action);
    });
    if(!ctx.compactConnections) content.querySelectorAll('[data-edit-mcp]').forEach(button => {
      const share = document.createElement('button');
      share.className = 'btn-mini';
      share.dataset.mcpShare = button.dataset.editMcp;
      share.textContent = '共享到公司';
      share.onclick = () => shareDialog((mcp.personal || []).find(r => r.id === share.dataset.mcpShare));
      button.parentElement.insertBefore(share, button);
    });
    if(!ctx.compactConnections) content.querySelectorAll('[data-company-mcp]').forEach(button => {
      const item = (mcp.company || []).find(r => r.name === button.dataset.companyMcp);
      const wrapper = document.createElement('div');
      wrapper.className = 'cap-mcp-company';
      button.replaceWith(wrapper); wrapper.append(button);
      const inspect = document.createElement('button');
      inspect.className = 'cap-mcp-inspect'; inspect.dataset.mcpInspect = item.id;
      inspect.textContent = '连接详情与测试';
      inspect.onclick = () => companyDialog(item);
      wrapper.append(inspect);
    });

    return {company:companyDialog,share:shareDialog,history};

    function currentModal(layer, selector) {
      const owner = api.taskStorageKey?.('ops'), revision = ctx.viewRevision?.(), element = layer.querySelector(selector);
      return () => api.taskStorageKey?.('ops') === owner && (!ctx.viewRevision || ctx.viewRevision() === revision) &&
        layer.isConnected && !layer.hidden && layer.querySelector(selector) === element;
    }
    function notice(layer, text, bad) {
      const el = layer.querySelector('[data-mcp-feedback]');
      if (el) { el.hidden = false; el.textContent = text; el.classList.toggle('bad', !!bad); }
    }
    function modal(title, subtitle, body, foot) {
      const layer = openModal(title, subtitle, '<div class="cap-mcp-flow">' + body +
        '<p class="cap-mcp-feedback" data-mcp-feedback role="status" hidden></p></div>', foot);
      layer.querySelector('.cap-modal').classList.add('cap-mcp-modal');
      return layer;
    }
    function shareDialog(item) {
      if (!item) return;
      const required = [...Object.keys(item.headers || {}), ...Object.keys(item.env || {})];
      const layer = modal('共享到公司', '先提交配置，经管理员实测开放后，其他客户端才能选择使用。',
        '<label class="cap-field"><span>公司连接名称</span><input class="cap-input" data-mcp-share-name maxlength="60" value="' +
        h((item.name.slice(0,52) + '-company')) + '"></label>' +
        '<div class="cap-mcp-route"><span>我的连接</span><i>→</i><span>管理员检查</span><i>→</i><span>公司客户端</span></div>' +
        '<p>共享连接方式、目标和工具范围；不会提交个人密钥，不会改变当前连接。</p>' +
        (required.length ? '<p>管理员需补充公司凭据：<b>' + required.map(h).join('、') + '</b></p>' : '') +
        '<label class="cap-confirm"><input data-mcp-share-consent type="checkbox"><span>确认提交配置，允许管理员检查并向公司开放。</span></label>',
        '<button class="btn-mini primary" data-mcp-share-do disabled>提交共享</button>');
      const button = layer.querySelector('[data-mcp-share-do]');
      const active = currentModal(layer, '[data-mcp-share-do]');
      let saving = false;
      layer.querySelector('[data-mcp-share-consent]').onchange = e => { button.disabled = saving || !e.target.checked; };
      button.onclick = async () => {
        if (button.disabled || saving || !active()) return;
        saving = true; button.disabled = true;
        try {
          const r = await api.shareMyMcp(item.id, layer.querySelector('[data-mcp-share-name]').value.trim());
          if (!active()) return;
          notice(layer, r.item.status === 'approved' ? '已开放，其他客户端可以选择使用' : r.item.status === 'rejected' ? '申请已退回：' + r.item.note : '已提交，等待管理员检查；个人连接不受影响');
          button.textContent = '查看共享记录'; button.disabled = false; button.onclick = history;
        } catch (e) { if (active()) { notice(layer, errorText(e, '提交失败'), true); button.disabled = false; } }
        finally { saving = false; }
      };
    }
    async function history() {
      const layer = modal('共享记录', '仅显示当前设备提交的连接。', '<div data-mcp-history>正在读取…</div>', '');
      const active = currentModal(layer, '[data-mcp-history]');
      try {
        const r = await api.myMcpSubmissions();
        if (!active()) return;
        layer.querySelector('[data-mcp-history]').innerHTML = r.items.length ? r.items.map(item =>
          "<article class=\"cap-mcp-import-row\"><header><b data-user-content>" + h(item.name) + '</b><em>' +
          h({pending:'等待检查',approved:'已开放',rejected:'已退回'}[item.status] || item.status) +
          "</em></header><p" + (item.note ? ' data-user-content' : '') + '>' + h(item.note || '管理员处理后，将在公司连接中提供') + '</p></article>').join('') : '<p>还没有共享记录。从个人连接旁点击“共享到公司”开始。</p>';
      } catch (e) { if (active()) notice(layer, errorText(e, '读取失败'), true); }
    }
    function companyDialog(item) {
      const layer = modal(item.name, '公司连接 · 凭据由管理员维护',
        '<div class="cap-mcp-route"><span>' + (item.type === 'http' ? '远程服务' : '本机 Runner') +
        "</span><i>→</i><span data-user-content>" + h(item.name) + '</span><i>→</i><span>授权工具</span></div>' +
        "<p" + (item.description ? ' data-user-content' : '') + '>' + h(item.description || '按需启用，用于当前设备的任务与对话') + '</p>' +
        '<dl class="cap-mcp-facts"><div><dt>启动 / 调用超时</dt><dd>' + Number(item.startupTimeoutSeconds || 10) + 's / ' +
        Number(item.toolTimeoutSeconds || 60) + 's</dd></div><div><dt>允许工具</dt><dd>' +
        h(item.enabledTools?.join('、') || '服务公开的全部工具') + '</dd></div><div><dt>禁用工具</dt><dd>' +
        h(item.disabledTools?.join('、') || '无') + '</dd></div></dl><div data-mcp-tools></div>',
        '<span class="cap-mcp-footnote">测试仅读取工具清单，不执行工具</span><button class="btn-mini primary" data-mcp-company-probe>测试连接</button>');
      const button = layer.querySelector('[data-mcp-company-probe]');
      const active = currentModal(layer, '[data-mcp-company-probe]');
      button.onclick = async () => {
        if (!active() || button.disabled) return;
        button.disabled = true; button.textContent = '连接中…';
        try {
          const r = await api.probeCompanyMcp(item.id);
          if (!active()) return;
          notice(layer, r.ok ? (r.authenticationTested === false ? '工具清单已加载 · 业务授权待验证 · ' : '连接通过 · ') + (r.runOn === 'runner' ? r.runnerHost || '本机 Runner' : 'SoduWork Hub') : r.error || '连接未通过', !r.ok);
          layer.querySelector('[data-mcp-tools]').innerHTML = '<div class="cap-mcp-tool-chips">' +
            (r.tools || []).map(t => '<code>' + h(t) + '</code>').join('') + '</div>';
        } catch (e) { if (active()) notice(layer, errorText(e, '连接失败'), true); }
        finally { if (active()) { button.disabled = false; button.textContent = '重新测试'; } }
      };
    }
  }
  function openImport(ctx, options) {
    const {api,h,say,errorText,openModal,closeModal,load,openMcpEditor} = ctx;
    options = options || {};
      let file = null, result = null, importing = false;
      const owner = api.taskStorageKey?.('ops');
      const layer = openModal('导入连接配置', '支持接口文档（OpenAPI / JSON / YAML）与连接配置。导入后自动带入认证字段。',
        '<div class="cap-mcp-flow">' + (options.file ? '' : '<label class="cap-mcp-upload">' + icon + '<b>选择配置文件</b><span>JSON / YAML / TOML · 最大 1 MB</span>' +
        '<input data-mcp-file type="file" accept=".json,.toml,.yaml,.yml" aria-label="选择连接配置文件"></label>') +
        '<div data-mcp-preview></div>' +
        '<label class="cap-confirm"><input data-mcp-import-consent type="checkbox"><span>已核对连接目标和权限，导入后保持停用。</span></label>' +
        '<p class="cap-mcp-feedback" data-mcp-feedback role="status" hidden></p></div>',
        '<span class="cap-mcp-footnote">密钥归当前设备使用，不随共享提交</span>' +
        '<button class="btn-mini primary" data-mcp-import-do disabled>导入个人连接</button>');
      layer.querySelector('.cap-modal').classList.add('cap-mcp-modal');
      let revision = ctx.viewRevision?.();
      const sameView = () => api.taskStorageKey?.('ops') === owner && (!ctx.viewRevision || ctx.viewRevision() === revision);
      const active = () => sameView() && layer.isConnected && !layer.hidden && layer.querySelector('[data-mcp-import-do]') === submit;
      const submit = layer.querySelector('[data-mcp-import-do]');
      const consent = layer.querySelector('[data-mcp-import-consent]');
      function updateSubmit() { submit.disabled = importing || !consent.checked || !result?.summary?.importable; }
      consent.onchange = updateSubmit;
      async function preview(selectedFile) {
        file = selectedFile; result = null; submit.disabled = true; consent.checked = false;
        const holder = layer.querySelector('[data-mcp-preview]'); holder.textContent = '正在检查配置…';
        if (!file) { holder.textContent = ''; return; }
        if (file.size > 1024 * 1024) { holder.textContent = '文件超过 1 MB，请缩小配置'; return; }
        try {
          const selected = file, response = await api.previewMyMcpImport(file);
          if (file !== selected || !active()) return;
          result = response;
          holder.innerHTML = "<div class=\"cap-mcp-preview-head\"><b data-user-content>" + h(file.name) + '</b><span>' +
            Number(result.summary.importable) + ' / ' + Number(result.summary.total) + ' 可导入</span></div>' +
            result.servers.map(row => "<article class=\"cap-mcp-import-row\"><header><b data-user-content>" + h(row.name) +
              '</b><em>' + h(row.duplicate ? '已存在' : row.importable ? '可导入' : '需调整') + '</em></header>' +
              '<code>' + h(row.target) + '</code>' +
              (row.credentialKeys?.length ? '<span>只写凭据：' + row.credentialKeys.map(h).join('、') + '</span>' : '') +
              [...(row.errors || []), ...(row.warnings || [])].map(t => '<p>' + h(t) + '</p>').join('') + '</article>').join('');
          updateSubmit();
        } catch (e) { if (active()) holder.textContent = errorText(e, '文件检查失败'); }
      }
      const picker = layer.querySelector('[data-mcp-file]');
      if (picker) picker.onchange = event => preview(event.target.files[0]);
      if (options.file) void preview(options.file);
      submit.onclick = async () => {
        if (!active() || importing || !consent.checked || !result?.summary?.importable || submit.disabled) return;
        importing = true; submit.disabled = true; submit.textContent = '正在导入…';
        try {
          if (options.beforeImport) await options.beforeImport();
          if (!active()) return;
          const saved = await api.importMyMcp(file);
          if (!active()) return;
          const importedRows = Array.isArray(saved?.importedRows) ? saved.importedRows : [];
          closeModal(); revision = ctx.viewRevision?.(); await load();
          if (!sameView() || !layer.isConnected || !layer.hidden || layer.querySelector('[data-mcp-import-do]') !== submit) return;
          if (importedRows.length && typeof openMcpEditor === 'function') {
            // Open the imported, credential-masked row immediately.  URL,
            // command, args and policies are carried into the editor while
            // secret values remain write-only on the server.
            openMcpEditor(importedRows[0], null, {
              onSaved: options.onSaved || function () { say('连接器配置已保存，可在任务中启用'); },
            });
            say(importedRows.length === 1
              ? '已导入连接，配置已带入编辑页'
              : '已导入 ' + importedRows.length + ' 个连接，已打开第一个配置；其余连接可在列表中编辑');
          } else {
            say('已导入 ' + Number(saved?.imported?.length || 0) + ' 个连接，保持停用；编辑并实测后启用');
          }
        } catch (e) {
          if (!active()) return;
          const feedback = layer.querySelector('[data-mcp-feedback]');
          feedback.hidden = false; feedback.textContent = errorText(e, '导入失败，请重试'); feedback.classList.add('bad');
          submit.disabled = !consent.checked; submit.textContent = '导入个人连接';
        } finally { importing = false; }
      };
    }
  global.SoduWorkMcpManagement = {enhance, openImport, moreIcon};
})(window);
