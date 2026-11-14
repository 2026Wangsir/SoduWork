"use strict";
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const deflate = require('node:util').promisify(zlib.deflateRaw);

const MAX_FILES = 500;
const MAX_BYTES = 24 * 1024 * 1024;
const SKIP = new Set([".git", "node_modules", ".venv", "__pycache__", ".soduwork"]);
const SKIP_FILE = /(?:^|[\\/])(?:\.DS_Store|Thumbs\.db|~\$)/i;

const CRC = Uint32Array.from({ length: 256 }, (_, n) => { for (let i = 0; i < 8; i++) n = (n >>> 1) ^ (0xedb88320 & -(n & 1)); return n >>> 0; });
function crc32(buffer) { let crc = 0xffffffff; for (const byte of buffer) crc = CRC[(crc ^ byte) & 255] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; }
function u16(n) { const b = Buffer.alloc(2); b.writeUInt16LE(n & 0xffff); return b; }
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; }
function dosDate(st) {
  const d = new Date(st.mtimeMs || Date.now());
  return { date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(), time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2) };
}
function collect(root) {
  const result = []; let total = 0;
  function walk(dir, rel, depth) {
    if (depth > 12 || result.length >= MAX_FILES) return;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (result.length >= MAX_FILES) break;
      if (!ent.name || ent.name === "." || ent.name === ".." || SKIP.has(ent.name)) continue;
      const full = path.join(dir, ent.name); const next = rel ? rel + "/" + ent.name : ent.name;
      if (SKIP_FILE.test(next)) continue;
      if (ent.isDirectory()) { walk(full, next, depth + 1); continue; }
      if (!ent.isFile()) continue;
      const st = fs.statSync(full);
      if (st.size > MAX_BYTES || total + st.size > MAX_BYTES) throw new Error("Folder is larger than 24 MB; remove dependencies or media files");
      total += st.size; result.push({ full, name: next.replace(/\\/g, "/"), st });
    }
  }
  walk(root, "", 0);
  if (!result.length) throw new Error("The selected folder has no shareable files");
  if (result.length >= MAX_FILES) throw new Error("Too many files; remove node_modules and build output first");
  return { result, total };
}
function encode(entries) {
  const local = [], central = []; let offset = 0;
  for (const item of entries) {
    const data = item.bytes, name = Buffer.from(item.name, "utf8"), compressed = item.compressed;
    const method = compressed.length < data.length ? 8 : 0;
    const payload = method ? compressed : data; const stamp = item.st ? dosDate(item.st) : { date: 33, time: 0 };
    const head = Buffer.concat([Buffer.from([0x50,0x4b,0x03,0x04]), u16(20), u16(0x800), u16(method), u16(stamp.time), u16(stamp.date), u32(crc32(data)), u32(payload.length), u32(data.length), u16(name.length), u16(0), name]);
    local.push(head, payload);
    const cd = Buffer.concat([Buffer.from([0x50,0x4b,0x01,0x02]), u16(20), u16(20), u16(0x800), u16(method), u16(stamp.time), u16(stamp.date), u32(crc32(data)), u32(payload.length), u32(data.length), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), name]);
    central.push(cd); offset += head.length + payload.length;
  }
  const directory = Buffer.concat(central); const footer = Buffer.concat([Buffer.from([0x50,0x4b,0x05,0x06]), Buffer.alloc(4), u16(entries.length), u16(entries.length), u32(directory.length), u32(offset), u16(0)]);
  return Buffer.concat([...local, directory, footer]);
}
async function createEntries(entries) {
  const prepared = [];
  for (const item of entries) prepared.push({ ...item, compressed: await deflate(item.bytes, { level: 3 }) });
  return encode(prepared);
}
function createEntriesSync(entries) {
  return encode(entries.map(item => ({ ...item, compressed: zlib.deflateRawSync(item.bytes, { level: 6 }) })));
}
function createZip(root) {
  const base = fs.realpathSync(root); const { result, total } = collect(base);
  const archive = encode(result.map(item => { const bytes = fs.readFileSync(item.full); return {
    name: item.name, bytes, st: item.st, compressed: zlib.deflateRawSync(bytes, { level: 6 }),
  }; }));
  if (archive.length > MAX_BYTES) throw new Error("ZIP archive is larger than 24 MB; remove large files");
  return { data: archive, name: path.basename(base) + ".zip", size: archive.length, files: result.length, total,
    website: result.some(file => /(?:^|\/)index\.(?:html?|xhtml)$/i.test(file.name)) };
}
// Keep the synchronous primitive for worker/test callers. Native UI handlers
// must use the bounded worker so scanning, reads, zlib and CRC stay off-thread.
function createZipAsync(root, options) { return require('./zip-archive-worker').create(root, options); }
module.exports = { createZip, createZipAsync, createEntries, createEntriesSync, collect, MAX_BYTES, MAX_FILES };
