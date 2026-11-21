// Markdown export of highlights, notes and bookmarks.

import { state } from './store.js';
import { saveFile, toast } from './util.js';
import { HL_COLORS } from './settings.js';

export function annotationsMarkdown(books, annsByBook, opts = {}) {
  const lines = [];
  if (opts.heading) lines.push(`# ${opts.heading}`, '');
  for (const book of books) {
    const anns = (annsByBook.get(book.id) || []).slice().sort((a, b) => (a.progress || 0) - (b.progress || 0));
    const marks = opts.includeBookmarks ? state.bookmarks.filter((b) => b.bookId === book.id).sort((a, b) => a.progress - b.progress) : [];
    if (!anns.length && !marks.length) continue;
    lines.push(`${opts.heading ? '##' : '#'} ${book.title}`);
    if (book.author) lines.push(`*${book.author}*`);
    lines.push('');
    let chapter = null;
    for (const a of anns) {
      if (a.chapter && a.chapter !== chapter) { chapter = a.chapter; lines.push(`${opts.heading ? '###' : '##'} ${chapter}`, ''); }
      const tag = [HL_COLORS[a.color]?.label, a.style !== 'highlight' ? a.style : null, a.pageLabel].filter(Boolean).join(' · ');
      lines.push(...a.text.split('\n').map((l) => `> ${l}`));
      if (a.note) lines.push('', `**Note:** ${a.note}`);
      lines.push('', `<sub>${tag} · ${new Date(a.createdAt).toLocaleDateString()}</sub>`, '');
    }
    if (marks.length) {
      lines.push(`${opts.heading ? '###' : '##'} Bookmarks`, '');
      for (const m of marks) lines.push(`- ${m.label || 'Bookmark'} (${m.pageLabel || Math.round(m.progress * 100) + '%'})`);
      lines.push('');
    }
  }
  return lines.join('\n');
}

export async function exportBookAnnotations(book) {
  const anns = state.annotations.filter((a) => a.bookId === book.id);
  if (!anns.length && !state.bookmarks.some((b) => b.bookId === book.id)) { toast('This book has no highlights, notes or bookmarks yet.'); return; }
  const md = annotationsMarkdown([book], new Map([[book.id, anns]]), { includeBookmarks: true });
  report(await saveFile(`${safeName(book.title)} - highlights.md`, md, 'text/markdown'));
}

export async function exportAnnotationList(list, heading) {
  if (!list.length) { toast('Nothing to export with the current filters.'); return; }
  const byBook = new Map();
  for (const a of list) { if (!byBook.has(a.bookId)) byBook.set(a.bookId, []); byBook.get(a.bookId).push(a); }
  const books = state.books.filter((b) => byBook.has(b.id));
  const md = annotationsMarkdown(books, byBook, { heading });
  report(await saveFile(`${safeName(heading)}.md`, md, 'text/markdown'));
}

export function report(r) {
  if (r === 'saved') toast('Export ready');
  else if (r === 'copied') toast('Downloads aren’t available here, so the export was copied to your clipboard as Markdown.');
  else if (r === 'declined') toast('Export cancelled');
  else toast('Export failed. Try again.', { kind: 'error' });
}

export const safeName = (s) => String(s || 'export').replace(/[\\/:*?"<>|]+/g, '').slice(0, 80).trim() || 'export';
