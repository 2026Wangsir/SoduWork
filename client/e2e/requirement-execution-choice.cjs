'use strict';
// Use real Chromium dispatch UI with stub directories, conversation execution, and probes; isolate user data and block external networking.
// Load production dispatchToAI and error translation to verify queue rejection and retry from the action button.
// Plugin and Agent selectors use the production dispatch contract; default-model E2E separately covers the legacy native helper.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS']) delete env[key];
  const child = require('node:child_process').spawn(electron, [__filename, ...process.argv.slice(2)],
    { env, windowsHide: true, stdio: 'inherit' });
  const timer = setTimeout(() => child.kill(), 90000);
  child.on('exit', code => { clearTimeout(timer); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const assert = require('node:assert/strict'), { pathToFileURL } = require('node:url');
  const client = path.resolve(__dirname, '..'), baseline = false;
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-execution-choice-'));
  const out = path.resolve(process.argv[2] || path.join(client, '../outputs/requirement-assignment-redesign-20261022'));
  fs.mkdirSync(out, { recursive: true });
  app.setPath('userData', path.join(temporary, 'profile'));
  app.disableHardwareAcceleration();
  const report = { ok: false, baseline, cases: [], errors: [], networkRequests: [], realModel: false, businessDatabase: false };
  let win;
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const js = code => win.webContents.executeJavaScript(code, true);
  async function until(code, attempts = 200) {
    for (let i = 0; i < attempts; i++) { if (await js(code)) return; await delay(20); }
    throw Error('等待界面超时：' + code);
  }
  async function click(selector) {
    await js(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'});void 0;`);
    await delay(80);
    const point = await js(`(() => {const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect();
      const p={x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};
      if(!e.contains(document.elementFromPoint(p.x,p.y)))throw Error('控件被遮挡：'+${JSON.stringify(selector)});return p;})()`);
    for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, ...point, button: 'left', clickCount: 1 });
    await delay(30);
  }
  async function changeRepo(id) {
    await js(`document.querySelector('#fwdRepoSel').value=${JSON.stringify(id)};
      document.querySelector('#fwdRepoSel').dispatchEvent(new Event('change',{bubbles:true}));void 0;`);
  }
  async function select(selector,value) {
    await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),value=${JSON.stringify(value)};
      if(!e||e.disabled||![...e.options].some(o=>o.value===value&&!o.disabled))throw Error('Unavailable selection: '+value);
      e.value=value;e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  }
  async function openPicker(id) {
    await click('.fwd-select-trigger[data-select-id="'+id+'"]');
    await until(`Boolean([...document.querySelectorAll('.fwd-select-popup')].find(e=>e.getClientRects().length))`);
  }
  async function choosePopup(id,value) {
    await openPicker(id);
    const option='.fwd-select-popup [role="option"][data-value="'+value+'"]';
    await until(`Boolean(document.querySelector(${JSON.stringify(option)}))`);
    assert.equal(await js(`document.querySelector(${JSON.stringify(option)}).getAttribute('aria-disabled')==='true'`),false);
    await click(option);await until(`document.getElementById(${JSON.stringify(id)}).value===${JSON.stringify(value)}`);
  }
  async function key(code) {
    for(const type of ['keyDown','keyUp'])win.webContents.sendInputEvent({type,keyCode:code});
    await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))');
  }
  async function open(mode = 'all', nativeOk = true) {
    await js(`(async()=>{RequirementAssignment.close();window.calls=[];window.toasts=[];window.tasks=[];
      fixture.mode=${JSON.stringify(mode)};fixture.nativeOk=${nativeOk};fixture.models=null;fixture.pending={};fixture.localPending={};fixture.holdProbe=false;fixture.holdLocalProbe=false;fixture.probeWait=null;
      await RequirementAssignment.open('qa-task');})()`);
    await until(`Boolean(document.querySelector('#fwdPluginSelect')) && !_fwdLoading.ai`);
  }
  async function state() {
    return js(`({choice:JSON.parse(JSON.stringify(_fwdSelection.ai)),disabled:document.querySelector('#fwdConfirm')?.disabled,
      label:document.querySelector('#fwdConfirm')?.textContent,decision:document.querySelector('#fwdDecision')?.innerText,
      repo:document.querySelector('#fwdRepoSel')?.value,optionsRepo:_fwdOptions?.selection?.repoId,
      native:Boolean(document.querySelector('[data-fwd-choice="native"]')),
      plugin:document.querySelector('#fwdPluginSelect')?.value,agent:document.querySelector('#fwdAgentSelect')?.value,
      agentDisabled:document.querySelector('#fwdAgentSelect')?.disabled,
      plugins:[...document.querySelectorAll('#fwdPluginSelect option')].map(o=>({value:o.value,text:o.textContent,disabled:o.disabled})),
      agents:[...document.querySelectorAll('#fwdAgentSelect option')].map(o=>({value:o.value,text:o.textContent,disabled:o.disabled})),
      cards:document.querySelectorAll('[data-fwp-card]').length,
      calls:JSON.parse(JSON.stringify(calls))})`);
  }
  async function screenshot(name) {
    await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
    const file = path.join(out, name + '.png');
    const shot=await win.webContents.debugger.sendCommand('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});
    fs.writeFileSync(file, Buffer.from(shot.data,'base64'));
    return file;
  }
  async function run(name, action) {
    const row = { name, ok: false };
    try { await action(row); row.ok = true; }
    catch (error) { row.error = String(error.stack || error); row.state = await state().catch(() => null); }
    row.screenshot = await screenshot(String(report.cases.length + 1).padStart(2, '0'));
    report.cases.push(row);
  }
  app.whenReady().then(async () => {
    const desk = fs.readFileSync(path.join(client, 'desk.html'), 'utf8');
    const css = [...desk.matchAll(/<link\b[^>]*href=["']([^"']+\.css)["'][^>]*>/g)].map(m => m[1]);
    const fixtureFile = path.join(temporary, 'fixture.html');
    fs.writeFileSync(fixtureFile, '<!doctype html><html><head><meta charset="utf-8">' +
      css.map(file => '<link rel="stylesheet" href="' + pathToFileURL(path.join(client, file)).href + '">').join('') +
      '</head><body><main style="padding:32px"><h1>需求池 · 隔离验证</h1><button id="opener">安排执行</button></main></body></html>');
    win = new BrowserWindow({ show: false, width: 1280, height: 960, useContentSize: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } });
    win.webContents.debugger.attach('1.3');
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (request, cb) => {
      report.networkRequests.push(request.url); cb({ cancel: true });
    });
    await win.loadFile(fixtureFile);
    await js(`window.errors=[];addEventListener('error',event=>errors.push(event.message));
      addEventListener('unhandledrejection',event=>errors.push(String(event.reason)));
      window.esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
      window.calls=[];window.tasks=[];window.toasts=[];window.petSay=text=>toasts.push(text);
      window.save=()=>{};window.render=()=>{};window.workRoot=()=>'';
      window._humanErr=(error,fallback)=>error.message||fallback;
      window.fixture={mode:'all',nativeOk:true,pending:{},holdProbe:false,probeWait:null};
      window.taskFixture={id:'qa-task',title:'修复接收需求后的执行入口',note:'完整任务原文与验收要求',kind:'bug',
        status:'todo',triageStage:'ready',tags:['执行体验'],workRouting:{requiredAgentCapabilities:[]}};
      window.clone=value=>JSON.parse(JSON.stringify(value));
      window.optionsFixture=body=>{
        const repo=body.repoId||'',id=repo?'flow-'+repo:'flow-office';
        const localMode=fixture.mode.startsWith('local-');
        const plugin={bindingId:id,key:id,pluginId:'builtin-method',sourceKind:'builtin',selectionSource:'builtin',name:repo?'工程方法 '+repo:'内置办公方法',version:'1.0.0',recommended:true,runnable:true,
          description:'执行者可以选择此方法，也可以不用插件直接执行',inputs:[],workflow:[
            {key:'work',name:'完成工作',type:'ai',route:{agentSource:'runtime'}}],
          capabilities:{executionMode:'workflow'},readiness:{blockers:[]}};
        return {selection:{taskId:'qa-task',repoId:repo,projectId:repo?'business-'+repo:''},task:clone(taskFixture),
          scenario:{key:'office',name:'综合办公',reason:'推荐参考，可由执行者自由选择'},
          repos:fixture.mode==='no-repos'?[]:[{id:'a',name:'工程 A',projectName:'项目 A',projectId:'business-a'},{id:'b',name:'工程 B',projectName:'项目 B',projectId:'business-b'}],
          workflows:fixture.mode==='no-plugins'?[]:[plugin,
            {...plugin,bindingId:'installed-method',sourceKind:'import',selectionSource:'installed',name:'已安装的方法',recommended:false},
            {...plugin,bindingId:'fixed-method',sourceKind:'published',selectionSource:'installed',name:'固定路由的方法',recommended:false,
              workflow:[{key:'work',name:'完成工作',type:'ai',route:{agentSource:'plugin',agentKind:'local:pi'}}]},
            {...plugin,bindingId:'mixed-method',sourceKind:'import',selectionSource:'installed',name:'多节点协作方法',recommended:false,
              workflow:[{key:'file',name:'整理文件',type:'ai',route:{agentSource:'runtime',runtime:['files']}},
                {key:'web',name:'核对网页',type:'ai',route:{agentSource:'runtime',runtime:['browser']}}]},
            ...(fixture.mode==='filter'?[{...plugin,bindingId:'market-method',sourceKind:'published',selectionSource:undefined,name:'未安装市场方法'},
              {...plugin,bindingId:'org-method',sourceKind:'org',selectionSource:undefined,name:'未安装组织方法'},
              {...plugin,bindingId:'legacy-builtin',selectionSource:undefined,name:'旧服务内置方法'}]:[])],blockedWorkflows:fixture.mode==='no-plugins'?[]:[{...plugin,bindingId:'blocked',name:'不可运行的方法',
            runnable:false,recommended:false,readiness:{blockers:['节点要求的 Codex Runner 不在线']}}],
          substrates:fixture.mode==='local-pending-multi'?[{key:'local:codex',name:'Codex',cli:'codex',available:true,onlineSeats:1,modelPick:true},
            {key:'local:qwen',name:'Qwen',cli:'qwen',available:true,onlineSeats:1,modelPick:true}]:
            fixture.mode==='blocked'||(localMode&&!['local-dedupe','local-blocked','local-pending-device-key'].includes(fixture.mode))?[]:[{key:'local:opencode',name:'OpenCode',cli:'opencode',available:false,onlineSeats:0},
            {key:'local:pi',name:'Pi',cli:'pi',available:fixture.mode!=='local-blocked',onlineSeats:1,
            capabilitySets:[['files']],locationLabel:'本机 · 隔离 Runner',note:'测试替身',modelPick:true,
            ...(fixture.mode==='local-pending-device-key'?{locations:[{mode:'local',label:'本机 · 隔离 Runner',
              id:'runner:fixture-device:pi',assigneeId:'runner:fixture-device:pi',runnerId:'fixture-runner',clientId:'fixture-client'}]}:{})},
            ...(fixture.mode==='multi'?[{key:'local:codex',name:'Codex',cli:'codex',available:true,onlineSeats:1,modelPick:true,capabilitySets:[['browser']]}]:[])],
          models:fixture.models||['隔离模型'],recommendation:{strategy:'workflow',workflowBindingId:id,substrateKey:'local:pi',workflowRequired:false},
          availability:{agentReason:'本次未发现后台 Runner'}};
      };
      window.SoduWorkAPI={clientId:'fixture-client',getTask:async()=>clone(taskFixture),getTasksSnapshot:async()=>({online:true,items:[clone(taskFixture)]}),
        listAttachments:async()=>[{name:'需求原文.txt',byAgent:false}],listTeammates:async()=>({mates:fixture.mode==='mates'?
          [{id:'fixture-colleague',name:'测试同事',org:'体验组',canReceive:true,deviceCount:2},
            {id:'fixture-offline',name:'尚未启用同事',org:'体验组',canReceive:false}]:[]}),taskStorageKey:()=> 'isolated-executor',
        taskExecutionOptions:async body=>{calls.push({kind:'options',body:clone(body)});
          if(fixture.mode==='error')throw Error('服务连接失败');
          if(fixture.mode==='hold-first')return new Promise(resolve=>fixture.pending.first=()=>resolve(optionsFixture(body)));
          const result=optionsFixture(body);if(fixture.mode==='hold-api'&&body.repoId==='a')return new Promise(resolve=>fixture.pending.a=()=>resolve(result));
          return result;},
        dispatchToAI:async(...args)=>{calls.push({kind:'direct',args:clone(args)});return {ok:true};},
        startTaskPlugin:async(...args)=>{calls.push({kind:'plugin',args:clone(args)});return {ok:true};}};
      window.soduWorkAPI={conversationSession:{history:async()=>({ok:true,chats:[]}),runtimes:async()=>{
        calls.push({kind:'runtime-catalog'});return {ok:true,runtimes:fixture.mode.startsWith('local-')?
          [{id:'pi',displayName:'Pi',transport:'direct',modelMode:'managed',capabilities:[]},
           {id:'codex',displayName:'Codex',transport:'runner',modelMode:'account',capabilities:[]},
           ...(fixture.mode==='local-diagnostics'?[{id:'qwen',displayName:'Qwen Code',transport:'runner',modelMode:'managed',capabilities:[]}]:[]),
           ...(fixture.mode==='local-many'?[{id:'qwen',displayName:'Qwen Code',transport:'runner',modelMode:'managed',capabilities:[]},
             {id:'codex-harness',displayName:'Codex Harness',transport:'runner',modelMode:'managed',capabilities:[]},
             {id:'dsh',displayName:'DeepSeek Harness',transport:'runner',modelMode:'managed',capabilities:[]}]:[])]:[]};},probe:async adapter=>{
        calls.push({kind:'probe',adapter});
        if(fixture.holdLocalProbe||fixture.mode.startsWith('local-pending'))return new Promise(resolve=>fixture.localPending[adapter]=resolve);
        if(fixture.mode==='local-diagnostics')return adapter==='pi'?{ok:true,state:'ready'}:adapter==='qwen'?
          {ok:false,state:'missing',reason:'未安装测试运行时'}:{ok:false,state:'unauthed',reason:'测试账号需要重新登录'};
        if(fixture.mode.startsWith('local-'))return {ok:fixture.mode==='local-many'||(fixture.mode!=='local-failed'&&adapter==='pi'),state:fixture.mode==='local-many'||adapter==='pi'?'ready':'unauthed',reason:'隔离探测不可用'};
        if(fixture.holdProbe){fixture.holdProbe=false;return new Promise(resolve=>fixture.probeWait=()=>resolve({ok:fixture.nativeOk}));}
        return {ok:fixture.nativeOk};}}};
      window.ChatTaskController={isPickableTask:task=>task.status==='todo'&&!task.readOnly};
      window.NativeChat={enqueueTask:async(...args)=>{calls.push({kind:'native',args:clone(args)});return {ok:true,conversationId:'qa-conversation'};},sessionInfo:()=>({})};
      window.openTaskConversation=async(...args)=>{calls.push({kind:'navigate',args:clone(args)});return {ok:true};};
      window.RequirementsBoard={refresh:async()=>{}};void 0;`);
    const scripts = ['components/panels/panels-icons.js', 'core/requirement-session-context.js',
      'components/panels/task-execution-context.js', 'components/panels/task-execution-client.js',
      'components/panels/panels-forward-select.js',
      'components/panels/panels-forward-plugin.js', 'components/panels/panels-forward-picker.js',
      'components/panels/panels-forward-options.js', 'components/panels/panels-forward.js',
      'components/requirements/requirement-session-choice.js', 'components/requirements/requirement-assignment.js'];
    for (const file of scripts) {
      const source = baseline && file === 'components/panels/panels-forward-options.js'
        ? require('node:child_process').execFileSync('git', ['show', 'HEAD:client/' + file], { cwd: client, encoding: 'utf8', windowsHide: true })
        : fs.readFileSync(path.join(client, file), 'utf8');
      await js(source + '\nvoid 0;');
    }
    await run('安排选择器将插件、Agent、诊断和流程中的 HTML 保留为文本',async row=>{
      await open();
      const payload = '\"><img src=x onerror="window.pickerInjected=true"><svg onload="window.pickerInjected=true">';
      row.dom = await js(`(()=>{
        const value=${JSON.stringify(payload)}, plugin=_fwdOptions.workflows[0];
        plugin.bindingId=value;plugin.name=value;plugin.process={label:value,route:value,environments:[{label:value}]};
        plugin.workflow[0].name=value;plugin.readiness.warnings=[value];
        _fwdOptions.substrates[1].key=value;_fwdOptions.substrates[1].name=value;
        _fwdOptions.substrates[1].note=value;_fwdOptions.substrates[1].locationLabel=value;
        _fwdOptions.models=[value];_fwdLocalFailures=[{name:value,reason:value}];
        _fwdSelection.ai={type:'workflow',id:value};_fwdNoPlugin=false;
        const box=document.getElementById('fwdList');_fwdRenderAIPickers('qa-task',box);
        return {plugin:box.querySelector('#fwdPluginSelect').value,
          name:box.querySelector('[data-fwp-card]').getAttribute('data-fwp-name'),
          agent:[...box.querySelector('#fwdAgentSelect').options].some(o=>o.value===value&&o.textContent.includes(value)),
          model:[...box.querySelector('[data-fwp-model]').options].some(o=>o.value===value&&o.textContent===value),
          diagnostic:box.querySelector('.fwd-agent-diagnostics p span').textContent,
          dangerous:box.querySelectorAll('img,script,[onerror],[onload]').length};
      })()`);
      assert.equal(row.dom.plugin,payload);assert.equal(row.dom.name,payload);
      assert.equal(row.dom.agent,true);assert.equal(row.dom.model,true);
      assert.equal(row.dom.diagnostic,payload);assert.equal(row.dom.dangerous,0);
      await delay(30);assert.equal(await js('Boolean(window.pickerInjected)'),false);
    });
    await run('独立下拉默认不用插件并选择可用 Pi，确认前不执行',async row=>{
      await open();row.state=await state();assert.equal(row.state.plugin,'');assert.equal(row.state.agent,'local:pi');
      assert.equal(row.state.disabled,false);assert.equal(row.state.choice.type,'direct');assert.equal(row.state.cards,0);
      assert.equal(row.state.agents.filter(o=>o.value==='local:pi').length,1);assert.equal(row.state.native,false);
      assert.equal(await js(`Boolean(document.querySelector('#fwdAgentSearch,#fwdSearchCount'))`),false);
      assert.equal(await js(`document.querySelector('#fwdPop').textContent.includes('Pi · 本机对话')`),false);
      assert(!row.state.calls.some(c=>['plugin','direct','native','probe'].includes(c.kind)));
    });
    await run('左侧工程需求交代与右侧执行设置分工明确，无重复摘要卡或原生下拉',async row=>{
      await open();await key('Shift');
      row.layout=await js(`(()=>{const main=document.querySelector('.frw-main'),settings=document.querySelector('.fwd-settings');return {
        title:main?.querySelector('.fwd-task-context h3')?.textContent,note:main?.querySelector('.fwd-task-context p')?.textContent,
        left:['fwdRepo','fwdNote'].every(id=>main?.contains(document.getElementById(id))),
        right:['fwdPluginSelect','fwdAgentSelect','fwdModel','fwdSubmissionMode'].every(id=>settings?.contains(document.getElementById(id))),
        summaries:document.querySelectorAll('.fwd-picked,#fwdAgentSummary').length,
        visibleNative:[...document.querySelectorAll('#fwdPop select')].filter(e=>e.getClientRects().length).map(e=>e.id),
        pickers:[...document.querySelectorAll('.fwd-select-trigger')].map(e=>e.dataset.selectId)};})()`);
      assert.equal(row.layout.title,'修复接收需求后的执行入口');assert.match(row.layout.note,/完整任务原文与验收要求/);
      assert.equal(row.layout.left,true);assert.equal(row.layout.right,true);assert.equal(row.layout.summaries,0);
      assert.deepEqual(row.layout.visibleNative,[]);
      for(const id of ['fwdRepoSel','fwdPluginSelect','fwdAgentSelect','fwdModel','fwdSubmissionMode'])assert(row.layout.pickers.includes(id));
    });
    await run('插件下拉仅显示内置及已安装项，未安装市场和组织项不可见',async row=>{
      await open('filter');row.state=await state();const ids=row.state.plugins.map(o=>o.value);
      assert(ids.includes('flow-office'));assert(ids.includes('installed-method'));assert(ids.includes('fixed-method'));
      assert(ids.includes('legacy-builtin'));assert(!ids.includes('market-method'));assert(!ids.includes('org-method'));assert.equal(row.state.plugins.find(o=>o.value==='blocked').disabled,true);
    });
    await run('主题选择器支持真实鼠标和键盘，选择本身不派发',async row=>{
      await open('multi');await openPicker('fwdAgentSelect');await key('End');await key('Enter');
      assert.equal((await state()).agent,'local:codex');
      await openPicker('fwdPluginSelect');await key('Home');await key('Down');await key('Enter');
      row.state=await state();assert.equal(row.state.plugin,'flow-office');assert.equal(row.state.choice.type,'workflow');
      assert(!row.state.calls.some(c=>['plugin','direct','native'].includes(c.kind)));
    });
    await run('主题菜单禁用项不可点击且 Escape 只关闭菜单后返回触发器',async row=>{
      await open();await openPicker('fwdAgentSelect');
      const disabled='.fwd-select-popup [role="option"][data-value="local:opencode"]';
      assert.equal(await js(`document.querySelector(${JSON.stringify(disabled)}).getAttribute('aria-disabled')`),'true');
      await click(disabled);assert.equal((await state()).agent,'local:pi');
      await key('Escape');assert.equal(await js(`Boolean(document.querySelector('#fwdPop'))`),true);
      assert.equal(await js(`document.activeElement?.dataset.selectId`),'fwdAgentSelect');
      await choosePopup('fwdSubmissionMode','manual');assert.equal(await js(`document.querySelector('#fwdSubmissionMode').value`),'manual');
      row.state=await state();assert(!row.state.calls.some(c=>['plugin','direct','native'].includes(c.kind)));
    });
    await run('插件与 Agent 独立选择，切回直接执行保留原手选 Agent 和模型',async row=>{
      await open('multi');await select('#fwdAgentSelect','local:codex');await select('#fwdModel','隔离模型');
      await select('#fwdPluginSelect','installed-method');assert.equal((await state()).cards,1);
      assert.equal((await state()).agent,'local:codex');
      await select('#fwdPluginSelect','');assert.equal((await state()).agent,'local:codex');
      assert.equal(await js(`document.querySelector('#fwdModel').value`),'隔离模型');
      await select('#fwdPluginSelect','installed-method');
      await select('#fwdAgentSelect','local:pi');assert.equal((await state()).plugin,'installed-method');
      await select('#fwdPluginSelect','');row.state=await state();assert.equal(row.state.choice.type,'direct');
      assert.equal(row.state.agent,'local:pi');assert.equal(row.state.cards,0);
    });
    await run('刷新目录保留手选插件和运行时 Agent，不抢回推荐项',async row=>{
      await open('multi');await select('#fwdPluginSelect','installed-method');await select('#fwdAgentSelect','local:codex');
      await js(`_loadAIPickList('qa-task')`);row.state=await state();assert.equal(row.state.plugin,'installed-method');assert.equal(row.state.agent,'local:codex');assert.equal(row.state.cards,1);
    });
    await run('固定路由插件的 Agent 只读，不能伪造覆盖配置',async row=>{
      await open();await select('#fwdPluginSelect','fixed-method');row.state=await state();assert.equal(row.state.agentDisabled,true);assert.equal(row.state.disabled,false);
      assert.match(await js(`document.querySelector('#fwdPop').textContent`),/按插件配置|插件已指定/);
    });
    await run('多节点能力由不同 Agent 覆盖时保留自动选择，不虚构单一匹配',async row=>{
      await open('multi');await select('#fwdPluginSelect','mixed-method');row.state=await state();
      assert.equal(row.state.agent,'');assert.equal(row.state.disabled,false);
      assert.equal(row.state.agents.filter(o=>!o.disabled).length,1);assert.match(row.state.agents.find(o=>o.value==='').text,/自动选择/);
      await click('#fwdConfirm');await until(`calls.some(c=>c.kind==='plugin')`);
      const sent=await js(`clone(calls.find(c=>c.kind==='plugin'))`);assert.equal(sent.args[1].execution.agentKind,undefined);
    });
    await run('未就绪 Agent 与插件为禁用项，伪造 change 不触发执行',async row=>{
      await open();assert.equal((await state()).agents.find(o=>o.value==='local:opencode').disabled,true);
      await js(`for(const [id,value] of [['fwdAgentSelect','local:opencode'],['fwdPluginSelect','blocked']]){
        const e=document.getElementById(id);e.value=value;e.dispatchEvent(new Event('change',{bubbles:true}));}void 0;`);
      row.state=await state();assert(!row.state.calls.some(c=>['plugin','direct','native'].includes(c.kind)));
      assert(row.state.disabled||row.state.choice?.id==='local:pi');
    });
    await run('手选 Agent 失效后阻止确认，不自动换为 Pi',async row=>{
      await open('multi');await select('#fwdAgentSelect','local:codex');await js(`fixture.mode='all';_loadAIPickList('qa-task')`);
      row.state=await state();assert.equal(row.state.disabled,true);assert.notEqual(row.state.choice?.id,'local:pi');
    });
    await run('手选插件消失后明确保留失效状态，不改为直接执行',async row=>{
      await open();await select('#fwdPluginSelect','installed-method');await js(`fixture.mode='no-plugins';_loadAIPickList('qa-task')`);
      row.state=await state();assert.equal(row.state.disabled,true);assert.notEqual(row.state.choice?.type,'direct');
      assert.match(await js(`document.querySelector('#fwdPluginSelect').textContent`),/不可用|重新选择/);
      await select('#fwdPluginSelect','');assert.equal((await state()).disabled,false);
    });
    for(const type of ['direct','workflow']) {
      await run('模型目录移除手选模型后必须明确重新选择：'+type,async row=>{
        await open('multi');
        const modelSelector=type==='direct'?'#fwdModel':'[data-fwp-model]';
        if(type==='workflow') {
          await select('#fwdPluginSelect','installed-method');await click('[data-fwp-toggle]');
        }
        await select(modelSelector,'隔离模型');
        for(const models of [['替代模型'],[]]) {
          await js(`fixture.models=${JSON.stringify(models)};_loadAIPickList('qa-task')`);
          row.model=await js(`(()=>{const e=document.querySelector(${JSON.stringify(modelSelector)});return {
            exists:Boolean(e),value:e?.value,selectedText:e?.selectedOptions[0]?.textContent,
            selectedDisabled:e?.selectedOptions[0]?.disabled,confirmDisabled:document.querySelector('#fwdConfirm').disabled};})()`);
          assert.equal(row.model.exists,true);assert.equal(row.model.value,'__unselected__');
          assert.match(row.model.selectedText,/原模型已不可用/);assert.equal(row.model.selectedDisabled,true);
          assert.equal(row.model.confirmDisabled,true);
          await js(`_fwdConfirm('qa-task')`);
          assert.equal(await js(`calls.filter(c=>['direct','plugin'].includes(c.kind)).length`),0);
        }
        if(type==='workflow'&&await js(`document.querySelector('.fwp-body').hidden`))await click('[data-fwp-toggle]');
        row.invalidScreenshot=await screenshot(type+'-model-unavailable');
        await select(modelSelector,'');assert.equal((await state()).disabled,false);
        await click('#fwdConfirm');await until(`calls.some(c=>c.kind===${JSON.stringify(type==='direct'?'direct':'plugin')})&&!document.querySelector('#fwdPop')`);
        row.call=await js(`clone(calls.find(c=>c.kind===${JSON.stringify(type==='direct'?'direct':'plugin')}))`);
        if(type==='direct')assert.equal(row.call.args[4],'');
        else assert.equal(row.call.args[1].execution.model||'','');
      });
    }
    await run('插件提交期间冻结选择，失败后保留固定路由和空工程原有禁用状态',async row=>{
      await open('no-repos');await select('#fwdPluginSelect','fixed-method');
      await js(`window.originalPluginStart=SoduWorkAPI.startTaskPlugin;window.releasePlugin=null;
        SoduWorkAPI.startTaskPlugin=(...args)=>new Promise(resolve=>{calls.push({kind:'plugin',args:clone(args)});releasePlugin=resolve;});
        window.readPluginControls=()=>['fwdPluginSelect','fwdAgentSelect','fwdRepoSel','fwdSubmissionMode','fwdNote'].map(id=>{
          const e=document.getElementById(id);return {id,value:e.value,disabled:e.disabled};});void 0;`);
      try {
        row.before=await js('readPluginControls()');
        assert.equal(row.before.find(e=>e.id==='fwdAgentSelect').disabled,true);
        assert.equal(row.before.find(e=>e.id==='fwdRepoSel').disabled,true);
        await click('#fwdConfirm');await until('Boolean(releasePlugin)');
        row.pending=await js('readPluginControls()');assert(row.pending.every(e=>e.disabled));
        assert.deepEqual(row.pending.map(({id,value})=>({id,value})),row.before.map(({id,value})=>({id,value})));
        await js(`_fwdChoose('qa-task',{type:'direct',id:'local:pi',name:'Pi',available:true});void 0;`);
        assert.equal((await state()).choice.id,'fixed-method');
        row.pendingScreenshot=await screenshot('fixed-plugin-controls-pending');
        await js(`releasePlugin({ok:false,reason:'隔离插件拒绝回执'});void 0;`);
        await until(`!document.querySelector('#fwdConfirm').disabled`);
        row.after=await js('readPluginControls()');assert.deepEqual(row.after,row.before);
        assert.equal(await js(`calls.filter(c=>c.kind==='plugin').length`),1);
      } finally {
        await js(`releasePlugin?.({ok:false,reason:'隔离插件拒绝回执'});SoduWorkAPI.startTaskPlugin=originalPluginStart;void 0;`);
      }
    });
    await run('无插件可直接执行；无 Runner 时不再提供本机对话候选',async row=>{
      await open('no-plugins');assert.equal((await state()).disabled,false);assert.equal((await state()).plugins.filter(o=>o.value).length,0);
      await open('blocked');row.state=await state();assert.equal(row.state.disabled,true);assert.equal(row.state.choice,null);assert.equal(row.state.native,false);
      assert(!row.state.calls.some(c=>c.kind==='probe'));
    });
    await run('Hub 目录为空时真实本机探测补齐同一个 Pi，仅直接执行可用',async row=>{
      await open('local-fallback');await until(`document.querySelector('#fwdAgentSelect')?.value==='local:pi'&&!document.querySelector('#fwdConfirm').disabled`);
      row.state=await state();assert.equal(row.state.choice.type,'direct');assert.equal(row.state.native,false);
      assert.equal(row.state.agents.filter(o=>o.value==='local:pi').length,1);
      assert(!row.state.agents.some(o=>o.value==='local:codex'&&!o.disabled));
      assert.equal(row.state.plugins.find(o=>o.value==='flow-office').disabled,true,'Local session readiness must not unlock a Runner workflow');
      assert(row.state.calls.some(c=>c.kind==='probe'&&c.adapter==='pi'));
      assert.equal(await js(`document.querySelector('#fwdPop').textContent.includes('Pi · 本机对话')`),false);
      row.localScreenshot=await screenshot('local-pi-with-empty-hub');
    });
    await run('Hub 和本机都提供 Pi 时只保留一个候选',async row=>{
      await open('local-dedupe');await key('Shift');row.state=await state();
      assert.equal(row.state.agents.filter(o=>o.value==='local:pi').length,1);assert.equal(row.state.agent,'local:pi');
      assert.equal(row.state.disabled,false);assert.equal(row.state.native,false);
    });
    await run('本机探测成功不覆写 Hub 已明确禁用的同名 Agent',async row=>{
      await open('local-blocked');await until(`calls.some(c=>c.kind==='probe'&&c.adapter==='pi')&&!_fwdLocalLoading`);
      row.state=await state();assert.equal(row.state.disabled,true);
      assert.equal(row.state.agents.filter(o=>o.value==='local:pi').length,1);
      assert.equal(row.state.agents.find(o=>o.value==='local:pi').disabled,true);
    });
    await run('重新检查后保留手选本机 Agent 和模型',async row=>{
      await open('local-fallback');await until(`document.querySelector('#fwdAgentSelect')?.value==='local:pi'&&!_fwdLocalLoading`);
      await select('#fwdAgentSelect','local:pi');await select('#fwdModel','隔离模型');
      const prior=await js(`calls.filter(c=>c.kind==='probe'&&c.adapter==='pi').length`);
      await click('[data-fwd-recheck]');await until(`calls.filter(c=>c.kind==='probe'&&c.adapter==='pi').length>${prior}&&!_fwdLocalLoading`);
      row.state=await state();assert.equal(row.state.agent,'local:pi');assert.equal(row.state.disabled,false);
      assert.equal(await js(`document.querySelector('#fwdModel').value`),'隔离模型');
    });
    await run('注册目录存在但本机探测失败不能伪造可用 Agent',async row=>{
      await open('local-failed');await until(`calls.some(c=>c.kind==='probe'&&c.adapter==='pi')`);await key('Shift');
      row.state=await state();assert.equal(row.state.disabled,true);
      assert(!row.state.agents.some(o=>o.value&&!o.disabled));
      assert(!row.state.calls.some(c=>['direct','plugin','native'].includes(c.kind)));
    });
    await run('连接失败给出可读检查原因，未安装运行时不混入故障提示',async row=>{
      await open('local-diagnostics');await until(`!_fwdLocalLoading&&Boolean(document.querySelector('.fwd-agent-diagnostics'))`);
      await click('.fwd-agent-diagnostics summary');
      row.diagnostics=await js(`document.querySelector('.fwd-agent-diagnostics').innerText`);
      assert.match(row.diagnostics,/1 个 Agent 连接未就绪/);assert.match(row.diagnostics,/Codex/);
      assert.match(row.diagnostics,/测试账号需要重新登录/);assert.doesNotMatch(row.diagnostics,/Qwen|未安装测试运行时/);
      assert.equal((await state()).agent,'local:pi');assert.equal((await state()).disabled,false);
      row.diagnosticsScreenshot=await screenshot('local-runtime-diagnostics');
    });
    await run('工程、已有流程、远程及小队任务不采用本机会话兜底',async row=>{
      const original=await js('clone(taskFixture)');row.scenarios=[];
      try {
        for(const patch of [{repoId:'a'},{workflowBindingId:'saved-flow'},
          {workRouting:{selectedStrategy:'workflow'}},{executionContext:{runner:{mode:'remote',id:'saved-runner'}}},
          {executionContext:{assigneeType:'squad'}}]) {
          await js(`window.taskFixture={...${JSON.stringify(original)},...${JSON.stringify(patch)}};void 0;`);
          await open('local-fallback');await key('Shift');const observed=await state();
          assert.equal(observed.disabled,true,JSON.stringify(patch));
          assert(!observed.agents.some(o=>o.value==='local:pi'&&!o.disabled),JSON.stringify(patch));
          row.scenarios.push({patch,state:observed});
        }
      } finally {await js(`window.taskFixture=${JSON.stringify(original)};void 0;`);}
    });
    await run('本机探测晚到不覆盖已经手选的 Agent 或插件',async row=>{
      for(const selection of ['agent','plugin']) {
        await open('local-pending-multi');await until('Boolean(fixture.localPending.pi)');
        if(selection==='agent')await select('#fwdAgentSelect','local:qwen');
        else await select('#fwdPluginSelect','installed-method');
        const chosen=(await state()).choice;
        await js(`Object.entries(fixture.localPending).forEach(([id,resolve])=>resolve({ok:id==='pi'}));void 0;`);await key('Shift');
        row[selection]=await state();assert.deepEqual(row[selection].choice,chosen);
        if(selection==='agent')assert.equal(row[selection].agent,'local:qwen');
        else assert.equal(row[selection].plugin,'installed-method');
      }
    });
    await run('本机探测增量及收尾保留正在操作的 Agent 插件和模型菜单',async row=>{
      row.menus=[];
      for(const [kind,selector,query,value] of [
        ['agent','#fwdAgentSelect','Qwen','local:qwen'],
        ['plugin','#fwdPluginSelect','已安装','installed-method'],
        ['model','#fwdModel','隔离','隔离模型'],
        ['workflow-model','[data-fwp-model]','隔离','隔离模型'],
      ]) {
        await open('local-pending-multi');await until('Boolean(fixture.localPending.pi)&&Boolean(fixture.localPending.codex)');
        if(kind==='workflow-model') {await select('#fwdPluginSelect','installed-method');await click('[data-fwp-toggle]');}
        const controlId=await js(`document.querySelector(${JSON.stringify(selector)}).id`);
        await openPicker(controlId);win.webContents.insertText(query);
        await until(`document.querySelectorAll('.fwd-select-popup [role="option"]').length===1`);await key('Home');
        await js(`window.menuChanges=0;document.querySelector('#fwdPop').addEventListener('change',()=>menuChanges++);
          window.readActiveMenu=()=>({count:document.querySelectorAll('.fwd-select-popup').length,
            query:document.querySelector('.fwd-select-search')?.value,
            active:document.querySelector('.fwd-select-popup [role="option"].is-active')?.dataset.value,
            focused:document.activeElement?.classList.contains('fwd-select-search'),changes:menuChanges});void 0;`);
        const before=await js('readActiveMenu()');assert.equal(before.query,query);assert.equal(before.active,value);
        await js(`fixture.localPending.pi({ok:true,state:'ready'});void 0;`);
        await until(`_fwdLocalAgents.some(agent=>agent.key==='local:pi')`);await key('Shift');
        const incremental=await js('readActiveMenu()');assert.deepEqual(incremental,before,kind+' incremental update');
        await js(`fixture.localPending.codex({ok:false,state:'unauthed',reason:'隔离账号需登录'});void 0;`);
        await until('!_fwdLocalLoading');await key('Shift');
        const completed=await js('readActiveMenu()');assert.deepEqual(completed,before,kind+' final update');
        assert.equal(await js(`calls.filter(c=>['direct','plugin','native','queue'].includes(c.kind)).length`),0);
        await key('Enter');assert.equal(await js(`document.querySelector(${JSON.stringify(selector)}).value`),value);
        row.menus.push({kind,before,incremental,completed});
      }
    });
    await run('切换工程及重开弹窗后旧本机探测结果不能填回',async row=>{
      await open('local-pending');await until('Boolean(fixture.localPending.pi)');
      await js('window.oldLocalProbes=Object.entries(fixture.localPending);void 0;');await changeRepo('a');
      await until(`_fwdOptions?.selection?.repoId==='a'&&!_fwdLoading.ai`);
      await js(`oldLocalProbes.forEach(([id,resolve])=>resolve({ok:id==='pi'}));void 0;`);await key('Shift');
      row.repository=await state();assert.equal(row.repository.repo,'a');assert.equal(row.repository.disabled,true);
      assert(!row.repository.agents.some(o=>o.value==='local:pi'&&!o.disabled));
      await open('local-pending');await until('Boolean(fixture.localPending.pi)');
      await js('window.oldLocalProbes=Object.entries(fixture.localPending);void 0;');await open('blocked');
      await js(`oldLocalProbes.forEach(([id,resolve])=>resolve({ok:id==='pi'}));void 0;`);await key('Shift');
      row.reopened=await state();assert.equal(row.reopened.disabled,true);assert.equal(row.reopened.choice,null);
      assert(!row.reopened.agents.some(o=>o.value==='local:pi'&&!o.disabled));
    });
    await run('默认 Agent 确认带上说明、模型与交付方式',async row=>{
      await open();await select('#fwdModel','隔离模型');
      await js(`document.querySelector('#fwdNote').value='保留验收材料';document.querySelector('#fwdSubmissionMode').value='manual';void 0;`);
      await click('#fwdConfirm');await until(`calls.some(c=>c.kind==='direct')&&!document.querySelector('#fwdPop')`);
      row.call=await js(`clone(calls.find(c=>c.kind==='direct'))`);assert.equal(row.call.args[1].id,'local:pi');assert.equal(row.call.args[2],'保留验收材料');
      assert.equal(row.call.args[4],'隔离模型');assert.equal(row.call.args[5].strategy,'direct');assert.equal(row.call.args[6],'manual');
    });
    await run('插件确认采用独立 Agent 下拉和关联工程',async row=>{
      await open('multi');await changeRepo('a');await until(`_fwdOptions?.selection?.repoId==='a'&&!_fwdLoading.ai`);
      await select('#fwdPluginSelect','flow-a');await select('#fwdAgentSelect','local:codex');await click('#fwdConfirm');
      await until(`calls.some(c=>c.kind==='plugin')&&!document.querySelector('#fwdPop')`);row.call=await js(`clone(calls.find(c=>c.kind==='plugin'))`);
      assert.equal(row.call.args[1].bindingId,'flow-a');assert.equal(row.call.args[1].repoId,'a');assert.equal(row.call.args[1].execution.agentKind,'local:codex');
    });
    await run('不用插件派发仍保留主动关联的工程',async row=>{
      await open();await changeRepo('b');await until(`_fwdOptions?.selection?.repoId==='b'&&!_fwdLoading.ai`);await click('#fwdConfirm');
      await until(`calls.some(c=>c.kind==='direct')`);row.call=await js(`clone(calls.find(c=>c.kind==='direct'))`);assert.equal(row.call.args[3].id,'b');assert.equal(row.call.args[5].repo.id,'b');
    });
    await run('工程区域在加载、空目录和错误期间可见，重试恢复',async row=>{
      await js(`fixture.mode='hold-first';fixture.pending={};RequirementAssignment.open('qa-task')`);await until('Boolean(fixture.pending.first)');
      assert.equal(await js(`document.querySelector('#fwdRepo').getClientRects().length>0`),true);await js('fixture.pending.first();void 0;');await until('!_fwdLoading.ai');
      await open('no-repos');assert.equal(await js(`document.querySelector('#fwdRepo').getClientRects().length>0`),true);
      await js(`RequirementAssignment.close();fixture.mode='error';RequirementAssignment.open('qa-task')`);await until(`Boolean(document.querySelector('[data-fwd-retry]'))`);
      assert.equal((await state()).disabled,true);await js(`fixture.mode='all';void 0;`);await click('[data-fwd-retry]');
      await until(`Boolean(document.querySelector('#fwdAgentSelect'))&&!_fwdLoading.ai`);row.state=await state();assert.equal(row.state.disabled,false);
    });
    await run('工程迟到响应和已关闭弹层响应不覆盖当前选择',async row=>{
      await open('hold-api');await changeRepo('a');await until('Boolean(fixture.pending.a)');assert.equal((await state()).disabled,true);
      await changeRepo('b');await until(`_fwdOptions?.selection?.repoId==='b'&&!_fwdLoading.ai`);await js('fixture.pending.a();void 0;');await key('Shift');
      assert.equal((await state()).optionsRepo,'b');await open('hold-api');await changeRepo('a');await until('Boolean(fixture.pending.a)');
      await js('window.oldReply=fixture.pending.a;void 0;');await open('blocked');await js('oldReply();void 0;');await key('Shift');
      row.state=await state();assert.equal(row.state.disabled,true);assert.equal(row.state.optionsRepo,'');
    });
    await run('Tab 留在弹层，Escape 关闭后焦点回到发起入口',async row=>{
      await js(`RequirementAssignment.close();document.querySelector('#opener').focus();void 0;`);await open();
      await js(`document.querySelector('#fwdConfirm').focus();void 0;`);await key('Tab');assert.equal(await js(`document.activeElement===document.querySelector('[data-act="fwd-close"]')`),true);
      await key('Escape');await until(`!document.querySelector('#fwdPop')`);row.focus=await js('document.activeElement.id');assert.equal(row.focus,'opener');
    });
    await run('同事候选沿用紧凑布局并可选择，不受左列样式影响',async row=>{
      await open('mates');await click('[data-fwdtab="mate"]');await until(`Boolean(document.querySelector('[data-aid="fixture-colleague"]'))`);
      await click('[data-aid="fixture-colleague"]');
      row.mate=await js(`(()=>{const item=document.querySelector('[data-aid="fixture-colleague"]'),main=item.querySelector('.fwd-main'),r=item.getBoundingClientRect();return {
        id:_fwdSelection.mate?.id,disabled:document.querySelector('#fwdConfirm').disabled,height:r.height,
        paddingRight:getComputedStyle(main).paddingRight,overflow:main.scrollWidth>main.clientWidth+2,
        available:item.disabled,offline:document.querySelector('[data-aid="fixture-offline"]')?.disabled,
        hiddenAgent:!document.querySelector('#fwdAgentSelect')};})()`);
      assert.equal(row.mate.id,'fixture-colleague');assert.equal(row.mate.disabled,false);assert(row.mate.height<110);
      assert.equal(row.mate.paddingRight,'0px');assert.equal(row.mate.overflow,false);assert.equal(row.mate.available,false);
      assert.equal(row.mate.hiddenAgent,true);assert.equal(await js(`calls.filter(c=>['direct','plugin','native'].includes(c.kind)).length`),0);
      row.mateScreenshot=await screenshot('colleague-layout');
      await click('[data-fwdtab="ai"]');await until(`Boolean(document.querySelector('.fwd-select-trigger[data-select-id="fwdAgentSelect"]'))`);
      assert.equal((await state()).agent,'local:pi');
    });
    // Keep catalog/material reads deterministic, but exercise the real API
    // method and its real receipt/error conversion instead of the success stub.
    await js('RequirementAssignment.close();window.choiceFixtureAPI=window.SoduWorkAPI;void 0;');
    for (const file of ['core/api-work-plugins.js', 'api.js']) {
      await js(fs.readFileSync(path.join(client, file), 'utf8') + '\nvoid 0;');
    }
    await js(`window.productionDispatchToAI=SoduWorkAPI.dispatchToAI;
      const {clientId,...fixtureAPI}=choiceFixtureAPI;
      Object.defineProperty(SoduWorkAPI,'clientId',{get:()=>clientId});
      Object.assign(SoduWorkAPI,fixtureAPI,{dispatchToAI:productionDispatchToAI});void 0;`);
    const bootSource = fs.readFileSync(path.join(client, 'desk-boot.js'), 'utf8');
    const humanError = bootSource.match(/window\._humanErr = function \(e, fallback\) \{[\s\S]*?\n  \};/);
    assert(humanError, 'The production workspace error formatter must be available');
    await js(humanError[0] + '\nvoid 0;');
    report.productionDispatchBoundary = {
      api: 'client/api.js dispatchToAI (unmodified function)',
      feedback: 'client/desk-boot.js _humanErr (unmodified function)',
      execution: 'NativeChat.enqueueTask deterministic receipt; no real task or model',
    };
    win.setContentSize(1280, 960);

    await run('Current-device endpoint aliases collapse without changing model values or leaking Runner identity', async row => {
      await open('local-pending-device-key');
      await until(`Boolean(fixture.localPending.pi && fixture.localPending.codex)`);
      assert.equal((await state()).agent, 'runner:fixture-device:pi');
      await select('#fwdModel', '隔离模型');
      await js(`fixture.localPending.pi({ok:true,state:'ready'});fixture.localPending.codex({ok:false,state:'missing'});void 0;`);
      await until(`!_fwdLocalLoading`);
      row.state=await state();
      assert.equal(row.state.agents.filter(o=>o.value==='local:pi'||o.value==='runner:fixture-device:pi').length,1);
      assert.equal(row.state.agent,'local:pi');
      assert.equal(await js(`document.querySelector('#fwdModel').value`),'隔离模型');
      await js(`_fwdOptions.modelOptions=[{name:'local:model-fixture',label:'Fixture local model',localOnly:true}];
        _fwdOptions.defaultModels={pi:'隔离模型'};_fwdSyncConfirm('qa-task');void 0;`);
      await choosePopup('fwdModel','local:model-fixture');
      await js(`NativeChat.enqueueTask=async(...args)=>{calls.push({kind:'queue',args:clone(args)});return {ok:true,conversationId:'fixture-local-model'};};void 0;`);
      await click('#fwdConfirm');await until(`calls.some(c=>c.kind==='queue')`);
      row.receipt=await js(`calls.find(c=>c.kind==='queue').args[1]`);
      assert.equal(row.receipt.agentId,'local:pi');assert.equal(row.receipt.model,'local:model-fixture');
      assert.equal(row.receipt.executionContext.agent.id,'local:pi');
      assert.equal(row.receipt.executionContext.runner.runnerId,'');
      assert.equal(row.receipt.executionContext.runner.clientId,'');
    });
    await run('A manual Runner selection survives its later native probe and excludes local model references', async row => {
      await open('local-pending-device-key');
      await until(`Boolean(fixture.localPending.pi && fixture.localPending.codex)`);
      await select('#fwdAgentSelect','runner:fixture-device:pi');
      await select('#fwdModel','隔离模型');
      await js(`fixture.localPending.pi({ok:true,state:'ready'});fixture.localPending.codex({ok:false,state:'missing'});void 0;`);
      await until(`!_fwdLocalLoading`);
      await js(`_fwdOptions.modelOptions=[{name:'local:model-fixture',label:'Fixture local model',localOnly:true}];_fwdSyncConfirm('qa-task');void 0;`);
      row.state=await state();
      assert.equal(row.state.agents.filter(o=>o.value==='local:pi'||o.value==='runner:fixture-device:pi').length,1);
      assert.equal(row.state.agent,'runner:fixture-device:pi');
      assert.equal(await js(`[...document.querySelector('#fwdModel').options].some(o=>o.value==='local:model-fixture')`),false);
      await click('#fwdConfirm');await until(`calls.some(c=>c.kind==='queue')`);
      row.receipt=await js(`calls.find(c=>c.kind==='queue').args[1]`);
      assert.equal(row.receipt.agentId,'runner:fixture-device:pi');assert.equal(row.receipt.model,'隔离模型');
      assert.equal(row.receipt.executionContext.runner.runnerId,'fixture-runner');
    });

    await run('Switching from native Pi to another runtime removes the local model without changing managed choices', async row => {
      await open('local-many');await until(`!_fwdLocalLoading`);
      await js(`_fwdOptions.modelOptions=[{name:'local:model-fixture',label:'Fixture local model',localOnly:true}];_fwdSyncConfirm('qa-task');void 0;`);
      await choosePopup('fwdAgentSelect','local:pi');await choosePopup('fwdModel','local:model-fixture');
      await choosePopup('fwdAgentSelect','local:qwen');
      assert.equal(await js(`_fwdModel`),'');
      assert.equal(await js(`[...document.querySelector('#fwdModel').options].some(o=>o.value==='local:model-fixture')`),false);
      await choosePopup('fwdModel','隔离模型');
      await click('#fwdConfirm');await until(`calls.some(c=>c.kind==='queue')`);
      row.receipt=await js(`calls.find(c=>c.kind==='queue').args[1]`);
      assert.equal(row.receipt.agentId,'local:qwen');assert.equal(row.receipt.model,'隔离模型');
    });

    await run('Rechecking a legacy local Agent preserves its local model through probe failure and recovery', async row => {
      await js(`soduWorkAPI.localModels={get:async()=>({usable:[{name:'local:model-fixture',label:'Fixture local model',localOnly:true}]})};void 0;`);
      try {
        await open('local-dedupe');await until(`!_fwdLocalLoading`);
        await choosePopup('fwdModel','local:model-fixture');
        await js('fixture.holdLocalProbe=true;void 0;');await click('[data-fwd-recheck]');
        await until(`Boolean(fixture.localPending.pi&&fixture.localPending.codex)`);
        row.pending=await js(`({model:_fwdModel,disabled:document.querySelector('#fwdConfirm').disabled})`);
        assert.equal(row.pending.model,'local:model-fixture');assert.equal(row.pending.disabled,true);
        await js(`fixture.localPending.pi({ok:false,state:'unauthed'});fixture.localPending.codex({ok:false,state:'missing'});void 0;`);
        await until(`!_fwdLocalLoading`);
        row.failed=await js(`({model:_fwdModel,value:document.querySelector('#fwdModel').value,disabled:document.querySelector('#fwdConfirm').disabled})`);
        assert.equal(row.failed.model,'local:model-fixture');assert.equal(row.failed.value,'__unselected__');
        assert.equal(row.failed.disabled,true);
        assert.equal(await js(`calls.filter(c=>c.kind==='queue').length`),0);
        await js('fixture.holdLocalProbe=false;void 0;');await click('[data-fwd-recheck]');
        await until(`!_fwdLocalLoading && document.querySelector('#fwdModel')?.value==='local:model-fixture'`);
        assert.equal(await js(`document.querySelector('#fwdConfirm').disabled`),false);
        await choosePopup('fwdModel','');assert.equal(await js('_fwdModel'),'');
      } finally {await js('delete soduWorkAPI.localModels;void 0;');}
    });
    await run('Workflow selection excludes local models and preserves the remembered native choice', async row => {
      await open('local-dedupe');await until(`!_fwdLocalLoading`);
      await js(`_fwdOptions.modelOptions=[{name:'local:model-fixture',label:'Fixture local model',localOnly:true}];_fwdSyncConfirm('qa-task');void 0;`);
      await choosePopup('fwdModel','local:model-fixture');
      await choosePopup('fwdPluginSelect','flow-office');
      assert.equal(await js('_fwdModel'),'');
      assert.equal(await js(`Boolean(document.querySelector('#fwdModel'))`),false);
      assert.equal(await js(`document.querySelector('#fwdConfirm').disabled`),false);
      row.workflowModels=await js(`[...document.querySelector('[data-fwp-model]').options].map(o=>o.value)`);
      assert.equal(row.workflowModels.includes('local:model-fixture'),false);
      assert.equal(row.workflowModels.includes('隔离模型'),true);
      await choosePopup('fwdPluginSelect','');
      assert.equal(await js(`document.querySelector('#fwdModel').value`),'local:model-fixture');
      await choosePopup('fwdPluginSelect','flow-office');
      await js(`_fwdWorkflowChoices.get('flow-office').model='local:model-fixture';
        _fwdRenderAIPickers('qa-task',document.querySelector('#fwdList'));_fwdSyncConfirm('qa-task');void 0;`);
      assert.equal(await js(`document.querySelector('[data-fwp-model]').value`),'__unselected__');
      assert.equal(await js(`document.querySelector('#fwdConfirm').disabled`),true);
      await select('[data-fwp-model]','隔离模型');
      assert.equal(await js(`document.querySelector('#fwdConfirm').disabled`),false);
    });
    await run('五个就绪运行时均可从主题菜单选择并经正式 API 进入对应会话队列',async row=>{
      row.runtimeReceipts=[];
      for(const adapter of ['pi','qwen','codex','codex-harness','dsh']) {
        await open('local-many');await until(`!_fwdLocalLoading&&document.querySelector('#fwdAgentSelect').options.length===5`);
        await choosePopup('fwdAgentSelect','local:'+adapter);
        await choosePopup('fwdSubmissionMode','manual');
        if(adapter!=='codex')await choosePopup('fwdModel','隔离模型');
        else assert.equal(await js(`Boolean(document.querySelector('#fwdModel'))`),false);
        await js(`NativeChat.enqueueTask=async(...args)=>{calls.push({kind:'queue',args:clone(args)});
          return {ok:true,conversationId:'fixture-${adapter}-conversation'};};void 0;`);
        await click('#fwdConfirm');await until(`calls.some(c=>c.kind==='queue')&&!document.querySelector('#fwdPop')`);
        const receipt=await js(`({queue:calls.filter(c=>c.kind==='queue'),navigation:calls.filter(c=>c.kind==='navigate')})`);
        assert.equal(receipt.queue.length,1);assert.equal(receipt.queue[0].args[0],'qa-task');
        const execution=receipt.queue[0].args[1];
        assert.equal(execution.agentId,'local:'+adapter);assert.equal(execution.executionContext.agent.id,'local:'+adapter);
        assert.equal(execution.executionContext.strategy,'direct');assert.equal(execution.executionContext.runner.mode,'local');
        assert.equal(execution.submissionMode,'manual');assert.equal(execution.model,adapter==='codex'?'':'隔离模型');
        assert.equal(receipt.navigation.length,1);assert.equal(receipt.navigation[0].args[2].chatId,'fixture-'+adapter+'-conversation');
        row.runtimeReceipts.push({adapter,...receipt});
      }
    });
    await run('主题菜单真实搜索和 Tab 导航不提前派发',async row=>{
      await open('local-many');await until('!_fwdLocalLoading');await openPicker('fwdAgentSelect');
      win.webContents.insertText('Qwen');await until(`document.querySelectorAll('.fwd-select-popup [role="option"]').length===1`);
      assert.equal(await js(`document.querySelector('.fwd-select-popup [role="option"]').dataset.value`),'local:qwen');
      await key('Enter');assert.equal((await state()).agent,'local:qwen');
      await openPicker('fwdPluginSelect');await key('Tab');
      assert.equal(await js(`Boolean(document.querySelector('.fwd-select-popup'))`),false);
      row.focus=await js(`({tag:document.activeElement.tagName,disabled:document.activeElement.disabled,
        inDialog:document.querySelector('#fwdPop').contains(document.activeElement)})`);
      assert.equal(row.focus.inDialog,true);assert.equal(row.focus.disabled,false);assert.notEqual(row.focus.tag,'SELECT');
      assert.equal(await js(`calls.filter(c=>['queue','direct','plugin'].includes(c.kind)).length`),0);
    });
    await run('Hub 空目录下本机 Pi 从正式确认按钮进入既有派发队列',async row=>{
      await open('local-fallback');await until(`document.querySelector('#fwdAgentSelect')?.value==='local:pi'&&!document.querySelector('#fwdConfirm').disabled`);
      await js(`NativeChat.enqueueTask=async(...args)=>{calls.push({kind:'queue',args:clone(args)});return {ok:true,conversationId:'local-runtime-fixture'};};void 0;`);
      await click('#fwdConfirm');await until(`calls.some(c=>c.kind==='queue')&&!document.querySelector('#fwdPop')`);
      row.call=await js(`clone(calls.find(c=>c.kind==='queue'))`);
      assert.equal(await js('SoduWorkAPI.dispatchToAI===productionDispatchToAI'),true);
      assert.equal(row.call.args[0],'qa-task');assert.equal(row.call.args[1].agentId,'local:pi');
      assert.equal(row.call.args[1].executionContext.agent.id,'local:pi');
      assert.equal(row.call.args[1].executionContext.strategy,'direct');assert.equal(row.call.args[1].executionContext.runner.mode,'local');
      assert.equal(await js(`calls.filter(c=>c.kind==='queue').length`),1);
    });
    await run('正式派发等待回执时冻结两个下拉及工程模型交付方式，拒绝后完整恢复',async row=>{
      await open('multi');await changeRepo('a');await until(`_fwdOptions?.selection?.repoId==='a'&&!_fwdLoading.ai`);
      await select('#fwdAgentSelect','local:codex');await select('#fwdModel','隔离模型');
      await js(`window.releaseBusy=null;NativeChat.enqueueTask=(...args)=>new Promise(resolve=>{
        calls.push({kind:'queue',args:clone(args)});releaseBusy=resolve;});
        document.querySelector('#fwdSubmissionMode').value='manual';document.querySelector('#fwdNote').value='锁定后的交代';
        window.readBusyControls=()=>['fwdPluginSelect','fwdAgentSelect','fwdRepoSel','fwdModel','fwdSubmissionMode','fwdNote'].map(id=>{
          const e=document.getElementById(id);return {id,value:e.value,disabled:e.disabled};});void 0;`);
      row.before=await js('readBusyControls()');assert(row.before.every(e=>!e.disabled));
      await click('#fwdConfirm');await until('Boolean(releaseBusy)');
      row.pending=await js('readBusyControls()');assert(row.pending.every(e=>e.disabled));
      row.pendingTriggers=await js(`[...document.querySelectorAll('.fwd-select-trigger')].map(e=>({id:e.dataset.selectId,disabled:e.disabled}))`);
      assert.equal(row.pendingTriggers.length,5);assert(row.pendingTriggers.every(e=>e.disabled));
      assert.deepEqual(row.pending.map(({id,value})=>({id,value})),row.before.map(({id,value})=>({id,value})));
      await js(`_fwdChoose('qa-task',{type:'workflow',id:'installed-method',name:'已安装的方法',available:true});void 0;`);
      assert.equal((await state()).choice.id,'local:codex');assert.equal((await state()).plugin,'');
      await js(`window.enabledPending=[...document.querySelectorAll('#fwdPop button,#fwdPop input,#fwdPop textarea,#fwdPop select')]
        .filter(e=>!e.disabled&&e.getClientRects().length);enabledPending.at(-1).focus();void 0;`);await key('Tab');
      // Dispatch locks the tabs as well as selectors. The close control is the
      // only focus target, so both Tab directions must remain on that control.
      row.pendingFocusableCount=await js('enabledPending.length');
      assert.equal(row.pendingFocusableCount,1);
      assert.equal(await js(`document.activeElement===enabledPending[0]`),true);
      await key('Tab');
      assert.equal(await js(`document.activeElement===enabledPending[0]`),true);
      for(const type of ['keyDown','keyUp'])win.webContents.sendInputEvent({type,keyCode:'Tab',modifiers:['shift']});
      await js('new Promise(r=>requestAnimationFrame(()=>r(true)))');
      assert.equal(await js(`document.activeElement===enabledPending[0]`),true);
      await key('Escape');assert.equal(await js(`Boolean(document.querySelector('#fwdPop'))`),true);
      row.pendingScreenshot=await screenshot('direct-controls-pending');
      await js(`releaseBusy({ok:false,reason:'隔离执行端暂未接单'});void 0;`);
      await until(`!document.querySelector('#fwdConfirm').disabled`);
      row.after=await js('readBusyControls()');assert.deepEqual(row.after,row.before);
      assert.equal(await js(`document.querySelector('#fwdAgentSelect option[value="local:opencode"]').disabled`),true);
      row.call=await js(`clone(calls.find(c=>c.kind==='queue'))`);
      assert.equal(await js(`calls.filter(c=>c.kind==='queue').length`),1);
      assert.equal(row.call.args[1].agentId,'local:codex');assert.equal(row.call.args[1].model,'隔离模型');
      assert.equal(row.call.args[1].submissionMode,'manual');assert.equal(row.call.args[1].brief,'锁定后的交代');
      assert.equal(row.call.args[1].executionContext.repo.id,'a');
    });
    for (const [field, message] of [
      ['reason', '这条需求已绑定到其他项目，请重新选择执行会话'],
      ['error', '请先在模型设置中选择可用模型'],
      ['message', '当前需求正在等待验收，不能再次安排执行'],
      ['', '需求未能进入会话队列'],
    ]) {
      await run('正式派活 API 与错误提示保留会话拒绝：' + (field || '空回执'), async row => {
        await open();
        const receipt = field ? {ok:false,[field]:message} : null;
        await js(`NativeChat.enqueueTask=async(...args)=>{
          calls.push({kind:'queue',args:clone(args)});return ${JSON.stringify(receipt)};};void 0;`);
        assert.equal(await js('SoduWorkAPI.dispatchToAI===productionDispatchToAI'), true);
        await click('#fwdConfirm');
        await until(`calls.some(c=>c.kind==='queue') && !document.querySelector('#fwdConfirm').disabled`);
        row.feedback = await js(`({message:document.querySelector('#fwdStatus').textContent,
          open:Boolean(document.querySelector('#fwdPop')),selection:_fwdSelection.ai.type,
          queueCalls:calls.filter(c=>c.kind==='queue'),navigation:calls.filter(c=>c.kind==='navigate'),toasts:clone(toasts)})`);
        assert.equal(row.feedback.message, message);
        assert.equal(row.feedback.open, true);
        assert.equal(row.feedback.selection, 'direct');
        assert.equal(row.feedback.queueCalls.length, 1);
        assert.equal(row.feedback.queueCalls[0].args[0], 'qa-task');
        assert.equal(row.feedback.queueCalls[0].args[1].agentId, 'local:pi');
        assert.equal(row.feedback.queueCalls[0].args[1].executionContext.strategy, 'direct');
        assert.deepEqual(row.feedback.navigation, []);
        assert.deepEqual(row.feedback.toasts, []);
      });
    }
    await run('正式派活 API 拒绝后可原窗重试，等待回执时重复点击只派发一次', async row => {
      await open();
      await js(`window.queueAttempts=0;window.acceptedQueueCount=0;window.releaseQueue=null;
        window.appliedTaskReceipts=[];window.Store={applyServerEvent:event=>appliedTaskReceipts.push(clone(event))};
        NativeChat.enqueueTask=async(...args)=>{
          calls.push({kind:'queue',args:clone(args)});queueAttempts++;
          if(queueAttempts===1)return{ok:false,reason:'本机执行会话尚未就绪，请重试'};
          return new Promise(resolve=>{releaseQueue=()=>{acceptedQueueCount++;
            resolve({ok:true,conversationId:'qa-retry-conversation',task:{...clone(taskFixture),status:'doing'}});};});
        };
        document.querySelector('#fwdNote').value='保留本次补充说明';
        document.querySelector('#fwdModel').value='隔离模型';
        document.querySelector('#fwdModel').dispatchEvent(new Event('change'));
        document.querySelector('#fwdSubmissionMode').value='manual';void 0;`);
      await click('#fwdConfirm');
      await until(`document.querySelector('#fwdStatus').textContent==='本机执行会话尚未就绪，请重试'`);
      row.refusedScreenshot = await screenshot('production-dispatch-refused');
      assert.equal(await js('queueAttempts'), 1);
      assert.equal(await js(`document.querySelector('#fwdConfirm').disabled`), false);
      assert.equal(await js('appliedTaskReceipts.length'), 0);
      await click('#fwdConfirm');
      await until('Boolean(releaseQueue)');
      assert.equal(await js(`document.querySelector('#fwdConfirm').disabled`), true);
      await click('#fwdConfirm');
      assert.equal(await js('queueAttempts'), 2, 'The busy native button cannot enqueue a second retry');
      assert.equal(await js('acceptedQueueCount'), 0);
      row.waitingScreenshot = await screenshot('production-dispatch-waiting');
      await js('releaseQueue();void 0;');
      await until(`!document.querySelector('#fwdPop') && calls.some(c=>c.kind==='navigate')`);
      row.receipt = await js(`({attempts:queueAttempts,accepted:acceptedQueueCount,
        queueCalls:calls.filter(c=>c.kind==='queue'),navigation:calls.filter(c=>c.kind==='navigate'),
        applied:clone(appliedTaskReceipts),toasts:clone(toasts)})`);
      assert.equal(row.receipt.attempts, 2);
      assert.equal(row.receipt.accepted, 1);
      assert.equal(row.receipt.navigation.length, 1);
      assert.equal(row.receipt.navigation[0].args[0], 'qa-task');
      assert.equal(row.receipt.applied.length, 1);
      assert.equal(row.receipt.applied[0].task.status, 'doing');
      const options = row.receipt.queueCalls[1].args[1];
      assert.equal(options.source, 'task-dispatch');
      assert.equal(options.agentId, 'local:pi');
      assert.equal(options.brief, '保留本次补充说明');
      assert.equal(options.model, '隔离模型');
      assert.equal(options.submissionMode, 'manual');
      assert.deepEqual(row.receipt.toasts, ['已交给 Pi。']);
    });
    await run('切换账号后迟到派发回执不能跳转或通知新账号',async row=>{
      await open();await js(`window.releaseOld=null;NativeChat.enqueueTask=(...args)=>new Promise(r=>{calls.push({kind:'queue',args:clone(args)});releaseOld=r;});void 0;`);
      await click('#fwdConfirm');await until('Boolean(releaseOld)');await js(`dispatchEvent(new Event('soduwork-data-scope-changed'));releaseOld({ok:true});void 0;`);await key('Shift');
      row.calls=await js('clone(calls)');assert(!row.calls.some(c=>c.kind==='navigate'));assert.equal(await js('toasts.length'),0);
    });
    for(const [theme,color,width,height,plugin] of [['blue','#387cff',1280,960,false],['purple','#8b5cf6',1280,960,true],
      ['blue','#387cff',375,667,false],['purple','#8b5cf6',680,760,true]]) {
      await run('蓝紫主题与窄屏布局 '+theme+' '+width+'×'+height,async row=>{
        win.setContentSize(width,height);await js(`document.documentElement.style.setProperty('--accent',${JSON.stringify(color)});
          document.documentElement.style.setProperty('--accent-soft',${JSON.stringify('color-mix(in srgb,'+color+' 9%,white)')});void 0;`);
        await open('multi');if(plugin)await select('#fwdPluginSelect','installed-method');
        row.geometry=await js(`(()=>{const p=document.querySelector('#fwdPop'),c=document.querySelector('#fwdConfirm'),r=p.getBoundingClientRect(),b=c.getBoundingClientRect();
          const main=p.querySelector('.frw-main').getBoundingClientRect(),settings=p.querySelector('.fwd-settings').getBoundingClientRect();
          return {popup:{left:r.left,top:r.top,right:r.right,bottom:r.bottom},footer:{top:b.top,bottom:b.bottom},
            main:{left:main.left,right:main.right,top:main.top,bottom:main.bottom},settings:{left:settings.left,top:settings.top},
            summaries:p.querySelectorAll('.fwd-picked,#fwdAgentSummary').length,
            nativeSelects:[...p.querySelectorAll('select')].filter(e=>e.getClientRects().length).length,
            selectors:[...p.querySelectorAll('.fwd-select-trigger')]
              .filter(e=>e.getClientRects().length).map(e=>({id:e.dataset.selectId,height:e.getBoundingClientRect().height})),
            hit:c.contains(document.elementFromPoint(b.x+b.width/2,b.y+b.height/2)),overflow:[p,...p.querySelectorAll('.fwd-scroll,.frw-main,.fwd-settings,.fwd-select-trigger')]
              .filter(e=>e.getClientRects().length&&e.scrollWidth>e.clientWidth+2).map(e=>e.id||e.className)};})()`);
        const g=row.geometry;assert(g.popup.left>=0&&g.popup.top>=0&&g.popup.right<=width+1&&g.popup.bottom<=height+1,JSON.stringify(g));
        assert(g.footer.top>=0&&g.footer.bottom<=height&&g.hit,JSON.stringify(g));assert.deepEqual(g.overflow,[]);
        assert.equal(g.summaries,0);assert.equal(g.nativeSelects,0);
        if(width>720)assert(g.main.right<=g.settings.left+1,JSON.stringify(g));
        else assert(g.settings.top>=g.main.bottom-1,JSON.stringify(g));
        assert(g.selectors.length>=4,JSON.stringify(g.selectors));
        assert(g.selectors.every(e=>e.height>=34&&e.height<=40),JSON.stringify(g.selectors));
        row.themedScreenshot=await screenshot(theme+'-'+width+'-'+(plugin?'plugin':'direct'));
        await openPicker('fwdAgentSelect');
        row.menu=await js(`(()=>{const e=document.querySelector('.fwd-select-popup'),r=e.getBoundingClientRect();return {
          left:r.left,top:r.top,right:r.right,bottom:r.bottom,accent:getComputedStyle(e).getPropertyValue('--accent').trim(),
          options:[...e.querySelectorAll('[role="option"]')].map(o=>({value:o.dataset.value,disabled:o.getAttribute('aria-disabled')}))};})()`);
        assert(row.menu.left>=0&&row.menu.top>=0&&row.menu.right<=width+1&&row.menu.bottom<=height+1,JSON.stringify(row.menu));
        assert.equal(row.menu.accent,color);row.menuScreenshot=await screenshot(theme+'-'+width+'-agent-popup');
        await key('End');await key('Enter');assert.equal((await state()).agent,'local:codex');
        row.agentReachable=await js(`(()=>{const e=document.querySelector('.fwd-select-trigger[data-select-id="fwdAgentSelect"]'),r=e.getBoundingClientRect();
          return e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));})()`);
        assert.equal(row.agentReachable,true);row.agentScreenshot=await screenshot(theme+'-'+width+'-agent-visible');
      });
    }

    for (const file of JSON.parse(fs.readFileSync(path.join(client,'core/locales/manifest.json'),'utf8')))
      await js(fs.readFileSync(path.join(client,'core/locales',file),'utf8'));
    for (const file of ['core/i18n-dom.js','core/i18n.js']) await js(fs.readFileSync(path.join(client,file),'utf8'));
    for (const [locale,label] of [['zh-CN','跟随底座默认'],['en-US','Use runtime default'],
      ['ja-JP','基盤のデフォルトに従う'],['ko-KR','기반 기본값 따르기']]) {
      await run('Default strategy and concrete model remain distinct in '+locale, async row => {
        await js(`SoduWorkI18n.setLocale('zh-CN',{persist:false,broadcast:false});void 0;`);
        await open();
        await js(`_fwdOptions.models=['fixture-model'];_fwdOptions.defaultModel='fixture-model';
          _fwdOptions.defaultModels={pi:'fixture-model'};
          _fwdOptions.modelOptions=[{name:'fixture-model',providerId:'fixture-provider',providerName:'Fixture provider'}];
          _fwdSyncConfirm('qa-task');
          SoduWorkI18n.setLocale(${JSON.stringify(locale)},{persist:false,broadcast:false});void 0;`);
        await until(`document.querySelector('.fwd-select-trigger[data-select-id="fwdModel"]').title.includes(${JSON.stringify(label)})`);
        await openPicker('fwdModel');
        row.menu=await js(`({rows:[...document.querySelectorAll('.fwd-select-popup [role="option"]')].map(o=>({value:o.dataset.value,text:o.textContent.replace('✓','').trim(),title:o.title})),
          trigger:document.querySelector('.fwd-select-trigger[data-select-id="fwdModel"]').title})`);
        assert.equal(row.menu.rows.length,2);
        assert.equal(row.menu.rows[0].value,'');assert.equal(row.menu.rows[0].text,label);
        assert.equal(row.menu.rows[0].title,label+' · fixture-model · Fixture provider');
        assert.equal(row.menu.rows[1].value,'fixture-model');
        assert.equal(row.menu.rows[1].text,'fixture-model · Fixture provider');
        assert.equal(row.menu.trigger,row.menu.rows[0].title);
        await js('ForwardSelect.closeAll();void 0;');
        await choosePopup('fwdModel','fixture-model');
        assert.equal(await js('_fwdModel'),'fixture-model');
        await choosePopup('fwdModel','');
        assert.equal(await js('_fwdModel'),'');
      });
    }
    report.errors = await js('errors.slice()');
  }).catch(error => { report.error = String(error.stack || error); }).finally(async () => {
    if (win) report.errors = await js('errors.slice()').catch(() => report.errors);
    report.ok = !report.error && report.cases.length > 0 && report.cases.every(row => row.ok) && !report.errors.length && !report.networkRequests.length;
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ok:report.ok,baseline,cases:report.cases.map(({name,ok,error})=>({name,ok,error})),error:report.error,
      errors:report.errors,networkRequests:report.networkRequests,out}, null, 2));
    win?.destroy(); app.exit(report.ok ? 0 : 1);
  });
}
