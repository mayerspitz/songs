'use strict';
import { api } from './api.js';

// Central app state + song snapshot with light polling for collaboration.

export const store = {
  config: null,
  user: null,
  song: null,          // current song snapshot (server shape)
  songId: null,
  ui: {
    stageView: 1,          // which stage tab is open (independent of official stage)
    panel: 'takes',        // takes | comps | comments | members
    selectedTakeId: null,
    selectedSectionId: null,
    selectedTrackId: null,
    listen: { type: 'mine', id: null }, // mine | user:<id> | comp:<id>
    backing: { metronome: false, pad: false, beatPattern: null, midi: false, aec: true },
    draftStructure: null,  // stage-2 structure being edited
    pinMode: false,
    s2CompId: null,        // comp selected in stage 2 view
    s3MixId: null,
  },
  _subs: new Set(),
  _pollTimer: null,
  suspendPolling: false,

  sub(fn) { this._subs.add(fn); return () => this._subs.delete(fn); },
  emit(what = 'all') { for (const fn of this._subs) fn(what); },

  async init() {
    this.config = await api.get('/api/config');
    const me = await api.get('/api/me');
    this.user = me.user;
    return this.user;
  },

  async loadSong(id) {
    this.songId = id;
    this.song = await api.get(`/api/songs/${id}`);
    this._startPoll();
    return this.song;
  },

  closeSong() {
    this.songId = null;
    this.song = null;
    clearInterval(this._pollTimer);
  },

  async refreshSong(force = false) {
    if (!this.songId) return;
    try {
      if (!force) {
        const { rev } = await api.get(`/api/songs/${this.songId}/rev`);
        if (this.song && rev === this.song.rev) return;
      }
      this.song = await api.get(`/api/songs/${this.songId}`);
      this.emit('song');
    } catch (e) {
      if (e.status === 403 || e.status === 404) { clearInterval(this._pollTimer); location.hash = '#/'; }
    }
  },

  _startPoll() {
    clearInterval(this._pollTimer);
    this._pollTimer = setInterval(() => {
      if (document.hidden || this.suspendPolling) return;
      this.refreshSong();
    }, 4000);
  },

  // ---- selectors ----

  me() { return this.user; },
  usersById() { return Object.fromEntries((this.song?.users || []).map(u => [u.id, u])); },
  takesFor(stage, laneType, laneId) {
    return (this.song?.takes || []).filter(t => t.stage === stage && t.laneType === laneType && (laneId == null || t.laneId === laneId));
  },
  take(id) { return (this.song?.takes || []).find(t => t.id === id); },
  section(id) { return (this.song?.sections || []).find(s => s.id === id); },
  comp(id) { return (this.song?.comps || []).find(c => c.id === id); },
  compsFor(stage) { return (this.song?.comps || []).filter(c => c.stage === stage); },
  myPicks(stage, laneId) {
    const p = (this.song?.picks || []).find(p => p.stage === stage && p.lane_id === laneId && p.user_id === this.user.id);
    return p ? p.take_ids : [];
  },
  picksOf(userId, stage, laneId) {
    const p = (this.song?.picks || []).find(p => p.stage === stage && p.lane_id === laneId && p.user_id === userId);
    return p ? p.take_ids : [];
  },
  votesFor(compId) { return (this.song?.votes || []).filter(v => v.comp_id === compId); },
  role() { return this.song?.myRole || 'viewer'; },
  can(action) {
    const ORDER = { viewer: 1, voter: 2, suggester: 3, contributor: 4, admin: 5, owner: 6 };
    const NEED = {
      view: 1, vote: 2, comment: 3, addTake: 3, pick: 3, editOwn: 3,
      createComp: 4, editContent: 4, process: 4,
      manageMembers: 5, editSettings: 5, setStage: 5, deleteAny: 5, deleteSong: 6,
    };
    return (ORDER[this.role()] || 0) >= (NEED[action] || 99);
  },
  spb() { return this.song?.song.bpm ? 60 / this.song.song.bpm : null; },
  bpb() { return this.song?.song.beats_per_bar || 4; },
  songLenBeats() {
    const s = this.song;
    if (!s) return 64;
    const secEnd = (s.sections || []).reduce((a, x) => Math.max(a, x.start_beat + x.length_beats), 0);
    const takeEnd = (s.takes || []).reduce((a, t) => {
      const base = t.laneType === 'section' ? (this.section(t.laneId)?.start_beat || 0) : 0;
      const spb = this.spb() || 0.5;
      return Math.max(a, base + t.offsetBeats + (t.duration || 0) / spb);
    }, 0);
    return Math.max(s.song.bars * this.bpb(), secEnd, takeEnd);
  },
};
