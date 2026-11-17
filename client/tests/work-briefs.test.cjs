const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

test('work briefs stay registered while team, AI Team and briefs menus are temporarily hidden', () => {
  const shell = read('components', 'workspace', 'workspace-shell.js');
  const boot = read('desk-boot.js');
  const html = read('desk.html');
  const specs = read('main', 'window-specs.js');
  const bridge = read('core', 'win-bridge.js');
  assert.match(shell, /briefs: \['简报'/);
  assert.match(shell, /\['协作', \['history'\], 'collaboration'\]/);
  assert.doesNotMatch(shell, /\['我的工作', \['briefs', 'memory', 'team'\]\]/);
  assert.match(shell, /const RAIL_MORE_ITEMS = \[/);
  const navigation = [...shell.matchAll(/const (?:HOME_GROUPS|SETTINGS_GROUPS|RAIL_ITEMS|RAIL_MORE_ITEMS) = \[([\s\S]*?)\n  \];/g)];
  assert.equal(navigation.length, 4);
  for (const [, entries] of navigation) assert.doesNotMatch(entries, /'(?:briefs|team|aidesk)'/);
  assert.match(shell, /\['memory', '记忆', 'memory'\]/);
  assert.doesNotMatch(shell, /'approvals', 'history', 'team', 'aidesk', 'briefs'/);
  assert.match(boot, /briefs: 'briefPanel'/);
  assert.match(boot, /briefs: 'closeBriefsPanel'/);
  assert.match(boot, /OPENERS\.daily = \(p\) => OPENERS\.briefs/);
  assert.match(html, /work-briefs\.css/);
  assert.match(html, /work-briefs\.js/);
  assert.doesNotMatch(html, /data-tab="5">日报/);
  assert.match(specs, /briefs:\s+role\('workspace'/);
  assert.match(bridge, /openBriefsEntry/);
  assert.match(bridge, /e === 'daily'[\s\S]*openBriefsEntry/);
});

test('brief screen exposes period and scope without fictional data', () => {
  const source = read('components', 'reports', 'work-briefs.js');
  assert.match(source, /data-period="daily"/);
  assert.match(source, /data-period="weekly"/);
  assert.match(source, /data-scope="mine"/);
  assert.match(source, /data-scope="team"/);
  assert.match(source, /!data\.capability\.canManage/);
  assert.match(source, /来源变化后，确认会自动失效/);
  assert.doesNotMatch(source, /SAMPLE_|示例员工|张三|李四/);
});

test('brief typography keeps a readable selectable floor', () => {
  const css = read('components', 'reports', 'work-briefs.css');
  assert.match(css, /\.br-narrative pre\{[^}]*14\.5px\/1\.82/);
  assert.match(css, /user-select:text/);
  assert.match(css, /prefers-reduced-motion:reduce/);
  const declarations = [...css.matchAll(/font(?:-size)?:([^;}]+)/g)].map(([, value]) => value.trim());
  assert.ok(declarations.length > 20, 'covers both font-size and font shorthand declarations');
  for (const value of declarations) {
    const hasLowPx = [...value.matchAll(/(?:^|[,(]\s*)(\d*\.?\d+)px/g)]
      .some(([, size]) => Number(size) < 14.5);
    if (hasLowPx) assert.match(value, /max\(var\(--font-min-readable/);
  }
});
