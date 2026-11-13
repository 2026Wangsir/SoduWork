'use strict';
// Actual controls remain production code. Only the remote/IPC data is synthetic.
module.exports = async function ({js, click, type, navigate, until, report, win, delay, shot}) {
  const assert = require('node:assert/strict');
  report.actions = [];
  async function scenario(view, label, body) {
    try {await navigate(view); await body(); report.actions.push({view, label, ok: true});}
    catch (error) {report.actions.push({view, label, ok: false, error: String(error)}); await shot(view + '-action-failure');}
  }
  await scenario('create', 'original multiline draft and capability menu', async () => {
    const draft = '1. /skill:example 是正文\n# 标题\nD:/work/files 保持原文';
    await type('#cpInput', draft); assert.equal(await js('document.querySelector("#cpInput").value'), draft);
    await click('#cpMore'); assert.equal(await js('document.querySelector("#cpMorePop").hidden'), false);
    await click('#cpMore'); await navigate('library'); await navigate('create');
    assert.equal(await js('document.querySelector("#cpInput").value'), draft);
  });
  await scenario('history', 'nonempty search and create/cancel', async () => {
    await js('fixtureTasks=[{id:"audit-task",title:"Page audit requirement",note:"Synthetic requirement",kind:"requirement",status:"todo",triageStage:"ready",myRoles:["creator"],canEditRequirement:true}];tasks=fixtureTasks;Store._tasks=fixtureTasks;RequirementsBoard.render(true);void 0;');
    await until('document.querySelector("[data-rq-open=audit-task]")');
    await type('#hbSearch', 'No match'); await until('!document.querySelector("[data-rq-open=audit-task]")');
    await type('#hbSearch', ''); await until('document.querySelector("[data-rq-open=audit-task]")');
    await click('#hbAdd'); await until('document.querySelector("#cpTitle")');
    await type('#cpTitle', 'Unsaved requirement'); await click('[data-wes-close]');
    assert.equal(await js('fixtureTasks.length'), 1);
  });
  await scenario('skills', 'tabs and failure retry', async () => {
    for (const tab of ['skills','connections','market','plugins']) await click(`[data-cap-tab="${tab}"]`);
    await js('fixtureFailures.add("capabilityCatalog");void 0;');
    await navigate('library'); await navigate('skills'); await until('document.querySelector("#capRetry")');
    await js('fixtureFailures.delete("capabilityCatalog");void 0;'); await click('#capRetry');
    await until('document.querySelector(".cap-shell")');
  });
  await scenario('schedules', 'create menu and cancellation', async () => {
    await click('#schNew');
    await until('document.querySelector("[data-sch-create=manual]")?.checkVisibility()');
    await click('[data-sch-create=manual]'); await until('document.querySelector("#schEditorLayer.show")');
    await click('#schCancel'); assert.equal(await js('!!document.querySelector("#schEditorLayer.show")'), false);
  });
  await scenario('library', 'nonempty grid/list, search, storage and failure retry', async () => {
    await js('fixtureOverrides.listLibrary=async filters=>({folders:[],items:filters.query&&!"Audit document".includes(filters.query)?[]:[{id:"audit-doc",kind:"document",title:"Audit document",filename:"audit.txt",size:20,storage:"local",favorite:false}]});openLibraryPanel();void 0;');
    await until('document.querySelector("[data-library-content]").textContent.includes("Audit document")');
    await click('[data-library-view=list]'); await click('[data-library-view=grid]');
    await type('[data-library-search]', 'Missing'); await until('!document.querySelector("[data-library-content]").textContent.includes("Audit document")');
    await type('[data-library-search]', ''); await until('document.querySelector("[data-library-content]").textContent.includes("Audit document")');
    await click('[data-library-storage=minio]'); await click('[data-library-storage=local]');
    await js('fixtureFailures.add("listLibrary");openLibraryPanel();void 0;'); await until('document.querySelector("[data-library-retry]")');
    await js('fixtureFailures.delete("listLibrary");void 0;'); await click('[data-library-retry]');
    await until('document.querySelector("[data-library-content]").textContent.includes("Audit document")');
  });
  await scenario('notices', 'nonempty long body expand, folder and failure retry', async () => {
    await js('fixtureOverrides.mateMessages=async folder=>({ok:true,items:folder==="sent"?[]:[{id:"audit-notice",senderName:"Audit Sender",text:"Synthetic notice body ".repeat(30),createdAt:Date.now(),status:"unread"}]});_loadMateNoticeFolder("received");void 0;');
    await until('document.querySelector("[data-notice-expand]")'); await click('[data-notice-expand]');
    assert.equal(await js('document.querySelector("[data-notice-expand]").getAttribute("aria-expanded")'), 'true');
    await click('[data-notice-folder=sent]'); await until('document.querySelector(".np-empty")');
    await js('fixtureFailures.add("mateMessages");void 0;'); await click('[data-notice-folder=received]');
    await until('document.querySelector("[data-notice-retry]")');
    await js('fixtureFailures.delete("mateMessages");void 0;'); await click('[data-notice-retry]');
    await until('!document.querySelector("[data-notice-retry]")');
  });
  await scenario('aidesk', 'refresh and management navigation', async () => {
    await click('#dkRefresh'); await until('!document.querySelector("#dkRefresh").disabled');
    await click('#dkAgentManage'); await until('WorkspaceHost.view==="agents"');
  });
  await scenario('briefs', 'daily/weekly, date shift, failure retry', async () => {
    await click('[data-period=weekly]'); await click('[data-shift="-1"]'); await click('[data-current]');
    await js('fixtureFailures.add("getWorkReports");void 0;'); await click('[data-period=daily]');
    await until('document.querySelector("#briefPanel [data-retry]")');
    await js('fixtureFailures.delete("getWorkReports");void 0;'); await click('#briefPanel [data-retry]');
    await until('!document.querySelector("#briefPanel [data-retry]")');
  });
  await scenario('team', 'member overview, tasks tab and failure retry', async () => {
    await js('fixtureData.getTeam={assigned:true,orgName:"Audit org",canManage:true,members:[{userId:"audit-member",name:"Audit Member",doing:1,todo:2,done:3,cap:4}],week:{labels:[],done:[]}};openTeamPanel({entry:"team",tab:1});void 0;');
    await until('document.querySelector("#teamBody").textContent.includes("Audit Member")');
    await click('#teamTabs [data-tab="0"]'); await click('#teamTabs [data-tab="1"]');
    await js('fixtureFailures.add("getTeam");openTeamPanel({entry:"team",tab:1});void 0;');
    await until('document.querySelector("[data-team-retry]")');
    await js('fixtureFailures.delete("getTeam");void 0;'); await click('[data-team-retry]');
    await until('document.querySelector("#teamBody").textContent.includes("Audit Member")');
  });
  await scenario('memory', 'personal document editing and revisit', async () => {
    await until('document.querySelector("[data-personal-content]")');
    await type('[data-personal-content]', 'Personal audit draft');
    await navigate('library'); await navigate('memory');
    assert.equal(await js('document.querySelector("[data-personal-content]").value'), 'Personal audit draft');
  });
  await scenario('usage', 'range and refresh failure preserve data', async () => {
    await js('fixtureData.myUsage={days:7,summary:{tokens:12345,sessions:3,durationMs:90000},quality:{coveragePct:100},byAgent:[],bySource:[],recent:[],trend:[]};void 0;');
    await click('[data-days="7"]'); await until('document.querySelector("#usageBody").textContent.includes("1.2")');
    await js('fixtureFailures.add("myUsage");void 0;'); await click('#usageRefresh');
    await until('document.querySelector("#usageRefresh").classList.contains("has-error")');
    assert.ok(await js('document.querySelector("#usageBody").textContent.includes("1.2")'));
    await js('fixtureFailures.delete("myUsage");void 0;'); await click('#usageRefresh');
    await until('!document.querySelector("#usageRefresh").classList.contains("has-error")');
  });
  await scenario('agents', 'Agent/Runner tabs and refresh', async () => {
    await click('[data-agtab=runners]'); await until('document.querySelector("[data-agtab=runners]").getAttribute("aria-selected")==="true"');
    await click('#agRefresh'); await click('[data-agtab=agents]');
    assert.equal(await js('document.querySelector("[data-agtab=agents]").getAttribute("aria-selected")'), 'true');
  });
  await scenario('models', 'empty catalog and API failure retry', async () => {
    await js('fixtureFailures.add("myModels");_mdLoad();void 0;'); await until('document.querySelector("#mdRetry")');
    await js('fixtureFailures.delete("myModels");void 0;'); await click('#mdRetry');
    await until('!document.querySelector("#mdRetry")');
  });
  await scenario('cloud', 'add form cancel and refresh', async () => {
    await click('[data-ce-add]'); await until('document.querySelector("dialog[open]")');
    await type('dialog [name=host]', '192.0.2.10'); await click('dialog footer [data-ce-dismiss]');
    await until('!document.querySelector("dialog[open]")'); await click('[data-ce-refresh]');
    await until('!document.querySelector("[data-ce-refresh]").disabled');
  });
  await scenario('codeacct', 'draft sections and recovered API load', async () => {
    for (const tab of ['token','ssh','gerrit','test','identity']) await click(`[data-caopen="${tab}"]`);
    await js('fixtureFailures.add("myGit");_caLoad();void 0;'); await until('document.querySelector("#caRetry")');
    await js('fixtureFailures.delete("myGit");void 0;'); await click('#caRetry'); await until('document.querySelector("[data-cf=name]")');
    await click('[data-caopen="token"]');
    const placeholders = {
      'en-US': 'GitLab username (optional for GitHub)',
      'ja-JP': 'GitLab ログイン名（GitHub は空欄可）',
      'ko-KR': 'GitLab 로그인 이름(GitHub은 비워도 됨)',
      'zh-CN': 'GitLab 登录名（GitHub 可留空）',
    };
    for (const [locale, expected] of Object.entries(placeholders)) {
      await js(`SoduWorkI18n.setLocale(${JSON.stringify(locale)});void 0;`); await delay(60);
      assert.equal(await js('document.querySelector("[data-cf=user]").placeholder'), expected, locale);
    }
  });
  await scenario('archive', 'chat/project tabs and search/sort', async () => {
    await click('#archiveProjectsTab'); await click('#archiveChatsTab');
    await type('#archiveHistorySearch', 'No archived match'); await click('#archiveHistorySortTrigger');
    await click('[data-archive-sort=alpha]'); assert.equal(await js('document.querySelector("#archiveHistoryList").textContent.includes("No archived match")'), false);
  });
  await scenario('skin', 'local skin switches and theme tokens', async () => {
    await click('.skin-card[data-id=flat-azure]'); assert.equal(await js('document.documentElement.dataset.theme'), 'azure');
    await click('.skin-card[data-id=bear-ruby]'); assert.equal(await js('document.documentElement.dataset.theme'), 'ruby');
  });
  await scenario('settings', 'display flags, reminder/font, work root and locale', async () => {
    for (const id of ['petVisibleChk','dockVisibleChk','trayVisibleChk']) {
      const before = await js(`document.getElementById('${id}').checked`); await click('#' + id);
      assert.equal(await js(`document.getElementById('${id}').checked`), !before);
    }
    await click('#remindSeg [data-remind=off]'); await click('#fontSeg [data-font=large]');
    assert.equal(await js('document.querySelector("#workRootInput").readOnly'), true);
    await js('fixtureOverrides.pickWorkdir=async()=>({ok:true,dir:"D:/isolated/page-audit/custom"});void 0;');
    await click('#workRootSave');
    assert.equal(await js('workRoot()'), 'D:/isolated/page-audit/custom');
    await js('fixtureOverrides.pickWorkdir=async()=>({ok:false,canceled:true});void 0;');
    await click('#workRootSave');
    assert.equal(await js('workRoot()'), 'D:/isolated/page-audit/custom');
    assert.equal(await js('document.querySelector("#workRootInput").value'), 'D:/isolated/page-audit/custom');
    await js('SoduWorkI18n.setLocale("en-US");void 0;'); await delay(50);
    await js('SoduWorkI18n.setLocale("zh-CN");void 0;');
  });
  report.responsive = [];
  win.setContentSize(820, 620); await delay(100);
  for (const view of ['history','skills','schedules','library','notices','briefs','team','usage','agents','models','cloud','codeacct','archive','settings','shortcuts']) {
    try {
      await navigate(view);
      const metrics = await js('({width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth+1})');
      report.responsive.push({view, ...metrics});
      assert.equal(metrics.overflow, false);
    } catch (error) {report.responsive.push({view, error: String(error)});}
  }
  await shot('narrow-workspace'); win.setContentSize(1440, 1000);
};
