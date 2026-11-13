const assert = require('node:assert/strict');
const fs = require('./renderer-source.cjs');
const path = require('node:path');

const { validateAdapter, CAPABILITIES } = require('../main/agent-runtime/contract');
const {
  ADAPTER_ID,
  createRunnerRuntimeAdapter,
  _uuidV5,
} = require('../main/agent-runtime/runner-adapter');
const { RUNTIMES } = require('../main/agent-runtime/runtime-catalog');

const adapter = createRunnerRuntimeAdapter();
const descriptor = validateAdapter(adapter);
assert.equal(ADAPTER_ID, 'codex-harness');
assert.equal(descriptor.id, 'codex-harness');
assert.equal(descriptor.displayName, 'Codex Harness');
assert.ok(descriptor.capabilities.some((item) => item.id === CAPABILITIES.SESSION_RESUME));
assert.ok(descriptor.capabilities.some((item) => item.id === CAPABILITIES.TURN_QUEUE));
assert.ok(descriptor.capabilities.some((item) => item.id === CAPABILITIES.MODEL_SELECT));
assert.ok(descriptor.capabilities.some((item) => item.id === CAPABILITIES.GOAL_CONTROL));
assert.deepEqual(RUNTIMES.map((item) => item.id), [
  'pi', 'codex-harness', 'opencode', 'codex', 'qwen', 'dsh', 'harness2', 'kimi', 'claude',
]);
RUNTIMES.filter((item) => item.transport === 'runner').forEach((runtimeSpec) => {
  const runner = validateAdapter(createRunnerRuntimeAdapter({ runtimeSpec }));
  assert.equal(runner.id, runtimeSpec.id);
  assert.equal(runner.displayName, runtimeSpec.displayName);
});

const namespace = '9af442c8-cd1d-4b91-a668-22da2b2635bf';
assert.equal(_uuidV5(namespace, 'chat-demo'), 'fa126f20-10d1-5176-a85c-1255b782dcb3',
  'Electron and Python must derive the same execution reference');
assert.equal(_uuidV5(namespace, 'task-123'), '45f7107a-4fbc-53df-b0fd-a3ecf892ac08');

const compose = fs.readFileSync(path.join(__dirname,
  '../components/panels/panels-compose.js'), 'utf8');
const runtime = fs.readFileSync(path.join(__dirname,
  '../components/panels/panels-compose-runtime.js'), 'utf8');
const brand = fs.readFileSync(path.join(__dirname,
  '../components/panels/agent-brand.js'), 'utf8');
const composerCss = fs.readFileSync(path.join(__dirname,
  '../components/panels/work-composer.css'), 'utf8');
const sessionControlsCss = fs.readFileSync(path.join(__dirname,
  '../components/panels/chat-session-controls.css'), 'utf8');
const desk = fs.readFileSync(path.join(__dirname, '../desk.html'), 'utf8');
const composeSurface = fs.readFileSync(path.join(__dirname,
  '../components/panels/compose-surface.js'), 'utf8');
const bridge = fs.readFileSync(path.join(__dirname,
  '../main/agent-runtime/pi-session-bridge.js'), 'utf8');
const chat = fs.readFileSync(path.join(__dirname,
  '../components/panels/panels-chat.js'), 'utf8');
const picker = fs.readFileSync(path.join(__dirname,
  '../components/panels/chat-runtime-picker.js'), 'utf8');
const workComposer = fs.readFileSync(path.join(__dirname,
  '../components/panels/work-composer.js'), 'utf8');
const localeChat = fs.readFileSync(path.join(__dirname,
  '../core/locales/en-US-chat.js'), 'utf8');

assert.match(runtime, /api\.runtimes/,
  'new conversation must load the authoritative runtime catalog over IPC');
assert.match(runtime, /data-runtime=.*runtime\.id/,
  'runtime rows must be generated from the catalog rather than hard-coded');
[
  "pi: 'PI'",
  "opencode: 'OC'",
  "qwen: 'QW'",
  "dsh: 'DS'",
].forEach((entry) => assert.ok(brand.includes(entry), 'missing Agent monogram: ' + entry));
assert.match(runtime, /iconHtml:\s*brandIcon\(current, 'cpRuntimeIcon'\)/,
  'selected runtime must use the same identity badge as the picker');
assert.match(runtime, /AgentBrand\.html\(id, \{ className: 'runtime-brand'/,
  'runtime picker must delegate identity rendering to the shared Agent brand contract');
assert.match(runtime, /#cpRuntimeAvailability/,
  'new conversation must render a missing-runtime slot beside the selected runtime');
assert.match(runtime, /cp-runtime-availability-footer/,
  'new conversation must render runtime management inside the picker footer');
assert.match(runtime, /missingWrap\.closest\('\.cp-runtimewrap'\)/,
  'new conversation must keep the missing-runtime slot in the same runtime wrapper');
assert.match(runtime, /missingWrap\.parentElement === runtimeWrap/,
  'picker footer must not widen the compact composer toolbar');
assert.match(composeSurface, /runtimeWrap\.appendChild\(runtimeAvailability\)/,
  'new conversation must move the missing-runtime slot with the selected runtime button');
assert.match(sessionControlsCss, /wc-agent-badge\{[^}]*border:1px solid/,
  'historical conversation runtime trigger must share the outlined selected-runtime treatment');
assert.match(desk, /components\/panels\/chat-session-controls\.css/,
  'historical conversation runtime styles must be loaded in production');
assert.match(runtime, /class='wc-pop-row cp-runtime-row'/,
  'runtime rows must keep explicit icon, copy and status columns');
assert.match(runtime, /data-state='unknown'/,
  'runtime availability must use a stable state contract');
assert.match(composerCss, /\.cp-runtime-row\{[^}]*grid-template-columns:28px minmax\(0,1fr\) auto/,
  'compact runtime picker must reserve the intrinsic width of its status column');
assert.doesNotMatch(composerCss, /\.cp-runtime-pop \.wc-pop-row>span\{flex:1 1 auto\}/,
  'the generic text column must never stretch the brand icon container');
const enterChat = compose.slice(compose.indexOf('async function _enterChat('), compose.indexOf('async function makeDraft('));
const localStart = enterChat.slice(enterChat.indexOf('const viewSeq = _composeViewSeq;'));
const preparationAwait = localStart.indexOf('await global.ComposeModelPicker?.ready?.()');
assert.ok(preparationAwait >= 0, 'the local first send waits for model preparation');
assert.match(localStart, /const adapterId = global\.ComposeRuntime\?\.value\?\.\(\) \|\| 'pi';/,
  'local conversation must capture its selected runtime with an explicit Pi default');
assert.ok(localStart.indexOf('const adapterId =') < preparationAwait,
  'runtime selection must be captured before asynchronous preparation');
assert.match(localStart, /const executionRevision = global\.ComposeExecution\?\.revision\?\.\(\);/,
  'local conversation must capture its execution location revision');
assert.ok(localStart.indexOf('const executionRevision =') < preparationAwait,
  'execution location revision must be captured before asynchronous preparation');
assert.ok(localStart.indexOf('const current =') < preparationAwait,
  'the full selection guard must exist before asynchronous preparation');
assert.match(localStart, /global\.ComposeExecution\?\.revision\?\.\(\) === executionRevision/,
  'returning to local execution still invalidates a send prepared under an earlier revision');
assert.match(localStart, /await global\.ComposeModelPicker\?\.ready\?\.\(\);\s*if \(!current\(\)\) return false/,
  'the selected runtime and location must still match after model warmup');
assert.match(localStart, /await _capabilityPromise\.catch\(\(\) => \{\}\);\s*if \(!current\(\)\) return false/,
  'the selected runtime and location must still match after capability warmup');
assert.match(localStart, /NativeChat\.enter\([\s\S]*?Object\.assign\(\{\s*adapterId,\s*modelName:/,
  'the captured runtime must reach the final session open options unchanged');
assert.match(localStart, /global\.ComposeRuntime\?\.value\?\.\(\) \|\| 'pi'\) === adapterId/,
  'local preparation must still reject a runtime selection changed while awaiting');
assert.match(bridge, /createRunnerRuntimeAdapter/,
  'the generic runtime registry must register the Runner adapter');
assert.match(bridge, /runtimeCatalog\.runnerRuntimes\(\)/,
  'all supported Runner runtimes must be registered from one catalog');
assert.match(bridge, /async function availableRuntimes/,
  'runtime availability must be health checked without changing the sync catalog API');
assert.match(bridge, /availableRuntimes: ready/,
  'the bridge must separate ready rows from the complete catalog');
assert.match(picker, /availableRuntimes/,
  'the conversation picker must render the health checked projection');
assert.match(picker, /cp-runtime-pop/,
  'historical conversations must use the same runtime picker surface as new conversations');
assert.match(picker, /wc-pop-row cp-runtime-row/,
  'historical runtime rows must keep the shared icon, name and status columns');
assert.match(picker, /nchatRuntimeAvailability/,
  'historical conversations must expose the missing-runtime stack beside the selected Agent');
assert.match(picker, /function attachFooter\(\)/,
  'historical conversations must move the management entry into the picker footer');
assert.match(workComposer, /data-runtime-more/,
  'missing runtimes must expose a management entry point');
assert.match(picker, /translateText/,
  'picker labels and aria text must go through the locale adapter');
assert.match(localeChat, /'缺失的执行底座': 'Missing runtimes'/,
  'runtime availability labels must have an English locale entry');
assert.match(localeChat, /'打开 Agent 管理': 'Open Agent management'/,
  'runtime management action must have an English locale entry');
assert.match(composerCss, /cp-runtimewrap:has\(> \.wc-runtime-availability:not\(\[hidden\]\)\)/,
  'missing runtime stack must remain visible in the compact composer');
assert.match(composerCss, /cp-runtime-availability-footer[^}]*border-top/,
  'runtime management must be visually separated as the picker footer');
assert.match(bridge, /legacyOptions\.adapterId\s*\|\|\s*'pi'/,
  'Pi remains the explicit default rather than an implicit fallback');
assert.match(chat, /_sessionOptions\.adapterId/,
  'chat probing must follow the selected session runtime');

const piAdapter = fs.readFileSync(path.join(__dirname,
  '../main/agent-runtime/pi-adapter.js'), 'utf8');
assert.match(piAdapter, /sessionModule\.open\(/,
  'Pi must continue to open its native local session directly');
assert.doesNotMatch(piAdapter, /runner-runtime|runnerRuntime/,
  'Pi direct mode must never depend on the Runner transport');
console.log('conversation runtime selector: multi-runtime contract passed');
