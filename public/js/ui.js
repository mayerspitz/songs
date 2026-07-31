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
      h('button.icon-btn', { onclick: () => close(), 'aria-label': 'Close' }, '✕')),
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
