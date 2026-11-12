'use strict';
// Production renderer and authenticated HTTP/SQLite; only the secure identity bridge is supplied by the fixture.
if (!process.versions.electron) throw Error('Run this suite through run-requirements-isolated.cjs');
const {app, BrowserWindow} = require('electron');
if (!app || !BrowserWindow) throw Error('Electron main-process APIs are required');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const [output, hub] = process.argv.slice(2);
if (!path.isAbsolute(output || '') || !/^http:\/\/127\.0\.0\.1:\d+$/.test(hub || '')) throw Error('Explicit isolated output and Hub required');
fs.mkdirSync(output, {recursive:true}); app.setPath('userData', path.join(output, 'profile'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = {ok:false, scope:'Complete desk.html renderer, native text entry and save clicks, DOM select change events, isolated Device-authenticated Hub and SQLite; OS dropdown menus, production accounts, model and repository execution are not tested', checks:[]};
let win, bootstrap, blockProjects = false, holdProjects = false, pendingProjects = [];
const js = source => win.webContents.executeJavaScript(source, true);
const stage = value => { report.stage = value; fs.writeFileSync(path.join(output, 'progress.json'), JSON.stringify(report,null,2)); };
async function until(source) {
  for (let i = 0; i < 150; i++) { if (await js(source)) return; await delay(80); }
  throw Error('Timed out: ' + source);
}
async function click(selector) {
  let point;
  for (let i = 0; i < 30; i++) {
    point = await js(`(async()=>{const n=[...document.querySelectorAll(${JSON.stringify(selector)})].find(n=>n.getClientRects().length&&!n.disabled);if(!n)return null;
      n.scrollIntoView({block:'nearest',behavior:'instant'});const a=n.getBoundingClientRect();await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
      const b=n.getBoundingClientRect(),x=Math.round(b.x+b.width/2),y=Math.round(b.y+b.height/2);
      return n.isConnected&&Math.abs(a.x-b.x)<1&&Math.abs(a.y-b.y)<1&&n.contains(document.elementFromPoint(x,y))?{x,y}:null})()`);
    if (point) break; await delay(50);
  }
  assert.ok(point, 'Stable visible pointer target: ' + selector);
  for (const type of ['mouseDown','mouseUp']) win.webContents.sendInputEvent({type,...point,button:'left',clickCount:1});
  await delay(100);
}
async function choose(selector, value) {
  // Offscreen Electron cannot exercise the OS menu; dispatch normal DOM form input without invoking business handlers.
  await js(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});
    if(!(n instanceof HTMLSelectElement)||!n.isConnected||n.disabled||!n.getClientRects().length)throw Error('Unavailable project select');
    const option=[...n.options].find(item=>item.value===${JSON.stringify(value)});
    if(!option||option.disabled||option.parentElement.disabled)throw Error('Unavailable project option');
    n.focus();n.selectedIndex=option.index;
    n.dispatchEvent(new Event('input',{bubbles:true}));n.dispatchEvent(new Event('change',{bubbles:true}));
    if(!n.isConnected||n.value!==${JSON.stringify(value)})throw Error('Project selection was not retained');})()`);
  assert.equal(await js(`document.querySelector(${JSON.stringify(selector)}).value`), value);
}
async function text(selector, value) {
  await click(selector); win.webContents.selectAll();
  await until(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});return document.activeElement===n&&n.selectionStart===0&&n.selectionEnd===n.value.length})()`);
  await win.webContents.insertText(value);
}
async function capture(name, selector) {
  await js(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center',behavior:'instant'})`);
  await delay(100); fs.writeFileSync(path.join(output,name),(await win.webContents.capturePage()).toPNG());
}
async function api(route, {identity=bootstrap.identities.owner, method='GET', body}={}) {
  const response = await fetch(hub + route, {method, headers:{Authorization:'Device '+identity.session,'Content-Type':'application/json'},
    ...(body ? {body:JSON.stringify(body)} : {})});
  return {status:response.status, data:await response.json()};
}
async function openDetail(id, edit=true) {
  await js(`RequirementsDetail.open(${JSON.stringify(id)})`);
  await until('!!document.querySelector(".rq-detail-backdrop [data-rq-project-name]")');
  if (edit) { await click('[data-rq-edit]'); await until('!!document.querySelector("#rqEditProject")'); }
}
async function closeDetail() { await click('[data-rq-dismiss]'); await until('!document.querySelector(".rq-detail-backdrop")'); }
async function readySelect(selector) { await until(`!!document.querySelector(${JSON.stringify(selector)})&&!document.querySelector(${JSON.stringify(selector)}).disabled`); }
async function saveDetail() { await click('[data-rq-save]'); await until('!document.querySelector("#rqEditForm")'); }
async function openCreate(projectId) {
  await js(`WorkEntrySheet.openTask({source:'需求池',requirement:true,saveOnly:true,triageStage:'intake',projectId:${JSON.stringify(projectId)}})`);
  await readySelect('#cpProjectId');
}
async function closeCreate() {
  if (await js('!!document.querySelector(".wes-result-dialog[open]")')) await click('.wes-result-dialog[open] .wes-result-close');
  if (await js('!!document.querySelector("[data-wes-close]")')) await click('[data-wes-close]');
  await until('!document.querySelector(".wes-layer.is-dialog")&&!document.querySelector(".wes-result-dialog[open]")');
}
async function switchAccount(name) {
  await js(`window.fixtureIdentity=${JSON.stringify(bootstrap.identities[name])};SoduWorkAPI.registerClient()`);
  await until(`SoduWorkAPI.clientId===${JSON.stringify(bootstrap.identities[name].clientId)}`);
}
app.whenReady().then(async()=>{
  const watchdog = setTimeout(()=>{report.error='Project selection suite exceeded 110 seconds';fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));app.exit(1);},110000);
  try {
    stage('isolated-fixture'); bootstrap = await (await fetch(hub+'/e2e/project-bootstrap')).json(); assert.equal(bootstrap.isolated,true);
    win = new BrowserWindow({width:1440,height:1000,show:false,webPreferences:{offscreen:true,sandbox:true,contextIsolation:true,partition:'requirement-project-'+process.pid+'-'+Date.now()}});
    win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*','ws://*/*','wss://*/*']},(row,reply)=>{
      if (!row.url.startsWith(hub+'/') && !row.url.startsWith(hub.replace('http:','ws:')+'/')) return reply({cancel:true});
      if (new URL(row.url).pathname === '/api/v1/projects') {
        if (holdProjects) { pendingProjects.push(reply); return; }
        if (blockProjects) return reply({cancel:true});
      }
      reply({cancel:false});
    });
    await win.loadURL('about:blank'); win.webContents.debugger.attach('1.3'); await win.webContents.debugger.sendCommand('Page.enable');
    await win.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument',{source:`
      localStorage.setItem('soduwork_work_hub_environment_v1','development');
      localStorage.setItem('soduwork_work_development_hub_url_v1',${JSON.stringify(hub)});
      localStorage.setItem('soduwork_work_user_id','e2e-sender');
      window.fixtureIdentity=${JSON.stringify(bootstrap.identities.owner)};
      window.soduWorkAPI={getHubConnection:async()=>({hub:${JSON.stringify(hub)},internalTest:true,editable:false}),deviceAuthBootstrap:async()=>window.fixtureIdentity};
      window.fixtureErrors=[];addEventListener('error',e=>fixtureErrors.push(e.message));addEventListener('unhandledrejection',e=>fixtureErrors.push(String(e.reason)));
    `});
    await win.loadFile(path.join(__dirname,'../desk.html'),{query:{panel:'workspace',view:'history'}});
    await until('typeof Store!=="undefined"&&Store.taskState==="ready"&&!document.documentElement.classList.contains("soduwork-auth-pending")');
    await js("SoduWorkI18n.setLocale('zh-CN')"); await click('button[data-rail-view="history"]');

    stage('native-create-and-clear');
    const created = [];
    for (const clear of [false,true]) {
      await openCreate(bootstrap.projects.own);
      assert.equal(await js('document.querySelector("#cpProjectId").value'),bootstrap.projects.own);
      const choices = await js('[...document.querySelector("#cpProjectId").options].map(o=>o.value)');
      for (const excluded of [bootstrap.projects.foreign,bootstrap.projects.retired]) assert.ok(!choices.includes(excluded));
      assert.equal(await js('[...document.querySelectorAll("[data-rq-project-retry]")].some(n=>!n.hidden)'),false);
      const value = clear ? '' : bootstrap.projects.second, title = clear ? 'Explicitly unlinked requirement' : 'Selected business project';
      await choose('#cpProjectId',value); await text('#cpTitle',title); await text('#cpNote','Synthetic project selection');
      if (!clear) await capture('project-create-selected.png','#cpProjectId');
      await click('#cpCreate'); await until(`tasks.some(t=>t.title===${JSON.stringify(title)})`);
      const id = await js(`tasks.find(t=>t.title===${JSON.stringify(title)}).id`);
      const record = await api('/api/v1/tasks/'+id); assert.equal(record.status,200); assert.equal(record.data.projectId,value||null); assert.equal(record.data.repoId,'');
      created.push(id); await closeCreate();
    }
    report.checks.push('Creation with DOM project selection and native text/save input retains the board default, selects or clears an authorized Hub project, and persists through authenticated HTTP');

    stage('native-edit-and-visibility');
    await openDetail(created[0]); await readySelect('#rqEditProject');
    assert.equal(await js('!!document.querySelector("[data-rq-reload]")'),false);
    assert.ok(await js('!!document.querySelector("#rqVisibilityHint")'));
    await choose('#rqEditProject',bootstrap.projects.own);
    await capture('project-edit-selected.png','#rqEditProject'); await saveDetail();
    assert.equal((await api('/api/v1/tasks/'+created[0])).data.projectId,bootstrap.projects.own);
    await click('[data-rq-edit]'); await readySelect('#rqEditProject'); await choose('#rqEditProject',''); await saveDetail();
    assert.equal((await api('/api/v1/tasks/'+created[0])).data.projectId,null);
    await closeDetail();
    report.checks.push('Detail editing with DOM project selection and native save clicks changes and clears the association without a persistent reload action; existing visibility help remains present');

    stage('locked-and-unavailable-associations');
    await openDetail(bootstrap.tasks.repo); await until('document.querySelector("#rqEditProject").getAttribute("aria-busy")==="false"');
    assert.equal(await js('document.querySelector("#rqEditProject").disabled'),true);
    assert.equal(await js('document.querySelector("#rqEditProject").value'),bootstrap.projects.own);
    await text('#rqEditForm [name=note]','Repository remains fixed'); await saveDetail();
    const repo = (await api('/api/v1/tasks/'+bootstrap.tasks.repo)).data;
    assert.equal(repo.repoId,'picker-repository'); assert.equal(repo.projectId,bootstrap.projects.own); await closeDetail();
    await openDetail(bootstrap.tasks.unavailable); await readySelect('#rqEditProject');
    assert.equal(await js('document.querySelector("#rqEditProject").value'),bootstrap.projects.retired);
    assert.match(await js('document.querySelector("#rqEditProject").selectedOptions[0].textContent'),/不可用/);
    await text('#rqEditForm [name=note]','Retain unavailable association'); await saveDetail();
    assert.equal((await api('/api/v1/tasks/'+bootstrap.tasks.unavailable)).data.projectId,bootstrap.projects.retired); await closeDetail();
    for (const name of ['executed','archived']) {
      await openDetail(bootstrap.tasks[name],false); assert.equal(await js('!!document.querySelector("[data-rq-edit]")'),false); await closeDetail();
    }
    report.checks.push('Repository bindings and executed/archived requirements stay locked; editing other fields preserves an unavailable historical project');

    stage('error-and-retry'); blockProjects = true;
    await openDetail(bootstrap.tasks.repo); await until('!document.querySelector("[data-rq-project-error]").hidden');
    assert.equal(await js('document.querySelector("#rqEditProject").value'),bootstrap.projects.own);
    assert.equal(await js('document.querySelector("#rqEditProject").disabled'),true);
    blockProjects = false; await click('[data-rq-project-retry]');
    await until('document.querySelector("[data-rq-project-error]").hidden&&document.querySelector("#rqEditProject").getAttribute("aria-busy")==="false"');
    assert.equal(await js('document.querySelector("#rqEditProject").value'),bootstrap.projects.own); await closeDetail();
    report.checks.push('A failed project request reports an error instead of an empty catalog, preserves the association and offers retry only after failure');

    stage('optimistic-conflict-preserves-input');
    const initial = await api('/api/v1/tasks/'+bootstrap.tasks.stale); assert.equal(initial.status,200);
    assert.equal(initial.data.requirementVersion,3);
    await openDetail(bootstrap.tasks.stale); await readySelect('#rqEditProject');
    await choose('#rqEditProject',bootstrap.projects.second); await text('#rqEditForm [name=note]','Unsaved local project notes');
    const external = await api('/api/v1/tasks/'+bootstrap.tasks.stale,{method:'PATCH',body:{visibility:'organization',requirementVersion:initial.data.requirementVersion}});
    assert.equal(external.status,200); assert.equal(external.data.id,bootstrap.tasks.stale);
    // The existing Hub contract increments once for the version claim and once for visibility metadata.
    assert.equal(external.data.requirementVersion,initial.data.requirementVersion+2);
    const externalSnapshot = await api('/api/v1/tasks/'+bootstrap.tasks.stale); assert.equal(externalSnapshot.status,200);
    assert.equal(externalSnapshot.data.requirementVersion,external.data.requirementVersion);
    assert.equal(externalSnapshot.data.visibility,'organization'); assert.equal(externalSnapshot.data.projectId,null);
    await click('[data-rq-save]'); await until('!!document.querySelector("[data-rq-reload]")');
    const rejectedSnapshot = await api('/api/v1/tasks/'+bootstrap.tasks.stale); assert.equal(rejectedSnapshot.status,200);
    assert.deepEqual(rejectedSnapshot.data,externalSnapshot.data,'The rejected stale save must not change any task field');
    await click('[data-rq-reload]'); await until('!document.querySelector("[data-rq-reload]")');
    assert.equal(await js('document.querySelector("#rqEditForm [name=note]").value'),'Unsaved local project notes');
    assert.equal(await js('document.querySelector("#rqEditProject").value'),bootstrap.projects.second);
    assert.equal(await js('document.querySelector("#rqEditForm [name=visibility]").value'),'organization');
    assert.match(await js('document.querySelector("#rqVisibilityHint").textContent'),/同公司成员/);
    await saveDetail(); const recovered = (await api('/api/v1/tasks/'+bootstrap.tasks.stale)).data;
    assert.equal(recovered.note,'Unsaved local project notes'); assert.equal(recovered.projectId,bootstrap.projects.second);
    assert.equal(recovered.requirementVersion,external.data.requirementVersion+1);
    report.conflictVersions = {initial:initial.data.requirementVersion,external:external.data.requirementVersion,
      afterRejectedSave:rejectedSnapshot.data.requirementVersion,recovered:recovered.requirementVersion}; await closeDetail();
    report.checks.push('An actual HTTP 409 leaves edits intact; explicit recovery rebases the version without discarding the project or notes, and a second explicit save succeeds');

    stage('closed-and-account-switched-responses');
    holdProjects = true; await openDetail(bootstrap.tasks.ready,false); await closeDetail();
    holdProjects = false; await openDetail(bootstrap.tasks.repo); await until('document.querySelector("#rqEditProject").getAttribute("aria-busy")==="false"');
    for (const reply of pendingProjects.splice(0)) reply({cancel:false}); await delay(200);
    assert.equal(await js('document.querySelector("#rqEditProject").value'),bootstrap.projects.own); await closeDetail();
    holdProjects = true; await openDetail(bootstrap.tasks.switch,false); await switchAccount('viewer');
    holdProjects = false; for (const reply of pendingProjects.splice(0)) reply({cancel:false});
    await until('!document.querySelector(".rq-detail-backdrop")');
    await openDetail(bootstrap.tasks.shared); await until('document.querySelector("#rqEditProject").getAttribute("aria-busy")==="false"');
    assert.equal(await js('document.querySelector("#rqEditProject").disabled'),true);
    const shared = (await api('/api/v1/tasks/'+bootstrap.tasks.shared,{identity:bootstrap.identities.viewer})).data;
    assert.equal(shared.canEditRequirement,true); assert.equal(shared.readOnly,true);
    const denied = await api('/api/v1/tasks/'+bootstrap.tasks.shared,{identity:bootstrap.identities.viewer,method:'PATCH',body:{projectId:bootstrap.projects.own,requirementVersion:shared.requirementVersion}});
    assert.equal(denied.status,403); await closeDetail();
    report.checks.push('Replies from a closed form or previous account cannot overwrite the active form; shared requirement editors without execution ownership cannot change projects, including direct HTTP');
    assert.deepEqual(await js('fixtureErrors'),[]); report.ok = true;
  } catch (error) {
    report.error = String(error.stack || error);
    if (win) { report.runtimeErrors = await js('window.fixtureErrors||[]').catch(()=>[]); fs.writeFileSync(path.join(output,'failure.png'),(await win.webContents.capturePage()).toPNG()); }
  } finally {
    clearTimeout(watchdog); for (const reply of pendingProjects.splice(0)) reply({cancel:true});
    fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2)); console.log(JSON.stringify(report)); app.exit(report.ok ? 0 : 1);
  }
});
