'use strict';
// Exercise production detail and trace rendering with isolated authoritative DTOs.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = {...process.env};
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  const result = require('node:child_process').spawnSync(electron, [__filename], {
    env, windowsHide: true, stdio: 'inherit', timeout: 120000,
  });
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
}
const {app, BrowserWindow} = electron;
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {pathToFileURL} = require('node:url');
const client = path.resolve(__dirname, '..');
const output = path.resolve(client, '../outputs/requirements-lifecycle-edit');
fs.mkdirSync(output, {recursive: true});
app.setPath('userData', fs.mkdtempSync(path.join(output, 'profile-')));
app.disableHardwareAcceleration();
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = {ok: false, cases: [], snapshots: [], errors: [], failures: [],
  boundary: 'Hidden native Electron and production desktop CSS/detail/trace runtime; isolated API DTOs, no network, model or business data'};
let win;
const js = code => win.webContents.executeJavaScript(code, true);
function verify(condition, label) {
  if (!condition) report.failures.push(label);
}
async function until(code, label) {
  for (let i = 0; i < 80; i++) {
    if (await js(code)) return;
    await wait(50);
  }
  throw Error('Timed out: ' + label);
}
async function click(selector, allowDisabled = false, count = 1) {
  const point = await js(`(async()=>{const n=[...document.querySelectorAll(${JSON.stringify(selector)})].find(n=>n.getClientRects().length);
    if(!n||(!${allowDisabled}&&n.disabled))throw Error('Unavailable '+${JSON.stringify(selector)});
    n.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});
    await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
    const b=n.getBoundingClientRect(),x=Math.round(b.x+b.width/2),y=Math.round(b.y+b.height/2);
    if(!n.contains(document.elementFromPoint(x,y)))throw Error('Occluded '+${JSON.stringify(selector)});return{x,y}})()`);
  for (let index = 0; index < count; index++) {
    for (const type of ['mouseMove', 'mouseDown', 'mouseUp']) win.webContents.sendInputEvent({type, ...point,
      ...(type === 'mouseMove' ? {} : {button: 'left', clickCount: index + 1})});
  }
  await wait(80);
}
async function shot(name) {
  await wait(80);
  fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG());
}
async function shotHero(name) {
  const top = await js(`document.querySelector('.rq-detail-content').scrollTop`);
  await js(`document.querySelector('.tfd-hero').scrollIntoView({block:'center',behavior:'instant'});void 0`);
  await shot(name);
  await js(`document.querySelector('.rq-detail-content').scrollTop=${top};void 0`);
}
async function snapshot(label) {
  const value = await js(`(()=>{const content=document.querySelector('.rq-detail-content');return{
    title:document.querySelector('.tfd-hero h3')?.textContent,
    progress:document.querySelector('.tfd-progress')?.getAttribute('aria-label'),
    progressText:document.querySelector('.tfd-progress')?.textContent.trim(),
    delivery:document.querySelector('.rq-delivery-state')?.textContent,
    edit:!!document.querySelector('.rq-detail [data-rq-edit]'),chat:!!document.querySelector('.rq-detail [data-rq-chat]'),
    submit:!!document.querySelector('[data-rq-submit-review]'),materials:!!document.querySelector('[data-rq-add-files]'),
    file:document.querySelector('[data-rq-file]')?.textContent,
    outer:document.querySelector('[data-rq-execution]')?.open,
    timeline:!document.querySelector('[data-rq-evidence-modal]')?.hidden,
    evidenceTop:document.querySelector('.rq-evidence-modal .rq-detail-modal-body')?.scrollTop,
    top:content.scrollTop,height:content.scrollHeight,viewport:content.clientHeight,
    patches:fixtureCalls.filter(x=>x[0]==='patch').length,chats:fixtureCalls.filter(x=>x[0]==='chat').length,
    traceReads:window.traceReads}})()`);
  report.snapshots.push({label, ...value});
  return value;
}
app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({show: false, width: 1440, height: 960,
      webPreferences: {offscreen: true, contextIsolation: true, sandbox: true, backgroundThrottling: false}});
    win.webContents.session.webRequest.onBeforeRequest({urls: ['http://*/*', 'https://*/*']}, (_r, done) => done({cancel: true}));
    win.webContents.on('console-message', event => {if (event.level === 'error') report.errors.push(event.message);});
    await win.loadFile(path.join(__dirname, 'fixtures/requirements-board.html'));
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', {enabled: true});
    const styles = [...fs.readFileSync(path.join(client, 'desk.html'), 'utf8')
      .matchAll(/<link\b[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']+)/g)]
      .map(match => pathToFileURL(path.join(client, match[1])).href);
    await js(`Promise.all(${JSON.stringify(styles)}.map(href=>new Promise((resolve,reject)=>{
      const n=document.createElement('link');n.rel='stylesheet';n.href=href;n.onload=resolve;n.onerror=()=>reject(Error(href));document.head.append(n)
    }))).then(()=>true)`);
    await js(`window.detailId='';window.traceReads=0;window.phase='ready';window.traceRevision=1;
      window.lifecycleDTOs={
        ready:{title:'等待开始',state:'planned',nextAction:'安排执行',description:'需求已准备，可以安排执行。',progress:{done:1,total:4,unit:'阶段'}},
        doing:{title:'执行工作',state:'running',nextAction:'完成后提交验收',description:'负责人正在执行需求。',progress:{done:1,total:4,unit:'阶段'}},
        reviewing:{title:'等待验收',state:'waiting_human',nextAction:'核对成果并确认交付',description:'执行已完成，等待验收人确认。',progress:{done:2,total:4,unit:'阶段'}},
        done:{title:'需求已完成',state:'succeeded',nextAction:'',description:'交付结果已验收，需求已经完成。',progress:{done:4,total:4,unit:'阶段'}}
      };
      tasks=[{id:'lifecycle',title:'完善客户需求的执行、验收与交付体验',note:'需求与交付证据保存在同一条工作记录中。',
        kind:'requirement',priority:'normal',visibility:'organization',status:'todo',triageStage:'ready',
        myRoles:['creator','executor'],createdBy:'fixture-author',assigneeName:'测试负责人',assigneeUserId:'fixture-owner',
        readOnly:false,canEditRequirement:true,canManageRequirementMaterials:true,canSubmitReview:false,
        canManageRequirementAutomation:false,canViewExecution:true,requirementVersion:1,
        acceptanceCriteria:['每个阶段显示真实状态','执行开始后保留草稿并锁定编辑','验收完成后显示完整进度'],tags:['交付体验'],
        createdAt:1792713600000,updatedAt:1792713600000}];
      fixtureApprovals=[];
      SoduWorkAPI.listAttachments=async()=>[{id:'material-1',name:'需求背景与验收依据.md',size:2048,role:'input'}];
      window.setPhase=value=>{phase=value;traceRevision++;const t=tasks[0];Object.assign(t,{status:value==='ready'?'todo':value==='doing'?'doing':'done',
        requirementStage:value==='reviewing'?'reviewing':undefined,reviewedAt:value==='done'?1792796400000:null,
        canEditRequirement:value==='ready',canSubmitReview:value==='doing',hasExecutionHistory:value!=='ready',
        requirementEditBlocked:value!=='ready',maintenanceBlocked:value==='doing',actualStart:value==='ready'?null:1792717200000,
        requirementEditBlockReason:value==='ready'?'':'需求已开始执行，不能再编辑。',updatedAt:1792713600000+traceRevision*1000});};
      SoduWorkAPI.taskTrace=async id=>{traceReads++;const result={task:structuredClone(tasks[0]),
        card:{taskId:id,stage:{name:'原执行节点',state:'running'},progress:{done:1,total:9}},
        summary:{currentStageName:'原执行节点',currentState:'running',completedStages:1,totalStages:9,lifecycle:structuredClone(lifecycleDTOs[phase])},
        delivery:{authority:'manual',state:phase==='done'?'complete':'pending',complete:phase==='done'},
        stages:[],runs:[],ai:[],approvals:[],deployments:[],attachments:[],
        timeline:Array.from({length:18},(_,i)=>({kind:'advance',actor:'测试负责人',at:1792713600000+i*60000,
          detail:{note:'第 '+(i+1)+' 条执行证据已留存，版本 '+traceRevision}}))};
        await new Promise(resolve=>setTimeout(resolve,60));return result;};
      SoduWorkAPI.getTaskComments=async()=>[];
      SoduWorkAPI.getTaskEvents=async id=>(await SoduWorkAPI.taskTrace(id)).timeline;
      Store.applyServerEvent=event=>{fixtureCalls.push(['server-event',event.type]);
        window.dispatchEvent(new CustomEvent('soduwork-work-task-change',{detail:{type:event.type,taskId:event.task.id}}));
        return refreshOpenDetail(event.task.id);};
      window.notifyTaskChange=()=>Store.applyServerEvent({type:'task.updated',task:structuredClone(tasks[0])});
      SoduWorkAPI.submitTaskReview=async id=>{fixtureCalls.push(['submit-review',id]);setPhase('reviewing');
        notifyTaskChange();return{ok:true,task:structuredClone(tasks[0])}};
      RequirementsBoard.render(true);void 0;`);
    for (const file of ['task-trace-execution-details.js', 'task-trace-rail-view.js', 'task-trace-view.js', 'task-trace-runtime.js', 'panels-detail.js']) {
      await js(fs.readFileSync(path.join(client, 'components/panels', file), 'utf8'));
    }
    await click('[data-rq-open="lifecycle"]');
    await until(`!!document.querySelector('[data-rq-edit]')`, 'ready detail');
    await js(`window.staleEdit=document.querySelector('[data-rq-edit]').cloneNode(true);void 0`);
    await click('[data-rq-edit]');
    assert.equal(await js(`document.querySelector('#rqEditForm [name=title]').disabled`), false);
    await click('[data-rq-edit-cancel]');
    await click('[data-rq-execution]>summary');
    await until(`document.querySelector('.tfd-hero h3')?.textContent==='等待开始'`, 'ready lifecycle');
    const ready = await snapshot('ready');
    assert.equal(ready.edit, true); assert.equal(ready.progress, '流程进度 1/4');
    assert.equal(ready.delivery, '尚未开始'); assert.equal(ready.chat, false);
    await shotHero('ready');
    report.cases.push('Ready requirement remains editable and shows authoritative 1/4 lifecycle');

    await click('.rq-detail-more>summary');
    await click('[data-rq-comments-open]');
    await until(`document.querySelector('[data-rq-comment-list]')?.textContent.includes('版本 '+traceRevision)`, 'activity evidence');
    await js(`document.querySelector('.rq-evidence-modal .rq-detail-modal-body').scrollTop+=900;void 0`);
    const beforeTrace = await snapshot('before-trace-event');
    await js(`traceRevision++;window.dispatchEvent(new CustomEvent('soduwork-requirement-comment',{detail:{taskId:'lifecycle'}}));void 0`);
    await until(`document.querySelector('[data-rq-comment-list]')?.textContent.includes('版本 '+traceRevision)`, 'trace event');
    const afterTrace = await snapshot('after-trace-event');
    assert.equal(afterTrace.timeline, true); assert.equal(afterTrace.outer, true);
    assert.ok(Math.abs(afterTrace.top - beforeTrace.top) <= 2, 'trace-only refresh preserves reading position');
    assert.ok(Math.abs(afterTrace.evidenceTop - beforeTrace.evidenceTop) <= 2, 'activity refresh preserves reading position');
    report.cases.push('Task event refreshes real trace runtime while retaining expanded evidence and scroll');

    const beforeDoing = await snapshot('before-doing');
    await js(`setPhase('doing');notifyTaskChange()`);
    await until(`document.querySelector('.tfd-hero h3')?.textContent==='执行工作'`, 'doing lifecycle');
    const doing = await snapshot('doing');
    assert.equal(doing.edit, false); assert.equal(doing.submit, false); assert.equal(doing.materials, true);
    assert.equal(doing.file, '需求背景与验收依据.md'); assert.equal(doing.outer, true);
    verify(doing.timeline === true, 'detail refresh retains the open activity evidence panel');
    verify(Math.abs(doing.top - beforeDoing.top) <= 2, 'detail refresh preserves reading position');
    await click('[data-rq-evidence-close]');
    await shotHero('doing');
    report.cases.push('Running execution removes editing and premature submission while retaining materials and evidence');

    await js(`tasks[0].maintenanceBlocked=false;notifyTaskChange()`);
    await until(`!!document.querySelector('[data-rq-submit-review]')`, 'stopped execution can submit');
    assert.equal(await js(`!!document.querySelector('[data-rq-edit]')`), false);

    await js(`window.manualDrawer=document.querySelector('.rq-detail-backdrop');
      window.acceptManualReview=SoduWorkAPI.submitTaskReview;
      SoduWorkAPI.submitTaskReview=id=>{fixtureCalls.push(['submit-review-attempt',id]);
        return new Promise((resolve,reject)=>{window.pendingManualReview={id,resolve,reject}})};void 0`);
    await click('.rq-detail-more>summary');
    await click('[data-rq-submit-review]', false, 2);
    await until(`!!window.pendingManualReview`, 'one manual review request');
    assert.equal(await js(`document.querySelector('[data-rq-submit-review]').disabled`), true);
    assert.equal(await js(`fixtureCalls.filter(x=>x[0]==='submit-review-attempt').length`), 1);
    await js(`pendingManualReview.reject(new Error('Submission unavailable'));void 0`);
    await until(`document.querySelector('[data-rq-error]')?.textContent.includes('Submission unavailable')`, 'manual review failure');
    assert.equal(await js(`document.querySelector('.rq-detail-backdrop')===manualDrawer`), true);
    assert.equal(await js(`document.querySelector('[data-rq-submit-review]').disabled`), false);
    report.cases.push('Native double click sends one manual submission; a rejected request keeps the same details, error and retry action');

    await js(`window.originalBoardRefresh=RequirementsBoard.refresh;
      RequirementsBoard.refresh=()=>new Promise(resolve=>{window.finishManualRefresh=async()=>{
        await originalBoardRefresh();window.manualRefreshFinished=true;resolve()}});void 0`);
    await click('.rq-detail-more>summary');
    await click('[data-rq-submit-review]', false, 2);
    assert.equal(await js(`fixtureCalls.filter(x=>x[0]==='submit-review-attempt').length`), 2);
    await js(`acceptManualReview(pendingManualReview.id).then(pendingManualReview.resolve);void 0`);
    await until(`!document.querySelector('.rq-detail-backdrop')`, 'accepted manual review closes its details');
    assert.equal(await js(`typeof finishManualRefresh`), 'function');
    assert.equal(await js(`!!window.manualRefreshFinished`), false);
    assert.equal(await js(`fixtureCalls.filter(x=>x[0]==='submit-review').length`), 1);
    await click('[data-rq-open="lifecycle"]');
    await until(`document.querySelector('.rq-delivery-state')?.textContent==='待验收'`, 'manual review submission');
    await js(`window.reviewingDrawer=document.querySelector('.rq-detail-backdrop');finishManualRefresh();void 0`);
    await until(`window.manualRefreshFinished===true`, 'delayed board refresh');
    assert.equal(await js(`document.querySelector('.rq-detail-backdrop')===reviewingDrawer`), true);
    await js(`RequirementsBoard.refresh=originalBoardRefresh;SoduWorkAPI.submitTaskReview=acceptManualReview;void 0`);
    await click('[data-rq-execution]>summary');
    await until(`document.querySelector('.tfd-hero h3')?.textContent==='等待验收'`, 'reviewing lifecycle');
    const reviewing = await snapshot('reviewing');
    assert.equal(reviewing.edit, false); assert.equal(reviewing.chat, false); assert.equal(reviewing.submit, false);
    assert.equal(reviewing.progress, '流程进度 2/4');
    assert.equal(await js(`fixtureCalls.filter(x=>x[0]==='submit-review').length`), 1);
    await shotHero('reviewing');
    report.cases.push('Accepted manual submission closes before list refresh; reopening shows reviewing without edit or generic execution-chat entry and a late refresh preserves the new drawer');
    // Simulate delayed controls from a stale rendered snapshot; handlers must recheck the current DTO.
    await js(`document.querySelector('.rq-detail-actions').append(staleEdit);
      const staleChat=document.createElement('button');staleChat.dataset.rqChat='';staleChat.textContent='过期会话入口';
      document.querySelector('.rq-detail-actions').append(staleChat);void 0`);
    await click('.rq-detail [data-rq-edit]');
    assert.equal(await js(`!!document.querySelector('#rqEditForm')`), false);
    await click('.rq-detail [data-rq-chat]');
    assert.equal(await js(`fixtureCalls.filter(x=>x[0]==='chat').length`), 0);
    await js(`document.querySelector('.rq-detail [data-rq-edit]').remove();document.querySelector('.rq-detail [data-rq-chat]').remove();void 0`);
    report.cases.push('Native clicks on stale edit/chat controls are rejected using the latest requirement state');

    await js(`setPhase('done');notifyTaskChange()`);
    await until(`document.querySelector('.tfd-hero h3')?.textContent==='需求已完成'`, 'completed lifecycle');
    const done = await snapshot('done');
    assert.equal(done.progress, '流程进度 4/4'); assert.equal(done.delivery, '已验收'); assert.equal(done.edit, false);
    assert.match(done.progressText, /已完成\s+4\s*\/\s*4\s*阶段/);
    await shotHero('done');
    report.cases.push('Accepted completion shows 4/4 lifecycle independently of underlying 1/9 execution evidence');

    await js(`RequirementsDetail.close(true);setPhase('ready');RequirementsDetail.open('lifecycle')`);
    await click('[data-rq-edit]');
    await click('#rqEditForm [name=title]');
    // Offscreen macOS windows do not dispatch native menu accelerators.
    // Use Chromium's edit command, then insert text through the native input path.
    win.webContents.selectAll();
    win.webContents.insertText('尚未保存的需求草稿');
    await wait(80);
    assert.equal(await js(`document.querySelector('#rqEditForm [name=title]').value`), '尚未保存的需求草稿');
    const activeSaveBackground = await js(`getComputedStyle(document.querySelector('[form=rqEditForm][type=submit]')).backgroundColor`);
    await js(`window.originalForm=document.querySelector('#rqEditForm');setPhase('doing');notifyTaskChange()`);
    const draft = await js(`(()=>{const f=document.querySelector('#rqEditForm');return{
      same:f===originalForm,title:f.elements.title.value,controls:[...f.querySelectorAll('input,textarea,select')].every(n=>n.disabled),
      save:document.querySelector('[form=rqEditForm][type=submit]').disabled,error:document.querySelector('[data-rq-error]').textContent,
      header:document.querySelector('[data-rq-header-meta]').textContent,eyebrow:document.querySelector('.rq-detail-eyebrow').textContent,
      saveText:document.querySelector('[form=rqEditForm][type=submit]').textContent,
      background:getComputedStyle(document.querySelector('[form=rqEditForm][type=submit]')).backgroundColor,
      opacity:Number(getComputedStyle(document.querySelector('[form=rqEditForm][type=submit]')).opacity)}})()`);
    report.draft = draft;
    assert.equal(draft.same, true); assert.equal(draft.title, '尚未保存的需求草稿');
    assert.equal(draft.controls, true); assert.equal(draft.save, true); assert.match(draft.error, /已开始执行/);
    assert.match(draft.header, /进行中/); assert.match(draft.eyebrow, /已锁定/);
    assert.equal(draft.saveText, '不可编辑'); assert.notEqual(draft.background, activeSaveBackground); assert.ok(draft.opacity < 1);
    await click('[form=rqEditForm][type=submit]', true);
    await js(`originalForm.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));void 0`);
    assert.equal(await js(`fixtureCalls.filter(x=>x[0]==='patch').length`), 0);
    await shot('draft-locked');
    report.cases.push('Execution start locks the original form and save, preserves native typed draft, and rejects delayed submit');
    await click('[data-rq-edit-cancel]');
    assert.equal(await js(`document.querySelector('[data-rq-confirm]').hidden`), false);
    await click('[data-rq-confirm-cancel]');
    assert.equal(await js(`document.querySelector('#rqEditForm [name=title]').value`), '尚未保存的需求草稿');
    await click('[data-rq-edit-cancel]'); await click('[data-rq-confirm-discard]');
    assert.equal(await js(`!!document.querySelector('#rqEditForm')`), false);
    assert.equal(await js(`fixtureCalls.filter(x=>x[0]==='patch'||x[0]==='chat').length`), 0);
    report.cases.push('Locked draft still supports keep/discard confirmation without API writes or conversation navigation');

    await js(`RequirementsDetail.close(true);setPhase('ready');RequirementsDetail.open('lifecycle')`);
    await click('[data-rq-edit]'); await click('#rqEditForm [name=title]');
    win.webContents.insertText('保存期间的草稿');
    await js(`SoduWorkAPI.patchTask=(id,patch)=>{fixtureCalls.push(['patch',id,patch]);
      return new Promise((_resolve,reject)=>{window.rejectPendingSave=reject})};void 0`);
    await click('[form=rqEditForm][type=submit]');
    await until(`typeof rejectPendingSave==='function'`, 'pending save request');
    const pendingDraft = await js(`document.querySelector('#rqEditForm [name=title]').value`);
    await js(`setPhase('doing');notifyTaskChange()`);
    await js(`rejectPendingSave(Object.assign(new Error('需求已开始执行，不能再编辑。'),{status:409}));void 0`);
    await until(`document.querySelector('[data-rq-error]')?.textContent.includes('已开始执行')`, 'server conflict feedback');
    const rejected = await js(`(()=>{const f=document.querySelector('#rqEditForm');return{
      title:f.elements.title.value,locked:[...f.querySelectorAll('input,textarea,select')].every(n=>n.disabled),
      save:document.querySelector('[form=rqEditForm][type=submit]').disabled,
      writes:fixtureCalls.filter(x=>x[0]==='patch').length}})()`);
    report.pendingSave = rejected;
    assert.equal(rejected.title, pendingDraft); assert.equal(rejected.locked, true); assert.equal(rejected.save, true);
    assert.equal(rejected.writes, 1);
    await click('[form=rqEditForm][type=submit]', true);
    assert.equal(await js(`fixtureCalls.filter(x=>x[0]==='patch').length`), 1);
    report.cases.push('A pending save rejected after execution starts keeps draft controls locked and cannot issue another write');

    await js(`RequirementsDetail.close(true);setPhase('doing');Object.assign(tasks[0],{
      maintenanceBlocked:false,canContinueExecution:true,canSubmitReview:false,ai:{state:'done'},
      workRouting:{conversationTurn:{state:'completed'},reworkPending:{state:'awaiting_executor',feedback:'补充结尾'}}
    });RequirementsBoard.render(true);RequirementsDetail.open('lifecycle')`);
    await until(`!!document.querySelector('[data-rq-rework]')`, 'executor rework entry');
    assert.equal(await js(`Requirements.inScope(tasks[0],'actionable',{})`), true);
    for (let index = 0; index < 3; index++) await js(`notifyTaskChange()`);
    assert.equal(await js(`!!document.querySelector('[data-rq-rework]')`), true);
    assert.equal(await js(`fixtureCalls.filter(x=>x[0]==='chat').length`), 0);
    await click('[data-rq-rework]');
    const reworkCalls = await js(`fixtureCalls.filter(x=>x[0]==='chat')`);
    assert.equal(reworkCalls.length, 1);
    assert.equal(reworkCalls[0][1], 'lifecycle');
    assert.equal(reworkCalls[0][2].reworkSession, true);
    assert.equal(reworkCalls[0][2].forceNew, false);
    await js(`tasks[0].canContinueExecution=false;RequirementsDetail.open('lifecycle')`);
    await until(`!!document.querySelector('.rq-rework-pending')`, 'reviewer can read feedback');
    assert.equal(await js(`!!document.querySelector('[data-rq-rework]')`), false);
    report.cases.push('Rejected work stays actionable across refreshes, starts only on the executor click, and hides continuation from reviewers');

    await js(`RequirementsDetail.close(true);setPhase('doing');Object.assign(tasks[0],{
      maintenanceBlocked:false,canContinueExecution:false,workRouting:{},ai:{state:'done'}});
      SoduWorkAPI.submitTaskReview=async()=>({ok:true,already:true});RequirementsDetail.open('lifecycle')`);
    await click('.rq-detail-more>summary');
    await click('[data-rq-submit-review]');
    await until(`!document.querySelector('.rq-detail-backdrop')`, 'already-submitted receipt closes details');
    assert.equal(await js(`fixtureCalls.some(x=>x[0]==='notice'&&x[1].includes('已经在待验收'))`), true);
    report.cases.push('An idempotent already-submitted receipt closes the original drawer and explains the pending review');

    await js(`SoduWorkAPI.submitTaskReview=()=>new Promise(resolve=>{window.finishStaleReview=resolve});
      tasks.push({...structuredClone(tasks[0]),id:'next-requirement',title:'Another requirement'});
      RequirementsDetail.open('lifecycle')`);
    await click('.rq-detail-more>summary');
    await click('[data-rq-submit-review]');
    await until(`typeof finishStaleReview==='function'`, 'delayed manual submission');
    await js(`RequirementsDetail.open('next-requirement')`);
    await until(`document.querySelector('.rq-detail-content')?.dataset.taskId==='next-requirement'`, 'next requirement detail');
    await js(`window.nextDrawer=document.querySelector('.rq-detail-backdrop');finishStaleReview({ok:true});void 0`);
    await wait(80);
    assert.equal(await js(`document.querySelector('.rq-detail-backdrop')===nextDrawer`), true);
    assert.equal(await js(`document.querySelector('#rqDetailTitle').textContent`), 'Another requirement');
    report.cases.push('A response to a submission from a replaced drawer cannot close or reopen the new requirement');
    assert.deepEqual(await js('fixtureErrors'), []); assert.deepEqual(report.errors, []);
    assert.deepEqual(report.failures, []);
    report.ok = true;
  } catch (error) {
    report.error = String(error.stack || error);
    if (win) await shot('failure');
  } finally {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ok: report.ok, cases: report.cases, error: report.error, errors: report.errors}));
    app.exit(report.ok ? 0 : 1);
  }
});
