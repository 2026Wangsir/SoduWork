'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const {submitted} = require('../main/pi-session/dispatch-instructions.cjs');
const {prepare} = require('../main/pi-session/task-input');
function renderer(api = {}) {
  const context = {window:null, SoduWorkAPI:api}; context.window = context;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,
    '../components/requirements/requirement-dispatch-instructions.js'), 'utf8'), context);
  return context.RequirementDispatchInstructions;
}
function event(turnId, note, at) {
  return {kind:'execution.instructions', at, detail:{schemaVersion:1, conversationId:'chat', turnId,
    note, submissionMode:'manual', effectiveSubmissionMode:'manual', executor:'native'}};
}
test('dispatch fields are explicit and never copied from full prompts or follow-ups', () => {
  assert.equal(submitted({instruction:'Private generated prompt'}), null);
  const metadata = {note:'Exact\n' + '文'.repeat(1800), submissionMode:'manual'};
  assert.deepEqual(submitted({dispatchInstructions:{...metadata, model:'Omit', prompt:'Omit'}}), metadata);
  assert.equal(submitted({dispatchInstructions:metadata, followUp:true}), null);
  assert.equal(submitted({dispatchInstructions:metadata, reworkSession:true}), null);
  for (const value of [{}, [], {note:42, submissionMode:'default'}, {note:'x'.repeat(2001),submissionMode:'default'},
    {note:'x',submissionMode:'invalid'}]) assert.throws(() => submitted({dispatchInstructions:value}), /派发说明格式无效/);
});
test('the real preparation request retains only explicit fields and retry keeps the original note', async t => {
  const calls = [], note = 'Supplement only\n' + '文'.repeat(1700);
  t.mock.method(global, 'fetch', async (url, options) => {
    if (url.endsWith('/tasks/task')) return Response.json({id:'task', title:'Public requirement', note:'Full description'});
    if (url.endsWith('/attachments')) return Response.json([]);
    calls.push(JSON.parse(options.body));
    return Response.json({turn:{state:'queued'},task:{id:'task'}});
  });
  const input = await prepare({hub:'http://fixture'}, 'task','chat','turn','Entire execution prompt',
    {submissionMode:'manual',dispatchInstructions:{note,submissionMode:'manual',model:'Omit'}});
  assert.deepEqual(calls[0].dispatchInstructions, {note,submissionMode:'manual'});
  await input.beforeTurn();
  assert.equal(calls[1].dispatchInstructions, undefined);
  await input.beforeRetry();
  assert.deepEqual(calls[2].dispatchInstructions, {note,submissionMode:'manual'});
});
test('history keeps separate turns, escapes notes and explicitly marks missing legacy fields', () => {
  const api = renderer();
  const rows = [event('first','<img src=x onerror=alert(1)>\nOriginal',1000),
    {kind:'conversation.turn',at:1001,detail:{conversationId:'chat',turnId:'first',state:'queued'}},
    {kind:'conversation.turn',at:500,detail:{conversationId:'chat',turnId:'legacy',state:'queued'}},
    event('second','Second note',2000)];
  assert.equal(api.records(rows).length, 3);
  const html = api.html(rows);
  assert.ok(html.indexOf('Second note') < html.indexOf('Original'));
  assert.match(html, /&lt;img/); assert.doesNotMatch(html, /<img/);
  assert.match(html,/未记录/); assert.match(html,/完成后手动提交验收/);
  assert.doesNotMatch(api.shell(), /<details[^>]*\bopen\b/);
});
test('stale or permission-revoked history responses cannot populate a new detail', async () => {
  let resolve, allowed = true, calls = 0, listener;
  const api = renderer({getTaskEvents:() => {calls++;return new Promise(done => {resolve=done;});}});
  const node = {isConnected:true,innerHTML:'',textContent:''};
  const disclosure = {open:false,querySelector:()=>node,addEventListener:(_,fn)=>{listener=fn;}};
  const root = {querySelector:()=>disclosure};
  api.mount(root,{id:'private',canViewExecution:false},()=>true,true);
  assert.equal(calls,0);
  api.mount(root,{id:'private',canViewExecution:true},()=>allowed,true);
  assert.equal(calls,1); allowed=false; resolve([event('first','Must stay private',1000)]);
  await new Promise(done=>setImmediate(done));
  assert.equal(node.innerHTML,'');
  allowed=true; node.isConnected=false; await listener(); assert.equal(calls,1);
});
test('unrelated old Runner dispatches remain visible beside new queued dispatches', () => {
  const api = renderer(), recorded = event('new', 'New note', 2000);
  recorded.detail.executor = 'dispatch';
  const old = {id:'old',kind:'ai.dispatched',at:1000,detail:{ref:'old-run',carried:{brief:'Truncated legacy note'}}};
  const correlated = {kind:'ai.dispatched',at:2001,detail:{ref:'new-run',conversationTurn:{conversationId:'chat',turnId:'new'}}};
  assert.equal(api.records([old,recorded,correlated]).length,2);
  const html = api.html([old,recorded,correlated]);
  assert.match(html,/历史安排执行/); assert.match(html,/未记录/);
  assert.doesNotMatch(html,/Truncated legacy note/);
  const node = {kind:'ai.dispatched',at:3000,detail:{ref:'workflow-node',plugin:{runId:'flow',nodeId:'node'}}};
  assert.equal(api.records([old,recorded,correlated,node]).length,2);
  assert.equal(api.records([{...node,detail:{ref:'incomplete-proof',plugin:{runId:'flow'}}}]).length,1);
});
