// App state and data operations. Views subscribe with on('change', fn).

import { db, requestPersistence } from './db.js';
import { uid, quickHash, dayKey } from './util.js';
import { detectFormat, readMeta, loadFlowBook, htmlToText, UnsupportedError } from './formats.js';
import { openPdf, pageText as pdfPageText, closePdf } from './pdfcore.js';
import { DEFAULT_READING, DEFAULT_UI } from './settings.js';
import { categorize } from './freebooks.js';

const listeners = new Map();
export function on(ev, fn) { if (!listeners.has(ev)) listeners.set(ev, new Set()); listeners.get(ev).add(fn); return () => listeners.get(ev).delete(fn); }
export function emit(ev, data) { for (const fn of listeners.get(ev) || []) { try { fn(data); } catch (e) { console.error(e); } } }

export const state = {
  books: [],
  collections: [],
  annotations: [],
  bookmarks: [],
  notes: [],
  days: [],
  reading: { ...DEFAULT_READING },
  ui: { ...DEFAULT_UI },
  coverUrls: new Map(),
};

export async function loadAll() {
  await db.ready();
  const [books, collections, annotations, bookmarks, notes, days, reading, ui] = await Promise.all([
    db.all('books'), db.all('collections'), db.all('annotations'), db.all('bookmarks'), db.all('notes'), db.all('days'),
    db.kvGet('reading', {}), db.kvGet('ui', {}),
  ]);
  Object.assign(state, { books, collections, annotations, bookmarks, notes, days });
  state.reading = { ...DEFAULT_READING, ...(reading || {}) };
  state.ui = { ...DEFAULT_UI, ...(ui || {}), toolbar: { ...DEFAULT_UI.toolbar, ...((ui && ui.toolbar) || {}) } };
  // One-time: keep the toolbar showing by default (it's hard to find when it hides itself).
  if (!state.ui.toolbarShownV2) { state.ui.toolbarAutoHide = false; state.ui.toolbarShownV2 = true; db.kvSet('ui', state.ui).catch(() => {}); }
}

export const bookById = (id) => state.books.find((b) => b.id === id);

export async function coverUrl(book) {
  if (!book.hasCover) return null;
  if (state.coverUrls.has(book.id)) return state.coverUrls.get(book.id);
  const p = db.get('covers', book.id).then((r) => (r?.blob ? URL.createObjectURL(r.blob) : null)).catch(() => null);
  state.coverUrls.set(book.id, p);
  return p;
}

export async function saveUI(patch) {
  Object.assign(state.ui, patch);
  await db.kvSet('ui', state.ui);
  emit('ui', state.ui);
}
export async function saveReading(patch) {
  Object.assign(state.reading, patch);
  await db.kvSet('reading', state.reading);
}

// ---------- import ----------
/** Import one file. Returns {book, duplicate?:true, reattached?:true}. Throws a readable Error. */
export async function importFile(file, { quiet } = {}) {
  const format = await detectFormat(file);
  const hash = await quickHash(file);
  const existing = state.books.find((b) => b.hash === hash);
  if (existing && !existing.missingFile) return { book: existing, duplicate: true };
  const meta = await readMeta(file, format);
  if (existing && existing.missingFile) {
    await db.put('files', { id: existing.id, blob: file });
    if (meta.cover) { await db.put('covers', { id: existing.id, blob: meta.cover }); existing.hasCover = true; state.coverUrls.delete(existing.id); }
    existing.missingFile = false;
    queueIndex(existing.id);
    await db.put('books', existing);
    emit('change');
    return { book: existing, reattached: true };
  }
  const id = uid();
  const now = Date.now();
  const book = {
    id, hash, format,
    title: meta.title || 'Untitled', author: /^(anonymous|unknown|unspecified|admin|user|author|none)$/i.test((meta.author || '').trim()) ? '' : (meta.author || ''),
    fileName: file.name, size: file.size, pages: meta.pages || null, language: meta.language || '',
    addedAt: now, lastOpenedAt: 0, progress: 0, location: null, pageLabel: '', locked: !!meta.locked,
    collections: [], finishedAt: null, readingSeconds: 0, settings: null, hasCover: !!meta.cover, indexed: false,
    subjects: (meta.subjects || []).slice(0, 12), categories: categorize(meta.subjects || []),
  };
  await db.put('files', { id, blob: file });
  if (meta.cover) await db.put('covers', { id, blob: meta.cover });
  await db.put('books', book);
  state.books.push(book);
  if (state.books.length === 1 || state.books.length % 5 === 0) requestPersistence();
  emit('change');
  queueIndex(book.id);
  return { book };
}

export async function updateBook(book, patch) {
  Object.assign(book, patch);
  await db.put('books', book);
  emit('change', { book });
}

export async function removeBook(id) {
  await Promise.all([db.del('books', id), db.del('files', id), db.del('covers', id), db.del('texts', id), db.del('reflow', id), db.delWhere('annotations', 'bookId', id), db.delWhere('bookmarks', 'bookId', id)]);
  state.books = state.books.filter((b) => b.id !== id);
  state.annotations = state.annotations.filter((a) => a.bookId !== id);
  state.bookmarks = state.bookmarks.filter((a) => a.bookId !== id);
  const u = state.coverUrls.get(id);
  if (u) { u.then((x) => x && URL.revokeObjectURL(x)); state.coverUrls.delete(id); }
  emit('change');
}

export async function bookFile(id) {
  const r = await db.get('files', id);
  return r?.blob || null;
}

// ---------- background full-text indexing for library content search ----------
const indexQueue = [];
let indexing = false;
export function queueIndex(id) { if (!indexQueue.includes(id)) indexQueue.push(id); runIndex(); }
async function runIndex() {
  if (indexing) return;
  indexing = true;
  while (indexQueue.length) {
    const id = indexQueue.shift();
    const book = bookById(id);
    if (!book || book.indexed || book.locked) continue;
    try {
      await idle();
      const blob = await bookFile(id);
      if (!blob) continue;
      let text = '';
      if (book.format === 'pdf') {
        const doc = await openPdf(blob, null);
        const n = Math.min(doc.numPages, 1500);
        const parts = [];
        for (let i = 0; i < n; i++) { parts.push(await pdfPageText(doc, i)); if (i % 10 === 9) await idle(); }
        closePdf(doc);
        text = parts.join('\n\f');
      } else if (book.format !== 'cbz') {
        const fb = await loadFlowBook(blob, book.format);
        text = fb.chapters.map((c) => htmlToText(c.html)).join('\n\f');
        fb.dispose();
      }
      await db.put('texts', { id, text });
      book.indexed = true;
      await db.put('books', book);
    } catch (e) { console.warn('index failed', book.title, e); }
  }
  indexing = false;
}
const idle = () => new Promise((r) => (window.requestIdleCallback ? requestIdleCallback(() => r(), { timeout: 800 }) : setTimeout(r, 50)));

export async function searchContent(q, limit = 40) {
  const needle = q.toLowerCase();
  const out = [];
  for (const b of state.books) {
    if (!b.indexed) continue;
    const r = await db.get('texts', b.id);
    if (!r?.text) continue;
    const low = r.text.toLowerCase();
    let p = low.indexOf(needle), n = 0;
    const hits = [];
    while (p >= 0 && n < 200) {
      if (hits.length < 3) {
        const a = Math.max(0, p - 60), e = Math.min(r.text.length, p + needle.length + 80);
        hits.push({ before: (a ? '…' : '') + r.text.slice(a, p).replace(/\s+/g, ' '), match: r.text.slice(p, p + needle.length), after: r.text.slice(p + needle.length, e).replace(/\s+/g, ' ') + '…', frac: p / r.text.length });
      }
      n++;
      p = low.indexOf(needle, p + needle.length);
    }
    if (n) out.push({ book: b, count: n, hits });
    if (out.length >= limit) break;
  }
  return out.sort((a, b) => b.count - a.count);
}

// ---------- collections ----------
export async function createCollection(name) {
  const c = { id: uid(), name: name.trim(), createdAt: Date.now() };
  await db.put('collections', c);
  state.collections.push(c);
  emit('change');
  return c;
}
export async function renameCollection(c, name) { c.name = name.trim(); await db.put('collections', c); emit('change'); }
export async function deleteCollection(id) {
  await db.del('collections', id);
  state.collections = state.collections.filter((c) => c.id !== id);
  for (const b of state.books) if (b.collections?.includes(id)) { b.collections = b.collections.filter((x) => x !== id); await db.put('books', b); }
  emit('change');
}
export async function setBookCollections(book, ids) { book.collections = ids; await db.put('books', book); emit('change'); }

// ---------- annotations ----------
export async function addAnnotation(a) {
  const now = Date.now();
  const ann = { id: uid(), createdAt: now, updatedAt: now, note: '', style: 'highlight', color: 'yellow', ...a };
  await db.put('annotations', ann);
  state.annotations.push(ann);
  emit('annotations', { bookId: ann.bookId });
  return ann;
}
export async function updateAnnotation(ann, patch) {
  Object.assign(ann, patch, { updatedAt: Date.now() });
  await db.put('annotations', ann);
  emit('annotations', { bookId: ann.bookId });
}
export async function deleteAnnotation(id) {
  const a = state.annotations.find((x) => x.id === id);
  await db.del('annotations', id);
  state.annotations = state.annotations.filter((x) => x.id !== id);
  emit('annotations', { bookId: a?.bookId, deleted: a });
  return a;
}
export async function restoreAnnotation(a) {
  await db.put('annotations', a);
  state.annotations.push(a);
  emit('annotations', { bookId: a.bookId });
}

// ---------- bookmarks ----------
export async function addBookmark(b) {
  const bm = { id: uid(), createdAt: Date.now(), ...b };
  await db.put('bookmarks', bm);
  state.bookmarks.push(bm);
  emit('bookmarks', { bookId: bm.bookId });
  return bm;
}
export async function updateBookmark(bm, patch) { Object.assign(bm, patch); await db.put('bookmarks', bm); emit('bookmarks', { bookId: bm.bookId }); }
export async function deleteBookmark(id) {
  const b = state.bookmarks.find((x) => x.id === id);
  await db.del('bookmarks', id);
  state.bookmarks = state.bookmarks.filter((x) => x.id !== id);
  emit('bookmarks', { bookId: b?.bookId });
}

// ---------- personal notes ----------
export async function saveNote(n) {
  n.updatedAt = Date.now();
  if (!n.id) { n.id = uid(); n.createdAt = n.updatedAt; state.notes.push(n); }
  await db.put('notes', n);
  emit('notes');
  return n;
}
export async function deleteNote(id) { await db.del('notes', id); state.notes = state.notes.filter((n) => n.id !== id); emit('notes'); }

// ---------- reading log ----------
export async function logReading(bookId, seconds) {
  const key = dayKey();
  let d = state.days.find((x) => x.date === key);
  if (!d) { d = { date: key, seconds: 0, books: {} }; state.days.push(d); }
  d.seconds += seconds;
  d.books[bookId] = (d.books[bookId] || 0) + seconds;
  await db.put('days', d);
  const b = bookById(bookId);
  if (b) { b.readingSeconds = (b.readingSeconds || 0) + seconds; await db.put('books', b); }
  emit('reading-log');
}

export function streak() {
  const set = new Set(state.days.filter((d) => d.seconds >= 60).map((d) => d.date));
  let n = 0;
  const d = new Date();
  if (!set.has(dayKey(d))) d.setDate(d.getDate() - 1);   // today not read yet: streak still counts through yesterday
  while (set.has(dayKey(d))) { n++; d.setDate(d.getDate() - 1); }
  return n;
}
export function todaySeconds() { return state.days.find((d) => d.date === dayKey())?.seconds || 0; }

// ---------- backup ----------
export async function exportBackup() {
  const [books, annotations, bookmarks, notes, collections, days] = await Promise.all(['books', 'annotations', 'bookmarks', 'notes', 'collections', 'days'].map((s) => db.all(s)));
  return JSON.stringify({ app: 'marginalia', version: 1, exportedAt: new Date().toISOString(), books, annotations, bookmarks, notes, collections, days, reading: state.reading, ui: state.ui }, null, 1);
}

export async function importBackup(text) {
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('This file is not a valid backup (it is not JSON).'); }
  if (data.app !== 'marginalia') throw new Error('This JSON file is not a Marginalia backup.');
  let added = 0;
  for (const b of data.books || []) {
    if (bookById(b.id)) continue;
    const hasFile = await db.get('files', b.id);
    b.missingFile = !hasFile;
    b.hasCover = false;
    b.indexed = false;
    await db.put('books', b); state.books.push(b); added++;
  }
  for (const [store, key] of [['annotations', 'annotations'], ['bookmarks', 'bookmarks'], ['notes', 'notes'], ['collections', 'collections'], ['days', 'days']]) {
    const have = new Set(state[key].map((x) => x.id || x.date));
    const fresh = (data[store] || []).filter((x) => !have.has(x.id || x.date));
    if (fresh.length) { await db.putMany(store, fresh); state[key].push(...fresh); }
  }
  if (data.reading) await saveReading(data.reading);
  if (data.ui) await saveUI({ ...data.ui });
  emit('change');
  return added;
}

export async function clearEverything() {
  for (const s of ['books', 'files', 'covers', 'texts', 'reflow', 'annotations', 'bookmarks', 'notes', 'collections', 'days', 'kv']) await db.clear(s);
  for (const u of state.coverUrls.values()) u.then((x) => x && URL.revokeObjectURL(x));
  Object.assign(state, { books: [], collections: [], annotations: [], bookmarks: [], notes: [], days: [], reading: { ...DEFAULT_READING }, ui: { ...DEFAULT_UI }, coverUrls: new Map() });
  emit('change');
}

export { UnsupportedError };
