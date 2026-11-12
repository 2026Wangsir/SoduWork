'use strict';
// Capture runtime sources read by the account tests, independently of Git's
// representation under corporate transparent file encryption.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const repo = path.resolve(__dirname, '../../..');
const files = [
  'client/api.js', 'client/preload.js', 'client/desk.html',
  'client/core/i18n.js', 'client/core/i18n-dom.js', 'client/core/locales/manifest.json',
  ...JSON.parse(fs.readFileSync(path.join(repo, 'client/core/locales/manifest.json'), 'utf8')).map(file => 'client/core/locales/' + file),
  'client/main/device-auth.js', 'client/main/account-auth-contract.cjs',
  ...['client-auth.js', 'client-auth.css', 'account-ui.js', 'email-auth.js', 'account-verification.js', 'account-center.js', 'account-center.css', 'personal-account.css']
    .map(file => 'client/components/client-auth/' + file),
  ...['client_auth.py', 'client_email_auth.py', 'account_profile.py', 'admin.py'].map(file => 'hub-backend/app/api/' + file),
  ...['client_access.py', 'email_auth.py', 'account_security.py', 'account_privacy.py', 'account_mail.py', 'account_legal.py', 'device_connections.py'].map(file => 'hub-backend/app/services/' + file),
  'client/e2e/account-center.cjs', 'client/e2e/account-center-http.cjs',
  'client/e2e/account-password-http.cjs',
  'client/e2e/account-email-http.cjs',
  'client/e2e/fixtures/account_hub_fixture.py', 'client/e2e/fixtures/account_smtp_fixture.py',
];
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function snapshot() {
  const hashes = Object.fromEntries(files.map(file => [file, digest(fs.readFileSync(path.join(repo, file)))]));
  const api = fs.readFileSync(path.join(repo, 'client/api.js'), 'utf8').replace(/\r\n/g, '\n');
  const ranges = [
    ['    async clientLogin(credentials)', '    async patchTask('],
    ['  function rememberSession(row)', '  function handleAuthError('],
    ['  if (global.soduWorkAPI?.onAccountSessionChanged)', '  global.SoduWorkAPI ='],
  ];
  const accountSections = ranges.map(([start, end]) => {
    const first = api.indexOf(start), last = api.indexOf(end, first);
    if (first < 0 || last < 0) throw Error('Account source marker changed: ' + start);
    return api.slice(first, last);
  }).join('\n');
  return { capturedAt: new Date().toISOString(), sha256: hashes, apiAccountSectionsSha256: digest(accountSections) };
}
function changed(before, after) {
  return Object.keys(before.sha256).filter(file => before.sha256[file] !== after.sha256[file]);
}
module.exports = { snapshot, changed };
