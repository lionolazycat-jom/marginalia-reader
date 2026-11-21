// Book view for PDFs: rebuilds a PDF's text as a reflowable e-book.
// Lines are rebuilt from positioned text, running headers/footers and page numbers are dropped,
// hyphenated line breaks are joined, paragraphs and headings are detected from spacing and
// font size, and chapters come from the PDF's outline (or its large headings).

import { pdfOutline } from './pdfcore.js';

export const REFLOW_VERSION = 5;

const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };

/** onProgress(fraction). Returns {chapters:[{title, html}], toc, pageToChapter, scanned:boolean}. */
export async function reflowPdf(doc, onProgress, signal, opts = {}) {
  const n = doc.numPages;
  const pages = [];
  for (let i = 0; i < n; i++) {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    const page = await doc.getPage(i + 1);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent({ disableNormalization: false });
    pages.push({ lines: toLines(tc, vp), width: vp.width, height: vp.height });
    page.cleanup();
    if (i % 4 === 3) { onProgress?.((i + 1) / n * 0.85); await new Promise((r) => setTimeout(r)); }
  }
  const chars = pages.reduce((s, p) => s + p.lines.reduce((t, l) => t + l.text.length, 0), 0);
  if (chars < Math.max(80, n * 25)) return { scanned: true, chapters: [], toc: [], pageToChapter: [] };

  stripRunningLines(pages);
  const allLines = pages.flatMap((p) => p.lines);
  // Body text size: the size carrying the most characters.
  const bySize = new Map();
  for (const l of allLines) { const k = Math.round(l.size * 2) / 2; bySize.set(k, (bySize.get(k) || 0) + l.text.length); }
  const body = [...bySize.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 11;
  const headingSizes = [...new Set(allLines.filter((l) => l.size >= body * 1.18 && l.text.length < 140).map((l) => Math.round(l.size)))].sort((a, b) => b - a);
  const level = (size) => { const i = headingSizes.indexOf(Math.round(size)); return i < 0 ? 0 : Math.min(3, i + 1); };

  // Blocks: {type:'p'|'h', level, text, page}. Automatic mode keeps paragraphs apart using spacing and indents;
  // if that leaves the book in tiny fragments (a sign the PDF's spacing is unusual), the text is joined more firmly.
  let mode = opts.mode === 'join' ? 'join' : 'auto';
  let blocks = buildBlocks(pages, body, level, mode);
  if (mode === 'auto' && fragmented(blocks)) { mode = 'join'; blocks = buildBlocks(pages, body, level, mode); }
  onProgress?.(0.92);

  // Chapters: outline first, then big headings, then fixed page ranges.
  const outline = (await pdfOutline(doc).catch(() => [])).filter((o) => o.page != null);
  const top = outline.filter((o) => o.depth === 0);
  let starts = [];   // [{page, title}]
  if (top.length >= 2) starts = top.map((o) => ({ page: o.page, title: o.label }));
  else {
    const big = blocks.filter((b) => b.type === 'h' && b.level === 1);
    if (big.length >= 2 && big.length < blocks.length / 3) starts = big.map((b) => ({ page: b.page, title: b.text, block: b }));
  }
  const chapters = [];
  const pageToChapter = new Array(n).fill(0);
  if (!starts.length) {
    const per = 20;
    for (let p = 0; p < n; p += per) starts.push({ page: p, title: n > per ? `Pages ${p + 1}–${Math.min(n, p + per)}` : 'Text' });
  }
  starts.sort((a, b) => a.page - b.page);
  if (starts[0].page > 0) starts.unshift({ page: 0, title: 'Opening' });
  let bi = 0;
  for (let ci = 0; ci < starts.length; ci++) {
    const end = starts[ci + 1]?.page ?? n;
    const parts = [];
    let lastPage = -1;
    while (bi < blocks.length && (blocks[bi].page < end || ci === starts.length - 1)) {
      const b = blocks[bi];
      // When chapters come from headings, the next chapter's heading starts it.
      if (starts[ci + 1]?.block === b) break;
      if (b.page !== lastPage) { parts.push(`<span class="pdf-pg" id="c${ci}-pg${b.page}" data-p="${b.page}"></span>`); lastPage = b.page; }
      if (b.type === 'h') { const lv = Math.min(4, Math.max(2, b.level + 1)); parts.push(`<h${lv}>${esc(typo(b.text))}</h${lv}>`); }
      else if (b.type === 'toc') parts.push(`<p class="x-toc"><span class="t">${esc(typo(b.title))}</span><span class="n">${esc(b.num)}</span></p>`);
      else parts.push(`<p${b.small ? ' class="x-small"' : ''}>${esc(typo(b.text))}</p>`);
      bi++;
    }
    for (let p = starts[ci].page; p < end; p++) pageToChapter[p] = chapters.length;
    if (!parts.some((x) => x.startsWith('<p') || x.startsWith('<h'))) {
      // Empty section (e.g. outline entries on the same page): fold into the next one.
      continue;
    }
    chapters.push({ title: starts[ci].title, html: parts.join('\n'), page: starts[ci].page });
  }
  // Fix chapter mapping after folding empty sections.
  for (let p = 0; p < n; p++) {
    let c = 0;
    chapters.forEach((ch, i) => { if (ch.page <= p) c = i; });
    pageToChapter[p] = c;
  }
  const toc = top.length >= 2
    ? outline.map((o) => ({ label: o.label, chapter: pageToChapter[o.page], id: `c${pageToChapter[o.page]}-pg${o.page}`, depth: o.depth }))
    : chapters.map((c, i) => ({ label: c.title, chapter: i, id: '', depth: 0 }));
  // Page markers carry ids per chapter; renumber them to the final chapter index.
  chapters.forEach((c, i) => { c.html = c.html.replace(/id="c\d+-pg(\d+)"/g, `id="c${i}-pg$1"`); });
  onProgress?.(1);
  return { chapters, toc: toc.filter((t) => chapters[t.chapter]), pageToChapter, scanned: false, mode };
}

function buildBlocks(pages, body, level, mode) {
  const blocks = [];
  let para = null;
  const flush = () => { if (para && para.text.trim()) blocks.push(para); para = null; };
  for (let pi = 0; pi < pages.length; pi++) {
    const { lines } = pages[pi];
    if (!lines.length) continue;
    const bodyLines = lines.filter((l) => Math.abs(l.size - body) < body * 0.15);
    const left = median(bodyLines.map((l) => l.x0)) || Math.min(...lines.map((l) => l.x0));
    const right = Math.max(...(bodyLines.length ? bodyLines : lines).map((l) => l.x1));
    const gaps = [];
    for (let i = 1; i < lines.length; i++) { const g = lines[i - 1].y - lines[i].y; if (g > 0 && Math.abs(lines[i].size - body) < body * 0.15) gaps.push(g); }
    const lineGap = median(gaps) || body * 1.25;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i], prev = lines[i - 1];
      const toc = tocParts(l.text);
      if (toc) { flush(); blocks.push({ type: 'toc', title: toc.title, num: toc.num, text: toc.title, page: pi, size: l.size }); continue; }
      const isHead = l.size >= body * 1.18 && l.text.length < 140 && !/[.,;]$/.test(l.text) ? level(l.size) || 3
        : (l.bold && l.text.length < 90 && !/[.,;:]$/.test(l.text) && (!prev || prev.y - l.y > lineGap * 1.3) && (!lines[i + 1] || l.y - lines[i + 1].y > lineGap * 1.3) && /^[\p{Lu}\d]/u.test(l.text) ? 4 : 0);
      if (isHead) {
        // Multi-line headings at the same size join together.
        if (para && para.type === 'h' && para.page === pi && Math.abs(para.size - l.size) < 0.6 && prev && prev.y - l.y < l.size * 1.9) { para.text += ' ' + l.text; continue; }
        flush();
        para = { type: 'h', level: isHead, text: l.text, page: pi, size: l.size };
        continue;
      }
      let newPara = !para || para.type === 'h';
      if (!newPara && prev) {
        const gap = prev.y - l.y;
        const prevShort = prev.x1 < right - body * (mode === 'join' ? 9 : 5);
        const indented = l.x0 > left + body * 0.9 && l.x0 < left + body * 6;
        const ends = /[.!?:"”’)\]…]$/.test(prev.text);
        if (gap < 0) newPara = !(prev.x1 > left && l.x0 <= left + body);     // new column or page region
        else if (gap > lineGap * (mode === 'join' ? 1.7 : 1.35)) newPara = true;
        else if (mode !== 'join' && indented && ends && prevShort) newPara = true;
        else if (mode !== 'join' && prevShort && ends && gap > lineGap * 1.2) newPara = true;
        else if (/^([•▪◦●·\-–—*]|\d{1,2}[.)]|[a-z][.)])\s/.test(l.text)) newPara = true;
        if (Math.abs(l.size - (para.size || body)) > body * 0.25 && !(mode === 'join' && l.size < body * 1.1)) newPara = true;
      }
      if (!newPara && i === 0 && para) {
        // Page break: continue the paragraph unless the last one clearly ended.
        if (/[.!?"”]$/.test(para.text) && /^[\p{Lu}"“‘(\d]/u.test(l.text)) newPara = true;
      }
      if (newPara) { flush(); para = { type: 'p', text: l.text, page: pi, size: l.size, small: l.size < body * 0.86 }; }
      else para.text = joinLines(para.text, l.text);
    }
  }
  flush();
  return blocks;
}

function fragmented(blocks) {
  const ps = blocks.filter((b) => b.type === 'p' && !b.small);
  if (ps.length < 24) return false;
  const lens = ps.map((b) => b.text.length).sort((a, b) => a - b);
  const med = lens[lens.length >> 1];
  const tiny = lens.filter((n) => n < 90).length / lens.length;
  return med < 150 || tiny > 0.45;
}

const LEADER = /(?:\.\s?){4,}|…{2,}|(?:·\s?){4,}/;
const hasLeader = (items) => items.some((it) => LEADER.test(it.str));

/** Table-of-contents line ("Chapter one ........ 14") → {title, num}, or null. */
function tocParts(text) {
  const m = text.match(/^(.{2,}?)\s*(?:(?:\.\s?){4,}|…{2,}|(?:·\s?){4,})\s*([\divxlcIVXLC]{1,6})$/);
  return m ? { title: m[1].trim(), num: m[2] } : null;
}

/** Straight quotes and dashes → typographic ones. */
function typo(t) {
  return t
    .replace(/(^|[\s(\[{\u2014\u2013-])"/g, '$1\u201C').replace(/"/g, '\u201D')
    .replace(/(^|[\s(\[{\u2014\u2013\u201C-])'/g, '$1\u2018').replace(/'/g, '\u2019')
    .replace(/\s--\s/g, ' \u2014 ');
}

function joinLines(a, b) {
  // Rejoin words hyphenated across a line break ("infor-" + "mation").
  if (/\p{L}[-\u2010]$/u.test(a) && /^\p{Ll}/u.test(b)) return a.slice(0, -1) + b;
  if (/[­]$/.test(a)) return a.slice(0, -1) + b;
  return a + (/\s$/.test(a) ? '' : ' ') + b;
}

function toLines(tc, vp) {
  const items = [];
  for (const it of tc.items) {
    if (!it.str || !it.str.trim()) { if (it.hasEOL && items.length) items[items.length - 1].eol = true; continue; }
    const [a, b, c, d, e, f] = it.transform;
    if (Math.abs(b) > Math.abs(a) * 0.3) continue;   // rotated text (margins, stamps)
    const size = Math.hypot(c, d) || Math.abs(d) || 10;
    const style = tc.styles?.[it.fontName] || {};
    const bold = /bold|black|heavy|semibold/i.test(it.fontName + ' ' + (style.fontFamily || ''));
    items.push({ str: it.str, x: e, y: f, w: it.width || it.str.length * size * 0.5, size, bold });
  }
  // Cluster items into baselines, then split each baseline at wide gaps (columns, tables).
  items.sort((p, q) => q.y - p.y);
  const rows = [];
  for (const it of items) {
    const R = rows[rows.length - 1];
    if (R && Math.abs(R.y - it.y) <= Math.min(R.size, it.size) * 0.45) R.items.push(it);
    else rows.push({ y: it.y, size: it.size, items: [it] });
  }
  for (const R of rows) R.items.sort((p, q) => p.x - q.x);
  const build = (items, y, splitGap) => {
    const out = [];
    let L = null;
    for (const it of items) {
      const gap = L ? it.x - L.x1 : 0;
      if (!L || gap > it.size * splitGap) {
        L = { text: it.str, x0: it.x, x1: it.x + it.w, y, size: it.size, sizes: [it.size], bold: it.bold };
        out.push(L);
      } else {
        L.text += gap > it.size * 0.18 && !/\s$/.test(L.text) && !/^\s/.test(it.str) ? ' ' + it.str : it.str;
        L.x1 = Math.max(L.x1, it.x + it.w);
        L.sizes.push(it.size); L.bold = L.bold && it.bold;
      }
    }
    return out;
  };
  // Two columns: look for a vertical channel near the middle that almost no line crosses.
  let gutter = null;
  if (rows.length >= 14) {
    let best = null;
    for (let x = vp.width * 0.36; x <= vp.width * 0.64; x += 3) {
      let cross = 0;
      for (const R of rows) if (R.items.some((it) => it.x < x - 1 && it.x + it.w > x + 1)) cross++;
      if (!best || cross < best.cross) best = { x, cross };
    }
    if (best && best.cross <= rows.length * 0.1) {
      const both = rows.filter((R) => R.items.some((it) => it.x + it.w < best.x) && R.items.some((it) => it.x > best.x)).length;
      if (both >= rows.length * 0.25) gutter = best.x;
    }
  }
  let lines = [];
  if (gutter == null) {
    // Single column: only a very wide gap (table cells, tab stops) breaks a line; justified spacing never does.
    for (const R of rows) lines.push(...build(R.items, R.y, hasLeader(R.items) ? 999 : 4.5));
  } else {
    // Read each column top to bottom, with full-width lines (titles) where they fall.
    let leftCol = [], rightCol = [];
    const flushCols = () => { lines.push(...leftCol, ...rightCol); leftCol = []; rightCol = []; };
    for (const R of rows) {
      const crosses = R.items.some((it) => it.x < gutter - 1 && it.x + it.w > gutter + 1);
      if (crosses) { flushCols(); lines.push(...build(R.items, R.y, hasLeader(R.items) ? 999 : 4.5)); continue; }
      leftCol.push(...build(R.items.filter((it) => it.x + it.w / 2 < gutter), R.y, 4.5));
      rightCol.push(...build(R.items.filter((it) => it.x + it.w / 2 >= gutter), R.y, 4.5));
    }
    flushCols();
  }
  for (const l of lines) { l.size = median(l.sizes); l.text = l.text.replace(/\s+/g, ' ').trim(); l.top = vp.height - l.y; }
  return lines.filter((l) => l.text);
}

/** Remove running headers, footers and page numbers (text repeating at the page edges). */
function stripRunningLines(pages) {
  const n = pages.length;
  const norm = (t) => t.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
  const isPageNum = (t) => /^(page\s*)?[#ivxlcdm]{1,6}(\s*(of|\/)\s*#)?$/i.test(norm(t)) || /^[-–—]\s*\d+\s*[-–—]$/.test(t);
  const counts = new Map();
  for (const p of pages) {
    const edge = edgeLines(p);
    for (const l of new Set(edge.map((x) => norm(x.text)))) counts.set(l, (counts.get(l) || 0) + 1);
  }
  const repeated = new Set([...counts.entries()].filter(([k, c]) => n >= 4 && c >= Math.max(3, n * 0.25) && k.length < 120).map(([k]) => k));
  for (const p of pages) {
    const edge = new Set(edgeLines(p));
    p.lines = p.lines.filter((l) => !(edge.has(l) && (repeated.has(norm(l.text)) || isPageNum(l.text))));
  }
}
function edgeLines(p) {
  if (!p.lines.length) return [];
  const sorted = [...p.lines].sort((a, b) => a.top - b.top);
  const topBand = p.height * 0.09, bottomBand = p.height * 0.91;
  return [...sorted.slice(0, 2).filter((l) => l.top < topBand), ...sorted.slice(-2).filter((l) => l.top > bottomBand)];
}
