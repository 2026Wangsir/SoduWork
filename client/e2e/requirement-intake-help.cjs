'use strict';
// Production board/CSS with pointer navigation and synthetic task responses.
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
fs.mkdirSync(output,{recursive:true});app.setPath('userData',fs.mkdtempSync(path.join(os.tmpdir(),'soduwork-intake-help-')));
app.disableHardwareAcceleration();
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));let win;
const report={ok:false,checks:[],layouts:[],boundary:'Real Electron production renderer/CSS, DOM localization and pointer navigation; synthetic task APIs, no real accounts or server authorization changes.'};
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
    const shot=async name=>fs.writeFileSync(path.join(output,name+'.png'),(await win.webContents.capturePage()).toPNG());
    await win.loadFile(path.join(__dirname,'fixtures/requirements-board.html'));await wait(150);
    await js(`tasks=['intake','clarifying','ready'].map(triageStage=>({id:triageStage,title:{intake:'整理业务需求与客户背景',clarifying:'确认报表口径和完成标准',ready:'准备安排的需求'}[triageStage],
      status:'todo',triageStage,myRoles:['creator','executor'],readOnly:false,canEditRequirement:true,canViewExecution:true,requirementVersion:1,kind:triageStage==='clarifying'?'bug':'requirement'}));
      fixtureApprovals=[];RequirementsBoard.render(true);void 0`);
    await click('.rq-scopes [data-rq-scope=related]');
    const original=await js('JSON.stringify(tasks)');
    const hint='待整理的需求；“待补充”表示仍需完善背景或完成标准';
    assert.equal(await js("document.querySelector('[data-rq-lane=intake] .rq-lane-hint').textContent"),hint);
    assert.equal(await js("document.querySelector('[data-rq-lane=intake] .rq-lane-title>span').textContent"),'收集箱');
    assert.equal(await js("document.querySelector('[data-rq-lane=intake] .rq-lane-title>em').textContent"),'2');
    assert.deepEqual(await js("[...document.querySelectorAll('#rqLane-intake [data-hbid]')].map(n=>n.dataset.hbid).sort()"),['clarifying','intake']);
    assert.equal(await js("document.querySelector('[data-hbid=clarifying] .rq-flag').textContent"),'待补充');
    assert.equal(await js("document.querySelector('[data-rq-lane=clarifying]')===null"),true);
    assert.equal(await js("document.querySelector('#rqScopeHint').hidden"),true);
    report.checks.push('Inbox retains both intake and clarification issues, its existing count and clarification badge; the approved description explains their relationship without adding a column or a scope banner');
    for(const file of [...JSON.parse(fs.readFileSync(path.join(client,'core/locales/manifest.json'),'utf8')).map(name=>'core/locales/'+name),'core/i18n-dom.js','core/i18n.js'])
      await js(fs.readFileSync(path.join(client,file),'utf8')+'\nvoid 0;');
    for(const locale of ['zh-CN','en-US','ja-JP','ko-KR'])for(const width of [1440,480]){
      win.setContentSize(width,1000);await js(`SoduWorkI18n.setLocale(${JSON.stringify(locale)})`);await wait(120);
      const geometry=await js(`(()=>{const n=document.querySelector('[data-rq-lane=intake] .rq-lane-hint'),r=n.getBoundingClientRect();
        const heading=n.closest('.rq-lane-head').getBoundingClientRect(),lane=n.closest('.rq-lane').getBoundingClientRect(),card=document.querySelector('#rqLane-intake .rq-card').getBoundingClientRect();
        const range=document.createRange();range.selectNodeContents(n);const lineCount=range.getClientRects().length;
        return{text:n.textContent,title:document.querySelector('[data-rq-lane=intake] .rq-lane-title').title,
          whiteSpace:getComputedStyle(n).whiteSpace,otherWhiteSpace:getComputedStyle(document.querySelector('[data-rq-lane=ready] .rq-lane-hint')).whiteSpace,
          lineCount,notClipped:n.scrollWidth<=n.clientWidth+1&&n.scrollHeight<=n.clientHeight+1,
          withinHeader:r.left>=heading.left&&r.right<=heading.right+1&&r.top>=heading.top&&r.bottom<=heading.bottom+1,
          withinViewport:r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight,
          beforeCards:r.bottom<=card.top,withinLane:r.right<=lane.right+1,hit:n.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)),
          outerOverflow:document.documentElement.scrollWidth>innerWidth+1};})()`);
      assert.equal(geometry.text,await js(`SoduWorkI18n.translateText(${JSON.stringify(hint)})`));
      assert.equal(geometry.title,geometry.text);assert.equal(geometry.whiteSpace,'normal');assert.equal(geometry.otherWhiteSpace,'nowrap');
      assert.ok(geometry.lineCount>1,JSON.stringify(geometry));
      for(const key of ['notClipped','withinHeader','withinViewport','beforeCards','withinLane','hit'])assert.equal(geometry[key],true,key+': '+JSON.stringify(geometry));
      assert.equal(geometry.outerOverflow,false);report.layouts.push({locale,width,...geometry});
      if(locale==='zh-CN'||locale==='en-US')await shot('intake-'+locale+'-'+width);
    }
    report.checks.push('All four locales wrap only the Inbox explanation at desktop and narrow widths; full text stays visible, unobstructed and above the cards');
    win.setContentSize(1440,1000);await js("SoduWorkI18n.setLocale('zh-CN')");await wait(100);
    assert.deepEqual(await js("tasks.filter(t=>t.id!=='ready').map(t=>({id:t.id,stage:Requirements.stage(t),column:Requirements.column(t),canOpen:Requirements.canOpenConversation(t,'fixture-device'),canStart:ChatTaskController.isPickableTask(t)}))"),
      [{id:'intake',stage:'intake',column:'intake',canOpen:false,canStart:false},{id:'clarifying',stage:'clarifying',column:'intake',canOpen:false,canStart:false}]);
    assert.equal(await js("document.querySelectorAll('#rqLane-intake [data-rq-assign]').length"),0);
    await click('[data-rq-view=list]');
    assert.equal(await js("document.querySelectorAll('.rq-table tbody tr').length"),3);
    assert.equal(await js("document.querySelector('tr[data-hbid=clarifying] .rq-flag').textContent"),'待补充');
    assert.equal(await js('JSON.stringify(tasks)'),original);assert.deepEqual(await js('fixtureErrors'),[]);
    assert.equal(await js("fixtureCalls.some(row=>['patch','submit-review','review','assign'].includes(row[0]))"),false);
    report.checks.push('The same clarification state remains in list view, neither collected state gains execution access, and navigation/localization performs no write');
    report.ok=true;
  }catch(error){report.error=String(error.stack||error);if(win)fs.writeFileSync(path.join(output,'failure.png'),(await win.webContents.capturePage()).toPNG());}
  finally{fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));win?.destroy();app.exit(report.ok?0:1);}
});
