'use strict';
// Real Windows regions, focus changes and production preload/shape/dock code.
// This isolated fixture does not verify system mouse input or the user's client.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE',
    'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  const child = require('node:child_process').spawnSync(electron, [__filename, ...process.argv.slice(2)], {
    env, windowsHide: true, stdio: 'inherit', timeout: 45000,
  });
  process.exit(child.status ?? 1);
}
const { app, BrowserWindow, ipcMain, screen, globalShortcut, Notification, powerMonitor, nativeImage } = electron;
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-overlay-stability-'));
const outputAt = process.argv.indexOf('--output');
const output = outputAt >= 0 ? path.resolve(process.argv[outputAt + 1])
  : path.resolve(__dirname, '../../outputs/desktop-overlay-stability/result.json');
const venv = path.resolve(__dirname, '../../hub-backend/.venv/Scripts/python.exe');
const python = process.env.SODUWORK_TEST_PYTHON || (fs.existsSync(venv) ? venv : 'python');
const report = { ok: false, isolated: true, realNativeWindows: true, nativeMouseVerified: false,
  electron: process.versions.electron, rounds: [],
  note: 'Cursor coordinates, keyboard events and renderer busy time are injected fixture inputs, not physical mouse/IME or production latency.',
  workWindowOverlapVerified: false };
app.setPath('userData', path.join(root, 'profile'));
app.on('window-all-closed', () => {});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let controller, overlay, target, overlapWindow, timeout;
let cursor = { x: -1000, y: -1000 };
const fixtureScreen = { getPrimaryDisplay: () => screen.getPrimaryDisplay(),
  getCursorScreenPoint: () => cursor, on: (...args) => screen.on(...args), removeListener: (...args) => screen.removeListener(...args) };
const probes = new Set();
async function until(check, description) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { if (await check()) return; await delay(20); }
  throw Error('Timed out: ' + description);
}
function monitor(win, point) {
  const handle = win.getNativeWindowHandle().readBigUInt64LE().toString();
  const child = spawn(python, [path.join(__dirname, 'fixtures/overlay-region-monitor.py'),
    handle, String(win.getBounds().width), String(point.x), String(point.y), '650'], { windowsHide: true });
  probes.add(child);
  let stdout = '', stderr = '', readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const done = new Promise((resolve, reject) => {
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.includes('READY')) readyResolve(); });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => { readyReject(error); reject(error); });
    child.on('close', code => {
      probes.delete(child);
      try {
        if (code !== 0) throw Error('Native region probe failed: ' + stderr);
        if (!stdout.includes('READY')) throw Error('Native region probe did not initialize');
        resolve(JSON.parse(stdout.slice(stdout.indexOf('READY') + 5).trim()));
      } catch (error) { readyReject(error); reject(error); }
    });
  });
  // A failed launch can reject both promises before the caller awaits done.
  done.catch(() => {});
  return { ready, done };
}
function rendererHTML() {
  const file = relative => pathToFileURL(path.resolve(__dirname, '..', relative)).href;
  return `<!doctype html><html><head><meta charset="utf-8">
    <link rel="stylesheet" href="${file('theme/variables.css')}">
    <link rel="stylesheet" href="${file('components/pet/pet.css')}">
    <style>html,body{margin:0;background:transparent}#pet{left:200px;top:100px;right:auto;bottom:auto;
    width:20px;height:20px;opacity:1;transform:none;transition:none;background:#69a}</style></head><body>
    <div id="pet" class="pet"><div class="pet-ring"><button class="ring-btn" style="--rx:150px;--ry:0px">Ring</button></div></div><div id="edgeDock" class="edge-dock"></div>
    <script>
    window.errors=[];addEventListener('error',e=>errors.push(e.message));
    window.cfg={dockVisible:true,tasksOn:true,dockX:100,dockY:100};window.saveCfg=()=>{};
    window.fixtureBusyMs=0;
    soduWorkAPI.onOverlayWindowBlur(()=>{
      const end=performance.now()+fixtureBusyMs;while(performance.now()<end){}
    });
    </script>
    <script src="${file('core/electron.js')}"></script>
    <script src="${file('components/pet/pet-dock.js')}"></script>
    <script>
    soduWorkAPI.onOverlayWindowBlur(()=>requestOverlayShapeSync(240,true));
    _syncSidebar();setInterval(()=>soduWorkAPI.sendHeartbeat(),2000);
    </script></body></html>`;
}
function finish(error) {
  if (timeout) clearTimeout(timeout);
  if (error) report.error = error.stack || String(error);
  for (const probe of probes) probe.kill();
  controller?.dispose();
  if (target && !target.isDestroyed()) target.destroy();
  if (overlay && !overlay.isDestroyed()) overlay.destroy();
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: report.ok, rounds: report.rounds.length, output, error: report.error }));
  app.exit(report.ok ? 0 : 1);
}
app.whenReady().then(async () => {
  if (process.platform !== 'win32') throw Error('Native region verification requires Windows');
  timeout = setTimeout(() => finish(Error('Native overlay verification exceeded 30 seconds')), 30000);
  fs.copyFileSync(path.resolve(__dirname, '../preload.js'), path.join(root, 'preload.js'));
  fs.writeFileSync(path.join(root, 'index.html'), rendererHTML());
  controller = require('../main/desktop-overlay.cjs').create({ app, BrowserWindow, ipcMain, screen: fixtureScreen,
    globalShortcut, Notification, powerMonitor, getRendererRoot: () => root,
    getIcon: () => nativeImage.createEmpty(), translate: value => value,
    getWorkWindows: () => [target, overlapWindow].filter(Boolean) });
  overlay = controller.createWindow();
  await new Promise(resolve => overlay.webContents.once('did-finish-load', resolve));
  const js = code => overlay.webContents.executeJavaScript(code);
  await until(() => js(`soduWorkAPI.getOverlayShape().then(info=>info.reported &&
    window.__ptState().shapeRects.length === 2)`), 'initial regions');
  await js('soduWorkAPI.notifyReady()');
  target = new BrowserWindow({ x: 400, y: 100, width: 800, height: 450, show: false,
    skipTaskbar: true, title: 'SoduWork isolated composer focus regression', webPreferences: { sandbox: true } });
  const asset = relative => pathToFileURL(path.resolve(__dirname, '..', relative)).href;
  const targetFile = path.join(root, 'composer.html');
  fs.writeFileSync(targetFile, `<!doctype html><meta charset="utf-8">
    <link rel="stylesheet" href="${asset('theme/variables.css')}">
    <link rel="stylesheet" href="${asset('components/panels/work-composer.css')}">
    <style>body{margin:30px;background:white;font:16px sans-serif} .work-composer{margin-top:40px}</style>
    <h2>输入焦点回归 · 隔离测试</h2><p>桌宠及任务栏切换后保留草稿、附件和选择。</p><main id="host"></main>
    <script src="${asset('components/panels/work-composer.js')}"></script><script>
    host.innerHTML=WorkComposer.html({inputId:'nchatInput',sendId:'nchatSend',placeholder:'接着说…',
      beforeInput:'<div id="attachment">参考.md</div>',afterInput:WorkComposer.syntaxHint(),
      context:'<span id="selection">Pi · fixture-model · fixture-conversation</span>'});
    WorkComposer.bindPlaceholder(document.querySelector('.work-composer'));
    window.input=document.getElementById('nchatInput');input.value='保留草稿';
    input.dispatchEvent(new Event('input',{bubbles:true}));window.inputEvents=0;
    input.addEventListener('input',()=>inputEvents++);
    </script>`);
  await target.loadFile(targetFile);
  // Settle the production startup redraw and display-bound correction before measuring blur.
  await delay(3300);
  const point = await js(`(()=>{const r=document.getElementById('edgeDock').getBoundingClientRect();
    return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  const ringPoint = await js(`(()=>{const r=document.querySelector('.ring-btn').getBoundingClientRect();
    return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  assert.equal(await js('isPointInteractive(' + ringPoint.x + ',' + ringPoint.y + ')'), false,
    'closed ring geometry cannot block an underlying editor');
  assert.equal(await js('getComputedStyle(document.querySelector(".ring-btn")).pointerEvents'), 'none');
  await js('document.getElementById("pet").classList.add("ring-open");requestOverlayShapeSync(0,true)');
  await until(() => js('window.__ptState().shapeRects.length===3'), 'open ring region');
  assert.equal(await js('getComputedStyle(document.querySelector(".ring-btn")).pointerEvents'), 'auto');
  await js('document.getElementById("pet").classList.remove("ring-open");requestOverlayShapeSync(0,true)');
  await until(() => js('window.__ptState().shapeRects.length===2'), 'closed ring releases region');
  assert.equal(await js('isPointInteractive(' + ringPoint.x + ',' + ringPoint.y + ')'), false);
  // Let the production transition envelope settle before counting blur repaints.
  await delay(800);
  report.closedRingVerified = true;
  let expectedDraft = '保留草稿';
  for (const busyMs of [0, 150, 150]) {
    await js('window.fixtureBusyMs=' + busyMs);
    const bounds = overlay.getContentBounds();
    cursor = { x: bounds.x + point.x, y: bounds.y + point.y };
    await until(() => overlay.isFocusable(), 'widget input enabled');
    overlay.focus();
    await until(() => overlay.isFocused(), 'fixture overlay focus');
    const probe = monitor(overlay, point);
    await probe.ready;
    const calls = [], blurStates = [];
    const original = overlay.setShape.bind(overlay);
    overlay.setShape = rects => { calls.push(rects); return original(rects); };
    const onBlur = () => blurStates.push({ focusable: overlay.isFocusable(), visible: overlay.isVisible() });
    overlay.on('blur', onBlur);
    cursor = { x: bounds.x + 600, y: bounds.y + 300 };
    target.show(); target.focus();
    cursor = { x: bounds.x + point.x, y: bounds.y + point.y };
    /* Use a deterministic visible work-window adapter for the first-click guard. Native
       focus is exercised by the composer window below, while this adapter avoids depending
       on the desktop session's window manager to keep a hidden fixture foregrounded. */
    overlapWindow = {
      isDestroyed: () => false,
      isVisible: () => true,
      isMinimized: () => false,
      getBounds: () => ({ x: cursor.x - 40, y: cursor.y - 40, width: 80, height: 80 }),
    };
    await until(() => overlay.isFocusable() === false,
      'overlapping work window takes the pet hit region');
    report.workWindowOverlapVerified = true;
    /* Continue the native region probe from a transparent gap; the overlap assertion above
       already verifies that the work window wins while the cursor is over the dock. */
    cursor = { x: bounds.x + 600, y: bounds.y + 300 };
    overlapWindow = null;
    const native = await probe.done;
    overlay.setShape = original;
    overlay.removeListener('blur', onBlur);
    report.rounds.push({ fixtureBusyMs: busyMs, blurStates, shapeCalls: calls, native });
    assert.ok(blurStates.length > 0, 'real focus change must emit blur');
    assert.ok(blurStates.every(value => !value.focusable && value.visible), 'blur releases focus and stays visible');
    assert.equal(calls.length, 0, 'unchanged geometry must not repaint or park the native region on blur');
    assert.ok(native.sampleCount > 20, 'native sampler must cover the busy interval');
    assert.ok(native.changes.every(sample => sample.regionType === 3 && sample.containsDockCenter),
      'dock center remains inside the actual Windows region across blur');
    const state = await js('soduWorkAPI.getOverlayShape()');
    assert.equal(state.awaitingShape, false, 'fresh shape acknowledgement resumes input guard');
    assert.equal(overlay.isFocusable(), false, 'fresh acknowledgement keeps transparent gaps outside the focus chain');
    await target.webContents.executeJavaScript('input.focus();input.setSelectionRange(input.value.length,input.value.length)');
    assert.equal(target.isFocused(), true, 'underlying work window retains native focus after overlay acknowledgement');
    target.webContents.sendInputEvent({ type: 'char', keyCode: 'x' }); expectedDraft += 'x';
    await until(async () => await target.webContents.executeJavaScript('input.value') === expectedDraft, 'composer accepts keyboard event');
    const composer = await target.webContents.executeJavaScript(`({draft:input.value,caret:input.selectionStart,
      focused:document.activeElement===input,disabled:input.disabled,attachment:attachment.textContent,selection:selection.textContent})`);
    assert.equal(composer.focused, true); assert.equal(composer.disabled, false);
    assert.equal(composer.caret, expectedDraft.length);
    assert.equal(composer.attachment, '参考.md'); assert.equal(composer.selection, 'Pi · fixture-model · fixture-conversation');
    report.rounds.at(-1).composer = composer;
    target.hide();
  }
  assert.deepEqual(await js('window.errors'), [], 'production renderer scripts must load without errors');
  report.ok = true;
}).then(() => finish(), finish);
