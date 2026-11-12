'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../components/panels/panels-desk.js'),'utf8');
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(){
  const nodes=new Map(),handlers=new Map(),reads=[],opened=[],localReads=[],refreshes=[],followups=[],toasts=[];
  let scope='one',failRead=false;
  class Node {
    constructor(){this.innerHTML='';this.hidden=false;this.classes=new Set();this.classList={add:x=>this.classes.add(x),remove:x=>this.classes.delete(x),contains:x=>this.classes.has(x),toggle(){}};}
    addEventListener(type,fn){handlers.set(this.id+':'+type,fn);}
    querySelector(){return {addEventListener(){}};}
    querySelectorAll(){return [];}
  }
  const rows={received:[],sent:[]};
  const context={Date,console,setTimeout,clearTimeout,addEventListener(){},tasks:[],notices:[],
    esc:value=>String(value??''),_nkIcon:()=>'',
    document:{addEventListener(){},querySelectorAll:()=>[],getElementById:id=>nodes.get(id),createElement:()=>new Node(),body:{appendChild(node){nodes.set(node.id,node);for(const id of ['npBody','npSub','npClear','npClose']){const child=new Node();child.id=id;nodes.set(id,child);}}}},
    SoduWorkAPI:{taskStorageKey:()=>scope,mateMessages:async()=>({ok:true,items:[]}),markMateMessageRead:async()=>{if(failRead)throw Error('网络已断开');}},
    MateNoticeSync:{rows:folder=>rows[folder],refresh:async folder=>{refreshes.push(folder);return {ok:true};},markRead:async id=>{reads.push(id);if(failRead)throw Error('网络已断开');rows.received.find(row=>row.serverMessageId===id).read=true;}},
    WorkspaceHost:{open:(_view,payload)=>{followups.push(payload);return true;}},
    markNoticeRead:id=>localReads.push(id),openDetailEntry:id=>opened.push(id),petSay:text=>toasts.push(text),
  };context.window=context;vm.createContext(context);vm.runInContext(source,context);
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../components/panels/message-follow-up.js'),'utf8'),context);
  return {context,rows,nodes,reads,localReads,opened,refreshes,followups,toasts,scope:value=>{scope=value;},failRead:value=>{failRead=value;},
    async open(){context.openNoticePanel();await settle();},
    click(values){const row={getAttribute:key=>values[key]||null};handlers.get('npBody:click')({target:{closest:selector=>selector==='.np-row'?row:null}});},
    followUp(key){const button={isConnected:true,disabled:false,getAttribute:()=>key,setAttribute(){},removeAttribute(){}};
      handlers.get('npBody:click')({preventDefault(){},stopPropagation(){},target:{closest:selector=>selector==='[data-notice-follow-up]'?button:null}});return button;},
    html:()=>nodes.get('npBody').innerHTML};
}
const row=()=>({id:'mate-client',serverMessageId:'server-1',messageId:'client-1',at:Date.now(),text:'收到需求',bodyText:'收到需求',kind:'task_assignment',taskId:'task-1',read:false,sentStatus:'delivered',senderName:'发送人',recipientName:'接收人'});
test('publication notices use localized system copy and retain recipient read acknowledgements',async()=>{
  const f=fixture(), name='<img src=x onerror="bad()">';
  f.context.esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  f.context.SoduWorkI18n={t:(_key,_fallback,params)=>'Removed: '+params.name};
  f.rows.received=[{...row(),kind:'plugin_lifecycle',taskId:'',textMessage:{key:'notification.plugin_unpublished',params:{name}}}];
  await f.open();
  assert.match(f.html(),/发布状态更新/);
  assert.match(f.html(),/class="np-txt" data-user-content/);
  assert.match(f.html(),/Removed: &lt;img/);
  assert.doesNotMatch(f.html(),/<img|data-ntask=|来自/);
  f.click({'data-nnotice':'mate-client','data-server-message':'server-1'});await settle();
  assert.deepEqual(f.reads,['server-1']);assert.equal(f.rows.received[0].read,true);
  f.rows.sent=[{...f.rows.received[0],recipientName:'Recipient <script>'}];
  await f.context._loadMateNoticeFolder('sent');
  assert.match(f.html(),/Recipient &lt;script&gt;/);assert.doesNotMatch(f.html(),/<script>/);
});
test('notice center renders the shared store and refreshes receipt status without a parallel cache',async()=>{
  const f=fixture();f.rows.received=[row()];f.rows.sent=[{...row(),read:true}];await f.open();
  assert.match(f.html(),/收到需求/);assert.match(f.html(),/data-ntask="task-1"/);
  await f.context._loadMateNoticeFolder('sent');assert.match(f.html(),/np-delivery np-delivered/);
  f.rows.sent[0].sentStatus='read';f.context._renderNoticePanel();assert.match(f.html(),/np-delivery np-read/);
  assert.deepEqual(f.refreshes,['received','sent']);
});
test('library attachments expose open, download, and save actions in both folders',async()=>{
  const attachment={id:'attachment-1',name:'shared.txt',size:12};
  const f=fixture();f.rows.received=[{...row(),kind:'mate_message',attachments:[attachment]}];f.rows.sent=[{...row(),kind:'mate_message',attachments:[attachment]}];
  await f.open();
  assert.equal((f.html().match(/data-notice-action="(?:open|download|save)"/g)||[]).length,3);
  await f.context._loadMateNoticeFolder('sent');
  assert.equal((f.html().match(/data-notice-action="(?:open|download|save)"/g)||[]).length,3);
});
test('a failed remote read keeps the row unread and reports failure instead of consuming locally',async()=>{
  const f=fixture();f.rows.received=[row()];f.failRead(true);await f.open();
  f.click({'data-nnotice':'mate-client','data-server-message':'server-1'});await settle();
  assert.deepEqual(f.localReads,[]);assert.deepEqual(f.reads,['server-1']);
  assert.equal(f.rows.received[0].read,false);assert.match(f.html(),/网络已断开|未读状态|重试/);
});
test('received task links open the authoritative detail even before task list hydration',async()=>{
  const f=fixture();f.rows.received=[row()];await f.open();
  f.click({'data-nnotice':'mate-client','data-server-message':'server-1','data-ntask':'task-1'});await settle();
  assert.deepEqual(f.opened,['task-1']);assert.deepEqual(f.reads,['server-1']);
});
test('sender receipt notifications are read locally and never call the recipient read API',async()=>{
  const f=fixture();f.rows.received=[{...row(),kind:'mate_receipt'}];await f.open();
  assert.match(f.html(),/收到需求/);
  assert.doesNotMatch(f.html(),/data-server-message=/);
  f.click({'data-nnotice':'mate-client'});await settle();
  assert.deepEqual(f.localReads,['mate-client']);assert.deepEqual(f.reads,[]);
});

for(const [receiptStatus,label] of [['accepted','已发送'],['delivered','已送达'],['read','已读']]){
  test('回执标题直接展示'+label+'与接收人，发送状态不冒充送达',async()=>{
    const f=fixture();f.rows.received=[{...row(),kind:'mate_receipt',receiptStatus}];await f.open();
    assert.match(f.html(),new RegExp(label+' · 接收人'));
    assert.doesNotMatch(f.html(),/送达与已读回执/);
    if(receiptStatus==='accepted')assert.doesNotMatch(f.html(),/>已送达</);
  });
}
test('changing accounts before a queued click cannot acknowledge the old message as the new account',async()=>{
  const f=fixture();f.rows.received=[row()];await f.open();
  f.click({'data-nnotice':'mate-client','data-server-message':'server-1'});
  f.scope('two');f.rows.received=[];f.context._renderNoticePanel();await settle();
  assert.deepEqual(f.reads,[]);assert.doesNotMatch(f.html(),/收到需求/);
});

test('follow-up opens the new conversation but failed read acknowledgement keeps the notice unread',async()=>{
  const f=fixture();f.rows.received=[{...row(),kind:'mate_message'}];f.failRead(true);await f.open();
  const button=f.followUp('mate-client');await settle();
  assert.equal(f.followups.length,1);assert.match(f.followups[0].prefill,/收到需求/);
  assert.deepEqual(f.reads,['server-1']);assert.deepEqual(f.localReads,[]);
  assert.equal(f.rows.received[0].read,false);assert.match(f.html(),/网络已断开|重试/);assert.equal(button.disabled,false);
});

test('successful follow-up consumes only the confirmed message through the shared receipt helper',async()=>{
  const f=fixture();f.rows.received=[{...row(),kind:'mate_message'}, {...row(),id:'untouched',serverMessageId:'server-2'}];await f.open();
  f.followUp('mate-client');await settle();
  assert.equal(f.followups[0].newSession,true);assert.equal(f.followups[0].send,undefined);
  assert.deepEqual(f.reads,['server-1']);assert.deepEqual(f.localReads,[]);
  assert.equal(f.rows.received[0].read,true);assert.equal(f.rows.received[1].read,false);
});

test('failed follow-up never acknowledges or locally consumes the original message',async()=>{
  const f=fixture();f.rows.received=[{...row(),kind:'mate_message'}];await f.open();
  f.context.WorkspaceHost.open=()=>false;f.followUp('mate-client');await settle();
  assert.deepEqual(f.reads,[]);assert.deepEqual(f.localReads,[]);assert.equal(f.rows.received[0].read,false);
  assert.equal(f.toasts.length,1);
});

test('account switch while follow-up opens cannot acknowledge the previous account message',async()=>{
  const f=fixture();f.rows.received=[{...row(),kind:'mate_message'}];await f.open();
  let complete;f.context.WorkspaceHost.open=()=>new Promise(resolve=>{complete=resolve;});
  f.followUp('mate-client');await settle();assert.equal(typeof complete,'function');
  f.scope('two');f.rows.received=[];f.context._renderNoticePanel();complete(true);await settle();
  assert.deepEqual(f.reads,[]);assert.deepEqual(f.localReads,[]);assert.doesNotMatch(f.html(),/收到需求/);
});
