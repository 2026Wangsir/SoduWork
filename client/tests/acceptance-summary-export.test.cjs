'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { install } = require('../main/acceptance-summary-export.cjs');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-summary-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const state = { owner: 'account-a', identity: { hub: 'https://hub.example', clientId: 'device-a', secret: 'synthetic-device-secret' },
    requests: [], choices: [], status: 200, response: { filename: 'Acceptance.md', markdown: '# Acceptance\n\nAwaiting acceptance.\n',
      artifactVersionId: 'artifact-a', requirementVersion: 3, exportedAt: '2026-11-12T08:00:00Z' } };
  const parent = { isDestroyed: () => state.closed || false };
  const sender = { mainFrame: {}, getURL: () => state.url || pathToFileURL(path.resolve(__dirname, '../desk.html')).href, isDestroyed: () => false };
  const event = { sender, senderFrame: sender.mainFrame };
  let handler;
  install({ app: { getPath: () => directory }, ipcMain: { handle: (name, fn) => { assert.equal(name, 'acceptance-summary-export'); handler = fn; } },
    BrowserWindow: { fromWebContents: () => parent }, identityOf: () => state.identity, ownerOf: () => state.owner,
    authenticatedIdentityOf: async () => { await state.authWait?.(); return { ...state.identity, session: 'synthetic-account-session' }; },
    fetchAuthenticated: async (identity, url, options) => {
      state.requests.push({ identity, url, options }); await state.fetchWait?.();
      return new Response(JSON.stringify(state.response), { status: state.status, headers: { 'Content-Type': 'application/json' } });
    },
    dialog: { showSaveDialog: async (_parent, options) => {
      state.choices.push(options); await state.dialogWait?.();
      return { canceled: state.cancel || false, filePath: path.join(directory, 'saved.md') };
    } } });
  return { state, directory, event, save: input => handler(event, { taskId: 'task-a', requirementVersion: 3, ...input }),
    saved: () => fs.readFileSync(path.join(directory, 'saved.md'), 'utf8') };
}

test('native export fetches only the authorized snapshot and saves its exact UTF-8 bytes', async t => {
  const f = fixture(t);
  const result = await f.save({ artifactVersionId: 'artifact-a', url: 'https://untrusted.example', markdown: 'forged', filePath: '/untrusted' });
  assert.equal(result.ok, true); assert.equal(f.saved(), f.state.response.markdown);
  assert.equal(f.state.requests[0].url, 'https://hub.example/api/v1/tasks/task-a/acceptance-summary?requirementVersion=3&artifactVersionId=artifact-a');
  assert.equal(f.state.requests[0].options.redirect, 'manual');
  assert.equal(f.state.requests[0].identity.session, 'synthetic-account-session');
  assert.equal(f.state.choices[0].defaultPath, path.join(f.directory, 'Acceptance.md'));
  assert.deepEqual(fs.readdirSync(f.directory), ['saved.md']);
});

test('untrusted frames and malformed identifiers cannot fetch or open a save dialog', async t => {
  const f = fixture(t);
  f.state.url = 'https://untrusted.example/desk.html'; assert.equal((await f.save()).ok, false);
  delete f.state.url;
  f.event.senderFrame = {}; assert.equal((await f.save()).ok, false);
  f.event.senderFrame = f.event.sender.mainFrame;
  for (const input of [{ taskId: '../secrets' }, { requirementVersion: 0 }, { artifactVersionId: '../../escape' }])
    assert.equal((await f.save(input)).ok, false);
  assert.equal(f.state.requests.length, 0); assert.equal(f.state.choices.length, 0);
});

test('canceled exports preserve existing bytes and do not report success', async t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.directory, 'saved.md'), 'existing'); f.state.cancel = true;
  assert.deepEqual(await f.save(), { ok: false, canceled: true }); assert.equal(f.saved(), 'existing');
});

test('missing, unauthorized and changed snapshots fail before choosing a destination', async t => {
  const f = fixture(t);
  for (const status of [403, 404, 409, 500]) {
    f.state.status = status; f.state.response = { detail: 'Synthetic rejection ' + status };
    assert.deepEqual(await f.save(), { ok: false, reason: 'Synthetic rejection ' + status });
  }
  f.state.status = 200; f.state.response = { markdown: 'not a snapshot' };
  assert.equal((await f.save()).ok, false);
  assert.equal(f.state.choices.length, 0); assert.deepEqual(fs.readdirSync(f.directory), []);
});

test('account switches during fetching or the dialog discard the result without touching the destination', async t => {
  for (const boundary of ['fetchWait', 'dialogWait']) {
    const f = fixture(t), pending = deferred(), entered = deferred();
    fs.writeFileSync(path.join(f.directory, 'saved.md'), 'existing');
    f.state[boundary] = async () => { entered.resolve(); await pending.promise; };
    const saving = f.save(); await entered.promise;
    f.state.owner = 'account-b'; pending.resolve();
    const result = await saving; assert.equal(result.ok, false); assert.match(result.reason, /账号/);
    assert.equal(f.saved(), 'existing'); assert.deepEqual(fs.readdirSync(f.directory), ['saved.md']);
  }
});

test('repeat requests cannot open parallel save dialogs, and cancellation permits a retry', async t => {
  const f = fixture(t), pending = deferred(), entered = deferred();
  f.state.dialogWait = async () => { entered.resolve(); await pending.promise; };
  const first = f.save(); await entered.promise;
  assert.equal((await f.save()).ok, false); assert.equal(f.state.requests.length, 1); assert.equal(f.state.choices.length, 1);
  f.state.cancel = true; pending.resolve(); await first;
  delete f.state.dialogWait; f.state.cancel = false;
  assert.equal((await f.save()).ok, true);
});

test('an account switch while staging the file cannot publish old-account bytes', async t => {
  const f = fixture(t), promises = require('node:fs/promises'), original = promises.writeFile;
  fs.writeFileSync(path.join(f.directory, 'saved.md'), 'existing');
  t.mock.method(promises, 'writeFile', async (...args) => {
    const result = await original(...args); f.state.owner = 'account-b'; return result;
  });
  const result = await f.save(); assert.equal(result.ok, false); assert.match(result.reason, /账号/);
  assert.equal(f.saved(), 'existing'); assert.deepEqual(fs.readdirSync(f.directory), ['saved.md']);
});

test('snapshot versions and redirections are checked before exporting', async t => {
  const f = fixture(t);
  f.state.response.requirementVersion = 4; assert.equal((await f.save()).ok, false);
  f.state.response.requirementVersion = 3; assert.equal((await f.save({ artifactVersionId: 'artifact-b' })).ok, false);
  f.state.status = 302; assert.equal((await f.save()).ok, false);
  assert.equal(f.state.choices.length, 0);
});
