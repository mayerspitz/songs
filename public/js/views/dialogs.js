'use strict';
import { api } from '../api.js';
import { store } from '../store.js';
import { engine, CHORD_QUALITIES } from '../audio.js';
import { INSTRUMENTS, renderNotes, playNotesLive, FX_DEFS, buildFxChain, applyFxToBuffer, encodeWav } from '../synths.js';
import { h, clear, toast, busy, modal, confirmDlg, slider, menu, icon, NOTE_NAMES, midiName } from '../ui.js';

const SECTION_COLORS = ['#4a9de8', '#43b5a0', '#5fbf6e', '#d8c93a', '#e8a03d', '#e8595c', '#b76ce8', '#7c6cf0', '#e86cb8'];

// ---------- song settings ----------

export function settingsDialog() {
  const song = store.song.song;
  const st = {
    name: song.name, bpm: song.bpm, bpb: song.beats_per_bar || 4, bars: song.bars,
    keyRoot: song.key_root, keyMode: song.key_mode, latency: song.latency_ms,
    chords: (song.chords || []).map(c => ({ ...c })),
  };
  const chordRow = (c, i) => h('div.row.gap-xs.chord-row', {},
    h('input.input.tiny', { type: 'number', value: c.s, step: 1, min: 0, title: 'start beat', onchange: e => c.s = Number(e.target.value) }),
    h('input.input.tiny', { type: 'number', value: c.l, step: 1, min: 1, title: 'length beats', onchange: e => c.l = Number(e.target.value) }),
    h('select.input.tiny', { onchange: e => c.root = Number(e.target.value) },
      NOTE_NAMES.map((n, j) => h('option', { value: j, selected: j === c.root }, n))),
    h('select.input.tiny', { onchange: e => c.quality = e.target.value },
      Object.entries(CHORD_QUALITIES).map(([k, q]) => h('option', { value: k, selected: k === c.quality }, q.label))),
    h('button.icon-btn.small', { title: 'Remove chord', onclick: () => { st.chords.splice(i, 1); redrawChords(); } }, icon('close', { size: 12 })));
  const chordsBox = h('div.col.gap-xs');
  const redrawChords = () => clear(chordsBox, st.chords.map(chordRow),
    h('button.btn.small', {
      onclick: () => {
        const last = st.chords[st.chords.length - 1];
        st.chords.push({ s: last ? last.s + last.l : 0, l: last ? last.l : st.bpb, root: last ? last.root : 0, quality: last ? last.quality : 'maj' });
        redrawChords();
      },
    }, '+ chord'));
  redrawChords();

  const midiInput = h('input', {
    type: 'file', accept: '.mid,.midi,audio/midi', style: { display: 'none' },
    onchange: async e => {
      const f = e.target.files[0];
      if (!f) return;
      try {
        await api.upload(`/api/songs/${store.songId}/midi`, f, { type: 'application/octet-stream' });
        toast('MIDI backing uploaded');
        await store.refreshSong(true);
      } catch (err) { toast(err.message, 'error'); }
    },
  });

  const m = modal('Song settings', h('div.col.gap', {},
    h('label.field', {}, 'Name', h('input.input', { value: st.name, onchange: e => st.name = e.target.value })),
    h('div.row.gap-s.wrap', {},
      h('label.field', {}, 'BPM (official)', h('input.input.small', { type: 'number', min: 30, max: 300, value: st.bpm || '', placeholder: 'auto', onchange: e => st.bpm = e.target.value ? Number(e.target.value) : null })),
      h('label.field', {}, 'Beats/bar', h('input.input.small', { type: 'number', min: 1, max: 12, value: st.bpb, onchange: e => st.bpb = Number(e.target.value) })),
      h('label.field', {}, 'Bars', h('input.input.small', { type: 'number', min: 1, max: 500, value: st.bars, onchange: e => st.bars = Number(e.target.value) }))),
    h('div.row.gap-s.wrap', {},
      h('label.field', {}, 'Key (for note snapping)',
        h('div.row.gap-xs', {},
          h('select.input.small', { onchange: e => st.keyRoot = e.target.value === '' ? null : Number(e.target.value) },
            h('option', { value: '', selected: st.keyRoot == null }, '—'),
            NOTE_NAMES.map((n, j) => h('option', { value: j, selected: j === st.keyRoot }, n))),
          h('select.input.small', { onchange: e => st.keyMode = e.target.value || null },
            h('option', { value: '', selected: !st.keyMode }, '—'),
            h('option', { value: 'major', selected: st.keyMode === 'major' }, 'major'),
            h('option', { value: 'minor', selected: st.keyMode === 'minor' }, 'minor')))),
      h('label.field', {}, `Recording latency ${st.latency}ms`,
        h('input', { type: 'range', min: 0, max: 350, step: 5, value: st.latency, oninput: e => { st.latency = Number(e.target.value); e.target.closest('label').firstChild.textContent = `Recording latency ${st.latency}ms`; } }))),
    h('div.field', {}, 'Backing chords (pad)', chordsBox),
    h('div.row.gap-s', {},
      h('button.btn.small', { onclick: () => midiInput.click() }, song.midi_file_id ? 'Replace MIDI backing…' : 'Upload MIDI backing…'),
      midiInput),
    h('div.row.end.gap-s', {},
      h('button.btn.primary', {
        onclick: async () => {
          try {
            await api.patch(`/api/songs/${store.songId}`, {
              name: st.name, bpm: st.bpm, beatsPerBar: st.bpb, bars: st.bars,
              keyRoot: st.keyRoot, keyMode: st.keyMode, latencyMs: st.latency,
              chords: st.chords,
            });
            await store.refreshSong(true);
            m.close();
            toast('Settings saved');
          } catch (e) { toast(e.message, 'error'); }
        },
      }, 'Save'))));
}

// ---------- Tempo Sense ----------

export async function tempoSenseDialog() {
  const data = await api.get(`/api/songs/${store.songId}/tempo-sense`).catch(e => ({ error: e.message }));
  if (data.error) return toast(data.error, 'error');
  const canSet = store.can('editSettings');
  const content = h('div.col.gap', {},
    h('p.dim.small', {}, 'Tempo Sense listens to every hum you record. The more you record, the sharper the guess. Confirm when you trust it — takes that later drift off this grid get flagged with fix options.'),
    data.suggestions.length
      ? data.suggestions.map((s, i) => h('div.row.gap-s.tempo-sug', {},
        h('b', {}, `${Math.round(s.bpm)} BPM`),
        h('div.conf-bar', {}, h('div.conf-fill', { style: { width: Math.round(s.confidence * 100) + '%' } })),
        h('span.small.dim', {}, `${Math.round(s.confidence * 100)}% · from ${s.takes} take${s.takes > 1 ? 's' : ''}`),
        canSet ? h('button.btn.small' + (i === 0 ? '.primary' : ''), {
          onclick: async () => {
            const bpb = data.meterSuggestion ? data.meterSuggestion.beatsPerBar : 4;
            await api.patch(`/api/songs/${store.songId}`, { bpm: s.bpm, beatsPerBar: bpb });
            await store.refreshSong(true);
            m.close();
            toast(`Official tempo set: ${Math.round(s.bpm)} BPM · ${bpb}/4`);
          },
        }, 'Set official') : null))
      : h('p.dim', {}, data.analyzedTakes ? 'Not enough rhythmic signal yet — record a few more takes.' : 'Record your first takes and come back.'),
    data.meterSuggestion ? h('p.small.dim', {}, `Meter guess: ${data.meterSuggestion.beatsPerBar} beats per bar`) : null,
    canSet ? h('div.row.gap-s', {},
      h('span.small.dim', {}, 'Or set manually:'),
      h('button.btn.small', { onclick: () => { m.close(); settingsDialog(); } }, 'Open settings')) : null);
  const m = modal('Tempo Sense', content);
}

// ---------- tempo flag intent ----------

export function tempoIntentDialog(take) {
  const flag = take.flags?.tempo;
  if (!flag) return;
  const official = store.song.song.bpm;
  let ratio = flag.stretch;
  let previewId = null;
  const info = h('p', {},
    `This take feels like ${Math.round(flag.detected)} BPM; the song is ${Math.round(official)} BPM. What did you intend?`);
  const ratioSlider = slider({
    label: 'stretch', min: 0.7, max: 1.45, step: 0.005, value: ratio,
    fmt: v => `${v.toFixed(3)}× (${Math.round(flag.detected / v)}→${Math.round(official)} BPM)`,
    oninput: v => { ratio = v; previewId = null; },
  });
  const doPreview = async () => {
    const b = busy('Rendering preview…');
    try {
      const r = await api.post(`/api/takes/${take.id}/process`, { op: 'rubberband', params: { stretch: ratio }, preview: true });
      previewId = r.previewId;
      engine.auditionUrl(`/api/previews/${previewId}/audio`);
    } catch (e) { toast(e.message, 'error'); }
    finally { b.close(); }
  };
  const act = async (action) => {
    const b = busy('Applying…');
    try {
      await api.post(`/api/takes/${take.id}/flag-intent`, { action, ratio });
      await store.refreshSong(true);
      m.close();
      toast(action === 'keep' ? 'Kept as intended' : action === 'variant' ? 'On-grid variant saved (original kept)' : 'Take stretched onto the grid');
    } catch (e) { toast(e.message, 'error'); }
    finally { b.close(); }
  };
  const m = modal('Off-tempo take — your intent?', h('div.col.gap', {},
    info,
    ratioSlider,
    h('div.row.gap-s.wrap', {},
      h('button.btn', { title: 'Hear the stretched version', onclick: doPreview }, icon('play', { size: 13 }), ' Preview fixed'),
      h('button.btn', { title: 'Hear the original', onclick: () => engine.audition(take.fileId) }, icon('play', { size: 13 }), ' Original')),
    h('div.col.gap-s', {},
      h('button.btn.primary', { onclick: () => act('fix') }, icon('check', { size: 13 }), ' Fix it — stretch onto the grid (undoable)'),
      h('button.btn', { onclick: () => act('variant') }, icon('variant', { size: 13 }), ' Keep both — save an on-grid variant'),
      h('button.btn', { onclick: () => act('keep') }, 'It’s intentional — keep as is'))));
}

// ---------- match ----------

export function matchDialog(take) {
  const takes = (store.song.takes || []).filter(t => t.id !== take.id && t.fileId);
  let refId = 'grid';
  const samelane = takes.filter(t => t.laneId === take.laneId && t.stage === take.stage);
  if (samelane.length) refId = samelane[samelane.length - 1].id;
  let cents = 0, ratio = 1, previewId = null, analyzed = false;
  const sug = h('div.small.dim', {}, 'Analyze compares this take with the reference and suggests transpose + stretch.');
  const centsS = slider({ label: 'pitch', min: -1200, max: 1200, step: 5, value: 0, fmt: v => `${v > 0 ? '+' : ''}${v}¢ (${(v / 100).toFixed(1)} st)`, oninput: v => { cents = v; previewId = null; } });
  const ratioS = slider({ label: 'stretch', min: 0.5, max: 2, step: 0.005, value: 1, fmt: v => v.toFixed(3) + '×', oninput: v => { ratio = v; previewId = null; } });
  const setSliders = (c, r) => {
    centsS.querySelector('input').value = c; centsS.querySelector('.slider-val').textContent = `${c > 0 ? '+' : ''}${c}¢ (${(c / 100).toFixed(1)} st)`;
    ratioS.querySelector('input').value = r; ratioS.querySelector('.slider-val').textContent = r.toFixed(3) + '×';
    cents = c; ratio = r;
  };
  const analyze = async () => {
    const b = busy('Listening to both takes…');
    try {
      const r = await api.post(`/api/takes/${take.id}/process`, { op: 'match', params: { refTakeId: refId }, preview: true });
      previewId = r.previewId;
      analyzed = true;
      const s = r.suggestion || {};
      setSliders(s.cents || 0, s.ratio || 1);
      sug.textContent = `Suggestion: ${s.cents ? `transpose ${s.cents > 0 ? '+' : ''}${s.cents}¢` : 'pitch already matches'}${s.ratio && Math.abs(s.ratio - 1) > 0.01 ? `, stretch ${s.ratio.toFixed(3)}×` : ', tempo already matches'}. Preview is ready.`;
    } catch (e) { toast(e.message, 'error'); }
    finally { b.close(); }
  };
  const preview = async () => {
    const b = busy('Rendering preview…');
    try {
      if (!previewId) {
        const r = await api.post(`/api/takes/${take.id}/process`, { op: 'rubberband', params: { cents, stretch: ratio }, preview: true });
        previewId = r.previewId;
      }
      engine.auditionUrl(`/api/previews/${previewId}/audio`);
    } catch (e) { toast(e.message, 'error'); }
    finally { b.close(); }
  };
  const commit = async asVariant => {
    const b = busy('Applying…');
    try {
      if (!previewId) {
        const r = await api.post(`/api/takes/${take.id}/process`, { op: 'rubberband', params: { cents, stretch: ratio }, preview: true });
        previewId = r.previewId;
      }
      await api.post(`/api/takes/${take.id}/commit-preview`, { previewId, asVariant, label: `match ${cents}¢ ${ratio.toFixed(3)}×` });
      await store.refreshSong(true);
      m.close();
      toast(asVariant ? 'Matched variant saved' : 'Take matched (undoable)');
    } catch (e) { toast(e.message, 'error'); }
    finally { b.close(); }
  };
  const m = modal('Match tempo & pitch', h('div.col.gap', {},
    h('label.field', {}, 'Match against',
      h('select.input', { onchange: e => { refId = e.target.value; analyzed = false; previewId = null; } },
        h('option', { value: 'grid' }, 'The song grid (official tempo)'),
        takes.map(t => h('option', { value: t.id, selected: t.id === refId }, `${t.name} (${{ 1: 'Hum', 2: 'Song', 3: 'Arrange' }[t.stage]})`)))),
    sug,
    h('button.btn', { title: 'Compare and suggest transpose + stretch', onclick: analyze }, icon('magnet', { size: 13 }), ' Analyze & suggest'),
    centsS, ratioS,
    h('div.row.gap-s.wrap', {},
      h('button.btn', { onclick: preview }, icon('play', { size: 13 }), ' Preview'),
      h('button.btn', { onclick: () => engine.audition(take.fileId) }, icon('play', { size: 13 }), ' Original'),
      refId !== 'grid' ? h('button.btn', { onclick: () => { const rt = store.take(refId); if (rt) engine.audition(rt.fileId); } }, icon('play', { size: 13 }), ' Reference') : null),
    h('div.row.end.gap-s', {},
      h('button.btn', { onclick: () => commit(true), disabled: !analyzed && false }, 'Apply as variant'),
      h('button.btn.primary', { onclick: () => commit(false) }, 'Apply'))));
}

// ---------- note correction ----------

export async function noteCorrectionDialog(take) {
  const b = busy('Finding the notes you meant…');
  let data;
  try {
    data = await api.post(`/api/takes/${take.id}/analyze-notes`, {});
  } catch (e) { b.close(); return toast(e.message, 'error'); }
  b.close();
  const spb = 60 / data.bpm;
  let sel = 0;
  const chosen = new Set();
  let liveStop = null;

  const roll = h('canvas.piano-roll', { width: 640, height: 180 });
  const drawRoll = () => {
    const cand = data.candidates[sel];
    const cx = roll.getContext('2d');
    const W = roll.width, H = roll.height;
    cx.clearRect(0, 0, W, H);
    cx.fillStyle = 'rgba(128,128,160,0.08)';
    cx.fillRect(0, 0, W, H);
    if (!cand.notes.length) return;
    const minM = Math.min(...cand.notes.map(n => n.m)) - 2;
    const maxM = Math.max(...cand.notes.map(n => n.m)) + 2;
    const maxB = Math.max(...cand.notes.map(n => n.s + n.l)) + 0.5;
    const x = bb => (bb / maxB) * (W - 34) + 30;
    const y = mm => H - ((mm - minM) / (maxM - minM)) * (H - 16) - 8;
    cx.strokeStyle = 'rgba(128,128,160,0.25)';
    cx.fillStyle = 'rgba(128,128,160,0.7)';
    cx.font = '9px system-ui';
    for (let bb = 0; bb <= maxB; bb += 1) {
      cx.beginPath(); cx.moveTo(x(bb), 0); cx.lineTo(x(bb), H); cx.stroke();
    }
    for (let mm = minM; mm <= maxM; mm++) {
      if (mm % 12 === 0) cx.fillText(midiName(mm), 2, y(mm) + 3);
    }
    // raw sung notes (ghost)
    cx.fillStyle = 'rgba(232,160,61,0.35)';
    for (const rn of data.rawNotes) {
      const s = rn.startSec / spb, l = (rn.endSec - rn.startSec) / spb;
      cx.fillRect(x(s), y(rn.midiFloat) - 3, Math.max(2, (l / maxB) * (W - 34)), 6);
    }
    // corrected
    cx.fillStyle = '#7c6cf0';
    for (const n of cand.notes) {
      cx.fillRect(x(n.s), y(n.m) - 4, Math.max(3, (n.l / maxB) * (W - 34)), 8);
    }
  };

  const candList = h('div.col.gap-xs');
  const redraw = () => {
    clear(candList, data.candidates.map((c, i) => h(`div.cand-row${i === sel ? '.active' : ''}`, {
      onclick: () => { sel = i; redraw(); drawRoll(); },
    },
      h('input', {
        type: 'checkbox', checked: chosen.has(i), title: 'Include when saving multiple intents',
        onclick: e => { e.stopPropagation(); chosen.has(i) ? chosen.delete(i) : chosen.add(i); },
      }),
      h('div.min0.grow', {},
        h('div.small', {}, c.label),
        h('div.tiny.dim', {}, `${c.notes.length} notes · deviation score ${c.score}`)),
      h('button.icon-btn.small', {
        title: 'Audition with synth',
        onclick: e => {
          e.stopPropagation();
          if (liveStop) liveStop();
          const ctx = engine.ensure();
          liveStop = playNotesLive(ctx, engine.master, c.notes, spb, 'epiano');
        },
      }, icon('play', { size: 12 })))));
    drawRoll();
  };
  redraw();
  setTimeout(drawRoll, 30);

  const apply = async mode => {
    const list = chosen.size && mode === 'variant' ? [...chosen] : [sel];
    const bz = busy(mode === 'notes-only' ? 'Saving notes…' : 'Rendering corrected audio…');
    try {
      for (const i of list) {
        await api.post(`/api/takes/${take.id}/apply-notes`, { notes: data.candidates[i].notes, mode });
      }
      await store.refreshSong(true);
      m.close();
      toast(mode === 'notes-only' ? 'Notes saved on the take'
        : mode === 'variant' ? `${list.length} corrected variant${list.length > 1 ? 's' : ''} saved (original kept)`
          : 'Corrected audio applied (undoable)');
    } catch (e) { toast(e.message, 'error'); }
    finally { bz.close(); }
  };

  const m = modal('Note correction', h('div.col.gap', {},
    h('p.dim.small', {}, `Detected what you hummed at ${Math.round(data.bpm)} BPM and built accurate interpretations — pick what you actually meant. Orange = as sung, purple = corrected. Tick several to keep multiple intents.`),
    roll,
    candList,
    h('div.row.gap-s.wrap', {},
      h('button.btn', { title: 'Hear the raw hum', onclick: () => engine.audition(take.fileId) }, icon('play', { size: 13 }), ' Original hum')),
    h('div.row.end.gap-s.wrap', {},
      h('button.btn', { title: 'Store the note track on the take without touching audio', onclick: () => apply('notes-only') }, icon('note', { size: 13 }), ' Save notes only'),
      h('button.btn', { title: 'Render corrected audio as new take(s), original kept', onclick: () => apply('variant') }, icon('variant', { size: 13 }), ' Corrected variant(s)'),
      h('button.btn.primary', { title: 'Replace this take’s audio (undoable)', onclick: () => apply('corrected-audio') }, icon('check', { size: 13 }), ' Apply corrected audio'))),
    { wide: true, onClose: () => { if (liveStop) liveStop(); } });
}

// ---------- FX ----------

export function fxDialog(take) {
  const chain = [];
  let range = null; // [startBeat, endBeat] within take
  const spb = store.spb() || 0.5;
  const durBeats = (take.duration || 0) / spb;
  let liveNodes = null;

  const chainBox = h('div.col.gap-s');
  const redraw = () => {
    clear(chainBox,
      chain.map((fx, i) => h('div.fx-row', {},
        h('div.row.between', {},
          h('b.small', {}, FX_DEFS[fx.type].label),
          h('button.icon-btn.small', { title: 'Remove effect', onclick: () => { chain.splice(i, 1); redraw(); } }, icon('close', { size: 12 }))),
        Object.entries(FX_DEFS[fx.type].params).map(([k, p]) => slider({
          label: p.label, min: p.min, max: p.max, step: p.step, value: fx.params[k],
          fmt: v => String(Math.round(v * 100) / 100),
          oninput: v => { fx.params[k] = v; },
        })))),
      h('button.btn.small', {
        onclick: e => {
          menu(e.currentTarget, Object.entries(FX_DEFS).map(([k, d]) => ({
            label: d.label,
            action: () => {
              chain.push({ type: k, params: Object.fromEntries(Object.entries(d.params).map(([pk, p]) => [pk, p.def])) });
              redraw();
            },
          })));
        },
      }, '+ Add effect'));
  };
  redraw();

  const stopPreview = () => { engine.stop(); if (liveNodes) { try { liveNodes.src.stop(); } catch { /* ok */ } liveNodes = null; } };
  const preview = async () => {
    stopPreview();
    const ctx = engine.ensure();
    const buf = await engine.buffer(take.fileId);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const { input, output } = buildFxChain(ctx, chain, spb);
    src.connect(input); output.connect(engine.master);
    const r = range || [0, durBeats];
    src.start(0, Math.max(0, r[0] * spb), Math.max(0.1, (r[1] - r[0]) * spb));
    liveNodes = { src };
  };

  const apply = async () => {
    if (!chain.length) return toast('Add at least one effect', 'error');
    const bz = busy('Rendering effects…');
    try {
      const buf = await engine.buffer(take.fileId);
      const rendered = await applyFxToBuffer(buf, chain, spb, range ? [range[0] * spb, range[1] * spb] : null);
      const wav = encodeWav(rendered);
      await fetch(`/api/takes/${take.id}/audio-version?type=audio/wav&label=${encodeURIComponent('fx: ' + chain.map(f => f.type).join('+'))}`, {
        method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: wav,
      }).then(async r => { if (!r.ok) throw new Error((await r.json()).error || 'upload failed'); });
      await store.refreshSong(true);
      m.close();
      toast('Effects applied (undoable via Undo last edit)');
    } catch (e) { toast(e.message, 'error'); }
    finally { bz.close(); }
  };

  const rangeStart = h('input.input.tiny', { type: 'number', min: 0, max: durBeats, step: 0.25, placeholder: '0', onchange: upd });
  const rangeEnd = h('input.input.tiny', { type: 'number', min: 0, max: Math.ceil(durBeats * 4) / 4, step: 0.25, placeholder: durBeats.toFixed(2), onchange: upd });
  function upd() {
    const s = rangeStart.value === '' ? 0 : Number(rangeStart.value);
    const e = rangeEnd.value === '' ? durBeats : Number(rangeEnd.value);
    range = (s <= 0 && e >= durBeats) ? null : [Math.max(0, s), Math.min(durBeats, e)];
  }

  const m = modal(`Effects — ${take.name}`, h('div.col.gap', {},
    h('div.row.gap-s.wrap', {},
      h('span.small.dim', {}, `Apply to beats`), rangeStart, h('span.dim', {}, '→'), rangeEnd,
      h('span.tiny.dim', {}, `(whole take = 0 → ${durBeats.toFixed(2)})`)),
    chainBox,
    h('div.row.gap-s', {},
      h('button.btn', { title: 'Hear the effect chain live', onclick: preview }, icon('play', { size: 13 }), ' Preview'),
      h('button.btn', { title: 'Stop preview', onclick: stopPreview }, icon('stop', { size: 13 }))),
    h('div.row.end', {}, h('button.btn.primary', { onclick: apply }, 'Apply (undoable)'))),
    { onClose: stopPreview });
}

// ---------- instrument generation (stage 3) ----------

export function generateDialog(trackId) {
  const track = store.song.tracks.find(t => t.id === trackId);
  if (!track) return;
  const withNotes = (store.song.takes || []).filter(t => t.notes && t.notes.length);
  if (!withNotes.length) {
    return toast('No note-corrected takes yet — run “Note correction” on a hum first (Hum stage → take → Actions)', 'error');
  }
  let srcId = withNotes[withNotes.length - 1].id;
  let inst = track.instrument;
  let octave = 0;
  let liveStop = null;
  const audition = () => {
    if (liveStop) liveStop();
    const t = store.take(srcId);
    const notes = t.notes.map(n => ({ ...n, m: n.m + octave * 12 }));
    liveStop = playNotesLive(engine.ensure(), engine.master, notes, store.spb() || 0.5, inst);
  };
  const gen = async () => {
    const bz = busy('Rendering instrument…');
    try {
      const t = store.take(srcId);
      const notes = t.notes.map(n => ({ ...n, m: n.m + octave * 12 }));
      const buf = await renderNotes(notes, store.spb() || 0.5, inst);
      const wav = encodeWav(buf);
      const sec = t.laneType === 'section' ? store.section(t.laneId) : null;
      const abs = (sec ? sec.start_beat : 0) + t.offsetBeats;
      const meta = {
        stage: 3, laneType: 'track', laneId: trackId,
        offsetBeats: t.laneType === 'section' || t.laneType === 'perf' || t.laneType === 'track' ? abs : 0,
        name: `${INSTRUMENTS[inst].label} · from ${t.name}`,
        notes: notes,
      };
      await api.upload(`/api/songs/${store.songId}/takes`, wav, { type: 'audio/wav', query: { meta: JSON.stringify(meta), type: 'audio/wav' } });
      await store.refreshSong(true);
      m.close();
      toast('Instrument line generated — add effects from the take menu');
    } catch (e) { toast(e.message, 'error'); }
    finally { bz.close(); }
  };
  const m = modal(`Generate ${track.name}`, h('div.col.gap', {},
    h('p.dim.small', {}, 'Plays the corrected notes with a clean instrument tone (simple key-note output first — articulation effects come after, via Effects on the generated take).'),
    h('label.field', {}, 'Source notes',
      h('select.input', { onchange: e => srcId = e.target.value },
        withNotes.map(t => h('option', { value: t.id, selected: t.id === srcId }, `${t.name} (${t.notes.length} notes)`)))),
    h('div.row.gap-s.wrap', {},
      h('label.field', {}, 'Instrument',
        h('select.input.small', { onchange: e => inst = e.target.value },
          Object.entries(INSTRUMENTS).map(([k, v]) => h('option', { value: k, selected: k === inst }, v.label)))),
      h('label.field', {}, 'Octave',
        h('select.input.small', { onchange: e => octave = Number(e.target.value) },
          [-2, -1, 0, 1, 2].map(o => h('option', { value: o, selected: o === octave }, o > 0 ? '+' + o : String(o)))))),
    h('div.row.gap-s', {}, h('button.btn', { title: 'Hear it with the chosen instrument', onclick: audition }, icon('play', { size: 13 }), ' Audition')),
    h('div.row.end', {}, h('button.btn.primary', { onclick: gen }, 'Generate onto track'))),
    { onClose: () => { if (liveStop) liveStop(); } });
}

// ---------- sections / tracks / structure ----------

export function sectionDialog(sec, atBeat = null) {
  const isNew = !sec;
  const bpb = store.bpb();
  const st = sec
    ? { name: sec.name, start: sec.start_beat, len: sec.length_beats, color: sec.color, snap: false }
    : { name: `Part ${String.fromCharCode(65 + (store.song.sections.length % 26))}`, start: atBeat ?? 0, len: bpb * 4, color: SECTION_COLORS[store.song.sections.length % SECTION_COLORS.length], snap: true };
  const colorRow = h('div.row.gap-xs', {}, SECTION_COLORS.map(c =>
    h(`button.color-dot${st.color === c ? '.on' : ''}`, {
      title: 'Section color',
      onclick: e => { st.color = c; colorRow.querySelectorAll('.color-dot').forEach(d => d.classList.remove('on')); e.target.classList.add('on'); },
      style: { background: c },
    })));
  const snappedStart = () => st.snap ? Math.round(st.start / bpb) * bpb : st.start;
  const startInput = h('input.input.small', {
    type: 'number', min: 0, step: 0.25, value: st.start,
    title: 'Where this part begins on the timeline',
    onchange: e => { st.start = Number(e.target.value); refreshSnapNote(); },
  });
  const snapNote = h('div.tiny.dim');
  const snapBox = h('label.row.gap-xs.small', {},
    h('input', {
      type: 'checkbox', checked: st.snap,
      onchange: e => { st.snap = e.target.checked; refreshSnapNote(); },
    }),
    ' Align to the bar grid (avoids starting at an off-beat point)');
  function refreshSnapNote() {
    const s = snappedStart();
    snapNote.textContent = st.snap && Math.abs(s - st.start) > 1e-6
      ? `Will start at beat ${s} (bar ${Math.floor(s / bpb) + 1}) instead of ${st.start}`
      : `Starts at beat ${s} (bar ${Math.floor(s / bpb) + 1})`;
  }
  refreshSnapNote();
  const m = modal(isNew ? 'Create part' : 'Edit part', h('div.col.gap', {},
    h('label.field', {}, 'Name', h('input.input', { value: st.name, onchange: e => st.name = e.target.value })),
    h('div.row.gap-s', {},
      h('label.field', {}, 'Starting at beat', startInput),
      h('label.field', {}, 'Length (beats — can be 1)', h('input.input.small', { type: 'number', min: 0.25, step: 0.25, value: st.len, title: 'How many beats this part spans', onchange: e => st.len = Number(e.target.value) }))),
    snapBox,
    snapNote,
    colorRow,
    h('div.row.between', {},
      !isNew ? h('button.btn.danger', {
        onclick: async () => {
          if (await confirmDlg('Delete section', `Delete "${sec.name}" AND its takes?`)) {
            await api.del(`/api/sections/${sec.id}`);
            await store.refreshSong(true);
            m.close();
          }
        },
      }, 'Delete') : h('span'),
      h('button.btn.primary', {
        onclick: async () => {
          try {
            if (isNew) {
              const created = await api.post(`/api/songs/${store.songId}/sections`, { name: st.name, startBeat: snappedStart(), lengthBeats: st.len, color: st.color });
              store.ui.selectedSectionId = created.id;
            } else {
              await api.patch(`/api/sections/${sec.id}`, { name: st.name, startBeat: snappedStart(), lengthBeats: st.len, color: st.color });
            }
            await store.refreshSong(true);
            m.close();
          } catch (e) { toast(e.message, 'error'); }
        },
      }, isNew ? 'Add section' : 'Save'))));
}

export function trackDialog(track) {
  const isNew = !track;
  const st = track
    ? { name: track.name, instrument: track.instrument, color: track.color }
    : { name: 'Track ' + (store.song.tracks.length + 1), instrument: 'piano', color: SECTION_COLORS[(store.song.tracks.length + 3) % SECTION_COLORS.length] };
  const m = modal(isNew ? 'New instrument track' : 'Edit track', h('div.col.gap', {},
    h('label.field', {}, 'Name', h('input.input', { value: st.name, onchange: e => st.name = e.target.value })),
    h('label.field', {}, 'Instrument',
      h('select.input', { onchange: e => st.instrument = e.target.value },
        Object.entries(INSTRUMENTS).map(([k, v]) => h('option', { value: k, selected: k === st.instrument }, v.label)))),
    h('div.row.between', {},
      !isNew ? h('button.btn.danger', {
        onclick: async () => {
          if (await confirmDlg('Delete track', `Delete "${track.name}" and its takes?`)) {
            await api.del(`/api/tracks/${track.id}`); await store.refreshSong(true); m.close();
          }
        },
      }, 'Delete') : h('span'),
      h('button.btn.primary', {
        onclick: async () => {
          try {
            if (isNew) {
              const created = await api.post(`/api/songs/${store.songId}/tracks`, st);
              store.ui.selectedTrackId = created.id;
            } else await api.patch(`/api/tracks/${track.id}`, st);
            await store.refreshSong(true);
            m.close();
          } catch (e) { toast(e.message, 'error'); }
        },
      }, isNew ? 'Add track' : 'Save'))));
}

export function structureDialog() {
  const ui = store.ui;
  const struct = (ui.draftStructure || (() => {
    const compId = ui.s2CompId;
    const comp = compId ? store.comp(compId) : null;
    return (comp?.payload.structure || store.song.sections.map(s => ({ sectionId: s.id, repeats: 1 }))).map(s => ({ ...s }));
  })());
  const box = h('div.col.gap-xs');
  const redraw = () => clear(box,
    struct.map((step, i) => {
      const sec = store.section(step.sectionId);
      return h('div.row.gap-xs.struct-row', {},
        h('span.struct-chip', { style: { background: (sec?.color || '#888') + '55', borderColor: sec?.color || '#888' } }, sec?.name || '?'),
        h('div.row.gap-xs', {},
          h('button.icon-btn.small', { disabled: i === 0, onclick: () => { [struct[i - 1], struct[i]] = [struct[i], struct[i - 1]]; redraw(); } }, '↑'),
          h('button.icon-btn.small', { disabled: i === struct.length - 1, onclick: () => { [struct[i + 1], struct[i]] = [struct[i], struct[i + 1]]; redraw(); } }, '↓'),
          h('button.icon-btn.small', { onclick: () => { step.repeats = Math.max(1, (step.repeats || 1) - 1); redraw(); } }, '−'),
          h('span.small', {}, `×${step.repeats || 1}`),
          h('button.icon-btn.small', { onclick: () => { step.repeats = (step.repeats || 1) + 1; redraw(); } }, '+'),
          h('button.icon-btn.small', { title: 'Remove from structure', onclick: () => { struct.splice(i, 1); redraw(); } }, icon('close', { size: 12 }))));
    }),
    h('div.row.gap-xs', {},
      h('select.input.small.add-sec', {}, store.song.sections.map(s => h('option', { value: s.id }, s.name))),
      h('button.btn.small', {
        onclick: () => {
          const sel = box.querySelector('.add-sec');
          struct.push({ sectionId: sel.value, repeats: 1 });
          redraw();
        },
      }, '+ Add')));
  redraw();
  const m = modal('Song structure', h('div.col.gap', {},
    h('p.dim.small', {}, 'Order the sections for the performance — repeats included. This is what plays as backing and what your Song comps store.'),
    box,
    h('div.row.end', {}, h('button.btn.primary', {
      onclick: () => { ui.draftStructure = struct; m.close(); store.emit(); },
    }, 'Use this structure'))));
}

export function copyToSectionDialog(take) {
  const m = modal('Copy take to section', h('div.col.gap', {},
    h('select.input.copy-target', {},
      store.song.sections.map(s => h('option', { value: s.id, selected: s.id !== take.laneId }, s.name))),
    h('div.row.end', {}, h('button.btn.primary', {
      onclick: async () => {
        const target = m.body.querySelector('.copy-target').value;
        try {
          await api.post(`/api/takes/${take.id}/duplicate`, { laneId: target, offsetBeats: 0, name: take.name + ' (copy)' });
          await store.refreshSong(true);
          m.close();
        } catch (e) { toast(e.message, 'error'); }
      },
    }, 'Copy'))));
}

export async function sendToSongDialog(take) {
  let home;
  try { home = await api.get('/api/home'); }
  catch (e) { return toast(e.message, 'error'); }
  const others = home.songs.filter(s => s.id !== store.songId);
  if (!others.length) return toast('No other songs yet — create one first', 'error');
  const sel = h('select.input', {},
    others.map(s => h('option', { value: s.id }, s.name)));
  const m = modal('Send to another song', h('div.col.gap', {},
    h('p.dim.small', {}, `"${take.name}" will land in that song's Pool as unplaced audio, ready to drag in. This song keeps its copy.`),
    h('label.field', {}, 'Destination song', sel),
    h('div.row.end', {}, h('button.btn.primary', {
      onclick: async () => {
        try {
          const r = await api.post(`/api/takes/${take.id}/send-to-song`, { songId: sel.value });
          m.close();
          toast(`Sent "${take.name}" to the Pool of "${r.songName}"`);
        } catch (e) { toast(e.message, 'error'); }
      },
    }, 'Send'))));
}

export function commentAt(beat) {
  const input = h('textarea.input', { rows: 3, placeholder: 'Pin a comment at this beat…' });
  const m = modal(`Comment at beat ${beat.toFixed(2)}`, h('div.col.gap', {},
    input,
    h('div.row.end', {}, h('button.btn.primary', {
      onclick: async () => {
        if (!input.value.trim()) return;
        try {
          await api.post(`/api/songs/${store.songId}/comments`, { stage: store.ui.stageView, beat, text: input.value.trim() });
          store.ui.pinMode = false;
          await store.refreshSong(true);
          m.close();
        } catch (e) { toast(e.message, 'error'); }
      },
    }, 'Pin comment'))));
  input.focus();
}
