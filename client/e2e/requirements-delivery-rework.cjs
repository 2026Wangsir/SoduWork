'use strict';

// Real native input and production requirement details use disposable accounts
// and HTTP data produced by the shared two-round capture/rejection scenario.
const {app, BrowserWindow} = require('electron');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const [output, hub] = process.argv.slice(2);
if (!path.isAbsolute(output || '') || !/^http:\/\/127\.0\.0\.1:\d+$/.test(hub || ''))
  throw Error('An isolated Hub and evidence directory are required');
fs.mkdirSync(output, {recursive:true}); app.setPath('userData', path.join(output, 'profile'));
const report = {ok:false, checks:[], boundary:'Production Electron renderer, local capture and authenticated HTTP/SQLite; deterministic file generation, no model call'};
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let win;
app.whenReady().then(async () => {
  try {
    const scenarios = await require('./task-delivery-rework.cjs')(hub, report);
    win = new BrowserWindow({show:false, width:1280, height:1000,
      webPreferences:{contextIsolation:true, sandbox:true, offscreen:true, partition:'delivery-rework'}});
    const js = async source => {
      const value = await win.webContents.executeJavaScript(`(async()=>{try{return await(0,eval)(${JSON.stringify(source)})}catch(e){return{fixtureError:e.stack}}})()`, true);
      if (value?.fixtureError) throw Error(value.fixtureError); return value;
    };
    await win.loadFile(path.join(__dirname, 'fixtures/requirements-integration.html'), {query:{hub, identity:'recipient'}});
    assert.equal(await js('fixtureReady'), 'ready');
    const click = async selector => {
      const point = await js(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n||n.disabled)throw Error('Unavailable control');n.scrollIntoView({block:'center',behavior:'instant'});const r=n.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
      for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({type, ...point, button:'left', clickCount:1});
      await wait(100);
    };
    for (const scenario of scenarios) {
      await js(`RequirementsDetail.open(${JSON.stringify(scenario.taskId)})`);
      const current = await js(`document.querySelector('[data-rq-material-group="output"]').textContent`);
      assert.ok(current.includes('report.html'));
      assert.equal(current.includes('report.txt'), scenario.keepOriginal === true);
      assert.equal(await js(`document.querySelectorAll('[data-rq-material-group="output"] .rq-material').length`), scenario.keepOriginal ? 2 : 1);
      assert.equal(await js(`document.querySelectorAll('[data-rq-bundle-download]').length`), 0);
      assert.ok(await js(`!!document.querySelector('.rq-material-archive')`));
      await click('.rq-material-archive>summary');
      assert.equal(await js(`document.querySelector('.rq-material-archive').open`), true);
      const history = await js(`document.querySelector('.rq-material-archive').textContent`);
      assert.ok(history.includes(scenario.sameName ? 'report.html' : 'report.txt'));
      fs.writeFileSync(path.join(output, scenario.id + '.png'), (await win.webContents.capturePage()).toPNG());
    }
    report.checks.push('Requirement details show only final HTML after conversion, both files when explicitly retained, and historical files remain accessible through native expansion');
    report.ok = true;
  } catch (error) { report.error = error.stack || String(error); }
  finally {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    win?.destroy(); app.exit(report.ok ? 0 : 1);
  }
});
