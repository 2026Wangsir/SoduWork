'use strict';

const origins = require('./app-origin.cjs');
const access = require('./history-access');
function create({ app, session, identityOf, preview, history, accountHistory, reattach,
  entry = require('../app-conversation-entry.cjs'), trusted = require('../access-control/preferences').isTrusted }) {
  async function context() {
    const captured = access.actor(app), identity = await identityOf(app);
    access.assertCurrent(app, captured, identity);
    const scope = origins.owner(identity);
    const assertCurrent = () => {
      access.assertCurrent(app, captured);
      const current = origins.owner(access.actor(app).identity);
      if (current.owner !== scope.owner || current.hub !== scope.hub) throw Error('账号或服务已变化，请重新打开会话');
    };
    assertCurrent();
    return { identity, assertCurrent };
  }
  async function remember(handle, sender, identity) {
    const origin = preview.appConversationOrigin(sender);
    if (!origin || !handle?.sessionId) return;
    const captured = access.actor(app, identity), scope = origins.owner(identity);
    const assertCurrent = () => {
      access.assertCurrent(app, captured);
      const current = origins.owner(access.actor(app).identity);
      if (current.owner !== scope.owner || current.hub !== scope.hub) throw Error('账号或服务已变化，请重新打开会话');
      const active = preview.appConversationOrigin(sender);
      if (!active || ['pluginId', 'contributionId', 'origin'].some(key => active[key] !== origin[key]))
        throw Error('应用入口已变化，请重新打开会话');
    };
    await entry.resolve({ app, identityOf }, origin, assertCurrent);
    assertCurrent();
    origins.bind(app, handle.sessionId, identity, origin);
  }
  async function navigate(event, id) {
    if (!trusted(event)) throw Error('请在 SoduWork 主窗口中打开会话');
    if (typeof id !== 'string' || !id || id.length > 512) throw Error('会话标识无效');
    let row = await history?.resolve(id);
    if (!row || !require('./shared-history.cjs').isLocalIdentity(row, id)) row = null;
    if (!row && history?.store) {
      // A strict history filter already rejected this indexed native identity.
      // Do not resurrect it from an older live handle or account-only archive.
      // Remote source locators are not canonical local identities.
      const indexed = await history.store.get(id);
      if (require('./shared-history.cjs').isLocalIdentity(indexed, id))
        throw Error('无法确认这条会话属于当前账号或服务，请切回原连接');
    }
    const accountAlias = !row && accountHistory?.isAccountConversation?.(id);
    if (!accountAlias && !origins.exists(app, row?.id || id)) return { ok: true, handled: false };
    const { identity, assertCurrent } = await context();
    if (accountAlias) {
      const projection = await accountHistory.row(id);
      if (projection) access.assertOwner(app, id, access.actor(app, identity), projection);
      if (projection?.deleted) throw Error('这个会话已经删除');
      row = await require('./account-native-source.cjs').resolve({ app, session, item: projection, identity });
    }
    const canonical = row?.id || id;
    const origin = origins.read(app, canonical, identity);
    if (!origin) return { ok: true, handled: false };
    const live = session.findBySessionId(canonical);
    row ||= live?.historyRow?.() || await session.archivedConversation?.(app, canonical, { nativeOnly: true });
    // localReplica marks every durable index row, including executable native
    // archives. Only cached copies are passive transcripts, never app runtimes.
    if (!row || row.deleted || row.cached) throw Error('原应用会话不可用，请从原应用打开');
    access.assertOwner(app, canonical, access.actor(app, identity), row);
    assertCurrent();
    const current = preview.appConversationOrigin(event.sender);
    if (current && ['pluginId', 'contributionId', 'origin'].every(key => current[key] === origin[key]))
      return { ok: true, handled: false };
    const recheckIndex = async () => {
      if (history?.store) {
        const indexed = await history.store.get(canonical);
        if (require('./shared-history.cjs').isLocalIdentity(indexed, canonical)) {
          const fresh = await history.resolve(canonical);
          if (!fresh || fresh.deleted || fresh.cached)
            throw Error('无法确认这条会话属于当前账号或服务，请切回原连接');
          access.assertOwner(app, canonical, access.actor(app, identity), fresh);
        }
      }
      assertCurrent();
    };
    const payload = await entry.resolve({ app, identityOf }, origin, assertCurrent);
    await recheckIndex();
    await preview.openAppConversation(event, origin, canonical, payload, assertCurrent, async sender => {
      await recheckIndex();
      const destination = preview.appConversationOrigin(sender);
      if (!destination || ['pluginId', 'contributionId', 'origin'].some(key => destination[key] !== origin[key]))
        throw Error('原应用入口已变化，请重新打开');
      const retained = session.findBySessionId(canonical);
      if (retained) {
        access.assertOwner(app, canonical, access.actor(app, identity), retained.historyRow?.() || row);
        reattach?.(retained, sender, origin);
      }
    });
    assertCurrent();
    return { ok: true, handled: true, sessionId: canonical };
  }
  return { remember, navigate };
}
module.exports = { create };
