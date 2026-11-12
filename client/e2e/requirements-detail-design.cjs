'use strict';
// Visual/interaction regression: production detail renderer and the complete
// desktop stylesheet stack. No network or user data. Permission DTO behavior
// is covered separately by requirement-tags and requirements-maintenance.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = {...process.env};
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE']) delete env[key];
  const result = require('node:child_process').spawnSync(electron, [__filename], {
    env, windowsHide: true, stdio: 'inherit', timeout: 150000,
  });
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
}
const {app, BrowserWindow} = electron;
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const {pathToFileURL} = require('node:url'), assert = require('node:assert/strict');
const client = path.resolve(__dirname, '..');
const output = path.resolve(client, '../outputs/requirements-detail-design-20261020');
fs.mkdirSync(output, {recursive: true});
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-detail-design-')));
app.disableHardwareAcceleration();
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = {ok: false, layouts: [], checks: [], errors: [],
  boundary: 'Hidden native Electron, production renderer and all desktop CSS, fixture APIs, no network or business data'};
const styles = [...fs.readFileSync(path.join(client, 'desk.html'), 'utf8')
  .matchAll(/<link\b[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']+)/g)]
  .map(match => pathToFileURL(path.join(client, match[1])).href);
let win;
app.whenReady().then(async () => {
  try {
    console.log('detail design: creating window');
    win = new BrowserWindow({show: false, width: 1440, height: 960,
      webPreferences: {offscreen: true, contextIsolation: true, sandbox: true, backgroundThrottling: false}});
    win.webContents.session.webRequest.onBeforeRequest({urls: ['http://*/*', 'https://*/*']}, (_r, done) => done({cancel: true}));
    win.webContents.on('console-message', event => {if (event.level === 'error') report.errors.push(event.message);});
    const js = source => win.webContents.executeJavaScript(source, true);
    const click = async selector => {
      const point = await js(`(async()=>{const n=[...document.querySelectorAll(${JSON.stringify(selector)})].find(n=>n.getClientRects().length&&!n.disabled);
        if(!n)throw Error('Unavailable '+${JSON.stringify(selector)});n.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});
        await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
        const b=n.getBoundingClientRect(),x=Math.round(b.x+b.width/2),y=Math.round(b.y+b.height/2);
        if(!n.contains(document.elementFromPoint(x,y)))throw Error('Occluded '+${JSON.stringify(selector)});return{x,y}})()`);
      const zoom = win.webContents.getZoomFactor();
      for (const type of ['mouseMove', 'mouseDown', 'mouseUp']) win.webContents.sendInputEvent({type,
        x: Math.round(point.x * zoom), y: Math.round(point.y * zoom),
        ...(type === 'mouseMove' ? {} : {button: 'left', clickCount: 1})});
      await wait(65);
    };
    const shot = async name => {
      await wait(60); fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG());
    };
    console.log('detail design: loading fixture');
    await win.loadFile(path.join(__dirname, 'fixtures/requirements-board.html'));
    await js(fs.readFileSync(path.join(client, 'components/panels/panels-forward-select.js'), 'utf8'));
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', {enabled: true});
    console.log('detail design: loading full desktop CSS');
    await js(`Promise.all(${JSON.stringify(styles)}.map(href=>new Promise((resolve,reject)=>{
      const n=document.createElement('link');n.rel='stylesheet';n.href=href;
      const timer=setTimeout(()=>reject(Error('CSS timeout: '+href)),8000);
      n.onload=()=>{clearTimeout(timer);resolve()};n.onerror=()=>{clearTimeout(timer);reject(Error(href))};document.head.append(n)}))).then(()=>true)`);
    await js(`tasks=[{id:'detail-design',title:'完善客户服务流程与多底座协作插件的需求管理、验收和资料归档体验',
      note:'保留客户原始背景和验收依据。\\n'+Array.from({length:12},(_,i)=>'第 '+(i+1)+' 项背景：梳理业务参与者、处理流程和最终交付文件。').join('\\n'),
      tags:['客户体验','跨团队协作','超长标签CustomerExperienceAndRequirementManagementWithoutWhitespace','验收检查'],
      acceptanceCriteria:['提供可直接使用的交付内容','所有相关入口一致并且符合已有权限','已开始且未结束的流程不能被归档或删除'],
      status:'todo',triageStage:'intake',priority:'high',kind:'requirement',visibility:'organization',
      readOnly:false,canEditRequirement:true,canDeleteRequirement:true,canArchiveRequirement:true,
      maintenanceBlocked:false,canViewExecution:true,requirementVersion:1,myRoles:['creator'],
      assigneeName:'客户成功与产品体验团队',assigneeUserId:'member-1',due:'2026-10-25'}];
      SoduWorkAPI.listAttachments=async()=>Array.from({length:8},(_,i)=>({id:'file-'+i,name:'需求说明与交付检查记录-'+i+'.md',size:2048}));
      RequirementsBoard.render(true);void 0;`);
    await js(`tasks.push({id:'short-detail',title:'Short layout fixture',note:'Brief background',status:'doing',
      triageStage:'ready',myRoles:['creator'],canViewExecution:true,canEditRequirement:false});void 0;`);
    for (const [width, height, zoom] of [[2560, 1395, 1], [1440, 1000, 1.5]]) {
      win.webContents.setZoomFactor(zoom); win.setContentSize(width, height);
      await js(`RequirementsDetail.open('short-detail')`); await wait(100);
      const layout = await js(`(()=>{const drawer=document.querySelector('.rq-detail'),backdrop=drawer.parentElement,
        footer=drawer.querySelector('.rq-detail-footer'),content=drawer.querySelector('.rq-detail-content'),
        d=drawer.getBoundingClientRect(),b=backdrop.getBoundingClientRect(),f=footer.getBoundingClientRect(),
        c=content.getBoundingClientRect(),style=getComputedStyle(backdrop);
        return{gap:Math.abs(d.bottom-(b.bottom-parseFloat(style.paddingBottom))),
          topGap:Math.abs(d.top-(b.top+parseFloat(style.paddingTop))),
          footerGap:Math.abs(f.bottom-d.bottom),contentGap:Math.abs(c.bottom-f.top),
          visible:f.top>=0&&f.bottom<=innerHeight&&d.right<=innerWidth};})()`);
      assert.ok(layout.gap<=2 && layout.topGap<=2 && layout.footerGap<=2 && layout.contentGap<=2 && layout.visible,
        'Short content must fill the drawer and keep its footer at the available window edge: '+JSON.stringify(layout));
      report.layouts.push({label:'short/'+width+'/'+zoom,...layout});
      await shot('short-full-height-'+width);
      await click('[data-rq-dismiss]');
    }
    for (const theme of ['azure', 'ruby', 'steady', 'warm', 'minimal']) {
      console.log('detail design: ' + theme);
      await js(`document.documentElement.dataset.theme=${JSON.stringify(theme)};void 0;`);
      for (const [width, zoom] of [[1440, 1], [820, 1.25], [480, 1]]) {
        const height = width === 820 ? 720 : 960;
        win.setSize(width, height); win.webContents.setZoomFactor(zoom); await wait(80);
        await js(`RequirementsDetail.open('detail-design')`); await wait(80);
        const inspect = async editing => {
          const value = await js(`(()=>{const drawer=document.querySelector('.rq-detail'),content=drawer.querySelector('.rq-detail-content'),
            footer=drawer.querySelector('.rq-detail-footer'),header=drawer.querySelector('.rq-detail-header'),r=n=>n.getBoundingClientRect();
            const d=r(drawer),f=r(footer),h=r(header),c=r(content);
            return{width:innerWidth,outerOverflow:document.documentElement.scrollWidth>innerWidth+1,
              drawerOverflow:drawer.scrollWidth>drawer.clientWidth+1,contentOverflow:content.scrollWidth>content.clientWidth+1,
              footerVisible:f.top>=h.bottom&&f.bottom<=innerHeight+1&&f.left>=0&&f.right<=innerWidth+1,
              contentBetween:c.top>=h.bottom-1&&c.bottom<=f.top+1,
              formOnly:!document.querySelector('#rqEditForm')||!content.querySelector('.rq-delivery,.rq-detail-materials'),
              tagCount:content.querySelectorAll('[data-rq-detail-tags]>span').length,
              fields:[...content.querySelectorAll('input:not([type=hidden]),textarea,select,.rq-tag-editor')].filter(n=>n.getClientRects().length).filter(n=>{
                const b=r(n);return b.left<d.left||b.right>d.right+1}).map(n=>n.name||n.className)}})()`);
          const label = [theme, width, zoom, editing ? 'edit' : 'detail'].join('/');
          assert.equal(value.outerOverflow || value.drawerOverflow || value.contentOverflow, false, label + ': horizontal overflow');
          assert.equal(value.footerVisible && value.contentBetween, true, label + ': header/footer layout');
          assert.equal(value.formOnly, true, label + ': edit-only content');
          assert.deepEqual(value.fields, [], label + ': escaped form fields');
          if (!editing) assert.equal(value.tagCount, 4, label + ': all tags');
          report.layouts.push({label, ...value});
        };
        await inspect(false);
        await js(`document.querySelector('.rq-detail-content').scrollTop=0;void 0;`);
        if (width === 1440) await shot(theme + '-detail');
        await click('.rq-detail-more>summary');
        const menu = await js(`(()=>{const n=document.querySelector('.rq-detail-more-menu'),b=n.getBoundingClientRect();return{
          delete:!!n.querySelector('[data-rq-delete]:not([disabled])'),archive:!!n.querySelector('[data-rq-archive]:not([disabled])'),
          visible:b.left>=0&&b.right<=innerWidth+1&&b.top>=0&&b.bottom<=innerHeight+1}})()`);
        assert.deepEqual(menu, {delete: true, archive: true, visible: true});
        await click('.rq-detail-more>summary');
        await click('[data-rq-edit]'); await inspect(true);
        assert.equal(await js(`document.querySelector('[name="assigneeUserId"]').getClientRects().length`), 0,
          theme + ': only the searchable assignee control is visible');
        assert.equal(await js(`getComputedStyle(document.querySelector('#rqEditForm [name=title]')).outlineStyle`),
          'none', theme + ': input has one focus frame');
        await js(`document.querySelector('.rq-detail-content').scrollTop=0;void 0;`);
        if (width === 1440) await shot(theme + '-edit-top');
        const before = await js(`document.querySelector('.rq-detail-footer').getBoundingClientRect().top`);
        await click('#rqTagsInput');
        const after = await js(`document.querySelector('.rq-detail-footer').getBoundingClientRect().top`);
        assert.equal(after, before, theme + ': footer remains fixed while editing tags');
        if (theme === 'azure') await shot(theme + '-edit-tags-' + width);
        await click('[data-rq-edit-cancel]');
        assert.equal(await js(`!!document.querySelector('#rqEditForm')`), false);
        await click('[data-rq-dismiss]');
      }
    }
    report.checks.push('All tags visible, no horizontal overflow, fixed header/footer, native edit/cancel and menu actions in 30 layouts',
      'Full desktop CSS across five themes, narrow window and 125% zoom; long titles, tags, notes and materials');
    assert.deepEqual(await js('fixtureErrors'), []); assert.deepEqual(report.errors, []);
    report.ok = true;
  } catch (error) {
    report.error = String(error.stack || error);
    if (win) fs.writeFileSync(path.join(output, 'failure.png'), (await win.webContents.capturePage()).toPNG());
  } finally {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ok: report.ok, layouts: report.layouts.length, checks: report.checks, error: report.error, errors: report.errors}));
    app.exit(report.ok ? 0 : 1);
  }
});
