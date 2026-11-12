'use strict';
// Exercise production board submission and review routing with isolated Hub projections.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = {...process.env};
  for (const key of ['ELECTRON_RUN_AS_NODE','NODE_OPTIONS','ELECTRON_NO_ATTACH_CONSOLE']) delete env[key];
  const result = require('node:child_process').spawnSync(electron,[__filename,...process.argv.slice(2),'--force-device-scale-factor=1'],
    {env,windowsHide:true,stdio:'inherit',timeout:90000});
  process.exit(result.status ?? 1);
}
const {app,BrowserWindow} = electron;
const fs = require('node:fs'),path = require('node:path'),os = require('node:os'),assert = require('node:assert/strict');
const output = process.argv[2];
if (!output || !path.isAbsolute(output)) throw Error('An absolute evidence directory is required');
fs.mkdirSync(output,{recursive:true});
app.setPath('userData',fs.mkdtempSync(path.join(os.tmpdir(),'soduwork-review-scope-')));
app.disableHardwareAcceleration();
const report = {ok:false,checks:[],boundary:'Real Electron clicks and production board/detail; synthetic Hub submission and permissions, no model calls or production accounts'};
const delay = ms => new Promise(resolve=>setTimeout(resolve,ms));
let win;
app.whenReady().then(async()=>{
  try {
    win = new BrowserWindow({show:false,width:1600,height:1000,webPreferences:{contextIsolation:true,sandbox:true,offscreen:true}});
    win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_request,done)=>done({cancel:true}));
    const js = source => win.webContents.executeJavaScript(source,true);
    const until = async (source,label) => {
      for(let i=0;i<60;i++) {if(await js(source))return;await delay(50);}
      throw Error('Timed out: '+label);
    };
    const click = async selector => {
      const point = await js(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n||n.disabled)throw Error('Unavailable control');
        n.scrollIntoView({block:'center',behavior:'instant'});const b=n.getBoundingClientRect();if(!b.width||!b.height)throw Error('Hidden control');
        return{x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)}})()`);
      for(const type of ['mouseDown','mouseUp'])win.webContents.sendInputEvent({type,...point,button:'left',clickCount:1});
      await delay(80);
    };
    const ids = () => js("[...document.querySelectorAll('.hb-body [data-hbid]')].map(n=>n.dataset.hbid).sort()");
    const screenshot = async name => {
      await delay(80);fs.writeFileSync(path.join(output,name+'.png'),(await win.webContents.capturePage()).toPNG());
    };
    await win.loadFile(path.join(__dirname,'fixtures/requirements-board.html'));
    await js(`(()=>{
      const base={status:'doing',requirementStage:'reviewing',myRoles:['assignee','executor'],canViewExecution:true,
        canReview:false,canEditRequirement:false,assigneeName:'合成执行人',canSubmitReview:false,requirementVersion:1,
        createdAt:Date.now(),updatedAt:Date.now()};
      tasks=[{...base,id:'submitted-manual',title:'手工交付已提交验收'},
        {...base,id:'submitted-agent',title:'智能体交付已提交验收',ai:{state:'done'}},
        {...base,id:'submitted-legacy',title:'旧版已提交记录',status:'done'},
        {...base,id:'manual-submit',title:'手工完成，待本人提交验收',requirementStage:'delivering',canSubmitReview:true},
        {...base,id:'ordinary-manual',title:'仍需本人完成的手动工作',requirementStage:'delivering'},
        {...base,id:'own-review',title:'当前轮到本人验收',myRoles:['creator'],canReview:true,ai:{state:'done'}},
        {...base,id:'attention-review',title:'已提交但有明确关注事项',ai:{state:'done',attentionRaised:true}},
        {...base,id:'explicit-request',title:'已提交但明确需要本人处理',needsMe:true},
        {...base,id:'unrelated',title:'其他人的交付验收',myRoles:[]}];
      fixtureApprovals=[{taskId:'own-review',id:'own-gate',action:'review'},
        {taskId:'submitted-manual',id:'stale-gate',action:'review'}];
      window.beforeReviewRows=JSON.stringify(tasks);RequirementsBoard.render(true);
    })()`);
    const personal=['attention-review','explicit-request','manual-submit','ordinary-manual','own-review'];
    assert.deepEqual(await ids(),personal);
    assert.match(await js("document.querySelector('#rqScopeHint').textContent"),/已提交验收的需求仍保留在“与我相关”/);
    assert.equal(await js('JSON.stringify(tasks)===beforeReviewRows'),true);
    report.checks.push('Submitted manual, agent and legacy deliveries leave executor actions; pending personal review, manual submission and explicit attention remain');

    await click('[data-rq-actions="manual-submit"]');
    await click('[data-rq-move="manual-submit"][data-rq-target="reviewing"]');
    await until("tasks.find(row=>row.id==='manual-submit').requirementStage==='reviewing'&&!document.querySelector('.hb-body [data-hbid=manual-submit]')",'submitted item leaves personal actions');
    assert.equal(await js("tasks.find(row=>row.id==='manual-submit').status"),'doing');
    assert.deepEqual(await ids(),personal.filter(id=>id!=='manual-submit'));
    assert.deepEqual(await js("fixtureCalls.filter(row=>row[0]==='submit-review')"),[['submit-review','manual-submit']]);
    await screenshot('after-manual-submission');
    report.checks.push('The production board submit action runs once and removes a doing task from personal actions after the Hub projection enters reviewing');

    await click('#rqScopeHint [data-rq-scope="related"]');
    const related=[...personal,'submitted-agent','submitted-legacy','submitted-manual'].sort();
    assert.deepEqual(await ids(),related);
    await click('.hb-body [data-rq-open="manual-submit"]');
    await until("!!document.querySelector('.rq-detail-next')",'submitted detail opens');
    assert.match(await js("document.querySelector('.rq-detail-next').textContent"),/已提交验收，等待验收人处理/);
    assert.equal(await js("document.querySelectorAll('[data-rq-submit-review],[data-tfd-approval-action]').length"),0);
    await screenshot('submitted-review-destination');
    await click('[data-rq-dismiss]');
    await click('[data-rq-view="list"]');
    assert.deepEqual(await ids(),related);
    assert.match(await js("document.querySelector('[data-hbid=manual-submit] .rq-stage').textContent"),/待验收/);
    report.checks.push('Related board and list retain the submitted item; its existing detail hint names the reviewer without exposing resubmission or acceptance controls');

    await click('.rq-scopes [data-rq-scope="actionable"]');
    await js("Object.assign(tasks.find(row=>row.id==='manual-submit'),{requirementStage:'delivering',canSubmitReview:false,canContinueExecution:true,workRouting:{reworkPending:{feedback:'Revise'}}});RequirementsBoard.render(true)");
    assert.deepEqual(await ids(),personal);
    await js("fixtureIdentity='fixture:reviewer:tasks';tasks=[{...tasks.find(row=>row.id==='submitted-manual'),myRoles:['creator'],canReview:true}];fixtureApprovals=[];dispatchEvent(new Event('soduwork-data-scope-changed'))");
    assert.deepEqual(await ids(),['submitted-manual']);
    assert.deepEqual(await js("fixtureCalls.filter(row=>['patch','review','assign'].includes(row[0]))"),[]);
    assert.deepEqual(await js('fixtureErrors'),[]);
    report.checks.push('Returned rework becomes an executor action again; an account switch shows only the new reviewer projection even before the approval inbox refreshes');
    report.ok=true;
  }catch(error){
    report.error=String(error.stack||error);
    if(win&&!win.isDestroyed())fs.writeFileSync(path.join(output,'failure.png'),(await win.webContents.capturePage()).toPNG());
  }finally{
    fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify(report));win?.destroy();app.exit(report.ok?0:1);
  }
});
