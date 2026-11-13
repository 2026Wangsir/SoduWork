'use strict';
// Exercise production composer layouts and the teammate picker with a synthetic directory.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const name of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE',
    'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[name];
  require('node:child_process').spawn(electron, [__filename, ...process.argv.slice(2)],
    { env, windowsHide: true, stdio: 'inherit' }).on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const assert = require('node:assert/strict'), { pathToFileURL } = require('node:url');
  const client = path.resolve(__dirname, '..');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-mate-mention-'));
  const output = path.resolve(process.argv[2] || path.join(temporary, 'evidence'));
  fs.mkdirSync(output, { recursive: true });
  app.setPath('userData', path.join(temporary, 'profile'));
  app.disableHardwareAcceleration();
  const report = { ok: false, cases: [], errors: [], networkRequests: 0,
    scope: 'Native Electron renderer; production starter/chat composer markup, styles and picker; synthetic directory; no Hub or real messages.' };
  let win;
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const js = source => win.webContents.executeJavaScript(source, true);
  async function until(source) {
    for (let index = 0; index < 100; index++) { if (await js(source)) return; await pause(20); }
    throw Error('Timed out: ' + source);
  }
  async function key(keyCode) {
    for (const type of ['keyDown', 'keyUp']) win.webContents.sendInputEvent({ type, keyCode });
    await pause(30);
  }
  async function open(text = '@') {
    await js("input.value='';input.focus();host.classList.add('wc-has-value');");
    await win.webContents.insertText(text);
    await until('!host.querySelector(".nmate-menu").hidden');
    await pause(150);
  }
  async function bounds() {
    return js(`(() => {
      const menu = host.querySelector('.nmate-menu'), r = menu.getBoundingClientRect(), a = host.getBoundingClientRect();
      return { left:r.left, right:r.right, top:r.top, bottom:r.bottom, width:r.width,
        hostLeft:a.left, hostTop:a.top, hostBottom:a.bottom, hostWidth:a.width,
        viewWidth:innerWidth, viewHeight:innerHeight, scroll:menu.scrollTop,
        scrollHeight:menu.scrollHeight, clientHeight:menu.clientHeight, hidden:menu.hidden };
    })()`);
  }
  function contained(b) {
    assert.equal(b.hidden, false);
    assert.ok(b.left >= 7 && b.right <= b.viewWidth - 7 && b.top >= 7 && b.bottom <= b.viewHeight - 7,
      'Menu must remain visible: ' + JSON.stringify(b));
  }
  function positioned(b, above = true) {
    contained(b);
    assert.ok(Math.abs(b.left - b.hostLeft) <= 1, 'Menu must align with composer: ' + JSON.stringify(b));
    if (above) assert.ok(b.bottom <= b.hostTop - 7 && b.bottom >= b.hostTop - 10,
      'Menu must sit directly above composer: ' + JSON.stringify(b));
  }
  async function verify(name, action) {
    try { await action(); report.cases.push({ name, ok: true }); }
    catch (error) {
      report.cases.push({ name, ok: false, error: error.stack, bounds: await bounds() });
      fs.writeFileSync(path.join(output, name + '-failed.png'), (await win.webContents.capturePage()).toPNG());
    }
  }
  app.whenReady().then(async () => {
    win = new BrowserWindow({ show: false, width: 1440, height: 860,
      webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] },
      (_request, callback) => { report.networkRequests++; callback({ cancel: true }); });
    win.webContents.on('console-message', event => { if (event.level === 'error') report.errors.push(event.message); });
    const styles = [...fs.readFileSync(path.join(client, 'desk.html'), 'utf8')
      .matchAll(/<link rel=["']stylesheet["'] href=["']([^"']+)["']/g)]
      .map(match => '<link rel="stylesheet" href="' + pathToFileURL(path.join(client, match[1])).href + '">').join('');
    const html = '<!doctype html><html data-desk-panel="workspace" data-workspace-view="create" data-theme="azure" ' +
      'data-skin="flat" style="--ws-rail-w:52px;--ws-side-w:290px"><head><meta charset="utf-8">' + styles +
      '<style>body{margin:0}#composePanel{position:fixed;left:var(--ws-main-left);right:0;top:0;bottom:0}</style></head><body></body></html>';
    const page = path.join(temporary, 'picker.html'); fs.writeFileSync(page, html);
    await win.loadFile(page);
    for (const file of JSON.parse(fs.readFileSync(path.join(client, 'core/locales/manifest.json'), 'utf8'))) {
      await js(fs.readFileSync(path.join(client, 'core/locales', file), 'utf8') + '\nvoid 0;');
    }
    for (const file of ['core/i18n-dom.js', 'core/i18n.js', 'components/panels/work-composer.js',
      'components/panels/compose-surface.js', 'components/panels/chat-composer-bindings.js', 'components/panels/chat-mate-mention.js']) {
      await js(fs.readFileSync(path.join(client, file), 'utf8') + '\nvoid 0;');
    }
    // Mount both production surfaces while leaving unrelated network/runtime bindings inactive.
    await js(`window.panel=ComposeSurface.create({_bind:()=>{}})._panel();panel.classList.add('show');
      ChatComposerBindings.create({_ensureHlCss(){},_ensureCollabView(){},_conversationDraftText(){return '';},
        _withConversationDraftRestore(){},_draftOwnerScope(){return 'fixture';},_rememberConversationDraft(){},_sessionOptions:{}})._mount();
      window.directory=[{id:'synthetic-user',name:'Example teammate',org:'Example team',hasBox:false}];
      window.mountPicker=kind=>{
        window.picker?.destroy();panel.dataset.stage=kind==='starter'?'compose':'chat';
        window.host=panel.querySelector(kind==='starter'?'.cp-box':'.nbox');window.input=host.querySelector('textarea');
        window.picker=ChatMateMention.create({host,input,mates:async()=>({mates:directory})});
      };void 0;`);
    for (const kind of ['starter', 'chat']) {
      win.webContents.setZoomFactor(1); win.setContentSize(1440, 860);
      await js(`document.documentElement.style.setProperty('--ws-side-w','290px');
        document.documentElement.removeAttribute('data-window-sidebar-hidden');mountPicker(${JSON.stringify(kind)});void 0;`);
      await verify(kind + '-english-desktop', async () => {
        await js("SoduWorkI18n.setLocale('en-US');void 0;"); await open(); positioned(await bounds());
        fs.writeFileSync(path.join(output, kind + '-desktop.png'), (await win.webContents.capturePage()).toPNG());
      });
      await verify(kind + '-sidebar-width-and-collapse', async () => {
        const before = await bounds();
        await js("document.documentElement.style.setProperty('--ws-side-w','380px');void 0;"); await pause(200);
        const wide = await bounds(); positioned(wide);
        assert.notEqual(wide.hostLeft, before.hostLeft, 'Sidebar must actually move the composer');
        assert.equal(wide.hostWidth, before.hostWidth, 'Capped composer remains the same width');
        await js("document.documentElement.setAttribute('data-window-sidebar-hidden','');void 0;"); await pause(200);
        const collapsed = await bounds(); positioned(collapsed); assert.notEqual(collapsed.hostLeft, wide.hostLeft);
        await js("document.documentElement.removeAttribute('data-window-sidebar-hidden');document.documentElement.style.setProperty('--ws-side-w','290px');void 0;");
      });
      await verify(kind + '-chinese-narrow-and-125-percent', async () => {
        await js("SoduWorkI18n.setLocale('zh-CN');void 0;");
        win.setContentSize(880, 700); await pause(200); positioned(await bounds());
        win.webContents.setZoomFactor(1.25); await pause(200); positioned(await bounds());
        fs.writeFileSync(path.join(output, kind + '-narrow-125.png'), (await win.webContents.capturePage()).toPNG());
        win.webContents.setZoomFactor(1); win.setContentSize(640, 700); await pause(200);
        const constrained = await bounds(); contained(constrained);
        assert.ok(Math.abs(constrained.left - Math.max(8, Math.min(constrained.hostLeft,
          constrained.viewWidth - 8 - constrained.width))) <= 1, 'Offscreen composer requires viewport clamping');
        await js("document.documentElement.setAttribute('data-window-sidebar-hidden','');void 0;"); await pause(200);
        positioned(await bounds());
        fs.writeFileSync(path.join(output, kind + '-640.png'), (await win.webContents.capturePage()).toPNG());
      });
      await verify(kind + '-close-and-reopen', async () => {
        await key('Escape'); assert.equal((await bounds()).hidden, true);
        const previous = await js('host.querySelector(".nmate-menu").style.cssText');
        win.setContentSize(1200, 800); await pause(150);
        assert.equal(await js('host.querySelector(".nmate-menu").style.cssText'), previous);
        await open(); positioned(await bounds());
      });
      await verify(kind + '-long-directory-scroll-and-filter', async () => {
        await js(`directory=Array.from({length:12},(_,i)=>({id:'user-'+i,name:'Example '+String(i).padStart(2,'0'),org:'Example team',hasBox:true}));
          mountPicker(${JSON.stringify(kind)});void 0;`);
        await open(); const before = await bounds(); positioned(before);
        assert.ok(before.scrollHeight > before.clientHeight, 'Long directory must scroll');
        await js("host.querySelector('.nmate-menu').scrollTop=10000;void 0;"); await pause(100);
        const after = await bounds(); assert.ok(after.scroll > 0); assert.equal(after.top, before.top);
        await js(`(()=>{const row=host.querySelector('.nmate-menu').lastElementChild,r=row.getBoundingClientRect();
          if(!row.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)))throw Error('Last teammate is clipped');})();`);
        await key('Escape'); await open('@11'); positioned(await bounds());
        assert.equal(await js('host.querySelectorAll(".nmate-menu [role=option]").length'), 1);
      });
      await js("directory=[{id:'synthetic-user',name:'Example teammate',org:'Example team',hasBox:false}];void 0;");
    }
    await verify('ancestor-scroll-repositions-and-destroy-releases', async () => {
      win.setContentSize(1000, 700);
      await js(`picker.destroy();panel.style.display='none';window.outer=document.createElement('div');
        outer.style.cssText='height:100vh;overflow:auto';outer.innerHTML='<div style="height:700px"></div><div id="scrollHost" class="work-composer" style="width:600px;height:140px;margin-left:180px"><textarea></textarea></div><div style="height:700px"></div>';
        document.body.appendChild(outer);host=outer.querySelector('#scrollHost');input=host.querySelector('textarea');
        picker=ChatMateMention.create({host,input,mates:async()=>({mates:directory})});outer.scrollTop=220;void 0;`);
      await open(); positioned(await bounds()); const before = await bounds();
      await js('outer.scrollTop+=100;void 0;'); await pause(150);
      const after = await bounds(); positioned(after); assert.ok(Math.abs(before.top - after.top - 100) <= 1);
      await js('outer.scrollTop=695;void 0;'); await pause(150);
      const nearTop = await bounds(); positioned(nearTop, false);
      assert.ok(nearTop.top > nearTop.hostBottom, 'Top-edge composer opens below when there is no room above');
      win.setContentSize(1000, 180); await pause(150); contained(await bounds());
      await js('picker.destroy();void 0;');
      assert.equal(await js('host.querySelector(".nmate-menu")'), null);
    });
    report.ok = report.cases.every(row => row.ok) && report.errors.length === 0 && report.networkRequests === 0;
  }).catch(error => { report.errors.push(error.stack); }).finally(() => {
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report)); win?.destroy(); app.exit(report.ok ? 0 : 1);
  });
}
