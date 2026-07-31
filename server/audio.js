'use strict';
// All audio processing runs through ffmpeg (static build with librubberband) for
// pristine quality. Every stored file keeps two encodings:
//   master — lossless FLAC, the processing source (never re-encoded from lossy)
//   play   — AAC .m4a, decodable by every browser's decodeAudioData (incl. Safari)

const { execFile } = require('child_process');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const FFMPEG = process.env.FFMPEG_PATH || require('ffmpeg-static');
const SR = 48000;

function tmp(ext) {
  return path.join(os.tmpdir(), 'humlab-' + crypto.randomBytes(8).toString('hex') + ext);
}

function run(args, { timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(FFMPEG, ['-hide_banner', '-y', ...args], { timeout, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => err ? reject(new Error('ffmpeg failed: ' + (stderr || err.message).slice(-2000))) : resolve({ stdout, stderr }));
  });
}

async function withTempFiles(fn) {
  const files = [];
  const mk = async (ext, content) => {
    const p = tmp(ext);
    files.push(p);
    if (content) await fs.writeFile(p, content);
    return p;
  };
  try { return await fn(mk); }
  finally { await Promise.all(files.map(f => fs.unlink(f).catch(() => {}))); }
}

// Decode anything to mono float32 PCM at 48k (for analysis + peaks + duration).
async function decodePcm(inputBuf, inputExt = '.bin') {
  return withTempFiles(async mk => {
    const inp = await mk(inputExt, inputBuf);
    const out = await mk('.f32');
    await run(['-i', inp, '-ac', '1', '-ar', String(SR), '-f', 'f32le', out]);
    const raw = await fs.readFile(out);
    return new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 4));
  });
}

function peaksFromPcm(pcm, buckets = 1000) {
  const out = [];
  const per = Math.max(1, Math.floor(pcm.length / buckets));
  for (let b = 0; b < buckets; b++) {
    let mn = 0, mx = 0;
    const s = b * per, e = Math.min(pcm.length, s + per);
    if (s >= pcm.length) { out.push([0, 0]); continue; }
    for (let i = s; i < e; i++) { const v = pcm[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
    out.push([Math.round(mn * 1000) / 1000, Math.round(mx * 1000) / 1000]);
  }
  return out;
}

// Ingest an uploaded/rendered audio buffer -> { master, play, duration, peaks, pcm }
async function ingest(inputBuf, ext = '.webm') {
  const pcm = await decodePcm(inputBuf, ext);
  const duration = pcm.length / SR;
  const peaks = peaksFromPcm(pcm);
  const { master, play } = await withTempFiles(async mk => {
    const inp = await mk(ext, inputBuf);
    const mst = await mk('.flac');
    const ply = await mk('.m4a');
    await run(['-i', inp, '-vn', '-ac', '1', '-ar', String(SR), '-c:a', 'flac', mst]);
    await run(['-i', inp, '-vn', '-ac', '1', '-ar', String(SR), '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', ply]);
    return { master: await fs.readFile(mst), play: await fs.readFile(ply) };
  });
  return { master, play, duration, peaks, pcm };
}

// Re-derive play copy + peaks from a processed master.
async function finalizeMaster(masterPath, mk) {
  const ply = await mk('.m4a');
  await run(['-i', masterPath, '-vn', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', ply]);
  const master = await fs.readFile(masterPath);
  const pcm = await decodePcm(master, '.flac');
  return { master, play: await fs.readFile(ply), duration: pcm.length / SR, peaks: peaksFromPcm(pcm), pcm };
}

// Time-stretch and/or pitch-shift with rubberband.
// stretch: output_duration / input_duration (2 = twice as long). pitchCents: +1200 = up an octave.
async function rubberband(masterBuf, { stretch = 1, pitchCents = 0 } = {}) {
  return withTempFiles(async mk => {
    const inp = await mk('.flac', masterBuf);
    const out = await mk('.flac');
    const tempo = 1 / stretch; // rubberband tempo >1 = faster/shorter
    const pitch = Math.pow(2, pitchCents / 1200);
    await run(['-i', inp, '-filter:a',
      `rubberband=tempo=${tempo.toFixed(6)}:pitch=${pitch.toFixed(6)}:transients=mixed:pitchq=quality`,
      '-c:a', 'flac', out]);
    return finalizeMaster(out, mk);
  });
}

// Trim [startSec, endSec) of a master.
async function trim(masterBuf, startSec, endSec) {
  return withTempFiles(async mk => {
    const inp = await mk('.flac', masterBuf);
    const out = await mk('.flac');
    await run(['-i', inp, '-filter:a',
      `atrim=start=${startSec.toFixed(4)}:end=${endSec.toFixed(4)},asetpts=PTS-STARTPTS`,
      '-c:a', 'flac', out]);
    return finalizeMaster(out, mk);
  });
}

async function gainFade(masterBuf, { gain = 1, fadeIn = 0, fadeOut = 0, normalize = false, reverse = false } = {}) {
  return withTempFiles(async mk => {
    const inp = await mk('.flac', masterBuf);
    const out = await mk('.flac');
    const pcm = await decodePcm(masterBuf, '.flac');
    const dur = pcm.length / SR;
    const filters = [];
    if (reverse) filters.push('areverse');
    if (normalize) {
      let peak = 0; for (let i = 0; i < pcm.length; i++) { const a = Math.abs(pcm[i]); if (a > peak) peak = a; }
      if (peak > 0.0001) filters.push(`volume=${(0.97 / peak).toFixed(4)}`);
    }
    if (gain !== 1) filters.push(`volume=${gain.toFixed(4)}`);
    if (fadeIn > 0) filters.push(`afade=t=in:st=0:d=${fadeIn.toFixed(3)}`);
    if (fadeOut > 0) filters.push(`afade=t=out:st=${Math.max(0, dur - fadeOut).toFixed(3)}:d=${fadeOut.toFixed(3)}`);
    if (!filters.length) filters.push('anull');
    await run(['-i', inp, '-filter:a', filters.join(','), '-c:a', 'flac', out]);
    return finalizeMaster(out, mk);
  });
}

// Mix items (master buffers) at offsets (seconds, >=0) with per-item gain into one master.
// totalDur (sec) optionally pads/limits the output length.
async function mixdown(items, { totalDur = null } = {}) {
  if (!items.length) throw new Error('nothing to mix');
  return withTempFiles(async mk => {
    const args = [];
    const chains = [];
    for (let i = 0; i < items.length; i++) {
      const p = await mk('.flac', items[i].master);
      args.push('-i', p);
      const delayMs = Math.max(0, Math.round((items[i].offsetSec || 0) * 1000));
      const g = items[i].gain == null ? 1 : items[i].gain;
      chains.push(`[${i}:a]volume=${g.toFixed(4)},adelay=${delayMs}:all=1[a${i}]`);
    }
    const inputs = items.map((_, i) => `[a${i}]`).join('');
    let graph = `${chains.join(';')};${inputs}amix=inputs=${items.length}:normalize=0:dropout_transition=0[mix]`;
    let mapLabel = '[mix]';
    if (totalDur != null) {
      graph += `;[mix]apad,atrim=end=${totalDur.toFixed(4)}[fin]`;
      mapLabel = '[fin]';
    }
    const out = await mk('.flac');
    await run([...args, '-filter_complex', graph, '-map', mapLabel, '-c:a', 'flac', out]);
    return finalizeMaster(out, mk);
  });
}

// Export a master as 16-bit WAV (for downloads).
async function toWav(masterBuf) {
  return withTempFiles(async mk => {
    const inp = await mk('.flac', masterBuf);
    const out = await mk('.wav');
    await run(['-i', inp, '-c:a', 'pcm_s16le', out]);
    return fs.readFile(out);
  });
}

// Note-correction render: move/stretch/retune each hummed note into its quantized slot.
// segments: [{srcStart, srcEnd, dstStart, dstLen, cents}] seconds; crossfaded via short fades.
async function renderCorrected(masterBuf, segments, totalDur) {
  const parts = [];
  for (const seg of segments) {
    const srcLen = Math.max(0.03, seg.srcEnd - seg.srcStart);
    const cut = await trim(masterBuf, seg.srcStart, seg.srcEnd);
    const stretch = Math.max(0.25, Math.min(4, seg.dstLen / srcLen));
    const shifted = (Math.abs(seg.cents) > 1 || Math.abs(stretch - 1) > 0.005)
      ? await rubberband(cut.master, { stretch, pitchCents: seg.cents })
      : cut;
    const faded = await gainFade(shifted.master, { fadeIn: 0.008, fadeOut: 0.012 });
    parts.push({ master: faded.master, offsetSec: seg.dstStart, gain: 1 });
  }
  return mixdown(parts, { totalDur });
}

module.exports = { SR, ingest, decodePcm, peaksFromPcm, rubberband, trim, gainFade, mixdown, toWav, renderCorrected };
