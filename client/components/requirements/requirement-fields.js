/* Task-backed requirement fields; no separate collection/conversion form. */
(function (global) {
  'use strict';
  const esc = value => String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const wired = new WeakSet(), composing = new WeakSet(), visibilityWired = new WeakSet();
  const sectionPaths = {
    content: '<rect x="4" y="3" width="16" height="18" rx="3"/><path d="M8 8h8M8 12h8M8 16h5"/>',
    criteria: '<rect x="4" y="3" width="16" height="18" rx="3"/><path d="m8 12 3 3 5-6"/>',
    settings: '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="2"/><circle cx="15" cy="17" r="2"/>',
    materials: '<path d="m8 13 6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l8-8"/>',
    tags: '<path d="M3 3h8l10 10-8 8L3 11Z"/><circle cx="7.5" cy="7.5" r="1"/>',
  };
  const sectionIcon = name => '<svg class="rq-section-icon" viewBox="0 0 24 24" aria-hidden="true">' +
    (sectionPaths[name] || sectionPaths.content) + '</svg>';
  function normalizeTags(value, limit = 20) {
    if (typeof value === 'string' && value.trim().startsWith('[')) {
      try { const parsed = JSON.parse(value); if (Array.isArray(parsed)) value = parsed; } catch (_) {}
    }
    return [...new Set((Array.isArray(value) ? value : String(value || '').split(/[,，\n]/))
      .map(item => String(item || '').trim()).filter(Boolean))].slice(0, limit);
  }
  function tagChips(tags, disabled = false) {
    return tags.map((tag, index) => '<span class="rq-tag-chip"><span>' + esc(tag) +
      '</span><button type="button" data-rq-tag-remove="' + index + '" aria-label="删除标签：' + esc(tag) +
      '" title="删除标签"' + (disabled ? ' disabled data-rq-locked' : '') + '><span aria-hidden="true">×</span></button></span>').join('');
  }
  function tagHtml(tags, options = {}) {
    const value = normalizeTags(tags), id = options.id || 'rqTags', disabled = options.disabled === true;
    return '<div class="rq-tag-editor" data-rq-tag-editor' + (disabled ? ' aria-disabled="true"' : '') +
      '><div class="rq-tag-chips" data-rq-tag-chips>' + tagChips(value, disabled) +
      '</div><input type="hidden" data-rq-tag-value id="' + esc(id) + '"' + (options.name ? ' name="' + esc(options.name) + '"' : '') +
      ' value="' + esc(JSON.stringify(value)) + '"><input id="' + esc(id) + 'Input" data-rq-tag-input type="text" aria-label="添加标签" placeholder="' +
      (disabled ? '' : '输入标签后按回车') + '" autocomplete="off"' + (disabled ? ' disabled data-rq-locked' : '') + '>' +
      '<span class="rq-tag-limit" data-rq-tag-limit role="status" hidden>最多添加 20 个标签</span></div>';
  }
  function storedTags(field) {
    try { return normalizeTags(JSON.parse(field?.value || '[]')); } catch (_) { return normalizeTags(field?.value); }
  }
  function readTags(field) {
    const value = storedTags(field), input = field?.closest?.('[data-rq-tag-editor]')?.querySelector('[data-rq-tag-input]');
    const pending = input?.disabled ? '' : input?.value || '';
    return normalizeTags([...value, ...normalizeTags(pending)]);
  }
  function validateTags(root) {
    for (const editor of root?.querySelectorAll?.('[data-rq-tag-editor]') || []) {
      const field = editor.querySelector('[data-rq-tag-value]'), input = editor.querySelector('[data-rq-tag-input]');
      if (input.disabled) continue;
      const count = new Set([...storedTags(field), ...String(input.value || '').split(/[,，\n]/).map(value => value.trim()).filter(Boolean)]).size;
      const invalid = count > 20;
      editor.querySelector('[data-rq-tag-limit]').hidden = !invalid;
      if (invalid) { input.focus(); return false; }
    }
    return true;
  }
  function bindTags(root) {
    if (!root?.addEventListener || wired.has(root)) return;
    wired.add(root);
    function update(editor, tags) {
      const field = editor.querySelector('[data-rq-tag-value]');
      if (field.value === JSON.stringify(tags)) return;
      field.value = JSON.stringify(tags);
      editor.querySelector('[data-rq-tag-chips]').innerHTML = tagChips(tags);
      field.dispatchEvent(new Event('input', {bubbles: true}));
    }
    function commit(editor) {
      const input = editor.querySelector('[data-rq-tag-input]');
      if (input.disabled || composing.has(input)) return;
      const values = storedTags(editor.querySelector('[data-rq-tag-value]'));
      const pending = normalizeTags(input.value, Infinity), combined = [...new Set([...values, ...pending])];
      const warning = editor.querySelector('[data-rq-tag-limit]');
      warning.hidden = combined.length <= 20;
      if (combined.length > 20) return;
      input.value = ''; update(editor, combined);
    }
    root.addEventListener('keydown', event => {
      const input = event.target.closest('[data-rq-tag-input]');
      if (!input || input.disabled || event.key !== 'Enter' || event.isComposing || event.keyCode === 229 || composing.has(input)) return;
      event.preventDefault(); event.stopPropagation(); commit(input.closest('[data-rq-tag-editor]'));
    });
    root.addEventListener('compositionstart', event => {
      const input = event.target.closest('[data-rq-tag-input]');
      if (input) composing.add(input);
    });
    root.addEventListener('compositionend', event => {
      const input = event.target.closest('[data-rq-tag-input]');
      if (input) composing.delete(input);
    });
    root.addEventListener('focusout', event => {
      const input = event.target.closest('[data-rq-tag-input]');
      if (!input) return;
      const editor = input.closest('[data-rq-tag-editor]');
      // Keep the native pointer target alive between focusout and click.
      const remove = event.relatedTarget?.closest?.('[data-rq-tag-remove]');
      if (remove?.closest('[data-rq-tag-editor]') === editor) return;
      commit(editor);
    });
    root.addEventListener('click', event => {
      const button = event.target.closest('[data-rq-tag-remove]');
      if (!button || button.disabled) return;
      const editor = button.closest('[data-rq-tag-editor]'), values = storedTags(editor.querySelector('[data-rq-tag-value]'));
      if (editor.querySelector('[data-rq-tag-input]').disabled) return;
      values.splice(Number(button.dataset.rqTagRemove), 1);
      update(editor, values); editor.querySelector('[data-rq-tag-limit]').hidden = true;
      editor.querySelector('[data-rq-tag-input]').focus();
    });
  }
  function visibilityDescription(value, scope) {
    if (scope === 'repository') return '仓库成员可查看需求内容；执行会话和日志仍按原有权限访问。';
    if (scope === 'organization') value = 'organization';
    return value === 'organization' ? '同公司成员可查看需求内容；执行会话和日志仍按原有权限访问。' :
      '仅相关人可查看需求内容；执行会话和日志仍按原有权限访问。';
  }
  function visibilityHint(value, id, scope) {
    return '<span class="rq-visibility-hint" id="' + esc(id) + '">' + visibilityDescription(value, scope) + '</span>';
  }
  function bindVisibility(root) {
    if (!root?.addEventListener || visibilityWired.has(root)) return;
    visibilityWired.add(root);
    root.addEventListener('change', event => {
      const select = event.target.closest('[data-rq-visibility]');
      if (!select || select.disabled) return;
      const hint = root.querySelector('#' + select.getAttribute('aria-describedby'));
      if (hint) {
        const text = visibilityDescription(select.value);
        hint.textContent = global.SoduWorkI18n?.translateText?.(text) || text;
      }
    });
  }
  function html(draft, options) {
    const kinds = global.Requirements?.kinds || { requirement: '需求', bug: 'Bug', ticket: '工单', improvement: '优化', other: '其它' };
    return '<div class="cp-row cp-requirement-fields"><label class="cp-k" for="cpKind">类型</label>' +
      '<select id="cpKind">' + Object.entries(kinds).map(([key, label]) => '<option value="' + key + '"' +
        (draft.kind === key ? ' selected' : '') + '>' + esc(label) + '</option>').join('') + '</select>' +
      '<label class="cp-k cp-k2" for="cpVisibility">可见范围</label><select id="cpVisibility" data-rq-visibility aria-describedby="cpVisibilityHint">' +
      '<option value="related"' + (draft.visibility !== 'organization' ? ' selected' : '') + '>仅相关人</option>' +
      '<option value="organization"' + (draft.visibility === 'organization' ? ' selected' : '') + '>同公司可见</option></select></div>' +
      visibilityHint(draft.visibility, 'cpVisibilityHint') +
      '<div class="cp-row cp-requirement-fields"><label class="cp-k" for="cpTagsInput">标签</label>' +
      tagHtml(draft.tags, {id: 'cpTags'}) + '</div>' +
      (options?.saveOnly ? '<div class="cp-row cp-requirement-fields"><label class="cp-k" for="cpTriage">加入阶段</label><select id="cpTriage">' +
        [['intake', '收集箱'], ['clarifying', '收集箱 · 待补充'], ['ready', '待开始']].map(([key,label]) => '<option value="' + key + '"' +
          ((draft.triageStage || options.triageStage || 'intake') === key ? ' selected' : '') + '>' + label + '</option>').join('') + '</select></div>' : '');
  }
  global.RequirementFields = { html, tagHtml, bindTags, readTags, validateTags, normalizeTags, sectionIcon, visibilityHint, bindVisibility };
})(window);
