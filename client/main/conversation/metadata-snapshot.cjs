'use strict';

// Authorization caches must observe bytes, not just file timestamps: Windows
// can report identical timestamps for consecutive, same-sized overwrites.
const fs = require('node:fs'), crypto = require('node:crypto');
const { assertNoLinks } = require('../plugin-resources');
const MAX_BYTES = 2 * 1024 * 1024;
const identity = stat => [stat.dev, stat.ino, stat.size].join(':');
const stamp = stat => [identity(stat), stat.mtimeNs, stat.ctimeNs].join(':');

function read(root, file, { maxBytes = MAX_BYTES, prefix = false, maxFileBytes = maxBytes } = {}) {
  assertNoLinks(root, file);
  const before = fs.lstatSync(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(maxFileBytes))
    throw Error('Invalid conversation metadata');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isFile() || identity(opened) !== identity(before)) throw Error('Conversation metadata changed');
    const capacity = prefix ? Math.min(maxBytes, Number(opened.size)) : Number(opened.size) + 1;
    const buffer = Buffer.alloc(capacity); let size = 0;
    while (size < capacity) {
      const count = fs.readSync(fd, buffer, size, Math.min(64 * 1024, capacity - size), size);
      if (!count) break;
      size += count;
    }
    assertNoLinks(root, file);
    const after = fs.lstatSync(file, { bigint: true }), closed = fs.fstatSync(fd, { bigint: true });
    const expected = prefix ? capacity : Number(opened.size);
    if (size !== expected || !after.isFile() || after.isSymbolicLink() ||
        identity(after) !== identity(opened) || stamp(closed) !== stamp(opened))
      throw Error('Conversation metadata changed');
    const bytes = buffer.subarray(0, size);
    return { bytes, stat: after, revision: crypto.createHash('sha256').update(bytes).digest('hex') };
  } finally { fs.closeSync(fd); }
}
function digest(root, file) {
  assertNoLinks(root, file);
  const before = fs.lstatSync(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) throw Error('Invalid conversation metadata');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isFile() || identity(opened) !== identity(before)) throw Error('Conversation metadata changed');
    const hash = crypto.createHash('sha256'), buffer = Buffer.alloc(64 * 1024);
    const limit = Number(opened.size) + 1; let size = 0;
    while (size < limit) {
      const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, limit - size), size);
      if (!count) break;
      hash.update(buffer.subarray(0, count)); size += count;
    }
    assertNoLinks(root, file);
    const after = fs.lstatSync(file, { bigint: true }), closed = fs.fstatSync(fd, { bigint: true });
    if (size !== Number(opened.size) || !after.isFile() || after.isSymbolicLink() ||
        identity(after) !== identity(opened) || stamp(closed) !== stamp(opened))
      throw Error('Conversation metadata changed');
    return { stat: after, revision: hash.digest('hex') };
  } finally { fs.closeSync(fd); }
}
module.exports = { read, digest, MAX_BYTES };
