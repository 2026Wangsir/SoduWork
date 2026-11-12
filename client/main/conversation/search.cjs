'use strict';
const accessDefault = require('./history-access');
function excerpt(text, words) {
  text = String(text || '').replace(/\s+/gu, ' ');
  const lower = text.toLocaleLowerCase(), positions = words.map(word => lower.indexOf(word)).filter(index => index >= 0);
  const start = positions.length ? Math.max(0, Math.min(...positions) - 35) : 0;
  return (start ? '…' : '') + text.slice(start, start + 360) + (text.length > start + 360 ? '…' : '');
}

// Reuse the actor-bound archive reader. Search never receives a renderer path,
// queries cloud message services, or writes an additional conversation store.
function create({ app, session, access = accessDefault, read, maxSessions = 500, maxPages = 8, budgetMs = 15000, cacheTtl = 5000, maxCacheBytes = 8 * 1024 * 1024 }) {
  let epoch = 0, cacheOwner = '', cacheBytes = 0;
  const pages = new Map(), readable = access.assertReadable || access.assertOwner;
  function clear() { pages.clear(); cacheBytes = 0; }
  async function search(rawQuery) {
    const query = typeof rawQuery === 'string' ? rawQuery.trim().slice(0, 200) : '';
    const words = query.toLocaleLowerCase().split(/\s+/u).filter(Boolean).slice(0, 12);
    const ticket = ++epoch, captured = access.actor(app), deadline = Date.now() + budgetMs;
    const owner = JSON.stringify([captured.owner, captured.identity?.hub || '', captured.identity?.clientId || '']);
    if (owner !== cacheOwner) { clear(); cacheOwner = owner; }
    for (const [key, entry] of pages) if (entry.expires <= Date.now()) { pages.delete(key); cacheBytes -= entry.bytes; }
    const guard = () => {
      access.assertCurrent(app, captured);
      if (ticket !== epoch) throw Error('SEARCH_CANCELLED');
      if (Date.now() > deadline) throw Error('SEARCH_TIMEOUT');
    };
    guard();
    const result = await session.history(app, Number.MAX_SAFE_INTEGER); guard();
    if (result?.ok === false) throw Error(result.reason || 'SEARCH_HISTORY_UNAVAILABLE');
    const titles = require('./titles');
    const visible = access.visible ? access.visible(app, result.chats || [], captured.identity) : result.chats || [];
    const rows = visible.filter(row => {
      try { readable(app, row.id, captured, row); return true; } catch (_) { return false; }
    }).map(row => titles.decorate(app, row));
    const hits = [], matches = value => words.every(word => value.toLocaleLowerCase().includes(word));
    let partial = rows.length > maxSessions, cursor = 0;
    const work = async () => {
      while (cursor < rows.length) {
        const index = cursor++, row = rows[index]; guard();
        const title = String(row.title || row.name || '');
        const hit = { id: row.id, title, at: row.at || row.updatedAt || 0, text: String(row.summary || '').slice(0, 360) };
        if (!query || matches(title + ' ' + hit.text)) { hits.push(hit); continue; }
        if (row.cloud || (row.adapterId && row.adapterId !== 'pi')) { partial = true; continue; }
        if (index >= maxSessions) continue;
        try {
          let offset = 0, found = false;
          for (let page = 0; page < maxPages; page++) {
            const cacheable = typeof row.path === 'string' && require('node:path').isAbsolute(row.path) && Number(row.at) > 0 && Number.isSafeInteger(row.count);
            const key = JSON.stringify([row.id, row.path || '', row.at || 0, row.count || 0, offset]);
            const cached = pages.get(key);
            let data = cacheable && cached?.expires > Date.now() ? cached.data : null;
            if (!data) {
              if (cached) { pages.delete(key); cacheBytes -= cached.bytes; }
              data = await read('conversations.messages', { id: row.id, offset, limit: 400 }, guard); guard();
              const bytes = Buffer.byteLength(JSON.stringify(data));
              if (cacheable && bytes <= maxCacheBytes) {
                while (pages.size && cacheBytes + bytes > maxCacheBytes) {
                  const oldest = pages.keys().next().value; cacheBytes -= pages.get(oldest).bytes; pages.delete(oldest);
                }
                pages.set(key, { data, bytes, expires: Date.now() + cacheTtl }); cacheBytes += bytes;
              }
            }
            if (data.requiresSegment || data.format !== 'messages') { partial = true; break; }
            const item = (data.items || []).find(message => matches(title + ' ' + message.text));
            if (item) {
              hits.push({ ...hit, text: excerpt(item.text, words), serverMatched: true, messageIndex: offset + data.items.indexOf(item) }); found = true; break;
            }
            if (data.nextOffset == null) { found = true; break; }
            if (!(data.nextOffset > offset)) throw Error('SEARCH_PAGING_STALLED');
            offset = data.nextOffset;
          }
          if (!found) partial = true;
        } catch (error) { guard(); partial = true; }
      }
    };
    await Promise.all([work(), work()]); guard();
    // Ownership may have changed during an asynchronous archive read.
    const checked = new Map(rows.map(row => [row.id, row]));
    return { ok: true, chats: hits.filter(row => {
      try { readable(app, row.id, captured, checked.get(row.id)); return true; } catch (_) { return false; }
    }), partial: query ? partial : false };
  }
  return { search, cancel() { epoch++; }, dispose() { epoch++; clear(); } };
}
function localSession(local) {
  return {
    history: (...args) => local.history(...args),
    historyEntry: (...args) => local.historyEntry(...args),
    async archivedConversation(app, id) {
      const result = await local.historyEntry(app, id);
      return result?.ok ? { ...result.entry, adapterId: 'pi' } : null;
    },
  };
}
function install({ app, ipcMain, BrowserWindow, getRendererRoot }) {
  const trusted = require('../app-menu-info.cjs').createTrustedWindow({ app, BrowserWindow, getRendererRoot });
  const session = require('../agent-runtime/pi-session-bridge');
  const local = {
    async history(app) {
      const chats = []; let after;
      do {
        const page = await session.history(app, { source: 'local', limit: 200, after });
        if (page.ok === false) return page;
        chats.push(...page.chats); after = page.next;
      } while (after);
      return { ok: true, chats };
    },
    indexedHistoryRow: id => session.indexedHistoryRow(id),
    archivedConversation: (_app, id) => session.indexedHistoryRow(id),
    historyEntry: (...args) => require('../pi-session/session').historyEntry(...args),
  };
  const metadata = require('../app-readonly-history.cjs').create({ app, session });
  const searches = new Map();
  ipcMain.handle('conversation-search', async (event, query) => {
    if (!trusted(event)) throw Error('Search requires a trusted application window');
    let service = searches.get(event.sender.id);
    if (!service) {
      service = create({ app, session: local, read: require('../app-readonly-history.cjs').create({ app, session: local,
        readCloud: async () => { throw Error('SEARCH_CLOUD_BODY_UNAVAILABLE'); } }) });
      searches.set(event.sender.id, service);
      event.sender.once('destroyed', () => { service.dispose(); searches.delete(event.sender.id); });
    }
    return service.search(query);
  });
  ipcMain.handle('conversation-search-history', async event => {
    if (!trusted(event)) throw Error('Search requires a trusted application window');
    return metadata('conversations.list', { limit: 5000 }, () => {
      if (event.sender.isDestroyed()) throw Error('SEARCH_CANCELLED');
    });
  });
  ipcMain.on('conversation-search-cancel', (event, clearCache) => {
    if (!trusted(event)) return;
    const service = searches.get(event.sender.id);
    if (clearCache === true) service?.dispose(); else service?.cancel();
  });
}
module.exports = { create, install, localSession };
