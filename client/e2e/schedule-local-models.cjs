'use strict';

// Exercise the real editor and encrypted catalog IPC with a disposable profile.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const child = require('node:child_process').spawn(electron, [__filename, ...process.argv.slice(2)],
    { env, windowsHide: true, stdio: 'inherit' });
  const timer = setTimeout(() => child.kill(), 60000);
  child.on('exit', code => { clearTimeout(timer); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, ipcMain, safeStorage, net } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const assert = require('node:assert/strict'), { pathToFileURL } = require('node:url');
  const client = path.resolve(__dirname, '..'), output = process.argv[2];
  const modelLabel = process.argv[3] || 'custom-medium';
  assert.ok(output && path.isAbsolute(output), 'Absolute evidence directory required');
  fs.mkdirSync(output, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-schedule-models-'));
  app.setPath('userData', profile); app.disableHardwareAcceleration();
  if (process.platform === 'darwin') app.commandLine.appendSwitch('use-mock-keychain');
  let win;
  const js = code => win.webContents.executeJavaScript(code, true);
  const report = { ok: false, checks: [], boundary: 'Real Electron editor and production local-model IPC; synthetic encrypted model, mocked Hub, no user data or model request.' };
  async function until(code) {
    for (let i = 0; i < 100; i++) {
      if (await js(code)) return;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    throw Error('Timed out: ' + code);
  }
  app.whenReady().then(async () => {
    require('../main/local-model-ipc.cjs').install({ app, ipcMain, safeStorage });
    const store = require('../main/local-model-store.cjs');
    const catalog = store.save({ providers: [{ id: 'fixture-local', name: 'Fixture local service',
      baseUrl: 'http://127.0.0.1:1/v1', kind: 'openai-compat', authMode: 'none' }],
    models: [{ providerId: 'fixture-local', name: modelLabel, label: modelLabel }] });
    const ref = catalog.usable[0].name;
    const preload = path.join(profile, 'fixture-preload.cjs');
    fs.writeFileSync(preload, `const {contextBridge,ipcRenderer}=require('electron');
      contextBridge.exposeInMainWorld('soduWorkAPI',{localModels:{get:()=>ipcRenderer.invoke('local-models-get')}});`);
    const options = { substrates: [{ key: 'local:pi', cli: 'pi', name: 'Pi', modelPick: true,
      available: true, locations: [
        { assigneeId: 'runner:fixture-current-device:pi', mode: 'local', label: '本机' },
        { assigneeId: 'runner:fixture-other-device:pi', mode: 'remote', label: '远程 Runner' },
      ] }], modelOptions: [{ name: 'managed-model', label: 's1' }] };
    const setup = `SoduWorkAPI.taskExecutionOptions=async()=>(${JSON.stringify(options)});
      rows=[]; openSchedulePanel();`;
    const html = fs.readFileSync(path.join(__dirname, 'fixtures/schedule-once-editor.html'), 'utf8')
      .replaceAll('href="../../', 'href="').replaceAll('src="../../', 'src="')
      .replace('openSchedulePanel();</script>', setup + '</script>');
    win = new BrowserWindow({ show: false, width: 1280, height: 1100,
      webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true,
        offscreen: true, backgroundThrottling: false } });
    const desk = pathToFileURL(path.join(client, 'desk.html')).href;
    win.webContents.session.protocol.handle('file', request => request.url === desk
      ? new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })
      : net.fetch(request.url, { bypassCustomProtocolHandlers: true }));
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] },
      (_request, done) => done({ cancel: true }));
    await win.loadURL(desk);
    await until('document.querySelector("#schPanel.show")');
    await js('_schPrepareEditor("new")');
    await until('document.querySelector("#schModel") && !_schEditorPending');
    report.options = await js('[...schModel.options].map(o=>({value:o.value,label:o.textContent}))');
    assert.ok(report.options.some(row => row.value === ref && row.label === modelLabel));
    assert.ok(report.options.some(row => row.label === 's1'));
    assert.equal(await js('schWho.value'), 'local:pi');
    report.checks.push('Opening a new automation on a concrete current-device Runner lists managed and saved local models');
    await js(`schModel.value=${JSON.stringify(ref)};schModel.dispatchEvent(new Event('change',{bubbles:true}));
      schTitle.value='Synthetic local model verification';schNote.value='Synthetic validation only';
      schModel.scrollIntoView({block:'center'});void 0;`);
    assert.equal(await js('schModel.selectedOptions[0].textContent'), modelLabel);
    await new Promise(resolve => setTimeout(resolve, 100));
    fs.writeFileSync(path.join(output, 'schedule-local-model-selected.png'), (await win.webContents.capturePage()).toPNG());
    await js('schReloadAgents.click();void 0;');
    await until('!schReloadAgents.disabled');
    assert.equal(await js('schModel.value'), ref, 'refresh must retain the chosen local model');
    await js('schSave.click();void 0;');
    await until('calls.created.length===1');
    const saved = await js('calls.created[0]');
    assert.equal(saved.assigneeId, 'local:pi'); assert.equal(saved.modelName, ref);
    report.checks.push('Selection survives refresh and reaches the save API with the local conversation route and opaque model reference');
    await js('_schPrepareEditor("new")');
    await js('schWho.value="runner:fixture-other-device:pi";schWho.dispatchEvent(new Event("change",{bubbles:true}));void 0;');
    await until('schWho.value==="runner:fixture-other-device:pi" && !schModel.disabled');
    assert.equal(await js('[...schModel.options].some(o=>o.value.startsWith("local:"))'), false);
    report.checks.push('Remote Runner never lists the device-owned model');
    assert.deepEqual(await js('errors'), []);
    report.ok = true;
    console.log(JSON.stringify(report));
  }).catch(error => { report.error = String(error.stack || error); console.error(report.error); process.exitCode = 1; })
    .finally(() => { fs.writeFileSync(path.join(output, 'schedule-local-models.json'), JSON.stringify(report, null, 2));
      win?.destroy(); app.quit(); });
}
