'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Windows shell properties require a real file, not a path inside app.asar.
// Content-addressed icons avoid stale shell caches without resetting other apps' icons.
function create({ app, profile, launchPath, shell, root = path.join(__dirname, '..'),
  platform = process.platform, executable = process.execPath, warn = console.warn }) {
  let cachedIcon;
  function icon() {
    if (cachedIcon) return cachedIcon;
    const ico = path.join(root, 'icon.ico');
    const png = path.join(root, 'icon.png');
    if (platform !== 'win32') return fs.existsSync(png) ? png : fs.existsSync(ico) ? ico : undefined;
    try {
      const bytes = fs.readFileSync(ico);
      const digest = crypto.createHash('sha256').update(bytes).digest('hex');
      const directory = path.join(app.getPath('userData'), 'shell-icons');
      const target = path.join(directory, digest + '.ico');
      fs.mkdirSync(directory, { recursive: true });
      if (!fs.existsSync(target) || !fs.readFileSync(target).equals(bytes)) {
        const temporary = target + '.' + crypto.randomUUID() + '.tmp';
        try { fs.writeFileSync(temporary, bytes); fs.renameSync(temporary, target); }
        finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
      }
      cachedIcon = target;
      return target;
    } catch (error) {
      warn('[shell] native icon:', error.message);
      return fs.existsSync(ico) ? ico : fs.existsSync(png) ? png : undefined;
    }
  }
  function repairPins() {
    if (platform !== 'win32' || !app.isPackaged || !shell || !cachedIcon) return;
    const directory = path.join(app.getPath('appData'), 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar');
    const normalized = value => path.resolve(value).toLowerCase();
    const launcher = launchPath();
    const names = new Set([path.basename(executable).toLowerCase(), path.basename(launcher).toLowerCase()]);
    let files;
    try { files = fs.readdirSync(directory); }
    catch (error) { if (error.code !== 'ENOENT') warn('[shell] pinned icons:', error.message); return; }
    for (const name of files.filter(name => /\.lnk$/i.test(name))) {
      try {
        const shortcut = path.join(directory, name);
        const details = shell.readShortcutLink(shortcut);
        // An app ID or display name alone is insufficient to claim another installation's pin.
        if (!details.target || !names.has(path.basename(details.target).toLowerCase()) ||
            normalized(launchPath(details.target)) !== normalized(launcher)) continue;
        if (details.icon === cachedIcon && details.iconIndex === 0 && details.appUserModelId === profile.appId) continue;
        if (!shell.writeShortcutLink(shortcut, 'update', { icon: cachedIcon, iconIndex: 0, appUserModelId: profile.appId })) {
          warn('[shell] pinned icon update failed:', name);
        }
      } catch (error) { warn('[shell] pinned icon:', error.message); }
    }
  }
  function install() {
    if (platform === 'darwin') {
      app.whenReady().then(() => {
        const file = icon();
        if (file) app.dock?.setIcon(file);
      }).catch(error => warn('[shell] Dock icon setup:', error.message));
      return;
    }
    if (platform !== 'win32') return;
    const development = !app.isPackaged;
    const suffix = crypto.createHash('sha256').update(path.resolve(app.getPath('userData')).toLowerCase()).digest('hex').slice(0, 20);
    const appId = profile.appId + (development ? '.dev.' + suffix : '');
    // Set the process identity before any BrowserWindow can acquire a taskbar group.
    app.setAppUserModelId(appId);
    app.whenReady().then(() => { icon(); repairPins(); }).catch(error => warn('[shell] icon setup:', error.message));
    app.on('browser-window-created', (_event, win) => {
      try {
        const file = icon();
        if (file) win.setIcon(file);
        const launcher = development ? executable : launchPath();
        const shellIcon = cachedIcon || launcher;
        // Set relaunch properties before the window ID triggers a taskbar refresh.
        win.setAppDetails({ appIconPath: shellIcon, appIconIndex: 0,
          relaunchCommand: '"' + launcher + '"' + (development ? ' "' + app.getAppPath() + '"' : ''),
          relaunchDisplayName: profile.productName + (development ? ' (Dev)' : '') });
        win.setAppDetails({ appId });
      } catch (error) { warn('[shell] taskbar identity:', error.message); }
    });
  }
  return { icon, install, repairPins };
}
module.exports = { create };
