'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const runtime = require('../main/conversation/artifact-runtime');
const packages = require('../main/conversation/delivery-package');
const taskDelivery = require('../main/pi-session/task-delivery.cjs');
const {create} = require('../main/conversation/local-delivery-sync');

function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-delivery-selection-'));
  t.after(() => fs.rmSync(cwd, {recursive:true, force:true}));
  const now = Date.now(), turnSince = now - 5000;
  const state = {status:'idle', messages:[], tools:[]};
  const handle = {cwd, sessionId:'selection', snapshot:()=>state,
    outputSnapshot:()=>require('../main/pi-session/outputs').scan(cwd, 0, turnSince)};
  const write = (name, content, old = false) => {
    const target = path.join(cwd, name); fs.mkdirSync(path.dirname(target), {recursive:true}); fs.writeFileSync(target, content);
    const at = new Date(now - (old ? 10000 : 0)); fs.utimesSync(target, at, at); return target;
  };
  const manifest = value => write('.soduwork/delivery.json', JSON.stringify({schemaVersion:1, ...value}));
  const messages = (request, answer) => { state.messages = [{role:'user', content:request}, {role:'assistant', content:answer}]; };
  return {cwd, handle, state, write, manifest, messages};
}
const names = snapshot => snapshot.delivery.items.map(item => item.relative).sort();

test('Word conversion selects the new document in both local cards and requirement transport', async t => {
  const f = fixture(t);
  f.write('课表.md', '# draft', true); f.write('中学生课表.md', '# previous', true);
  f.write('中学生课表.docx', await require('../main/conversation/zip-archive').createEntries([
    {name:'[Content_Types].xml', bytes:Buffer.from('<Types/>')}, {name:'word/document.xml',bytes:Buffer.from('<document/>')},
  ]));
  f.messages('生成word', 'Word 已生成：[中学生课表.docx](中学生课表.docx)');
  // A legacy manifest that accumulates every document must not defeat conversion intent.
  f.manifest({deliverables:[{path:'课表.md'}, {path:'中学生课表.md'}, {path:'中学生课表.docx'}]});
  let snapshot = runtime.snapshot(f.handle);
  assert.deepEqual(names(snapshot), ['中学生课表.docx']);
  assert.equal(snapshot.items.filter(item => item.kind === 'document').length, 3, 'historical sources remain addressable');
  const captured = await taskDelivery.capture(f.handle, 'completed');
  assert.deepEqual(captured.files.map(item => item.name), ['中学生课表.docx']);
  const now = Math.floor(Date.now()/1000);
  create().bind(f.handle, {hub:'http://fixture.invalid', clientId:'desktop',
    session:Buffer.from(JSON.stringify({typ:'device',uid:'fixture',cid:'desktop',iat:now,exp:now+3600})).toString('base64url')+'.'+'a'.repeat(64)});
  await f.handle.captureDelivery();
  assert.deepEqual(f.handle.deliverySync.artifactIds, snapshot.delivery.items.map(item => item.artifactId));
  f.messages('把 Markdown 转换为 Word', '[Word](中学生课表.docx)');
  assert.deepEqual(names(runtime.snapshot(f.handle)), ['中学生课表.docx']);
  f.messages('生成 Word，保留 Markdown，两种格式都要', 'Two formats');
  f.manifest({deliverables:[{path:'中学生课表.md'},{path:'中学生课表.docx'}]});
  snapshot = runtime.snapshot(f.handle);
  assert.deepEqual(names(snapshot), ['中学生课表.docx', '中学生课表.md']);
});

test('exclusive final-format requests exclude old manifest roots from cards and transport', async t => {
  const f = fixture(t);
  f.write('report.txt', 'Original report', true);
  f.write('report.html', '<!doctype html><html><body>Final report</body></html>');
  f.manifest({deliverables:[{path:'report.txt'}, {path:'report.html'}]});
  for (const request of [
    '请把交付格式改成 HTML，只保留最终网页',
    '改成 HTML，仅保留 HTML 文件',
    'Convert to HTML and keep only the final HTML file.',
    'Convert to HTML; only keep the final HTML.',
  ]) {
    f.messages(request, 'Final result: [report.html](report.html)');
    assert.deepEqual(names(runtime.snapshot(f.handle)), ['report.html'], request);
    assert.deepEqual((await taskDelivery.capture(f.handle, 'completed')).files.map(item => item.name),
      ['report.html'], request);
  }
  assert.equal(fs.readFileSync(path.join(f.cwd, 'report.txt'), 'utf8'), 'Original report',
    'selection must not delete historical workspace files');
});

test('explicit retention of both formats or original versions survives exclusive-format wording', async t => {
  const f = fixture(t);
  f.write('report.txt', 'Original report', true);
  f.write('report.html', '<!doctype html><html><body>Final report</body></html>');
  f.manifest({deliverables:[{path:'report.txt'}, {path:'report.html'}]});
  for (const request of [
    '改成 HTML，同时保留原来的 TXT',
    '改成 HTML，保留旧版',
    '改成 HTML，只保留最终网页，同时保留旧版 TXT 以供审核',
    '改成 HTML，不只保留最终网页',
    '改成 HTML，只保留旧版 HTML',
    'Convert to HTML and keep both formats.',
    'Convert to HTML, keep the original TXT.',
    'Convert to HTML; keep only the final HTML; keep the original TXT for audit.',
    'Convert to HTML; keep only the final HTML; retain the original TXT for audit.',
    'Convert to HTML; keep only the final HTML; preserve the original TXT for audit.',
    'Convert to HTML; keep only the final HTML; do not discard the original TXT.',
    'Convert to HTML; retain the original TXT for audit; keep only the final HTML.',
    '改成 HTML，只保留最终网页，原 TXT 也留着以供审核',
    '改成 HTML，只保留最终网页，原 TXT 不要删除',
    '改成 HTML，原 TXT 也留着以供审核，只保留最终网页',
    '改成 HTML，原 TXT 不要删除，只保留最终网页',
    'Convert to HTML; do not keep only the final HTML.',
    '不要这么做：改成 HTML，只保留最终网页',
    'Do not do this: convert to HTML and keep only the final HTML.',
    'Convert to HTML; the original TXT must remain available; keep only the final HTML.',
    'Convert to HTML while the original TXT remains available and keep only the final HTML.',
    '改成 HTML，原 TXT 别删，只保留最终网页',
    'Convert to HTML and keep only the final HTML and the original TXT.',
  ]) {
    f.messages(request, 'Final result: [report.html](report.html)');
    assert.deepEqual(names(runtime.snapshot(f.handle)), ['report.html', 'report.txt'], request);
    assert.deepEqual((await taskDelivery.capture(f.handle, 'completed')).files.map(item => item.name).sort(),
      ['report.html', 'report.txt'], request);
  }
});

test('explicit final links disambiguate drafts without losing referenced website resources', async t => {
  const f = fixture(t);
  f.write('课表.md', '# draft'); f.write('中学生课表.md', '# final');
  f.messages('生成一份课表', '文件已生成：[中学生课表.md](中学生课表.md)');
  assert.deepEqual(names(runtime.snapshot(f.handle)), ['中学生课表.md']);
  f.write('index.html', '<link rel="stylesheet" href="assets/app.css"><img src="assets/hero.png">');
  f.write('assets/app.css','body{color:purple}'); f.write('assets/hero.png', 'asset');
  f.messages('改成网页', '[预览](index.html)');
  const snapshot = runtime.snapshot(f.handle);
  assert.deepEqual(names(snapshot), ['index.html']);
  const result = await packages.prepare(f.handle, snapshot.delivery.items.map(item=>item.artifactId));
  assert.deepEqual(result.manifest.files.map(item=>item.path), ['assets/app.css', 'assets/hero.png', 'index.html']);
  assert.equal(result.manifest.entryPath, 'index.html');
});

test('website verification captures cannot enter a bundle through primary or supporting declarations', async t => {
  const f = fixture(t);
  f.write('index.html','<img src="assets/hero.png">'); f.write('assets/hero.png','page asset');
  f.write('final-hero.png','capture'); f.write('verify-top.png','capture'); f.write('check.md','validation');
  f.write('.soduwork/evidence/report.txt','validation details');
  f.messages('生成一个网站', '[打开网页](index.html)');
  f.state.tools = [{name:'bash',state:'done',args:{command:"const shot = await cdp.send('Page.captureScreenshot'); fs.writeFileSync('final-hero.png', Buffer.from(shot.data, 'base64'));"}}];
  f.manifest({processFiles:['check.md','.soduwork/evidence/report.txt'],deliverables:[{path:'index.html',files:['assets/hero.png','final-hero.png','verify-top.png','check.md','.soduwork/evidence/report.txt']},
    {path:'final-hero.png'}, {path:'check.md',role:'evidence'}]});
  const snapshot = runtime.snapshot(f.handle);
  assert.deepEqual(names(snapshot), ['index.html']);
  const payload = await taskDelivery.capture(f.handle, 'completed');
  assert.deepEqual(payload.files.map(item=>item.name), ['assets/hero.png','index.html']);
  const worker = await require('../main/conversation/delivery-package-worker').prepare(f.handle, snapshot.delivery.items.map(item=>item.artifactId));
  assert.deepEqual(worker.manifest.files.map(item=>item.path), ['assets/hero.png','index.html'], 'worker packaging preserves the same provenance rules');
  assert.equal(snapshot.items.find(item=>item.relative==='final-hero.png').processEvidence, true);
  f.write('index.html','<img src="final-hero.png">');
  await assert.rejects(taskDelivery.capture(f.handle, 'completed'), /交付物引用了过程或验证文件/,
    'a conflicting runtime dependency must not produce a broken website silently');
});

test('requested screenshots, explicit replacements, and summary-only work retain their contracts', async t => {
  const f = fixture(t);
  f.write('final-hero.png','requested image');
  f.state.tools = [{name:'browser_screenshot',state:'done',args:{filename:'final-hero.png'}}];
  f.messages('提供网页截图作为交付物', '[截图](final-hero.png)');
  f.manifest({deliverables:[{path:'final-hero.png'}]});
  assert.deepEqual(names(runtime.snapshot(f.handle)), ['final-hero.png']);
  assert.deepEqual((await taskDelivery.capture(f.handle,'completed')).files.map(item=>item.name), ['final-hero.png']);
  f.write('old.md','# old'); f.write('new.html','<h1>new</h1>');
  f.manifest({deliverables:[{path:'old.md'}, {path:'new.html',replaces:['old.md']}]});
  f.messages('修改成新版', '[新版本](new.html)');
  assert.deepEqual(names(runtime.snapshot(f.handle)), ['new.html']);
  f.manifest({presentation:'summary',deliverables:[]});
  assert.equal(await taskDelivery.capture(f.handle,'completed'), null);
});
