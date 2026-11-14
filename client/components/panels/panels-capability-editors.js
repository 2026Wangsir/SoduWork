/* Personal Skill and MCP editors. Catalog navigation stays in panels-capabilities.js. */
(function (global) {
  'use strict';

  function create(ctx) {
    const SoduWorkAPI = ctx.api;
    const h = ctx.h;
    const say = ctx.say;
    const errorText = ctx.errorText;
    const openModal = ctx.openModal;
    const closeModal = ctx.closeModal;
    const load = ctx.load;
    const render = ctx.render;
    const ICON = { warn: ctx.warnIcon };
    let mcp = ctx.mcp;
    const companyMcp = ctx.companyMcp;
    let data = ctx.data;

    function skillReadError(error, fallback) {
      // A missing API route is different from an authorized route hiding a package.
      if (Number(error && error.status) === 404 && /^Not Found$/i.test(String(error.message || '').trim())) {
        return '当前 SoduWork 后台尚未提供技能内容接口。请联系管理员更新或重启后台服务，再点击重新加载；无需重新导入技能。';
      }
      return errorText(error, fallback);
    }

  function openCreateSkill() {
    const layer = openModal(
      '创建个人 Skill',
      '把你的工作方法写成可复用标准；创建后自动加入我的选择。',
      '<div class="cap-fields">' +
        '<label class="cap-field"><span>技能名称 <em>英文小写，如 weekly-analysis</em></span>' +
          '<input class="cap-input" id="capSkillName" maxlength="64" placeholder="weekly-analysis"></label>' +
        '<label class="cap-field"><span>一句话说明 <em>AI 用它判断什么时候调用</em></span>' +
          '<input class="cap-input" id="capSkillDesc" maxlength="1024" placeholder="整理每周数据并输出管理摘要"></label>' +
        '<label class="cap-field wide"><span>工作方法与完成标准</span>' +
          '<textarea class="cap-textarea" id="capSkillBody" placeholder="写清楚输入是什么、按什么步骤做、如何检查、最终交付什么。\n\n示例：\n1. 先核对数据范围和截止时间\n2. 汇总变化与异常，保留来源\n3. 输出结论、风险和下一步"></textarea>' +
          '<i class="cap-help">SoduWork 会生成标准 SKILL.md。需要脚本、参考资料或模板时，请使用“导入能力包”。</i></label>' +
      '</div>',
      '<button class="btn-mini" id="capModalCancel">取消</button><span class="push"></span>' +
      '<button class="btn-mini primary" id="capCreateDo">创建并启用</button>'
    );
    layer.querySelector('#capModalCancel').addEventListener('click', closeModal);
    layer.querySelector('#capCreateDo').addEventListener('click', async function () {
      const button = this;
      const payload = {
        name: layer.querySelector('#capSkillName').value.trim(),
        description: layer.querySelector('#capSkillDesc').value.trim(),
        instructions: layer.querySelector('#capSkillBody').value.trim(),
      };
      if (!payload.name || !payload.description || !payload.instructions) {
        say('名称、说明和工作方法都要写清楚');
        return;
      }
      button.disabled = true;
      button.textContent = '正在创建…';
      try {
        await SoduWorkAPI.createMySkill(payload);
        closeModal();
        say('Skill 已创建并启用');
        await load();
      } catch (error) {
        say(errorText(error, 'Skill 没创建成'));
        button.disabled = false;
        button.textContent = '创建并启用';
      }
    });
    setTimeout(function () { layer.querySelector('#capSkillName').focus(); }, 0);
  }

  function chooseSkillPackage() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.zip,.skill,application/zip';
    input.hidden = true;
    document.body.appendChild(input);
    input.addEventListener('cancel', () => input.remove(), { once: true });
    input.addEventListener('change', async function () {
      const file = input.files && input.files[0];
      input.remove();
      if (!file) return;
      try {
        const preview = await SoduWorkAPI.preflightMySkill(file);
        openImportPreview(file, preview);
      } catch (error) {
        say(errorText(error, '能力包预检没有通过'));
      }
    });
    input.click();
  }

  function openImportPreview(file, preview) {
    // Individual checks also carry advisory script warnings; the Hub's result is authoritative.
    if (preview?.ok !== true) throw Error('技能包预检没有通过');
    const scope = SoduWorkAPI.taskStorageKey?.('ops');
    const isCurrent = () => scope === SoduWorkAPI.taskStorageKey?.('ops');
    const skill = (preview && preview.skill) || {};
    const checks = (preview && preview.checks) || [];
    const layer = openModal(
      '安装技能',
      '保存到当前账号的个人技能库并启用，可在「技能」页管理。',
      "<div class=\"cap-import-card\"><b" + (skill.name ? ' data-user-content' : '') + '>' + h(skill.name || file.name) + '</b>' +
        "<p" + (skill.description ? ' data-user-content' : '') + '>' + h(skill.description || '暂无说明') + '</p>' +
        '<code>SHA-256 ' + h(String(skill.checksum || '').slice(0, 20)) + '… · ' +
          Number(skill.fileCount || 0) + ' 个文件 · ' + formatBytes(skill.unpackedBytes) + '</code></div>' +
      '<div class="cap-checks">' + checks.map(function (check) {
        return '<span class="cap-check' + (check.ok ? '' : ' warn') + '">' + h(check.label) + '</span>';
      }).join('') + '</div>' +
      packageMarkup(preview.files || []) +
      (skill.hasScripts ? '<div class="cap-notice">' + ICON.warn +
        '<span>这个 Skill 包含脚本。脚本不会在导入时执行，只会在任务获得相应权限并被 AI 选择后运行。</span></div>' : ''),
      '<button class="btn-mini" id="capModalCancel">取消</button><span class="push"></span>' +
      '<button class="btn-mini primary" id="capImportDo">安装并启用</button>'
    );
    const marker = {};
    layer._skillView = marker;
    layer.querySelector('#capModalCancel').addEventListener('click', closeModal);
    layer.querySelector('.cap-modal').classList.add('cap-skill-detail-modal');
    bindPackage(layer, preview.files || [], (path, offset) => SoduWorkAPI.previewSkillContent(file, path, offset),
      undefined, () => isCurrent() && !layer.hidden && layer._skillView === marker);
    layer.querySelector('#capImportDo').addEventListener('click', async function () {
      const button = this;
      if (button.disabled || !isCurrent() || layer.hidden || layer._skillView !== marker) return;
      button.disabled = true;
      layer._installPending = true;
      button.textContent = '正在安装…';
      try {
        await SoduWorkAPI.importMySkill(file);
      } catch (error) {
        if (isCurrent()) say(errorText(error, '技能没有安装成功'));
        button.disabled = false;
        button.textContent = '安装并启用';
        return;
      } finally {
        layer._installPending = false;
        if (!isCurrent() && layer._skillView === marker) closeModal();
      }
      if (!isCurrent() || layer._skillView !== marker) return;
      closeModal();
      say('技能已安装并启用，可在「技能」页找到');
      // Import has committed; a catalog refresh failure must not invite a second installation.
      try { await load(); }
      catch (error) { if (isCurrent()) say(errorText(error, '技能已安装，目录刷新失败，请点击刷新重试')); }
    });
  }


  function skillCard(item, on, runtime) {
    const personal = item.scope === 'personal';
    const installed = Boolean(item.runtimeAvailable || (runtime && runtime.installed));
    const stateText = installed ? '本机已安装'
      : (on ? '等待同步到本机' : '启用后同步到本机');
    return '<div class="cap-card cap-skill-card' + (on ? ' on' : '') + '">' +
      '<button type="button" class="cap-skill-open" data-skill-details="' + h(item.name) +
      '" aria-label="查看 ' + h(item.name) + ' 完整内容">' +
      '<span class="cap-card-icon cap-plugin-brand cap-ability-icon icon-skill" aria-hidden="true">' + ctx.skillIcon + '</span>' +
      '<span class="cap-card-main"><span class="cap-card-title"><b>' + (global.SoduWorkBuiltinSkills?.html(item) || h(item.name)) + '</b>' +
        '<em class="' + (personal ? 'personal' : '') + '">' + h(item.source || '公司能力库') + '</em></span>' +
        '<span class="cap-card-desc">' + (global.SoduWorkBuiltinSkills?.html(item, 'description') || h(item.description || '暂无说明')) + '</span>' +
        '<span class="cap-passport">' +
          '<span class="' + (installed ? 'ok' : 'warn') + '">' + stateText + '</span>' +
          (item.hasScripts ? '<span class="warn">含脚本</span>' : '<span>纯方法</span>') +
          (!item.portable ? '<span class="warn" title="目标 Runner 也要安装同名 Skill">仅同名执行机</span>' : '') +
          (item.version ? '<span>v ' + h(item.version) + '</span>' : '') +
        '</span></span></button><span class="cap-skill-actions"><button type="button" class="cap-dir-switch' + (on ? ' on' : '') +
        '" data-skill="' + h(item.name) + '" aria-label="启用 ' + h(item.name) +
        '" aria-pressed="' + on + '"><i></i></button>' +
        (item.canDelete && !item.builtIn ? '<button type="button" class="cap-delete-icon" data-remove-skill="' + h(item.name) +
          '" aria-label="删除 ' + h(item.name) + '" title="删除个人技能"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5m4-5v5"/></svg></button>' : '') + '</span></div>';
  }

  async function openDeleteSkill(name, info) {
    try {
      const item = info || await SoduWorkAPI.skillDetails(name);
      if (!item.canDelete || item.builtIn) { say('此技能不能删除；SoduWork 内置技能只能启用或停用'); return; }
      confirmDelete('技能', item, () => SoduWorkAPI.deleteMySkill(name, item.checksum));
    } catch (error) { say(errorText(error, '无法读取要删除的技能')); }
  }

  function openDeleteMcp(item) {
    if (!item || !item.canDelete || item.builtIn) { say('此连接器不能删除；SoduWork 内置连接器只能启用或停用'); return; }
    confirmDelete('连接器', item, () => SoduWorkAPI.deleteMyMcpServer(item.id));
  }

  function confirmDelete(kind, item, remove) {
    const layer = openModal('删除' + kind, '仅删除你自己创建或导入的内容',
      '<div class="cap-delete-summary"><span class="cap-delete-symbol" aria-hidden="true">' + ctx.warnIcon + '</span>' +
      "<div><b data-user-content>" + h(item.name) + '</b><p>删除后，新任务和对话不再使用这项能力。已共享的公司版本、历史会话和成果不会被删除。</p></div></div>' +
      '<p class="cap-delete-error" data-delete-error role="alert" hidden></p>',
      '<button type="button" class="btn-mini" data-delete-cancel>保留</button><span class="push"></span>' +
      '<button type="button" class="btn-mini cap-delete-confirm" data-delete-confirm>确认删除</button>');
    layer.querySelector('.cap-modal').classList.add('cap-delete-modal');
    layer.querySelector('[data-delete-cancel]').onclick = closeModal;
    const button = layer.querySelector('[data-delete-confirm]');
    button.onclick = async () => {
      if (button.disabled) return;
      button.disabled = true; layer._deletePending = true; button.textContent = '正在删除…';
      layer.querySelector('[data-delete-error]').hidden = true;
      try {
        if (ctx.beforeDelete) await ctx.beforeDelete();
        await remove();
        layer._deletePending = false; closeModal();
        await load();
        say('已删除个人' + kind + '「' + item.name + '」，公司共享版本和历史成果已保留');
      } catch (error) {
        const message = layer.querySelector('[data-delete-error]');
        message.textContent = errorText(error, '删除失败，请重试'); message.hidden = false;
      } finally {
        layer._deletePending = false; button.disabled = false; button.textContent = '确认删除';
      }
    };
  }

  function packageMarkup(files) {
    return '<div class="cap-package"><nav class="cap-package-tree" aria-label="Skill 文件目录">' +
      '<span class="cap-package-caption">包内文件 · ' + files.length + '</span>' +
      files.map(file => '<button type="button" data-package-file="' + h(file.path) + '" title="' +
        h(file.path) + '"><span aria-hidden="true">' + (file.kind === 'image' ? '▧' : '≡') +
        '</span><span>' + h(file.path) + '</span></button>').join('') +
      '</nav><section class="cap-package-reader" aria-label="文件内容">' +
        '<header><b data-file-name>选择文件</b><button class="btn-mini" data-file-download hidden>下载原文件</button></header>' +
        '<div class="cap-package-content" aria-live="polite"></div>' +
        '<button class="btn-mini cap-package-more" hidden>继续加载</button></section></div>';
  }

  function bindPackage(layer, files, read, download, isCurrent = () => true) {
    const root = layer.querySelector('.cap-package');
    const area = root.querySelector('.cap-package-content');
    const more = root.querySelector('.cap-package-more');
    const dl = root.querySelector('[data-file-download]');
    let selected = '', revision = 0, next = null, text = '';
    async function select(path, append) {
      // An in-flight installation can keep this dialog mounted after an account switch.
      if (!isCurrent()) return;
      const ticket = ++revision;
      selected = path;
      if (!append) { text = ''; next = null; area.textContent = '正在读取文件…'; }
      root.querySelector('[data-file-name]').textContent = path;
      root.querySelectorAll('[data-package-file]').forEach(b => {
        b.classList.toggle('is-active', b.dataset.packageFile === path);
        b.setAttribute('aria-current', b.dataset.packageFile === path ? 'true' : 'false');
      });
      more.hidden = true;
      dl.hidden = !download;
      try {
        const result = await read(path, append ? next : 0);
        if (ticket !== revision || !root.isConnected || !isCurrent()) return;
        area.replaceChildren();
        if (result.kind === 'text') {
          text += result.text;
          const pre = document.createElement('pre');
          pre.textContent = text;
          if (/\.(md|txt)$/i.test(path)) pre.className = 'cap-source-prose';
          area.appendChild(pre);
          next = result.nextOffset;
          more.hidden = next == null;
          more.textContent = '继续加载 · 已显示 ' + (next == null ? result.totalCharacters : next) +
            ' / ' + result.totalCharacters + ' 字符';
        } else if (result.kind === 'image') {
          const img = document.createElement('img');
          img.alt = path;
          img.src = 'data:' + result.mediaType + ';base64,' + result.base64;
          area.appendChild(img);
        } else {
          area.textContent = result.message || '该文件可下载后查看。';
        }
      } catch (error) {
        if (ticket !== revision || !root.isConnected || !isCurrent()) return;
        area.textContent = skillReadError(error, '文件读取失败');
        const retry = document.createElement('button');
        retry.className = 'btn-mini'; retry.textContent = '重试';
        retry.onclick = () => select(path, false); area.appendChild(retry);
      }
    }
    root.querySelectorAll('[data-package-file]').forEach(b => {
      b.onclick = () => select(b.dataset.packageFile, false);
    });
    more.onclick = () => select(selected, true);
    dl.onclick = async () => {
      dl.disabled = true;
      try { await download(selected); } catch (error) { say(errorText(error, '下载失败')); }
      finally { dl.disabled = false; }
    };
    if (files.length) select(files.some(f => f.path === 'SKILL.md') ? 'SKILL.md' : files[0].path, false);
  }

  async function openSkillDetails(name) {
    const layer = openModal(name, '正在读取完整 Skill 包…', '<div class="cap-state">加载中…</div>', '');
    const modal = layer.querySelector('.cap-modal');
    modal.classList.add('cap-skill-detail-modal');
    const marker = {};
    layer._skillView = marker;
    try {
      const info = await SoduWorkAPI.skillDetails(name);
      if (layer.hidden || layer._skillView !== marker) return;
      const presentation = { ...info, name, builtIn: info.builtIn || data.skills?.find(item => item.name === name)?.builtIn };
      layer.querySelector('#capModalTitle').innerHTML = global.SoduWorkBuiltinSkills?.html(presentation) || h(name);
      layer.querySelector('#capModalSub').innerHTML = global.SoduWorkBuiltinSkills?.html(presentation, 'description') || h(info.description);
      const submission = info.submission;
      const state = submission && submission.status;
      layer.querySelector('#capModalBody').innerHTML =
        '<div class="cap-package-meta"><span>' + (info.scope === 'personal' ? '个人 Skill' : '公司 Skill') +
        '</span><span>' + info.fileCount + ' 个文件 · ' + formatBytes(info.unpackedBytes) +
        '</span><code title="' + h(info.checksum) + '">版本 ' + h(info.checksum.slice(0, 12)) + '</code></div>' +
        packageMarkup(info.files) +
        (info.canShare ? '<details class="cap-package-share"' + (state ? ' open' : '') + '><summary>' +
          h(state === 'pending' ? '已提交 · 等待管理员审核' : state === 'approved' ? '此版本已审核通过' :
            state === 'rejected' ? '已退回 · 修改后可重新提交' : '共享给其他客户端') + '</summary>' +
          (submission && submission.reviewNote ? '<p>' + h(submission.reviewNote) + '</p>' : '') +
          (state === 'pending' || state === 'approved' ? '<p>只有管理员开放的版本会出现在其他客户端；个人修改不会自动发布。</p>' :
            '<p>将完整包提交到公司能力库审核。审核并开放后，其他客户端才可选择使用。</p>' +
            '<label class="cap-field"><span>共享说明（选填）</span><input class="cap-input" data-share-note maxlength="2000" placeholder="适用场景与使用注意事项"></label>' +
            '<label class="cap-confirm"><input type="checkbox" data-share-consent><span>我已检查包内全部文件，确认可以向公司共享，且不含密钥或不应共享的资料。</span></label>' +
            '<button class="btn-mini primary" data-share-submit disabled>' + (state === 'rejected' ? '重新提交审核' : '提交共享审核') + '</button>') +
          '</details>' : '');
      layer.querySelector('#capModalFoot').innerHTML = '<span class="cap-package-footnote">只读预览 · 不运行包内脚本</span><span class="push"></span><button class="btn-mini" data-package-download>下载完整包</button>';
      if (info.canDelete && !info.builtIn) {
        const button = document.createElement('button');
        button.className = 'btn-mini cap-delete-action'; button.dataset.skillDelete = name;
        button.textContent = '删除技能'; button.onclick = () => openDeleteSkill(name, info);
        layer.querySelector('#capModalFoot').append(button);
      }
      bindPackage(layer, info.files, (path, offset) => SoduWorkAPI.skillContent(name, info.checksum, path, offset),
        path => SoduWorkAPI.downloadSkill(name, info.checksum, path));
      layer.querySelector('[data-package-download]').onclick = async function () {
        this.disabled = true;
        try { await SoduWorkAPI.downloadSkill(name, info.checksum); }
        catch (error) { say(errorText(error, '下载失败')); }
        finally { this.disabled = false; }
      };
      const submit = layer.querySelector('[data-share-submit]');
      if (submit) {
        layer.querySelector('[data-share-consent]').onchange = function () { submit.disabled = !this.checked; };
        submit.onclick = async function () {
          submit.disabled = true;
          try {
            await SoduWorkAPI.shareSkill(name, { checksum: info.checksum,
              note: layer.querySelector('[data-share-note]').value, resubmit: state === 'rejected' });
            say('共享申请已提交，审核开放后其他客户端可用');
            if (!layer.hidden && layer._skillView === marker) await openSkillDetails(name);
          } catch (error) { say(errorText(error, '共享申请提交失败')); submit.disabled = false; }
        };
      }
    } catch (error) {
      if (layer.hidden || layer._skillView !== marker) return;
      layer.querySelector('#capModalSub').textContent = '暂时无法读取';
      layer.querySelector('#capModalBody').textContent = skillReadError(error, 'Skill 内容读取失败');
      layer.querySelector('#capModalFoot').innerHTML = '<button class="btn-mini" data-detail-retry>重新加载</button>';
      layer.querySelector('[data-detail-retry]').onclick = () => openSkillDetails(name);
    }
  }

  function formatBytes(value) {
    const size = Number(value || 0);
    if (size < 1024) return size + ' B';
    if (size < 1024 * 1024) return (size / 1024).toFixed(1) + ' KB';
    return (size / 1024 / 1024).toFixed(1) + ' MB';
  }

  function openMcpEditor(initial, template, options) {
    return global.SoduWorkConnectorEditor.open(ctx, initial, template, options);
  }

    return { openCreateSkill, chooseSkillPackage, openImportPreview, openSkillDetails, skillCard, openMcpEditor, openDeleteSkill, openDeleteMcp };
  }

  global.SoduWorkCapabilityEditors = { create };
})(window);
