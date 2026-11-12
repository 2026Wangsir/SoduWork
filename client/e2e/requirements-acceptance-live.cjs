'use strict';
// The real renderer and HTTP API share a disposable Hub; no installed profile is used.
const {app,BrowserWindow} = require('electron');
const fs = require('node:fs'),path = require('node:path'),assert = require('node:assert/strict');
const [output,hub] = process.argv.slice(2);
if(!path.isAbsolute(output||'')||!/^http:\/\/127\.0\.0\.1:\d+$/.test(hub||''))throw Error('Isolated Hub required');
fs.mkdirSync(output,{recursive:true});app.setPath('userData',path.join(output,'profile'));
const report = {ok:false,checks:[],boundary:'Production Electron renderer and API against isolated HTTP/SQLite; seeded terminal execution receipts, no model call'};
const windows=[];const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function call(route,identity='recipient',method='GET',body) {
  const response=await fetch(hub+route,{method,headers:{'Content-Type':'application/json','X-Soduwork-Device':'e2e-'+identity},
    ...(body?{body:JSON.stringify(body)}:{})});
  return {status:response.status,body:await response.json()};
}
async function open(identity) {
  const win=new BrowserWindow({show:false,width:1280,height:1000,webPreferences:{contextIsolation:true,sandbox:true,offscreen:true,partition:'acceptance-'+identity}});
  windows.push(win);
  const js=async source=>{
    const value=await win.webContents.executeJavaScript(`(async()=>{try{return await(0,eval)(${JSON.stringify(source)})}catch(e){return{fixtureError:e.stack}}})()`,true);
    if(value?.fixtureError)throw Error(value.fixtureError);return value;
  };
  await win.loadFile(path.join(__dirname,'fixtures/requirements-integration.html'),{query:{hub,identity}});
  assert.equal(await js('fixtureReady'),'ready');
  for(const name of ['task-trace-approval','task-approval-inbox'])await js(fs.readFileSync(path.join(__dirname,'../components/panels',name+'.js'),'utf8'));
  await win.webContents.insertCSS(fs.readFileSync(path.join(__dirname,'../components/panels/task-trace-view.css'),'utf8'));
  await js(`TaskApprovalInbox.refresh()`);
  const click=async selector=>{
    for(let i=0;i<60;i++) {
      if(await js(`!!document.querySelector(${JSON.stringify(selector)}+':not([disabled])')`))break;
      await wait(100);
    }
    const p=await js(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n||n.disabled)throw Error('Unavailable button');
      n.scrollIntoView({block:'center',behavior:'instant'});const b=n.getBoundingClientRect();return{x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)}})()`);
    for(const type of ['mouseDown','mouseUp'])win.webContents.sendInputEvent({type,...p,button:'left',clickCount:1});
    await wait(150);
  };
  return {win,js,click};
}
app.whenReady().then(async()=>{
  try {
    assert.equal((await call('/e2e/acceptance-seed','recipient','POST',{})).status,200);
    await require('./task-delivery-roundtrip.cjs')(hub, call, report);
    assert.equal((await call('/api/v1/tasks/empty-delivery/submit-review','sender','POST',{})).status,403);
    assert.equal((await call('/api/v1/tasks/live-turn/submit-review','recipient','POST',{})).status,409);
    const executor=await open('recipient');
    await executor.js(`RequirementsDetail.open('live-turn')`);
    assert.equal(await executor.js(`document.querySelectorAll('[data-rq-submit-review]').length`),0);
    await executor.js(`RequirementsDetail.open('empty-delivery')`);
    await executor.click('.rq-detail-more>summary');
    await executor.click('[data-rq-submit-review]');
    let task;
    for(let i=0;i<50;i++) {task=(await call('/api/v1/tasks/empty-delivery')).body;if(task.requirementStage==='reviewing')break;await wait(100);}
    assert.equal(task.requirementStage,'reviewing');
    assert.equal(task.canSubmitReview,false);
    assert.equal(await executor.js(`document.querySelectorAll('.rq-detail-backdrop').length`),0,
      'A successful HTTP submission closes the executor drawer');
    const reviewer=await open('sender');
    await reviewer.js(`RequirementsDetail.open('empty-delivery')`);
    assert.equal(await reviewer.js(`document.querySelectorAll('[data-tfd-acceptance-mode]').length`),2);
    await reviewer.click('[data-tfd-approval-action="approve"]');
    for(let i=0;i<50;i++) {task=(await call('/api/v1/tasks/empty-delivery','sender')).body;if(task.reviewedAt&&task.status==='done')break;await wait(100);}
    assert.ok(task.reviewedAt,'Empty delivery must remain manually reviewable');
    assert.equal(task.status,'done');
    report.checks.push('Stopped executor can submit an empty declared delivery from More; creator and live-turn submissions are denied by the Hub');
    const submitted=await call('/api/v1/tasks/revised-delivery/submit-review','recipient','POST',{});
    assert.equal(submitted.status,200,JSON.stringify(submitted.body));
    const packet=await call('/api/v1/tasks/revised-delivery/acceptance-context','sender');
    assert.deepEqual(packet.body.attachmentIds,['revision-2']);
    assert.ok(!JSON.stringify(packet.body.evidence).includes('report.md'));
    await reviewer.js(`(async()=>{await Store.refreshTasks();await TaskApprovalInbox.refresh();await RequirementsDetail.open('revised-delivery')})()`);
    const current=await reviewer.js(`document.querySelector('[data-rq-material-group="output"]').textContent`);
    assert.ok(current.includes('report.html'));assert.ok(!current.includes('report.md'));
    report.checks.push('Real acceptance context, gate evidence and detail materials agree on revised HTML only');
    report.reviewState=await reviewer.js(`(async()=>({task:await SoduWorkAPI.getTask('revised-delivery'),approvals:TaskApprovalInbox.snapshot(),waiting:TaskApprovalInbox.waiting()}))()`);
    await reviewer.click('[data-tfd-approval-action="approve"]');
    for(let i=0;i<50;i++) {task=(await call('/api/v1/tasks/revised-delivery','sender')).body;if(task.reviewedAt&&task.status==='done')break;await wait(100);}
    assert.ok(task.reviewedAt,'Creator confirmation must finish acceptance');
    assert.equal(task.status,'done');
    await reviewer.js(`RequirementsDetail.open('revised-delivery')`);
    assert.equal(await reviewer.js(`document.querySelectorAll('[data-tfd-approval-action]').length`),0);
    report.checks.push('Creator confirms through the production approval card; completed details have no stale decision buttons');
    delete report.reviewState;
    const multiple=await call('/api/v1/tasks/multiple-deliverables/submit-review','recipient','POST',{});
    assert.equal(multiple.status,200,JSON.stringify(multiple.body));
    const materialContext=(await call('/api/v1/tasks/multiple-deliverables/acceptance-context','sender')).body;
    assert.deepEqual(materialContext.attachmentIds.slice().sort(),['site-css','site-doc','site-html','site-notes']);
    assert.equal(materialContext.deliveryBundle.fileCount,4);
    const prepared=await require('../main/pi-session/task-input').prepare({hub,clientId:'e2e-sender',
      secret:'isolated-requirements-fixture-key-never-production'},'multiple-deliverables','acceptance-chat','turn','Review',
      {acceptanceOnly:true},{handle:{sessionId:'acceptance-chat'}});
    await prepared.beforeTurn();
    assert.equal(prepared.attachments.length,2);
    assert.equal(prepared.attachments[0].mimeType,'application/zip');
    assert.equal(prepared.attachments[0].data.subarray(0,2).toString(),'PK');
    assert.deepEqual(prepared.attachments[0].evidenceMeta.sourceAttachmentIds.slice().sort(),['site-css','site-doc','site-html','site-notes']);
    assert.equal(prepared.attachments[1].name,'brief.md');
    assert.equal(prepared.attachments[1].data.toString(),'Reference only');
    await reviewer.js(`(async()=>{await Store.refreshTasks();await TaskApprovalInbox.refresh();await RequirementsDetail.open('multiple-deliverables')})()`);
    assert.equal(await reviewer.js(`document.querySelectorAll('[data-rq-material-group="output"] .rq-material').length`),5);
    assert.deepEqual(await reviewer.js(`Array.from(document.querySelectorAll('[data-rq-material-group="output"] [data-rq-file-id]'),n=>n.dataset.rqFileId).filter(Boolean).sort()`),['site-css','site-doc','site-html','site-notes']);
    assert.equal(await reviewer.js(`!!document.querySelector('[data-rq-bundle-download]')`),true);
    assert.equal(await reviewer.js(`document.querySelector('[data-rq-material-group="output"]').textContent.includes('final-hero.png')`),false);
    await reviewer.click('[data-rq-material-group="output"]>summary');
    const downloadPath=path.join(output,'review-delivery.zip');
    const downloaded=new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>reject(Error('Archive download did not complete')),15000);
      reviewer.win.webContents.session.once('will-download',(_event,item)=>{
        item.setSavePath(downloadPath);
        item.once('done',(_done,state)=>{clearTimeout(timeout);state==='completed'?resolve():reject(Error('Download '+state));});
      });
    });
    await reviewer.click('[data-rq-bundle-download]');
    await downloaded;
    assert.equal(fs.readFileSync(downloadPath).subarray(0,2).toString(),'PK');
    report.checks.push('Three primary deliverables and their stylesheet enter the real acceptance runtime as one version-bound checksum-verified ZIP alongside the original reference; the drawer retains original files and downloads the archive through a native click, excluding historical output and optional evidence');
    for(const page of [executor,reviewer])assert.deepEqual(await page.js('fixtureErrors'),[]);
    report.ok=true;
  }catch(error){report.error=String(error.stack||error);for(let i=0;i<windows.length;i++)fs.writeFileSync(path.join(output,'failure-'+i+'.png'),(await windows[i].webContents.capturePage()).toPNG());}
  finally{fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));app.exit(report.ok?0:1);}
});
