'use strict';
// Real package import, authenticated policy, immutable cache and production
// composer loaders. All accounts, HTTP traffic and profiles are isolated.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE',
    'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  require('node:child_process').spawn(electron, [__filename, ...process.argv.slice(2)],
    { env, windowsHide: true, stdio: 'inherit' }).on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, ipcMain } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
  const { spawn, execFileSync } = require('node:child_process');
  const assert = require('node:assert/strict'), { pathToFileURL } = require('node:url');
  const client = path.resolve(__dirname, '..'), repo = path.dirname(client);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-skill-e2e-'));
  const out = path.resolve(process.argv[2] || path.join(repo, 'outputs/device-chat-sharing-20261111/skills-refresh-electron'));
  fs.mkdirSync(out, { recursive: true }); app.setPath('userData', path.join(root, 'profile')); app.disableHardwareAcceleration();
  const report = { ok: false, cases: [], errors: [] };
  let win, backend, identity, base, worker;
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const js = code => win.webContents.executeJavaScript(code, true);
  async function until(check, label, timeout = 30000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { try { if (await check()) return; } catch {} await pause(40); }
    throw Error('Timed out: ' + label);
  }
  async function request(route, body) {
    const response = await fetch(base + '/api/v1' + route, { method: body ? 'POST' : 'GET',
      headers: { Authorization: 'Device ' + identity.session, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.equal(response.ok, true, 'Fixture request failed: ' + route);
    return response.json();
  }
  async function choose(prefix) {
    await js(`newPicker.close();chatPicker.close();document.getElementById('${prefix}Input').value='';document.getElementById('${prefix}Input').focus()`);
    await win.webContents.insertText('#weekly-business');
    const selector = '#' + prefix + 'Host [data-skill-name="weekly-business"]';
    await until(() => js(`!!document.querySelector(${JSON.stringify(selector)})`), 'fresh selectable skill');
    const point = await js(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});n.scrollIntoView({block:'nearest'});
      const r=n.getBoundingClientRect(),x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2);
      if(!n.contains(document.elementFromPoint(x,y)))throw Error('Skill option is occluded');return{x,y}})()`);
    for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, ...point, button: 'left', clickCount: 1 });
    await until(() => js(`${prefix}Picker.selected().includes('weekly-business')`), 'selected skill chip');
  }
  app.whenReady().then(async () => {
    const listener = net.createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
    const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
    base = 'http://127.0.0.1:' + port;
    backend = spawn(process.env.SODUWORK_TEST_PYTHON || path.join(repo, 'hub-backend/.venv/Scripts/python.exe'),
      ['-u', 'e2e_skill_sharing_server.py', String(port), root], { cwd: path.join(repo, 'hub-backend'),
        windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, PYTHONUTF8: '1' } });
    backend.stderr.on('data', bytes => { report.errors.push(String(bytes).slice(0, 500)); });
    await until(async () => (await fetch(base + '/healthz')).ok, 'isolated backend');
    const tokens = await (await fetch(base + '/fixture/auth')).json();
    identity = { hub: base, clientId: 'device-alice', session: tokens.alice };
    for (let index = 0; index < 13; index++) await request('/skills/create', {
      name: 'fixture-' + index, description: 'Existing trusted fixture', instructions: 'Read fixture data only.' });
    require('../main/pi-session/environment-ipc').install({ app, ipcMain, session: {}, identityOf: async () => identity,
      capabilityGrantsOf: () => [], _skillDirs: () => [], workDir: () => root, _saveConf() {}, _conf: () => ({}) });
    ipcMain.handle('skill-fixture-auth', () => ({ ok: true, stored: true, clientId: identity.clientId,
      session: identity.session, user: { id: 'alice' }, expiresIn: 1800 }));
    ipcMain.handle('skill-fixture-send', async (_event, turn) => {
      const skillTurn = require('../main/pi-session/skill-turn');
      const resolveSkills = skillTurn.resolver({ app, identity, identityOf: async () => identity, skillDirs: () => [] });
      const prepared = await skillTurn.prepare({ cwd: root, resolveSkills }, turn);
      if (!prepared.ok) return { ok: false, failureKind: prepared.failureKind };
      assert.deepEqual(prepared.names, ['weekly-business']);
      const source = fs.readFileSync(path.join(prepared.dirs[0], 'SKILL.md'), 'utf8');
      assert.ok(source.endsWith(turn.version), 'Each send must use the current immutable version');
      assert.ok(fs.existsSync(path.join(prepared.dirs[0], 'references/中文说明.md')));
      worker ||= require('../main/agent-runtime/process-session');
      const runner = await skillTurn.prepareRunner({ app, cwd: root, resolveSkills }, turn, worker);
      assert.equal(runner.ok, true, runner.reason);
      assert.deepEqual(runner.names, ['weekly-business']);
      return { ok: true, text: turn.text, names: prepared.names, version: turn.version,
        resources: ['SKILL.md', 'references/中文说明.md'], pi: true, runner: true };
    });
    const preload = path.join(root, 'preload.cjs');
    fs.writeFileSync(preload, `const{contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('soduWorkAPI',{
      deviceAuthBootstrap:()=>ipcRenderer.invoke('skill-fixture-auth'),conversationSession:{
      capabilities:o=>ipcRenderer.invoke('conversation-capabilities',o)},sendFixture:t=>ipcRenderer.invoke('skill-fixture-send',t)});`);
    win = new BrowserWindow({ show: false, width: 1100, height: 800,
      webPreferences: { preload, offscreen: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    win.webContents.on('console-message', event => { if (event.level === 'error') report.errors.push(event.message.slice(0, 600)); });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (info, done) => {
      done({ cancel: !info.url.startsWith(base + '/') });
    });
    const html = '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="' +
      pathToFileURL(path.join(client, 'components/panels/panels-compose-skills.css')).href + '">' +
      '<style>body{font:14px Arial;margin:40px}.cp-box{position:relative;margin:30px 0 210px;width:800px}' +
      'textarea{width:780px;height:80px}button{font:inherit}</style><h2>Existing starter</h2>' +
      '<div id="newHost" class="cp-box"><textarea id="newInput"></textarea></div>' +
      '<h2>Existing conversation</h2><div id="chatHost" class="cp-box"><textarea id="chatInput"></textarea></div>';
    const page = path.join(root, 'page.html'); fs.writeFileSync(page, html); await win.loadFile(page);
    await js(`window.__SODUWORK_TEST_HUB_CONFIG__={allowSwitch:true};localStorage.setItem('soduwork_work_hub_url',${JSON.stringify(base)});
      localStorage.setItem('soduwork_work_hub_environment_v1','development');localStorage.setItem('soduwork_work_development_hub_url_v1',${JSON.stringify(base)});
      window.User={id:'device-alice'};window.petSay=()=>{};void 0;`);
    const load = async file => js(fs.readFileSync(path.join(client, file), 'utf8') + '\nvoid 0;');
    for (const file of ['core/api-work-plugins.js', 'api.js', 'components/panels/compose-candidate-navigation.js',
      'components/panels/panels-compose-skills.js', 'components/panels/chat-composer-bindings.js']) await load(file);
    await js(`window.ComposeSurface={create:c=>{window.starter=c;return{_paintSetup(){},_restoreComposeDraft(){}}}};
      window.ComposeCapabilities={render(){}};void 0;`);
    await load('components/panels/panels-compose.js');
    await js(`(async()=>{await SoduWorkAPI.registerClient();
      window.chatContext={_skillLoadSeq:0,_sessionOptions:{}};window.chatBinding=ChatComposerBindings.create(chatContext);
      window.newPicker=ComposeSkills.create({host:document.getElementById('newHost'),input:document.getElementById('newInput'),
        onRefresh:()=>starter._loadCapabilities(true,true)});starter._skillPicker=newPicker;
      window.chatPicker=ComposeSkills.create({host:document.getElementById('chatHost'),input:document.getElementById('chatInput'),
        onRefresh:()=>chatBinding._loadChatSkills(true)});chatContext._skillPicker=chatPicker;
      await Promise.all([starter._loadCapabilities(),chatBinding._loadChatSkills()]);})()`);
    await js(`for(const prefix of ['new','chat']){const input=document.getElementById(prefix+'Input');input.value='#';input.selectionStart=1;input.dispatchEvent(new Event('input'));}`);
    assert.equal(await js('document.querySelectorAll("#newHost [data-skill-name]").length'), 13);
    assert.equal(await js('document.querySelectorAll("#chatHost [data-skill-name]").length'), 13);
    report.cases.push('Both already-mounted production loaders initially expose thirteen trusted installed skills');
    const importVersion = async version => {
      await js(`(async()=>{const body=await(await fetch(${JSON.stringify(base + '/fixture/package?version=' + version)})).blob();
        await SoduWorkAPI.importMySkill(new File([body],'weekly-business.skill'));})()`);
      await until(() => js(`document.querySelectorAll('#newHost [data-skill-name]').length===14&&
        document.querySelectorAll('#chatHost [data-skill-name]').length===14`), 'both catalog invalidations');
    };
    await importVersion('v1');
    assert.equal((await request('/capabilities')).skills.length, 14);
    report.cases.push('Actual personal package import refreshes both mounted menus to fourteen without restarting');
    for (const prefix of ['new', 'chat']) {
      report.stage = 'choose-' + prefix;
      await choose(prefix);
      report.stage = 'prepare-' + prefix;
      const prepared = await js(`soduWorkAPI.sendFixture({...ComposeSkills.submission('Run fixture',${prefix}Picker.selected()),version:'v1'})`);
      assert.equal(prepared.ok, true); assert.equal(prepared.pi && prepared.runner, true);
    }
    report.cases.push('Real mouse selection supplies structured names to fresh authorization, Pi and Runner resource preparation');
    await js(`newPicker.restore(['weekly-business']);chatPicker.restore(['weekly-business']);
      for(const prefix of ['new','chat']){const i=document.getElementById(prefix+'Input');i.value='#';i.selectionStart=1;i.dispatchEvent(new Event('input'));}`);
    await importVersion('v2');
    const updated = await js(`soduWorkAPI.sendFixture({...ComposeSkills.submission('Use latest',chatPicker.selected()),version:'v2'})`);
    assert.equal(updated.version, 'v2'); assert.deepEqual(await js('chatPicker.selected()'), ['weekly-business']);
    report.cases.push('Reimport keeps explicit chips and execution reads the newer immutable package and references');
    await js(`(async()=>{const d=await SoduWorkAPI.skillDetails('weekly-business');await SoduWorkAPI.deleteMySkill('weekly-business',d.checksum)})()`);
    await until(() => js(`!document.querySelector('#chatHost [data-skill-name="weekly-business"]')`), 'deleted skill removed');
    const stale = await js(`soduWorkAPI.sendFixture({...ComposeSkills.submission('Stale chip',chatPicker.selected()),version:'v2'})`);
    assert.equal(stale.ok, false, 'A retained draft chip must fail fresh authorization after deletion');
    assert.equal(stale.failureKind, 'skill-selection');
    report.cases.push('Deletion updates the menus and rejects a preserved stale chip before any model or tool execution');
    fs.writeFileSync(path.join(out, 'completed.png'), (await win.webContents.capturePage()).toPNG());
    report.ok = true;
  }).catch(async error => { report.error = error.stack;
    if (win && !win.isDestroyed()) fs.writeFileSync(path.join(out, 'failure.png'), (await win.webContents.capturePage()).toPNG());
  }).finally(async () => {
    try { await worker?.closeAll?.(); } catch {}
    if (win && !win.isDestroyed()) win.destroy();
    if (backend && backend.exitCode === null) {
      if (process.platform === 'win32') {
        try { execFileSync('taskkill', ['/pid', String(backend.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' }); } catch {}
      } else backend.kill();
    }
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ok: report.ok, cases: report.cases.length, error: report.error, report: path.join(out, 'report.json') }));
    app.exit(report.ok ? 0 : 1);
  });
}
