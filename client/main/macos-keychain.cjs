'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// Inspect metadata and read access only. Never unlock, replace, create, or reset
// a user's Keychain. The second security call deliberately asks for a sentinel
// item that does not exist; a normal "item not found" result proves that the
// default keychain can be read without creating or changing any item.
function inspect({ run = execFileSync, stat = fs.statSync } = {}) {
  let output;
  try {
    output = run('/usr/bin/security', ['default-keychain', '-d', 'user'], {
      encoding: 'utf8', timeout: 2000, maxBuffer: 16384, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    // errSecNoDefaultKeychain is -25307 (shell exit status 37). Other failures
    // cannot establish that storage is missing and must not block startup.
    const detail = String(error?.stderr || '');
    if (error?.status === 37 || /default keychain could not be found|no default keychain/i.test(detail))
      return { code: 'KEYCHAIN_DEFAULT_MISSING' };
    return null;
  }
  const value = String(output || '').trim();
  if (!value) return { code: 'KEYCHAIN_DEFAULT_MISSING' };
  const file = value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
  if (!path.isAbsolute(file) || /[\r\n\0]/.test(file)) return null;
  try { if (!stat(file).isFile()) return { code: 'KEYCHAIN_DEFAULT_MISSING' }; }
  catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return { code: 'KEYCHAIN_DEFAULT_MISSING' };
    if (error?.code === 'EACCES' || error?.code === 'EPERM') return { code: 'KEYCHAIN_ACCESS_UNAVAILABLE' };
    return null;
  }
  try {
    run('/usr/bin/security', ['find-generic-password', '-a', 'soduwork-preflight',
      '-s', 'soduwork-preflight', file], {
      encoding: 'utf8', timeout: 2000, maxBuffer: 16384, stdio: ['ignore', 'pipe', 'pipe'],
    });
    return null;
  } catch (error) {
    // errSecItemNotFound (status 44) is the expected result and proves the
    // keychain was reachable. Check the status rather than localized stderr:
    // security translates this message using the user's macOS language.
    // Locked, denied, malformed, or other native failures must enter SoduWork's
    // recovery page before Electron safeStorage is touched.
    if (error?.status === 44)
      return null;
    return { code: 'KEYCHAIN_ACCESS_UNAVAILABLE' };
  }
}

module.exports = { inspect };
