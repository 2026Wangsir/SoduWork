'use strict';
// Exercise generated skill delivery through the production install dialog,
// authenticated Hub catalog and both runtime resource preparation paths.
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
  const out = path.resolve(process.argv[2] || path.join(repo, 'outputs/created-skill-install'));
  const name = 'created-skill-fixture';
  const source = path.join(root, name);
  const references = 'Read the supplied sample and preserve its meaning.\n';
  const report = { ok: false, cases: [], errors: [] };
  fs.mkdirSync(out, { recursive: true });
  app.setPath('userData', path.join(root, 'profile')); app.disableHardwareAcceleration();
  let win, backend, identity, base, worker;
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const js = code => win.webContents.executeJavaScript(code, true);
  async function until(check, label, timeout = 30000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { try { if (await check()) return; } catch {} await pause(40); }
    throw Error('Timed out: ' + label);
  }
  async function request(route, account = identity) {
    const response = await fetch(base + '/api/v1' + route, {
      headers: { Authorization: 'Device ' + account.session } });
    assert.equal(response.ok, true, 'Fixture request failed: ' + route);
    return response.json();
  }
  async function click(selector) {
    const point = await js(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node || node.disabled) throw Error('Control unavailable');
      node.scrollIntoView({ block: 'center' });
      const bounds = node.getBoundingClientRect();
      const x = Math.round(bounds.x + bounds.width / 2), y = Math.round(bounds.y + bounds.height / 2);
      if (!node.contains(document.elementFromPoint(x, y))) throw Error('Control is occluded');
      return { x, y };
    })()`);
    for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, ...point, button: 'left', clickCount: 1 });
  }
  app.whenReady().then(async () => {
    const python = process.env.SODUWORK_TEST_PYTHON;
    if (!python) throw Error('Set SODUWORK_TEST_PYTHON to an interpreter with backend test dependencies');
    fs.mkdirSync(path.join(source, 'references'), { recursive: true });
    fs.writeFileSync(path.join(source, 'SKILL.md'), '---\nname: ' + name +
      '\ndescription: Preserve the meaning of a supplied sample.\n---\n\n# Created skill fixture\n\nRead [the rules](references/rules.md).\n');
    fs.writeFileSync(path.join(source, 'references/rules.md'), references);
    const delivery = path.join(root, 'delivery');
    const built = require('../../skills/skill-studio/scripts/skill-package.cjs').build({ source, out: delivery, targets: 'soduwork' });
    const packagePath = path.join(delivery, built.exports[0].file);
    assert.match(packagePath, /\.skill$/);
    const row = { path: packagePath, artifactId: 'created-skill', relative: path.relative(root, packagePath) };
    const handle = { cwd: root, sessionId: 'created-skill-session', inFlight: () => false,
      outputSnapshot: () => ({ files: [row], delivery: { items: [row] } }) };
    const artifact = require('../main/conversation/artifact-runtime').snapshot(handle).items.find(item => item.path === packagePath);
    assert.equal(artifact.pluginDraft, true, 'The generated skill must expose a conversation install action');
    assert.equal(artifact.skillPackage, true, 'The indexed artifact must retain its skill type');
    const listener = net.createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
    const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
    base = 'http://127.0.0.1:' + port;
    backend = spawn(python, ['-u', path.join(__dirname, 'fixtures/created_skill_hub.py'), String(port), root], {
      cwd: path.join(repo, 'hub-backend'), windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, PYTHONUTF8: '1' } });
    backend.stderr.on('data', bytes => { report.errors.push(String(bytes).slice(0, 500)); });
    await until(async () => (await fetch(base + '/healthz')).ok, 'isolated backend');
    const tokens = await (await fetch(base + '/fixture/auth')).json();
    identity = { hub: base, clientId: 'device-alice', session: tokens.alice };
    require('../main/pi-session/environment-ipc').install({ app, ipcMain, session: {}, identityOf: async () => identity,
      capabilityGrantsOf: () => [], _skillDirs: () => [], workDir: () => root, _saveConf() {}, _conf: () => ({}) });
    ipcMain.handle('created-skill-auth', () => ({ ok: true, stored: true, clientId: identity.clientId,
      session: identity.session, user: { id: 'alice' }, expiresIn: 1800 }));
    ipcMain.handle('created-skill-draft', async (_event, ref, target) => {
      assert.equal(ref, handle.sessionId);
      return require('../main/pi-session/plugin-draft').readSessionAsync(handle, target, app);
    });
    ipcMain.handle('created-skill-send', async (_event, turn) => {
      const skillTurn = require('../main/pi-session/skill-turn');
      const resolveSkills = skillTurn.resolver({ app, identity, identityOf: async () => identity, skillDirs: () => [] });
      const prepared = await skillTurn.prepare({ cwd: root, resolveSkills }, turn);
      assert.equal(prepared.ok, true, prepared.reason);
      assert.deepEqual(prepared.names, [name]);
      assert.equal(fs.readFileSync(path.join(prepared.dirs[0], 'SKILL.md'), 'utf8'), fs.readFileSync(path.join(source, 'SKILL.md'), 'utf8'));
      assert.equal(fs.readFileSync(path.join(prepared.dirs[0], 'references/rules.md'), 'utf8'), references);
      worker ||= require('../main/agent-runtime/process-session');
      const runner = await skillTurn.prepareRunner({ app, cwd: root, resolveSkills }, turn, worker);
      assert.equal(runner.ok, true, runner.reason); assert.deepEqual(runner.names, [name]);
      return { ok: true, names: prepared.names, pi: true, runner: true };
    });
    const preload = path.join(root, 'preload.cjs');
    fs.writeFileSync(preload, `const { contextBridge, ipcRenderer } = require('electron');
      contextBridge.exposeInMainWorld('soduWorkAPI', {
        deviceAuthBootstrap: () => ipcRenderer.invoke('created-skill-auth'),
        conversationSession: {
          capabilities: options => ipcRenderer.invoke('conversation-capabilities', options),
          pluginDraft: (ref, target) => ipcRenderer.invoke('created-skill-draft', ref, target)
        }, sendFixture: turn => ipcRenderer.invoke('created-skill-send', turn)
      });`);
    win = new BrowserWindow({ show: false, width: 1280, height: 1000,
      webPreferences: { preload, offscreen: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    win.webContents.on('console-message', event => { if (event.level === 'error') report.errors.push(event.message.slice(0, 600)); });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (info, done) => {
      done({ cancel: !info.url.startsWith(base + '/') });
    });
    const styles = [...fs.readFileSync(path.join(client, 'desk.html'), 'utf8').matchAll(/<link rel="stylesheet" href="([^"]+)"/g)]
      .map(match => '<link rel="stylesheet" href="' + pathToFileURL(path.join(client, match[1])).href + '">').join('');
    const page = path.join(root, 'page.html');
    fs.writeFileSync(page, '<!doctype html><meta charset="utf-8">' + styles +
      '<style>body{background:var(--bg-1);color:var(--ink)}#capPanel{position:fixed;inset:20px;width:auto;height:auto;max-height:none;transform:none}' +
      '#delivery{padding:40px}.nplugin-draft{max-width:1000px}</style>' +
      '<section id="delivery"><div class="nmsg ai"><p>The skill and supporting rules are ready.</p></div></section>');
    await win.loadFile(page);
    await js(`window.__SODUWORK_TEST_HUB_CONFIG__ = { allowSwitch: true };
      localStorage.setItem('soduwork_work_hub_url', ${JSON.stringify(base)});
      localStorage.setItem('soduwork_work_hub_environment_v1', 'development');
      localStorage.setItem('soduwork_work_development_hub_url_v1', ${JSON.stringify(base)});
      window.User = { id: 'device-alice' }; window.fixtureMessages = []; window.petSay = text => fixtureMessages.push(text); void 0;`);
    const load = async file => js(fs.readFileSync(path.join(client, file), 'utf8') + '\nvoid 0;');
    for (const file of ['core/api-work-plugins.js', 'api.js', 'core/plugin-icon.js', 'core/connector-brand.js',
      'components/panels/skill-catalog-sync.js', 'components/panels/plugin-catalog-sync.js',
      'components/panels/plugin-catalog-format.js', 'components/panels/plugin-publication-ux.js',
      'components/panels/plugin-dependency-ux.js', 'components/panels/plugin-install-setup.js',
      'components/panels/plugin-lifecycle.js', 'components/panels/plugin-presentation.js',
      'components/panels/panels-capability-directory.js', 'components/panels/panels-capability-plugins.js',
      'components/panels/panels-capability-mcp.js', 'components/panels/connector-export.js',
      'components/panels/connector-config.js', 'components/panels/connector-auth.js',
      'components/panels/connector-editor.js', 'components/panels/connector-selection.js',
      'components/panels/connector-directory.js', 'components/panels/panels-capability-editors.js',
      'components/panels/panels-capabilities.js', 'components/panels/panels-plugin-maker-utils.js',
      'components/panels/chat-output-links.js']) await load(file);
    await js(`(async () => {
      await SoduWorkAPI.registerClient();
      ChatOutputLinks.pluginDrafts(document.getElementById('delivery'), ${JSON.stringify([artifact])}, ${JSON.stringify(handle.sessionId)});
      document.getElementById('delivery').onclick = event => {
        const button = event.target.closest('[data-install-plugin-draft]');
        if (button) openConversationPluginDraft(button.dataset.pluginDraftRef, button.dataset.installPluginDraft, button);
      };
    })()`);
    await click('[data-install-plugin-draft]');
    await until(() => js('document.querySelector("#capModalTitle")?.textContent === "安装技能"'), 'skill installation dialog');
    assert.equal((await request('/capabilities')).skills.some(item => item.name === name), false);
    fs.writeFileSync(path.join(out, 'install-skill.png'), (await win.webContents.capturePage()).toPNG());
    report.cases.push('Generated .skill exposes the production conversation action and opens Install Skill before saving');
    await click('#capImportDo');
    await until(async () => (await request('/capabilities')).skills.some(item => item.name === name && item.enabled), 'personal skill import and enable');
    await until(() => js('!document.getElementById("capImportDo") || document.getElementById("capModalLayer").hidden'), 'installation completion');
    const details = await request('/skills/' + name + '/details');
    assert.equal(details.scope, 'personal');
    assert.equal(details.fileCount, 2);
    assert.equal((await request('/capabilities', { session: tokens.bob })).skills.some(item => item.name === name), false);
    assert.equal(fs.existsSync(path.join(app.getPath('userData'), 'personal-plugins.json')), false);
    assert.equal((await request('/plugins/catalog')).items.some(item => item.key === name || item.key === 'skill-' + name), false);
    report.cases.push('Confirmation imports an enabled private skill with both files, without adding a personal or Hub plugin');
    await js('openCapabilityPanel()');
    await click('[data-cap-tab="skills"]');
    await until(() => js(`!!document.querySelector('[data-skill-details="${name}"]')`), 'installed skill in the production Skills tab');
    assert.equal(await js(`document.querySelector('[data-skill="${name}"]').getAttribute('aria-pressed')`), 'true');
    fs.writeFileSync(path.join(out, 'installed-skill.png'), (await win.webContents.capturePage()).toPNG());
    report.cases.push('The production Skills tab lists and enables the generated skill after installation');
    const prepared = await js(`soduWorkAPI.sendFixture({ text: 'Apply the supplied rules', skills: [${JSON.stringify(name)}] })`);
    assert.equal(prepared.pi && prepared.runner, true);
    report.cases.push('Fresh account authorization and immutable synchronization prepare the unchanged SKILL.md and reference for Pi and Runner');
    report.ok = true;
  }).catch(async error => {
    report.error = error.stack;
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
