'use strict';

const { runtime } = require('./agent-runtime/runtime-catalog');
const { imageChoice, imageKey } = require('../core/model-choice');
const LOCAL_REFERENCE = /^local:model-[a-f0-9]{32}$/;
const available = row => row && row.available !== false && row.unavailable !== true;

function createSelector({ localCatalog, request }) {
  return async function selectModel(identity, adapterId, requested) {
    const selected = String(requested || '').trim();
    if (runtime(adapterId)?.modelMode !== 'managed') return selected;
    const image = imageChoice(selected);
    if (image && adapterId !== 'pi') throw Error('当前执行底座不支持图片模型，请选择对话模型');
    const selectedLocal = image ? image.name : selected;
    if (selectedLocal.startsWith('local:') && !LOCAL_REFERENCE.test(selectedLocal)) {
      throw Error('本地模型选择不可用，请在自动化设置中重新选择');
    }
    // A locked or corrupt vault is not an empty catalog. Let the worker stop
    // without replacing a selection whose ownership cannot be established.
    const local = await localCatalog();
    if (local?.ok === false || !Array.isArray(local?.usable)) throw Error('本地模型目录无法读取，请检查本机安全存储');
    const localNames = local.usable.filter(available).map(row => String(row?.name || '')).filter(name => LOCAL_REFERENCE.test(name));
    const localImages = (local.mediaUsable?.image || []).filter(row => available(row) && LOCAL_REFERENCE.test(row.name)).map(imageKey);
    if (localNames.includes(selected) || localImages.includes(selected)) return selected;
    const isLocal = selected.startsWith('local:') || String(imageChoice(selected)?.name || '').startsWith('local:');
    if ((!selected || isLocal) && localNames.length) return localNames[0];

    // A successful, account-scoped catalog read is required before treating a
    // named Hub selection as deleted. Offline/auth failures must not switch it.
    const managed = await request(identity, '/my-models');
    if (managed?.ok === false || !Array.isArray(managed?.usable)) throw Error('模型目录暂时无法读取，请刷新后重试');
    const publicRow = row => available(row) && row.localOnly !== true &&
      !String(row.providerId || '').startsWith('device:') &&
      !String(row.name || '').startsWith('unavailable:') &&
      !String(row.name || '').startsWith('local:') &&
      !String(imageChoice(row.name)?.name || '').startsWith('local:');
    const managedNames = managed.usable.filter(publicRow).map(row => String(row.name || '').trim()).filter(Boolean);
    const managedImages = (managed.mediaUsable?.image || []).filter(publicRow).map(imageKey);
    if (managedNames.includes(selected) || managedImages.includes(selected)) return selected;
    const replacement = localNames[0] || managedNames[0];
    if (!replacement) throw Error('当前没有可用模型，请先配置模型后重试');
    return replacement;
  };
}

module.exports = { createSelector };
