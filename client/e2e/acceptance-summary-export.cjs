'use strict';
// Production detail -> preload -> native export -> isolated authenticated Hub -> real Markdown bytes.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const electron = require('electron');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const client = path.resolve(__dirname, '..');

if (typeof electron === 'string') {
  (async () => {
    const output = process.argv[2], python = process.argv[3] || process.env.SODUWORK_TEST_PYTHON;
    if (!path.isAbsolute(output || '') || !python) throw Error('Absolute evidence directory and test Python are required');
    fs.mkdirSync(output, { recursive: true });
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'soduwork-collab-e2e-'));
    const probe = require('node:net').createServer();
    await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
    const hub = 'http://127.0.0.1:' + port, log = fs.openSync(path.join(output, 'hub.log'), 'w');
    const server = spawn(python, ['-m', 'uvicorn', 'tests.acceptance_summary_browser_server:app', '--host', '127.0.0.1', '--port', String(port)],
      { cwd: path.join(client, '../hub-backend'), env: { ...process.env, SODUWORK_COLLAB_E2E_ROOT: root }, stdio: ['ignore', log, log] });
    try {
      let ready = false;
      for (let i = 0; i < 150; i++) {
        try { ready = (await (await fetch(hub + '/ready')).json()).isolated === true; } catch {}
        if (ready || server.exitCode !== null) break;
        await wait(100);
      }
      if (!ready) throw Error('Isolated summary Hub failed to start; inspect hub.log');
      const env = { ...process.env };
      for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
      const result = spawnSync(electron, [__filename, output, hub], { env, encoding: 'utf8', timeout: 120000 });
      fs.writeFileSync(path.join(output, 'electron.log'), (result.stdout || '') + (result.stderr || '') + (result.error?.message || ''));
      const report = JSON.parse(fs.readFileSync(path.join(output, 'report.json'), 'utf8'));
      console.log(JSON.stringify(report));
      if (result.status !== 0 || !report.ok) throw Error('Acceptance summary E2E failed');
    } finally {
      server.kill(); await Promise.race([new Promise(resolve => server.once('exit', resolve)), wait(3000)]);
      fs.closeSync(log);
    }
  })().catch(error => { console.error(error); process.exitCode = 1; });
} else {
  const { app, BrowserWindow, ipcMain, session } = electron;
  const { pathToFileURL, fileURLToPath } = require('node:url');
  const [output, hub] = process.argv.slice(2);
  if (!path.isAbsolute(output || '') || !/^http:\/\/127\.0\.0\.1:\d+$/.test(hub || '')) throw Error('Isolated Hub required');
  app.setPath('userData', path.join(output, 'profile')); app.disableHardwareAcceleration();
  const report = { ok: false, checks: [], boundary: 'Real Electron detail/preload/native IPC, production Device authentication, isolated HTTP/SQLite and filesystem; injected save-dialog choices and synthetic records, no model execution' };
  let win, actor, bootstrap, cancel = false, holdDialog = null, saveCount = 0, destination = path.join(output, 'summary.md');
  const errors = [], requests = [];
  const js = code => win.webContents.executeJavaScript(code, true);
  async function api(route, identity = actor, method = 'GET', body) {
    const response = await fetch(hub + route, { method, headers: { Authorization: 'Device ' + identity.session, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  }
  async function until(code, label) {
    for (let i = 0; i < 100; i++) { if (await js(code)) return; await wait(50); }
    throw Error('Timed out: ' + label);
  }
  async function click() {
    const point = await js(`(()=>{const n=document.querySelector('[data-rq-export-summary]');if(!n||n.disabled)throw Error('Unavailable export action');n.scrollIntoView({block:'center'});const r=n.getBoundingClientRect();const p={x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};if(!n.contains(document.elementFromPoint(p.x,p.y)))throw Error('Export action is obscured');return p})()`);
    for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, ...point, button: 'left', clickCount: 1 });
    await wait(80);
  }
  async function display(key, identity = bootstrap.identities.owner) {
    actor = identity;
    const record = bootstrap.tasks[key], result = await api('/api/v1/tasks/' + record.id);
    assert.equal(result.status, 200, JSON.stringify(result.data));
    const inbox = await api('/api/v1/approvals?view=pending'); assert.equal(inbox.status, 200);
    await js(`window.fixtureTask=${JSON.stringify(result.data)};window.fixtureApprovals=${JSON.stringify(inbox.data)};TaskApprovalInbox.refresh()`);
    await js('RequirementsDetail.open(fixtureTask.id)');
    return result.data;
  }
  function html() {
    const file = relative => pathToFileURL(path.join(client, relative)).href;
    return '<!doctype html><html data-theme="vivid"><meta charset="utf-8"><title>Acceptance summary</title>' +
      ['theme/variables.css', 'components/requirements/requirements-board.css'].map(name => '<link rel="stylesheet" href="' + file(name) + '">').join('') +
      '<style>body{margin:0;font-family:var(--font-ui)}</style><body><script>window.fixtureErrors=[];addEventListener("error",e=>fixtureErrors.push(e.message));addEventListener("unhandledrejection",e=>fixtureErrors.push(String(e.reason)));window.SoduWorkAPI={getTask:async()=>fixtureTask,listAttachments:async()=>[],listApprovals:async()=>fixtureApprovals};window.RequirementsBoard={context:()=>({approvals:new Map(TaskApprovalInbox.snapshot().map(row=>[row.taskId,row]))}),refresh:async()=>{}};</script>' +
      ['core/requirements.js', 'components/panels/task-approval-inbox.js', 'components/requirements/requirement-fields.js', 'components/requirements/requirements-detail.js'].map(name => '<script src="' + file(name) + '"></script>').join('') + '</body></html>';
  }
  app.whenReady().then(async () => {
    try {
      bootstrap = await (await fetch(hub + '/e2e/summary-bootstrap')).json(); actor = bootstrap.identities.owner;
      const partition = session.fromPartition('summary-e2e');
      await partition.protocol.handle('file', async request => {
        const filename = fileURLToPath(request.url);
        if (filename === path.join(client, 'desk.html')) return new Response(html(), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
        if (!filename.startsWith(client + path.sep)) return new Response('', { status: 403 });
        return new Response(fs.readFileSync(filename), { headers: { 'Content-Type': filename.endsWith('.js') ? 'text/javascript' : 'text/css' } });
      });
      require('../main/acceptance-summary-export.cjs').install({ app, ipcMain, BrowserWindow,
        identityOf: () => ({ hub, clientId: actor.clientId }), ownerOf: () => actor.userId,
        authenticatedIdentityOf: async () => ({ hub, clientId: actor.clientId, session: actor.session }),
        fetchAuthenticated: async (...args) => {
          requests.push(new URL(args[1]).pathname);
          return require('../main/device-auth-request').fetchWithDeviceAuthRetry(...args);
        },
        dialog: { showSaveDialog: async () => { saveCount++; if (holdDialog) await holdDialog; return { canceled: cancel, filePath: destination }; } } });
      win = new BrowserWindow({ show: false, width: 1100, height: 850, webPreferences: {
        preload: path.join(client, 'preload.js'), session: partition, sandbox: true, contextIsolation: true, offscreen: true } });
      win.webContents.on('preload-error', (_event, _file, error) => errors.push(error.message));
      await win.loadFile(path.join(client, 'desk.html'));
      const before = await display('awaiting');
      await click(); await until(`document.querySelector('[data-rq-export-status]').textContent==='验收摘要已保存'`, 'pending summary saved');
      const pendingText = fs.readFileSync(destination, 'utf8');
      assert.match(pendingText, /待验收/); assert.doesNotMatch(pendingText, /PRIVATE|HISTORICAL/);
      const after = (await api('/api/v1/tasks/' + before.id)).data;
      for (const key of ['status', 'reviewedAt', 'requirementVersion', 'updatedAt']) assert.deepEqual(after[key], before[key]);
      fs.writeFileSync(path.join(output, 'awaiting-summary.md'), pendingText);
      report.checks.push('Native export writes an awaiting-acceptance snapshot without changing the task or leaking private fields');
      await display('approved'); await click();
      await until(`document.querySelector('[data-rq-export-status]').textContent==='验收摘要已保存'`, 'approved summary saved');
      const approved = fs.readFileSync(destination, 'utf8'); assert.match(approved, /已通过/); assert.match(approved, /验收决定/);
      fs.writeFileSync(path.join(output, 'approved-summary.md'), approved);
      fs.writeFileSync(path.join(output, 'export-saved.png'), (await win.webContents.capturePage()).toPNG());
      report.checks.push('Approved export retains the fixed decision and differs from pending acceptance');
      cancel = true; const count = saveCount; await click();
      await until(`!document.querySelector('[data-rq-export-summary]').disabled`, 'cancel settled');
      assert.equal(saveCount, count + 1); assert.equal(fs.readFileSync(destination, 'utf8'), approved);
      assert.equal(await js(`document.querySelector('[data-rq-export-status]').textContent`), ''); cancel = false;
      report.checks.push('Cancel preserves the previous saved file and does not report success');
      await display('revised');
      assert.equal(await js(`RequirementsBoard.context().approvals.get(fixtureTask.id).artifactVersionId`), bootstrap.tasks.revised.artifactVersionId);
      const revised = await api('/e2e/summary-revise', actor, 'POST', { taskId: bootstrap.tasks.revised.id, keepRequirementVersion: true });
      assert.equal(revised.status, 200);
      assert.equal(revised.data.requirementVersion, bootstrap.tasks.revised.requirementVersion);
      assert.notEqual(revised.data.artifactVersionId, bootstrap.tasks.revised.artifactVersionId);
      const staleCount = saveCount; await click();
      await until(`document.querySelector('[data-rq-export-status]').textContent.includes('版本已经变化')`, 'stale version rejected');
      assert.equal(saveCount, staleCount); assert.equal(fs.readFileSync(destination, 'utf8'), approved);
      report.checks.push('A revised requirement or delivery rejects the stale visible snapshot before the save dialog');
      await display('requirementOnly', bootstrap.identities.viewer);
      assert.equal(await js(`!!document.querySelector('[data-rq-export-summary]')`), false);
      const denied = await js(`soduWorkAPI.exportAcceptanceSummary({taskId:fixtureTask.id})`);
      assert.equal(denied.ok, false); assert.equal(saveCount, staleCount);
      report.checks.push('Requirement-only visibility exposes no export action and cannot bypass Hub execution permissions through IPC');
      await display('approved');
      let release; holdDialog = new Promise(resolve => { release = resolve; });
      await click(); await until(`document.querySelector('[data-rq-export-summary]').disabled`, 'pending export');
      actor = bootstrap.identities.viewer; release(); holdDialog = null;
      await until(`!document.querySelector('[data-rq-export-summary]').disabled`, 'account switch discarded');
      assert.match(await js(`document.querySelector('[data-rq-export-status]').textContent`), /账号/);
      assert.equal(fs.readFileSync(destination, 'utf8'), approved);
      report.checks.push('Account changes while the save dialog is open discard old-account bytes');
      assert.deepEqual(await js('fixtureErrors'), []); assert.deepEqual(errors, []);
      assert.ok(requests.every(route => /^\/api\/v1\/tasks\/[^/]+\/acceptance-summary$/.test(route)));
      report.ok = true;
    } catch (error) { report.error = error.stack; }
    finally {
      fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
      win?.destroy(); app.exit(report.ok ? 0 : 1);
    }
  });
}
