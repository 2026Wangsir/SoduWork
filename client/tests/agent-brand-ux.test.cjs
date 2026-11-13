const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const brand = require('../components/panels/agent-brand');
const brandAssetDir = path.join(__dirname, '../assets/agent-brands');
const brandSources = JSON.parse(fs.readFileSync(path.join(brandAssetDir, 'sources.json'), 'utf8'));
const attributes = fs.readFileSync(path.join(__dirname, '../../.gitattributes'), 'utf8');
assert.match(attributes, /^client\/assets\/agent-brands\/\*\.svg text eol=lf$/m,
  'brand artwork must retain LF bytes on Windows checkouts');

for (const [id, relative] of Object.entries(brand.ICONS)) {
  const file = relative.replace(/^assets\/agent-brands\//, '');
  const absolute = path.join(brandAssetDir, file);
  assert.ok(fs.existsSync(absolute), id + ' brand artwork is missing');
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex'), brandSources[id].sha256,
    id + ' brand artwork changed without updating its provenance record');
}

for (const raw of ['@openma/deepseek-harness-acp 0.4.40', '@openma/deepseek-harness-acp@0.4.40', 'v0.4.40', '0.4.40']) {
  const agent = { key: 'runner:local:dsh', version: raw };
  assert.equal(brand.version(agent), '0.4.40');
  assert.equal(agent.version, raw, 'display formatting must not mutate runtime metadata');
}
assert.equal(brand.version({ key: 'dsh', version: '@openma/deepseek-harness-acp 0.5.0-beta.2+build.1' }), '0.5.0-beta.2+build.1');
assert.equal(brand.version({ key: 'dsh', version: 'unknown' }), 'unknown');
assert.equal(brand.version({ key: 'pi', version: '0.84.4' }), '0.84.4');

[
  ['runner:pc-01:pi', 'pi'],
  [{ key: 'codex-harness', name: 'Codex Harness' }, 'codex-harness'],
  [{ cli: 'Claude Code', key: 'runner:pc-01:claude' }, 'claude'],
  ['OpenCode', 'opencode'],
  ['DeepSeek Harness', 'dsh'],
  ['pipeline', 'custom'],
].forEach(([value, expected]) => {
  assert.equal(brand.canonical(value), expected,
    'wrong Agent brand mapping for ' + JSON.stringify(value));
});

const codex = brand.html('codex', { className: 'test-slot' });
assert.match(codex, /agent-brand-codex/);
assert.match(codex, /aria-label="Codex"/);
assert.match(codex, /<img src="assets\/agent-brands\/codex\.svg"/);
assert.match(codex, /test-slot/);

for (const [id, mark] of Object.entries(brand.MONOGRAMS)) {
  const html = brand.html(id);
  if (brand.ICONS[id]) {
    assert.ok(html.includes('<img src="' + brand.ICONS[id] + '"'));
    assert.match(html, /alt="" aria-hidden="true" draggable="false"/);
  } else assert.ok(html.includes('>' + mark + '</span>'));
  assert.ok(html.includes('aria-label="' + brand.LABELS[id] + '"'));
}

assert.match(fs.readFileSync(path.join(__dirname, '../components/panels/agent-brand.css'), 'utf8'),
  /\.agent-brand>img\s*\{[^}]*object-fit:contain/,
  'official marks must stay contained inside the shared shell');
assert.match(fs.readFileSync(path.join(__dirname, '../components/panels/agent-brand.css'), 'utf8'),
  /data-composer-theme="dark"[^}]*background:#f7f8fb/,
  'dark chatbar keeps black official marks readable without recoloring them');

const agents = fs.readFileSync(path.join(__dirname,
  '../components/panels/panels-agents.js'), 'utf8');
const context = { AgentBrand: brand, addEventListener() {}, esc: value => String(value || '') };
context.window = context;
require('node:vm').runInNewContext(agents, context);
const deepseek = { key: 'dsh', name: 'DeepSeek Harness', installed: true, version: '@openma/deepseek-harness-acp 0.4.40' };
assert.match(context._agRowHtml(deepseek), /class="ag-ver[^"]*"[^>]*>0\.4\.40<\/span>/);
context.fixtureAgents = [deepseek];
require('node:vm').runInContext("_agData = { machines: [{ runnerId: 'local', scope: 'current-instance', agents: fixtureAgents }] }; _agOpen = 'local~dsh'", context);
assert.match(context._agDrawer(), /class="ag-ver">0\.4\.40<\/span>/);
const aidesk = fs.readFileSync(path.join(__dirname,
  '../components/panels/panels-aidesk-office.js'), 'utf8');
const aideskCss = fs.readFileSync(path.join(__dirname,
  '../components/panels/panels-aidesk-office.css'), 'utf8');

assert.match(agents, /AgentBrand\.html\(a, \{ className: 'ag-agent-brand'/,
  'Agent Management must use the shared commercial identity');
[
  'aio-agent-avatar',
  'aio-work-bot',
].forEach((slot) => {
  assert.ok(aidesk.includes("className: '" + slot + "'"),
    'AI Team is missing the shared brand in ' + slot);
  assert.ok(aideskCss.includes('.' + slot + '.agent-brand'),
    'AI Team is missing stable sizing for ' + slot);
});
assert.doesNotMatch(aidesk, /_robotSvg\(/,
  'AI Team must not fall back to decorative robot identities');

for (const htmlName of ['desk.html', 'index.html']) {
  const html = fs.readFileSync(path.join(__dirname, '..', htmlName), 'utf8');
  assert.ok(html.indexOf('components/panels/agent-brand.js') <
    html.indexOf('components/panels/panels-agents.js'),
  htmlName + ' must load the brand contract before Agent Management');
  assert.match(html, /components\/panels\/agent-brand\.css/);
}

console.log('agent brand UX: shared commercial identity passed');
