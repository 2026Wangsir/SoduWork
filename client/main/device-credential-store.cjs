'use strict';

// Only device credentials: no renderer access and no additional persistent key store.
function create({ safeStorage, app, platform = process.platform }) {
  const cache = new Map();
  let blocked = false;
  const message = platform === 'linux'
    ? '无法访问 Linux 系统密钥环。请在当前桌面会话中解锁密码管理器，然后完全退出并重新打开 SoduWork；原设备凭据已保留，请勿删除或重置密钥环'
    : '无法访问系统安全存储中的设备凭据。请解锁 macOS 登录钥匙串，完全退出并重新打开 SoduWork 后允许访问；原设备凭据已保留。若仍失败，请联系支持人员检查，勿删除钥匙串项目';
  function accessError() {
    return Object.assign(new Error(message), { code: 'DEVICE_KEYCHAIN_UNAVAILABLE' });
  }
  function block() {
    blocked = true;
    cache.clear();
    return accessError();
  }
  function available() {
    if (blocked) return false;
    // Early module installation is not an OS permission failure.
    if (app?.isReady && !app.isReady()) return false;
    let ready = false;
    try {
      ready = !!safeStorage?.isEncryptionAvailable();
      if (ready && platform === 'linux') {
        const backend = safeStorage.getSelectedStorageBackend();
        ready = ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'].includes(backend);
      }
    } catch (_) { ready = false; }
    // The synchronous macOS backend may retain a failed key lookup until process
    // exit. Background identity checks must not keep requesting OS authorization.
    if (!ready && platform === 'darwin') block();
    return ready;
  }
  function decrypt(file, row) {
    if (blocked) throw accessError();
    if (!row?.cipher) {
      if (platform === 'darwin') throw block();
      if (platform === 'linux') throw accessError();
      return '';
    }
    if (platform === 'linux') {
      // Linux's synchronous v10 format uses a public, fixed password even
      // when the current process has since acquired a real keyring. Never
      // treat those old bytes as a protected identity during passive startup.
      if (typeof row.cipher !== 'string' ||
          Object.hasOwn(row, 'storage') && row.storage !== 'electron-safe-storage') throw accessError();
      const bytes = Buffer.from(row.cipher, 'base64');
      if (!bytes.subarray(0, 3).equals(Buffer.from('v11'))) throw accessError();
    }
    const previous = cache.get(file);
    if (previous && previous.hub === row.hub && previous.clientId === row.clientId &&
        previous.cipher === row.cipher) return previous.secret;
    cache.delete(file);
    if (!available()) {
      if (platform === 'darwin' || platform === 'linux') throw accessError();
      return '';
    }
    try {
      const secret = safeStorage.decryptString(Buffer.from(row.cipher, 'base64'));
      if (!secret) throw new Error('Empty device credential');
      cache.set(file, { hub: row.hub, clientId: row.clientId, cipher: row.cipher, secret });
      return secret;
    } catch (_) {
      // Electron's synchronous error does not distinguish denied/locked Keychain
      // from damaged ciphertext. Never infer permission to replace an identity.
      if (platform === 'darwin') throw block();
      if (platform === 'linux') throw accessError();
      return '';
    }
  }
  function encrypt(secret) {
    if (blocked) throw accessError();
    if (platform === 'linux' && !available()) throw accessError();
    try {
      const cipher = safeStorage.encryptString(secret);
      if (platform === 'linux' && (!Buffer.isBuffer(cipher) ||
          !cipher.subarray(0, 3).equals(Buffer.from('v11')) ||
          safeStorage.decryptString(cipher) !== secret)) throw accessError();
      return cipher;
    }
    catch (error) {
      if (platform === 'darwin') throw block();
      if (platform === 'linux') throw accessError();
      throw error;
    }
  }
  function legacySecret(row) {
    // Return weak credentials only to the explicit-login migration path.
    // Native v10 is decrypted by Electron, never decoded as plaintext here.
    if (platform !== 'linux' || !row || typeof row.cipher !== 'string') return '';
    if (Object.hasOwn(row, 'storage') && row.storage !== 'electron-safe-storage') return '';
    const bytes = Buffer.from(row.cipher, 'base64');
    if (bytes.toString('base64') !== row.cipher) return '';
    if (bytes.subarray(0, 3).equals(Buffer.from('v10'))) {
      if (!available()) throw accessError();
      try {
        const secret = safeStorage.decryptString(bytes);
        if (typeof secret !== 'string' || secret.length < 32 || secret.length > 256 || secret !== secret.trim())
          throw accessError();
        return secret;
      } catch (_) { throw accessError(); }
    }
    // The emergency patch used an unversioned, canonical 32-byte random key.
    // Marked records and every other native ciphertext remain ineligible.
    if (Object.hasOwn(row, 'storage')) return '';
    const secret = bytes.toString('utf8');
    if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) return '';
    const decoded = Buffer.from(secret, 'base64url');
    return decoded.length === 32 && decoded.toString('base64url') === secret ? secret : '';
  }
  return { available, decrypt, encrypt, legacySecret, platform,
    error: () => blocked || platform === 'linux' && !available() ? accessError() : null };
}

module.exports = { create };
