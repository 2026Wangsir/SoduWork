'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('./renderer-source.cjs');
const path = require('path');
const attachmentFiles = require('../main/attachment-files');

const root = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const ticket = 'abcdefghijklmnop.qrstuvwxyz012345.abcdefghi';

test('attachment preview URLs stay inside the active Hub and exact API route', () => {
  const relative = attachmentFiles.parseAttachmentUrl(
    '/api/v1/attachments/12345678?ticket=' + ticket,
    'http://192.0.2.10:8989',
    'preview');
  assert.equal(relative.id, '12345678');
  assert.equal(relative.url,
    'http://192.0.2.10:8989/api/v1/attachments/12345678?ticket=' +
    ticket + '&mode=preview');

  assert.throws(() => attachmentFiles.parseAttachmentUrl(
    'http://evil.example/api/v1/attachments/12345678?ticket=' + ticket,
    'http://192.0.2.10:8989'));
  assert.throws(() => attachmentFiles.parseAttachmentUrl(
    '/api/v1/tasks/12345678?ticket=' + ticket,
    'http://192.0.2.10:8989'));
  assert.throws(() => attachmentFiles.parseAttachmentUrl(
    '/api/v1/attachments/12345678',
    'http://192.0.2.10:8989'));
});

test('only passive document types render inline', () => {
  for (const type of [
    'image/png', 'application/pdf', 'text/plain; charset=utf-8',
    'text/markdown', 'application/json',
  ]) assert.equal(attachmentFiles.isInlinePreview(type), true, type);

  for (const type of [
    'text/html', 'image/svg+xml', 'application/javascript',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ]) assert.equal(attachmentFiles.isInlinePreview(type), false, type);
});

test('download filenames cannot escape their selected destination', () => {
  assert.equal(attachmentFiles.safeFilename('CON.txt', 'safe.txt'), 'safe.txt');
  assert.equal(attachmentFiles.safeFilename('../../report?.docx', 'safe.txt'), 'report_.docx');
  assert.equal(attachmentFiles.safeFilename('result. ', 'safe.txt'), 'result');
});

test('filename truncation keeps the final extension and the existing length limit', () => {
  for (const extension of ['.docx', '.md', '.gz', '.PNG']) {
    const result = attachmentFiles.safeFilename('a'.repeat(180) + extension, 'safe.txt');
    assert.equal(result.length, 180);
    assert.ok(result.endsWith(extension));
  }
  const boundary = 'a'.repeat(175) + '.docx';
  assert.equal(attachmentFiles.safeFilename(boundary, 'safe.txt'), boundary);
  assert.equal(attachmentFiles.safeFilename('a'.repeat(200), 'safe.txt'), 'a'.repeat(180));
  assert.equal(attachmentFiles.safeFilename('a.' + 'b'.repeat(200), 'safe.txt').length, 180);
});

test('renderer exposes narrow native preview and explicit download commands', () => {
  const main = read('main.js');
  const preload = read('preload.js');
  const detail = read('components', 'requirements', 'requirements-detail.js');
  assert.match(main, /attachment-files/);
  assert.match(main, /_attachmentFiles\.install/);
  assert.match(preload, /attachment-preview/);
  assert.match(preload, /attachment-download/);
  assert.match(detail, /ConversationAttachments\.openTaskAttachment/);
  assert.match(detail, /soduWorkAPI\.downloadAttachment/);
  assert.match(detail, /data-rq-download/);
  assert.match(detail, /deleteAttachment\(id\)/);
  assert.doesNotMatch(detail, /openExternal\(file\.url\)/);
});

test('task success and pinned conversation regressions stay closed', () => {
  const success = read('components', 'panels', 'panels-compose-submit.js');
  const shell = read('components', 'workspace', 'workspace-shell.css');
  assert.match(success, /ctx\.id\s*\?\s*'<button class="cp-primary" id="cpOpen">/);
  assert.match(shell, /\.ws-pinned\{flex:0 0 auto/);
  assert.match(shell, /\.ws-pinned \.ws-list-body\{[^}]*min-height:32px/);
  assert.doesNotMatch(shell, /\.ws-pinned \.ws-list-body\{[^}]*max-height/); // uses the shared upper scrollport
});

test('participant tracking copies never masquerade as assigned todos', () => {
  const store = read('core', 'store.js');
  assert.match(store, /incomingActionable=incoming&&!incoming\.readOnly/);
  assert.match(store, /incomingRoles\.includes\('executor'\)\|\|incomingRoles\.includes\('assignee'\)/);
  const R = require('../core/requirements.js');
  const shared = {id: 'shared', readOnly: true, canViewExecution: false,
    status: 'todo', myRoles: ['requester'], creatorName: 'Requester', executionDeviceName: 'Device'};
  assert.equal(R.inScope(shared, 'all'), true);
  assert.equal(R.inScope(shared, 'created'), true);
  assert.equal(R.inScope(shared, 'actionable'), false);
  assert.deepEqual(R.owner(shared), {kind: 'unassigned', name: '待安排'});
  assert.deepEqual(R.owner({...shared, assigneeName: 'Colleague'}), {kind: 'person', name: 'Colleague'});
  assert.deepEqual(R.owner({...shared, ai: {name: 'Pi'}}), {kind: 'agent', name: 'Pi'});
});
