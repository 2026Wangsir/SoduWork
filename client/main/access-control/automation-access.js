'use strict';
// Only the main-process automation worker can capture or restore this choice.
// Neither the Hub envelope nor a renderer option is a native consent source.
const preferences = require('./preferences');
const catalog = require('../agent-runtime/runtime-catalog');
const { connectionScope } = require('../platform-connections/runtime.cjs');
const SCHEMA = 'soduwork.automation-access/v1';
const modes = new Set(['standard', 'readonly', 'full']);
const issued = new WeakSet();
const supported = adapterId => catalog.runtime(adapterId || 'pi')?.accessControl?.supported === true;
const runIdValid = id => typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,119}$/.test(id);

function matches(choice, identity) {
  try { return choice.owner === connectionScope(identity); } catch { return false; }
}
function capture(app, options, identity, runId, trigger) {
  if (trigger !== 'manual' || options.chatId || options.taskRef || options.taskSession || !supported(options.adapterId)) return null;
  if (!runIdValid(runId)) throw Error('自动化执行标识无效');
  const value = preferences.snapshot(app);
  return { schema: SCHEMA, trigger: 'manual', runId, adapterId: options.adapterId || 'pi',
    owner: connectionScope(identity), mode: value.mode, revision: value.revision,
    fullConsentVersion: value.mode === 'full' ? 1 : 0 };
}
function authorize(choice, options, identity, runId) {
  if (!choice) return null;
  if (choice.schema !== SCHEMA || choice.trigger !== 'manual' || !runIdValid(runId) || choice.runId !== runId ||
      choice.adapterId !== (options.adapterId || 'pi') || !supported(choice.adapterId) ||
      !modes.has(choice.mode) || !Number.isSafeInteger(choice.revision) || choice.revision < 0 ||
      choice.mode === 'full' && choice.fullConsentVersion !== 1 ||
      !matches(choice, identity) || options.taskRef || options.taskSession) {
    throw Error('本次自动化授权已失效，请重新运行');
  }
  const context = Object.freeze({ ...choice });
  issued.add(context);
  return context;
}
function assertCurrent(context, identity) {
  if (!issued.has(context) || !matches(context, identity)) throw Error('连接账号已切换，本次自动化未启动');
}
function apply(options, context) {
  if (!context) return options;
  if (!issued.has(context)) throw Error('自动化授权来源无效');
  // The durable conversation owns resumed permissions. A new run alone takes
  // the choice frozen before its first opening attempt.
  return options.chatId ? options : { ...options, accessMode: context.mode };
}
function hasFullConsent(context) { return issued.has(context) && context.mode === 'full' && context.fullConsentVersion === 1; }
async function confirmFull({ app, event, options, context, consent, BrowserWindow, confirm }) {
  const automatedConsent = hasFullConsent(context);
  if (!event?.sender && !automatedConsent) return { ok: false, reason: '完全访问需要在客户端确认' };
  const parent = event?.sender ? BrowserWindow.fromWebContents(event.sender) : null;
  const allowed = automatedConsent || Boolean(consent) ||
    (preferences.isTrusted(event) && preferences.hasFullConsent(app, options)) || await confirm(parent);
  return allowed === true ? { ok: true } : { ok: false, cancelled: true, reason: '已取消完全访问' };
}
function service(app, open) {
  return {
    captureAutomationAccess: (options, identity, runId, trigger) => capture(app, options, identity, runId, trigger),
    openAutomation: async (options, identity, choice, runId) => {
      try { return await open(null, options, identity, authorize(choice, options, identity, runId)); }
      catch (error) { return { ok: false, reason: String(error.message || error) }; }
    },
  };
}
module.exports = { capture, authorize, apply, assertCurrent, confirmFull, matches, service };
