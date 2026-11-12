/* Account-scoped notice history. IndexedDB owns durable remote records and
   receipt markers; localStorage remains the small transient-notice cache. */
(function (global) {
  'use strict';
  function create() {
    if (!global.indexedDB || !global.navigator?.locks) return null;
    let opening, cached;
    const request = operation => new Promise((resolve, reject) => {
      operation.onsuccess = () => resolve(operation.result);
      operation.onerror = () => reject(operation.error);
    });
    function open() {
      if (!opening) opening = new Promise((resolve, reject) => {
        const operation = global.indexedDB.open('soduwork-notices-v1', 1);
        let failed = false;
        operation.onupgradeneeded = () => {
          const db = operation.result;
          db.createObjectStore('rows', { keyPath: ['scope', 'id'] }).createIndex('scope', 'scope');
          db.createObjectStore('meta', { keyPath: 'scope' });
        };
        operation.onerror = () => { failed = true; opening = null; reject(operation.error); };
        operation.onblocked = () => { failed = true; opening = null; reject(Error('Notice storage upgrade is blocked')); };
        operation.onsuccess = () => {
          const db = operation.result;
          if (failed) { db.close(); return; }
          db.onversionchange = () => { db.close(); opening = null; cached = null; };
          db.onclose = () => { opening = null; cached = null; };
          resolve(db);
        };
      }).catch(error => { opening = null; throw error; });
      return opening;
    }
    const done = transaction => new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error || Error('Notice transaction aborted'));
      transaction.onerror = () => {};
    });
    async function snapshot(db, scope) {
      const tx = db.transaction(['rows', 'meta'], 'readonly'), complete = done(tx);
      const metaRequest = tx.objectStore('meta').get(scope);
      // Queue the record read in the same transaction as its revision read.
      const rowsRequest = tx.objectStore('rows').index('scope').getAll(global.IDBKeyRange.only(scope));
      const [meta, records] = await Promise.all([request(metaRequest), request(rowsRequest), complete]);
      if ((meta && (!meta.value || typeof meta.value !== 'object' || Array.isArray(meta.value) || !Number.isSafeInteger(meta.version))) ||
          records.some(row => !row.value || row.value.id !== row.id || !row.value.serverMessageId))
        throw Error('Invalid durable notice records');
      return { scope, version: meta?.version || 0, meta: meta?.value || {}, rows: records.map(row => row.value) };
    }
    async function update(scope, legacy, change) {
      return global.navigator.locks.request('soduwork-notices:' + scope, async () => {
        const db = await open();
        const tx = db.transaction('meta', 'readonly'), complete = done(tx);
        const [head] = await Promise.all([request(tx.objectStore('meta').get(scope)), complete]);
        if (!cached || cached.scope !== scope || cached.version !== (head?.version || 0)) cached = await snapshot(db, scope);
        const original = cached, input = legacy(), byId = new Map(original.rows.map(row => [row.id, row]));
        for (const row of input.rows) if (row?.serverMessageId && row.id && !byId.has(row.id)) byId.set(row.id, row);
        const meta = structuredClone(original.meta);
        for (const field of ['ids', 'readIds', 'presentedIds']) {
          if (Array.isArray(input.meta[field])) meta[field] = [...new Set([...(meta[field] || []), ...input.meta[field]])];
        }
        const state = { rows: [...byId.values()], meta };
        const result = change(state);
        if (result?.stale) return result;
        const previous = new Map(original.rows.map(row => [row.id, row]));
        const writes = [];
        for (const row of state.rows) {
          if (!row?.serverMessageId || !row.id) continue;
          const old = previous.get(row.id); previous.delete(row.id);
          if (old !== row && JSON.stringify(old) !== JSON.stringify(row)) writes.push({ scope, id: row.id, value: row });
        }
        const changed = writes.length || previous.size || JSON.stringify(original.meta) !== JSON.stringify(state.meta);
        const version = original.version + (changed ? 1 : 0);
        if (changed) {
          const write = db.transaction(['rows', 'meta'], 'readwrite', { durability: 'strict' }), finished = done(write);
          try {
            const rows = write.objectStore('rows');
            for (const value of writes) rows.put(value);
            for (const id of previous.keys()) rows.delete([scope, id]);
            write.objectStore('meta').put({ scope, version, value: state.meta });
          } catch (error) {
            write.abort(); await finished.catch(() => {}); throw error;
          }
          await finished;
        }
        cached = { scope, version, rows: state.rows.filter(row => row?.serverMessageId), meta: state.meta };
        // Delete a legacy snapshot only after its replacement is committed and
        // only if another window has not changed that exact source meanwhile.
        input.retire();
        return { ...cached, result, changed: Boolean(changed) };
      });
    }
    return { update, reset() { cached = null; } };
  }
  global.SoduWorkNoticePersistence = { create };
})(window);
