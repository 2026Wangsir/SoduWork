'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const fixture = require('./fixtures/acceptance-analysis-runtime.cjs');

test('production stream completion creates a private, turn-bound analysis receipt without a model heading', async t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-completion-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const f = await fixture.create({ cwd });
  let frames = 0;
  const result = await f.run(snapshot => {
    frames++;
    assert.equal(f.journal.length, 0, 'streaming cannot publish a completed review');
    assert.equal(snapshot.status, 'streaming');
  });
  assert.equal(result.ok, true, result.reason);
  assert.equal(frames, 2);
  assert.equal(f.journal.length, 1);
  const receipt = f.journal[0];
  assert.match(receipt.taskOutputKey, /^acceptance-analysis:v1:/);
  const binding = JSON.parse(decodeURIComponent(receipt.taskOutputKey.slice('acceptance-analysis:v1:'.length)));
  assert.deepEqual(binding, { taskId: 'acceptance-task', approvalId: 'approval-current',
    artifactVersionId: 'artifact-current', requirementVersion: 3, turnId: 'analysis-turn' });
  assert.match(receipt.content[0].text, /逐项核验/);
  assert.doesNotMatch(receipt.content[0].text, /【验收分析结果】/);
  assert.equal(receipt.model, 'task-executor');
  assert.doesNotMatch(JSON.stringify(receipt), /local:model-/);
  assert.ok(f.requests.every(row => !row.body), 'analysis never submits an approval or model metadata');
  await f.turn.afterTurn('completed', result);
  assert.equal(f.journal.length, 1, 'completion replay is idempotent');
  assert.equal(f.events.at(-1).kind, 'task-message');
});

test('incomplete, stopped, old and ambiguous replies cannot become the current analysis receipt', async t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-incomplete-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  for (const stopReason of ['length', 'error', 'aborted']) {
    const f = await fixture.create({ cwd, stopReason });
    await f.run();
    assert.equal(f.journal.length, 0, stopReason);
  }
  const f = await fixture.create({ cwd });
  await f.turn.afterTurn('stopped');
  await f.turn.afterTurn('failed');
  const user = { role: 'user', submissionId: 'analysis-turn' };
  const answer = { role: 'assistant', done: true, blocks: [{ kind: 'text', done: true, text: 'Old answer' }] };
  for (const messages of [[answer], [{ ...user, submissionId: 'old-turn' }, answer],
    [user, user, answer], [user, answer, { ...user, submissionId: 'later-turn' }, answer],
    [user, { ...answer, done: false }], [user, { ...answer, stopReason: 'toolUse' }]]) {
    await assert.rejects(f.turn.afterTurn('completed', { snapshot: { messages } }), /本轮完整/);
  }
  assert.equal(f.journal.length, 0);
});
