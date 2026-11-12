





(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ChatMateMention = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  function mateQuery(value, caret) {
    const source = String(value || '');
    const end = Math.max(0, Math.min(Number(caret == null ? source.length : caret), source.length));
    const before = source.slice(0, end);
    const match = before.match(/(^|\s)@([^\s@/]{0,20})$/u);
    if (!match) return null;
    return {
      start: before.length - match[0].length + match[1].length,
      end,
      query: String(match[2] || '').toLocaleLowerCase(),
    };
  }

  const GREETING = '您好，以下是我当前的工作进展：';
  const uiText = value => (typeof window !== 'undefined' && window.SoduWorkI18n?.translateText?.(value)) || value;

  function progressContext(snapshot, extra) {
    const options = extra || {};
    const messages = ((snapshot || {}).messages || []).filter(m => ['user', 'assistant'].includes(m.role))
      .map(m => ({ role: m.role, text: String(m.text || (m.blocks || []).filter(b => b.kind === 'text')
        .map(b => b.text || '').join('\n')).replace(/\x60\x60\x60[\s\S]*?\x60\x60\x60/g, '').trim() }))
      .filter(m => m.text);
    // Keep the original request and the most recent human-visible exchanges.
    // Tool commands and reasoning blocks never enter the summary request.
    const first = messages[0], selected = [];
    let remaining = 24000 - (first ? Math.min(3000, first.text.length) : 0);
    for (let i = messages.length - 1; i > 0 && selected.length < 59 && remaining > 0; i--) {
      const row = messages[i], text = row.text.slice(0, Math.min(3000, remaining));
      selected.unshift({ role: row.role, text }); remaining -= text.length;
    }
    if (first) selected.unshift({ role: first.role, text: first.text.slice(0, 3000) });
    return { topic: String(options.topic || '').slice(0, 180), state: String(snapshot?.status || ''),
      messages: selected, omittedMessages: Math.max(0, messages.length - selected.length),
      outputs: (options.files || []).slice(0, 20).map(f => String(f.name || '').slice(0, 180)) };
  }

  // Compatibility for a blank/new conversation, not a fabricated AI summary.
  function progressDraft(snapshot, extra) {
    const facts = progressContext(snapshot, extra);
    return uiText(GREETING) + '\n\n' + (facts.messages.length
      ? uiText('当前工作') + '：' + String(facts.topic || facts.messages.find(m => m.role === 'user')?.text || uiText('当前工作')).slice(0, 120) +
        '\n\n' + uiText('请补充已完成的进展和后续安排。')
      : uiText('目前还没有可总结的工作内容，请补充后再发送。'));
  }

  async function conversationOutputs(context) {
    if (!context || !context.ref) return [];
    const result = await context.api.outputs(context.ref);
    if (!result || result.ok === false) throw Error('\u65e0\u6cd5\u8bfb\u53d6\u5f53\u524d\u4f1a\u8bdd\u6210\u679c\uff0c\u8bf7\u91cd\u8bd5');
    let files = (result.artifacts || []).map(file => ({
      key: 'local:' + file.artifactId, artifactId: file.artifactId,
      name: file.name, size: file.size, at: file.at, relative: file.relative, kind: file.kind,
    }));
    // Websites are directories, not lone index.html files. The trusted main
    // process packages sibling CSS/JS/assets into one bounded ZIP.
    const websites = files.filter(file => file.kind === 'website' || /\.html?$/i.test(file.name || ''));
    for (const website of websites.slice(0, 3)) {
      if (typeof context.api.artifactAction !== 'function') break;
      const bundled = await context.api.artifactAction(context.ref, website.artifactId, 'share-related');
      if (!bundled || !bundled.ok || typeof bundled.data !== 'string') continue;
      const parent = String(website.relative || website.name || '').replace(/[^/]+$/, '');
      files = files.filter(file => file !== website && (!parent || !String(file.relative || '').startsWith(parent)));
      files.unshift({ key: 'bundle:' + website.artifactId, name: bundled.name, size: bundled.size,
        at: bundled.at, inlineData: bundled.data, website: bundled.preview || null, kind: 'website-bundle' });
    }
    for (const taskId of [...new Set(context.taskIds || [])]) {
      const rows = await context.hub.listAttachments(taskId);
      if (!Array.isArray(rows)) throw Error('\u65e0\u6cd5\u8bfb\u53d6\u4efb\u52a1\u6210\u679c\uff0c\u8bf7\u91cd\u8bd5');
      rows.filter(row => ['output', 'evidence', 'supporting', 'verification'].includes(row.role)).forEach(row => {
        files.push({ key: 'task:' + row.id, attachmentId: row.id, name: row.filename, size: row.size });
      });
    }
    const rows = [...new Map(files.map(file => [file.key, file])).values()];
    Object.defineProperty(rows, 'truncated', { value: Boolean(result.truncated), enumerable: false });
    return rows;
  }


  async function outputPayload(context, files, messageId) {
    if (files.length > 20) throw Error('一次最多发送 20 份成果，请移除部分文件');
    if (files.reduce((sum, f) => sum + Number(f.size || 0), 0) > 24 * 1024 * 1024)
      throw Error('成果合计不能超过 24 MB，请移除部分文件');
    const prepared = [];
    let bytes = 0;
    for (const file of files) {
      if (file.size > 20 * 1024 * 1024) throw Error('单份成果不能超过 20 MB：' + file.name);
      if (file.attachmentId) { prepared.push({ attachmentId: file.attachmentId }); bytes += Number(file.size || 0); continue; }
      if (typeof file.inlineData === 'string') { prepared.push({ name: file.name, data: file.inlineData }); bytes += Number(file.size || 0);
        if (bytes > 24 * 1024 * 1024) throw Error('\u6210\u679c\u5408\u8ba1\u4e0d\u80fd\u8d85\u8fc7 24 MB'); continue; }
      const result = await context.api.artifactAction(context.ref, file.artifactId, 'share');
      if (!result || !result.ok || typeof result.data !== 'string') throw Error(result?.reason || '无法读取成果：' + file.name);
      if (file.at && result.at !== file.at) throw Error('成果已更新，请重新打开发送卡：' + file.name);
      bytes += Number(result.size || 0);
      if (bytes > 24 * 1024 * 1024) throw Error('成果合计不能超过 24 MB');
      prepared.push({ name: result.name, data: result.data });
    }
    return { conversationId: context?.ref || '', messageId, files: prepared, website: files.find(file => file.website)?.website || undefined };
  }

  function create(options) {
    const o = options || {};
    const input = o.input;
    const host = o.host || (input && input.parentElement);
    if (!input || !host) return null;

    const menu = document.createElement('div');
    menu.className = 'nplugin-menu nmate-menu';
    menu.hidden = true;
    menu.setAttribute('role', 'listbox');
    host.appendChild(menu);

    const card = document.createElement('div');
    card.className = 'nmate-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'false');

    card.hidden = true;
    host.appendChild(card);

    let query = null;
    let mates = [];
    let loaded = false;
    let loading = false;
    let reason = '';
    let active = 0;
    let cardEpoch = 0, directoryEpoch = 0, loadPromise = null;

    function say(message) { if (typeof o.say === 'function') o.say(message); }

    function matches() {
      const q = query ? query.query : '';
      return mates.filter((m) => !q || m.name.toLocaleLowerCase().includes(q) ||
        String(m.org || '').toLocaleLowerCase().includes(q)).slice(0, 12);
    }

    function close() {
      menu.hidden = true;
      menu.replaceChildren();
      query = null;
    }

    function closeCard() {
      cardEpoch++;
      card.hidden = true;
      card.replaceChildren();
    }

    function renderMenu() {
      if (!query) return close();
      menu.replaceChildren();
      menu.hidden = false;
      if (loading && !mates.length) {
        const state = document.createElement('div');
        state.className = 'nplugin-state';
        state.textContent = '正在读取同事清单…';
        menu.appendChild(state);
        return;
      }
      if (!mates.length) {
        const state = document.createElement('div');
        state.className = 'nplugin-state';
        state.textContent = reason || '当前企业还没有其他可联系的同事';
        menu.appendChild(state);
        return;
      }
      const rows = matches();
      if (!rows.length) {
        const state = document.createElement('div');
        state.className = 'nplugin-state';
        state.textContent = '没有匹配的同事';
        menu.appendChild(state);
        return;
      }
      active = Math.min(active, rows.length - 1);
      let lastOrg = null;
      rows.forEach((mate, index) => {
        if (mate.org !== lastOrg) {
          lastOrg = mate.org;
          const head = document.createElement('div');
          head.className = 'nmate-org';
          head.textContent = mate.org || '未分部门';
          menu.appendChild(head);
        }
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'nplugin-option' + (index === active ? ' is-active' : '');
        button.setAttribute('role', 'option');
        button.disabled = !mate.hasBox;
        const icon = document.createElement('i');
        icon.className = 'nplugin-option-icon nmate-avatar';
        icon.textContent = (mate.name || '?').slice(0, 1);
        const copy = document.createElement('span');
        copy.className = 'nplugin-option-copy';
        const title = document.createElement('b');
        title.textContent = mate.name;
        const detail = document.createElement('span');
        detail.textContent = mate.hasBox ? '发一条简短通知到对方 SoduWork' : '还没装 SoduWork，消息送不过去';
        copy.append(title, detail);
        button.append(icon, copy);
        button.addEventListener('mousedown', (event) => event.preventDefault());
        button.addEventListener('click', () => choose(mate));
        menu.appendChild(button);
      });
    }

    function load(force) {
      if (loading) return loadPromise;
      if (loaded && !force) return Promise.resolve();
      const epoch=directoryEpoch;loading=true;renderMenu();
      loadPromise=(async()=>{
        try {
          const payload=typeof o.mates==='function' ? await o.mates() : {mates:[]};
          if(epoch!==directoryEpoch)return;
          mates=(payload?.mates || []).map(m=>({id:String(m.id || ''),name:String(m.name || ''),org:String(m.org || ''),hasBox:Boolean(m.hasBox)}))
            .sort((a,b)=>(a.org || '').localeCompare(b.org || '') || Number(!a.hasBox)-Number(!b.hasBox));
          reason=String(payload?.reason || '');loaded=true;
        } catch(error) {if(epoch===directoryEpoch)reason='拿不到同事清单（后台没连上）';}
        finally {if(epoch===directoryEpoch){loading=false;renderMenu();}}
      })();
      return loadPromise;
    }

    function eraseTrigger() {
      if (!query || query.programmatic) return;
      const value = input.value;
      input.value = value.slice(0, query.start) + value.slice(query.end).replace(/^\s+/, '');
      input.selectionStart = input.selectionEnd = query.start;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }

    function choose(mate) {
      if (!mate || !mate.hasBox) return;
      const prefill=query?.prefill;
      eraseTrigger();
      close();
      openCard(mate,prefill);
    }

    function openCard(mate, prefill) {
      const epoch = ++cardEpoch;
      card.setAttribute('aria-label', '发给 ' + mate.name + ' 的工作进展');
      const context = typeof o.context === 'function' ? o.context() : null;
      let files = [], loadingFiles = true, loadError = '', sending = false, picking = false, outputWarning = '';
      let messageId = crypto.randomUUID();
      const excluded = new Set();
      card.replaceChildren();
      card.hidden = false;
      const head = document.createElement('div');
      head.className = 'nmate-card-head';
      head.innerHTML = '<b></b><span></span>';
      head.querySelector('b').textContent = '发给 ' + mate.name;
      head.querySelector('span').textContent = mate.org || '';
      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'nmate-card-close';
      closeBtn.setAttribute('aria-label', '取消');
      closeBtn.textContent = '×';
      closeBtn.addEventListener('click', () => { closeCard(); input.focus(); });
      head.appendChild(closeBtn);

      const box = document.createElement('textarea');
      box.className = 'nmate-card-text';
      box.setAttribute('aria-label', '工作进展小结');
      box.rows = 6;
      box.maxLength = 500;
      box.placeholder = '想同步什么？内容发出前都可以改…';
      box.value = prefill?.text || '';

      const tools = document.createElement('div');
      tools.className = 'nmate-card-tools';
      const fill = document.createElement('button');
      fill.type = 'button';
      fill.textContent = '重新总结';
      fill.addEventListener('click', () => { void fillProgress(); });
      const blank = document.createElement('button');
      blank.type = 'button';
      blank.textContent = '手动填写';
      blank.addEventListener('click', () => {
        summaryStarted = true; summaryRequest++; summarizing = false;
        box.value = uiText(GREETING) + '\n\n'; messageId = crypto.randomUUID();
        summaryStatus.textContent = '手动填写工作进展，附件可按需勾选'; renderFiles(); box.focus();
      });
      const folder = document.createElement('button');
      folder.type = 'button'; folder.textContent = '\u6dfb\u52a0\u6587\u4ef6\u5939';
      folder.addEventListener('click', async () => {
        if (sending || loadingFiles || picking || typeof context?.api?.pickShareFolder !== 'function') return;
        picking = true; renderFiles();
        try {
          const picked = await context.api.pickShareFolder();
          if (epoch !== cardEpoch || (context?.ref && o.context?.().ref !== context.ref)) return;
          if (picked?.ok && picked.data) {
            files.push({ key: 'folder:' + crypto.randomUUID(), name: picked.name, size: picked.size,
              inlineData: picked.data, kind: picked.website ? 'website-bundle' : 'folder-bundle', website: picked.preview || null });
            outputWarning = picked.website ? '\u7f51\u9875\u5df2\u5b8c\u6574\u6253\u5305\uff0c\u63a5\u6536\u4eba\u65e0\u9700\u4f9d\u8d56\u4f60\u7684 localhost \u6216\u9632\u706b\u5899\u8bbe\u7f6e\u3002' : '';
            messageId = crypto.randomUUID(); renderFiles();
          } else if (picked?.reason) say(picked.reason);
        } catch (error) { say(String(error?.message || '\u6587\u4ef6\u5939\u6253\u5305\u5931\u8d25')); }
        finally { picking = false; if (epoch === cardEpoch) renderFiles(); }
      });
      const addFile = document.createElement('button');
      addFile.type = 'button'; addFile.textContent = '添加文件';
      const picker = document.createElement('input');
      picker.type = 'file'; picker.multiple = true; picker.hidden = true;
      addFile.addEventListener('click', () => picker.click());
      picker.addEventListener('change', async () => {
        const selected = Array.from(picker.files || []);
        picker.value = '';
        if (!selected.length || sending || loadingFiles || picking) return;
        picking = true; renderFiles();
        try {
          // Validate the complete selected batch size before reading files; add attachments only after all reads succeed.
          const active = files.filter(file => !excluded.has(file.key));
          if (active.length + selected.length > 20) throw Error('一次最多发送 20 份成果，请先取消勾选部分文件');
          if (selected.some(file => file.size > 20 * 1024 * 1024)) throw Error('单份成果不能超过 20 MB');
          if ([...active, ...selected].reduce((sum, file) => sum + Number(file.size || 0), 0) > 24 * 1024 * 1024)
            throw Error('成果合计不能超过 24 MB，请先取消勾选部分文件');
          const added = [];
          for (const file of selected) {
            const data = await new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(String(reader.result).split(',')[1]);
              reader.onerror = reader.onabort = () => reject(Error('无法读取文件：' + file.name));
              reader.readAsDataURL(file);
            });
            if (epoch !== cardEpoch || (context?.ref && o.context?.().ref !== context.ref)) return;
            added.push({ key: 'picked:' + crypto.randomUUID(), name: file.name, size: file.size, inlineData: data });
          }
          files.push(...added); messageId = crypto.randomUUID();
        } catch (error) { if (epoch === cardEpoch) say(String(error.message || '无法读取文件')); }
        finally { picking = false; if (epoch === cardEpoch) renderFiles(); }
      });
      tools.append(fill, blank, addFile, folder, picker);

      const summaryStatus = document.createElement('div');
      summaryStatus.className = 'nmate-summary-status';
      summaryStatus.setAttribute('role', 'status');
      let summaryRequest = 0, summaryStarted = prefill?.fromApp === true, summarizing = false;
      if(summaryStarted)summaryStatus.textContent='即用提供的内容，核对后发送';
      async function fillProgress() {
        summaryStarted = true;
        const request = ++summaryRequest;
        summarizing = true;
        summaryStatus.textContent = '正在整理工作进展…';
        renderFiles();
        try {
          if (context?.ref && o.context?.().ref !== context.ref) throw Error('会话已切换，请重新选择同事');
          const result = typeof o.progress === 'function' ? await o.progress(files) : '';
          if (epoch !== cardEpoch || request !== summaryRequest) return;
          const text = typeof result === 'string' ? result : result?.text;
          if (!text || text.length > box.maxLength) throw Error('小结未能生成，请重试或手动填写');
          box.value = text;
          messageId = crypto.randomUUID();
          summaryStatus.textContent = result?.source === 'empty' ? '暂无工作内容，请手动补充后发送' :
            result?.omittedMessages ? '已根据近期对话整理，请核对后发送' : '已整理为工作小结，可修改后发送';
        } catch (error) {
          if (epoch !== cardEpoch || request !== summaryRequest) return;
          /*
           * Show precise backend detail for HTTP errors; use generic wording only for network-level
           * TypeError failures.
           */
          summaryStatus.textContent = error && error.name !== 'TypeError' && error.message
            ? String(error.message).slice(0, 200)
            : '暂时无法总结，请重新总结或手动填写';
        } finally {
          if (epoch === cardEpoch && request === summaryRequest) { summarizing = false; renderFiles(); }
        }
      }
      const send = document.createElement('button');
      send.type = 'button';
      send.className = 'nmate-card-send';
      send.textContent = '发送通知';
      const results = document.createElement('section');
      results.className = 'nmate-results';
      results.setAttribute('aria-live', 'polite');
      function renderFiles() {
        results.replaceChildren();
        const heading = document.createElement('b');
        const selected = files.filter(file => !excluded.has(file.key));
        heading.textContent = loadingFiles ? '正在整理当前会话成果…' : loadError ||
          (files.length ? '随消息发送 · ' + selected.length + ' 份成果' : '当前会话暂无成果，仅发送留言');
        results.appendChild(heading);
        if (outputWarning && !loadingFiles && !loadError) {
          const notice = document.createElement('div');
          notice.className = 'nmate-results-warning';
          notice.textContent = outputWarning;
          results.appendChild(notice);
        }
        if (loadError) {
          const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = '重试读取';
          retry.addEventListener('click', loadFiles); results.appendChild(retry);
        }
        files.forEach(file => {
          const row = document.createElement('label'), check = document.createElement('input');
          row.className = 'nmate-result-row' + (excluded.has(file.key) ? '' : ' is-selected');
          check.type = 'checkbox'; check.checked = !excluded.has(file.key); check.disabled = sending || picking;
          check.addEventListener('change', () => {
            check.checked ? excluded.delete(file.key) : excluded.add(file.key);
            messageId = crypto.randomUUID(); renderFiles();
          });
          const name = document.createElement('span'); name.textContent = file.name; name.title = file.name;
          const size = document.createElement('small'); size.textContent = Math.max(1, Math.ceil((file.size || 0) / 1024)) + ' KB';
          row.append(check, name, size); results.appendChild(row);
        });
        send.disabled = loadingFiles || Boolean(loadError) || sending || summarizing || picking;
        fill.disabled = loadingFiles || sending || summarizing;
        blank.disabled = sending;
        folder.disabled = addFile.disabled = sending || loadingFiles || Boolean(loadError) || picking;
        fill.textContent = summarizing ? '正在总结…' : '重新总结';
      }
      async function loadFiles() {
        loadingFiles = true; loadError = ''; renderFiles();
        try {
          const loaded = await conversationOutputs(context);
          if (epoch !== cardEpoch) return;
          files = loaded;
          if(prefill?.fromApp)files.forEach(file=>excluded.add(file.key));
          if (loaded.truncated || files.length > 20) {
            outputWarning = prefill?.fromApp ? '请选择要发送的成果（最多20份）' : loaded.truncated
              ? '\u6210\u679c\u8f83\u591a\uff0c\u5df2\u5c55\u793a\u6700\u8fd1 60 \u9879\uff1b\u9ed8\u8ba4\u52fe\u9009\u6700\u8fd1 20 \u9879\uff0c\u53ef\u6309\u9700\u8c03\u6574\u3002'
              : '\u672c\u6b21\u6700\u591a\u53d1\u9001 20 \u4efd\u6210\u679c\uff0c\u5df2\u9ed8\u8ba4\u52fe\u9009\u524d 20 \u9879\uff0c\u53ef\u6309\u9700\u8c03\u6574\u3002';
            // Avoid opening a card that can only fail on the first click.
            files.slice(20).forEach(file => excluded.add(file.key));
          }
        }
        catch (error) { if (epoch !== cardEpoch) return; loadError = error.message || '无法读取成果'; }
        finally {
          if (epoch === cardEpoch) {
            loadingFiles = false; renderFiles();
            if (!loadError && !summaryStarted) void fillProgress();
          }
        }
      }
      box.addEventListener('input', () => {
        summaryStarted = true; summaryRequest++; summarizing = false;
        summaryStatus.textContent = '已手动编辑，发送前请确认内容';
        messageId = crypto.randomUUID(); renderFiles();
      });
      send.addEventListener('click', async () => {
        if (sending || loadingFiles || loadError || summarizing || picking) return;
        if (context?.ref && o.context?.().ref !== context.ref) { say('会话已切换，请从当前会话重新选择同事'); return; }
        const text = box.value.trim();
        if (!text || text === GREETING) { say('请补充工作进展后再发'); box.focus(); return; }
        sending = true; box.disabled = true; fill.disabled = blank.disabled = true; renderFiles();
        send.textContent = '正在发送…';
        try {
          const outputs = await outputPayload(context, files.filter(file => !excluded.has(file.key)), messageId);
          if(epoch!==cardEpoch)throw Error('发送卡片或账号已变化，请重新选择同事');
          const result = typeof o.send === 'function' ? await o.send(mate.id, text, outputs) : null;
          if (result && result.ok === false) throw Error(result.reason || '消息没有发出去');
          if (epoch === cardEpoch) closeCard();
          say(result && result.delivered
            ? '已发给 ' + mate.name
            : result?.ok && result.messageId && ['accepted', 'delivered', 'read'].includes(result.status)
              ? '通知已保存，对方上线后可查看'
              : mate.name + ' 现在不在线，这条消息没能送达');
          input.focus();
        } catch (error) {
          sending = false; box.disabled = false; fill.disabled = blank.disabled = false;
          if (epoch === cardEpoch) renderFiles();
          send.textContent = '发送通知';
          say(String(error && error.message || '消息没有发出去'));
        }
      });

      card.append(head, box, tools, summaryStatus, results, send);
      void loadFiles();
      setTimeout(() => box.focus(), 0);
    }

    async function open(options = {}) {
      if(!card.hidden || (query && !menu.hidden))return {ok:false,reason:'请先完成或关闭当前同事发送卡片'};
      if(typeof options.text!=='string' && options.text!=null || String(options.text || '').length>500)return {ok:false,reason:'通知内容最多500字'};
      const epoch=directoryEpoch;await load(true);
      if(epoch!==directoryEpoch)return {ok:false,reason:'SoduWork 账号已变化，请重新选择同事'};
      if(!card.hidden || (query && !menu.hidden))return {ok:false,reason:'请先完成或关闭当前同事发送卡片'};
      const id=String(options.recipientUserId || ''),name=String(options.query || '').replace(/^@/,'').trim().toLocaleLowerCase();
      if(reason && !mates.length)return {ok:false,reason};
      const mate=id ? mates.find(m=>m.id===id) : name ? mates.find(m=>m.name.toLocaleLowerCase()===name) : null;
      if(id || mate) {
        if(!mate || !mate.hasBox)return {ok:false,reason:'这位同事不在可联系目录中或尚未启用 SoduWork'};
        openCard(mate,{fromApp:true,text:String(options.text || '')});return {ok:true,state:'review'};
      }
      query={query:name,programmatic:true,prefill:{fromApp:true,text:String(options.text || '')}};active=0;renderMenu();input.focus();
      return {ok:true,state:'select'};
    }
    function clearScope() {
      directoryEpoch++;mates=[];loaded=false;loading=false;loadPromise=null;reason='';close();closeCard();
    }
    const scopeTarget=typeof window!=='undefined' ? window : document.defaultView;
    scopeTarget?.addEventListener?.('soduwork-data-scope-changed',clearScope);
    function update() {
      query = mateQuery(input.value, input.selectionStart);
      active = 0;
      if (!query) return close();
      renderMenu();
      load(!loaded);
    }

    function onKeydown(event) {
      if (event.isComposing || menu.hidden) return;
      const rows = matches().filter((m) => m.hasBox);
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        close();
        return;
      }
      if (!rows.length) return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        event.stopImmediatePropagation();
        active = (active + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
        renderMenu();
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        event.stopImmediatePropagation();
        choose(rows[active] || rows[0]);
      }
    }

    const onDocumentMouseDown = (event) => {
      const target = event && event.target;
      if (!target || typeof target.closest !== 'function') return;
      if (!target.closest('.nmate-menu') && target !== input) close();
      if (!target.closest('.nmate-card') && target !== input) closeCard();
    };

    const onDocumentKeyDown = event => {
      if (card.hidden || event.isComposing || event.key !== 'Escape') return;
      event.preventDefault(); event.stopImmediatePropagation(); closeCard(); input.focus();
    };

    document.addEventListener('keydown', onDocumentKeyDown, true);
    input.addEventListener('input', update);
    input.addEventListener('click', update);
    input.addEventListener('keydown', onKeydown, true);
    document.addEventListener('mousedown', onDocumentMouseDown);

    return {
      open,
      destroy() {
        directoryEpoch++;scopeTarget?.removeEventListener?.('soduwork-data-scope-changed',clearScope);
        input.removeEventListener('input', update);
        input.removeEventListener('click', update);
        input.removeEventListener('keydown', onKeydown, true);
        document.removeEventListener('mousedown', onDocumentMouseDown);
        document.removeEventListener('keydown', onDocumentKeyDown, true);
        close();
        closeCard();
        menu.remove();
        card.remove();
      },
    };
  }

  return { mateQuery, progressDraft, progressContext, conversationOutputs, outputPayload, create };
});
