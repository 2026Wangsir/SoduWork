'use strict';
const crypto = require('node:crypto');

// This is an isolated test cipher, not a replacement for Electron OSCrypt.
// Linux fixtures carry the native protected-format prefix so the real device
// credential boundary is exercised instead of bypassed by a plaintext mock.
function createSafeStorage(platform = process.platform) {
  const key = crypto.randomBytes(32);
  const prefix = Buffer.from(platform === 'linux' ? 'v11' : 'fixture:');
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => platform === 'linux' ? 'gnome_libsecret'
      : platform === 'darwin' ? 'keychain' : 'dpapi',
    encryptString(value) {
      const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([prefix, iv, cipher.getAuthTag(), data]);
    },
    decryptString(value) {
      if (!value.subarray(0, prefix.length).equals(prefix)) throw new Error('Invalid test ciphertext');
      const bytes = value.subarray(prefix.length);
      const cipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      cipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8');
    },
  };
}

module.exports = { createSafeStorage };
