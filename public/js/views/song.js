'use strict';
import { api } from '../api.js';
import { store } from '../store.js';
import { engine, BEAT_PATTERNS } from '../audio.js';
import { Timeline } from '../timeline.js';
import { h, clear, toast, busy, confirmDlg, avatar, menu, slider, fmtScore, icon } from '../ui.js';
import { renderPanel, panelTabs } from './panels.js';
import * as dialogs from './dialogs.js';

const STAGE_NAMES = { 1: '1 · Hum', 2: '2 · Song', 3: '3 · Arrange' };
let tl = null;
let rafId = null;
let recState = null;
let unsub = null;
let midiCache = null;
let clipboard = null;            // {takeId, cut}
const hist = { undo: [], redo: [] };
let keyHandler = null;
let seekTimer = null;

export async function renderSongView(root, songId) {
  if (unsub) { unsub(); unsub = null; }
  if (keyHandler) { document.removeEventListener('keydown', keyHandler); keyHandler = null; }
  engine.stop();
  clear(root, h('div.page-loading', {}, h('div.spinner')));
  try {
    await store.loadSong(songId);
  } catch (e) {
    toast(e.message, 'error');
    location.hash = '#/';
    return;
  }
  const ui = store.ui;
  ui.stageView = store.song.song.stage;
  ui.panel = 'comps';
  ui.selectedTakeId = null;
  ui.multiSel = new Set();
  ui.selectedSectionId = store.song.sections[0]?.id || null;
  ui.selectedTrackId = store.song.tracks[0]?.id || null;
  ui.listen = { type: 'mine', id: null };
  ui.playhead = 0;
  ui.draftStructure = null;
  ui.hearOthers = true;
  hist.undo.length = 0;
  hist.redo.length = 0;
  clipboard = null;
  midiCache = null;
  try {
    ui.savedView = JSON.parse(localStorage.getItem('humlab-zoom-' + songId) || 'null');
  } catch { ui.savedView = null; }

  const skel = h('div.songview', {},
    h('div.song-header'),
    h('div.transport'),
    h('div.workarea', {},
      h('div.main-col', {},
        h('div.tl-wrap', {}, h('canvas.tl-canvas')),
        h('div.inspector')),
      h('div.side-panel', {},
        h('div.panel-tabs'),
        h('div.panel-body'))));
  clear(root, skel);

  const canvas = skel.querySelector('canvas');
  tl = new Timeline(canvas, timelineCallbacks());
  if (ui.savedView) { tl.pxPerBeat = ui.savedView.pxPerBeat || 16; tl.scrollBeat = ui.savedView.scrollBeat || 0; }
  tl.cb.onViewChange = v => localStorage.setItem('humlab-zoom-' + songId, JSON.stringify(v));

  // drop a Pool voice note onto the timeline -> place a copy as a take
  canvas.addEventListener('dragover', e => {
    if ([...e.dataTransfer.types].includes('text/humlab-pool')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      canvas.classList.add('drop-target');
    }
  });
  canvas.addEventListener('dragleave', () => canvas.classList.remove('drop-target'));
  canvas.addEventListener('drop', e => {
    canvas.classList.remove('drop-target');
    const id = e.dataTransfer.getData('text/humlab-pool');
    if (!id) return;
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    const hitR = tl.hit(x, y);
    placePool(id, { beat: tl.beatAt(x), rowIndex: hitR.rowIndex });
  });

  keyHandler = e => onKey(e);
  document.addEventListener('keydown', keyHandler);

  unsub = store.sub(() => render(skel));
  render(skel);
  startPlayheadLoop();
  window.addEventListener('resize', onResize);
  function onResize() { if (store.songId === songId) { tl.layout(); tl.draw(); } else window.removeEventListener('resize', onResize); }
}

// ---------- helpers ----------

const spbOr = () => store.spb() || 0.5;
function absStart(t) {
  if (t.laneType === 'section') {
    const sec = store.section(t.laneId);
    return (sec ? sec.start_beat : 0) + t.offsetBeats;
  }
  return t.offsetBeats;
}
const lenBeats = t => (t.duration || 0) / spbOr();
const laneOrigin = (laneType, laneId) => laneType === 'section' ? (store.section(laneId)?.start_beat || 0) : 0;

function selectedTakes() {
  const ui = store.ui;
  const ids = ui.multiSel.size ? [...ui.multiSel] : (ui.selectedTakeId ? [ui.selectedTakeId] : []);
  return ids.map(id => store.take(id)).filter(Boolean);
}

function listenTakesForLane(stage, laneId) {
  const ui = store.ui;
  const mode = ui.listen;
  if (mode.type === 'comp') {
    const comp = store.comp(mode.id);
    if (comp && comp.stage === stage) {
      if (stage === 2) return (comp.payload.takeIds || []);
      return (comp.payload.selections && comp.payload.selections[laneId]) || [];
    }
    return [];
  }
  const userId = mode.type === 'user' ? mode.id : store.user.id;
  const picked = store.picksOf(userId, stage, laneId);
  if (picked.length) return picked;
  const ts = store.takesFor(stage, stage === 1 ? 'section' : stage === 2 ? 'perf' : 'track', laneId)
    .filter(t => !t.isSuggestion && !t.muted);
  return ts.length ? [ts[ts.length - 1].id] : [];
}

function currentStructure() {
  const ui = store.ui;
  if (ui.draftStructure) return ui.draftStructure;
  const comp = ui.s2CompId ? store.comp(ui.s2CompId) : null;
  if (comp && comp.payload.structure) return comp.payload.structure;
  return (store.song.sections || []).map(s => ({ sectionId: s.id, repeats: 1 }));
}

function structureSpans() {
  const out = [];
  let cursor = 0;
  for (const step of currentStructure()) {
    const sec = store.section(step.sectionId);
    if (!sec) continue;
    for (let r = 0; r < (step.repeats || 1); r++) {
      out.push({ sectionId: sec.id, name: sec.name + ((step.repeats || 1) > 1 ? ` ×${r + 1}` : ''), color: sec.color, start: cursor, len: sec.length_beats, srcStart: sec.start_beat });
      cursor += sec.length_beats;
    }
  }
  return out;
}

function s2SourceCompId() {
  const ui = store.ui;
  const comp = ui.s2CompId ? store.comp(ui.s2CompId) : null;
  return (comp && comp.payload.sourceCompId) || store.song.song.stage2_source_comp
    || store.compsFor(1)[0]?.id || null;
}

function backingGainS2() {
  const ui = store.ui;
  if (ui.s2BackingGain != null) return ui.s2BackingGain;
  const comp = ui.s2CompId ? store.comp(ui.s2CompId) : null;
  return comp && comp.payload.backingGain != null ? comp.payload.backingGain : 0.5;
}

// ---------- undo / redo ----------

function pushAction(a) { hist.undo.push(a); hist.redo.length = 0; }
async function doUndo() {
  const a = hist.undo.pop();
  if (!a) return toast('Nothing to undo');
  try { await a.undo(); hist.redo.push(a); await store.refreshSong(true); toast('Undid: ' + a.label); }
  catch (e) { toast(e.message, 'error'); }
}
async function doRedo() {
  const a = hist.redo.pop();
  if (!a) return toast('Nothing to redo');
  try { await a.redo(); hist.undo.push(a); await store.refreshSong(true); toast('Redid: ' + a.label); }
  catch (e) { toast(e.message, 'error'); }
}

// ---------- playback ----------

function buildItems(stage, { excludeLaneId = null, onlyTakeIds = null, backingOnly = false } = {}) {
  if (backingOnly) return [];
  const ui = store.ui;
  const items = [];
  const laneTakes = laneId => {
    // your click means what it says: a selected take overrides picks for its lane
    if (onlyTakeIds) return onlyTakeIds;
    if (ui.selectedTakeId) {
      const sel = store.take(ui.selectedTakeId);
      if (sel && sel.stage === stage && sel.laneId === laneId && !sel.muted) return [sel.id];
    }
    return listenTakesForLane(stage, laneId);
  };
  if (stage === 1) {
    for (const sec of store.song.sections) {
      if (excludeLaneId === sec.id) continue;
      for (const tid of laneTakes(sec.id)) {
        const t = store.take(tid);
        if (!t || t.muted || !t.fileId || t.laneId !== sec.id) continue;
        items.push({ fileId: t.fileId, atBeat: sec.start_beat + t.offsetBeats, gain: t.gain });
      }
    }
  } else if (stage === 2) {
    const srcId = s2SourceCompId();
    const src = srcId ? store.comp(srcId) : null;
    const backingGain = backingGainS2();
    if (src && backingGain > 0) {
      for (const span of structureSpans()) {
        for (const tid of (src.payload.selections && src.payload.selections[span.sectionId]) || []) {
          const t = store.take(tid);
          if (!t || t.muted || !t.fileId) continue;
          items.push({ fileId: t.fileId, atBeat: span.start + t.offsetBeats, gain: t.gain * backingGain });
        }
      }
    }
    if (excludeLaneId !== 'perf') {
      for (const tid of laneTakes('perf')) {
        const t = store.take(tid);
        if (!t || t.muted || !t.fileId) continue;
        items.push({ fileId: t.fileId, atBeat: t.offsetBeats, gain: t.gain });
      }
    }
  } else {
    for (const tr of store.song.tracks) {
      if (excludeLaneId === tr.id) continue;
      for (const tid of laneTakes(tr.id)) {
        const t = store.take(tid);
        if (!t || t.muted || !t.fileId || t.laneId !== tr.id) continue;
        items.push({ fileId: t.fileId, atBeat: t.offsetBeats, gain: t.gain });
      }
    }
  }
  return items;
}

async function midiNotes() {
  const s = store.song;
  if (!s.song.midi_file_id) return null;
  if (midiCache && midiCache.fileId === s.song.midi_file_id) return midiCache.notes;
  try {
    const res = await fetch(`/api/songs/${s.song.id}/midi`);
    const ab = await res.arrayBuffer();
    const { parseMidi } = await import('../midi.js');
    const parsed = parseMidi(ab);
    midiCache = { fileId: s.song.midi_file_id, notes: parsed.notes };
    return parsed.notes;
  } catch { return null; }
}

async function backingConfig() {
  const ui = store.ui;
  const song = store.song.song;
  return {
    bpb: store.bpb(),
    metronome: ui.backing.metronome,
    chordsOn: ui.backing.pad,
    chords: song.chords || [],
    beatPattern: ui.backing.beatPattern,
    midiOn: ui.backing.midi,
    midiNotes: ui.backing.midi ? await midiNotes() : null,
    clickGain: 0.9, padGain: 0.9, beatGain: 0.8, midiGain: 0.8,
  };
}

async function playFrom(fromBeat, { loop = false, endBeat = null, countIn = 0, items = null, excludeLaneId = null, backingOnly = false } = {}) {
  const ui = store.ui;
  const stage = ui.stageView;
  const end = endBeat != null ? endBeat
    : stage === 2 ? Math.max(...structureSpans().map(s => s.start + s.len), 4)
      : store.songLenBeats();
  await engine.play({
    spb: spbOr(),
    fromBeat, endBeat: Math.max(end, fromBeat + 1), loop,
    countInBeats: countIn,
    items: items || buildItems(stage, { excludeLaneId, backingOnly }),
    backing: await backingConfig(),
    onStop: atBeat => {
      if (atBeat != null && !recState) {
        store.ui.playhead = Math.max(0, atBeat);
        tl.setPlayhead(store.ui.playhead);
      }
      store.emit('play');
    },
  });
  store.emit('play');
}

function liveSeek(beat) {
  store.ui.playhead = Math.max(0, beat);
  tl.setPlayhead(store.ui.playhead);
  if (recState) return; // repositioning while recording would scramble the grid mapping
  if (engine.playing) {
    clearTimeout(seekTimer);
    seekTimer = setTimeout(() => { engine.seek(store.ui.playhead); }, 120);
  }
}

function startPlayheadLoop() {
  cancelAnimationFrame(rafId);
  const loop = () => {
    if (engine.playing) {
      const b = engine.currentBeat();
      if (b != null) tl.setPlayhead(Math.max(0, b));
    }
    rafId = requestAnimationFrame(loop);
  };
  rafId = requestAnimationFrame(loop);
}

// ---------- recording ----------

function recTarget() {
  const ui = store.ui;
  const stage = ui.stageView;
  const ph = Math.max(0, ui.playhead || 0);
  const snap = b => Math.round(b * 4) / 4;
  if (stage === 1) {
    const within = store.song.sections.find(s => ph >= s.start_beat - 1e-6 && ph < s.start_beat + s.length_beats - 1e-6);
    const sec = within || store.section(ui.selectedSectionId) || store.song.sections[0];
    if (!sec) return null;
    const fromBeat = within ? snap(ph) : sec.start_beat;
    return {
      laneType: 'section', laneId: sec.id, fromBeat,
      offsetBeats: fromBeat - sec.start_beat,
      name: `${sec.name} · take ${store.takesFor(1, 'section', sec.id).length + 1}`,
      secId: sec.id,
    };
  }
  if (stage === 2) {
    const fromBeat = snap(ph);
    return { laneType: 'perf', laneId: 'perf', fromBeat, offsetBeats: fromBeat, name: `Full run ${store.takesFor(2, 'perf', 'perf').length + 1}` };
  }
  const tr = store.song.tracks.find(t => t.id === ui.selectedTrackId) || store.song.tracks[0];
  if (!tr) return null;
  const fromBeat = snap(ph);
  return { laneType: 'track', laneId: tr.id, fromBeat, offsetBeats: fromBeat, name: `${tr.name} · take ${store.takesFor(3, 'track', tr.id).length + 1}` };
}

async function startRecord() {
  const ui = store.ui;
  if (!store.can('addTake')) return toast('Your role cannot record takes', 'error');
  const target = recTarget();
  if (!target) return toast(ui.stageView === 3 ? 'Add a track first' : 'Add a section first', 'error');
  if (target.secId) ui.selectedSectionId = target.secId;
  const hasTempo = !!store.song.song.bpm;
  const countIn = hasTempo ? store.bpb() : 0;
  let rec;
  try {
    rec = await engine.startRecording({ aec: ui.backing.aec });
  } catch (e) {
    return toast('Microphone unavailable: ' + e.message, 'error');
  }
  const recStartCtx = await rec.startedAt;
  let t0 = null;
  if (hasTempo) {
    // hear the full flow while recording — with the part being re-recorded muted
    await playFrom(target.fromBeat, {
      countIn,
      excludeLaneId: target.laneId,
      backingOnly: !ui.hearOthers,
    });
    t0 = engine.state ? engine.state.t0 : null;
  }
  recState = {
    ...target, rec, recStartCtx, t0,
    stage: ui.stageView, backing: { ...ui.backing }, startedWall: Date.now(),
  };
  store.emit('rec');
}

async function stopRecord() {
  if (!recState) return;
  const rs = recState;
  recState = null;
  engine.stop({ silent: true });
  const blob = await rs.rec.stop();
  store.ui.playhead = rs.fromBeat;
  store.emit('rec');
  if (Date.now() - rs.startedWall < 700) { toast('Recording too short — discarded'); return; }
  const b = busy('Processing your take…');
  try {
    const latency = (store.song.song.latency_ms || 0) / 1000;
    let trimHeadSec = 0;
    if (rs.t0 != null) trimHeadSec = Math.max(0, (rs.t0 - rs.recStartCtx) - latency);
    const meta = {
      stage: rs.stage, laneType: rs.laneType, laneId: rs.laneId,
      offsetBeats: rs.offsetBeats,
      name: rs.name, trimHeadSec,
      recCtx: {
        metronome: rs.backing.metronome, pad: rs.backing.pad,
        beatPattern: rs.backing.beatPattern, midi: rs.backing.midi,
        fromBeat: rs.fromBeat,
      },
    };
    const r = await api.upload(`/api/songs/${store.songId}/takes`, blob, {
      type: rs.rec.mime, query: { meta: JSON.stringify(meta), type: rs.rec.mime.split(';')[0] },
    });
    store.ui.selectedTakeId = r.take.id;
    store.ui.multiSel = new Set();
    await store.refreshSong(true);
    const flag = r.take.flags && r.take.flags.tempo;
    if (flag && flag.state === 'open') {
      toast(`Heads up: this take feels like ${Math.round(flag.detected)} BPM vs official ${Math.round(store.song.song.bpm)} — use the warning badge to resolve`, 'info');
    } else {
      toast('Take saved');
    }
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    b.close();
  }
}

// ---------- clipboard / delete / combine / swap ----------

async function softDelete(t) {
  await api.del(`/api/takes/${t.id}`);
}
async function restoreTake(id) {
  await api.post(`/api/takes/${id}/restore`, {});
}

async function deleteSelection() {
  const takes = selectedTakes().filter(t => {
    const own = t.authorId === store.user.id;
    return own ? store.can('editOwn') : store.can('deleteAny');
  });
  if (!takes.length) return toast('Nothing deletable selected', 'error');
  for (const t of takes) await softDelete(t);
  pushAction({
    label: takes.length > 1 ? `delete ${takes.length} takes` : `delete "${takes[0].name}"`,
    undo: async () => { for (const t of takes) await restoreTake(t.id); },
    redo: async () => { for (const t of takes) await softDelete(t); },
  });
  store.ui.selectedTakeId = null;
  store.ui.multiSel = new Set();
  await store.refreshSong(true);
  toast(`Deleted ${takes.length > 1 ? takes.length + ' takes' : '"' + takes[0].name + '"'} — Ctrl+Z to undo`);
}

function copySelection(cut = false) {
  const t = selectedTakes()[0];
  if (!t) return toast('Select a take first', 'error');
  clipboard = { takeId: t.id, cut };
  toast(cut ? 'Cut — paste to move it' : 'Copied');
}

async function pasteAtPlayhead() {
  if (!clipboard) return toast('Clipboard is empty', 'error');
  const src = store.take(clipboard.takeId);
  if (!src) { clipboard = null; return toast('Copied take no longer exists', 'error'); }
  const ui = store.ui;
  const ph = Math.round((ui.playhead || 0) * 4) / 4;
  let laneType = src.laneType, laneId = src.laneId, offset;
  if (src.laneType === 'section' && ui.stageView === 1) {
    const sec = store.song.sections.find(s => ph >= s.start_beat - 1e-6 && ph < s.start_beat + s.length_beats + 1e-6)
      || store.section(ui.selectedSectionId) || store.section(src.laneId);
    laneId = sec.id;
    offset = ph - sec.start_beat;
  } else {
    offset = ph;
  }
  try {
    if (clipboard.cut) {
      const before = { laneId: src.laneId, offsetBeats: src.offsetBeats };
      await api.patch(`/api/takes/${src.id}`, { laneId, laneType, offsetBeats: offset });
      pushAction({
        label: `move "${src.name}"`,
        undo: () => api.patch(`/api/takes/${src.id}`, { laneId: before.laneId, offsetBeats: before.offsetBeats }),
        redo: () => api.patch(`/api/takes/${src.id}`, { laneId, laneType, offsetBeats: offset }),
      });
      clipboard = null;
    } else {
      const r = await api.post(`/api/takes/${src.id}/duplicate`, { laneId, laneType, offsetBeats: offset, name: src.name + ' (copy)' });
      pushAction({
        label: `paste "${src.name}"`,
        undo: () => api.del(`/api/takes/${r.id}`),
        redo: () => restoreTake(r.id),
      });
      store.ui.selectedTakeId = r.id;
    }
    await store.refreshSong(true);
  } catch (e) { toast(e.message, 'error'); }
}

function overlaps(takes) {
  const rs = takes.map(t => [absStart(t), absStart(t) + lenBeats(t)]).sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < rs.length; i++) if (rs[i][0] < rs[i - 1][1] - 0.02) return true;
  return false;
}

async function combineSelection() {
  const takes = selectedTakes();
  if (takes.length < 2) return toast('Select 2+ takes to combine', 'error');
  if (takes.some(t => t.stage !== takes[0].stage)) return toast('Combine works within one stage', 'error');
  if (overlaps(takes)) return toast('Takes overlap — move them apart first, then combine', 'error');
  const b = busy('Combining…');
  try {
    const sorted = takes.slice().sort((a, b2) => absStart(a) - absStart(b2));
    const r = await api.post(`/api/songs/${store.songId}/flatten`, {
      takeIds: sorted.map(t => t.id),
      name: sorted.map(t => t.name).join(' + ').slice(0, 100),
      laneId: sorted[0].laneId, laneType: sorted[0].laneType, stage: sorted[0].stage,
    });
    for (const t of takes) await softDelete(t);
    pushAction({
      label: 'combine takes',
      undo: async () => { for (const t of takes) await restoreTake(t.id); await api.del(`/api/takes/${r.take.id}`); },
      redo: async () => { for (const t of takes) await softDelete(t); await restoreTake(r.take.id); },
    });
    store.ui.multiSel = new Set();
    store.ui.selectedTakeId = r.take.id;
    await store.refreshSong(true);
    toast('Combined into one take — Ctrl+Z to undo');
  } catch (e) { toast(e.message, 'error'); }
  finally { b.close(); }
}

async function flattenSelection() {
  const takes = selectedTakes();
  if (takes.length < 2) return toast('Select 2+ takes to flatten', 'error');
  const b = busy('Flattening (layer mix)…');
  try {
    const r = await api.post(`/api/songs/${store.songId}/flatten`, {
      takeIds: takes.map(t => t.id),
      name: 'Flatten of ' + takes.length,
      laneId: takes[0].laneId, laneType: takes[0].laneType, stage: takes[0].stage,
    });
    pushAction({
      label: 'flatten takes',
      undo: () => api.del(`/api/takes/${r.take.id}`),
      redo: () => restoreTake(r.take.id),
    });
    store.ui.multiSel = new Set();
    store.ui.selectedTakeId = r.take.id;
    await store.refreshSong(true);
    toast('Flattened into a new layered take (originals kept)');
  } catch (e) { toast(e.message, 'error'); }
  finally { b.close(); }
}

async function swapSelection() {
  const takes = selectedTakes();
  if (takes.length !== 2) return toast('Select exactly 2 takes to swap', 'error');
  const [a, b] = takes;
  const swap = async () => {
    const A = { laneId: a.laneId, laneType: a.laneType, offsetBeats: a.offsetBeats };
    const B = { laneId: b.laneId, laneType: b.laneType, offsetBeats: b.offsetBeats };
    await api.patch(`/api/takes/${a.id}`, B);
    await api.patch(`/api/takes/${b.id}`, A);
  };
  try {
    await swap();
    pushAction({ label: 'swap takes', undo: swap, redo: swap });
    await store.refreshSong(true);
    toast('Swapped positions');
  } catch (e) { toast(e.message, 'error'); }
}

// ---------- Pool placement ----------

// Place a Pool voice note onto the timeline at a beat (default: the needle).
// mode 'copy' keeps the original in the Pool; 'move' takes it out of the Pool.
async function placePool(takeId, { beat = null, rowIndex = null, mode = 'copy' } = {}) {
  const src = store.take(takeId);
  if (!src) return toast('Voice note not found', 'error');
  if (!store.can('addTake')) return toast('Your role cannot place takes', 'error');
  const ui = store.ui;
  const stage = ui.stageView;
  const at = Math.max(0, Math.round(((beat != null ? beat : ui.playhead) || 0) * 4) / 4);
  let laneType, laneId, offsetBeats;
  if (stage === 1) {
    const sec = store.song.sections.find(s => at >= s.start_beat - 1e-6 && at < s.start_beat + s.length_beats + 1e-6)
      || store.section(ui.selectedSectionId) || store.song.sections[0];
    if (!sec) return toast('Create a part first', 'error');
    laneType = 'section'; laneId = sec.id; offsetBeats = Math.max(0, at - sec.start_beat);
    ui.selectedSectionId = sec.id;
  } else if (stage === 2) {
    laneType = 'perf'; laneId = 'perf'; offsetBeats = at;
  } else {
    const m = buildModel();
    const laneFromRow = rowIndex != null && m.rows[rowIndex] ? m.rows[rowIndex].laneId : null;
    const tr = store.song.tracks.find(t => t.id === (laneFromRow || ui.selectedTrackId)) || store.song.tracks[0];
    if (!tr) return toast('Add a track first', 'error');
    laneType = 'track'; laneId = tr.id; offsetBeats = at;
    ui.selectedTrackId = tr.id;
  }
  try {
    let placedId;
    if (mode === 'move') {
      const before = { stage: src.stage, laneType: src.laneType, laneId: src.laneId, offsetBeats: src.offsetBeats };
      await api.patch(`/api/takes/${src.id}`, { stage, laneType, laneId, offsetBeats });
      pushAction({
        label: `move "${src.name}" out of the Pool`,
        undo: () => api.patch(`/api/takes/${src.id}`, before),
        redo: () => api.patch(`/api/takes/${src.id}`, { stage, laneType, laneId, offsetBeats }),
      });
      placedId = src.id;
    } else {
      const r = await api.post(`/api/takes/${src.id}/duplicate`, {
        stage, laneType, laneId, offsetBeats, name: src.name,
      });
      pushAction({
        label: `place "${src.name}"`,
        undo: () => api.del(`/api/takes/${r.id}`),
        redo: () => restoreTake(r.id),
      });
      placedId = r.id;
    }
    ui.selectedTakeId = placedId;
    ui.multiSel = new Set();
    await store.refreshSong(true);
    toast(mode === 'move' ? `Moved "${src.name}" onto the timeline` : `Placed "${src.name}" — the Pool keeps the original`);
  } catch (e) { toast(e.message, 'error'); }
}

// ---------- keyboard ----------

function onKey(e) {
  if (!store.song) return;
  const tgt = e.target;
  if (tgt && (tgt.matches('input, textarea, select, [contenteditable]'))) return;
  if (document.querySelector('.modal-overlay')) return;
  const mod = e.ctrlKey || e.metaKey;
  if (e.code === 'Space') {
    e.preventDefault();
    if (recState) return stopRecord();
    if (engine.playing) engine.stop();
    else playFrom(store.ui.playhead || 0, { loop: !!store.ui.loop });
    return;
  }
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (selectedTakes().length) { e.preventDefault(); deleteSelection(); }
    return;
  }
  if (e.key === 'Escape') {
    store.ui.selectedTakeId = null;
    store.ui.multiSel = new Set();
    store.emit();
    return;
  }
  if (!mod) return;
  const k = e.key.toLowerCase();
  if (k === 'z' && !e.shiftKey) { e.preventDefault(); doUndo(); }
  else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); doRedo(); }
  else if (k === 'c') { if (selectedTakes().length) { e.preventDefault(); copySelection(false); } }
  else if (k === 'x') { if (selectedTakes().length) { e.preventDefault(); copySelection(true); } }
  else if (k === 'v') { e.preventDefault(); pasteAtPlayhead(); }
}

// ---------- timeline model ----------

function buildModel() {
  const ui = store.ui;
  const stage = ui.stageView;
  const s = store.song;
  const usersById = store.usersById();
  const isSel = id => ui.selectedTakeId === id || ui.multiSel.has(id);
  const badge = t => ({
    flag: t.flags && t.flags.tempo && t.flags.tempo.state === 'open',
    notes: !!t.notes,
    sugg: t.isSuggestion,
    pick: listenTakesForLane(stage, t.laneId).includes(t.id),
  });
  const mkClip = (t, start) => ({
    id: t.id, start, len: Math.max(0.25, lenBeats(t)),
    color: (usersById[t.authorId] || {}).color || '#8a9aa8',
    peaks: t.peaks, name: t.name, muted: t.muted,
    selected: isSel(t.id), badges: badge(t), take: t,
  });
  let sections = [], rows = [], loop = null, totalBeats = store.songLenBeats();
  if (stage === 1) {
    sections = s.sections.map(x => ({ id: x.id, name: x.name, start: x.start_beat, len: x.length_beats, color: x.color, raw: x }));
    const stacks = [];
    for (const sec of s.sections) {
      const ts = store.takesFor(1, 'section', sec.id);
      ts.forEach((t, i) => {
        if (!stacks[i]) stacks[i] = { laneId: null, clips: [] };
        stacks[i].clips.push(mkClip(t, sec.start_beat + t.offsetBeats));
      });
    }
    rows = stacks.length ? stacks : [{ laneId: null, clips: [] }];
    const sel = store.section(ui.selectedSectionId);
    if (sel) loop = { start: sel.start_beat, end: sel.start_beat + sel.length_beats };
  } else if (stage === 2) {
    const spans = structureSpans();
    sections = spans.map((sp, i) => ({ id: 'span' + i, name: sp.name, start: sp.start, len: sp.len, color: sp.color, span: sp }));
    totalBeats = Math.max(...spans.map(x => x.start + x.len), 8);
    const perfs = store.takesFor(2, 'perf', 'perf');
    rows = perfs.length ? perfs.map(t => ({ laneId: 'perf', clips: [mkClip(t, t.offsetBeats)] })) : [{ laneId: 'perf', clips: [] }];
  } else {
    sections = s.sections.map(x => ({ id: x.id, name: x.name, start: x.start_beat, len: x.length_beats, color: x.color, raw: x, ghost: true }));
    rows = s.tracks.map(tr => ({
      laneId: tr.id, label: `${tr.name} · ${tr.instrument}${ui.selectedTrackId === tr.id ? '  ●' : ''}`,
      clips: store.takesFor(3, 'track', tr.id).map(t => mkClip(t, t.offsetBeats)),
    }));
    if (!rows.length) rows = [{ laneId: null, clips: [] }];
  }
  const pins = (s.comments || [])
    .filter(c => c.stage === stage && c.beat != null)
    .map(c => ({ id: c.id, beat: c.beat, resolved: c.resolved }));
  const nextPartLabel = 'Part ' + String.fromCharCode(65 + (s.sections.length % 26));
  return {
    bpb: store.bpb(), totalBeats: totalBeats + 4, sections, rows, pins, loop, nextPartLabel,
    canEdit: store.can('editContent') && stage === 1,
    canDragClips: store.can('editOwn'),
  };
}

function timelineCallbacks() {
  return {
    onSeek: beat => liveSeek(beat),
    onSectionClick: sec => {
      if (store.ui.stageView === 1) {
        store.ui.selectedSectionId = sec.id;
        store.emit();
      }
    },
    onSectionDbl: sec => { if (sec.raw && store.can('editContent')) dialogs.sectionDialog(sec.raw); },
    onSectionChange: async (sec, change) => {
      if (!sec.raw || !store.can('editContent')) return store.refreshSong(true);
      const before = { startBeat: sec.raw.start_beat, lengthBeats: sec.raw.length_beats };
      const after = {
        startBeat: change.start != null ? change.start : before.startBeat,
        lengthBeats: change.len != null ? change.len : before.lengthBeats,
      };
      try {
        await api.patch(`/api/sections/${sec.id}`, after);
        pushAction({
          label: `move "${sec.raw.name}"`,
          undo: () => api.patch(`/api/sections/${sec.id}`, before),
          redo: () => api.patch(`/api/sections/${sec.id}`, after),
        });
        await store.refreshSong(true);
      } catch (e) { toast(e.message, 'error'); store.refreshSong(true); }
    },
    onAddSection: beat => {
      if (!store.can('editContent')) return;
      dialogs.sectionDialog(null, beat);
    },
    onClipClick: (clip, e) => {
      const ui = store.ui;
      const multi = e && (e.shiftKey || e.ctrlKey || e.metaKey);
      if (multi) {
        if (!ui.multiSel.size && ui.selectedTakeId && ui.selectedTakeId !== clip.id) ui.multiSel.add(ui.selectedTakeId);
        ui.multiSel.has(clip.id) ? ui.multiSel.delete(clip.id) : ui.multiSel.add(clip.id);
        ui.selectedTakeId = null;
      } else {
        ui.multiSel = new Set();
        ui.selectedTakeId = clip.id === ui.selectedTakeId ? null : clip.id;
      }
      const t = store.take(clip.id);
      if (t && t.laneType === 'section') ui.selectedSectionId = t.laneId;
      if (t && t.laneType === 'track') ui.selectedTrackId = t.laneId;
      store.emit();
    },
    onClipDbl: clip => {
      const t = store.take(clip.id);
      if (!t) return;
      store.ui.multiSel = new Set();
      store.ui.selectedTakeId = t.id;
      store.emit();
      auditionTake(t);
    },
    onClipMenu: (clip, x, y) => {
      const t = store.take(clip.id);
      if (!t) return;
      const ui = store.ui;
      if (!ui.multiSel.has(t.id)) {
        ui.multiSel = new Set();
        ui.selectedTakeId = t.id;
      }
      store.emit();
      const anchor = h('span', { style: { position: 'fixed', left: x + 'px', top: y + 'px' } });
      document.body.append(anchor);
      if (selectedTakes().length > 1) multiMenu(anchor);
      else takeMenu(t, anchor);
      setTimeout(() => anchor.remove(), 100);
    },
    onClipMove: async (clip, newStart, newRow, oldRow) => {
      const t = store.take(clip.id);
      if (!t) return;
      const own = t.authorId === store.user.id;
      if (!(own ? store.can('editOwn') : store.can('editContent'))) { toast('Your role cannot move this take', 'error'); return store.refreshSong(true); }
      const before = { laneId: t.laneId, offsetBeats: t.offsetBeats };
      let after;
      try {
        if (t.laneType === 'section') {
          const target = store.song.sections.find(sx => newStart >= sx.start_beat - 0.001 && newStart < sx.start_beat + sx.length_beats + 0.999)
            || store.section(t.laneId);
          after = { laneId: target.id, offsetBeats: newStart - target.start_beat };
        } else if (t.laneType === 'track') {
          const m = buildModel();
          const targetLane = (m.rows[newRow] && m.rows[newRow].laneId) || t.laneId;
          after = { laneId: targetLane, offsetBeats: Math.max(0, newStart) };
        } else {
          after = { offsetBeats: Math.max(0, newStart) };
        }
        void oldRow;
        await api.patch(`/api/takes/${t.id}`, after);
        pushAction({
          label: `move "${t.name}"`,
          undo: () => api.patch(`/api/takes/${t.id}`, before),
          redo: () => api.patch(`/api/takes/${t.id}`, after),
        });
        await store.refreshSong(true);
      } catch (e) { toast(e.message, 'error'); store.refreshSong(true); }
    },
    onPinClick: pin => {
      store.ui.panel = 'comments';
      store.ui.focusComment = pin.id;
      store.emit();
    },
    onEmptyClick: (beat, row) => {
      if (store.ui.pinMode && store.can('comment')) {
        dialogs.commentAt(beat);
        return;
      }
      store.ui.selectedTakeId = null;
      store.ui.multiSel = new Set();
      if (store.ui.stageView === 3 && row && row.laneId) store.ui.selectedTrackId = row.laneId;
      liveSeek(beat);
      store.emit();
    },
  };
}

// Positioned solo play: needle runs at the take's real place on the timeline.
async function auditionTake(t, { withBacking = false } = {}) {
  const from = absStart(t);
  const end = from + Math.max(0.25, lenBeats(t));
  store.ui.playhead = from;
  tl.setPlayhead(from);
  if (withBacking && t.recCtx && store.spb()) {
    const rc = t.recCtx;
    const saved = { ...store.ui.backing };
    store.ui.backing = { ...store.ui.backing, metronome: !!rc.metronome, pad: !!rc.pad, beatPattern: rc.beatPattern || null, midi: !!rc.midi };
    await playFrom(from, { endBeat: end, items: [{ fileId: t.fileId, atBeat: from, gain: t.gain }] });
    store.ui.backing = saved;
  } else {
    await playFrom(from, { endBeat: end, items: [{ fileId: t.fileId, atBeat: from, gain: t.gain }] });
  }
}

// ---------- take menus ----------

function multiMenu(anchorEl) {
  const takes = selectedTakes();
  const laps = overlaps(takes);
  menu(anchorEl, [
    { label: `Combine ${takes.length} into one`, icon: icon('combine'), disabled: laps || takes.length < 2, action: combineSelection },
    laps ? { label: 'Takes overlap — move apart to combine', icon: icon('warning'), disabled: true } : null,
    { label: 'Flatten (layer mix, keep originals)', icon: icon('layers'), action: flattenSelection },
    takes.length === 2 ? { label: 'Swap positions', icon: icon('swap'), action: swapSelection } : null,
    '-',
    { label: 'Delete selected', icon: icon('trash'), danger: true, action: deleteSelection },
    { label: 'Clear selection', icon: icon('close'), action: () => { store.ui.multiSel = new Set(); store.ui.selectedTakeId = null; store.emit(); } },
  ]);
}

function takeMenu(t, anchorEl) {
  const own = t.authorId === store.user.id;
  const canEdit = own ? store.can('editOwn') : store.can('editContent');
  const canProc = store.can('process') || (own && store.can('editOwn'));
  const sec = t.laneType === 'section' ? store.section(t.laneId) : null;
  menu(anchorEl, [
    { label: 'Play (solo)', icon: icon('play'), action: () => auditionTake(t) },
    t.recCtx && (t.recCtx.metronome || t.recCtx.pad || t.recCtx.beatPattern || t.recCtx.midi)
      ? { label: 'Play with recorded backing', icon: icon('headphones'), action: () => auditionTake(t, { withBacking: true }) } : null,
    '-',
    canEdit ? { label: 'Copy', icon: icon('copy'), action: () => { store.ui.selectedTakeId = t.id; copySelection(false); } } : null,
    canEdit ? { label: 'Cut', icon: icon('scissors'), action: () => { store.ui.selectedTakeId = t.id; copySelection(true); } } : null,
    '-',
    canProc ? { label: 'Effects…', icon: icon('fx'), action: () => dialogs.fxDialog(t) } : null,
    canProc ? { label: 'Match tempo/pitch…', icon: icon('magnet'), action: () => dialogs.matchDialog(t) } : null,
    canProc ? { label: 'Note correction…', icon: icon('note'), action: () => dialogs.noteCorrectionDialog(t) } : null,
    canProc && sec ? {
      label: `Stretch to fit section (${sec.length_beats} beats)`, icon: icon('grid'),
      action: async () => {
        const b = busy('Stretching…');
        try { await api.post(`/api/takes/${t.id}/process`, { op: 'stretch-to-beats', params: { beats: sec.length_beats } }); await store.refreshSong(true); toast('Stretched to section'); }
        catch (e) { toast(e.message, 'error'); } finally { b.close(); }
      },
    } : null,
    t.flags && t.flags.tempo && t.flags.tempo.state === 'open'
      ? { label: 'Resolve tempo flag…', icon: icon('warning'), action: () => dialogs.tempoIntentDialog(t) } : null,
    '-',
    canEdit ? {
      label: 'Split at playhead', icon: icon('scissors'),
      action: async () => {
        const at = (store.ui.playhead || 0) - absStart(t);
        const atSec = at * spbOr();
        if (atSec <= 0.05 || atSec >= (t.duration || 0) - 0.05) return toast('Put the playhead inside the take first', 'error');
        const b = busy('Splitting…');
        try { await api.post(`/api/takes/${t.id}/split`, { atSec }); await store.refreshSong(true); }
        catch (e) { toast(e.message, 'error'); } finally { b.close(); }
      },
    } : null,
    store.can('editContent') ? {
      label: 'Duplicate', icon: icon('copy'),
      action: async () => {
        const r = await api.post(`/api/takes/${t.id}/duplicate`, {});
        pushAction({ label: 'duplicate take', undo: () => api.del(`/api/takes/${r.id}`), redo: () => restoreTake(r.id) });
        store.refreshSong(true);
      },
    } : null,
    store.can('editContent') && t.laneType === 'section' ? {
      label: 'Copy to section…', icon: icon('copy'),
      action: () => dialogs.copyToSectionDialog(t),
    } : null,
    '-',
    { label: 'Send to another song’s Pool…', icon: icon('archive'), action: () => dialogs.sendToSongDialog(t) },
    { label: 'Download WAV', icon: icon('download'), action: () => { window.open(`/api/files/${t.fileId}/wav`, '_blank'); } },
    t.historyLen > 0 && canEdit ? {
      label: `Undo last audio edit (${t.historyLen})`, icon: icon('undo'),
      action: async () => { try { await api.post(`/api/takes/${t.id}/revert`, {}); await store.refreshSong(true); toast('Reverted'); } catch (e) { toast(e.message, 'error'); } },
    } : null,
    (own ? store.can('editOwn') : store.can('deleteAny')) ? {
      label: 'Delete take', icon: icon('trash'), danger: true,
      action: () => { store.ui.selectedTakeId = t.id; store.ui.multiSel = new Set(); deleteSelection(); },
    } : null,
  ]);
}

// ---------- rendering ----------

function render(skel) {
  if (!store.song) return;
  renderHeader(skel.querySelector('.song-header'));
  renderTransport(skel.querySelector('.transport'));
  tl.update(buildModel());
  tl.setPlayhead(store.ui.playhead || 0);
  renderInspector(skel.querySelector('.inspector'));
  clear(skel.querySelector('.panel-tabs'), panelTabs());
  renderPanel(skel.querySelector('.panel-body'), { auditionTake, playFrom, structureSpans, currentStructure, s2SourceCompId, placePool, pushAction });
}

function renderHeader(el) {
  const s = store.song;
  const song = s.song;
  const membersUsers = (s.members || []).map(m => store.usersById()[m.user_id]).filter(Boolean).slice(0, 5);
  clear(el,
    h('div.row.gap-s.grow.min0', {},
      h('button.icon-btn', { title: 'Back to songs', onclick: () => { location.hash = '#/'; } }, icon('back')),
      h('div.song-name.ellip', {
        title: song.name + (store.can('editSettings') ? ' — click for settings' : ''),
        onclick: () => { if (store.can('editSettings')) dialogs.settingsDialog(); },
      }, song.name)),
    h('div.stage-tabs', {},
      [1, 2, 3].map(st => h(`button.stage-tab${store.ui.stageView === st ? '.active' : ''}${song.stage === st ? '.official' : ''}`, {
        onclick: () => { store.ui.stageView = st; store.ui.selectedTakeId = null; store.ui.multiSel = new Set(); engine.stop(); store.emit(); },
        title: song.stage === st ? 'Official current stage' : 'Open this stage',
      }, STAGE_NAMES[st], song.stage === st ? h('span.official-dot') : null))),
    h('div.row.gap-s', {},
      h('div.avatars', {}, membersUsers.map(u => avatar(u, 22))),
      store.can('manageMembers')
        ? h('button.btn.small', { title: 'Invite members', onclick: () => { store.ui.panel = 'members'; store.emit(); } }, 'Invite')
        : null,
      h('button.icon-btn', {
        title: 'Song menu',
        onclick: e => menu(e.currentTarget, [
          store.can('editSettings') ? { label: 'Song settings…', icon: icon('gear'), action: () => dialogs.settingsDialog() } : null,
          { label: 'Export current listen mix (WAV)', icon: icon('download'), action: exportListen },
          '-',
          store.can('deleteSong') ? {
            label: 'Delete song', icon: icon('trash'), danger: true,
            action: async () => {
              if (await confirmDlg('Delete song', `Delete "${song.name}" and all its takes? This cannot be undone.`)) {
                await api.del(`/api/songs/${song.id}`);
                location.hash = '#/';
              }
            },
          } : null,
        ]),
      }, icon('more'))));
}

async function exportListen() {
  const stage = store.ui.stageView;
  const payload = {};
  if (stage === 1) {
    payload.selections = {};
    for (const sec of store.song.sections) payload.selections[sec.id] = listenTakesForLane(1, sec.id);
  } else if (stage === 2) {
    payload.sourceCompId = s2SourceCompId();
    payload.structure = currentStructure();
    payload.takeIds = listenTakesForLane(2, 'perf');
    payload.backingGain = backingGainS2();
  } else {
    payload.sourceCompId = store.song.song.stage3_source_comp;
    payload.selections = {};
    for (const tr of store.song.tracks) payload.selections[tr.id] = listenTakesForLane(3, tr.id);
  }
  if (!store.can('createComp')) return toast('Contributors and up can export mixes', 'error');
  const b = busy('Rendering mix…');
  try {
    const comp = await api.post(`/api/songs/${store.songId}/comps`, { stage, name: '(export) ' + new Date().toLocaleString(), payload });
    window.open(`/api/comps/${comp.id}/render?format=wav`, '_blank');
    setTimeout(() => api.del(`/api/comps/${comp.id}`).then(() => store.refreshSong(true)).catch(() => {}), 30000);
  } catch (e) { toast(e.message, 'error'); }
  finally { b.close(); }
}

function renderTransport(el) {
  const ui = store.ui;
  const song = store.song.song;
  const stage = ui.stageView;
  const playing = engine.playing && !recState;

  const listenOptions = [
    h('option', { value: 'mine' }, 'My picks'),
    (store.song.users || []).filter(u => u.id !== store.user.id).map(u =>
      h('option', { value: 'user:' + u.id }, `${u.name}'s picks`)),
    store.compsFor(stage).map(c => h('option', { value: 'comp:' + c.id }, `Comp: ${c.name}`)),
  ];
  const listenVal = ui.listen.type === 'mine' ? 'mine' : `${ui.listen.type}:${ui.listen.id}`;

  const chip = (key, ic, title) => h(`button.chip${ui.backing[key] ? '.on' : ''}`, {
    title,
    onclick: () => { ui.backing[key] = !ui.backing[key]; store.emit(); },
  }, icon(ic));

  clear(el,
    h('div.row.gap-s.transport-main', {},
      recState
        ? h('button.btn.rec-live', { title: 'Stop and save the recording (Space)', onclick: stopRecord }, h('span.rec-dot'), 'Stop & save')
        : h('button.btn.record', {
          title: stage === 1 ? 'Record a take at the playhead into its section (1 bar count-in)' : stage === 2 ? 'Record a full-song performance from the playhead' : 'Record onto the selected track from the playhead',
          onclick: startRecord,
          disabled: !store.can('addTake'),
        }, icon('record')),
      h('button.btn.play', {
        title: playing ? 'Stop (Space)' : 'Play from the playhead (Space)',
        onclick: () => {
          if (playing) { engine.stop(); return; }
          playFrom(ui.playhead || 0, { loop: !!ui.loop });
        },
      }, icon(playing ? 'stop' : 'play')),
      h(`button.chip${ui.loop ? '.on' : ''}`, {
        title: 'Loop playback', onclick: () => { ui.loop = !ui.loop; store.emit(); },
      }, icon('loop')),
      stage === 1 && store.section(ui.selectedSectionId) ? h('button.chip', {
        title: 'Play the selected section from its start',
        onclick: () => {
          const sec = store.section(ui.selectedSectionId);
          liveSeek(sec.start_beat);
          playFrom(sec.start_beat, { loop: ui.loop, endBeat: sec.start_beat + sec.length_beats });
        },
      }, icon('play'), h('span.chip-label', {}, 'section')) : null,
      tempoWidget(),
      h('div.grow'),
      h('div.backing-chips.row.gap-xs', {},
        chip('metronome', 'metronome', 'Metronome click while playing/recording'),
        chip('pad', 'piano', 'Chord pad backing (set chords in Settings)'),
        h(`button.chip${ui.backing.beatPattern ? '.on' : ''}`, {
          title: 'Drum beat backing',
          onclick: e => menu(e.currentTarget, [
            { label: 'No beat', action: () => { ui.backing.beatPattern = null; store.emit(); } },
            ...Object.entries(BEAT_PATTERNS).map(([k, p]) => ({
              label: (ui.backing.beatPattern === k ? '● ' : '') + p.label,
              action: () => { ui.backing.beatPattern = k; store.emit(); },
            })),
          ]),
        }, icon('drum')),
        song.midi_file_id ? chip('midi', 'midi', 'MIDI backing track') : null,
        chip('aec', 'clean', 'Backing bleed removal while recording (echo cancellation): removes what the app plays from your mic. Re-add the same backing later from the original sources, not the bleed.'),
        h(`button.chip${ui.hearOthers ? '.on' : ''}`, {
          title: 'Hear the other parts while recording (the part you are re-recording stays muted)',
          onclick: () => { ui.hearOthers = !ui.hearOthers; store.emit(); },
        }, icon('headphones'))),
      h('select.input.small.listen-as', {
        title: 'Choose whose picks (or which comp) you hear',
        value: listenVal,
        onchange: e => {
          const v = e.target.value;
          ui.listen = v === 'mine' ? { type: 'mine', id: null } : { type: v.split(':')[0], id: v.split(':').slice(1).join(':') };
          ui.selectedTakeId = null;
          store.emit();
        },
      }, listenOptions),
      h('div.zoom-ctl.row.gap-xs', {},
        h('button.icon-btn', { onclick: () => tl.setZoom(tl.pxPerBeat * 0.8), title: 'Zoom out (Ctrl+scroll)' }, icon('zoomOut')),
        h('button.icon-btn', { onclick: () => tl.setZoom(tl.pxPerBeat * 1.25), title: 'Zoom in (Ctrl+scroll)' }, icon('zoomIn'))),
      h(`button.chip${ui.pinMode ? '.on' : ''}`, {
        title: 'Pin-comment mode: click anywhere on the timeline to pin a comment at that beat',
        onclick: () => { ui.pinMode = !ui.pinMode; store.emit(); },
      }, icon('pin'))),
    recState ? recIndicator() : null,
    stage === 2 ? s2Toolbar() : null,
    stage === 3 ? s3Toolbar() : null);
}

function recIndicator() {
  const el = h('div.rec-banner', {},
    h('span.rec-dot'), ` Recording ${recState.name} — hum away`,
    h('canvas.level-meter', { width: 120, height: 10 }));
  const cv = el.querySelector('canvas');
  const cx = cv.getContext('2d');
  const loop = () => {
    if (!recState) return;
    const lvl = recState.rec.level();
    cx.clearRect(0, 0, 120, 10);
    cx.fillStyle = lvl > 0.9 ? '#e8595c' : '#5fbf6e';
    cx.fillRect(0, 0, lvl * 120, 10);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  return el;
}

function tempoWidget() {
  const song = store.song.song;
  if (song.bpm) {
    const flagged = (store.song.takes || []).filter(t => t.flags && t.flags.tempo && t.flags.tempo.state === 'open');
    return h('div.tempo-widget', {
      onclick: () => { if (store.can('editSettings')) dialogs.settingsDialog(); },
      title: 'Official tempo and meter' + (store.can('editSettings') ? ' — click to edit' : ''),
    },
      h('b', {}, Math.round(song.bpm) + ' BPM'),
      h('span.dim', {}, ` · ${song.beats_per_bar || 4}/4`),
      flagged.length ? h('span.flag-badge', {
        title: `${flagged.length} take(s) look off-tempo — click to resolve`,
        onclick: e => {
          e.stopPropagation();
          store.ui.selectedTakeId = flagged[0].id;
          store.emit();
          dialogs.tempoIntentDialog(flagged[0]);
        },
      }, icon('warning', { size: 13 }), String(flagged.length)) : null);
  }
  return h('div.tempo-widget.sensing', {
    onclick: () => dialogs.tempoSenseDialog(),
    title: 'Tempo Sense: the app detects your tempo from your hums. Click for status.',
  }, h('span.pulse'), 'Tempo Sense…');
}

function s2Toolbar() {
  const ui = store.ui;
  const s1comps = store.compsFor(1);
  const srcId = s2SourceCompId();
  return h('div.row.gap-s.subtoolbar.wrap', {},
    h('span.small.dim', {}, 'Source comp:'),
    h('select.input.small', {
      title: 'Which Hum-stage comp this Song stage builds on',
      value: srcId || '',
      onchange: async e => {
        if (store.can('setStage')) {
          try { await api.patch(`/api/songs/${store.songId}`, { stage2SourceComp: e.target.value }); await store.refreshSong(true); } catch (err) { toast(err.message, 'error'); }
        } else { toast('Admins set the official source; build your own Song comp instead', 'info'); }
      },
    },
      s1comps.length ? s1comps.map(c => {
        const votes = store.votesFor(c.id);
        const avg = votes.length ? votes.reduce((a, v) => a + v.score, 0) / votes.length : null;
        return h('option', { value: c.id, selected: c.id === srcId }, `${c.name}${avg ? ` · ${fmtScore(avg)}` : ''}`);
      }) : h('option', { value: '' }, 'No Hum-stage comps yet')),
    h('button.btn.small', { title: 'Section order and repeats for the performance', onclick: () => dialogs.structureDialog() }, 'Structure'),
    slider({
      label: 'backing', min: 0, max: 1, step: 0.05,
      value: backingGainS2(),
      fmt: v => Math.round(v * 100) + '%',
      oninput: v => { ui.s2BackingGain = v; },
    }));
}

function s3Toolbar() {
  const s2comps = store.compsFor(2);
  const srcId = store.song.song.stage3_source_comp || s2comps[0]?.id;
  return h('div.row.gap-s.subtoolbar.wrap', {},
    h('span.small.dim', {}, 'Source song comp:'),
    h('select.input.small', {
      title: 'Which Song-stage comp this arrangement builds on',
      value: srcId || '',
      onchange: async e => {
        if (store.can('setStage')) {
          try { await api.patch(`/api/songs/${store.songId}`, { stage3SourceComp: e.target.value }); await store.refreshSong(true); } catch (err) { toast(err.message, 'error'); }
        } else toast('Admins set the official source comp', 'info');
      },
    },
      s2comps.length ? s2comps.map(c => {
        const votes = store.votesFor(c.id);
        const avg = votes.length ? votes.reduce((a, v) => a + v.score, 0) / votes.length : null;
        return h('option', { value: c.id, selected: c.id === srcId }, `${c.name}${avg ? ` · ${fmtScore(avg)}` : ''}`);
      }) : h('option', { value: '' }, 'No Song-stage comps yet')),
    store.can('editContent') ? h('button.btn.small', { title: 'Add an instrument track', onclick: () => dialogs.trackDialog(null) }, '+ Track') : null,
    store.ui.selectedTrackId ? h('button.btn.small', {
      title: 'Edit the selected track',
      onclick: () => {
        const tr = store.song.tracks.find(x => x.id === store.ui.selectedTrackId);
        if (tr) dialogs.trackDialog(tr);
      },
    }, 'Track…') : null,
    store.can('editContent') && store.ui.selectedTrackId ? h('button.btn.small', {
      title: 'Generate clean instrument audio from a note-corrected take',
      onclick: () => dialogs.generateDialog(store.ui.selectedTrackId),
    }, 'Generate') : null);
}

function renderInspector(el) {
  const multi = selectedTakes();
  if (multi.length > 1) return renderMultiInspector(el, multi);
  const t = store.take(store.ui.selectedTakeId);
  if (!t) {
    const stage = store.ui.stageView;
    const hint = stage === 1
      ? 'Select a section and hit record — the take starts at the playhead. Click a take to select; double-click to solo it; right-click for all actions; Shift-click to multi-select.'
      : stage === 2 ? 'Pick the source comp, set the structure, then record full-song runs from the playhead. Star your favorite and save Song comps for voting.'
        : 'Add instrument tracks, generate lines from note-corrected takes, record real audio, then save Mixes for voting.';
    clear(el, h('div.inspector-hint.dim.small', {}, hint));
    return;
  }
  const author = store.usersById()[t.authorId];
  const own = t.authorId === store.user.id;
  const canEdit = own ? store.can('editOwn') : store.can('editContent');
  const flag = t.flags && t.flags.tempo && t.flags.tempo.state === 'open' ? t.flags.tempo : null;
  const picked = store.myPicks(t.stage, t.laneId).includes(t.id);
  clear(el,
    flag ? h('div.flag-banner', {},
      h('span.row.gap-xs', {}, icon('warning', { size: 14 }), ` Feels like ${Math.round(flag.detected)} BPM vs official ${Math.round(store.song.song.bpm)}.`),
      h('button.btn.small', { title: 'Choose what you intended', onclick: () => dialogs.tempoIntentDialog(t) }, 'Resolve…')) : null,
    h('div.row.gap-s.wrap.inspector-row', {},
      avatar(author, 22),
      canEdit
        ? h('input.input.small.take-name', {
          title: 'Rename take',
          value: t.name,
          onchange: async e => { try { await api.patch(`/api/takes/${t.id}`, { name: e.target.value }); store.refreshSong(true); } catch (err) { toast(err.message, 'error'); } },
        })
        : h('b', {}, t.name),
      t.isSuggestion ? h('span.tag', { title: 'Recorded by a suggester' }, 'suggestion') : null,
      t.variantOf ? h('span.tag', { title: 'Variant of another take' }, 'variant') : null,
      t.notes ? h('span.tag', { title: 'Has a corrected note track' }, `${t.notes.length} notes`) : null,
      h('span.dim.small', {}, `${(t.duration || 0).toFixed(2)}s ≈ ${(lenBeats(t)).toFixed(2)} beats`),
      h('button.btn.small', { title: 'Solo this take from its position (double-click a clip does the same)', onclick: () => auditionTake(t) }, icon('play', { size: 13 }), ' Solo'),
      store.can('pick') ? h(`button.btn.small${picked ? '.primary' : ''}`, {
        title: 'Include in my picks for this part — what "My picks" plays and what your comps start from',
        onclick: async () => {
          const cur = store.myPicks(t.stage, t.laneId);
          const next = picked ? cur.filter(x => x !== t.id) : [...cur, t.id];
          await api.put(`/api/songs/${store.songId}/picks`, { stage: t.stage, laneId: t.laneId, takeIds: next });
          store.refreshSong(true);
        },
      }, icon(picked ? 'starFill' : 'star', { size: 13 }), picked ? ' picked' : ' pick') : null,
      canEdit ? h(`button.btn.small${t.muted ? '.warn' : ''}`, {
        title: t.muted ? 'Unmute' : 'Mute',
        onclick: async () => { await api.patch(`/api/takes/${t.id}`, { muted: !t.muted }); store.refreshSong(true); },
      }, t.muted ? 'muted' : 'mute') : null,
      canEdit ? slider({
        label: 'gain', min: 0, max: 2, step: 0.05, value: t.gain,
        fmt: v => Math.round(v * 100) + '%',
        oninput: debounce(async v => { await api.patch(`/api/takes/${t.id}`, { gain: v }); store.refreshSong(true); }, 400),
      }) : null,
      canEdit ? h('div.row.gap-xs.nudge', { title: 'Nudge on the grid (¼ beat)' },
        h('button.icon-btn', { title: 'Nudge left ¼ beat', onclick: () => nudge(t, -0.25) }, icon('back', { size: 13 })),
        h('button.icon-btn', { title: 'Nudge right ¼ beat', onclick: () => nudge(t, +0.25), style: { transform: 'scaleX(-1)' } }, icon('back', { size: 13 }))) : null,
      h('button.btn.small', { title: 'All take actions (also on right-click)', onclick: e => takeMenu(t, e.currentTarget) }, 'Actions')));
}

function renderMultiInspector(el, takes) {
  const laps = overlaps(takes);
  clear(el, h('div.row.gap-s.wrap.inspector-row', {},
    h('b.small', {}, `${takes.length} takes selected`),
    laps ? h('span.small.dim.row.gap-xs', {}, icon('warning', { size: 13 }), ' overlap — move apart to combine') : null,
    h('button.btn.small', { title: laps ? 'Move the takes apart first' : 'Merge into one take, keeping the gaps between them', disabled: laps, onclick: combineSelection }, icon('combine', { size: 13 }), ' Combine'),
    h('button.btn.small', { title: 'Mix all selected into a new layered take (originals kept)', onclick: flattenSelection }, icon('layers', { size: 13 }), ' Flatten'),
    takes.length === 2 ? h('button.btn.small', { title: 'Exchange the two takes’ positions', onclick: swapSelection }, icon('swap', { size: 13 }), ' Swap') : null,
    h('button.btn.small.danger', { title: 'Delete selected (Del)', onclick: deleteSelection }, icon('trash', { size: 13 }), ' Delete'),
    h('button.btn.small', { title: 'Clear selection (Esc)', onclick: () => { store.ui.multiSel = new Set(); store.ui.selectedTakeId = null; store.emit(); } }, 'Clear')));
}

async function nudge(t, d) {
  const before = t.offsetBeats;
  try {
    await api.patch(`/api/takes/${t.id}`, { offsetBeats: before + d });
    pushAction({
      label: 'nudge take',
      undo: () => api.patch(`/api/takes/${t.id}`, { offsetBeats: before }),
      redo: () => api.patch(`/api/takes/${t.id}`, { offsetBeats: before + d }),
    });
    await store.refreshSong(true);
  } catch (e) { toast(e.message, 'error'); }
}

function debounce(fn, ms) {
  let to = null;
  return (...a) => { clearTimeout(to); to = setTimeout(() => fn(...a), ms); };
}

export { absStart, lenBeats, listenTakesForLane, auditionTake, takeMenu };
