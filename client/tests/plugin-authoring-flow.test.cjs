'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const personal = require('../main/personal-plugins');
const setup = require('../main/personal-plugin-setup.cjs');
const platforms = require('../core/plugin-platforms');
const drafts = require('../main/pi-session/plugin-draft');
const grant = require('../main/pi-session/plugin-grant');
const platformService = require('../main/platform-connections/index.cjs');
const body = { template:'method', key:'weekly-summary', name:'周报助手', version:'1.0.0',
  description:'用模板汇总本周工作', instructions:'读取资料，复制模板并生成周报。' };
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-authoring-'));
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  return { root, app:{getPath:()=>root} };
}

test('required private preferences survive restart and rollback, never export', t => {
  const {app} = fixture(t);
  const source = {...body, setup:{preferences:[
    {key:'department',label:'部门',type:'text',required:true},
    {key:'compact',label:'精简版',type:'boolean',default:false},
    {key:'count',label:'条数',type:'number',default:0,minimum:0,maximum:10},
  ]}};
  const created = personal.create(app, source).plugin;
  assert.equal(created.setupState, 'needs_setup');
  assert.equal(created.conversationUse.available, false);
  assert.throws(() => personal.resolve(app, [created.pluginId]), /设置中完成配置/);
  assert.throws(() => personal.configure(app, created.pluginId, 'stale', {}), /版本已变化/);
  assert.throws(() => personal.configure(app, created.pluginId, created.checksum, {}), /部门/);
  const saved = personal.configure(app, created.pluginId, created.checksum, {department:'运营研发'}).plugin;
  assert.equal(saved.checksum, created.checksum);
  assert.equal(saved.setupConfigured, true);
  assert.equal(personal.get(app,created.pluginId).setupConfig.compact, false);
  assert.match(personal.resolve(app,[created.pluginId]).items[0].context, /"department":"运营研发"/);
  assert.doesNotMatch(JSON.stringify(personal.exportDraft(app,created.pluginId)), /运营研发/);
  const next = personal.create(app,{...source,version:'1.0.1'}).plugin;
  assert.equal(next.setupState,'needs_setup');
  assert.equal(personal.setVersion(app,created.pluginId,'1.0.0').plugin.setupConfig.department,'运营研发');
  const other = fixture(t);
  const imported = personal.create(other.app,personal.exportDraft(app,created.pluginId)).plugin;
  assert.equal(imported.setupState,'needs_setup');
});

test('main-process setup validates types, limits, choices and non-secret values', () => {
  const schema={preferences:[
    {key:'text',label:'名称',type:'text',required:true,minLength:2,maxLength:30},
    {key:'count',type:'number',minimum:0,maximum:5},
    {key:'enabled',type:'boolean'}, {key:'url',type:'url'},
    {key:'regions',type:'multiselect',options:[{value:'cn'},{value:'eu'}]},
  ]};
  const good={text:'示例',count:0,enabled:false,regions:['cn','cn']};
  assert.deepEqual(setup.validate(schema,good),{...good,regions:['cn']});
  for(const bad of [{text:' '},{count:'2'},{count:6},{enabled:'false'},{regions:['us']},
    {url:'file:///tmp/a'},{url:'https://user:pass@example.com'},{text:'token=abcdefghijk'}, {unknown:'x'}]) {
    assert.throws(()=>setup.validate(schema,{...good,...bad}));
  }
});

test('business names can reuse platform connections or bundle a CLI without an MCP', t => {
  const {app} = fixture(t);
  const item = personal.create(app,{...body,template:'connector',platforms:['wecom','dingtalk']}).plugin;
  assert.deepEqual(platforms.forItem(item),['wecom','dingtalk']);
  assert.equal(item.capabilities.network,true);
  assert.deepEqual(item.capabilities.runtime,['files','terminal']);
  assert.deepEqual(personal.exportDraft(app,item.pluginId).platforms,['wecom','dingtalk']);
  const script={path:'scripts/query.js',kind:'script',encoding:'utf8',content:'console.log("fixture")'};
  const cli = personal.preflight({...body,template:'connector',resources:[script],runtimeCapabilities:['terminal']});
  assert.equal(cli.capabilities.network,true);
  assert.throws(()=>personal.preflight({...body,template:'connector',resources:[script]}),/需要声明/);
  assert.throws(()=>personal.preflight({...body,platforms:['invented']}),/只支持/);
  const feishu=personal.preflight({...body,template:'workflow',platforms:['feishu']});
  assert.deepEqual(feishu.capabilities.mcpServers,['feishu']);
});

test('SoduWork media capability is portable and does not require an external connection', t => {
  const {app} = fixture(t);
  const item = personal.create(app, {
    ...body,
    name: '视频成片助手',
    key: 'video-maker',
    instructions: '先生成脚本和分镜，再调用 SoduWork 内置视频能力产出视频文件。',
    mcpServers: ['soduwork-media'],
  }).plugin;
  assert.deepEqual(item.capabilities.mcpServers, ['soduwork-media']);
  assert.equal(item.capabilities.network, true);
  const resolved = personal.resolve(app, [item.pluginId]);
  assert.match(resolved.items[0].context, /本轮使用 SoduWork 内置能力：soduwork-media/);
  assert.doesNotMatch(resolved.items[0].context, /依赖外部 MCP：soduwork-media/);
});

test('selected conversation artifact installs with resources, never a newer unrelated session', t => {
  const {root} = fixture(t);
  const file = path.join(root,drafts.DRAFT_NAME);
  fs.mkdirSync(path.join(root,'templates'));
  fs.writeFileSync(path.join(root,'templates','report.md'),'# Weekly report');
  fs.writeFileSync(file,JSON.stringify({...body,resources:[{path:'templates/report.md',kind:'template'}]}));
  const entry={artifactId:'artifact-1',path:file,relative:drafts.DRAFT_NAME};
  const handle={cwd:root,sessionId:'selected',inFlight:()=>false,
    outputSnapshot:()=>({files:[entry],delivery:{items:[entry]}})};
  const result=drafts.readSession(handle,'artifact-1');
  assert.equal(result.ok,true,result.reason);
  assert.equal(result.source.sessionId,'selected');
  assert.equal(Buffer.from(result.body.resources[0].content,'base64').toString(),'# Weekly report');
  assert.equal(drafts.readSession(handle,'another-artifact').ok,false);
  assert.equal(drafts.readSession({...handle,inFlight:()=>true},'artifact-1').ok,false);
  assert.equal(drafts.readSession(null,'artifact-1').ok,false);
  fs.unlinkSync(path.join(root,'templates','report.md'));
  assert.equal(drafts.readSession(handle,'artifact-1').ok,false);
});

test('conversation action preflights exact draft before showing installation confirmation', async () => {
  const calls=[];
  const window={soduWorkAPI:{conversationSession:{pluginDraft:async(ref,target)=>{
    calls.push([ref,target]);return{ok:true,body};}}},
    SoduWorkAPI:{preflightPluginDraft:async draft=>{assert.equal(draft,body);calls.push('preflight');return{ok:true};}},
    SoduWorkCapabilityPlugins:{openLocalImport:(draft,preview)=>{assert.equal(draft,body);assert.equal(preview.ok,true);calls.push('preview');}}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../components/panels/panels-plugin-maker-utils.js'),'utf8'),{window});
  const button={disabled:false,textContent:'检查并安装'},messages=[];
  await window.SoduWorkPluginMakerUtils.openConversationDraft('chat-1','artifact-1',button,{say:msg=>messages.push(msg)});
  assert.deepEqual(calls,[['chat-1','artifact-1'],'preflight','preview']);
  window.soduWorkAPI.conversationSession.pluginDraft=async()=>({ok:false,reason:'制作中'});
  await window.SoduWorkPluginMakerUtils.openConversationDraft('chat-1','artifact-1',button,{say:msg=>messages.push(msg)});
  assert.deepEqual(messages,['制作中']);assert.equal(button.disabled,false);assert.equal(button.textContent,'检查并安装');
});

test('conversation skill artifacts use the skill preflight and installation flow', async () => {
  const calls = [];
  const bytes = Buffer.from('fixture skill archive');
  const result = { ok: true, kind: 'skill', skillPackage: { name: 'weekly-summary.skill', base64: bytes.toString('base64') } };
  let scope = 'alice';
  const window = {
    soduWorkAPI: { conversationSession: { pluginDraft: async () => result } },
    SoduWorkAPI: {
      taskStorageKey: () => scope,
      preflightMySkill: async file => {
        assert.equal(file.name, 'weekly-summary.skill');
        assert.deepEqual(Buffer.from(await file.arrayBuffer()), bytes);
        calls.push('skill-preflight');
        return { ok: true, skill: { name: 'weekly-summary', hasScripts: true },
          checks: [{ ok: true, label: 'Checked' }, { ok: false, key: 'scripts', label: 'Contains scripts' }] };
      },
      preflightPluginDraft: () => assert.fail('A skill must not enter plugin preflight'),
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../components/panels/panels-plugin-maker-utils.js'), 'utf8'),
    { window, File, atob });
  const button = { disabled: false, textContent: '检查并安装' };
  const ctx = { openSkillImport: (file, preview) => {
    assert.equal(file.name, 'weekly-summary.skill');
    assert.equal(preview.skill.name, 'weekly-summary'); calls.push('skill-preview');
  }, say: () => {} };
  await window.SoduWorkPluginMakerUtils.openConversationDraft('chat', 'artifact', button, ctx);
  assert.deepEqual(calls, ['skill-preflight', 'skill-preview']);
  assert.equal(button.disabled, false);
  window.SoduWorkAPI.preflightMySkill = async () => { scope = 'bob'; return { ok: true }; };
  await window.SoduWorkPluginMakerUtils.openConversationDraft('chat', 'artifact', button, ctx);
  assert.deepEqual(calls, ['skill-preflight', 'skill-preview'], 'A stale preflight cannot open an install dialog for another account');
});

test('platform account is restored before requesting Feishu MCP authorization', async t => {
  const {app} = fixture(t), calls=[];
  const item=personal.create(app,{...body,template:'connector',platforms:['feishu']}).plugin;
  const original=platformService.guidance;
  t.after(()=>{platformService.guidance=original;});
  platformService.guidance=async key=>{calls.push('account:'+key);return'official connection restored';};
  await grant.resolve({app,pluginIds:[item.pluginId],ref:'authoring-test',
    identityOf:async()=>({hub:'https://example.invalid',clientId:'fixture',session:'fixture'}),
    fetchImpl:async()=>{calls.push('grant');return{ok:true,json:async()=>({ok:true,items:[]})};}});
  assert.deepEqual(calls,['account:feishu','grant']);
});
