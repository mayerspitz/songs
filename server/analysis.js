'use strict';
// Signal analysis on decoded mono PCM (48k float32):
//  - Tempo Sense: BPM candidates with confidence (onset autocorrelation)
//  - f0 tracking (normalized autocorrelation) and note segmentation
//  - Note-correction candidates: grid × scale interpretations, scored by how
//    little correction they need (accurate, never wild)
//  - Match analysis: pitch/tempo offset between two takes

const SR = 48000;

// ---------- onset envelope + BPM ----------

function onsetEnvelope(pcm) {
  const hop = 512, win = 1024;
  const n = Math.max(0, Math.floor((pcm.length - win) / hop));
  const env = new Float32Array(n);
  let prev = 0;
  for (let i = 0; i < n; i++) {
    let e = 0;
    const s = i * hop;
    for (let j = 0; j < win; j++) { const v = pcm[s + j]; e += v * v; }
    e = Math.sqrt(e / win);
    const d = e - prev;
    env[i] = d > 0 ? d : 0; // half-wave rectified energy flux
    prev = e;
  }
  // light smoothing
  for (let i = 1; i < n - 1; i++) env[i] = (env[i - 1] + env[i] * 2 + env[i + 1]) / 4;
  return { env, hopSec: hop / SR };
}

function bpmDetect(pcm) {
  const { env, hopSec } = onsetEnvelope(pcm);
  const durSec = pcm.length / SR;
  if (env.length < 40 || durSec < 2.5) return { bpm: null, confidence: 0, candidates: [] };
  const mean = env.reduce((a, b) => a + b, 0) / env.length;
  const cent = Float32Array.from(env, v => v - mean);
  const minLag = Math.round((60 / 220) / hopSec);
  const maxLag = Math.min(env.length - 2, Math.round((60 / 50) / hopSec));
  if (maxLag <= minLag) return { bpm: null, confidence: 0, candidates: [] };
  let e0 = 0; for (let i = 0; i < cent.length; i++) e0 += cent[i] * cent[i];
  if (e0 < 1e-9) return { bpm: null, confidence: 0, candidates: [] };
  const ac = new Float32Array(maxLag + 1);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = 0; i + lag < cent.length; i++) s += cent[i] * cent[i + lag];
    ac[lag] = s / e0;
  }
  // peak picking
  const peaks = [];
  for (let lag = minLag + 1; lag < maxLag; lag++) {
    if (ac[lag] > ac[lag - 1] && ac[lag] >= ac[lag + 1] && ac[lag] > 0.05) {
      peaks.push({ lag, v: ac[lag] });
    }
  }
  peaks.sort((a, b) => b.v - a.v);
  const cands = [];
  for (const p of peaks.slice(0, 12)) {
    let bpm = 60 / (p.lag * hopSec);
    // fold into a comfortable 65..190 window (half/double time equivalence)
    while (bpm < 65) bpm *= 2;
    while (bpm > 190) bpm /= 2;
    const existing = cands.find(c => Math.abs(c.bpm - bpm) < 2.5);
    if (existing) existing.score += p.v;
    else cands.push({ bpm, score: p.v });
  }
  cands.sort((a, b) => b.score - a.score);
  const total = cands.reduce((a, c) => a + c.score, 0) || 1;
  const out = cands.slice(0, 5).map(c => ({ bpm: Math.round(c.bpm * 10) / 10, confidence: Math.min(0.99, c.score / total) }));
  const top = out[0] || null;
  // longer + more periodic material => higher confidence
  const lenBoost = Math.min(1, durSec / 20);
  return {
    bpm: top ? top.bpm : null,
    confidence: top ? Math.round(Math.min(0.98, top.confidence * (0.55 + 0.45 * lenBoost)) * 100) / 100 : 0,
    candidates: out,
  };
}

// Estimate beats-per-bar by accent grouping of the onset envelope at a known BPM.
function meterDetect(pcm, bpm) {
  if (!bpm) return { beatsPerBar: 4, confidence: 0 };
  const { env, hopSec } = onsetEnvelope(pcm);
  const beatHops = (60 / bpm) / hopSec;
  const nBeats = Math.floor(env.length / beatHops);
  if (nBeats < 8) return { beatsPerBar: 4, confidence: 0 };
  const strength = [];
  for (let b = 0; b < nBeats; b++) {
    const s = Math.round(b * beatHops), e = Math.min(env.length, Math.round((b + 0.3) * beatHops) + 1);
    let m = 0; for (let i = s; i < e; i++) m = Math.max(m, env[i]);
    strength.push(m);
  }
  const scores = {};
  for (const g of [2, 3, 4, 6]) {
    let best = -1;
    for (let phase = 0; phase < g; phase++) {
      let on = 0, off = 0, cOn = 0, cOff = 0;
      for (let b = 0; b < strength.length; b++) {
        if (b % g === phase) { on += strength[b]; cOn++; } else { off += strength[b]; cOff++; }
      }
      if (cOn && cOff) best = Math.max(best, (on / cOn) / ((off / cOff) + 1e-6));
    }
    scores[g] = best;
  }
  let bestG = 4, bestV = -1;
  for (const g of [4, 3, 2, 6]) if (scores[g] > bestV * 1.08) { bestV = scores[g]; bestG = g; }
  return { beatsPerBar: bestG, confidence: Math.round(Math.min(0.9, Math.max(0, (bestV - 1) / 2)) * 100) / 100 };
}

// ---------- f0 tracking ----------

function f0Track(pcm) {
  const hop = 480; // 10ms
  const win = 1200; // fits down to 80Hz (>=2 periods at 80Hz)
  const fMin = 70, fMax = 900;
  const lagMin = Math.floor(SR / fMax), lagMax = Math.ceil(SR / fMin);
  const frames = [];
  let globalRms = 0, cnt = 0;
  for (let s = 0; s + win + lagMax < pcm.length; s += hop) {
    let rms = 0;
    for (let j = 0; j < win; j++) rms += pcm[s + j] * pcm[s + j];
    rms = Math.sqrt(rms / win);
    globalRms += rms; cnt++;
    frames.push({ t: s / SR, rms, f0: 0, clarity: 0, s });
  }
  const rmsThresh = Math.max(0.004, (globalRms / Math.max(1, cnt)) * 0.35);
  for (const fr of frames) {
    if (fr.rms < rmsThresh) continue;
    const s = fr.s;
    let e0 = 0;
    for (let j = 0; j < win; j++) e0 += pcm[s + j] * pcm[s + j];
    let bestLag = 0, bestV = 0;
    for (let lag = lagMin; lag <= lagMax; lag++) {
      let ac = 0, e1 = 0;
      for (let j = 0; j < win; j++) { const b = pcm[s + j + lag]; ac += pcm[s + j] * b; e1 += b * b; }
      const v = ac / Math.sqrt((e0 + 1e-12) * (e1 + 1e-12));
      if (v > bestV) { bestV = v; bestLag = lag; }
    }
    if (bestV > 0.55 && bestLag) {
      // parabolic refinement around bestLag
      fr.f0 = SR / bestLag;
      fr.clarity = bestV;
    }
  }
  // median filter f0 (5-wide) to kill octave blips
  const f0s = frames.map(f => f.f0);
  for (let i = 0; i < frames.length; i++) {
    const wnd = [];
    for (let j = Math.max(0, i - 2); j <= Math.min(frames.length - 1, i + 2); j++) if (f0s[j] > 0) wnd.push(f0s[j]);
    if (frames[i].f0 > 0 && wnd.length >= 3) {
      wnd.sort((a, b) => a - b);
      frames[i].f0 = wnd[Math.floor(wnd.length / 2)];
    }
  }
  return frames.map(({ t, rms, f0, clarity }) => ({ t, rms: Math.round(rms * 1e4) / 1e4, f0: Math.round(f0 * 100) / 100, clarity: Math.round(clarity * 100) / 100 }));
}

const midiFromHz = hz => 69 + 12 * Math.log2(hz / 440);
const hzFromMidi = m => 440 * Math.pow(2, (m - 69) / 12);

function medianF0(frames) {
  const v = frames.filter(f => f.f0 > 0).map(f => f.f0).sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : null;
}

// ---------- note segmentation ----------

function extractNotes(frames) {
  const notes = [];
  let cur = null;
  const flush = () => {
    if (cur && cur.end - cur.start >= 0.07) {
      const mids = cur.mids.slice().sort((a, b) => a - b);
      const m = mids[Math.floor(mids.length / 2)];
      notes.push({ startSec: cur.start, endSec: cur.end, midiFloat: Math.round(m * 100) / 100 });
    }
    cur = null;
  };
  for (const fr of frames) {
    const voiced = fr.f0 > 0 && fr.clarity > 0.55;
    if (!voiced) { flush(); continue; }
    const m = midiFromHz(fr.f0);
    if (!cur) { cur = { start: fr.t, end: fr.t + 0.01, mids: [m] }; continue; }
    const curMed = cur.mids[Math.floor(cur.mids.length / 2)];
    if (Math.abs(m - curMed) > 0.75) { flush(); cur = { start: fr.t, end: fr.t + 0.01, mids: [m] }; }
    else { cur.end = fr.t + 0.01; cur.mids.push(m); cur.mids.sort((a, b) => a - b); }
  }
  flush();
  // merge micro-gaps between same-pitch notes
  const merged = [];
  for (const n of notes) {
    const last = merged[merged.length - 1];
    if (last && n.startSec - last.endSec < 0.04 && Math.abs(n.midiFloat - last.midiFloat) < 0.6) {
      last.endSec = n.endSec;
    } else merged.push({ ...n });
  }
  return merged;
}

// ---------- scales + note-correction candidates ----------

const SCALES = { major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10] };
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

function bestKey(midis) {
  let best = null;
  for (const mode of ['major', 'minor']) {
    for (let root = 0; root < 12; root++) {
      let dev = 0;
      for (const m of midis) {
        const pc = ((m % 12) + 12) % 12;
        let d = Infinity;
        for (const deg of SCALES[mode]) {
          const tone = (root + deg) % 12;
          let diff = Math.abs(pc - tone); diff = Math.min(diff, 12 - diff);
          d = Math.min(d, diff);
        }
        dev += d * d;
      }
      if (!best || dev < best.dev) best = { root, mode, dev };
    }
  }
  return best;
}

function snapMidi(midiFloat, scale) {
  const round = Math.round(midiFloat);
  if (!scale) return round;
  const { root, mode } = scale;
  let best = round, bestD = Infinity;
  for (let m = round - 2; m <= round + 2; m++) {
    const pc = ((m % 12) + 12) % 12;
    if (SCALES[mode].some(deg => (root + deg) % 12 === pc)) {
      const d = Math.abs(m - midiFloat);
      if (d < bestD) { bestD = d; best = m; }
    }
  }
  return best;
}

// Build interpretation candidates for notes (seconds) against a bpm grid.
// secPerBeat known; startBeatOffset lets note times be relative to the take start.
function noteCandidates(rawNotes, bpm, keyHint) {
  if (!rawNotes.length || !bpm) return [];
  const spb = 60 / bpm;
  const midis = rawNotes.map(n => n.midiFloat);
  const autoKey = bestKey(midis);
  const scales = [
    { label: 'free (chromatic)', scale: null },
    { label: `${NOTE_NAMES[autoKey.root]} ${autoKey.mode}`, scale: autoKey },
  ];
  if (keyHint && (keyHint.root !== autoKey.root || keyHint.mode !== autoKey.mode)) {
    scales.push({ label: `${NOTE_NAMES[keyHint.root]} ${keyHint.mode} (song key)`, scale: keyHint });
  }
  const grids = [
    { label: '1/4 notes', div: 1 },
    { label: '1/8 notes', div: 2 },
    { label: '1/16 notes', div: 4 },
    { label: '1/8 triplets', div: 3 },
  ];
  const cands = [];
  for (const g of grids) {
    for (const sc of scales) {
      const unit = spb / g.div;
      let timingDev = 0, pitchDev = 0;
      const notes = [];
      for (const n of rawNotes) {
        const s = Math.round(n.startSec / unit);
        let l = Math.max(1, Math.round((n.endSec - n.startSec) / unit));
        const midi = snapMidi(n.midiFloat, sc.scale);
        timingDev += Math.abs(n.startSec - s * unit) + Math.abs((n.endSec - n.startSec) - l * unit) * 0.5;
        pitchDev += Math.abs(n.midiFloat - midi);
        notes.push({ s: (s * unit) / spb, l: (l * unit) / spb, m: midi, srcStart: n.startSec, srcEnd: n.endSec, cents: Math.round((midi - n.midiFloat) * 100) });
      }
      // collapse overlapping notes on the same grid slot (keep the longer)
      notes.sort((a, b) => a.s - b.s || b.l - a.l);
      const clean = [];
      for (const n of notes) {
        const last = clean[clean.length - 1];
        if (last && n.s < last.s + last.l && n.m === last.m) continue;
        if (last && n.s < last.s + last.l) last.l = Math.max(0.25 / (60 / bpm), n.s - last.s);
        clean.push(n);
      }
      const score = timingDev / rawNotes.length + (pitchDev / rawNotes.length) * 0.9 + (g.div === 3 ? 0.02 : 0) + (g.div === 4 ? 0.015 : 0);
      cands.push({
        label: `${g.label} · ${sc.label}`,
        grid: g.div, scaleLabel: sc.label,
        score: Math.round(score * 1000) / 1000,
        notes: clean.map(({ s, l, m, srcStart, srcEnd, cents }) => ({ s: r3(s), l: r3(l), m, srcStart: r3(srcStart), srcEnd: r3(srcEnd), cents })),
      });
    }
  }
  cands.sort((a, b) => a.score - b.score);
  // dedupe identical note sequences
  const seen = new Set(), out = [];
  for (const c of cands) {
    const key = c.notes.map(n => `${n.s},${n.l},${n.m}`).join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
    if (out.length >= 5) break;
  }
  return out;
}

const r3 = v => Math.round(v * 1000) / 1000;

// ---------- match analysis (align take B to reference A / grid) ----------

function matchAnalysis(framesRef, framesTgt, bpmRef, bpmTgt) {
  const fRef = medianF0(framesRef), fTgt = medianF0(framesTgt);
  let cents = null;
  if (fRef && fTgt) {
    cents = Math.round(1200 * Math.log2(fRef / fTgt));
    // fold to nearest octave-equivalent shift within ±600 unless clearly intended
    while (cents > 700) cents -= 1200;
    while (cents < -700) cents += 1200;
  }
  let ratio = null;
  if (bpmRef && bpmTgt) {
    ratio = bpmTgt / bpmRef; // stretch factor to apply to target duration
    for (const f of [0.5, 2]) if (Math.abs(ratio * f - 1) < Math.abs(ratio - 1)) ratio *= f;
  }
  return { cents, ratio: ratio ? Math.round(ratio * 1000) / 1000 : null };
}

function analyzeAll(pcm) {
  const tempo = bpmDetect(pcm);
  const meter = meterDetect(pcm, tempo.bpm);
  const frames = f0Track(pcm);
  const f0med = medianF0(frames);
  const voiced = frames.filter(f => f.f0 > 0).length / Math.max(1, frames.length);
  return {
    tempo, meter,
    f0Median: f0med ? Math.round(f0med * 10) / 10 : null,
    voiced: Math.round(voiced * 100) / 100,
    durationSec: r3(pcm.length / SR),
  };
}

module.exports = { bpmDetect, meterDetect, f0Track, extractNotes, noteCandidates, matchAnalysis, analyzeAll, medianF0, NOTE_NAMES, midiFromHz, hzFromMidi };
