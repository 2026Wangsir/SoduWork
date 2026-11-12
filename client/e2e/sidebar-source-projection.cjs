'use strict';
// Real Electron new-chat send, history refresh, sidebar actions and reload.
// The isolated IPC fixture supplies native/account records; no model or Hub is contacted.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS']) delete env[key];
  const child = require('node:child_process').spawn(electron, [__filename, ...process.argv.slice(2)],
    { env, windowsHide: true, stdio: 'inherit' });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, ipcMain, net } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const assert = require('node:assert/strict'), { pathToFileURL } = require('node:url');
  const output = process.argv[2];
  assert.ok(output && path.isAbsolute(output), 'An absolute evidence directory is required');
  fs.mkdirSync(output, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-sidebar-source-'));
  app.setPath('userData', path.join(root, 'profile')); app.disableHardwareAcceleration();
  if (process.platform === 'darwin') app.commandLine.appendSwitch('use-mock-keychain');
  const report = { ok: false, cases: [], blockedRequests: [], screenshots: [] };
  let win, native = [], account = [], revision = 0, sequence = 0, sends = 0, order = 'local';
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const js = code => win.webContents.executeJavaScript(code, true);
  async function until(code) {
    for (let i = 0; i < 200; i++) { if (await js(code)) return; await delay(25); }
    throw Error('Timed out: ' + code);
  }
  const ids = 'Array.from(document.querySelectorAll(".ws-chat-row .ws-chat"), el => el.dataset.chatId)';
  ipcMain.handle('fixture-history', async (_, options = {}) => {
    await delay(options.source === order ? 5 : 80);
    return options.source === 'local' ? { ok: true, chats: native, next: null,
      localCatalog: { workspace: 'fixture-source', revision,
        items: native.map(row => ({ id: row.id, historyAliasIds: row.historyAliasIds || [],
          originIds: row.source?.id ? [row.source.id] : [] })) } } : { ok: true, chats: account };
  });
  ipcMain.handle('fixture-open', (_, options) => {
    const id = options.chatId || 'native-' + (++sequence);
    return { ok: true, ref: id, sessionId: id, adapterId: 'pi', model: {},
      snapshot: { status: 'idle', messages: [], tools: [], pendingUi: null } };
  });
  ipcMain.handle('fixture-send', (_, id, title) => {
    sends++; revision++;
    native.push({ id, title, count: 2, at: Date.now(), adapterId: 'pi', usedHarnesses: ['pi'], localReplica: true });
    account.push({ id: 'account-' + id, title, at: Date.now(), accountConversation: true, accountProjection: true,
      sourceClientId: 'fixture-device', sourceSessionId: id, contentLocation: 'source', accountCanSend: true });
    return { ok: true };
  });
  async function reload() {
    const loaded = new Promise(resolve => win.webContents.once('did-finish-load', resolve));
    win.webContents.reload(); await loaded;
  }
  async function shot(name) {
    const file = path.join(output, name + '.png');
    fs.writeFileSync(file, (await win.webContents.capturePage()).toPNG()); report.screenshots.push(file);
  }
  app.whenReady().then(async () => {
    const client = path.resolve(__dirname, '..');
    let html = fs.readFileSync(path.join(client, 'tests/new-conversation.html'), 'utf8');
    const boundary = '<script>\n(async()=>{';
    assert.equal(html.split(boundary).length, 2, 'Keep the existing UI fixture separate from its test driver');
    html = html.split(boundary)[0].replace('<head>', '<head><base href="' + pathToFileURL(client + path.sep).href + '">');
    const modules = ['../components/panels/agent-brand.js', '../components/panels/panels-chat-chrome.js',
      '../components/workspace/workspace-sidebar-state.js', '../components/workspace/workspace-sidebar-drag.js',
      '../components/workspace/workspace-sidebar-projects.js'];
    html = html.replace('<script src="../components/workspace/workspace-chat-list.js">',
      modules.map(file => '<script src="' + file + '"></script>').join('\n') + '\n<script src="../components/workspace/workspace-chat-list.js">');
    html += `<script>
      window.errors=[];addEventListener('error',e=>errors.push(e.message));
      addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));
      const ipc=require('electron').ipcRenderer;
      Object.assign(SoduWorkAPI,{hubBase:()=> 'https://sidebar-fixture.invalid',
        clientAuthSnapshot:()=>({clientId:'fixture-device',user:{id:'employee'}})});
      Object.assign(soduWorkAPI.conversationSession,{localHistorySupported:true,
        history:options=>ipc.invoke('fixture-history',options),
        open:options=>ipc.invoke('fixture-open',options),send:(ref,text)=>ipc.invoke('fixture-send',ref,text)});
      WorkspaceShell.mount();WorkspaceShell.setActive('create');openComposePanel({newSession:true});
      window.row=id=>[...document.querySelectorAll('.ws-chat-row')].find(el=>el.querySelector('.ws-chat').dataset.chatId===id);
      window.fixtureReady=true;
    </script></body></html>`;
    const css = ['theme/variables.css', 'components/workspace/workspace-shell.css', 'components/workspace/workspace-sidebar-projects.css',
      'components/panels/agent-brand.css', 'components/panels/work-composer.css', 'components/panels/panels-chat.css'];
    html = html.replace('</head>', css.map(file => '<link rel="stylesheet" href="../' + file + '">').join('\n') + '</head>');
    html = html.replaceAll('src="../', 'src="').replaceAll("src='../", "src='").replaceAll('href="../', 'href="');
    const file = path.join(root, 'fixture.html'); fs.writeFileSync(file, html);
    win = new BrowserWindow({ show: false, width: 1100, height: 820,
      webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false, offscreen: true, backgroundThrottling: false } });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (request, done) => {
      report.blockedRequests.push(request.url); done({ cancel: true });
    });
    if (process.argv.includes('--baseline')) {
      const old = require('node:child_process').execFileSync('git',
        ['show', '34ed263a526bc3366a02561c7cd6714923a0f3c3:client/components/workspace/workspace-sidebar-state.js'], { cwd: client, encoding: 'utf8' });
      win.webContents.session.protocol.handle('file', request => new URL(request.url).pathname.endsWith('/workspace-sidebar-state.js')
        ? new Response(old, { headers: { 'content-type': 'text/javascript' } }) : net.fetch(request.url, { bypassCustomProtocolHandlers: true }));
    }
    await win.loadFile(file); await until('window.fixtureReady');
    for (order of ['local', 'account']) {
      await js(`WorkspaceHost.open('create',{newSession:true});document.getElementById('cpInput').value='Same question';document.getElementById('cpGo').click()`);
      for (let i = 0; i < 200 && sends < (order === 'local' ? 1 : 2); i++) await delay(20);
      assert.equal(sends, order === 'local' ? 1 : 2, 'The real new-chat composer must reach the isolated send boundary');
      await js('WorkspaceShell.refreshConversationHistory()');
      await until(ids + '.length===' + sends);
      assert.deepEqual(await js(ids), native.slice().reverse().map(row => row.id));
      assert.equal(await js(`document.querySelectorAll('.ws-chat-row [data-agent-brand="pi"]').length`), sends);
      report.cases.push(order + '-first history response after a real composer send shows one native Pi row per conversation; identical titles remain distinct');
      await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      await shot('after-' + order + '-first-send');
    }
    await shot('after-new-sends');
    const before = JSON.stringify({ native, account });
    await reload(); await until(`JSON.stringify(${ids})===JSON.stringify(['native-2','native-1'])`);
    assert.deepEqual(await js(ids), ['native-2', 'native-1']);
    await js(`row('native-1').querySelector('.ws-chat').click()`);
    assert.equal(await js('routes.at(-1).payload.chatId'), 'native-1');
    report.cases.push('Renderer reload and clicking the row preserve the original native identity');
    await js(`window.store=WorkspaceSidebarState.create(WorkspaceSidebarState.accountOptions({storage:localStorage,api:SoduWorkAPI}));
      store.togglePin('account-native-1');window.group=store.saveProject({name:'Fixture project',folders:['/fixture/work']});
      store.fileChat('account-native-1',group);WorkspaceShell.refreshConversationHistory()`);
    await until(`!!document.querySelector('#wsPinnedChats [data-chat-id="native-1"]')`);
    assert.equal(await js(`WorkspaceShell.projectForChat('native-1').id`), await js('group'));
    await js(`document.querySelector('#wsPinnedChats [data-chat-id="native-1"]').closest('.ws-chat-row').querySelector('.ws-chat-pin').click()`);
    assert.equal(await js(`document.querySelectorAll('#wsPinnedChats .ws-chat').length`), 0);
    assert.equal(await js(`document.querySelectorAll('.ws-project-chats [data-chat-id="native-1"]').length`), 1);
    report.cases.push('Existing account pin/project placement resolves to the native row, retains project context, and can be unpinned');
    assert.equal(JSON.stringify({ native, account }), before, 'Rendering and organization never rewrite either history source');
    native.push({ id: 'download', title: 'Downloaded replay', cached: true, localReplica: true, source: { id: 'foreign' }, at: 1 });
    account.push({ id: 'foreign', title: 'Downloaded replay', accountConversation: true, sourceClientId: 'another-device',
      sourceSessionId: 'download', accountCanSend: true, contentLocation: 'source', at: 1 }); revision++;
    await js('WorkspaceShell.refreshConversationHistory()');
    await until(`!!row('download')&&!!row('foreign')`);
    assert.deepEqual(await js('errors'), []);
    report.cases.push('Foreign-device account original and downloaded local replay remain separate');
    await shot('organized-source-history'); report.ok = true;
  }).catch(async error => {
    report.error = error.stack; console.error(error.stack);
    if (win) { report.ui = await js('({errors,ids:' + ids + '})').catch(() => null); await shot('failure').catch(() => {}); }
  }).finally(() => {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report)); win?.destroy(); app.exit(report.ok ? 0 : 1);
  });
}
