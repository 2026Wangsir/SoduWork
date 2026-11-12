'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { inspect } = require('./macos-keychain.cjs');

const ACTION = 'soduwork-keychain:';
const COPY = {
  'zh-CN': {
    title: '系统钥匙串需要修复',
    detail: 'macOS 当前默认钥匙串不存在，无法安全保存或读取登录凭据。请在“钥匙串访问”中检查登录钥匙串和默认钥匙串设置，修复后退出并重新启动 SoduWork。',
    preserved: 'SoduWork 已保留现有凭据与本地数据，不会自动重置或删除钥匙串。',
    open: '打开钥匙串访问', quit: '退出 SoduWork',
  },
  'en-US': {
    title: 'System Keychain needs attention',
    detail: 'The default macOS Keychain is missing, so sign-in credentials cannot be stored or read securely. Check the login Keychain and default Keychain settings in Keychain Access, then quit and start SoduWork again.',
    preserved: 'Your existing credentials and local data are preserved. SoduWork will not reset or delete your Keychain.',
    open: 'Open Keychain Access', quit: 'Quit SoduWork',
  },
  'ja-JP': {
    title: 'システムのキーチェーンを確認してください',
    detail: 'macOS のデフォルトキーチェーンが見つからず、ログイン情報を安全に保存・読み込みできません。「キーチェーンアクセス」でログインキーチェーンとデフォルト設定を確認し、修復後に SoduWork を終了して再起動してください。',
    preserved: '既存の認証情報とローカルデータは保持されています。SoduWork がキーチェーンをリセット・削除することはありません。',
    open: 'キーチェーンアクセスを開く', quit: 'SoduWork を終了',
  },
  'ko-KR': {
    title: '시스템 키체인을 확인해 주세요',
    detail: 'macOS 기본 키체인이 없어 로그인 정보를 안전하게 저장하거나 읽을 수 없습니다. 키체인 접근에서 로그인 키체인과 기본 키체인 설정을 확인하고 복구한 후 SoduWork를 종료하고 다시 실행하세요.',
    preserved: '기존 인증 정보와 로컬 데이터는 보존됩니다. SoduWork는 키체인을 자동으로 재설정하거나 삭제하지 않습니다.',
    open: '키체인 접근 열기', quit: 'SoduWork 종료',
  },
};

function page(locale) {
  const text = COPY[locale] || COPY['en-US'];
  return '<!doctype html><html lang="' + locale + '"><head><meta charset="utf-8">' +
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'">' +
    '<title>SoduWork</title><style>body{margin:0;background:#f3f6fb;color:#182236;font:16px/1.6 -apple-system,BlinkMacSystemFont,sans-serif}' +
    'main{max-width:560px;margin:52px auto;padding:0 32px}h1{font-size:25px;line-height:1.3}p{margin:20px 0}' +
    '.note{color:#526075;font-size:14px}nav{display:flex;gap:12px;flex-wrap:wrap;margin-top:28px}' +
    'a{color:#fff;background:#1769dc;padding:9px 18px;border-radius:8px;text-decoration:none}a:last-child{color:#182236;background:#e3e9f2}' +
    'a:focus-visible{outline:3px solid #75a9f5;outline-offset:3px}</style></head><body><main>' +
    '<h1>' + text.title + '</h1><p>' + text.detail + '</p><p class="note">' + text.preserved + '</p><nav>' +
    '<a role="button" href="' + ACTION + 'open">' + text.open + '</a>' +
    '<a role="button" href="' + ACTION + 'quit">' + text.quit + '</a></nav></main></body></html>';
}

function dispatch({ app, BrowserWindow, shell, nativeImage, platform = process.platform,
  probe = inspect, root = path.join(__dirname, '..'), warn = console.warn }) {
  if (platform !== 'darwin' || app.commandLine.hasSwitch('use-mock-keychain') || !probe()) return false;
  // This branch runs before normal services or a persistent Chromium session
  // are created. A missing Keychain must not strand the workspace on a blank page.
  app.setName('SoduWork');
  let win;
  app.on('window-all-closed', () => app.quit());
  app.on('activate', () => { if (win && !win.isDestroyed()) { win.show(); win.focus(); } });
  app.whenReady().then(async () => {
    const rawLocale = String(app.getLocale() || 'en').toLowerCase();
    const locale = rawLocale.startsWith('zh') ? 'zh-CN' : rawLocale.startsWith('ja') ? 'ja-JP' :
      rawLocale.startsWith('ko') ? 'ko-KR' : 'en-US';
    const icon = path.join(root, 'icon.png');
    try { if (fs.existsSync(icon)) app.dock?.setIcon(nativeImage.createFromPath(icon)); }
    catch (_) { /* Recovery remains usable even if Dock artwork is unavailable. */ }
    win = new BrowserWindow({ width: 700, height: 430, minWidth: 550, minHeight: 380,
      title: 'SoduWork', backgroundColor: '#f3f6fb', show: false, autoHideMenuBar: true,
      webPreferences: { partition: 'soduwork-keychain-recovery', sandbox: true,
        contextIsolation: true, nodeIntegration: false, devTools: false } });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event, url) => {
      event.preventDefault();
      if (url === ACTION + 'quit') app.quit();
      if (url === ACTION + 'open') {
        const locations = ['/System/Library/CoreServices/Applications/Keychain Access.app',
          '/System/Applications/Utilities/Keychain Access.app'];
        const target = locations.find(file => fs.existsSync(file));
        if (target) void shell.openPath(target).catch(() => {});
      }
    });
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(page(locale)));
    win.show();
  }).catch(() => {
    warn('[startup] Keychain recovery could not be displayed');
    app.quit();
  });
  return true;
}

module.exports = { dispatch, page };
