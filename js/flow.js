// Reflowable reading engine (EPUB, FB2, TXT, Markdown, HTML, CBZ).
// Paginated mode lays one chapter into CSS columns and slides between pages;
// scroll mode stacks every chapter. Positions are {ch, off}: a character offset
// into the chapter's text, so they survive font, size and layout changes.

import { h, debounce, clamp, throttle } from './util.js';
import { FONTS } from './settings.js';
import { bindPenDrag } from './pen.js';
import { snapshot, playTurn, clearTurn, reducedMotion, opaqueBg } from './turn.js';

export class FlowEngine {
  constructor(host, book, opts) {
    this.host = host;
    this.book = book;            // {chapters, toc, image(), comic}
    this.opts = opts;            // callbacks: onRelocate, onTap, onAnnotation, onLink, onSelection
    this.kind = 'flow';
    this.settings = {};
    this.annotations = [];
    this.page = 0;
    this.pages = 1;
    this.ch = 0;
    this.chLens = book.chapters.map((c) => c.chars || 0);
    this.recount();
    this.viewport = h('div.flow-viewport');
    this.frame = h('div.flow-frame');
    this.content = h('div.flow-content');
    this.frame.append(this.content);
    this.viewport.append(this.frame);
    host.append(this.viewport);
    this.toc = (book.toc || []).map((t) => ({ label: t.label, depth: t.depth, loc: t.chapter == null ? null : { ch: t.chapter, id: t.id } }));
    this.bind();
  }

  recount() {
    this.chStarts = [];
    let acc = 0;
    for (const n of this.chLens) { this.chStarts.push(acc); acc += n; }
    this.total = Math.max(1, acc);
  }

  // ---------- setup ----------
  bind() {
    this.onResize = debounce(() => this.relayout(), 140);
    this.ro = new ResizeObserver(() => this.onResize());
    this.ro.observe(this.viewport);
    this.viewport.addEventListener('click', (e) => this.onClick(e));
    this.frame.addEventListener('scroll', throttle(() => { if (this.mode === 'scroll') this.emit(); }, 120), { passive: true });
    let wheelLock = 0;
    this.viewport.addEventListener('wheel', (e) => {
      if (this.mode !== 'paged' || e.ctrlKey) return;
      const d = Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
      if (Math.abs(d) < 12) return;
      e.preventDefault();
      const now = Date.now();
      if (now - wheelLock < 420) return;
      wheelLock = now;
      d > 0 ? this.next() : this.prev();
    }, { passive: false });
    bindPenDrag(this.viewport, () => this.mode === 'paged' && !!this.opts.penOn?.());
    // Swipe page turns (touch). Long-press selection is left to the browser.
    let sx = 0, sy = 0, st = 0, tracking = false;
    this.viewport.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) { tracking = false; return; }
      tracking = true; sx = e.touches[0].clientX; sy = e.touches[0].clientY; st = Date.now();
    }, { passive: true });
    this.viewport.addEventListener('touchend', (e) => {
      if (!tracking || this.mode !== 'paged') return;
      tracking = false;
      const t = e.changedTouches[0];
      const dx = t.clientX - sx, dy = t.clientY - sy;
      if (hasSelection() || this.opts.penOn?.()) return;
      if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.4 && Date.now() - st < 700) {
        this.swiped = Date.now();
        dx < 0 ? this.next() : this.prev();
      }
    }, { passive: true });
  }

  onClick(e) {
    const link = e.target.closest('a');
    if (link) {
      if (link.dataset.link) {
        e.preventDefault();
        const [ch, id] = link.dataset.link.split('|');
        this.opts.onLink?.({ ch: +ch, id }, link);
      }
      return;
    }
    const hl = e.target.closest('.hl');
    if (hl && !hasSelection()) { this.opts.onAnnotation?.(hl.dataset.id, hl.getBoundingClientRect()); return; }
    if (hasSelection()) return;
    if (this.swiped && Date.now() - this.swiped < 400) return;
    const r = this.viewport.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const [zl, zr] = this.opts.zones?.() || [0.28, 0.72];
    if (this.opts.penOn?.() && this.mode === 'paged' && (x < zl || x > zr)) return;   // pen on: edge taps don't turn pages
    this.opts.onTap?.(x < zl ? 'left' : x > zr ? 'right' : 'center', e);
  }

  // ---------- settings / layout ----------
  applySettings(s) {
    const prevMode = this.mode;
    const loc = this.rendered ? this.currentLoc() : null;
    this.settings = s;
    this.mode = s.flowLayout === 'scroll' ? 'scroll' : 'paged';
    const st = this.viewport.style;
    st.setProperty('--rd-font', (FONTS[s.font] || FONTS.literata).stack);
    st.setProperty('--rd-size', s.fontSize + 'px');
    st.setProperty('--rd-lh', s.lineHeight);
    st.setProperty('--rd-para', s.paraSpacing + 'em');
    st.setProperty('--rd-indent', s.indent ? '1.5em' : '0');
    st.setProperty('--rd-align', s.align);
    st.setProperty('--rd-weight', s.fontWeight || 400);
    st.setProperty('--rd-letter', (s.letterSpacing || 0) + 'em');
    this.viewport.classList.toggle('is-paged', this.mode === 'paged');
    this.viewport.classList.toggle('is-scroll', this.mode === 'scroll');
    this.viewport.classList.toggle('hyphenate', !!s.hyphenate);
    this.viewport.classList.toggle('comic', !!this.book.comic);
    this.viewport.classList.toggle('no-anim', s.pageAnim === 'none' || reducedMotion());
    this.viewport.classList.toggle('overlay-turn', s.pageAnim === 'curl' || s.pageAnim === 'fade');
    if (this.book.lang) this.content.lang = this.book.lang;
    if (prevMode !== this.mode && this.rendered) { this.rendered = false; return this.open(loc); }
    if (this.rendered) this.relayout(loc);
  }

  geometry() {
    const s = this.settings;
    const vw = this.viewport.clientWidth, vh = this.viewport.clientHeight;
    // On phones, cap margins so the text column stays usable.
    const margin = vw < 600 ? Math.min(s.margin, Math.max(14, vw * 0.06)) : s.margin;
    const avail = Math.max(200, vw - margin * 2);
    const measure = s.maxWidth;  // max line length in px
    let n = 1;
    if (this.mode === 'paged' && !this.book.comic) {
      // Two columns need about 270px each to stay readable (a phone held sideways qualifies).
      if (s.spread === 'double') n = vw >= 340 ? 2 : 1;   // asked for two pages: give them, even on an upright phone
      else if (s.spread === 'auto') n = vw > vh * 1.05 && vw >= 560 ? 2 : 1;   // any screen held sideways gets two pages
    }
    if (n === 2) {
      // Two pages are drawn as two paper sheets side by side, like a printed spread.
      const pad = vw < 600 ? 12 : 26, om = vw < 600 ? 6 : 16, sg = vw < 600 ? 8 : 14;
      const colW = Math.max(120, Math.min(measure, (vw - 2 * om - sg - 4 * pad) / 2));
      const gap = 2 * pad + sg, width = Math.round(2 * colW + gap);
      const top = Math.max(s.vMargin, 36), bottom = top;
      return { vw, vh, n, gap, width, height: Math.max(160, vh - top - bottom), top, left: Math.round((vw - width) / 2), pad, sg, sheets: true };
    }
    const gap = n === 2 ? Math.max(48, margin * 1.5) : margin * 2;
    const width = this.mode === 'scroll' ? Math.min(avail, measure) : Math.min(avail, n * measure + (n - 1) * gap);
    const top = s.vMargin, bottom = s.vMargin;
    return { vw, vh, n, gap, width, height: Math.max(160, vh - top - bottom), top, left: Math.round((vw - width) / 2) };
  }

  layoutFrame() {
    this.cppMeasured = 0;
    const g = (this.geo = this.geometry());
    const f = this.frame.style, c = this.content.style;
    if (this.mode === 'paged') {
      f.left = g.left + 'px'; f.width = g.width + 'px'; f.top = g.top + 'px'; f.height = g.height + 'px'; f.right = 'auto'; f.bottom = 'auto';
      const colW = (g.width - (g.n - 1) * g.gap) / g.n;
      c.width = g.width + 'px';
      c.height = g.height + 'px';
      c.columnWidth = colW + 'px';
      c.columnGap = g.gap + 'px';
      c.padding = '0';
      this.stride = g.width + g.gap;
      this.viewport.style.setProperty('--page-h', g.height + 'px');
      this.viewport.style.setProperty('--col-w', colW + 'px');
      this.layoutSheets(g, colW);
    } else {
      this.layoutSheets(null);
      f.left = '0'; f.width = '100%'; f.top = '0'; f.height = '100%';
      c.width = g.width + 'px';
      c.height = 'auto';
      c.columnWidth = 'auto';
      c.columnGap = 'normal';
      c.padding = `${g.top}px 0 ${g.top + 40}px`;
      this.viewport.style.setProperty('--page-h', Math.round(g.vh * 0.85) + 'px');
    }
  }

  layoutSheets(g, colW) {
    const on = !!(g && g.sheets);
    this.viewport.classList.toggle('is-spread', on);
    if (!on) { this.sheets?.forEach((x) => x.remove()); this.sheets = null; return; }
    if (!this.sheets) {
      this.sheets = [0, 1].map(() => h('div.flow-sheet', { 'aria-hidden': 'true' }, h('span.flow-sheet-no')));
      this.viewport.prepend(...this.sheets);
    }
    const sTop = Math.max(6, g.top - 30), sH = g.vh - sTop * 1;
    const w = colW + 2 * g.pad;
    this.sheets.forEach((el, i) => {
      const st = el.style;
      st.left = Math.round(g.left + i * (colW + g.gap) - g.pad) + 'px';
      st.width = Math.round(w) + 'px';
      st.top = sTop + 'px';
      st.height = Math.max(160, g.vh - sTop - Math.max(6, g.top - 30)) + 'px';
    });
  }

  relayout(loc) {
    if (!this.rendered) return;
    loc = loc || this.lastLoc || { ch: this.ch, off: 0 };
    this.layoutFrame();
    if (this.mode === 'paged') { this.countPages(); this.goTo(loc, { instant: true }); }
    else this.goTo(loc, { instant: true });
  }

  // ---------- rendering ----------
  async renderChapter(i) {
    const c = this.book.chapters[i];
    const sec = h('section.flow-ch', { dataset: { ch: i } });
    sec.innerHTML = c.html;
    sec.append(h('span.flow-end', { 'aria-hidden': 'true' }));
    await this.loadImages(sec);
    this.paintAnnotations(sec, i);
    return sec;
  }

  async loadImages(sec) {
    const imgs = [...sec.querySelectorAll('img[data-src]')];
    await Promise.all(imgs.map(async (img) => {
      const url = await this.book.image(img.dataset.src);
      img.removeAttribute('data-src');
      img.removeAttribute('loading');
      if (!url) { img.remove(); return; }
      img.src = url;
      // Decode before layout so page counts are right; never block long on a bad image.
      await Promise.race([img.decode().catch(() => {}), new Promise((r) => setTimeout(r, 1500))]);
    }));
  }

  async open(loc) {
    loc = loc || { ch: 0, off: 0 };
    this.content.textContent = '';
    this.caches = new Map();
    this.layoutFrame();
    if (this.mode === 'paged') {
      await this.showChapter(clamp(loc.ch || 0, 0, this.book.chapters.length - 1));
      this.rendered = true;
      this.goTo(loc, { instant: true });
    } else {
      const frag = document.createDocumentFragment();
      for (let i = 0; i < this.book.chapters.length; i++) frag.append(await this.renderChapter(i));
      this.content.append(frag);
      this.measureChapters();
      this.rendered = true;
      this.goTo(loc, { instant: true });
    }
  }

  measureChapters() {
    // Real text lengths from the DOM keep offsets exact.
    for (const sec of this.content.querySelectorAll('.flow-ch')) this.chLens[+sec.dataset.ch] = sec.textContent.length;
    this.recount();
  }

  async showChapter(i) {
    const sec = await this.renderChapter(i);
    this.content.textContent = '';
    this.content.append(sec);
    this.ch = i;
    this.caches = new Map();
    this.chLens[i] = sec.textContent.length;
    this.recount();
    this.countPages();
  }

  countPages() {
    const end = this.content.querySelector('.flow-end');
    if (!end) { this.pages = 1; return; }
    const prev = this.content.style.transform;
    this.content.style.transition = 'none';
    this.content.style.transform = 'none';
    const c0 = this.content.getBoundingClientRect().left;
    const er = end.getBoundingClientRect();
    this.pages = Math.max(1, Math.floor((er.left - c0 + 1) / this.stride) + 1);
    // An empty trailing page (end marker alone at the top of a column) is dropped.
    if (this.pages > 1 && er.top - this.content.getBoundingClientRect().top < 2) {
      const r = document.createRange();
      r.setEndBefore(end);
      r.setStart(this.content, 0);
      const rects = r.getClientRects();
      const last = rects[rects.length - 1];
      if (last && Math.floor((last.right - c0 - 1) / this.stride) < this.pages - 1) this.pages--;
    }
    this.content.style.transform = prev;
    void this.content.offsetWidth;
    this.content.style.transition = '';
    this.page = clamp(this.page, 0, this.pages - 1);
  }

  setPage(p, instant) {
    this.page = clamp(p, 0, this.pages - 1);
    if (instant) this.content.style.transition = 'none';
    this.content.style.transform = `translate3d(${-this.page * this.stride}px,0,0)`;
    if (instant) { void this.content.offsetWidth; this.content.style.transition = ''; }
    // Record the new position right away so a resize racing the page turn keeps it.
    if (this.rendered) this.lastLoc = this.currentLoc();
    this.emit();
  }

  chapterEl(i) { return this.content.querySelector(`.flow-ch[data-ch="${i}"]`); }

  // ---------- text node index for a chapter ----------
  index(i) {
    if (this.caches.has(i)) return this.caches.get(i);
    const sec = this.chapterEl(i);
    if (!sec) return null;
    const nodes = [], starts = [];
    const w = document.createTreeWalker(sec, NodeFilter.SHOW_TEXT);
    let acc = 0, n;
    while ((n = w.nextNode())) {
      if (n.nodeValue.trim()) { nodes.push(n); starts.push(acc); }
      acc += n.nodeValue.length;
    }
    const idx = { sec, nodes, starts, len: acc };
    this.caches.set(i, idx);
    return idx;
  }
  invalidate(i) { this.caches.delete(i); }

  nodeAt(i, off) {
    const idx = this.index(i);
    if (!idx || !idx.nodes.length) return null;
    let lo = 0, hi = idx.nodes.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (idx.starts[mid] <= off) lo = mid; else hi = mid - 1;
    }
    const node = idx.nodes[lo];
    return { node, offset: clamp(off - idx.starts[lo], 0, node.nodeValue.length) };
  }

  offsetOf(sec, node, offset) {
    const r = document.createRange();
    r.setStart(sec, 0);
    try { r.setEnd(node, offset); } catch { return 0; }
    return r.toString().length;
  }

  charRect(node, o) {
    const r = document.createRange();
    const len = node.nodeValue.length;
    o = clamp(o, 0, Math.max(0, len - 1));
    r.setStart(node, o);
    r.setEnd(node, Math.min(len, o + 1));
    const rects = r.getClientRects();
    return rects[0] || r.getBoundingClientRect();
  }

  /** Page index (paged) of a rect. */
  pageOfRect(rect) {
    const c0 = this.content.getBoundingClientRect().left + this.page * this.stride;
    const x = rect.left - (this.content.getBoundingClientRect().left);
    void c0;
    return clamp(Math.floor((x + 1) / this.stride), 0, this.pages - 1);
  }

  // ---------- location ----------
  currentLoc() {
    if (!this.rendered) return this.lastLoc || { ch: 0, off: 0 };
    if (this.mode === 'paged') {
      const idx = this.index(this.ch);
      if (!idx || !idx.nodes.length) return { ch: this.ch, off: 0 };
      if (this.page === 0) return { ch: this.ch, off: 0 };
      // Binary search the first text node that reaches the current page.
      const pageOf = (node, o) => this.pageOfRect(this.charRect(node, o));
      let lo = 0, hi = idx.nodes.length - 1, found = idx.nodes.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const n = idx.nodes[mid];
        if (pageOf(n, n.nodeValue.length - 1) >= this.page) { found = mid; hi = mid - 1; } else lo = mid + 1;
      }
      const node = idx.nodes[found];
      let a = 0, b = node.nodeValue.length - 1;
      while (a < b) {
        const m = (a + b) >> 1;
        if (pageOf(node, m) >= this.page) b = m; else a = m + 1;
      }
      return { ch: this.ch, off: idx.starts[found] + a };
    }
    // scroll: find the chapter crossing the top edge
    const top = this.frame.getBoundingClientRect().top + 8;
    const secs = this.content.querySelectorAll('.flow-ch');
    let ch = 0;
    for (const s of secs) { if (s.getBoundingClientRect().bottom > top) { ch = +s.dataset.ch; break; } }
    const idx = this.index(ch);
    if (!idx || !idx.nodes.length) return { ch, off: 0 };
    const below = (n, o) => this.charRect(n, o).bottom > top;
    let lo = 0, hi = idx.nodes.length - 1, found = idx.nodes.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const n = idx.nodes[mid];
      if (below(n, n.nodeValue.length - 1)) { found = mid; hi = mid - 1; } else lo = mid + 1;
    }
    const node = idx.nodes[found];
    let a = 0, b = node.nodeValue.length - 1;
    while (a < b) { const m = (a + b) >> 1; if (below(node, m)) b = m; else a = m + 1; }
    return { ch, off: idx.starts[found] + a };
  }

  async goTo(loc, o = {}) {
    if (!loc) return;
    let ch = clamp(loc.ch ?? 0, 0, this.book.chapters.length - 1);
    if (this.mode === 'paged') {
      if (ch !== this.ch || !this.chapterEl(ch)) await this.showChapter(ch);
      let page = 0;
      if (loc.toEnd) page = this.pages - 1;
      else if (loc.id) {
        const el = this.content.querySelector(`#${cssEsc(loc.id)}`);
        if (el) page = this.pageOfRect(el.getBoundingClientRect());
      } else if (loc.off) {
        const p = this.nodeAt(ch, loc.off);
        if (p) page = this.pageOfRect(this.charRect(p.node, p.offset));
      } else if (loc.frac) page = Math.round(loc.frac * (this.pages - 1));
      this.setPage(page, o.instant !== false && o.instant);
    } else {
      let y = null;
      const frameTop = this.frame.getBoundingClientRect().top;
      if (loc.id) {
        const el = this.content.querySelector(`#${cssEsc(loc.id)}`);
        if (el) y = el.getBoundingClientRect().top;
      }
      if (y == null && loc.off) {
        const p = this.nodeAt(ch, loc.off);
        if (p) y = this.charRect(p.node, p.offset).top;
      }
      if (y == null) {
        const sec = this.chapterEl(ch);
        if (sec) {
          y = sec.getBoundingClientRect().top;
          if (loc.frac) y += sec.offsetHeight * loc.frac;
          else y += this.geo.top - 4;
        }
      }
      if (y != null) this.frame.scrollTo({ top: this.frame.scrollTop + (y - frameTop) - (loc.id || loc.off ? 24 : this.geo.top), behavior: o.smooth ? 'smooth' : 'auto' });
      if (this.rendered && !o.smooth) this.lastLoc = this.currentLoc();
      this.emit();
    }
  }

  /** Paint the page that is on screen (text, highlights, pictures) onto a canvas, for saving or sharing. */
  captureCanvas(caption = '', scale = 2) {
    const vr = this.viewport.getBoundingClientRect();
    const W = Math.round(vr.width), H = Math.round(vr.height);
    const cv = document.createElement('canvas');
    cv.width = W * scale; cv.height = H * scale;
    const ctx = cv.getContext('2d');
    ctx.scale(scale, scale);
    ctx.fillStyle = opaqueBg(this.viewport);
    ctx.fillRect(0, 0, W, H);
    if (this.sheets && this.viewport.classList.contains('is-spread')) {
      this.sheets.forEach((sh) => {
        const r = sh.getBoundingClientRect(), x = r.left - vr.left, y = r.top - vr.top;
        ctx.save(); ctx.shadowColor = 'rgba(0,0,0,.28)'; ctx.shadowBlur = 14; ctx.shadowOffsetY = 4;
        ctx.fillStyle = getComputedStyle(sh).backgroundColor; ctx.fillRect(x, y, r.width, r.height); ctx.restore();
        const no = sh.firstChild?.textContent;
        if (no) { ctx.fillStyle = getComputedStyle(sh.firstChild).color; ctx.font = '500 11px system-ui, sans-serif'; ctx.textAlign = 'center'; if ('letterSpacing' in ctx) ctx.letterSpacing = '0px'; ctx.fillText(no, x + r.width / 2, y + r.height - 9); ctx.textAlign = 'start'; }
      });
    }
    const seen = (r) => r.right > vr.left && r.left < vr.right && r.bottom > vr.top && r.top < vr.bottom && r.width > 0;
    for (const hl of this.content.querySelectorAll('.hl')) {
      const bg = getComputedStyle(hl).backgroundColor;
      for (const r of hl.getClientRects()) if (seen(r)) { ctx.fillStyle = bg; ctx.fillRect(r.left - vr.left, r.top - vr.top, r.width, r.height); }
    }
    for (const img of this.content.querySelectorAll('img')) {
      const r = img.getBoundingClientRect();
      if (seen(r) && img.complete && img.naturalWidth) { try { ctx.drawImage(img, r.left - vr.left, r.top - vr.top, r.width, r.height); } catch { /* cross-origin */ } }
    }
    const walker = document.createTreeWalker(this.content, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    const styles = new Map();
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = n.nodeValue;
      if (!text || !/\S/.test(text)) continue;
      const el = n.parentElement;
      if (!el || el.closest('.turn-layer')) continue;
      const pr = el.getBoundingClientRect();
      if (pr.right < vr.left || pr.left > vr.right) continue;
      let st = styles.get(el);
      if (!st) {
        const cs = getComputedStyle(el);
        ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
        st = { font: ctx.font, color: cs.color, ls: cs.letterSpacing === 'normal' ? '0px' : cs.letterSpacing, upper: cs.textTransform === 'uppercase', asc: ctx.measureText('Hg').fontBoundingBoxAscent || parseFloat(cs.fontSize) * 0.8 };
        styles.set(el, st);
      }
      ctx.font = st.font; ctx.fillStyle = st.color; ctx.textBaseline = 'alphabetic';
      if ('letterSpacing' in ctx) ctx.letterSpacing = st.ls;
      const draw = (str, r) => { if (seen(r)) ctx.fillText(st.upper ? str.toUpperCase() : str, r.left - vr.left, r.top - vr.top + st.asc); };
      const re = /\S+/g;
      for (let m = re.exec(text); m; m = re.exec(text)) {
        range.setStart(n, m.index); range.setEnd(n, m.index + m[0].length);
        const rects = range.getClientRects();
        if (rects.length === 1) { draw(m[0], rects[0]); continue; }
        // A hyphenated word runs over two lines: paint each line's piece where the browser put it, then the hyphen.
        const lines = [];
        for (let i = 0; i < m[0].length; i++) {
          range.setStart(n, m.index + i); range.setEnd(n, m.index + i + 1);
          const cr = range.getClientRects()[0];
          if (!cr) continue;
          const last = lines[lines.length - 1];
          if (last && Math.abs(cr.top - last.top) < 4) { last.text += m[0][i]; } else lines.push({ top: cr.top, left: cr.left, bottom: cr.bottom, text: m[0][i] });
        }
        const hw = ctx.measureText('-').width;
        lines.forEach((ln, k) => {
          // Chrome reports a word's continuation line shifted by the hyphen that ended the line before.
          const left = ln.left - (k > 0 ? hw : 0);
          const width = ctx.measureText(ln.text).width;
          draw(ln.text, { left, top: ln.top, right: left + width, bottom: ln.bottom, width });
          if (k < lines.length - 1 && !/[-\u2010\u2011]$/.test(ln.text)) draw('-', { left: left + width, top: ln.top, right: left + width + hw, bottom: ln.bottom, width: hw });
        });
      }
    }
    if (caption) {
      ctx.font = '500 11px system-ui, sans-serif'; ctx.fillStyle = getComputedStyle(this.content).color; ctx.globalAlpha = 0.55; ctx.textAlign = 'center';
      if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
      ctx.fillText(caption, W / 2, H - 14); ctx.globalAlpha = 1;
    }
    return cv;
  }

  /** Which effect to use right now ('none' when motion is off or the chapter is too big to copy cheaply). */
  turnStyle() {
    const a = this.settings.pageAnim || 'curl';
    if (a === 'none' || reducedMotion()) return 'none';
    if ((a === 'curl' || a === 'fade') && (this.chLens[this.ch] || 0) > 300000) return 'slide';
    return a;
  }
  async turn(dir, change, crossChapter) {
    const st = this.turnStyle();
    const overlay = st === 'curl' || st === 'fade';
    if (overlay) {
      const sn = snapshot(this.frame, this.viewport, this.sheets);
      await change(true);
      playTurn(this.viewport, sn, dir, st);
    } else {
      await change(false);
      if (crossChapter && st !== 'none') this.flash(dir);
    }
  }
  async next() {
    if (this.mode === 'scroll') { this.frame.scrollBy({ top: this.frame.clientHeight * 0.9, behavior: 'smooth' }); return; }
    if (this.page < this.pages - 1) return this.turn('next', (inst) => this.setPage(this.page + 1, inst));
    if (this.ch < this.book.chapters.length - 1) return this.turn('next', async () => { await this.showChapter(this.ch + 1); this.setPage(0, true); }, true);
    this.opts.onEnd?.();
  }
  async prev() {
    if (this.mode === 'scroll') { this.frame.scrollBy({ top: -this.frame.clientHeight * 0.9, behavior: 'smooth' }); return; }
    if (this.page > 0) return this.turn('prev', (inst) => this.setPage(this.page - 1, inst));
    if (this.ch > 0) return this.turn('prev', async () => { await this.showChapter(this.ch - 1); this.setPage(this.pages - 1, true); }, true);
  }
  flash(dir) {
    if (this.viewport.classList.contains('no-anim')) return;
    this.content.animate([{ opacity: 0.25, transform: `translate3d(${-this.page * this.stride + (dir === 'next' ? 24 : -24)}px,0,0)` }, { opacity: 1, transform: `translate3d(${-this.page * this.stride}px,0,0)` }], { duration: 260, easing: 'cubic-bezier(.2,.7,.2,1)' });
  }

  goToFraction(f) {
    const target = clamp(f, 0, 1) * this.total;
    let ch = 0;
    for (let i = 0; i < this.chStarts.length; i++) if (this.chStarts[i] <= target) ch = i;
    const off = Math.max(0, Math.round(target - this.chStarts[ch]));
    return this.goTo({ ch, off: Math.min(off, Math.max(0, this.chLens[ch] - 1)) }, { instant: true });
  }

  emit() {
    if (!this.rendered) return;
    clearTimeout(this.emitT);
    this.emitT = setTimeout(() => {
      const loc = this.currentLoc();
      this.lastLoc = loc;
      this.opts.onRelocate?.(this.info(loc));
    }, 30);
  }

  info(loc = this.lastLoc || { ch: 0, off: 0 }) {
    const progress = clamp((this.chStarts[loc.ch] + loc.off) / this.total, 0, 1);
    const ch = this.book.chapters[loc.ch];
    let pageLabel, pagesLeftInChapter = null, page = null, totalPages = null;
    if (this.mode === 'paged') {
      // Every chapter starts on a fresh page, so count pages chapter by chapter.
      const cpp = this.charsPerPage();
      const pagesOf = (i) => (i === this.ch ? this.pages : Math.max(1, Math.ceil((this.chLens[i] || 0) / cpp)));
      let before = 0;
      totalPages = 0;
      for (let i = 0; i < this.chLens.length; i++) { const n = pagesOf(i); if (i < this.ch) before += n; totalPages += n; }
      page = clamp(before + this.page + 1, 1, totalPages);
      pagesLeftInChapter = this.pages - this.page - 1;
      pageLabel = `Page ${page} of ${totalPages}`;
    } else {
      const cpp = 1800;
      totalPages = Math.max(1, Math.round(this.total / cpp));
      page = clamp(Math.round(progress * totalPages) + 1, 1, totalPages);
      pageLabel = `Page ${page} of ${totalPages}`;
    }
    if (this.mode === 'paged' && this.geo?.n === 2 && page != null) {
      // Count every sheet, not every spread, so the footer matches the numbers printed on the sheets.
      const a = (page - 1) * 2 + 1, tot = totalPages * 2;
      page = a; totalPages = tot;
      pageLabel = `Page ${a}\u2013${Math.min(a + 1, tot)} of ${tot}`;
      this.sheets?.forEach((el, i) => { const no = el.firstChild; no.textContent = a + i <= tot ? String(a + i) : ''; });
    }
    const charsLeftCh = Math.max(0, (this.chLens[loc.ch] || 0) - loc.off);
    const atEnd = loc.ch === this.book.chapters.length - 1 && (this.mode === 'paged' ? this.page >= this.pages - 1 : this.frame.scrollTop + this.frame.clientHeight >= this.frame.scrollHeight - 4);
    return {
      loc, progress: atEnd ? 1 : progress, page, totalPages, pageLabel, pagesLeftInChapter, charsLeftInChapter: charsLeftCh, charsLeftInBook: this.total - (this.chStarts[loc.ch] + loc.off),
      chapterIndex: loc.ch, chapterTitle: ch?.title || '', atStart: loc.ch === 0 && (this.mode === 'paged' ? this.page === 0 : loc.off < 5),
      atEnd,
    };
  }

  /** Characters per page: measured from a long-enough chapter, otherwise estimated from geometry. */
  charsPerPage() {
    const len = this.chLens[this.ch] || 0;
    if (this.pages >= 3 && len > 0) this.cppMeasured = len / (this.pages - 0.5);
    if (this.cppMeasured) return Math.max(150, this.cppMeasured);
    const g = this.geo, s = this.settings;
    if (!g) return 1500;
    const colW = (g.width - (g.n - 1) * g.gap) / g.n;
    const cpl = colW / (s.fontSize * 0.47);
    const lines = g.height / (s.fontSize * s.lineHeight);
    return Math.max(150, cpl * lines * g.n * 0.85);
  }

  tocIndexFor(loc) {
    let best = -1;
    this.toc.forEach((t, i) => { if (t.loc && t.loc.ch <= loc.ch) best = i; });
    return best;
  }

  locLabel(loc) {
    const ch = this.book.chapters[loc.ch];
    return ch?.title || `Section ${loc.ch + 1}`;
  }
  progressOf(loc) { return clamp((this.chStarts[loc.ch] + (loc.off || 0)) / this.total, 0, 1); }

  // ---------- annotations ----------
  setAnnotations(list) {
    this.annotations = list.filter((a) => a.loc?.kind === 'flow');
    if (!this.rendered) return;
    for (const sec of this.content.querySelectorAll('.flow-ch')) this.repaint(+sec.dataset.ch);
  }

  repaint(i) {
    const sec = this.chapterEl(i);
    if (!sec) return;
    unwrapAll(sec, '.hl');
    this.paintAnnotations(sec, i);
    this.invalidate(i);
  }

  paintAnnotations(sec, i) {
    const list = this.annotations.filter((a) => a.loc.ch === i).sort((a, b) => a.loc.start - b.loc.start);
    for (const a of list) {
      wrapRange(sec, a.loc.start, a.loc.end, (span) => {
        span.className = `hl hl-${a.style || 'highlight'} c-${a.color || 'yellow'}${a.note ? ' has-note' : ''}`;
        span.dataset.id = a.id;
      });
    }
  }

  /** Turn the current selection into a location, or null. */
  selectionLoc() {
    const sel = getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    const sa = range.startContainer.parentElement?.closest?.('.flow-ch') || (range.startContainer.closest && range.startContainer.closest('.flow-ch'));
    if (!sa || !this.content.contains(sa)) return null;
    const ch = +sa.dataset.ch;
    let start = this.offsetOf(sa, range.startContainer, range.startOffset);
    let end;
    const eb = range.endContainer.parentElement?.closest?.('.flow-ch') || (range.endContainer.closest && range.endContainer.closest('.flow-ch'));
    if (eb === sa) end = this.offsetOf(sa, range.endContainer, range.endOffset);
    else end = sa.textContent.length;
    const text = sa.textContent.slice(start, end);
    // Trim whitespace inside the range
    const lead = text.length - text.trimStart().length;
    const trail = text.length - text.trimEnd().length;
    start += lead; end -= trail;
    if (end <= start) return null;
    return { kind: 'flow', ch, start, end, text: sa.textContent.slice(start, end), rect: range.getBoundingClientRect() };
  }

  rectForAnnotation(id) {
    const el = this.content.querySelector(`.hl[data-id="${cssEsc(id)}"]`);
    return el ? el.getBoundingClientRect() : null;
  }

  // ---------- search ----------
  chapterText(i) {
    if (!this.textCache) this.textCache = [];
    if (this.textCache[i] == null) {
      const d = document.createElement('div');
      d.innerHTML = this.book.chapters[i].html;
      this.textCache[i] = d.textContent;
    }
    return this.textCache[i];
  }

  async search(q, onResult, signal) {
    const needle = q.toLowerCase();
    let count = 0;
    for (let i = 0; i < this.book.chapters.length; i++) {
      if (signal?.aborted) return count;
      const t = this.chapterText(i);
      const low = t.toLowerCase();
      let p = low.indexOf(needle);
      while (p >= 0) {
        const a = Math.max(0, p - 50), b = Math.min(t.length, p + needle.length + 70);
        const sq = (x) => x.replace(/\s+/g, ' ');
        onResult({ loc: { ch: i, off: p, len: needle.length }, label: this.locLabel({ ch: i }), before: (a > 0 ? '…' : '') + sq(t.slice(a, p)), match: t.slice(p, p + needle.length), after: sq(t.slice(p + needle.length, b)) + (b < t.length ? '…' : ''), progress: this.progressOf({ ch: i, off: p }) });
        if (++count >= 500) return count;
        p = low.indexOf(needle, p + needle.length);
      }
      if (i % 20 === 19) await new Promise((r) => setTimeout(r));
    }
    return count;
  }

  async showSearchHit(loc) {
    this.clearMarks('search-hit');
    await this.goTo({ ch: loc.ch, off: loc.off }, { instant: true });
    const sec = this.chapterEl(loc.ch);
    if (sec) { wrapRange(sec, loc.off, loc.off + loc.len, (s) => { s.className = 'mark search-hit'; }); this.invalidate(loc.ch); }
  }

  clearMarks(cls) {
    for (const sec of this.content.querySelectorAll('.flow-ch')) {
      if (sec.querySelector('.' + cls)) { unwrapAll(sec, '.' + cls); this.invalidate(+sec.dataset.ch); }
    }
  }

  // ---------- text for speech ----------
  /** Sentences from a location onward: [{text, loc:{ch, off}, end}] for one chapter. */
  sentencesFrom(loc) {
    const t = this.chapterText(loc.ch);
    const out = [];
    const re = /[^.!?…。！？\n]+(?:[.!?…。！？]+["'”’»)\]]*|\n|$)/g;
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(t))) {
      if (!m[0]) { re.lastIndex++; continue; }
      const s = m.index, e = m.index + m[0].length;
      if (e <= loc.off) continue;
      const text = m[0].trim();
      if (text.length < 1 || !/[\p{L}\p{N}]/u.test(text)) continue;
      const lead = m[0].length - m[0].trimStart().length;
      out.push({ text, loc: { ch: loc.ch, off: s + lead }, end: e, para: m[0].endsWith('\n') || t[e] === '\n' });
      if (out.length > 400) break;
    }
    return out;
  }

  async markSpeaking(seg) {
    this.clearMarks('tts-word');
    this.clearMarks('tts-mark');
    if (!seg) return;
    const visible = this.isVisible(seg.loc);
    if (!visible) await this.goTo(seg.loc, { instant: true });
    const sec = this.chapterEl(seg.loc.ch);
    if (sec) { wrapRange(sec, seg.loc.off, seg.end, (s) => { s.className = 'mark tts-mark'; }); this.invalidate(seg.loc.ch); }
    if (this.mode === 'scroll') {
      const m = sec?.querySelector('.tts-mark');
      if (m) { const r = m.getBoundingClientRect(), fr = this.frame.getBoundingClientRect(); if (r.bottom > fr.bottom - 40 || r.top < fr.top) this.frame.scrollBy({ top: r.top - fr.top - fr.height * 0.3, behavior: 'smooth' }); }
    } else {
      const m = sec?.querySelector('.tts-mark:last-of-type') || sec?.querySelector('.tts-mark');
      if (m) { const p = this.pageOfRect(m.getBoundingClientRect()); if (p !== this.page) this.setPage(p); }
    }
  }

  /** Highlight the word being spoken inside the current sentence. */
  markWord(seg, idx, len) {
    const sec = this.chapterEl(seg.loc.ch);
    if (!sec) return;
    if (sec.querySelector('.tts-word')) unwrapAll(sec, '.tts-word');
    const a = seg.loc.off + idx;
    wrapRange(sec, a, Math.min(seg.end, a + len), (s) => { s.className = 'mark tts-word'; });
    this.invalidate(seg.loc.ch);
    if (this.mode === 'paged') {
      const w = sec.querySelector('.tts-word');
      if (w) { const p = this.pageOfRect(w.getBoundingClientRect()); if (p !== this.page) this.setPage(p); }
    }
  }

  isVisible(loc) {
    if (this.mode === 'paged') {
      if (loc.ch !== this.ch) return false;
      const p = this.nodeAt(loc.ch, loc.off);
      return p ? this.pageOfRect(this.charRect(p.node, p.offset)) === this.page : false;
    }
    const p = this.nodeAt(loc.ch, loc.off);
    if (!p) return false;
    const r = this.charRect(p.node, p.offset), fr = this.frame.getBoundingClientRect();
    return r.top >= fr.top && r.bottom <= fr.bottom;
  }

  targetText(t) {
    const d = document.createElement('div');
    d.innerHTML = this.book.chapters[t.ch]?.html || '';
    const el = t.id ? d.querySelector(`#${cssEsc(t.id)}`) : null;
    if (!el) return null;
    let node = el;
    // Anchors are often empty <a id>; use the enclosing block.
    while (node && node.textContent.trim().length < 2 && node.parentElement && node.parentElement !== d) node = node.parentElement;
    const isNoteBlock = node.closest('aside,.x-note,li,p,div');
    const text = (isNoteBlock || node).textContent.replace(/\s+/g, ' ').trim();
    return text.length ? text : null;
  }

  destroy() {
    this.ro.disconnect();
    this.viewport.remove();
    this.book.dispose?.();
  }
}

// ---------- DOM range helpers ----------
export function wrapRange(root, start, end, decorate) {
  if (end <= start) return;
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const targets = [];
  let acc = 0, n;
  while ((n = w.nextNode())) {
    const len = n.nodeValue.length;
    const a = acc, b = acc + len;
    acc = b;
    if (b <= start) continue;
    if (a >= end) break;
    targets.push([n, Math.max(0, start - a), Math.min(len, end - a)]);
  }
  for (const [node, s, e] of targets) {
    if (!node.nodeValue.slice(s, e).length) continue;
    // Never wrap text inside tables' structural whitespace
    const parent = node.parentNode;
    if (!parent || /^(TABLE|TBODY|THEAD|TR|UL|OL)$/.test(parent.nodeName)) continue;
    let target = node;
    if (s > 0) target = target.splitText(s);
    if (e - s < target.nodeValue.length) target.splitText(e - s);
    const span = document.createElement('span');
    decorate(span);
    target.parentNode.insertBefore(span, target);
    span.append(target);
  }
}

export function unwrapAll(root, sel) {
  for (const el of root.querySelectorAll(sel)) {
    const p = el.parentNode;
    while (el.firstChild) p.insertBefore(el.firstChild, el);
    el.remove();
    p.normalize();
  }
}

export function hasSelection() {
  const s = getSelection();
  return !!(s && !s.isCollapsed && s.toString().trim());
}

function cssEsc(s) { return window.CSS?.escape ? CSS.escape(s) : s.replace(/[^\w-]/g, '\\$&'); }
