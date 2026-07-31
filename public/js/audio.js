'use strict';
// Client audio engine: sample-accurate playback of takes on the beat grid,
// synthesized backing (metronome click, chord pad, drum beat, MIDI file),
// looping, and mic recording with echo-cancellation so backing doesn't bleed.

export const BEAT_PATTERNS = {
  pop: { label: 'Pop', kick: [0, 2], snare: [1, 3], hat: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5] },
  four: { label: 'Four on the floor', kick: [0, 1, 2, 3], snare: [1, 3], hat: [0.5, 1.5, 2.5, 3.5] },
  halftime: { label: 'Half-time', kick: [0], snare: [2], hat: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5] },
  shuffle: { label: 'Shuffle', kick: [0, 2], snare: [1, 3], hat: [0, 0.66, 1, 1.66, 2, 2.66, 3, 3.66] },
  latin: { label: 'Latin', kick: [0, 1.5, 2.5], snare: [2, 3.5], hat: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5] },
};

export const CHORD_QUALITIES = {
  maj: { label: 'maj', iv: [0, 4, 7] }, min: { label: 'min', iv: [0, 3, 7] },
  7: { label: '7', iv: [0, 4, 7, 10] }, maj7: { label: 'maj7', iv: [0, 4, 7, 11] },
  min7: { label: 'min7', iv: [0, 3, 7, 10] }, sus4: { label: 'sus4', iv: [0, 5, 7] },
  dim: { label: 'dim', iv: [0, 3, 6] }, pow: { label: '5', iv: [0, 7] },
};

const hzOf = m => 440 * Math.pow(2, (m - 69) / 12);

class Engine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.buffers = new Map(); // fileId -> Promise<AudioBuffer>
    this.state = null;        // active playback
    this.recording = null;
    this.onPlayState = null;  // cb(playing:boolean)
  }

  ensure() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
      this.master = this.ctx.createGain();
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }

  buffer(fileId) {
    if (!this.buffers.has(fileId)) {
      this.buffers.set(fileId, (async () => {
        const res = await fetch(`/api/files/${fileId}/audio`);
        if (!res.ok) throw new Error('audio fetch failed');
        const ab = await res.arrayBuffer();
        return this.ensure().decodeAudioData(ab);
      })().catch(e => { this.buffers.delete(fileId); throw e; }));
    }
    return this.buffers.get(fileId);
  }

  // ---- backing synthesis (all scheduled at absolute ctx times) ----

  click(t, accent, gain = 1) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.frequency.value = accent ? 1660 : 1150;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime((accent ? 0.42 : 0.25) * gain, t + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, t + (accent ? 0.07 : 0.045));
    osc.connect(g); g.connect(this.master);
    osc.start(t); osc.stop(t + 0.09);
  }

  drum(t, kind, gain = 1) {
    const ctx = this.ctx;
    if (kind === 'kick') {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.setValueAtTime(150, t);
      o.frequency.exponentialRampToValueAtTime(48, t + 0.11);
      g.gain.setValueAtTime(0.5 * gain, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
      o.connect(g); g.connect(this.master); o.start(t); o.stop(t + 0.24);
    } else {
      const len = kind === 'snare' ? 0.16 : 0.05;
      const buf = ctx.createBuffer(1, Math.ceil(len * ctx.sampleRate), ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, kind === 'snare' ? 1.4 : 2.5);
      const src = ctx.createBufferSource(); src.buffer = buf;
      const f = ctx.createBiquadFilter();
      f.type = kind === 'snare' ? 'bandpass' : 'highpass';
      f.frequency.value = kind === 'snare' ? 1800 : 7500;
      const g = ctx.createGain();
      g.gain.value = (kind === 'snare' ? 0.34 : 0.16) * gain;
      src.connect(f); f.connect(g); g.connect(this.master);
      src.start(t);
      if (kind === 'snare') { // add tone body
        const o = ctx.createOscillator(), g2 = ctx.createGain();
        o.frequency.value = 190;
        g2.gain.setValueAtTime(0.2 * gain, t);
        g2.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
        o.connect(g2); g2.connect(this.master); o.start(t); o.stop(t + 0.1);
      }
    }
  }

  chordVoice(t, tStop, rootPc, quality, gain = 1) {
    const ctx = this.ctx;
    const iv = (CHORD_QUALITIES[quality] || CHORD_QUALITIES.maj).iv;
    const nodes = [];
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 1400; lp.Q.value = 0.4;
    const bus = ctx.createGain();
    bus.gain.setValueAtTime(0.0001, t);
    bus.gain.linearRampToValueAtTime(0.09 * gain, t + 0.09);
    bus.gain.setValueAtTime(0.09 * gain, Math.max(t + 0.09, tStop - 0.14));
    bus.gain.linearRampToValueAtTime(0.0001, tStop);
    bus.connect(lp); lp.connect(this.master);
    const rootMidi = 48 + rootPc;
    for (const off of iv.concat([iv[0] - 12])) {
      for (const det of [-4, 4]) {
        const o = ctx.createOscillator();
        o.type = 'triangle';
        o.frequency.value = hzOf(rootMidi + off);
        o.detune.value = det;
        o.connect(bus);
        o.start(t); o.stop(tStop + 0.02);
        nodes.push(o);
      }
    }
    return nodes;
  }

  midiNote(t, tStop, midi, vel = 0.8, drum = false, gain = 1) {
    if (drum) { this.drum(t, midi === 36 || midi === 35 ? 'kick' : midi === 38 || midi === 40 ? 'snare' : 'hat', gain * vel); return; }
    const ctx = this.ctx;
    const o = ctx.createOscillator(); o.type = 'triangle';
    const o2 = ctx.createOscillator(); o2.type = 'sine';
    o.frequency.value = hzOf(midi); o2.frequency.value = hzOf(midi) * 2;
    const g = ctx.createGain();
    const peak = 0.14 * vel * gain;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.015);
    g.gain.setValueAtTime(peak * 0.8, Math.max(t + 0.02, tStop - 0.05));
    g.gain.exponentialRampToValueAtTime(0.0001, tStop + 0.03);
    const g2 = ctx.createGain(); g2.gain.value = 0.25;
    o.connect(g); o2.connect(g2); g2.connect(g); g.connect(this.master);
    o.start(t); o2.start(t); o.stop(tStop + 0.05); o2.stop(tStop + 0.05);
  }

  // ---- playback ----

  // plan: {spb, fromBeat, endBeat, loop, items:[{fileId, atBeat, gain, cutBeat?}],
  //        backing:{bpb, metronome, chords, chordsOn, beatPattern, beatGain, padGain, clickGain,
  //                 midiNotes, midiOn, midiGain}, countInBeats, onStop, onTick}
  async play(plan) {
    this.stop();
    const ctx = this.ensure();
    const buffers = new Map();
    await Promise.all([...new Set((plan.items || []).map(i => i.fileId))].map(async fid => {
      try { buffers.set(fid, await this.buffer(fid)); } catch { /* missing audio is skipped */ }
    }));
    const spb = plan.spb;
    const span = Math.max(0.25, plan.endBeat - plan.fromBeat);
    const countIn = plan.countInBeats || 0;
    const t0 = ctx.currentTime + 0.12 + countIn * spb; // t0 = ctx time of fromBeat (iteration 0)
    const st = {
      plan, spb, span, t0, iter: 0, sources: [], stopped: false,
      itemsScheduledForIter: -1, backingCursor: plan.fromBeat - countIn, // absolute beat-line position incl. count-in
    };
    this.state = st;

    const scheduleItemsIter = iter => {
      const base = t0 + iter * span * spb;
      for (const it of plan.items || []) {
        const buf = buffers.get(it.fileId);
        if (!buf) continue;
        const relStart = it.atBeat - plan.fromBeat;
        const durBeats = (it.cutBeat != null ? it.cutBeat : buf.duration / spb);
        if (relStart >= span || relStart + durBeats <= 0) continue;
        const src = ctx.createBufferSource();
        src.buffer = buf;
        const g = ctx.createGain();
        g.gain.value = it.gain == null ? 1 : it.gain;
        src.connect(g); g.connect(this.master);
        const offsetSec = Math.max(0, -relStart) * spb;
        const when = base + Math.max(0, relStart) * spb;
        src.start(when, offsetSec);
        const stopAt = base + Math.min(span, relStart + durBeats) * spb;
        if (plan.loop || (it.cutBeat != null)) src.stop(Math.max(when + 0.01, stopAt));
        st.sources.push(src);
      }
      st.itemsScheduledForIter = iter;
    };
    scheduleItemsIter(0);

    const b = plan.backing || {};
    const bpb = b.bpb || 4;
    const step = 0.25; // scheduling resolution in beats (16ths at 4/4)
    const chordNodes = [];
    st.timer = setInterval(() => {
      if (st.stopped) return;
      const horizon = ctx.currentTimeSafe !== undefined ? ctx.currentTimeSafe : ctx.currentTime + 0.3;
      // map absolute beat-line position -> ctx time (count-in beats sit before t0)
      const timeOf = beatPos => t0 + (beatPos - plan.fromBeat) * spb;
      while (timeOf(st.backingCursor) < horizon) {
        const cur = st.backingCursor;
        const inCountIn = cur < plan.fromBeat;
        // wrapped musical beat (for loops)
        let musical = cur;
        if (!inCountIn && plan.loop) musical = plan.fromBeat + (((cur - plan.fromBeat) % span) + span) % span;
        if (!plan.loop && !inCountIn && cur >= plan.endBeat) break;
        const t = timeOf(cur);
        const barBeat = ((musical % bpb) + bpb) % bpb;
        const frac = Math.round((barBeat % 1) * 100) / 100;
        if ((b.metronome || inCountIn) && Number.isInteger(Math.round(barBeat * 4) / 4) && barBeat % 1 === 0) {
          this.click(t, barBeat === 0, (b.clickGain == null ? 1 : b.clickGain) * (inCountIn ? 1 : 1));
        }
        if (!inCountIn && b.beatPattern && BEAT_PATTERNS[b.beatPattern]) {
          const pat = BEAT_PATTERNS[b.beatPattern];
          const bg = b.beatGain == null ? 1 : b.beatGain;
          for (const k of pat.kick) if (k < bpb && Math.abs(barBeat - k) < 0.01) this.drum(t, 'kick', bg);
          for (const k of pat.snare) if (k < bpb && Math.abs(barBeat - k) < 0.01) this.drum(t, 'snare', bg);
          for (const k of pat.hat) if (k < bpb && Math.abs(((barBeat - k + bpb) % bpb)) < 0.01) this.drum(t, 'hat', bg);
        }
        if (!inCountIn && b.chordsOn && Array.isArray(b.chords)) {
          for (const c of b.chords) {
            if (Math.abs(musical - c.s) < step / 2) {
              chordNodes.push(...this.chordVoice(t, t + Math.max(0.2, c.l * spb), c.root, c.quality, b.padGain == null ? 1 : b.padGain));
            }
          }
        }
        if (!inCountIn && b.midiOn && Array.isArray(b.midiNotes)) {
          for (const n of b.midiNotes) {
            if (Math.abs(musical - n.beat) < step / 2) {
              this.midiNote(t, t + Math.max(0.08, n.dur * spb), n.midi, n.vel, n.ch === 9, b.midiGain == null ? 1 : b.midiGain);
            }
          }
        }
        void frac;
        st.backingCursor += step;
      }
      // pre-schedule next loop iteration of items
      if (plan.loop) {
        const iterEnd = t0 + (st.itemsScheduledForIter + 1) * span * spb;
        if (ctx.currentTime > iterEnd - 0.5) scheduleItemsIter(st.itemsScheduledForIter + 1);
      } else if (ctx.currentTime > t0 + span * spb + 0.25) {
        this.stop();
      }
    }, 60);

    st.chordNodes = chordNodes;
    if (this.onPlayState) this.onPlayState(true);
    return { t0 };
  }

  currentBeat() {
    const st = this.state;
    if (!st) return null;
    const el = (this.ctx.currentTime - st.t0) / st.spb;
    if (el < 0) return st.plan.fromBeat + el; // during count-in: negative progress
    if (st.plan.loop) return st.plan.fromBeat + (el % st.span);
    return Math.min(st.plan.endBeat, st.plan.fromBeat + el);
  }

  get playing() { return !!this.state; }

  stop({ silent = false } = {}) {
    const st = this.state;
    if (!st) return null;
    const atBeat = this.currentBeat();
    st.stopped = true;
    clearInterval(st.timer);
    for (const s of st.sources) { try { s.stop(); } catch { /* already stopped */ } }
    for (const o of st.chordNodes || []) { try { o.stop(); } catch { /* ok */ } }
    this.state = null;
    if (!silent && st.plan.onStop) st.plan.onStop(atBeat);
    if (this.onPlayState) this.onPlayState(false);
    return atBeat;
  }

  // Live reposition: restart the same plan from a new beat without firing onStop.
  async seek(beat) {
    const st = this.state;
    if (!st || st.plan.noSeek) return false;
    const plan = st.plan;
    this.stop({ silent: true });
    await this.play({ ...plan, fromBeat: Math.max(0, beat), countInBeats: 0 });
    return true;
  }

  // one-shot audition of a file
  async audition(fileId, { gain = 1, onEnd } = {}) {
    this.stop();
    const ctx = this.ensure();
    const buf = await this.buffer(fileId);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain(); g.gain.value = gain;
    src.connect(g); g.connect(this.master);
    src.start();
    const st = { plan: { fromBeat: 0, endBeat: buf.duration, loop: false, onStop: onEnd, noSeek: true }, spb: 1, span: buf.duration, t0: ctx.currentTime, sources: [src], timer: setInterval(() => { if (ctx.currentTime > st.t0 + buf.duration + 0.05) this.stop(); }, 120) };
    this.state = st;
    if (this.onPlayState) this.onPlayState(true);
  }

  auditionUrl(url) {
    this.stop();
    const a = new Audio(url);
    a.play();
    this._urlAudio && this._urlAudio.pause();
    this._urlAudio = a;
    return a;
  }

  // ---- recording ----

  async startRecording({ aec = true } = {}) {
    const ctx = this.ensure();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: aec, noiseSuppression: aec,
        autoGainControl: false, channelCount: 1,
      },
    });
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find(m => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
    const mr = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 192000 } : undefined);
    const chunks = [];
    mr.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    const startedAt = new Promise(res => { mr.onstart = () => res(ctx.currentTime); });
    // level meter (never routed to speakers -> no feedback)
    const srcNode = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    srcNode.connect(analyser);
    mr.start(250);
    const rec = {
      mime: mime || 'audio/webm',
      startedAt,
      level: () => {
        const d = new Uint8Array(analyser.frequencyBinCount);
        analyser.getByteTimeDomainData(d);
        let peak = 0;
        for (const v of d) peak = Math.max(peak, Math.abs(v - 128) / 128);
        return peak;
      },
      stop: () => new Promise(resolve => {
        mr.onstop = () => {
          stream.getTracks().forEach(t => t.stop());
          try { srcNode.disconnect(); } catch { /* ok */ }
          resolve(new Blob(chunks, { type: mime || 'audio/webm' }));
        };
        mr.stop();
      }),
    };
    this.recording = rec;
    return rec;
  }
}

export const engine = new Engine();
