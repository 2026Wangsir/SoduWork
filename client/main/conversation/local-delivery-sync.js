'use strict';
// Turn completion only indexes local results. Library writes belong to the
// explicit save action, never to session settlement or renderer attachment.
const artifacts = require('./artifact-runtime');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const { scope, connectionScope } = require('../platform-connections/runtime.cjs');
const destination = identity => connectionScope(identity) + '|' + identity.hub.replace(/\/+$/, '');

function ready(snapshot) {
  const execution = snapshot?.execution || {}, phase = execution.quality?.phase;
  return snapshot?.status === 'idle' && !snapshot.pendingUi && !execution.running && !execution.stopped &&
    !execution.limitRequest && !['executing', 'implementing', 'reviewing', 'repairing', 'blocked'].includes(phase);
}
function create({ notify = () => {}, snapshotFiles = artifacts.snapshotAsync } = {}) {
  const states = new WeakMap();
  function mark(handle, state, value) {
    if (states.get(handle) !== state) return;
    handle.deliverySync = { managed: true, state: 'local', ...value };
    try { notify(handle); } catch { /* A closing renderer does not own results. */ }
  }
  async function capture(handle, state, completedTurn) {
    try {
      if (states.get(handle) !== state || handle.passiveCloudView) return;
      const snapshot = handle.snapshot();
      if (!(completedTurn ? snapshot.status === 'idle' && !snapshot.pendingUi : ready(snapshot) && !handle.inFlight?.())) return;
      const token = {}; state.latest = token;
      const indexed = await snapshotFiles(handle);
      if (states.get(handle) !== state || state.latest !== token) return;
      const declared = indexed.delivery?.source === 'manifest';
      const primary = (indexed.delivery?.presentation === 'summary' ? [] : indexed.delivery?.items || indexed.items || [])
        .filter(file => file.primary !== false && !file.processEvidence && file.role !== 'evidence' &&
          (!file.pluginDraft || file.skillPackage && /\.skill$/i.test(file.name || file.relative || file.path || '')));
      const closures = new Map();
      for (const file of primary) {
        if (!handle.cwd || !file.path || !file.artifactId) continue;
        // Reuse the packaging dependency resolver so CSS-only revisions and
        // archive-download revisions agree without compressing the files.
        const captured = await require('./delivery-package').prepare(handle, [file.artifactId], {
          completedTurn: true, metadataOnly: true, snapshot: indexed, turnSince: indexed.got?.turnSince,
        });
        if (states.get(handle) !== state || state.latest !== token) return;
        closures.set(file.artifactId, captured);
      }
      const files = primary.filter(file => file.changedInTurn || declared ||
        closures.get(file.artifactId)?.changedInTurn === true);
      const artifactIds = files.map(file => file.artifactId);
      const artifactVersions = files.map(file => ({ id: file.artifactId, at: file.at || 0, size: file.size || 0 }));
      // Supporting assets can change without touching the entry file. Include
      // their metadata in the UI revision so an older save is never reused.
      const included = new Set([...files.map(file => file.relative || file.name),
        ...files.flatMap(file => closures.get(file.artifactId)?.manifest.files.map(row => row.path) || [])]);
      const versions = await Promise.all((indexed.items || []).filter(file =>
        !file.processEvidence && file.role !== 'evidence' &&
        (!file.pluginDraft || file.skillPackage && /\.skill$/i.test(file.name || file.relative || file.path || '')) &&
        (included.has(file.relative || file.name) || !handle.cwd)).map(async file => {
        if (!file.path) return [file.artifactId, file.at || 0, file.size || 0];
        try {
          const stat = await fs.stat(file.path);
          return [file.artifactId, stat.mtimeMs, stat.ctimeMs, stat.size, stat.ino];
        } catch { return [file.artifactId, 'missing']; }
      }));
      if (states.get(handle) !== state || state.latest !== token) return;
      const signature = JSON.stringify({files:versions.sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
        closures:[...closures].map(([id, value]) => [id, value.manifest.revision]).sort((a,b)=>a[0].localeCompare(b[0]))});
      const revision = createHash('sha256').update(signature).digest('hex');
      const currentTurn = Boolean(files.length && signature !== state.previous);
      state.previous = signature;
      mark(handle, state, { artifactIds, artifactVersions, currentTurn, revision });
    } catch { /* Index failure must not create a save error or block the next turn. */ }
  }
  function bind(handle, identity) {
    let owner, target; try { owner = scope(identity); target = destination(identity); } catch { return; }
    if (states.get(handle)?.destination === target) return;
    const state = { destination: target, lastStatus: '', previous: null, latest: null };
    states.set(handle, state);
    handle.deliveryOwner = owner;
    handle.deliverySync = { managed: true, state: 'local', artifactIds: [], artifactVersions: [] };
    handle.captureDelivery = () => capture(handle, state, true);
  }
  function observe(handle, touched, snapshot) {
    const state = states.get(handle); if (!state || handle.passiveCloudView) return;
    const wasBusy = ['streaming', 'running', 'queued'].includes(state.lastStatus); state.lastStatus = snapshot?.status;
    if (!wasBusy && ['streaming', 'running', 'queued'].includes(snapshot?.status)) {
      state.latest = null;
      mark(handle, state, { artifactIds: [], artifactVersions: [] });
    }
    if (handle.deliveryCaptureAtTurnBoundary) return;
    if (!ready(snapshot) || !(['settled', 'turn-finished'].includes(touched?.kind) || wasBusy)) return;
    void (async () => {
      for (let n = 0; n < 8 && ready(handle.snapshot()) && handle.inFlight?.(); n++) await new Promise(resolve => setTimeout(resolve, 25));
      if (!handle.inFlight?.()) await capture(handle, state, false);
    })().catch(() => {});
  }
  return { bind, observe };
}
module.exports = { create, ready };
