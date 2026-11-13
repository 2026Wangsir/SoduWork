'use strict';

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');

const output = process.argv[2];
if (!output || !path.isAbsolute(output)) throw Error('Absolute evidence directory required');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-card-i18n-')));

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const report = { ok: false, cases: [], screenshots: [] };
let win;
const js = code => win.webContents.executeJavaScript(code);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const inject = async () => {
  for (const file of JSON.parse(read('core/locales/manifest.json'))) await js(read('core/locales/' + file));
  await js(read('core/i18n-dom.js'));
  await js(read('core/i18n.js'));
  await js(read('core/requirements.js'));
  await js(read('components/panels/task-priority.js'));
  await js(read('components/panels/requirement-routing.js'));
  await js(read('components/requirements/requirement-fields.js'));
  await js(read('components/panels/panels-compose-submit.js'));
  await js(read('components/panels/panels-compose-draft.js'));
};
const text = selector => js('document.querySelector(' + JSON.stringify(selector) + ')?.textContent || ""');
const shot = async name => {
  const file = path.join(output, name + '.png');
  fs.writeFileSync(file, (await win.webContents.capturePage()).toPNG());
  report.screenshots.push(file);
};

app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({
      show: false, width: 1440, height: 1000,
      webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
    await win.loadURL('about:blank');
    await js("document.body.innerHTML='<div id=\"cpDraft\"></div>'; window.SoduWorkAPI={taskStorageKey:()=> 'card-i18n-scope',listTeammates:async()=>({mates:[]}),parseTaskText:async()=>({title:'用户标题',note:'用户描述',checklist:['用户标准']})}; window.WorkIntent={acceptanceItems:()=>[]}; void 0;");
    await inject();
    await js("SoduWorkI18n.setLocale('en-US'); void ComposeDraft.openWith({title:'用户标题',note:'用户描述',checklist:['用户标准'],kind:'requirement'},{variant:'sheet',box:()=>document.querySelector('#cpDraft'),model:()=>'',atts:()=>[]}); void 0;");
    await wait(120);
    assert.equal(await js('document.querySelector("#cpTitle").value'), '用户标题');
    assert.equal(await js('document.querySelector("#cpTagsInput").placeholder'), 'Press Enter after entering a tag');
    assert.equal(await text('.cp-content-heading'), 'Issue content');
    assert.equal((await text('#cpCheck .cp-sec-h')).startsWith('Acceptance criteria'), true);
    assert.equal(await text('#cpRows .cp-sec-h'), 'Basic information');
    assert.equal(await text('#cpCreate'), 'Create issue');
    assert.equal(await js('document.querySelector("#cpDue").getAttribute("lang")'), 'en-US');
    await shot('requirement-card-en');
    report.cases.push('English requirement card translates controls while preserving user title and description');

    await js("SoduWorkI18n.setLocale('ja-JP')");
    await wait(100);
    assert.equal(await text('.cp-content-heading'), '課題の内容');
    assert.equal(await text('#cpCreate'), '課題を作成');
    assert.equal(await js('document.querySelector("#cpTagsInput").placeholder'), 'タグを入力して Enter キーを押してください');
    assert.equal(await js('document.querySelector("#cpTitle").value'), '用户标题');
    await shot('requirement-card-ja');

    await js("SoduWorkI18n.setLocale('ko-KR')");
    await wait(100);
    assert.equal(await text('.cp-content-heading'), '이슈 내용');
    assert.equal(await text('#cpCreate'), '이슈 생성');
    assert.equal(await js('document.querySelector("#cpTagsInput").placeholder'), '태그를 입력한 후 Enter를 누르세요');
    assert.equal(await js('document.querySelector("#cpTitle").value'), '用户标题');
    await shot('requirement-card-ko');
    report.cases.push('Japanese and Korean requirement cards redraw after locale changes');

    report.ok = true;
  } catch (error) {
    report.error = error.stack;
  } finally {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    win?.destroy();
    app.exit(report.ok ? 0 : 1);
  }
});
