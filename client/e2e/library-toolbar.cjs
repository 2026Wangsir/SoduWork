'use strict';
// Native Electron input and production library/localization code. All storage,
// membership and conversation boundaries use isolated synthetic fixtures.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = {...process.env};
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE',
    'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  const result = require('node:child_process').spawnSync(electron, [__filename, ...process.argv.slice(2)],
    {env, stdio: 'inherit', timeout: 120000});
  process.exit(result.status ?? 1);
}
const {app, BrowserWindow} = electron;
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict');
const client = path.resolve(__dirname, '..');
const output = path.resolve(process.argv[2] || path.join(client, '../outputs/library-toolbar'));
const temporary = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'soduwork-library-toolbar-'));
fs.mkdirSync(output, {recursive:true}); app.setPath('userData', path.join(temporary, 'profile'));
app.disableHardwareAcceleration();
const report = {ok:false, boundary:'Native Electron pointer input, production library DOM/CSS and localization. In-memory storage and account fixtures; no real Hub, personal files or model.', layouts:[]};
let win;
const js = code => win.webContents.executeJavaScript(code, true);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(code) {
  for (let i=0;i<120;i++) { if (await js(code)) return; await wait(25); }
  throw Error('Timed out: '+code);
}
async function click(selector) {
  const point = await js(`(async()=>{const n=[...document.querySelectorAll(${JSON.stringify(selector)})].find(n=>n.getClientRects().length&&!n.disabled);
    if(!n)throw Error('Unavailable '+${JSON.stringify(selector)});n.scrollIntoView({block:'nearest',behavior:'instant'});
    await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
    const b=n.getBoundingClientRect(),x=Math.round(b.x+b.width/2),y=Math.round(b.y+b.height/2);
    if(!n.contains(document.elementFromPoint(x,y)))throw Error('Occluded '+${JSON.stringify(selector)});return{x,y};})()`);
  const zoom = win.webContents.getZoomFactor();
  for (const type of ['mouseDown','mouseUp']) win.webContents.sendInputEvent({type,
    x:Math.round(point.x*zoom),y:Math.round(point.y*zoom),button:'left',clickCount:1});
  await wait(50);
}
async function selected() {
  await click('[data-library-select="local-1"]'); await click('[data-library-select="local-2"]');
  await until('!document.querySelector("[data-library-batch-toolbar]").hidden');
}
async function capture(name) {
  await js('document.querySelector("#libraryPanel").scrollTop=0;void 0;'); await wait(60);
  fs.writeFileSync(path.join(output,name+'.png'),(await win.webContents.capturePage()).toPNG());
}
app.whenReady().then(async()=>{
  win = new BrowserWindow({show:false,width:1440,height:900,webPreferences:{offscreen:true,
    contextIsolation:true,sandbox:true,backgroundThrottling:false}});
  win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*','ws://*/*','wss://*/*']},(_r,reply)=>reply({cancel:true}));
  await win.loadFile(path.join(__dirname,'fixtures/library.html'));
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});
  await js(`window.fixture={errors:[],requests:[],handoffs:[],deleted:[],copied:[]};
    addEventListener('error',e=>fixture.errors.push(e.message));addEventListener('unhandledrejection',e=>fixture.errors.push(String(e.reason)));
    window.WorkspaceHost={open:(view,payload)=>fixture.handoffs.push({view,payload})};
    window.SoduWorkAPI={
      getLibraryStorageStatus:async()=>({storage:{local:{available:true},remote:{backend:'nfs',configured:true,connected:true,available:true}}}),
      listLibrary:async options=>{fixture.requests.push(options);return {items:options.scope==='trash'?[]:[
        {id:'local-1',filename:'回收站.md',size:2048,kind:'document',backend:'local',updatedAt:'2026-11-12T08:00:00Z'},
        {id:'local-2',filename:'Requirement acceptance checklist.xlsx',size:4096,kind:'spreadsheet',backend:'local',updatedAt:'2026-11-12T08:00:00Z'}],folders:[],trashCount:0};},
      listLibraryShareMembers:async()=>({meId:'owner',members:[{id:'member',name:'Synthetic teammate'}]}),
      readLibraryBinary:async()=>({blob:new Blob(['Original fixture content']),type:'text/plain'}),
      deleteLibraryItems:async ids=>{fixture.deleted.push(ids);return{succeeded:ids,failed:[]};},
      copyLocalLibraryItemsToRemote:async(ids,options)=>{fixture.copied.push({ids,storage:options.storage});return{succeeded:ids,failed:[]};}
    };void 0;`);
  for (const file of JSON.parse(fs.readFileSync(path.join(client,'core/locales/manifest.json'),'utf8')))
    await js(fs.readFileSync(path.join(client,'core/locales',file),'utf8'));
  for (const file of ['core/i18n-dom.js','core/i18n.js','components/panels/library-file-icons.js',
    'components/panels/panels-library-dialogs.js','components/panels/panels-library.js'])
    await js(fs.readFileSync(path.join(client,file),'utf8')+'\nvoid 0;');
  await js('openLibraryPanel();void 0;');
  await until('document.querySelectorAll("[data-library-select]").length===2&&!document.querySelector("[data-library-storage=remote]").disabled');
  const labels = {'zh-CN':'回收站','en-US':'Trash','ja-JP':'ごみ箱','ko-KR':'휴지통'};
  const toolbarCopy = {
    'zh-CN':['新建','创建新内容','上传文件','筛选类型','搜索资料库','返回资料库'],
    'en-US':['New','Create something new','Upload files','Filter by type','Search library','Back to library'],
    'ja-JP':['作成','新しいコンテンツを作成','ファイルをアップロード','種類で絞り込み','資料ライブラリを検索','資料ライブラリへ戻る'],
    'ko-KR':['생성','새 내용 만들기','파일 올리기','종류로 걸러내기','자료 보관함 검색','자료 보관함으로 돌아가기'],
  };
  const batchCopy = {
    'zh-CN':['围绕内容开启对话','批量存储到远端','批量分享','批量删除','取消选择'],
    'en-US':['Chat about selected items','Save selected to remote','Share selected','Delete selected','Clear selection'],
    'ja-JP':['選択した資料について会話する','選択した資料をリモートに保存','選択した資料を共有','選択した資料を削除','選択を解除'],
    'ko-KR':['선택한 자료로 대화하기','선택한 자료를 원격에 저장','선택한 자료 공유','선택한 자료 삭제','선택 취소'],
  };
  for (const [locale,label] of Object.entries(labels)) {
    await js(`SoduWorkI18n.setLocale(${JSON.stringify(locale)},{persist:false,broadcast:false});void 0;`);
    await until(`document.querySelector('[data-library-trash]').textContent.trim()===${JSON.stringify(label)}`);
    const accessible = await js(`(()=>{const n=document.querySelector('[data-library-trash]');return[n.title,n.getAttribute('aria-label')];})()`);
    assert.deepEqual(accessible,[label,label],locale+': tooltip and accessible name');
    const copy = await js(`[
      document.querySelector('[data-library-menu-toggle=create]').textContent.trim(),
      document.querySelector('[data-library-menu=create] .library-menu-label').textContent,
      document.querySelector('[data-library-menu=create] [data-library-create-kind=upload]').textContent.trim(),
      document.querySelector('[data-library-menu-toggle=filter]').getAttribute('aria-label'),
      document.querySelector('[data-library-search]').getAttribute('aria-label'),
      document.querySelector('.library-trash-nav [data-library-root]').textContent.trim()]`);
    assert.deepEqual(copy,toolbarCopy[locale],locale+': toolbar, dropdown, search and return labels');
    assert.equal(await js('document.querySelector("[data-library-select=local-1]").closest("article").querySelector("b").textContent'),'回收站.md','Business filenames stay untouched');
    await selected();
    for (const [width,height,zoom] of [[1440,900,1],[820,960,1],[820,1000,1.25],[480,1100,1]]) {
      win.webContents.setZoomFactor(zoom);win.setContentSize(width,height);await wait(90);
      const layout = await js(`(()=>{const panel=document.querySelector('#libraryPanel'),bar=document.querySelector('[data-library-batch-toolbar]'),head=document.querySelector('[data-library-list-head]'),toolbar=document.querySelector('.library-toolbar');
        const all=[...toolbar.querySelectorAll('button,input'),...bar.querySelectorAll('button')].filter(n=>n.getClientRects().length);
        return{width:innerWidth,overflow:panel.scrollWidth>panel.clientWidth+1,
          batchAbove:bar.getBoundingClientRect().bottom<=head.getBoundingClientRect().top+1,
          createLast:toolbar.lastElementChild.matches('.library-create-wrap'),
          escaped:all.filter(n=>{const r=n.getBoundingClientRect();return r.left<0||r.right>innerWidth+1||n.scrollWidth>n.clientWidth+1}).map(n=>n.textContent||n.getAttribute('aria-label')),
          labels:[...bar.querySelectorAll('button')].map(n=>n.textContent),
          buttonRows:[...new Set([...bar.querySelectorAll('button')].map(n=>Math.round(n.getBoundingClientRect().top)))]};})()`);
      assert.equal(layout.overflow,false,locale+': '+JSON.stringify(layout));
      assert.equal(layout.batchAbove&&layout.createLast,true);
      assert.deepEqual(layout.escaped,[],locale+': all action labels fit');
      assert.deepEqual(layout.labels,batchCopy[locale],locale+': all batch actions are translated');
      if(width===820)assert.ok(layout.buttonRows.length>1,'Narrow action bar wraps');
      report.layouts.push({locale,width,height,zoom,...layout});
      if (['zh-CN','en-US'].includes(locale) && width!==480) await capture(locale+'-'+width+'-'+zoom);
      await click('[data-library-menu-toggle=create]');
      await until('!document.querySelector("[data-library-menu=create]").hidden');
      await click('[data-library-menu=create] [data-library-create-kind=folder]');
      await until('!!document.querySelector(".library-folder-dialog")');
      await click('.library-folder-dialog [data-library-folder-cancel]');
      await until('!document.querySelector(".library-folder-dialog")');
      await click('[data-library-batch-migrate]');await until('!!document.querySelector(".library-confirm-dialog")');
      await click('.library-confirm-cancel');await until('!document.querySelector(".library-confirm-dialog")');
      await click('[data-library-batch-delete]');await until('!!document.querySelector(".library-confirm-dialog")');
      await click('.library-confirm-cancel');await until('!document.querySelector(".library-confirm-dialog")');
      await click('[data-library-batch-share]');await until('!!document.querySelector(".library-share-dialog")');
      await click('[data-library-share-cancel]');await until('!document.querySelector(".library-share-dialog")');
    }
    await click('[data-library-batch-clear]');await until('document.querySelector("[data-library-batch-toolbar]").hidden');
    await click('[data-library-trash]');await until('document.querySelector("#libraryPanel").classList.contains("is-trash")');
    assert.equal(await js('document.querySelector("[data-library-trash]").hidden'),true);
    assert.equal(await js('document.querySelector(".library-create-wrap").hidden'),true);
    await click('[data-library-root]');await until('!document.querySelector("#libraryPanel").classList.contains("is-trash")');
    assert.equal(await js('fixture.requests.at(-1).scope'),'all');
  }
  win.webContents.setZoomFactor(1);win.setContentSize(1440,900);
  await selected();await click('[data-library-batch-chat]');await until('fixture.handoffs.length===1');
  assert.equal(await js('fixture.handoffs[0].payload.initialFiles.length'),2);
  assert.deepEqual(await js('fixture.deleted'),[]);assert.deepEqual(await js('fixture.copied'),[]);
  assert.deepEqual(await js('fixture.errors'),[]);report.ok=true;
}).catch(async error=>{report.error=error.stack;if(win)await capture('failure').catch(()=>{});})
.finally(()=>{fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
  win?.destroy();app.exit(report.ok?0:1);});
