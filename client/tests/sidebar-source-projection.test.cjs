'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
function fixture() {
  const window = { SoduWorkAPI: { clientAuthSnapshot: () => ({ clientId: 'device-one', user: { id: 'owner' } }) } };
  for (const file of ['workspace-chat-history', 'workspace-sidebar-state']) vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, '../components/workspace', file + '.js'), 'utf8'), { window });
  window.WorkspaceSidebarState.setLocalHistory({ workspace: 'source-fixture', revision: 1,
    items: [{ id: 'native', historyAliasIds: ['segment'] }, { id: 'download' }] });
  const values = new Map(), storage = { getItem: key => values.get(key) || null,
    setItem: (key, value) => values.set(key, value) };
  return { window, storage, state: window.WorkspaceSidebarState.create({ storage, key: 'fixture' }) };
}
const native = { id: 'native', title: 'Same question', count: 2, adapterId: 'pi', usedHarnesses: ['pi'], localReplica: true };
const account = { id: 'acct-native', title: 'Same question', accountConversation: true, accountProjection: true,
  sourceClientId: 'device-one', sourceSessionId: 'native', accountCanSend: true, contentLocation: 'source' };
const ids = rows => Array.from(rows, row => row.id);

test('new native persistence and its account directory projection render one row in either arrival order', () => {
  for (const rows of [[native, account], [account, native]]) {
    const f = fixture(), before = JSON.stringify(rows);
    assert.deepEqual(ids(f.state.view(rows).recent), ['native']);
    assert.deepEqual(Array.from(f.state.view(rows).recent[0].usedHarnesses), ['pi']);
    assert.equal(JSON.stringify(rows), before, 'Display reconciliation must not mutate either history source');
  }
});

test('source segments join only by the confirmed local catalog; same titles remain independent', () => {
  const f = fixture(), other = { ...native, id: 'another', usedHarnesses: ['qwen'] };
  assert.deepEqual(ids(f.state.view([native, { ...account, sourceSessionId: 'segment' }, other]).recent), ['native', 'another']);
});

test('foreign devices, readonly originals, cloud content and downloaded copies stay independently reachable', () => {
  for (const patch of [{ sourceClientId: 'foreign' }, { accountCanSend: false },
    { contentLocation: 'hub' }, { sourceSessionId: 'missing' }]) {
    assert.equal(fixture().state.view([native, { ...account, ...patch }]).recent.length, 2);
  }
  const copy = { ...native, id: 'download', cached: true, source: { id: account.id } };
  assert.equal(fixture().state.view([copy, { ...account, sourceSessionId: 'download' }]).recent.length, 2);
  assert.deepEqual(ids(fixture().state.view([account]).recent), [account.id]);
});

test('source projection retains pinned and project placement without rewriting persistent identity or lifecycle aliases', () => {
  const f = fixture();
  f.state.togglePin(account.id, account);
  const project = f.state.saveProject({ name: 'Work' });
  f.state.fileChat(account.id, project, account);
  const stored = f.storage.getItem('fixture'), result = f.state.view([native, account]);
  assert.deepEqual(ids(result.pinned), ['native']);
  assert.deepEqual(ids(result.projects[0].items), ['native']);
  assert.deepEqual(ids(result.recent), []);
  assert.equal(f.storage.getItem('fixture'), stored);
  assert.equal(result.pinned[0].historyAliasIds, undefined, 'Display aliases grant no archive/delete authority');
  assert.deepEqual(ids(f.state.view([account]).pinned), [account.id], 'Removing local content does not remove the account original');
});

test('account changes discard transient display associations and never join matching foreign source IDs', () => {
  const f = fixture(); f.state.view([native, account]);
  f.window.SoduWorkAPI.clientAuthSnapshot = () => ({ clientId: 'device-two', user: { id: 'other' } });
  assert.equal(f.state.view([native, account]).recent.length, 2);
});


test('pin and project actions resolve the displayed source without leaving hidden memberships', () => {
  const f = fixture();
  f.state.togglePin(account.id, account);
  f.state.view([native, account]);
  f.state.togglePin(native.id, native);
  assert.deepEqual(ids(f.state.view([native, account]).pinned), []);
  assert.deepEqual(ids(f.state.view([native, account]).recent), ['native']);
  const project = f.state.saveProject({ name: 'Work' });
  f.state.fileChat(account.id, project, account);
  f.state.move(native, 'recent', '', [native, account]);
  assert.deepEqual(ids(f.state.view([native, account]).projects[0].items), []);
  assert.deepEqual(Array.from(f.state.get().projects[0].chatIds), []);
});

test('native lifecycle cleanup leaves the account record and its organization intact', () => {
  const f = fixture();
  f.state.togglePin(account.id, account);
  f.state.view([native, account]);
  f.state.forget(native.id);
  assert.deepEqual(ids(f.state.view([account]).pinned), [account.id]);
});

test('account switches invalidate display aliases before the next mutation', () => {
  const f = fixture();
  f.state.togglePin(account.id, account);
  f.state.view([native, account]);
  f.window.SoduWorkAPI.clientAuthSnapshot = () => ({ clientId: 'device-two', user: { id: 'other' } });
  f.state.togglePin(native.id, native);
  assert.deepEqual(Array.from(f.state.get().pins), [account.id, native.id]);
});


test('explicit native project membership wins over its account projection without changing stored groups', () => {
  const f = fixture(), first = f.state.saveProject({ name: 'Account' }), second = f.state.saveProject({ name: 'Device' });
  f.state.fileChat(account.id, first, account);
  f.state.fileChat(native.id, second, native);
  const before = f.storage.getItem('fixture'), result = f.state.view([native, account]);
  assert.deepEqual(ids(result.projects.find(p => p.id === first).items), []);
  assert.deepEqual(ids(result.projects.find(p => p.id === second).items), ['native']);
  assert.equal(f.storage.getItem('fixture'), before);
});


test('sorting a neighbor preserves the stored account identity in projects and recent ordering', () => {
  for (const target of ['project', 'recent']) {
    const f = fixture(), other = { id: 'other', title: 'Other', at: 1 };
    const project = target === 'project' ? f.state.saveProject({ name: 'Work' }) : 'recent';
    if (target === 'project') {
      f.state.fileChat(account.id, project, account);
      f.state.fileChat(other.id, project, other);
    } else {
      f.state.move(account, 'recent', '', [account, other]);
    }
    f.state.move(other, project, native.id, [native, account, other]);
    const state = f.state.get(), stored = target === 'project' ? state.projects[0].chatIds : state.recent;
    assert.deepEqual(Array.from(stored), ['other', account.id]);
  }
});


test('a retained sidebar snapshot cannot prove native ownership or hide an account original', () => {
  const f = fixture();
  f.state.togglePin('download', { ...native, id: 'download', cached: true, source: { id: account.id } });
  const view = f.state.view([{ ...account, sourceSessionId: 'download' }]);
  assert.deepEqual(ids(view.pinned), ['download']);
  assert.deepEqual(ids(view.recent), [account.id]);
});
