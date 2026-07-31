'use strict';
import { api } from '../api.js';
import { store } from '../store.js';
import { engine, BEAT_PATTERNS } from '../audio.js';
import { Timeline } from '../timeline.js';
import { h, clear, toast, busy, modal, confirmDlg, avatar, menu, slider, fmtScore } from '../ui.js';
import { renderPanel, panelTabs } from './panels.js';
import * as dialogs from './dialogs.js';

const STAGE_NAMES = { 1: '1 · Hum', 2: '2 · Song', 3: '3 · Arrange' };
let tl = null;
let rafId = null;
let recState = null;
let unsub = null;
let midiCache = null; // {songRev, notes}

export async function renderSongView(root, songId) {
  if (unsub) { unsub(); unsub = null; }
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
  ui.selectedSectionId = store.song.sections[0]?.id || null;
  ui.selectedTrackId = store.song.tracks[0]?.id || null;
  ui.listen = { type: 'mine', id: null };
  ui.playhead = 0;
  ui.draftStructure = null;
  ui.s2CompId = store.song.song.stage2_source_comp ? null : null;
  midiCache = null;
  try {
    const zs = JSON.parse(localStorage.getItem('humlab-zoom-' + songId) || 'null');
    ui.savedView = zs;
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
  tl.cb.onViewChange = v => {
    localStorage.setItem('humlab-zoom-' + songId, JSON.stringify(v));
  };

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
  // sensible default: latest non-suggestion take in the lane
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
  // expand structure to [{sectionId, name, color, start, len, srcStart}]
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

// ---------- playback ----------

function buildItems(stage) {
  const items = [];
  if (stage === 1) {
    for (const sec of store.song.sections) {
      for (const tid of listenTakesForLane(1, sec.id)) {
        const t = store.take(tid);
        if (!t || t.muted || !t.fileId) continue;
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
    for (const tid of listenTakesForLane(2, 'perf')) {
      const t = store.take(tid);
      if (!t || t.muted || !t.fileId) continue;
      items.push({ fileId: t.fileId, atBeat: t.offsetBeats, gain: t.gain });
    }
  } else {
    for (const tr of store.song.tracks) {
      for (const tid of listenTakesForLane(3, tr.id)) {
        const t = store.take(tid);
        if (!t || t.muted || !t.fileId) continue;
        items.push({ fileId: t.fileId, atBeat: t.offsetBeats, gain: t.gain });
      }
    }
  }
  return items;
}

function backingGainS2() {
  const ui = store.ui;
  if (ui.s2BackingGain != null) return ui.s2BackingGain;
  const comp = ui.s2CompId ? store.comp(ui.s2CompId) : null;
  return comp && comp.payload.backingGain != null ? comp.payload.backingGain : 0.5;
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

async function playFrom(fromBeat, { loop = false, endBeat = null, countIn = 0, items = null } = {}) {
  const ui = store.ui;
  const stage = ui.stageView;
  if (!store.spb() && !items) { toast('Set the tempo first (Tempo Sense) to play on the grid', 'error'); }
  const end = endBeat != null ? endBeat
    : stage === 2 ? Math.max(...structureSpans().map(s => s.start + s.len), 4)
      : store.songLenBeats();
  await engine.play({
    spb: spbOr(),
    fromBeat, endBeat: Math.max(end, fromBeat + 1), loop,
    countInBeats: countIn,
    items: items || buildItems(stage),
    backing: await backingConfig(),
    onStop: () => { store.emit('play'); },
  });
  store.emit('play');
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

async function startRecord() {
  const ui = store.ui;
  const stage = ui.stageView;
  if (!store.can('addTake')) return toast('Your role cannot record takes', 'error');
  let laneType, laneId, fromBeat, name;
  if (stage === 1) {
    const sec = store.section(ui.selectedSectionId) || store.song.sections[0];
    if (!sec) return toast('Add a section first', 'error');
    laneType = 'section'; laneId = sec.id; fromBeat = sec.start_beat;
    name = `${sec.name} · take ${store.takesFor(1, 'section', sec.id).length + 1}`;
  } else if (stage === 2) {
    laneType = 'perf'; laneId = 'perf'; fromBeat = 0;
    name = `Full run ${store.takesFor(2, 'perf', 'perf').length + 1}`;
  } else {
    const tr = store.song.tracks.find(t => t.id === ui.selectedTrackId) || store.song.tracks[0];
    if (!tr) return toast('Add a track first', 'error');
    laneType = 'track'; laneId = tr.id;
    fromBeat = Math.floor((ui.playhead || 0) / store.bpb()) * store.bpb();
    name = `${tr.name} · take ${store.takesFor(3, 'track', tr.id).length + 1}`;
  }
  const hasTempo = !!store.spb() && !!store.song.song.bpm;
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
    const r = await playFrom(fromBeat, { loop: false, countIn });
    void r;
    t0 = engine.state ? engine.state.t0 : null;
  }
  recState = {
    stage, laneType, laneId, fromBeat, name, rec, recStartCtx, t0,
    backing: { ...ui.backing }, startedWall: Date.now(),
  };
  store.emit('rec');
}

async function stopRecord() {
  if (!recState) return;
  const rs = recState;
  recState = null;
  engine.stop();
  const blob = await rs.rec.stop();
  store.emit('rec');
  if (Date.now() - rs.startedWall < 700) { toast('Recording too short — discarded'); return; }
  const b = busy('Processing your take…');
  try {
    const latency = (store.song.song.latency_ms || 0) / 1000;
    let trimHeadSec = 0;
    if (rs.t0 != null) trimHeadSec = Math.max(0, (rs.t0 - rs.recStartCtx) - latency);
    const toBeat = rs.fromBeat + (blob.size ? 0 : 0); // filled server-side by duration
    const meta = {
      stage: rs.stage, laneType: rs.laneType, laneId: rs.laneId,
      offsetBeats: rs.laneType === 'section' ? 0 : rs.fromBeat,
      name: rs.name, trimHeadSec,
      recCtx: {
        metronome: rs.backing.metronome, pad: rs.backing.pad,
        beatPattern: rs.backing.beatPattern, midi: rs.backing.midi,
        fromBeat: rs.fromBeat, toBeat,
      },
    };
    const r = await api.upload(`/api/songs/${store.songId}/takes`, blob, {
      type: rs.rec.mime, query: { meta: JSON.stringify(meta), type: rs.rec.mime.split(';')[0] },
    });
    store.ui.selectedTakeId = r.take.id;
    await store.refreshSong(true);
    const flag = r.take.flags && r.take.flags.tempo;
    if (flag && flag.state === 'open') {
      toast(`Heads up: this take feels like ${Math.round(flag.detected)} BPM vs official ${Math.round(store.song.song.bpm)} — tap the ⚠ to resolve`, 'info');
    } else {
      toast('Take saved');
    }
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    b.close();
  }
}

// ---------- timeline model ----------

function buildModel() {
  const ui = store.ui;
  const stage = ui.stageView;
  const s = store.song;
  const usersById = store.usersById();
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
    selected: ui.selectedTakeId === t.id, badges: badge(t), take: t,
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
    loop = null;
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
  return {
    bpb: store.bpb(), totalBeats: totalBeats + 4, sections, rows, pins, loop,
    canEdit: store.can('editContent') && stage === 1,
    canDragClips: store.can('editOwn'),
  };
}

function timelineCallbacks() {
  return {
    onSeek: beat => { store.ui.playhead = beat; tl.setPlayhead(beat); },
    onSectionClick: sec => {
      if (store.ui.stageView === 1) {
        store.ui.selectedSectionId = sec.id;
        store.emit();
      }
    },
    onSectionDbl: sec => { if (sec.raw && store.can('editContent')) dialogs.sectionDialog(sec.raw); },
    onSectionChange: async (sec, change) => {
      if (!sec.raw || !store.can('editContent')) return store.refreshSong(true);
      try {
        await api.patch(`/api/sections/${sec.id}`, {
          startBeat: change.start != null ? change.start : undefined,
          lengthBeats: change.len != null ? change.len : undefined,
        });
        await store.refreshSong(true);
      } catch (e) { toast(e.message, 'error'); store.refreshSong(true); }
    },
    onAddSection: async beat => {
      if (!store.can('editContent')) return;
      dialogs.sectionDialog(null, beat);
    },
    onClipClick: clip => {
      store.ui.selectedTakeId = clip.id === store.ui.selectedTakeId ? null : clip.id;
      const t = store.take(clip.id);
      if (t && t.laneType === 'section') store.ui.selectedSectionId = t.laneId;
      if (t && t.laneType === 'track') store.ui.selectedTrackId = t.laneId;
      store.emit();
    },
    onClipDbl: async clip => {
      const t = store.take(clip.id);
      if (t) auditionTake(t);
    },
    onClipMenu: (clip, x, y) => {
      const t = store.take(clip.id);
      if (!t) return;
      store.ui.selectedTakeId = t.id;
      store.emit();
      const anchor = h('span', { style: { position: 'fixed', left: x + 'px', top: y + 'px' } });
      document.body.append(anchor);
      takeMenu(t, anchor);
      setTimeout(() => anchor.remove(), 100);
    },
    onClipMove: async (clip, newStart, newRow, oldRow) => {
      const t = store.take(clip.id);
      if (!t) return;
      const own = t.authorId === store.user.id;
      if (!(own ? store.can('editOwn') : store.can('editContent'))) { toast('Your role cannot move this take', 'error'); return store.refreshSong(true); }
      try {
        if (t.laneType === 'section') {
          // find target section by position
          const target = store.song.sections.find(sx => newStart >= sx.start_beat - 0.001 && newStart < sx.start_beat + sx.length_beats + 0.999)
            || store.section(t.laneId);
          await api.patch(`/api/takes/${t.id}`, { laneId: target.id, offsetBeats: newStart - target.start_beat });
        } else if (t.laneType === 'track') {
          const m = buildModel();
          const targetLane = (m.rows[newRow] && m.rows[newRow].laneId) || t.laneId;
          await api.patch(`/api/takes/${t.id}`, { offsetBeats: Math.max(0, newStart), laneId: targetLane });
        } else {
          await api.patch(`/api/takes/${t.id}`, { offsetBeats: Math.max(0, newStart) });
        }
        void oldRow;
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
      if (store.ui.stageView === 3 && row && row.laneId) store.ui.selectedTrackId = row.laneId;
      store.ui.playhead = beat;
      tl.setPlayhead(beat);
      store.emit();
    },
  };
}

async function auditionTake(t, { withBacking = false } = {}) {
  if (withBacking && t.recCtx && store.spb()) {
    const from = absStart(t);
    const rc = t.recCtx;
    const saved = { ...store.ui.backing };
    store.ui.backing = { ...store.ui.backing, metronome: !!rc.metronome, pad: !!rc.pad, beatPattern: rc.beatPattern || null, midi: !!rc.midi };
    await playFrom(from, { endBeat: from + lenBeats(t), items: [{ fileId: t.fileId, atBeat: from, gain: t.gain }] });
    store.ui.backing = saved;
  } else {
    engine.audition(t.fileId, { gain: t.gain, onEnd: () => store.emit('play') });
    store.emit('play');
  }
}

// ---------- take actions menu ----------

function takeMenu(t, anchorEl) {
  const own = t.authorId === store.user.id;
  const canEdit = own ? store.can('editOwn') : store.can('editContent');
  const canProc = store.can('process') || (own && store.can('editOwn'));
  const sec = t.laneType === 'section' ? store.section(t.laneId) : null;
  menu(anchorEl, [
    { label: 'Play', icon: '▶', action: () => auditionTake(t) },
    t.recCtx && (t.recCtx.metronome || t.recCtx.pad || t.recCtx.beatPattern || t.recCtx.midi)
      ? { label: 'Play with recorded backing', icon: '♬', action: () => auditionTake(t, { withBacking: true }) } : null,
    '-',
    canProc ? { label: 'Effects…', icon: '✨', action: () => dialogs.fxDialog(t) } : null,
    canProc ? { label: 'Match tempo/pitch…', icon: '🧲', action: () => dialogs.matchDialog(t) } : null,
    canProc ? { label: 'Note correction…', icon: '♪', action: () => dialogs.noteCorrectionDialog(t) } : null,
    canProc && sec ? {
      label: `Stretch to fit section (${sec.length_beats} beats)`, icon: '↔',
      action: async () => {
        const b = busy('Stretching…');
        try { await api.post(`/api/takes/${t.id}/process`, { op: 'stretch-to-beats', params: { beats: sec.length_beats } }); await store.refreshSong(true); toast('Stretched to section'); }
        catch (e) { toast(e.message, 'error'); } finally { b.close(); }
      },
    } : null,
    t.flags && t.flags.tempo && t.flags.tempo.state === 'open'
      ? { label: 'Resolve tempo flag…', icon: '⚠', action: () => dialogs.tempoIntentDialog(t) } : null,
    '-',
    canEdit ? {
      label: 'Split at playhead', icon: '✂',
      action: async () => {
        const at = (store.ui.playhead || 0) - absStart(t);
        const atSec = at * spbOr();
        if (atSec <= 0.05 || atSec >= (t.duration || 0) - 0.05) return toast('Put the playhead inside the take first', 'error');
        const b = busy('Splitting…');
        try { await api.post(`/api/takes/${t.id}/split`, { atSec }); await store.refreshSong(true); }
        catch (e) { toast(e.message, 'error'); } finally { b.close(); }
      },
    } : null,
    store.can('editContent') ? { label: 'Duplicate', icon: '⧉', action: async () => { await api.post(`/api/takes/${t.id}/duplicate`, {}); store.refreshSong(true); } } : null,
    store.can('editContent') && t.laneType === 'section' ? {
      label: 'Copy to section…', icon: '📋',
      action: () => dialogs.copyToSectionDialog(t),
    } : null,
    '-',
    { label: 'Download WAV', icon: '⇩', action: () => { window.open(`/api/files/${t.fileId}/wav`, '_blank'); } },
    t.historyLen > 0 && canEdit ? {
      label: `Undo last edit (${t.historyLen})`, icon: '↩',
      action: async () => { try { await api.post(`/api/takes/${t.id}/revert`, {}); await store.refreshSong(true); toast('Reverted'); } catch (e) { toast(e.message, 'error'); } },
    } : null,
    (own ? store.can('editOwn') : store.can('deleteAny')) ? {
      label: 'Delete take', icon: '🗑', danger: true,
      action: async () => {
        if (await confirmDlg('Delete take', `Delete "${t.name}"? This cannot be undone.`)) {
          await api.del(`/api/takes/${t.id}`);
          if (store.ui.selectedTakeId === t.id) store.ui.selectedTakeId = null;
          store.refreshSong(true);
        }
      },
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
  renderPanel(skel.querySelector('.panel-body'), { auditionTake, playFrom, structureSpans, currentStructure, s2SourceCompId });
}

function renderHeader(el) {
  const s = store.song;
  const song = s.song;
  const membersUsers = (s.members || []).map(m => store.usersById()[m.user_id]).filter(Boolean).slice(0, 5);
  clear(el,
    h('div.row.gap-s.grow.min0', {},
      h('button.icon-btn', { onclick: () => { location.hash = '#/'; } }, '←'),
      h('div.song-name.ellip', {
        title: song.name,
        onclick: () => { if (store.can('editSettings')) dialogs.settingsDialog(); },
      }, song.name)),
    h('div.stage-tabs', {},
      [1, 2, 3].map(st => h(`button.stage-tab${store.ui.stageView === st ? '.active' : ''}${song.stage === st ? '.official' : ''}`, {
        onclick: () => { store.ui.stageView = st; store.ui.selectedTakeId = null; engine.stop(); store.emit(); },
        title: song.stage === st ? 'Official current stage' : '',
      }, STAGE_NAMES[st], song.stage === st ? h('span.official-dot') : null))),
    h('div.row.gap-s', {},
      h('div.avatars', {}, membersUsers.map(u => avatar(u, 22))),
      store.can('manageMembers')
        ? h('button.btn.small', { onclick: () => { store.ui.panel = 'members'; store.emit(); } }, 'Invite')
        : null,
      h('button.icon-btn', {
        onclick: e => menu(e.currentTarget, [
          store.can('editSettings') ? { label: 'Song settings…', action: () => dialogs.settingsDialog() } : null,
          { label: 'Export: render my current listen mix (WAV)', action: exportListen },
          '-',
          store.can('deleteSong') ? {
            label: 'Delete song', danger: true,
            action: async () => {
              if (await confirmDlg('Delete song', `Delete "${song.name}" and all its takes? This cannot be undone.`)) {
                await api.del(`/api/songs/${song.id}`);
                location.hash = '#/';
              }
            },
          } : null,
        ]),
      }, '⋯')));
}

async function exportListen() {
  // build a temporary comp from the current listen selection and download it
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
    h('option', { value: 'mine' }, '🎧 My picks'),
    (store.song.users || []).filter(u => u.id !== store.user.id).map(u =>
      h('option', { value: 'user:' + u.id }, `👤 ${u.name}'s picks`)),
    store.compsFor(stage).map(c => h('option', { value: 'comp:' + c.id }, `◉ ${c.name}`)),
  ];
  const listenVal = ui.listen.type === 'mine' ? 'mine' : `${ui.listen.type}:${ui.listen.id}`;

  const backingBtn = (key, label, title) => h(`button.chip${ui.backing[key] ? '.on' : ''}`, {
    title,
    onclick: () => { ui.backing[key] = !ui.backing[key]; store.emit(); },
  }, label);

  clear(el,
    h('div.row.gap-s.transport-main', {},
      recState
        ? h('button.btn.rec-live', { onclick: stopRecord }, h('span.rec-dot'), 'Stop & save')
        : h('button.btn.record', {
          title: stage === 1 ? 'Record a take into the selected section (1 bar count-in)' : stage === 2 ? 'Record a full-song performance' : 'Record onto the selected track',
          onclick: startRecord,
          disabled: !store.can('addTake'),
        }, '●'),
      h('button.btn.play', {
        onclick: () => {
          if (playing) { engine.stop(); return; }
          const from = stage === 1 && ui.loopSection !== false && store.section(ui.selectedSectionId) && ui.playheadInSection !== false
            ? ui.playhead || 0 : ui.playhead || 0;
          playFrom(from, { loop: !!ui.loop });
        },
      }, playing ? '■' : '▶'),
      h(`button.chip${ui.loop ? '.on' : ''}`, {
        title: 'Loop', onclick: () => { ui.loop = !ui.loop; store.emit(); },
      }, '↻'),
      stage === 1 && store.section(ui.selectedSectionId) ? h('button.chip', {
        title: 'Play selected section',
        onclick: () => {
          const sec = store.section(ui.selectedSectionId);
          ui.playhead = sec.start_beat;
          playFrom(sec.start_beat, { loop: ui.loop, endBeat: sec.start_beat + sec.length_beats });
        },
      }, '▶ section') : null,
      tempoWidget(),
      h('div.grow'),
      h('div.backing-chips.row.gap-xs', {},
        backingBtn('metronome', '🕒', 'Metronome click while playing/recording'),
        backingBtn('pad', '🎹', 'Chord pad backing (set chords in Settings)'),
        h(`button.chip${ui.backing.beatPattern ? '.on' : ''}`, {
          title: 'Drum beat backing',
          onclick: e => menu(e.currentTarget, [
            { label: 'No beat', action: () => { ui.backing.beatPattern = null; store.emit(); } },
            ...Object.entries(BEAT_PATTERNS).map(([k, p]) => ({
              label: (ui.backing.beatPattern === k ? '● ' : '') + p.label,
              action: () => { ui.backing.beatPattern = k; store.emit(); },
            })),
          ]),
        }, '🥁'),
        song.midi_file_id ? backingBtn('midi', '🎼', 'MIDI backing track') : null,
        h(`button.chip${ui.backing.aec ? '.on' : ''}`, {
          title: 'Backing bleed removal while recording (echo cancellation): the app removes what it is playing from your mic signal. Later you can re-add the same backing from the original sources, not the bleed.',
          onclick: () => { ui.backing.aec = !ui.backing.aec; store.emit(); },
        }, '🧹')),
      h('select.input.small.listen-as', {
        title: 'Choose whose picks (or which comp) you hear',
        value: listenVal,
        onchange: e => {
          const v = e.target.value;
          ui.listen = v === 'mine' ? { type: 'mine', id: null } : { type: v.split(':')[0], id: v.split(':').slice(1).join(':') };
          store.emit();
        },
      }, listenOptions),
      h('div.zoom-ctl.row.gap-xs', {},
        h('button.icon-btn', { onclick: () => tl.setZoom(tl.pxPerBeat * 0.8), title: 'Zoom out' }, '−'),
        h('button.icon-btn', { onclick: () => tl.setZoom(tl.pxPerBeat * 1.25), title: 'Zoom in' }, '+')),
      h(`button.chip${ui.pinMode ? '.on' : ''}`, {
        title: 'Pin-comment mode: click anywhere on the timeline to pin a comment at that beat',
        onclick: () => { ui.pinMode = !ui.pinMode; store.emit(); },
      }, '📍')),
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
      title: 'Official tempo/meter',
    },
      h('b', {}, Math.round(song.bpm) + ' BPM'),
      h('span.dim', {}, ` · ${song.beats_per_bar || 4}/4`),
      flagged.length ? h('span.flag-badge', {
        title: `${flagged.length} take(s) look off-tempo — click a ⚠ clip to resolve`,
        onclick: e => {
          e.stopPropagation();
          store.ui.selectedTakeId = flagged[0].id;
          store.emit();
          dialogs.tempoIntentDialog(flagged[0]);
        },
      }, `⚠ ${flagged.length}`) : null);
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
      value: srcId || '',
      onchange: async e => {
        if (store.can('setStage')) {
          try { await api.patch(`/api/songs/${store.songId}`, { stage2SourceComp: e.target.value }); await store.refreshSong(true); } catch (err) { toast(err.message, 'error'); }
        } else { toast('Admins set the official source; ask an admin or build your own Song comp', 'info'); }
      },
    },
      s1comps.length ? s1comps.map(c => {
        const votes = store.votesFor(c.id);
        const avg = votes.length ? votes.reduce((a, v) => a + v.score, 0) / votes.length : null;
        return h('option', { value: c.id, selected: c.id === srcId }, `${c.name}${avg ? ` · ${fmtScore(avg)}★` : ''}`);
      }) : h('option', { value: '' }, 'No Hum-stage comps yet')),
    h('button.btn.small', { onclick: () => dialogs.structureDialog() }, '🧱 Structure'),
    slider({
      label: '🎚 backing', min: 0, max: 1, step: 0.05,
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
        return h('option', { value: c.id, selected: c.id === srcId }, `${c.name}${avg ? ` · ${fmtScore(avg)}★` : ''}`);
      }) : h('option', { value: '' }, 'No Song-stage comps yet')),
    store.can('editContent') ? h('button.btn.small', { onclick: () => dialogs.trackDialog(null) }, '+ Track') : null,
    store.ui.selectedTrackId ? h('button.btn.small', {
      onclick: () => {
        const tr = store.song.tracks.find(x => x.id === store.ui.selectedTrackId);
        if (tr) dialogs.trackDialog(tr);
      },
    }, '⚙ Track') : null,
    store.can('editContent') && store.ui.selectedTrackId ? h('button.btn.small', {
      title: 'Generate instrument audio from a note-corrected take',
      onclick: () => dialogs.generateDialog(store.ui.selectedTrackId),
    }, '♪→🎻 Generate') : null);
}

function renderInspector(el) {
  const t = store.take(store.ui.selectedTakeId);
  if (!t) {
    const stage = store.ui.stageView;
    const hint = stage === 1
      ? 'Select a section, hit ● to record a humming take into it. Click a take to edit; long-press for all actions.'
      : stage === 2 ? 'Pick the source comp, set the structure, then record full-song performance runs. Star your favorite and save Song comps for voting.'
        : 'Add instrument tracks, generate clean instrument lines from note-corrected takes, record real audio, then save Mixes for voting.';
    clear(el, h('div.inspector-hint.dim.small', {}, hint));
    return;
  }
  const author = store.usersById()[t.authorId];
  const own = t.authorId === store.user.id;
  const canEdit = own ? store.can('editOwn') : store.can('editContent');
  const flag = t.flags && t.flags.tempo && t.flags.tempo.state === 'open' ? t.flags.tempo : null;
  const picked = (() => {
    const picks = store.myPicks(t.stage, t.laneId);
    return picks.includes(t.id);
  })();
  clear(el,
    flag ? h('div.flag-banner', {},
      `⚠ Feels like ${Math.round(flag.detected)} BPM vs official ${Math.round(store.song.song.bpm)}. `,
      h('button.btn.small', { onclick: () => dialogs.tempoIntentDialog(t) }, 'Resolve…')) : null,
    h('div.row.gap-s.wrap.inspector-row', {},
      avatar(author, 22),
      canEdit
        ? h('input.input.small.take-name', {
          value: t.name,
          onchange: async e => { try { await api.patch(`/api/takes/${t.id}`, { name: e.target.value }); store.refreshSong(true); } catch (err) { toast(err.message, 'error'); } },
        })
        : h('b', {}, t.name),
      t.isSuggestion ? h('span.tag', {}, '✦ suggestion') : null,
      t.variantOf ? h('span.tag', { title: 'Variant of another take' }, '⑂ variant') : null,
      t.notes ? h('span.tag', {}, `♪ ${t.notes.length} notes`) : null,
      h('span.dim.small', {}, `${(t.duration || 0).toFixed(2)}s ≈ ${(lenBeats(t)).toFixed(2)} beats`),
      h('button.btn.small', { onclick: () => auditionTake(t) }, '▶ Solo'),
      store.can('pick') ? h(`button.btn.small${picked ? '.primary' : ''}`, {
        title: 'Include in my picks for this part (what "My picks" plays and what your comps start from)',
        onclick: async () => {
          const cur = store.myPicks(t.stage, t.laneId);
          const next = picked ? cur.filter(x => x !== t.id) : [...cur, t.id];
          await api.put(`/api/songs/${store.songId}/picks`, { stage: t.stage, laneId: t.laneId, takeIds: next });
          store.refreshSong(true);
        },
      }, picked ? '★ picked' : '☆ pick') : null,
      canEdit ? h(`button.btn.small${t.muted ? '.warn' : ''}`, {
        onclick: async () => { await api.patch(`/api/takes/${t.id}`, { muted: !t.muted }); store.refreshSong(true); },
      }, t.muted ? '🔇 muted' : '🔊') : null,
      canEdit ? slider({
        label: 'gain', min: 0, max: 2, step: 0.05, value: t.gain,
        fmt: v => Math.round(v * 100) + '%',
        oninput: debounce(async v => { await api.patch(`/api/takes/${t.id}`, { gain: v }); store.refreshSong(true); }, 400),
      }) : null,
      canEdit ? h('div.row.gap-xs.nudge', { title: 'Nudge on the grid' },
        h('button.icon-btn', { onclick: () => nudge(t, -0.25) }, '⇤'),
        h('button.icon-btn', { onclick: () => nudge(t, +0.25) }, '⇥')) : null,
      h('button.btn.small', { onclick: e => takeMenu(t, e.currentTarget) }, 'Actions ▾')));
}

async function nudge(t, d) {
  try {
    await api.patch(`/api/takes/${t.id}`, { offsetBeats: t.offsetBeats + d });
    await store.refreshSong(true);
  } catch (e) { toast(e.message, 'error'); }
}

function debounce(fn, ms) {
  let to = null;
  return (...a) => { clearTimeout(to); to = setTimeout(() => fn(...a), ms); };
}

export { absStart, lenBeats, listenTakesForLane, auditionTake, takeMenu };
