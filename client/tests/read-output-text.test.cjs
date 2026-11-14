'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const { readOutputText } = require('../main/pi-session/read-output-text.cjs');

test('large previews read a bounded prefix and close the file handle', async () => {
  const size = 64 * 1024 * 1024;
  let bytesRead = 0;
  let closed = false;
  const file = {
    stat: async () => ({ size, isFile: () => true }),
    read: async (buffer, offset, length) => {
      buffer.fill(0x61, offset, offset + length);
      bytesRead += length;
      return { bytesRead: length };
    },
    close: async () => { closed = true; },
  };

  const result = await readOutputText('synthetic-large-output', async () => file);

  assert.equal(result.ok, true);
  assert.equal(result.tooBig, true);
  assert.equal(result.size, size);
  assert.equal(result.text.length, 20000);
  assert.ok(bytesRead < size, `read ${bytesRead} bytes from a ${size}-byte file`);
  assert.ok(bytesRead <= 80000, `read ${bytesRead} bytes for a 20000-character preview`);
  assert.equal(closed, true);
});

test('non-regular files are opened nonblocking and rejected before reading', async () => {
  let closed = false;
  const file = {
    stat: async () => ({ size: 0, isFile: () => false }),
    read: async () => assert.fail('must reject the file before reading'),
    close: async () => { closed = true; },
  };

  await assert.rejects(readOutputText('synthetic-pipe', async (_target, flags) => {
    assert.equal(flags, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0));
    return file;
  }), /regular file/i);

  assert.equal(closed, true);
});

test('large previews do not split a multibyte character at the display limit', async () => {
  const prefix = Buffer.from('a'.repeat(19999) + '😀中文'.repeat(20000));
  const file = {
    stat: async () => ({ size: 8 * 1024 * 1024, isFile: () => true }),
    read: async (buffer, offset, length, position) => {
      const bytesRead = Math.min(length, 997, prefix.length - position);
      prefix.copy(buffer, offset, position, position + bytesRead);
      return { bytesRead };
    },
    close: async () => {},
  };

  const result = await readOutputText('synthetic-unicode-output', async () => file);

  assert.equal(result.ok, true);
  assert.equal(result.tooBig, true);
  assert.equal(result.text.length, 19999);
  assert.doesNotMatch(result.text, /[\uD800-\uDBFF]$/);
});

test('small UTF-8 files are returned intact without a truncation flag', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-output-small-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, 'small.txt');
  fs.writeFileSync(target, '你好 😀\n');

  const result = await readOutputText(target);

  assert.equal(result.ok, true);
  assert.equal(result.tooBig, undefined);
  assert.equal(result.size, Buffer.byteLength('你好 😀\n'));
  assert.equal(result.text, '你好 😀\n');
});

test('the output preview IPC never reads a large file synchronously', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-output-preview-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, 'large.txt');
  fs.writeFileSync(target, 'a'.repeat(2 * 1024 * 1024 + 1));

  const handlers = new Map();
  const handle = { cwd: root };
  const originalLoad = Module._load;
  const artifactPath = require.resolve('../main/pi-session/artifact-ipc');
  delete require.cache[artifactPath];
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return { shell: {}, nativeImage: {}, dialog: {} };
    return originalLoad.call(this, request, parent, isMain);
  };
  t.after(() => {
    Module._load = originalLoad;
    delete require.cache[artifactPath];
  });
  require(artifactPath).install({
    app: { getPath: () => root },
    ipcMain: { handle: (name, callback) => handlers.set(name, callback) },
    BrowserWindow: {},
    workDir: () => path.join(root, 'work'),
    session: { get: ref => ref === 'synthetic-session' ? handle : null },
  });

  const readFileSync = fs.readFileSync;
  fs.readFileSync = (...args) => {
    if (path.resolve(String(args[0])) === path.resolve(target)) {
      throw new Error('synchronous output read');
    }
    return readFileSync(...args);
  };
  t.after(() => { fs.readFileSync = readFileSync; });

  const result = await handlers.get('pi-session-read-output')({}, 'synthetic-session', target);

  assert.equal(result.ok, true, result.reason);
  assert.equal(result.tooBig, true);
  assert.equal(result.text.length, 20000);
});
