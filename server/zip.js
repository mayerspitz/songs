'use strict';
// Minimal ZIP reader (store + deflate entries) — enough for voice-note archives.
// Returns [{name, data}] for file entries; skips directories and junk.

const zlib = require('zlib');

function findEOCD(buf) {
  // End of Central Directory signature 0x06054b50, scan back over the comment
  const min = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

function unzip(buf) {
  const eocd = findEOCD(buf);
  if (eocd < 0) throw new Error('Not a valid ZIP file');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const rawSize = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.slice(off + 46, off + 46 + nameLen).toString('utf8');
    off += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;                     // directory
    if (compSize === 0xffffffff || rawSize === 0xffffffff) continue; // zip64 — not supported
    // local header: skip its own (possibly different) name/extra lengths
    if (localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== 0x04034b50) continue;
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const comp = buf.slice(dataStart, dataStart + compSize);
    let data;
    try {
      if (method === 0) data = comp;
      else if (method === 8) data = zlib.inflateRawSync(comp);
      else continue; // unsupported compression method
    } catch { continue; }
    if (rawSize && data.length !== rawSize) continue;
    entries.push({ name, data });
  }
  return entries;
}

const AUDIO_EXT = new Set(['.ogg', '.opus', '.oga', '.mp3', '.m4a', '.aac', '.wav', '.flac', '.webm', '.amr', '.3gp', '.mp4', '.wma', '.aiff', '.aif']);

function audioEntries(buf, { maxEntries = 60, maxEntryBytes = 60 * 1024 * 1024 } = {}) {
  const out = [];
  for (const e of unzip(buf)) {
    const base = e.name.split('/').pop();
    if (!base || base.startsWith('.') || e.name.includes('__MACOSX')) continue;
    const dot = base.lastIndexOf('.');
    const ext = dot >= 0 ? base.slice(dot).toLowerCase() : '';
    if (!AUDIO_EXT.has(ext)) continue;
    if (e.data.length < 128 || e.data.length > maxEntryBytes) continue;
    out.push({ name: base.slice(0, dot >= 0 ? dot : base.length), ext, data: e.data });
    if (out.length >= maxEntries) break;
  }
  return out;
}

module.exports = { unzip, audioEntries, AUDIO_EXT };
