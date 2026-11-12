'use strict';
// Production library and system icon service; synthetic metadata only, no Hub or business files.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict');
const client = path.resolve(__dirname, '..');
const output = path.resolve(process.argv[2] || path.join(client, '../outputs/library-file-icons'));
const compactOnly = process.argv.includes('--compact-trash');
fs.mkdirSync(output, { recursive: true });
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-library-file-icons-'));
app.setPath('userData', path.join(temporary, 'profile'));
const report = { ok: false, boundary: 'Synthetic library records; real production renderer, IPC and Electron system icon lookup. All network blocked.',
  cases: [], screenshots: [], layouts: [], nativeTypes: [], errors: [], blockedNetwork: [] };
let win, service;
const replies = new Map();
const read = name => fs.readFileSync(path.join(client, name), 'utf8');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const js = code => win.webContents.executeJavaScript(code, true);
async function until(code) {
  for (let i = 0; i < 200; i++) { if (await js(code)) return; await pause(40); }
  throw Error('Timed out: ' + code);
}
async function click(selector) {
  const point = await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)throw Error('Unavailable '+${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
  for (const type of ['mouseMove', 'mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, button: 'left', clickCount: 1, ...point });
  await pause(80);
}
async function shot(name) {
  await js(`document.querySelector('#libraryPanel').scrollTop=0;new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`);
  await pause(100);
  const file = path.join(output, name + '.png');
  fs.writeFileSync(file, (await win.webContents.capturePage()).toPNG()); report.screenshots.push(file);
}
const definitions = [
  ['word', '方案.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'document', 'docx'],
  ['slides', '演示.PPTX', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'presentation', 'pptx'],
  ['sheet', '预算.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'spreadsheet', 'xlsx'],
  ['pdf', '说明.pdf', 'application/pdf', 'document', 'pdf'],
  ['markdown', 'README.md', 'text/markdown', 'document', 'md'],
  ['website', '网页.html', 'text/html', 'document', 'html'],
  ['image', '截图.png', 'image/png', 'image', 'png'],
  ['archive', '资料.zip', 'application/zip', 'file', 'zip'],
  ['unknown', '资料.unknownsoduwork', 'application/octet-stream', 'file', 'unknownsoduwork'],
  ['mime-word', '无后缀文档', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'document', 'docx'],
  ['misleading-title', '真实格式.docx', 'application/pdf', 'document', 'docx'],
  ['generic', '无格式资料', 'application/octet-stream', 'document', ''],
];
const records = definitions.map(([id, filename, contentType, kind]) => ({ id, filename, contentType, kind,
  title: id === 'misleading-title' ? '这是幻灯片.pptx' : filename,
  favorite: true, size: 2048, updatedAt: '2026-09-30T08:00:00Z', createdAt: '2026-09-30T08:00:00Z' }));
const dataUrl = result => typeof result === 'string' ? result : result?.dataUrl || result?.url || '';

async function verifyIcons(label) {
  await until(`document.querySelectorAll('.library-file-card').length===${records.length}&&!document.querySelector('.library-spinner')`);
  await until(`Array.from(document.querySelectorAll('.library-file-card [data-native-file-icon]')).length===${records.length}&&Array.from(document.querySelectorAll('.library-file-card [data-native-file-icon]')).every(node=>{const img=node.matches('img')?node:node.querySelector('img');return img?.complete&&img.naturalWidth>0})`);
  const rendered = await js(`Array.from(document.querySelectorAll('.library-file-card')).map(card=>{const node=card.querySelector('[data-native-file-icon]'),img=node.matches('img')?node:node.querySelector('img'),s=getComputedStyle(img),r=img.getBoundingClientRect();return{id:card.querySelector('[data-library-select]').dataset.librarySelect,type:node.dataset.nativeFileIcon,src:img.currentSrc||img.src,natural:[img.naturalWidth,img.naturalHeight],size:[r.width,r.height],filter:s.filter,visible:img.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}),text:card.querySelector('.library-card-copy b').textContent}})`);
  for (const row of rendered) {
    const expected = definitions.find(def => def[0] === row.id)[4];
    assert.equal(row.type.replace(/^\./, ''), expected, label + ': ' + row.id + ' must use actual file type');
    const result = replies.get(row.type) || await service.get(row.type);
    assert.equal(row.src, dataUrl(result), label + ': ' + row.id + ' must display the unmodified system bitmap');
    assert.ok(row.natural[0] > 0 && row.natural[1] > 0);
    assert.ok(row.size[0] > 0 && row.size[1] > 0, label + ': visible icon dimensions');
    assert.equal(row.visible, true); assert.equal(row.filter, 'none', 'theme cannot recolor file associations');
  }
  assert.match(rendered.find(row => row.id === 'misleading-title').text, /幻灯片/);
  const layout = await js(`(()=>{const e=document.querySelector('#libraryPanel'),r=e.getBoundingClientRect();return{width:innerWidth,locale:SoduWorkI18n.getLocale(),theme:document.documentElement.dataset.theme,view:document.querySelector('[data-library-content]').className,title:document.querySelector('[data-library-title]').textContent,overflow:e.scrollWidth>e.clientWidth+1,left:r.left,right:r.right,accent:getComputedStyle(e).getPropertyValue('--accent').trim()}})()`);
  assert.equal(layout.overflow, false, JSON.stringify(layout)); assert.ok(layout.left >= 0 && layout.right <= layout.width + 1);
  report.layouts.push({ label, ...layout }); return rendered;
}
async function verifyCompactTrash() {
  win.setContentSize(580, 950);
  await js(`SoduWorkI18n.setLocale('en-US',{persist:false,broadcast:false});void 0;`);
  for (const view of ['list', 'grid']) {
    await click(`[data-library-view="${view}"]`);
    await verifyIcons('trash-en-580-' + view); await shot('trash-en-580-' + view);
    assert.equal(await js(`Array.from(document.querySelectorAll('.library-row-actions button')).every(button=>{const r=button.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.width>0})`), true,
      'both trash actions must remain horizontally reachable');
  }
  report.cases.push('English trash remains usable at 580 pixels in list and grid views; restore and permanent delete stay within the viewport');
}

app.whenReady().then(async () => {
  service = require('../main/file-type-icons.cjs').createService({ app });
  ipcMain.handle('file-type-icon', async (_event, type) => {
    const result = await service.get(type); replies.set(String(type), result); return result;
  });
  const preload = path.join(temporary, 'preload.cjs');
  fs.writeFileSync(preload, "const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('soduWorkAPI',{fileTypeIcon:type=>ipcRenderer.invoke('file-type-icon',type)});");
  win = new BrowserWindow({ show: false, width: 1366, height: 950,
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) report.errors.push(message); });
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (request, callback) => {
    report.blockedNetwork.push(request.url); callback({ cancel: true });
  });
  win.webContents.session.enableNetworkEmulation({ offline: true });
  await win.loadFile(path.join(__dirname, 'fixtures/library.html'));
  report.initialNavigatorOnline = await js('navigator.onLine');
  // Session transport emulation alone can retain the OS online flag on file://
  // pages. Also emulate Chromium's network state, without overriding navigator.
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Network.enable');
  await win.webContents.debugger.sendCommand('Network.emulateNetworkConditions',
    { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0, connectionType: 'none' });
  await js(`(()=>{const style=document.createElement('style');style.textContent=${JSON.stringify(read('theme/workspace-page-heads.css'))};document.head.appendChild(style)})()`);
  await js(`window.errors=[];window.notices=[];window.petSay=text=>notices.push(text);addEventListener('error',e=>errors.push(e.message));addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));window.fixtureItems=${JSON.stringify(records)};window.SoduWorkAPI={listLibrary:async opts=>({items:fixtureItems.map(row=>({...row,...(opts.scope==='trash'?{deletedAt:'2026-09-30T09:00:00Z'}:{})})),folders:[],trashCount:fixtureItems.length}),getLibraryStorageStatus:async()=>({local:{available:true},minio:{available:false}}),readLibraryBinary:async()=>null};void 0;`);
  for (const file of JSON.parse(read('core/locales/manifest.json'))) await js(read('core/locales/' + file));
  for (const file of ['core/i18n-dom.js', 'core/i18n.js', 'components/panels/library-file-icons.js', 'components/panels/panels-library-dialogs.js', 'components/panels/library-delivery.js', 'components/panels/library-preview-html.js', 'components/panels/library-preview-archive.js', 'components/panels/library-preview-pane.js', 'components/panels/panels-library.js']) await js(read(file) + '\nvoid 0;');
  await js('SoduWorkI18n.setLocale("zh-CN",{persist:false,broadcast:false});openLibraryPanel();void 0;');
  report.verificationNavigatorOnline = await js('navigator.onLine');
  assert.equal(report.verificationNavigatorOnline, false);
  await verifyIcons('initial-offline-list');
  if (process.platform === 'win32') assert.equal(dataUrl(await service.get('')), dataUrl(await service.get('unknownsoduwork')),
    'untyped files must use the same system generic document icon as unassociated extensions, never a drive icon');
  report.cases.push('All twelve metadata cases resolve to real decodable system icons while offline; actual filenames beat misleading titles, MIME identifies extensionless Word, and unspecified formats stay generic');
  if (compactOnly) {
    await click('[data-library-trash]');
    await verifyCompactTrash();
    assert.deepEqual(await js('errors'), []); assert.deepEqual(report.errors, []); assert.deepEqual(report.blockedNetwork, []);
    report.nativeTypes = [...replies.keys()]; report.ok = true; return;
  }
  for (const theme of ['azure', 'ruby']) for (const locale of ['zh-CN', 'en-US']) for (const width of [1366, 960]) {
    win.setContentSize(width, 950);
    await js(`document.documentElement.dataset.theme='${theme}';SoduWorkI18n.setLocale('${locale}',{persist:false,broadcast:false});void 0;`);
    for (const view of ['list', 'grid']) {
      await click(`[data-library-view="${view}"]`);
      const label = theme + '-' + locale + '-' + width + '-' + view;
      await verifyIcons(label); await shot(label);
    }
  }
  report.cases.push('Real mouse toggles list/grid across Chinese/English, 960/1366 pixels and two production themes; original icon colors and usable layout remain intact');
  await click('[data-library-scope="favorites"]'); await verifyIcons('favorites'); await shot('favorites');
  await js(`SoduWorkAPI.readLibraryThumbnail=SoduWorkAPI.readLibraryBinary=async()=>({blob:new Blob([Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKk0AAAAASUVORK5CYII='),c=>c.charCodeAt(0))],{type:'image/png'})});closeLibraryPanel();openLibraryPanel();void 0;`);
  await until(`document.querySelector('[data-library-image="image"]')?.naturalWidth>0`);
  assert.equal(await js(`document.querySelector('[data-library-image="image"]').parentElement.querySelector('[data-library-image-fallback]').hidden`), true);
  await click('[data-library-file-preview="image"]');
  await until(`document.querySelector('.library-preview-pane img')?.naturalWidth>0`);
  await shot('image-preview'); await click('[data-preview-close]');
  await until(`!document.querySelector('.library-preview-pane')`);
  report.cases.push('A real PNG Blob still hydrates the thumbnail and opens the full-size preview; the system image icon remains its loading/read-failure fallback');
  await click('[data-library-trash]');
  await verifyIcons('trash'); assert.equal(await js('document.querySelectorAll("[data-library-restore]").length'), records.length);
  await shot('trash');
  await verifyCompactTrash(); win.setContentSize(960, 950);
  await js('SoduWorkAPI.readLibraryThumbnail=SoduWorkAPI.readLibraryBinary=async()=>null;closeLibraryPanel();openLibraryPanel();void 0;');
  await verifyIcons('trash-reopened');
  await click('[data-library-root]'); await verifyIcons('return-from-trash');
  report.cases.push('Favorites and trash use the same real type icons; return navigation retains the full original set');
  assert.deepEqual(await js('errors'), []); assert.deepEqual(report.errors, []); assert.deepEqual(report.blockedNetwork, []);
  report.nativeTypes = [...replies.keys()]; report.ok = true;
}).catch(async error => {
  report.error = String(error.stack || error);
  if (win && !win.isDestroyed()) { report.rendererErrors = await js('window.errors||[]').catch(() => []); await shot('failure').catch(() => {}); }
}).finally(() => {
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: report.ok, cases: report.cases, error: report.error, layouts: report.layouts.length, screenshots: report.screenshots.length }));
  if (win && !win.isDestroyed()) win.destroy(); ipcMain.removeHandler('file-type-icon'); app.exit(report.ok ? 0 : 1);
});
