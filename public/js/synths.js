'use strict';
// Instrument presets (simple clean note rendering — articulations come later),
// offline rendering of note tracks, FX chains, and WAV encoding.

const hzOf = m => 440 * Math.pow(2, (m - 69) / 12);

export const INSTRUMENTS = {
  piano: { label: 'Piano' },
  epiano: { label: 'E-Piano' },
  bass: { label: 'Bass' },
  strings: { label: 'Strings' },
  violin: { label: 'Violin' },
  flute: { label: 'Flute' },
  trumpet: { label: 'Trumpet' },
  marimba: { label: 'Marimba' },
  lead: { label: 'Synth lead' },
};

// Build one note's voice into ctx, connected to dest. t0..t1 = seconds.
function voice(ctx, dest, inst, midi, t0, t1, vel = 0.9) {
  const f = hzOf(midi);
  const g = ctx.createGain();
  g.connect(dest);
  const oscs = [];
  const mk = (type, freq, det = 0, lvl = 1) => {
    const o = ctx.createOscillator();
    o.type = type; o.frequency.value = freq; o.detune.value = det;
    const og = ctx.createGain(); og.gain.value = lvl;
    o.connect(og); og.connect(g);
    oscs.push(o);
    return o;
  };
  const env = (attack, decay, sustain, release, peak) => {
    const p = peak * vel;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.001, p), t0 + attack);
    g.gain.exponentialRampToValueAtTime(Math.max(0.001, p * sustain), Math.min(t1, t0 + attack + decay));
    g.gain.setValueAtTime(Math.max(0.001, p * sustain), Math.max(t0 + attack, t1 - 0.01));
    g.gain.exponentialRampToValueAtTime(0.0001, t1 + release);
    return t1 + release + 0.02;
  };
  const vibrato = (rate, cents, delay = 0.12) => {
    const lfo = ctx.createOscillator(); lfo.frequency.value = rate;
    const lg = ctx.createGain(); lg.gain.setValueAtTime(0, t0);
    lg.gain.linearRampToValueAtTime(cents, t0 + delay + 0.25);
    lfo.connect(lg);
    for (const o of oscs) lg.connect(o.detune);
    lfo.start(t0); lfo.stop(t1 + 0.5);
  };
  let stopAt = t1 + 0.3;
  switch (inst) {
    case 'piano': {
      mk('triangle', f, 0, 1); mk('sine', f * 2, 3, 0.35); mk('sine', f * 3, -4, 0.12);
      const d = Math.min(2.2, Math.max(0.5, 90 / f));
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.5 * vel, t0 + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0001, Math.min(t1 + 0.2, t0 + d) + 0.25);
      stopAt = Math.min(t1 + 0.25, t0 + d) + 0.3;
      break;
    }
    case 'epiano': {
      mk('sine', f, 0, 1); mk('sine', f * 4, 0, 0.18); mk('sine', f * 7.02, 0, 0.03);
      stopAt = env(0.004, 0.5, 0.45, 0.25, 0.45);
      break;
    }
    case 'bass': {
      mk('sawtooth', f / 2, 0, 0.8); mk('sine', f / 2, 0, 0.7);
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = Math.min(900, f * 3);
      g.disconnect(); g.connect(lp); lp.connect(dest);
      stopAt = env(0.008, 0.15, 0.6, 0.12, 0.6);
      break;
    }
    case 'strings': {
      mk('sawtooth', f, -7, 0.4); mk('sawtooth', f, 7, 0.4); mk('sawtooth', f * 2, 3, 0.1);
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2600; lp.Q.value = 0.3;
      g.disconnect(); g.connect(lp); lp.connect(dest);
      stopAt = env(0.22, 0.2, 0.85, 0.35, 0.35);
      vibrato(4.6, 7, 0.3);
      break;
    }
    case 'violin': {
      mk('sawtooth', f, 0, 0.75); mk('sawtooth', f * 2, 4, 0.12);
      const bp = ctx.createBiquadFilter(); bp.type = 'peaking'; bp.frequency.value = 2800; bp.gain.value = 5;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 5200;
      g.disconnect(); g.connect(bp); bp.connect(lp); lp.connect(dest);
      stopAt = env(0.09, 0.12, 0.8, 0.22, 0.42);
      vibrato(5.4, 14, 0.18);
      break;
    }
    case 'flute': {
      mk('sine', f, 0, 1); mk('sine', f * 2, 0, 0.12);
      const noise = ctx.createBufferSource();
      const nb = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const nd = nb.getChannelData(0);
      for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
      noise.buffer = nb; noise.loop = true;
      const nf = ctx.createBiquadFilter(); nf.type = 'bandpass'; nf.frequency.value = f * 2; nf.Q.value = 8;
      const ng = ctx.createGain(); ng.gain.value = 0.04;
      noise.connect(nf); nf.connect(ng); ng.connect(g);
      noise.start(t0); noise.stop(t1 + 0.3);
      stopAt = env(0.07, 0.1, 0.85, 0.16, 0.4);
      vibrato(5, 9, 0.25);
      break;
    }
    case 'trumpet': {
      mk('sawtooth', f, 0, 0.6); mk('square', f, 3, 0.3); mk('sawtooth', f * 2, -3, 0.15);
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = Math.max(200, f * 0.7);
      const pk = ctx.createBiquadFilter(); pk.type = 'peaking'; pk.frequency.value = 1200; pk.gain.value = 6;
      g.disconnect(); g.connect(hp); hp.connect(pk); pk.connect(dest);
      stopAt = env(0.035, 0.08, 0.8, 0.14, 0.42);
      vibrato(5.2, 6, 0.3);
      break;
    }
    case 'marimba': {
      mk('sine', f, 0, 1); mk('sine', f * 3.93, 0, 0.25); mk('sine', f * 9.03, 0, 0.08);
      const d = Math.min(1.1, Math.max(0.22, 60 / f));
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.55 * vel, t0 + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + d);
      stopAt = t0 + d + 0.1;
      break;
    }
    default: { // lead
      mk('sawtooth', f, -5, 0.5); mk('square', f, 5, 0.35);
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3800; lp.Q.value = 1.5;
      g.disconnect(); g.connect(lp); lp.connect(dest);
      stopAt = env(0.015, 0.1, 0.7, 0.12, 0.4);
      vibrato(5.5, 8, 0.2);
    }
  }
  for (const o of oscs) { o.start(t0); o.stop(stopAt); }
}

// Render notes [{s,l,m,v}] (beats) with an instrument into an AudioBuffer. spb = sec/beat.
export async function renderNotes(notes, spb, inst, { sampleRate = 48000, gain = 0.9, tail = 0.8 } = {}) {
  const total = Math.max(...notes.map(n => (n.s + n.l))) * spb + tail;
  const ctx = new OfflineAudioContext(1, Math.ceil(total * sampleRate), sampleRate);
  const master = ctx.createGain(); master.gain.value = gain;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14; comp.ratio.value = 6;
  master.connect(comp); comp.connect(ctx.destination);
  for (const n of notes) {
    voice(ctx, master, inst, n.m, n.s * spb, (n.s + n.l) * spb, n.v == null ? 0.9 : n.v);
  }
  return ctx.startRendering();
}

// Live audition of notes on a running context (returns stop fn).
export function playNotesLive(ctx, dest, notes, spb, inst) {
  const t = ctx.currentTime + 0.08;
  const g = ctx.createGain(); g.connect(dest);
  for (const n of notes) voice(ctx, g, inst, n.m, t + n.s * spb, t + (n.s + n.l) * spb, n.v == null ? 0.9 : n.v);
  return () => { try { g.disconnect(); } catch { /* ok */ } };
}

// ---------- FX ----------

export const FX_DEFS = {
  gain: { label: 'Gain', params: { amount: { label: 'Amount', min: 0, max: 3, step: 0.01, def: 1 } } },
  reverb: {
    label: 'Reverb', params: {
      mix: { label: 'Mix', min: 0, max: 1, step: 0.01, def: 0.3 },
      size: { label: 'Size', min: 0.2, max: 4, step: 0.1, def: 1.6 },
    },
  },
  delay: {
    label: 'Delay', params: {
      time: { label: 'Time (beats)', min: 0.25, max: 2, step: 0.25, def: 0.5 },
      feedback: { label: 'Feedback', min: 0, max: 0.85, step: 0.01, def: 0.35 },
      mix: { label: 'Mix', min: 0, max: 1, step: 0.01, def: 0.25 },
    },
  },
  eq: {
    label: 'EQ (shelves)', params: {
      low: { label: 'Low dB', min: -18, max: 18, step: 0.5, def: 0 },
      high: { label: 'High dB', min: -18, max: 18, step: 0.5, def: 0 },
    },
  },
  chorus: {
    label: 'Chorus', params: {
      depth: { label: 'Depth (ms)', min: 1, max: 12, step: 0.5, def: 5 },
      rate: { label: 'Rate (Hz)', min: 0.1, max: 4, step: 0.1, def: 0.8 },
      mix: { label: 'Mix', min: 0, max: 1, step: 0.01, def: 0.4 },
    },
  },
  tremolo: {
    label: 'Tremolo', params: {
      rate: { label: 'Rate (Hz)', min: 0.5, max: 12, step: 0.1, def: 4.5 },
      depth: { label: 'Depth', min: 0, max: 1, step: 0.01, def: 0.5 },
    },
  },
  distortion: {
    label: 'Distortion', params: {
      drive: { label: 'Drive', min: 1, max: 40, step: 1, def: 8 },
      mix: { label: 'Mix', min: 0, max: 1, step: 0.01, def: 0.8 },
    },
  },
};

function impulseResponse(ctx, seconds, decay = 2.5) {
  const len = Math.ceil(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
  }
  return buf;
}

// Build a serial FX chain in ctx. Returns {input, output}.
export function buildFxChain(ctx, chain, spb = 0.5) {
  let input = ctx.createGain();
  let cur = input;
  const connect = node => { cur.connect(node); cur = node; };
  for (const fx of chain) {
    const p = fx.params || {};
    switch (fx.type) {
      case 'gain': {
        const g = ctx.createGain(); g.gain.value = p.amount == null ? 1 : p.amount;
        connect(g); break;
      }
      case 'eq': {
        const lo = ctx.createBiquadFilter(); lo.type = 'lowshelf'; lo.frequency.value = 320; lo.gain.value = p.low || 0;
        const hi = ctx.createBiquadFilter(); hi.type = 'highshelf'; hi.frequency.value = 3200; hi.gain.value = p.high || 0;
        connect(lo); connect(hi); break;
      }
      case 'reverb': {
        const dry = ctx.createGain(), wet = ctx.createGain(), sum = ctx.createGain();
        const conv = ctx.createConvolver();
        conv.buffer = impulseResponse(ctx, p.size || 1.6);
        dry.gain.value = 1 - (p.mix == null ? 0.3 : p.mix);
        wet.gain.value = p.mix == null ? 0.3 : p.mix;
        cur.connect(dry); cur.connect(conv); conv.connect(wet);
        dry.connect(sum); wet.connect(sum);
        cur = sum; break;
      }
      case 'delay': {
        const dry = ctx.createGain(), wet = ctx.createGain(), sum = ctx.createGain();
        const dl = ctx.createDelay(4); dl.delayTime.value = (p.time || 0.5) * spb;
        const fb = ctx.createGain(); fb.gain.value = p.feedback == null ? 0.35 : p.feedback;
        dl.connect(fb); fb.connect(dl);
        dry.gain.value = 1; wet.gain.value = p.mix == null ? 0.25 : p.mix;
        cur.connect(dry); cur.connect(dl); dl.connect(wet);
        dry.connect(sum); wet.connect(sum);
        cur = sum; break;
      }
      case 'chorus': {
        const dry = ctx.createGain(), wet = ctx.createGain(), sum = ctx.createGain();
        const dl = ctx.createDelay(0.1); dl.delayTime.value = 0.02;
        const lfo = ctx.createOscillator(); lfo.frequency.value = p.rate || 0.8;
        const lg = ctx.createGain(); lg.gain.value = (p.depth || 5) / 1000;
        lfo.connect(lg); lg.connect(dl.delayTime); lfo.start();
        dry.gain.value = 1; wet.gain.value = p.mix == null ? 0.4 : p.mix;
        cur.connect(dry); cur.connect(dl); dl.connect(wet);
        dry.connect(sum); wet.connect(sum);
        cur = sum; break;
      }
      case 'tremolo': {
        const g = ctx.createGain();
        const lfo = ctx.createOscillator(); lfo.frequency.value = p.rate || 4.5;
        const lg = ctx.createGain(); lg.gain.value = (p.depth == null ? 0.5 : p.depth) / 2;
        g.gain.value = 1 - lg.gain.value;
        lfo.connect(lg); lg.connect(g.gain); lfo.start();
        connect(g); break;
      }
      case 'distortion': {
        const dry = ctx.createGain(), wet = ctx.createGain(), sum = ctx.createGain();
        const ws = ctx.createWaveShaper();
        const k = p.drive || 8, n = 1024, curve = new Float32Array(n);
        for (let i = 0; i < n; i++) {
          const x = (i / (n - 1)) * 2 - 1;
          curve[i] = Math.tanh(k * x) / Math.tanh(k);
        }
        ws.curve = curve; ws.oversample = '4x';
        dry.gain.value = 1 - (p.mix == null ? 0.8 : p.mix);
        wet.gain.value = (p.mix == null ? 0.8 : p.mix) * 0.7;
        cur.connect(dry); cur.connect(ws); ws.connect(wet);
        dry.connect(sum); wet.connect(sum);
        cur = sum; break;
      }
    }
  }
  return { input, output: cur };
}

// Apply FX to an AudioBuffer (optionally only on [rangeStartSec, rangeEndSec)).
export async function applyFxToBuffer(buffer, chain, spb, range) {
  const sr = buffer.sampleRate;
  const tail = chain.some(f => f.type === 'reverb' || f.type === 'delay') ? 2.5 : 0.2;
  const render = async (buf) => {
    const ctx = new OfflineAudioContext(buf.numberOfChannels, Math.ceil((buf.duration + tail) * sr), sr);
    const src = ctx.createBufferSource(); src.buffer = buf;
    const { input, output } = buildFxChain(ctx, chain, spb);
    src.connect(input); output.connect(ctx.destination);
    src.start(0);
    return ctx.startRendering();
  };
  if (!range) return render(buffer);
  const [s, e] = [Math.max(0, Math.floor(range[0] * sr)), Math.min(buffer.length, Math.ceil(range[1] * sr))];
  const slice = new AudioBuffer({ numberOfChannels: buffer.numberOfChannels, length: Math.max(1, e - s), sampleRate: sr });
  for (let c = 0; c < buffer.numberOfChannels; c++) slice.copyToChannel(buffer.getChannelData(c).slice(s, e), c);
  const wet = await render(slice);
  const outLen = Math.max(buffer.length, s + wet.length);
  const out = new AudioBuffer({ numberOfChannels: buffer.numberOfChannels, length: outLen, sampleRate: sr });
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = out.getChannelData(c);
    const orig = buffer.getChannelData(c);
    d.set(orig, 0);
    // silence the replaced range, then add the processed slice
    for (let i = s; i < e; i++) d[i] = 0;
    const w = wet.getChannelData(Math.min(c, wet.numberOfChannels - 1));
    for (let i = 0; i < w.length && s + i < outLen; i++) d[s + i] += w[i];
  }
  return out;
}

// ---------- WAV encode ----------

export function encodeWav(buffer) {
  const nCh = Math.min(2, buffer.numberOfChannels);
  const sr = buffer.sampleRate;
  const len = buffer.length;
  const bytes = 44 + len * nCh * 2;
  const ab = new ArrayBuffer(bytes);
  const d = new DataView(ab);
  const wstr = (o, s) => { for (let i = 0; i < s.length; i++) d.setUint8(o + i, s.charCodeAt(i)); };
  wstr(0, 'RIFF'); d.setUint32(4, bytes - 8, true); wstr(8, 'WAVE'); wstr(12, 'fmt ');
  d.setUint32(16, 16, true); d.setUint16(20, 1, true); d.setUint16(22, nCh, true);
  d.setUint32(24, sr, true); d.setUint32(28, sr * nCh * 2, true);
  d.setUint16(32, nCh * 2, true); d.setUint16(34, 16, true);
  wstr(36, 'data'); d.setUint32(40, len * nCh * 2, true);
  const chans = [];
  for (let c = 0; c < nCh; c++) chans.push(buffer.getChannelData(c));
  let o = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < nCh; c++) {
      const v = Math.max(-1, Math.min(1, chans[c][i]));
      d.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      o += 2;
    }
  }
  return new Blob([ab], { type: 'audio/wav' });
}
