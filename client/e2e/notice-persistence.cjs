'use strict';
// Exercise real IndexedDB, Web Locks, account boundaries and fresh processes.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const electron = require('electron');
const output = path.resolve(process.argv[2] || path.join(__dirname, '../outputs/notice-persistence'));
if (typeof electron === 'string') {
  fs.mkdirSync(output, { recursive: true });
  const profile = fs.mkdtempSync(path.join(output, 'profile-'));
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  for (const phase of ['exercise', 'restart']) {
    const run = require('node:child_process').spawnSync(electron, [__filename, output, profile, phase],
      { env, windowsHide: true, encoding: 'utf8', timeout: 240000 });
    fs.writeFileSync(path.join(output, phase + '.log'), String(run.stdout || '') + String(run.stderr || ''));
    assert.equal(run.status, 0, run.error?.message || run.stderr || 'Electron fixture failed');
  }
  // Only the fresh fixture profile belongs to this run; retain failure evidence.
  fs.rmSync(profile, { recursive: true, force: true });
  console.log('Notice persistence and fresh-process recovery passed');
} else {
  const { app, BrowserWindow, session } = electron;
  const profile = process.argv[3], phase = process.argv[4], windows = [];
  const report = { phase, cases: [], boundary: 'Isolated Chromium storage and synthetic Hub responses; no real accounts or services.' };
  app.setPath('userData', profile); app.disableHardwareAcceleration();
  app.on('window-all-closed', () => {});
  const source = file => fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
  const code = win => script => win.webContents.executeJavaScript(`(async()=>{
    const body=${JSON.stringify(script)}, AsyncFunction=(async()=>{}).constructor;let run;
    try{run=new AsyncFunction('return ('+body+'\\n)');}catch(error){if(!(error instanceof SyntaxError))throw error;run=new AsyncFunction(body);}
    try{return await run();}catch(error){console.error(error.stack);throw error;}
  })()`, true);
  const seed = `
    var owner='fixture-a', delivered=[], lists=0, items=[], blocked=false, revisionTag='initial';
    var startupLags=[], heartbeatAt=performance.now();setInterval(()=>{const now=performance.now();startupLags.push(now-heartbeatAt-10);heartbeatAt=now},10);
    var _nkIcon=()=>'', petSay=()=>{}, updateNoticeBadge=()=>{};
    var SoduWorkAPI={taskStorageKey:k=>owner+':'+k,clientAuthSnapshot:()=>({user:{id:owner}}),
      mateMessages:async(folder,limit,before,revision)=>{lists++;if(blocked)throw Error('fixture offline');
        if(revision===revisionTag)return {ok:true,items:[],revision,notModified:true};
        const offset=Number(before)||0, page=folder==='sent'?[]:items.slice(offset,offset+limit);
        return {ok:true,items:page,nextCursor:offset+page.length<items.length?String(offset+page.length):'',revision:revisionTag};},
      markMateMessageDelivered:async id=>{delivered.push(id);return {ok:true,status:'delivered',deliveredAt:200};},
      markMateMessageRead:async id=>({ok:true,status:'read',readAt:300})};
    var fixtureEvent=(id,text='original private message')=>({type:'notice',serverMessageId:id,messageId:id,
      senderId:'fixture-b',recipientId:owner,text,createdAt:Date.now(),status:'accepted',kind:'mate_message'});
  `;
  async function windowFor(file = 'fixture.html') {
    const win = new BrowserWindow({ show: false, width: 1100, height: 800,
      webPreferences: { contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } });
    windows.push(win);
    win.webContents.on('console-message', details => {
      if (details.level === 'error') console.error(details.message);
    });
    await win.loadFile(path.join(output, file));
    await code(win)('MateNoticeSync.restore()');
    return win;
  }
  async function check(name, fn) { const result = await fn(); report.cases.push({ name, ok: true, result }); }
  async function click(win, selector) {
    const point = await code(win)(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)throw Error('Missing input');el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
    await new Promise(resolve => setTimeout(resolve, 120));
  }
  app.whenReady().then(async () => {
    fs.mkdirSync(output, { recursive: true });
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('file:') }));
    const scripts = ['core/task-sync.js', 'core/store-lifecycle.js', 'core/store.js', 'core/notice-persistence.js',
      'core/mate-notice-sync.js', 'components/panels/panels-desk.js'];
    fs.writeFileSync(path.join(output, 'fixture.html'), '<!doctype html><meta charset="utf-8"><style>body{font:14px sans-serif}.np-body{height:650px;overflow:auto}.np-row{padding:12px;border-bottom:1px solid #ccc}.np-ico svg{height:20px}.np-txt.is-long{max-height:50px;overflow:hidden}.np-copy svg,.np-empty svg{height:24px}button{min-height:32px}</style><script>' + seed + '</script>' +
      scripts.map(file => '<script>' + source(file).replace(/<\/script/gi, '<\\/script') + '</script>').join(''));
    const first = await windowFor(), js = code(first);
    assert.equal(await js('MateNoticeSync.persistent'), true);
    if (phase === 'restart') {
      await check('fresh-process-offline-history-and-markers', async () => {
        await js('blocked=true; await MateNoticeSync.restore()');
        assert.equal(await js('MateNoticeSync.rows("received").filter(r=>r.serverMessageId.startsWith("bulk-")).length'), 5000);
        assert.equal(await js('MateNoticeSync.rows("received").some(r=>r.serverMessageId==="cleared")'), false);
        assert.equal(await js('MateNoticeSync.rows("received").find(r=>r.serverMessageId==="restart-record").bodyText'), 'saved after retry');
        return await js('({maxStartupLag:Math.max(0,...startupLags),samples:startupLags.length})');
      });
    } else {
      await check('storage-open-and-read-abort-can-retry-without-unhandled-rejections', async () => {
        const result = await js(`(async()=>{const store=SoduWorkNoticePersistence.create(),original=indexedDB.open,unhandled=[];
          const listener=e=>{unhandled.push(String(e.reason));e.preventDefault()};addEventListener('unhandledrejection',listener);
          const legacy=()=>({rows:[],meta:{},retire(){}});let openFailed=false,readFailed=false;
          indexedDB.open=()=>{throw Error('fixture open failure')};try{await store.update('fault-scope',legacy,()=>true)}catch(e){openFailed=true}finally{indexedDB.open=original}
          await store.update('fault-scope',legacy,()=>true);
          const get=IDBObjectStore.prototype.get;IDBObjectStore.prototype.get=function(...args){const operation=get.apply(this,args);if(this.name==='meta')operation.addEventListener('success',()=>this.transaction.abort(),{once:true});return operation};
          try{await store.update('fault-scope',legacy,()=>true)}catch(e){readFailed=true}finally{IDBObjectStore.prototype.get=get}
          await store.update('fault-scope',legacy,()=>true);await new Promise(r=>setTimeout(r,40));removeEventListener('unhandledrejection',listener);
          return {openFailed,readFailed,unhandled};})()`);
        assert.deepEqual(result, { openFailed: true, readFailed: true, unhandled: [] });
      });
      await check('migration-abort-preserves-source-and-rolls-back-partial-records', async () => {
        const result = await js(`(async()=>{owner='migration-owner';const original=IDBObjectStore.prototype.put;
          const raw=JSON.stringify([{id:'mate_migrate',serverMessageId:'migrate',recipientId:owner,text:'keep original',at:1,read:false}]);
          localStorage.setItem(owner+':notices',raw);IDBObjectStore.prototype.put=function(value,...args){if(this.name==='meta')throw Error('fixture write failure');return original.call(this,value,...args)};
          let rejected=false;try{await MateNoticeSync.restore()}catch(e){rejected=true}finally{IDBObjectStore.prototype.put=original}
          const preserved=localStorage.getItem(owner+':notices')===raw;await MateNoticeSync.restore();const count=MateNoticeSync.rows('received').length;
          owner='fixture-a';dispatchEvent(new Event('soduwork-data-scope-changed'));await MateNoticeSync.restore();return {rejected,preserved,count};})()`);
        assert.deepEqual(result, { rejected: true, preserved: true, count: 1 });
      });
      await check('legacy-cache-and-dismissal-migrate-without-truncation', async () => {
        await js(`localStorage.setItem(owner+':notices',JSON.stringify([{id:'mate_legacy',serverMessageId:'legacy',recipientId:owner,at:100,text:'legacy original',read:false}]));
          localStorage.setItem(owner+':notices:sync',JSON.stringify({ids:['dismissed-local']}));await MateNoticeSync.restore();`);
        assert.equal(await js('MateNoticeSync.rows("received").find(r=>r.serverMessageId==="legacy").text'), 'legacy original');
        assert.equal(await js('JSON.parse(localStorage.getItem(owner+":notices")).length'), 0);
        assert.equal(await js('MateNoticeSync.dismissedId("dismissed-local")'), true);
      });
      // Main and desk windows use distinct file URLs in the same app profile.
      fs.copyFileSync(path.join(output, 'fixture.html'), path.join(output, 'fixture-desk.html'));
      const second = await windowFor('fixture-desk.html'), other = code(second);
      await check('cross-window-concurrent-writes-and-single-presentation', async () => {
        await Promise.all(Array.from({ length: 24 }, (_, i) => (i % 2 ? js : other)(`MateNoticeSync.handle(fixtureEvent('parallel-${i}'))`)));
        await js('await MateNoticeSync.restore()');
        assert.equal(await js('MateNoticeSync.rows("received").filter(r=>r.serverMessageId.startsWith("parallel-")).length'), 24);
        const result = await Promise.all([js('MateNoticeSync.present(fixtureEvent("present-once")).then(Boolean)'), other('MateNoticeSync.present(fixtureEvent("present-once")).then(Boolean)')]);
        assert.equal(result.filter(Boolean).length, 1);
      });
      await check('failed-database-transaction-never-confirms-delivery-and-retry-recovers', async () => {
        const result = await js(`(async()=>{const original=IDBDatabase.prototype.transaction;IDBDatabase.prototype.transaction=function(stores,mode,...rest){if(mode==='readwrite')throw Error('fixture disk full');return original.call(this,stores,mode,...rest);};
          let failed=false;try{await MateNoticeSync.handle(fixtureEvent('recovered','saved after retry'));}catch(e){failed=/无法保存到本机/.test(e.message);}finally{IDBDatabase.prototype.transaction=original;}
          const acknowledged=delivered.includes('recovered');await MateNoticeSync.handle(fixtureEvent('recovered','saved after retry'));return {failed,acknowledged,recovered:delivered.includes('recovered')};})()`);
        assert.deepEqual(result, { failed: true, acknowledged: false, recovered: true });
      });
      await check('account-switch-fences-delayed-responses', async () => {
        const result = await js(`(async()=>{const original=SoduWorkAPI.mateMessages;let release,entered;const started=new Promise(r=>entered=r);
          SoduWorkAPI.mateMessages=()=>{entered();return new Promise(r=>release=r)};const pending=MateNoticeSync.refresh('received');await started;
          owner='fixture-c';dispatchEvent(new Event('soduwork-data-scope-changed'));await MateNoticeSync.restore();release({ok:true,items:[{id:'wrong-account',recipientId:'fixture-a',text:'private'}]});await pending;
          const count=MateNoticeSync.rows('received').length;SoduWorkAPI.mateMessages=original;owner='fixture-a';dispatchEvent(new Event('soduwork-data-scope-changed'));await MateNoticeSync.restore();return count;})()`);
        assert.equal(result, 0);
      });
      await check('clear-survives-other-window-and-server-replay', async () => {
        await js('await MateNoticeSync.handle(fixtureEvent("cleared"));await MateNoticeSync.clear()');
        await other('await MateNoticeSync.restore();await MateNoticeSync.handle(fixtureEvent("cleared"))');
        assert.equal(await other('MateNoticeSync.rows("received").some(r=>r.serverMessageId==="cleared")'), false);
        await js('await MateNoticeSync.handle(fixtureEvent("recovered","saved after retry"))');
        // A cleared ID stays cleared. A distinct later message proves that clear
        // does not use a client clock to hide future messages.
        await js('await MateNoticeSync.handle(fixtureEvent("after-clear","new message"))');
        assert.equal(await js('MateNoticeSync.rows("received").some(r=>r.serverMessageId==="after-clear")'), true);
      });
      await check('queued-clear-preserves-a-new-local-notice', async () => {
        const result = await js(`(async()=>{logNotice('before clear',null,'notice');let unlock,entered;
          const started=new Promise(r=>entered=r);const hold=navigator.locks.request('soduwork-notices:'+SoduWorkAPI.taskStorageKey('notices'),()=>{entered();return new Promise(r=>unlock=r)});await started;
          const clear=MateNoticeSync.clear();logNotice('after clear was clicked',null,'notice');unlock();await hold;await clear;
          const texts=MateNoticeSync.rows('received').map(row=>row.text);return {before:texts.includes('before clear'),after:texts.includes('after clear was clicked')};})()`);
        assert.deepEqual(result, { before: false, after: true });
        await js('await MateNoticeSync.handle(fixtureEvent("after-clear","new message"))');
      });
      await check('queued-read-does-not-consume-a-later-receipt-phase', async () => {
        const result = await js(`(async()=>{const event={type:'mate_message_accepted',messageId:'phase-receipt',clientMessageId:'phase-client',senderId:owner,recipientId:'fixture-b',text:'sent original',status:'accepted',createdAt:400};
          await MateNoticeSync.handle(event);let unlock,entered;const started=new Promise(r=>entered=r);
          const hold=navigator.locks.request('soduwork-notices:'+SoduWorkAPI.taskStorageKey('notices'),()=>{entered();return new Promise(r=>unlock=r)});await started;
          const later=MateNoticeSync.handle({...event,type:'mate_message_delivered',status:'delivered',deliveredAt:500});
          const read=MateNoticeSync.markLocalRead('mate_receipt_phase-receipt');unlock();await Promise.all([hold,later,read]);
          const row=MateNoticeSync.rows('received').find(r=>r.id==='mate_receipt_phase-receipt');return {status:row.receiptStatus,read:row.read};})()`);
        assert.deepEqual(result, { status: 'delivered', read: false });
      });
      await check('large-history-exceeds-localStorage-with-responsive-incremental-writes', async () => {
        const result = await js(`(async()=>{revisionTag='bulk';items=Array.from({length:5000},(_,i)=>({id:'bulk-'+i,messageId:'bulk-'+i,senderId:'fixture-b',recipientId:owner,
          text:'message '+i+' '+ 'x'.repeat(4096),createdAt:10000+i,status:'read',readAt:20000}));
          const lags=[];let previous=performance.now();const timer=setInterval(()=>{const now=performance.now();lags.push(now-previous-10);previous=now},10);
          const begin=performance.now();await MateNoticeSync.refresh('received');clearInterval(timer);
          const elapsed=performance.now()-begin, before=lists;await MateNoticeSync.refresh('received');
          return {count:MateNoticeSync.rows('received').filter(r=>r.serverMessageId.startsWith('bulk-')).length,elapsed,maxLag:Math.max(...lags),heartbeatSamples:lags.length,conditionalRequests:lists-before,localBytes:(localStorage.getItem(owner+':notices')||'').length};})()`);
        assert.equal(result.count, 5000); assert.equal(result.conditionalRequests, 1); assert.ok(result.localBytes < 10000);
        assert.ok(result.heartbeatSamples > 3, 'storage work must allow the renderer heartbeat to advance');
        return result;
      });
      await check('native-pagination-and-read-actions-retain-history', async () => {
        await js('openNoticePanel()');
        assert.equal(await js('document.querySelectorAll(".np-row").length'), 100);
        assert.equal(await js('(async()=>{const row=document.querySelector(".np-row");await _loadMateNoticeFolder("received");return row===document.querySelector(".np-row")})()'), true);
        await click(first, '[data-notice-more]');
        assert.equal(await js('document.querySelectorAll(".np-row").length'), 200);
        await js('await MateNoticeSync.handle(fixtureEvent("native-read","read this message"))');
        await click(first, '[data-server-message="native-read"]');
        assert.equal(await js('MateNoticeSync.rows("received").find(r=>r.serverMessageId==="native-read").read'), true);
        fs.writeFileSync(path.join(output, 'history.png'), (await first.webContents.capturePage()).toPNG());
      });
      await check('local-reminder-retains-history-above-javascript-argument-limit', async () => {
        const result = await js(`(async()=>{const read=_readNotices,save=_saveNotices;
          _readNotices=()=>Array.from({length:150000},(_,i)=>({id:'capacity-'+i,serverMessageId:'capacity-'+i}));_saveNotices=()=>true;
          let count,ok;try{ok=logNotice('new local reminder');count=notices.length}finally{_readNotices=read;_saveNotices=save}
          await MateNoticeSync.restore();return {ok,count};})()`);
        assert.deepEqual(result, { ok: true, count: 150001 });
      });
      // Retain a separate unconsumed record for the fresh-process durability check.
      await js('await MateNoticeSync.handle(fixtureEvent("restart-record","saved after retry"))');
    }
    report.ok = true;
  }).catch(error => { report.ok = false; report.error = error.stack; console.error(error); process.exitCode = 1; }).finally(() => {
    fs.writeFileSync(path.join(output, phase + '.json'), JSON.stringify(report, null, 2));
    for (const win of windows) if (!win.isDestroyed()) win.destroy();
    app.exit(report.ok ? 0 : 1);
  });
}
