'use strict';
// Owns disposable Hub data and child processes; never contacts the daily Hub.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const net = require('node:net'), {spawn, spawnSync} = require('node:child_process');
const output = process.argv[2];
if (!path.isAbsolute(output || '')) throw Error('An absolute evidence directory is required');
const backend = path.resolve(__dirname, '../../hub-backend');
const python = process.argv[3] || path.join(backend, '.venv/Scripts/python.exe');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const specs = process.argv.slice(4);
const wanted = specs.length ? specs : ['requirements-workspace', 'requirements-integration', 'project-conversation'];
const report = {ok: false, scope: 'Isolated HTTP/SQLite and production Electron renderer; deterministic provider and native IPC boundary', suites: []};
fs.mkdirSync(output, {recursive: true});
(async () => {
  for (const spec of wanted) {
    if (!['requirements-workspace', 'requirements-integration', 'project-conversation', 'requirements-acceptance-live', 'requirements-delivery-rework', 'requirements-acceptance-preflight'].includes(spec)) throw Error('Unsupported suite');
    const dir = path.join(output, spec); fs.mkdirSync(dir, {recursive: true});
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-collab-e2e-'));
    const probe = net.createServer();
    await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
    const hub = 'http://127.0.0.1:' + port;
    let logs = '';
    const module = ['requirements-acceptance-live', 'requirements-delivery-rework', 'requirements-acceptance-preflight'].includes(spec)
      ? 'tests.acceptance_browser_server:app' : 'tests.unified_requirements_browser_server:app';
    const server = spawn(python, ['-m', 'uvicorn', module, '--host', '127.0.0.1', '--port', String(port)],
      {cwd: backend, windowsHide: true, env: {...process.env, SODUWORK_COLLAB_E2E_ROOT: temporary}, stdio: ['ignore', 'pipe', 'pipe']});
    server.on('error', error => {logs += error.stack;});
    server.stdout.on('data', data => {logs += data;}); server.stderr.on('data', data => {logs += data;});
    try {
      let ready = false;
      for (let attempt = 0; attempt < 150; attempt++) {
        try { ready = (await (await fetch(hub + '/ready')).json()).isolated === true; } catch (_) {}
        if (ready || server.exitCode !== null) break;
        await wait(100);
      }
      if (!ready) throw Error('Isolated Hub did not become ready: ' + logs);
      const result = spawnSync(process.execPath, [path.join(__dirname, 'run-requirements.cjs'), spec, dir, hub],
        {cwd: path.resolve(__dirname, '..'), windowsHide: true, timeout: 130000, encoding: 'utf8'});
      fs.writeFileSync(path.join(dir, 'launcher.log'), (result.stdout || '') + (result.stderr || '') + (result.error?.message || ''));
      const suite = JSON.parse(fs.readFileSync(path.join(dir, 'report.json'), 'utf8'));
      report.suites.push({spec, ok: result.status === 0 && suite.ok, checks: suite.checks, error: suite.error || ''});
      console.log(JSON.stringify(report.suites.at(-1)));
      if (result.status !== 0 || !suite.ok) throw Error(spec + ' failed: ' + (suite.error || result.error || result.status));
    } finally {
      server.kill();
      await Promise.race([new Promise(resolve => server.once('exit', resolve)), wait(3000)]);
      fs.writeFileSync(path.join(dir, 'hub.log'), logs.replace(/([?&]session=)[^&\s"]+/g, '$1[isolated-token-redacted]'));
    }
  }
  report.ok = true;
})().catch(error => {report.error = error.stack; process.exitCode = 1;}).finally(() => {
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ok: report.ok, error: report.error || ''}));
});
