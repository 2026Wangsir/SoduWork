'use strict';
const fs = require('node:fs/promises'), path = require('node:path');
const prepare = require('../../scripts/prepare-installer.cjs');
const { prepareFixtureLauncher } = require('./isolated-installer-build.cjs');
const longResource = 'resources/' + Array(12).fill('中文资源abcdefghijklmnop').join('/') + '/requirements.txt';
const zipBytes = Buffer.from('UEsDBBQAAAAAAEuJKl0Ck5lQPAAAADwAAAATAAAAcnVudGltZS1maXh0dXJlLnR4dFZlcmlmeSBuYXRpdmUgWklQIGJ5dGVzLCBub3QgYSBydW5uYWJsZSBQeXRob24gZGlzdHJpYnV0aW9uLlBLAQIUABQAAAAAAEuJKl0Ck5lQPAAAADwAAAATAAAAAAAAAAAAAACAAQAAAABydW50aW1lLWZpeHR1cmUudHh0UEsFBgAAAAABAAEAQQAAAG0AAAAAAA==', 'base64');
async function fixturePrepare(context) {
  if (context.appOutDir) {
    const root = context.appOutDir;
    await fs.mkdir(path.dirname(path.join(root, longResource)), { recursive: true });
    await fs.writeFile(path.join(root, longResource), 'deep native runtime resource');
    await fs.mkdir(path.join(root, 'resources/runner/_internal'), { recursive: true });
    await fs.writeFile(path.join(root, 'resources/runner/_internal/base_library.zip'), zipBytes);
    await fs.mkdir(path.join(root, 'resources/shell/etc'), { recursive: true });
    await fs.writeFile(path.join(root, 'resources/shell/etc/package-versions.txt'), 'vendor versions');
  }
  await prepare(context);
  // The production hook compiles a SoduWork.exe launcher. Replace it after
  // that hook so the first install opens this fixture's unique executable.
  const { nsis, productName, win } = context.packager.config;
  await prepareFixtureLauncher(context.packager.projectDir, { guid: nsis.guid,
    productName, executableName: win.executableName, shortcutName: nsis.shortcutName });
}
module.exports = fixturePrepare;
module.exports.longResource = longResource;
module.exports.zipBytes = zipBytes;
