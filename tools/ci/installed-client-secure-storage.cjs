'use strict';

// Serialized into the installed Electron main process; keep this function
// self-contained. The marker is synthetic, and only its hash enters receipts.
function secureStorageProbe(profile, mode) {
  const fs = process.mainModule.require('node:fs');
  const path = process.mainModule.require('node:path');
  const crypto = process.mainModule.require('node:crypto');
  const { safeStorage } = process.mainModule.require('electron');
  if (!path.isAbsolute(profile) || !path.basename(profile).startsWith('soduwork-acceptance-profile-'))
    throw Error('Secure-storage probe requires an isolated acceptance profile');
  if (!['write', 'read'].includes(mode)) throw Error('Invalid secure-storage marker mode');
  const directory = fs.lstatSync(profile);
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw Error('Unsafe secure-storage acceptance profile');
  if (!safeStorage.isEncryptionAvailable()) throw Error('Electron safeStorage is unavailable');
  const backend = process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : null;
  if (process.platform === 'linux' && !['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'].includes(backend))
    throw Error('Linux acceptance requires a real system credential store');
  const requireStrongCipher = value => {
    // Linux v10 uses Chromium's fixed fallback key, even if today's backend is secure.
    if (process.platform === 'linux' && value.subarray(0, 3).toString('ascii') !== 'v11')
      throw Error('Linux acceptance requires system-key encrypted v11 ciphertext');
  };
  const file = path.join(profile, 'acceptance-secure-storage.bin');
  const marker = 'soduwork-keychain-smoke-v1';
  if (mode === 'write') {
    // Never replace earlier ciphertext: a fresh key must not hide data loss.
    const cipher = safeStorage.encryptString(marker);
    requireStrongCipher(cipher);
    fs.writeFileSync(file, cipher, { flag: 'wx', mode: 0o600 });
  }
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0 || stat.size > 65536)
    throw Error('Invalid secure-storage acceptance ciphertext');
  const cipher = fs.readFileSync(file);
  requireStrongCipher(cipher);
  if (safeStorage.decryptString(cipher) !== marker)
    throw Error('Electron safeStorage did not preserve the earlier ciphertext');
  return { available: true, backend, roundTrip: true, persisted: true, mode,
    ciphertextSha256: crypto.createHash('sha256').update(cipher).digest('hex') };
}

module.exports = { secureStorageProbe };
