// PDF reading engine on PDF.js: virtualized pages (only pages near the view are rendered),
// selectable text layer, percentage-positioned highlight layer (zoom-independent),
// continuous / single / two-page layouts, fit-width / fit-page / custom zoom, pinch zoom.

import { h, clamp, debounce, throttle } from './util.js';
import { getPdfjs, pdfOutline, destToPage, closePdf } from './pdfcore.js';
import { hasSelection } from './flow.js';
import { snapshot, playTurn, reducedMotion } from './turn.js';

const MAX_RENDERED = 10;
const MAX_CANVAS_PIXELS = 12e6;

export class PdfEngine {
  constructor(host, doc, opts) {
    this.kind = 'pdf';
    this.host = host;
    this.doc = doc;
    this.opts = opts;
    this.n = doc.numPages;
    this.settings = {};
    this.annotations = [];
    this.scale = 1;
    this.cur = 0;
    this.sizes = [];
    this.pages = [];           // {el, canvas, text, hl, rendered:scale|0, task}
    this.rendered = new Set();
    this.textCache = new Map();
    this.viewport = h('div.pdf-viewport', { tabindex: '-1' });
    this.inner = h('div.pdf-pages');
    this.viewport.append(this.inner);
    host.append(this.viewport);
    this.toc = [];
  }

  async init() {
    this.lib = await getPdfjs();
    const p1 = await this.doc.getPage(1);
    const v = p1.getViewport({ scale: 1 });
    for (let i = 0; i < this.n; i++) this.sizes.push({ w: v.width, h: v.height, known: i === 0 });
    if (this.n <= 400) await this.loadSizes(1, this.n);
    else this.loadSizes(1, this.n);   // background
    try { this.labels = await this.doc.getPageLabels(); } catch { this.labels = null; }
    for (let i = 0; i < this.n; i++) {
      const el = h('div.pdf-page', { dataset: { p: i } });
      const canvas = h('canvas.pdf-canvas', { width: 0, height: 0 });
      const hl = h('div.pdf-hl');
      el.append(canvas, hl, h('div.pdf-pagenum', this.pageName(i)));
      this.pages.push({ el, canvas, hl, text: null, links: null, rendered: 0, task: null });
    }
    this.io = new IntersectionObserver((ents) => {
      for (const e of ents) {
        const i = +e.target.dataset.p;
        if (e.isIntersecting) this.visible.add(i); else this.visible.delete(i);
      }
      this.scheduleRender();
    }, { root: this.viewport, rootMargin: '120% 0px 120% 0px' });
    this.visible = new Set();
    this.bind();
    pdfOutline(this.doc).then((o) => { this.toc = o.map((t) => ({ label: t.label, depth: t.depth, loc: t.page == null ? null : { page: t.page, y: 0 } })); this.opts.onToc?.(); });
  }

  async loadSizes(from, to) {
    for (let i = from; i < to; i++) {
      try {
        const p = await this.doc.getPage(i + 1);
        const v = p.getViewport({ scale: 1 });
        const s = this.sizes[i];
        const changed = Math.abs(s.w - v.width) > 0.5 || Math.abs(s.h - v.height) > 0.5;
        this.sizes[i] = { w: v.width, h: v.height, known: true };
        if (changed && this.ready) this.sizePage(i);
      } catch {}
      if (i % 50 === 49) await new Promise((r) => setTimeout(r));
    }
  }

  pageName(i) {
    const l = this.labels?.[i];
    return l && l !== String(i + 1) ? `${l}` : `${i + 1}`;
  }

  bind() {
    this.ro = new ResizeObserver(debounce(() => { if (this.ready && typeof this.settings.zoom !== 'number') this.applyZoom(); }, 150));
    this.ro.observe(this.viewport);
    this.viewport.addEventListener('scroll', throttle(() => { if (this.mode === 'scroll') this.emit(); }, 100), { passive: true });
    this.viewport.addEventListener('click', (e) => this.onClick(e));
    this.viewport.addEventListener('wheel', (e) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        this.zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1);
        return;
      }
      if (this.mode !== 'scroll') {
        const v = this.viewport;
        const atBottom = v.scrollTop + v.clientHeight >= v.scrollHeight - 2, atTop = v.scrollTop <= 0;
        const now = Date.now();
        if (Math.abs(e.deltaY) < 14 || now - (this.wheelT || 0) < 450) return;
        if (e.deltaY > 0 && atBottom) { this.wheelT = now; e.preventDefault(); this.next(); }
        else if (e.deltaY < 0 && atTop) { this.wheelT = now; e.preventDefault(); this.prev(); }
      }
    }, { passive: false });
    // pinch zoom + swipe
    let pinch = null, sx = 0, sy = 0, st = 0;
    this.viewport.addEventListener('touchstart', (e) => {
      if (e.touches.length === 2) {
        const [a, b] = e.touches;
        pinch = { d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), cx: (a.clientX + b.clientX) / 2, cy: (a.clientY + b.clientY) / 2, ratio: 1 };
        const r = this.inner.getBoundingClientRect();
        this.inner.style.transformOrigin = `${pinch.cx - r.left}px ${pinch.cy - r.top}px`;
      } else if (e.touches.length === 1) { sx = e.touches[0].clientX; sy = e.touches[0].clientY; st = Date.now(); }
    }, { passive: true });
    this.viewport.addEventListener('touchmove', (e) => {
      if (!pinch || e.touches.length !== 2) return;
      e.preventDefault();
      const [a, b] = e.touches;
      pinch.ratio = clamp(Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) / pinch.d, 0.4, 4);
      this.inner.style.transform = `scale(${pinch.ratio})`;
    }, { passive: false });
    this.viewport.addEventListener('touchend', (e) => {
      if (pinch && e.touches.length < 2) {
        const r = pinch.ratio; pinch = null;
        this.inner.style.transform = '';
        if (Math.abs(r - 1) > 0.03) this.zoomBy(r);
        return;
      }
      if (this.mode === 'scroll' || e.changedTouches.length !== 1 || hasSelection()) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - sx, dy = t.clientY - sy;
      const v = this.viewport;
      const fitsH = v.scrollWidth <= v.clientWidth + 2;
      if (fitsH && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5 && Date.now() - st < 700) { this.swiped = Date.now(); dx < 0 ? this.next() : this.prev(); }
    }, { passive: true });
  }

  onClick(e) {
    const a = e.target.closest('a.pdf-link');
    if (a) {
      if (a.dataset.page) { e.preventDefault(); this.goTo({ page: +a.dataset.page, y: 0 }); }
      return;
    }
    if (hasSelection()) return;
    if (this.swiped && Date.now() - this.swiped < 400) return;
    const pageEl = e.target.closest('.pdf-page');
    if (pageEl) {
      const i = +pageEl.dataset.p;
      const r = pageEl.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
      const hit = this.annotations.find((an) => an.loc.page === i && an.loc.rects.some(([rx, ry, rw, rh]) => x >= rx && x <= rx + rw && y >= ry - 0.004 && y <= ry + rh + 0.004));
      if (hit) { this.opts.onAnnotation?.(hit.id, this.rectForAnnotation(hit.id)); return; }
    }
    const vr = this.viewport.getBoundingClientRect();
    const fx = (e.clientX - vr.left) / vr.width;
    // In continuous mode the edges are for reading, not page turns.
    if (this.mode === 'scroll') { this.opts.onTap?.('center', e); return; }
    const [zl, zr] = this.opts.zones?.() || [0.28, 0.72];
    this.opts.onTap?.(fx < zl ? 'left' : fx > zr ? 'right' : 'center', e);
  }

  // ---------- settings ----------
  applySettings(s) {
    const prev = this.settings;
    const loc = this.ready ? this.currentLoc() : null;
    this.settings = s;
    const modeChanged = prev.pdfLayout !== s.pdfLayout || prev.pdfCoverAlone !== s.pdfCoverAlone;
    this.mode = s.pdfLayout || 'scroll';
    this.viewport.classList.toggle('mode-scroll', this.mode === 'scroll');
    this.viewport.classList.toggle('mode-paged', this.mode !== 'scroll');
    this.viewport.classList.toggle('mode-double', this.mode === 'double');
    this.viewport.dataset.tint = s.pdfTint ? s.theme : 'none';
    if (!this.ready) return;
    if (modeChanged) this.build(loc);
    else if (prev.zoom !== s.zoom) this.applyZoom(loc);
  }

  async open(loc) {
    loc = loc || { page: 0, y: 0 };
    this.build(loc);
    this.ready = true;
    this.emit();
  }

  spreads() {
    if (this.mode === 'single') return Array.from({ length: this.n }, (_, i) => [i]);
    const out = [];
    let i = 0;
    if (this.settings.pdfCoverAlone !== false && this.n > 1) { out.push([0]); i = 1; }
    for (; i < this.n; i += 2) out.push(i + 1 < this.n ? [i, i + 1] : [i]);
    return out;
  }
  spreadOf(page) {
    const sp = this.spreads();
    return Math.max(0, sp.findIndex((s) => s.includes(page)));
  }

  build(loc) {
    this.io.disconnect();
    this.visible.clear();
    this.inner.textContent = '';
    this.cur = clamp(loc?.page || 0, 0, this.n - 1);
    this.scale = this.computeScale();
    if (this.mode === 'scroll') {
      for (let i = 0; i < this.n; i++) { this.sizePage(i); this.inner.append(this.pages[i].el); this.io.observe(this.pages[i].el); }
      this.scrollToLoc(loc);
    } else {
      this.showSpread(this.spreadOf(this.cur));
    }
  }

  showSpread(si) {
    const sp = this.spreads();
    si = clamp(si, 0, sp.length - 1);
    this.spread = si;
    this.inner.textContent = '';
    const row = h('div.pdf-spread');
    for (const i of sp[si]) { this.sizePage(i); row.append(this.pages[i].el); }
    this.inner.append(row);
    this.cur = sp[si][0];
    this.visible = new Set(sp[si]);
    // Pre-render neighbours for instant page turns
    for (const j of [...(sp[si + 1] || []), ...(sp[si - 1] || [])]) this.visible.add(j);
    this.viewport.scrollTop = 0;
    this.scheduleRender();
    this.emit();
  }

  computeScale() {
    const z = this.settings.zoom ?? 'auto';
    if (typeof z === 'number') return z;
    const s = this.sizes[this.cur] || this.sizes[0];
    const narrow = this.viewport.clientWidth < 600;
    const pad = narrow ? 8 : 32;
    const cols = this.mode === 'double' ? 2 : 1;
    const gap = cols === 2 ? 12 : 0;
    const w = (this.viewport.clientWidth - pad * 2 - gap) / cols;
    const hgt = this.viewport.clientHeight - 32;
    const fw = w / s.w;
    if (z === 'fit-page') return clamp(Math.min(fw, hgt / s.h), 0.1, 8);
    // Auto: fit the width, but never blow a page up beyond a comfortable reading size.
    if (z === 'auto') return clamp(Math.min(fw, 1.5), 0.1, 8);
    return clamp(fw, 0.1, 8);
  }

  sizePage(i) {
    const p = this.pages[i], s = this.sizes[i];
    const w = Math.floor(s.w * this.scale), hh = Math.floor(s.h * this.scale);
    p.el.style.width = w + 'px';
    p.el.style.height = hh + 'px';
    p.el.style.setProperty('--scale-factor', this.scale);
    p.el.style.setProperty('--total-scale-factor', this.scale);
    p.el.style.setProperty('--user-unit', 1);
    p.el.style.setProperty('--scale-round-x', '1px');
    p.el.style.setProperty('--scale-round-y', '1px');
    if (p.rendered && p.rendered !== this.scale) p.stale = true;
  }

  applyZoom(loc) {
    loc = loc || this.currentLoc();
    this.scale = this.computeScale();
    for (let i = 0; i < this.n; i++) this.sizePage(i);
    if (this.mode === 'scroll') this.scrollToLoc(loc); else this.viewport.scrollTop = 0;
    this.scheduleRender();
    this.emit();
    this.opts.onZoom?.(this.scale);
  }

  zoomBy(f) {
    const ns = clamp(Math.round(this.scale * f * 100) / 100, 0.25, 6);
    this.opts.onZoomRequest?.(ns);
  }

  scheduleRender() {
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(() => this.renderVisible());
  }

  async renderVisible() {
    if (this.busy) { this.again = true; return; }
    this.busy = true;
    try { await this.renderVisibleInner(); } finally {
      this.busy = false;
      if (this.again) { this.again = false; this.scheduleRender(); }
    }
  }

  async renderVisibleInner() {
    const order = [...this.visible].sort((a, b) => Math.abs(a - this.cur) - Math.abs(b - this.cur));
    for (const i of order) {
      const p = this.pages[i];
      if (p.rendered === this.scale && !p.stale) continue;
      if (!this.visible.has(i)) continue;
      await this.renderPage(i);
    }
    // Free memory far from the view
    if (this.rendered.size > MAX_RENDERED) {
      const far = [...this.rendered].filter((i) => !this.visible.has(i)).sort((a, b) => Math.abs(b - this.cur) - Math.abs(a - this.cur));
      for (const i of far.slice(0, this.rendered.size - MAX_RENDERED)) this.unrender(i);
    }
  }

  unrender(i) {
    const p = this.pages[i];
    p.task?.cancel();
    p.canvas.width = 0; p.canvas.height = 0;
    p.text?.remove(); p.text = null;
    p.links?.remove(); p.links = null;
    p.rendered = 0;
    p.el.classList.remove('is-rendered');
    this.rendered.delete(i);
  }

  async renderPage(i) {
    const p = this.pages[i];
    const scale = this.scale;
    p.task?.cancel();
    let page;
    try { page = await this.doc.getPage(i + 1); } catch { return; }
    const vp = page.getViewport({ scale });
    const dpr = window.devicePixelRatio || 1;
    let out = dpr;
    if (vp.width * vp.height * out * out > MAX_CANVAS_PIXELS) out = Math.sqrt(MAX_CANVAS_PIXELS / (vp.width * vp.height));
    const canvas = document.createElement('canvas');
    canvas.className = 'pdf-canvas';
    canvas.width = Math.floor(vp.width * out);
    canvas.height = Math.floor(vp.height * out);
    const ctx = canvas.getContext('2d', { alpha: false });
    const task = page.render({ canvasContext: ctx, viewport: vp, canvas, transform: out !== 1 ? [out, 0, 0, out, 0, 0] : null });
    p.task = task;
    try { await task.promise; }
    catch (e) { if (e?.name !== 'RenderingCancelledException') console.warn('render', i, e); return; }
    if (scale !== this.scale) return;
    p.canvas.replaceWith(canvas);
    p.canvas = canvas;
    p.rendered = scale; p.stale = false;
    p.el.classList.add('is-rendered');
    this.rendered.add(i);
    // text layer
    p.text?.remove();
    const tl = h('div.textLayer');
    p.el.append(tl);
    p.text = tl;
    try {
      const layer = new this.lib.TextLayer({ textContentSource: page.streamTextContent({ includeMarkedContent: true, disableNormalization: true }), container: tl, viewport: vp });
      await layer.render();
      tl.style.width = Math.floor(vp.width) + 'px';
      tl.style.height = Math.floor(vp.height) + 'px';
      tl.append(h('div.endOfContent'));
    } catch {}
    this.paintPage(i);
    this.renderLinks(i, page, vp);
    if (this.pendingMark?.page === i) { const m = this.pendingMark; this.pendingMark = null; this.markText(i, m.text, m.cls); }
    this.opts.onPageRendered?.(i);
  }

  async renderLinks(i, page, vp) {
    const p = this.pages[i];
    p.links?.remove();
    let anns;
    try { anns = await page.getAnnotations({ intent: 'display' }); } catch { return; }
    const links = anns.filter((a) => a.subtype === 'Link' && (a.dest || a.url));
    if (!links.length) return;
    const layer = h('div.pdf-links');
    const [vx, vy, vw, vh] = page.view;
    const W = vw - vx, H = vh - vy;
    for (const a of links) {
      const [x1, y1, x2, y2] = a.rect;
      const el = h('a.pdf-link', { style: { left: ((Math.min(x1, x2) - vx) / W) * 100 + '%', top: ((vh - Math.max(y1, y2)) / H) * 100 + '%', width: (Math.abs(x2 - x1) / W) * 100 + '%', height: (Math.abs(y2 - y1) / H) * 100 + '%' } });
      if (a.url) { el.href = a.url; el.target = '_blank'; el.rel = 'noopener noreferrer'; el.title = a.url; }
      else {
        const pg = await destToPage(this.doc, a.dest);
        if (pg == null) continue;
        el.dataset.page = pg; el.href = '#'; el.title = `Go to page ${this.pageName(pg)}`;
      }
      layer.append(el);
    }
    p.el.append(layer);
    p.links = layer;
  }

  // ---------- navigation ----------
  // Reference line: positions are measured where reading happens, just below the toolbar.
  get refLine() { return Math.min(96, this.viewport.clientHeight * 0.2); }

  scrollToLoc(loc) {
    const i = clamp(loc?.page || 0, 0, this.n - 1);
    const el = this.pages[i].el;
    this.viewport.scrollTop = Math.max(0, el.offsetTop + (loc?.y || 0) * el.offsetHeight - this.refLine);
    this.cur = i;
  }

  async goTo(loc, o = {}) {
    if (!loc) return;
    const i = clamp(loc.page || 0, 0, this.n - 1);
    if (this.mode === 'scroll') {
      const el = this.pages[i].el;
      const top = el.offsetTop + (loc.y || 0) * el.offsetHeight - this.refLine;
      this.viewport.scrollTo({ top: Math.max(0, top), behavior: o.smooth ? 'smooth' : 'auto' });
      this.cur = i;
      this.emit();
    } else {
      this.cur = i;
      this.showSpread(this.spreadOf(i));
      if (loc.y) {
        const el = this.pages[i].el;
        this.viewport.scrollTop = Math.max(0, el.offsetTop + loc.y * el.offsetHeight - this.viewport.clientHeight * 0.3);
      }
    }
  }

  next() {
    if (this.mode === 'scroll') { this.viewport.scrollBy({ top: this.viewport.clientHeight * 0.9, behavior: 'smooth' }); return; }
    if (this.spread < this.spreads().length - 1) this.turn('next', () => this.showSpread(this.spread + 1)); else this.opts.onEnd?.();
  }
  prev() {
    if (this.mode === 'scroll') { this.viewport.scrollBy({ top: -this.viewport.clientHeight * 0.9, behavior: 'smooth' }); return; }
    if (this.spread > 0) this.turn('prev', () => this.showSpread(this.spread - 1));
  }
  /** The page(s) on screen as one canvas, for saving or sharing. */
  captureCanvas() {
    const vr = this.viewport.getBoundingClientRect();
    const vis = [...this.viewport.querySelectorAll('.pdf-page')].map((el) => ({ el, r: el.getBoundingClientRect(), cv: el.querySelector('canvas') }))
      .filter((x) => x.cv && x.cv.width > 0 && x.r.bottom > vr.top && x.r.top < vr.bottom && x.r.right > vr.left && x.r.left < vr.right);
    if (!vis.length) return null;
    const L = Math.max(vr.left, Math.min(...vis.map((x) => x.r.left))), T = Math.max(vr.top, Math.min(...vis.map((x) => x.r.top)));
    const R = Math.min(vr.right, Math.max(...vis.map((x) => x.r.right))), B = Math.min(vr.bottom, Math.max(...vis.map((x) => x.r.bottom)));
    const k = vis[0].cv.width / vis[0].r.width || 1;
    const out = document.createElement('canvas');
    out.width = Math.round((R - L) * k); out.height = Math.round((B - T) * k);
    const ctx = out.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, out.width, out.height);
    for (const { r, cv } of vis) {
      ctx.save();
      try { const f = getComputedStyle(cv).filter; if (f && f !== 'none') ctx.filter = f; } catch { /* unsupported */ }
      ctx.drawImage(cv, (r.left - L) * k, (r.top - T) * k, r.width * k, r.height * k);
      ctx.restore();
    }
    return out;
  }
  turn(dir, change) {
    const st = this.settings.pageAnim || 'curl';
    if (st === 'none' || reducedMotion() || !this.ready) { change(); return; }
    const sn = snapshot(this.viewport, this.host);
    change();
    playTurn(this.host, sn, dir, st, this.viewport);
  }
  goToFraction(f) {
    const x = clamp(f, 0, 1) * this.n;
    const page = clamp(Math.floor(x), 0, this.n - 1);
    return this.goTo({ page, y: this.mode === 'scroll' ? x - page : 0 });
  }

  currentLoc() {
    if (!this.ready) return { page: this.cur, y: 0 };
    if (this.mode !== 'scroll') return { page: this.cur, y: 0 };
    const top = this.viewport.scrollTop + this.refLine + 1;
    // binary search on offsetTop
    let lo = 0, hi = this.n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.pages[mid].el.offsetTop <= top) lo = mid; else hi = mid - 1;
    }
    const el = this.pages[lo].el;
    const y = clamp((top - el.offsetTop) / Math.max(1, el.offsetHeight), 0, 0.999);
    this.cur = lo;
    return { page: lo, y: Math.round(y * 1000) / 1000 };
  }

  emit() {
    clearTimeout(this.emitT);
    this.emitT = setTimeout(() => this.opts.onRelocate?.(this.info(this.currentLoc())), 30);
  }

  info(loc) {
    const sp = this.mode === 'double' ? this.spreads()[this.spread] : null;
    const progress = clamp((loc.page + (loc.y || 0) + (sp && sp.length === 2 ? 1 : 0)) / this.n, 0, 1);
    const shown = sp ? sp.map((i) => this.pageName(i)).join('–') : this.pageName(loc.page);
    const label = this.labels && this.labels[loc.page] && this.labels[loc.page] !== String(loc.page + 1) ? `Page ${shown} (${loc.page + 1} of ${this.n})` : `Page ${shown} of ${this.n}`;
    const t = this.tocIndexFor(loc);
    return {
      loc, progress: loc.page === this.n - 1 && (loc.y || 0) > 0.3 ? 1 : progress, page: loc.page + 1, totalPages: this.n, pageLabel: label,
      chapterTitle: t >= 0 ? this.toc[t].label : '', chapterIndex: t,
      atStart: loc.page === 0 && !(loc.y > 0.02), atEnd: loc.page >= this.n - 1 || (sp && sp.includes(this.n - 1)),
      pagesLeftInChapter: this.pagesLeftInChapter(loc),
    };
  }
  pagesLeftInChapter(loc) {
    const t = this.tocIndexFor(loc);
    const nextT = this.toc.slice(t + 1).find((x) => x.loc && x.loc.page > loc.page);
    if (!nextT) return null;
    return nextT.loc.page - loc.page - 1;
  }
  tocIndexFor(loc) {
    let best = -1;
    this.toc.forEach((t, i) => { if (t.loc && t.loc.page <= loc.page) best = i; });
    return best;
  }
  locLabel(loc) { const t = this.tocIndexFor(loc); return t >= 0 ? `${this.toc[t].label} · p. ${this.pageName(loc.page)}` : `Page ${this.pageName(loc.page)}`; }
  progressOf(loc) { return clamp((loc.page + (loc.y || 0)) / this.n, 0, 1); }

  // ---------- annotations ----------
  setAnnotations(list) {
    this.annotations = list.filter((a) => a.loc?.kind === 'pdf');
    for (const i of this.rendered) this.paintPage(i);
  }
  repaint(i) { this.paintPage(i); }

  paintPage(i) {
    const p = this.pages[i];
    p.hl.textContent = '';
    for (const a of this.annotations) {
      if (a.loc.page !== i) continue;
      for (const [x, y, w, hh] of a.loc.rects) {
        p.hl.append(h('div', { class: `pdf-mark hl-${a.style || 'highlight'} c-${a.color || 'yellow'}`, dataset: { id: a.id }, style: { left: x * 100 + '%', top: y * 100 + '%', width: w * 100 + '%', height: hh * 100 + '%' } }));
      }
      if (a.note) {
        const [x, y] = a.loc.rects[0];
        p.hl.append(h('div.pdf-note-dot', { dataset: { id: a.id }, style: { left: x * 100 + '%', top: y * 100 + '%' } }));
      }
    }
  }

  selectionLoc() {
    const sel = getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    const startEl = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
    const pageEl = startEl?.closest('.pdf-page');
    if (!pageEl || !this.inner.contains(pageEl)) return null;
    const page = +pageEl.dataset.p;
    const pr = pageEl.getBoundingClientRect();
    const raw = [...range.getClientRects()].filter((r) => r.width > 1 && r.height > 1 && r.bottom > pr.top && r.top < pr.bottom && r.right > pr.left && r.left < pr.right && r.width < pr.width * 0.98 + 50);
    if (!raw.length) return null;
    const rects = mergeRects(raw.map((r) => [(r.left - pr.left) / pr.width, (r.top - pr.top) / pr.height, r.width / pr.width, r.height / pr.height]));
    const text = sel.toString().replace(/\s+/g, ' ').trim();
    if (!text) return null;
    return { kind: 'pdf', page, rects, text, rect: range.getBoundingClientRect() };
  }

  rectForAnnotation(id) {
    const el = this.inner.querySelector(`.pdf-mark[data-id="${id}"]`);
    return el ? el.getBoundingClientRect() : null;
  }

  // ---------- text & search ----------
  async pageText(i) {
    if (this.textCache.has(i)) return this.textCache.get(i);
    let s = '';
    try {
      const page = await this.doc.getPage(i + 1);
      const tc = await page.getTextContent();
      for (const it of tc.items) { if (it.str !== undefined) { s += it.str; if (it.hasEOL) s += '\n'; } }
    } catch {}
    s = s.replace(/[ \t]+/g, ' ');
    this.textCache.set(i, s);
    return s;
  }

  async search(q, onResult, signal) {
    const needle = q.toLowerCase();
    let count = 0;
    for (let i = 0; i < this.n; i++) {
      if (signal?.aborted) return count;
      const t = await this.pageText(i);
      const flat = t.replace(/\n/g, ' ');
      const low = flat.toLowerCase();
      let p = low.indexOf(needle);
      while (p >= 0) {
        const a = Math.max(0, p - 50), b = Math.min(flat.length, p + needle.length + 70);
        onResult({ loc: { page: i, y: 0, q: flat.slice(p, p + needle.length) }, label: this.locLabel({ page: i }), before: (a > 0 ? '…' : '') + flat.slice(a, p), match: flat.slice(p, p + needle.length), after: flat.slice(p + needle.length, b) + (b < flat.length ? '…' : ''), progress: i / this.n });
        if (++count >= 500) return count;
        p = low.indexOf(needle, p + needle.length);
      }
      this.opts.onSearchProgress?.((i + 1) / this.n);
    }
    return count;
  }

  async showSearchHit(loc) {
    this.clearMarks('search-hit');
    await this.goTo({ page: loc.page, y: 0 });
    if (!this.markText(loc.page, loc.q, 'search-hit')) this.pendingMark = { page: loc.page, text: loc.q, cls: 'search-hit' };
  }

  /** Mark text-layer spans covering `text` (whitespace-insensitive). Scrolls it into view. */
  markText(i, text, cls) {
    const tl = this.pages[i]?.text;
    if (!tl || !text) return false;
    const spans = [...tl.querySelectorAll('span')].filter((s) => !s.children.length);
    let joined = '';
    const owner = [];
    spans.forEach((s, si) => { for (const ch of s.textContent) { if (/\s/.test(ch)) continue; joined += ch.toLowerCase(); owner.push(si); } });
    const needle = text.toLowerCase().replace(/\s+/g, '');
    const p = joined.indexOf(needle);
    if (p < 0) return false;
    const hit = new Set(owner.slice(p, p + needle.length));
    let first = null;
    for (const si of hit) { spans[si].classList.add(cls); first = first || spans[si]; }
    if (first && this.mode === 'scroll') {
      const r = first.getBoundingClientRect(), vr = this.viewport.getBoundingClientRect();
      if (r.top < vr.top + 40 || r.bottom > vr.bottom - 60) this.viewport.scrollBy({ top: r.top - vr.top - vr.height * 0.3, behavior: 'smooth' });
    }
    return true;
  }

  clearMarks(cls) {
    for (const el of this.inner.querySelectorAll('.' + cls)) el.classList.remove(cls);
  }

  async sentencesFrom(loc) {
    const out = [];
    const t = (await this.pageText(loc.page)).replace(/-\n(?=\p{Ll})/gu, '').replace(/\n/g, ' ');
    const re = /[^.!?…]+(?:[.!?…]+["'”’)\]]*|$)/g;
    let m;
    while ((m = re.exec(t))) {
      if (!m[0]) { re.lastIndex++; continue; }
      const text = m[0].trim();
      if (!text || !/[\p{L}\p{N}]/u.test(text)) continue;
      out.push({ text, loc: { page: loc.page, y: 0 }, mark: text });
    }
    return out;
  }

  async markSpeaking(seg) {
    this.clearMarks('tts-mark');
    if (!seg) return;
    if (this.mode === 'scroll') {
      const vr = this.viewport.getBoundingClientRect();
      const r = this.pages[seg.loc.page].el.getBoundingClientRect();
      if (r.bottom < vr.top + 40 || r.top > vr.bottom - 40) await this.goTo(seg.loc);
    } else if (!this.spreads()[this.spread].includes(seg.loc.page)) await this.goTo(seg.loc);
    if (!this.markText(seg.loc.page, seg.mark, 'tts-mark')) this.pendingMark = { page: seg.loc.page, text: seg.mark, cls: 'tts-mark' };
  }

  destroy() {
    this.io?.disconnect();
    this.ro?.disconnect();
    for (const p of this.pages) p.task?.cancel();
    this.viewport.remove();
    closePdf(this.doc);
  }
}

/** Merge per-glyph-run rects into line rects. Input/Output: [x,y,w,h] normalized. */
function mergeRects(rs) {
  rs.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const lines = [];
  for (const r of rs) {
    const L = lines.find((l) => Math.abs(l[1] + l[3] / 2 - (r[1] + r[3] / 2)) < Math.max(l[3], r[3]) * 0.5 && r[0] <= l[0] + l[2] + 0.02 && r[0] + r[2] >= l[0] - 0.02);
    if (L) {
      const x1 = Math.min(L[0], r[0]), y1 = Math.min(L[1], r[1]);
      const x2 = Math.max(L[0] + L[2], r[0] + r[2]), y2 = Math.max(L[1] + L[3], r[1] + r[3]);
      L[0] = x1; L[1] = y1; L[2] = x2 - x1; L[3] = y2 - y1;
    } else lines.push([...r]);
  }
  return lines.map((l) => l.map((v) => Math.round(v * 10000) / 10000));
}
