'use strict';
// Production board components and styles in Electron, with isolated task projections.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = {...process.env};
  for (const key of ['ELECTRON_RUN_AS_NODE','NODE_OPTIONS','ELECTRON_NO_ATTACH_CONSOLE']) delete env[key];
  const result = require('node:child_process').spawnSync(electron,[__filename,...process.argv.slice(2),'--force-device-scale-factor=1'],
    {env,windowsHide:true,stdio:'inherit',timeout:90000});
  process.exit(result.status ?? 1);
}
const {app,BrowserWindow} = electron;
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict');
const output = process.argv[2];
if (!output || !path.isAbsolute(output)) throw Error('An absolute evidence directory is required');
fs.mkdirSync(output,{recursive:true});
app.setPath('userData',fs.mkdtempSync(path.join(os.tmpdir(),'soduwork-active-scope-')));
app.disableHardwareAcceleration();
const report = {ok:false,checks:[],boundary:'Real Electron clicks and production board; synthetic Hub task projections, no model calls or production accounts'};
const delay = ms => new Promise(resolve=>setTimeout(resolve,ms));
let win;
app.whenReady().then(async()=>{
  try {
    win = new BrowserWindow({show:false,width:1600,height:1000,webPreferences:{contextIsolation:true,sandbox:true,offscreen:true}});
    win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_request,done)=>done({cancel:true}));
    const js = source => win.webContents.executeJavaScript(source,true);
    const click = async selector => {
      const point = await js(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n||n.disabled)throw Error('Unavailable control');
        n.scrollIntoView({block:'center',behavior:'instant'});const b=n.getBoundingClientRect();if(!b.width||!b.height)throw Error('Hidden control');
        return{x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)}})()`);
      for (const type of ['mouseDown','mouseUp']) win.webContents.sendInputEvent({type,...point,button:'left',clickCount:1});
      await delay(80);
    };
    const ids = () => js("[...document.querySelectorAll('.hb-body [data-hbid]')].map(n=>n.dataset.hbid).sort()");
    const screenshot = async name => {
      await delay(80);fs.writeFileSync(path.join(output,name+'.png'),(await win.webContents.capturePage()).toPNG());
    };
    await win.loadFile(path.join(__dirname,'fixtures/requirements-board.html'));
    await js(`(()=>{
      const base={status:'doing',requirementStage:'delivering',myRoles:['assignee','executor'],canViewExecution:true,
        canEditRequirement:false,assigneeName:'合成执行人',canSubmitReview:false,createdAt:Date.now(),updatedAt:Date.now()};
      tasks=['queued','starting','dispatching','running','working','streaming'].map(state=>({...base,id:'active-'+state,title:'AI 状态 '+state,ai:{state,name:'Synthetic agent'}}));
      tasks.push({...base,id:'active-local',title:'本地会话执行中',workRouting:{conversationTurn:{state:'running'}}},
        {...base,id:'active-session',title:'已确认的运行会话仍在输出',ai:{state:'done',executionState:'streaming'}},
        {...base,id:'manual-work',title:'仍需本人完成的手动工作'},
        {...base,id:'manual-submit',title:'执行结束待本人提交',ai:{state:'done'},canSubmitReview:true},
        {...base,id:'attention',title:'执行需要本人确认',ai:{state:'queued',attentionRaised:true}},
        {...base,id:'approval',title:'当前轮到本人确认的关卡',ai:{state:'running'}},
        {...base,id:'unrelated',title:'其他人的执行',myRoles:[],ai:{state:'running'}});
      fixtureApprovals=[{taskId:'approval',id:'gate',action:'baseline'}];
      window.beforeScopeRows=JSON.stringify(tasks);RequirementsBoard.render(true);
    })()`);
    const personal = ['approval','attention','manual-submit','manual-work'];
    assert.deepEqual(await ids(),personal);
    assert.equal(await js("document.querySelector('#rqScopeHint')"),null);
    await screenshot('personal-actions');
    report.checks.push('Queued, streaming and local execution stay out of personal actions while actual decisions and manual follow-up remain; no scope banner is rendered');

    await click('.rq-scopes [data-rq-scope="related"]');
    const related = [...personal,...['queued','starting','dispatching','running','working','streaming','local','session'].map(state=>'active-'+state)].sort();
    assert.deepEqual(await ids(),related);
    assert.equal(await js("document.querySelector('#rqScope').value"),'related');
    await screenshot('related-execution');
    await click('[data-rq-view="list"]');
    assert.deepEqual(await ids(),related);
    assert.equal(await js('JSON.stringify(tasks)===beforeScopeRows'),true);
    assert.deepEqual(await js("fixtureCalls.filter(row=>['patch','submit-review','review','assign'].includes(row[0]))"),[]);
    report.checks.push('The related scope opens related work in board and list views without changing tasks or granting unrelated access');

    await click('.rq-scopes [data-rq-scope="actionable"]');
    await js("tasks.find(row=>row.id==='manual-work').workRouting={conversationTurn:{state:'queued'}};RequirementsBoard.render(true)");
    assert.deepEqual(await ids(),personal.filter(id=>id!=='manual-work'));
    await click('.rq-scopes [data-rq-scope="related"]');
    assert.ok((await ids()).includes('manual-work'));
    report.checks.push('A live start removes only the pending personal action and keeps the same task available in related work');

    await click('.rq-scopes [data-rq-scope="actionable"]');
    await js("tasks=tasks.filter(row=>row.id.startsWith('active-'));fixtureApprovals=[];RequirementsBoard.render(true)");
    assert.deepEqual(await ids(),[]);
    assert.match(await js("document.querySelector('.rq-empty').textContent"),/暂时没有需要你处理的需求/);
    win.setSize(640,900);await delay(100);
    assert.equal(await js("document.querySelector('#rqScopeHint')"),null);
    await screenshot('narrow-empty-personal-actions');
    await js("(()=>{const n=document.querySelector('#rqScope');n.value='related';n.dispatchEvent(new Event('change',{bubbles:true}));})()");
    assert.equal((await ids()).length,8);
    report.checks.push('An empty personal queue remains usable on a narrow viewport without rendering a scope banner');

    await js("fixtureIdentity='fixture:bob:tasks';tasks=[];fixtureApprovals=[];dispatchEvent(new Event('soduwork-data-scope-changed'))");
    assert.deepEqual(await ids(),[]);
    assert.deepEqual(await js('fixtureErrors'),[]);
    report.checks.push('Switching the fixture account clears the former account rows and scope state');
    report.ok=true;
  } catch(error) {
    report.error=String(error.stack||error);
    if(win&&!win.isDestroyed())fs.writeFileSync(path.join(output,'failure.png'),(await win.webContents.capturePage()).toPNG());
  } finally {
    fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify(report));win?.destroy();app.exit(report.ok?0:1);
  }
});
