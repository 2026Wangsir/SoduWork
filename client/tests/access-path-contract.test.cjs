'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const policy = require('../main/access-control/policy');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function sdkPaths() {
  return import(pathToFileURL(path.resolve(__dirname,
    '../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/path-utils.js')).href);
}
function temporary(t) {
  // Windows service accounts can expose TEMP with different casing from the
  // physical directory. Compare SDK and policy paths from the same native cwd.
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-access-paths-')));
  const workspace = path.join(root, 'workspace'); fs.mkdirSync(workspace);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, workspace };
}
function aliases(target) {
  const list = ['@' + target, '~/' + path.relative(os.homedir(), target).split(path.sep).join('/'),
    pathToFileURL(target).href, target.replaceAll(' ', '\u00A0')];
  if (process.platform === 'win32') {
    const slash = target.replaceAll('\\', '/');
    for (const prefix of ['/', '/mnt/', '/cygdrive/']) list.push(prefix + slash[0].toLowerCase() + slash.slice(2));
    list.push('~\\' + path.relative(os.homedir(), target));
  }
  return list;
}
const variants = [
  ["Capture's", 'Capture\u2019s'],
  ['Caf\u00e9', 'Cafe\u0301'],
  ['Screen 1 AM.png', 'Screen 1\u202fAM.png'],
  ["Capture d'\u00e9cran", 'Capture d\u2019e\u0301cran'],
];

test('permission resolution matches the installed Pi SDK for path aliases and spaces', async t => {
  const { root, workspace } = temporary(t), sdk = await sdkPaths();
  const target = path.join(root, 'outside file.txt');
  const p = policy.create('standard', workspace);
  const inputs = ['inside.txt', '@inside.txt', ' leading space.txt', '@@literal.txt', '~', ...aliases(target)];
  for (const space of ['\u2000', '\u200A', '\u202F', '\u205F', '\u3000']) inputs.push(target.replaceAll(' ', space));
  for (const input of inputs) {
    for (const name of ['write', 'edit', 'ls', 'find', 'grep']) {
      const op = policy.operation(p, name, { path: input });
      const native = sdk.resolveToCwd(input, workspace);
      assert.equal(op.source, native, name + ': ' + input);
      assert.equal(op.target, policy.canonical(native));
      const concrete = name !== 'grep' || fs.existsSync(op.target) && fs.statSync(op.target).isFile();
      assert.equal(op.verdict, concrete && policy.within(p.workspaceRoot, op.target) ? 'allow' : 'ask');
    }
    assert.equal(policy.operation(p, 'read', { path: input }).source, await sdk.resolveReadPathAsync(input, workspace));
  }
});

test('read fallback variants match Pi and cannot disguise external junctions as workspace reads', async t => {
  const { root, workspace } = temporary(t), sdk = await sdkPaths();
  const outside = path.join(root, 'outside'); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'private');
  for (const [raw, actual] of variants) {
    fs.symlinkSync(outside, path.join(workspace, actual), 'junction');
    const input = path.join(raw, 'secret.txt');
    const native = await sdk.resolveReadPathAsync(input, workspace);
    const expected = path.join(workspace, actual, 'secret.txt');
    // macOS may resolve canonically equivalent Unicode without taking the SDK
    // fallback. Preserve the physical identity and byte checks on every OS.
    assert.equal(native.normalize('NFC'), expected.normalize('NFC'));
    assert.equal(fs.realpathSync(native), fs.realpathSync(expected));
    assert.equal(fs.readFileSync(native, 'utf8'), 'private');
    for (const mode of ['standard', 'readonly']) {
      const op = policy.operation(policy.create(mode, workspace), 'read', { path: input });
      assert.equal(op.source, native);
      assert.equal(op.target, path.join(outside, 'secret.txt'));
      assert.equal(op.verdict, 'ask');
    }
  }
  // Pi must still prefer an exact existing filename over a fallback.
  fs.mkdirSync(path.join(workspace, variants[0][0]));
  fs.writeFileSync(path.join(workspace, variants[0][0], 'secret.txt'), 'local');
  const input = path.join(variants[0][0], 'secret.txt');
  assert.equal(policy.operation(policy.create('standard', workspace), 'read', { path: input }).verdict, 'allow');
  assert.equal(await sdk.resolveReadPathAsync(input, workspace), path.join(workspace, input));
});

test('junction workspaces resolve relative traversal against the native cwd, not its physical root', async t => {
  const { root, workspace } = temporary(t);
  const physical = path.join(root, 'deep', 'work'), outside = path.join(root, 'work');
  fs.mkdirSync(physical, { recursive: true }); fs.mkdirSync(outside);
  fs.rmdirSync(workspace); fs.symlinkSync(physical, workspace, 'junction');
  const actual = path.join(outside, 'secret.txt'); fs.writeFileSync(actual, 'unchanged');
  const p = policy.create('standard', workspace), args = { path: '../work/secret.txt', content: 'authorized' };
  const sdk = await sdkPaths();
  assert.equal(sdk.resolveToCwd(args.path, workspace), actual);
  assert.equal(policy.operation(p, 'write', args, workspace).target, actual);
  assert.equal(policy.operation(p, 'write', args, workspace).verdict, 'ask');
  const session = { agent: { beforeToolCall: async () => undefined } };
  const access = require('../main/access-control/pi').install(session, p, workspace, () => {});
  t.after(() => access.broker.close());
  const context = { toolCall: { name: 'write' }, args };
  let check = session.agent.beforeToolCall(context); await delay(0);
  let request = access.broker.pending()[0]; assert.ok(request); assert.equal(request.target, actual);
  access.broker.answer({ ...request, decision: 'deny' }); assert.equal((await check).block, true);
  assert.equal(fs.readFileSync(actual, 'utf8'), 'unchanged');
  access.broker.beginTurn(); check = session.agent.beforeToolCall(context); await delay(0);
  request = access.broker.pending()[0]; assert.ok(request);
  access.broker.answer({ ...request, decision: 'once' }); assert.equal(await check, undefined);
  const { createWriteTool } = await import(pathToFileURL(path.resolve(__dirname,
    '../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/write.js')).href);
  await createWriteTool(workspace).execute('cwd-contract', args);
  assert.equal(fs.readFileSync(actual, 'utf8'), 'authorized');
  assert.equal(fs.existsSync(path.join(physical, 'secret.txt')), false);
});

async function denyTurn(fixture, tool, args) {
  fixture.access.broker.beginTurn();
  const promise = fixture.send(tool, args);
  for (let i = 0; i < 300 && !fixture.access.broker.pending().length; i++) await delay(10);
  const request = fixture.access.broker.pending()[0];
  assert.ok(request, tool + ' must await permission for ' + args.path);
  assert.equal(fixture.access.broker.answer({ ...request, decision: 'deny' }).ok, true);
  await promise;
  const result = fixture.session.messages.filter(message => message.role === 'toolResult').at(-1);
  assert.equal(result.isError, true);
  return result;
}

test('real Pi SDK refuses unapproved alias writes, edits and reads, with working approved access', { timeout: 60000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-access-alias-sdk-'));
  const fixture = await require('../e2e/fixtures/access-sdk.cjs').create(root);
  t.after(async () => { await fixture.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const target = path.join(root, 'outside secret.txt'), secret = 'SECRET-OUTSIDE-ALIAS';
  fs.writeFileSync(target, secret);
  for (const input of aliases(target)) {
    await denyTurn(fixture, 'write', { path: input, content: 'unauthorized' });
    assert.equal(fs.readFileSync(target, 'utf8'), secret);
    await denyTurn(fixture, 'edit', { path: input, oldText: secret, newText: 'unauthorized' });
    assert.equal(fs.readFileSync(target, 'utf8'), secret);
    const result = await denyTurn(fixture, 'read', { path: input });
    assert.ok(!JSON.stringify(result.content).includes(secret));
  }
  // Consent is for the actual resolved target; accepted aliases remain usable.
  fixture.access.broker.beginTurn();
  const turn = fixture.send('write', { path: '@' + target, content: 'approved' });
  for (let i = 0; i < 300 && !fixture.access.broker.pending().length; i++) await delay(10);
  const request = fixture.access.broker.pending()[0]; assert.ok(request);
  assert.equal(request.target, policy.canonical(target));
  fixture.access.broker.answer({ ...request, decision: 'once' }); await turn;
  assert.equal(fs.readFileSync(target, 'utf8'), 'approved');
  await fixture.send('write', { path: '@ordinary\u00a0file.txt', content: 'local' });
  assert.equal(fs.readFileSync(path.join(fixture.workspace, 'ordinary file.txt'), 'utf8'), 'local');
});

test('real Pi SDK blocks external read fallbacks and invalidates consent when the selected variant changes', { timeout: 60000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-access-read-sdk-'));
  const fixture = await require('../e2e/fixtures/access-sdk.cjs').create(root);
  t.after(async () => { await fixture.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const outside = path.join(root, 'outside'); fs.mkdirSync(outside);
  const secret = 'SECRET-OUTSIDE-VARIANT'; fs.writeFileSync(path.join(outside, 'secret.txt'), secret);
  for (const [raw, actual] of variants) {
    fs.symlinkSync(outside, path.join(fixture.workspace, actual), 'junction');
    const result = await denyTurn(fixture, 'read', { path: path.join(raw, 'secret.txt') });
    assert.ok(!JSON.stringify(result.content).includes(secret));
  }
  const base = path.join(fixture.workspace, '.soduwork', "Capture's"); fs.mkdirSync(base, { recursive: true });
  const original = path.join(base, 'secret.txt'); fs.writeFileSync(original, 'local protected file');
  fs.symlinkSync(outside, path.join(fixture.workspace, '.soduwork', 'Capture\u2019s'), 'junction');
  fixture.access.broker.beginTurn();
  const turn = fixture.send('read', { path: original });
  for (let i = 0; i < 300 && !fixture.access.broker.pending().length; i++) await delay(10);
  const request = fixture.access.broker.pending()[0]; assert.ok(request);
  fs.unlinkSync(original);
  // The old canonical-only recheck cannot detect this switch: the missing
  // original path still canonicalizes to the same string.
  assert.equal(policy.canonical(original), request.target);
  fixture.access.broker.answer({ ...request, decision: 'once' }); await turn;
  const result = fixture.session.messages.filter(message => message.role === 'toolResult').at(-1);
  assert.equal(result.isError, true);
  assert.ok(JSON.stringify(result.content).includes('target changed'));
  assert.ok(!JSON.stringify(result.content).includes(secret));
});
