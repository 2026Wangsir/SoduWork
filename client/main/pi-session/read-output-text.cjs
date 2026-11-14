'use strict';

const fs = require('node:fs');
const { StringDecoder } = require('node:string_decoder');

const CAP = 2 * 1024 * 1024;
const PREVIEW_CHARS = 20000;
// UTF-8 needs at most four bytes per JavaScript code unit.
const PREVIEW_BYTES = PREVIEW_CHARS * 4;

async function readOutputText(target, open = fs.promises.open) {
  const file = await open(target, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0));
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error('Only regular files can be previewed');
    const tooBig = stat.size > CAP;
    const limit = tooBig ? PREVIEW_BYTES : Math.min(stat.size, CAP);
    const buffer = Buffer.alloc(limit);
    let offset = 0;
    while (offset < limit) {
      const { bytesRead } = await file.read(buffer, offset, limit - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const decoder = new StringDecoder('utf8');
    let text = decoder.write(buffer.subarray(0, offset));
    if (!tooBig || offset < limit) text += decoder.end();
    text = text.slice(0, PREVIEW_CHARS);
    if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
    return { ok: true, ...(tooBig ? { tooBig: true } : {}), size: stat.size, text };
  } finally {
    await file.close();
  }
}

module.exports = { readOutputText };
