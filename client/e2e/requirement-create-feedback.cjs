'use strict';

// Real WorkEntrySheet, ComposeDraft, submission and attachment modules. Only
// service persistence/navigation boundaries use isolated, controllable fixtures.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE',
    'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  const child = require('node:child_process').spawnSync(electron,
    [__filename, ...process.argv.slice(2), '--disable-gpu'],
    { env, windowsHide: true, stdio: 'inherit', timeout: 150000 });
  if (child.error) console.error(child.error.message);
  process.exit(child.status ?? 1);
}
const { app, BrowserWindow } = electron;
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict'), { pathToFileURL } = require('node:url');
const client = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-requirement-feedback-'));
const out = path.resolve(process.argv.slice(2).find(value => !value.startsWith('--')) ||
  path.join(client, '../outputs/requirement-create-feedback'));
const onlyCase = process.argv.find(value => value.startsWith('--case='))?.slice(7) || '';
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', path.join(temp, 'profile')); app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
let win, page;
const report = { ok: false, cases: [], phases: [], network: [], onlyCase,
  boundary: 'Actual Electron, production draft/submission/sheet/attachment modules and CSS; controlled public service APIs; no model calls or real account/business data.' };
const js = code => win.webContents.executeJavaScript(code, true)
  .catch(error => { throw Error(error.message + '\nScript: ' + code); });
const frame = () => js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
async function until(code, label = code) {
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    if (await js(code)) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw Error('Timed out: ' + label);
}
async function click(selector, count = 1) {
  await until(`(() => {const n=document.querySelector(${JSON.stringify(selector)});if(!n||n.disabled)return false;
    n.scrollIntoView({block:'nearest'});const r=n.getBoundingClientRect();
    return r.width>0&&r.height>0&&n.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));})()`, 'clickable ' + selector);
  const point = await js(`(() => {const n=document.querySelector(${JSON.stringify(selector)}),r=n.getBoundingClientRect();
    return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
  for (let index = 1; index <= count; index++) for (const type of ['mouseDown', 'mouseUp'])
    win.webContents.sendInputEvent({ type, ...point, button: 'left', clickCount: index });
  await frame();
}
async function button(label, root = '.wes-result-dialog') {
  const selector = await js(`(() => {const node=[...document.querySelectorAll(${JSON.stringify(root + ' button')})]
    .find(node=>node.textContent.trim()===${JSON.stringify(label)});if(!node)throw Error('Missing button: '+${JSON.stringify(label)});
    node.dataset.fixtureButton='selected';return '[data-fixture-button="selected"]';})()`);
  await click(selector);
}
async function key(keyCode, modifiers = []) {
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  await frame();
}
async function shot(name) {
  await frame();
  const state = await js(`({text:document.body.innerText,dialog:document.querySelector('.wes-result-dialog')?.outerHTML,
    capture:ComposeDraft.capture(),creates:fixture.creates,uploads:fixture.uploads,
    focus:{id:document.activeElement?.id,text:document.activeElement?.textContent},errors:errors.slice()})`);
  report.phases.push({ name, ...state });
  fs.writeFileSync(path.join(out, name + '.png'), (await win.webContents.capturePage()).toPNG());
  return state;
}
async function runCase(name, action) {
  if (onlyCase && !name.includes(onlyCase)) return;
  try {
    await action(); assert.deepEqual(await js('errors'), []);
    report.cases.push({ name, ok: true });
  } catch (error) {
    await shot('failure-' + name).catch(() => {});
    report.cases.push({ name, ok: false, error: error.stack });
  }
}
function fixtureSetup() {
  window.errors = []; window.notices = [];
  addEventListener('error', event => errors.push(event.message));
  addEventListener('unhandledrejection', event => errors.push(String(event.reason)));
  window.tasks = []; window.save = () => {}; window.render = () => {};
  window.petSay = text => notices.push(String(text));
  window.fixture = { owner: 'fixture-owner', creates: [], uploads: [], created: [], snapshots: [], details: [],
    pauses: [], refreshes: 0, persistMode: 'success', uploadMode: 'success', pendingCreates: [], pendingUploads: [], sequence: 0 };
  window.uid = () => 'fixture-task-' + (++fixture.sequence);
  window.Store = {
    persistTask: async id => {
      fixture.creates.push({ id, task: structuredClone(tasks.find(task => task.id === id)) });
      if (fixture.persistMode === 'defer') return new Promise(resolve => fixture.pendingCreates.push(resolve));
      if (fixture.persistMode === 'throw') throw Error('隔离服务返回：连接中断，请稍后重试');
      return fixture.persistMode !== 'failure';
    },
    pauseUnconfirmedTask: id => fixture.pauses.push(id),
  };
  window.SoduWorkAPI = { online: true, taskStorageKey: () => fixture.owner,
    listTeammates: async () => ({ mates: [] }),
    uploadAttachment: async (id, file, options) => {
      fixture.uploads.push({ id, filename: file.name, size: file.size, options });
      if (fixture.uploadMode === 'defer') return new Promise(resolve => fixture.pendingUploads.push(resolve));
      if (fixture.uploadMode === 'failure' || fixture.uploadMode === file.name) throw Error('隔离附件服务暂时不可用');
      return { id: 'attachment-' + file.name, filename: file.name, size: file.size };
    },
  };
  window.RequirementsBoard = { refresh: () => { fixture.refreshes++; } };
  window.openDetailEntry = id => {
    fixture.details.push({ id, hadSheet: !!document.querySelector('#workEntryLayer'), hadModal: !!document.querySelector('dialog:modal') });
    const detail = document.createElement('section'); detail.id = 'fixtureDetail'; detail.tabIndex = -1;
    detail.textContent = '需求详情 · ' + tasks.find(task => task.id === id)?.title; document.body.append(detail); detail.focus();
  };
  fixture.open = async (options = {}) => {
    document.getElementById('fixtureLaunch').focus();
    return WorkEntrySheet.openTask({ saveOnly: true, triageStage: 'intake', visibility: 'related',
      proposal: { title: '为团队整理可核对的需求', note: '保留提交说明和材料，服务确认后再提示完成。', checklist: ['说明完整', '材料可查看'] },
      onCardState: saved => fixture.snapshots.push(saved),
      onCreated: (id, title, outcome) => fixture.created.push({ id, title, outcome }), ...options });
  };
}
function buildPage() {
  const desk = fs.readFileSync(path.join(client, 'desk.html'), 'utf8');
  const required = new Set(['core/requirements.js', 'components/panels/task-priority.js',
    'components/panels/conversation-attachments.js', 'components/requirements/requirement-fields.js',
    'components/panels/panels-compose-submit.js', 'components/panels/compose-selection-position.js',
    'components/panels/requirement-routing.js', 'components/panels/panels-compose-draft.js',
    'components/panels/plugin-ui-host.js', 'components/panels/work-entry-sheet.js']);
  const scripts = [...desk.matchAll(/<script\b[^>]*src=["']([^"']+)["']/g)].map(match => match[1]).filter(file => required.has(file));
  assert.equal(scripts.length, required.size);
  const styles = [...desk.matchAll(/<link\b[^>]*href=["']([^"']+\.css)["']/g)].map(match => match[1]);
  const url = file => pathToFileURL(path.join(client, file)).href;
  page = path.join(temp, 'fixture.html');
  fs.writeFileSync(page, '<!doctype html><html lang="zh-CN" data-theme="azure"><head><meta charset="utf-8"><base href="' +
    pathToFileURL(client + path.sep).href + '">' + styles.map(file => '<link rel="stylesheet" href="' + url(file) + '">').join('') +
    '<style>body{margin:0;min-height:100vh;background:var(--bg-1);color:var(--ink);font:14px var(--font-ui)}.fixture-board{padding:32px}#fixtureInline{max-width:680px;margin:24px auto}#fixtureDetail{padding:32px}</style></head><body>' +
    '<main class="fixture-board"><h1>需求池</h1><p>收集目标与材料，准备好后安排执行。</p><button id="fixtureLaunch">新建需求</button></main><div id="fixtureInline"></div>' +
    '<script>(' + fixtureSetup.toString() + ')();</script>' + scripts.map(file => '<script src="' + url(file) + '"></script>').join('') + '</body></html>');
}
async function setup(options = {}) {
  win.setContentSize(options.width || 1100, options.height || 850);
  await win.loadFile(page);
  await js('fixture.open(' + JSON.stringify(options.open || {}) + ').then(()=>true)');
  await until('Boolean(document.querySelector("#cpCreate"))', 'actual requirement form');
}
async function englishDraft(stage = 'intake') {
  await setup({ open: { triageStage: stage, text: 'Help me design a login page', proposal: {
    title: 'Design a login page', note: 'Keep the original requirement text.', checklist: ['Deliver a working preview'],
  } } });
  for (const file of JSON.parse(fs.readFileSync(path.join(client, 'core/locales/manifest.json'), 'utf8'))
    .map(file => 'core/locales/' + file).concat(['core/i18n-dom.js', 'core/i18n.js'])) {
    await js(fs.readFileSync(path.join(client, file), 'utf8') + '\n;void 0;');
  }
  await js(`SoduWorkI18n.setLocale('en-US')`); await frame();
}
async function addFiles(names) {
  await js(`(() => {const data=new DataTransfer();for(const name of ${JSON.stringify(names)})data.items.add(new File(['fixture material'],name,{type:'text/plain'}));
    const input=document.querySelector('#wesAttachInput');input.files=data.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await until('ComposeDraft.capture()?.files.length===' + names.length, 'materials accepted by real attachment control');
}
async function assertDialog(title) {
  await until('Boolean(document.querySelector("dialog.wes-result-dialog:modal"))', 'native modal result dialog');
  assert.match(await js('document.querySelector(".wes-result-dialog").innerText'), new RegExp(title));
}

app.whenReady().then(async () => {
  win = new BrowserWindow({ show: false, width: 1100, height: 850, webPreferences: {
    contextIsolation: true, nodeIntegration: false, sandbox: true, offscreen: true, backgroundThrottling: false } });
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (request, callback) => {
    report.network.push(request.url); callback({ cancel: true });
  });
  buildPage();
  await runCase('english-requirement-form', async () => {
    await englishDraft(); await shot('english-form');
    assert.doesNotMatch(await js('document.querySelector("#workEntryLayer").innerText'), /[\u4e00-\u9fff]/);
    const original = await js('ComposeDraft.capture().draft');
    for (const value of ['zh-CN', 'ja-JP', 'ko-KR', 'en-US']) {
      await js(`SoduWorkI18n.setLocale(${JSON.stringify(value)})`); await frame();
      assert.deepEqual(await js('ComposeDraft.capture().draft'), original, 'locale changes preserve the draft');
    }
    assert.doesNotMatch(await js('document.querySelector("#workEntryLayer").innerText'), /[\u4e00-\u9fff]/);
  });
  for (const stage of ['intake', 'ready']) await runCase('english-requirement-receipt-' + stage, async () => {
    await englishDraft(stage); await click('#cpCreate');
    await until('Boolean(document.querySelector("dialog.wes-result-dialog:modal"))');
    await frame(); await shot('english-receipt-' + stage);
    assert.doesNotMatch(await js('document.querySelector(".wes-result-dialog").innerText'), /[\u4e00-\u9fff]/);
    assert.equal(await js('fixture.creates[0].task.title'), 'Design a login page');
    assert.equal(await js('fixture.creates[0].task.note'), 'Keep the original requirement text.');
    await button('View details');
    await until('fixture.details.length===1');
    assert.equal(await js('fixture.details[0].hadModal'), false);
  });
  await runCase('success-intake-closes-form-and-opens-detail', async () => {
    await setup(); await click('#cpCreate');
    await assertDialog('需求已创建');
    const state = await shot('success-intake');
    assert.match(state.text, /为团队整理可核对的需求/); assert.match(state.text, /收集箱/);
    assert.equal(await js('Boolean(document.querySelector("#workEntryLayer"))'), false);
    assert.equal(await js('fixture.creates.length'), 1);
    await button('查看详情');
    await until('fixture.details.length===1', 'detail navigation');
    assert.deepEqual(await js('fixture.details[0]'), { id: 'fixture-task-1', hadSheet: false, hadModal: false });
  });
  await runCase('pending-submit-shows-real-stage-and-busy-indicator', async () => {
    await setup(); await js("fixture.persistMode='defer'"); await click('#cpCreate');
    await until('fixture.pendingCreates.length===1');
    assert.equal(await js('document.querySelector("#cpCreate").disabled'), true);
    assert.match(await js('document.querySelector("#cpCreate").textContent'), /正在保存需求/);
    assert.equal(await js('document.querySelector("#cpCreate").getAttribute("aria-busy")'), 'true');
    assert.equal(await js('getComputedStyle(document.querySelector("#cpCreate"),"::before").animationName'), 'cp-submit-spin');
    await shot('pending-submit');
    await js('fixture.pendingCreates.shift()(true)'); await assertDialog('需求已创建');
    assert.equal(await js('fixture.creates.length'), 1);
  });
  await runCase('inline-chat-receipt-shows-confirmed-creation-time', async () => {
    const created = 1792700000000, updated = 1792700123000;
    await setup();
    await js("fixture.open({host:document.querySelector('#fixtureInline')}).then(()=>true)");
    await js("fixture.persistMode='defer'"); await click('#cpCreate');
    await until('fixture.pendingCreates.length===1');
    // The Hub confirms both timestamps; a creation receipt must not prefer the later update.
    await js(`delete tasks[0].createdAt;Object.assign(tasks[0], {created:${created}, updatedAt:${updated}});fixture.pendingCreates.shift()(true)`);
    await until('Boolean(document.querySelector(".cp-receipt-time"))');
    assert.equal(await js('document.querySelector(".cp-receipt-time").dateTime'), new Date(created).toISOString());
    assert.match(await js('document.querySelector(".cp-receipt-time").parentElement.textContent'), /创建时间/);
    assert.match(await js('document.querySelector(".cp-receipt-time").title'), /创建时间/);
    assert.equal(await js('document.querySelectorAll("[data-cp-receipt-close]").length'), 0);
    assert.equal(await js('fixture.creates.length'), 1);
    const saved = await js('ComposeDraft.capture()');
    assert.equal(saved.receipt.createdAt, created);
    assert.equal(saved.receipt.updatedAt, updated);
    await shot('inline-chat-receipt-time');

    await win.loadFile(page);
    await js(`fixture.open({host:document.querySelector('#fixtureInline'),cardState:${JSON.stringify(saved)}}).then(()=>true)`);
    await until('Boolean(document.querySelector(".cp-receipt-time"))');
    assert.equal(await js('document.querySelector(".cp-receipt-time").dateTime'), new Date(created).toISOString());
    assert.equal(await js('fixture.creates.length'), 0, 'restoring a receipt must not create another requirement');
    await shot('inline-chat-receipt-time-restored');
  });
  await runCase('failure-shows-error-dialog-and-keeps-form', async () => {
    await setup(); await js("fixture.persistMode='throw'"); await click('#cpCreate');
    await assertDialog('需求未提交完成');
    const state = await shot('failure-keeps-form');
    assert.match(state.dialog, /alertdialog/); assert.match(state.text, /连接中断/);
    assert.match(state.text, /填写内容和附件已保留/);
    assert.equal(await js('Boolean(document.querySelector("#cpCreate"))'), true, 'form stays editable for retry');
    assert.equal(await js('fixture.created.length'), 0);
    assert.equal(await js('fixture.pauses.length'), 1, 'unconfirmed task is paused to block duplicate dispatch');
    await button('返回继续');
    await until('!document.querySelector("dialog.wes-result-dialog:modal")', 'error dialog dismissed');
    assert.equal(await js('Boolean(document.querySelector("#cpCreate"))'), true);
  });
  await runCase('stored-with-failed-upload-retries-to-success', async () => {
    await setup(); await addFiles(['材料说明.txt']); await js("fixture.uploadMode='failure'"); await click('#cpCreate');
    await assertDialog('需求已保存，提交未完成');
    const state = await shot('stored-partial');
    assert.match(state.text, /1 个附件未上传/); assert.match(state.text, /已保存的需求不会重复创建/);
    assert.equal(await js('Boolean(document.querySelector("#cpCreate"))'), true);
    assert.equal(await js('fixture.creates.length'), 1); assert.equal(await js('fixture.created.length'), 0);
    await button('返回继续');
    await until('!document.querySelector("dialog.wes-result-dialog:modal")', 'partial dialog dismissed for retry');
    await js("fixture.uploadMode='success'"); await click('#cpCreate');
    await assertDialog('需求已创建');
    const done = await shot('stored-retry-success');
    assert.match(done.text, /为团队整理可核对的需求/);
    assert.equal(await js('fixture.uploads.length'), 2, 'retry uploads only the missing material once');
    assert.equal(await js('Boolean(document.querySelector("#workEntryLayer"))'), false);
    await button('知道了');
    await until('!document.querySelector("dialog.wes-result-dialog:modal")', 'success dialog dismissed by primary action');
  });
  await runCase('compact-viewport-and-alt-theme-keep-dialog-usable', async () => {
    win.setContentSize(390, 760);
    await setup({ width: 390, height: 760 });
    await js('document.documentElement.dataset.theme="steady"');
    await click('#cpCreate');
    await assertDialog('需求已创建');
    const state = await shot('compact-steady');
    assert.match(state.text, /需求已创建/);
    assert.equal(await js('getComputedStyle(document.querySelector(".wes-result-actions button")).flex'), '1 1 0%',
      'narrow layout gives action buttons full width');
    assert.ok(await js('(() => { const d = document.querySelector(".wes-result-dialog"); const r = d.getBoundingClientRect();'
      + 'return r.width <= window.innerWidth - 31 && r.height <= window.innerHeight - 39; })()'), 'dialog stays inside the compact viewport');
    await button('知道了');
    await until('!document.querySelector("dialog.wes-result-dialog:modal")', 'compact dialog dismissed');
  });
  report.ok = report.cases.length > 0 && report.cases.every(item => item.ok) && report.network.length === 0;
}).catch(error => { report.error = error.stack; }).finally(() => {
  win?.destroy(); fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: report.ok, cases: report.cases, error: report.error, report: path.join(out, 'report.json') }));
  app.exit(report.ok ? 0 : 1);
});
