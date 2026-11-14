import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawn} from 'node:child_process';
import {CdpPage,listPages,delay} from './lib/cdp.mjs';
const out=path.resolve(process.argv[2]||'automation-create-evidence');fs.mkdirSync(out,{recursive:true});
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'soduwork-automation-menu-'));let page;
const checks=[];let lastRuntimeErrors=[];
const check=(name,ok)=>{checks.push({name,ok:Boolean(ok)});if(!ok)throw Error(name)};
const browser=process.env.SODUWORK_TEST_BROWSER || (process.platform==='darwin'
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  : 'C:/Program Files/Google/Chrome/Application/chrome.exe');
const chrome=spawn(browser,['--headless=new','--disable-gpu','--no-first-run','--remote-debugging-port=0','--remote-debugging-address=127.0.0.1','--user-data-dir='+profile,'--window-size=1440,1050','about:blank'],{windowsHide:true,stdio:'ignore'});
async function click(s){await page.run(s=>document.querySelector(s).scrollIntoView({block:'nearest'}),s);const p=await page.run(s=>{const r=document.querySelector(s).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}},s);for(const type of ['mouseMoved','mousePressed','mouseReleased'])await page.call('Input.dispatchMouseEvent',{type,...p,button:type==='mouseMoved'?'none':'left',clickCount:type==='mouseMoved'?0:1})}
async function key(key,code=key,modifiers=0){await page.call('Input.dispatchKeyEvent',{type:'keyDown',key,code,modifiers,text:key==='Enter'?'\r':'',unmodifiedText:key==='Enter'?'\r':'',windowsVirtualKeyCode:({Enter:13,Tab:9,Escape:27,ArrowUp:38,ArrowDown:40,Home:36,End:35})[key]||0});await page.call('Input.dispatchKeyEvent',{type:'keyUp',key,code,modifiers})}
async function fill(s,text){await click(s);await page.run(s=>document.querySelector(s).select(),s);await page.call('Input.insertText',{text})}
async function shot(name){await delay(160);const r=await page.call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,name),Buffer.from(r.data,'base64'))}
async function back(){await page.run(()=>WorkspaceHost.open('schedules'));await delay(100)}
const managedRuntimes=['pi','qwen','opencode','dsh','kimi','harness2','codex-harness'];
const localModel='local:model-0123456789abcdef0123456789abcdef';
async function modelMatrix(agentSelector,modelSelector){
 for(const runtime of managedRuntimes){
  const agent='local:'+runtime;
  check(runtime+' is offered as an automation runtime',await page.run(({agentSelector,agent})=>[...document.querySelector(agentSelector).options].some(row=>row.value===agent),{agentSelector,agent}));
  await page.run(({agentSelector,agent})=>{const select=document.querySelector(agentSelector);select.value=agent;select.dispatchEvent(new Event('change',{bubbles:true}))},{agentSelector,agent});
  await page.waitFor(({modelSelector,localModel})=>{const select=document.querySelector(modelSelector);return select&&!select.disabled&&[...select.options].some(row=>row.value===localModel&&!row.disabled)},{modelSelector,localModel});
  for(const model of [localModel,'managed-model']){
   await page.run(({modelSelector,model})=>{const select=document.querySelector(modelSelector);select.value=model;select.dispatchEvent(new Event('change',{bubbles:true}))},{modelSelector,model});
   check(runtime+' accepts '+(model===localModel?'device':'Hub')+' model independently',await page.run(({modelSelector,model})=>document.querySelector(modelSelector).value===model,{modelSelector,model}));
  }
 }
 for(const runtime of ['codex','claude']){
  const agent='local:'+runtime;
  check(runtime+' account runtime is present',await page.run(({agentSelector,agent})=>[...document.querySelector(agentSelector).options].some(row=>row.value===agent),{agentSelector,agent}));
  await page.run(({agentSelector,agent})=>{const select=document.querySelector(agentSelector);select.value=agent;select.dispatchEvent(new Event('change',{bubbles:true}))},{agentSelector,agent});
  await page.waitFor(({modelSelector,localModel})=>{const select=document.querySelector(modelSelector);return select&&![...select.options].some(row=>!row.disabled&&[localModel,'managed-model'].includes(row.value))},{modelSelector,localModel});
  check(runtime+' keeps its account model catalog',await page.run(modelSelector=>document.querySelector(modelSelector).value==='',modelSelector));
 }
 await page.run(agentSelector=>{const select=document.querySelector(agentSelector);select.value='local:pi';select.dispatchEvent(new Event('change',{bubbles:true}))},agentSelector);
 await page.waitFor(({modelSelector,localModel})=>[...document.querySelector(modelSelector).options].some(row=>row.value===localModel&&!row.disabled),{modelSelector,localModel});
 await page.run(({modelSelector,localModel})=>{const select=document.querySelector(modelSelector);select.value=localModel;select.dispatchEvent(new Event('change',{bubbles:true}))},{modelSelector,localModel});
}
try{
 let port;for(let i=0;i<80;i++){try{port=Number(fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').split('\n')[0]);if(port)break}catch{}await delay(100)}
 page=await CdpPage.connect((await listPages(port))[0]);await page.call('Page.navigate',{url:new URL('../tests/automation-create-menu.html',import.meta.url).href});
 await page.waitFor(()=>window.ready&&!document.getElementById('schNew').disabled,null,10000);
 check('创建按钮默认为收起，菜单不占布局',await page.run(()=>document.querySelector('#schCreateMenu').hidden&&document.querySelector('#schNew').getAttribute('aria-expanded')==='false'));
 const before=await page.run(()=>document.querySelector('#schBody').getBoundingClientRect().top);
 await click('#schNew');
 check('点击创建显示两个清晰入口，不创建计划',await page.run(()=>!document.querySelector('#schCreateMenu').hidden&&document.querySelectorAll('#schCreateMenu [role="menuitem"]').length===2&&calls.created.length===0));
 check('展开没有推动自动化正文',before===await page.run(()=>document.querySelector('#schBody').getBoundingClientRect().top));
 check('菜单没有被正文遮挡',await page.run(()=>[...document.querySelectorAll('#schCreateMenu button')].every(n=>{const r=n.getBoundingClientRect();return n.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))})));
 check('新控件文字不小于12px',await page.run(()=>[...document.querySelectorAll('#schNew,#schCreateMenu button')].every(n=>parseFloat(getComputedStyle(n).fontSize)>=12)));
 await shot('automation-create-menu.png');
 const crop=await page.run(()=>{const a=document.querySelector('#schNew').getBoundingClientRect(),b=document.querySelector('#schCreateMenu').getBoundingClientRect();return{x:b.left-22,y:a.top-14,width:b.width+44,height:b.bottom-a.top+38,scale:1}});
 const capture=await page.call('Page.captureScreenshot',{format:'png',clip:crop});fs.writeFileSync(path.join(out,'automation-create-control.png'),Buffer.from(capture.data,'base64'));

 await key('ArrowDown');check('方向键在菜单两项间移动',await page.run(()=>document.activeElement.dataset.schCreate==='manual'));
 await key('Home');check('Home回第一项',await page.run(()=>document.activeElement.dataset.schCreate==='chat'));
 await key('Escape');check('Esc关闭并返回创建按钮',await page.run(()=>document.querySelector('#schCreateMenu').hidden&&document.activeElement.id==='schNew'));
 await key('ArrowUp');check('向上键打开并聚焦最后一项',await page.run(()=>!document.querySelector('#schCreateMenu').hidden&&document.activeElement.dataset.schCreate==='manual'));
 await key('Enter');await delay(120);
 check('手动配置打开原有表单并聚焦名称',await page.run(()=>document.querySelector('#schEditorLayer').classList.contains('show')&&document.activeElement.id==='schTitle'&&document.querySelector('#schCreateMenu').hidden));
 check('自动化配置显示本机模型并优先选中',await page.run(()=>{const select=document.querySelector('#schModel');return select&&select.value==='local:model-0123456789abcdef0123456789abcdef'&&select.options[0].textContent.includes('glm5.2')&&select.options[1].value==='managed-model'}));
 await page.run(()=>{const select=document.querySelector('#schWho');select.value='local:qwen';select.dispatchEvent(new Event('change',{bubbles:true}))});await delay(100);
 await page.run(()=>{const select=document.querySelector('#schModel');select.value='local:model-0123456789abcdef0123456789abcdef';select.dispatchEvent(new Event('change',{bubbles:true}))});await delay(40);
 check('本地托管底座可独立搭配本机模型',await page.run(()=>{const select=document.querySelector('#schModel');return select&&select.disabled===false&&select.value==='local:model-0123456789abcdef0123456789abcdef'&&[...select.options].some(option=>option.value.startsWith('local:model-')&&!option.disabled)}));
 await page.run(()=>{const select=document.querySelector('#schWho');select.value='local:codex';select.dispatchEvent(new Event('change',{bubbles:true}))});await delay(100);
 check('Codex 账户底座不接受本机模型引用',await page.run(()=>{const select=document.querySelector('#schModel');return select&&![...select.options].some(option=>option.value.startsWith('local:model-')&&!option.disabled)}));
 await modelMatrix('#schWho','#schModel');
 await page.run(()=>{const select=document.querySelector('#schWho');select.value='local:pi';select.dispatchEvent(new Event('change',{bubbles:true}))});await delay(100);
 check('打开手动表单不修改菜单展开语义',await page.run(()=>document.querySelector('#schNew').getAttribute('aria-expanded')==='false'&&calls.created.length===0));
 await fill('#schTitle','每周交付回顾');await fill('#schNote','汇总本周已完成工作和待跟进事项。');
 await shot('automation-manual-config.png');await click('#schCancel');await delay(80);
 check('取消不会保存并回到创建按钮',await page.run(()=>calls.created.length===0&&document.activeElement.id==='schNew'));
 await click('[data-sch-recipe="weekly"]');await delay(80);
 check('场景模板仍预填原来的名称与周期',await page.run(()=>document.querySelector('#schTitle').value==='每周团队简报'&&document.querySelector('#schEvery').value==='weekly'&&document.querySelector('#schWd').value==='5'));
 await click('#schCancel');await delay(40);
 await click('#schNew');await click('.sch-h-title');
 check('点击菜单外关闭',await page.run(()=>document.querySelector('#schCreateMenu').hidden));
 await click('#schNew');await key('Tab');
 check('Tab离开菜单不困住焦点',await page.run(()=>document.querySelector('#schCreateMenu').hidden&&!document.activeElement.closest('#schCreateMenu')));
 await click('#schNew');await click('[data-sch-create="manual"]');
 await fill('#schTitle','每周交付回顾');await fill('#schNote','汇总本周已完成工作和待跟进事项。');
 await click('#schSave');await delay(180);
 check('手动确认后只提交一次现有保存接口',await page.run(()=>calls.created.length===1&&calls.created[0].title==='每周交付回顾'));
 await click('#schNew');await click('[data-sch-create="chat"]');
 await page.waitFor(()=>document.querySelector('#cpInput')&&document.querySelector('.nplugin-chip.is-action'),null,5000);
 check('Chat creation opens the shared composer with only the automation plugin selected',await page.run(()=>document.querySelector('#composePanel').classList.contains('show')&&document.querySelector('.nplugin-chip.is-action').textContent.includes('创建自动化')&&document.querySelector('#cpInput').value===''&&!Object.hasOwn(calls.routes.at(-1).payload,'prefill')&&calls.routes.at(-1).payload.newSession===true));
 check('对话入口不发消息不自动启动，关闭原自动化页面',await page.run(()=>calls.sent.length===0&&calls.created.length===1&&!document.querySelector('#schPanel').classList.contains('show')));
 await shot('automation-chat-entry.png');
 await fill('#cpInput','每天18:00整理今日工作进展、风险和明日计划，生成工作简报。');await click('#cpGo');
 await page.waitFor(()=>document.querySelector('#wazForm'),null,6000);
 check('发送描述打开真正的对话内自动化确认卡',await page.run(()=>document.querySelector('#wazForm').closest('.pui-surface-inline')&&calls.parsed.length===1&&calls.parsed[0].startsWith('每天18:00')));
 check('对话内自动化确认卡同样优先使用本机模型',await page.run(()=>{const select=document.querySelector('#wazForm select[name="modelName"]');return select&&select.value==='local:model-0123456789abcdef0123456789abcdef'&&select.options[0].textContent.includes('glm5.2')}));
 await modelMatrix('#wazForm select[name="assigneeId"]','#wazForm select[name="modelName"]');
 check('根据描述整理名称和时间，确认前不保存',await page.run(()=>document.querySelector('#wazForm').querySelector('[name="title"]').value==='每日工作简报'&&document.querySelector('#wazForm').querySelector('[name="clockHour"]').value==='18'&&document.querySelector('#wazForm').querySelector('[name="clockMinute"]').value==='0'&&calls.created.length===1));
 check('每天仅显示频率和执行时刻',await page.run(()=>getComputedStyle(document.querySelector('[data-waz-weekday]')).display==='none'&&getComputedStyle(document.querySelector('[data-waz-minute]')).display==='none'));
 await page.run(()=>{const n=document.querySelector('#wazForm').elements.every;n.value='weekly';n.dispatchEvent(new Event('change',{bubbles:true}))});
 check('切换每周显示星期但不显示每小时分钟',await page.run(()=>getComputedStyle(document.querySelector('[data-waz-weekday]')).display!=='none'&&getComputedStyle(document.querySelector('[data-waz-minute]')).display==='none'));
 await page.run(()=>{const n=document.querySelector('#wazForm').elements.every;n.value='hourly';n.dispatchEvent(new Event('change',{bubbles:true}))});
 check('切换每小时只显示分钟而隐藏日期和时刻',await page.run(()=>getComputedStyle(document.querySelector('[data-waz-weekday]')).display==='none'&&getComputedStyle(document.querySelector('[data-waz-clock]')).display==='none'&&getComputedStyle(document.querySelector('[data-waz-minute]')).display!=='none'));
 await page.run(()=>{const n=document.querySelector('#wazForm').elements.every;n.value='daily';n.dispatchEvent(new Event('change',{bubbles:true}))});
 check('自动化确认卡可见文字至少12px',await page.run(()=>[...document.querySelectorAll('.waz-layer *')].filter(n=>n.children.length===0&&n.textContent.trim()&&n.getClientRects().length&&!n.closest('svg')).every(n=>parseFloat(getComputedStyle(n).fontSize)>=12)));
 await shot('automation-chat-confirm.png');
 await page.run(()=>blocked=true);await click('[data-waz-save]');await delay(80);
 check('执行条件不满足时阻止创建',await page.run(()=>calls.created.length===1&&document.querySelector('#wazError').textContent.includes('执行机未就绪')));
 await page.run(()=>{blocked=false;createFail=false});await click('[data-waz-save]');await delay(100);
 check('对话确认保存完整配置且不立即执行',await page.run(()=>calls.created.length===2&&calls.created[1].atHour===18&&calls.created[1].note.includes('明日计划')&&calls.sent.length===0));
 await back();check('返回自动化列表能看到两种入口创建的计划',await page.run(()=>document.querySelector('#schBody').textContent.includes('每周交付回顾')&&document.querySelector('#schBody').textContent.includes('每日工作简报')));
 await page.call('Emulation.setDeviceMetricsOverride',{width:800,height:950,deviceScaleFactor:1,mobile:false});await click('#schNew');
 check('窄窗口菜单保持可见且无横向溢出',await page.run(()=>{const r=document.querySelector('#schCreateMenu').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&document.documentElement.scrollWidth<=innerWidth}));
 await shot('automation-create-narrow.png');
 await page.run(()=>document.documentElement.dataset.theme='minimal');await shot('automation-create-light.png');
 await page.run(()=>closeSchedulePanel());
 check('关闭自动化页面同时清理菜单状态',await page.run(()=>document.querySelector('#schCreateMenu').hidden&&document.querySelector('#schNew').getAttribute('aria-expanded')==='false'));
 lastRuntimeErrors=page.takeRuntimeErrors();check('界面流程没有运行错误',lastRuntimeErrors.length===0);
 await page.call('Page.navigate',{url:new URL('../tests/schedule-loading.html',import.meta.url).href});await page.waitFor(()=>document.querySelector('#out')?.textContent.includes('schedule loading smoke:'),null,5000);
 check('现有自动化加载页面回归通过',await page.run(()=>document.querySelector('#out').textContent.includes('7 passed, 0 failed')));
 await page.call('Page.navigate',{url:new URL('../tests/new-conversation.html',import.meta.url).href});await page.waitFor(()=>document.querySelector('#out')?.textContent.includes('new conversation smoke:'),null,10000);
 const ordinary=await page.run(()=>document.querySelector('#out').textContent);
 check('现有普通会话连续新建及历史恢复回归通过',!ordinary.includes('FAIL')&&ordinary.includes('0 failed'));
 fs.writeFileSync(path.join(out,'ordinary-chat-results.txt'),ordinary);
}catch(e){checks.push({name:String(e.stack||e),ok:false});if(page){checks.push({name:JSON.stringify(lastRuntimeErrors.length?lastRuntimeErrors:page.takeRuntimeErrors()),ok:false});await shot('failure.png').catch(()=>{});fs.writeFileSync(path.join(out,'failure-state.txt'),await page.run(()=>document.body.innerText).catch(()=>''))}process.exitCode=1}
finally{fs.writeFileSync(path.join(out,'page-results.json'),JSON.stringify(checks,null,2));console.log(JSON.stringify(checks,null,2));if(page){await page.call('Browser.close').catch(()=>{});page.close()}else chrome.kill()}
