'use strict';

// First-message cloud creation. Only explicitly attached files leave this
// device; the local directory and native Agent are never opened or migrated.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const durableFiles = require('../verified-file-replace.cjs');
const { connectionScope: scope } = require('../platform-connections/runtime.cjs');
const attachmentContract = require('../pi-session/attachment-contract');
const digest = data => crypto.createHash('sha256').update(data).digest('hex');
const MAX_BYTES = 96 * 1024 * 1024;
function assertCloudModel(value) {
  const model = String(value || '').trim();
  const image = require('../../core/model-choice').imageChoice(model);
  if (model.startsWith('local:') || image?.name.startsWith('local:')) {
    throw Error('本地模型只能在本机使用，请选择云端可用模型');
  }
}

function create({ app, root, read, save, identity, request, publicRecord }) {
  const pending = new Map();
  function options(input) {
    if (!/^[a-f0-9-]{36}$/i.test(input.requestId || '')) throw Error('云端请求标识无效');
    if (!/^[a-z][a-z0-9._-]{0,47}$/.test(input.agentId || '')) throw Error('请选择执行底座');
    assertCloudModel(input.model);
    const text = String(input.text || '').trim();
    if ((!text && !input.attachments?.length) || text.length > 50000) throw Error('请输入消息或添加附件');
    if (input.skills?.length || input.plugins?.length || input.intent === 'goal') {
      throw Error('云端会话使用服务器已配置的能力；本机技能、插件和目标模式请在本地使用');
    }
    const prep = input.inputPreparation && typeof input.inputPreparation === 'object'
      ? { schemaVersion: 1, userText: String(input.inputPreparation.userText || '').slice(0, 50000),
          fallback: input.inputPreparation.fallback === true } : null;
    return { sessionId: 'cloud-' + input.requestId, agentId: input.agentId,
      text, userText: prep ? prep.userText : text, inputPreparation: prep,
      title: (text || prep?.userText || '附件任务').replace(/\s+/g, ' ').slice(0, 80),
      model: String(input.model || ''), requiredSkills: [] };
  }
  async function files(items) {
    if (!Array.isArray(items) || items.length > 20) throw Error('每次最多添加 20 个附件');
    let total = 0;
    const names = new Set(), result = [];
    for (const item of items) {
      const name = String(item.name || path.basename(item.path || '')).normalize('NFC');
      if (!name || name.length > 200 || name !== name.trim() || name.endsWith('.') || /[\\/:*?"<>|\x00-\x1f\x7f]/.test(name) ||
          /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i.test(name) || names.has(name.toLowerCase())) throw Error('请使用不同名称的普通文件附件');
      names.add(name.toLowerCase());
      let bytes;
      if (item.path) {
        const stat = await fs.stat(item.path);
        if (!stat.isFile()) throw Error('云端暂不支持文件夹附件，请选择文件');
        if (total + stat.size > MAX_BYTES) throw Error('附件总大小不能超过 96 MB');
        bytes = await fs.readFile(item.path);
      } else if (item.data instanceof ArrayBuffer || ArrayBuffer.isView(item.data)) bytes = Buffer.from(item.data instanceof ArrayBuffer ? new Uint8Array(item.data) : item.data);
      else throw Error('附件无法读取，请重新选择');
      total += bytes.length;
      if (!bytes.length) throw Error('不能上传空文件');
      if (total > MAX_BYTES) throw Error('附件总大小不能超过 96 MB');
      result.push({ name, bytes, sha256: digest(bytes), type: String(item.type || item.mimeType || '') });
    }
    return result;
  }
  function selection(items = []) {
    if (!Array.isArray(items) || items.length > 20) throw Error('每次最多添加 20 个附件');
    return items.map(item => [String(item.name || path.basename(item.path || '')).normalize('NFC'),
      item.path ? path.resolve(item.path) : '', item.path ? '' : digest(Buffer.from(item.data instanceof ArrayBuffer ? new Uint8Array(item.data) : item.data || []))]);
  }
  async function submit(record) {
    assertCloudModel(record.cloudStart.options.model);
    const current = await identity(record), form = new FormData();
    form.append('options', JSON.stringify(record.cloudStart.options));
    for (const file of record.cloudStart.files) {
      const bytes = await fs.readFile(file.path);
      if (digest(bytes) !== file.sha256) throw Error('待发送附件已变化，请保留现场后重新创建会话');
      form.append('files', new Blob([bytes], { type: file.type }), file.name);
    }
    // A lost reply cannot cause a new task on retry: requestId is durable.
    const reply = await request(current, '/cloud-conversations/' + record.transferId, { method: 'POST', body: form });
    if (reply.transferId !== record.transferId || !['prepared', 'committing', 'committed', 'aborted'].includes(reply.phase)) throw Error('云端回执不匹配，请重试核对原请求');
    if (reply.source?.sessionId !== record.sessionId || reply.source?.adapterId !== record.adapterId ||
        reply.source?.entryKind !== 'cloud' || reply.phase === 'committed' && (!reply.taskId || !reply.ref)) throw Error('云端会话回执不完整，请重试核对原请求');
    const next = { ...record, phase: reply.phase, taskId: reply.taskId || '', ref: reply.ref || '',
      accepted: reply.accepted === true || record.accepted === true, acceptedAt: reply.acceptedAt || record.acceptedAt || '',
      canAbort: reply.canAbort === true,
      ...(reply.deliveryMode === 'git' ? { deliveryPresentation: 'summary', codeDelivery: reply.codeDelivery || { kind: 'git' } } : {}),
      target: reply.target || null, error: reply.error || '', at: Date.now(),
      remoteState: ['running', 'queued', 'done', 'completed', 'failed', 'stopped'].includes(reply.status) ? reply.status : 'queued' };
    await save(next);
    return { ok: reply.phase === 'committed', sessionId: record.sessionId, handoff: publicRecord(next),
      reason: reply.phase === 'committed' ? '' : reply.error || '正在确认云端是否已接收，请重试核对，消息不会重复派发' };
  }
  async function start(input = {}) {
    const config = options(input), key = config.sessionId;
    if (pending.has(key)) throw Error('正在创建这条云端会话，请稍候');
    const job = (async () => {
      const current = await identity(), old = read(key);
      if (old) await identity(old);
      const chosen = selection(input.attachments);
      if (old) {
        if (JSON.stringify(old.cloudStart?.options) !== JSON.stringify(config) || JSON.stringify(old.cloudStart?.selection) !== JSON.stringify(chosen)) {
          throw Error('上一条云端请求尚需确认，请保持原消息重试，或打开历史会话核对');
        }
        if (old.phase === 'committed') return { ok: true, sessionId: key, handoff: publicRecord(old) };
        if (old.phase === 'aborted') throw Error('这条云端请求已取消，请开启新会话');
        return submit(old);
      }
      const attached = await files(input.attachments || []);
      const cache = path.join(app.getPath('userData'), 'cloud-conversations', input.requestId);
      await fs.mkdir(cache, { recursive: true, mode: 0o700 });
      const stored = [];
      for (const [index, file] of attached.entries()) {
        const target = path.join(cache, 'input-' + index);
        await fs.writeFile(target, file.bytes, { mode: 0o600 });
        stored.push({ name: file.name, path: target, sha256: file.sha256, type: file.type,
          size: file.bytes.length });
      }
      const cwd = path.join(cache, 'results');
      await fs.mkdir(cwd, { recursive: true });
      const record = { sessionId: key, transferId: input.requestId, owner: scope(current), entryKind: 'cloud',
        phase: 'committing', title: config.title, at: Date.now(), cwd, adapterId: config.agentId,
        options: { model: config.model }, cloudStart: { options: config, files: stored, selection: chosen } };
      await fs.mkdir(root, { recursive: true, mode: 0o700 });
      await durableFiles.writeFile(path.join(root, record.transferId + '.view.json'), JSON.stringify({ cwd,
        adapterId: config.agentId, model: config.model,
        snapshot: { messages: [], tools: [], pendingUser: { role: 'user', text: config.text,
          // The cloud cache is not a conversation workspace. Keep the public
          // metadata needed by the shared message renderer, but never expose
          // its local path as a preview reference.
          attachments: attachmentContract.publicFiles(stored.map(file => ({ name: file.name,
            type: file.type, size: file.size }))), sentAt: Date.now(), done: true },
          adapterId: config.agentId, displayName: config.agentId,
          modelSelection: { name: config.model }, execution: { cloud: true }, status: 'idle' } }), { mode: 0o600, flush: true });
      await save(record);
      return submit(record);
    })().finally(() => pending.delete(key));
    pending.set(key, job); return job;
  }
  async function history(hiddenTasks) {
    const current = await identity(), owner = scope(current);
    const syncOwner = require('./cloud-execution-sync').scope(current);
    const entries = await fs.readdir(root).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    const rows = [];
    for (const name of entries.filter(name => /^[a-f0-9]{64}\.json$/.test(name))) {
      let record;
      try { record = JSON.parse(await fs.readFile(path.join(root, name), 'utf8')); }
      catch (error) { console.warn('[cloud-start] Unreadable history receipt:', name, error.code || 'invalid JSON'); continue; }
      if (record.entryKind !== 'cloud' || (record.owner !== owner && (!record.syncOwner || record.syncOwner !== syncOwner))) continue;
      if (record.hidden) {
        if (record.taskId) hiddenTasks?.add(record.taskId);
        continue;
      }
      // The receipt's `cwd` is a private cache on this computer.  It is only
      // used to replay remote artifacts and must never be exposed as a local
      // working directory or inherited by the next local conversation.
      rows.push({ id: record.sessionId, title: record.title, at: record.at, cwd: '',
        workspaceName: '云端环境', workspaceLabel: '云端环境', locationMode: 'remote',
        location: 'cloud', adapterId: record.activeExecutionSelection?.agentId || record.adapterId, taskId: record.taskId || '', state: record.cloudApprovals?.length || record.syncSnapshot?.historyGap || record.syncRecovery?.historyGap || record.syncArtifactsPending ? 'waiting' : record.remoteState || (record.phase === 'committed' ? 'idle' : 'waiting'),
        cloud: true, needsAttention: Boolean(record.cloudApprovals?.length || record.syncSnapshot?.historyGap || record.syncRecovery?.historyGap || record.syncArtifactsPending),
        outputPending: Boolean(record.syncArtifactsPending), outputError: record.syncArtifactError || '',
        historyGap: record.syncSnapshot?.historyGap || (record.syncRecovery?.historyGap ? { reason: 'local-cache-recovery' } : null), cloudApprovals: record.cloudApprovals || [] });
    }
    return { ok: true, chats: rows };
  }
  async function forget(id) {
    const record = read(id);
    if (!record || record.entryKind !== 'cloud') return { ok: false, notFound: true };
    const current = await identity(record);
    if (!record.taskId) throw Error('请先核对这条云端请求是否已接收');
    // Let Hub resolve the current execution. Deletion does not need transcript events.
    const cursor = '?since=2147483647';
    let page;
    if (record.syncId) {
      const details = await request(current, '/cloud-execution-sync/' + encodeURIComponent(record.syncId) + cursor + '&limit=1');
      if (!details?.ok || details.conversation?.id !== record.syncId ||
          details.conversation?.receipt?.taskId !== record.taskId) throw Error('无法核对这条云端会话，请刷新后重试');
      if (details.messages?.length || details.approvals?.length) throw Error('这条云端会话还有待处理的消息或审批，请先处理后再删除');
      page = details.page;
    } else {
      page = await request(current, '/tasks/' + encodeURIComponent(record.taskId) + '/ai-session' + cursor);
    }
    const settledAtHub = page?.persisted && page.taskId === record.taskId && page.finishedAt;
    if (!page?.ok || !page.ref || (page.taskId && page.taskId !== record.taskId) || (page.liveError && !settledAtHub)) {
      throw Error('暂时无法确认最近一轮的执行状态，请检查执行机连接后重试');
    }
    if (['queued', 'dispatching', 'running'].includes(page.status)) throw Error('云端会话仍在执行，请先停止或等待完成');
    if (!['done', 'completed', 'failed', 'stopped', 'cancelled', 'interrupted'].includes(page.status)) {
      throw Error('暂时无法确认最近一轮的执行状态，请稍后重试');
    }
    await identity(record);
    await save({ ...read(id), hidden: true }); // Keep the durable execution fence.
    return { ok: true, id };
  }
  return { start, history, forget, retry: submit };
}
module.exports = { create };
