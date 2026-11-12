'use strict';

// Account-filtered projections of the durable device index. The index retains
// other accounts and unknown archives; none of their metadata leaves this view.
const access = require('./history-access');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
async function ownerStamp(app) {
  const hash = crypto.createHash('sha256'), entries = []; let inspected = 0;
  for (const name of ['session-memory-bindings', 'requirement-session-context', 'conversation-runtime-segments', 'conversation-history-owners']) {
    const folder = path.join(app.getPath('userData'), name);
    let files;
    try { files = fs.readdirSync(folder).sort(); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    for (const file of files) {
      if (!/^[a-f0-9]{64}\.json$/.test(file)) continue;
      const full = path.join(folder, file), stat = fs.lstatSync(full, { bigint: true });
      hash.update(name + '/' + file + ':' + stat.mtimeNs + ':' + stat.ctimeNs + ':' + stat.size);
      entries.push({ name, file, full });
      if (++inspected % 100 === 0) await new Promise(resolve => setImmediate(resolve));
    }
  }
  return { stamp: hash.digest('hex'), entries };
}
async function ownerEvidence(app, entries) {
  const records = new Map(); let count = 0;
  for (const entry of entries) {
    const id = entry.file.slice(0, -5);
    if (!records.has(id)) records.set(id, { records: [], legacy: null });
    let value;
    try {
      require('../plugin-resources').assertNoLinks(app.getPath('userData'), entry.full);
      value = JSON.parse(fs.readFileSync(entry.full, 'utf8'));
    } catch (_) { value = { owner: '' }; }
    if (entry.name === 'conversation-history-owners') records.get(id).legacy = value;
    else records.get(id).records.push(value || { owner: '' });
    if (++count % 100 === 0) await new Promise(resolve => setImmediate(resolve));
  }
  return id => records.get(crypto.createHash('sha256').update(String(id)).digest('hex')) || { records: [], legacy: null };
}
function create({ app, store, identityOf }) {
  let selected, epoch = 0, cached, flight;
  function actor() {
    const captured = access.actor(app, identityOf());
    const key = JSON.stringify([captured.readScope, captured.epoch]);
    if (key !== selected) { selected = key; epoch++; cached = null; flight = null; }
    return { ...captured, historyEpoch: epoch };
  }
  function guard(captured) {
    const current = actor();
    if (current.historyEpoch !== captured.historyEpoch || current.readScope !== captured.readScope ||
        current.epoch !== captured.epoch) throw Error('账号或服务已切换，请重新读取会话');
  }
  function readable(row, captured) {
    try { access.assertReadable(app, row.id, captured, row); return true; }
    catch (_) { return false; }
  }
  async function catalog(captured, refresh = false, retry = false) {
    guard(captured);
    if (flight && !refresh) return flight;
    const previous = cached;
    const job = (async () => {
      const { stamp, entries } = await ownerStamp(app);
      let source = await store.catalog(refresh ? undefined : previous?.sourceRevision, true);
      guard(captured);
      if (!source.items && previous?.stamp === stamp) {
        const latest = await ownerStamp(app); guard(captured);
        if (latest.stamp === stamp) return previous;
        if (retry) throw Error('会话归属正在变化，请刷新后重试');
        return catalog(captured, true, true);
      }
      if (!source.items) source = await store.catalog(undefined, true);
      const checked = { ...captured, ownership: await ownerEvidence(app, entries) };
      const items = [], allowed = new Set(), origins = [];
      for (let index = 0; index < source.items.length; index++) {
        const item = source.items[index];
        if (readable({ ...item.ownership, historyAliasIds: item.historyAliasIds }, checked)) {
          const { ownership, ...publicItem } = item;
          publicItem.originIds = [];
          items.push(publicItem); allowed.add(item.id);
          origins.push({ item: publicItem, ownership });
        }
        if (index % 100 === 99) { await new Promise(resolve => setImmediate(resolve)); guard(captured); }
      }
      const claimed = new Set(items.flatMap(item => [item.id, ...item.historyAliasIds]));
      origins.sort((left, right) => right.ownership.at - left.ownership.at || right.item.id.localeCompare(left.item.id));
      for (const { item, ownership } of origins) for (const id of [ownership.source?.id, ownership.source?.conversationId, ownership.sourceSessionId]) {
        if (typeof id !== 'string' || !id || id.length > 512 || /[\x00-\x1f]/.test(id) || claimed.has(id)) continue;
        claimed.add(id); item.originIds.push(id);
      }
      guard(captured);
      const latest = await ownerStamp(app); guard(captured);
      if (latest.stamp !== stamp) {
        if (retry) throw Error('会话归属正在变化，请刷新后重试');
        return catalog(captured, true, true);
      }
      return cached = { workspace: source.workspace + ':' + (captured.readScope || 'signed-out'),
        sourceRevision: source.revision, stamp,
        revision: Math.max(source.revision, (previous?.revision ?? -1) + 1), items, allowed };
    })();
    flight = job;
    try { return await job; } finally { if (flight === job) flight = null; }
  }
  async function assertCatalogCurrent(captured, view) {
    const latest = await ownerStamp(app); guard(captured);
    if (latest.stamp !== view.stamp) { cached = null; throw Error('会话归属已变化，请刷新后重试'); }
  }
  async function page(options = {}, captured = actor()) {
    const limit = options.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw Error('Invalid history page size');
    if (options.catalogRevision !== undefined && (!Number.isSafeInteger(options.catalogRevision) || options.catalogRevision < 0))
      throw Error('Invalid catalog revision');
    const view = await catalog(captured, options.refresh === true);
    if (options.workspace !== undefined && options.workspace !== view.workspace) throw Error('Local history workspace changed');
    const chats = []; let after = options.after, more = false;
    do {
      const batch = await store.list({ after, limit: Math.min(200, limit + 1 - chats.length), archived: options.archived === true });
      guard(captured);
      chats.push(...batch.items.filter(row => view.allowed.has(row.id) && readable(row, captured)));
      after = batch.next; more = !!after;
    } while (after && chats.length <= limit);
    const overflow = chats.length > limit;
    if (overflow) chats.length = limit;
    const last = chats.at(-1);
    await assertCatalogCurrent(captured, view);
    return { ok: true, chats, next: (overflow || more) && last ? { at: last.replicaUpdatedAt, id: last.id } : null,
      localCatalog: { workspace: view.workspace, revision: view.revision,
        ...(options.catalogRevision === view.revision && options.workspace === view.workspace ? {} : { items: view.items }) } };
  }
  async function list(options = {}, captured = actor()) {
    const result = await page(options, captured);
    return { items: result.chats, next: result.next };
  }
  async function directory(after, limit, captured = actor()) {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200)
      throw Error('Invalid local history cursor or page size');
    const view = await catalog(captured), items = []; let cursor = after, hasMore;
    do {
      const batch = await store.directory(cursor, Math.min(200, limit - items.length));
      guard(captured);
      if (batch.hasMore && batch.cursor <= cursor) throw Error('Local history cursor did not advance');
      items.push(...batch.items.filter(row => view.allowed.has(row.id) && readable(row, captured)));
      cursor = batch.cursor; hasMore = batch.hasMore;
    } while (hasMore && items.length < limit);
    await assertCatalogCurrent(captured, view);
    return { items, cursor, hasMore, workspace: view.workspace };
  }
  async function lifecycleRows(captured = actor()) {
    const view = await catalog(captured), rows = await store.lifecycleRows();
    await assertCatalogCurrent(captured, view); return rows.filter(row => view.allowed.has(row.id));
  }
  return { actor, guard, readable, page, list, directory, lifecycleRows };
}
module.exports = { create };
