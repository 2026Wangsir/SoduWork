'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const fs=require('node:fs'), os=require('node:os'), path=require('node:path'), crypto=require('node:crypto');
const {identity}=require('./helpers/platform-session-fixture.cjs');
async function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'soduwork-cached-cards-')), app={getPath:()=>root};
  let current=identity(), accountReads=0;
  const store=require('../main/conversation/replica-store.cjs').createWorker(path.join(root,'replicas.sqlite'));
  const session={findBySessionId:()=>null,archivedConversation:async()=>null,history:async()=>({ok:true,chats:[]}),archivedHistory:async()=>({ok:true,chats:[]})};
  const history=require('../main/conversation/shared-history.cjs').create({app,session,store,identityOf:()=>current});
  session.indexedHistoryRow=id=>history.indexedRow(id);
  const cards=require('../main/conversation/work-conversation-cards').create({app,session,identityOf:async()=>current,
    accountHistory:{row:async()=>{accountReads++;return null;}},newCwd:()=>{throw Error('No workspace/runtime is allowed for a read-only copy');}});
  async function copy(id,{imported=false,extra={}}={}){
    const creator={account:'one',hub:current.hub};
    if(imported){
      const body=Buffer.from(JSON.stringify([{role:'user',text:'old private prompt'},{role:'assistant',text:'old private answer'}]));
      const pointer={sha256:crypto.createHash('sha256').update(body).digest('hex'),size:body.length};
      assert.equal((await store.importChunk(id,pointer,0,body.toString('base64'))).ok,true);
      assert.equal((await store.sealImport(id,pointer,{title:'Imported',adapterId:'pi',creator,archived:true,importedHistory:true})).ok,true);
    }else{
      const [row]=await history.register([{id,title:'Cached',adapterId:'pi',at:100,cached:true,creator,...extra}]);
      assert.equal((await store.cache(id,[{role:'user',text:'private'}],{start:0,complete:true,expectedRevision:row.replicaRevision})).ok,true);
    }
  }
  t.after(async()=>{await history.close();fs.rmSync(root,{recursive:true,force:true});});
  return{app,root,store,history,session,cards,copy,get current(){return current;},set current(value){current=value;},accountReads:()=>accountReads};
}
const empty=id=>({ok:true,sessionId:id,cards:[],workOnly:false,draftSelection:null,draftSelectionRevision:0});
test('authenticated imported and ordinary cached copies prepare empty work cards without acquiring write or execution rights',async t=>{
  const f=await fixture(t);
  for(const imported of [true,false]){
    const id=imported?'imported-copy':'ordinary-copy';await f.copy(id,{imported});
    assert.deepEqual(await f.cards.read(id),empty(id));
    assert.equal((await f.cards.save(id,{id:'must-not-save',actionId:'work.requirement.create',prompt:'do not execute',state:{},files:[]})).ok,false);
    assert.equal((await f.cards.saveDraftSelection(id,{selection:{adapterId:'pi'},revision:0})).ok,false);
    for(const directory of ['work-conversation-cards','session-memory-bindings','requirement-session-context','conversation-runtime-segments'])
      assert.equal(fs.existsSync(path.join(f.root,directory)),false,'No writable sidecar should be created');
  }
  assert.equal(f.accountReads(),0,'Native cached identities cannot go through a Hub account-alias lookup');
});
test('cached card preparation refuses foreign account, different Hub, signed-out, unknown and deleted copies',async t=>{
  const f=await fixture(t);await f.copy('imported-copy',{imported:true});const original=f.current;
  for(const account of [identity('two'),{...original,hub:'https://other.invalid'},null]){
    f.current=account;assert.equal((await f.cards.read('imported-copy')).ok,false);
  }
  f.current=original;assert.equal((await f.cards.read('absent')).ok,false);
  await f.store.lifecycle('imported-copy','delete');assert.equal((await f.cards.read('imported-copy')).ok,false);
});
test('a cached lookup resolved before a live account/Hub switch cannot return prepared cards',async t=>{
  for(const kind of ['account','hub']){
    const f=await fixture(t);await f.copy('copy');
    const original=f.session.indexedHistoryRow;
    f.session.indexedHistoryRow=async id=>{const row=await original(id);f.current=kind==='account'?identity('two'):{...f.current,hub:'https://changed.invalid'};return row;};
    const result=await f.cards.read('copy');assert.equal(result.ok,false);assert.match(result.reason,/切换/);
  }
});
test('a cached source locator is not treated as the local copy identity',async t=>{
  const f=await fixture(t);await f.copy('copy');
  f.session.indexedHistoryRow=()=>f.history.indexedRow('copy');
  assert.equal((await f.cards.read('untrusted-source-locator')).ok,false);
});
