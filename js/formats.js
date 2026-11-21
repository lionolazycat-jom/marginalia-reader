// Format detection, import (metadata + cover) and conversion of reflowable formats
// (EPUB, FB2, TXT, Markdown, HTML, CBZ) into sanitized chapters for the flow reader.

import { Zip, ZipError, decodeText, resolvePath, mimeFor } from './zip.js';
import { openPdf, renderThumb, PdfPasswordNeeded, closePdf } from './pdfcore.js';

export class UnsupportedError extends Error {}

export const FORMAT_LABEL = { pdf: 'PDF', epub: 'EPUB', txt: 'Text', md: 'Markdown', html: 'HTML', fb2: 'FB2', cbz: 'Comic' };
export const ACCEPT = '.pdf,.epub,.txt,.text,.md,.markdown,.html,.htm,.xhtml,.fb2,.cbz,application/pdf,application/epub+zip,text/plain,text/markdown,text/html';

export async function detectFormat(file) {
  const name = (file.name || '').toLowerCase();
  const ext = name.includes('.') ? name.split('.').pop() : '';
  const head = new Uint8Array(await file.slice(0, 1024).arrayBuffer());
  const ascii = String.fromCharCode(...head.slice(0, 64));
  if (file.size === 0) throw new UnsupportedError('This file is empty.');
  if (ascii.includes('%PDF-')) return 'pdf';
  if (['mobi', 'azw', 'azw3', 'kfx', 'prc'].includes(ext) || ascii.slice(60, 68) === 'BOOKMOBI') {
    throw new UnsupportedError('Kindle files (MOBI/AZW) are not supported. Convert them to EPUB with a free tool like Calibre, then import the EPUB.');
  }
  if (['djvu', 'djv'].includes(ext)) throw new UnsupportedError('DjVu files are not supported. Convert to PDF first.');
  if (['doc', 'docx', 'odt', 'rtf', 'pages'].includes(ext)) throw new UnsupportedError('Word-processor documents are not supported. Export them as PDF or EPUB first.');
  if (head[0] === 0x50 && head[1] === 0x4b) {
    if (ext === 'epub' || ascii.includes('mimetypeapplication/epub+zip')) return 'epub';
    if (ext === 'cbz') return 'cbz';
    // Unknown zip: peek for container.xml or images
    try {
      const z = await Zip.open(file);
      if (z.has('META-INF/container.xml')) return 'epub';
      if (z.names().some((n) => /\.(jpe?g|png|webp|gif)$/i.test(n))) return 'cbz';
    } catch {}
    throw new UnsupportedError('This ZIP archive is not an EPUB or comic (CBZ).');
  }
  if (ext === 'pdf') throw new UnsupportedError('This file is named .pdf but its contents are not a PDF. It may be damaged.');
  if (ext === 'epub') throw new UnsupportedError('This EPUB is damaged: it is not a valid ZIP archive.');
  if (ext === 'fb2' || /<FictionBook/i.test(decodeText(head))) return 'fb2';
  if (['md', 'markdown'].includes(ext)) return 'md';
  if (['html', 'htm', 'xhtml'].includes(ext)) return 'html';
  if (['txt', 'text'].includes(ext) || (file.type || '').startsWith('text/') || looksLikeText(head)) return 'txt';
  throw new UnsupportedError(`".${ext || 'unknown'}" files are not supported. Supported: PDF, EPUB, TXT, Markdown, HTML, FB2 and CBZ.`);
}

function looksLikeText(bytes) {
  let bad = 0;
  for (const b of bytes) if (b < 9 || (b > 13 && b < 32)) bad++;
  return bytes.length > 0 && bad / bytes.length < 0.02;
}

const stripExt = (n) => (n || 'Untitled').replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim();

/** Read title/author/cover at import time. */
export async function readMeta(file, format) {
  const base = { title: stripExt(file.name), author: '', cover: null, pages: null, locked: false };
  if (format === 'pdf') {
    let doc;
    try { doc = await openPdf(file, null); }
    catch (e) {
      if (e instanceof PdfPasswordNeeded) return { ...base, locked: true };
      throw e;
    }
    try {
      const md = await doc.getMetadata().catch(() => null);
      const info = md?.info || {};
      const t = (info.Title || md?.metadata?.get?.('dc:title') || '').trim();
      const a = (info.Author || md?.metadata?.get?.('dc:creator') || '').trim();
      if (t && t.length > 2 && !/^(untitled|about:blank|microsoft word|document\d*|\w+\.(docx?|pdf|html?)|https?:)/i.test(t)) base.title = t;
      if (a) base.author = a;
      base.pages = doc.numPages;
      try { base.cover = await renderThumb(doc); } catch {}
    } finally { closePdf(doc); }
    return base;
  }
  if (format === 'epub') {
    const z = await Zip.open(file);
    const opf = await epubPackage(z);
    return { ...base, title: opf.title || base.title, author: opf.author, cover: opf.coverPath ? await z.blobOf(opf.coverPath).catch(() => null) : null, language: opf.language };
  }
  if (format === 'fb2') {
    const doc = parseXml(decodeText(new Uint8Array(await file.arrayBuffer())));
    const ti = doc.querySelector('title-info');
    const title = ti?.querySelector('book-title')?.textContent?.trim();
    const au = ti?.querySelector('author');
    const author = au ? ['first-name', 'middle-name', 'last-name'].map((t) => au.querySelector(t)?.textContent?.trim()).filter(Boolean).join(' ') : '';
    let cover = null;
    const ci = ti?.querySelector('coverpage image');
    const href = ci && (ci.getAttribute('l:href') || ci.getAttribute('xlink:href') || ci.getAttribute('href') || '').replace(/^#/, '');
    if (href) {
      const bin = [...doc.getElementsByTagName('binary')].find((b) => b.getAttribute('id') === href);
      if (bin) cover = b64Blob(bin.textContent, bin.getAttribute('content-type'));
    }
    return { ...base, title: title || base.title, author, cover };
  }
  if (format === 'cbz') {
    const z = await Zip.open(file);
    const imgs = comicPages(z);
    if (!imgs.length) throw new UnsupportedError('This comic archive contains no images.');
    return { ...base, cover: await z.blobOf(imgs[0]), pages: imgs.length };
  }
  if (format === 'md' || format === 'txt' || format === 'html') {
    const text = decodeText(new Uint8Array(await file.slice(0, 200000).arrayBuffer()));
    if (format === 'html') {
      const d = new DOMParser().parseFromString(text, 'text/html');
      const t = d.querySelector('title')?.textContent?.trim() || d.querySelector('h1')?.textContent?.trim();
      const a = d.querySelector('meta[name="author"]')?.getAttribute('content');
      return { ...base, title: t || base.title, author: a || '' };
    }
    if (format === 'md') {
      const m = text.match(/^#\s+(.+)$/m);
      return { ...base, title: m ? m[1].trim() : base.title };
    }
    // Project Gutenberg style header
    const t = text.match(/^Title:\s*(.+)$/m), a = text.match(/^Author:\s*(.+)$/m);
    return { ...base, title: t ? t[1].trim() : base.title, author: a ? a[1].trim() : '' };
  }
  return base;
}

function b64Blob(b64, type) {
  const bin = atob(b64.replace(/\s+/g, ''));
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return new Blob([u], { type: type || 'image/jpeg' });
}

function parseXml(text) {
  const d = new DOMParser().parseFromString(text, 'application/xml');
  if (d.querySelector('parsererror')) {
    const d2 = new DOMParser().parseFromString(text, 'text/html');
    return d2;
  }
  return d;
}

// ---------------- EPUB ----------------
async function epubPackage(z) {
  if (!z.has('META-INF/container.xml')) throw new UnsupportedError('This EPUB is missing its container file and cannot be opened.');
  const container = parseXml(await z.text('META-INF/container.xml'));
  const opfPath = container.querySelector('rootfile')?.getAttribute('full-path');
  if (!opfPath || !z.has(opfPath)) throw new UnsupportedError('This EPUB is damaged: its package file is missing.');
  const opf = parseXml(await z.text(opfPath));
  const byTag = (tag) => [...opf.getElementsByTagName('*')].filter((e) => e.localName === tag);
  const meta = (tag) => byTag(tag)[0]?.textContent?.trim() || '';
  const manifest = new Map();
  for (const it of byTag('item')) {
    manifest.set(it.getAttribute('id'), {
      id: it.getAttribute('id'),
      href: resolvePath(opfPath, it.getAttribute('href')),
      type: it.getAttribute('media-type') || '',
      props: it.getAttribute('properties') || '',
    });
  }
  const spineEl = byTag('spine')[0];
  const spine = byTag('itemref').map((r) => manifest.get(r.getAttribute('idref'))).filter((m) => m && z.has(m.href));
  let coverPath = [...manifest.values()].find((m) => m.props.includes('cover-image'))?.href;
  if (!coverPath) {
    const cm = byTag('meta').find((m) => m.getAttribute('name') === 'cover');
    const it = cm && manifest.get(cm.getAttribute('content'));
    if (it && it.type.startsWith('image')) coverPath = it.href;
  }
  if (!coverPath) coverPath = [...manifest.values()].find((m) => m.type.startsWith('image') && /cover/i.test(m.href + m.id))?.href;
  if (coverPath && !z.has(coverPath)) coverPath = null;
  const nav = [...manifest.values()].find((m) => m.props.split(/\s+/).includes('nav'));
  const ncx = manifest.get(spineEl?.getAttribute('toc')) || [...manifest.values()].find((m) => m.type === 'application/x-dtbncx+xml');
  const creators = byTag('creator').map((c) => c.textContent.trim()).filter(Boolean);
  return { opfPath, title: meta('title'), author: creators.join(', '), language: meta('language'), spine, manifest, coverPath, nav, ncx };
}

async function epubToc(z, pkg) {
  const out = [];
  if (pkg.nav && z.has(pkg.nav.href)) {
    const d = parseXml(await z.text(pkg.nav.href));
    const navs = [...d.getElementsByTagName('*')].filter((e) => e.localName === 'nav');
    const tocNav = navs.find((n) => /toc/.test(n.getAttribute('epub:type') || n.getAttributeNS('http://www.idpf.org/2007/ops', 'type') || '')) || navs[0];
    const walk = (ol, depth) => {
      for (const li of [...ol.children].filter((c) => c.localName === 'li')) {
        const a = [...li.children].find((c) => c.localName === 'a' || c.localName === 'span');
        if (a) {
          const href = a.getAttribute('href');
          out.push({ label: a.textContent.replace(/\s+/g, ' ').trim(), href: href ? resolveHref(pkg.nav.href, href) : null, depth });
        }
        const sub = [...li.children].find((c) => c.localName === 'ol' || c.localName === 'ul');
        if (sub) walk(sub, depth + 1);
      }
    };
    const ol = tocNav && [...tocNav.getElementsByTagName('*')].find((e) => e.localName === 'ol' || e.localName === 'ul');
    if (ol) walk(ol, 0);
  }
  if (!out.length && pkg.ncx && z.has(pkg.ncx.href)) {
    const d = parseXml(await z.text(pkg.ncx.href));
    const walk = (parent, depth) => {
      for (const np of [...parent.children].filter((c) => c.localName === 'navPoint')) {
        const label = [...np.getElementsByTagName('*')].find((e) => e.localName === 'text')?.textContent?.trim();
        const src = [...np.children].find((c) => c.localName === 'content')?.getAttribute('src');
        out.push({ label: label || 'Untitled', href: src ? resolveHref(pkg.ncx.href, src) : null, depth });
        walk(np, depth + 1);
      }
    };
    const map = [...d.getElementsByTagName('*')].find((e) => e.localName === 'navMap');
    if (map) walk(map, 0);
  }
  return out;
}

function resolveHref(base, href) {
  const [p, frag] = href.split('#');
  return { path: p ? resolvePath(base, p) : base, frag: frag ? safeDecode(frag) : '' };
}
const safeDecode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };

// ---------------- sanitizer ----------------
const KEEP = new Set(['p', 'div', 'section', 'article', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'code', 'em', 'i', 'strong', 'b', 'u', 's', 'del', 'ins', 'sub', 'sup', 'small', 'br', 'hr', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'figure', 'figcaption', 'img', 'a', 'span', 'aside', 'header', 'footer', 'cite', 'q', 'abbr', 'ruby', 'rt', 'rp', 'kbd', 'var', 'samp', 'address', 'center']);
const DROP = new Set(['script', 'style', 'link', 'meta', 'head', 'title', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'select', 'textarea', 'video', 'audio', 'source', 'track', 'canvas', 'noscript', 'template', 'math', 'map']);
const BLOCKS = new Set(['p', 'div', 'section', 'article', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'li', 'dt', 'dd', 'tr', 'figure', 'figcaption', 'aside', 'header', 'footer', 'table', 'ul', 'ol', 'dl', 'hr', 'address', 'caption']);
const BLOCK_REMAP = { nav: 'div', main: 'div', center: 'div', body: 'div', html: 'div' };

/**
 * Convert a parsed document body into safe HTML.
 * ctx: {chapter, path, resolveLink(path, frag) -> {chapter, id}|null, imagePath(src) -> zipPath|dataUrl}
 */
export function sanitize(root, ctx) {
  const out = document.createElement('div');
  const walk = (src, dst) => {
    for (const n of src.childNodes) {
      if (n.nodeType === 3) { dst.append(n.nodeValue); continue; }
      if (n.nodeType !== 1) continue;
      let tag = (n.localName || n.nodeName).toLowerCase();
      if (DROP.has(tag)) continue;
      if (tag === 'svg') {
        const im = [...n.getElementsByTagName('*')].find((e) => e.localName === 'image');
        if (im) {
          const href = im.getAttribute('xlink:href') || im.getAttributeNS('http://www.w3.org/1999/xlink', 'href') || im.getAttribute('href');
          const img = document.createElement('img');
          setImg(img, href, ctx);
          img.alt = '';
          img.className = 'svg-image';
          dst.append(img);
        }
        continue;
      }
      if (BLOCK_REMAP[tag]) tag = BLOCK_REMAP[tag];
      if (!KEEP.has(tag)) { walk(n, dst); continue; }
      const el = document.createElement(tag);
      const id = n.getAttribute('id') || n.getAttribute('name');
      if (id) el.id = `c${ctx.chapter}-${id}`;
      const style = (n.getAttribute('style') || '').toLowerCase();
      const cls = (n.getAttribute('class') || '').toLowerCase();
      if (/text-align:\s*center/.test(style) || /\b(center|centered|centre|title|chapter-?title)\b/.test(cls)) el.classList.add('x-center');
      else if (/text-align:\s*right/.test(style) || /\bright\b/.test(cls)) el.classList.add('x-right');
      if (/font-style:\s*italic/.test(style)) el.classList.add('x-italic');
      if (/font-weight:\s*(bold|[6-9]00)/.test(style)) el.classList.add('x-bold');
      if (/small-?caps/.test(style + cls)) el.classList.add('x-smcp');
      const etype = n.getAttribute('epub:type') || n.getAttributeNS?.('http://www.idpf.org/2007/ops', 'type') || '';
      if (/noteref/.test(etype)) el.dataset.noteref = '1';
      if (/footnote|endnote|rearnote/.test(etype)) el.classList.add('x-note');
      if (tag === 'img') {
        setImg(el, n.getAttribute('src'), ctx);
        el.alt = n.getAttribute('alt') || '';
      } else if (tag === 'a') {
        const href = n.getAttribute('href') || n.getAttribute('xlink:href') || '';
        if (/^(https?:|mailto:)/i.test(href)) { el.href = href; el.target = '_blank'; el.rel = 'noopener noreferrer'; }
        else if (href && ctx.resolveLink) {
          const t = ctx.resolveLink(href);
          if (t) el.dataset.link = `${t.chapter}|${t.id || ''}`;
        }
      } else if (tag === 'td' || tag === 'th') {
        for (const a of ['colspan', 'rowspan']) if (n.getAttribute(a)) el.setAttribute(a, n.getAttribute(a));
      } else if (tag === 'ol' && n.getAttribute('start')) el.setAttribute('start', n.getAttribute('start'));
      walk(n, el);
      dst.append(el);
      // A newline after each block keeps words of adjacent blocks apart in textContent
      // (search snippets, speech) without changing how the page renders.
      if (BLOCKS.has(tag) && !el.closest?.('pre')) dst.append('\n');
    }
  };
  walk(root, out);
  return out.innerHTML;
}

function setImg(el, src, ctx) {
  if (!src) return;
  if (/^data:image\//i.test(src)) { el.src = src; return; }
  const p = ctx.imagePath ? ctx.imagePath(src) : null;
  if (p) el.dataset.src = p;
}

// ---------------- loading books for reading ----------------
/**
 * Returns {chapters:[{title, html, chars}], toc:[{label, chapter, id, depth}], image(path)->Promise<url>, dispose()}
 */
export async function loadFlowBook(blob, format) {
  if (format === 'epub') return loadEpub(blob);
  if (format === 'fb2') return loadFb2(blob);
  if (format === 'cbz') return loadCbz(blob);
  const text = decodeText(new Uint8Array(await blob.arrayBuffer()));
  if (format === 'md') {
    const { marked } = await import('../lib/marked.min.js');
    const html = marked.parse(text, { gfm: true, breaks: false, async: false });
    return fromHtmlString(html, 'Markdown');
  }
  if (format === 'html') return fromHtmlString(text, 'Document');
  return loadTxt(text);
}

function finalize(chapters, toc, extra = {}) {
  for (const c of chapters) {
    if (c.chars == null) c.chars = textLen(c.html);
  }
  return { chapters, toc, image: extra.image || (async (p) => p), dispose: extra.dispose || (() => {}) };
}
function textLen(html) {
  const d = document.createElement('div');
  d.innerHTML = html;
  return (d.textContent || '').length;
}
export function htmlToText(html) {
  const d = document.createElement('div');
  d.innerHTML = html.replace(/<\/(p|div|h\d|li|blockquote|tr)>/gi, '</$1>\n');
  return d.textContent || '';
}

async function loadEpub(blob) {
  const z = await Zip.open(blob);
  const pkg = await epubPackage(z);
  if (!pkg.spine.length) throw new UnsupportedError('This EPUB has no readable chapters.');
  if (z.has('META-INF/encryption.xml')) {
    const enc = await z.text('META-INF/encryption.xml');
    if (/EncryptedData/i.test(enc) && !/obfuscation|font/i.test(enc)) throw new UnsupportedError('This EPUB is DRM-protected (for example from Kindle, Kobo or Google Play) and cannot be opened here.');
  }
  const pathToCh = new Map(pkg.spine.map((s, i) => [s.href, i]));
  const urls = new Map();
  const image = async (path) => {
    if (path.startsWith('data:')) return path;
    if (!urls.has(path)) urls.set(path, z.blobOf(path).then((b) => URL.createObjectURL(b)).catch(() => ''));
    return urls.get(path);
  };
  const chapters = [];
  const titles = [];
  for (let i = 0; i < pkg.spine.length; i++) {
    const item = pkg.spine[i];
    let html = '';
    try {
      const src = await z.text(item.href);
      const isX = /xhtml|xml/.test(item.type) || /\.x?html?$/i.test(item.href);
      let doc = new DOMParser().parseFromString(src, isX ? 'application/xhtml+xml' : 'text/html');
      if (doc.querySelector('parsererror')) doc = new DOMParser().parseFromString(src, 'text/html');
      const body = doc.body || [...doc.getElementsByTagName('*')].find((e) => e.localName === 'body') || doc.documentElement;
      html = sanitize(body, {
        chapter: i,
        imagePath: (s) => resolvePath(item.href, s),
        resolveLink: (href) => {
          const [p, frag] = href.split('#');
          const path = p ? resolvePath(item.href, p) : item.href;
          if (!pathToCh.has(path)) return null;
          const ch = pathToCh.get(path);
          return { chapter: ch, id: frag ? `c${ch}-${safeDecode(frag)}` : '' };
        },
      });
      const hd = body.querySelector?.('h1,h2,h3');
      titles.push(hd?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 80) || '');
    } catch (e) {
      html = `<p class="x-center"><em>This section could not be read.</em></p>`;
      titles.push('');
    }
    chapters.push({ title: titles[i], html });
  }
  const rawToc = await epubToc(z, pkg).catch(() => []);
  const toc = [];
  for (const t of rawToc) {
    if (!t.href) { toc.push({ label: t.label, chapter: null, id: '', depth: t.depth }); continue; }
    const ch = pathToCh.get(t.href.path);
    if (ch == null) continue;
    toc.push({ label: t.label, chapter: ch, id: t.href.frag ? `c${ch}-${t.href.frag}` : '', depth: t.depth });
  }
  // Name chapters from the TOC where possible
  for (const t of toc) if (t.chapter != null && !t.id && !chapters[t.chapter].tocTitle) chapters[t.chapter].tocTitle = t.label;
  let last = '';
  chapters.forEach((c, i) => {
    const fromToc = toc.filter((t) => t.chapter != null && t.chapter <= i).pop();
    c.title = c.tocTitle || (fromToc ? fromToc.label : '') || c.title || last || `Section ${i + 1}`;
    last = c.title;
  });
  if (!toc.length) chapters.forEach((c, i) => { if (c.title) toc.push({ label: c.title, chapter: i, id: '', depth: 0 }); });
  return finalize(chapters, dedupeToc(toc), { image, dispose: () => { for (const p of urls.values()) p.then((u) => u && URL.revokeObjectURL(u)); } });
}

function dedupeToc(toc) {
  const seen = new Set();
  return toc.filter((t) => { const k = `${t.label}|${t.chapter}|${t.id}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

async function loadFb2(blob) {
  const doc = parseXml(decodeText(new Uint8Array(await blob.arrayBuffer())));
  const bins = new Map([...doc.getElementsByTagName('binary')].map((b) => [b.getAttribute('id'), b]));
  const urls = new Map();
  const image = async (id) => {
    if (!urls.has(id)) {
      const b = bins.get(id);
      urls.set(id, b ? URL.createObjectURL(b64Blob(b.textContent, b.getAttribute('content-type'))) : '');
    }
    return urls.get(id);
  };
  const bodies = [...doc.getElementsByTagName('body')];
  const chapters = [], toc = [];
  const conv = (node) => {
    const map = { p: 'p', emphasis: 'em', strong: 'strong', 'empty-line': 'br', epigraph: 'blockquote', cite: 'blockquote', poem: 'div', stanza: 'div', v: 'p', subtitle: 'h4', 'text-author': 'p', strikethrough: 's', sub: 'sub', sup: 'sup', code: 'code', a: 'a', table: 'table', tr: 'tr', td: 'td', th: 'th' };
    const out = document.createElement('div');
    const walk = (src, dst) => {
      for (const n of src.childNodes) {
        if (n.nodeType === 3) { dst.append(n.nodeValue); continue; }
        if (n.nodeType !== 1) continue;
        const t = n.localName;
        if (t === 'title') { const h = document.createElement('h2'); h.textContent = n.textContent.trim(); h.className = 'x-center'; dst.append(h); continue; }
        if (t === 'section') { walk(n, dst); continue; }
        if (t === 'image') {
          const href = (n.getAttribute('l:href') || n.getAttribute('xlink:href') || n.getAttribute('href') || '').replace(/^#/, '');
          const img = document.createElement('img'); img.dataset.src = href; img.alt = ''; dst.append(img); continue;
        }
        const tag = map[t];
        if (!tag) { walk(n, dst); continue; }
        const el = document.createElement(tag);
        if (t === 'poem' || t === 'stanza') el.className = 'x-poem';
        if (t === 'text-author') el.className = 'x-right x-italic';
        if (t === 'a') {
          const href = n.getAttribute('l:href') || n.getAttribute('xlink:href') || '';
          if (/^https?:/.test(href)) { el.href = href; el.target = '_blank'; el.rel = 'noopener noreferrer'; }
        }
        if (n.getAttribute('id')) el.id = n.getAttribute('id');
        walk(n, el);
        dst.append(el);
        if (/^(p|div|blockquote|h4|table|tr)$/.test(tag)) dst.append('\n');
      }
    };
    walk(node, out);
    return out.innerHTML;
  };
  for (const body of bodies) {
    const isNotes = /notes|comments/.test(body.getAttribute('name') || '');
    const sections = [...body.children].filter((c) => c.localName === 'section');
    if (!sections.length) { chapters.push({ title: isNotes ? 'Notes' : 'Text', html: conv(body) }); continue; }
    for (const s of sections) {
      const title = [...s.children].find((c) => c.localName === 'title')?.textContent?.replace(/\s+/g, ' ').trim() || (isNotes ? 'Notes' : `Chapter ${chapters.length + 1}`);
      toc.push({ label: title, chapter: chapters.length, id: '', depth: 0 });
      chapters.push({ title, html: conv(s) });
    }
  }
  if (!chapters.length) throw new UnsupportedError('This FB2 file has no readable text.');
  return finalize(chapters, toc, { image, dispose: () => urls.forEach((u) => u && URL.revokeObjectURL(u)) });
}

function comicPages(z) {
  const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  return z.names().filter((n) => /\.(jpe?g|png|webp|gif|avif)$/i.test(n) && !/(^|\/)(__MACOSX|\.)/.test(n)).sort(coll.compare);
}
async function loadCbz(blob) {
  const z = await Zip.open(blob);
  const pages = comicPages(z);
  const urls = new Map();
  const image = async (p) => {
    if (!urls.has(p)) urls.set(p, z.blobOf(p, mimeFor(p)).then((b) => URL.createObjectURL(b)));
    return urls.get(p);
  };
  const chapters = pages.map((p, i) => ({ title: `Page ${i + 1}`, html: `<figure class="x-comic"><img data-src="${p.replace(/"/g, '&quot;')}" alt="Page ${i + 1}"></figure>`, chars: 400 }));
  const toc = chapters.filter((_, i) => i % 10 === 0).map((c, j) => ({ label: c.title, chapter: j * 10, id: '', depth: 0 }));
  return { ...finalize(chapters, toc, { image, dispose: () => urls.forEach((u) => u.then(URL.revokeObjectURL)) }), comic: true };
}

function fromHtmlString(html, fallbackTitle) {
  const d = new DOMParser().parseFromString(html, 'text/html');
  const clean = sanitize(d.body, { chapter: 0, imagePath: (s) => (/^data:/.test(s) ? s : null), resolveLink: (href) => (href.startsWith('#') ? { chapter: 0, id: `c0-${href.slice(1)}` } : null) });
  // Split at h1/h2 into chapters when there are several
  const wrap = document.createElement('div');
  wrap.innerHTML = clean;
  const heads = [...wrap.children].filter((c) => /^H[12]$/.test(c.tagName));
  if (heads.length < 2) return finalize(splitLarge([{ title: heads[0]?.textContent.trim() || fallbackTitle, html: clean }]), heads.length ? [{ label: heads[0].textContent.trim(), chapter: 0, id: '', depth: 0 }] : []);
  const chapters = [];
  let cur = { title: 'Opening', nodes: [] };
  for (const node of [...wrap.childNodes]) {
    if (node.nodeType === 1 && /^H[12]$/.test(node.tagName)) {
      if (cur.nodes.some((n) => (n.textContent || '').trim() || n.nodeName === 'IMG')) chapters.push(cur);
      cur = { title: node.textContent.replace(/\s+/g, ' ').trim(), nodes: [] };
    }
    cur.nodes.push(node);
  }
  chapters.push(cur);
  // A short opening (title + tagline) reads better on the same page as the first chapter.
  if (chapters.length > 1 && chapters[0].nodes.reduce((n, x) => n + (x.textContent || '').length, 0) < 400) {
    const first = chapters.shift();
    chapters[0].nodes.unshift(...first.nodes);
  }
  const out = chapters.map((c, i) => {
    const box = document.createElement('div');
    for (const n of c.nodes) box.append(n);
    // ids were assigned for chapter 0; fix the prefix for this chapter
    for (const el of box.querySelectorAll('[id^="c0-"]')) el.id = `c${i}-` + el.id.slice(3);
    for (const el of box.querySelectorAll('[data-link]')) el.removeAttribute('data-link');
    return { title: c.title, html: box.innerHTML };
  });
  return finalize(out, out.map((c, i) => ({ label: c.title, chapter: i, id: '', depth: 0 })));
}

const CHAPTER_RE = /^\s*((chapter|chap\.|part|book|volume|act|section|prologue|epilogue|preface|introduction|foreword|afterword|appendix)\b[^\n]{0,70}|[IVXLC]{1,7}\.?|\d{1,3}\.)\s*$/i;

function loadTxt(text) {
  text = text.replace(/\r\n?/g, '\n').replace(/\t/g, '    ');
  // Strip Project Gutenberg boilerplate if present
  const s = text.search(/\*\*\*\s*START OF (THE|THIS) PROJECT GUTENBERG[^\n]*\n/i);
  if (s >= 0) text = text.slice(text.indexOf('\n', s) + 1);
  const e = text.search(/\*\*\*\s*END OF (THE|THIS) PROJECT GUTENBERG/i);
  if (e > 0) text = text.slice(0, e);
  // Drop a metadata header ("Title: …", "Author: …") at the very top
  text = text.replace(/^(?:\s*(?:Title|Author|Release Date|Language|Credits|Produced by|Translator|Editor|Illustrator|Posting Date|Character set encoding):[^\n]*\n)+/i, '');
  const hasBlank = /\n\s*\n/.test(text);
  let paras = hasBlank ? text.split(/\n\s*\n/) : text.split('\n');
  paras = paras.map((p) => p.replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean);
  const chapters = [];
  let cur = { title: 'Beginning', parts: [] };
  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  for (const p of paras) {
    if (p.length < 80 && CHAPTER_RE.test(p)) {
      if (cur.parts.length) chapters.push(cur);
      cur = { title: p.replace(/\s+/g, ' '), parts: [`<h2 class="x-center">${esc(p)}</h2>`] };
      continue;
    }
    cur.parts.push(`<p>${esc(p)}</p>`);
  }
  if (cur.parts.length) chapters.push(cur);
  if (!chapters.length) chapters.push({ title: 'Text', parts: ['<p><em>This file is empty.</em></p>'] });
  const list = chapters.map((c) => ({ title: c.title, html: c.parts.join('\n') }));
  const split = splitLarge(list);
  const toc = split.filter((c) => !c.cont).map((c) => ({ label: c.title, chapter: split.indexOf(c), id: '', depth: 0 }));
  return finalize(split, toc.length > 1 ? toc : []);
}

/** Keep chapters under ~80k characters so paginated layout stays fast. */
function splitLarge(chapters, max = 80000) {
  const out = [];
  for (const c of chapters) {
    if (c.html.length <= max) { out.push(c); continue; }
    const box = document.createElement('div');
    box.innerHTML = c.html;
    let chunk = [], size = 0, n = 0;
    const push = () => {
      if (!chunk.length) return;
      out.push({ title: n ? `${c.title} (cont.)` : c.title, html: chunk.join(''), cont: n > 0 });
      n++; chunk = []; size = 0;
    };
    for (const node of [...box.childNodes]) {
      const s = node.nodeType === 1 ? node.outerHTML : (node.nodeValue || '').replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[ch]);
      chunk.push(s); size += s.length;
      if (size > max) push();
    }
    push();
  }
  return out;
}

export { ZipError };
