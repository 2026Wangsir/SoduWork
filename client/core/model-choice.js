/* A modality-qualified choice is never a text completion model name. */
(function (global) {
  'use strict';
  const PREFIX = 'image::';
  function imageKey(row) { return PREFIX + String(row.providerId || '') + '::' + String(row.name || ''); }
  function imageChoice(value) {
    if (typeof value !== 'string' || !value.startsWith(PREFIX)) return null;
    const split = value.indexOf('::', PREFIX.length);
    if (split < 0) return null;
    const providerId = value.slice(PREFIX.length, split), name = value.slice(split + 2);
    return providerId && name ? { providerId, name } : null;
  }
  // A local reference includes a 48-character provider and up to 160 model
  // characters, each of which may occupy nine percent-encoded ASCII bytes.
  function nameLimit(value) { return typeof value === 'string' && value.trim().startsWith('local:') ? 1500 : 300; }
  const api = { imageKey, imageChoice, nameLimit };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.SoduWorkModelChoice = api;
})(typeof window !== 'undefined' ? window : globalThis);
