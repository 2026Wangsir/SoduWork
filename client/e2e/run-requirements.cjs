'use strict';
// Bounded child process with its own profile and an explicitly isolated Hub.
const fs = require('node:fs'), path = require('node:path'), {spawnSync} = require('node:child_process');
const [spec, output, hub] = process.argv.slice(2);
if (!['requirements-board', 'requirements-workspace', 'requirements-form-typography', 'requirements-navigation', 'requirements-integration', 'project-conversation', 'issue-terminology', 'requirements-acceptance-live', 'requirements-delivery-rework', 'requirements-acceptance-preflight', 'requirements-project-selection'].includes(spec) ||
    !path.isAbsolute(output || '') || (!['requirements-board','project-conversation','issue-terminology'].includes(spec) && !/^http:\/\/127\.0\.0\.1:\d+$/.test(hub || ''))) throw Error('Explicit isolated test arguments required');
const env = {...process.env};
for (const key of ['ELECTRON_RUN_AS_NODE','NODE_OPTIONS','CHROME_CRASHPAD_PIPE_NAME','CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
fs.mkdirSync(output,{recursive:true});
const result = spawnSync(require('electron'), [path.join(__dirname, spec + '.cjs'), output, ...(hub ? [hub] : [])],
  {cwd:path.join(__dirname,'..'), env, windowsHide:true, encoding:'utf8', timeout:120000});
fs.writeFileSync(path.join(output,'process.log'),(result.stdout||'')+(result.stderr||'')+(result.error?.message||''));
const reportPath = path.join(output,'report.json');
const report = fs.existsSync(reportPath) ? JSON.parse(fs.readFileSync(reportPath,'utf8')) : {ok:false,error:'No completion receipt'};
console.log(JSON.stringify(report));
process.exitCode = result.status === 0 && report.ok ? 0 : 1;
