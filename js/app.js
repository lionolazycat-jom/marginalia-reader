// App shell: navigation, library and all non-reading views.

import { h, $, $$, icon, iconBtn, toast, dialog, confirmDialog, menu, fmtRelative, fmtPct, fmtDuration, fmtBytes, hashHue, debounce, dayKey, capability, capabilityNow, saveFile, esc } from './util.js';
import { db, persistent, storageEstimate, requestPersistence } from './db.js';
import { state, on, loadAll, importFile, updateBook, removeBook, coverUrl, bookById, createCollection, renameCollection, deleteCollection, setBookCollections, updateAnnotation, deleteAnnotation, restoreAnnotation, updateBookmark, deleteBookmark, addBookmark, saveNote, deleteNote, saveUI, streak, todaySeconds, exportBackup, importBackup, clearEverything, searchContent, queueIndex } from './store.js';
import { ACCEPT, FORMAT_LABEL } from './formats.js';
import { HL_COLORS, ACCENTS } from './settings.js';
import { openReader, activeReader, showShortcuts, listVoices, sortVoices, VOICE_STYLES } from './reader.js';
import { installState, promptInstall, onInstallChange, initPwa } from './pwa.js';
import { exportAnnotationList, report, safeName } from './exporter.js';
import { WELCOME_MD } from './welcome.js';
import { SHELVES, LANGUAGES, CATEGORIES, categorize, categoryLabel, search as searchFree, downloadBook, gutenbergPage } from './freebooks.js';

const NAV = [
  ['home', 'Home', 'home'],
  ['library', 'Library', 'library'],
  ['free', 'Free books', 'gift'],
  ['collections', 'Collections', 'collection'],
  ['bookmarks', 'Bookmarks', 'bookmark'],
  ['highlights', 'Highlights', 'highlight'],
  ['notes', 'Notes', 'note'],
  ['stats', 'Statistics', 'stats'],
  ['preferences', 'Preferences', 'settings'],
];
const VIEWS = {};
let view = 'home';
let viewArg = null;
const lib = { q: '', status: 'all', format: 'all', collection: 'all', category: 'all', content: false };

// ---------------- boot ----------------
export async function boot() {
  initPwa();
  await loadAll();
  applyAppTheme();
  buildShell();
  bindDrop();
  on('change', debounce(() => { if (!document.body.classList.contains('is-reading') || true) rerender(); }, 60));
  on('annotations', debounce(() => { if (['highlights', 'notes', 'home'].includes(view)) rerender(); }, 80));
  on('bookmarks', debounce(() => { if (view === 'bookmarks') rerender(); }, 80));
  on('notes', debounce(() => { if (view === 'notes' && !notesEditing) rerender(); }, 80));
  on('ui', () => applyAppTheme());
  on('reader-closed', () => { if (location.hash.startsWith('#book-')) history.replaceState(null, '', '#' + (lastView || 'home')); rerender(); });
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', applyAppTheme);
  if (!persistent) toast('Storage is unavailable in this browser view, so your library won’t be saved after you close the page.', { kind: 'error', ms: 9000 });
  if (!(await db.kvGet('seeded')) && !state.books.length) {
    await db.kvSet('seeded', true);
    try { await importFile(new File([WELCOME_MD], 'The Marginalia Field Guide.md', { type: 'text/markdown' })); } catch (e) { console.warn(e); }
  }
  window.addEventListener('hashchange', route);
  route();
  capability('sample').then((v) => { if (v && view === 'preferences') rerender(); });
  capability('downloads');
  // Warm up PDF.js in the background so PDFs open instantly (and work offline later).
  setTimeout(() => import('./pdfcore.js').then((m) => m.getPdfjs()).catch(() => {}), 1200);
  for (const b of state.books) if (!b.indexed && !b.locked && !b.missingFile) queueIndex(b.id);
}

let lastView = 'home';
function route() {
  const raw = location.hash.slice(1);
  if (raw.startsWith('book-')) {
    const b = bookById(raw.slice(5));
    if (b && !activeReader()) openReader(b);
    else if (!b) history.replaceState(null, '', '#library');
    return;
  }
  if (activeReader()) activeReader().close();
  let v = raw || 'home', arg = null;
  if (v.startsWith('collection-')) { arg = v.slice(11); v = 'collection'; }
  if (!VIEWS[v]) v = 'home';
  view = v; viewArg = arg; lastView = raw || 'home';
  rerender();
}
export function go(hash) { if (location.hash === '#' + hash) route(); else location.hash = hash; }

export function openBook(book, opts) {
  if (book.missingFile) { toast('This book’s file isn’t on this device. Add the same file again to reattach it.', { kind: 'error' }); return; }
  history.pushState(null, '', '#book-' + book.id);
  openReader(book, opts);
}

function applyAppTheme() {
  const ui = state.ui;
  const dark = ui.appTheme === 'dark' || (ui.appTheme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  const a = ACCENTS[ui.accent];
  const accent = ui.accent === 'custom' && ui.customAccent ? ui.customAccent : a ? (dark ? a.dark : a.light) : null;
  if (accent) document.documentElement.style.setProperty('--accent', accent); else document.documentElement.style.removeProperty('--accent');
}

function buildShell() {
  const side = $('#sidebar');
  side.textContent = '';
  side.append(
    h('div.brand', h('span.brand-mark', { 'aria-hidden': 'true' }), h('span.brand-name', 'Marginalia')),
    h('button.btn.btn-primary.btn-import', { type: 'button', onclick: pickFiles }, icon('plus', 18), 'Add books'),
    h('nav.nav', { 'aria-label': 'Sections' }, NAV.map(([k, label, ic]) => h('a.nav-item', { href: '#' + k, dataset: { view: k } }, icon(ic, 19), h('span', label), h('span.nav-count', { dataset: { count: k } })))),
    h('div.side-foot', h('span.lock', icon('check', 14)), h('span', 'Books stay on this device')),
  );
  const drawInstall = () => {
    $('.side-install')?.remove();
    const st = installState();
    if (st.installed || !(st.canPrompt || st.ios)) return;
    side.insertBefore(h('button.side-install', { type: 'button', onclick: async () => { if (st.canPrompt) { await promptInstall(); drawInstall(); } else go('preferences'); } }, icon('download', 16), 'Install app'), side.querySelector('.side-foot'));
  };
  drawInstall();
  onInstallChange(() => { drawInstall(); if (view === 'preferences') rerender(); });
  const tab = $('#tabbar');
  tab.textContent = '';
  const tabs = [['home', 'Home', 'home'], ['library', 'Library', 'library'], ['free', 'Free books', 'gift'], ['highlights', 'Highlights', 'highlight']];
  tab.append(...tabs.map(([k, l, ic]) => h('a.tab', { href: '#' + k, dataset: { view: k } }, icon(ic, 22), h('span', l))),
    h('button.tab.tab-more', { type: 'button', onclick: (e) => menu(e.currentTarget, [['notes', 'Notes', 'note'], ['collections', 'Collections', 'collection'], ['bookmarks', 'Bookmarks', 'bookmark'], ['stats', 'Statistics', 'stats'], ['preferences', 'Preferences', 'settings']].map(([k, l, ic]) => ({ label: l, icon: ic, run: () => go(k) }))) }, icon('menu', 22), h('span', 'More')));
  // Phones mislabel book files (an .epub often shows as "unknown"), so a type filter there
  // greys files out or hides the Files/folder option. Only desktops get the filter.
  const touch = matchMedia('(pointer: coarse)').matches || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  if (!touch) $('#file-input').accept = ACCEPT;
  $('#file-input').addEventListener('change', (e) => { const f = [...e.target.files]; e.target.value = ''; importFiles(f); });
}

function rerender() {
  if (document.body.classList.contains('is-reading')) return;
  const main = $('#main');
  const scroll = main.scrollTop;
  const same = main.dataset.view === view + (viewArg || '');
  main.dataset.view = view + (viewArg || '');
  for (const a of $$('[data-view]')) a.classList.toggle('active', a.dataset.view === view || (view === 'collection' && a.dataset.view === 'collections'));
  // On phones, sections reached from "More" light up the More tab.
  const inTabs = ['home', 'library', 'free', 'highlights'].includes(view);
  $('#tabbar .tab-more')?.classList.toggle('active', !inTabs);
  for (const a of $$('[data-view]')) a.setAttribute('aria-current', a.classList.contains('active') ? 'page' : 'false');
  const counts = { library: state.books.length, highlights: state.annotations.length, bookmarks: state.bookmarks.length, collections: state.collections.length, notes: state.notes.length };
  for (const el of $$('[data-count]')) el.textContent = counts[el.dataset.count] || '';
  const focused = document.activeElement?.id;
  const selStart = document.activeElement?.selectionStart;
  main.textContent = '';
  const page = h('div.page', { class: `page page-${view}` });
  main.append(page);
  VIEWS[view](page);
  if (same) main.scrollTop = scroll; else main.scrollTop = 0;
  if (focused) { const el = document.getElementById(focused); if (el) { el.focus(); try { el.setSelectionRange(selStart, selStart); } catch {} } }
}

// ---------------- import ----------------
function pickFiles() { $('#file-input').click(); }

async function importFiles(files) {
  if (!files.length) return;
  const backups = files.filter((f) => /\.json$/i.test(f.name));
  if (backups.length) { for (const f of backups) await restoreFrom(f); files = files.filter((f) => !backups.includes(f)); if (!files.length) return; }
  const busy = h('div.import-progress', { role: 'status' }, h('div.spinner.small'), h('span', `Adding ${files.length} book${files.length > 1 ? 's' : ''}…`));
  document.body.append(busy);
  const ok = [], fails = [];
  let dup = 0;
  for (const [i, f] of files.entries()) {
    busy.lastChild.textContent = files.length > 1 ? `Adding ${i + 1} of ${files.length}: ${f.name}` : `Adding ${f.name}…`;
    try {
      const r = await importFile(f);
      if (r.duplicate) dup++; else ok.push(r);
    } catch (e) { fails.push([f.name, e.message || 'Unknown error']); }
  }
  busy.remove();
  if (ok.length === 1 && !fails.length) {
    const b = ok[0].book;
    toast(ok[0].reattached ? `Reattached “${b.title}”` : b.locked ? `Added “${b.title}”. It’s password-protected; you’ll be asked for the password when you open it.` : `Added “${b.title}”`, { action: { label: 'Open', run: () => openBook(b) } });
  } else if (ok.length) toast(`Added ${ok.length} book${ok.length > 1 ? 's' : ''}${dup ? `; ${dup} already in your library` : ''}`);
  else if (dup && !fails.length) toast(dup === 1 ? 'That book is already in your library.' : `All ${dup} books are already in your library.`);
  if (fails.length) {
    dialog({
      title: fails.length === 1 ? 'A file couldn’t be added' : `${fails.length} files couldn’t be added`,
      body: h('ul.fail-list', fails.map(([n, m]) => h('li', h('strong', n), h('span', m)))),
      actions: [{ label: 'OK', value: true, primary: true }],
    });
  }
}

function bindDrop() {
  const over = $('#drop');
  let depth = 0;
  window.addEventListener('dragenter', (e) => { if (![...(e.dataTransfer?.types || [])].includes('Files')) return; depth++; over.hidden = false; });
  window.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) over.hidden = true; });
  window.addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) e.preventDefault(); });
  window.addEventListener('drop', (e) => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault(); depth = 0; over.hidden = true;
    importFiles([...e.dataTransfer.files]);
  });
}

// ---------------- shared pieces ----------------
function coverEl(book, cls = '') {
  const hue = hashHue(book.title + book.author);
  const el = h('div', { class: `cover ${cls} fmt-${book.format}`, style: { '--hue': hue }, 'aria-hidden': 'true' },
    h('div.cover-gen', h('span.cover-title', book.title), book.author ? h('span.cover-author', book.author) : null, h('span.cover-fmt', FORMAT_LABEL[book.format] || '')));
  if (book.hasCover) coverUrl(book).then((url) => { if (url) { const img = h('img', { src: url, alt: '', loading: 'lazy', decoding: 'async' }); img.onload = () => el.classList.add('has-img'); el.append(img); } });
  return el;
}

function progressBar(p) {
  return h('div.pbar', { role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round((p || 0) * 100), 'aria-label': 'Reading progress' }, h('span', { style: { width: Math.max(0, Math.min(100, (p || 0) * 100)) + '%' } }));
}

function statusOf(b) {
  if (b.finishedAt) return 'finished';
  if (b.progress > 0.005 || b.lastOpenedAt) return 'reading';
  return 'new';
}

function bookMenu(anchor, b) {
  menu(anchor, [
    { label: 'Open', icon: 'book', run: () => openBook(b) },
    { label: 'Edit details & categories', icon: 'edit', run: () => editBook(b) },
    { label: 'Collections…', icon: 'collection', run: () => pickCollections(b) },
    { label: b.finishedAt ? 'Mark as unread' : 'Mark as finished', icon: 'check', run: () => updateBook(b, b.finishedAt ? { finishedAt: null } : { finishedAt: Date.now(), progress: Math.max(b.progress, 1) }) },
    { label: 'Reset reading progress', icon: 'back', run: () => updateBook(b, { progress: 0, location: null, pageLabel: '', finishedAt: null }) },
    'sep',
    { label: 'Remove from library', icon: 'trash', danger: true, run: () => confirmRemove(b) },
  ]);
}

async function editBook(b) {
  const sel = new Set(b.categories || []);
  const box = h('fieldset.cat-pick', h('legend', 'Categories'), CATEGORIES.map((c) => {
    const id = 'cat-' + c.key;
    const cb = h('input', { type: 'checkbox', id, checked: sel.has(c.key) });
    cb.addEventListener('change', () => (cb.checked ? sel.add(c.key) : sel.delete(c.key)));
    return h('label.chip.check-chip', { for: id }, cb, h('span', c.label));
  }));
  const r = await dialog({ title: 'Edit details', body: box, fields: [{ name: 'title', label: 'Title', value: b.title }, { name: 'author', label: 'Author', value: b.author }], actions: [{ label: 'Cancel', value: false }, { label: 'Save', value: true, primary: true }] });
  if (r?.action) { await updateBook(b, { title: r.values.title.trim() || b.title, author: r.values.author.trim(), categories: [...sel] }); toast('Details saved'); }
}

async function confirmRemove(b) {
  const n = state.annotations.filter((a) => a.bookId === b.id).length;
  const ok = await confirmDialog(`Remove “${b.title}”?`, `The book${n ? `, its ${n} highlight${n > 1 ? 's' : ''}` : ''} and its bookmarks will be deleted from this device. This can’t be undone.`, 'Remove book');
  if (ok) { await removeBook(b.id); toast('Book removed'); }
}

async function pickCollections(b) {
  const box = h('div.check-list');
  const sel = new Set(b.collections || []);
  const draw = () => {
    box.textContent = '';
    if (!state.collections.length) box.append(h('p.hint', 'No collections yet. Create one below.'));
    for (const c of state.collections) {
      const id = 'cc-' + c.id;
      const cb = h('input', { type: 'checkbox', id, checked: sel.has(c.id) });
      cb.addEventListener('change', () => (cb.checked ? sel.add(c.id) : sel.delete(c.id)));
      box.append(h('label.check', { for: id }, cb, h('span', c.name)));
    }
  };
  draw();
  const nameIn = h('input', { type: 'text', id: 'new-coll', placeholder: 'New collection name' });
  const add = h('button.btn.btn-small', { type: 'button', onclick: async () => { const n = nameIn.value.trim(); if (!n) return; const c = await createCollection(n); sel.add(c.id); nameIn.value = ''; draw(); } }, 'Create');
  nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add.click(); } });
  const r = await dialog({ title: `Collections for “${b.title}”`, body: h('div', box, h('div.inline-add', nameIn, add)), actions: [{ label: 'Cancel', value: false }, { label: 'Save', value: true, primary: true }] });
  if (r) { await setBookCollections(b, [...sel]); toast('Collections updated'); }
}

function emptyState(title, text, action) {
  return h('div.empty', h('div.empty-art', { 'aria-hidden': 'true' }), h('h2', title), h('p', text), action || null);
}

function pageHead(title, sub, ...actions) {
  return h('header.page-head', h('div', h('h1', title), sub ? h('p.page-sub', sub) : null), actions.length ? h('div.head-actions', ...actions) : null);
}

// ---------------- HOME ----------------
VIEWS.home = (page) => {
  const now = new Date();
  const reading = state.books.filter((b) => b.lastOpenedAt).sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
  const added = [...state.books].sort((a, b) => b.addedAt - a.addedAt);
  const hero = reading[0] || added[0];
  const eyebrow = now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  page.append(h('header.page-head.home-head', h('div', h('p.eyebrow', eyebrow), h('h1', greeting()))));
  const inst = installState();
  if (!inst.installed && (inst.canPrompt || inst.ios) && !state.ui.installHintDismissed) {
    page.append(h('section.install-banner', { role: 'note' },
      h('img', { src: 'icons/icon-192.png', alt: '', width: 44, height: 44 }),
      h('div', h('strong', 'Put Marginalia on your home screen'), h('p', inst.canPrompt ? 'It opens full screen and works offline, like any app.' : 'In Safari, tap Share, then “Add to Home Screen”. It opens full screen and works offline.')),
      inst.canPrompt ? h('button.btn.btn-primary.btn-small', { type: 'button', onclick: async () => { await promptInstall(); rerender(); } }, 'Install') : null,
      iconBtn('close', 'Dismiss', () => saveUI({ installHintDismissed: true }).then(rerender), { class: 'mini-btn' })));
  }
  if (!state.books.length) {
    page.append(dropzone());
    return;
  }
  const grid = h('div.home-grid');
  if (hero) {
    const last = state.annotations.filter((a) => a.bookId === hero.id).sort((a, b) => b.createdAt - a.createdAt)[0];
    const resume = h('button.btn.btn-primary.btn-lg', { type: 'button', onclick: () => openBook(hero) }, hero.lastOpenedAt ? 'Continue reading' : 'Start reading');
    grid.append(h('section.hero-card', { 'aria-label': 'Continue reading' },
      h('button.hero-cover', { type: 'button', onclick: () => openBook(hero), 'aria-label': `Open ${hero.title}` }, coverEl(hero, 'xl')),
      h('div.hero-body',
        h('p.eyebrow', hero.lastOpenedAt ? `Last read ${fmtRelative(hero.lastOpenedAt).toLowerCase()}` : 'Newest in your library'),
        h('h2.hero-title', hero.title),
        hero.author ? h('p.hero-author', hero.author) : null,
        hero.chapterTitle ? h('p.hero-chapter', hero.chapterTitle) : null,
        h('div.hero-progress', progressBar(hero.progress), h('span.num', `${fmtPct(hero.progress)}${hero.pageLabel ? ' · ' + hero.pageLabel : ''}`)),
        last ? h('blockquote.hero-quote', { class: `hero-quote c-${last.color}` }, h('p', last.text.length > 220 ? last.text.slice(0, 220) + '…' : last.text), h('cite', last.note ? `Your note: ${last.note.slice(0, 90)}` : 'Your latest highlight')) : null,
        h('div.row', resume, hero.readingSeconds ? h('span.muted', `${fmtDuration(hero.readingSeconds)} read so far`) : null))));
  }
  grid.append(todayCard());
  page.append(grid);
  const rest = reading.filter((b) => b !== hero).slice(0, 10);
  if (rest.length) page.append(shelf('Recently read', rest, () => go('library')));
  const fresh = added.filter((b) => b !== hero && !b.lastOpenedAt).slice(0, 10);
  if (fresh.length) page.append(shelf('Recently added', fresh, () => go('library')));
};

function greeting() {
  const hr = new Date().getHours();
  return hr < 5 ? 'Reading late' : hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening';
}

function todayCard() {
  const goal = state.ui.goalMinutes || 20;
  const mins = Math.floor(todaySeconds() / 60);
  const pct = Math.min(1, mins / goal);
  const r = 38, c = 2 * Math.PI * r;
  const ring = `<svg viewBox="0 0 96 96" width="96" height="96" aria-hidden="true"><circle cx="48" cy="48" r="${r}" class="ring-bg"/><circle cx="48" cy="48" r="${r}" class="ring-fg" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - pct)}" transform="rotate(-90 48 48)"/></svg>`;
  const week = lastNDays(7);
  const max = Math.max(goal * 60, ...week.map((d) => d.seconds));
  const s = streak();
  return h('section.today-card', { 'aria-label': 'Today’s reading' },
    h('div.today-top', h('div.ring', { html: ring }, h('div.ring-label', h('strong.num', String(mins)), h('span', `of ${goal} min`))),
      h('div', h('h2', mins >= goal ? 'Goal reached today' : 'Today'), h('p.muted', mins >= goal ? 'Anything more is a bonus.' : `${goal - mins} min to reach your daily goal`), h('p.streak', icon('target', 16), s ? `${s}-day streak` : 'Start a streak today'))),
    h('div.week', week.map((d) => h('div.week-day', { title: `${d.label}: ${fmtDuration(d.seconds)}` }, h('div.week-bar', h('span', { style: { height: Math.max(3, (d.seconds / max) * 100) + '%' }, class: d.seconds >= goal * 60 ? 'met' : '' })), h('span.week-lbl', d.short)))),
    h('a.link', { href: '#stats' }, 'Reading statistics'));
}

function lastNDays(n) {
  const out = [];
  const map = new Map(state.days.map((d) => [d.date, d]));
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const k = dayKey(d);
    out.push({ key: k, date: d, seconds: map.get(k)?.seconds || 0, books: map.get(k)?.books || {}, short: d.toLocaleDateString(undefined, { weekday: 'narrow' }), label: d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' }) });
  }
  return out;
}

function shelf(title, books, more) {
  return h('section.shelf', h('div.shelf-head', h('h2', title), more ? h('button.link', { type: 'button', onclick: more }, 'See all') : null),
    h('div.shelf-row', books.map((b) => h('button.shelf-book', { type: 'button', onclick: () => openBook(b), title: b.title }, coverEl(b), h('span.shelf-title', b.title), h('span.shelf-meta', b.lastOpenedAt ? fmtPct(b.progress) : FORMAT_LABEL[b.format])))));
}

function dropzone() {
  return h('section.dropzone', { onclick: pickFiles, role: 'button', tabindex: '0', onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickFiles(); } } },
    icon('upload', 32),
    h('h2', 'Add your first books'),
    h('p', 'Drop files here or choose them from your device. PDF, EPUB, TXT, Markdown, HTML, FB2 and CBZ.'),
    h('p.muted', 'Books are stored only in this browser. Nothing is uploaded.'));
}

// ---------------- LIBRARY ----------------
VIEWS.library = (page) => renderLibrary(page, null);
VIEWS.collection = (page) => {
  const c = state.collections.find((x) => x.id === viewArg);
  if (!c) { go('collections'); return; }
  renderLibrary(page, c);
};

function renderLibrary(page, coll) {
  const ui = state.ui;
  const total = coll ? state.books.filter((b) => b.collections?.includes(coll.id)).length : state.books.length;
  const actions = coll
    ? [iconBtn('edit', 'Rename collection', async () => { const r = await dialog({ title: 'Rename collection', fields: [{ name: 'name', label: 'Name', value: coll.name }], actions: [{ label: 'Cancel', value: false }, { label: 'Save', value: true, primary: true }] }); if (r?.action && r.values.name.trim()) renameCollection(coll, r.values.name); }, { class: 'btn-icon' }),
      h('button.btn', { type: 'button', onclick: () => addBooksToCollection(coll) }, icon('plus', 16), 'Add books'),
      iconBtn('trash', 'Delete collection', async () => { if (await confirmDialog(`Delete “${coll.name}”?`, 'The books stay in your library; only the collection is deleted.', 'Delete collection')) { await deleteCollection(coll.id); go('collections'); } }, { class: 'btn-icon' })]
    : [h('button.btn.btn-primary', { type: 'button', onclick: pickFiles }, icon('plus', 16), 'Add books')];
  page.append(pageHead(coll ? coll.name : 'Library', `${total} book${total === 1 ? '' : 's'}${coll ? ' in this collection' : ''}`, ...actions));
  if (coll) page.prepend(h('a.crumb', { href: '#collections' }, icon('back', 16), 'Collections'));
  if (!state.books.length) { page.append(dropzone()); return; }

  const search = h('input#lib-search.search-input', { type: 'search', placeholder: lib.content ? 'Search inside every book' : 'Search titles and authors', value: lib.q, 'aria-label': 'Search library' });
  search.addEventListener('input', debounce(() => { lib.q = search.value; rerender(); }, lib.content ? 450 : 150));
  const contentToggle = h('label.toggle.compact', { for: 'lib-content' }, h('span', 'Inside books'), h('input#lib-content', { type: 'checkbox', role: 'switch', checked: lib.content, onchange: (e) => { lib.content = e.target.checked; rerender(); } }), h('span.switch', { 'aria-hidden': 'true' }));
  const sort = h('select#lib-sort', { 'aria-label': 'Sort by' }, [['opened', 'Recently opened'], ['added', 'Recently added'], ['title', 'Title'], ['author', 'Author'], ['progress', 'Progress']].map(([v, l]) => h('option', { value: v, selected: ui.librarySort === v }, l)));
  sort.addEventListener('change', () => saveUI({ librarySort: sort.value }).then(rerender));
  const viewSeg = h('div.seg.icon-seg', { role: 'group', 'aria-label': 'View' },
    h('button', { type: 'button', class: ui.libraryView === 'grid' ? 'on' : '', 'aria-pressed': ui.libraryView === 'grid' ? 'true' : 'false', 'aria-label': 'Grid view', title: 'Grid view', onclick: () => saveUI({ libraryView: 'grid' }).then(rerender) }, icon('grid', 18)),
    h('button', { type: 'button', class: ui.libraryView === 'list' ? 'on' : '', 'aria-pressed': ui.libraryView === 'list' ? 'true' : 'false', 'aria-label': 'List view', title: 'List view', onclick: () => saveUI({ libraryView: 'list' }).then(rerender) }, icon('list', 18)));
  page.append(h('div.lib-tools', h('div.search-wrap', icon('search', 18), search), contentToggle, h('div.lib-tools-right', sort, viewSeg)));

  const formats = [...new Set(state.books.map((b) => b.format))];
  const chip = (group, value, label, count) => h('button', { type: 'button', class: `chip ${lib[group] === value ? 'on' : ''}`, 'aria-pressed': lib[group] === value ? 'true' : 'false', onclick: () => { lib[group] = lib[group] === value && value !== 'all' ? 'all' : value; rerender(); } }, label, count != null ? h('span.chip-n', String(count)) : null);
  const scope = coll ? state.books.filter((b) => b.collections?.includes(coll.id)) : state.books;
  const cnt = (fn) => scope.filter(fn).length;
  const chips = h('div.chips.lib-chips',
    chip('status', 'all', 'All', scope.length), chip('status', 'reading', 'Reading', cnt((b) => statusOf(b) === 'reading')), chip('status', 'new', 'Not started', cnt((b) => statusOf(b) === 'new')), chip('status', 'finished', 'Finished', cnt((b) => statusOf(b) === 'finished')),
    formats.length > 1 ? h('span.chip-sep') : null,
    formats.length > 1 ? formats.map((f) => chip('format', f, FORMAT_LABEL[f], cnt((b) => b.format === f))) : null,
    !coll && state.collections.length ? h('span.chip-sep') : null,
    !coll && state.collections.length ? h('select.chip-select', { 'aria-label': 'Collection', onchange: (e) => { lib.collection = e.target.value; rerender(); } }, h('option', { value: 'all' }, 'All collections'), state.collections.map((c) => h('option', { value: c.id, selected: lib.collection === c.id }, c.name))) : null);
  page.append(chips);
  const usedCats = CATEGORIES.filter((c) => scope.some((b) => b.categories?.includes(c.key)));
  if (usedCats.length) {
    page.append(h('div.chips.lib-chips.cat-chips', { role: 'group', 'aria-label': 'Categories' },
      h('button', { type: 'button', class: `chip ${lib.category === 'all' ? 'on' : ''}`, onclick: () => { lib.category = 'all'; rerender(); } }, 'All categories'),
      usedCats.map((c) => h('button', { type: 'button', class: `chip ${lib.category === c.key ? 'on' : ''}`, 'aria-pressed': lib.category === c.key ? 'true' : 'false', onclick: () => { lib.category = lib.category === c.key ? 'all' : c.key; rerender(); } }, c.label, h('span.chip-n', String(scope.filter((b) => b.categories?.includes(c.key)).length))))));
  }

  let books = scope.filter((b) => (lib.status === 'all' || statusOf(b) === lib.status) && (lib.format === 'all' || b.format === lib.format) && (lib.category === 'all' || b.categories?.includes(lib.category)) && (coll || lib.collection === 'all' || b.collections?.includes(lib.collection)));
  const q = lib.q.trim().toLowerCase();
  if (lib.content && q.length >= 2) {
    const box = h('div.content-results', h('p.muted', 'Searching inside your books…'));
    page.append(box);
    const allowed = new Set(books.map((b) => b.id));
    searchContent(q).then((res) => {
      res = res.filter((r) => allowed.has(r.book.id));
      box.textContent = '';
      const pending = state.books.filter((b) => !b.indexed && !b.locked && b.format !== 'cbz').length;
      if (pending) box.append(h('p.hint', `Still preparing ${pending} book${pending > 1 ? 's' : ''} for search. Results will grow as this finishes.`));
      if (!res.length) { box.append(h('p.empty-note', `No books contain “${lib.q.trim()}”.`)); return; }
      for (const r of res) {
        box.append(h('article.content-hit', h('button.content-cover', { type: 'button', onclick: () => openBook(r.book) }, coverEl(r.book, 'sm')),
          h('div', h('h3', h('button.link-strong', { type: 'button', onclick: () => openBook(r.book) }, r.book.title)), h('p.muted', `${r.count} match${r.count > 1 ? 'es' : ''}${r.book.author ? ' · ' + r.book.author : ''}`),
            r.hits.map((x) => h('button.snippet', { type: 'button', onclick: () => openBook(r.book, { searchQuery: q, fraction: x.frac }) }, x.before, h('mark', x.match), x.after)))));
      }
    });
    return;
  }
  if (q) books = books.filter((b) => (b.title + ' ' + b.author + ' ' + (b.fileName || '')).toLowerCase().includes(q));
  const coll8 = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  const sorters = {
    opened: (a, b) => (b.lastOpenedAt || 0) - (a.lastOpenedAt || 0) || b.addedAt - a.addedAt,
    added: (a, b) => b.addedAt - a.addedAt,
    title: (a, b) => coll8.compare(a.title.replace(/^(the|a|an)\s+/i, ''), b.title.replace(/^(the|a|an)\s+/i, '')),
    author: (a, b) => coll8.compare(lastName(a.author) || '￿', lastName(b.author) || '￿') || coll8.compare(a.title, b.title),
    progress: (a, b) => (b.progress || 0) - (a.progress || 0),
  };
  books.sort(sorters[ui.librarySort] || sorters.opened);
  if (!books.length) { page.append(h('p.empty-note', coll && !scope.length ? 'This collection is empty. Use “Add books” to fill it.' : 'No books match these filters.')); return; }
  if (ui.libraryView === 'list') page.append(listView(books));
  else page.append(h('div.book-grid', books.map(bookCard)));
}

const lastName = (a) => (a || '').split(/[,&]| and /)[0].trim().split(/\s+/).pop() || '';

function bookCard(b) {
  const st = statusOf(b);
  return h('article.book-card', { dataset: { id: b.id } },
    h('button.card-open', { type: 'button', onclick: () => openBook(b), 'aria-label': `Open ${b.title}` }, coverEl(b),
      st === 'finished' ? h('span.badge', 'Finished') : b.locked ? h('span.badge', 'Locked') : b.missingFile ? h('span.badge.warn', 'File missing') : null),
    h('div.card-body',
      h('div.card-text', h('h3.card-title', { title: b.title }, b.title), h('p.card-author', b.author || FORMAT_LABEL[b.format])),
      iconBtn('more', `Options for ${b.title}`, (e) => bookMenu(e.currentTarget, b), { class: 'mini-btn' })),
    h('div.card-foot', progressBar(b.progress), h('span.num', st === 'new' ? 'New' : fmtPct(b.progress)), h('span.card-when', fmtRelative(b.lastOpenedAt))));
}

function listView(books) {
  return h('div.book-list', { role: 'table', 'aria-label': 'Books' },
    h('div.list-row.list-head', { role: 'row' }, ['', 'Title', 'Format', 'Progress', 'Last opened', 'Added', ''].map((t) => h('span', { role: 'columnheader' }, t))),
    books.map((b) => h('div.list-row', { role: 'row', dataset: { id: b.id } },
      h('button.list-cover', { type: 'button', onclick: () => openBook(b), 'aria-label': `Open ${b.title}` }, coverEl(b, 'xs')),
      h('button.list-title', { type: 'button', onclick: () => openBook(b) }, h('strong', b.title), h('span', b.author || '—')),
      h('span.list-fmt', FORMAT_LABEL[b.format], h('small', fmtBytes(b.size))),
      h('span.list-prog', progressBar(b.progress), h('span.num', fmtPct(b.progress))),
      h('span.list-date', fmtRelative(b.lastOpenedAt)),
      h('span.list-date', new Date(b.addedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })),
      iconBtn('more', `Options for ${b.title}`, (e) => bookMenu(e.currentTarget, b), { class: 'mini-btn' }))));
}

async function addBooksToCollection(c) {
  const box = h('div.check-list.tall');
  const sel = new Set(state.books.filter((b) => b.collections?.includes(c.id)).map((b) => b.id));
  for (const b of [...state.books].sort((a, b2) => a.title.localeCompare(b2.title))) {
    const id = 'ab-' + b.id;
    const cb = h('input', { type: 'checkbox', id, checked: sel.has(b.id) });
    cb.addEventListener('change', () => (cb.checked ? sel.add(b.id) : sel.delete(b.id)));
    box.append(h('label.check', { for: id }, cb, h('span', b.title, b.author ? h('small', ' · ' + b.author) : null)));
  }
  const r = await dialog({ title: `Books in “${c.name}”`, body: box, actions: [{ label: 'Cancel', value: false }, { label: 'Save', value: true, primary: true }] });
  if (!r) return;
  for (const b of state.books) {
    const has = b.collections?.includes(c.id);
    if (sel.has(b.id) && !has) await setBookCollections(b, [...(b.collections || []), c.id]);
    else if (!sel.has(b.id) && has) await setBookCollections(b, b.collections.filter((x) => x !== c.id));
  }
}

// ---------------- FREE BOOKS ----------------
const free = { q: '', cat: null, lang: 'en' };

VIEWS.free = (page) => {
  page.append(pageHead('Free books', 'Classics from Project Gutenberg: free, legal and yours to keep. Added books work offline like any other.'));
  let framed = false; try { framed = window.self !== window.top; } catch { framed = true; }
  if (framed) {
    page.append(emptyState('Free books live in the phone app', 'This preview inside Claude can’t reach Project Gutenberg. Open the installed app to browse and add free books with one tap.', h('a.btn.btn-primary', { href: 'https://lionolazycat-jom.github.io/marginalia-reader/#free', target: '_blank', rel: 'noopener' }, 'Open the app')));
    return;
  }
  const q = h('input#free-q.search-input', { type: 'search', placeholder: 'Search 75,000 free books by title or author', value: free.q, 'aria-label': 'Search free books', enterkeyhint: 'search' });
  const run = () => { free.q = q.value.trim(); if (free.q) free.cat = null; rerender(); };
  q.addEventListener('search', () => { if (!q.value && free.q) run(); });
  const lang = h('select#free-lang', { 'aria-label': 'Language' }, LANGUAGES.map(([v, l]) => h('option', { value: v, selected: free.lang === v }, l)));
  lang.addEventListener('change', () => { free.lang = lang.value; if (free.q) rerender(); });
  page.append(h('form.lib-tools', { onsubmit: (e) => { e.preventDefault(); q.blur(); run(); } }, h('div.search-wrap', icon('search', 18), q), h('div.lib-tools-right', lang, h('button.btn.btn-primary', { type: 'submit' }, 'Search'))));
  if (!navigator.onLine) page.append(h('p.hint', 'You’re offline. You can browse the shelves; adding a book needs a connection.'));
  page.append(h('div.chips.cat-chips', { role: 'group', 'aria-label': 'Categories' },
    h('button', { type: 'button', class: `chip ${!free.cat && !free.q ? 'on' : ''}`, onclick: () => { free.cat = null; free.q = ''; rerender(); } }, 'Shelves'),
    CATEGORIES.map((c) => h('button', { type: 'button', class: `chip ${free.cat === c.key ? 'on' : ''}`, 'aria-pressed': free.cat === c.key ? 'true' : 'false', onclick: () => { free.cat = c.key; free.q = ''; rerender(); } }, c.label))));

  if (free.q || free.cat) {
    const cat = free.cat && !free.q ? CATEGORIES.find((c) => c.key === free.cat) : null;
    const box = h('section.free-results');
    page.append(box);
    box.append(h('div.shelf-head', h('h2', cat ? cat.label : `Results for “${free.q}”`), h('button.link', { type: 'button', onclick: () => { free.q = ''; free.cat = null; rerender(); } }, 'Back to shelves')));
    if (cat) box.append(h('p.hint', 'Most-read first. Everything here is free and yours to keep.'));
    const note = h('div');
    const grid = h('div.book-grid.free-grid');
    const more = h('div.row.center');
    box.append(note, grid, more);
    const load = async (pg) => {
      more.textContent = '';
      more.append(h('div.spinner.small'));
      const r = await searchFree({ q: cat ? '' : free.q, cat: cat?.key, lang: free.lang, page: pg });
      if (r.unavailable) note.replaceChildren(h('p.hint', cat ? 'The full Gutenberg catalogue isn’t answering right now, so this shows only the books that come with the app. Try again later for the whole category.' : 'The full Gutenberg catalogue isn’t answering right now, so these results come from the shelves below. Try again later for everything.'));
      else if (r.offline) note.replaceChildren(h('p.hint', 'Showing results saved from earlier.'));
      if (pg === 1 && !r.books.length) grid.replaceWith(h('p.empty-note', cat ? 'Nothing to show in this category right now. Try again when you’re online and the catalogue is up.' : `No free books found for “${free.q}”. Try the author’s surname or fewer words.`));
      for (const b of r.books) grid.append(freeCard(b));
      more.textContent = '';
      if (r.next) more.append(h('button.btn', { type: 'button', onclick: () => load(r.next) }, 'Show more'));
    };
    load(1);
    return;
  }
  for (const sh of SHELVES) {
    page.append(h('section.shelf', h('div.shelf-head', h('h2', sh.label)), h('div.shelf-row', sh.books.map((b) => freeCard(b, true)))));
  }
  page.append(h('p.hint.free-foot', 'Books come from Project Gutenberg, the oldest free digital library. They’re free because their copyright has expired in the United States; check your own country’s rules before sharing them.'));
};

const ownedFree = (id) => state.books.find((b) => b.source === `gutenberg:${id}`);

function freeCover(b, cls = '') {
  const fake = { title: b.title, author: b.author, format: 'epub', hasCover: false, id: 'g' + b.id };
  const el = coverEl(fake, cls);
  if (b.cover) { const img = h('img', { src: b.cover, alt: '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer' }); img.onload = () => el.classList.add('has-img'); img.onerror = () => img.remove(); el.append(img); }
  return el;
}

function freeCard(b, compact) {
  const owned = ownedFree(b.id);
  return h(compact ? 'button.shelf-book' : 'button.free-card', { type: 'button', onclick: () => freeDetail(b), title: b.title },
    freeCover(b),
    owned ? h('span.badge.free-owned', 'In library') : null,
    h('span.shelf-title', b.title), h('span.shelf-meta', b.author || 'Unknown author'));
}

async function freeDetail(b) {
  const owned = ownedFree(b.id);
  const body = h('div.free-detail',
    freeCover(b, 'free-detail-cover'),
    h('div',
      b.author ? h('p.free-author', b.author) : null,
      b.downloads ? h('p.muted', `${b.downloads.toLocaleString()} downloads in the last month · ${b.languages.map((l) => LANGUAGES.find(([v]) => v === l)?.[1] || l).join(', ')}`) : h('p.muted', 'Project Gutenberg · EPUB'),
      b.summary ? h('p.free-summary', b.summary.length > 420 ? b.summary.slice(0, 420).replace(/\s\S*$/, '') + '…' : b.summary) : null,
      b.subjects.length ? h('div.chips', b.subjects.slice(0, 5).map((s) => h('span.chip.static', s))) : null,
      h('a.link.small', { href: gutenbergPage(b.id), target: '_blank', rel: 'noopener noreferrer' }, 'View on Project Gutenberg')));
  const r = await dialog({ title: b.title, body, wide: true, actions: [{ label: 'Close', value: false }, owned ? { label: 'Open book', value: 'open', primary: true } : { label: 'Add to library', value: 'add', primary: true }] });
  if (r === 'open') { openBook(owned); return; }
  if (r !== 'add') return;
  const busy = h('div.import-progress', { role: 'status' }, h('div.spinner.small'), h('span', `Downloading ${b.title}…`));
  document.body.append(busy);
  try {
    const file = await downloadBook(b, (f) => { if (f != null) busy.lastChild.textContent = `Downloading ${b.title}… ${Math.round(f * 100)}%`; });
    busy.lastChild.textContent = `Adding ${b.title}…`;
    const res = await importFile(file);
    const norm = (x) => (x || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').slice(0, 2).join(' ');
    if (norm(res.book.title) && norm(b.title) && !norm(res.book.title).includes(norm(b.title).split(' ')[0]) && !norm(b.title).includes(norm(res.book.title).split(' ')[0])) {
      toast(`Note: Project Gutenberg sent “${res.book.title}”.`, { ms: 7000 });
    }
    const patch = { source: `gutenberg:${b.id}`, categories: categorize([...(b.subjects || []), ...(res.book.subjects || [])], [...(res.book.categories || []), ...(free.cat ? [free.cat] : []), 'classics']) };
    if (b.author && !res.book.author) patch.author = b.author;
    await updateBook(res.book, patch);
    busy.remove();
    toast(res.duplicate ? `“${res.book.title}” is already in your library` : `Added “${res.book.title}”`, { action: { label: 'Open', run: () => openBook(res.book) } });
    if (view === 'free') rerender();
  } catch (e) {
    busy.remove();
    dialog({ title: 'The book couldn’t be added', body: h('div', h('p', e.message), h('p.hint', 'You can also download it from Project Gutenberg in your browser, then add it here with Add books.')), actions: [{ label: 'Close', value: false }, { label: 'Open Gutenberg page', value: 'pg', primary: true }] })
      .then((v) => { if (v === 'pg') { const a = h('a', { href: gutenbergPage(b.id), target: '_blank', rel: 'noopener noreferrer' }); document.body.append(a); a.click(); a.remove(); } });
  }
}

// ---------------- COLLECTIONS ----------------
VIEWS.collections = (page) => {
  const newBtn = h('button.btn.btn-primary', { type: 'button', onclick: async () => { const r = await dialog({ title: 'New collection', fields: [{ name: 'name', label: 'Name', placeholder: 'e.g. Philosophy, Work, To read in 2027' }], actions: [{ label: 'Cancel', value: false }, { label: 'Create', value: true, primary: true }] }); if (r?.action && r.values.name.trim()) { const c = await createCollection(r.values.name); go('collection-' + c.id); } } }, icon('plus', 16), 'New collection');
  page.append(pageHead('Collections', 'Group books any way you like. A book can be in several collections.', newBtn));
  const smart = [
    ['Currently reading', state.books.filter((b) => statusOf(b) === 'reading'), () => { Object.assign(lib, { status: 'reading', format: 'all', collection: 'all', q: '' }); go('library'); }],
    ['Not started', state.books.filter((b) => statusOf(b) === 'new'), () => { Object.assign(lib, { status: 'new', format: 'all', collection: 'all', q: '' }); go('library'); }],
    ['Finished', state.books.filter((b) => statusOf(b) === 'finished'), () => { Object.assign(lib, { status: 'finished', format: 'all', collection: 'all', q: '' }); go('library'); }],
  ];
  const tile = (name, books, onclick, extra) => h('button.coll-tile', { type: 'button', onclick },
    h('div.coll-stack', books.slice(0, 3).map((b) => coverEl(b, 'sm')), !books.length ? h('div.coll-empty', icon('collection', 28)) : null),
    h('div.coll-info', h('strong', name), h('span.muted', `${books.length} book${books.length === 1 ? '' : 's'}`), extra || null));
  if (state.collections.length) {
    page.append(h('h2.sec-title', 'Your collections'));
    page.append(h('div.coll-grid', state.collections.slice().sort((a, b) => a.name.localeCompare(b.name)).map((c) => tile(c.name, state.books.filter((b) => b.collections?.includes(c.id)), () => go('collection-' + c.id)))));
  } else page.append(emptyState('No collections yet', 'Create collections for subjects, projects or moods, then add books from their menu or from inside the collection.', newBtn.cloneNode(true)));
  page.lastChild.querySelector?.('.btn')?.addEventListener('click', () => newBtn.click());
  page.append(h('h2.sec-title', 'By reading status'));
  page.append(h('div.coll-grid', smart.map(([n, b, f]) => tile(n, b, f))));
};

// ---------------- BOOKMARKS ----------------
VIEWS.bookmarks = (page) => {
  page.append(pageHead('Bookmarks', `${state.bookmarks.length} saved place${state.bookmarks.length === 1 ? '' : 's'}`));
  if (!state.bookmarks.length) { page.append(emptyState('No bookmarks yet', 'While reading, press B or tap the bookmark button to save a page. Name bookmarks to find them again.')); return; }
  const byBook = groupBy(state.bookmarks, 'bookId');
  for (const [bookId, marks] of byBook) {
    const b = bookById(bookId);
    if (!b) continue;
    page.append(h('section.group',
      h('div.group-head', coverEl(b, 'xs'), h('div', h('h2', b.title), h('p.muted', b.author || '')), h('button.btn.btn-small', { type: 'button', onclick: () => openBook(b) }, 'Open')),
      h('ul.mark-list.wide', marks.sort((x, y) => x.progress - y.progress).map((m) => h('li.mark-item',
        h('button.mark-main', { type: 'button', onclick: () => openBook(b, { loc: m.loc }) }, h('span.mark-label', m.label || 'Bookmark'), h('span.mark-meta', `${m.pageLabel || ''} · ${fmtPct(m.progress)} · saved ${fmtRelative(m.createdAt).toLowerCase()}`), m.snippet ? h('span.mark-snip', m.snippet) : null),
        h('div.mark-actions',
          iconBtn('edit', 'Rename bookmark', async () => { const r = await dialog({ title: 'Rename bookmark', fields: [{ name: 'label', label: 'Name', value: m.label }], actions: [{ label: 'Cancel', value: false }, { label: 'Save', value: true, primary: true }] }); if (r?.action) updateBookmark(m, { label: r.values.label.trim() || m.label }); }, { class: 'mini-btn', size: 16 }),
          iconBtn('trash', 'Delete bookmark', async () => { await deleteBookmark(m.id); toast('Bookmark deleted', { action: { label: 'Undo', run: () => addBookmark(m) } }); }, { class: 'mini-btn', size: 16 })))))));
  }
};

function groupBy(list, key) {
  const m = new Map();
  for (const x of list) { if (!m.has(x[key])) m.set(x[key], []); m.get(x[key]).push(x); }
  return m;
}

// ---------------- HIGHLIGHTS ----------------
const hlf = { book: 'all', color: 'all', style: 'all', chapter: 'all', q: '' };
VIEWS.highlights = (page) => {
  const all = state.annotations;
  page.append(pageHead('Highlights', `${all.length} highlight${all.length === 1 ? '' : 's'} across ${new Set(all.map((a) => a.bookId)).size} book${new Set(all.map((a) => a.bookId)).size === 1 ? '' : 's'}`,
    all.length ? h('button.btn', { type: 'button', onclick: () => exportAnnotationList(filteredHl(), hlf.book !== 'all' ? `${bookById(hlf.book)?.title} - highlights` : 'Highlights') }, icon('download', 16), 'Export') : null));
  if (!all.length) { page.append(emptyState('Nothing highlighted yet', 'Select text while reading and choose a color. Your highlights from every book collect here.')); return; }
  const booksWith = state.books.filter((b) => all.some((a) => a.bookId === b.id));
  const bookSel = h('select#hl-book', { 'aria-label': 'Book' }, h('option', { value: 'all' }, 'All books'), booksWith.map((b) => h('option', { value: b.id, selected: hlf.book === b.id }, b.title)));
  bookSel.addEventListener('change', () => { hlf.book = bookSel.value; hlf.chapter = 'all'; rerender(); });
  const chapters = hlf.book !== 'all' ? [...new Set(all.filter((a) => a.bookId === hlf.book).sort((a, b) => a.progress - b.progress).map((a) => a.chapter).filter(Boolean))] : [];
  const chSel = chapters.length > 1 ? h('select#hl-ch', { 'aria-label': 'Chapter' }, h('option', { value: 'all' }, 'All chapters'), chapters.map((c) => h('option', { value: c, selected: hlf.chapter === c }, c))) : null;
  chSel?.addEventListener('change', () => { hlf.chapter = chSel.value; rerender(); });
  const styleSel = h('select#hl-style', { 'aria-label': 'Style' }, [['all', 'All styles'], ['highlight', 'Highlights'], ['underline', 'Underlines'], ['strike', 'Strikethroughs'], ['notes', 'With notes']].map(([v, l]) => h('option', { value: v, selected: hlf.style === v }, l)));
  styleSel.addEventListener('change', () => { hlf.style = styleSel.value; rerender(); });
  const q = h('input#hl-q.search-input', { type: 'search', placeholder: 'Search highlights and notes', value: hlf.q, 'aria-label': 'Search highlights' });
  q.addEventListener('input', debounce(() => { hlf.q = q.value; rerender(); }, 200));
  const colors = h('div.chips', h('button', { type: 'button', class: `chip ${hlf.color === 'all' ? 'on' : ''}`, onclick: () => { hlf.color = 'all'; rerender(); } }, 'All colors'), Object.entries(HL_COLORS).map(([k, c]) => h('button', { type: 'button', class: `chip ${hlf.color === k ? 'on' : ''}`, 'aria-pressed': hlf.color === k ? 'true' : 'false', style: { '--sw': c.css }, onclick: () => { hlf.color = hlf.color === k ? 'all' : k; rerender(); } }, h('span.dot'), c.label)));
  page.append(h('div.lib-tools', h('div.search-wrap', icon('search', 18), q), h('div.lib-tools-right', bookSel, chSel, styleSel)), colors);
  const list = filteredHl();
  if (!list.length) { page.append(h('p.empty-note', 'No highlights match these filters.')); return; }
  const byBook = groupBy(list.sort((a, b) => (a.bookId === b.bookId ? (a.progress || 0) - (b.progress || 0) : 0)), 'bookId');
  for (const [bookId, anns] of byBook) {
    const b = bookById(bookId);
    if (!b) continue;
    page.append(h('section.group',
      h('div.group-head', coverEl(b, 'xs'), h('div', h('h2', b.title), h('p.muted', `${anns.length} highlight${anns.length > 1 ? 's' : ''}${b.author ? ' · ' + b.author : ''}`))),
      h('div.hl-cards', anns.map((a) => hlCard(a, b)))));
  }
};

function filteredHl() {
  const q = hlf.q.trim().toLowerCase();
  return state.annotations.filter((a) => (hlf.book === 'all' || a.bookId === hlf.book) && (hlf.color === 'all' || a.color === hlf.color) && (hlf.style === 'all' || (hlf.style === 'notes' ? !!a.note : a.style === hlf.style)) && (hlf.chapter === 'all' || a.chapter === hlf.chapter) && (!q || (a.text + ' ' + (a.note || '')).toLowerCase().includes(q)));
}

function hlCard(a, b) {
  const goto = () => openBook(b, { loc: a.loc.kind === 'pdf' ? { page: a.loc.page, y: Math.max(0, a.loc.rects[0][1] - 0.05) } : { ch: a.loc.ch, off: a.loc.start } });
  const noteBox = h('div.hl-note');
  const drawNote = () => {
    noteBox.textContent = '';
    if (a.note) noteBox.append(h('p', a.note));
  };
  drawNote();
  return h('article', { class: `hl-card c-${a.color}` },
    h('div.hl-meta', h('span', a.chapter || ''), h('span', `${fmtPct(a.progress)} · ${new Date(a.createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`)),
    h('blockquote', { class: `st-${a.style}` }, a.text),
    noteBox,
    h('div.hl-actions',
      h('button.btn.btn-small.ghost', { type: 'button', onclick: goto }, 'Go to passage'),
      h('div.swatch-row', Object.entries(HL_COLORS).map(([k, c]) => h('button.swatch.sm', { type: 'button', class: `swatch sm ${a.color === k ? 'on' : ''}`, 'aria-label': `Change color to ${c.label}`, style: { '--sw': c.css }, onclick: () => updateAnnotation(a, { color: k }) }))),
      iconBtn('note', a.note ? 'Edit note' : 'Add note', async () => { const r = await dialog({ title: a.note ? 'Edit note' : 'Add a note', body: h('blockquote.dlg-quote', a.text.slice(0, 280)), fields: [{ name: 'note', label: 'Note', type: 'textarea', value: a.note }], actions: [{ label: 'Cancel', value: false }, { label: 'Save note', value: true, primary: true }] }); if (r?.action) updateAnnotation(a, { note: r.values.note.trim() }); }, { class: 'mini-btn', size: 16 }),
      iconBtn('copy', 'Copy quote', async () => { const { copyText } = await import('./util.js'); toast((await copyText(`“${a.text}”\n— ${b.title}${b.author ? ', ' + b.author : ''}${a.note ? `\n\nNote: ${a.note}` : ''}`)) ? 'Quote copied' : 'Copy failed'); }, { class: 'mini-btn', size: 16 }),
      iconBtn('trash', 'Delete highlight', async () => { const d = await deleteAnnotation(a.id); toast('Highlight deleted', { action: { label: 'Undo', run: () => restoreAnnotation(d) } }); }, { class: 'mini-btn', size: 16 })));
}

// ---------------- NOTES ----------------
let notesTab = 'mine';
let notesEditing = null;
VIEWS.notes = (page) => {
  const passageNotes = state.annotations.filter((a) => a.note);
  page.append(pageHead('Notes', 'Your own notes, and notes you’ve written on passages.',
    notesTab === 'mine' ? h('button.btn.btn-primary', { type: 'button', onclick: () => { notesEditing = { title: '', body: '', bookId: '' }; rerender(); } }, icon('plus', 16), 'New note') : null));
  page.append(h('div.tabs.page-tabs', { role: 'tablist' }, [['mine', `My notes (${state.notes.length})`], ['passages', `On passages (${passageNotes.length})`]].map(([k, l]) => h('button', { type: 'button', role: 'tab', class: notesTab === k ? 'on' : '', 'aria-selected': notesTab === k ? 'true' : 'false', onclick: () => { notesTab = k; notesEditing = null; rerender(); } }, l))));
  if (notesTab === 'passages') {
    if (!passageNotes.length) { page.append(emptyState('No notes on passages', 'Select text while reading and choose Note to write beside the words that prompted it.')); return; }
    for (const [bookId, anns] of groupBy(passageNotes.sort((a, b) => b.updatedAt - a.updatedAt), 'bookId')) {
      const b = bookById(bookId);
      if (!b) continue;
      page.append(h('section.group', h('div.group-head', coverEl(b, 'xs'), h('div', h('h2', b.title), h('p.muted', b.author || ''))), h('div.hl-cards', anns.map((a) => hlCard(a, b)))));
    }
    return;
  }
  const layout = h('div.notes-layout');
  const list = h('ul.note-list');
  const notes = [...state.notes].sort((a, b) => b.updatedAt - a.updatedAt);
  if (!notes.length && !notesEditing) { page.append(emptyState('No notes yet', 'Keep ideas, reading plans or reflections here. Notes can stand alone or be linked to a book.', h('button.btn.btn-primary', { type: 'button', onclick: () => { notesEditing = { title: '', body: '', bookId: '' }; rerender(); } }, 'Write a note'))); return; }
  for (const n of notes) {
    const b = n.bookId ? bookById(n.bookId) : null;
    list.append(h('li', h('button.note-item', { type: 'button', class: `note-item ${notesEditing?.id === n.id ? 'on' : ''}`, onclick: () => { notesEditing = n; rerender(); } }, h('strong', n.title || 'Untitled note'), h('span.note-prev', (n.body || '').slice(0, 110) || 'Empty note'), h('span.note-when', `${fmtRelative(n.updatedAt)}${b ? ' · ' + b.title : ''}`))));
  }
  layout.append(h('div.note-col', list));
  const ed = notesEditing || notes[0];
  if (ed) {
    notesEditing = ed;
    const title = h('input#note-title.note-title-in', { type: 'text', placeholder: 'Title', value: ed.title || '', 'aria-label': 'Note title' });
    const body = h('textarea#note-body.note-body-in', { placeholder: 'Write…', 'aria-label': 'Note text' });
    body.value = ed.body || '';
    const bookSel = h('select#note-book', { 'aria-label': 'Linked book' }, h('option', { value: '' }, 'Not linked to a book'), state.books.map((b) => h('option', { value: b.id, selected: ed.bookId === b.id }, b.title)));
    const status = h('span.save-state', ed.id ? `Saved ${fmtRelative(ed.updatedAt).toLowerCase()}` : 'Not saved yet');
    const save = debounce(async () => {
      if (!title.value.trim() && !body.value.trim() && !ed.id) return;
      ed.title = title.value.trim(); ed.body = body.value; ed.bookId = bookSel.value;
      await saveNote(ed);
      status.textContent = 'Saved';
      const item = list.querySelector('.note-item.on strong'); if (item) item.textContent = ed.title || 'Untitled note';
    }, 500);
    title.addEventListener('input', save); body.addEventListener('input', save); bookSel.addEventListener('change', save);
    layout.append(h('div.note-editor', h('div.note-ed-top', bookSel, status, ed.id ? iconBtn('trash', 'Delete note', async () => { if (await confirmDialog('Delete this note?', 'This can’t be undone.', 'Delete note')) { await deleteNote(ed.id); notesEditing = null; rerender(); } }, { class: 'mini-btn' }) : null), title, body,
      ed.bookId && bookById(ed.bookId) ? h('button.btn.btn-small.ghost', { type: 'button', onclick: () => openBook(bookById(ed.bookId)) }, `Open ${bookById(ed.bookId).title}`) : null));
    if (!ed.id) setTimeout(() => title.focus(), 30);
  }
  page.append(layout);
};

// ---------------- STATS ----------------
VIEWS.stats = (page) => {
  const days = lastNDays(30);
  const total = state.days.reduce((s, d) => s + d.seconds, 0);
  const week = days.slice(-7).reduce((s, d) => s + d.seconds, 0);
  const year = new Date().getFullYear();
  const finishedYear = state.books.filter((b) => b.finishedAt && new Date(b.finishedAt).getFullYear() === year);
  const activeDays = state.days.filter((d) => d.seconds >= 60).length;
  page.append(pageHead('Reading statistics', 'Counted only while a book is open in front of you and you’re active.'));
  const tile = (label, value, sub) => h('div.stat-tile', h('span.stat-label', label), h('strong.stat-val.num', value), sub ? h('span.stat-sub', sub) : null);
  page.append(h('div.stat-tiles',
    tile('Today', fmtDuration(todaySeconds()), `Goal ${state.ui.goalMinutes} min`),
    tile('Last 7 days', fmtDuration(week), `${days.slice(-7).filter((d) => d.seconds >= 60).length} of 7 days`),
    tile('Streak', `${streak()} day${streak() === 1 ? '' : 's'}`, 'Days in a row with a minute or more'),
    tile(`Finished in ${year}`, `${finishedYear.length} of ${state.ui.goalBooks}`, 'Yearly book goal'),
    tile('All time', fmtDuration(total), `${activeDays} reading day${activeDays === 1 ? '' : 's'}`)));
  // 30-day chart
  const goalS = state.ui.goalMinutes * 60;
  const max = Math.max(goalS * 1.25, ...days.map((d) => d.seconds), 60);
  const W = 720, H = 200, pad = { l: 36, r: 8, t: 12, b: 26 };
  const bw = (W - pad.l - pad.r) / days.length;
  const y = (s) => pad.t + (H - pad.t - pad.b) * (1 - s / max);
  const ticks = niceTicks(max / 60);
  let svg = `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Minutes read per day, last 30 days">`;
  for (const t of ticks) svg += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(t * 60)}" y2="${y(t * 60)}" class="grid"/><text x="${pad.l - 6}" y="${y(t * 60) + 4}" class="axis" text-anchor="end">${t}</text>`;
  svg += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(goalS)}" y2="${y(goalS)}" class="goal-line"/><text x="${W - pad.r}" y="${y(goalS) - 5}" class="axis goal-txt" text-anchor="end">goal ${state.ui.goalMinutes} min</text>`;
  days.forEach((d, i) => {
    const x = pad.l + i * bw + bw * 0.18, w = bw * 0.64;
    const hh = Math.max(d.seconds ? 2 : 0, H - pad.b - y(d.seconds));
    svg += `<rect x="${x}" y="${H - pad.b - hh}" width="${w}" height="${hh}" rx="2" class="${d.seconds >= goalS ? 'bar met' : 'bar'}"><title>${esc(d.label)}: ${esc(fmtDuration(d.seconds))}</title></rect>`;
    if (i % 5 === 4 || i === days.length - 1) svg += `<text x="${x + w / 2}" y="${H - 8}" class="axis" text-anchor="middle">${d.date.getDate()}/${d.date.getMonth() + 1}</text>`;
  });
  svg += `<text x="4" y="${pad.t + 2}" class="axis">min</text></svg>`;
  page.append(h('section.card.chart-card', h('h2', 'Minutes per day · last 30 days'), h('div.chart-wrap', { html: svg })));
  // goals
  const gm = h('input#goal-min', { type: 'number', min: 1, max: 600, value: state.ui.goalMinutes, inputmode: 'numeric' });
  const gb = h('input#goal-books', { type: 'number', min: 1, max: 500, value: state.ui.goalBooks, inputmode: 'numeric' });
  gm.addEventListener('change', () => saveUI({ goalMinutes: Math.max(1, Math.min(600, +gm.value || 20)) }).then(rerender));
  gb.addEventListener('change', () => saveUI({ goalBooks: Math.max(1, Math.min(500, +gb.value || 12)) }).then(rerender));
  const two = h('div.two-col');
  two.append(h('section.card', h('h2', 'Goals'), h('label.field.inline', { for: 'goal-min' }, h('span.field-label', 'Daily reading goal (minutes)'), gm), h('label.field.inline', { for: 'goal-books' }, h('span.field-label', `Books to finish in ${year}`), gb),
    h('div.goal-bar', h('div.pbar.big', h('span', { style: { width: Math.min(100, (finishedYear.length / state.ui.goalBooks) * 100) + '%' } })), h('span.muted', `${finishedYear.length} finished · ${Math.max(0, state.ui.goalBooks - finishedYear.length)} to go`))));
  const most = [...state.books].filter((b) => b.readingSeconds).sort((a, b) => b.readingSeconds - a.readingSeconds).slice(0, 6);
  two.append(h('section.card', h('h2', 'Most read'), most.length ? h('ol.most', most.map((b) => h('li', h('button.link-strong', { type: 'button', onclick: () => openBook(b) }, b.title), h('span.num', fmtDuration(b.readingSeconds))))) : h('p.muted', 'Read for a few minutes and your books will appear here.')));
  page.append(two);
  // history
  const hist = [...state.days].filter((d) => d.seconds >= 30).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 14);
  page.append(h('section.card', h('h2', 'Reading history'), hist.length ? h('ul.history', hist.map((d) => h('li', h('span.hist-date', new Date(d.date + 'T12:00').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })), h('span.hist-books', Object.entries(d.books).sort((a, b) => b[1] - a[1]).map(([id, s]) => { const b = bookById(id); return b ? h('span.hist-book', `${b.title} `, h('small', fmtDuration(s))) : null; })), h('strong.num', fmtDuration(d.seconds))))) : h('p.muted', 'No reading recorded yet.')));
  if (finishedYear.length) page.append(shelf(`Finished in ${year}`, finishedYear.sort((a, b) => b.finishedAt - a.finishedAt)));
};

function niceTicks(maxMin) {
  const step = maxMin <= 10 ? 2 : maxMin <= 30 ? 10 : maxMin <= 90 ? 15 : maxMin <= 180 ? 30 : 60;
  const out = [];
  for (let t = step; t < maxMin; t += step) out.push(t);
  return out;
}

// ---------------- PREFERENCES ----------------
VIEWS.preferences = async (page) => {
  page.append(pageHead('Preferences', 'Appearance, reading aids and your data.'));
  const ui = state.ui;
  const seg = (key, opts) => h('div.seg', { role: 'group' }, opts.map(([v, l]) => h('button', { type: 'button', class: ui[key] === v ? 'on' : '', 'aria-pressed': ui[key] === v ? 'true' : 'false', onclick: () => saveUI({ [key]: v }).then(rerender) }, l)));
  const accent = h('div.accent-row', Object.entries(ACCENTS).map(([k, a]) => h('button', { type: 'button', class: `accent-sw ${ui.accent === k ? 'on' : ''}`, 'aria-label': a.label, title: a.label, style: { '--sw': document.documentElement.dataset.theme === 'dark' ? a.dark : a.light }, onclick: () => saveUI({ accent: k }).then(rerender) })),
    (() => { const c = h('input', { type: 'color', id: 'acc-custom', value: ui.customAccent || '#2F5D50', title: 'Custom accent' }); c.addEventListener('change', () => saveUI({ accent: 'custom', customAccent: c.value }).then(rerender)); return h('label.accent-custom', { for: 'acc-custom', class: `accent-custom ${ui.accent === 'custom' ? 'on' : ''}` }, c, 'Custom'); })());
  page.append(h('section.card.pref', h('h2', 'Appearance'), h('div.pref-row', h('span', 'App theme'), seg('appTheme', [['auto', 'Match device'], ['light', 'Light'], ['dark', 'Dark']])), h('div.pref-row', h('span', 'Accent color'), accent), h('p.hint', 'Reading themes, fonts and spacing are in the Display panel (Aa) while you read.')));

  const sample = capabilityNow('sample');
  const lang = h('select#tr-lang', { 'aria-label': 'Translate into' }, ['English', 'Malay', 'Chinese (Simplified)', 'Chinese (Traditional)', 'Tamil', 'Indonesian', 'Japanese', 'Korean', 'Spanish', 'French', 'German', 'Italian', 'Portuguese', 'Arabic', 'Hindi', 'Thai', 'Vietnamese', 'Russian'].map((l) => h('option', { value: l, selected: ui.translateTo === l }, l)));
  lang.addEventListener('change', () => saveUI({ translateTo: lang.value }));
  page.append(h('section.card.pref', h('h2', 'Dictionary & translation'),
    h('p', sample ? 'Select a word or passage while reading and choose Define or Translate. Only the selected text (and a sentence of context for definitions) is sent to Claude; your books are never uploaded.' : 'Select a word or passage while reading and choose Define or Translate. When you’re online, the selected text opens in Wiktionary or Google Translate; nothing else leaves your device. Everything else works offline.'),
    h('div.pref-row', h('label', { for: 'tr-lang' }, 'Translate into'), lang)));

  const est = await storageEstimate();
  const usage = est ? `${fmtBytes(est.usage)} used${est.quota ? ` of about ${fmtBytes(est.quota)} available` : ''}` : 'Storage size unknown';
  const backup = h('button.btn', { type: 'button', onclick: async () => { const json = await exportBackup(); report(await saveFile(`marginalia-backup-${dayKey()}.json`, json, 'application/json')); } }, icon('download', 16), 'Back up');
  const restore = h('button.btn', { type: 'button', onclick: () => { const inp = h('input.visually-hidden', { type: 'file' }); inp.onchange = () => { if (inp.files[0]) restoreFrom(inp.files[0]); inp.remove(); }; document.body.append(inp); inp.click(); } }, icon('upload', 16), 'Restore from backup');
  const persistBtn = est && !est.persisted ? h('button.btn.btn-small', { type: 'button', onclick: async () => { const ok = await requestPersistence(); toast(ok ? 'Storage is now protected from automatic cleanup.' : 'The browser declined. Your data is still saved, but may be cleared if the device runs low on space.'); rerender(); } }, 'Protect storage') : null;
  page.append(h('section.card.pref', h('h2', 'Your data'),
    h('div.pref-row', h('span', 'Storage'), h('span.muted', usage, est?.persisted ? ' · protected' : '')), persistBtn,
    h('p', `${plural(state.books.length, 'book')}, ${plural(state.annotations.length, 'highlight')}, ${plural(state.bookmarks.length, 'bookmark')} and ${plural(state.notes.length, 'note')} are stored in this browser only.`),
    h('p.hint', 'A backup saves highlights, notes, bookmarks, collections, reading history and settings. Book files aren’t included; if you restore on another device, add the same files and they reattach to their highlights automatically.'),
    h('div.row', backup, restore),
    h('div.danger-zone', h('button.btn.btn-danger', { type: 'button', onclick: async () => { if (await confirmDialog('Delete everything?', 'All books, highlights, notes, bookmarks, collections and reading history will be removed from this device. Back up first if you want to keep them.', 'Delete everything')) { await clearEverything(); await db.kvSet('seeded', true); toast('Everything was deleted'); go('home'); } } }, 'Delete everything'))));

  // ----- read aloud -----
  if ('speechSynthesis' in window) {
    const voiceSel = h('select#tts-voice-pref', { 'aria-label': 'Voice' });
    const fillVoices = () => {
      const voices = sortVoices(listVoices());
      voiceSel.textContent = '';
      voiceSel.append(h('option', { value: '' }, 'Automatic (best match for each book)'));
      for (const v of voices) voiceSel.append(h('option', { value: v.voiceURI, selected: v.voiceURI === ui.ttsVoice }, `${v.name} · ${v.lang}${v.localService ? '' : ' · online'}`));
    };
    fillVoices();
    speechSynthesis.addEventListener?.('voiceschanged', fillVoices, { once: true });
    voiceSel.addEventListener('change', () => saveUI({ ttsVoice: voiceSel.value }));
    const rateIn = h('input#tts-rate-pref', { type: 'range', min: 0.6, max: 2, step: 0.05, value: ui.ttsRate || 1 });
    const rateOut = h('output', { for: 'tts-rate-pref' }, `${(ui.ttsRate || 1).toFixed(2)}×`);
    rateIn.addEventListener('input', () => { rateOut.textContent = `${(+rateIn.value).toFixed(2)}×`; });
    rateIn.addEventListener('change', () => saveUI({ ttsRate: +rateIn.value }));
    const pitchIn = h('input#tts-pitch-pref', { type: 'range', min: 0.7, max: 1.3, step: 0.05, value: ui.ttsPitch || 1 });
    const pitchOut = h('output', { for: 'tts-pitch-pref' }, (ui.ttsPitch || 1).toFixed(2));
    pitchIn.addEventListener('input', () => { pitchOut.textContent = (+pitchIn.value).toFixed(2); });
    pitchIn.addEventListener('change', () => saveUI({ ttsPitch: +pitchIn.value }));
    const test = h('button#tts-test.btn', { type: 'button', onclick: () => {
      try {
        speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance('The lamp was lit, the page was turned, and the evening grew quiet.');
        const v = listVoices().find((x) => x.voiceURI === voiceSel.value) || sortVoices(listVoices())[0];
        if (v) { u.voice = v; u.lang = v.lang; }
        const st = VOICE_STYLES[state.ui.ttsStyle] || VOICE_STYLES.natural;
        u.rate = +rateIn.value * st.rate; u.pitch = +pitchIn.value * st.pitch;
        speechSynthesis.speak(u);
      } catch { toast('This device can’t play speech right now.'); }
    } }, icon('play', 16), 'Test voice');
    const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    page.append(h('section.card.pref', h('h2', 'Read aloud'),
      h('p', 'Books are read by your device’s own voices, sentence by sentence, with the current word highlighted when the voice supports it. It works offline and keeps the screen on while it plays.'),
      h('div.pref-row', h('label', { for: 'tts-voice-pref' }, 'Voice'), voiceSel),
      h('div.style-grid', { role: 'group', 'aria-label': 'Reading style' }, Object.entries(VOICE_STYLES).map(([k, v]) => h('button', { type: 'button', class: `style-opt ${(ui.ttsStyle || 'natural') === k ? 'on' : ''}`, 'aria-pressed': (ui.ttsStyle || 'natural') === k ? 'true' : 'false', onclick: () => saveUI({ ttsStyle: k }).then(() => { rerender(); setTimeout(() => document.querySelector('#tts-test')?.click(), 50); }) }, h('strong', v.label), h('span', v.note)))),
      h('div.slider-row.pref-slider', h('label', { for: 'tts-rate-pref' }, 'Speed'), rateIn, rateOut),
      h('div.slider-row.pref-slider', h('label', { for: 'tts-pitch-pref' }, 'Pitch'), pitchIn, pitchOut),
      h('div.row', test),
      h('p.hint', ios ? 'For more natural voices on iPhone or iPad: Settings → Accessibility → Spoken Content → Voices, then download an “Enhanced” or “Premium” voice. It appears here after you reopen the app.' : 'For more natural voices on Android: Settings → Accessibility → Text-to-speech output, choose Speech Services by Google and install voice data for your language.')));
  }

  // ----- install -----
  const inst = installState();
  page.append(h('section.card.pref', h('h2', 'App on this device'),
    h('p', inst.installed ? 'Marginalia is installed. It opens full screen from your home screen and works without a connection.' : inst.canPrompt ? 'Install Marginalia to open it from your home screen, full screen and offline.' : inst.ios ? 'On iPhone or iPad: tap the Share button in Safari, then “Add to Home Screen”.' : inst.supported ? 'Use your browser’s menu and choose “Install app” or “Add to Home screen”.' : 'Open this app from its web address in Safari (iPhone/iPad) or Chrome (Android) to install it.'),
    inst.canPrompt && !inst.installed ? h('button.btn.btn-primary', { type: 'button', onclick: async () => { await promptInstall(); rerender(); } }, icon('download', 16), 'Install app') : null,
    inst.offlineReady ? h('p.hint', 'Offline copy ready: the app and its PDF engine are saved on this device.') : null));

  page.append(h('section.card.pref', h('h2', 'Keyboard'), h('p', 'Arrow keys turn pages; T opens contents, / searches, B bookmarks, R reads aloud, A opens display settings.'), h('button.btn', { type: 'button', onclick: showShortcuts }, 'All shortcuts')));
  page.append(h('section.card.pref', h('h2', 'About'), h('p', 'Marginalia renders PDFs with PDF.js and reads EPUB, FB2, Markdown, HTML, text and comics with its own engine. It needs no account and keeps working offline once loaded.')));
};

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

async function restoreFrom(file) {
  try {
    const n = await importBackup(await file.text());
    toast(`Backup restored${n ? `: ${n} book record${n > 1 ? 's' : ''} added (add their files to read them)` : ''}`);
  } catch (e) { toast(e.message, { kind: 'error' }); }
}

export { rerender };
