// Free public-domain books from Project Gutenberg (catalogue via the Gutendex API).
// Gutenberg's file servers don't allow downloads from web apps, so book files (and the
// catalogue, if needed) go through a tiny relay that forwards only Gutenberg requests.

import { db } from './db.js';

export const RELAY = 'https://marginalia-books.vercel.app';
const GUTENDEX = 'https://gutendex.com';

// Hand-picked shelves ship with the app, so they appear instantly and offline.
const B = (id, title, author) => ({ id, title, author, authors: [author], cover: coverUrl(id), subjects: [], languages: ['en'], downloads: 0, hasEpub: true, summary: '' });
// Covers come from Gutenberg's own pglaf mirror through the relay: it stays up when gutenberg.org is down.
export const coverUrl = (id) => `https://marginalia-books.vercel.app/pglaf/cache/epub/${id}/pg${id}.cover.medium.jpg`;
export const SHELVES = [
  { key: 'start', label: 'Start here', books: [B(1342, 'Pride and Prejudice', 'Jane Austen'), B(84, 'Frankenstein', 'Mary Shelley'), B(64317, 'The Great Gatsby', 'F. Scott Fitzgerald'), B(1661, 'The Adventures of Sherlock Holmes', 'Arthur Conan Doyle'), B(11, 'Alice’s Adventures in Wonderland', 'Lewis Carroll'), B(174, 'The Picture of Dorian Gray', 'Oscar Wilde'), B(345, 'Dracula', 'Bram Stoker'), B(2701, 'Moby-Dick', 'Herman Melville'), B(1260, 'Jane Eyre', 'Charlotte Brontë'), B(5200, 'Metamorphosis', 'Franz Kafka')] },
  { key: 'women', label: 'Women writers & women’s lives', books: [B(3420, 'A Vindication of the Rights of Woman', 'Mary Wollstonecraft'), B(160, 'The Awakening', 'Kate Chopin'), B(32, 'Herland', 'Charlotte Perkins Gilman'), B(1952, 'The Yellow Wallpaper', 'Charlotte Perkins Gilman'), B(145, 'Middlemarch', 'George Eliot'), B(541, 'The Age of Innocence', 'Edith Wharton'), B(4276, 'North and South', 'Elizabeth Gaskell'), B(768, 'Wuthering Heights', 'Emily Brontë'), B(1260, 'Jane Eyre', 'Charlotte Brontë'), B(514, 'Little Women', 'Louisa May Alcott')] },
  { key: 'mystery', label: 'Mystery & adventure', books: [B(2852, 'The Hound of the Baskervilles', 'Arthur Conan Doyle'), B(244, 'A Study in Scarlet', 'Arthur Conan Doyle'), B(2097, 'The Sign of the Four', 'Arthur Conan Doyle'), B(120, 'Treasure Island', 'Robert Louis Stevenson'), B(1184, 'The Count of Monte Cristo', 'Alexandre Dumas'), B(1257, 'The Three Musketeers', 'Alexandre Dumas'), B(103, 'Around the World in Eighty Days', 'Jules Verne'), B(164, 'Twenty Thousand Leagues under the Sea', 'Jules Verne'), B(215, 'The Call of the Wild', 'Jack London'), B(521, 'Robinson Crusoe', 'Daniel Defoe')] },
  { key: 'love', label: 'Love & society', books: [B(158, 'Emma', 'Jane Austen'), B(161, 'Sense and Sensibility', 'Jane Austen'), B(105, 'Persuasion', 'Jane Austen'), B(768, 'Wuthering Heights', 'Emily Brontë'), B(514, 'Little Women', 'Louisa May Alcott'), B(2542, 'A Doll’s House', 'Henrik Ibsen'), B(98, 'A Tale of Two Cities', 'Charles Dickens'), B(1400, 'Great Expectations', 'Charles Dickens'), B(33, 'The Scarlet Letter', 'Nathaniel Hawthorne'), B(2814, 'Dubliners', 'James Joyce')] },
  { key: 'strange', label: 'Strange & gothic', books: [B(43, 'The Strange Case of Dr Jekyll and Mr Hyde', 'Robert Louis Stevenson'), B(35, 'The Time Machine', 'H. G. Wells'), B(36, 'The War of the Worlds', 'H. G. Wells'), B(1952, 'The Yellow Wallpaper', 'Charlotte Perkins Gilman'), B(932, 'The Fall of the House of Usher', 'Edgar Allan Poe'), B(219, 'Heart of Darkness', 'Joseph Conrad'), B(829, 'Gulliver’s Travels', 'Jonathan Swift'), B(1080, 'A Modest Proposal', 'Jonathan Swift')] },
  { key: 'ideas', label: 'Ideas & philosophy', books: [B(2680, 'Meditations', 'Marcus Aurelius'), B(132, 'The Art of War', 'Sun Tzu'), B(1232, 'The Prince', 'Niccolò Machiavelli'), B(1497, 'The Republic', 'Plato'), B(2500, 'Siddhartha', 'Hermann Hesse'), B(205, 'Walden', 'Henry David Thoreau'), B(4363, 'Beyond Good and Evil', 'Friedrich Nietzsche'), B(58585, 'The Prophet', 'Kahlil Gibran')] },
  { key: 'children', label: 'Children’s classics', books: [B(16, 'Peter Pan', 'J. M. Barrie'), B(55, 'The Wonderful Wizard of Oz', 'L. Frank Baum'), B(45, 'Anne of Green Gables', 'L. M. Montgomery'), B(113, 'The Secret Garden', 'Frances Hodgson Burnett'), B(236, 'The Jungle Book', 'Rudyard Kipling'), B(289, 'The Wind in the Willows', 'Kenneth Grahame'), B(12, 'Through the Looking-Glass', 'Lewis Carroll'), B(2591, 'Grimms’ Fairy Tales', 'Jacob and Wilhelm Grimm'), B(74, 'The Adventures of Tom Sawyer', 'Mark Twain'), B(76, 'Adventures of Huckleberry Finn', 'Mark Twain')] },
  { key: 'mind', label: 'Mind, meaning & self-understanding', books: [B(621, 'The Varieties of Religious Experience', 'William James'), B(2680, 'Meditations', 'Marcus Aurelius'), B(4507, 'As a Man Thinketh', 'James Allen'), B(38219, 'The Interpretation of Dreams', 'Sigmund Freud'), B(5827, 'The Problems of Philosophy', 'Bertrand Russell'), B(3600, 'The Essays of Montaigne', 'Michel de Montaigne'), B(205, 'Walden', 'Henry David Thoreau')] },
  { key: 'myth', label: 'Fairy tales, myths & wild stories', books: [B(2591, 'Grimms’ Fairy Tales', 'Jacob and Wilhelm Grimm'), B(1597, 'Andersen’s Fairy Tales', 'Hans Christian Andersen'), B(503, 'The Blue Fairy Book', 'Andrew Lang'), B(540, 'The Red Fairy Book', 'Andrew Lang'), B(4928, 'Bulfinch’s Mythology', 'Thomas Bulfinch'), B(21, 'Aesop’s Fables', 'Aesop')] },
  { key: 'poetry', label: 'Poetry', books: [B(1041, 'Shakespeare’s Sonnets', 'William Shakespeare'), B(1322, 'Leaves of Grass', 'Walt Whitman'), B(12242, 'Poems', 'Emily Dickinson'), B(1065, 'The Raven', 'Edgar Allan Poe'), B(20, 'Paradise Lost', 'John Milton'), B(1001, 'Dante’s Inferno', 'Dante Alighieri')] },
  { key: 'history', label: 'History & big ideas', books: [B(1404, 'The Federalist Papers', 'Hamilton, Madison and Jay'), B(23, 'Narrative of the Life of Frederick Douglass', 'Frederick Douglass'), B(147, 'Common Sense', 'Thomas Paine'), B(61, 'The Communist Manifesto', 'Karl Marx and Friedrich Engels'), B(2376, 'Up from Slavery', 'Booker T. Washington'), B(408, 'The Souls of Black Folk', 'W. E. B. Du Bois'), B(148, 'The Autobiography of Benjamin Franklin', 'Benjamin Franklin')] },
  { key: 'big', label: 'The big ones', books: [B(2600, 'War and Peace', 'Leo Tolstoy'), B(2554, 'Crime and Punishment', 'Fyodor Dostoyevsky'), B(135, 'Les Misérables', 'Victor Hugo'), B(996, 'Don Quixote', 'Miguel de Cervantes'), B(1727, 'The Odyssey', 'Homer'), B(766, 'David Copperfield', 'Charles Dickens'), B(4300, 'Ulysses', 'James Joyce'), B(100, 'The Complete Works of William Shakespeare', 'William Shakespeare')] },
];
const CURATED = SHELVES.flatMap((s) => s.books.map((b) => ({ ...b, shelf: s.key })));

/** Categories: live catalogue topics, with keyword search and bundled shelves as fallbacks. */
export const CATEGORIES = [
  { key: 'literature', label: 'Literature', topic: 'literature', query: 'fiction', shelves: ['start', 'love', 'big'] },
  { key: 'women', label: 'Her story', topic: 'women', query: 'women', shelves: ['women', 'myth'] },
  { key: 'health', label: 'Health', topic: 'health', query: 'health', shelves: [] },
  { key: 'mind', label: 'Mind & mental health', topic: 'psychology', query: 'psychology', shelves: ['mind'] },
  { key: 'classics', label: 'Classics', topic: 'classics', query: 'classics', shelves: ['start', 'big'] },
  { key: 'philosophy', label: 'Philosophy', topic: 'philosophy', query: 'philosophy', shelves: ['ideas', 'mind'] },
  { key: 'poetry', label: 'Poetry', topic: 'poetry', query: 'poetry', shelves: ['poetry'] },
  { key: 'mystery', label: 'Mystery', topic: 'detective', query: 'detective', shelves: ['mystery'] },
  { key: 'adventure', label: 'Adventure', topic: 'adventure', query: 'adventure', shelves: ['mystery'] },
  { key: 'scifi', label: 'Science fiction', topic: 'science fiction', query: 'science fiction', shelves: ['strange'] },
  { key: 'history', label: 'History', topic: 'history', query: 'history', shelves: ['history'] },
  { key: 'cooking', label: 'Cooking', topic: 'cooking', query: 'cooking', shelves: [] },
  { key: 'children', label: 'Children', topic: 'children', query: 'juvenile fiction', shelves: ['children', 'myth'] },
];

/** Map subject headings to the app's categories (used for your own library too). */
const CAT_RULES = [
  ['women', /\b(women|woman|feminis|girls?\b|mothers?|wives|sisters|gender|sexuality)/i],
  ['health', /\b(health|medicine|medical|hygiene|nutrition|diet|nursing|disease|fitness|exercise|physiology)/i],
  ['mind', /\b(psycholog|mental|psychiatr|mind|anxiety|depression|happiness|self-help|conduct of life|emotions|consciousness|dreams)/i],
  ['philosophy', /\b(philosoph|ethics|stoic|metaphysic|logic)/i],
  ['poetry', /\b(poetry|poems|verse|sonnets)/i],
  ['mystery', /\b(detective|mystery|crime|murder)/i],
  ['adventure', /\b(adventure|voyages|sea stories|pirates|explor)/i],
  ['scifi', /\b(science fiction|time travel|space|martians|utopia)/i],
  ['history', /\b(history|historical|biograph|memoir|war\b)/i],
  ['cooking', /\b(cook|recipes|food|baking)/i],
  ['children', /\b(juvenile|children|fairy tales|nursery)/i],
  ['literature', /\b(fiction|novel|literature|stories|drama|plays|short stories|romance)/i],
];
export function categorize(subjects = [], extra = []) {
  const text = subjects.join(' | ');
  const out = new Set(extra);
  for (const [k, re] of CAT_RULES) if (re.test(text)) out.add(k);
  return [...out];
}
export const categoryLabel = (k) => CATEGORIES.find((c) => c.key === k)?.label || k;

export const LANGUAGES = [['en', 'English'], ['fr', 'French'], ['de', 'German'], ['es', 'Spanish'], ['it', 'Italian'], ['pt', 'Portuguese'], ['nl', 'Dutch'], ['fi', 'Finnish'], ['zh', 'Chinese'], ['tl', 'Tagalog']];

const mem = new Map();
const qs = (o) => Object.entries(o).filter(([, v]) => v != null && v !== '').map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');

/** fetch with a hard time limit, so a stalled server can't leave the page searching forever. */
async function fetchT(url, ms = 7000, init = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, { mode: 'cors', ...init, signal: ac.signal }); } finally { clearTimeout(t); }
}

async function getJson(path) {
  // Ask the catalogue directly and through the relay at the same time; first good answer wins.
  const tries = [`${GUTENDEX}${path}`, `${RELAY}/gutendex${path.replace(/^\/books\/\?/, '/books?')}`];
  try {
    return await Promise.any(tries.map(async (url) => {
      const r = await fetchT(url, 7000);
      if (!r.ok || /text\/html/.test(r.headers.get('content-type') || '')) throw new Error(`The catalogue answered ${r.status}.`);
      return r.json();
    }));
  } catch (e) {
    console.warn('catalogue', e);
    throw new Error(navigator.onLine ? 'The free-book catalogue can’t be reached right now. Try again in a moment.' : 'You’re offline. Connect to the internet to browse free books.');
  }
}

function normalize(b) {
  const authors = (b.authors || []).map((a) => {
    const [last, first] = (a.name || '').split(/,\s*/);
    return first ? `${first.replace(/\s*\(.*\)$/, '')} ${last}` : last;
  });
  const cover = coverUrl(b.id);
  const hasEpub = Object.keys(b.formats || {}).some((k) => k.startsWith('application/epub'));
  const hasText = Object.keys(b.formats || {}).some((k) => k.startsWith('text/plain'));
  return {
    id: b.id, title: (b.title || 'Untitled').replace(/\s*\r?\n\s*/g, ': ').replace(/[;:]\s*$/, ''),
    authors, author: authors.join(', '), cover, subjects: [...(b.subjects || []), ...(b.bookshelves || [])].map((s) => s.replace(/^Browsing:\s*/, '').replace(/ -- .*$/, '')).filter((s, i, a) => a.indexOf(s) === i).slice(0, 6),
    languages: b.languages || [], downloads: b.download_count || 0, hasEpub, hasText, summary: (b.summaries || [])[0] || '',
  };
}

/** The books that ship with the app for a category (no network needed). */
export function localForCategory(key) {
  const c = CATEGORIES.find((x) => x.key === key);
  const seen = new Set();
  return c ? CURATED.filter((b) => c.shelves.includes(b.shelf) && !seen.has(b.id) && seen.add(b.id)) : [];
}

/** A pasted Project Gutenberg link or number → a single book that can be added even when the catalogue is down. */
export function bookFromLink(q) {
  const m = String(q).trim().match(/^(?:https?:\/\/)?(?:www\.)?(?:gutenberg\.org\/(?:ebooks|files|cache\/epub)\/)?(\d{1,6})(?:[\/.?#].*)?$/i);
  if (!m || (!/gutenberg/i.test(q) && !/^\d{2,6}$/.test(q.trim()))) return null;
  const id = +m[1];
  const known = CURATED.find((b) => b.id === id);
  return known || B(id, `Project Gutenberg #${id}`, '');
}

/** Search the whole Project Gutenberg catalogue. Returns {books, next, count, source}. */
export async function search({ q = '', cat = null, lang = 'en', page = 1 } = {}) {
  const c = cat ? CATEGORIES.find((x) => x.key === cat) : null;
  const key = `free:${lang}:${page}:${c ? 'cat:' + c.key : q.toLowerCase()}`;
  if (mem.has(key)) return mem.get(key);
  let out = null;
  // 1) Gutendex JSON API
  try {
    const data = await getJson(`/books/?${qs({ search: c ? null : q, topic: c ? c.topic : null, languages: lang, page: page > 1 ? page : null, mime_type: 'application/epub' })}`);
    out = { books: (data.results || []).map(normalize).filter((b) => b.hasEpub), next: data.next ? page + 1 : null, count: data.count || 0, source: 'catalogue' };
  } catch {}
  // 2) Project Gutenberg's own OPDS search
  if (!out) {
    try { out = await opdsSearch(c ? c.query : q, page); } catch {}
  }
  // 3) Open Library / Internet Archive: a second, independent catalogue of free-to-read books
  if (!out) {
    try { out = await openLibrarySearch(c ? { topic: c.topic } : { q }, lang, page); } catch (e) { console.warn('openlibrary', e); }
    if (out && !out.books.length) out = null;
  }
  if (out) { mem.set(key, out); db.kvSet(key, { at: Date.now(), out }).catch(() => {}); return out; }
  const cached = await db.kvGet(key).catch(() => null);
  if (cached) return { ...cached.out, offline: true };
  // 4) Offline: search the shelves that ship with the app
  const needle = q.toLowerCase();
  const seen = new Set();
  const local = CURATED.filter((b) => (c ? c.shelves.includes(b.shelf) : (b.title + ' ' + b.author).toLowerCase().includes(needle)) && !seen.has(b.id) && seen.add(b.id));
  return { books: local, next: null, count: local.length, source: 'shelves', unavailable: true };
}

const OL_LANG = { en: 'eng', fr: 'fre', de: 'ger', es: 'spa', it: 'ita', pt: 'por', nl: 'dut', fi: 'fin', zh: 'chi', tl: 'tgl' };
/** Open Library search, limited to books that can be read and downloaded for free. */
async function openLibrarySearch({ q, topic }, lang, page) {
  const url = `https://openlibrary.org/search.json?${qs({ q: topic ? null : q, subject: topic || null, has_fulltext: 'true', ebook_access: 'public', language: OL_LANG[lang] || 'eng', fields: 'key,title,author_name,cover_i,ia,first_publish_year,subject,ebook_access,public_scan_b', limit: 24, page: page > 1 ? page : null, sort: topic ? 'readinglog' : null })}`;
  const r = await fetchT(url, 8000);
  if (!r.ok) throw new Error('openlibrary ' + r.status);
  const data = await r.json();
  // Only truly free scans. 'borrowable' and 'printdisabled' books are in copyright and can only be borrowed on archive.org.
  const books = (data.docs || []).filter((d) => Array.isArray(d.ia) && d.ia.length && d.title && (d.ebook_access === 'public' || (d.ebook_access == null && d.public_scan_b === true))).map((d) => ({
    id: 'ia:' + d.ia[0], ia: d.ia[0], title: d.title, author: (d.author_name || [])[0] || '', authors: d.author_name || [],
    cover: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-M.jpg` : '', subjects: (d.subject || []).slice(0, 8), languages: [lang],
    downloads: 0, hasEpub: true, summary: '', from: 'Open Library', page: `https://archive.org/details/${d.ia[0]}`,
  }));
  const total = data.numFound || 0;
  return { books, next: page * 24 < total ? page + 1 : null, count: total, source: 'openlibrary' };
}

async function opdsSearch(q, page) {
  const start = (page - 1) * 25 + 1;
  const url = `${RELAY}/gutenberg/ebooks/search.opds?${qs({ query: q, sort_order: 'downloads', start_index: start > 1 ? start : null })}`;
  const r = await fetchT(url, 7000);
  if (!r.ok || /text\/html/.test(r.headers.get('content-type') || '')) throw new Error('opds ' + r.status);
  const xml = new DOMParser().parseFromString(await r.text(), 'application/xml');
  const books = [];
  for (const e of xml.getElementsByTagName('entry')) {
    const links = [...e.getElementsByTagName('link')].map((l) => l.getAttribute('href') || '');
    const idm = links.concat([e.getElementsByTagName('id')[0]?.textContent || '']).join(' ').match(/ebooks\/(\d+)/);
    if (!idm) continue;
    const id = +idm[1];
    const title = e.getElementsByTagName('title')[0]?.textContent?.trim() || 'Untitled';
    const author = e.getElementsByTagName('name')[0]?.textContent?.trim() || '';
    books.push({ ...B(id, title, author.includes(',') ? author.split(/,\s*/).reverse().join(' ') : author) });
  }
  return { books, next: books.length >= 25 ? page + 1 : null, count: books.length, source: 'opds' };
}

/** Download a book's EPUB through the relay. Returns a File. */
async function readBlob(r, type, onProgress) {
  const total = +r.headers.get('content-length') || 0;
  const reader = r.body?.getReader?.();
  if (!reader) return r.blob();
  const chunks = []; let got = 0;
  for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); got += value.length; onProgress?.(total ? got / total : null); }
  return new Blob(chunks, { type });
}

/** Internet Archive books: try an EPUB first, then the PDF scan. */
async function downloadArchive(book, onProgress) {
  const safe = `${book.title}${book.author ? ' - ' + book.author : ''}`.replace(/[\\/:*?"<>|]+/g, '').slice(0, 90);
  for (const [ext, type] of [['epub', 'application/epub+zip'], ['pdf', 'application/pdf']]) {
    let r;
    try { r = await fetch(`https://archive.org/download/${book.ia}/${book.ia}.${ext}`, { mode: 'cors' }); }
    catch { throw new Error(navigator.onLine ? 'The Internet Archive didn’t answer. Try again in a moment, or open the book on archive.org.' : 'You’re offline. Connect to the internet to download books.'); }
    if (r.status === 401 || r.status === 403) throw new Error('This book is still in copyright. The Internet Archive only lends it: borrow it on archive.org with a free account. It can’t be downloaded into Marginalia.');
    if (!r.ok || /text\/html/.test(r.headers.get('content-type') || '')) continue;
    const blob = await readBlob(r, type, onProgress);
    if (blob.size > 1000) return new File([blob], `${safe}.${ext}`, { type });
  }
  throw new Error('This book can’t be downloaded from the Internet Archive. Use “View on Internet Archive” to read it there.');
}

async function isZip(blob) {
  const b = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
  return b[0] === 0x50 && b[1] === 0x4b && b[2] === 3 && b[3] === 4;
}

export async function downloadBook(book, onProgress) {
  if (book.ia) return downloadArchive(book, onProgress);
  const id = book.id;
  const files = [`pg${id}-images-3.epub`, `pg${id}-images.epub`, `pg${id}.epub`];
  // Gutenberg's own mirrors first (pglaf, then Old Dominion University); they stay up when gutenberg.org is down.
  const paths = [
    ...files.map((f) => `/pglaf/cache/epub/${id}/${f}`),
    ...files.map((f) => `/odu/epub/${id}/${f}`),
    ...files.map((f) => `/aleph/cache/epub/${id}/${f}`),
    ...files.map((f) => `/gutenberg/cache/epub/${id}/${f}`),
  ];
  let lastStatus = 0;
  for (const p of paths) {
    let r;
    try { r = await fetchT(`${RELAY}${p}`, 20000); }
    catch { if (!navigator.onLine) throw new Error('You’re offline. Connect to the internet to download books.'); lastStatus = 503; continue; }
    if (!r.ok || /text\/html/.test(r.headers.get('content-type') || '')) { lastStatus = r.ok ? 503 : r.status; continue; }
    const total = +r.headers.get('content-length') || 0;
    const reader = r.body?.getReader?.();
    let blob;
    if (reader) {
      const chunks = []; let got = 0;
      for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); got += value.length; onProgress?.(total ? got / total : null); }
      blob = new Blob(chunks, { type: 'application/epub+zip' });
    } else blob = await r.blob();
    if (blob.size < 1000 || !(await isZip(blob))) { lastStatus = 503; continue; }   // an error page, not a book
    const safe = `${book.title}${book.author ? ' - ' + book.author : ''}`.replace(/[\\/:*?"<>|]+/g, '').slice(0, 90);
    return new File([blob], `${safe}.epub`, { type: 'application/epub+zip' });
  }
  throw new Error(lastStatus === 404 ? 'Project Gutenberg doesn’t have an EPUB for this book.' : lastStatus === 503 ? 'Project Gutenberg and its mirrors didn’t send this book right now. Try again in a while.' : `The download failed (${lastStatus || 'network'}). Try again later.`);
}

export const gutenbergPage = (id) => `https://www.gutenberg.org/ebooks/${id}`;
