'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');

function fixture() {
  let scope = 'account-a';
  const events = new Map(), requests = [];
  const body = { innerHTML: '', textContent: '' };
  const panel = { classList: { contains: () => true } };
  const context = {
    Promise, setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {},
    document: { getElementById: id => id === 'agBody' ? body : id === 'agPanel' ? panel : null },
    addEventListener: (name, callback) => events.set(name, callback),
    SoduWorkAPI: {
      taskStorageKey: () => scope,
      runners: () => new Promise(resolve => requests.push({ scope, resolve })),
    },
    RunnerManager: { reset() {} },
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../components/panels/panels-agents.js'), 'utf8'), context);
  vm.runInContext('_agView = "runners"', context);
  context._agDrawerSync = () => {};
  context._agRender = () => { body.textContent = vm.runInContext('JSON.stringify(_agData?.runners || [])', context); };
  return { context, body, requests, events, setScope: value => { scope = value; },
    read: code => vm.runInContext(code, context) };
}

test('account changes clear personal inventory and discard the previous account response before caching', async () => {
  const f = fixture();
  const oldLoad = f.context._agLoad(true);
  f.body.textContent = 'Previous account machine';
  f.setScope('account-b');
  f.events.get('soduwork-data-scope-changed')();
  assert.equal(f.body.textContent, '');
  await Promise.resolve();
  assert.equal(f.requests.length, 2);
  f.requests[0].resolve({ runners: [{ runnerId: 'private-a', owned: true, label: 'Previous account machine' }] });
  await oldLoad;
  assert.equal(f.read('_agData'), null);
  assert.equal(f.read('_agLoaded.runners'), false);
  f.requests[1].resolve({ runners: [{ runnerId: 'personal-b', owned: true }] });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(f.body.textContent, /personal-b/);
  assert.doesNotMatch(f.body.textContent, /private-a|Previous account machine/);
});

test('renewing the same account keeps its inventory and active installation state', async () => {
  const f = fixture();
  const load = f.context._agLoad(true);
  f.requests[0].resolve({ runners: [{ runnerId: 'personal-a', owned: true }] });
  await load;
  f.read('_agJobs = { install: { state: "running", jobId: "accepted" } }');
  f.events.get('soduwork-device-auth')();
  assert.equal(f.requests.length, 1);
  assert.equal(f.read('_agJobs.install.jobId'), 'accepted');
  assert.match(f.body.textContent, /personal-a/);
});

test('device models are offered as local Agent defaults and deleted selections remain explicit', () => {
  const f = fixture(); f.context.esc = String;
  f.read('_agData = { models: [{ name: "local:private", label: "Private", localOnly: true }] }');
  let html = f.context._agModelHtml({ key: 'qwen', modelPick: true });
  assert.match(html, /本地默认模型仅保存在当前设备/);
  assert.match(html, /value="local:private"/);
  assert.doesNotMatch(html, /还没有能用的模型/);
  f.read('_agData.models.push({ name: "hub-model", label: "Hub model" })');
  html = f.context._agModelHtml({ key: 'qwen', modelPick: true });
  assert.match(html, /value="hub-model"/);
  assert.match(html, /value="local:private"/);
  html = f.context._agModelHtml({ key: 'qwen', modelPick: true, model: 'local:deleted',
    localModelDefault: true, modelGone: true });
  assert.match(html, /value="local:deleted" selected/);
  assert.match(html, /原本地模型已删除或不可用/);
  assert.doesNotMatch(html, /派活会退回默认/);
  html = f.context._agModelHtml({ key: 'codex', modelPick: false });
  assert.doesNotMatch(html, /<select|local:private/);
});

for (const outcome of ['accepted', 'rejected']) {
  test(`a previous account's ${outcome} installation cannot replace a new account job`, async () => {
    const f = fixture();
    let resolve, reject;
    f.read('_agData = { machines: [{ runnerId: "machine", scope: "current-instance", agents: [{ key: "pi" }] }] }');
    f.context.SoduWorkAPI.agentInstall = () => new Promise((yes, no) => { resolve = yes; reject = no; });
    const pending = f.context._agRun('machine~pi', 'repair');
    f.setScope('account-b');
    f.events.get('soduwork-device-auth')();
    f.read('_agJobs["machine~pi"] = { jobId: "new-account-job", state: "running" }');
    if (outcome === 'accepted') resolve({ jobId: 'old-account-job' });
    else reject(new Error('Old account installation details'));
    await pending;
    assert.equal(f.read('_agJobs["machine~pi"].jobId'), 'new-account-job');
    assert.equal(f.read('_agJobs["machine~pi"].state'), 'running');
  });
}

test('late machine diagnostics cannot repopulate a cleared account or clear its new probe', async () => {
  const f = fixture(), probes = [];
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../components/panels/panels-runners.js'), 'utf8'), f.context);
  f.context.SoduWorkAPI.runnerProbe = () => new Promise(resolve => probes.push(resolve));
  f.context._agEnsureScope();
  const oldProbe = f.context._rnDoProbe('same-local-machine');
  f.setScope('account-b');
  f.events.get('soduwork-data-scope-changed')();
  const newProbe = f.context._rnDoProbe('same-local-machine');
  probes[0]({ ok: true, data: { agents: ['Private old model'], capabilities: { privateOldSetting: true } } });
  await oldProbe;
  assert.equal(f.read('_rnProbe["same-local-machine"]'), undefined);
  assert.equal(f.read('_rnWorking["same-local-machine"]'), 'probe');
  probes[1]({ ok: true, data: { agents: [], capabilities: { currentSetting: true } } });
  await newProbe;
  assert.equal(f.read('_rnProbe["same-local-machine"].capabilities.currentSetting'), true);
  assert.equal(f.read('_rnWorking["same-local-machine"]'), undefined);
});

test('an installation approval from a previous account never starts work in the new account', async () => {
  const f = fixture();
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../components/panels/panels-runners.js'), 'utf8'), f.context);
  let approve, starts = 0;
  f.context.soduWorkAPI = { confirmRunnerComponentInstall: () => new Promise(resolve => { approve = resolve; }) };
  f.context.SoduWorkAPI.runnerComponentInstall = async () => { starts++; return {}; };
  f.context._agEnsureScope();
  const pending = f.context._rnInstallComponent('local-machine', 'office',
    [{ runnerId: 'local-machine', owned: true, embedded: true }]);
  f.setScope('account-b');
  f.events.get('soduwork-device-auth')();
  approve({ ok: true });
  await pending;
  assert.equal(starts, 0);
  assert.equal(f.read('Object.keys(_rnComponentJobs).length'), 0);
});
