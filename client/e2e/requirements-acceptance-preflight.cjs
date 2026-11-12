'use strict';
// Real authenticated HTTP and native renderer input; navigation is the model boundary.
const {app, BrowserWindow} = require('electron');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const [output, hub] = process.argv.slice(2);
if (!path.isAbsolute(output || '') || !/^http:\/\/127\.0\.0\.1:\d+$/.test(hub || '')) throw Error('Isolated Hub required');
fs.mkdirSync(output, {recursive: true});
app.setPath('userData', path.join(output, 'profile'));
const report = {ok: false, checks: [], boundary: 'Production HTTP, Device authentication, delivery freezing and Electron renderer; navigation recorded without a model call'};
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let win, identity;
async function request(route, method = 'GET', body) {
  const response = await fetch(hub + '/api/v1' + route, {method,
    headers: {'Content-Type': 'application/json', Authorization: 'Device ' + identity.session},
    ...(body ? {body: JSON.stringify(body)} : {})});
  const data = await response.json();
  assert.equal(response.status, 200, route + ': ' + JSON.stringify(data));
  return data;
}
async function submit(taskId, criteria) {
  const route = '/tasks/' + taskId;
  const scope = {conversationId: taskId + '-chat', turnId: taskId + '-turn', executor: 'native'};
  await request(route, 'PUT', {title: taskId, status: 'todo', triageStage: 'ready', kind: 'requirement', acceptanceCriteria: criteria});
  await request(route + '/conversation-turn', 'POST', {...scope, action: 'prepare'});
  await request(route + '/conversation-turn', 'POST', {...scope, action: 'start'});
  await require('../main/pi-session/task-delivery.cjs').send(identity, route, scope, {
    outcome: 'completed', model: '', files: [{name: 'result.txt', category: 'primary', contentType: 'text/plain',
      data: Buffer.from('Synthetic review result').toString('base64')}],
  });
  await request(route + '/conversation-turn', 'POST', {...scope, action: 'complete'});
  await request(route + '/submit-review', 'POST', {});
  return request(route + '/acceptance-context');
}
const js = async source => {
  const value = await win.webContents.executeJavaScript(`(async()=>{try{return await(0,eval)(${JSON.stringify(source)})}catch(e){return{fixtureError:e.stack}}})()`, true);
  if (value?.fixtureError) throw Error(value.fixtureError);
  return value;
};
async function until(source) {
  for (let i = 0; i < 60; i++) {if (await js(source)) return; await wait(100);}
  throw Error('Renderer condition did not settle: ' + source);
}
async function click(selector) {
  // Approval cards stay hidden while their asynchronous permission lookup runs.
  // Textareas are not disabled by that lookup, so presence alone is insufficient.
  await until(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n||n.disabled)return false;
    const b=n.getBoundingClientRect();return b.width>0&&b.height>0})()`);
  const p = await js(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});n.scrollIntoView({block:'center',behavior:'instant'});
    const b=n.getBoundingClientRect();if(!b.width||!b.height)throw Error('Invisible control');return{x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)}})()`);
  for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({type, ...p, button: 'left', clickCount: 1});
  await wait(100);
}
app.whenReady().then(async () => {
  try {
    const enrolled = await fetch(hub + '/api/v1/clients/enroll', {method: 'POST', headers: {
      'Content-Type': 'application/json', 'X-Device-Key': 'isolated-requirements-fixture-key-never-production',
    }, body: JSON.stringify({device: 'e2e-recipient', name: 'Acceptance preflight fixture'})});
    assert.equal(enrolled.status, 200);
    identity = {hub, clientId: 'e2e-recipient', session: (await enrolled.json()).session};
    const missing = await submit('missing-review-criteria', []);
    const ready = await submit('ready-review-criteria', ['The output contains Synthetic review result']);
    assert.ok(missing.artifactVersionId); assert.deepEqual(missing.criteria, []);
    assert.ok(ready.artifactVersionId); assert.equal(ready.criteria.length, 1);
    await assert.rejects(require('../main/pi-session/acceptance-turn').prepare({identity,
      taskId: 'missing-review-criteria', requested: {acceptanceMode: 'auto'}, runtime: {handle: {cwd: output}},
      request: async (_identity, route) => request(route),
    }), /自动验收需要明确的验收标准和固定交付版本/);
    report.checks.push('Real completed deliveries freeze review versions with and without criteria; the runtime guard still rejects missing criteria');

    win = new BrowserWindow({show: false, width: 1280, height: 1000,
      webPreferences: {contextIsolation: true, sandbox: true, offscreen: true, partition: 'acceptance-preflight'}});
    await win.loadFile(path.join(__dirname, 'fixtures/requirements-integration.html'), {query: {hub, identity: 'recipient'}});
    assert.equal(await js('fixtureReady'), 'ready');
    for (const name of ['task-trace-approval', 'task-approval-inbox'])
      await js(fs.readFileSync(path.join(__dirname, '../components/panels', name + '.js'), 'utf8'));
    await win.webContents.insertCSS(fs.readFileSync(path.join(__dirname, '../components/panels/task-trace-view.css'), 'utf8'));
    // Keep the production preflight and card lifecycle; record the downstream session navigation only.
    await js(`window.fixtureNavigation=[];window.openTaskConversation=async(id,title,opts)=>{fixtureNavigation.push({id,mode:opts.acceptanceMode});return true};TaskApprovalInbox.refresh()`);
    await js(`RequirementsDetail.open('missing-review-criteria')`);
    await click('[data-tfd-approval-note]');
    await win.webContents.insertText('Keep this review note');
    await click('[data-tfd-acceptance-mode][value="auto"]');
    await click('[data-tfd-acceptance-session="auto"]');
    await until(`!!document.querySelector('[data-tfd-approval-error]:not([hidden])')`);
    assert.equal(await js('fixtureNavigation.length'), 0);
    assert.match(await js(`document.querySelector('[data-tfd-approval-error]').textContent`), /自动验收需要明确的验收标准和固定交付版本/);
    assert.equal(await js(`document.querySelector('[data-tfd-approval-note]').value`), 'Keep this review note');
    assert.equal(await js(`document.querySelector('[data-tfd-acceptance-session="auto"]').disabled`), false);
    fs.writeFileSync(path.join(output, 'missing-criteria.png'), (await win.webContents.capturePage()).toPNG());
    await click('[data-tfd-acceptance-mode][value="manual"]');
    await click('[data-tfd-acceptance-session="1"]');
    await until('fixtureNavigation.length===1');
    assert.deepEqual(await js('fixtureNavigation[0]'), {id: 'missing-review-criteria', mode: 'manual'});
    assert.equal((await request('/tasks/missing-review-criteria')).requirementStage, 'reviewing');
    report.checks.push('Native automatic-review click stays on the original card, preserves the note, exposes the existing error and permits manual analysis without changing review state');

    await js(`RequirementsDetail.open('ready-review-criteria')`);
    await click('[data-tfd-acceptance-mode][value="auto"]');
    await click('[data-tfd-acceptance-session="auto"]');
    await until('fixtureNavigation.length===2');
    assert.deepEqual(await js('fixtureNavigation[1]'), {id: 'ready-review-criteria', mode: 'auto'});
    assert.deepEqual(await js('fixtureErrors'), []);
    report.checks.push('Native automatic-review click navigates once when authoritative frozen criteria and a fixed version are present');
    report.ok = true;
  } catch (error) {
    report.error = String(error.stack || error);
    if (win) fs.writeFileSync(path.join(output, 'failure.png'), (await win.webContents.capturePage()).toPNG());
  } finally {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report)); app.exit(report.ok ? 0 : 1);
  }
});
