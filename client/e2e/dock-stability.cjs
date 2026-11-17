'use strict';
// Isolated real Electron renderer. This does not exercise native mouse routing,
// Windows overlay regions, the user's client, business services, or any model.
// node client/e2e/dock-stability.cjs [--output DIR] [--dock-source FILE]
// --dock-source permits comparing a preserved pre-fix snapshot with current code.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE',
    'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  const child = require('node:child_process').spawnSync(electron, [__filename, ...process.argv.slice(2)], {
    env, windowsHide: true, stdio: 'inherit', timeout: 45000 });
  if (child.error) console.error(child.error.message);
  process.exit(child.status ?? 1);
}

const { app, BrowserWindow } = electron;
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const args = process.argv.slice(2), options = {};
for (let index = 0; index < args.length; index += 2) {
  assert.ok(['--output', '--dock-source'].includes(args[index]) && args[index + 1],
    'Usage: node client/e2e/dock-stability.cjs [--output DIR] [--dock-source FILE]');
  options[args[index]] = args[index + 1];
}
const client = path.resolve(__dirname, '..');
const source = path.resolve(options['--dock-source'] || path.join(client, 'components/pet/pet-dock.js'));
const unique = new Date().toISOString().replace(/[:.]/g, '-') + '-' + process.pid;
const output = path.resolve(options['--output'] || path.join(client, '../outputs/dock-stability-' + unique));
const owned = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-dock-stability-'));
app.setPath('userData', path.join(owned, 'profile'));
fs.mkdirSync(output, { recursive: true });
assert.equal(fs.existsSync(path.join(output, 'report.json')), false, 'Use a new output directory; prior evidence must not be overwritten');
const report = {
  ok: false,
  boundary: 'Isolated real Electron renderer with production dock JS/CSS, synthetic PointerEvents and CDP pseudo states. No native mouse/hit-test or physical desktop flicker verification; no user client, business service, model, or real session.',
  source, sourceSha256: createHash('sha256').update(fs.readFileSync(source)).digest('hex'),
  electron: process.versions.electron, chromium: process.versions.chrome,
  cases: [], errors: [],
};
let win;
const js = code => win.webContents.executeJavaScript(code);
const nearRect = (actual, expected, label) => {
  for (const field of ['x', 'y', 'width', 'height'])
    assert.ok(Math.abs(actual[field] - expected[field]) < 0.1, label + ': ' + field + ' changed from ' + expected[field] + ' to ' + actual[field]);
};
async function check(name, operation) {
  const item = { name, ok: false };
  report.cases.push(item);
  try { await operation(item); item.ok = true; }
  catch (error) { item.error = error.stack || String(error); }
}
const timeout = setTimeout(() => { console.error('dock-stability timed out'); app.exit(2); }, 40000);

app.whenReady().then(async () => {
  const url = file => pathToFileURL(path.join(client, file)).href;
  const html = path.join(owned, 'fixture.html');
  fs.writeFileSync(html, `<!doctype html><html><head><meta charset="utf-8"><title>Dock stability - isolated renderer</title>
    <link rel="stylesheet" href="${url('theme/variables.css')}">
    <link rel="stylesheet" href="${url('components/pet/pet.css')}">
    <style>body{margin:0;background:#eef2f7}#petUnreadBadge{position:absolute;left:5px;top:5px}</style>
    </head><body><div class="edge-dock" id="edgeDock"></div><span id="petUnreadBadge" hidden></span>
    <script>
      window.cfg={dockVisible:true,tasksOn:true,dockX:null,dockY:120};
      window.saved=[];window.saveCfg=()=>saved.push({...cfg});window.taskArea=null;
      window.unread=0;window.noticeUnread=()=>unread;
      window.dragHooks={begin:0,end:0};window.beginOverlayDrag=()=>dragHooks.begin++;
      window.endOverlayDrag=()=>dragHooks.end++;
      window.SkinRegistry={getSkins:()=>[],applySkinCSSVars:()=>{}};window.currentSkinId=()=>'';
      window.fixtureErrors=[];addEventListener('error',event=>fixtureErrors.push(event.message));
    </script><script src="${pathToFileURL(source).href}"></script></body></html>`);
  win = new BrowserWindow({ width: 900, height: 700, show: false, frame: false,
    webPreferences: { contextIsolation: false, nodeIntegration: false, backgroundThrottling: false, offscreen: true } });
  win.webContents.on('console-message', event => { if (event.level === 'error') report.errors.push(event.message); });
  await win.loadFile(html);
  await js(`
    window.pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
    window.rectOf=element=>{const r=element.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}};
    window.emitPointer=(target,type,x,y,buttons)=>target.dispatchEvent(new PointerEvent(type,{bubbles:true,pointerId:1,pointerType:'mouse',button:0,buttons,clientX:x,clientY:y}));
    _syncSidebar();window.dock=document.getElementById('edgeDock');window.buttons=[...dock.querySelectorAll('.ed-view')];
    window.allButtonsPreserved=()=>buttons.every((button,index)=>dock.querySelectorAll('.ed-view')[index]===button);
    window.removals=0;window.additions=0;
    new MutationObserver(records=>records.forEach(record=>{removals+=record.removedNodes.length;additions+=record.addedNodes.length})).observe(dock,{childList:true,subtree:true});
    window.resetDock=()=>{cfg.dockVisible=true;cfg.tasksOn=true;cfg.dockX=null;cfg.dockY=120;_syncSidebar();saved.length=0;dragHooks.begin=0;dragHooks.end=0;};
    window.startDrag=async()=>{const r=rectOf(dock);window.dragOrigin={x:r.x+12,y:r.y+10};emitPointer(dock.querySelector('.ed-grip'),'pointerdown',dragOrigin.x,dragOrigin.y,1);emitPointer(document,'pointermove',dragOrigin.x-160,dragOrigin.y+90,1);await pause(80);return rectOf(dock);};
    void 0;
  `);

  await check('A missing dock preference hides the rail and explicit opt-in restores it', async item => {
    item.evidence = await js(`(() => {
      delete cfg.dockVisible; _syncSidebar();
      const hidden = !dock.checkVisibility();
      cfg.dockVisible = true; _syncSidebar();
      return {hidden, visible: dock.checkVisibility(), retained: allButtonsPreserved()};
    })()`);
    assert.deepEqual(item.evidence, {hidden: true, visible: true, retained: true});
  });
  await check('Four entry buttons and grip render once; repeated notification refresh retains every node', async item => {
    item.evidence = await js(`(async()=>{for(let i=0;i<100;i++)updateNoticeBadge();await pause(25);return{children:dock.children.length,actions:buttons.map(button=>button.dataset.act),allButtonsPreserved:allButtonsPreserved(),removals,additions};})()`);
    assert.equal(item.evidence.children, 5);
    assert.deepEqual(item.evidence.actions, ['workspace', 'schedules', 'requirements', 'notices']);
    assert.equal(item.evidence.allButtonsPreserved, true);
    assert.equal(item.evidence.removals, 0); assert.equal(item.evidence.additions, 0);
  });
  await check('Unread changes update the pet badge without rebuilding dock buttons', async item => {
    item.evidence = await js(`(async()=>{const samples=[];for(const count of [1,2,100,0]){unread=count;updateNoticeBadge();await pause(25);const badge=document.getElementById('petUnreadBadge');samples.push({unread:count,text:badge.textContent,hidden:badge.hidden});}return{samples,allButtonsPreserved:allButtonsPreserved(),removals,additions};})()`);
    assert.deepEqual(item.evidence.samples, [{ unread: 1, text: '1', hidden: false }, { unread: 2, text: '2', hidden: false }, { unread: 100, text: '99+', hidden: false }, { unread: 0, text: '', hidden: true }]);
    assert.equal(item.evidence.allButtonsPreserved, true);
    assert.equal(item.evidence.removals, 0); assert.equal(item.evidence.additions, 0);
  });

  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('DOM.enable');
  await win.webContents.debugger.sendCommand('CSS.enable');
  const { root } = await win.webContents.debugger.sendCommand('DOM.getDocument');
  const { nodeId } = await win.webContents.debugger.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector: '.ed-view' });
  const forceState = pseudo => win.webContents.debugger.sendCommand('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: pseudo });
  const geometry = () => js('({dock:rectOf(dock),button:rectOf(buttons[0]),transform:getComputedStyle(buttons[0]).transform})');
  for (const scale of [1, 1.25]) {
    await check('Hover preserves hit-box geometry at UI scale ' + scale, async item => {
      await js('document.documentElement.style.setProperty("--ui-scale",' + JSON.stringify(String(scale)) + ');resetDock();pause(300)');
      await forceState([]); await js('pause(250)');
      const rest = await geometry();
      await forceState(['hover']); await js('pause(250)');
      const hover = await geometry();
      item.evidence = { rest, hover };
      nearRect(hover.dock, rest.dock, 'dock hover'); nearRect(hover.button, rest.button, 'button hover');
      await forceState(['hover', 'active']); await js('pause(250)');
      item.evidence.pressed = await geometry();
      nearRect(item.evidence.pressed.dock, rest.dock, 'pressed dock');
      assert.ok(item.evidence.pressed.button.width <= rest.button.width, 'pressed button must remain inside its resting hit box');
      await forceState([]); await js('pause(250)');
    });
  }
  await forceState([]);
  await js('document.documentElement.style.setProperty("--ui-scale","1");resetDock();pause(300)');

  await check('Background sidebar sync during a drag preserves position and floating state; release saves final position', async item => {
    item.evidence = await js(`(async()=>{
      resetDock();const start=rectOf(dock);const during=await startDrag();const beforeSyncCfg={...cfg};
      for(let i=0;i<20;i++){unread=i;updateNoticeBadge();_syncSidebar();}await pause(80);
      const afterSync=rectOf(dock),floatingAfterSync=dock.classList.contains('floating'),savesDuringDrag=saved.length;
      emitPointer(document,'pointermove',dragOrigin.x-170,dragOrigin.y+95,1);await pause(80);
      const afterNextMove=rectOf(dock);emitPointer(document,'pointerup',dragOrigin.x-170,dragOrigin.y+95,0);await pause(80);
      return{start,during,beforeSyncCfg,afterSync,floatingAfterSync,savesDuringDrag,afterNextMove,afterRelease:rectOf(dock),finalCfg:{...cfg},saved:[...saved],hooks:{...dragHooks},allButtonsPreserved:allButtonsPreserved()};
    })()`);
    const value = item.evidence;
    nearRect(value.afterSync, value.during, 'background sync during drag');
    assert.equal(value.floatingAfterSync, true);
    assert.equal(value.savesDuringDrag, 0);
    nearRect(value.afterRelease, value.afterNextMove, 'pointerup position');
    assert.equal(value.finalCfg.dockX, Math.round(value.afterNextMove.x));
    assert.equal(value.finalCfg.dockY, Math.round(value.afterNextMove.y));
    assert.equal(value.saved.length, 1); assert.deepEqual(value.saved[0], value.finalCfg);
    assert.deepEqual(value.hooks, { begin: 1, end: 1 });
    assert.equal(value.allButtonsPreserved, true);
  });

  for (const preference of ['dockVisible', 'tasksOn']) {
    await check('Explicit ' + preference + '=false hides the dock during dragging and after release', async item => {
      item.evidence = await js(`(async()=>{
        resetDock();await startDrag();cfg[${JSON.stringify(preference)}]=false;_syncSidebar();await pause(30);
        const hiddenAfterSync=getComputedStyle(dock).display==='none';
        const cfgAfterSync={...cfg},savedAfterSync=saved.length,hooksAfterSync={...dragHooks};
        emitPointer(document,'pointermove',dragOrigin.x-175,dragOrigin.y+100,1);await pause(30);
        emitPointer(document,'pointerup',dragOrigin.x-175,dragOrigin.y+100,0);await pause(30);
        const hiddenAfterRelease=getComputedStyle(dock).display==='none';
        const cfgAfterRelease={...cfg},savedAfterRelease=saved.length,hooksAfterRelease={...dragHooks};
        cfg[${JSON.stringify(preference)}]=true;_syncSidebar();await pause(30);
        return{hiddenAfterSync,hiddenAfterRelease,cfgAfterSync,cfgAfterRelease,savedAfterSync,savedAfterRelease,hooksAfterSync,hooksAfterRelease,visibleAfterOptIn:getComputedStyle(dock).display!=='none',allButtonsPreserved:allButtonsPreserved()};
      })()`);
      assert.equal(item.evidence.hiddenAfterSync, true); assert.equal(item.evidence.hiddenAfterRelease, true);
      assert.deepEqual(item.evidence.hooksAfterSync, { begin: 1, end: 1 }, 'hide must end native drag mode immediately');
      assert.deepEqual(item.evidence.hooksAfterRelease, item.evidence.hooksAfterSync, 'late pointerup must not end the gesture twice');
      assert.deepEqual(item.evidence.cfgAfterRelease, item.evidence.cfgAfterSync, 'late hidden pointer events must not move the saved dock');
      assert.equal(item.evidence.savedAfterSync, 1); assert.equal(item.evidence.savedAfterRelease, 1);
      assert.equal(item.evidence.visibleAfterOptIn, true); assert.equal(item.evidence.allButtonsPreserved, true);
    });
  }
  report.errors.push(...await js('fixtureErrors'));
  fs.writeFileSync(path.join(output, 'dock.png'), (await win.webContents.capturePage()).toPNG());
  report.ok = report.cases.every(item => item.ok) && report.errors.length === 0;
}).catch(error => { report.error = error.stack || String(error); }).finally(() => {
  clearTimeout(timeout);
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: report.ok, passed: report.cases.filter(item => item.ok).length, cases: report.cases.length,
    failed: report.cases.filter(item => !item.ok).map(item => ({ name: item.name, error: item.error })), error: report.error, report: path.join(output, 'report.json') }));
  win?.destroy();
  app.exit(report.ok ? 0 : 1);
});
