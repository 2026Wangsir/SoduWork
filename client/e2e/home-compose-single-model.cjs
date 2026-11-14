'use strict';

// Production homepage, picker and first-send controller with synthetic catalogs only.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  const result = require('node:child_process').spawnSync(electron, [__filename, ...process.argv.slice(2)],
    { env, stdio: 'inherit', timeout: 90000 });
  process.exit(result.status ?? 1);
}

const { app, BrowserWindow } = electron;
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const client = path.resolve(__dirname, '..'), output = process.argv[2];
assert.ok(output && path.isAbsolute(output), 'Absolute evidence directory required');
fs.mkdirSync(output, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-home-single-model-'));
app.setPath('userData', profile); app.disableHardwareAcceleration();
const local = 'local:model-' + 'b'.repeat(32), missing = 'local:model-' + 'a'.repeat(32);
const report = { ok: false, cases: [], screenshots: [], network: [],
  boundary: 'Real Electron Chromium, production homepage shell/composer/model picker and first-send controller. Catalogs, runtime selection and NativeChat boundary are synthetic; HTTP(S) is blocked. Disposable profile only; no production profile, credentials, provider, native model process or full-product inference.' };
let win;
const js = async code => {
  try { return await win.webContents.executeJavaScript(code, true); }
  catch (error) { throw Error(error.message + '\nRenderer expression: ' + code); }
};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(code) {
  for (let i = 0; i < 150; i++) { if (await js(code)) return; await delay(30); }
  throw Error('Timed out: ' + code);
}
async function click(selector) {
  const point = await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'center'});
    const r=e.getBoundingClientRect(),x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2);
    if(e.disabled||!e.contains(document.elementFromPoint(x,y)))throw Error('Control unavailable');return{x,y};})()`);
  for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, ...point, button: 'left', clickCount: 1 });
  await delay(50);
}
async function shot(name) {
  await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))');
  const value = await win.webContents.debugger.sendCommand('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  const file = path.join(output, name + '.png'); fs.writeFileSync(file, Buffer.from(value.data, 'base64')); report.screenshots.push(file);
}
function mark(value) { report.cases.push(value); console.log('PASS ' + value); }
async function fresh(catalog, runtime = 'pi', location = 'local') {
  await js(`window.homeCatalog=${JSON.stringify(catalog)};window.homeRuntime=${JSON.stringify(runtime)};
    window.homeLocation=${JSON.stringify(location)};openComposePanel({newSession:true});void 0;`);
  return js('ComposeModelPicker.ready()');
}
const catalog = (name, label, localOnly = false) => ({ usable: [{ name, label, localOnly }],
  defaultModels: { pi: missing }, defaultModelErrors: { pi: 'Original local default was deleted' } });

app.whenReady().then(async () => {
  win = new BrowserWindow({ show: false, width: 1440, height: 1000,
    webPreferences: { contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } });
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (request, callback) => {
    report.network.push(request.url); callback({ cancel: true });
  });
  await win.loadFile(path.join(client, 'tests/composer-menu.html'));
  await until('!!window.ComposeModelPicker && !!document.querySelector("#cpModelName")');
  await js(fs.readFileSync(path.join(client, 'components/panels/panels-compose-work-actions.js'), 'utf8') + '\nvoid 0;');
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
  await js(`window.homeOwner='fixture-owner-a';window.homeRuntime='pi';window.homeLocation='local';window.homeSends=[];
    SoduWorkAPI.taskStorageKey=()=>homeOwner;
    SoduWorkAPI.myModels=async()=>structuredClone(homeCatalog);
    ComposeRuntime.value=()=>homeRuntime;ComposeRuntime.location=()=>homeLocation;
    ComposeRuntime.catalog=()=>[{id:'pi',modelMode:'managed'},{id:'qwen',modelMode:'managed'},
      {id:'codex',modelMode:'account'},{id:'claude',modelMode:'account'}];
    soduWorkAPI.conversationSession.runtimeModels=async id=>({ok:true,models:[{id:'account-'+id,label:'Account '+id}]});
    NativeChat.enter=async(...args)=>{homeSends.push(args);return false;};void 0;`);
  for (const source of ['local', 'Hub']) {
    const name = source === 'local' ? local : 'sole-hub-model', label = source === 'local' ? '本机唯一可用模型' : 'Hub 唯一可用模型';
    assert.equal(await fresh(catalog(name, label, source === 'local')), true);
    assert.equal(await js('ComposeModelPicker.value().modelName'), name);
    assert.equal(await js('document.querySelector("#cpModelName").textContent'), label);
    assert.equal(await js('document.querySelector("#cpModelName").textContent.includes("已删除")'), false);
    await shot('home-' + source.toLowerCase() + '-sole-model');
    await click('#cpInput');
    await win.webContents.debugger.sendCommand('Input.insertText', { text: 'Synthetic first message using the sole model.' });
    const count = await js('homeSends.length'); await click('#cpGo');
    await until('homeSends.length===' + (count + 1));
    assert.equal(await js('homeSends.at(-1)[2].modelName'), name);
    mark(source + ' sole model replaces an inherited invalid default on a genuinely new homepage and reaches first send explicitly');
  }
  assert.equal(await fresh(catalog(local, '本机手动选择', true)), true);
  await click('#cpModelBtn'); await until('!!document.querySelector(' + JSON.stringify('[data-model="' + local + '"]') + ')');
  await click('[data-model="' + local + '"]');
  await js(`homeCatalog=${JSON.stringify(catalog('sole-replacement', '唯一替代模型'))};ComposeModelPicker.refresh(true);`);
  assert.equal(await js('ComposeModelPicker.ready()'), false);
  assert.equal(await js('ComposeModelPicker.value().modelName'), local);
  assert.match(await js('document.querySelector("#cpModelName").textContent'), /已删除或不可用/);
  await js('openComposePanel({});void 0;');
  assert.equal(await js('ComposeModelPicker.ready()'), false, 'ordinary redraw cannot reset a manual deleted choice');
  await shot('same-draft-explicit-model-deleted');
  const before = await js('homeSends.length');
  await click('#cpInput'); await win.webContents.debugger.sendCommand('Input.insertText', { text: 'Keep this unsent draft.' });
  await click('#cpGo'); await delay(100);
  assert.equal(await js('homeSends.length'), before);
  assert.match(await js('document.querySelector("#cpInput").value'), /Keep this unsent draft/);
  mark('Deleting a model manually selected in this draft preserves its invalid placeholder and prevents first send');
  assert.equal(await fresh(catalog('sole-replacement', '唯一替代模型')), true);
  assert.equal(await js('ComposeModelPicker.value().modelName'), 'sole-replacement');
  await shot('new-conversation-after-deleted-draft');
  mark('An explicit new-conversation action clears only the prior draft choice and selects the sole current model');

  for (const id of ['codex', 'claude']) {
    assert.equal(await fresh(catalog(local, 'Private model', true), id), true);
    const selected = await js('ComposeModelPicker.value().modelName');
    assert.equal(selected, id === 'codex' ? 'account-codex' : '');
    assert.equal(await js('document.querySelector("#cpModelPop").innerHTML.includes(' + JSON.stringify(local) + ')'), false);
  }
  mark('Codex and Claude keep independent account model behavior and never select the device model');
  assert.equal(await fresh({ usable: [{ name: local, localOnly: true }, { name: 'cloud-hub', label: 'Cloud Hub' }] }, 'pi', 'cloud'), true);
  assert.equal(await js('ComposeModelPicker.value().modelName'), 'cloud-hub');
  assert.equal(await js('document.querySelector("#cpModelPop").innerHTML.includes(' + JSON.stringify(local) + ')'), false);
  mark('Cloud new conversations filter device-owned models before choosing their sole Hub model');
  await js(`window.finishOldHomeCatalog=null;SoduWorkAPI.myModels=()=>new Promise(resolve=>finishOldHomeCatalog=resolve);
    homeLocation='local';ComposeModelPicker.resetNewDraft();void 0;`);
  await until('typeof finishOldHomeCatalog==="function"');
  await js(`homeOwner='fixture-owner-b';homeCatalog=${JSON.stringify(catalog('new-owner-model', 'New owner model'))};
    SoduWorkAPI.myModels=async()=>structuredClone(homeCatalog);dispatchEvent(new Event('soduwork-data-scope-changed'));void 0;`);
  assert.equal(await js('ComposeModelPicker.ready()'), true);
  await js(`finishOldHomeCatalog(${JSON.stringify(catalog(local, 'Previous owner private model', true))});void 0;`);
  await delay(50);
  assert.equal(await js('ComposeModelPicker.value().modelName'), 'new-owner-model');
  assert.equal(await js('document.querySelector("#cpModelName").textContent'), 'New owner model');
  mark('A late prior-account catalog cannot overwrite the new owner selection');
  assert.deepEqual(await js('fixtureErrors'), []); assert.deepEqual(report.network, []);
  report.ok = true;
}).catch(async error => {
  report.error = String(error.stack || error); console.error(report.error);
  report.diagnostics = await js('({errors:fixtureErrors,calls:fixtureCalls,sends:homeSends,body:document.body.innerText})').catch(() => null);
})
  .finally(() => {
    const cleanupErrors = [];
    try { win?.destroy(); } catch (error) { cleanupErrors.push(String(error.stack || error)); }
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (error) { cleanupErrors.push(String(error.stack || error)); }
    report.cleanup = { ok: !cleanupErrors.length, errors: cleanupErrors };
    if (!report.cleanup.ok) report.ok = false;
    try { fs.writeFileSync(path.join(output, 'home-compose-single-model.json'), JSON.stringify(report, null, 2)); }
    catch (error) { console.error(error); app.exit(1); return; }
    console.log(JSON.stringify({ ok: report.ok, cases: report.cases.length, error: report.error || null }));
    app.exit(report.ok ? 0 : 1);
  });
