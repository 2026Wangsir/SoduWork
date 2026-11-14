'use strict';

// One routing policy for admission and dispatch. The parent's managed model is
// not a portable model identifier for another Agent (or an account runtime).
const catalog = require('./agent-runtime/runtime-catalog');
const models = require('./pi-session/model-config');
const capabilities = require('./conversation/capabilities');
const connectorProbe = require('./automation-connector-probe.cjs');
const unique = values => [...new Set((values || []).map(value => String(value || '').trim()).filter(Boolean))];
const failure = (code, message) => Object.assign(new Error(message), { code });

function select(node, handle, plugin, runtimeCatalog = catalog) {
  const config = require('./personal-plugin-agent-route.cjs').read(node.config || {}, runtimeCatalog), caps = node.capabilities || {};
  const parentAgent = String(handle.adapterId || 'pi').replace(/^local:/, '');
  const agent = require('./personal-plugin-agent-route.cjs').normalize(
    config.agentKind || 'local:' + parentAgent, runtimeCatalog).replace(/^local:/, '');
  const spec = runtimeCatalog.runtime(agent);
  if (!spec || agent === 'hosted' || (config.runnerTags || []).length) {
    throw failure('runtime_route', '此节点需要非本机路由，请修改插件的本机执行配置');
  }
  const explicit = String(config.model || '').trim();
  const modelName = explicit || (spec.modelMode !== 'account' && agent === parentAgent
    ? String(handle.model && (handle.model.id || handle.model.name) || '').trim() : '');
  return { agent, spec, modelName,
    requested: unique(caps.runtime).filter(id => ['browser', 'computer', 'office'].includes(id)),
    names: unique(caps.skills).filter(name => name !== plugin.localDraft?.key),
    connectors: unique(caps.mcpServers),
  };
}

function create({ app, handle, plugin, identityOf, skillDirs, deviceGrants, runtime,
  assertOwner = () => {}, runtimeCatalog = catalog, fetchModel = (...args) => models.fetchModel(...args),
  resolveCapabilities = options => capabilities.resolve(options),
  probeConnectors = (...args) => connectorProbe.probe(...args), validatePlugin,
  probePi = () => require('./agent-runtime/process-session').probe(app) }) {
  const selection = node => select(node, handle, plugin, runtimeCatalog);
  async function identity(record) {
    const value = await identityOf(app);
    await assertOwner(value, record);
    return value;
  }
  async function checkPlugin(record) {
    if (validatePlugin) return validatePlugin(record);
    const personal = require('./personal-plugins'), sources = require('./plugin-source-access');
    let current;
    try { current = personal.get(app, record.pluginId); }
    catch (_) { throw failure('plugin_unavailable', '插件已移除或无法读取，请重新选择插件'); }
    if (!current.enabled || current.version !== record.version || current.checksum !== record.checksum) {
      throw failure('plugin_changed', '插件版本已变化或已停用，请结束本次运行并重新选择版本');
    }
    try {
      await sources.check({ app, identityOf: () => identity(record), action: 'use',
        sourceIds: sources.sourcesForIds(personal._read(app).plugins, [record.pluginId]) });
      personal.resolve(app, [record.pluginId]); // Validate setup/resources without materializing them.
    } catch (_) { throw failure('plugin_access', '插件的当前使用权限、设置或资源无法通过检查，请在插件页面检查后重试'); }
  }
  function accessPolicy(cwd = handle.cwd, live = false) {
    if (typeof handle.snapshot !== 'function') return null;
    const snapshot = handle.snapshot(), rules = require('./access-control/policy');
    const restored = rules.restoreState(snapshot.accessPolicy, snapshot.nextAccessPolicy, handle.cwd);
    // A native current-turn transition may expose a tentative pending policy
    // before its ACK. Running children only inherit the committed choice.
    const source = live && snapshot.accessControl?.changeTakesEffect === 'current-turn'
      ? restored.accessPolicy : restored.nextAccessPolicy || restored.accessPolicy;
    if (source) {
      const parent = rules.normalize(source, handle.cwd);
      return rules.normalize({ ...parent, workspaceRoot: cwd }, cwd);
    }
    // Historic sessions have no versioned policy. They must not silently grant
    // new unrestricted permissions to a different runtime.
    const readOnly = snapshot.readOnly || snapshot.permissionMode === 'readonly' || snapshot.mode === 'readonly';
    return rules.create(readOnly ? 'readonly' : 'standard', cwd);
  }
  function checkAccess(value, policy) {
    if (policy && (value?.schema !== policy.schema || !value.supported || !value.modes?.includes(policy.mode))) {
      throw failure('access_unsupported', '当前底座尚未接通所选权限控制，请检查底座设置或为该节点选择已支持的底座');
    }
  }
  async function checkCapabilities(route, who) {
    const value = await resolveCapabilities({ app, identity: who, skillDirs, deviceGrants,
      requested: route.requested, selectedSkills: route.names });
    const missing = route.requested.filter(id => !(value.capabilityIds || []).includes(id));
    const skills = route.names.filter(name => !(value.skills || []).some(skill => skill.name === name));
    if (missing.length || skills.length) throw failure('capability_missing',
      '请先安装或授权节点能力：' + [...missing, ...skills].join('、'));
    return value;
  }
  async function model(route, who, force = false) {
    if (route.spec.modelMode === 'account') return null;
    let result;
    try { result = await fetchModel(who, route.modelName, 8000, global.fetch, force, route.agent,
      { app, allowLocal: true }); }
    catch (_) { /* Provider errors can contain credentials or request bodies. */ }
    if (!result?.ok || !result.model?.id) throw failure('model_unavailable',
      '请检查 ' + route.spec.displayName + ' 的模型配置和后台连接');
    return result.model;
  }
  async function resolveNode(node, record, force = false) {
    const route = selection(node), who = await identity(record);
    const ready = await checkCapabilities(route, who);
    return { ...route, identity: who, capabilities: ready, model: await model(route, who, force) };
  }
  async function preflight(record) {
    const issues = [], nodes = [], runtimeCache = new Map(), modelCache = new Map(), capCache = new Map();
    const add = (node, agent, code, message) => issues.push({
      nodeKey: node.key, nodeName: node.name, agent, code, message,
    });
    const who = await identity(record);
    try { await checkPlugin(record); }
    catch (error) { add({ key: '', name: record.name || plugin.name || '' }, '', error.code || 'plugin_unavailable', error.message); }
    let policy;
    try { policy = accessPolicy(); }
    catch (_) { add({ key: '', name: '' }, '', 'access_invalid', '当前会话权限无法恢复，请重新打开会话后重试'); }
    const pending = (record.nodes || []).filter(node => ['ai', 'ai_review'].includes(node.type) && node.status !== 'completed');
    for (const node of pending) {
      let route;
      try { route = selection(node); }
      catch (error) { add(node, '', error.code || 'runtime_route', error.message); continue; }
      const { agent, spec } = route;
      if (!runtimeCache.has(agent)) {
        let state, accessControl;
        try {
          const direct = agent === 'pi' ? await probePi() : null;
          const reply = direct ? { ok: direct.ok, data: { installed: direct.ok, state: direct.ok ? 'ready' : 'missing', accessControl: direct.accessControl } }
            : await runtime.rpc('runtime.detect', { key: agent }, 20000);
          const value = reply?.data || {};
          accessControl = value.accessControl;
          state = reply?.ok === false ? 'unknown' : !value.installed ? 'missing'
            : value.auth === 'unauthed' || value.state === 'unauthed' ? 'unauthed'
              : value.state === 'ready' ? 'ready' : 'unknown';
        } catch (_) { state = 'unknown'; }
        runtimeCache.set(agent, { state, accessControl });
      }
      const { state, accessControl } = runtimeCache.get(agent);
      if (state !== 'ready') add(node, agent, 'runtime_' + state,
        state === 'missing' ? '请先在底座设置中安装或修复 ' + spec.displayName
          : state === 'unauthed' ? '请先在底座设置中登录 ' + spec.displayName
            : '暂时无法检查 ' + spec.displayName + '，请检查本机执行机连接');
      if (state === 'ready') {
        try { checkAccess(accessControl, policy); }
        catch (error) { add(node, agent, error.code, error.message); }
      }
      const modelKey = JSON.stringify([agent, route.modelName]);
      if (!modelCache.has(modelKey)) {
        try { modelCache.set(modelKey, { value: await model(route, who) }); }
        catch (error) { modelCache.set(modelKey, { error }); }
      }
      const selectedModel = modelCache.get(modelKey);
      if (selectedModel.error) add(node, agent, 'model_unavailable', selectedModel.error.message);
      const capKey = JSON.stringify([route.requested, route.names]);
      if (!capCache.has(capKey)) {
        try { await checkCapabilities(route, who); capCache.set(capKey, { ok: true }); }
        catch (error) { capCache.set(capKey, { message: error.code === 'capability_missing' ? error.message
          : '节点技能或设备能力暂时无法检查，请检查授权和后台连接' }); }
      }
      if (capCache.get(capKey).message) add(node, agent, 'capability_missing', capCache.get(capKey).message);
      nodes.push({ nodeKey: node.key, agent, model: selectedModel.value?.id || route.modelName });
    }
    const connectorNames = unique(pending.flatMap(node => node.capabilities?.mcpServers || []));
    if (connectorNames.length) {
      let checked;
      try { checked = await probeConnectors(who, connectorNames); }
      catch (_) { checked = connectorNames.map(name => ({ name, state: 'waiting' })); }
      for (const node of pending) {
        const names = unique(node.capabilities?.mcpServers).filter(name => name !== 'soduwork-media');
        for (const name of names) {
          if (!checked.some(row => row.name === name && row.state === 'ready')) add(node,
            nodes.find(row => row.nodeKey === node.key)?.agent || '', 'connector_unavailable',
            '请检查连接器的配置、连接和使用授权：' + name);
        }
      }
    }
    // A check that began under another account must never authorize dispatch.
    await identity(record);
    return { ok: issues.length === 0, issues, nodes };
  }
  return { preflight, resolveNode, identity, selection, checkPlugin, accessPolicy, checkAccess };
}

module.exports = { create, select };
