'use strict';

// Navigation provenance, not an execution grant. Only an authenticated native
// application composer can create this record; ordinary plugin selections and
// renderer sidebar groups cannot turn a chat into an application conversation.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { assertNoLinks } = require('../plugin-resources');
const runtime = require('../platform-connections/runtime.cjs');
function owner(identity) {
  return { owner: runtime.scope(identity), hub: new URL(identity.hub).origin };
}
function location(app, id) {
  if (typeof id !== 'string' || !id || id.length > 512) throw Error('会话标识无效');
  const file = path.join(app.getPath('userData'), 'conversation-app-origins',
    crypto.createHash('sha256').update(id).digest('hex') + '.json');
  assertNoLinks(app.getPath('userData'), file);
  return file;
}
function read(app, id, identity) {
  let value;
  try { value = JSON.parse(fs.readFileSync(location(app, id), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const current = owner(identity);
  if (value.version !== 1 || value.sessionId !== id || value.owner !== current.owner || value.hub !== current.hub)
    throw Error('应用会话属于其他账号或服务，请切回原账号');
  if (!value.pluginId || !value.contributionId || new URL(value.origin).origin !== value.origin)
    throw Error('应用会话来源无效，请从原应用打开');
  return value;
}
function bind(app, id, identity, origin) {
  const previous = read(app, id, identity);
  if (previous) {
    if (['pluginId', 'contributionId', 'origin'].some(key => previous[key] !== origin[key]))
      throw Error('会话属于另一个应用，请从原应用打开');
    return previous;
  }
  const value = { version: 1, sessionId: id, ...owner(identity),
    pluginId: origin.pluginId, contributionId: origin.contributionId, origin: origin.origin };
  const file = location(app, id);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try { fs.writeFileSync(file, JSON.stringify(value), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; return bind(app, id, identity, origin); }
  return value;
}
module.exports = { read, bind, owner, exists: (app, id) => fs.existsSync(location(app, id)) };
