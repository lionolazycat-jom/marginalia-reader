// Reader screen: hosts a Flow or PDF engine and provides every reading control around it.

import { h, $, $$, icon, iconBtn, toast, dialog, confirmDialog, debounce, clamp, fmtPct, fmtDuration, copyText, capability, capabilityNow, saveFile, esc, menu } from './util.js';
import { state, emit, on, updateBook, bookFile, addAnnotation, updateAnnotation, deleteAnnotation, restoreAnnotation, addBookmark, updateBookmark, deleteBookmark, logReading, saveReading, saveUI } from './store.js';
import { FONTS, THEMES, HL_COLORS, TOOLBAR_ITEMS, PER_BOOK_KEYS, themeColors, contrast } from './settings.js';
import { loadFlowBook } from './formats.js';
import { openPdf, PdfPasswordNeeded } from './pdfcore.js';
import { FlowEngine, hasSelection } from './flow.js';
import { PdfEngine } from './pdfview.js';
import { reflowPdf, REFLOW_VERSION, pdfLooksPlain } from './pdfreflow.js';
import { db } from './db.js';
import * as ambient from './ambient.js';
import { openVoicePicker, toneOf } from './voices.js';
import { TURN_STYLES, tapZones } from './turn.js';
import { exportBookAnnotations } from './exporter.js';

let current = null;
export const activeReader = () => current;
window.serein = window.marginalia = { get reader() { return current; } };

export async function openReader(book, opts = {}) {
  if (current) await current.close(true);
  current = new Reader(book, opts);
  await current.start();
  return current;
}
export async function closeReader() { if (current) await current.close(); }

class Reader {
  constructor(book, opts) {
    this.book = book;
    this.opts = opts;
    this.unsubs = [];
    this.timers = [];
    this.lastActivity = Date.now();
  }

  get settings() { return { ...state.reading, ...(this.book.settings || {}) }; }
  get isPdf() { return this.engine ? this.engine.kind === 'pdf' : this.book.format === 'pdf' && this.view !== 'book'; }
  get isPdfBook() { return this.book.format === 'pdf'; }
  toggleSpread() {
    if (this.isPdf) this.setSetting('pdfLayout', this.settings.pdfLayout === 'double' ? 'single' : 'double');
    else this.setSetting('spread', this.engine?.geo?.n === 2 ? 'single' : 'double');
  }
  updateTextRow() {
    const b = this.spreadBtn; if (!b || !this.engine) return;
    const paged = this.isPdf ? true : this.engine.mode === 'paged' && !this.book?.comic;
    b.hidden = !paged;
    const two = this.isPdf ? this.settings.pdfLayout === 'double' : this.engine.geo?.n === 2;
    b.textContent = two ? '2 pages' : '1 page';
    b.classList.toggle('on', !!two);
    b.setAttribute('aria-label', two ? 'Two pages. Switch to one page' : 'One page. Switch to two pages');
    const sz = !this.isPdf && two;
    for (const x of [this.zoomOutBtn, this.zoomLbl, this.zoomInBtn]) if (x) x.hidden = !sz;
    if (this.zoomLbl) this.zoomLbl.textContent = Math.round((this.settings.spreadZoom || 1) * 100) + '%';
  }
  updateViewBtn() {
    this.updateTextRow();
    if (!this.viewBtn) return;
    this.viewBtn.hidden = !this.canBookView;
    const book = this.view === 'book';
    this.viewBtn.querySelector('.rd-lbl').textContent = book ? 'Book view' : 'Original';
    this.viewBtn.setAttribute('aria-label', book ? 'Book view. Switch to the original pages (V)' : 'Original pages. Switch to Book view (V)');
    this.viewBtn.title = this.viewBtn.getAttribute('aria-label');
  }
  bookAnns() { return state.annotations.filter((a) => a.bookId === this.book.id); }
  bookMarks() { return state.bookmarks.filter((a) => a.bookId === this.book.id); }

  // ---------------- lifecycle ----------------
  async start() {
    const root = $('#reader');
    this.root = root;
    root.textContent = '';
    root.hidden = false;
    root.className = 'reader';
    root.dataset.format = this.book.format;
    document.body.classList.add('is-reading');
    this.buildChrome();
    this.applyTheme();
    this.stage.append(h('div.rd-loading', h('div.spinner'), h('p', `Opening ${this.book.title}…`)));
    try {
      const blob = await bookFile(this.book.id);
      if (!blob) throw new Error('The book file is missing from this device. Import the file again to read it; your highlights and notes are kept.');
      if (this.isPdfBook) {
        const doc = await openPdf(blob, (retry) => this.askPassword(retry));
        if (this.book.locked) updateBook(this.book, { locked: false, pages: doc.numPages });
        // The Book / Original switch is always there for PDFs. Designed PDFs simply open as the original pages.
        if (this.book.plainPdf == null) { this.book.plainPdf = await pdfLooksPlain(doc); updateBook(this.book, { plainPdf: this.book.plainPdf }); }
        this.canBookView = true;
        this.updateViewBtn();
        if (!this.book.plainPdf && !this.opts.view && !this.book.pdfView && this.opts.loc?.ch == null) { this.view = 'original'; }
        else {
          if (this.opts.loc) this.view = this.opts.loc.ch != null ? 'book' : 'original';
          else this.view = this.opts.view || this.book.pdfView || null;
          if (!this.view) {
            this.view = await this.chooseView();
            await updateBook(this.book, { pdfView: this.view });
          }
        }
        let content = null;
        if (this.view === 'book') {
          content = await this.bookViewContent(doc);
          if (!content) {
            this.view = 'original';
            updateBook(this.book, { pdfView: 'original' });
            toast('This PDF is made of scanned page images, so it can only be shown as original pages.', { ms: 6000 });
          }
        }
        this.root.dataset.view = this.view;
        this.updateViewBtn();
        if (content) {
          this.pdfDoc = doc;
          this.engine = new FlowEngine(this.stage, content, this.engineCallbacks());
        } else {
          this.engine = new PdfEngine(this.stage, doc, this.engineCallbacks());
          await this.engine.init();
        }
      } else {
        const content = await loadFlowBook(blob, this.book.format);
        content.lang = this.book.language;
        this.engine = new FlowEngine(this.stage, content, this.engineCallbacks());
      }
      this.stage.querySelector('.rd-loading')?.remove();
      this.engine.applySettings(this.settings);
      this.engine.setAnnotations(this.bookAnns());
      let loc = this.opts.loc || (this.view === 'book' ? this.book.bookLocation : this.book.location) || null;
      if (this.view === 'book' && !this.opts.loc && !this.book.bookLocation && this.book.location?.page) loc = this.pageToFlowLoc(this.book.location.page);
      if (this.view === 'book' && this.opts.loc?.page != null) loc = this.pageToFlowLoc(this.opts.loc.page);
      if (this.view === 'book' && this.opts.pageForBook != null) loc = this.pageToFlowLoc(this.opts.pageForBook);
      await this.engine.open(loc);
      if (this.opts.searchQuery) this.jumpToContentHit(this.opts.searchQuery, this.opts.fraction || 0);
      await updateBook(this.book, { lastOpenedAt: Date.now() });
      this.refreshToc();
    } catch (e) {
      this.stage.textContent = '';
      const msg = e instanceof PdfPasswordNeeded ? 'This PDF is password-protected. Open it again and enter its password to read it.' : (e.message || 'This book could not be opened.');
      this.stage.append(h('div.rd-error', h('h2', 'This book can’t be opened'), h('p', msg), h('div.row', h('button.btn.btn-primary', { type: 'button', onclick: () => this.close() }, 'Back to library'), e instanceof PdfPasswordNeeded ? h('button.btn', { type: 'button', onclick: () => openReader(this.book) }, 'Try password again') : null)));
      return;
    }
    this.bindGlobal();
    this.updateSoundsBtn();
    ambient.setMaster(state.ui.soundsMaster ?? 0.8);
    this.startTracking();
    this.showChrome(true);
    this.hideChromeSoon(2600);
    this.stage.focus?.();
  }

  async jumpToContentHit(q, frac) {
    const hits = [];
    await this.engine.search(q, (r) => hits.push(r));
    if (!hits.length) return;
    hits.sort((a, b) => Math.abs(a.progress - frac) - Math.abs(b.progress - frac));
    await this.engine.showSearchHit(hits[0].loc);
    this.togglePanel('search', true, q);
  }

  async close(replacing) {
    if (this.closed) return;
    this.closed = true;
    this.tts?.destroy();
    this.saveProgressNow();
    for (const u of this.unsubs) u();
    for (const t of this.timers) clearInterval(t);
    this.flushTime();
    try { this.engine?.destroy(); } catch {}
    try { if (this.pdfDoc) (await import('./pdfcore.js')).closePdf(this.pdfDoc); } catch {}
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    if (current === this) current = null;
    if (!replacing) {
      this.root.hidden = true;
      this.root.textContent = '';
      document.body.classList.remove('is-reading');
      document.documentElement.style.removeProperty('--reader-bg');
      setThemeColor(null);
      emit('reader-closed', this.book);
    }
  }

  // ---------------- PDF Book view ----------------
  chooseView() {
    const card = (v, title, text) => h('button.view-choice', { type: 'button', dataset: { v } }, h('strong', title), h('span', text));
    return new Promise((resolve) => {
      const box = h('div.view-choose', card('book', 'Book view', 'The text rebuilt as an e-book: pick the font, size, spacing, margins and page color. Best for books, novels and articles.'), card('original', 'Original pages', 'The PDF exactly as designed, with images, tables and layout. Best for magazines, forms and slides.'));
      const p = dialog({ title: 'How do you want to read this PDF?', body: h('div', box, h('p.hint', 'You can switch at any time from Display (Aa).')), actions: [{ label: 'Decide later', value: 'later' }] });
      box.addEventListener('click', (e) => {
        const b = e.target.closest('.view-choice'); if (!b) return;
        document.querySelector('.scrim .dialog-actions button')?.click();
        resolve(b.dataset.v);
      });
      p.then((v) => resolve(v === 'later' || !v ? 'original' : v));
    });
  }

  async bookViewContent(doc) {
    let cached = null;
    try { cached = await db.get('reflow', this.book.id); } catch {}
    let data = cached && cached.version === REFLOW_VERSION && (cached.req || 'auto') === (this.book.reflowMode || 'auto') ? cached.data : null;
    if (!data) {
      const label = this.stage.querySelector('.rd-loading p');
      const bar = h('div.pbar.rd-load-bar', h('span', { style: { width: '0%' } }));
      this.stage.querySelector('.rd-loading')?.append(bar);
      if (label) label.textContent = 'Turning the PDF into a book…';
      data = await reflowPdf(doc, (f) => { bar.firstChild.style.width = Math.round(f * 100) + '%'; }, undefined, { mode: this.book.reflowMode });
      try { await db.put('reflow', { id: this.book.id, version: REFLOW_VERSION, req: this.book.reflowMode || 'auto', data }); } catch {}
    }
    if (data.scanned) return null;
    this.pageToChapter = data.pageToChapter;
    this.pageMarkers = data.chapters.map((c) => new Set([...c.html.matchAll(/data-p="(\d+)"/g)].map((m) => +m[1])));
    const chapters = data.chapters.map((c) => { const d = document.createElement('div'); d.innerHTML = c.html; return { title: c.title, html: c.html, chars: d.textContent.length }; });
    return { chapters, toc: data.toc, image: async () => '', dispose() {}, lang: this.book.language };
  }

  /** Book view location for an original page number. */
  pageToFlowLoc(page) {
    if (!this.pageToChapter) return null;
    const ch = this.pageToChapter[Math.min(page, this.pageToChapter.length - 1)] ?? 0;
    const marks = this.pageMarkers?.[ch];
    let p = page;
    while (p >= 0 && marks && !marks.has(p)) p--;
    return p >= 0 ? { ch, id: `c${ch}-pg${p}` } : { ch, off: 0 };
  }

  /** Original page number for a Book view location. */
  flowLocToPage(loc) {
    const e = this.engine;
    if (!e || e.kind !== 'flow' || !loc) return null;
    const sec = e.chapterEl(loc.ch);
    if (!sec) return this.book.location?.page ?? null;
    const at = e.nodeAt(loc.ch, loc.off || 0);
    let page = null;
    for (const m of sec.querySelectorAll('.pdf-pg')) {
      if (!at || (m.compareDocumentPosition(at.node) & Node.DOCUMENT_POSITION_FOLLOWING)) page = +m.dataset.p;
      else break;
    }
    return page;
  }

  /** Rebuild the Book view text; 'join' mode glues lines into long paragraphs for PDFs with odd spacing. */
  async rebuildBookView() {
    const mode = this.book.reflowMode === 'join' ? 'auto' : 'join';
    const pg = this.info ? this.flowLocToPage(this.info.loc) : null;
    this.saveProgressNow();
    try { await db.del('reflow', this.book.id); } catch {}
    await updateBook(this.book, { reflowMode: mode });
    openReader(this.book, { view: 'book', pageForBook: pg });
  }

  async switchView(v) {
    if (!this.isPdfBook || !this.canBookView || v === this.view) return;
    let loc = null;
    if (this.info) {
      if (this.view === 'book') { const pg = this.flowLocToPage(this.info.loc); loc = pg != null ? { page: pg, y: 0 } : null; }
      else loc = { page: this.info.loc.page, y: 0 };
    }
    this.saveProgressNow();
    await updateBook(this.book, { pdfView: v });
    openReader(this.book, { view: v, loc: v === 'original' ? loc : null, pageForBook: v === 'book' ? loc?.page : null });
  }

  askPassword(retry) {
    return dialog({
      title: retry ? 'Incorrect password' : 'Password required',
      body: retry ? 'That password didn’t work. Check it and try again.' : `“${this.book.title}” is protected. Enter its password to open it. The password is not saved.`,
      fields: [{ name: 'pw', label: 'Password', type: 'password' }],
      actions: [{ label: 'Cancel', value: false }, { label: 'Open', value: true, primary: true }],
    }).then((r) => (r && r.action ? r.values.pw : null));
  }

  engineCallbacks() {
    return {
      onRelocate: (info) => this.onRelocate(info),
      onTap: (zone, e) => this.onTap(zone, e),
      zones: () => tapZones(state.ui.tapZone),
      penOn: () => !!this.hlPen,
      onAnnotation: (id, rect) => this.showAnnotationPop(id, rect),
      onLink: (t, el) => this.onLink(t, el),
      onToc: () => this.refreshToc(),
      onZoomRequest: (z) => this.setSetting('zoom', z),
      onSpreadZoom: (z) => this.setSetting('spreadZoom', z),
      onZoom: () => this.updateZoomLabel(),
      onEnd: () => this.onReachEnd(),
    };
  }

  // ---------------- chrome ----------------
  buildChrome() {
    const ui = state.ui.toolbar;
    const LBL = { toc: 'Contents', search: 'Search', pen: 'Highlight', capture: 'Capture', annotations: 'Notes', tts: 'Listen', sounds: 'Sounds', bookmark: 'Bookmark', display: 'Display', fullscreen: 'Full screen' };
    const tb = (key, ico, label, fn, extra) => { if (ui[key] === false) return null; const b = iconBtn(ico, label, fn, { class: `rd-btn rd-${key}`, ...extra }); b.append(h('span.rd-lbl', LBL[key] || '')); return b; };
    this.titleEl = h('div.rd-title', h('div.rd-book', this.book.title), h('div.rd-chapter', this.book.author || ''));
    this.bookmarkBtn = tb('bookmark', 'bookmark', 'Bookmark this page (B)', () => this.toggleBookmark());
    this.viewBtn = this.isPdfBook ? iconBtn('book', 'Switch between Book view and original pages (V)', () => this.switchView(this.view === 'book' ? 'original' : 'book'), { class: 'rd-btn rd-viewtoggle' }) : null;
    this.viewBtn?.append(h('span.rd-lbl', 'Original'));
    this.viewBtn && (this.viewBtn.hidden = true);
    this.tools = {
      toc: tb('toc', 'toc', 'Contents (T)', () => this.togglePanel('toc')),
      search: tb('search', 'search', 'Search in book (/)', () => this.togglePanel('search')),
      pen: tb('pen', 'highlight', 'Highlighter: pick a colour, then select text (L)', (e) => this.penMenu(e.currentTarget)),
      annotations: tb('annotations', 'note', 'Highlights & notes (H)', () => this.togglePanel('annotations')),
      tts: tb('tts', 'speaker', 'Read aloud (R)', () => this.toggleTts()),
      sounds: tb('sounds', 'waves', 'Background sounds (S)', () => this.togglePanel('sounds')),
      bookmark: this.bookmarkBtn,
    };
    this.displayBtn = tb('display', 'type', 'Display settings (A)', () => this.togglePanel('display'));
    this.penBtn = this.tools.pen;
    this.captureBtn = tb('capture', 'camera', 'Save this page as an image (C)', () => this.capturePage());
    this.fsBtn = tb('fullscreen', 'fullscreen', 'Full screen (F)', () => this.toggleFullscreen());
    this.moreBtn = iconBtn('more', 'More options', (e) => this.moreMenu(e.currentTarget), { class: 'rd-btn rd-more' });
    this.sizeDownBtn = h('button.rd-pill.rd-size', { type: 'button', 'aria-label': 'Smaller text', title: 'Smaller text (-)', onclick: () => this.bumpSize(-1) }, h('span', { style: { fontSize: '13px' } }, 'A'), h('span.rd-minus', '\u2212'));
    this.sizeUpBtn = h('button.rd-pill.rd-size', { type: 'button', 'aria-label': 'Larger text', title: 'Larger text (+)', onclick: () => this.bumpSize(1) }, h('span', { style: { fontSize: '20px' } }, 'A'), h('span.rd-minus', '+'));
    this.spreadBtn = h('button.rd-pill.rd-spread', { type: 'button', onclick: () => this.toggleSpread() });
    const zoomBy = (f) => this.engine?.setSpreadZoom?.((this.settings.spreadZoom || 1) * f);
    this.zoomOutBtn = h('button.rd-pill.rd-zoom', { type: 'button', 'aria-label': 'Zoom out', title: 'Zoom out', onclick: () => zoomBy(1 / 1.25) }, icon('search', 15), h('span.rd-minus', '\u2212'));
    this.zoomLbl = h('button.rd-pill.rd-zoomlbl', { type: 'button', 'aria-label': 'Fit both pages to the screen', title: 'Fit both pages', onclick: () => this.engine?.setSpreadZoom?.(1) }, '100%');
    this.zoomInBtn = h('button.rd-pill.rd-zoom', { type: 'button', 'aria-label': 'Zoom in', title: 'Zoom in', onclick: () => zoomBy(1.25) }, icon('search', 15), h('span.rd-minus', '+'));
    this.textRow = h('div.rd-textrow', { role: 'toolbar', 'aria-label': 'Text and view' }, this.sizeDownBtn, this.sizeUpBtn, this.spreadBtn, this.zoomOutBtn, this.zoomLbl, this.zoomInBtn, this.displayBtn);
    this.toolsEl = h('div.rd-tools', this.viewBtn, ...Object.values(this.tools).slice(0, 6), this.bookmarkBtn, this.captureBtn, this.fsBtn, this.moreBtn);
    this.top = h('header.rd-top', { role: 'toolbar', 'aria-label': 'Reading tools' },
      iconBtn('back', 'Back to library', () => this.close(), { class: 'rd-btn rd-back' }),
      this.titleEl,
      this.toolsEl);
    // On a phone the main tools sit in a labelled strip at the bottom, where the thumb is.
    this.dock = h('div.rd-dock', { role: 'toolbar', 'aria-label': 'Reader tools' });
    const mq = matchMedia('(max-width: 700px)');
    const place = () => {
      const order = ['toc', 'search', 'pen', 'annotations', 'tts', 'sounds', 'bookmark'].map((k) => this.tools[k]).filter(Boolean);
      if (mq.matches) order.forEach((el) => this.dock.append(el));
      else {
        const anchor = [this.captureBtn, this.fsBtn, this.moreBtn].find((x) => x && x.parentNode === this.toolsEl) || null;
        for (const el of order) this.toolsEl.insertBefore(el, anchor);
      }
    };
    place();
    mq.addEventListener('change', place);
    this.unsubs.push(() => mq.removeEventListener('change', place));
    this.slider = h('input.rd-slider', { type: 'range', min: 0, max: 1000, step: 1, value: 0, 'aria-label': 'Reading position' });
    this.slider.addEventListener('input', () => this.previewSlider());
    this.slider.addEventListener('change', () => { this.engine?.goToFraction(this.slider.value / 1000); this.sliderTip.hidden = true; });
    this.sliderTip = h('div.rd-slider-tip', { hidden: true });
    this.posLabel = h('span.rd-pos', '');
    this.leftLabel = h('span.rd-left', '');
    this.pctLabel = h('span.rd-pct', '');
    this.bottom = h('footer.rd-bottom',
      this.textRow,
      this.dock,
      iconBtn('chevronL', 'Previous page', () => this.engine?.prev(), { class: 'rd-btn rd-prev' }),
      h('div.rd-progress', h('div.rd-slider-wrap', this.slider, this.sliderTip), h('div.rd-meta', this.posLabel, this.leftLabel, this.pctLabel)),
      iconBtn('chevronR', 'Next page', () => this.engine?.next(), { class: 'rd-btn rd-next' }));
    this.stage = h('main.rd-stage', { tabindex: '-1', 'aria-label': 'Book text' });
    this.ribbon = h('div.rd-ribbon', { 'aria-hidden': 'true' });
    this.panel = h('aside.rd-panel', { 'aria-label': 'Reader panel' });
    this.edgeTop = h('div.rd-edge.top');
    this.edgeBottom = h('div.rd-edge.bottom');
    this.runTop = h('div.rd-run.top', { 'aria-hidden': 'true' });
    this.runBottom = h('div.rd-run.bottom', { 'aria-hidden': 'true' });
    // A small arrow tab: pulls the toolbar back down when it is tucked away, and tucks it away when it is showing.
    this.handle = h('button.rd-handle', { type: 'button', 'aria-label': 'Hide toolbar', title: 'Pull up or down to show / hide the toolbar (M)',
      onpointerdown: (e) => { this.handleWasHidden = this.chromeHidden; this.hy = e.clientY; this.hmoved = false; },
      onpointerup: (e) => {
        const dy = e.clientY - this.hy;
        if (Math.abs(dy) > 14) { this.hmoved = true; if (dy < 0 && this.handleWasHidden) { this.showChrome(true); this.chromeHold = Date.now() + 6000; this.hideChromeSoon(6000); } else if (dy > 0 && !this.handleWasHidden) this.tuckChrome(); }
      },
      onclick: (e) => { e.stopPropagation(); if (this.hmoved) { this.hmoved = false; this.handleWasHidden = undefined; return; } const wasHidden = this.handleWasHidden ?? this.chromeHidden; this.handleWasHidden = undefined; if (wasHidden) { this.showChrome(true); this.chromeHold = Date.now() + 6000; this.hideChromeSoon(6000); } else this.tuckChrome(); } }, icon("chevronD", 14));
    // Keep the pull tab riding on the top edge of the bottom bar, and let the bar itself be swiped down.
    if (window.ResizeObserver) { const ro = new ResizeObserver(() => this.root.style.setProperty('--bh', this.bottom.offsetHeight + 'px')); ro.observe(this.bottom); this.unsubs.push(() => ro.disconnect()); }
    let by = 0, bx = 0;
    this.bottom.addEventListener('touchstart', (e) => { by = e.touches[0].clientY; bx = e.touches[0].clientX; }, { passive: true });
    this.bottom.addEventListener('touchend', (e) => { const t = e.changedTouches[0]; if (t.clientY - by > 50 && Math.abs(t.clientX - bx) < 40 && !e.target.closest?.('.rd-slider-wrap')) this.tuckChrome(); }, { passive: true });
    this.root.append(this.stage, this.runTop, this.runBottom, this.ribbon, this.edgeTop, this.edgeBottom, this.top, this.bottom, this.panel, this.handle);
    for (const edge of [this.edgeTop, this.edgeBottom]) edge.addEventListener('mouseenter', () => this.showChrome());
    this.top.addEventListener('mouseenter', () => this.pinChrome = true);
    this.top.addEventListener('mouseleave', () => { this.pinChrome = false; this.hideChromeSoon(); });
    this.bottom.addEventListener('mouseenter', () => this.pinChrome = true);
    this.bottom.addEventListener('mouseleave', () => { this.pinChrome = false; this.hideChromeSoon(); });
  }

  applyTheme() {
    const s = this.settings;
    const c = themeColors(s);
    const st = this.root.style;
    st.setProperty('--rd-bg', c.bg);
    st.setProperty('--rd-fg', c.fg);
    st.setProperty('--rd-muted', c.muted);
    st.setProperty('--rd-line', c.line);
    st.setProperty('--rd-chrome', c.chrome);
    this.root.dataset.dark = c.dark ? '1' : '0';
    this.root.dataset.theme = s.theme;
    document.documentElement.style.setProperty('--reader-bg', c.bg);
    setThemeColor(c.chrome || c.bg);
  }

  showChrome(force) {
    if (this.chromeHidden === false && !force) return;
    this.root.classList.remove('chrome-hidden');
    this.chromeHidden = false;
    this.handle?.setAttribute('aria-label', 'Hide toolbar');
  }
  hideChrome() {
    if (this.pinChrome || this.panelOpen || this.tts?.active || !state.ui.toolbarAutoHide) return;
    this.root.classList.add('chrome-hidden');
    this.chromeHidden = true;
  }
  hideChromeSoon(ms = 1800) {
    if (this.chromeHold && Date.now() < this.chromeHold && ms < 3000) return;
    clearTimeout(this.chromeT);
    this.chromeT = setTimeout(() => this.hideChrome(), ms);
  }
  tuckChrome() { this.root.classList.add('chrome-hidden'); this.chromeHidden = true; this.handle?.setAttribute('aria-label', 'Show toolbar'); }
  toggleChrome() { this.chromeHidden ? (this.showChrome(true), this.chromeHold = Date.now() + 5000, this.hideChromeSoon(5000)) : this.tuckChrome(); }

  onTap(zone, e) {
    this.activity();
    if (this.closePops()) return;
    if (this.panelOpen && innerWidth < 900) { this.closePanel(); return; }
    const paged = this.isPdf ? this.engine.mode !== 'scroll' : this.engine.mode === 'paged';
    // With half-and-half tap areas there is no middle, so the top strip of the page shows the toolbar.
    const top = e && state.ui.tapZone === 'halves' && (e.clientY - this.stage.getBoundingClientRect().top) < 72;
    if (zone === 'center' || top || !paged || !state.ui.tapToTurn) { this.toggleChrome(); return; }
    zone === 'left' ? this.engine.prev() : this.engine.next();
  }

  moreMenu(anchor) {
    const perBook = !!this.book.settings;
    const narrow = innerWidth <= 820;
    menu(anchor, [
      ...(narrow ? [
        { label: 'Search in book', icon: 'search', run: () => this.togglePanel('search', true) },
        { label: 'Highlights & notes', icon: 'highlight', run: () => this.togglePanel('annotations', true) },
        { label: 'Background sounds', icon: 'waves', run: () => this.togglePanel('sounds', true) },
        { label: 'Full screen', icon: 'fullscreen', run: () => this.toggleFullscreen() },
        'sep'] : []),
      ...(this.isPdfBook && this.canBookView ? [{ label: this.view === 'book' ? 'Show original pages' : 'Read in Book view', icon: this.view === 'book' ? 'copy' : 'book', run: () => this.switchView(this.view === 'book' ? 'original' : 'book') }] : []),
      { label: 'All bookmarks', icon: 'bookmark', run: () => { this.tocTab = 'bookmarks'; this.togglePanel('toc', true); } },
      { label: 'Save page as image', icon: 'camera', run: () => this.capturePage() },
      { label: 'Book details', icon: 'book', run: () => this.showDetails() },
      { label: 'Export highlights & notes', icon: 'download', run: () => exportBookAnnotations(this.book) },
      { label: perBook ? 'Use my default settings' : 'Keep these settings for this book', icon: 'sliders', run: () => this.setPerBook(!perBook) },
      { label: state.ui.toolbarAutoHide ? 'Keep toolbar visible' : 'Auto-hide toolbar', icon: 'menu', run: () => { saveUI({ toolbarAutoHide: !state.ui.toolbarAutoHide }); this.showChrome(true); } },
      { label: 'Keyboard shortcuts', icon: 'more', run: () => showShortcuts() },
      'sep',
      { label: this.book.finishedAt ? 'Mark as unread' : 'Mark as finished', icon: 'check', run: () => updateBook(this.book, { finishedAt: this.book.finishedAt ? null : Date.now() }).then(() => toast(this.book.finishedAt ? 'Marked as finished' : 'Marked as unread')) },
    ]);
  }

  showDetails() {
    const b = this.book, info = this.info;
    const rows = [
      ['Title', b.title], ['Author', b.author || '—'], ['Format', b.format.toUpperCase()], ['File', `${b.fileName}`],
      ['Progress', `${fmtPct(b.progress)}${info?.pageLabel ? ' · ' + info.pageLabel : ''}`], ['Time read', fmtDuration(b.readingSeconds)],
      ['Highlights', String(this.bookAnns().length)], ['Bookmarks', String(this.bookMarks().length)],
    ];
    dialog({ title: 'Book details', body: h('dl.details', rows.map(([k, v]) => [h('dt', k), h('dd', v)])), actions: [{ label: 'Close', value: true, primary: true }] });
  }

  // ---------------- position ----------------
  onRelocate(info) {
    this.info = info;
    this.updateTextRow();
    this.activity();
    const pct = Math.round(info.progress * 1000) / 10;
    this.slider.value = Math.round(info.progress * 1000);
    this.slider.style.setProperty('--fill', info.progress * 100 + '%');
    this.posLabel.textContent = info.pageLabel || '';
    this.pctLabel.textContent = `${pct < 10 && pct > 0 ? pct.toFixed(1) : Math.round(pct)}%`;
    let left = '';
    if (this.isPdf) {
      if (info.pagesLeftInChapter != null) left = info.pagesLeftInChapter === 0 ? 'Last page in chapter' : `${info.pagesLeftInChapter} page${info.pagesLeftInChapter === 1 ? '' : 's'} left in chapter`;
    } else if (info.charsLeftInChapter != null) {
      const min = Math.ceil(info.charsLeftInChapter / 1100);
      left = min <= 1 ? 'Less than a minute left in chapter' : `${min} min left in chapter`;
    }
    this.leftLabel.textContent = left;
    $('.rd-chapter', this.titleEl).textContent = info.chapterTitle || this.book.author || '';
    this.runTop.textContent = info.chapterTitle || this.book.title;
    this.runBottom.textContent = `${info.pageLabel ? info.pageLabel.replace(/^Page /, '') + '  ·  ' : ''}${Math.round(info.progress * 100)}%`;
    this.updateBookmarkState();
    this.markTocCurrent();
    if (!this.tts?.active && this.lastInfoProgress != null && Math.abs(this.lastInfoProgress - info.progress) > 0) this.hideChromeSoon(900);
    this.lastInfoProgress = info.progress;
    this.saveProgress();
  }

  saveProgress = debounce(() => this.saveProgressNow(), 800);
  saveProgressNow() {
    if (!this.info || !this.engine) return;
    const i = this.info;
    const patch = { [this.view === 'book' ? 'bookLocation' : 'location']: i.loc, progress: i.progress, pageLabel: i.pageLabel, lastOpenedAt: Date.now(), chapterTitle: i.chapterTitle || '' };
    if (this.view === 'book') { const pg = this.flowLocToPage(i.loc); if (pg != null) patch.location = { page: pg, y: 0 }; }
    if (i.progress >= 0.995 && !this.book.finishedAt) patch.finishedAt = Date.now();
    updateBook(this.book, patch);
  }

  previewSlider() {
    const f = this.slider.value / 1000;
    this.slider.style.setProperty('--fill', f * 100 + '%');
    let label = `${Math.round(f * 100)}%`;
    if (this.isPdf) label = `Page ${Math.min(this.engine.n, Math.floor(f * this.engine.n) + 1)}`;
    else {
      const e = this.engine;
      const target = f * e.total;
      let ch = 0;
      e.chStarts.forEach((s, i) => { if (s <= target) ch = i; });
      label = `${e.book.chapters[ch]?.title || ''} · ${label}`;
    }
    this.sliderTip.textContent = label;
    this.sliderTip.hidden = false;
    this.sliderTip.style.left = `calc(${f * 100}% )`;
  }

  onReachEnd() {
    if (this.endShown) return;
    this.endShown = true;
    toast(this.book.finishedAt ? 'You’ve reached the end.' : 'You’ve reached the end of the book.', this.book.finishedAt ? {} : { action: { label: 'Mark finished', run: () => updateBook(this.book, { finishedAt: Date.now(), progress: 1 }) } });
  }

  // ---------------- global input ----------------
  bindGlobal() {
    const onKey = (e) => this.onKey(e);
    document.addEventListener('keydown', onKey);
    this.unsubs.push(() => document.removeEventListener('keydown', onKey));
    const onSel = debounce(() => this.onSelectionChange(), 260);
    document.addEventListener('selectionchange', onSel);
    this.unsubs.push(() => document.removeEventListener('selectionchange', onSel));
    const act = () => this.activity();
    for (const ev of ['pointerdown', 'wheel', 'touchstart']) { this.root.addEventListener(ev, act, { passive: true }); }
    const onMove = (e) => {
      if (e.pointerType !== 'mouse') return;
      if (e.clientY < 64 || e.clientY > innerHeight - 76) this.showChrome();
    };
    this.root.addEventListener('pointermove', onMove);
    const onVis = () => { if (document.hidden) { this.saveProgressNow(); this.flushTime(); } };
    document.addEventListener('visibilitychange', onVis);
    this.unsubs.push(() => document.removeEventListener('visibilitychange', onVis));
    const onFs = () => { const b = $('.rd-fullscreen', this.top); if (b) { b.replaceChildren(icon(document.fullscreenElement ? 'exitfs' : 'fullscreen')); } };
    document.addEventListener('fullscreenchange', onFs);
    this.unsubs.push(() => document.removeEventListener('fullscreenchange', onFs));
    this.unsubs.push(on('annotations', ({ bookId } = {}) => { if (bookId === this.book.id) { this.engine.setAnnotations(this.bookAnns()); if (this.panelName === 'annotations') this.renderPanel(); } }));
    this.unsubs.push(on('bookmarks', ({ bookId } = {}) => { if (bookId === this.book.id) { this.updateBookmarkState(); if (this.panelName === 'toc' && this.tocTab === 'bookmarks') this.renderPanel(); } }));
    this.unsubs.push(on('ui', () => this.rebuildToolbarVisibility()));
    const onPop = () => { if (!location.hash.startsWith('#book-') && current === this) this.close(); };
    window.addEventListener('hashchange', onPop);
    this.unsubs.push(() => window.removeEventListener('hashchange', onPop));
  }

  rebuildToolbarVisibility() {
    for (const key of Object.keys(TOOLBAR_ITEMS)) {
      const b = $(`.rd-${key}`, this.root);
      if (b) b.hidden = state.ui.toolbar[key] === false;
    }
  }

  onKey(e) {
    if (e.defaultPrevented) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) {
      if (e.key === 'Escape') t.blur();
      return;
    }
    if (document.querySelector('.scrim')) return;
    const k = e.key, mod = e.ctrlKey || e.metaKey;
    const scrollPdf = this.isPdf && this.engine?.mode === 'scroll';
    const scrollFlow = !this.isPdf && this.engine?.mode === 'scroll';
    if (mod && (k === 'f' || k === 'F')) { e.preventDefault(); this.togglePanel('search', true); return; }
    if (mod && (k === '=' || k === '+')) { e.preventDefault(); this.bumpSize(1); return; }
    if (mod && k === '-') { e.preventDefault(); this.bumpSize(-1); return; }
    if (mod || e.altKey) return;
    const handled = () => { e.preventDefault(); this.activity(); };
    switch (k) {
      case 'ArrowRight': case 'PageDown':
        handled(); scrollPdf ? this.engine.goTo({ page: this.engine.cur + 1, y: 0 }) : this.engine?.next(); break;
      case 'ArrowLeft': case 'PageUp':
        handled(); scrollPdf ? this.engine.goTo({ page: Math.max(0, this.engine.cur - (this.engine.currentLoc().y > 0.05 ? 0 : 1)), y: 0 }) : this.engine?.prev(); break;
      case ' ':
        handled(); e.shiftKey ? this.engine?.prev() : this.engine?.next(); break;
      case 'ArrowDown': case 'ArrowUp':
        if (scrollPdf || scrollFlow) return;
        handled(); k === 'ArrowDown' ? this.engine?.next() : this.engine?.prev(); break;
      case 'Home': handled(); this.engine?.goToFraction(0); break;
      case 'End': handled(); this.engine?.goToFraction(this.isPdf ? 0.9999 : 0.9999); break;
      case 't': case 'T': handled(); this.togglePanel('toc'); break;
      case '/': handled(); this.togglePanel('search', true); break;
      case 'a': case 'A': handled(); this.togglePanel('display'); break;
      case 'h': case 'H': handled(); this.togglePanel('annotations'); break;
      case 'b': case 'B': handled(); this.toggleBookmark(); break;
      case 'l': case 'L': handled(); this.penMenu(this.penBtn || this.stage); break;
      case 'c': case 'C': handled(); this.capturePage(); break;
      case 'f': case 'F': handled(); this.toggleFullscreen(); break;
      case 'r': case 'R': handled(); this.toggleTts(); break;
      case 'm': case 'M': handled(); this.toggleChrome(); break;
      case 's': case 'S': handled(); this.togglePanel('sounds'); break;
      case 'v': case 'V': if (this.isPdfBook && this.canBookView) { handled(); this.switchView(this.view === 'book' ? 'original' : 'book'); } break;
      case '+': case '=': handled(); this.bumpSize(1); break;
      case '-': case '_': handled(); this.bumpSize(-1); break;
      case '0': if (this.isPdf) { handled(); this.setSetting('zoom', 'auto'); } break;
      case 'Escape':
        handled();
        if (this.closePops()) return;
        if (this.panelOpen) { this.closePanel(); return; }
        if (this.tts?.active) { this.tts.stop(); return; }
        if (document.fullscreenElement) { document.exitFullscreen().catch(() => {}); return; }
        break;
      default:
    }
  }

  bumpSize(d) {
    if (this.isPdf) {
      const z = this.engine.scale;
      this.setSetting('zoom', clamp(Math.round((z * (d > 0 ? 1.15 : 1 / 1.15)) * 100) / 100, 0.25, 6));
    } else {
      this.setSetting('fontSize', clamp(this.settings.fontSize + d, 8, 40));
    }
  }

  activity() { this.lastActivity = Date.now(); }

  // ---------------- reading time ----------------
  startTracking() {
    this.pendingSeconds = 0;
    const tick = 5;
    const t = setInterval(() => {
      const idle = Date.now() - this.lastActivity > 3 * 60e3;
      if (document.hidden || (idle && !this.tts?.playing)) return;
      this.pendingSeconds += tick;
      if (this.pendingSeconds >= 30) this.flushTime();
    }, tick * 1000);
    this.timers.push(t);
  }
  flushTime() {
    if (this.pendingSeconds > 0) { logReading(this.book.id, this.pendingSeconds); this.pendingSeconds = 0; }
  }

  // ---------------- fullscreen ----------------
  async toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (document.documentElement.requestFullscreen) { await document.documentElement.requestFullscreen(); this.hideChromeSoon(600); }
      else throw new Error('no');
    } catch {
      // Embedded viewers may block the Fullscreen API: fall back to a focus mode.
      this.root.classList.toggle('focus-mode');
      const onNow = this.root.classList.contains('focus-mode');
      if (onNow) { this.closePanel(); this.root.classList.add('chrome-hidden'); this.chromeHidden = true; }
      toast(onNow ? 'Focus mode on. Tap the middle of the page or press M for controls.' : 'Focus mode off');
    }
  }

  // ---------------- bookmarks ----------------
  bookmarkOnScreen() {
    const info = this.info;
    if (!info) return null;
    return this.bookMarks().find((b) => this.locOnScreen(b.loc));
  }
  locOnScreen(loc) {
    if (!loc || !this.engine) return false;
    if (this.isPdf) {
      if (this.engine.mode === 'scroll') return loc.page === this.info.loc.page;
      return this.engine.spreads()[this.engine.spread]?.includes(loc.page);
    }
    if (loc.ch !== this.info.loc.ch) return false;
    return this.engine.isVisible(loc);
  }
  updateBookmarkState() {
    const on = !!this.bookmarkOnScreen();
    this.ribbon.classList.toggle('on', on);
    this.bookmarkBtn?.classList.toggle('active', on);
    this.bookmarkBtn?.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
  async toggleBookmark() {
    const existing = this.bookmarkOnScreen();
    if (existing) {
      await deleteBookmark(existing.id);
      toast('Bookmark removed', { action: { label: 'Undo', run: () => addBookmark(existing) } });
      return;
    }
    const info = this.info;
    if (!info) return;
    let snippet = '';
    try {
      if (this.isPdf) snippet = (await this.engine.pageText(info.loc.page)).replace(/\s+/g, ' ').trim().slice(0, 140);
      else snippet = this.engine.chapterText(info.loc.ch).slice(info.loc.off, info.loc.off + 160).replace(/\s+/g, ' ').trim();
    } catch {}
    await addBookmark({ bookId: this.book.id, loc: info.loc, progress: info.progress, label: info.chapterTitle || info.pageLabel, pageLabel: info.pageLabel, snippet });
    toast('Page bookmarked', { action: { label: 'View all', run: () => { this.tocTab = 'bookmarks'; this.togglePanel('toc', true); } } });
  }

  // ---------------- selection & annotations ----------------
  onSelectionChange() {
    if (!this.engine) return;
    const s = hasSelection() ? this.engine.selectionLoc() : null;
    if (!s) { if (this.selPop && !this.selPop.contains(document.activeElement)) this.hideSelPop(); return; }
    this.sel = s;
    if (this.hlPen) {
      // Highlighter on: wait for the finger to stop adjusting the selection, then highlight it.
      clearTimeout(this.penT);
      this.penT = setTimeout(() => { if (this.hlPen && hasSelection()) this.createAnnotation({ color: this.hlPen, style: 'highlight' }); }, 700);
      return;
    }
    this.showSelPop(s);
  }

  penMenu(anchor) {
    if (this.closePops()) return;
    const pop = h('div.rd-pop.pen-pop', { role: 'dialog', 'aria-label': 'Highlighter' },
      h('p.pen-title', this.hlPen ? 'Highlighter is on' : 'Pick a highlighter'),
      h('div.pop-colors', Object.entries(HL_COLORS).map(([k, c]) => h('button.swatch', { type: 'button', class: `swatch ${this.hlPen === k ? 'on' : ''}`, 'aria-label': `Highlight in ${c.label}`, title: c.label, style: { '--sw': c.css }, onclick: () => this.setPen(k) }))),
      h('p.hint', 'Then select text and it is highlighted at once.'),
      this.hlPen ? h('button.btn.btn-small', { type: 'button', onclick: () => this.setPen(null) }, 'Turn off') : null);
    this.placePop(pop, anchor.getBoundingClientRect(), false);
  }
  setPen(color) {
    this.hlPen = color;
    this.root.classList.toggle('pen-on', !!color);
    this.closePops();
    const b = this.penBtn;
    if (b) { b.classList.toggle('active', !!color); b.classList.toggle('has-pen', !!color); if (color) b.style.setProperty('--pen', HL_COLORS[color].css); }
    toast(color ? `Highlighter on (${HL_COLORS[color].label.toLowerCase()}). Drag over text to highlight. Swiping and edge taps are paused; use the arrows to turn pages.` : 'Highlighter off');
    saveUI({ lastColor: color || state.ui.lastColor });
  }

  async capturePage() {
    try {
      const caption = `${this.book.title}${this.book.author ? ' · ' + this.book.author : ''}${this.info?.pageLabel ? ' · ' + this.info.pageLabel : ''}`;
      const cv = this.isPdf ? this.engine.captureCanvas() : this.engine.captureCanvas(caption);
      if (!cv) { toast('Nothing to capture yet.'); return; }
      const blob = await new Promise((r) => cv.toBlob(r, 'image/png'));
      const name = `${this.book.title}${this.info?.pageLabel ? ' - ' + this.info.pageLabel : ''}`.replace(/[\\/:*?"<>|]+/g, '').slice(0, 80) + '.png';
      const file = new File([blob], name, { type: 'image/png' });
      if (navigator.canShare?.({ files: [file] })) {
        try { await navigator.share({ files: [file], title: this.book.title }); return; } catch (e) { if (e && e.name === 'AbortError') return; }
      }
      const url = URL.createObjectURL(blob);
      const a = h('a', { href: url, download: name });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      toast('Page saved as an image');
    } catch (e) { console.warn(e); toast('Couldn’t capture this page.'); }
  }

  closePops() {
    let closed = false;
    for (const el of $$('.rd-pop', this.root)) { el.remove(); closed = true; }
    this.selPop = null;
    return closed;
  }
  hideSelPop() { this.selPop?.remove(); this.selPop = null; }

  placePop(pop, rect, preferBelow) {
    this.root.append(pop);
    const pw = pop.offsetWidth, ph = pop.offsetHeight;
    const coarse = matchMedia('(pointer: coarse)').matches;
    let x = rect.left + rect.width / 2 - pw / 2;
    x = clamp(x, 8, innerWidth - pw - 8);
    let y = (preferBelow || coarse) ? rect.bottom + 12 : rect.top - ph - 12;
    if (y < 8) y = rect.bottom + 12;
    if (y + ph > innerHeight - 8) y = Math.max(8, rect.top - ph - 12);
    pop.style.left = x + 'px';
    pop.style.top = y + 'px';
    requestAnimationFrame(() => pop.classList.add('in'));
  }

  showSelPop(sel) {
    this.closePops();
    const sample = capabilityNow('sample');
    const pop = h('div.rd-pop.sel-pop', { role: 'toolbar', 'aria-label': 'Selection actions', onmousedown: (e) => { if (!e.target.closest('button')) return; e.preventDefault(); } });
    const colors = h('div.pop-colors', Object.entries(HL_COLORS).map(([k, c]) => h('button.swatch', { type: 'button', 'aria-label': `Highlight ${c.label}`, title: `Highlight ${c.label}`, style: { '--sw': c.css }, onclick: () => this.createAnnotation({ color: k, style: 'highlight' }) })));
    const lastColor = state.ui.lastColor || 'yellow';
    const row = h('div.pop-actions',
      iconBtn('underline', 'Underline', () => this.createAnnotation({ color: lastColor, style: 'underline' }), { class: 'pop-btn' }),
      iconBtn('strike', 'Strike through', () => this.createAnnotation({ color: lastColor, style: 'strike' }), { class: 'pop-btn' }),
      iconBtn('note', 'Add note', () => this.createAnnotation({ color: lastColor, style: 'highlight' }, true), { class: 'pop-btn', text: 'Note' }),
      iconBtn('copy', 'Copy', () => this.copySel(false), { class: 'pop-btn' }),
      iconBtn('share', 'Copy as quote', () => this.copySel(true), { class: 'pop-btn' }),
      sample ? iconBtn('dict', 'Define', () => this.lookup('define'), { class: 'pop-btn' }) : navigator.onLine ? iconBtn('dict', 'Look up in Wiktionary', () => this.lookupOnline('define'), { class: 'pop-btn' }) : null,
      sample ? iconBtn('translate', 'Translate', () => this.lookup('translate'), { class: 'pop-btn' }) : navigator.onLine ? iconBtn('translate', 'Translate with Google Translate', () => this.lookupOnline('translate'), { class: 'pop-btn' }) : null,
      iconBtn('speaker', 'Read aloud from here', () => { this.hideSelPop(); this.startTtsAt(this.sel); }, { class: 'pop-btn' }),
      iconBtn('search', 'Search for this', () => { const q = this.sel.text.slice(0, 80); this.hideSelPop(); getSelection()?.removeAllRanges(); this.togglePanel('search', true, q); }, { class: 'pop-btn' }),
    );
    pop.append(colors, h('div.pop-sep'), row);
    this.selPop = pop;
    this.placePop(pop, sel.rect);
  }

  async createAnnotation({ color, style }, withNote) {
    const s = this.sel || this.engine.selectionLoc();
    if (!s) return;
    const loc = s.kind === 'pdf' ? { kind: 'pdf', page: s.page, rects: s.rects } : { kind: 'flow', ch: s.ch, start: s.start, end: s.end };
    const info = this.info;
    const chapter = this.isPdf ? this.engine.locLabel({ page: s.page }) : this.engine.locLabel({ ch: s.ch });
    const progress = this.isPdf ? this.engine.progressOf({ page: s.page, y: s.rects[0][1] }) : this.engine.progressOf({ ch: s.ch, off: s.start });
    getSelection()?.removeAllRanges();
    this.hideSelPop();
    this.sel = null;
    const a = await addAnnotation({ bookId: this.book.id, loc, text: s.text, color, style, chapter, progress, pageLabel: info?.pageLabel || '' });
    saveUI({ lastColor: color });
    if (withNote) this.editNote(a);
  }

  async copySel(quote) {
    const t = this.sel?.text || getSelection()?.toString() || '';
    const out = quote ? `“${t.trim()}”\n— ${this.book.title}${this.book.author ? ', ' + this.book.author : ''}${this.info?.pageLabel ? ` (${this.info.pageLabel.toLowerCase()})` : ''}` : t;
    toast((await copyText(out)) ? (quote ? 'Quote copied' : 'Copied') : 'Copy failed. Select the text and use your device’s copy command.');
    this.hideSelPop();
  }

  showAnnotationPop(id, rect) {
    const a = state.annotations.find((x) => x.id === id);
    if (!a || !rect) return;
    this.closePops();
    const pop = h('div.rd-pop.ann-pop', { role: 'dialog', 'aria-label': 'Highlight' });
    const colors = h('div.pop-colors', Object.entries(HL_COLORS).map(([k, c]) => h('button.swatch', { type: 'button', class: `swatch ${a.color === k ? 'on' : ''}`, 'aria-label': c.label, title: c.label, style: { '--sw': c.css }, onclick: () => { updateAnnotation(a, { color: k }); this.closePops(); } })));
    const styles = h('div.seg', ['highlight', 'underline', 'strike'].map((st) => h('button', { type: 'button', class: a.style === st ? 'on' : '', 'aria-pressed': a.style === st ? 'true' : 'false', onclick: () => { updateAnnotation(a, { style: st }); this.closePops(); } }, icon(st === 'highlight' ? 'highlight' : st, 18), h('span', st === 'highlight' ? 'Highlight' : st === 'underline' ? 'Underline' : 'Strike'))));
    pop.append(colors, styles);
    if (a.note) pop.append(h('div.pop-note', a.note));
    pop.append(h('div.pop-actions',
      iconBtn('note', a.note ? 'Edit note' : 'Add note', () => { this.closePops(); this.editNote(a); }, { class: 'pop-btn', text: a.note ? 'Edit note' : 'Note' }),
      iconBtn('copy', 'Copy text', async () => { await copyText(a.text); toast('Copied'); this.closePops(); }, { class: 'pop-btn' }),
      iconBtn('speaker', 'Read aloud from here', () => { this.closePops(); this.startTtsAt(a.loc.kind === 'pdf' ? { page: a.loc.page } : { ch: a.loc.ch, start: a.loc.start }); }, { class: 'pop-btn' }),
      iconBtn('trash', 'Delete highlight', async () => { this.closePops(); const del = await deleteAnnotation(a.id); toast('Highlight deleted', { action: { label: 'Undo', run: () => restoreAnnotation(del) } }); }, { class: 'pop-btn danger' }),
    ));
    this.placePop(pop, rect, true);
  }

  async editNote(a) {
    const r = await dialog({
      title: a.note ? 'Edit note' : 'Add a note',
      body: h('blockquote.dlg-quote', a.text.length > 280 ? a.text.slice(0, 280) + '…' : a.text),
      fields: [{ name: 'note', label: 'Note', type: 'textarea', value: a.note, rows: 5, placeholder: 'Your thoughts on this passage' }],
      actions: [{ label: 'Cancel', value: false }, { label: 'Save note', value: true, primary: true }],
    });
    if (r && r.action) await updateAnnotation(a, { note: r.values.note.trim() });
  }

  onLink(target, el) {
    const text = this.engine.targetText(target);
    const isNote = el.dataset.noteref || el.closest('sup') || /^\[?\d{1,3}\]?$|^[*†‡]$/.test(el.textContent.trim());
    if (text && isNote && text.length < 900) {
      this.closePops();
      const pop = h('div.rd-pop.note-pop', { role: 'dialog', 'aria-label': 'Footnote' }, h('p', text), h('div.pop-actions', h('button.btn.btn-small', { type: 'button', onclick: () => { this.closePops(); this.engine.goTo(target, { instant: true }); } }, 'Go to note')));
      this.placePop(pop, el.getBoundingClientRect(), true);
      return;
    }
    this.engine.goTo(target, { instant: true });
  }

  /** Without Claude: open a dictionary or translator in the browser (needs a connection). */
  lookupOnline(kind) {
    const t = (this.sel?.text || '').trim();
    if (!t) return;
    const langs = { English: 'en', Malay: 'ms', 'Chinese (Simplified)': 'zh-CN', 'Chinese (Traditional)': 'zh-TW', Tamil: 'ta', Indonesian: 'id', Japanese: 'ja', Korean: 'ko', Spanish: 'es', French: 'fr', German: 'de', Italian: 'it', Portuguese: 'pt', Arabic: 'ar', Hindi: 'hi', Thai: 'th', Vietnamese: 'vi', Russian: 'ru' };
    const url = kind === 'define'
      ? `https://en.wiktionary.org/wiki/${encodeURIComponent(t.split(/\s+/).slice(0, 3).join(' ').replace(/[^\p{L}\p{N}' -]/gu, '').toLowerCase())}`
      : `https://translate.google.com/?sl=auto&tl=${langs[state.ui.translateTo] || 'en'}&op=translate&text=${encodeURIComponent(t.slice(0, 1500))}`;
    this.hideSelPop();
    const a = h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' });
    document.body.append(a); a.click(); a.remove();
  }

  // ---------------- dictionary / translation via Claude (optional) ----------------
  async lookup(kind) {
    const s = this.sel;
    if (!s) return;
    const sample = await capability('sample');
    if (!sample) { toast('Dictionary and translation need the Claude connection, which isn’t available here.'); return; }
    const text = s.text.trim().slice(0, 1500);
    const rect = s.rect;
    this.closePops();
    const body = h('div.lookup-body', h('div.spinner.small'));
    const head = kind === 'define' ? 'Definition' : `Translation · ${state.ui.translateTo}`;
    const pop = h('div.rd-pop.lookup-pop', { role: 'dialog', 'aria-label': head }, h('div.lookup-head', h('span', head), iconBtn('close', 'Close', () => this.closePops(), { class: 'pop-btn', size: 16 })), body, h('p.lookup-foot', 'Only the selected text was sent to Claude.'));
    this.placePop(pop, rect, true);
    let context = '';
    try {
      if (!this.isPdf) {
        const t = this.engine.chapterText(s.ch);
        context = t.slice(Math.max(0, s.start - 200), s.end + 200).replace(/\s+/g, ' ');
      }
    } catch {}
    const word = text.split(/\s+/).length <= 3;
    const prompt = kind === 'define'
      ? `You are a concise dictionary inside an e-reader. ${word ? `Define the word or phrase "${text}"` : `Explain the meaning of this passage in plain language: "${text}"`}${context ? ` as used in this context: "${context}"` : ''}.\nFormat: first line is the headword with part of speech and pronunciation (for a word), then 1-3 short numbered definitions, marking the sense used in context with "(here)". Then one short example. No preamble, no markdown headings. Under 90 words.`
      : `Translate the following text into ${state.ui.translateTo}. Reply with only the translation, keeping line breaks.\n\n${text}`;
    try {
      const res = await sample(prompt, { modelTier: 'quick', onText: ({ text: t }) => { body.textContent = t; } });
      body.textContent = res.text;
    } catch (e) {
      body.textContent = e?.code === 'rate_limited' ? 'Too many lookups right now. Wait a moment and try again.' : e?.code === 'not_granted' ? 'Lookups were not allowed. You can allow them the next time you’re asked.' : 'The lookup failed. Check your connection and try again.';
    }
  }

  // ---------------- read aloud ----------------
  toggleTts() {
    if (this.tts?.active) { this.tts.playing ? this.tts.pause() : this.tts.resume(); return; }
    this.startTtsAt(null);
  }
  async startTtsAt(from) {
    if (!('speechSynthesis' in window)) { toast('Read aloud isn’t supported in this browser.'); return; }
    if (!this.tts) this.tts = new Speaker(this);
    let loc;
    if (from && from.kind === 'pdf') loc = { page: from.page, y: 0 };
    else if (from && from.page != null) loc = { page: from.page, y: 0 };
    else if (from && from.ch != null) loc = { ch: from.ch, off: from.start ?? from.off ?? 0 };
    else loc = this.info?.loc;
    getSelection()?.removeAllRanges();
    await this.tts.start(loc);
  }

  // ---------------- settings ----------------
  async setSetting(key, value) {
    
    if (this.book.settings) {
      this.book.settings = { ...this.book.settings, [key]: value };
      await updateBook(this.book, { settings: this.book.settings });
    } else await saveReading({ [key]: value });
    this.applyTheme();
    this.engine?.applySettings(this.settings);
    if (this.panelName === 'display') this.syncDisplayPanel();
  }
  async setPerBook(onFlag) {
    if (onFlag) {
      const s = this.settings;
      await updateBook(this.book, { settings: Object.fromEntries(PER_BOOK_KEYS.map((k) => [k, s[k]])) });
      toast('These settings now apply to this book only');
    } else {
      await updateBook(this.book, { settings: null });
      toast('Using your default reading settings');
    }
    this.applyTheme();
    this.engine?.applySettings(this.settings);
    if (this.panelName === 'display') this.renderPanel();
  }

  updateZoomLabel() { const z = $('.zoom-val', this.panel); if (z && this.engine) z.textContent = Math.round(this.engine.scale * 100) + '%'; }

  // ---------------- panels ----------------
  togglePanel(name, forceOpen, query) {
    if (this.panelOpen && this.panelName === name && !forceOpen) { this.closePanel(); return; }
    this.panelName = name;
    this.panelOpen = true;
    if (query != null) this.searchQuery = query;
    this.root.classList.add('panel-open');
    this.panel.classList.add('open');
    this.showChrome(true);
    for (const b of $$('.rd-tools .rd-btn', this.top)) b.classList.remove('panel-active');
    $(`.rd-${name === 'annotations' ? 'annotations' : name}`, this.top)?.classList.add('panel-active');
    this.renderPanel();
  }
  closePanel() {
    this.panelOpen = false;
    this.root.classList.remove('panel-open');
    this.panel.classList.remove('open');
    for (const b of $$('.rd-tools .rd-btn', this.top)) b.classList.remove('panel-active');
    this.searchAbort?.abort();
    this.engine?.clearMarks?.('search-hit');
    this.stage.focus?.({ preventScroll: true });
  }

  renderPanel() {
    const p = this.panel;
    p.textContent = '';
    const name = this.panelName;
    const titles = { toc: 'Contents', search: 'Search', display: 'Display', annotations: 'Highlights & notes', sounds: 'Background sounds' };
    p.append(h('div.panel-head', h('h2', titles[name]), iconBtn('close', 'Close panel', () => this.closePanel(), { class: 'rd-btn' })));
    const body = h('div.panel-body');
    p.append(body);
    if (name === 'toc') this.renderTocPanel(body);
    if (name === 'search') this.renderSearchPanel(body);
    if (name === 'display') { this.renderDisplayPanel(body); this.dispSig = this.dispSignature(); }
    if (name === 'annotations') this.renderAnnPanel(body);
    if (name === 'sounds') this.renderSoundsPanel(body);
  }

  refreshToc() { if (this.panelOpen && this.panelName === 'toc') this.renderPanel(); }

  renderTocPanel(body) {
    this.tocTab = this.tocTab || 'contents';
    const tabs = h('div.tabs', { role: 'tablist' }, [['contents', 'Contents'], ['bookmarks', `Bookmarks (${this.bookMarks().length})`]].map(([k, l]) =>
      h('button', { type: 'button', role: 'tab', class: this.tocTab === k ? 'on' : '', 'aria-selected': this.tocTab === k ? 'true' : 'false', onclick: () => { this.tocTab = k; this.renderPanel(); } }, l)));
    body.append(tabs);
    if (this.tocTab === 'bookmarks') return this.renderBookmarksList(body);
    const toc = this.engine?.toc || [];
    if (!toc.length) {
      body.append(h('p.empty-note', this.isPdf ? 'This PDF has no table of contents. Use the slider or search to move around.' : 'This book has no table of contents.'));
      if (!this.isPdf && this.engine) {
        body.append(h('ol.toc', this.engine.book.chapters.map((c, i) => h('li', h('button.toc-item', { type: 'button', dataset: { i }, onclick: () => { this.engine.goTo({ ch: i, off: 0 }, { instant: true }); if (innerWidth < 900) this.closePanel(); } }, h('span.toc-label', c.title || `Section ${i + 1}`))))));
      }
      return;
    }
    const list = h('ol.toc');
    toc.forEach((t, i) => {
      const pg = this.isPdf && t.loc ? this.engine.pageName(t.loc.page) : t.loc ? fmtPct(this.engine.progressOf({ ch: t.loc.ch, off: 0 })) : '';
      list.append(h('li', { style: { '--depth': t.depth } }, h('button.toc-item', { type: 'button', disabled: !t.loc, dataset: { i }, onclick: () => { this.engine.goTo(t.loc, { instant: true }); if (innerWidth < 900) this.closePanel(); } }, h('span.toc-label', t.label), h('span.toc-page', pg))));
    });
    body.append(list);
    this.markTocCurrent(true);
  }

  markTocCurrent(scroll) {
    if (!this.panelOpen || this.panelName !== 'toc' || this.tocTab !== 'contents' || !this.info || !this.engine) return;
    const idx = (this.engine.toc || []).length ? this.engine.tocIndexFor(this.info.loc) : this.info.loc.ch;
    for (const b of $$('.toc-item', this.panel)) b.classList.toggle('current', +b.dataset.i === idx);
    if (scroll) $('.toc-item.current', this.panel)?.scrollIntoView({ block: 'center' });
  }

  renderBookmarksList(body) {
    const list = this.bookMarks().sort((a, b) => a.progress - b.progress);
    body.append(h('button.btn.btn-block', { type: 'button', onclick: () => this.toggleBookmark().then(() => this.renderPanel()) }, icon('bookmark', 18), this.bookmarkOnScreen() ? 'Remove bookmark on this page' : 'Bookmark this page'));
    if (!list.length) { body.append(h('p.empty-note', 'No bookmarks yet. Press B or tap the bookmark button to save your place.')); return; }
    body.append(h('ul.mark-list', list.map((b) => h('li.mark-item',
      h('button.mark-main', { type: 'button', onclick: () => { this.engine.goTo(b.loc, { instant: true }); if (innerWidth < 900) this.closePanel(); } },
        h('span.mark-label', b.label || 'Bookmark'), h('span.mark-meta', `${b.pageLabel || ''} · ${fmtPct(b.progress)}`), b.snippet ? h('span.mark-snip', b.snippet) : null),
      h('div.mark-actions',
        iconBtn('edit', 'Rename bookmark', async () => { const r = await dialog({ title: 'Rename bookmark', fields: [{ name: 'label', label: 'Name', value: b.label }], actions: [{ label: 'Cancel', value: false }, { label: 'Save', value: true, primary: true }] }); if (r?.action) { await updateBookmark(b, { label: r.values.label.trim() || b.label }); this.renderPanel(); } }, { class: 'mini-btn', size: 16 }),
        iconBtn('trash', 'Delete bookmark', async () => { await deleteBookmark(b.id); this.renderPanel(); toast('Bookmark deleted', { action: { label: 'Undo', run: () => addBookmark(b).then(() => this.renderPanel()) } }); }, { class: 'mini-btn', size: 16 }))))));
  }

  renderSearchPanel(body) {
    const input = h('input.search-input', { type: 'search', placeholder: 'Find in this book', 'aria-label': 'Find in this book', value: this.searchQuery || '', enterkeyhint: 'search' });
    const status = h('p.search-status', { 'aria-live': 'polite' });
    const results = h('ol.search-results');
    const run = async () => {
      const q = input.value.trim();
      this.searchQuery = q;
      this.searchAbort?.abort();
      results.textContent = '';
      this.searchHits = [];
      if (q.length < 2) { status.textContent = q ? 'Type at least two letters.' : ''; return; }
      const ctrl = new AbortController();
      this.searchAbort = ctrl;
      status.textContent = 'Searching…';
      const n = await this.engine.search(q, (r) => {
        const idx = this.searchHits.length;
        this.searchHits.push(r);
        if (idx < 300) results.append(h('li', h('button.result', { type: 'button', onclick: () => { this.searchIdx = idx; this.engine.showSearchHit(r.loc); markSel(); if (innerWidth < 900) this.closePanel(); } }, h('span.result-where', `${r.label} · ${fmtPct(r.progress)}`), h('span.result-text', r.before, h('mark', r.match), r.after))));
      }, ctrl.signal);
      if (ctrl.signal.aborted) return;
      status.textContent = n ? `${n >= 500 ? '500+' : n} result${n === 1 ? '' : 's'}` : `No results for “${q}”.`;
      this.searchIdx = -1;
    };
    const markSel = () => $$('.result', results).forEach((b, i) => b.classList.toggle('current', i === this.searchIdx));
    const step = (d) => {
      if (!this.searchHits?.length) return;
      this.searchIdx = (this.searchIdx + d + this.searchHits.length) % this.searchHits.length;
      this.engine.showSearchHit(this.searchHits[this.searchIdx].loc);
      markSel();
      $$('.result', results)[this.searchIdx]?.scrollIntoView({ block: 'nearest' });
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); this.searchHits?.length && input.value.trim() === this.searchQuery ? step(e.shiftKey ? -1 : 1) : run(); } });
    input.addEventListener('input', debounce(run, 350));
    body.append(h('div.search-row', input, iconBtn('chevronL', 'Previous result', () => step(-1), { class: 'mini-btn' }), iconBtn('chevronR', 'Next result', () => step(1), { class: 'mini-btn' })), status, results);
    setTimeout(() => { input.focus(); if (this.searchQuery) run(); }, 40);
  }

  renderSoundsPanel(body) {
    const vols = state.ui.sounds || {};
    const save = (k, v) => saveUI({ sounds: { ...(state.ui.sounds || {}), [k]: v } });
    body.append(h('p.hint', 'Made live on your device, so they work offline. Mix as many as you like; they quieten while a book is read aloud.'));
    const grid = h('div.sound-grid');
    for (const [k, snd] of Object.entries(ambient.AMBIENT_SOUNDS)) {
      const on = ambient.isPlaying(k);
      const vol = vols[k] ?? 0.6;
      const range = h('input', { type: 'range', min: 0, max: 1, step: 0.01, value: vol, 'aria-label': `${snd.label} volume`, disabled: !on });
      range.addEventListener('input', () => { ambient.setVolume(k, +range.value); });
      range.addEventListener('change', () => save(k, +range.value));
      const tile = h('div', { class: `sound-tile s-${k} ${on ? 'on' : ''}` },
        h('button.sound-toggle', { type: 'button', 'aria-pressed': on ? 'true' : 'false', onclick: () => { ambient.isPlaying(k) ? ambient.stop(k) : ambient.start(k, vol); this.renderPanel(); this.updateSoundsBtn(); } },
          h('span.sound-art', { 'aria-hidden': 'true' }), h('span.sound-name', snd.label), h('span.sound-note', snd.note)),
        range);
      grid.append(tile);
    }
    body.append(grid);
    const mv = h('input#snd-master', { type: 'range', min: 0, max: 1, step: 0.01, value: state.ui.soundsMaster ?? 0.8 });
    mv.addEventListener('input', () => ambient.setMaster(+mv.value));
    mv.addEventListener('change', () => saveUI({ soundsMaster: +mv.value }));
    body.append(h('div.slider-row', h('label', { for: 'snd-master' }, 'Overall'), mv, h('span')));
    if (ambient.anyPlaying()) body.append(h('button.btn.btn-block', { type: 'button', onclick: () => { ambient.stopAll(); this.renderPanel(); this.updateSoundsBtn(); } }, icon('stop', 16), 'Stop all sounds'));
  }
  updateSoundsBtn() { $('.rd-sounds', this.root)?.classList.toggle('active', ambient.anyPlaying()); }

  renderAnnPanel(body) {
    const anns = this.bookAnns().sort((a, b) => (a.progress || 0) - (b.progress || 0));
    this.annFilter = this.annFilter || 'all';
    const chips = h('div.chips', [['all', 'All'], ...Object.entries(HL_COLORS).map(([k, c]) => [k, c.label]), ['notes', 'With notes']].map(([k, l]) =>
      h('button', { type: 'button', class: `chip ${this.annFilter === k ? 'on' : ''}`, 'aria-pressed': this.annFilter === k ? 'true' : 'false', style: HL_COLORS[k] ? { '--sw': HL_COLORS[k].css } : null, onclick: () => { this.annFilter = k; this.renderPanel(); } }, HL_COLORS[k] ? h('span.dot') : null, l)));
    body.append(chips);
    const list = anns.filter((a) => this.annFilter === 'all' || (this.annFilter === 'notes' ? !!a.note : a.color === this.annFilter));
    if (!list.length) {
      body.append(h('p.empty-note', anns.length ? 'Nothing matches this filter.' : 'Select text while reading to highlight it, underline it or add a note.'));
      return;
    }
    body.append(h('div.row.end', h('button.btn.btn-small', { type: 'button', onclick: () => exportBookAnnotations(this.book) }, icon('download', 16), 'Export')));
    body.append(h('ul.ann-list', list.map((a) => h('li', { class: `ann-item c-${a.color}` },
      h('button.ann-main', { type: 'button', onclick: () => this.goToAnnotation(a) },
        h('span.ann-where', `${a.chapter || ''}${a.pageLabel && this.isPdf ? '' : ''} · ${fmtPct(a.progress)}`),
        h('span', { class: `ann-text st-${a.style}` }, a.text.length > 320 ? a.text.slice(0, 320) + '…' : a.text),
        a.note ? h('span.ann-note', a.note) : null),
      h('div.mark-actions',
        iconBtn('note', a.note ? 'Edit note' : 'Add note', () => this.editNote(a), { class: 'mini-btn', size: 16 }),
        iconBtn('trash', 'Delete', async () => { const d = await deleteAnnotation(a.id); toast('Highlight deleted', { action: { label: 'Undo', run: () => restoreAnnotation(d) } }); }, { class: 'mini-btn', size: 16 }))))));
  }

  goToAnnotation(a) {
    const loc = a.loc.kind === 'pdf' ? { page: a.loc.page, y: Math.max(0, a.loc.rects[0][1] - 0.05) } : { ch: a.loc.ch, off: a.loc.start };
    this.engine.goTo(loc, { instant: true });
    if (innerWidth < 900) this.closePanel();
    setTimeout(() => {
      const els = this.isPdf ? $$(`.pdf-mark[data-id="${a.id}"]`, this.stage) : $$(`.hl[data-id="${a.id}"]`, this.stage);
      for (const el of els) { el.classList.remove('pulse'); void el.offsetWidth; el.classList.add('pulse'); }
    }, 120);
  }

  renderDisplayPanel(body) {
    const s = this.settings;
    const sec = (title, ...kids) => h('section.disp-sec', h('h3', title), ...kids);
    const seg = (key, opts) => h('div.seg', { role: 'group', 'aria-label': key }, opts.map(([v, l, ic]) => h('button', { type: 'button', class: s[key] === v ? 'on' : '', 'aria-pressed': s[key] === v ? 'true' : 'false', dataset: { key, v: String(v) }, onclick: () => this.setSetting(key, v) }, ic ? icon(ic, 16) : null, h('span', l))));
    const slider = (key, label, min, max, step, fmt) => {
      const id = 'set-' + key;
      const out = h('output', { for: id }, fmt(s[key]));
      const r = h('input', { id, type: 'range', min, max, step, value: s[key], dataset: { key } });
      r.addEventListener('input', () => { out.textContent = fmt(+r.value); this.setSettingLive(key, +r.value); });
      return h('div.slider-row', h('label', { for: id }, label), r, out);
    };
    const tapSeg = h('div.seg', { role: 'group', 'aria-label': 'Tap areas' }, [['edges', 'Edges'], ['thirds', 'Thirds'], ['halves', 'Halves']].map(([v, l]) => h('button', { type: 'button', class: (state.ui.tapZone || 'thirds') === v ? 'on' : '', 'aria-pressed': (state.ui.tapZone || 'thirds') === v ? 'true' : 'false', onclick: () => saveUI({ tapZone: v }).then(() => this.renderPanel()) }, h('span', l))));
    const turnBlock = [sec('Page turn', seg('pageAnim', TURN_STYLES), h('p.hint', 'Tap the left or right of the page, or swipe, to turn it.')),
      sec('Tap areas', toggle('Tap the page sides to turn pages', state.ui.tapToTurn, (v) => saveUI({ tapToTurn: v }).then(() => this.renderPanel())), state.ui.tapToTurn ? tapSeg : null, state.ui.tapToTurn ? h('p.hint', { 'aria-live': 'polite' }, { edges: 'Narrow strips at the sides turn the page; the rest shows the toolbar.', thirds: 'Left third goes back, right third goes forward, the middle shows the toolbar.', halves: 'Left half goes back, right half goes forward. Tap the very top to show the toolbar.' }[state.ui.tapZone || 'thirds']) : null)];
    // Themes
    const themes = h('div.theme-grid', Object.entries(THEMES).map(([k, t]) => {
      const c = k === 'custom' ? { bg: s.customBg, fg: s.customFg } : t;
      return h('button', { type: 'button', class: `theme-sw ${s.theme === k ? 'on' : ''}`, 'aria-pressed': s.theme === k ? 'true' : 'false', dataset: { theme: k }, style: { '--tb': c.bg, '--tf': c.fg }, onclick: () => this.setSetting('theme', k) }, h('span.theme-aa', 'Aa'), h('span.theme-name', t.label));
    }));
    if (this.isPdfBook && this.canBookView) {
      const vs = h('div.seg.view-seg', { role: 'group', 'aria-label': 'PDF view' }, [['book', 'Book view', 'book'], ['original', 'Original pages', 'copy']].map(([v, l, ic]) =>
        h('button', { type: 'button', class: this.view === v ? 'on' : '', 'aria-pressed': this.view === v ? 'true' : 'false', onclick: () => this.switchView(v) }, icon(ic, 16), h('span', l))));
      const fix = this.view === 'book' ? h('button.btn.btn-block.ghost', { type: 'button', onclick: () => this.rebuildBookView() }, this.book.reflowMode === 'join' ? 'Rebuild with automatic paragraphs' : 'Fix broken lines and paragraphs') : null;
      body.append(sec('PDF view', vs, h('p.hint', this.view === 'book' ? 'The PDF’s text, rebuilt as a book you can restyle. Pictures and tables stay in Original pages.' : 'Switch to Book view to choose the font, size and spacing.'), fix));
    }
    body.append(sec('Theme', themes));
    if (s.theme === 'custom') {
      const bg = h('input', { type: 'color', id: 'c-bg', value: s.customBg });
      const fg = h('input', { type: 'color', id: 'c-fg', value: s.customFg });
      const warn = h('p.contrast-note');
      const check = () => { const r = contrast(bg.value, fg.value); warn.textContent = `Contrast ${r.toFixed(1)}:1${r < 4.5 ? ' · low; text may be hard to read' : ''}`; warn.classList.toggle('bad', r < 4.5); };
      bg.addEventListener('input', () => { this.setSettingLive('customBg', bg.value); check(); });
      fg.addEventListener('input', () => { this.setSettingLive('customFg', fg.value); check(); });
      check();
      body.append(h('div.color-row', h('label', { for: 'c-bg' }, bg, 'Background'), h('label', { for: 'c-fg' }, fg, 'Text')), warn);
    }
    if (this.isPdf) {
      body.append(sec('Pages', seg('pdfLayout', [['scroll', 'Continuous'], ['single', 'Single'], ['double', 'Two pages']])));
      const zoom = h('div.zoom-row',
        iconBtn('zoomOut', 'Zoom out', () => this.bumpSize(-1), { class: 'mini-btn' }),
        h('span.zoom-val', Math.round((this.engine?.scale || 1) * 100) + '%'),
        iconBtn('zoomIn', 'Zoom in', () => this.bumpSize(1), { class: 'mini-btn' }));
      body.append(sec('Zoom', zoom, seg('zoom', [['auto', 'Auto'], ['fit-width', 'Fit width'], ['fit-page', 'Fit page']])));
      body.append(sec('Options',
        toggle('Tint pages to match theme', s.pdfTint, (v) => this.setSetting('pdfTint', v)),
        s.pdfLayout === 'double' ? toggle('Show cover page alone', s.pdfCoverAlone !== false, (v) => this.setSetting('pdfCoverAlone', v)) : null));
      if (s.pdfLayout !== 'scroll') body.append(...turnBlock);
    } else {
      const fonts = h('div.font-list', Object.entries(FONTS).map(([k, f]) => h('button', { type: 'button', class: `font-opt ${s.font === k ? 'on' : ''}`, 'aria-pressed': s.font === k ? 'true' : 'false', dataset: { font: k }, style: { fontFamily: f.stack }, onclick: () => this.setSetting('font', k) }, h('span.font-name', f.label), h('span.font-note', f.note))));
      const num = h('input.size-input', { type: 'number', inputmode: 'numeric', min: 8, max: 40, step: 1, value: s.fontSize, 'aria-label': 'Text size in pixels' });
      num.addEventListener('change', () => this.setSetting('fontSize', clamp(Math.round(+num.value) || s.fontSize, 8, 40)));
      const rng = h('input.size-range', { type: 'range', min: 8, max: 40, step: 1, value: s.fontSize, 'aria-label': 'Text size' });
      rng.addEventListener('input', () => { num.value = rng.value; this.setSettingLive('fontSize', +rng.value); });
      rng.addEventListener('change', () => this.setSetting('fontSize', +rng.value));
      const size = h('div.size-row',
        h('button.size-btn', { type: 'button', 'aria-label': 'Smaller text', onclick: () => this.bumpSize(-1) }, h('span', { style: { fontSize: '14px' } }, 'A')),
        rng,
        h('button.size-btn', { type: 'button', 'aria-label': 'Larger text', onclick: () => this.bumpSize(1) }, h('span', { style: { fontSize: '22px' } }, 'A')),
        num, h('span.size-unit', 'px'));
      body.append(sec('Text', size, fonts));
      body.append(sec('Spacing',
        slider('lineHeight', 'Line spacing', 1.1, 2.4, 0.05, (v) => v.toFixed(2)),
        slider('paraSpacing', 'Paragraphs', 0, 2, 0.1, (v) => v.toFixed(1) + ' em'),
        slider('margin', 'Margins', 8, 140, 2, (v) => v + ' px'),
        slider('maxWidth', 'Line length', 420, 1100, 10, (v) => Math.round(v / (s.fontSize * 0.5)) + ' ch'),
        slider('letterSpacing', 'Letter spacing', -0.02, 0.12, 0.005, (v) => (v * 100).toFixed(1) + '%'),
        slider('fontWeight', 'Weight', 300, 600, 50, (v) => String(v))));
      body.append(sec('Alignment', seg('align', [['left', 'Left'], ['justify', 'Justified']])));
      const narrowForTwo = s.flowLayout === 'paged' && s.spread === 'double' && this.engine?.geo?.n === 1;
      body.append(sec('Layout', seg('flowLayout', [['paged', 'Pages'], ['scroll', 'Scroll']]), s.flowLayout === 'paged' ? seg('spread', [['auto', 'Auto'], ['single', 'One page'], ['double', 'Two pages']]) : null,
        narrowForTwo ? h('p.hint.warn-hint', 'This screen is too narrow for two pages side by side. Turn your phone sideways and it switches to two pages automatically.') : null));
      body.append(sec('Options',
        toggle('Hyphenation', s.hyphenate, (v) => this.setSetting('hyphenate', v)),
        toggle('Indent paragraphs', s.indent, (v) => this.setSetting('indent', v)),
        null));
      if (s.flowLayout === 'paged') body.append(...turnBlock);
    }
    body.append(sec('This book', toggle('Keep these settings for this book only', !!this.book.settings, (v) => this.setPerBook(v)), h('p.hint', this.book.settings ? 'Changes here affect only this book.' : 'Changes here become your defaults for every book.')));
    const tbx = h('div.toolbar-opts', Object.entries(TOOLBAR_ITEMS).map(([k, l]) => toggle(l, state.ui.toolbar[k] !== false, (v) => saveUI({ toolbar: { ...state.ui.toolbar, [k]: v } }))));
    body.append(sec('Toolbar', toggle('Hide toolbar while reading', state.ui.toolbarAutoHide, (v) => saveUI({ toolbarAutoHide: v }).then(() => this.showChrome(true))), h('details.tb-details', h('summary', 'Choose toolbar buttons'), tbx)));
    if (s.theme === 'custom' || true) {
      body.append(h('button.btn.btn-block.ghost', { type: 'button', onclick: async () => { if (await confirmDialog('Reset display settings?', 'Theme, font, size and spacing go back to the defaults.', 'Reset', false)) { const { DEFAULT_READING } = await import('./settings.js'); if (this.book.settings) await updateBook(this.book, { settings: { ...DEFAULT_READING } }); else await saveReading({ ...DEFAULT_READING }); this.applyTheme(); this.engine.applySettings(this.settings); this.renderPanel(); } } }, 'Reset to defaults'));
    }
  }

  setSettingLive = (() => {
    const commit = debounce((key, v) => this.setSetting(key, v), 180);
    return (key, v) => {
      // Live preview of colors/spacing; layout commits after the slider settles.
      if (key === 'customBg' || key === 'customFg') { const s = { ...this.settings, [key]: v }; this.root.style.setProperty('--rd-bg', s.customBg); this.root.style.setProperty('--rd-fg', s.customFg); }
      commit(key, v);
    };
  })();

  dispSignature() { const s = this.settings; return `${s.theme === 'custom'}|${s.flowLayout}|${s.pdfLayout}|${s.spread}|${this.engine?.geo?.n}`; }

  syncDisplayPanel() {
    const s = this.settings;
    for (const b of $$('.seg button[data-key]', this.panel)) { const on = String(s[b.dataset.key]) === b.dataset.v; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); }
    for (const b of $$('.theme-sw', this.panel)) b.classList.toggle('on', b.dataset.theme === s.theme);
    for (const b of $$('.font-opt', this.panel)) b.classList.toggle('on', b.dataset.font === s.font);
    const sv = $('.size-input', this.panel); if (sv && document.activeElement !== sv) sv.value = s.fontSize;
    const sr = $('.size-range', this.panel); if (sr) sr.value = s.fontSize;
    this.updateZoomLabel();
    // Some sections depend on values (custom colors, spreads): rebuild when they change.
    const sig = this.dispSignature();
    if (this.dispSig && this.dispSig !== sig) { const sc = this.panel.querySelector('.panel-body')?.scrollTop || 0; this.renderPanel(); const pb = this.panel.querySelector('.panel-body'); if (pb) pb.scrollTop = sc; }
    this.dispSig = sig;
  }
}

/** Match the phone status bar to the reading theme; null restores the app colors. */
export function setThemeColor(color) {
  for (const m of document.querySelectorAll('meta[name="theme-color"]')) {
    if (!m.dataset.orig) m.dataset.orig = m.content;
    m.content = color || m.dataset.orig;
  }
}

function toggle(label, value, onChange) {
  const id = 'tg-' + label.toLowerCase().replace(/[^a-z]+/g, '-');
  const input = h('input', { type: 'checkbox', id, role: 'switch', checked: !!value });
  input.addEventListener('change', () => onChange(input.checked));
  return h('label.toggle', { for: id }, h('span', label), input, h('span.switch', { 'aria-hidden': 'true' }));
}

export function showShortcuts() {
  const keys = [
    ['→  ·  Space  ·  Page Down', 'Next page'], ['←  ·  Shift+Space  ·  Page Up', 'Previous page'], ['Home / End', 'Start / end of book'],
    ['T', 'Contents'], ['/  or  Ctrl+F', 'Search in book'], ['H', 'Highlights & notes'], ['A', 'Display settings'], ['B', 'Bookmark page'], ['L', 'Highlighter on / off'], ['C', 'Save this page as an image'],
    ['R', 'Read aloud: play / pause'], ['F', 'Full screen'], ['V', 'PDF: Book view / original pages'], ['S', 'Background sounds'], ['M', 'Show / hide toolbar'], ['+  /  −', 'Text size (PDF: zoom)'], ['0', 'PDF: automatic zoom'], ['Esc', 'Close panel or popup'],
  ];
  dialog({ title: 'Keyboard shortcuts', body: h('dl.shortcuts', keys.map(([k, v]) => [h('dt', h('kbd', k)), h('dd', v)])), actions: [{ label: 'Close', value: true, primary: true }] });
}

// ---------------- speech ----------------
// Device voices via the Web Speech API: works offline, follows the text sentence by sentence,
// highlights the spoken word where the voice reports word boundaries, keeps the screen awake
// while playing, and can stop on a sleep timer.
export function listVoices() {
  try { return window.speechSynthesis ? window.speechSynthesis.getVoices() : []; } catch { return []; }
}
export function sortVoices(voices, lang) {
  lang = (lang || navigator.language || 'en').slice(0, 2).toLowerCase();
  const score = (v) => (v.lang?.toLowerCase().startsWith(lang) ? 4 : 0) + (/enhanced|premium|natural|neural|siri/i.test(v.name) ? 2 : 0) + (v.localService ? 1 : 0);
  return [...voices].sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name));
}

export const VOICE_STYLES = {
  natural: { label: 'Natural', note: 'The voice as it is', rate: 1, pitch: 1, gap: 0, para: 250 },
  narrator: { label: 'Narrator', note: 'Measured, a touch deeper, clear pauses', rate: 0.94, pitch: 0.9, gap: 260, para: 750 },
  storyteller: { label: 'Storyteller', note: 'Unhurried, lifts questions and exclamations', rate: 0.9, pitch: 1.04, gap: 360, para: 950, expressive: true },
  bedtime: { label: 'Bedtime', note: 'Slow and low, long pauses', rate: 0.8, pitch: 0.86, gap: 560, para: 1300 },
  brisk: { label: 'Brisk', note: 'Quick, for skimming', rate: 1.25, pitch: 1, gap: 0, para: 120 },
};

class Speaker {
  constructor(reader) {
    this.r = reader;
    this.synth = window.speechSynthesis;
    this.token = 0;
    this.voices = listVoices();
    const load = () => { this.voices = listVoices(); this.renderVoices?.(); };
    this.synth.addEventListener?.('voiceschanged', load);
    this.onVis = () => { if (!document.hidden && this.playing) this.lockScreen(); };
    document.addEventListener('visibilitychange', this.onVis);
  }
  get active() { return !!this.bar; }

  async start(loc) {
    this.synth.cancel();
    this.loc = loc;
    this.segs = await this.r.engine.sentencesFrom(loc);
    this.i = 0;
    this.fails = 0;
    if (!this.segs.length) { if (!(await this.advanceChunk())) { toast('There’s no text to read here.'); return; } }
    this.showBar();
    this.play();
  }

  async advanceChunk() {
    const e = this.r.engine;
    if (this.sleep?.mode === 'chapter') { this.stop(); toast('Sleep timer: stopped at the end of the chapter'); return false; }
    let next;
    if (this.r.isPdf) { const p = (this.segs?.[0]?.loc.page ?? this.loc.page) + 1; if (p >= e.n) return false; next = { page: p, y: 0 }; }
    else { const c = (this.segs?.[0]?.loc.ch ?? this.loc.ch) + 1; if (c >= e.book.chapters.length) return false; next = { ch: c, off: 0 }; }
    this.loc = next;
    this.segs = await e.sentencesFrom(next);
    this.i = 0;
    if (!this.segs.length) return this.advanceChunk();
    return true;
  }

  pickVoice() {
    const want = state.ui.ttsVoice;
    if (want) { const v = this.voices.find((x) => x.voiceURI === want); if (v) return v; }
    return sortVoices(this.voices, this.r.book.language)[0] || null;
  }

  play() {
    this.playing = true;
    ambient.duck(true);
    this.updateBar();
    this.lockScreen();
    this.speak();
  }
  async speak() {
    if (this.sleep?.until && Date.now() >= this.sleep.until) { this.pause(); this.setSleep('off'); toast('Sleep timer: reading paused'); return; }
    const seg = this.segs[this.i];
    if (!seg) {
      if (await this.advanceChunk()) return this.speak();
      if (this.bar) { this.stop(); toast('Finished reading aloud'); }
      return;
    }
    const tok = ++this.token;
    const style = VOICE_STYLES[state.ui.ttsStyle] || VOICE_STYLES.natural;
    const u = new SpeechSynthesisUtterance(seg.text);
    const tone = toneOf();
    let rate = (state.ui.ttsRate || 1) * style.rate * tone.rate, pitch = (state.ui.ttsPitch || 1) * style.pitch * tone.pitch;
    if (style.expressive) {
      if (/[?]["'”’»)]*$/.test(seg.text)) pitch *= 1.08;
      else if (/!["'”’»)]*$/.test(seg.text)) { pitch *= 1.06; rate *= 1.04; }
      if (/^["“‘«]/.test(seg.text)) rate *= 1.05;   // dialogue moves a little faster
    }
    u.rate = Math.min(3, Math.max(0.4, rate));
    u.pitch = Math.min(2, Math.max(0.5, pitch));
    const v = this.pickVoice();
    if (v) { u.voice = v; u.lang = v.lang; } else if (this.r.book.language) u.lang = this.r.book.language;
    u.onstart = () => { this.fails = 0; };
    u.onboundary = (e) => {
      if (tok !== this.token || e.name === 'sentence') return;
      const len = e.charLength || (seg.text.slice(e.charIndex).match(/^[\p{L}\p{N}'’-]+/u)?.[0].length ?? 0);
      if (len) this.r.engine.markWord?.(seg, e.charIndex, len);
    };
    u.onend = () => {
      if (tok !== this.token || !this.playing) return;
      this.i++;
      const wait = seg.para ? style.para : style.gap;
      if (wait) setTimeout(() => { if (tok === this.token && this.playing) this.speak(); }, wait); else this.speak();
    };
    u.onerror = (e) => {
      if (tok !== this.token) return;
      if (e.error === 'interrupted' || e.error === 'canceled') return;
      this.fails = (this.fails || 0) + 1;
      if (this.fails >= 2) { this.pause(); toast('Read aloud stopped: this device couldn’t speak the text. Try another voice.', { kind: 'error' }); return; }
      this.i++; if (this.playing) this.speak();
    };
    await this.r.engine.markSpeaking(seg);
    if (tok !== this.token) return;
    this.r.activity();
    this.synth.speak(u);
    if (this.synth.paused) this.synth.resume();
  }
  pause() { this.playing = false; this.token++; this.synth.cancel(); this.updateBar(); this.unlockScreen(); ambient.duck(false); }
  resume() { if (!this.active) return; this.playing = true; ambient.duck(true); this.updateBar(); this.lockScreen(); this.speak(); }
  restartSentence() { if (this.playing) { this.token++; this.synth.cancel(); this.speak(); } }
  skip(d) { this.token++; this.synth.cancel(); this.i = clamp(this.i + d, 0, Math.max(0, this.segs.length - 1)); if (this.playing) this.speak(); else this.r.engine.markSpeaking(this.segs[this.i]); }
  stop() {
    this.playing = false; this.token++; this.synth.cancel();
    this.r.engine?.markSpeaking(null);
    this.bar?.remove(); this.bar = null;
    this.setSleep('off', true);
    this.unlockScreen();
    ambient.duck(false);
    this.r.root.classList.remove('tts-on');
    $('.rd-tts', this.r.root)?.classList.remove('active');
  }
  destroy() { this.stop(); document.removeEventListener('visibilitychange', this.onVis); }

  // Keep the phone screen on while listening (where the browser supports it).
  async lockScreen() {
    try { if (navigator.wakeLock && !this.wake) { this.wake = await navigator.wakeLock.request('screen'); this.wake.addEventListener('release', () => { this.wake = null; }); } } catch { this.wake = null; }
  }
  unlockScreen() { try { this.wake?.release(); } catch {} this.wake = null; }

  setSleep(v, quiet) {
    clearInterval(this.sleepT);
    this.sleep = null;
    if (v === 'chapter') this.sleep = { mode: 'chapter' };
    else if (v !== 'off') {
      this.sleep = { mode: 'time', until: Date.now() + (+v) * 60e3 };
      // Pause on time even in the middle of a long sentence.
      this.sleepT = setInterval(() => { if (this.sleep?.until && Date.now() >= this.sleep.until) { this.pause(); this.setSleep('off'); toast('Sleep timer: reading paused'); } else this.updateSleepLabel(); }, 15000);
    }
    if (this.sleepSel) this.sleepSel.value = v;
    this.updateSleepLabel();
    if (!quiet && v !== 'off') toast(v === 'chapter' ? 'Reading will stop at the end of this chapter' : `Reading will stop in ${v} minutes`);
  }
  updateSleepLabel() {
    if (!this.sleepSel) return;
    for (const o of this.sleepSel.options) o.textContent = o.dataset.label;
    const sel = this.sleepSel.options[this.sleepSel.selectedIndex];
    if (this.sleep?.until && sel) sel.textContent = `Stops in ${Math.max(1, Math.ceil((this.sleep.until - Date.now()) / 60e3))} min`;
  }

  showBar() {
    if (this.bar) return;
    const rate = h('select.tts-rate', { 'aria-label': 'Speed' }, [0.75, 0.9, 1, 1.15, 1.3, 1.5, 1.75, 2].map((r) => h('option', { value: r, selected: (state.ui.ttsRate || 1) === r }, `${r}×`)));
    rate.addEventListener('change', () => { saveUI({ ttsRate: +rate.value }); this.restartSentence(); });
    const voice = h('button.tts-voice', { type: 'button', 'aria-label': 'Choose voice', onclick: () => openVoicePicker({ voices: this.voices, lang: this.r.book.language, onChange: () => { this.renderVoices(); this.restartSentence(); } }) });
    this.renderVoices = () => {
      const v = this.voices.find((x) => x.voiceURI === state.ui.ttsVoice);
      voice.textContent = v ? v.name.replace(/^(Microsoft|Google)\s+/i, '') : 'Voice…';
    };
    this.renderVoices();
    const sleepOpts = [['off', 'Timer'], ['10', '10 min'], ['20', '20 min'], ['30', '30 min'], ['45', '45 min'], ['60', '1 hour'], ['chapter', 'End of chapter']];
    this.sleepSel = h('select.tts-sleep', { 'aria-label': 'Sleep timer' }, sleepOpts.map(([v, l]) => h('option', { value: v, dataset: { label: l } }, l)));
    this.sleepSel.addEventListener('change', () => this.setSleep(this.sleepSel.value));
    const styleSel = h('select.tts-style', { 'aria-label': 'Reading style' }, Object.entries(VOICE_STYLES).map(([k, v]) => h('option', { value: k, selected: (state.ui.ttsStyle || 'natural') === k }, v.label)));
    styleSel.addEventListener('change', () => { saveUI({ ttsStyle: styleSel.value }); this.restartSentence(); });
    this.playBtn = iconBtn('pause', 'Pause', () => (this.playing ? this.pause() : this.resume()), { class: 'tts-play' });
    this.bar = h('div.tts-bar', { role: 'region', 'aria-label': 'Read aloud' },
      iconBtn('chevronL', 'Previous sentence', () => this.skip(-1), { class: 'mini-btn' }),
      this.playBtn,
      iconBtn('chevronR', 'Next sentence', () => this.skip(1), { class: 'mini-btn' }),
      h('div.tts-opts', styleSel, voice, rate, this.sleepSel),
      iconBtn('close', 'Stop reading aloud', () => this.stop(), { class: 'mini-btn' }));
    this.r.root.append(this.bar);
    this.r.root.classList.add('tts-on');
    $('.rd-tts', this.r.root)?.classList.add('active');
    this.r.showChrome(true);
  }
  updateBar() {
    if (!this.playBtn) return;
    this.playBtn.replaceChildren(icon(this.playing ? 'pause' : 'play', 22));
    this.playBtn.setAttribute('aria-label', this.playing ? 'Pause' : 'Play');
  }
}

export { esc };
