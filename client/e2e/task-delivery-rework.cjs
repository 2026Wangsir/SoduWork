'use strict';

// Production capture, authenticated HTTP, immutable versions and review inputs
// share this two-turn fixture. File generation stands in for the model only.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict'), crypto = require('node:crypto'), zlib = require('node:zlib');

function zipHashes(bytes) {
  const files = {};
  let at = 0;
  while (bytes.readUInt32LE(at) === 0x04034b50) {
    assert.equal(bytes.readUInt16LE(at + 6) & 8, 0, 'The isolated ZIP must declare local entry sizes');
    const method = bytes.readUInt16LE(at + 8), size = bytes.readUInt32LE(at + 18);
    const nameLength = bytes.readUInt16LE(at + 26), extraLength = bytes.readUInt16LE(at + 28);
    const name = bytes.subarray(at + 30, at + 30 + nameLength).toString('utf8');
    const start = at + 30 + nameLength + extraLength, data = bytes.subarray(start, start + size);
    assert.ok(method === 0 || method === 8);
    assert.equal(Object.hasOwn(files, name), false);
    files[name] = hash(method === 8 ? zlib.inflateRawSync(data) : data);
    at = start + size;
  }
  assert.equal(bytes.readUInt32LE(at), 0x02014b50);
  return files;
}
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

module.exports = async function deliveryRework(hub, report) {
  assert.match(hub, /^http:\/\/127\.0\.0\.1:\d+$/);
  const enrollment = await fetch(hub + '/api/v1/clients/enroll', {method:'POST',
    headers:{'Content-Type':'application/json', 'X-Device-Key':'isolated-requirements-fixture-key-never-production'},
    body:JSON.stringify({device:'e2e-recipient', name:'Isolated rework fixture'})});
  assert.equal(enrollment.status, 200);
  const identity = {hub, clientId:'e2e-recipient', session:(await enrollment.json()).session};
  assert.ok(identity.session);
  const request = async (route, method = 'GET', body) => fetch(hub + '/api/v1' + route, {method,
    headers:{Authorization:'Device ' + identity.session, 'Content-Type':'application/json'},
    ...(body ? {body:JSON.stringify(body)} : {})});
  const json = async (route, method, body) => {
    const response = await request(route, method, body), data = await response.json();
    assert.equal(response.status, 200, route + ': ' + JSON.stringify(data)); return data;
  };
  const download = async (route, version) => {
    const response = await request(route + '/artifacts.zip?artifactVersionId=' + encodeURIComponent(version));
    assert.equal(response.status, 200);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(response.headers.get('X-Artifact-Version'), version);
    assert.equal(response.headers.get('X-Artifact-SHA256'), hash(bytes));
    return zipHashes(bytes);
  };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-delivery-rework-'));
  const scenarios = [
    {id:'final-format', request:'请把交付格式改成 HTML，只保留最终网页'},
    {id:'retain-original', request:'请把交付格式改成 HTML，同时保留原来的 TXT', keepOriginal:true},
    {id:'retain-qualified', request:'Convert to HTML; keep only the final HTML; retain the original TXT for audit.', keepOriginal:true},
    {id:'same-filename', request:'改成 HTML，只保留最终网页', sameName:true},
  ];
  try {
    for (const scenario of scenarios) {
      const taskId = 'delivery-rework-' + scenario.id, route = '/tasks/' + taskId;
      const conversationId = taskId + '-chat', cwd = path.join(root, scenario.id);
      fs.mkdirSync(cwd);
      await json(route, 'PUT', {title:'Rework ' + scenario.id, status:'todo', triageStage:'ready',
        kind:'requirement', acceptanceCriteria:['Deliver the requested final format']});
      const state = {status:'idle', messages:[], tools:[]};
      let turnSince = Date.now();
      const handle = {cwd, sessionId:conversationId, snapshot:()=>state,
        outputSnapshot:()=>require('../main/pi-session/outputs').scan(cwd, 0, turnSince)};
      const firstName = scenario.sameName ? 'report.html' : 'report.txt';
      const firstBytes = Buffer.from(scenario.sameName ? '<html><body>Original</body></html>' : 'Original report');
      let firstContext, secondContext;
      for (const round of [1, 2]) {
        turnSince = Date.now();
        const scope = {conversationId, turnId:taskId + '-turn-' + round, executor:'native', submissionMode:'auto'};
        for (const action of ['prepare', 'start']) await json(route + '/conversation-turn', 'POST', {...scope, action});
        const name = round === 1 ? firstName : 'report.html';
        const bytes = round === 1 ? firstBytes : Buffer.from('<!doctype html><html><body>Final revision</body></html>');
        if (round === 2) {
          const old = new Date(turnSince - 10000); fs.utimesSync(path.join(cwd, firstName), old, old);
          if (!scenario.sameName) {
            fs.mkdirSync(path.join(cwd, '.soduwork'));
            fs.writeFileSync(path.join(cwd, '.soduwork/delivery.json'), JSON.stringify({schemaVersion:1,
              deliverables:[{path:firstName}, {path:'report.html'}]}));
          }
        }
        fs.writeFileSync(path.join(cwd, name), bytes);
        state.messages = [{role:'user', content:round === 1 ? 'Write the report' : scenario.request},
          {role:'assistant', content:'Final result: [' + name + '](' + name + ')'}];
        const expected = round === 2 && scenario.keepOriginal ? {'report.html':hash(bytes), [firstName]:hash(firstBytes)}
          : {[name]:hash(bytes)};
        const delivery = await require('../main/pi-session/task-delivery.cjs').capture(handle, 'completed');
        assert.deepEqual(delivery.files.map(file=>file.name).sort(), Object.keys(expected).sort(), scenario.request);
        const receipt = await require('../main/pi-session/task-delivery.cjs').send(identity, route, scope, delivery);
        assert.equal(receipt.round, round);
        await json(route + '/conversation-turn', 'POST', {...scope, action:'complete'});
        const context = await json(route + '/acceptance-context');
        assert.deepEqual(context.attachments.map(file=>file.filename).sort(), Object.keys(expected).sort());
        assert.deepEqual(await download(route, context.artifactVersionId), expected);
        const review = await require('../main/pi-session/task-input').prepare(identity, taskId,
          taskId + '-review-' + round, 'review', 'Review the final format', {acceptanceOnly:true, acceptanceMode:'auto'},
          {handle:{cwd, sessionId:taskId + '-review-' + round}});
        await review.beforeTurn(); assert.equal(review.attachments.length, 1);
        if (Object.keys(expected).length === 1) {
          assert.equal(context.deliveryBundle, null);
          assert.equal(review.attachments[0].name, name); assert.deepEqual(review.attachments[0].data, bytes);
        } else {
          assert.equal(context.deliveryBundle.fileCount, 2);
          assert.deepEqual(zipHashes(review.attachments[0].data), expected);
        }
        if (round === 1) {
          firstContext = context;
          await json('/approvals/' + context.approvalId + '/decision', 'POST',
            {decision:'reject', note:scenario.request});
        } else secondContext = context;
      }
      assert.notEqual(firstContext.artifactVersionId, secondContext.artifactVersionId);
      assert.ok(secondContext.attachmentIds.every(id=>!firstContext.attachmentIds.includes(id)));
      assert.deepEqual(await download(route, firstContext.artifactVersionId), {[firstName]:hash(firstBytes)});
      const attachments = await json(route + '/attachments');
      assert.equal(attachments.filter(file=>file.role === 'output').length, scenario.keepOriginal ? 3 : 2);
      const stale = await request(route + '/auto-review', 'POST', {approvalId:firstContext.approvalId,
        artifactVersionId:firstContext.artifactVersionId, requirementVersion:firstContext.requirementVersion,
        report:{verdict:'approve', summary:'Stale fixture result', checks:[{criterion:'criterion-1',
          result:'pass', evidence:'Original revision was read'}]}});
      assert.equal(stale.status, 409, await stale.text());
      scenario.taskId = taskId;
    }
    report.checks.push('Two real HTTP turns and rejection keep final-only HTML separate from historical TXT; explicit original retention still produces both formats');
    report.checks.push('Automatic acceptance inputs match fixed artifact bytes; same-name revisions have distinct IDs, original pinned downloads survive, and stale decisions receive 409');
    return scenarios;
  } finally { fs.rmSync(root, {recursive:true, force:true}); }
};
