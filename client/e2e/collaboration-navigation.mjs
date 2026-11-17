import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CdpPage, listPages } from './lib/cdp.mjs';

// Run against an explicitly selected, idle test window; never choose a user's window implicitly.
const [targetId, evidence] = process.argv.slice(2);
assert.ok(targetId && evidence, 'Usage: node e2e/collaboration-navigation.mjs <targetId> <evidenceDir>');
const p = await CdpPage.connect((await listPages(9347)).find(page => page.id === targetId));
const report = { pass: false, checks: [] };
fs.mkdirSync(evidence, { recursive: true });
async function click(selector) {
  await p.waitFor(s => {
    const e = document.querySelector(s); return e && e.getBoundingClientRect().height > 0 && !e.disabled;
  }, selector, 20000);
  const point = await p.run(async s => {
    const e = document.querySelector(s); e.scrollIntoView({ block: 'center' });
    await new Promise(requestAnimationFrame);
    const r = e.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2;
    if (!e.contains(document.elementFromPoint(x, y))) throw new Error('Click target obscured: ' + s);
    return { x, y };
  }, selector);
  await p.call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
  await p.call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
}
async function screenshot(name) {
  const shot = await p.call('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(evidence, name + '.png'), Buffer.from(shot.data, 'base64'));
}
async function navigation() {
  return p.run(() => [...document.querySelectorAll('#wsNav .ws-nav-group')].map(group => ({
    label: group.querySelector('.ws-section-label')?.textContent.trim() || '',
    entries: [...group.querySelectorAll('[data-view]')].map(e => ({ key: e.dataset.view, text: e.querySelector('span').textContent.trim() })),
  })));
}
try {
  assert.equal(await p.run(() => Boolean(window.NativeChat?.isBusy())), false);
  await p.call('Page.navigate', { url: 'file:///C:/Program%20Files/code/soduwork/client/desk.html?panel=workspace&view=history' });
  await p.waitFor(() => window.SoduWorkAPI?.online && document.querySelector('#hbTitleText'), null, 30000);
  await p.call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  const expected = [
    { key: 'history', text: '需求池' },
  ];
  assert.deepEqual((await navigation()).find(group => group.label === '协作').entries, expected);
  for (const [key, title, selector] of [
    ['history', '需求池', '#hbTitleText'],
  ]) {
    await click('.ws-nav-item[data-view="' + key + '"]');
    await p.waitFor(({ key, title, selector }) => {
      const e = document.querySelector(selector);
      return document.querySelector('#workspaceShell')?.dataset.view === key && e &&
        e.getBoundingClientRect().height > 0 && e.textContent.includes(title);
    }, { key, title, selector }, 20000);
    assert.equal(await p.run(() => document.querySelector('#workspaceShell').dataset.mode), 'home');
    await screenshot(key);
    report.checks.push(key + ': one-click navigation, visible matching heading, home mode');
  }
  await click('[data-rail-menu="more"]');
  assert.equal(await p.run(() => document.querySelectorAll(
    '#wsRailMoreMenu [data-rail-view="briefs"], #wsRailMoreMenu [data-rail-view="team"], #wsRailMoreMenu [data-rail-view="aidesk"]'
  ).length), 0);
  await click('[data-rail-menu="more"]');
  await click('#wsMine');
  await p.waitFor(() => document.querySelector('#workspaceShell')?.dataset.mode === 'settings', null, 10000);
  assert.equal((await navigation()).flatMap(group => group.entries).some(entry => entry.key === 'briefs'), false);
  assert.ok((await navigation()).every(group => group.entries.length > 0));
  await screenshot('mine');
  await click('#wsBack');
  await p.waitFor(() => document.querySelector('#workspaceShell')?.dataset.view === 'history', null, 10000);
  report.checks.push('AI Team, Team and Briefs menus hidden; return home restores the requirement board');
  await p.call('Page.reload', { ignoreCache: true });
  await p.waitFor(() => window.SoduWorkAPI?.online && document.querySelector('#wsNav [data-view="history"]'), null, 30000);
  assert.deepEqual((await navigation()).find(group => group.label === '协作').entries, expected);
  report.checks.push('Reload retains the new collaboration group and order');
  report.errors = p.takeRuntimeErrors().map(value => String(value).replace(
    /([?&](?:session|token|ticket|secret|key|authorization)=)[^&\s'"<>]+/gi, '$1[redacted]'));
  assert.deepEqual(report.errors, []);
  report.pass = true;
  console.log(JSON.stringify(report));
} catch (error) {
  report.error = String(error.message); await screenshot('failure');
  console.error(report.error); process.exitCode = 1;
} finally {
  fs.writeFileSync(path.join(evidence, 'results.json'), JSON.stringify(report, null, 2));
  p.close();
}
