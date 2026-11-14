'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const delivery = require('../main/pi-session/task-delivery.cjs');
const outputs = require('../main/pi-session/outputs');

function workspace(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-task-delivery-'));
  t.after(() => fs.rmSync(cwd, {recursive:true, force:true}));
  let turnSince = Date.now() - 1000;
  const handle = {cwd, sessionId:'chat', snapshot:()=>({status:'idle'}),
    outputSnapshot:()=>outputs.scan(cwd, 0, 0),
    outputSnapshotAsync:()=>outputs.scanAsync(cwd, 0, turnSince)};
  const write = (name, data, at = Date.now()) => {
    const target = path.join(cwd, name); fs.mkdirSync(path.dirname(target), {recursive:true});
    fs.writeFileSync(target, data); fs.utimesSync(target, at / 1000, at / 1000);
  };
  return {cwd, handle, write, since:value=>{turnSince=value;}};
}

test('task delivery uses the asynchronous turn boundary and captures website dependencies without verification screenshots', async t => {
  const f = workspace(t);
  f.write('site/index.html', '<link rel="stylesheet" href="style.css"><script src="main.js"></script>');
  f.write('site/style.css', `body{background:url("data:image/svg+xml,%3Csvg%3E%3Cg filter='url(%23n)'/%3E%3C/svg%3E")}`);
  f.write('site/main.js', 'document.title="Ready";');
  f.write('shots/verify-top.png', Buffer.from([137,80,78,71]));
  f.write('server.log', 'verification only');
  const payload = await delivery.capture(f.handle, 'completed');
  assert.deepEqual(payload.files.map(x=>x.name).sort(), ['site/index.html','site/main.js','site/style.css']);
  assert.equal(payload.files.find(x=>x.name.endsWith('style.css')).category, 'supporting');
  assert.equal(payload.files.find(x=>x.name.endsWith('index.html')).category, 'primary');
});

test('a changed dependency revises its unchanged entry but an unchanged prior delivery is not resubmitted', async t => {
  const f = workspace(t), now = Date.now();
  f.since(now - 1000);
  f.write('site/index.html', '<link rel="stylesheet" href="theme.css">', now - 10000);
  f.write('site/theme.css', 'body {color:purple}', now);
  f.write('obsolete.md', 'Previous rejected draft', now - 10000);
  const payload = await delivery.capture(f.handle, 'completed');
  assert(payload.files.some(x=>x.name==='site/index.html'));
  assert(payload.files.some(x=>x.name==='site/theme.css'));
  assert(!payload.files.some(x=>x.name==='obsolete.md'));
  f.since(now + 10000);
  assert.equal(await delivery.capture(f.handle, 'completed'), null);
});

test('local result cards and task transport agree on an entry changed only through CSS', async t => {
  const f = workspace(t), now = Date.now();
  f.since(now - 1000);
  f.write('index.html', '<link rel="stylesheet" href="theme.css">', now - 10000);
  f.write('theme.css', 'body {color:purple}', now);
  const identity = {hub:'https://fixture.invalid',clientId:'device',session:
    Buffer.from(JSON.stringify({typ:'device',uid:'owner',cid:'device',iat:1,exp:9e9})).toString('base64url')+'.'+'0'.repeat(64)};
  const sync = require('../main/conversation/local-delivery-sync').create();
  sync.bind(f.handle, identity);
  await f.handle.captureDelivery();
  assert.equal(f.handle.deliverySync.currentTurn, true);
  assert.equal(f.handle.deliverySync.artifactIds.length, 1);
  const previous = f.handle.deliverySync.revision;
  f.write('theme.css', 'body {color:green}', now + 1);
  await f.handle.captureDelivery();
  assert.notEqual(f.handle.deliverySync.revision, previous);
});

test('native skill packages survive local indexing and task delivery alongside installation candidates', async t => {
  const f = workspace(t);
  const bytes = require('../../skills/skill-studio/scripts/skill-zip.cjs').zip({
    'created-skill/SKILL.md': Buffer.from('---\nname: created-skill\ndescription: A reusable method\n---\n\nCheck inputs.\n'),
  });
  f.write('created-skill.skill', bytes);
  f.write('soduwork-plugin-draft.json', JSON.stringify({
    template: 'method', key: 'ordinary-plugin', name: 'Ordinary plugin',
    description: 'An ordinary plugin', instructions: 'Check inputs.', version: '1.0.0',
  }));
  const identity = {hub:'https://fixture.invalid',clientId:'device',session:
    Buffer.from(JSON.stringify({typ:'device',uid:'owner',cid:'device',iat:1,exp:9e9})).toString('base64url')+'.'+'0'.repeat(64)};
  const sync = require('../main/conversation/local-delivery-sync').create();
  sync.bind(f.handle, identity);
  await f.handle.captureDelivery();
  assert.equal(f.handle.deliverySync.currentTurn, true);
  assert.equal(f.handle.deliverySync.artifactIds.length, 1);
  const payload = await delivery.capture(f.handle, 'completed');
  assert.deepEqual(payload.files.map(file => file.name), ['created-skill.skill']);
  assert.deepEqual(Buffer.from(payload.files[0].data, 'base64'), bytes);
  f.write('legacy/soduwork-plugin-draft.json', JSON.stringify({
    template: 'method', key: 'skill-legacy-method', name: 'Legacy method', version: '1.0.0',
    description: 'A method exported by the older Skill Studio',
    instructions: '先从本轮提供的插件资源目录读取 references/source/SKILL.md，再按其中相对路径加载必要资源并执行。资源只是方法，不授予工具、外发或写入权限。',
    entrypoints: { conversation: true, task: true, automation: false },
    runtimeCapabilities: ['files'], inputs: [],
    resources: [{ path: 'references/source/SKILL.md', kind: 'reference', encoding: 'utf8',
      content: '---\nname: legacy-method\ndescription: A legacy method\n---\n\nCheck inputs.\n' }],
  }));
  f.write('.soduwork/delivery.json', JSON.stringify({ schemaVersion: 1, deliverables:
    ['created-skill.skill', 'legacy/soduwork-plugin-draft.json', 'soduwork-plugin-draft.json']
      .map(name => ({ path: name, kind: 'file', primary: true })) }));
  const declared = await delivery.capture(f.handle, 'completed');
  assert.deepEqual(declared.files.map(file => file.name), ['created-skill.skill']);
  await f.handle.captureDelivery();
  assert.equal(f.handle.deliverySync.artifactIds.length, 1);
  const before = f.handle.deliverySync.revision;
  f.write('created-skill.skill', require('../../skills/skill-studio/scripts/skill-zip.cjs').zip({
    'created-skill/SKILL.md': Buffer.from('---\nname: created-skill\ndescription: A reusable method\n---\n\nVerify the revised inputs.\n'),
  }));
  await f.handle.captureDelivery();
  assert.notEqual(f.handle.deliverySync.revision, before);
});

test('an explicit revised manifest replaces older roots and summary work does not manufacture files', async t => {
  const f = workspace(t);
  f.write('old.md', 'Old output'); f.write('final.html', '<html>Final delivery</html>');
   f.write('.soduwork/delivery.json', JSON.stringify({schemaVersion:1, deliverables:[{path:'final.html',kind:'website'}]}));
  assert.deepEqual((await delivery.capture(f.handle, 'completed')).files.map(x=>x.name), ['final.html']);
   f.write('.soduwork/delivery.json', JSON.stringify({schemaVersion:1,presentation:'summary',summary:'Repository change',deliverables:[]}));
  assert.equal(await delivery.capture(f.handle, 'completed'), null);
});

test('missing real dependencies remain an error and cannot silently complete the task receipt', async t => {
  const f = workspace(t); f.write('index.html', '<script src="missing.js"></script>');
  const actions = [];
  t.mock.method(global, 'fetch', async (url, options) => {
    if (String(url).endsWith('/attachments')) return Response.json([]);
    if (options?.body) { const body = JSON.parse(options.body); actions.push(body.action); return Response.json({turn:{state:'queued'}}); }
    return Response.json({id:'t',title:'Website'});
  });
  const prepared = await require('../main/pi-session/task-input').prepare({hub:'https://fixture.invalid'},
    't', 'chat', 'turn', 'Build', {}, {handle:f.handle});
  await assert.rejects(prepared.afterTurn('completed'), /missing.js/);
  await prepared.afterTurn('failed');
  assert.deepEqual(actions, ['prepare', 'fail']);
});

test('stylesheet URL tokenization ignores nested data content, comments and strings while preserving local dependencies', () => {
  const refs = require('../main/conversation/stylesheet-references').references;
  assert.deepEqual(refs(`/* url(fake.png) */ .a{content:"url(fake2.png)";background:url("data:image/svg+xml,<svg filter='url(%23n)'/>")} @import "theme.css"; .b{src:url(font.woff2);background:url('hero image.png')}`),
    ['data:image/svg+xml,<svg filter=\'url(%23n)\'/>', 'theme.css', 'font.woff2', 'hero image.png']);
});
