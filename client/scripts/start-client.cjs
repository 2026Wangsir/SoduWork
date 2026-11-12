'use strict';
// Portable source launcher. Never modifies profiles or stops other instances.
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const INHERITED_ELECTRON = new Set([
  'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ATTACH_CONSOLE',
  'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE',
  'NODE_USE_SYSTEM_CA', 'CHROME_DEVEL_SANDBOX',
]);
function cleanEnvironment(base) {
  return Object.fromEntries(Object.entries(base).filter(([key]) => !INHERITED_ELECTRON.has(key.toUpperCase())));
}
function command(platform = process.platform, root = ROOT) {
  const binary = platform === 'win32' ? 'electron.exe'
    : platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron';
  return path.join(root, 'node_modules', 'electron', 'dist', binary);
}
function main(args = process.argv.slice(2)) {
  let binary = command();
  if (!fs.existsSync(binary)) {
    console.error('Electron is missing. Run npm ci in client/ with Node.js 22.19+, then npm start.');
    return 1;
  }
  if (process.platform === 'darwin') {
    try { binary = require('./source-macos-app.cjs').prepareSourceApp({ root: ROOT, binary }); }
    catch (error) {
      console.error('SoduWork could not prepare its source application: ' + error.message);
      return 1;
    }
  }
  const sourceSession = process.env.SODUWORK_SOURCE_SESSION === '1';
  const child = spawn(binary, [ROOT, ...args], {
    cwd: ROOT, env: cleanEnvironment(process.env),
    stdio: sourceSession ? ['ignore', 'inherit', 'inherit'] : 'inherit', shell: false,
  });
  const stop = () => { if (child.exitCode === null && !child.killed) child.kill('SIGTERM'); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  if (sourceSession) {
    // Only the owning source launcher holds the pipe. EOF also covers a closed console.
    process.stdin.once('end', stop);
    process.stdin.resume();
  }
  child.once('error', (error) => {
    if (sourceSession) process.stdin.destroy();
    console.error('SoduWork could not start: ' + error.message);
    process.exitCode = 1;
  });
  child.once('exit', (code, signal) => {
    if (sourceSession) process.stdin.destroy();
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    process.exitCode = typeof code === 'number' ? code : signal ? 1 : 0;
  });
  return 0;
}
if (require.main === module) process.exitCode = main();
module.exports = { command, cleanEnvironment };
