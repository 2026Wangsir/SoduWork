'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const stream=require('../main/pi-session/event-stream');
const events=require('../main/pi-session/session-events');
const {createUsageReporter}=require('../main/agent-runtime/usage-reporter');
function fixture() {
  const acc=stream.create(),ctx={acc,prep:{provider:'gateway-runtime',model:{id:'model-a',quotaProvider:'provider-a',key:'private-config-key'}},
    turnQueue:{active:()=>null},run:{toolIds:new Set()},_emit(){},shared:{
      messageTime:require('../main/conversation/message-time'),toolGuard:{},
      runControl:{observeEvent(){}},mediaArtifacts:{fromToolEvent:()=>null}}};
  return {ctx,acc,onEvent:events.create(ctx).onPiEvent};
}
const message=(model='model-a',provider='gateway-runtime')=>({role:'assistant',model,provider,content:[],stopReason:'stop',usage:{input:10,output:2}});

test('trusted Pi provider attribution survives model changes, archival replay and the usage HTTP payload',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'soduwork-provider-usage-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const f=fixture(),first=message();f.onEvent({type:'message_start',message:first});
  f.ctx.prep.model={id:'model-b',quotaProvider:'provider-b',key:'another-private-key'};
  f.onEvent({type:'message_end',message:first});
  const second=message('model-b');f.onEvent({type:'message_start',message:second});f.onEvent({type:'message_end',message:second});
  assert.deepEqual(f.acc.snapshot().usageReceipts.map(r=>[r.model,r.provider]),[['model-a','provider-a'],['model-b','provider-b']]);
  assert.equal(first.provider,'gateway-runtime','SDK routing remains unchanged');
  const saved=JSON.parse(JSON.stringify([first,second]));
  const restored=stream.create();require('../main/pi-session/history-seed').seed(restored,{state:{messages:saved}},{nativeAgentId:'pi'});
  assert.deepEqual(restored.snapshot().usageReceipts.map(r=>r.provider),['provider-a','provider-b']);
  const sent=[],identity={hub:'http://fixture',clientId:'fixture',session:'fixture-session'};
  const reporter=createUsageReporter({app:{getPath:()=>root},identityOf:async()=>identity,
    fetchImpl:async(url,options)=>{sent.push({url,payload:JSON.parse(options.body)});return {ok:true,text:async()=>' {"ok":true}'};}});
  reporter.observe({sessionId:'provider-attribution',model:'model-b',usageIdentity:identity},restored.snapshot());await reporter.flush();
  assert.deepEqual(sent.map(r=>[r.payload.model,r.payload.provider,r.payload.usage.total]),[['model-a','provider-a',12],['model-b','provider-b',24]]);
  assert.ok(sent.every(r=>r.url.endsWith('/usage/events')));
  assert.doesNotMatch(JSON.stringify(sent),/private-config-key|another-private-key/);
});

test('missing or mismatched provider metadata remains unknown and never borrows the newest handle provider',async t=>{
  const f=fixture();delete f.ctx.prep.model.quotaProvider;
  const legacy=message();f.onEvent({type:'message_start',message:legacy});f.onEvent({type:'message_end',message:legacy});
  assert.equal(legacy.usageProvider,undefined);
  f.ctx.prep.model={id:'model-a',quotaProvider:'provider-new'};
  const mismatch=message('model-other');f.onEvent({type:'message_start',message:mismatch});f.onEvent({type:'message_end',message:mismatch});
  assert.equal(mismatch.usageProvider,undefined);
  const restored=stream.create();require('../main/pi-session/history-seed').seed(restored,{state:{messages:[{...legacy,provider:''}]}},{nativeAgentId:'pi'});
  assert.equal(restored.snapshot().usageReceipts[0].provider,'');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'soduwork-unknown-provider-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const sent=[],identity={hub:'http://fixture',clientId:'fixture',session:'fixture-session'};
  const reporter=createUsageReporter({app:{getPath:()=>root},identityOf:async()=>identity,
    fetchImpl:async(_url,options)=>{sent.push(JSON.parse(options.body));return {ok:true,text:async()=>'{"ok":true}'};}});
  reporter.observe({sessionId:'legacy',model:'model-a',usageProvider:'newest-provider',usageIdentity:identity},restored.snapshot());await reporter.flush();
  assert.equal(sent[0].provider,'');
});

test('local calls remain device-only across pending model changes, archival replay and managed billing', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-local-usage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const f = fixture(), managed = message();
  f.onEvent({ type: 'message_start', message: managed });
  f.onEvent({ type: 'message_end', message: managed });
  f.ctx.prep.model = { id: 'local-private-model', localOnly: true, modelRef: 'local:device/private-model' };
  const local = message('local-private-model');
  f.onEvent({ type: 'message_start', message: local });
  f.ctx.prep.model = { id: 'model-b', quotaProvider: 'provider-b' };
  f.onEvent({ type: 'message_end', message: local });
  assert.equal(local.usageLocalOnly, true, 'ownership belongs to the executing call');
  const next = message('model-b');
  f.onEvent({ type: 'message_start', message: next });
  f.onEvent({ type: 'message_end', message: next });
  const restored = stream.create();
  require('../main/pi-session/history-seed').seed(restored,
    { state: { messages: JSON.parse(JSON.stringify([managed, local, next])) } }, { nativeAgentId: 'pi', maxMessages: 1 });
  for (const snapshot of [f.acc.snapshot(), restored.snapshot()]) {
    assert.deepEqual(snapshot.usageReceipts.map(row => row.localOnly === true), [false, true, false]);
    const sent = [], identity = { hub: 'http://fixture', clientId: 'fixture', session: 'fixture-session' };
    const appRoot = fs.mkdtempSync(path.join(root, 'case-'));
    const reporter = createUsageReporter({ app: { getPath: () => appRoot }, identityOf: async () => identity,
      fetchImpl: async (_url, options) => {
        sent.push(JSON.parse(options.body)); return { ok: true, text: async () => '{"ok":true}' };
      } });
    reporter.observe({ sessionId: 'mixed-models', model: { id: 'local-private-model', localOnly: true }, usageIdentity: identity }, snapshot);
    await reporter.flush();
    assert.deepEqual(sent.map(row => [row.model, row.usage.total]), [['model-a', 12], ['model-b', 24]]);
    assert.doesNotMatch(JSON.stringify(sent), /local-private-model|private-model/);
  }
});

test('local usage without receipts is not uploaded by adapter fallback', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-local-usage-fallback-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sent = [], identity = { hub: 'http://fixture', clientId: 'fixture', session: 'fixture-session' };
  const reporter = createUsageReporter({ app: { getPath: () => root }, identityOf: async () => identity,
    fetchImpl: async (_url, options) => { sent.push(options.body); return { ok: true, text: async () => '{"ok":true}' }; } });
  const publicModel = require('../main/conversation/model-selection').publicModel({ id: 'private-model', localOnly: true, key: 'secret' });
  assert.equal(publicModel.localOnly, true); assert.equal(publicModel.key, undefined);
  for (const model of [publicModel, 'local:device/private-model']) {
    reporter.observe({ sessionId: 'local-only', model, usageIdentity: identity }, { usage: { input: 100, output: 20 } });
  }
  await reporter.flush();
  assert.deepEqual(sent, []);
  reporter.observe({ sessionId: 'managed-history', model: publicModel, usageIdentity: identity },
    { usageReceipts: [{ provider: 'managed-provider', usage: { input: 10 } }] });
  await reporter.flush();
  assert.equal(JSON.parse(sent[0]).model, '', 'unknown managed history cannot borrow the current local model name');
});

test('legacy local archives cannot become Hub usage after their local configuration is removed', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-legacy-local-usage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const legacyLocal = message('same-runtime-id', 'soduwork');
  const legacyManaged = { ...message('same-runtime-id', 'soduwork'), usageProvider: 'trusted-managed-provider' };
  const newManaged = { ...message('managed-without-catalog-provider', 'soduwork'), usageLocalOnly: false };
  const restored = stream.create();
  require('../main/pi-session/history-seed').seed(restored,
    { state: { messages: [legacyLocal, legacyManaged, newManaged] } }, { nativeAgentId: 'pi' });
  const receipts = restored.snapshot().usageReceipts;
  assert.deepEqual(receipts.map(row => row.reportable === false), [true, false, false]);
  assert.equal(receipts[0].localOnly, undefined, 'unknown historical ownership is not labeled as proven local');
  const sent = [], identity = { hub: 'http://fixture', clientId: 'fixture', session: 'fixture-session' };
  const reporter = createUsageReporter({ app: { getPath: () => root }, identityOf: async () => identity,
    fetchImpl: async (_url, options) => { sent.push(JSON.parse(options.body)); return { ok: true, text: async () => '{"ok":true}' }; } });
  reporter.observe({ sessionId: 'legacy-local', model: 'managed', usageIdentity: identity }, restored.snapshot());
  await reporter.flush();
  assert.deepEqual(sent.map(row => [row.model, row.usage.total]), [['same-runtime-id', 12], ['managed-without-catalog-provider', 24]]);
  assert.equal(sent[0].provider, 'trusted-managed-provider');
});
