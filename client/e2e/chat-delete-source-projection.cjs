'use strict';

// Exercise the production sidebar, confirmation, preload, lifecycle IPC and
// SQLite directories with synthetic native files and a loopback Hub only.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const result = require('node:child_process').spawnSync(electron, [__filename, ...process.argv.slice(2)],
    { env, windowsHide: true, stdio: 'inherit', timeout: 90000 });
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
}

const { app, BrowserWindow, ipcMain } = electron;
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict'), http = require('node:http');
assert.ok(process.argv[2] && path.isAbsolute(process.argv[2]), 'Absolute evidence directory required');
const output = process.argv[2], root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-source-delete-'));
fs.mkdirSync(output, { recursive: true }); app.setPath('userData', path.join(root, 'profile'));
app.disableHardwareAcceleration();
const report = { ok: false, cases: [], boundary: 'Real Electron sidebar, pointer clicks, confirmation, preload, history IPC, shared-history SQLite worker and account-sync transport. Synthetic native archive adapter/recycle destination and loopback Hub; chat execution is represented by navigation receipts. No user profile, model or production service is accessed.' };
let win, server, shared, sync, actor, writes = 0, recycled = 0, holdAccount = false;
const pendingAccount = [], native = new Map();
const js = code => win.webContents.executeJavaScript(code, true);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const record = name => { report.cases.push(name); console.log('PASS ' + name); };
async function until(code) {
  for (let i = 0; i < 200; i++) { if (await js(code)) return; await delay(40); }
  throw Error('UI did not settle: ' + code);
}
async function click(selector) {
  const point = await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});
    if(!e)throw Error('Missing target');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();
    const x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2);
    return{x,y};})()`);
  win.webContents.sendInputEvent({ type: 'mouseMove', ...point });
  await delay(80);
  assert.equal(await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});return !e.disabled&&e.contains(document.elementFromPoint(${point.x},${point.y}));})()`), true, 'Pointer target must be visible and enabled');
  for (const type of ['mouseDown', 'mouseUp'])
    win.webContents.sendInputEvent({ type, ...point, button: 'left', clickCount: 1 });
  await delay(40);
}
async function deleteNative() {
  await click('[data-chat-id="native-one"] + .ws-chat-actions .ws-chat-more');
  await until('!!document.querySelector(".ws-chat-menu:not([hidden])")');
  await click('.ws-chat-menu:not([hidden]) .ws-chat-delete');
  await until('!!document.querySelector(".app-confirm-dialog[open]")');
}
function releaseAccount() {
  holdAccount = false;
  for (const resolve of pendingAccount.splice(0)) resolve();
}
async function boot() {
  await win.loadFile(path.join(__dirname, 'fixtures/sidebar-projects.html'));
  await win.webContents.insertCSS(fs.readFileSync(path.join(__dirname, '../components/shared/app-confirm-dialog.css'), 'utf8'));
  await js(fs.readFileSync(path.join(__dirname, '../components/shared/app-confirm-dialog.js'), 'utf8'));
  await until('!!row("native-independent")&&!!row("acct-foreign")');
  await js('WorkspaceShell.refreshConversationHistory()');
}

app.whenReady().then(async () => {
  require('../main/native-locale.cjs').setLocale('zh-CN');
  const rows = [
    { id: 'acct-owned', sourceClientId: 'device', sourceSessionId: 'native-one' },
    { id: 'acct-foreign', sourceClientId: 'foreign-device', sourceSessionId: 'native-one' },
  ].map(row => ({ ...row, title: 'Same conversation title', state: 'idle', revision: 1,
    lifecycleRevision: 0, messageCount: 2, updatedAt: '2026-11-01T00:00:00Z' }));
  server = http.createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.method !== 'GET') {
      writes++; response.writeHead(500); response.end('{"detail":"Unexpected Hub mutation"}'); return;
    }
    if (request.url.startsWith('/api/v1/account-conversations?')) {
      response.end(JSON.stringify({ items: rows, cursor: 1, hasMore: false })); return;
    }
    response.writeHead(404); response.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  actor = { ...require('../tests/helpers/platform-session-fixture.cjs').identity(),
    hub: 'http://127.0.0.1:' + server.address().port };
  const access = require('../main/conversation/history-access'), baseActor = access.actor;
  access.actor = (_app, identity = actor) => baseActor(app, identity);
  require('../main/conversation/requirement-context').cachedIdentity = () => actor;
  const scope = require('../main/platform-connections/runtime.cjs').scope(actor);
  for (const id of ['native-one', 'native-independent']) {
    const file = path.join(root, id + '.jsonl'); fs.writeFileSync(file, 'Synthetic native transcript: ' + id);
    native.set(id, { id, path: file, adapterId: 'pi', title: 'Same conversation title', count: 2, at: 1000,
      workOwner: scope, creator: { account: 'one', hub: actor.hub }, historyAliasIds: [] });
  }
  const session = {
    findBySessionId: () => null,
    historyEntry: async (_app, id) => native.has(id) ? { ok: true, entry: native.get(id) } : { ok: false, notFound: true },
    archivedConversation: async (_app, id) => native.get(id) || null,
    forgetRunner: () => assert.fail('Pi native deletion must recycle only its own archive'),
    archivedHistory: async () => ({ ok: true, chats: await shared.indexedRows(true, 100) }),
  };
  const create = () => {
    shared = require('../main/conversation/shared-history.cjs').create({ app, session, identityOf: () => actor });
    sync = require('../main/conversation/account-sync').create({ app, identityOf: () => actor, localIdentityOf: () => actor,
      store: require('../main/conversation/account-sync-store').createWorker(path.join(root, 'outbox')),
      resolveDisplayLinks: (items, identity) => shared.accountDisplayLinks(items, identity),
      fetch: (_identity, url, options) => fetch(url, options) });
  };
  create(); await shared.register([...native.values()]);
  ipcMain.handle('recent-workspace-get', () => ({ ok: true, items: [] }));
  ipcMain.handle('pi-session-history', require('./fixtures/history-ipc.cjs').create(async (_event, options) => {
    const result = await sync.history({ ...options, force: true });
    if (holdAccount) await new Promise(resolve => pendingAccount.push(resolve));
    return result;
  }, { local: options => shared.page(options) }));
  require('../main/pi-session/history-ipc').install({ app, ipcMain, session, BrowserWindow,
    sharedHistory: Object.fromEntries(['resolve', 'lifecycle'].map(method => [method, (...args) => shared[method](...args)])),
    accountHistory: { resolveLifecycle: (...args) => sync.resolveLifecycle(...args), setLifecycle: (...args) => sync.setLifecycle(...args) },
    trash: async (_shell, file) => {
      assert.equal(file, native.get('native-one')?.path);
      fs.renameSync(file, path.join(root, 'recycled-native-one.jsonl')); recycled++; native.delete('native-one');
    } });
  win = new BrowserWindow({ show: false, width: 1100, height: 800, webPreferences: {
    preload: path.join(__dirname, '../preload.js'), contextIsolation: true, nodeIntegration: false,
    offscreen: true, backgroundThrottling: false } });
  await boot(); await until('!!row("native-one")');
  assert.equal(await js('!!row("acct-owned")'), false);
  assert.equal((await sync.history({ source: 'account' })).chats.find(row => row.id === 'acct-owned').displayNativeId, 'native-one');
  record('Authenticated same-device source paints once; an independent same-title local chat and foreign-device projection stay visible');

  await deleteNative(); await click('.app-confirm-cancel');
  assert.equal((await shared.resolve('native-one')).deleted, false); assert.equal(recycled, 0); assert.equal(writes, 0);
  record('Cancel leaves the native archive, local lifecycle and Hub unchanged');

  await click('[data-chat-id="native-one"]');
  await until('opens.some(item=>item.options.chatId==="native-one")');
  holdAccount = true; await js('void WorkspaceShell.refreshConversationHistory()');
  for (let i = 0; !pendingAccount.length && i < 150; i++) await delay(40);
  assert.equal(pendingAccount.length, 1, 'an authenticated account response is deliberately held before local deletion');
  await deleteNative();
  fs.writeFileSync(path.join(output, 'confirmation.png'), (await win.webContents.capturePage()).toPNG());
  await click('.app-confirm-submit');
  await until('!row("native-one")');
  assert.equal((await shared.resolve('native-one')).deleted, true); assert.equal(recycled, 1);
  assert.equal(await js('!!row("acct-owned")'), false, 'the same source must not reappear under its account ID');
  await until('opens.some(item=>item.options.newSession===true)');
  assert.equal(await js('opens.at(-1).options.chatId||""'), '');
  releaseAccount(); await js('WorkspaceShell.refreshConversationHistory()');
  // The held reply may be invalidated by the deletion. Read once more after
  // its continuation settles so the assertion covers a fresh directory too.
  await delay(100); await js('WorkspaceShell.refreshConversationHistory()');
  assert.equal(await js('!!row("native-one")||!!row("acct-owned")'), false);
  await click('[data-chat-id="native-independent"]'); await js('WorkspaceShell.refreshConversationHistory()');
  assert.equal(await js('!!row("native-one")||!!row("acct-owned")'), false);
  assert.equal(await js('opens.filter(item=>item.options.chatId==="native-one").length'), 1);
  assert.equal(await js('!!row("native-independent")&&!!row("acct-foreign")'), true); assert.equal(writes, 0);
  record('One confirmed deletion survives a late account reply, starts a fresh route, and stays deleted when another chat is opened');

  await sync.close(); await shared.close(); create();
  await shared.register([{ ...native.get('native-independent'), id: 'native-one', title: 'Late native index replay' }]);
  await boot();
  assert.equal((await shared.resolve('native-one')).deleted, true);
  assert.equal(await js('!!row("native-one")||!!row("acct-owned")'), false);
  assert.equal(await js('!!row("native-independent")&&!!row("acct-foreign")'), true);
  assert.equal(recycled, 1); assert.equal(writes, 0);
  assert.equal(fs.readFileSync(native.get('native-independent').path, 'utf8'), 'Synthetic native transcript: native-independent');
  assert.equal(rows[0].deleted, undefined, 'local deletion must not mutate the original account conversation');
  assert.deepEqual(await js('errors'), []);
  fs.writeFileSync(path.join(output, 'after-restart.png'), (await win.webContents.capturePage()).toPNG());
  record('SQLite service restart, page reload and stale native registration cannot resurrect the deleted source or remove independent conversations');
  report.ok = true; report.hubWrites = writes; report.recycledArchives = recycled;
}).catch(async error => {
  report.error = error.stack;
  if (win && !win.isDestroyed()) {
    report.renderer = await js('({notice:window.lastNotice,errors:window.errors,opens:window.opens,ids:[...document.querySelectorAll(".ws-chat")].map(row=>row.dataset.chatId)})').catch(() => null);
    fs.writeFileSync(path.join(output, 'failure.png'), (await win.webContents.capturePage()).toPNG());
  }
}).finally(async () => {
  releaseAccount(); await sync?.close(); await shared?.close(); win?.destroy(); server?.close();
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report)); app.exit(report.ok ? 0 : 1);
});
