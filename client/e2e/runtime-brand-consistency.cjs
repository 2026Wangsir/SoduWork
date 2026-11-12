'use strict';

// Verify real renderer identity across management and both composer entry points.
// The optional baseline mode intercepts only the two old consumer scripts.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS']) delete env[key];
  require('node:child_process').spawn(electron, [__filename, ...process.argv.slice(2)],
    { env, windowsHide: true, stdio: 'inherit' }).on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, net } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const assert = require('node:assert/strict');
  const output = process.argv[2];
  assert.ok(output && path.isAbsolute(output), 'An absolute evidence directory is required');
  fs.mkdirSync(output, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-brand-e2e-'));
  app.setPath('userData', profile); app.disableHardwareAcceleration();
  if (process.platform === 'darwin') app.commandLine.appendSwitch('use-mock-keychain');
  const report = { ok: false, baseline: process.argv.includes('--baseline'), checks: [], failures: [], blockedRequests: [] };
  let win;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const js = source => win.webContents.executeJavaScript(source, true);
  async function until(source) {
    for (let i = 0; i < 200; i++) { if (await js(source)) return; await sleep(30); }
    throw Error('Timed out: ' + source);
  }
  async function click(selector) {
    await js(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'nearest'});void 0`);
    const point = await js(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    for (const type of ['mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',
      { type, button: 'left', clickCount: 1, ...point });
    await sleep(80);
  }
  async function inspect(surface, selector, id) {
    const result = await js(`(()=>{
      const host=document.querySelector(${JSON.stringify(selector)}), icon=host?.querySelector('[data-agent-brand]');
      if(!icon)return {error:'Missing shared runtime identity',text:host?.textContent};
      const id=AgentBrand.canonical(${JSON.stringify(id)}),template=document.createElement('template');
      template.innerHTML=AgentBrand.html(id);
      const expected=template.content.firstElementChild;
      const signature=el=>({id:el.dataset.agentBrand,label:el.getAttribute('aria-label'),role:el.getAttribute('role'),
        mark:el.textContent.trim(),paths:[...el.querySelectorAll('path')].map(p=>p.getAttribute('d'))});
      const mark=icon.querySelector('.agent-monogram,svg'),bounds=icon.getBoundingClientRect(),m=mark?.getBoundingClientRect();
      const range=document.createRange();if(mark)range.selectNodeContents(mark);const text=mark?.tagName==='SPAN'?range.getBoundingClientRect():m;
      return {actual:signature(icon),expected:signature(expected),visible:icon.checkVisibility(),
        unobscured:icon.contains(document.elementFromPoint(bounds.x+bounds.width/2,bounds.y+bounds.height/2)),
        bounds:{width:bounds.width,height:bounds.height},fits:!!text&&text.left>=bounds.left-1&&text.right<=bounds.right+1&&text.top>=bounds.top-1&&text.bottom<=bounds.bottom+1};
    })()`);
    report.checks.push({ surface, selector, id, ...result });
    try {
      assert.equal(result.error, undefined); assert.deepEqual(result.actual, result.expected);
      assert.equal(result.visible, true); assert.equal(result.fits, true); assert.equal(result.unobscured, true);
      assert.notEqual(result.actual.mark, '•');
    } catch (_) { report.failures.push({ surface, selector, id, result }); }
  }
  async function screenshot(name) {
    fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG());
  }
  app.whenReady().then(async () => {
    win = new BrowserWindow({ show: false, width: 1400, height: 950,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } });
    win.webContents.debugger.attach('1.3');
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (request, done) => {
      report.blockedRequests.push(request.url); done({ cancel: true });
    });
    if (report.baseline) {
      const old = Object.fromEntries(['chat-runtime-picker.js', 'panels-compose-runtime.js'].map(name => [name,
        require('node:child_process').execFileSync('git', ['show', '34ed263a526bc3366a02561c7cd6714923a0f3c3:client/components/panels/' + name],
          { cwd: path.resolve(__dirname, '../..'), encoding: 'utf8' })]));
      win.webContents.session.protocol.handle('file', request => {
        const name = path.basename(new URL(request.url).pathname);
        return Object.hasOwn(old, name) ? new Response(old[name], { headers: { 'content-type': 'text/javascript' } })
          : net.fetch(request.url, { bypassCustomProtocolHandlers: true });
      });
    }
    await win.loadFile(path.join(__dirname, 'fixtures/runtime-brand-management.html'));
    await until('window.fixtureReady');
    for (const id of await js('identities')) await inspect('management', '[data-ak="' + id + '"]', id);
    assert.deepEqual(await js('errors'), []);
    await screenshot('management');
    for (const surface of ['conversation', 'new-chat']) {
      const chat = surface === 'conversation';
      await win.loadFile(path.join(__dirname, chat ? 'fixtures/conversation-runtime-picker.html' : '../tests/composer-menu.html'));
      const trigger = chat ? '#nchatRuntime' : '#cpRuntime';
      const popup = chat ? '.nchat-runtime-pop' : '#cpRuntimePop';
      const footer = chat ? '#nchatRuntimeMissing' : '#cpRuntimeMissing';
      await until(`document.querySelector(${JSON.stringify(trigger)})`);
      await js(`window.brandRuntimes=['pi','harness2','qwen','private-agent'].map((id,index)=>({id,displayName:AgentBrand.LABELS[id]||'Private runtime',
        version:'1.0.0',order:index+1,group:index?'more':'recommended',modelMode:'managed',availability:{ok:true}}));
        window.brandMissing=['codex','opencode','claude','kimi','dsh','private-agent'].map(id=>({id,displayName:AgentBrand.LABELS[id]||'Private runtime'}));
        window.brandReply=()=>({ok:true,runtimes:brandRuntimes,availableRuntimes:brandRuntimes,missing:brandMissing});
        soduWorkAPI.conversationSession.runtimes=async()=>brandReply();
        soduWorkAPI.conversationSession.conversationRuntimes=async()=>brandReply();
        window.dispatchEvent(new Event('agent-runtimes-changed'));void 0`);
      // The full workspace includes its sidebar; keep it at a desktop width.
      // The standalone conversation fixture also exercises a narrow composer.
      for (const [width, zoom] of [[1400, 1], [chat ? 500 : 1000, 1.25]]) {
        win.setSize(width, 950); win.webContents.setZoomFactor(zoom); await sleep(120);
        await click(trigger);
        await until(`document.querySelector(${JSON.stringify(popup)})?.checkVisibility() && document.querySelector(${JSON.stringify(popup)}).querySelectorAll('[data-runtime]').length===4`);
        for (const id of ['pi', 'harness2', 'qwen', 'private-agent']) await inspect(surface + ':' + width, popup + ' [data-runtime="' + id + '"]', id);
        for (const id of ['codex', 'opencode', 'claude', 'kimi', 'dsh', 'private-agent']) await inspect(surface + ':footer:' + width,
          footer + ' [data-runtime-missing="' + id + '"]', id);
        await screenshot(surface + '-' + width);
        await click(trigger);
      }
      assert.deepEqual(await js(chat ? 'errors' : 'fixtureErrors'), []);
      win.setSize(1400, 950); win.webContents.setZoomFactor(1);
    }
    assert.deepEqual(report.blockedRequests, []);
    assert.deepEqual(report.failures, [], 'Runtime identity or clipping differs across surfaces');
    report.ok = true;
  }).catch(error => { report.error = String(error.stack || error); }).finally(() => {
    win?.destroy(); fs.rmSync(profile, { recursive: true, force: true });
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ok: report.ok, checks: report.checks.length, failures: report.failures.length, output, error: report.error }));
    app.exit(report.ok ? 0 : 1);
  });
}
