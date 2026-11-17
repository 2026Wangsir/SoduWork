/* Main-process startup cache for dock, pet, and tray visibility.
   Renderer cfg is authoritative; this cache avoids flashing disabled components before renderer startup.
   Renderer updates replace the cache through reportFlags. Do not treat it as a second source of truth. */
const path = require('path');
const fs = require('fs');
const { app } = require('electron');

const KEYS = ['dock', 'pet', 'tray'];
const _file = () => path.join(app.getPath('userData'), 'desk-flags.json');

let _cache = null;

/*
 * The dock is opt-in. Missing pet and tray flags default to visible.
 * If an existing cache cannot be parsed, retain
 * the tray recovery entry but hide pet and dock until authoritative renderer preferences
 * arrive.
 */
function all() {
  if (!_cache) {
    let raw = {};
    try { raw = JSON.parse(fs.readFileSync(_file(), 'utf8')) || {}; } catch (e) {
      if (e && e.code !== 'ENOENT') {
        console.warn('[desk-flags] 缓存读取失败（可能是透明加密/损坏）：托盘照常显示，竖条/小球等渲染层真值：', e && e.message || e);
        raw = { tray: true, dock: false, pet: false };
      } else {
        raw = {};
      }
    }
    _cache = {};
    KEYS.forEach((k) => { _cache[k] = k === 'dock' ? raw[k] === true : raw[k] !== false; });
  }
  return Object.assign({}, _cache);
}

/*
 * Return flags and changed after merging. Ignore unchanged reports to terminate
 * tray-to-renderer synchronization loops.
 */
function merge(flags) {
  const cur = all();
  const next = Object.assign({}, cur);
  KEYS.forEach((k) => { if (flags && k in flags) next[k] = !!flags[k]; });
  const changed = KEYS.some((k) => next[k] !== cur[k]);
  _cache = next;
  if (changed) {
    try { fs.writeFileSync(_file(), JSON.stringify(next)); } catch (e) { /* Persistence failure affects only the next startup's initial visibility. */ }
  }
  return { flags: Object.assign({}, next), changed };
}

module.exports = { all, merge, KEYS };
