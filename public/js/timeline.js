'use strict';
// Canvas timeline: beat grid, section band, stacked take clips with waveforms,
// comment pins, playhead. Compact rows; horizontal zoom (buttons/wheel/pinch), pan.
//
// The view supplies a model via update(); the timeline renders and reports
// interactions through callbacks. All horizontal units are beats.

const RULER_H = 26;
const SECTIONS_H = 26;
const ROW_H = 44;
const ROW_GAP = 2;

export class Timeline {
  constructor(canvas, cb = {}) {
    this.cv = canvas;
    this.cx = canvas.getContext('2d');
    this.cb = cb;
    this.m = null;               // model
    this.pxPerBeat = 16;
    this.scrollBeat = 0;
    this.hover = null;
    this.drag = null;
    this.pointers = new Map();
    this.playheadBeat = null;
    canvas.style.touchAction = 'pan-y';
    canvas.addEventListener('pointerdown', e => this.onDown(e));
    canvas.addEventListener('pointermove', e => this.onMove(e));
    canvas.addEventListener('pointerup', e => this.onUp(e));
    canvas.addEventListener('pointercancel', e => this.onUp(e));
    canvas.addEventListener('wheel', e => this.onWheel(e), { passive: false });
    canvas.addEventListener('dblclick', e => this.onDbl(e));
    canvas.addEventListener('contextmenu', e => this.onCtx(e));
    this._raf = null;
  }

  // model: {bpb, totalBeats, sections:[{id,name,start,len,color}], rows:[{laneId, clips:[...]}],
  //         pins:[{id,beat,resolved}], loop:{start,end}|null, gridDiv, canEdit}
  // clip: {id, start, len, color, peaks, name, badges:{flag,notes,sugg,pick,variant}, muted, selected, author}
  update(model) {
    this.m = model;
    this.layout();
    this.draw();
  }

  setPlayhead(beat) {
    this.playheadBeat = beat;
    this.draw();
  }

  setZoom(px, centerBeat = null) {
    const old = this.pxPerBeat;
    px = Math.max(4, Math.min(120, px));
    if (centerBeat != null) {
      const xc = (centerBeat - this.scrollBeat) * old;
      this.scrollBeat = centerBeat - xc / px;
    }
    this.pxPerBeat = px;
    this.clampScroll();
    this.draw();
    this.cb.onViewChange && this.cb.onViewChange({ pxPerBeat: this.pxPerBeat, scrollBeat: this.scrollBeat });
  }

  clampScroll() {
    const w = this.cv.clientWidth / this.pxPerBeat;
    const max = Math.max(0, (this.m ? this.m.totalBeats + 8 : 64) - w);
    this.scrollBeat = Math.max(0, Math.min(max, this.scrollBeat));
  }

  layout() {
    const rows = this.m.rows || [];
    const h = RULER_H + SECTIONS_H + rows.length * (ROW_H + ROW_GAP) + 12;
    const w = this.cv.parentElement ? this.cv.parentElement.clientWidth : this.cv.clientWidth;
    const dpr = window.devicePixelRatio || 1;
    if (this.cv.width !== Math.round(w * dpr) || this.cv.height !== Math.round(h * dpr)) {
      this.cv.width = Math.round(w * dpr);
      this.cv.height = Math.round(h * dpr);
      this.cv.style.width = w + 'px';
      this.cv.style.height = h + 'px';
    }
  }

  xOf(beat) { return (beat - this.scrollBeat) * this.pxPerBeat; }
  beatAt(x) { return this.scrollBeat + x / this.pxPerBeat; }
  rowTop(i) { return RULER_H + SECTIONS_H + i * (ROW_H + ROW_GAP); }

  snap(beat) {
    const div = this.m.gridDiv || (this.pxPerBeat > 40 ? 4 : this.pxPerBeat > 18 ? 2 : 1);
    return Math.max(0, Math.round(beat * div) / div);
  }

  // ---------- drawing ----------

  draw() {
    if (!this.m) return;
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = null; this.paint(); });
  }

  paint() {
    const { cv, cx, m } = this;
    const dpr = window.devicePixelRatio || 1;
    const W = cv.width / dpr, H = cv.height / dpr;
    cx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(document.documentElement);
    const col = name => css.getPropertyValue(name).trim() || '#888';
    const C = {
      bg: col('--tl-bg'), grid: col('--tl-grid'), bar: col('--tl-bar'),
      text: col('--tl-text'), dim: col('--tl-dim'), accent: col('--accent'),
      clipText: col('--tl-clip-text'), rowBg: col('--tl-row'),
    };
    cx.clearRect(0, 0, W, H);
    cx.fillStyle = C.bg;
    cx.fillRect(0, 0, W, H);
    const bpb = m.bpb || 4;

    // loop region
    if (m.loop) {
      cx.fillStyle = 'rgba(124,108,240,0.10)';
      cx.fillRect(this.xOf(m.loop.start), 0, (m.loop.end - m.loop.start) * this.pxPerBeat, H);
    }

    // grid
    const beatW = this.pxPerBeat;
    const sub = beatW > 44 ? 4 : beatW > 22 ? 2 : 1;
    const first = Math.floor(this.scrollBeat);
    const last = Math.ceil(this.scrollBeat + W / beatW);
    for (let b = first; b <= last; b++) {
      for (let s = 0; s < sub; s++) {
        const beat = b + s / sub;
        const x = this.xOf(beat);
        if (x < -2 || x > W + 2) continue;
        const isBar = s === 0 && ((b % bpb) + bpb) % bpb === 0;
        cx.strokeStyle = isBar ? C.bar : C.grid;
        cx.globalAlpha = s === 0 ? 1 : 0.4;
        cx.beginPath();
        cx.moveTo(Math.round(x) + 0.5, isBar ? 0 : RULER_H);
        cx.lineTo(Math.round(x) + 0.5, H);
        cx.stroke();
        cx.globalAlpha = 1;
      }
    }

    // ruler
    cx.fillStyle = C.dim;
    cx.font = '10px system-ui, sans-serif';
    for (let b = first; b <= last; b++) {
      if (((b % bpb) + bpb) % bpb === 0 && b >= 0) {
        const x = this.xOf(b);
        cx.fillText(String(Math.floor(b / bpb) + 1), x + 3, 11);
      }
    }
    // comment pins
    for (const p of m.pins || []) {
      const x = this.xOf(p.beat);
      if (x < -8 || x > W + 8) continue;
      cx.fillStyle = p.resolved ? C.dim : '#e8a03d';
      cx.beginPath();
      cx.moveTo(x, RULER_H - 10);
      cx.lineTo(x - 4, RULER_H - 3);
      cx.lineTo(x + 4, RULER_H - 3);
      cx.closePath();
      cx.fill();
    }

    // sections band
    for (const s of m.sections || []) {
      const x = this.xOf(s.start), w = s.len * beatW;
      if (x + w < 0 || x > W) continue;
      const selected = m.loop && Math.abs(m.loop.start - s.start) < 1e-6 && Math.abs(m.loop.end - (s.start + s.len)) < 1e-6;
      cx.fillStyle = s.color + (selected ? 'e8' : '99');
      roundRect(cx, x + 1, RULER_H + 3, Math.max(3, w - 2), SECTIONS_H - 7, 5);
      cx.fill();
      if (selected) { cx.strokeStyle = '#fff'; cx.globalAlpha = 0.7; cx.stroke(); cx.globalAlpha = 1; }
      cx.fillStyle = '#fff';
      cx.font = '600 10px system-ui, sans-serif';
      const label = s.name;
      cx.save();
      cx.beginPath(); cx.rect(x + 4, RULER_H, Math.max(0, w - 8), SECTIONS_H); cx.clip();
      cx.fillText(label, x + 6, RULER_H + 16);
      cx.restore();
    }
    // ghost "Create Part" button after the last section
    this._ghostRect = null;
    if (m.canEdit) {
      const lastEnd = (m.sections || []).reduce((a, s) => Math.max(a, s.start + s.len), 0);
      const gx = this.xOf(lastEnd) + 6;
      const label = `+ Create ${m.nextPartLabel || 'Part'}`;
      cx.font = '600 10px system-ui, sans-serif';
      const gw = cx.measureText(label).width + 18;
      if (gx < W && gx + gw > 0) {
        this._ghostRect = { x: gx, y: RULER_H + 3, w: gw, h: SECTIONS_H - 7, beat: lastEnd };
        cx.globalAlpha = 0.45;
        roundRect(cx, gx, RULER_H + 3, gw, SECTIONS_H - 7, 5);
        cx.setLineDash([4, 3]);
        cx.strokeStyle = C.dim;
        cx.stroke();
        cx.setLineDash([]);
        cx.fillStyle = C.dim;
        cx.fillText(label, gx + 9, RULER_H + 16);
        cx.globalAlpha = 1;
      }
    }

    // clip rows
    (m.rows || []).forEach((row, i) => {
      const y = this.rowTop(i);
      cx.fillStyle = C.rowBg;
      cx.globalAlpha = 0.5;
      cx.fillRect(0, y, W, ROW_H);
      cx.globalAlpha = 1;
      if (row.label) {
        cx.fillStyle = C.dim;
        cx.font = '600 10px system-ui, sans-serif';
        cx.fillText(row.label, 4, y + 12);
      }
      for (const c of row.clips) {
        const drag = this.drag && this.drag.kind === 'clip' && this.drag.clipId === c.id ? this.drag : null;
        const start = drag ? drag.curStart : c.start;
        const x = this.xOf(start), w = Math.max(6, c.len * beatW);
        if (x + w < 0 || x > W) continue;
        this.paintClip(cx, c, x, y + 2, w, ROW_H - 4, C);
      }
    });

    // playhead
    if (this.playheadBeat != null) {
      const x = this.xOf(this.playheadBeat);
      if (x >= 0 && x <= W) {
        cx.strokeStyle = C.accent;
        cx.lineWidth = 1.5;
        cx.beginPath(); cx.moveTo(x, 0); cx.lineTo(x, H); cx.stroke();
        cx.lineWidth = 1;
        cx.fillStyle = C.accent;
        cx.beginPath();
        cx.moveTo(x - 5, 0); cx.lineTo(x + 5, 0); cx.lineTo(x, 7);
        cx.closePath(); cx.fill();
      }
    }
  }

  paintClip(cx, c, x, y, w, h, C) {
    const sel = c.selected;
    cx.save();
    roundRect(cx, x, y, w, h, 6);
    cx.fillStyle = c.color + (c.muted ? '26' : '3d');
    cx.fill();
    cx.clip();
    // waveform
    if (c.peaks && c.peaks.length) {
      const mid = y + h * 0.55, amp = h * 0.4;
      cx.beginPath();
      const n = c.peaks.length;
      for (let i = 0; i < n; i++) {
        const px = x + (i / n) * w;
        cx.moveTo(px, mid + c.peaks[i][0] * amp);
        cx.lineTo(px, mid + Math.max(0.5 / amp, c.peaks[i][1]) * amp * 1);
      }
      cx.strokeStyle = c.color;
      cx.globalAlpha = c.muted ? 0.35 : 0.9;
      cx.stroke();
      cx.globalAlpha = 1;
    }
    // badges (vector) + name
    cx.globalAlpha = c.muted ? 0.5 : 1;
    let bx = x + 5;
    const by = y + 7.5;
    if (c.badges) {
      if (c.badges.pick) { drawBadge(cx, 'star', bx, by, '#ffd166'); bx += 11; }
      if (c.badges.flag) { drawBadge(cx, 'warn', bx, by, '#e8a03d'); bx += 11; }
      if (c.badges.notes) { drawBadge(cx, 'note', bx, by, C.clipText); bx += 10; }
      if (c.badges.sugg) { drawBadge(cx, 'spark', bx, by, '#e86cb8'); bx += 11; }
    }
    cx.font = '600 10px system-ui, sans-serif';
    cx.fillStyle = C.clipText;
    cx.fillText(c.name, bx, y + 12, Math.max(10, w - (bx - x) - 5));
    cx.globalAlpha = 1;
    cx.restore();
    roundRect(cx, x, y, w, h, 6);
    cx.strokeStyle = sel ? '#ffffff' : c.color;
    cx.globalAlpha = sel ? 0.95 : 0.55;
    cx.lineWidth = sel ? 1.6 : 1;
    cx.stroke();
    cx.lineWidth = 1;
    cx.globalAlpha = 1;
  }

  // ---------- hit testing ----------

  hit(x, y) {
    const m = this.m;
    if (!m) return { zone: 'void' };
    if (y < RULER_H) {
      for (const p of m.pins || []) {
        if (Math.abs(this.xOf(p.beat) - x) < 6) return { zone: 'pin', pin: p };
      }
      return { zone: 'ruler' };
    }
    if (y < RULER_H + SECTIONS_H) {
      const g = this._ghostRect;
      if (g && x >= g.x && x <= g.x + g.w && y >= g.y && y <= g.y + g.h) {
        return { zone: 'ghost-add', beat: g.beat };
      }
      for (const s of m.sections || []) {
        const sx = this.xOf(s.start), sw = s.len * this.pxPerBeat;
        if (x >= sx - 3 && x <= sx + sw + 3) {
          if (m.canEdit && Math.abs(x - (sx + sw)) < 6) return { zone: 'section-edge', section: s, edge: 'end' };
          if (m.canEdit && Math.abs(x - sx) < 6) return { zone: 'section-edge', section: s, edge: 'start' };
          if (x >= sx && x <= sx + sw) return { zone: 'section', section: s };
        }
      }
      return { zone: 'sections-empty' };
    }
    const rows = m.rows || [];
    for (let i = 0; i < rows.length; i++) {
      const ry = this.rowTop(i);
      if (y >= ry && y <= ry + ROW_H) {
        for (const c of rows[i].clips) {
          const cx0 = this.xOf(c.start), cw = Math.max(6, c.len * this.pxPerBeat);
          if (x >= cx0 && x <= cx0 + cw) return { zone: 'clip', clip: c, row: rows[i], rowIndex: i };
        }
        return { zone: 'row', row: rows[i], rowIndex: i };
      }
    }
    return { zone: 'void' };
  }

  // ---------- pointer handling ----------

  onDown(e) {
    this.cv.setPointerCapture(e.pointerId);
    const rect = this.cv.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    this.pointers.set(e.pointerId, { x, y });
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.drag = { kind: 'pinch', startDist: Math.hypot(a.x - b.x, a.y - b.y), startPx: this.pxPerBeat, centerBeat: this.beatAt((a.x + b.x) / 2) };
      return;
    }
    const hitR = this.hit(x, y);
    const beat = this.beatAt(x);
    this.downAt = { x, y, t: Date.now(), hit: hitR };
    if (hitR.zone === 'ruler') {
      this.drag = { kind: 'seek' };
      this.cb.onSeek && this.cb.onSeek(Math.max(0, beat));
    } else if (hitR.zone === 'pin') {
      this.drag = { kind: 'none' };
    } else if (hitR.zone === 'section-edge') {
      this.drag = { kind: 'section-edge', section: hitR.section, edge: hitR.edge, orig: { start: hitR.section.start, len: hitR.section.len } };
    } else if (hitR.zone === 'section') {
      this.drag = { kind: 'maybe-section', section: hitR.section, startBeat: beat, orig: hitR.section.start };
    } else if (hitR.zone === 'ghost-add') {
      this.drag = { kind: 'none' };
    } else if (hitR.zone === 'clip') {
      this.drag = {
        kind: 'clip', clipId: hitR.clip.id, clip: hitR.clip, rowIndex: hitR.rowIndex,
        grabOffset: beat - hitR.clip.start, curStart: hitR.clip.start, curRow: hitR.rowIndex, moved: false,
      };
      if (e.pointerType === 'touch') { // touch has no right-click; keep long-press there
        this.longPress = setTimeout(() => {
          if (this.drag && this.drag.kind === 'clip' && !this.drag.moved) {
            this.drag = null;
            this.cb.onClipMenu && this.cb.onClipMenu(hitR.clip, e.clientX, e.clientY);
          }
        }, 550);
      }
    } else {
      this.drag = { kind: 'pan', startX: x, startScroll: this.scrollBeat, moved: false };
    }
  }

  onMove(e) {
    const rect = this.cv.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { x, y });
    const d = this.drag;
    if (!d) return;
    if (d.kind === 'pinch' && this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      this.setZoom(d.startPx * (dist / d.startDist), d.centerBeat);
      return;
    }
    const beat = this.beatAt(x);
    if (d.kind === 'seek') {
      this.cb.onSeek && this.cb.onSeek(Math.max(0, beat));
    } else if (d.kind === 'pan') {
      const db = (x - d.startX) / this.pxPerBeat;
      if (Math.abs(x - d.startX) > 4) d.moved = true;
      this.scrollBeat = d.startScroll - db;
      this.clampScroll();
      this.draw();
      this.cb.onViewChange && this.cb.onViewChange({ pxPerBeat: this.pxPerBeat, scrollBeat: this.scrollBeat });
    } else if (d.kind === 'maybe-section') {
      if (Math.abs(beat - d.startBeat) > 0.3 && this.m.canEdit) {
        d.kind = 'section-move';
      }
    } else if (d.kind === 'section-move') {
      const ns = this.snap(d.orig + (beat - d.startBeat));
      d.section.start = Math.max(0, ns);
      this.draw();
    } else if (d.kind === 'section-edge') {
      if (d.edge === 'end') {
        d.section.len = Math.max(0.25, this.snap(beat) - d.section.start);
      } else {
        const end = d.orig.start + d.orig.len;
        const ns = Math.min(end - 0.25, Math.max(0, this.snap(beat)));
        d.section.start = ns;
        d.section.len = end - ns;
      }
      this.draw();
    } else if (d.kind === 'clip') {
      const ns = this.snap(beat - d.grabOffset);
      if (Math.abs(ns - d.clip.start) > 1e-6) d.moved = true;
      if (d.moved && this.m.canDragClips !== false) {
        d.curStart = Math.max(0, ns);
        // vertical row change
        const rows = this.m.rows || [];
        for (let i = 0; i < rows.length; i++) {
          const ry = this.rowTop(i);
          if (y >= ry && y <= ry + ROW_H) { d.curRow = i; break; }
        }
        this.draw();
      }
    }
  }

  onUp(e) {
    this.pointers.delete(e.pointerId);
    clearTimeout(this.longPress);
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    if (d.kind === 'pinch') return;
    if (d.kind === 'maybe-section') {
      this.cb.onSectionClick && this.cb.onSectionClick(d.section);
      return;
    }
    if (d.kind === 'section-move') {
      this.cb.onSectionChange && this.cb.onSectionChange(d.section, { start: d.section.start });
      return;
    }
    if (d.kind === 'section-edge') {
      this.cb.onSectionChange && this.cb.onSectionChange(d.section, { start: d.section.start, len: d.section.len });
      return;
    }
    if (d.kind === 'clip') {
      if (d.moved) {
        this.cb.onClipMove && this.cb.onClipMove(d.clip, d.curStart, d.curRow, d.rowIndex);
      } else {
        this.cb.onClipClick && this.cb.onClipClick(d.clip, e);
      }
      return;
    }
    if (d.kind === 'pan' && !d.moved && this.downAt) {
      const hitR = this.downAt.hit;
      if (hitR.zone === 'sections-empty' && this.m.canEdit) {
        this.cb.onAddSection && this.cb.onAddSection(this.snap(this.beatAt(this.downAt.x)));
        return;
      }
      if (hitR.zone === 'row' || hitR.zone === 'void') {
        this.cb.onEmptyClick && this.cb.onEmptyClick(this.beatAt(this.downAt.x), hitR.row);
      }
    }
    if (this.downAt && this.downAt.hit.zone === 'ghost-add' && d.kind === 'none') {
      this.cb.onAddSection && this.cb.onAddSection(this.downAt.hit.beat);
    }
    if (this.downAt && this.downAt.hit.zone === 'pin') {
      this.cb.onPinClick && this.cb.onPinClick(this.downAt.hit.pin);
    }
  }

  onDbl(e) {
    const rect = this.cv.getBoundingClientRect();
    const hitR = this.hit(e.clientX - rect.left, e.clientY - rect.top);
    if (hitR.zone === 'section') this.cb.onSectionDbl && this.cb.onSectionDbl(hitR.section);
    if (hitR.zone === 'clip') this.cb.onClipDbl && this.cb.onClipDbl(hitR.clip);
  }

  onCtx(e) {
    e.preventDefault();
    const rect = this.cv.getBoundingClientRect();
    const hitR = this.hit(e.clientX - rect.left, e.clientY - rect.top);
    clearTimeout(this.longPress);
    this.drag = null;
    if (hitR.zone === 'clip') this.cb.onClipMenu && this.cb.onClipMenu(hitR.clip, e.clientX, e.clientY);
    else if (hitR.zone === 'section' && hitR.section.raw) this.cb.onSectionDbl && this.cb.onSectionDbl(hitR.section);
  }

  onWheel(e) {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const rect = this.cv.getBoundingClientRect();
      const beat = this.beatAt(e.clientX - rect.left);
      this.setZoom(this.pxPerBeat * (e.deltaY < 0 ? 1.12 : 0.9), beat);
    } else {
      const dx = e.deltaX !== 0 ? e.deltaX : (e.shiftKey ? e.deltaY : 0);
      if (dx !== 0) {
        this.scrollBeat += dx / this.pxPerBeat;
        this.clampScroll();
        this.draw();
        this.cb.onViewChange && this.cb.onViewChange({ pxPerBeat: this.pxPerBeat, scrollBeat: this.scrollBeat });
      } else if (e.deltaY !== 0 && this.cv.parentElement) {
        this.cv.parentElement.scrollTop += e.deltaY;
      }
    }
  }
}

function drawBadge(cx, kind, x, y, color) {
  cx.save();
  cx.fillStyle = color;
  cx.strokeStyle = color;
  cx.lineWidth = 1.2;
  if (kind === 'star') {
    cx.beginPath();
    for (let i = 0; i < 10; i++) {
      const r = i % 2 === 0 ? 4 : 1.8;
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      const px = x + 4 + Math.cos(a) * r, py = y + Math.sin(a) * r;
      i === 0 ? cx.moveTo(px, py) : cx.lineTo(px, py);
    }
    cx.closePath(); cx.fill();
  } else if (kind === 'warn') {
    cx.beginPath();
    cx.moveTo(x + 4, y - 4); cx.lineTo(x + 8, y + 3.6); cx.lineTo(x, y + 3.6);
    cx.closePath(); cx.fill();
  } else if (kind === 'note') {
    cx.beginPath(); cx.arc(x + 2.6, y + 2.6, 1.9, 0, Math.PI * 2); cx.fill();
    cx.beginPath(); cx.moveTo(x + 4.4, y + 2.6); cx.lineTo(x + 4.4, y - 3.6); cx.lineTo(x + 7.2, y - 2.8);
    cx.stroke();
  } else if (kind === 'spark') {
    cx.beginPath();
    cx.moveTo(x + 4, y - 4); cx.lineTo(x + 5.4, y - 1.4); cx.lineTo(x + 8, y);
    cx.lineTo(x + 5.4, y + 1.4); cx.lineTo(x + 4, y + 4); cx.lineTo(x + 2.6, y + 1.4);
    cx.lineTo(x, y); cx.lineTo(x + 2.6, y - 1.4);
    cx.closePath(); cx.fill();
  }
  cx.restore();
}

function roundRect(cx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  cx.beginPath();
  cx.moveTo(x + r, y);
  cx.arcTo(x + w, y, x + w, y + h, r);
  cx.arcTo(x + w, y + h, x, y + h, r);
  cx.arcTo(x, y + h, x, y, r);
  cx.arcTo(x, y, x + w, y, r);
  cx.closePath();
}
