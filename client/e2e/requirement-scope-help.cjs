'use strict';
// Production board and pointer navigation with synthetic task/approval responses.
const electron=require('electron');
if(typeof electron==='string'){
  const env={...process.env};
  for(const key of ['ELECTRON_RUN_AS_NODE','NODE_OPTIONS','ELECTRON_NO_ATTACH_CONSOLE'])delete env[key];
  const result=require('node:child_process').spawnSync(electron,[__filename,...process.argv.slice(2),'--force-device-scale-factor=1'],
    {env,stdio:'inherit',windowsHide:true,timeout:90000});
  process.exit(result.status??1);
}
const {app,BrowserWindow}=electron;
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const output=process.argv[2],client=path.resolve(__dirname,'..');
if(!output||!path.isAbsolute(output))throw Error('Absolute evidence directory required');
fs.mkdirSync(output,{recursive:true});app.setPath('userData',fs.mkdtempSync(path.join(os.tmpdir(),'soduwork-scope-help-')));
app.disableHardwareAcceleration();
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));let win;
const report={ok:false,checks:[],boundary:'Real Electron production renderer/CSS and pointer scope navigation; synthetic task/approval APIs. Native title attributes verified; OS tooltip popup and server authorization are not exercised.'};
app.whenReady().then(async()=>{
  try{
    win=new BrowserWindow({show:false,width:1440,height:1000,webPreferences:{offscreen:true,contextIsolation:true,sandbox:true}});
    win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_request,done)=>done({cancel:true}));
    const js=source=>win.webContents.executeJavaScript(source,true);
    const click=async selector=>{
      const point=await js(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n||n.disabled)throw Error('Unavailable control');
        n.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});const r=n.getBoundingClientRect(),x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2);
        if(!r.width||!r.height||!n.contains(document.elementFromPoint(x,y)))throw Error('Covered control');return{x,y};})()`);
      for(const type of ['mouseMove','mouseDown','mouseUp'])win.webContents.sendInputEvent({type,...point,...(type==='mouseMove'?{}:{button:'left',clickCount:1})});
      await wait(100);
    };
    const shot=async name=>{fs.writeFileSync(path.join(output,name+'.png'),(await win.webContents.capturePage()).toPNG());};
    const ids=()=>js(`[...document.querySelectorAll('.hb-body [data-hbid]')].map(n=>n.dataset.hbid).sort()`);
    const count=()=>js("document.querySelector('#hbCount').textContent");
    const title=selector=>js(`document.querySelector(${JSON.stringify(selector)}).title`);
    await win.loadFile(path.join(__dirname,'fixtures/requirements-board.html'));await wait(150);
    await js(`tasks=[
      {id:'created',title:'Created by me',status:'todo',myRoles:['creator']},
      {id:'assigned',title:'Assigned to me',status:'todo',myRoles:['assignee']},
      {id:'running',title:'Active execution',status:'doing',myRoles:['assignee'],ai:{state:'running'}},
      {id:'shared',title:'Shared content only',status:'todo',myRoles:[],canViewExecution:false},
      {id:'review',title:'Awaiting my decision',status:'doing',requirementStage:'reviewing',myRoles:[],canReview:true},
      {id:'archived',title:'Archived related issue',status:'done',archivedAt:1,myRoles:['creator']},
      {id:'cancelled',title:'Canceled visible issue',status:'cancel',myRoles:[]},
      {id:'conversation',title:'Ordinary conversation',status:'doing',origin:'cloud-conversation',myRoles:['creator']}];
      fixtureApprovals=[{taskId:'review',id:'approval',action:'review'}];RequirementsBoard.render(true);void 0`);
    const expected={related:['assigned','created','review','running'],actionable:['assigned','review'],created:['created'],all:['assigned','created','review','running','shared']};
    for(const [scope,rows] of Object.entries(expected)){
      await click('.rq-scopes [data-rq-scope="'+scope+'"]');
      assert.deepEqual(await ids(),rows);assert.equal(await count(),'· '+rows.length+' 条');
      const badges=await js(`Object.fromEntries([...document.querySelectorAll('.rq-scopes [data-rq-scope]')].map(n=>[n.dataset.rqScope,Number(n.querySelector('b').textContent)]))`);
      assert.deepEqual(badges,{related:4,actionable:2,created:1,all:5});
      assert.equal(await js("document.querySelector('#rqScopeHint')"),null);
      if(['related','all'].includes(scope))assert.equal(await title('#rqScope'),await title('.rq-scopes [data-rq-scope="'+scope+'"]'));
    }
    assert.equal(await js("document.querySelector('.rq-scopes [data-rq-scope=all]').firstChild.textContent"),'全部可见');
    assert.match(await title('.rq-scopes [data-rq-scope=related]'),/仓库成员/);
    assert.match(await title('.rq-scopes [data-rq-scope=all]'),/有权查看/);
    assert.match(await title('#hbApprovalInbox'),/交付验收/);assert.match(await title('#rqArchiveEntry'),/已归档或已取消/);
    await shot('all-visible-wide');
    await click('#hbApprovalInbox');assert.equal(await js("fixtureCalls.filter(row=>row[0]==='approval').length"),1);
    report.checks.push('Every current scope retains its exact rows and badge counts; company-shared content appears only in All visible, active work stays related, and approval navigation is unchanged');
    await click('#rqArchiveEntry');assert.deepEqual(await ids(),['archived','cancelled']);assert.equal(await count(),'· 已归档 · 2 条');
    assert.match(await title('#rqArchiveEntry'),/返回/);
    await click('.rq-scopes [data-rq-scope=related]');assert.deepEqual(await ids(),['archived']);assert.equal(await count(),'· 已归档 · 1 条');
    assert.equal(await js("document.querySelector('#rqScopeHint')"),null);
    await shot('archived-related');await click('#rqArchiveEntry');
    report.checks.push('Archive keeps only related/all scopes, includes canceled records as before, and changes its tooltip to the return action');
    for(const file of [...JSON.parse(fs.readFileSync(path.join(client,'core/locales/manifest.json'),'utf8')).map(name=>'core/locales/'+name),'core/i18n-dom.js','core/i18n.js'])
      await js(fs.readFileSync(path.join(client,file),'utf8')+'\nvoid 0;');
    for(const locale of ['en-US','ja-JP','ko-KR','zh-CN']){
      await js(`SoduWorkI18n.setLocale(${JSON.stringify(locale)})`);await wait(80);
      for(const scope of ['related','all']){
        await click('.rq-scopes [data-rq-scope="'+scope+'"]');assert.deepEqual(await ids(),expected[scope]);
        assert.equal(await title('#rqScope'),await js(`SoduWorkI18n.translateText(Requirements.scopeDescriptions['${scope}'])`));
        assert.equal(await title('.rq-scopes [data-rq-scope="'+scope+'"]'),await title('#rqScope'));
      }
      assert.equal(await js("document.querySelector('.rq-scopes [data-rq-scope=all]').firstChild.textContent"),await js("SoduWorkI18n.translateText('全部可见')"));
      assert.equal(await title('#hbApprovalInbox'),await js("SoduWorkI18n.translateText('查看当前需要我确认的需求、交付验收、合并、环境验收或发布事项。')"));
      assert.equal(await title('#rqArchiveEntry'),await js("SoduWorkI18n.translateText('查看已归档或已取消的需求；它们不再显示在当前需求池中。')"));
      await click('#rqArchiveEntry');assert.deepEqual(await ids(),['archived','cancelled']);
      assert.equal(await title('#rqArchiveEntry'),await js("SoduWorkI18n.translateText('返回未归档且未取消的当前需求。')"));
      await click('#rqArchiveEntry');assert.deepEqual(await ids(),expected.all);
    }
    report.checks.push('All four runtime locales translate the scope titles and All visible label while selection values and results stay unchanged');
    await click('.rq-scopes [data-rq-scope=related]');win.setContentSize(480,1000);await wait(150);
    assert.equal(await js('document.documentElement.scrollWidth<=innerWidth+1'),true);
    assert.equal(await js("document.querySelector('#rqScope').getClientRects().length>0"),true);
    assert.match(await title('#rqScope'),/仓库成员/);assert.equal(await js("document.querySelector('#rqScopeHint')"),null);
    await shot('related-narrow');
    assert.deepEqual(await js('fixtureErrors'),[]);assert.equal(await js("fixtureCalls.some(row=>['patch','submit-review','review'].includes(row[0]))"),false);
    report.checks.push('Narrow layout keeps the selected-scope tooltip without a scope banner or horizontal overflow; no write occurs');
    report.ok=true;
  }catch(error){report.error=String(error.stack||error);if(win)fs.writeFileSync(path.join(output,'failure.png'),(await win.webContents.capturePage()).toPNG());}
  finally{fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));win?.destroy();app.exit(report.ok?0:1);}
});
