'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const auth = require('../main/device-auth');
const { identity, sessions } = require('./helpers/platform-session-fixture.cjs');
const { scope } = require('../main/platform-connections/runtime.cjs');
const { create } = require('../main/pi-session/session-owner.cjs');

function fixture(t) {
  const original = { identity: auth.identity, session: auth.session, localOwner: auth.localOwner };
  let current = identity(), owner = scope(current);
  auth.identity = () => current;
  auth.session = () => current?.session || '';
  auth.localOwner = () => owner;
  t.after(() => Object.assign(auth, original));
  return { guard: create({ app: {} }),
    switch(value) { current = value; owner = value ? scope(value) : ''; },
    offline(value) { current = value; },
    expire() { current = { ...current, session: sessions().expired }; },
    refresh() { current = { ...current, session: current.session.split('.')[0] + '.' + 'b'.repeat(64) }; } };
}

test('a registered handle accepts token renewal and same-account local environment changes', t => {
  const f = fixture(t), handle = { ref: 'alice' };
  assert.equal(f.guard.bind(handle, identity()), handle);
  assert.equal(f.guard.assert(handle), handle);
  f.refresh();
  assert.equal(f.guard.canAccess(handle), true);
  const moved = { ...identity(), hub: 'https://second.invalid', clientId: 'device-two',
    session: sessions().otherDevice };
  f.switch(moved);
  assert.equal(f.guard.canAccess(handle), true);
  assert.equal(f.guard.bind(handle, moved), handle);
});

test('account switch, logout and an unregistered ref cannot read or mutate an owned handle', t => {
  const f = fixture(t), handle = { ref: 'same-ref' };
  f.guard.bind(handle, identity());
  assert.equal(f.guard.canAccess({ ref: handle.ref }), false);
  f.switch(identity('two'));
  assert.equal(f.guard.canAccess(handle), false);
  assert.throws(() => f.guard.assert(handle), /账号或服务已变化/);
  assert.throws(() => f.guard.bind(handle, identity('two')), /账号或服务已变化/);
  f.switch(identity());
  assert.equal(f.guard.canAccess(handle), true, 'failed adoption cannot replace the original owner');
  f.switch(null);
  assert.equal(f.guard.canAccess(handle), false);
});

test('desktop history handles retain their original Hub while allowing same-Hub enrollment renewal', t => {
  const f = fixture(t), handle = {};
  f.guard.bind(handle, identity(), { hub: true });
  f.expire(); assert.equal(f.guard.canAccess(handle), true);
  f.switch({ ...identity(), clientId: 'device-two', session: sessions().otherDevice });
  assert.equal(f.guard.canAccess(handle), true);
  f.switch({ ...identity(), hub: 'https://other.invalid' });
  assert.equal(f.guard.canAccess(handle), false);
  assert.throws(() => f.guard.bind(handle, { ...identity(), hub: 'https://other.invalid' }), /服务已变化/);
  f.switch(identity()); assert.equal(f.guard.canAccess(handle), true);
});

test('expired API tokens retain trusted offline ownership until explicit logout', t => {
  const f = fixture(t), handle = {};
  f.guard.bind(handle, identity());
  f.expire();
  assert.equal(f.guard.canAccess(handle), true);
  f.switch(null);
  assert.equal(f.guard.canAccess(handle), false);
});

test('offline archive registration accepts only current enrolled provenance and retains the captured account', t => {
  const f = fixture(t), bare = { ...identity(), secret: 'isolated-device-key' };
  delete bare.session;
  f.offline(bare);
  const captured = f.guard.assertOpen({ identity: { ...bare } }), handle = {};
  f.switch(identity('two'));
  f.guard.bind(handle, bare, { captured });
  assert.equal(f.guard.canAccess(handle), false, 'a later account cannot adopt an in-flight offline open');
  f.switch(identity());
  assert.equal(f.guard.canAccess(handle), true);
  f.offline(bare);
  assert.throws(() => f.guard.assertOpen({ ...bare, hub: 'https://other.invalid' }));
  assert.throws(() => f.guard.assertOpen({ ...bare, secret: 'other-key' }));
  assert.throws(() => f.guard.bind({}, bare, { captured: {} }), /账号或服务已变化/);
  f.switch(null);
  assert.throws(() => f.guard.assertOpen(bare));
});

test('expired-session registration needs the retained token and matching trusted offline account', t => {
  const f = fixture(t), expired = { ...identity(), session: sessions().expired }, handle = {};
  f.offline(expired);
  const captured = f.guard.assertOpen(expired);
  f.guard.bind(handle, expired, { captured });
  assert.equal(f.guard.canAccess(handle), true);
  assert.throws(() => f.guard.bind({}, { ...expired, session: expired.session.split('.')[0] + '.' + 'c'.repeat(64) }),
    /当前账号会话已失效/, 'an arbitrary stale token cannot claim current offline provenance');
  const wrong = Buffer.from(JSON.stringify({ typ: 'device', uid: 'two', cid: expired.clientId,
    iat: 1, exp: 2 })).toString('base64url') + '.' + 'a'.repeat(64);
  f.offline({ ...expired, session: wrong });
  assert.throws(() => f.guard.assertOpen({ ...expired, session: wrong }), /当前账号会话已失效/);
  for (const session of [sessions().future, sessions().wrongType, sessions().missingUid, 'malformed']) {
    f.offline({ ...expired, session });
    assert.throws(() => f.guard.bind({}, { ...expired, session }));
  }
});

test('cloud handles additionally require their original connection, including offline access', t => {
  const f = fixture(t), handle = {};
  f.guard.bind(handle, identity(), { connection: true });
  f.refresh();
  assert.equal(f.guard.canAccess(handle), true);
  f.expire();
  assert.equal(f.guard.canAccess(handle), true);
  f.switch({ ...identity(), hub: 'https://second.invalid' });
  assert.equal(f.guard.canAccess(handle), false);
  f.expire();
  assert.equal(f.guard.canAccess(handle), false, 'offline provenance cannot move a remote view to another Hub');
  f.switch({ ...identity(), clientId: 'device-two', session: sessions().otherDevice });
  assert.equal(f.guard.canAccess(handle), false, 'same-account device migration still changes the cloud connection');
  assert.throws(() => f.guard.bind(handle, identity(), { connection: false }), /账号或服务已变化/);
  f.switch(identity());
  assert.equal(f.guard.canAccess(handle), true);
});

test('failed cleanup quarantines the handle and blocks new runtimes only for its account', t => {
  const f = fixture(t), failed = {}, other = {};
  f.guard.bind(failed, identity()); f.guard.bind(other, identity());
  f.guard.quarantine(failed);
  assert.equal(f.guard.isQuarantined(failed), true);
  assert.equal(f.guard.canAccess(failed), false);
  assert.equal(f.guard.canAccess(other), true);
  assert.throws(() => f.guard.assertOpen({ identity: identity() }), /仍在清理/);
  assert.doesNotThrow(() => f.guard.assertOpen({ identity: identity('two') }));
  f.guard.closed(failed, false);
  assert.throws(() => f.guard.assertOpen({ identity: identity() }), /仍在清理/);
  f.guard.closed(failed, true);
  assert.doesNotThrow(() => f.guard.assertOpen({ identity: identity() }));
  assert.equal(f.guard.canAccess(failed), false, 'confirmed disposal does not revive the stale ref');
  assert.throws(() => f.guard.bind(failed, identity()), /账号或服务已变化/);
});

test('each failed handle needs confirmed cleanup before opening can resume', t => {
  const f = fixture(t), first = {}, second = {};
  for (const handle of [first, second]) { f.guard.bind(handle, identity()); f.guard.quarantine(handle); }
  f.guard.closed(first, true);
  assert.throws(() => f.guard.assertOpen(identity()), /仍在清理/);
  f.guard.closed(second, true);
  assert.doesNotThrow(() => f.guard.assertOpen(identity()));
});

test('unknown failed provenance blocks new runtime creation conservatively', t => {
  const f = fixture(t), handle = {};
  f.guard.quarantine(handle);
  assert.throws(() => f.guard.assertOpen(identity()), /仍在清理/);
  assert.throws(() => f.guard.assertOpen(identity('two')), /仍在清理/);
  f.guard.closed(handle, true);
  assert.doesNotThrow(() => f.guard.assertOpen(identity()));
});
