'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { create, actor } = require('../main/client-domain-cache.cjs');
const settle = () => new Promise(resolve => setImmediate(resolve));
function identity(user = 'alice', device = 'desktop', version = 1) {
  return { hub: 'https://fixture.invalid', clientId: device,
    session: Buffer.from(JSON.stringify({ typ: 'device', uid: user, cid: device, ver: version })).toString('base64url') + '.fixture' };
}
function fixture(t, request = async () => ({ items: [] })) {
  let current = identity(), at = 1000, confirmed = false, calls = 0;
  const timers = new Set(), wake = new Map(), changes = [];
  const cache = create({ identityOf: async () => current, now: () => at,
    discovery: { register(topic, fn) { wake.set(topic, fn); return () => wake.delete(topic); }, confirmed: () => confirmed },
    setTimeout(fn, ms) { const timer = { fn, at: at + ms, unref() {} }; timers.add(timer); return timer; },
    clearTimeout(timer) { timers.delete(timer); }, changed: (...args) => changes.push(args),
    fetch: async (...args) => { calls++; const value = await request(...args); return value instanceof Response ? value : new Response(JSON.stringify(value)); } });
  t.after(() => cache.close());
  return { cache, wake, changes, calls: () => calls, scope: () => actor(current), setIdentity: value => { current = value; },
    confirm: value => { confirmed = value; },
    async advance(ms) { at += ms; for (const timer of [...timers]) if (timer.at <= at) { timers.delete(timer); timer.fn(); } await settle(); },
    read: () => cache.read('conversation-projects', actor(current)) };
}
test('windows share one authenticated project snapshot and cannot mutate its cached rows', async t => {
  const f = fixture(t, async () => ({ items: [{ id: 'one', name: 'Original' }] }));
  const values = await Promise.all(Array.from({ length: 20 }, () => f.read()));
  assert.equal(f.calls(), 1); values[0].items[0].name = 'Local edit';
  assert.equal((await f.read()).items[0].name, 'Original');
});
test('old and mixed Hubs retain the legacy bound; confirmed domains use low frequency reconciliation', async t => {
  const f = fixture(t); await f.read(); await f.advance(10001); await f.read(); assert.equal(f.calls(), 2);
  f.confirm(true); await f.advance(10001); await f.read(); assert.equal(f.calls(), 2);
  f.confirm(false); await f.read(); assert.equal(f.calls(), 3);
});
test('pushes during an older server snapshot collapse into one trailing fetch', async t => {
  let release, entered, version = 0;
  const ready = new Promise(resolve => { entered = resolve; });
  const f = fixture(t, async () => {
    const snapshot = ++version;
    if (snapshot === 1) { entered(); await new Promise(resolve => { release = resolve; }); }
    return { items: [{ id: 'one', revision: snapshot }] };
  });
  const pending = f.read(); await ready;
  await Promise.all(Array.from({ length: 100 }, () => f.cache.invalidate('conversation-projects', f.scope())));
  release(); assert.equal((await pending).items[0].revision, 2); assert.equal(f.calls(), 2);
  await f.advance(50); assert.equal(f.changes.length, 1);
});
test('a continuous invalidation storm cannot starve UI reads or loop without backoff', async t => {
  const f = fixture(t, async () => {
    await f.cache.invalidate('conversation-projects', f.scope());
    return {items: [{id: 'one', revision: f.calls()}]};
  });
  assert.equal((await f.read()).items[0].revision, 2);
  for (let i = 0; i < 100; i++) await f.read();
  assert.equal(f.calls(), 2);
  await f.advance(1000); assert.equal(f.calls(), 4);
});
test('pending notifications from an old scope cannot suppress the new account wake', async t => {
  const f = fixture(t); await f.read();
  await f.cache.invalidate('conversation-projects', f.scope());
  f.setIdentity(identity('bob')); await f.read();
  await f.cache.invalidate('conversation-projects', f.scope());
  await f.advance(50);
  assert.equal(f.changes.length, 1); assert.equal(f.changes[0][1].userId, 'bob');
});
test('offline reads back off even when every window and push asks for a refresh', async t => {
  const f = fixture(t, async () => { throw Error('offline'); });
  await assert.rejects(f.read(), /offline/);
  for (let i = 0; i < 100; i++) {
    await f.cache.invalidate('conversation-projects', f.scope());
    await assert.rejects(f.read(), /offline/);
  }
  assert.equal(f.calls(), 1); await f.advance(5000); assert.equal(f.calls(), 2);
});
test('a new failure pushes an older reconciliation timer beyond the complete backoff', async t => {
  let attempts = 0;
  const f = fixture(t, async () => { if (++attempts === 2) throw Error('offline'); return {items: []}; });
  f.confirm(true); await f.read(); await f.advance(119000);
  await f.cache.invalidate('conversation-projects', f.scope()); await assert.rejects(f.read(), /offline/);
  await f.advance(1000); assert.equal(f.calls(), 2);
  await f.advance(3999); assert.equal(f.calls(), 2);
  await f.advance(1); assert.equal(f.calls(), 3);
});
test('push and reconnect wakes refresh an active snapshot without a renderer read', async t => {
  let revision = 1;
  const f = fixture(t, async () => ({items: [{id: 'one', revision}]}));
  f.confirm(true); await f.read(); revision = 2;
  f.wake.get('conversation-projects')(); await settle();
  await f.advance(1000); assert.equal(f.calls(), 2);
  assert.equal((await f.read()).items[0].revision, 2);
});
test('late reads and cached data cannot cross account, device or authorization versions', async t => {
  for (const next of [identity('bob'), identity('alice', 'other'), identity('alice', 'desktop', 2)]) {
    let release, entered;
    const ready = new Promise(resolve => { entered = resolve; });
    const f = fixture(t, async () => { entered(); await new Promise(resolve => { release = resolve; }); return { items: [{ id: 'private' }] }; });
    const pending = f.read(); await ready; f.setIdentity(next); release(); await assert.rejects(pending, /账号或设备/);
  }
});
test('an obsolete renderer cannot read or invalidate the newly signed in account', async t => {
  const f = fixture(t), previous = f.scope(); f.setIdentity(identity('bob'));
  await assert.rejects(f.cache.read('conversation-projects', previous), /账号或设备/);
  await assert.rejects(f.cache.invalidate('conversation-projects', previous), /账号或设备/);
  assert.equal(f.calls(), 0);
  await assert.rejects(f.cache.read('../../client-auth/me', f.scope()), /不支持/);
});
test('local writes invalidate fresh cache and reconciliation repairs a missed event', async t => {
  let revision = 1; const f = fixture(t, async () => ({ items: [{ id: 'one', revision }] }));
  f.confirm(true); await f.read(); revision = 2;
  await f.cache.invalidate('conversation-projects', f.scope()); assert.equal((await f.read()).items[0].revision, 2);
  revision = 3; await f.advance(120000); assert.equal((await f.read()).items[0].revision, 3);
});
test('model metadata is shared only under its confirmed topic and invalidation refreshes all callers', async t => {
  let model = 'first';
  const f = fixture(t, async () => ({providers: [], usable: [{name: model}], myModels: []}));
  const read = () => f.cache.read('models', f.scope());
  await Promise.all(Array.from({length: 8}, read)); assert.equal(f.calls(), 1);
  await read(); assert.equal(f.calls(), 2, 'old Hub explicit model reload remains a real read');
  f.confirm(true); await read(); assert.equal(f.calls(), 2);
  model = 'second'; await f.cache.invalidate('models', f.scope());
  assert.equal((await read()).usable[0].name, 'second');
});
test('configuration keeps its exact shape and personal caches cannot cross devices', async t => {
  const f = fixture(t, async () => ({theme: 'dark', dockVisible: false}));
  f.confirm(true);
  assert.deepEqual(await f.cache.read('config', f.scope()), {theme: 'dark', dockVisible: false});
  f.setIdentity(identity('alice', 'second-device'));
  await f.cache.read('config', f.scope()); assert.equal(f.calls(), 2);
});
test('periodic reads use the renewed session directly while retaining the same account fence', async t => {
  const sessions = [], original = identity();
  const f = fixture(t, async current => { sessions.push(current.session); return {items: []}; });
  f.confirm(true); await f.read();
  const claims = JSON.parse(Buffer.from(original.session.split('.')[0], 'base64url'));
  const renewed = {...original, session: Buffer.from(JSON.stringify({...claims, jti: 'renewed'})).toString('base64url') + '.fixture'};
  f.setIdentity(renewed); await f.advance(120000);
  assert.deepEqual(sessions, [original.session, renewed.session]);
});
test('message consumers share in-flight snapshots and revalidate explicit reads after capability confirmation', async t => {
  const f = fixture(t, async () => ({ok: true, folder: 'received', items: [], nextCursor: '', revision: 'current'}));
  const read = () => f.cache.read('team-messages-received', f.scope());
  await assert.rejects(read(), error => error.code === 'DOMAIN_POLL_FALLBACK'); assert.equal(f.calls(), 0);
  f.confirm(true); await Promise.all(Array.from({length: 8}, read)); assert.equal(f.calls(), 1);
  await f.advance(60000); await read(); assert.equal(f.calls(), 2);
  f.wake.get('team-messages')(); await settle(); await f.advance(1000); assert.equal(f.calls(), 3);
  f.confirm(false); await assert.rejects(read(), error => error.code === 'DOMAIN_POLL_FALLBACK');
  await f.advance(120000); assert.equal(f.calls(), 3, 'capability loss also stops unconditional background message reads');
});
test('cached transports retain HTTP status and structured failure details, including non-JSON proxies', async t => {
  const body = {detail: {code: 'SERVICE_BUSY', message: 'Busy', retryable: true}};
  const f = fixture(t, async () => new Response(JSON.stringify(body), {status: 503}));
  await assert.rejects(f.read(), error => error.status === 503 && error.httpBody.detail.code === 'SERVICE_BUSY');
  const html = fixture(t, async () => new Response('<html>Unavailable</html>', {status: 503}));
  await assert.rejects(html.read(), error => error.status === 503);
});
test('only a current HTTP response or transport failure reports reachability, never a snapshot or replayed error', async t => {
  let failure;
  const f = fixture(t, async () => { if (failure) throw failure; return {items: []}; });
  const states = [], read = () => f.cache.read('conversation-projects', f.scope(), online => states.push(online));
  f.confirm(true); await read(); await read(); assert.deepEqual(states, [true]);
  failure = Error('offline'); await f.cache.invalidate('conversation-projects', f.scope());
  await assert.rejects(read(), /offline/); await assert.rejects(read(), /offline/);
  assert.deepEqual(states, [true, false]);
  const http = fixture(t, async () => new Response('{}', {status: 503}));
  const httpStates = [], readHttp = () => http.cache.read('conversation-projects', http.scope(), value => httpStates.push(value));
  await assert.rejects(readHttp()); await assert.rejects(readHttp()); assert.deepEqual(httpStates, [true]);
});


test('notification read-through shares concurrent reads and preserves failure and invalidation backoff', async t => {
  for (const domain of ['team-messages-received', 'team-messages-sent']) {
    let failure = false, storm = false;
    const f = fixture(t, async () => {
      if (failure) throw Error('offline');
      if (storm) await f.cache.invalidate(domain, f.scope());
      return {ok: true, items: [], revision: String(f.calls())};
    });
    f.confirm(true);
    const read = () => f.cache.read(domain, f.scope());
    await Promise.all(Array.from({length: 20}, read));
    assert.equal(f.calls(), 1, 'parallel windows share one authenticated response');
    await read();
    assert.equal(f.calls(), 2, 'a later explicit read revalidates authorization even within TTL');
    failure = true;
    await assert.rejects(read(), /offline/);
    for (let i = 0; i < 20; i++) await assert.rejects(read(), /offline/);
    assert.equal(f.calls(), 3, 'fresh reads cannot bypass transport-error backoff');
    failure = false; storm = true;
    await f.advance(5000);
    assert.equal(f.calls(), 5, 'a storm gets only one bounded trailing read');
    for (let i = 0; i < 20; i++) await read();
    assert.equal(f.calls(), 5, 'the short dirty-generation backoff also applies to notification reads');
  }
});


test('notification revalidation wakes consumers only for a changed response, without a refresh loop', async t => {
  let revision = 'original';
  const f = fixture(t, async () => ({ok: true, items: [], revision}));
  f.confirm(true);
  const read = () => f.cache.read('team-messages-received', f.scope());
  await read(); await f.advance(50);
  assert.equal(f.changes.length, 0);
  revision = 'outside'; await read(); await f.advance(50);
  assert.equal(f.changes.length, 1);
  assert.equal(f.changes[0][0], 'team-messages-received');
  await read(); await f.advance(50); // The consumer responding to that wake.
  assert.equal(f.changes.length, 1, 'unchanged authenticated data emits no additional wake');
  assert.equal(f.calls(), 3);
});


test('notification revision ignores freshly signed preview tickets but still stores the latest response', async t => {
  for (const domain of ['team-messages-received', 'team-messages-sent']) {
    let revision = 'original';
    const f = fixture(t, async () => ({ok: true, revision, items: [{id: 'website',
      website: {previewUrl: 'https://fixture.invalid/preview?ticket=signed-' + f.calls()}}]}));
    f.confirm(true);
    const read = () => f.cache.read(domain, f.scope());
    assert.ok((await read()).items[0].website.previewUrl.endsWith('signed-1'));
    assert.ok((await read()).items[0].website.previewUrl.endsWith('signed-2'));
    await f.advance(50);
    assert.equal(f.changes.length, 0, 'a rotated ticket with the same inbox revision must not trigger another refresh');
    revision = 'read-or-company-changed';
    await read(); await f.advance(50);
    assert.equal(f.changes.length, 1, 'authorization and receipt revisions still wake consumers');
    await read(); await f.advance(50);
    assert.equal(f.changes.length, 1, 'the wake consumer cannot restart the signed-ticket refresh loop');
  }
});

test('notification responses without valid revisions retain body change detection', async t => {
  for (const revision of [undefined, null, '', ' ', 0, 17, {}, []]) {
    let currentRevision = revision;
    const f = fixture(t, async () => ({ok: true, revision: currentRevision,
      items: [{id: 'website', website: {previewUrl: 'https://fixture.invalid/?ticket=' + f.calls()}}]}));
    f.confirm(true);
    const read = () => f.cache.read('team-messages-received', f.scope());
    await read(); await read(); await f.advance(50);
    assert.equal(f.changes.length, 1, 'absent or malformed revisions cannot conceal changed rows');
    currentRevision = 'valid'; await read(); await f.advance(50);
    assert.equal(f.changes.length, 2, 'adding a valid revision retains body comparison');
    currentRevision = revision; await read(); await f.advance(50);
    assert.equal(f.changes.length, 3, 'losing the valid revision retains body comparison');
  }
});
