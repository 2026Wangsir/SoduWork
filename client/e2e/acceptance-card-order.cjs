'use strict';
// Real SDK archives and the production Electron renderer share isolated synthetic receipts.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const electron = require('electron');
const output = process.argv[2];
if (!output || !path.isAbsolute(output)) throw Error('Absolute evidence directory required');
fs.mkdirSync(output, { recursive: true });
const fixtureFile = path.join(output, 'fixture.json');

async function recordArchive() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-review-order-sdk-'));
  const stream = require('../main/pi-session/event-stream');
  const times = require('../main/conversation/message-time');
  const source = require('../main/conversation/native-agent-source.cjs');
  const acc = stream.create(), timeline = [], approvals = [];
  let turnId = '', sentAt = 0, streaming;
  const sdkFixture = await require('./fixtures/access-sdk.cjs').create(root, 'standard', () => {}, {
    persist: true, reply: () => null,
    beforeResponse: () => {
      approvals.push({ id: 'review-' + approvals.length, action: 'review', status: 'pending', createdAt: Date.now() });
    },
  });
  try {
    source.install(sdkFixture.session.sessionManager, 'pi');
    sdkFixture.session.subscribe(event => {
      times.stampPiEvent(event, sentAt, turnId);
      acc.push(source.event(event, 'pi'));
      if (event.type === 'message_update' && !streaming) streaming = structuredClone(acc.snapshot());
    });
    const snapshots = [];
    for (let index = 0; index < 2; index++) {
      turnId = 'native-turn-' + index; sentAt = Date.now();
      const detail = { conversationId: 'native-chat', turnId, executor: 'native' };
      timeline.push({ kind: 'conversation.turn', at: sentAt, detail: { ...detail, state: 'queued' } });
      await sdkFixture.session.prompt(index ? 'Revise the same essay.' : 'Write an essay for review.');
      timeline.push({ kind: 'conversation.turn', at: Date.now(), detail: { ...detail, state: 'completed' } });
      snapshots.push(structuredClone(acc.snapshot()));
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const restored = stream.create();
    const manager = sdkFixture.sdk.SessionManager.open(sdkFixture.session.sessionManager.getSessionFile());
    require('../main/pi-session/session')._seed(restored, { state: { messages: [] }, sessionManager: manager });
    const reopened = restored.snapshot();
    assert.deepEqual(reopened.messages.filter(row => row.role === 'user').map(row => row.submissionId),
      ['native-turn-0', 'native-turn-1']);
    assert.ok(reopened.messages.every(row => !row.taskId && !row.taskOutputKey));
    const details = Object.fromEntries(approvals.map(approval => [approval.id,
      { ...approval, taskId: 'task', assignment: { userId: 'self', reasons: [] } }]));
    fs.writeFileSync(fixtureFile, JSON.stringify({ snapshots, reopened, streaming, timeline, approvals, details }));
  } finally {
    await sdkFixture.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (typeof electron === 'string') {
  recordArchive().then(() => {
    const env = { ...process.env };
    for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE']) delete env[key];
    const result = require('node:child_process').spawnSync(electron, [__filename, output],
      { env, stdio: 'inherit', windowsHide: true, timeout: 120000 });
    process.exitCode = result.status ?? 1;
  }).catch(error => { console.error(error); process.exitCode = 1; });
} else {
  const { app, BrowserWindow } = electron;
  const data = JSON.parse(fs.readFileSync(fixtureFile, 'utf8'));
  const report = { ok: false, checks: [], boundary: 'Real Pi SDK with a loopback fixture provider, production Electron renderer and synthetic Hub receipts; no production account.' };
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-review-order-electron-'));
  app.setPath('userData', profile); app.disableHardwareAcceleration();
  let win;
  app.whenReady().then(async () => {
    win = new BrowserWindow({ show: false, width: 1100, height: 900,
      webPreferences: { contextIsolation: true, sandbox: true, offscreen: true, backgroundThrottling: false } });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_request, done) => done({ cancel: true }));
    const js = source => win.webContents.executeJavaScript(source, true);
    await win.loadFile(path.join(__dirname, 'fixtures/long-conversation.html'));
    const styles = [...fs.readFileSync(path.join(__dirname, '../desk.html'), 'utf8')
      .matchAll(/<link\b[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']+)/g)]
      .map(match => require('node:url').pathToFileURL(path.join(__dirname, '..', match[1])).href);
    await js(`Promise.all(${JSON.stringify(styles)}.map(href=>new Promise((resolve,reject)=>{
      const link=document.createElement('link');link.rel='stylesheet';link.href=href;
      link.onload=resolve;link.onerror=reject;document.head.append(link);
    })))`);
    await js(`document.documentElement.dataset.skin='box';
      document.querySelector('#root').style.height='900px';document.querySelector('#nchatScroll').style.height='900px';void 0;`);
    await js(fs.readFileSync(path.join(__dirname, '../components/panels/task-trace-approval.js'), 'utf8'));
    await js(`window.__teamCap={meId:'self'};ctx._sessionId='native-chat';
      window.entry={taskId:'task',nativeTurn:true,task:{createdBy:'self',assigneeUserId:'self',title:'Isolated review'},trace:{}};
      ctx._collabEntries=()=>[entry];ctx._collabTasks=new Map([['task',entry]]);ctx._collabEntryStatus=()=> 'completed';
      window.detailItems=${JSON.stringify(data.details)};window.heldDetails=[];window.holdDetails=true;
      window.SoduWorkAPI={taskStorageKey:key=>'isolated-account:'+key,
        listApprovals:async()=>({pendingTasks:entry.trace.approvals.filter(row=>row.status==='pending').map(row=>({id:row.id})),items:[]}),
        approvalDetail:async id=>{
          if(window.failDetails)throw Error('Isolated evidence service unavailable');
          if(holdDetails)await new Promise(resolve=>heldDetails.push(resolve));
          return {item:detailItems[id]};
        }};void 0;`);
    const waitFor = async (predicate, label) => {
      const deadline = Date.now() + 5000;
      while (!(await predicate())) {
        if (Date.now() > deadline) throw Error('Timed out: ' + label);
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    };
    const render = async (snapshot, approvals, timeline, reset = true) => {
      await js(`ctx._snap=${JSON.stringify(snapshot)};entry.trace=${JSON.stringify({ approvals, timeline })};
        ${reset ? 'renderer.reset();' : ''}renderer._render();void 0;`);
    };
    const order = () => js(`[...document.querySelector('#nchatList').children].map(row=>row.dataset.chatNode).filter(Boolean)`);
    const after = async (approvalId, messageIndex, nextMessage) => {
      await waitFor(async () => {
        const rows = await order();
        const card = rows.indexOf('task-confirmation:approval:' + JSON.stringify(['task', approvalId]));
        const visible = await js(`(()=>{
          const key=${JSON.stringify('task-confirmation:approval:' + JSON.stringify(['task', approvalId]))};
          const card=[...document.querySelector('#nchatList').children].find(row=>row.dataset.chatNode===key);
          return !!card && card.getBoundingClientRect().height>0 && !card.querySelector('[data-tfd-approval-id][hidden]');
        })()`);
        return visible && card > rows.indexOf('message:' + messageIndex) &&
          (nextMessage === undefined || card < rows.indexOf('message:' + nextMessage));
      }, 'review follows its own answer');
      const rows = await order();
      const card = rows.indexOf('task-confirmation:approval:' + JSON.stringify(['task', approvalId]));
      assert.ok(card > rows.indexOf('message:' + messageIndex), JSON.stringify(rows));
      if (nextMessage !== undefined) assert.ok(card < rows.indexOf('message:' + nextMessage), JSON.stringify(rows));
    };
    await render(data.snapshots[0], data.approvals.slice(0, 1), data.timeline.slice(0, 2));
    await waitFor(() => js('heldDetails.length===1'), 'approval detail request');
    assert.equal(await js(`document.querySelector('[data-tfd-approval-id]').hidden`), true);
    await js('holdDetails=false;heldDetails.splice(0).forEach(resolve=>resolve());void 0;');
    await after('review-0', 1);
    await js(`document.body.style.padding='16px';document.querySelector('#nchatScroll').scrollTop=0;
      new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
    fs.writeFileSync(path.join(output, 'native-order.png'), (await win.webContents.capturePage()).toPNG());
    report.checks.push('Real approval-detail hydration moves a raw trace review after its native SDK answer without projected-output metadata');

    const approvals = structuredClone(data.approvals);
    approvals[0].status = 'rejected'; approvals[0].decisions = [{ userId: 'self', decision: 'reject', note: 'Revise the same essay' }];
    await render(data.snapshots[1], approvals, data.timeline.slice().reverse());
    await after('review-0', 1, 2); await after('review-1', 3);
    report.checks.push('A second round follows its own result while the first decision stays before rework');
    await render(data.reopened, approvals, data.timeline);
    await after('review-0', 1, 2); await after('review-1', 3);
    report.checks.push('Reopening the real persisted SDK archive restores both original review positions');

    const later = structuredClone(data.reopened);
    later.messages.push({ role: 'user', submissionId: 'ordinary-follow-up', sentAt: Date.now(), text: 'An unrelated question' },
      { role: 'assistant', done: false, blocks: [{ kind: 'text', done: false, text: 'A later answer' }] });
    later.status = 'streaming';
    await render(later, approvals, data.timeline);
    await after('review-1', 3, 4);
    report.checks.push('An unrelated streaming turn does not hide or move an earlier review');
    await render(data.streaming, data.approvals.slice(0, 1), data.timeline.slice(0, 1));
    await waitFor(() => js(`document.querySelectorAll('[data-task-confirmation]').length===0`), 'pending native answer');
    assert.equal(await js(`document.querySelectorAll('[data-task-confirmation]').length`), 0);
    await render(data.snapshots[0], data.approvals.slice(0, 1), data.timeline.slice(0, 2), false);
    await after('review-0', 1);
    report.checks.push('An early review waits for its exact native answer to finish');
    await js(`window.failDetails=true;document.querySelector('#nchatList').replaceChildren();void 0;`);
    await render(data.snapshots[0], data.approvals.slice(0, 1), data.timeline.slice(0, 2));
    await waitFor(() => js(`!!document.querySelector('[data-tfd-proof-retry]')`), 'visible permission retry');
    assert.equal(await js(`document.querySelector('[data-tfd-approval-id]').hidden`), false);
    await js(`window.failDetails=false;document.querySelector('[data-tfd-proof-retry]').click();void 0;`);
    await after('review-0', 1);
    report.checks.push('Transient approval-detail failure preserves a visible retry and successful retry restores correct placement');
    report.ok = true;
  }).catch(error => { report.error = error.stack || String(error); }).finally(() => {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
    if (win && !win.isDestroyed()) win.destroy();
    fs.rmSync(profile, { recursive: true, force: true });
    app.exit(report.ok ? 0 : 1);
  });
}
