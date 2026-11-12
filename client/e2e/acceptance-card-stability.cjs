'use strict';
// Exercise production cards, streaming DOM patches and native clicks in an isolated profile.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = {...process.env};
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE']) delete env[key];
  const result = require('node:child_process').spawnSync(electron, [__filename, '--force-device-scale-factor=1', ...process.argv.slice(2)],
    {env, windowsHide:true, stdio:'inherit', timeout:120000});
  process.exit(result.status ?? 1);
}
const {app, BrowserWindow} = electron;
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const {pathToFileURL} = require('node:url');
const assert = require('node:assert/strict');
const baseline = process.argv.includes('--baseline');
const output = path.resolve(__dirname, '../../outputs/acceptance-binding-20261101/cards-' + (baseline ? 'baseline' : 'fixed'));
fs.mkdirSync(output, {recursive:true});
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-acceptance-cards-')));
app.disableHardwareAcceleration();
const report = {ok:false, baseline, checks:[], boundary:'Production Electron renderer, isolated API responses, no account or real model'};
let win;
app.whenReady().then(async () => {
  win = new BrowserWindow({show:false, width:1100, height:900,
    webPreferences:{contextIsolation:true, sandbox:true, offscreen:true, backgroundThrottling:false}});
  win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']}, (_request, done) => done({cancel:true}));
  const js = async source => {
    const result = await win.webContents.executeJavaScript(`(async()=>{try{return await(0,eval)(${JSON.stringify(source)})}
      catch(error){return{fixtureError:error.stack}}})()`, true);
    if(result?.fixtureError) throw Error(result.fixtureError);
    return result;
  };
  const click = async selector => {
    const point = await js(`(async () => {
      const node=document.querySelector(${JSON.stringify(selector)});
      if (!node || node.disabled) throw Error('Unavailable control: '+${JSON.stringify(selector)});
      for(let attempt=0;attempt<3;attempt++){
        node.scrollIntoView({block:'center',behavior:'instant'});
        await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      }
      const rect=node.getBoundingClientRect(),x=Math.round(rect.x+rect.width/2),y=Math.round(rect.y+rect.height/2);
      if(!node.contains(document.elementFromPoint(x,y)))throw Error('Control is not hit-testable: '+${JSON.stringify(selector)}+' at '+x+','+y);
      return {x,y};
    })()`);
    win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});
    win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point});
    await new Promise(resolve => setTimeout(resolve, 50));
  };
  await win.loadFile(path.join(__dirname, 'fixtures/long-conversation.html'));
  const clientRoot=path.resolve(__dirname,'..');
  const styles=[...fs.readFileSync(path.join(clientRoot,'desk.html'),'utf8').matchAll(/<link\b[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']+)/g)]
    .map(match=>pathToFileURL(path.join(clientRoot,match[1])).href);
  await js(`Promise.all(${JSON.stringify(styles)}.map(href=>new Promise((resolve,reject)=>{
    const link=document.createElement('link');link.rel='stylesheet';link.href=href;link.onload=resolve;link.onerror=reject;document.head.append(link);
  }))).then(()=>true)`);
  if (baseline) {
    const source = require('node:child_process').execFileSync('git', ['show', 'HEAD:client/components/panels/chat-message-renderer.js'],
      {cwd:path.resolve(__dirname, '../..'), encoding:'utf8', windowsHide:true});
    await js(source + '\nrenderer.reset();window.renderer=ChatMessageRenderer.create(ctx);void 0;');
  }
  report.stability = await js(`(async () => {
    ctx._snap={status:'idle',tools:[],messages:[{role:'user',text:'Review'}]};
    for(const kind of ['验收分析结果','验收确认卡','验收退回卡']) ctx._snap.messages.push({role:'assistant',done:true,
      blocks:[{kind:'text',done:true,text:'【'+kind+'】\\n\\n## Checked result\\n\\nEvidence remains visible.'}]});
    renderer._render();
    const list=document.querySelector('#nchatList');
    const cards=[...list.querySelectorAll('.nacceptance-result')];
    let mutations=0, frames=0;
    const observer=new MutationObserver(rows=>{mutations+=rows.length;});
    cards.forEach(card=>observer.observe(card,{subtree:true,childList:true,characterData:true,attributes:true}));
    const check=async()=>{
      renderer._render();await Promise.resolve();frames++;
      if(cards.some(card=>!card.isConnected || card.tagName!=='SECTION' || !card.textContent.includes('Evidence remains visible.')))
        throw Error('A settled acceptance card was replaced during frame '+frames);
    };
    ctx._snap.status='streaming';ctx._pending='Next request';ctx._pendingSentAt=Date.now();
    for(let i=0;i<10;i++)await check();
    ctx._pending='';ctx._snap.messages.push({role:'user',text:'Next request'});
    for(let i=0;i<10;i++)await check();
    const next={role:'assistant',done:false,blocks:[{kind:'thinking',text:'Thinking',done:false}]};ctx._snap.messages.push(next);
    for(let i=0;i<30;i++){next.blocks[0].text+=' next';await check();}
    next.blocks[0].done=true;next.blocks.push({kind:'toolcall',id:'inspect'});
    ctx._snap.tools=[{id:'inspect',name:'bash',state:'running',after:5,args:{command:'inspect'},partial:'Running'}];
    for(let i=0;i<30;i++){ctx._snap.tools[0].partial+=' next';await check();}
    ctx._snap.tools[0].state='done';next.blocks.push({kind:'text',text:'New answer',done:false});
    for(let i=0;i<40;i++){next.blocks.at(-1).text+=' next';await check();}
    next.done=true;next.blocks.at(-1).done=true;ctx._snap.status='idle';await check();
    observer.disconnect();
    return {frames,mutations,cards:cards.length,liveKey:ctx._liveTextKey};
  })()`);
  assert.equal(report.stability.cards, 3);
  assert.equal(report.stability.mutations, 0, 'settled review bodies never change during subsequent turns');
  assert.equal(report.stability.liveKey, '');
  report.checks.push('Three completed review card types retain identical DOM through 121 waiting/thinking/tool/text/idle frames');

  await js(fs.readFileSync(path.join(__dirname, '../components/panels/task-trace-approval.js'), 'utf8'));
  await js(`
    const composer=document.createElement('textarea');composer.id='nchatInput';document.querySelector('#root').append(composer);
    window.calls=[];window.failDecision=false;window.refreshes=0;
    window.entry={taskId:'task',task:{title:'Acceptance fixture',status:'doing',canReview:true},
      trace:{approvals:[{id:'review-1',action:'review',status:'pending'}]}};
    window.SoduWorkAPI={decideApproval:async(...args)=>{
      calls.push(args);if(failDecision)throw Error('Temporary offline');return {ok:true,request:{status:args[1]==='approve'?'approved':'rejected'}};
    }};
    ctx._collabTasks=new Map([['task',entry]]);ctx._collabEntries=()=>[entry];ctx._collabEntryStatus=()=> 'completed';
    ctx._loadCollabTask=async()=>{refreshes++;throw Error('Refresh temporarily unavailable');};
    window.paint=()=>{renderer.reset();renderer._render();};
    ctx._sessionOptions={taskRef:'task'};ctx._snap={status:'idle',messages:[{role:'user',text:'Review delivery'}],tools:[]};
    paint();void 0;
  `);
  await click('[data-tfd-approval-action="approve"]');
  assert.equal(await js(`calls.length`), 1);
  assert.equal(await js(`document.querySelectorAll('[data-tfd-approval-action]').length`), 0);
  assert.match(await js(`document.querySelector('[data-acceptance-operation]').textContent`), /已确认验收/);
  await js(`window.receipt=document.querySelector('[data-acceptance-operation]');
    ctx._snap.status='streaming';ctx._pending='Follow-up request';for(let i=0;i<20;i++)renderer._render();void 0;`);
  assert.equal(await js(`document.querySelectorAll('[data-tfd-approval-action]').length`), 0);
  assert.equal(await js(`receipt===document.querySelector('[data-acceptance-operation]') && receipt.isConnected`), true);
  report.checks.push('Successful chat acceptance becomes an operation receipt despite stale pending trace and refresh failure');

  await js(`
    ctx._snap.status='idle';ctx._pending='';
    entry.trace.approvals=[{id:'review-2',action:'review',status:'pending',createdAt:1}];
    ctx._sessionOptions={taskRef:'task',approvalId:'review-2',acceptanceExecutionSession:true};
    ctx._snap.messages.push({role:'assistant',done:true,sentAt:2,blocks:[{kind:'text',done:true,text:'【验收分析结果】\\n\\nCurrent delivery checked.'}]});
    paint();void 0;
  `);
  await click('[data-acceptance-result-action="reject"]');
  const fieldError = async field => js(`(() => {
    const input=document.querySelector('[data-acceptance-result-'+${JSON.stringify(field)}+']');
    const error=document.querySelector('[data-acceptance-result-error]');
    const bounds=input.getBoundingClientRect(),hint=error.getBoundingClientRect();
    return {adjacent:error.parentElement===input.parentElement,role:error.getAttribute('role'),
      invalid:input.getAttribute('aria-invalid'),described:input.getAttribute('aria-describedby')?.split(' ').includes(error.id),
      focused:document.activeElement===input,styled:getComputedStyle(error).color!==getComputedStyle(input).color,
      distance:hint.top-bounds.bottom};
  })()`);
  const requiredNote = await fieldError('note');
  assert.ok(requiredNote.distance >= 0 && requiredNote.distance <= 16, 'validation belongs directly below its input');
  delete requiredNote.distance;
  assert.deepEqual(requiredNote, {adjacent:true,role:'alert',invalid:'true',described:true,focused:true,styled:true});
  assert.equal(await js('calls.length'),1,'empty rejection must not submit');
  fs.writeFileSync(path.join(output, 'review-note-required.png'), (await win.webContents.capturePage()).toPNG());
  await click('[data-acceptance-result-action="analyze"]');
  assert.equal((await fieldError('analysis')).adjacent,true);
  assert.equal(await js(`document.querySelector('[data-acceptance-result-note]').hasAttribute('aria-invalid')`),false);
  await win.webContents.insertText('Keep this supplemental analysis');
  assert.equal(await js(`document.querySelector('[data-acceptance-result-error]')===null`),true);
  await click('[data-acceptance-result-note]');
  const reviewNote='Fix the layout\n  Preserve <img src=x> as literal feedback';
  await win.webContents.insertText(reviewNote);
  await js(`failDecision=true;void 0;`);
  await click('[data-acceptance-result-action="reject"]');
  assert.equal(await js(`document.querySelector('[data-acceptance-result-note]').value`), reviewNote);
  assert.equal(await js(`document.querySelector('[data-acceptance-result-analysis]').value`), 'Keep this supplemental analysis');
  assert.equal(await js(`document.querySelector('[data-acceptance-result-error]').getAttribute('role')`),'alert');
  assert.equal(await js(`Boolean(document.querySelector('[data-acceptance-result-error]').compareDocumentPosition(document.querySelector('.nacceptance-result-buttons'))&Node.DOCUMENT_POSITION_FOLLOWING)`),true);
  assert.equal(await js(`document.querySelector('[data-acceptance-result-action="reject"]').disabled`), false);
  await js(`failDecision=false;void 0;`);
  await click('[data-acceptance-result-action="reject"]');
  assert.equal(await js(`calls.length`), 3);
  assert.equal(await js(`document.querySelectorAll('[data-acceptance-result-action]').length`), 0);
  assert.match(await js(`document.querySelector('[data-chat-node="message:1"] .nacceptance-result').textContent`), /已退回修改/);
  await js(`ctx._snap.status='streaming';ctx._pending='Continue editing';for(let i=0;i<20;i++)renderer._render();void 0;`);
  assert.equal(await js(`document.querySelectorAll('[data-acceptance-result-action],details.nacceptance-result').length`), 0);
  assert.match(await js(`document.querySelector('[data-chat-node="message:1"] .nacceptance-result').textContent`), /Fix the layout/);
  assert.equal(await js(`document.querySelector('.nacceptance-result-outcome-note').textContent`),reviewNote);
  assert.equal(await js(`getComputedStyle(document.querySelector('.nacceptance-result-outcome-note')).whiteSpace`),'pre-wrap');
  assert.equal(await js(`document.querySelector('.nacceptance-result-outcome-note img')===null`),true);
  win.setSize(480,900);
  await js(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
  assert.equal(await js(`(() => {const note=document.querySelector('.nacceptance-result-outcome-note'),box=note.closest('.nacceptance-result-outcome');
    return note.scrollWidth<=note.clientWidth+1&&box.getBoundingClientRect().width<=box.closest('.nacceptance-result-body').getBoundingClientRect().width;})()`),true);
  await js(`document.querySelector('.nacceptance-result-outcome').scrollIntoView({block:'center',behavior:'instant'});void 0;`);
  fs.writeFileSync(path.join(output, 'rejection-feedback-narrow.png'), (await win.webContents.capturePage()).toPNG());
  win.setSize(1100,900);
  report.checks.push('Required review and analysis feedback is field-linked, clears on input, preserves failed drafts, and renders literal multiline rejection notes within a narrow receipt');
  report.checks.push('Failed analysis decision keeps its draft and retry; success remains immutable during follow-up streaming');

  await js(`
    ctx._pending='';ctx._snap.status='idle';entry.trace.approvals=[{id:'review-3',action:'review',status:'pending',createdAt:3}];
    ctx._sessionOptions={taskRef:'task',approvalId:'review-3',acceptanceExecutionSession:true};
    ctx._snap.messages.push({role:'user',text:'Analyze again',sentAt:4},{role:'assistant',done:true,sentAt:5,
      blocks:[{kind:'text',done:true,text:'【验收分析结果】\\n\\nNew revision checked.'}]});
    paint();document.querySelector('#nchatInput').value='Existing draft';
    document.querySelector('[data-acceptance-result-analysis]').value='Verify mobile layout';void 0;
  `);
  await click('[data-acceptance-result-action="analyze"]');
  assert.match(await js(`document.querySelector('#nchatInput').value`), /Existing draft[\s\S]*Verify mobile layout/);
  assert.equal(await js(`document.querySelectorAll('[data-acceptance-result-action]').length`), 0);
  assert.match(await js(`document.querySelector('[data-chat-node="message:3"] .nacceptance-result').textContent`), /已填入对话框/);
  assert.equal(await js(`calls.length`), 3, 'supplemental analysis prepares a draft without submitting a decision');
  report.checks.push('Supplemental analysis preserves the draft and replaces controls with a stable read-only handoff result');
  await js(`
    ctx._pending='';ctx._sessionOptions={taskRef:'task'};
    ctx._snap={status:'idle',tools:[],messages:[{role:'user',text:'Create website',sentAt:10},
      {role:'assistant',done:true,sentAt:20,blocks:[{kind:'text',done:true,text:'First delivery'}]}]};
    entry.trace.approvals=[{id:'position-1',action:'review',status:'pending',createdAt:25}];
    paint();document.querySelector('[data-tfd-approval-note]').value='Change the theme';void 0;
  `);
  await click('[data-tfd-approval-action="reject"]');
  await js(`
    window.firstReceipt=document.querySelector('[data-acceptance-operation="position-1"]');
    ctx._snap.messages.push({role:'user',text:'Rework theme',sentAt:30},{role:'assistant',done:true,sentAt:40,
      blocks:[{kind:'text',done:true,text:'Revised delivery'}]});
    entry.trace.approvals[0].status='rejected';
    entry.trace.approvals.push({id:'position-2',action:'review',status:'pending',createdAt:45});renderer._render();void 0;
  `);
  await click('[data-tfd-approval-action="approve"]');
  const chronological = async () => js(`(() => {
    const nodes=[document.querySelector('[data-chat-node="message:1"]'),document.querySelector('[data-acceptance-operation="position-1"]'),
      document.querySelector('[data-chat-node="message:2"]'),document.querySelector('[data-chat-node="message:3"]'),
      document.querySelector('[data-acceptance-operation="position-2"]'),document.querySelector('[data-chat-node="message:4"]')];
    return nodes.every((node,i)=>node&&(!i || (nodes[i-1].compareDocumentPosition(node)&Node.DOCUMENT_POSITION_FOLLOWING)));
  })()`);
  await js(`ctx._snap.messages.push({role:'user',text:'Continue after acceptance',sentAt:50});
    ctx._snap.status='streaming';renderer._render();void 0;`);
  assert.equal(await chronological(),true,'each operation stays before its following user turn');
  assert.equal(await js(`firstReceipt===document.querySelector('[data-acceptance-operation="position-1"]')`),true);
  await js(`ctx._snap.messages.push({role:'assistant',done:false,sentAt:60,blocks:[{kind:'text',text:'Follow-up',done:false}]});
    for(let i=0;i<100;i++){ctx._snap.messages.at(-1).blocks[0].text+=' next';renderer._render();}void 0;`);
  assert.equal(await chronological(),true);
  await js(`entry.trace.approvals[1].status='approved';
    entry.trace.approvals[0].myDecision={decision:'reject',note:'Change the theme'};
    entry.trace.approvals[1].myDecision={decision:'approve'};ctx._snap.status='idle';
    ctx._snap.messages.at(-1).done=true;ctx._snap.messages.at(-1).blocks[0].done=true;paint();void 0;`);
  assert.equal(await chronological(),true,'reopening reconstructs the same chronological positions');
  report.checks.push('Two native-click decisions remain in their original message slots across rework, 100 streamed frames and reopening');
  fs.writeFileSync(path.join(output, 'readonly-results.png'), (await win.webContents.capturePage()).toPNG());
  await js(`ctx._snap.messages=[];entry.task.title='保存';entry.trace.approvals=[{id:'review-4',action:'review',status:'approved',
    myDecision:{decision:'approve',note:'保存'}}];paint();void 0;`);
  for (const file of JSON.parse(fs.readFileSync(path.join(__dirname, '../core/locales/manifest.json'), 'utf8'))) {
    await js(fs.readFileSync(path.join(__dirname, '../core/locales', file), 'utf8') + '\nvoid 0;');
  }
  for (const file of ['i18n-dom.js', 'i18n.js']) await js(fs.readFileSync(path.join(__dirname, '../core', file), 'utf8') + '\nvoid 0;');
  for (const [locale, label] of [['en-US','Action result'], ['ja-JP','操作結果'], ['ko-KR','작업 결과'], ['zh-CN','操作结果']]) {
    await js(`SoduWorkI18n.setLocale(${JSON.stringify(locale)});void 0;`);
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(await js(`document.querySelector('[data-acceptance-operation] b').textContent`), label);
    assert.equal(await js(`document.querySelector('[data-acceptance-operation] small').textContent`), '保存');
    assert.equal(await js(`document.querySelector('.nacceptance-result-outcome-note').textContent`), '保存');
  }
  report.checks.push('Operation receipts switch across four locales while preserving requirement titles and user review notes');
  fs.writeFileSync(path.join(output, 'operation-result.png'), (await win.webContents.capturePage()).toPNG());
  report.ok = true;
}).catch(error => {report.error=error.stack || String(error);}).finally(() => {
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
  if (win && !win.isDestroyed()) win.destroy();
  app.exit(report.ok ? 0 : 1);
});
