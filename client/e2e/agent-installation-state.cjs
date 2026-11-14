'use strict';
// Exercise production cards, drawer and styles without contacting live services.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE',
    'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  require('node:child_process').spawn(electron, [__filename, ...process.argv.slice(2)], { env, windowsHide: true, stdio: 'inherit' })
    .on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = electron;
  app.disableHardwareAcceleration();
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const assert = require('node:assert/strict'), { pathToFileURL } = require('node:url');
  const client = path.resolve(__dirname, '..'), out = path.resolve(process.argv[2] || path.join(client, '../outputs/agent-local-cloud-20261030/ui'));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-agent-state-'));
  app.setPath('userData', profile);
  const report = { ok: false, cases: [], errors: [], networkRequests: [],
    boundary: 'Real Electron/Chromium, production Agent/Runner UI and API. Hub responses, installation jobs, runtime inventory and secure-store IPC are fixtures; no real model inference or installed-runtime execution.' };
  let win;
  const js = s => win.webContents.executeJavaScript(s, true).catch(error => {
    report.failedScript = s.slice(0, 320); throw error;
  });
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const waitDOM = expression => js(`new Promise((resolve,reject)=>{let timer;
    const observer=new MutationObserver(check);function check(){if(${expression}){observer.disconnect();clearTimeout(timer);resolve(true);}}
    observer.observe(document.documentElement,{childList:true,subtree:true,attributes:true});
    timer=setTimeout(()=>{observer.disconnect();reject(Error('UI did not settle: '+${JSON.stringify(expression)}));},5000);check();})`);
  app.whenReady().then(async () => {
    fs.mkdirSync(out, { recursive: true });
    win = new BrowserWindow({ show: false, width: 1280, height: 1000,
      webPreferences: { contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (request, done) => {
      report.networkRequests.push(request.url); done({cancel:true});
    });
    const file = path.join(profile, 'state.html');
    fs.writeFileSync(file, '<!doctype html><html data-desk-panel="agents" data-window-menu=""><meta charset="utf-8"><base href="' + pathToFileURL(client + path.sep).href + '"><body></body></html>');
    await win.loadFile(file);
    const styles = Array.from(fs.readFileSync(path.join(client,'desk.html'),'utf8').matchAll(/<link rel="stylesheet" href="([^"]+)"/g), match => match[1]);
    for (const file of styles) {
      await js(`new Promise((resolve,reject)=>{const e=document.createElement('link');e.rel='stylesheet';e.href=${JSON.stringify(pathToFileURL(path.join(client,file)).href)};e.onload=()=>resolve(true);e.onerror=()=>reject(Error('Style failed'));document.head.appendChild(e)})`);
    }
    await js(`window.errors=[];addEventListener('error',e=>errors.push(e.message));addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));window.esc=s=>String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');window.petSay=()=>{};window.requests=[];window.loginCancelled=false;window.SoduWorkAPI={localAgentSetup:async()=>window.fixture,agentSetup:async()=>window.fixture,agentInstall:async(key,action,runner,options)=>{requests.push({key,action,runner,...(options?{options}:{})});if(action==='login-cancel'){loginCancelled=true;return{jobId:options.jobId,cancelled:true,state:'cancelling'}}return{jobId:action==='login'?'fixture-login':'fixture-job'}},agentJob:async id=>id==='fixture-login'?{state:loginCancelled?'done':'running',auth:{state:loginCancelled?'cancelled':'waiting',verificationUrl:'https://auth.openai.com/codex/device',userCode:'ABCD-EFGH',expiresAt:Date.now()/1000+180}}:{state:'done',ok:true,lines:['Fixture completed']}};void 0;`);
    // Resolve the isolated Agent surface from the desktop entry's production declarations.
    const scripts = Array.from(fs.readFileSync(path.join(client,'desk.html'),'utf8')
      .matchAll(/<script\s+src=["']([^"']+)["']/g), match => match[1])
      .filter(file => /\/(?:agent-brand|panels-agents|panels-runners|codex-auth-dialog)\.js$/.test(file));
    for (const file of scripts)
      await js(`new Promise((resolve,reject)=>{const e=document.createElement('script');e.src=${JSON.stringify(pathToFileURL(path.join(client,file)).href)};e.onload=()=>resolve(true);e.onerror=()=>reject(Error('Script failed'));document.body.appendChild(e)})`);
    const agents = [
      {key:'opencode',name:'OpenCode',state:'missing',setupState:'missing',installed:false,present:false},
      {key:'harness2',name:'Google Harness²',state:'missing',setupState:'setup',installed:false,present:true,bundled:true,version:'0.1.0',why:'内置核心已就绪，需要准备 OpenCode 执行组件。'},
      {key:'qwen',name:'Qwen Code',state:'missing',setupState:'broken',installed:false,present:true,version:'0.25.0',runtimeIssue:'执行组件启动自检失败，请修复安装。'},
      {key:'codex',name:'Codex',state:'unauthed',auth:'unauthed',setupState:'unauthed',installed:true,present:true,version:'0.164.0',loginAvailable:true,loginFlowVersion:1},
      {key:'codex-harness',name:'Codex Harness',state:'ready',setupState:'ready',installed:true,present:true,version:'2.2.2'},
      {key:'pi',name:'Pi',state:'ready',setupState:'ready',installed:true,present:true,bundled:true,version:'0.84.3',probe:{ok:false,at:100,historical:true,detail:'Earlier connection failed'}},
      {key:'dsh',name:'DeepSeek Harness',state:'nollm',setupState:'nollm',installed:true,present:true,version:'0.4.39',modelPick:true}
    ].map(a=>({...a,modelPick:!['codex'].includes(a.key),blurb:'按当前执行机器的安装与配置状态显示。'}));
    await js(`window.fixture=${JSON.stringify({modelCount:1,models:[{name:'fixture-model'}],machines:[{runnerId:'fixture-runner',label:'测试电脑',scope:'current-instance',host:'DESKTOP-ISOLATED-SOURCE',os:'Windows-11-10.0.26300-SP0',env:{ok:true,node:'24',npm:'11'},agents},{runnerId:'fixture-cloud',label:'我的电脑',scope:'personal-cloud',host:'linux-cloud',agents}]})};openAgentsPanel();void 0;`);
    await delay(180);
    for (const width of [1280,600]) {
      win.setSize(width,1000); await delay(100);
      const cards = await js(`Array.from(document.querySelectorAll('.ag-row')).map(e=>({state:e.dataset.agstate,badges:e.querySelectorAll('.ag-row-st').length,flags:e.querySelectorAll('.ag-flag').length,overflow:e.scrollWidth>e.clientWidth+1,action:e.querySelector('.ag-quick button').textContent}))`);
      assert.equal(cards.length,7);
      assert.ok(cards.every(c=>c.badges===1 && c.flags===0 && !c.overflow), JSON.stringify(cards));
      assert.equal(await js("document.querySelector('.rn-section-head h3').textContent"), '本机 AI 助手');
      assert.equal(await js("document.querySelectorAll('.ag-section').length"), 1);
      assert.equal(await js("!!document.querySelector('[data-ak^=\"fixture-cloud~\"]')"), false);
      assert.equal(await js("document.querySelector('.rn-section-head h3').scrollWidth<=document.querySelector('.rn-section-head h3').clientWidth"),true);
      assert.equal(cards.find(c=>c.state==='setup').action,'准备组件');
      assert.equal(cards.find(c=>c.state==='broken').action,'修复安装');
      fs.writeFileSync(path.join(out,`cards-${width}.png`),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
      report.cases.push({width,cards});
      await js(`document.querySelector('[data-atoggle="fixture-runner~harness2"]').click()`); await delay(100);
      assert.equal(await js(`document.querySelector('.ag-drawer .cfg-state').textContent`),'待准备组件');
      assert.equal(await js(`document.querySelector('.ag-drawer').scrollWidth>document.querySelector('.ag-drawer').clientWidth+1`),false);
      fs.writeFileSync(path.join(out,`drawer-${width}.png`),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
      await js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))`);
      assert.equal(await js(`!!document.getElementById('agDrawerWrap')`),false);
    }
    await js(`document.querySelector('[data-ainstall="fixture-runner~harness2"]').click()`);
    assert.deepEqual(await js('requests'),[{key:'harness2',action:'install',runner:'fixture-runner'}]);
    await js('closeAgentsPanel();openAgentsPanel();void 0;'); await delay(1100);
    assert.equal(await js(`_agJobs['fixture-runner~harness2'].state`),'done');
    await js(`dispatchEvent(new Event('soduwork-data-scope-changed'));void 0;`);
    assert.equal(await js('Object.keys(_agJobs).length'),0);
    await js(`openAgentsPanel();void 0;`); await delay(180);
    await js(`document.querySelector('[data-atoggle="fixture-runner~codex"]').click()`);
    await delay(180);
    assert.equal(await js(`document.querySelectorAll('.ag-drawer [data-alogin]').length`),1);
    assert.equal(await js(`document.querySelector('.ag-drawer').scrollWidth>document.querySelector('.ag-drawer').clientWidth+1`),false);
    assert.match(await js(`document.querySelector('.ag-drawer').textContent`),/优先使用这台机器已有的 Codex 登录/);
    await js(`document.querySelector('.ag-drawer [data-alogin]').click()`); await delay(180);
    assert.equal(await js(`document.querySelector('.codex-auth-dialog').dataset.state`),'ready');
    assert.equal(await js('requests.length'),1);
    await js(`document.querySelector('.codex-auth-primary').click()`); await delay(180);
    assert.deepEqual((await js('requests')).at(-1),{key:'codex',action:'login',runner:'fixture-runner'});
    assert.equal(await js(`document.querySelector('.codex-auth-dialog').dataset.state`),'waiting');
    fs.writeFileSync(path.join(out,'codex-login-600.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
    await js(`document.querySelector('.codex-auth-secondary').click()`); await delay(180);
    assert.equal(await js(`!!document.querySelector('.codex-auth-dialog')`),false);
    assert.deepEqual((await js('requests')).at(-1),{key:'codex',action:'login-cancel',runner:'fixture-runner',options:{jobId:'fixture-login'}});
    await js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));document.querySelector('[data-atoggle="fixture-runner~codex-harness"]').click()`);
    assert.equal(await js(`document.querySelectorAll('.ag-drawer [data-alogin]').length`),0);
    report.cases.push({loginCapability:true,selectedRunner:true,explicitConsent:true,scopedCancellation:true,enterpriseUnchanged:true});
    await js(`fixture={...fixture,machines:fixture.machines.filter(m=>m.scope==='personal-cloud'),agents:fixture.machines[0].agents,modelCount:0};_agOpen='fixture-cloud~opencode';void 0;`);
    await js('_agLoad(true)');
    await delay(180);
    assert.equal(await js("document.querySelectorAll('.ag-row').length"),0);
    assert.equal(await js("!!document.querySelector('.ag-drawer')"),false);
    assert.match(await js("document.getElementById('agBody').textContent"),/本机底座暂不可用.*云端底座请在「云端电脑」中管理/);
    const before = await js('requests.length');
    await js("_agRun('fixture-cloud~opencode','install')");
    assert.equal(await js('requests.length'),before);
    fs.writeFileSync(path.join(out,'cloud-only-empty-600.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
    report.cases.push({cloudExcluded:true,noLegacyFallback:true,hiddenTargetBlocked:true});

    const managed = ['pi','qwen','opencode','dsh','kimi','harness2','codex-harness'];
    const localRef = 'local:model-0123456789abcdef0123456789abcdef';
    const remainingRef = 'local:model-fedcba9876543210fedcba9876543210';
    await js(`closeAgentsPanel();window.hubCalls=[];window.localWrites=[];window.defaultSelections={};window.defaultRevision=0;
      window.managedKeys=${JSON.stringify(managed)};window.localRef=${JSON.stringify(localRef)};window.remainingRef=${JSON.stringify(remainingRef)};
      window.localRows=[{name:localRef,label:'Private model',providerId:'private',localOnly:true,modality:'chat'}];
      window.localRunner={runnerId:'fixture-local',label:'Local-only model device',scope:'current-instance',owned:true,
        online:true,accepting:true,mode:'accepting',agents:managedKeys.map(key=>({key,name:key,state:'ready'}))};
      window.hubAgents=[...managedKeys,'codex','claude'].map(key=>({key,name:key,installed:true,present:true,
        state:'ready',setupState:'ready',modelPick:managedKeys.includes(key)}));
      window.User={id:'fixture-device',name:'Fixture'};window.__SODUWORK_TEST_HUB_CONFIG__={allowSwitch:true};
      localStorage.setItem('soduwork_work_hub_url','http://fixture-hub.invalid:8989');
      window.soduWorkAPI={deviceAuthBootstrap:async()=>({ok:true,stored:true,clientId:'fixture-device',
          user:{id:'fixture-owner'},session:'fixture-session',expiresIn:1800}),runnerStatus:async()=>({connected:true,running:true}),
        localModels:{get:async()=>({providers:[{id:'private'}],usable:localRows})},
        localAgentModels:{get:async()=>({ok:true,scopeKey:'fixture-scope',revision:defaultRevision,selections:defaultSelections}),
          set:async input=>{if(input.scopeKey!=='fixture-scope'||input.expectedRevision!==defaultRevision||!managedKeys.includes(input.agentId))throw Error('Invalid local mutation');
            localWrites.push({...input});defaultSelections[input.agentId]={configured:true,modelName:input.modelName,unavailable:false};
            defaultRevision++;return{ok:true};}}};
      window.fetch=async(url,options={})=>{hubCalls.push({url:String(url),method:options.method||'GET',body:options.body||''});
        const target=new URL(url);if(options.method&&options.method!=='GET')throw Error('Unexpected Hub write');
        if(target.pathname.endsWith('/runners'))return new Response(JSON.stringify({runners:[localRunner]}));
        if(target.pathname.endsWith('/agent-setup')){if(target.searchParams.get('hasLocalModel')!=='1')throw Error('Missing local capability');
          return new Response(JSON.stringify({models:[],modelCount:0,machines:[{...localRunner,env:{ok:true},agents:hubAgents}]}));}
        throw Error('Unexpected Hub endpoint: '+target.pathname);};void 0;`);
    for (const file of ['core/api-work-plugins.js', 'api.js'])
      await js(fs.readFileSync(path.join(client, file), 'utf8') + '\nvoid 0;');
    await js('SoduWorkAPI.registerClient()');
    await js('openAgentsPanel();void 0;');
    await waitDOM(`document.querySelectorAll('.ag-row').length===9&&_agData.localModelCount===1`);
    assert.equal(await js('_agData.modelCount'),1);
    assert.equal(await js(`document.querySelectorAll('.ag-row[data-agstate="ready"]').length`),9);
    for (const key of managed) {
      await js(`document.querySelector('[data-atoggle="fixture-local~${key}"]').click();void 0;`);
      await waitDOM(`document.querySelector('.ag-drawer [data-amodel="${key}"]')`);
      assert.equal(await js(`document.querySelectorAll('.ag-drawer option[value="${localRef}"]').length`),1);
      await js(`{const select=document.querySelector('.ag-drawer [data-amodel="${key}"]');select.value=localRef;
        select.dispatchEvent(new Event('change',{bubbles:true}));}void 0;`);
      await waitDOM(`document.querySelector('.ag-drawer [data-amodel="${key}"]')?.value===localRef&&
        !document.querySelector('.ag-drawer [data-amodel="${key}"]').disabled&&_agData.agents.find(a=>a.key==='${key}')?.localModelDefault`);
      assert.equal(await js(`defaultSelections['${key}'].modelName`),localRef);
      report.cases.push({localOnlyAgent:key,ready:true,defaultSavedLocally:true});
      await js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));void 0;`);
    }
    for (const key of ['codex','claude']) {
      await js(`document.querySelector('[data-atoggle="fixture-local~${key}"]').click();void 0;`);
      assert.equal(await js(`document.querySelectorAll('.ag-drawer [data-amodel]').length`),0);
      assert.match(await js(`document.querySelector('.ag-drawer .ag-model').textContent`),/自己的账号与模型/);
      await js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));void 0;`);
      report.cases.push({accountAgent:key,localModelsExcluded:true});
    }
    await js(`for(const agent of hubAgents.filter(a=>a.modelPick))Object.assign(agent,{state:'nollm',setupState:'nollm',displayState:'nollm'});
      _agLoad(true);void 0;`);
    await waitDOM(`_agData.agents.filter(a=>a.localModelDefault&&a.setupState==='ready').length===7`);
    assert.equal(await js(`document.querySelectorAll('.ag-row[data-agstate="ready"]').length`),9);
    report.cases.push({availableLocalDefaults:7,staleHubModelStatusCorrected:true});
    await js(`for(const agent of hubAgents.filter(a=>a.modelPick))Object.assign(agent,{state:'ready',setupState:'ready',displayState:'ready'});
      localRows=[{name:remainingRef,label:'Other private model',providerId:'private',localOnly:true,modality:'chat'}];
      for(const value of Object.values(defaultSelections))value.unavailable=true;defaultRevision++;_agLoad(true);void 0;`);
    await waitDOM(`_agData.agents.filter(a=>a.localModelDefault&&a.modelGone).length===7`);
    for (const key of managed) {
      await js(`document.querySelector('[data-atoggle="fixture-local~${key}"]').click();void 0;`);
      assert.equal(await js(`document.querySelector('.ag-drawer [data-amodel]').value`),localRef);
      assert.match(await js(`document.querySelector('.ag-drawer option:checked').textContent`),/本地模型已删除或不可用/);
      assert.match(await js(`document.querySelector('.ag-drawer').textContent`),/主动选择可用模型.*不会自动切换模型/);
      assert.equal(await js(`document.querySelector('[data-ak="fixture-local~${key}"]').dataset.agstate`),'nollm');
      await js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));void 0;`);
    }
    assert.equal(await js('localWrites.length'),7);
    report.cases.push({deletedDefaults:7,preservedOriginalReference:true,availableAlternativeNotSelected:true});
    await js(`document.querySelector('[data-agtab="runners"]').click();void 0;`);
    await waitDOM(`document.querySelector('#rn-card-fixture-local')`);
    assert.match(await js(`document.querySelector('#agBody').textContent`),/1 个节点在线，1 个可接单/);
    assert.equal(await js('_agData.runners[0].agents.length'),7);
    assert.equal(await js(`document.querySelector('#rn-card-fixture-local .rn-state').textContent`),'可接任务');
    assert.equal(await js(`document.querySelector('#rn-card-fixture-local .rn-chips em').textContent`),'+2');
    fs.writeFileSync(path.join(out,'local-only-runner.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
    const hubCalls = await js('hubCalls');
    assert(hubCalls.every(call=>call.method==='GET'));
    assert.doesNotMatch(JSON.stringify(hubCalls),/local:model-|private|fixture-scope/);
    assert.deepEqual(report.networkRequests,[]);
    report.cases.push({localOnlyRunnerReady:true,managedAgentCount:7,hubWrites:0,localDefaultWrites:7});
    report.errors = await js('errors'); assert.deepEqual(report.errors,[]);
    report.ok = true;
  }).catch(async e=>{report.errors.push(String(e.stack||e));process.exitCode=1;
    if(win&&!win.isDestroyed()) {
      report.diagnostics=await win.webContents.executeJavaScript(
        `({errors:window.errors,body:document.body.innerText,hubCalls:window.hubCalls,localWrites:window.localWrites})`,true).catch(()=>null);
      const capture=await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true}).catch(()=>null);
      if(capture)fs.writeFileSync(path.join(out,'failure.png'),capture.toPNG());
    }
  }).finally(()=>{
    fs.writeFileSync(path.join(out,'ui-report.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify({ok:report.ok,layouts:report.cases.length,errors:report.errors}));
    if(win&&!win.isDestroyed()) win.destroy(); app.exit(report.ok ? 0 : 1);
  });
}
