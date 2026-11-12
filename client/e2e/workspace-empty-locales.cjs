'use strict';
// Production renderers in Electron; empty catalogs are synthetic and network is blocked.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS']) delete env[key];
  const child = require('node:child_process').spawn(electron, [__filename, ...process.argv.slice(2)],
    { env, windowsHide: true, stdio: 'inherit' });
  const timer = setTimeout(() => child.kill(), 60000);
  child.on('exit', code => { clearTimeout(timer); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = electron;
  const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
  const output = path.resolve(process.argv[2] || 'outputs/workspace-empty-locales');
  const temporary = require('./lib/isolated-profile.cjs').isolateProfile(app, 'empty-locales').root;
  fs.mkdirSync(output, { recursive: true });
  const root = path.resolve(__dirname, '..'), read = file => fs.readFileSync(path.join(root, file), 'utf8');
  const report = { ok: false, cases: [], failures: [], errors: [], network: [] };
  let win;
  const js = code => win.webContents.executeJavaScript(code, true);
  const tick = () => js('new Promise(resolve => setTimeout(resolve, 100))');
  const load = async files => { for (const file of files) await js(read(file) + '\n;void 0;'); };
  const check = async (name, fn) => {
    try { await fn(); report.cases.push(name); }
    catch (error) { report.failures.push({ name, error: error.message }); }
  };
  const shot = async name => fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG());
  async function locale(value) { await js(`SoduWorkI18n.setLocale(${JSON.stringify(value)})`); await tick(); }
  async function click(selector) {
    const point = await js(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
      return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
    for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, button: 'left', clickCount: 1, ...point });
    await tick();
  }
  app.whenReady().then(async () => {
    const page = path.join(temporary, 'fixture.html');
    fs.writeFileSync(page, '<!doctype html><html data-desk-panel="workspace"><meta charset="utf-8"><body></body></html>');
    win = new BrowserWindow({ show: false, width: 1100, height: 850,
      webPreferences: { contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (request, callback) => {
      report.network.push(request.url); callback({ cancel: true });
    });
    win.webContents.on('console-message', event => { if (event.level === 'error') report.errors.push(event.message); });
    await win.loadFile(page);
    await load(JSON.parse(read('core/locales/manifest.json')).map(file => 'core/locales/' + file));
    await load(['core/i18n-dom.js', 'core/i18n.js', 'core/localized-text.js']);
    const css = ['theme/variables.css', 'components/panels/panels-base.css', 'components/panels/panels-schedules.css',
      'components/panels/panels-apps.css', 'components/panels/chat-plugin-mention.css', 'components/requirements/requirements-board.css'];
    await js(`document.head.insertAdjacentHTML('beforeend', '<style>'+${JSON.stringify(css.map(read).join('\n'))}+'</style>');
      window.esc=value=>String(value??'').replace(/[&<>\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c]));
      window.expandForOverlay=window.shrinkFromOverlay=window.makeDraggable=()=>{};
      window.SoduWorkAPI={listSchedules:async()=>[],listAIAgents:async()=>({agents:[]}),listRepos:async()=>[],
        listScheduleTemplates:async()=>[],pluginCatalog:async()=>({items:[]}),myModels:async()=>({usable:[]})};void 0;`);
    await load(['components/panels/schedule-timing.js', 'components/panels/panels-schedules-methods.js',
      'components/panels/panels-schedules-cards.js', 'components/panels/panels-schedules.js',
      'components/panels/panels-schedules-editor.js', 'components/panels/panels-schedules-runs.js',
      'components/panels/panels-apps.js', 'core/requirements.js', 'components/requirements/requirements-view.js',
      'components/panels/plugin-ui-host.js', 'components/panels/work-entry-sheet.js',
      'components/panels/work-automation-sheet.js', 'components/panels/plugin-debug-card.js',
      'components/panels/compose-candidate-navigation.js', 'components/panels/chat-plugin-mention-model.js',
      'components/panels/chat-plugin-mention.js']);
    await locale('en-US');
    await js('openSchedulePanel();'); await tick();
    await check('English automation empty state', async () => {
      assert.doesNotMatch(await js('document.querySelector("#schBody").innerText'), /[\u4e00-\u9fff]/);
    });
    await shot('automation-en');
    await js('document.querySelector("#schPanel").remove();SoduWorkApps.open();SoduWorkApps.render(true)'); await tick();
    await check('English personal and market app empty states', async () => {
      const text = await js('document.querySelector("#appsBody").innerText');
      assert.match(text, /No apps yet/); assert.match(text, /No apps in the marketplace yet/);
      assert.doesNotMatch(text, /[\u4e00-\u9fff]/);
    });
    await shot('apps-en');
    await js(`document.querySelector('#appsPanel').remove();document.body.innerHTML='<main id="filters"></main><section id="composer"><textarea></textarea></section>';
      window.filterState={...Requirements.defaults,phase:'reviewing'};
      document.querySelector('#filters').innerHTML=RequirementsView.chips(filterState,[],{});
      window.picker=ChatPluginMention.create({host:document.querySelector('#composer'),input:document.querySelector('textarea'),
        actions:()=>PluginUIHost.actions(),catalog:async()=>({items:[]})});picker.open();`); await tick();
    await check('English active issue filter label', async () => {
      assert.doesNotMatch(await js('document.querySelector("#filters").innerText'), /[\u4e00-\u9fff]/);
    });
    await check('English built-in slash menu', async () => {
      assert.equal(await js('document.querySelectorAll(".nplugin-option.is-action").length'), 4);
      assert.doesNotMatch(await js('document.querySelector(".nplugin-menu").innerText'), /[\u4e00-\u9fff]/);
    });
    await shot('commands-and-filters-en');
    const commandCases = [
      ['issue', 'work.requirement.create', '需求'], ['automation', 'work.automation.create', '自动化'],
      ['debug-plugin', 'work.plugin.debug', '调试插件'], ['plugin', 'work.plugin.create', '制作插件'],
    ];
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    for (const [command, id, canonical] of commandCases) {
      await check('Native input and selection: /' + command, async () => {
        await js(`picker.clearAction();document.querySelector('textarea').value='';document.querySelector('textarea').focus();`);
        await win.webContents.insertText('/' + command); await tick();
        const index = await js(`Array.from(document.querySelectorAll('.nplugin-option')).findIndex(e=>e.querySelector('b').textContent.startsWith(${JSON.stringify('/' + command + ' · ')}))`);
        assert.ok(index >= 0, 'the displayed command can be searched');
        await click('.nplugin-option:nth-child(' + (index + 1) + ')');
        assert.deepEqual(await js('({id:picker.action()?.actionId,command:picker.action()?.command})'), { id, command: canonical });
        assert.equal(await js(`picker.commandText('保留原文 /login')`), '/' + canonical + ' 保留原文 /login');
        if (id !== 'work.plugin.create') assert.equal(await js(`PluginUIHost.commandFromText(${JSON.stringify('/' + command + ' sample')}).actionId`), id);
      });
    }
    await check('Locale toggles preserve user text and custom plugin metadata', async () => {
      await js(`picker.destroy();window.customName='新建需求';window.customDescription='记录目标与完成标准，保存到需求池或交办给同事';
        window.picker=ChatPluginMention.create({host:document.querySelector('#composer'),input:document.querySelector('textarea'),
          actions:()=>PluginUIHost.actions(),catalog:async()=>({items:[{pluginId:'local:custom',name:customName,description:customDescription,personal:true}]})});
        document.querySelector('textarea').value='用户 draft /需求';picker.open();`); await tick();
      for (const value of ['zh-CN', 'ja-JP', 'ko-KR', 'en-US', 'zh-CN', 'en-US']) {
        await locale(value);
        assert.equal(await js('document.querySelector("textarea").value'), '用户 draft /需求');
        assert.deepEqual(await js(`Array.from(document.querySelector('.nplugin-option:not(.is-action) .nplugin-option-copy').children,e=>e.textContent)`),
          ['新建需求', '记录目标与完成标准，保存到需求池或交办给同事']);
        if (value === 'en-US') assert.doesNotMatch(await js(`Array.from(document.querySelectorAll('.nplugin-option.is-action'),e=>e.innerText).join('\\n')`), /[\u4e00-\u9fff]/);
        if (value === 'zh-CN') assert.match(await js('document.querySelector(".nplugin-option.is-action b").textContent'), /\/需求 · 新建需求/);
      }
    });
    await check('All active filter labels translate without changing user values', async () => {
      await js(`document.querySelector('#filters').innerHTML=RequirementsView.chips({...Requirements.defaults,
        phase:'reviewing',kind:'bug',priority:'high',project:'project-1',owner:'user-1',tag:'fixture-tag',due:'today',attention:'blocked'},
        [{projectId:'project-1',projectName:'保存',assigneeUserId:'user-1',assigneeName:'删除',tags:['fixture-tag']}],{});`); await tick();
      assert.equal(await js('document.querySelectorAll(".rq-filter-chip").length'), 8);
      assert.doesNotMatch(await js(`Array.from(document.querySelectorAll('.rq-filter-chip'),e=>e.firstChild.textContent).join('')`), /[\u4e00-\u9fff]/);
      assert.deepEqual(await js(`Array.from(document.querySelectorAll('#filters [data-user-content]'),e=>e.textContent)`), ['保存', '删除']);
    });
    await check('Saved English locale survives a new renderer and dynamic automation render', async () => {
      await locale('en-US');
      await win.loadFile(page);
      await load(JSON.parse(read('core/locales/manifest.json')).map(file => 'core/locales/' + file));
      await load(['core/i18n-dom.js', 'core/i18n.js']);
      assert.equal(await js('SoduWorkI18n.getLocale()'), 'en-US');
      await js(`document.body.innerHTML='<div id="schBody"></div>';window.esc=String;window._schRecipeHtml=()=>'';void 0;`);
      await load(['components/panels/panels-schedules.js']);
      await js('_renderSchPanel()'); await tick();
      assert.doesNotMatch(await js('document.querySelector("#schBody").innerText'), /[\u4e00-\u9fff]/);
    });
    assert.deepEqual(report.errors, []); assert.deepEqual(report.network, []);
    report.ok = !report.failures.length;
  }).catch(error => { report.error = error.stack; }).finally(() => {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2)); win?.destroy(); app.exit(report.ok ? 0 : 1);
  });
}
