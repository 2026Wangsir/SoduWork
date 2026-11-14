'use strict';
// The provider emits plain text into the production native completion pipeline;
// Chromium receives its real snapshots, never a prebuilt acceptance card.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE']) delete env[key];
  const result = require('node:child_process').spawnSync(electron, [__filename, ...process.argv.slice(2)],
    { env, stdio: 'inherit', timeout: 120000 });
  process.exit(result.status ?? 1);
}
const { app, BrowserWindow } = electron;
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const fixture = require('../tests/fixtures/acceptance-analysis-runtime.cjs');
const output = path.resolve(process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-acceptance-native-')));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-acceptance-profile-'));
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', profile);
app.disableHardwareAcceleration();
const report = { ok: false, checks: [], errors: [], boundary: 'Real Electron main and Chromium renderer. Production acceptance preparation, turn queue, stream accumulator, native message persistence, history restoration and card renderer. Synthetic provider events and Hub context; no real provider inference or production account.' };
let win;
app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({ show: false, width: 1100, height: 900,
      webPreferences: { contextIsolation: true, sandbox: true, offscreen: true, backgroundThrottling: false } });
    win.webContents.on('console-message', event => { if (event.level === 'error') report.errors.push(event.message); });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_request, done) => done({ cancel: true }));
    await win.loadFile(path.join(__dirname, 'fixtures/long-conversation.html'));
    const js = source => win.webContents.executeJavaScript(source, true);
    const styles = [...fs.readFileSync(path.join(__dirname, '../desk.html'), 'utf8')
      .matchAll(/<link\b[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']+)/g)]
      .map(match => pathToFileURL(path.join(__dirname, '..', match[1])).href);
    await js(`Promise.all(${JSON.stringify(styles)}.map(href=>new Promise((resolve,reject)=>{
      const link=document.createElement('link');link.rel='stylesheet';link.href=href;link.onload=resolve;link.onerror=reject;document.head.append(link);
    }))).then(()=>true)`);
    const shot = async name => {
      await js(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))).then(()=>true)`);
      await new Promise(resolve => setTimeout(resolve, 120));
      fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG());
    };
    const f = await fixture.create({ cwd: profile });
    const approval = { id: f.review.approvalId, action: 'review', status: 'pending', artifactVersionId: f.review.artifactVersionId };
    await js(`window.calls=[];window.SoduWorkAPI={decideApproval:async(...args)=>{calls.push(args);return{ok:true,request:{status:'approved'}}}};
      ctx._sessionOptions={taskRef:${JSON.stringify(f.review.task.id)},acceptanceSession:true,approvalId:${JSON.stringify(f.review.approvalId)}};
      ctx._collaborationTask=${JSON.stringify(f.review.task)};ctx._collaborationTrace={approvals:[${JSON.stringify(approval)}]};
      ctx._loadCollabTask=async()=>{};void 0;`);
    const paint = async snapshot => js(`ctx._snap=${JSON.stringify(snapshot)};renderer._render();void 0;`);
    await f.run(async snapshot => {
      await paint(snapshot);
      assert.equal(await js(`document.querySelectorAll('.nacceptance-result').length`), 0);
    });
    report.checks.push('Provider text streams through the production accumulator without an early result card');
    await paint(f.acc.snapshot());
    assert.equal(await js(`document.querySelectorAll('.nacceptance-result.is-analysis').length`), 1);
    assert.equal(await js(`document.querySelectorAll('[data-acceptance-result-action]').length`), 3);
    assert.equal(await js(`document.querySelectorAll('.nmsg.ai').length`), 1);
    assert.match(await js(`document.querySelector('.nacceptance-result').textContent`), /逐项核验/);
    assert.equal(await js('calls.length'), 0);
    assert.ok(f.requests.every(row => !row.body));
    assert.doesNotMatch(JSON.stringify(f.journal), /local:model-/);
    report.checks.push('Completion creates one native result card without a protocol heading or duplicate prose; no approval or local model metadata is sent to Hub');
    await shot('completed');

    const saved = path.join(output, 'synthetic-native-transcript.json');
    fs.writeFileSync(saved, JSON.stringify(f.transcript()));
    const restored = require('../main/pi-session/event-stream').create();
    require('../main/pi-session/history-seed').seed(restored, { state: { messages: JSON.parse(fs.readFileSync(saved, 'utf8')) } }, {});
    await js('renderer.reset();void 0;');
    await paint(restored.snapshot());
    assert.equal(await js(`document.querySelectorAll('.nacceptance-result.is-analysis').length`), 1);
    assert.equal(await js(`document.querySelectorAll('[data-acceptance-result-action]').length`), 3);
    report.checks.push('Production history replay preserves the native analysis receipt and exact pending review controls');
    await js(`ctx._collaborationTrace.approvals[0].artifactVersionId='revised-artifact';renderer.reset();renderer._render();void 0;`);
    assert.equal(await js(`document.querySelectorAll('[data-acceptance-result-action]').length`), 0);
    assert.equal(await js(`document.querySelectorAll('.nacceptance-result').length`), 1);
    report.checks.push('A later artifact leaves the historical card read-only after reopening');
    await js(`ctx._collaborationTrace.approvals[0].artifactVersionId=${JSON.stringify(approval.artifactVersionId)};renderer.reset();renderer._render();void 0;`);
    const point = await js(`(()=>{const n=document.querySelector('[data-acceptance-result-action="approve"]');n.scrollIntoView({block:'center',behavior:'instant'});const r=n.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
    for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, ...point, button: 'left', clickCount: 1 });
    for (let attempt = 0; attempt < 30 && !(await js('calls.length')); attempt++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(await js('calls.length'), 1);
    assert.deepEqual(await js('calls[0].slice(0,2)'), [approval.id, 'approve']);
    assert.match(await js(`document.querySelector('.nacceptance-result').textContent`), /已确认验收/);
    report.checks.push('Only an actual Chromium mouse click submits one explicit approval for the pinned review');
    await shot('confirmed');

    const incomplete = await fixture.create({ cwd: profile, stopReason: 'length' });
    await incomplete.run();
    await js('renderer.reset();void 0;');
    await paint(incomplete.acc.snapshot());
    assert.equal(await js(`document.querySelectorAll('.nacceptance-result').length`), 0);
    assert.equal(incomplete.journal.length, 0);
    report.checks.push('A provider length stop produces no native result card or approval controls');
    const misleading = await fixture.create({ cwd: profile, text: '【验收确认卡】\n逐项核验结束，建议人工确认。' });
    await misleading.run();
    await js('renderer.reset();void 0;');
    await paint(misleading.acc.snapshot());
    assert.equal(await js(`document.querySelectorAll('.nacceptance-result.is-analysis').length`), 1);
    assert.equal(await js(`document.querySelectorAll('.nacceptance-result.is-confirmed').length`), 0);
    report.checks.push('A model-supplied confirmation heading remains manual analysis rather than a completed approval');
    assert.deepEqual(report.errors, []);
    report.ok = true;
  } catch (error) { report.errors.push(error.stack || String(error)); }
  finally {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    process.stdout.write(JSON.stringify({ ok: report.ok, checks: report.checks.length, output, errors: report.errors }) + '\n');
    win?.destroy();
    app.exit(report.ok ? 0 : 1);
  }
});
