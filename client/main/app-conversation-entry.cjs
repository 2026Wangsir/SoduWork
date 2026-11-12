'use strict';

// Revalidate the accepted installation and contribution, including for a window
// that is already open. Persisted origin metadata is never permission to launch.
async function resolve(deps, origin, assertCurrent = () => {}) {
  const pluginId = origin.pluginId;
  const installed = pluginId.startsWith('local:')
    ? require('./personal-plugins').get(deps.app, pluginId)
    : await require('./app-installed-remote.cjs').get(deps, pluginId, assertCurrent);
  assertCurrent();
  if (!installed || installed.enabled === false) throw Error('应用已停用或卸载，请先在即用中恢复');
  const entry = installed.ui?.contributions?.find(row => row.id === origin.contributionId);
  const kind = entry?.source?.type || entry?.source?.kind;
  if (!entry || entry.slot !== 'workspace.navigation' || !['external', 'package'].includes(kind) ||
      entry.source.openMode === 'external') throw Error('应用入口已变化，请从即用重新打开');
  const packaged = kind === 'package';
  let url = '';
  if (!packaged) {
    // Only installed setup fields can resolve the entry. Task/context templates
    // are not recoverable from a session identifier and must not be guessed.
    url = String(entry.source.url || '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, key) => {
      const field = key.replace(/^setup\./, '');
      return Object.hasOwn(installed.setupConfig || {}, field) ? String(installed.setupConfig[field]) : match;
    });
    if (/\{\{/.test(url)) throw Error('应用入口需要上下文，请从原应用打开');
    const target = new URL(url);
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.origin !== origin.origin)
      throw Error('应用来源已变化，请从即用重新打开');
  } else if (require('../core/plugin-package-page.cjs').origin(pluginId) !== origin.origin) {
    throw Error('应用来源已变化，请从即用重新打开');
  }
  return { tabId: 'app-' + pluginId.replace(/[^a-zA-Z0-9_-]+/g, '-') + '-' +
      entry.id.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 60),
    url, label: entry.title || installed.name, appVersion: String(installed.version || ''),
    icon: installed.icon, windowSettings: installed.appWindow,
    ...(packaged ? { package: { pluginId, contributionId: entry.id } } : {
      appBridge: { appId: 'plugin:' + pluginId, contributionId: entry.id, origin: origin.origin,
        version: 1, capabilities: entry.source.bridge?.capabilities || [] } }) };
}
module.exports = { resolve };
