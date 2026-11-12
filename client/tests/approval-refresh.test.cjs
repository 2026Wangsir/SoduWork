'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('./renderer-source.cjs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../components/panels/task-approval-inbox.js'), 'utf8');

function runtime(listApprovals) {
  const handlers = {}, events = {}, emitted = [], badge = {}, counts = [], navigations = [], timers = new Map();
  let timerId = 0;
  let shown = false, focused = false;
  const list = {innerHTML: ''};
  const anchor = {getBoundingClientRect: () => ({right: 900, bottom: 120}), setAttribute() {}, focus() {focused = true;}};
  const panel = {style: {}, setAttribute() {}, innerHTML: '',
    querySelector: () => list, addEventListener: (name, fn) => {handlers[name] = fn;},
    matches: () => shown, showPopover() {shown = true;}, hidePopover() {shown = false;}};
  const ctx = {innerWidth: 1440, innerHeight: 900, console,
    document: {visibilityState: 'visible', addEventListener(name, fn) {events[name] = fn;},
      getElementById: () => anchor, querySelector: () => badge, createElement: () => panel, body: {appendChild() {}}},
    SoduWorkAPI: {listApprovals}, WorkspaceShell: {setApprovalCount: n => counts.push(n)},
    __deskPanel: 'workspace',
    RequirementsDetail: {open: async (...args) => {navigations.push(args); return true;}},
    CustomEvent: class {constructor(type) {this.type = type;}},
    setTimeout(fn) {timers.set(++timerId, fn); return timerId;}, clearTimeout(id) {timers.delete(id);},
    addEventListener(name, fn) {events[name] = fn;},
    dispatchEvent(event) {emitted.push(event.type); events[event.type]?.(event);}};
  ctx.window = ctx;
  vm.runInNewContext(source, ctx);
  const tick = async () => {
    const pending = [...timers.values()]; timers.clear();
    pending.forEach(fn => fn());
    for (let n = 0; n < 8; n++) await Promise.resolve();
  };
  return {ctx, list, badge, counts, navigations, handlers, events, emitted, anchor, timers, tick,
    shown: () => shown, focused: () => focused};
}
const response = title => ({pendingCount: 1, items: [{id: 'approval-1', taskId: 'task-1', action: 'review', task: {title}}]});

test('current approval inbox rows open the requirement details with the acceptance card', async () => {
  const x = runtime(async () => response('验收'));
  await x.ctx.TaskApprovalInbox.open(x.anchor);
  assert.match(x.list.innerHTML, /data-confirmation-task="task-1"/);
  assert.match(x.list.innerHTML, /data-confirmation-id="approval-1"/);
  const row = {disabled: false, dataset: {confirmationTask: 'task-1', confirmationId: 'approval-1'}};
  await x.handlers.click({target: {closest: selector => selector === '[data-confirmation-task]' ? row : null}});
  assert.equal(x.navigations.length, 1);
  assert.equal(x.navigations[0][0], 'task-1');
  assert.equal(x.shown(), false);
});

test('empty inbox is a real empty state and close returns focus to the entry', async () => {
  const x = runtime(async () => ({pendingCount: 0, items: []}));
  await x.ctx.TaskApprovalInbox.open(x.anchor);
  assert.match(x.list.innerHTML, /暂无需要你确认/);
  assert.equal(x.badge.textContent, '0');
  x.ctx.TaskApprovalInbox.close();
  assert.equal(x.shown(), false);
  assert.equal(x.focused(), true);
});

test('out-of-order refresh cannot replace newer pending approvals', async () => {
  let calls = 0, first;
  const x = runtime(() => ++calls === 1 ? Promise.resolve(response('initial')) :
    calls === 2 ? new Promise(resolve => {first = resolve;}) : Promise.resolve(response('newest')));
  await x.ctx.TaskApprovalInbox.open(x.anchor);
  const older = x.ctx.TaskApprovalInbox.refresh();
  await x.ctx.TaskApprovalInbox.refresh();
  first(response('stale'));
  await older;
  assert.match(x.list.innerHTML, /newest/);
  assert.doesNotMatch(x.list.innerHTML, /stale/);
});

test('network errors are visible and a later open recovers without losing approvals', async () => {
  let fail = true;
  const x = runtime(async () => {if (fail) throw Error('offline'); return response('recovered');});
  await x.ctx.TaskApprovalInbox.open(x.anchor);
  assert.match(x.list.innerHTML, /role="alert"/);
  fail = false;
  await x.ctx.TaskApprovalInbox.open(x.anchor);
  assert.match(x.list.innerHTML, /recovered/);
  assert.doesNotMatch(x.list.innerHTML, /role="alert"/);
});

test('approval inbox escapes task content and never exposes decision buttons', async () => {
  const x = runtime(async () => response('<img src=x onerror=alert(1)>'));
  await x.ctx.TaskApprovalInbox.open(x.anchor);
  assert.match(x.list.innerHTML, /&lt;img/);
  assert.doesNotMatch(x.list.innerHTML, /<img|data-tfd-approval-action/);
});

test('failed navigation restores the row so the user can retry', async () => {
  const x = runtime(async () => response('retry'));
  /* If routing from a nonworkspace window fails, keep the overlay open and restore the row's retry action. */
  x.ctx.__deskPanel = 'main'; x.ctx.RequirementsDetail = undefined;
  x.ctx.soduWorkAPI = {openDeskWindow: async () => false};
  await x.ctx.TaskApprovalInbox.open(x.anchor);
  const row = {disabled: false, dataset: {confirmationTask: 'task-1', confirmationId: 'approval-1'}};
  await x.handlers.click({target: {closest: selector => selector === '[data-confirmation-task]' ? row : null}});
  assert.equal(row.disabled, false);
  assert.equal(x.shown(), true);
});

test('complete lightweight references retain approvals beyond the detailed first page', async () => {
  const refs = Array.from({length: 105}, (_, index) => ({id: 'approval-' + index,
    taskId: 'task-' + index, action: 'review', artifactVersionId: 'artifact-' + index, privateEvidence: 'must not be retained'}));
  const x = runtime(async () => ({pendingCount: 105, pendingTasks: refs, items: refs.slice(0, 60)}));
  await x.ctx.TaskApprovalInbox.refresh();
  const result = x.ctx.TaskApprovalInbox.snapshot();
  assert.equal(result.length, 105);
  assert.deepEqual(JSON.parse(JSON.stringify(result.at(-1))), {id: 'approval-104', taskId: 'task-104', action: 'review', artifactVersionId: 'artifact-104'});
  result[0].taskId = 'changed'; result.pop();
  assert.equal(x.ctx.TaskApprovalInbox.snapshot().length, 105);
  assert.equal(x.ctx.TaskApprovalInbox.snapshot()[0].taskId, 'task-0');
  assert.equal(x.badge.textContent, '105');
  assert.deepEqual(x.emitted, ['soduwork-approvals-changed']);
});

test('older server items remain supported but an explicit empty complete list wins', async () => {
  let complete = false;
  const x = runtime(async () => ({...response('legacy'), ...(complete ? {pendingTasks: [], pendingCount: 0} : {})}));
  await x.ctx.TaskApprovalInbox.refresh();
  assert.equal(x.ctx.TaskApprovalInbox.snapshot()[0].taskId, 'task-1');
  complete = true;
  await x.ctx.TaskApprovalInbox.refresh();
  assert.equal(x.ctx.TaskApprovalInbox.snapshot().length, 0);
  assert.equal(x.badge.textContent, '0');
});

test('failed refresh clears stale approvals and badges even when the popover is closed', async () => {
  let fail = false;
  const x = runtime(async () => {if (fail) throw Error('offline'); return response('private');});
  await x.ctx.TaskApprovalInbox.refresh();
  fail = true;
  await assert.rejects(x.ctx.TaskApprovalInbox.refresh(), /offline/);
  assert.equal(x.ctx.TaskApprovalInbox.snapshot().length, 0);
  assert.equal(x.badge.textContent, '0');
  assert.equal(x.counts.at(-1), 0);
  assert.deepEqual(x.emitted, ['soduwork-approvals-changed', 'soduwork-approvals-changed']);
});

test('identity change immediately clears UI and ignores a late successful response', async () => {
  let next, calls = 0;
  const x = runtime(() => ++calls === 1 ? Promise.resolve(response('old identity')) : new Promise(resolve => {next = resolve;}));
  await x.ctx.TaskApprovalInbox.open(x.anchor);
  const pending = x.ctx.TaskApprovalInbox.refresh();
  x.events['soduwork-data-scope-changed']();
  assert.equal(x.shown(), false);
  assert.equal(x.list.innerHTML, '');
  assert.equal(x.badge.textContent, '0');
  assert.equal(x.ctx.TaskApprovalInbox.snapshot().length, 0);
  next(response('late private data')); await pending;
  assert.equal(x.list.innerHTML, '');
  assert.equal(x.badge.textContent, '0');
  assert.equal(x.ctx.TaskApprovalInbox.snapshot().length, 0);
});

test('an old failed open cannot overwrite a new identity response or clear its snapshot', async () => {
  let rejectOld, calls = 0;
  const x = runtime(() => ++calls === 1 ? new Promise((_, reject) => {rejectOld = reject;}) : Promise.resolve(response('new identity')));
  const old = x.ctx.TaskApprovalInbox.open(x.anchor);
  x.events['soduwork-data-scope-changed']();
  await x.ctx.TaskApprovalInbox.open(x.anchor);
  rejectOld(Error('old identity offline')); await old;
  assert.match(x.list.innerHTML, /new identity/);
  assert.doesNotMatch(x.list.innerHTML, /role="alert"/);
  assert.equal(x.ctx.TaskApprovalInbox.snapshot()[0].taskId, 'task-1');
  assert.equal(x.badge.textContent, '1');
});

test('snapshot strips private content, duplicate requests, resolved and malformed records', async () => {
  const x = runtime(async () => ({items: [
    {id: 'a', taskId: 'one', action: 'review', task: {note: 'secret'}},
    {id: 'a', taskId: 'one', action: 'review'}, {id: 'b'}, null,
    {id: 'c', taskId: 'three', status: 'approved'},
    {id: 'd', taskId: 'four', myDecision: {decision: 'approve'}},
  ]}));
  await x.ctx.TaskApprovalInbox.refresh();
  assert.deepEqual(JSON.parse(JSON.stringify(x.ctx.TaskApprovalInbox.snapshot())), [{id: 'a', taskId: 'one', action: 'review'}]);
});

test('task updates and completed decisions coalesce into one fresh approval request', async () => {
  let calls = 0, pending = true;
  const x = runtime(async () => {calls++; return pending ? response('new approval') : {items: [], pendingCount: 0};});
  for (let n = 0; n < 20; n++) x.events['soduwork-work-task-change']({detail: {type: 'task.updated'}});
  x.events['soduwork-store-hydrated']();
  assert.equal(x.timers.size, 1);
  await x.tick();
  assert.equal(calls, 1);
  assert.equal(x.ctx.TaskApprovalInbox.snapshot().length, 1);
  pending = false;
  x.events['soduwork-approvals-invalidated']();
  await x.tick();
  assert.equal(calls, 2);
  assert.equal(x.ctx.TaskApprovalInbox.snapshot().length, 0);
  assert.equal(x.badge.textContent, '0');
});

test('events during a request queue only one follow-up and never overlap discovery requests', async () => {
  let calls = 0, resolveFirst;
  const x = runtime(() => ++calls === 1 ? new Promise(resolve => {resolveFirst = resolve;}) : Promise.resolve(response('updated')));
  x.events['soduwork-store-hydrated'](); await x.tick();
  assert.equal(calls, 1);
  for (let n = 0; n < 20; n++) x.events['soduwork-approvals-invalidated']();
  assert.equal(x.timers.size, 0);
  resolveFirst(response('initial'));
  await x.tick();
  assert.equal(x.timers.size, 1);
  await x.tick();
  assert.equal(calls, 2);
  assert.equal(x.timers.size, 0);
});

test('hidden windows defer refreshes until visible and do not poll execution tokens', async () => {
  let calls = 0;
  const x = runtime(async () => {calls++; return response('visible');});
  assert.equal(x.events['soduwork-work-execution'], undefined, 'token deltas must not query approvals');
  x.events['soduwork-store-hydrated']();
  x.ctx.document.visibilityState = 'hidden'; x.events.visibilitychange();
  for (let n = 0; n < 20; n++) x.events['soduwork-work-task-change']({detail: {type: 'task.updated'}});
  await x.tick();
  assert.equal(calls, 0);
  x.ctx.document.visibilityState = 'visible'; x.events.visibilitychange(); x.events.focus();
  await x.tick();
  assert.equal(calls, 1);
  await x.tick();
  assert.equal(calls, 1, 'no idle polling is scheduled');
});

test('offline or identity change cancels queued requests and clears discovery immediately', async () => {
  let calls = 0;
  const x = runtime(async () => {calls++; return response('private');});
  await x.ctx.TaskApprovalInbox.refresh();
  x.events['soduwork-approvals-invalidated']();
  x.events['soduwork-work-task-change']({detail: {type: 'tasks.offline'}});
  assert.equal(x.ctx.TaskApprovalInbox.snapshot().length, 0);
  await x.tick(); assert.equal(calls, 1);
  x.events['soduwork-store-hydrated'](); x.events['soduwork-data-scope-changed']();
  await x.tick(); assert.equal(calls, 1);
});

function apiRuntime(fetchImpl) {
  const emitted = [], values = new Map();
  const window = {__SODUWORK_TEST_HUB_CONFIG__: {allowSwitch: true}, dispatchEvent(event) {emitted.push(event.type);},
    CustomEvent: class {constructor(type) {this.type = type;}}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../api.js'), 'utf8'), {
    window, User: {id: 'approval-fixture'}, navigator: {platform: 'test'},
    localStorage: {getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value))},
    fetch: fetchImpl, AbortController, FormData, URL, URLSearchParams,
    setTimeout: () => 0, clearTimeout() {}, console: {log() {}, error() {}},
  });
  return {api: window.SoduWorkAPI, emitted};
}

test('decision and revoke APIs invalidate discovery only after accepted mutations', async () => {
  let status = 200, data = {ok: true};
  const x = apiRuntime(async () => ({ok: status === 200, status, text: async () => JSON.stringify(data)}));
  await x.api.decideApproval('approval-1', 'approve', 'Checked');
  await x.api.revokeApproval('approval-1', 'Recheck');
  assert.deepEqual(x.emitted, ['soduwork-approvals-invalidated', 'soduwork-approvals-invalidated']);
  data = {ok: false};
  await x.api.decideApproval('approval-1', 'approve', 'Rejected by service');
  status = 403; data = {detail: 'Not assigned'};
  await assert.rejects(x.api.revokeApproval('approval-1', 'Denied'), /Not assigned/);
  assert.equal(x.emitted.length, 2);
});

test('an old environment mutation response cannot invalidate the new environment', async () => {
  let finish;
  const x = apiRuntime(() => new Promise(resolve => {finish = resolve;}));
  const request = x.api.decideApproval('approval-1', 'approve', 'Checked');
  x.api.setHubEnvironment('development', 'http://127.0.0.1:34567');
  finish({ok: true, status: 200, text: async () => '{"ok":true}'});
  await assert.rejects(request, error => error.code === 'STALE_TASK_SCOPE');
  assert.equal(x.emitted.includes('soduwork-approvals-invalidated'), false);
});
