'use strict';
// Tiny DOM toolkit: h() element builder, modals, toasts, menus.

export function h(tag, attrs, ...children) {
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (classes.length) el.className = classes.join(' ');
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className += (el.className ? ' ' : '') + v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function clear(el, ...children) {
  el.textContent = '';
  return append(el, children);
}

export function toast(msg, kind = 'info') {
  let holder = document.querySelector('.toasts');
  if (!holder) { holder = h('div.toasts'); document.body.append(holder); }
  const t = h(`div.toast.${kind}`, {}, msg);
  holder.append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 350); }, kind === 'error' ? 5200 : 2800);
}

export function busy(msg = 'Working…') {
  const el = h('div.busy-overlay', {}, h('div.busy-card', {}, h('div.spinner'), h('div.busy-msg', {}, msg)));
  document.body.append(el);
  return {
    set(m) { el.querySelector('.busy-msg').textContent = m; },
    close() { el.remove(); },
  };
}

export function modal(title, content, { wide, onClose } = {}) {
  const overlay = h('div.modal-overlay', {
    onclick: e => { if (e.target === overlay) close(); },
  });
  const box = h(`div.modal${wide ? '.wide' : ''}`, {},
    h('div.modal-head', {},
      h('div.modal-title', {}, title),
      h('button.icon-btn', { onclick: () => close(), title: 'Close', 'aria-label': 'Close' }, icon('close'))),
    h('div.modal-body'));
  overlay.append(box);
  const body = box.querySelector('.modal-body');
  append(body, [content]);
  document.body.append(overlay);
  const esc = e => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', esc);
  function close() {
    document.removeEventListener('keydown', esc);
    overlay.remove();
    onClose && onClose();
  }
  return { close, body, overlay };
}

export function confirmDlg(title, text, okLabel = 'Delete') {
  return new Promise(resolve => {
    const m = modal(title, h('div', {},
      h('p.dim', {}, text),
      h('div.row.end.gap', {},
        h('button.btn', { onclick: () => { m.close(); resolve(false); } }, 'Cancel'),
        h('button.btn.danger', { onclick: () => { m.close(); resolve(true); } }, okLabel))),
      { onClose: () => resolve(false) });
  });
}

export function menu(anchorEl, items) {
  document.querySelectorAll('.ctx-menu').forEach(m => m.remove());
  const r = anchorEl.getBoundingClientRect();
  const m = h('div.ctx-menu', { style: { top: Math.min(innerHeight - 20, r.bottom + 4) + 'px' } });
  for (const it of items) {
    if (it === '-') { m.append(h('div.menu-sep')); continue; }
    if (!it) continue;
    m.append(h(`button.menu-item${it.danger ? '.danger' : ''}`, {
      disabled: it.disabled,
      onclick: () => { m.remove(); it.action && it.action(); },
    }, it.icon ? h('span.menu-ic', {}, it.icon) : null, it.label));
  }
  document.body.append(m);
  const mw = m.offsetWidth;
  m.style.left = Math.max(8, Math.min(innerWidth - mw - 8, r.left)) + 'px';
  if (r.bottom + m.offsetHeight > innerHeight - 8) m.style.top = Math.max(8, r.top - m.offsetHeight - 4) + 'px';
  setTimeout(() => {
    const off = e => { if (!m.contains(e.target)) { m.remove(); document.removeEventListener('pointerdown', off); } };
    document.addEventListener('pointerdown', off);
  });
  return m;
}

export function avatar(user, size = 24) {
  if (!user) return h('span.avatar', { style: { width: size + 'px', height: size + 'px' } }, '?');
  const el = user.picture
    ? h('img.avatar', { src: user.picture, alt: user.name, referrerpolicy: 'no-referrer' })
    : h('span.avatar', { style: { background: user.color || '#888' } }, (user.name || '?').slice(0, 1).toUpperCase());
  el.style.width = el.style.height = size + 'px';
  el.title = user.name || user.email || '';
  return el;
}

export const fmtBeat = (b, bpb = 4) => `${Math.floor(b / bpb) + 1}.${(Math.floor(b % bpb) + 1)}`;
export const fmtScore = s => (Math.round(s * 10) / 10).toFixed(1);
export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const midiName = m => NOTE_NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);

export function slider(opts) {
  const { min, max, step, value, label, oninput, fmt = v => v } = opts;
  const out = h('span.slider-val', {}, fmt(value));
  const input = h('input', {
    type: 'range', min, max, step, value,
    oninput: e => { out.textContent = fmt(parseFloat(e.target.value)); oninput && oninput(parseFloat(e.target.value)); },
  });
  return h('label.slider', {}, label ? h('span.slider-label', {}, label) : null, input, out);
}

// ---------- SVG icon set (no emojis; stroke-based, inherits currentColor) ----------

const ICON_PATHS = {
  play: [['path', 'M8 5.5v13l11-6.5z', true]],
  stop: [['rect', { x: 7, y: 7, width: 10, height: 10, rx: 1.5, fill: true }]],
  record: [['circle', { cx: 12, cy: 12, r: 5.5, fill: true }]],
  loop: [['path', 'M17 2l4 4-4 4'], ['path', 'M21 6H8a5 5 0 0 0-5 5'], ['path', 'M7 22l-4-4 4-4'], ['path', 'M3 18h13a5 5 0 0 0 5-5']],
  metronome: [['path', 'M9.5 3h5L19 21H5z'], ['path', 'M12 14l6.5-8']],
  piano: [['rect', { x: 3, y: 5, width: 18, height: 14, rx: 1.5 }], ['path', 'M8 5v8'], ['path', 'M12.5 5v8'], ['path', 'M17 5v8']],
  drum: [['path', 'M4 8v8c0 1.7 3.6 3 8 3s8-1.3 8-3V8'], ['path', 'M4 8c0 1.7 3.6 3 8 3s8-1.3 8-3-3.6-3-8-3-8 1.3-8 3z'], ['path', 'M7 2.5L10 7'], ['path', 'M17 2.5L14 7']],
  midi: [['path', 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z'], ['path', 'M14 2v6h6'], ['circle', { cx: 9.6, cy: 16.5, r: 1.6 }], ['path', 'M11.2 16.5V11l3.6 1']],
  clean: [['path', 'M13 3l8 8'], ['path', 'M3 21c4.5-.5 8-2.5 10-6l-4-4c-3.5 2-5.5 5.5-6 10z']],
  pin: [['path', 'M12 21s-7-6.4-7-11a7 7 0 1 1 14 0c0 4.6-7 11-7 11z'], ['circle', { cx: 12, cy: 10, r: 2.4 }]],
  mic: [['rect', { x: 9, y: 2, width: 6, height: 12, rx: 3 }], ['path', 'M5 11a7 7 0 0 0 14 0'], ['path', 'M12 18v4']],
  comment: [['path', 'M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z']],
  users: [['circle', { cx: 9, cy: 8, r: 3.5 }], ['path', 'M2.5 21v-1.5A5.5 5.5 0 0 1 8 14h2a5.5 5.5 0 0 1 5.5 5.5V21'], ['path', 'M16 3.5a3.5 3.5 0 0 1 0 7'], ['path', 'M21.5 21v-1.5a5.5 5.5 0 0 0-3.5-5.1']],
  layers: [['path', 'M12 2L2 8l10 6 10-6z'], ['path', 'M2 13l10 6 10-6']],
  more: [['circle', { cx: 5, cy: 12, r: 1.6, fill: true }], ['circle', { cx: 12, cy: 12, r: 1.6, fill: true }], ['circle', { cx: 19, cy: 12, r: 1.6, fill: true }]],
  back: [['path', 'M15 18l-6-6 6-6']],
  plus: [['path', 'M12 5v14'], ['path', 'M5 12h14']],
  minus: [['path', 'M5 12h14']],
  close: [['path', 'M6 6l12 12'], ['path', 'M18 6L6 18']],
  star: [['path', 'M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z']],
  starFill: [['path', 'M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z', true]],
  warning: [['path', 'M12 4L3 19.5h18z'], ['path', 'M12 10.5v3.5'], ['path', 'M12 16.8v.01']],
  note: [['circle', { cx: 8.5, cy: 17.5, r: 2.6 }], ['path', 'M11.1 17.5V5.5l8-1.8v11'], ['circle', { cx: 16.5, cy: 14.7, r: 2.6 }]],
  spark: [['path', 'M12 3l1.7 5.6L19.5 12l-5.8 1.7L12 20.5l-1.7-6.8L4.5 12l5.8-3.4z']],
  scissors: [['circle', { cx: 6, cy: 6.5, r: 2.4 }], ['circle', { cx: 6, cy: 17.5, r: 2.4 }], ['path', 'M8.2 8L20 17'], ['path', 'M8.2 16L20 7']],
  copy: [['rect', { x: 9, y: 9, width: 11, height: 11, rx: 2 }], ['path', 'M5 15V5a2 2 0 0 1 2-2h10']],
  cut: [['circle', { cx: 6, cy: 6.5, r: 2.4 }], ['circle', { cx: 6, cy: 17.5, r: 2.4 }], ['path', 'M8.2 8L20 17'], ['path', 'M8.2 16L20 7']],
  trash: [['path', 'M3.5 6h17'], ['path', 'M8.5 6V4h7v2'], ['path', 'M6 6l1 14.5h10L18 6'], ['path', 'M10 10.5v6'], ['path', 'M14 10.5v6']],
  undo: [['path', 'M9 14L4 9l5-5'], ['path', 'M4 9h10.5a5.75 5.75 0 1 1 0 11.5H11']],
  redo: [['path', 'M15 14l5-5-5-5'], ['path', 'M20 9H9.5a5.75 5.75 0 1 0 0 11.5H13']],
  download: [['path', 'M12 3v12'], ['path', 'M7 10.5l5 5 5-5'], ['path', 'M4.5 21h15']],
  magnet: [['path', 'M6 3v8a6 6 0 0 0 12 0V3'], ['path', 'M6 3h4.5v5H6z'], ['path', 'M13.5 3H18v5h-4.5z']],
  fx: [['path', 'M4 21v-8'], ['path', 'M4 9V3'], ['path', 'M12 21v-6'], ['path', 'M12 11V3'], ['path', 'M20 21v-4'], ['path', 'M20 13V3'], ['path', 'M1.8 13h4.4'], ['path', 'M9.8 11h4.4'], ['path', 'M17.8 17h4.4']],
  headphones: [['path', 'M3.5 18v-6a8.5 8.5 0 0 1 17 0v6'], ['path', 'M3.5 19a2 2 0 0 0 2 2h1a1.5 1.5 0 0 0 1.5-1.5v-3A1.5 1.5 0 0 0 6.5 15h-3z'], ['path', 'M20.5 19a2 2 0 0 1-2 2h-1a1.5 1.5 0 0 1-1.5-1.5v-3a1.5 1.5 0 0 1 1.5-1.5h3z']],
  swap: [['path', 'M7 16V4'], ['path', 'M3 8l4-4 4 4'], ['path', 'M17 8v12'], ['path', 'M13 16l4 4 4-4']],
  combine: [['path', 'M6 3v5.5A6.5 6.5 0 0 0 12 15'], ['path', 'M18 3v5.5A6.5 6.5 0 0 1 12 15'], ['path', 'M12 15v6'], ['path', 'M9 18.5l3 3 3-3']],
  gear: [['circle', { cx: 12, cy: 12, r: 3.2 }], ['path', 'M19.4 15a1.6 1.6 0 0 0 .3 1.7l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.7-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.2a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.7.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.7 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.2a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.7.3h.1a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.2a1.6 1.6 0 0 0 1 1.5h.1a1.6 1.6 0 0 0 1.7-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.7v.1a1.6 1.6 0 0 0 1.5 1h.2a2 2 0 1 1 0 4h-.2a1.6 1.6 0 0 0-1.5 1z']],
  zoomIn: [['circle', { cx: 11, cy: 11, r: 7 }], ['path', 'M21 21l-4.3-4.3'], ['path', 'M11 8v6'], ['path', 'M8 11h6']],
  zoomOut: [['circle', { cx: 11, cy: 11, r: 7 }], ['path', 'M21 21l-4.3-4.3'], ['path', 'M8 11h6']],
  check: [['path', 'M4 12.5l5 5L20 6.5']],
  edit: [['path', 'M17 3.5a2.6 2.6 0 1 1 3.7 3.7L7.5 20.4 2 22l1.6-5.5z']],
  chevDown: [['path', 'M6 9.5l6 6 6-6']],
  wave: [['path', 'M2 12c2.2-6.5 4.3-6.5 6.5 0s4.3 6.5 6.5 0 4.3-6.5 6.5 0']],
  grid: [['rect', { x: 3.5, y: 3.5, width: 17, height: 17, rx: 2 }], ['path', 'M9.2 3.5v17'], ['path', 'M14.8 3.5v17'], ['path', 'M3.5 9.2h17'], ['path', 'M3.5 14.8h17']],
  variant: [['path', 'M6 3v7a4 4 0 0 0 4 4h8'], ['path', 'M14 10l4 4-4 4'], ['path', 'M6 3v18']],
  archive: [['rect', { x: 3, y: 3.5, width: 18, height: 5, rx: 1 }], ['path', 'M5 8.5V19a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5'], ['path', 'M10 12.5h4']],
  upload: [['path', 'M12 20V8'], ['path', 'M7 13l5-5 5 5'], ['path', 'M4.5 3.5h15']],
  drag: [['circle', { cx: 9, cy: 6, r: 1.4, fill: true }], ['circle', { cx: 15, cy: 6, r: 1.4, fill: true }], ['circle', { cx: 9, cy: 12, r: 1.4, fill: true }], ['circle', { cx: 15, cy: 12, r: 1.4, fill: true }], ['circle', { cx: 9, cy: 18, r: 1.4, fill: true }], ['circle', { cx: 15, cy: 18, r: 1.4, fill: true }]],
  place: [['path', 'M12 3v10'], ['path', 'M8 9l4 4 4-4'], ['rect', { x: 4, y: 16, width: 16, height: 5, rx: 1.5 }]],
};

const SVG_NS = 'http://www.w3.org/2000/svg';
export function icon(name, { size = 16, title } = {}) {
  const def = ICON_PATHS[name] || ICON_PATHS.more;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.9');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.classList.add('ic', 'ic-' + name);
  if (title) {
    const t = document.createElementNS(SVG_NS, 'title');
    t.textContent = title;
    svg.append(t);
  }
  for (const part of def) {
    const [kind, spec, fill] = part;
    if (kind === 'path') {
      const p = document.createElementNS(SVG_NS, 'path');
      p.setAttribute('d', spec);
      if (fill) { p.setAttribute('fill', 'currentColor'); p.setAttribute('stroke', 'none'); }
      svg.append(p);
    } else {
      const el = document.createElementNS(SVG_NS, kind);
      for (const [k, v] of Object.entries(spec)) {
        if (k === 'fill') { el.setAttribute('fill', 'currentColor'); el.setAttribute('stroke', 'none'); }
        else el.setAttribute(k, v);
      }
      svg.append(el);
    }
  }
  return svg;
}
