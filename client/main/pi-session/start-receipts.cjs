'use strict';
// Ordered transport receipts never store auth tokens. Frozen delivery bytes
// precede completion so network failure cannot silently lose task artifacts.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { connectionScope } = require('../platform-connections/runtime.cjs');
const { assertNoLinks } = require('../plugin-resources');

function destination(identity) {
  return connectionScope(identity) + '|' + String(identity.hub).replace(/\/+$/, '');
}

function create({ app, identityOf, request, intervalMs = 15000 }) {
  const root = path.join(app.getPath('userData'), 'task-start-receipts');
  let flushing = null;
  const inflight = new Map();
  function file(id) { return path.join(root, id + '.json'); }
  function save(id, row) {
    assertNoLinks(app.getPath('userData'), root);
    fs.mkdirSync(root, {recursive: true, mode: 0o700});
    const target = file(id), temporary = target + '.tmp';
    assertNoLinks(root, target); assertNoLinks(root, temporary);
    const fd = fs.openSync(temporary, 'w', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(row)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, target);
  }
  function remove(id) {
    try { fs.unlinkSync(file(id)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  function read(id) {
    const target = file(id);
    let row;
    try {
      assertNoLinks(app.getPath('userData'), root); assertNoLinks(root, target);
      row = JSON.parse(fs.readFileSync(target, 'utf8'));
    }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (![row.taskId, row.conversationId, row.turnId, row.destination].every(value => typeof value === 'string' && value))
      throw Error('Invalid task receipt');
    // Upgrade receipts saved before terminal delivery was made durable.
    if (!Array.isArray(row.steps)) row.steps = [{action: 'started'}];
    if (!row.steps.length || row.steps.length > 8 || row.steps.some(step =>
      !['started', 'deliver', 'complete', 'fail', 'wait', 'cancel'].includes(step?.action))) throw Error('Invalid task receipt steps');
    return row;
  }
  function send(id) {
    if (inflight.has(id)) return inflight.get(id);
    const pending = (async () => {
      while (true) {
        const row = read(id);
        if (!row) return {pending: false};
        const current = await identityOf(app);
        if (destination(current) !== row.destination) throw Error('连接或账号已切换，执行收据保留待同步');
        const step = row.steps[0];
        try {
          if (step.action === 'deliver') await require('./task-delivery.cjs').send(current,
            '/tasks/' + encodeURIComponent(row.taskId), {conversationId: row.conversationId, turnId: row.turnId}, step.payload);
          else await request(current, '/tasks/' + encodeURIComponent(row.taskId) + '/conversation-turn', {
            action: step.action, executor: 'native', conversationId: row.conversationId, turnId: row.turnId,
            ...(row.modelSource === 'device' ? { modelSource: 'device', agentId: row.modelAgentId } : {}),
            ...(['auto', 'manual'].includes(step.submissionMode) ? {submissionMode: step.submissionMode} : {}),
          });
        } catch (error) {
          // Revoked ownership, cancelled/replaced turns must never be resurrected.
          if (![404, 409].includes(error.status)) throw error;
          remove(id); return {pending: false, obsolete: true};
        }
        // Completion may have been appended while the start request was in flight.
        // Merge the acknowledgement into the latest durable row, not our snapshot.
        const latest = read(id);
        if (!latest) return {pending: false};
        if (latest.steps[0].action !== step.action) throw Error('Task receipt order changed');
        latest.steps.shift();
        if (latest.steps.length) save(id, latest);
        else remove(id);
      }
    })().finally(() => inflight.delete(id));
    inflight.set(id, pending); return pending;
  }
  async function enqueue(target, taskId, scope, terminal, started = true, delivery) {
    const base = {destination: target, taskId: String(taskId),
      conversationId: String(scope.conversationId), turnId: String(scope.turnId)};
    const id = crypto.createHash('sha256').update(JSON.stringify(base)).digest('hex');
    const row = read(id) || {...base,
      ...(scope.modelSource === 'device' ? { modelSource: 'device', modelAgentId: String(scope.modelAgentId || '') } : {}), steps: []};
    if (scope.modelSource && (row.modelSource || 'managed') !== scope.modelSource)
      throw Error('Task receipt model source changed');
    if (started && !row.steps.some(step => step.action === 'started')) row.steps.unshift({action: 'started'});
    if (delivery && !row.steps.some(step => step.action === 'deliver')) {
      const terminalIndex = row.steps.findIndex(step => ['complete', 'fail', 'wait', 'cancel'].includes(step.action));
      row.steps.splice(terminalIndex < 0 ? row.steps.length : terminalIndex, 0, {action: 'deliver', payload: delivery});
    }
    if (terminal && !row.steps.some(step => ['complete', 'fail', 'cancel'].includes(step.action)) &&
        !row.steps.some(step => step.action === terminal.action)) row.steps.push(terminal);
    save(id, row);
    // Durable acceptance succeeds even offline; the timer/app restart replays it.
    // Filesystem failures above still surface instead of promising nonexistent retry.
    try { return await send(id); }
    catch (_) { return {pending: true}; }
  }
  function flush() {
    if (flushing) return flushing;
    flushing = (async () => {
      let names;
      try { assertNoLinks(app.getPath('userData'), root); names = fs.readdirSync(root); }
      catch (error) { if (error.code === 'ENOENT') return; throw error; }
      for (const name of names.filter(value => /^[a-f0-9]{64}\.json$/.test(value))) {
        const id = name.slice(0, -5);
        try {
          await send(id);
        } catch (_) { /* Keep the durable receipt for this account's next retry. */ }
      }
    })().finally(() => { flushing = null; });
    return flushing;
  }
  const timer = intervalMs > 0 ? setInterval(() => { void flush().catch(() => {}); }, intervalMs) : null;
  timer?.unref?.();
  void flush().catch(() => {});
  return {
    record: (identity, taskId, scope) => enqueue(destination(identity), taskId, scope),
    forTask(identity, taskId) {
      // Freeze ownership while the authenticated preparation token is valid;
      // queued work may start after expiry or after another account logs in.
      const target = destination(identity);
      const record = scope => enqueue(target, taskId, scope);
      record.finish = (scope, body, {started = false, delivery} = {}) => {
        if (!['complete', 'fail', 'wait', 'cancel'].includes(body?.action)) throw Error('Invalid terminal receipt');
        const terminal = {action: body.action,
          ...(['auto', 'manual'].includes(body.submissionMode) ? {submissionMode: body.submissionMode} : {})};
        return enqueue(target, taskId, scope, terminal, started, delivery);
      };
      return record;
    },
    flush, dispose() { if (timer) clearInterval(timer); },
  };
}

module.exports = {create};
