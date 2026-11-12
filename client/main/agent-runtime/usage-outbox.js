'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { replaceFile } = require('../verified-file-replace.cjs');
const { units } = require('./usage-values');

// Checkpoints for one cumulative session must be delivered in order. A failed
// account/session must not starve other sessions, and unacknowledged rows must
// never be evicted to enforce a telemetry buffer limit.
function create(file, onError = () => {}, options = {}) {
  let rows = {}, quarantined = {}, loaded = false, blocked = false, generation = 0;
  let writing = null, dirty = false, active = null, nextScope = '';
  const last = new Map();
  const totals = new Map();
  const tails = new Map();
  function failure(error) { try { onError(error); } catch (_) {} }
  function load() {
    if (loaded) return;
    loaded = true;
    const candidates = [];
    let corrupt = false;
    for (const name of [file, file + '.tmp']) {
      try {
        const doc = JSON.parse(fs.readFileSync(name, 'utf8'));
        if (doc?.v !== 1 || !doc.rows || Array.isArray(doc.rows) || typeof doc.rows !== 'object') throw Error('Invalid usage outbox');
        if (doc.quarantined !== undefined && (!doc.quarantined || Array.isArray(doc.quarantined) ||
            typeof doc.quarantined !== 'object')) throw Error('Invalid usage quarantine');
        if (Object.values(doc.rows).some(row => !row || typeof row !== 'object' ||
            typeof row.hub !== 'string' || typeof row.clientId !== 'string' ||
            !row.payload || typeof row.payload !== 'object' || !row.payload.usage || typeof row.payload.usage !== 'object'))
          throw Error('Invalid usage checkpoint');
        candidates.push(doc);
      } catch (error) { if (error.code !== 'ENOENT') { corrupt = true; failure(error); } }
    }
    candidates.sort((a, b) => (b.generation || 0) - (a.generation || 0));
    if (candidates.length) {
      rows = candidates[0].rows; generation = candidates[0].generation || 0;
      quarantined = candidates[0].quarantined || {};
      // Retain unsafe historical checkpoints in the same atomic document,
      // outside both delivery and cumulative high-water initialization.
      for (const key of options.quarantine?.(rows) || []) {
        if (!Object.hasOwn(rows, key)) continue;
        quarantined[key] = rows[key]; delete rows[key]; dirty = true;
      }
      try { if (options.protectQuarantine?.(quarantined)) dirty = true; }
      catch (error) { failure(error); }
      for (const [key, row] of Object.entries(rows)) if (row.scope) {
        totals.set(row.scope, row.payload?.usage || {}); tails.set(row.scope, key);
      }
    }
    else if (corrupt) blocked = true; // Preserve corrupt evidence; do not overwrite it with an empty queue.
  }
  async function persist() {
    load();
    if (blocked) throw Error('Usage outbox needs recovery');
    if (writing) { await writing; if (dirty) return persist(); return; }
    if (!dirty) return;
    writing = (async () => {
      // Yield before JSON encoding as well as before disk I/O. A conversation
      // observer must not pay for serializing a large offline queue inline.
      await new Promise(resolve => setImmediate(resolve));
      while (dirty) {
        dirty = false;
        const data = JSON.stringify({ v: 1, generation: ++generation, rows,
          ...(Object.keys(quarantined).length ? { quarantined } : {}) });
        try {
          await fs.promises.mkdir(path.dirname(file), { recursive: true });
          await fs.promises.writeFile(file + '.tmp', data, { encoding: 'utf8', mode: 0o600 });
          await replaceFile(file + '.tmp', file);
        } catch (error) { dirty = true; failure(error); throw error; }
      }
    })();
    try { await writing; } finally { writing = null; }
  }
  function enqueue(row) {
    load();
    if (blocked) return false;
    const scope = row.scope;
    const previous = totals.get(scope);
    if (previous && ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'total',
      'costMicrousd', 'requests', 'turns', 'steps', 'durationMs'].every(key =>
      (row.payload.usage[key] || 0) <= (previous[key] || 0)) &&
      (units(row.payload.usage.costUsd || 0, 12) || 0n) <= (units(previous.costUsd || 0, 12) || 0n)) return false;
    if (previous) for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning',
      'total', 'costMicrousd', 'requests', 'turns', 'steps', 'durationMs'])
      row.payload.usage[key] = Math.max(previous[key] || 0, row.payload.usage[key] || 0);
    if (previous?.costUsd && (units(previous.costUsd, 12) || 0n) > (units(row.payload.usage.costUsd || 0, 12) || 0n))
      row.payload.usage.costUsd = previous.costUsd;
    row.payload.usage.cost = row.payload.usage.costMicrousd / 1000000;
    row.signature = JSON.stringify({ ...row.payload, occurredAt: '' });
    if (last.get(scope) === row.signature) return false;
    totals.delete(scope); totals.set(scope, { ...row.payload.usage });
    if (totals.size > 1000) totals.delete(totals.keys().next().value);
    // Only coalesce an unsent tail from the same day and attribution. Changing
    // model/day preserves the earlier checkpoint even while fully offline.
    const tailKey = tails.get(scope), tail = tailKey && rows[tailKey] ? [tailKey, rows[tailKey]] : null;
    const key = tail && tail[1] !== active && tail[1].bucket === row.bucket
      ? tail[0] : crypto.randomUUID();
    rows[key] = row;
    tails.set(scope, key);
    last.delete(scope); last.set(scope, row.signature);
    if (last.size > 1000) last.delete(last.keys().next().value);
    dirty = true;
    void persist().catch(() => {});
    return true;
  }
  async function drain(post, limit = 30) {
    load();
    await persist();
    const failed = new Set(), groups = new Map();
    for (const entry of Object.entries(rows)) {
      const value = entry[1];
      const scope = value.scope || JSON.stringify([value.hub, value.clientId, value.payload?.idempotencyKey]);
      if (!groups.has(scope)) groups.set(scope, []);
      groups.get(scope).push(entry);
    }
    const scopes = [...groups.keys()];
    const start = Math.max(0, scopes.indexOf(nextScope));
    let sent = 0;
    for (let offset = 0; offset < scopes.length && sent < limit; offset++) {
      const index = (start + offset) % scopes.length, scope = scopes[index];
      nextScope = scopes[(index + 1) % scopes.length];
      for (const [key, row] of groups.get(scope)) {
        if (sent >= limit) break;
        active = row; sent++;
        try {
          await post(row);
          // Object identity fences observations arriving in the same millisecond.
          if (rows[key] === row) {
            delete rows[key]; dirty = true;
            if (tails.get(scope) === key) tails.delete(scope);
          }
        } catch (_) { failed.add(scope); break; }
        finally { active = null; }
      }
    }
    await persist();
    return { pending: Object.keys(rows).length, failed: failed.size > 0 };
  }
  return { enqueue, drain, persist, pending() { load(); return Object.keys(rows).length; } };
}
module.exports = { create };
