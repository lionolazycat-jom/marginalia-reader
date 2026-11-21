// Small DOM + formatting helpers shared by every module.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** Hyperscript-style element builder: h('div.card#id', {onclick}, children...) */
export function h(tag, attrs, ...kids) {
  const m = tag.match(/^([a-z0-9-]+)?((?:[.#][\w-]+)*)$/i);
  const el = document.createElement((m && m[1]) || 'div');
  if (m && m[2]) {
    for (const part of m[2].match(/[.#][\w-]+/g)) {
      if (part[0] === '.') el.classList.add(part.slice(1));
      else el.id = part.slice(1);
    }
  }
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) {
    kids.unshift(attrs);
    attrs = null;
  }
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'style' && typeof v === 'object') {
        for (const [sk, sv] of Object.entries(v)) {
          if (sv == null) continue;
          if (sk.startsWith('--')) el.style.setProperty(sk, sv); else el.style[sk] = sv;
        }
      }
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k in el && typeof v !== 'string' && k !== 'list') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  append(el, kids);
  return el;
}

function append(el, kids) {
  for (const k of kids) {
    if (k == null || k === false) continue;
    if (Array.isArray(k)) append(el, k);
    else el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
}

export const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
export function throttle(fn, ms) {
  let last = 0, t;
  return (...a) => {
    const now = Date.now();
    clearTimeout(t);
    if (now - last >= ms) { last = now; fn(...a); }
    else t = setTimeout(() => { last = Date.now(); fn(...a); }, ms - (now - last));
  };
}
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function fmtBytes(n) {
  if (!n) return '0 KB';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i ? 1 : 0)} ${u[i]}`;
}
export function fmtDuration(sec) {
  sec = Math.round(sec || 0);
  if (sec < 60) return sec ? '<1 min' : '0 min';
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} min`;
  const hh = Math.floor(m / 60), mm = m % 60;
  return mm ? `${hh} h ${mm} min` : `${hh} h`;
}
export function fmtRelative(ts) {
  if (!ts) return 'Never opened';
  const d = Date.now() - ts;
  const min = 60e3, hr = 36e5, day = 864e5;
  if (d < min) return 'Just now';
  if (d < hr) return `${Math.floor(d / min)} min ago`;
  if (d < day) return `${Math.floor(d / hr)} h ago`;
  if (d < 2 * day) return 'Yesterday';
  if (d < 7 * day) return `${Math.floor(d / day)} days ago`;
  return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: new Date(ts).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
}
export const fmtPct = (p) => `${Math.round(clamp(p || 0, 0, 1) * 100)}%`;
export function dayKey(d = new Date()) {
  const z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
}

/** Deterministic hue from a string, for generated covers. */
export function hashHue(s) {
  let x = 0;
  for (let i = 0; i < s.length; i++) x = (x * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(x) % 360;
}

// ---------- toasts ----------
export function toast(msg, opts = {}) {
  const host = $('#toasts');
  const t = h('div.toast', { role: 'status', class: `toast ${opts.kind || ''}` },
    h('span', msg),
    opts.action ? h('button.toast-action', { type: 'button', onclick: () => { opts.action.run(); t.remove(); } }, opts.action.label) : null);
  host.append(t);
  requestAnimationFrame(() => t.classList.add('in'));
  setTimeout(() => { t.classList.remove('in'); setTimeout(() => t.remove(), 300); }, opts.ms || (opts.kind === 'error' ? 6000 : 3200));
}

// ---------- modal dialogs (alert/confirm/prompt are blocked in the host frame) ----------
export function dialog({ title, body, fields = [], actions = [{ label: 'OK', value: true, primary: true }], wide = false }) {
  return new Promise((resolve) => {
    const prev = document.activeElement;
    const inputs = {};
    const form = h('form.dialog-form', { onsubmit: (e) => { e.preventDefault(); finish(actions.find((a) => a.primary)?.value ?? true); } });
    if (body) form.append(typeof body === 'string' ? h('p.dialog-body', body) : body);
    for (const f of fields) {
      const id = 'fld-' + f.name;
      let input;
      if (f.type === 'select') {
        input = h('select', { id, name: f.name }, f.options.map((o) => h('option', { value: o.value, selected: o.value === f.value }, o.label)));
      } else if (f.type === 'textarea') {
        input = h('textarea', { id, name: f.name, rows: f.rows || 4, placeholder: f.placeholder || '' });
        input.value = f.value || '';
      } else {
        input = h('input', { id, name: f.name, type: f.type || 'text', placeholder: f.placeholder || '', autocomplete: 'off' });
        input.value = f.value || '';
      }
      inputs[f.name] = input;
      form.append(h('label.field', { for: id }, h('span.field-label', f.label), input));
    }
    const row = h('div.dialog-actions');
    for (const a of actions) {
      row.append(h('button', { type: a.primary ? 'submit' : 'button', class: `btn ${a.primary ? 'btn-primary' : ''} ${a.danger ? 'btn-danger' : ''}`, onclick: a.primary ? null : () => finish(a.value) }, a.label));
    }
    form.append(row);
    const box = h('div.dialog', { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'dlg-title', class: `dialog ${wide ? 'wide' : ''}` }, h('h2#dlg-title.dialog-title', title), form);
    const scrim = h('div.scrim', { onmousedown: (e) => { if (e.target === scrim) finish(null); } }, box);
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); finish(null); } };
    document.addEventListener('keydown', onKey, true);
    document.body.append(scrim);
    requestAnimationFrame(() => scrim.classList.add('in'));
    const first = fields.length ? inputs[fields[0].name] : row.querySelector('.btn-primary') || row.querySelector('button');
    setTimeout(() => { first?.focus(); first?.select?.(); }, 30);
    function finish(value) {
      document.removeEventListener('keydown', onKey, true);
      scrim.classList.remove('in');
      setTimeout(() => scrim.remove(), 180);
      prev?.focus?.();
      if (value && fields.length) {
        const out = {};
        for (const [k, el] of Object.entries(inputs)) out[k] = el.value;
        resolve({ action: value, values: out });
      } else resolve(value);
    }
  });
}
export const confirmDialog = (title, body, label = 'Remove', danger = true) =>
  dialog({ title, body, actions: [{ label: 'Cancel', value: false }, { label, value: true, primary: true, danger }] });

/** Popover menu anchored to an element. items: [{label, run, danger, icon}] or 'sep'. */
export function menu(anchor, items) {
  closeMenus();
  const m = h('div.menu', { role: 'menu' });
  for (const it of items) {
    if (it === 'sep') { m.append(h('div.menu-sep')); continue; }
    m.append(h('button.menu-item', { type: 'button', role: 'menuitem', class: `menu-item ${it.danger ? 'danger' : ''}`, onclick: (e) => { e.stopPropagation(); closeMenus(); it.run(); } }, it.icon ? icon(it.icon) : null, h('span', it.label)));
  }
  document.body.append(m);
  const r = anchor.getBoundingClientRect();
  const mw = m.offsetWidth, mh = m.offsetHeight;
  let x = r.right - mw, y = r.bottom + 6;
  if (x < 8) x = 8;
  if (y + mh > innerHeight - 8) y = Math.max(8, r.top - mh - 6);
  m.style.left = x + 'px';
  m.style.top = y + 'px';
  setTimeout(() => document.addEventListener('pointerdown', outside, true));
  function outside(e) { if (!m.contains(e.target)) closeMenus(); }
  m._cleanup = () => document.removeEventListener('pointerdown', outside, true);
  m.querySelector('button')?.focus();
  m.addEventListener('keydown', (e) => {
    const btns = $$('button', m);
    const i = btns.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); btns[(i + 1) % btns.length].focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); btns[(i - 1 + btns.length) % btns.length].focus(); }
    if (e.key === 'Escape') { closeMenus(); anchor.focus(); }
  });
  return m;
}
export function closeMenus() {
  for (const m of $$('.menu')) { m._cleanup?.(); m.remove(); }
}

// ---------- icons (inline SVG, 24px grid, 1.6 stroke) ----------
const P = {
  home: 'M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-5v-6h-4v6H5a1 1 0 0 1-1-1z',
  library: 'M5 4h3v16H5zM10 4h3v16h-3zM15.2 4.6l2.9-.8 3.9 15.5-2.9.8z',
  collection: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  bookmark: 'M6 3h12v18l-6-4.5L6 21z',
  highlight: 'M14.5 4.5 19.5 9.5 10 19H5v-5zM12.5 6.5l5 5M4 21h16',
  note: 'M5 3h10l4 4v14H5zM14 3v5h5M8 12h8M8 16h6',
  stats: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  settings: 'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z',
  plus: 'M12 5v14M5 12h14',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  list: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  back: 'M15 18l-6-6 6-6',
  close: 'M6 6l12 12M18 6 6 18',
  toc: 'M4 6h16M4 12h10M4 18h13',
  type: 'M4 19 9 5h1l5 14M6 14h7M15.5 19l3-8h.5l3 8M16.5 16.5h4',
  play: 'M7 4.5v15l12-7.5z',
  pause: 'M7 4h4v16H7zM13 4h4v16h-4z',
  stop: 'M6 6h12v12H6z',
  speaker: 'M4 9v6h4l5 4V5L8 9zM16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11',
  fullscreen: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  exitfs: 'M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
  edit: 'M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  upload: 'M12 16V4M7 9l5-5 5 5M4 20h16',
  download: 'M12 4v12M7 11l5 5 5-5M4 20h16',
  check: 'M5 12.5 10 17 19 7',
  chevronL: 'M15 18l-6-6 6-6',
  chevronR: 'M9 6l6 6-6 6',
  zoomIn: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4M8 11h6M11 8v6',
  zoomOut: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4M8 11h6',
  underline: 'M7 4v7a5 5 0 0 0 10 0V4M5 20h14',
  strike: 'M5 12h14M16 6.5C15 5 13.6 4.5 12 4.5c-2.5 0-4.5 1.3-4.5 3.5 0 1.3.8 2.3 2.2 3M8 17.5c1 1.4 2.4 2 4 2 2.7 0 4.5-1.4 4.5-3.5 0-.9-.3-1.6-.8-2.2',
  book: 'M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2zM4 21V5M8 7h7',
  dict: 'M4 4h11a3 3 0 0 1 3 3v13H7a3 3 0 0 1-3-3zM4 17a3 3 0 0 1 3-3h11M8 8h6',
  translate: 'M4 5h9M8.5 3v2M6 5c.5 3 2.5 5.5 5.5 7M11 5c-.7 3.3-3 6.3-6.5 8M13 21l4-9 4 9M14.3 18h5.4',
  share: 'M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7M16 6l-4-4-4 4M12 2v13',
  filter: 'M4 5h16l-6 8v6l-4-2v-4z',
  sun: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  menu: 'M4 7h16M4 12h16M4 17h16',
  sliders: 'M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M14 4v4M8 10v4M16 16v4',
  target: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 12h.01',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  sparkle: 'M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6',
};
export function icon(name, size = 20) {
  const ns = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(ns, 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('width', size);
  s.setAttribute('height', size);
  s.setAttribute('aria-hidden', 'true');
  s.setAttribute('class', 'ico');
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', P[name] || P.more);
  s.append(p);
  return s;
}
export function iconBtn(name, label, onclick, extra = {}) {
  return h('button', { type: 'button', class: `icon-btn ${extra.class || ''}`, 'aria-label': label, title: extra.title || label, onclick, ...(extra.attrs || {}) }, icon(name, extra.size || 20), extra.text ? h('span.icon-btn-text', extra.text) : null);
}

/** Hashes the first + last 64 KB and the size: cheap duplicate detection for huge files. */
export async function quickHash(blob) {
  const slice = 65536;
  const parts = [blob.slice(0, slice), blob.slice(Math.max(0, blob.size - slice))];
  const buf = new Uint8Array(await new Blob(parts).arrayBuffer());
  try {
    const d = await crypto.subtle.digest('SHA-256', buf);
    return blob.size + '-' + Array.from(new Uint8Array(d).slice(0, 12), (b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    let x = 2166136261;
    for (let i = 0; i < buf.length; i += 7) x = Math.imul(x ^ buf[i], 16777619);
    return blob.size + '-' + (x >>> 0).toString(16);
  }
}

/** Optional platform capabilities (Claude artifact runtime). Resolve to null when absent. */
const capCache = {};
const capValue = {};
export function capability(name) {
  if (!capCache[name]) {
    capCache[name] = (async () => {
      try {
        if (!window.claude || typeof window.claude.use !== 'function') return null;
        return await window.claude.use(name);
      } catch { return null; }
    })().then((v) => { capValue[name] = v || null; return v || null; });
  }
  return capCache[name];
}
/** The capability if it has already resolved, else null (never waits). */
export function capabilityNow(name) { capability(name); return capValue[name] || null; }

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch {
    const ta = h('textarea', { style: { position: 'fixed', opacity: '0' } });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch {}
    ta.remove();
    return ok;
  }
}

/** Offer a file to the viewer: downloads capability if available, otherwise copy text. */
export async function saveFile(filename, text, mime = 'text/plain') {
  const dl = await capability('downloads');
  if (dl) {
    try {
      await dl.save({ filename, data: new Blob([text], { type: mime }) });
      return 'saved';
    } catch (e) {
      if (e && (e.code === 'declined' || e.code === 'cancelled' || /declin|cancel/i.test(e.message || ''))) return 'declined';
    }
  }
  // Phones: the share sheet lets people save to Files/Drive or send the file on.
  if (!window.claude && matchMedia('(pointer: coarse)').matches && navigator.canShare) {
    try {
      const file = new File([text], filename, { type: mime });
      if (navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: filename }); return 'saved'; }
    } catch (e) { if (e && e.name === 'AbortError') return 'declined'; }
  }
  // Plain browser (outside the Claude frame): a normal download link works.
  if (!window.claude) {
    try {
      const a = h('a', { href: URL.createObjectURL(new Blob([text], { type: mime })), download: filename });
      document.body.append(a); a.click(); a.remove();
      return 'saved';
    } catch {}
  }
  return (await copyText(text)) ? 'copied' : 'failed';
}
