'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const personal = require('../main/personal-plugins');
const grant = require('../main/pi-session/plugin-grant');
const platformService = require('../main/platform-connections/index.cjs');

test('application preflight rejects missing declarations and unsigned connector names before creating a grant', async () => {
  const f = fixture();
  try {
    const item = { pluginId: 'market-app', name: 'Operations', version: '0.4.8', context: 'App instructions',
      capabilities: { skills: [], mcpServers: [], runtime: [] } };
    const opts = { app: f.app, pluginIds: ['market-app'],
      appContext: { pluginId: 'market-app', requiresMcp: true, pageUrl: 'http://127.0.0.1:8901/home.html' },
      identityOf: async () => ({ hub: 'https://hub.example', clientId: 'device', session: 'session' }),
      fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true, items: [item],
        mcpGrant: { servers: ['fixture-app-service'] } }) }) };
    await assert.rejects(grant.resolve(opts), /v0.4.8.*未声明 MCP/);
    item.capabilities.mcpServers = ['fixture-app-service'];
    await assert.rejects(grant.resolve(opts), /所需 MCP 未授权/);
    assert.equal(fs.existsSync(grant._grantRoot(f.app)), false);
  } finally { f.close(); }
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-plugin-grant-'));
  return {
    root,
    app: { isPackaged: false, getPath: () => root },
    close: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

test('only an owned app ordinary-text turn may continue without its missing connection; no grants or connector fallback are created', async () => {
  const f=fixture();
  try {
    const item=personal.create(f.app,{template:'connector',name:'应用文字继续',version:'0.1.0',
      description:'Fixture',instructions:'按用户本轮文字沟通。',mcpServers:'app-business'}).plugin;
    const opts={app:f.app,pluginIds:[item.pluginId],allowUnavailableApp:true,
      appContext:{pluginId:item.pluginId,requiresMcp:true,pageUrl:'https://app.example/home'},
      identityOf:async()=>{throw Error('must not obtain a fallback Hub grant');}};
    const result=await grant.resolve(opts);
    assert.equal(result.applicationUnavailable,true);
    assert.equal(result.grant,null);
    assert.deepEqual(result.items[0].capabilities.mcpServers,[]);
    assert.match(result.applicationGuide,/本轮仅作文字沟通/);
    assert.equal(fs.existsSync(grant._grantRoot(f.app)),false);
    assert.deepEqual(personal.resolve(f.app,[item.pluginId]).items[0].capabilities.mcpServers,['app-business']);
    await assert.rejects(grant.resolve({...opts,allowUnavailableApp:false}),/刷新云端页面/);
    await assert.rejects(grant.resolve({...opts,appContext:{...opts.appContext,pluginId:'other'}}),/刷新云端页面/);
    const second=personal.create(f.app,{template:'connector',name:'另一个插件',version:'0.1.0',
      description:'Fixture',instructions:'Fixture',mcpServers:'other-business'}).plugin;
    await assert.rejects(grant.resolve({...opts,pluginIds:[item.pluginId,second.pluginId]}),/刷新云端页面/);
  } finally { f.close(); }
});

test('per-turn plugin grant keeps the ticket out of guidance and removes its config', async () => {
  const f = fixture();
  try {
    const local = personal.create(f.app, {
      template: 'connector', name: 'OA 办理', version: '0.1.0',
      description: '按公司规范处理 OA 待办',
      instructions: '读取待办，核对事实后输出处理建议。',
      mcpServers: 'oa-system',
    }).plugin;
    let request = null;
    const identity = {
      hub: 'https://soduwork.example', clientId: 'device-1', session: 'device-session',
    };
    const result = await grant.resolve({
      app: f.app,
      identityOf: async () => identity,
      ref: 'chat-1',
      pluginIds: [local.pluginId, 'remote-plugin'],
      projectId: 'project-1',
      fetchImpl: async (url, options) => {
        request = { url, options, body: JSON.parse(options.body) };
        return {
          ok: true, status: 200,
          json: async () => ({
            ok: true,
            items: [{
              pluginId: 'remote-plugin', name: '企业周报', version: '1.0.0',
              context: 'Use verified enterprise facts.',
              capabilities: { skills: [], mcpServers: ['worklog'], runtime: [] },
            }],
            mcpGrant: {
              ticket: 'short-lived-plugin-ticket', expiresIn: 1800,
              servers: ['oa-system', 'worklog'],
            },
          }),
        };
      },
    });
    assert.deepEqual(result.items.map((item) => item.pluginId),
      [local.pluginId, 'remote-plugin']);
    assert.equal(request.url, 'https://soduwork.example/api/v1/plugins/conversation-grant');
    assert.equal(request.options.headers.Authorization, 'Device device-session');
    assert.deepEqual(request.body.personalMcpServers, ['oa-system']);
    assert.deepEqual(request.body.pluginIds, ['remote-plugin']);
    assert.equal(request.body.resourceProtocol, 1);
    assert.deepEqual(result.grant.servers, ['oa-system', 'worklog']);
    assert.ok(fs.existsSync(result.grant.configFile));
    const stored = fs.readFileSync(result.grant.configFile, 'utf8');
    assert.match(stored, /short-lived-plugin-ticket/);
    assert.doesNotMatch(result.grant.guide, /short-lived-plugin-ticket/);
    assert.doesNotMatch(result.grant.guide, /device-session/);
    assert.match(result.grant.guide, /--config/);
    assert.notEqual(grant._bridgePath(f.app),
      path.join(f.root, 'pi-agent', 'skills', 'mcp-tools', 'scripts', 'mcp.mjs'));
    result.grant.cleanup();
    assert.equal(fs.existsSync(result.grant.configFile), false);
  } finally {
    f.close();
  }
});

test('grant config cleanup cannot delete files outside its private root', () => {
  const f = fixture();
  try {
    const outside = path.join(f.root, 'keep.txt');
    fs.writeFileSync(outside, 'keep', 'utf8');
    grant.removeConfig(f.app, outside);
    assert.equal(fs.readFileSync(outside, 'utf8'), 'keep');
  } finally {
    f.close();
  }
});

test('enterprise platform plugin resolves the current desktop account before the turn', async () => {
  const f = fixture();
  const original = platformService.guidance;
  const calls = [];
  platformService.guidance = async key => {
    calls.push(key);
    return '本轮使用当前账号的' + key + '双向连接';
  };
  try {
    const result = await grant.resolve({
      app: f.app, ref: 'platform-chat', pluginIds: ['enterprise-platform'],
      identityOf: async () => ({ hub: 'https://soduwork.example', clientId: 'device-1', session: 'session' }),
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({
        ok: true, items: [{ pluginId: 'enterprise-platform', name: '企业通知', version: '1.0.0',
          context: '读取并发送业务通知。',
          capabilities: { platforms: ['wecom'], skills: [], mcpServers: [], runtime: ['files', 'terminal'] },
        }], mcpGrant: null,
      }) }),
    });
    assert.deepEqual(calls, ['wecom']);
    assert.match(result.items[0].context, /当前账号的wecom双向连接/);
  } finally {
    platformService.guidance = original;
    f.close();
  }
});

test('installed account renewal retries a plugin grant only for its original account', async t => {
  const f = fixture(); t.after(() => f.close());
  delete require.cache[require.resolve('../main/device-auth')];
  const localAuth = require('../main/device-auth'), requestAuth = require('../main/device-auth-request');
  localAuth.install({ app: f.app, ipcMain: { handle() {} },
    safeStorage: require('./helpers/device-safe-storage-fixture.cjs').createSafeStorage() });
  t.after(() => requestAuth.setIdentityRefresher(null));
  let account = 'alice', enrollments = 0;
  t.mock.method(global, 'fetch', async (url, options) => {
    assert.ok(url.endsWith('/clients/enroll'), 'only the installed account resolver renews the session');
    enrollments++;
    const now = Math.floor(Date.now() / 1000), cid = JSON.parse(options.body).device;
    const session = Buffer.from(JSON.stringify({ typ: 'device', uid: account, cid,
      iat: now, exp: now + 1800, jti: enrollments })).toString('base64url') + '.' + 'a'.repeat(64);
    return { ok: true, status: 200, text: async () => JSON.stringify({ session, expiresIn: 1800,
      authState: 'active', user: { id: account } }) };
  });
  await localAuth.enroll(f.app, { hub: 'http://plugin-renewal.fixture.invalid' });
  const identity = await localAuth.authenticatedIdentity(f.app), calls = [];
  const fetchGrant = async (url, options) => {
    calls.push({ url, method: options.method, headers: { ...options.headers }, body: options.body });
    if (calls.length === 1) return { status: 401, ok: false, json: async () => ({}) };
    return { status: 200, ok: true, json: async () => ({ ok: true, items: [], mcpGrant: null }) };
  };
  const result = await grant.request(identity, { pluginIds: ['plugin-1'] }, 10000, fetchGrant);
  assert.equal(result.ok, true);
  assert.equal(enrollments, 2, '401 forces renewal even while the rejected token is locally cached');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].headers.Authorization, 'Device ' + identity.session);
  assert.equal(calls[1].headers.Authorization, 'Device ' + localAuth.session(f.app));
  assert.equal(calls[1].headers['X-Soduwork-Secret'], undefined);
  assert.equal(calls[1].method, 'POST'); assert.equal(calls[1].body, calls[0].body);

  const beforeRebind = await localAuth.authenticatedIdentity(f.app);
  account = 'bob'; calls.length = 0;
  await assert.rejects(grant.request(beforeRebind, { pluginIds: ['plugin-1'] }, 10000, fetchGrant), /HTTP 401/);
  assert.equal(enrollments, 3);
  assert.equal(calls.length, 1, 'a rebound device cannot send the old account plugin grant as another user');
  assert.equal(calls[0].headers.Authorization, 'Device ' + beforeRebind.session);
  assert.equal(calls[0].headers['X-Soduwork-Secret'], undefined);
});

test('conversation-only plugin falls back to context when its stale package is unavailable', async () => {
  const f = fixture();
  try {
    const calls = [];
    const result = await grant.resolve({
      app: f.app, ref: 'context-fallback', pluginIds: ['conversation-only'],
      identityOf: async () => ({ hub: 'https://soduwork.example', clientId: 'device-1', session: 'session' }),
      fetchImpl: async (url, options) => {
        calls.push({ url, body: JSON.parse(options.body) });
        if (url.endsWith('/conversation-grant')) {
          return { ok: false, status: 409, json: async () => ({ detail: 'plugin package missing' }) };
        }
        return { ok: true, status: 200, json: async () => ({
          ok: true,
          items: [{ pluginId: 'conversation-only', name: 'Conversation only', version: '1.0.0',
            context: 'Use the approved conversation method.',
            resourceRequired: false,
            capabilities: { skills: [], mcpServers: [], runtime: ['files'] } }],
        }) };
      },
    });
    assert.equal(result.grant, null);
    assert.equal(result.items[0].pluginId, 'conversation-only');
    assert.equal(calls.length, 2);
    assert.match(calls[0].url, /conversation-grant$/);
    assert.match(calls[1].url, /conversation-context$/);
  } finally {
    f.close();
  }
});
