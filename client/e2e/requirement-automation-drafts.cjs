'use strict';
// Production detail/form/API -> authenticated loopback Hub -> durable independent draft.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict');
const {spawn, spawnSync} = require('node:child_process');
const electron = require('electron');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const client = path.resolve(__dirname, '..');

if (typeof electron === 'string') {
  (async () => {
    const output = process.argv[2], python = process.argv[3] || process.env.SODUWORK_TEST_PYTHON;
    if (!path.isAbsolute(output || '') || !python) throw Error('Absolute evidence directory and test Python are required');
    fs.mkdirSync(output, {recursive: true});
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'soduwork-collab-e2e-'));
    const probe = require('node:net').createServer();
    await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
    const hub = 'http://127.0.0.1:' + port, log = fs.openSync(path.join(output, 'hub.log'), 'w');
    const server = spawn(python, ['-m', 'uvicorn', 'tests.requirement_automation_browser_server:app', '--host', '127.0.0.1', '--port', String(port)],
      {cwd: path.join(client, '../hub-backend'), env: {...process.env, SODUWORK_COLLAB_E2E_ROOT: root}, stdio: ['ignore', log, log]});
    try {
      let ready = false;
      for (let i = 0; i < 150; i++) {
        try {ready = (await (await fetch(hub + '/ready')).json()).isolated === true;} catch {}
        if (ready || server.exitCode !== null) break;
        await wait(100);
      }
      if (!ready) throw Error('Isolated automation Hub failed to start; inspect hub.log');
      const env = {...process.env};
      for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
      const result = spawnSync(electron, [__filename, output, hub], {env, encoding: 'utf8', timeout: 150000});
      fs.writeFileSync(path.join(output, 'electron.log'), (result.stdout || '') + (result.stderr || '') + (result.error?.message || ''));
      const report = JSON.parse(fs.readFileSync(path.join(output, 'report.json'), 'utf8'));
      console.log(JSON.stringify(report));
      if (result.status !== 0 || !report.ok) throw Error('Requirement automation E2E failed');
    } finally {
      server.kill(); await Promise.race([new Promise(resolve => server.once('exit', resolve)), wait(3000)]);
      fs.closeSync(log);
    }
  })().catch(error => {console.error(error); process.exitCode = 1;});
} else {
  const {app, BrowserWindow} = electron, {pathToFileURL} = require('node:url');
  const [output, hub] = process.argv.slice(2);
  if (!path.isAbsolute(output || '') || !/^http:\/\/127\.0\.0\.1:\d+$/.test(hub || '')) throw Error('Isolated Hub required');
  app.setPath('userData', path.join(output, 'profile')); app.disableHardwareAcceleration();
  const report = {ok: false, checks: [], boundary: 'Native Electron and production detail, automation form, renderer API, Device authentication and HTTP/SQLite. Synthetic execution candidates and injected device bootstrap; no model, real account or native credential-storage validation.'};
  let win, bootstrap;
  let step = 0;
  const scrub = value => Object.values(bootstrap?.identities || {}).reduce((text, row) =>
    text.split(row.session).join('[session]'), String(value || ''));
  async function js(code, label = 'renderer step ' + (++step)) {
    const result = await win.webContents.executeJavaScript(`(async()=>{try{return {ok:true,value:await eval(${JSON.stringify(code)})};}
      catch(error){return {ok:false,error:String(error.stack||error)};}})()`, true);
    if (!result.ok) throw Error(label + ': ' + scrub(result.error));
    return result.value;
  }
  async function fixture(route, body) {
    const response = await fetch(hub + route, {method: body ? 'POST' : 'GET', headers: {'Content-Type': 'application/json'},
      ...(body ? {body: JSON.stringify(body)} : {})});
    assert.equal(response.status, 200); return response.json();
  }
  async function api(route, body, identity = bootstrap.identities.owner) {
    const response = await fetch(hub + '/api/v1' + route, {method: body ? 'POST' : 'GET', headers: {
      'Content-Type': 'application/json', Authorization: 'Device ' + identity.session}, ...(body ? {body: JSON.stringify(body)} : {})});
    return {status: response.status, data: await response.json()};
  }
  async function until(code, label) {
    for (let i = 0; i < 160; i++) {if (await js(code)) return; await wait(50);}
    throw Error('Timed out: ' + label);
  }
  async function click(selector) {
    const point = await js(`(async()=>{const n=document.querySelector(${JSON.stringify(selector)});
      if(!n||n.disabled)throw Error('Unavailable '+${JSON.stringify(selector)});
      n.scrollIntoView({block:'center',behavior:'instant'});await new Promise(r=>requestAnimationFrame(r));
      const r=n.getBoundingClientRect(),p={x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};
      const hit=document.elementFromPoint(p.x,p.y);
      if(!n.contains(hit))throw Error('Obscured '+${JSON.stringify(selector)}+' '+JSON.stringify({point:p,hit:hit?.outerHTML.slice(0,500),
        layers:[...document.querySelectorAll('.pui-layer')].map(row=>({className:row.className,connected:row.isConnected}))}));return p})()`);
    for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({type, ...point, button: 'left', clickCount: 1});
    await wait(80);
  }
  async function open(key, owner = 'owner') {
    await js(`WorkAutomationSheet.close(true);RequirementsDetail.close(true);window.fixtureIdentity=${JSON.stringify(bootstrap.identities[owner])};SoduWorkAPI.registerClient()`);
    await js(`RequirementsDetail.open(${JSON.stringify(bootstrap.tasks[key])})`);
    await until(`!!document.querySelector('.rq-detail-title-sr')`, 'requirement detail');
  }
  async function draft(key) {
    await open(key); await click('.rq-detail-more summary'); await click('[data-rq-automation]');
    await until(`!!document.querySelector('#wazForm')`, 'automation draft form');
    assert.equal(await js(`!!document.querySelector('[name=enabled]')`), false);
    assert.equal(await js(`document.querySelector('[data-waz-save]').textContent`), '保存草稿');
  }
  app.whenReady().then(async () => {
    try {
      bootstrap = await fixture('/e2e/automation-bootstrap');
      const desk = fs.readFileSync(path.join(client, 'desk.html'), 'utf8');
      const styles = [...desk.matchAll(/<link\b[^>]*href=["']([^"']+\.css)["'][^>]*>/g)].map(row => row[1]);
      const page = path.join(output, 'fixture.html');
      fs.writeFileSync(page, '<!doctype html><html data-theme="vivid"><meta charset="utf-8"><title>Requirement automation draft</title>' +
        styles.map(file => '<link rel="stylesheet" href="' + pathToFileURL(path.join(client, file)).href + '">').join('') +
        '<body style="margin:0"><main>Isolated requirement automation validation</main></body></html>');
      win = new BrowserWindow({show: false, width: 1200, height: 900, webPreferences: {
        contextIsolation: true, sandbox: true, offscreen: true, backgroundThrottling: false}});
      report.console = [];
      win.webContents.on('console-message', event => {
        if (event.level === 'error' || event.level === 3) report.console.push(scrub(event.message));
      });
      win.webContents.session.webRequest.onBeforeRequest({urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*']}, (request, done) => {
        done({cancel: !request.url.startsWith(hub + '/')});
      });
      await win.loadFile(page);
      await js(`window.fixtureErrors=[];addEventListener('error',e=>fixtureErrors.push(e.message));
        addEventListener('unhandledrejection',e=>fixtureErrors.push(String(e.reason)));
        window.__SODUWORK_TEST_HUB_CONFIG__={allowSwitch:true};localStorage.setItem('soduwork_work_hub_url',${JSON.stringify(hub)});
        window.fixtureIdentity=${JSON.stringify(bootstrap.identities.owner)};
        window.soduWorkAPI={deviceAuthBootstrap:async()=>fixtureIdentity};
        window.fixtureCalls=[];window.petSay=()=>{};window._schmLoad=async()=>[];
        window.RequirementsBoard={context:()=>({}),refresh:async()=>{}};
        window.fixtureFetch=window.fetch.bind(window);window.fetch=async(url,options={})=>{
          const route=new URL(url).pathname,method=options.method||'GET';
          fixtureCalls.push({route,method});
          if(route==='/api/v1/schedules/preflight'&&window.holdNextPreflight){window.holdNextPreflight=false;
            await new Promise(resolve=>{window.releasePreflight=resolve;window.preflightHeld=true;});}
          const response=await fixtureFetch(url,options);
          if(route==='/api/v1/schedules'&&method==='POST'){window.lastCreateBody=JSON.parse(options.body);
            if(window.dropCreateResponse&&response.ok){window.dropCreateResponse=false;throw Error('Synthetic lost response after commit');}}
          return response;};void 0`);
      for (const file of ['core/api-work-plugins.js', 'api.js', 'core/requirements.js', 'components/requirements/requirement-fields.js',
        'components/requirements/requirements-detail.js', ...['plugin-ui-host', 'schedule-timing', 'panels-forward-select',
          'work-automation-bindings', 'work-automation-view', 'work-automation-card-state', 'work-automation-sheet'].map(name => 'components/panels/' + name + '.js')]) {
        await js(fs.readFileSync(path.join(client, file), 'utf8') + '\nvoid 0', 'Loading ' + file);
      }
      await js(`SoduWorkAPI.taskExecutionOptions=async()=>({substrates:[{key:'local:pi',name:'Synthetic Pi',available:true}],repos:[]});SoduWorkAPI.registerClient()`);
      const initial = await fixture('/e2e/automation-state');
      await draft('ready');
      await js(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
      await js(`Promise.all([...document.querySelectorAll('.pui-layer,.pui-dialog,.waz-layer')]
        .flatMap(node=>node.getAnimations()).filter(animation=>Number.isFinite(animation.effect?.getComputedTiming().endTime))
        .map(animation=>animation.finished.catch(()=>{})))`);
      fs.writeFileSync(path.join(output, 'draft-before-save.png'), (await win.webContents.capturePage()).toPNG());
      await click('[data-waz-close]');
      await until(`!document.querySelector('.pui-layer')`, 'canceled automation surface removed');
      assert.deepEqual(await fixture('/e2e/automation-state'), initial);
      report.checks.push('Opening and canceling the production form creates no schedule and leaves every source field unchanged');

      await draft('ready'); await js('window.dropCreateResponse=true;void 0'); await click('[data-waz-save]');
      await until(`document.querySelector('#wazError')?.textContent.includes('Synthetic lost response')`, 'lost response retained');
      assert.equal((await fixture('/e2e/automation-state')).schedules.length, 1);
      await click('[data-waz-save]'); await until(`!!document.querySelector('.waz-saved')`, 'same draft recovered');
      const saved = await fixture('/e2e/automation-state');
      assert.equal(saved.schedules.length, 1); assert.equal(saved.schedules[0].enabled, false);
      assert.deepEqual(saved.tasks, initial.tasks);
      assert.deepEqual(saved.schedules[0].sourceRequirement, {id: bootstrap.tasks.ready,
        title: '独立自动化草稿 · ready', requirementVersion: 3});
      assert.match(await js(`document.querySelector('.waz-saved').textContent`), /尚未启用/);
      fs.writeFileSync(path.join(output, 'draft-saved.png'), (await win.webContents.capturePage()).toPNG());
      report.checks.push('Save creates one disabled independent draft with authorized provenance; lost-response retry recovers it without source changes');
      const body = await js('lastCreateBody');
      const repeated = await Promise.all([api('/schedules', body), api('/schedules', body)]);
      assert.ok(repeated.every(row => row.status === 200 && row.data.id === saved.schedules[0].id));
      assert.equal((await fixture('/e2e/automation-state')).schedules.length, 1);
      assert.doesNotMatch(JSON.stringify(body), /PRIVATE|local:private:model/);
      report.checks.push('Repeated authenticated HTTP submissions reuse one receipt without exporting private routing or model references');

      for (const key of ['stale', 'archive']) {
        await draft(key); await fixture('/e2e/automation-revise', {taskId: bootstrap.tasks[key], archive: key === 'archive'});
        await click('[data-waz-save]');
        await until(`document.querySelector('#wazError')?.textContent.includes(${JSON.stringify(key === 'archive' ? '归档' : '已更新')})`, key + ' rejected');
        assert.equal((await fixture('/e2e/automation-state')).schedules.length, 1);
      }
      report.checks.push('Real Hub version and archive conflicts remain visible in the editable form and create no draft');
      await open('shared', 'viewer');
      assert.equal(await js(`!!document.querySelector('[data-rq-automation]')`), false);
      const denied = await api('/schedules', {...body, creationRequestId: 'unauthorized-draft-request',
        sourceRequirement: {id: bootstrap.tasks.shared, requirementVersion: 3}}, bootstrap.identities.viewer);
      assert.equal(denied.status, 404);
      report.checks.push('Shared requirement visibility exposes no automation action and cannot bypass management permission over HTTP');

      await draft('switch');
      await js('window.holdNextPreflight=true;window.preflightHeld=false;void 0'); await click('[data-waz-save]');
      await until('window.preflightHeld===true', 'held authenticated preflight');
      await js(`window.fixtureIdentity=${JSON.stringify(bootstrap.identities.viewer)};SoduWorkAPI.registerClient()`);
      await js('releasePreflight();void 0'); await wait(250);
      assert.equal(await js(`!!document.querySelector('#wazForm')`), false);
      assert.equal((await fixture('/e2e/automation-state')).schedules.length, 1);
      report.checks.push('Account switching during preflight closes the old draft and prevents an old-account creation request');
      assert.deepEqual(await js('fixtureErrors'), []);
      report.ok = true;
    } catch (error) {
      report.error = error.stack;
      if (win && !win.isDestroyed()) fs.writeFileSync(path.join(output, 'failure.png'), (await win.webContents.capturePage()).toPNG());
    }
    finally {
      fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
      win?.destroy(); app.exit(report.ok ? 0 : 1);
    }
  });
}
