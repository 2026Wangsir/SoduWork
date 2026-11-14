'use strict';

const { accountScopeKey } = require('./device-auth-request');
const LEGACY_TOPICS = new Set(['remote-screen', 'personal-relay']);
const EXTENDED_TOPICS = new Set(['automation-inbox', 'cloud-execution-sync', 'conversation-projects',
  'models', 'config', 'team-messages', 'quota']);
function scopeOf(identity) {
  let version = '';
  try { version = JSON.parse(Buffer.from(String(identity?.session || '').split('.')[0], 'base64url')).ver ?? ''; } catch (_) {}
  return JSON.stringify([String(identity?.hub || '').replace(/\/+$/, ''),
    identity?.clientId || '', accountScopeKey(identity), version]);
}

// Uses the authenticated account-sync socket, never a renderer event or another
// connection. Messages only wake discovery; HTTP admission remains authoritative.
function create({ now = Date.now, setTimeout: later = setTimeout, clearTimeout: cancel = clearTimeout } = {}) {
  const consumers = new Map();
  let connection = null;
  function register(topic, wake) {
    const entry = { topic, wake };
    consumers.set(entry, entry);
    if (connection?.ready) void heartbeat(connection);
    return () => { consumers.delete(entry); };
  }
  function detach(entry) {
    if (entry?.timer) cancel(entry.timer);
    if (entry?.ackTimer) cancel(entry.ackTimer);
    if (entry?.extendedAckTimer) cancel(entry.extendedAckTimer);
    if (entry && connection === entry) {
      connection = null;
      for (const item of consumers.values()) item.wake();
    }
  }
  async function current(entry) {
    if (entry !== connection || entry.socket.readyState !== 1) return false;
    let identity;
    try { identity = await entry.identityOf(); } catch (_) { return false; }
    if (!identity?.session || scopeOf(identity) !== entry.scope) { detach(entry); return false; }
    return entry === connection;
  }
  async function heartbeat(entry) {
    if (entry.busy || !entry.ready || entry !== connection) return;
    entry.busy = true;
    try {
      if (!await current(entry)) return;
      if (entry.confirmedAt && now() - entry.confirmedAt >= 25000) {
        entry.confirmedAt = 0;
        for (const item of consumers.values()) item.wake();
      }
      const allTopics = [...new Set([...consumers.values()].map(item => item.topic))];
      const topics = allTopics.filter(topic => LEGACY_TOPICS.has(topic));
      if (topics.length) {
        entry.socket.send(JSON.stringify({ t: 'native-discovery', protocol: 1, topics }));
        if (entry.ackTimer) cancel(entry.ackTimer);
        entry.ackTimer = later(() => {
          entry.ackTimer = null;
          if (entry !== connection) return;
          entry.confirmedAt = 0;
          for (const item of consumers.values()) item.wake();
        }, 5000);
        entry.ackTimer?.unref?.();
      }
      const extended = allTopics.filter(topic => EXTENDED_TOPICS.has(topic));
      if (extended.length) {
        // Keep the original v1 frame intact: old Hubs reject unknown topics.
        entry.requestedTopics = new Set(extended);
        entry.socket.send(JSON.stringify({ t: 'native-discovery', protocol: 2, topics: extended }));
        if (entry.extendedAckTimer) cancel(entry.extendedAckTimer);
        entry.extendedAckTimer = later(() => {
          entry.extendedAckTimer = null;
          if (entry !== connection) return;
          const previous = entry.extendedConfirmed;
          entry.extendedConfirmed = new Map();
          for (const item of consumers.values()) if (previous.has(item.topic)) item.wake();
        }, 5000);
        entry.extendedAckTimer?.unref?.();
      }
    } catch (_) {
      entry.confirmedAt = 0;
      const previous = entry.extendedConfirmed;
      entry.extendedConfirmed = new Map();
      for (const item of consumers.values()) if (previous.has(item.topic)) item.wake();
    }
    finally {
      entry.busy = false;
      if (entry === connection) {
        if (entry.timer) cancel(entry.timer);
        entry.timer = later(() => { entry.timer = null; void heartbeat(entry); }, 15000);
        entry.timer?.unref?.();
      }
    }
  }
  function attach(socket, identity, identityOf) {
    detach(connection);
    const entry = { socket, scope: scopeOf(identity), identityOf, ready: false, confirmedAt: 0,
      timer: null, ackTimer: null, extendedAckTimer: null, busy: false,
      requestedTopics: new Set(), extendedConfirmed: new Map() };
    connection = entry;
    return {
      message(value) {
        if (entry !== connection) return;
        if (value?.type === 'ready') {
          entry.ready = true;
          // Reconcile the gap before this authenticated connection was ready.
          for (const item of consumers.values()) if (EXTENDED_TOPICS.has(item.topic)) item.wake();
          // Old Hubs ignore this frame, so a confirmation is required before
          // extending the relay poll beyond its legacy 30-second presence TTL.
          void heartbeat(entry);
        } else if (value?.type === 'native-discovery-ready' && value.protocol === 1) {
          void current(entry).then(ok => {
            if (!ok) return;
            if (entry.ackTimer) cancel(entry.ackTimer);
            entry.ackTimer = null;
            entry.confirmedAt = now();
          });
        } else if (value?.type === 'native-discovery-ready' && value.protocol === 2 && Array.isArray(value.topics)) {
          void current(entry).then(ok => {
            if (!ok || !entry.ready) return;
            if (entry.extendedAckTimer) cancel(entry.extendedAckTimer);
            entry.extendedAckTimer = null;
            const previous = entry.extendedConfirmed;
            entry.extendedConfirmed = new Map(value.topics.filter(topic => entry.requestedTopics.has(topic))
              .map(topic => [topic, now()]));
            for (const item of consumers.values()) {
              if (previous.has(item.topic) !== entry.extendedConfirmed.has(item.topic)) item.wake();
            }
          });
        } else if (value?.type === 'native-discovery' &&
            (LEGACY_TOPICS.has(value.topic) || EXTENDED_TOPICS.has(value.topic))) {
          void current(entry).then(ok => {
            if (!ok) return;
            if (!entry.ready) return;
            for (const item of consumers.values()) if (item.topic === value.topic) item.wake(value);
          });
        }
      },
      close() { detach(entry); },
    };
  }
  return {
    register, attach,
    confirmed(identity, topic) {
      if (EXTENDED_TOPICS.has(topic)) {
        const at = connection?.extendedConfirmed.get(topic);
        return !!connection && connection.scope === scopeOf(identity) && at != null &&
          now() - at < 25000 && connection.socket.readyState === 1;
      }
      if (topic && !LEGACY_TOPICS.has(topic)) return false;
      return !!connection && connection.scope === scopeOf(identity) && connection.confirmedAt > 0 &&
        now() - connection.confirmedAt < 25000 && connection.socket.readyState === 1;
    },
  };
}

module.exports = { ...create(), create, scopeOf };
