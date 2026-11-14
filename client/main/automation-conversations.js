'use strict';

// An automation is one ordinary message in a new ordinary chat. This worker
// only hands off the immutable trigger and records its receipt; the chat engine
// owns tools, streaming, permissions, history and subsequent user messages.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { resultState } = require('./pi-session/task-turn');
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
const { createPoller, POLL_INTERVAL_MS } = require('./automation-conversation-polling.cjs');
const discovery = require('./native-discovery.cjs');
const { imageChoice } = require('../core/model-choice');
const keyOf = (identity, runId) => crypto.createHash('sha256')
  .update(String(identity.hub).replace(/\/+$/, '') + '\n' + identity.clientId + '\n' + runId).digest('hex');

function diskJournal(directory) {
  fs.mkdirSync(directory, { recursive: true });
  function filename(key) {
    if (!/^[a-f0-9]{64}$/.test(key)) throw Error('Invalid automation journal key');
    return path.join(directory, key + '.json');
  }
  return {
    read(key) {
      try { return JSON.parse(fs.readFileSync(filename(key), 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    },
    write(key, record) {
      const target = filename(key), temporary = target + '.tmp';
      const fd = fs.openSync(temporary, 'w', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(record)); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      try {
        fs.renameSync(temporary, target);
      } catch (error) {
        // Some Windows security filters briefly hold a just-written file and
        // reject the atomic rename with EPERM/EACCES/EBUSY. The receipt is
        // local recovery state, so preserve it with a bounded direct-copy
        // fallback instead of turning an already dispatched run red. Do not
        // mask unrelated I/O errors.
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(error && error.code)) throw error;
        try {
          fs.copyFileSync(temporary, target);
          fs.unlinkSync(temporary);
        } catch (_) {
          throw error;
        }
      }
    },
  };
}

function pluginSelection(spec, catalog) {
  if (!spec || !spec.key) return null;
  const plugin = catalog.find(item => item.key === spec.key && item.enabled !== false);
  if (!plugin || !plugin.entrypoints || !plugin.entrypoints.automation) {
    throw Error('该个人插件未安装、已停用或不支持自动化，请检查插件设置');
  }
  if (spec.versionPolicy === 'pinned' &&
      (plugin.version !== spec.version || plugin.checksum !== spec.checksum)) {
    throw Error('个人插件版本与计划锁定的版本不一致，本次未执行；请检查插件版本设置');
  }
  return { pluginId: plugin.pluginId, version: plugin.version, checksum: plugin.checksum };
}

function createWorker({ identityOf, request, journal, conversation, catalog, localModelOf,
  instanceId = crypto.randomUUID(), onError = () => {}, now = Date.now }) {
  let ticking = false, stopped = false;
  let authBlockedUntil = 0, authBlockedIdentity = '', authNoticeSent = false;
  const jobs = new Map();
  const identityKey = identity => identity && identity.hub && identity.clientId
    ? identity.session ? discovery.scopeOf(identity)
      : String(identity.hub).replace(/\/+$/, '') + '\n' + identity.clientId : '';
  const isAuthError = error => !!(error && (error.authRequired || error.permissionRequired ||
    error.status === 401 || error.status === 403));
  function blockIdentity(identity, error) {
    const key = identityKey(identity);
    if (key !== authBlockedIdentity) authNoticeSent = false;
    authBlockedIdentity = key;
    authBlockedUntil = now() + 60_000;
    if (!authNoticeSent) {
      authNoticeSent = true;
      onError(error && error.permissionRequired ? '当前连接没有自动化权限，请重新登录或联系管理员' : '登录已过期，自动化已暂停，请重新连接 SoduWork 服务');
    }
  }
  function save(key, record) { journal.write(key, record); return record; }
  async function acknowledge(identity, id, record, workerId = instanceId) {
    try {
      await request(identity, '/automation-conversations/' + encodeURIComponent(id) + '/state', {
        instanceId: workerId,
        conversationId: record.conversationId || '', state: record.state,
        error: record.error || '',
      });
    } catch (error) {
      if (isAuthError(error)) throw error;
      throw Object.assign(Error('回执连接暂不可用'), { code: 'RECEIPT_UNAVAILABLE' });
    }
  }
  async function processRun(identity, row) {
    const key = keyOf(identity, row.id);
    let record = journal.read(key);
    // Observing a durable chat is not evidence that its execution is alive.
    // Older Hubs can still grant a takeover; do not keep renewing that grant.
    if (record?.phase === 'adopted' && !jobs.has(key)) return;
    if (jobs.has(key) && record?.workerId && record.workerId !== instanceId) return;
    const claimed = await request(identity, '/automation-conversations/' + encodeURIComponent(row.id) + '/claim', { instanceId });
    record = journal.read(key);
    const sameConversation = !!record?.conversationId && record.conversationId === claimed.conversationId;
    if (claimed.terminal) {
      if (claimed.errorCode === 'AUTOMATION_RECEIPT_TIMEOUT' && sameConversation &&
          record?.state === 'succeeded' && record.workerId) await acknowledge(identity, row.id, record, record.workerId);
      jobs.delete(key); return;
    }
    if (claimed.observeOnly) {
      // Only a durable terminal receipt can be retried after restart, using
      // its original owner token. Never revive execution or replay the prompt.
      if (sameConversation && record?.workerId && TERMINAL.has(record.state)) {
        await acknowledge(identity, row.id, record, record.workerId);
      } else if (!jobs.has(key)) {
        save(key, { phase: 'adopted', state: claimed.state || 'running',
          conversationId: claimed.conversationId || '', error: '' });
      }
      return;
    }
    if (!claimed.ok || claimed.busy) return;
    if (record && TERMINAL.has(record.state)) {
      record = save(key, { ...record, workerId: instanceId });
      await acknowledge(identity, row.id, record); jobs.delete(key); return;
    }
    if (record && record.phase === 'sending' && !jobs.has(key)) {
      // A crash between submit and completion is ambiguous. Never replay tools
      // automatically. The saved ordinary chat is still available to continue.
      record = save(key, { ...record, state: 'failed',
        error: record.conversationId
          ? '客户端执行被中断；为避免重复操作未自动重发，请在最近聊天中查看原会话。'
          : '客户端执行被中断；为避免重复操作未自动重发，请检查客户端状态。' });
      await acknowledge(identity, row.id, record); return;
    }
    if (jobs.has(key)) {
      record = save(key, { ...record, state: 'running' });
      await acknowledge(identity, row.id, record); return;
    }
    const input = claimed.input || {};
    try {
      if (claimed.conversationId && (!record || record.conversationId !== claimed.conversationId)) {
        /*
         * The durable Hub receipt is the source of truth for a cross-client handoff.
         * A restarted client can legitimately have no local journal while another
         * client has already opened the ordinary chat.  Treating that receipt as a
         * provider failure used to paint a successful dispatch red and overwrite the
         * schedule's compact last-error field with a foreign-client warning. Adopt the
         * existing conversation as an observed run and clear any stale error; the
         * client that owns the conversation will publish the terminal acknowledgement.
         * We deliberately do not send the prompt again.
         */
        record = save(key, { ...(record || {}), phase: 'adopted', state: 'running',
          conversationId: claimed.conversationId, error: '' });
        return;
      }
      if (input.runId !== row.id || !String(input.text || '').trim()) throw Error('自动化输入不完整，本次未执行');
      if (input.text.length > 50000) throw Error('自动化内容超过单轮长度限制，请精简材料后重试；内容未被截断');
      if (!record && typeof conversation.captureAutomationAccess === 'function') {
        const accessChoice = await conversation.captureAutomationAccess({ adapterId: input.adapterId }, identity, row.id, claimed.trigger);
        // Persist the first choice before any await that can create a runtime.
        // Existing journals without a choice retain their original contract.
        record = save(key, { phase: 'prepared', state: 'running', workerId: instanceId, accessChoice });
      }
      const plugin = pluginSelection(input.personalPlugin, await catalog(input.personalPlugin));
      const modelSource = String(input.modelSource || claimed.modelSource || '').trim().toLowerCase();
      if (modelSource && modelSource !== 'managed' && modelSource !== 'device') {
        throw Error('自动化模型来源无效，请重新保存自动化设置');
      }
      const requestedModel = String(input.modelName || '').trim();
      const localReference = requestedModel.startsWith('local:') ||
        String(imageChoice(requestedModel)?.name || '').startsWith('local:');
      if (modelSource === 'device') {
        // A device-owned model has no usable Hub fallback. New Hubs always
        // return scheduleId in the claim receipt; an older protocol must stop
        // here instead of opening a managed-model conversation.
        if (!claimed.scheduleId) throw Error('当前 Hub 不支持本地模型自动化，请升级 Hub 后重试');
        if (requestedModel && !localReference) {
          throw Error('本地模型自动化的模型名称不能由 Hub 提供');
        }
      } else if (localReference) {
        throw Error('本地模型自动化协议不完整，请重新保存自动化设置');
      }
      const legacyLocal = !modelSource && !requestedModel && claimed.scheduleId &&
        typeof localModelOf === 'function';
      const localModel = (modelSource === 'device' || legacyLocal) && typeof localModelOf === 'function'
        ? await localModelOf(identity, claimed.scheduleId, modelSource === 'device' ? 'device' : 'legacy') : '';
      if (modelSource === 'device' && !String(localModel || '').trim()) {
        throw Error('本地模型选择不可用，请在自动化设置中重新选择');
      }
      const modelName = String(modelSource === 'device' || legacyLocal ? localModel : (requestedModel || '')).trim();
      const options = {
        ...(record && record.conversationId ? { chatId: record.conversationId } : {}),
        ...(input.conversationTitle ? { sessionTitle: String(input.conversationTitle).trim().slice(0, 240) } : {}),
        ...(input.projectId ? { projectId: String(input.projectId).trim().slice(0, 160) } : {}),
        ...(input.repoId ? { repoId: String(input.repoId).trim().slice(0, 160) } : {}),
        // Always pass the field, including an empty value.  Omitting it lets
        // legacy runtimes interpret the request as "reuse the last local
        // model", which can resurrect a stale Runner model instead of using
        // the selected runtime's current default.
        adapterId: input.adapterId, modelName, intent: 'chat',
        cwd: input.cwd || '', capabilities: input.capabilities && input.capabilities.length ? input.capabilities : undefined,
        skills: input.skills,
        ...(plugin ? { pluginLock: plugin } : {}),
      };
      if (record?.accessChoice && claimed.trigger !== 'manual') throw Error('本次自动化授权来源已变化，请重新运行');
      const opened = record?.accessChoice
        ? await conversation.openAutomation(options, identity, record.accessChoice, row.id)
        : await conversation.open(options, identity);
      if (!opened || !opened.ok) throw Error(String(opened && opened.reason || '自动化任务未能启动，请检查当前底座、模型与工作目录后重试'));
      const available = new Set((opened.capabilities || []).map(item => item.id));
      if ((input.capabilities || []).some(id => !available.has(id))) {
        throw Error('本次自动化所需能力尚未安装或授权，请检查能力配置后重试');
      }
      // Publish the chat as soon as it exists. The UI can then move to the
      // ordinary conversation immediately while the first prompt is submitted
      // and streamed there; the prompt itself is still persisted before the
      // running acknowledgement is sent.
      record = save(key, { ...record, phase: 'created', state: 'running', workerId: instanceId,
        conversationId: opened.sessionId });
      await acknowledge(identity, row.id, { ...record, state: 'starting' });
      const currentIdentity = await identityOf();
      if (stopped || !currentIdentity || identityKey(currentIdentity) !== identityKey(identity)) throw Error('客户端停止或连接环境已切换，本次消息未发送');
      if (record.accessChoice && !require('./access-control/automation-access').matches(record.accessChoice, currentIdentity)) throw Error('连接账号已切换，本次消息未发送');
      // Persist BEFORE submitting. Lost completion acknowledgements only retry
      // the receipt, never the original message or its external side effects.
      record = save(key, { ...record, phase: 'sending' });
      const sent = await conversation.send(opened.ref, input.text, input.attachments || [], {
        // Keep scheduled turns on the ordinary conversation path.  Without
        // this marker a local workflow plugin is mistaken for an interactive
        // plugin-debug request by the shared send IPC.
        source: 'automation',
        submissionId: 'automation-' + row.id,
        ...(input.projectId ? { projectId: String(input.projectId).trim().slice(0, 160) } : {}),
        ...(input.repoId ? { repoId: String(input.repoId).trim().slice(0, 160) } : {}),
        plugins: plugin ? [{ pluginId: plugin.pluginId }] : [],
      });
      if (!sent || !sent.ok) throw Error('自动化消息未被接收，请在最近聊天中查看原会话并确认执行状态。');
      // The prompt is now in the ordinary conversation.  Publish its id only
      // after send is accepted so readers always see the complete Q&A chain.
      record = save(key, { ...record, state: 'running' });
      jobs.set(key, true);
      // Subscribe before any receipt I/O. A lost running acknowledgement must
      // never detach the accepted turn from its durable completion receipt.
      const runningReceipt = acknowledge(identity, row.id, record);
      const settle = async (state, error = '') => {
        const settled = save(key, { ...record, state, error });
        jobs.delete(key);
        try {
          // Preserve receipt order even when the conversation finishes before
          // the running request returns. The journal is already terminal.
          await runningReceipt.catch(() => {});
          const current = await identityOf();
          if (current && identityKey(current) === identityKey(identity)) await acknowledge(current, row.id, settled);
        } catch (_) { onError('自动化回执未能写入，本次内容不会自动重发'); }
      };
      Promise.resolve(sent.completion).then(result => {
        const outcome = resultState(result);
        // A resolved completion ends this occurrence. In-chat approvals keep
        // the promise pending; a returned pause requires explicit recovery.
        const state = outcome === 'completed' ? 'succeeded' : 'failed';
        return settle(state, outcome === 'waiting'
          ? '本轮执行已暂停，请在最近聊天中查看原会话并处理待确认事项；本次内容不会自动重发。'
          : outcome === 'stopped' ? '本轮执行已停止，可在最近聊天中查看原会话。'
          : state === 'failed' ? '本轮执行未完成，请在最近聊天中查看原会话了解详细原因。' : '');
      }, () => settle('failed', '本轮执行中断，请在最近聊天中查看原会话；本次内容不会自动重发。'))
        .catch(() => onError('自动化回执未能写入，本次内容不会自动重发'));
      await runningReceipt;
    } catch (error) {
      if (isAuthError(error)) throw error;
      if (error.code === 'RECEIPT_UNAVAILABLE') throw error;
      // Never echo provider errors, local paths, instruction contents or credentials.
      const reason = error.code ? '自动化本地记录暂不可用，请检查客户端后重试' : String(error.message || '自动化未启动').slice(0, 300);
      record = save(key, { ...record, state: 'failed', workerId: instanceId, error: reason });
      await acknowledge(identity, row.id, record);
    }
  }
  async function tick() {
    if (ticking || stopped) return;
    ticking = true;
    let identity;
    try {
      identity = await identityOf();
      if (!identity || !identity.hub || !identity.clientId) return { state: 'idle', scope: '' };
      const key = identityKey(identity);
      if (key !== authBlockedIdentity) { authBlockedIdentity = key; authBlockedUntil = 0; authNoticeSent = false; }
      if (authBlockedUntil > now()) return { state: 'blocked', scope: key, retryAfterMs: authBlockedUntil - now() };
      const inbox = await request(identity, '/automation-conversations/inbox', {});
      const items = inbox.items || [];
      let failed = false;
      for (const row of items) {
        if (stopped) break;
        try { await processRun(identity, row); }
        catch (error) {
          if (isAuthError(error)) throw error;
          failed = true;
          onError('自动化连接或回执同步暂不可用，稍后重试');
        }
      }
      return { state: failed ? 'error' : items.length || jobs.size ? 'active' : 'idle', scope: key,
        ...(discovery.confirmed(identity, 'automation-inbox') ? { pushConfirmed: true } : {}) };
    } catch (error) {
      if (isAuthError(error)) {
        blockIdentity(identity, error);
        return { state: 'blocked', scope: identityKey(identity), retryAfterMs: authBlockedUntil - now() };
      }
      /* Offline/old Hub: no fallback to a second execution route. */
      return { state: 'error', scope: identityKey(identity) };
    }
    finally { ticking = false; }
  }
  return { tick, stop() { stopped = true; } };
}

function install({ app, ipcMain, identityOf, conversation, platformConnections }) {
  require('./automation-preflight.cjs').install({ app, ipcMain, identityOf, platformConnections });
  const localAutomationModels = require('./local-automation-model-store.cjs');
  localAutomationModels.configure({ app, safeStorage: require('electron').safeStorage });
  let worker, poller, unsubscribe, stopped = false;
  ipcMain.handle('automation-conversations-wake', async (event, input) => {
    if (stopped || !require('./platform-connections/index.cjs').trustedSender(event)) return { ok: false };
    const identity = await identityOf(app);
    if (!identity || !input || String(input.hub).replace(/\/+$/, '') !== String(identity.hub).replace(/\/+$/, '')) return { ok: false };
    poller?.wake();
    return { ok: !!poller };
  });
  app.whenReady().then(() => {
    if (stopped) return;
    worker = createWorker({ identityOf: () => identityOf(app),
      request: require('./pi-session/task-input').request,
      journal: diskJournal(path.join(app.getPath('userData'), 'automation-conversations')),
      conversation, catalog: spec => require('./jiyong-scheduled-plugins.cjs').catalog(app,identityOf,spec),
      localModelOf: async (identity, scheduleId, modelSource) => {
        if (!scheduleId) return '';
        const result = localAutomationModels.get({ hub: identity.hub, clientId: identity.clientId,
          owner: require('./device-auth-request').accountScopeKey(identity), scheduleId });
        if (result.needsReselection) throw Error('本地模型选择需要重新确认，请在自动化设置中重新选择');
        if (result.configured && !result.modelName) throw Error('本地模型选择不可用，请在自动化设置中重新选择');
        if (modelSource === 'device' && !result.configured) throw Error('本地模型选择不可用，请在自动化设置中重新选择');
        return String(result.modelName || '');
      },
      onError: message => console.warn('[automation-conversation]', message),
    });
    poller = createPoller({ tick: () => worker.tick() });
    unsubscribe = discovery.register('automation-inbox', () => poller.wake());
    poller.start();
  });
  app.on('before-quit', () => { stopped = true; poller?.stop(); worker?.stop(); unsubscribe?.(); });
}
module.exports = { createWorker, diskJournal, pluginSelection, keyOf, install, POLL_INTERVAL_MS };
