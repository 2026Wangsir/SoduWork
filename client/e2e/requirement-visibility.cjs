'use strict';
// Production creation/detail views with injected select options, pointer saves, and isolated persistence.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = {...process.env};
  for(const key of ['ELECTRON_RUN_AS_NODE','NODE_OPTIONS','ELECTRON_NO_ATTACH_CONSOLE'])delete env[key];
  const result = require('node:child_process').spawnSync(electron,[__filename,...process.argv.slice(2),'--force-device-scale-factor=1'],
    {env,windowsHide:true,stdio:'inherit',timeout:90000});
  process.exit(result.status ?? 1);
}
const {app,BrowserWindow}=electron;
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
const output=process.argv[2],client=path.resolve(__dirname,'..');
if(!output||!path.isAbsolute(output))throw Error('An absolute evidence directory is required');
fs.mkdirSync(output,{recursive:true});app.setPath('userData',fs.mkdtempSync(path.join(os.tmpdir(),'soduwork-visibility-')));
app.disableHardwareAcceleration();
const report={ok:false,checks:[],boundary:'Real Electron creation/detail components, CSS and pointer saves; select option injected; native OS dropdown not validated; synthetic Hub persistence, no server ACL changes or real accounts'};
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));let win;
app.whenReady().then(async()=>{
  try {
    win=new BrowserWindow({show:true,width:1440,height:1000,webPreferences:{contextIsolation:true,sandbox:true,offscreen:false}});
    win.focus();
    win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_request,done)=>done({cancel:true}));
    win.webContents.on('console-message',event=>{if(event.level==='error')console.error(event.message);});
    const js=async source=>{try{return await win.webContents.executeJavaScript(source,true);}catch(error){
      throw Error('Renderer evaluation failed: '+source.slice(0,180)+'\n'+String(error));}};
    const until=async(source,label)=>{for(let i=0;i<80;i++){if(await js(source))return;await wait(50);}throw Error('Timed out: '+label);};
    const click=async selector=>{
      await js(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block:'center',behavior:'instant'})`);await wait(180);
      const point=await js(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n||n.disabled)throw Error('Unavailable control');
        const b=n.getBoundingClientRect(),x=Math.round(b.x+b.width/2),y=Math.round(b.y+b.height/2);
        if(!b.width||!b.height||!n.contains(document.elementFromPoint(x,y)))throw Error('Covered control');return{x,y}})()`);
      for(const type of ['mouseDown','mouseUp'])win.webContents.sendInputEvent({type,...point,button:'left',clickCount:1});await wait(80);
    };
    const select=async(selector,value)=>{
      // Match selectOption-style form input without changing application state or calling business handlers.
      await js(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});
        if(!(n instanceof HTMLSelectElement)||n.disabled||!n.getClientRects().length)throw Error('Unavailable select control');
        const option=[...n.options].find(item=>item.value===${JSON.stringify(value)});
        if(!option||option.disabled||option.parentElement.disabled)throw Error('Unavailable select option');
        n.focus();n.selectedIndex=option.index;
        n.dispatchEvent(new Event('input',{bubbles:true}));n.dispatchEvent(new Event('change',{bubbles:true}));})()`);
      await until(`document.querySelector(${JSON.stringify(selector)}).value===${JSON.stringify(value)}`,'visibility form selection');await wait(60);
    };
    const shot=async name=>{await wait(80);fs.writeFileSync(path.join(output,name+'.png'),(await win.webContents.capturePage()).toPNG());};
    const visibilityShot=async(name,hintSelector,selectSelector)=>{
      await js(`document.querySelector(${JSON.stringify(hintSelector)}).scrollIntoView({block:'center',behavior:'instant'})`);
      if(selectSelector)await js(`document.querySelector(${JSON.stringify(selectSelector)}).scrollIntoView({block:'nearest',behavior:'instant'})`);
      await wait(100);
      const geometry=await js(`(()=>{const inspect=selector=>{const n=document.querySelector(selector),r=n.getBoundingClientRect();
        const clip={left:0,top:0,right:innerWidth,bottom:innerHeight};
        for(let p=n.parentElement;p;p=p.parentElement){const style=getComputedStyle(p),b=p.getBoundingClientRect();
          if(/auto|scroll|hidden|clip/.test(style.overflowX)){clip.left=Math.max(clip.left,b.left);clip.right=Math.min(clip.right,b.right);}
          if(/auto|scroll|hidden|clip/.test(style.overflowY)){clip.top=Math.max(clip.top,b.top);clip.bottom=Math.min(clip.bottom,b.bottom);}}
        const nativeControl=n instanceof HTMLSelectElement;
        const points=nativeControl?[[r.left+r.width/2,r.top+r.height/2]]:
          [[r.left+1,r.top+1],[r.right-1,r.top+1],[r.left+1,r.bottom-1],[r.right-1,r.bottom-1]];
        const hits=points.map(([x,y])=>{const hit=document.elementFromPoint(x,y);return{x,y,inside:n.contains(hit),
          element:hit?hit.tagName+'#'+hit.id+'.'+String(hit.className):null};});
        return {selector,visible:r.width>0&&r.height>0&&r.left>=clip.left&&r.right<=clip.right&&r.top>=clip.top&&r.bottom<=clip.bottom,
          hit:hits.every(item=>item.inside),hits,rect:{left:r.left,top:r.top,right:r.right,bottom:r.bottom},clip};};
        return [${JSON.stringify(hintSelector)},${JSON.stringify(selectSelector||'')}].filter(Boolean).map(inspect);})()`);
      console.log('Visibility screenshot hit diagnostic:',JSON.stringify({name,geometry}));
      for(const item of geometry){assert.equal(item.visible,true,name+': '+JSON.stringify(item));assert.equal(item.hit,true,name+': '+JSON.stringify(item));}
      await shot(name);
    };
    await win.loadFile(path.join(__dirname,'fixtures/requirement-sheet-receipt.html'));
    app.focus({steal:true});win.show();win.focus();win.webContents.focus();
    const css=[...fs.readFileSync(path.join(client,'desk.html'),'utf8').matchAll(/<link\b[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']+)/g)]
      .map(match=>pathToFileURL(path.join(client,match[1])).href);
    await js(`Promise.all(${JSON.stringify(css)}.map(href=>new Promise((resolve,reject)=>{const n=document.createElement('link');n.rel='stylesheet';n.href=href;n.onload=resolve;n.onerror=reject;document.head.append(n)}))).then(()=>true)`);
    for(const file of ['components/requirements/requirement-fields.js','core/task-sync.js',
      ...JSON.parse(fs.readFileSync(path.join(client,'core/locales/manifest.json'),'utf8')).map(name=>'core/locales/'+name),'core/i18n.js'])
      await js(fs.readFileSync(path.join(client,file),'utf8')+'\nvoid 0;');
    await js(`window.visibilityWrites=[];window.visibilityCreates=[];window.visibilityErrors=[];
      addEventListener('error',e=>visibilityErrors.push(e.message));addEventListener('unhandledrejection',e=>visibilityErrors.push(String(e.reason)));
      SoduWorkAPI.taskStorageKey=()=> 'synthetic-visibility-user';
      Store.persistTask=async id=>{const task=tasks.find(row=>row.id===id);const payload=TaskSync.taskPayload(task);visibilityCreates.push(payload);
        serverTasks.set(id,{...task,readOnly:false,canEditRequirement:true,canViewExecution:true,requirementVersion:1});calls.persisted.push(id);return true};
      SoduWorkAPI.patchTask=async(id,patch)=>{visibilityWrites.push({id,patch});const next={...serverTasks.get(id),...patch,requirementVersion:serverTasks.get(id).requirementVersion+1};
        serverTasks.set(id,next);return structuredClone(next)};SoduWorkI18n.setLocale('zh-CN');`);
    const shared='同公司成员可查看需求内容；执行会话和日志仍按原有权限访问。';
    const related='仅相关人可查看需求内容；执行会话和日志仍按原有权限访问。';
    for(const value of ['organization','related']){
      await js('openSheet()');await until("!!document.querySelector('#cpVisibility')",'creation visibility field');
      assert.equal(await js("document.querySelector('#cpVisibility').value"),'related');
      assert.equal(await js("document.querySelector('#cpVisibilityHint').textContent"),related);
      await select('#cpVisibility','organization');
      assert.equal(await js("document.querySelector('#cpVisibilityHint').textContent"),shared);
      assert.equal(await js("getComputedStyle(document.querySelector('#cpVisibilityHint')).fontSize"),'13px');
      if(value==='related')await select('#cpVisibility','related');
      assert.equal(await js("document.querySelector('#cpVisibilityHint').textContent"),value==='organization'?shared:related);
      await visibilityShot('create-'+value,'#cpVisibilityHint','#cpVisibility');await click('#cpCreate');
      await until('calls.created.length===1','created receipt');
      assert.equal(await js('visibilityCreates.at(-1).visibility'),value);
      assert.equal(await js("Object.hasOwn(visibilityCreates.at(-1),'canViewExecution')"),false);
      await click('.wes-result-secondary');await until("!!document.querySelector('#rqVisibilityReadHint')",'created detail');
      assert.equal(await js("document.querySelector('#rqVisibilityReadHint').textContent"),value==='organization'?shared:related);
      await click('[data-rq-edit]');await until("!!document.querySelector('select[name=visibility]')",'visibility editor');
      const changed=value==='organization'?'related':'organization';
      await select('select[name=visibility]',changed);
      assert.equal(await js("document.querySelector('#rqVisibilityHint').textContent"),changed==='organization'?shared:related);
      await visibilityShot('edit-'+changed,'#rqVisibilityHint','select[name=visibility]');await click('[data-rq-save]');
      await until("!document.querySelector('#rqEditForm')",'saved detail');
      assert.equal(await js('visibilityWrites.at(-1).patch.visibility'),changed);
      await js('RequirementsDetail.close();RequirementsDetail.open(calls.created[0])');
      await until("!!document.querySelector('#rqVisibilityReadHint')",'persisted detail');
      assert.equal(await js("document.querySelector('#rqVisibilityReadHint').textContent"),changed==='organization'?shared:related);
      await visibilityShot('detail-'+changed,'#rqVisibilityReadHint');
    }
    report.checks.push('Creation and editing switch company/related explanations immediately while preserving organization/related payloads and versioned save behavior');
    assert.equal(await js('visibilityCreates.length'),2);assert.equal(await js('visibilityWrites.length'),2);
    report.checks.push('Reopening both saved audiences shows the canonical persisted value and never adds execution permissions');
    await click('[data-rq-edit]');
    for(const locale of ['en-US','ja-JP','ko-KR','zh-CN']){
      await js(`SoduWorkI18n.setLocale(${JSON.stringify(locale)})`);
      for(const value of ['related','organization']){
        await select('select[name=visibility]',value);
        const text=value==='organization'?shared:related;
        assert.equal(await js("document.querySelector('#rqVisibilityHint').textContent"),await js(`SoduWorkI18n.translateText(${JSON.stringify(text)})`));
      }
    }
    report.checks.push('All four runtime locales keep selected-audience descriptions in sync, with a 13px explanation matching the approved layout');
    for(const [provider,visibilityScope,value,label,description] of [
      ['github','organization','organization','同公司可见',shared],
      ['gitlab','repository','related','仓库成员可见','仓库成员可查看需求内容；执行会话和日志仍按原有权限访问。'],
    ]){
      await js(`RequirementsDetail.close();serverTasks.set('imported-${provider}',{...serverTasks.get(calls.created[0]),id:'imported-${provider}',
        origin:'${provider}_issue',visibility:'${value}',repositoryIssue:{provider:'${provider}',visibilityScope:'${visibilityScope}'}});
        RequirementsDetail.open('imported-${provider}')`);
      await until("!!document.querySelector('#rqVisibilityReadHint')",'imported detail');
      assert.equal(await js("document.querySelector('#rqVisibilityReadHint').textContent"),description);
      await click('[data-rq-edit]');await until("!!document.querySelector('select[name=visibility]')",'imported editor');
      assert.deepEqual(await js("(()=>{const n=document.querySelector('select[name=visibility]');return{disabled:n.disabled,value:n.value,label:n.selectedOptions[0].textContent}})()"),
        {disabled:true,value,label});
      await visibilityShot('imported-'+provider,'#rqVisibilityHint','select[name=visibility]');
      await click('textarea[name=note]');
      const modifiers=[process.platform==='darwin'?'meta':'control'];
      for(const type of ['keyDown','keyUp'])win.webContents.sendInputEvent({type,keyCode:'A',modifiers});
      await win.webContents.insertText('Updated imported requirement background');await click('[data-rq-save]');
      await until("!document.querySelector('#rqEditForm')",'saved imported detail');
      assert.equal(await js('Object.hasOwn(visibilityWrites.at(-1).patch,"visibility")'),false);
      assert.equal(await js(`serverTasks.get('imported-${provider}').visibility`),value);
      assert.equal(await js("document.querySelector('#rqVisibilityReadHint').textContent"),description);
    }
    report.checks.push('Explicit GitHub company and GitLab repository scopes retain their original values while another field is saved through the production editor');
    assert.deepEqual(await js('visibilityErrors'),[]);
    report.ok=true;
  }catch(error){report.error=String(error.stack||error);if(win&&!win.isDestroyed())fs.writeFileSync(path.join(output,'failure.png'),(await win.webContents.capturePage()).toPNG());}
  finally{fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));win?.destroy();app.exit(report.ok?0:1);}
});
