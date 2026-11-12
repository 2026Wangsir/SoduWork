'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// Inspect metadata only. Never unlock, replace, create, or reset a user's Keychain.
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
  try { return stat(file).isFile() ? null : { code: 'KEYCHAIN_DEFAULT_MISSING' }; }
  catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return { code: 'KEYCHAIN_DEFAULT_MISSING' };
    return null;
  }
}

module.exports = { inspect };
