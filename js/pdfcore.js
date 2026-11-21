// Loads PDF.js (bundled with the app, so it works offline) and opens documents.

let libP = null;
const base = new URL('../lib/pdfjs/', import.meta.url);

export function getPdfjs() {
  if (!libP) {
    libP = (async () => {
      const lib = await import('../lib/pdfjs/pdf.min.js');
      const workerUrl = new URL('pdf.worker.min.js', base).href;
      lib.GlobalWorkerOptions.workerSrc = workerUrl;
      try {
        lib.GlobalWorkerOptions.workerPort = new Worker(workerUrl, { type: 'module' });
      } catch {
        // PDF.js falls back to a main-thread "fake worker" via workerSrc.
      }
      return lib;
    })();
    libP.catch(() => { libP = null; });
  }
  return libP;
}

export class PdfPasswordNeeded extends Error {
  constructor(retry) { super(retry ? 'Incorrect password' : 'Password required'); this.retry = retry; }
}

/**
 * Open a PDF from a Blob. askPassword(isRetry) -> Promise<string|null> is called for protected files.
 * Throws a user-readable Error for damaged files.
 */
export async function openPdf(blob, askPassword) {
  const lib = await getPdfjs();
  const data = new Uint8Array(await blob.arrayBuffer());
  const task = lib.getDocument({
    data,
    isEvalSupported: false,
    enableXfa: false,
    standardFontDataUrl: new URL('standard_fonts/', base).href,
    wasmUrl: new URL('wasm/', base).href,
    useSystemFonts: true,
    disableAutoFetch: false,
  });
  let cancelled = false;
  task.onPassword = async (update, reason) => {
    if (!askPassword) { cancelled = true; task.destroy(); return; }
    const pw = await askPassword(reason === lib.PasswordResponses.INCORRECT_PASSWORD);
    if (pw == null) { cancelled = true; task.destroy(); return; }
    update(pw);
  };
  try {
    return await task.promise;
  } catch (e) {
    if (cancelled) throw new PdfPasswordNeeded(false);
    throw friendlyPdfError(e);
  }
}

export function friendlyPdfError(e) {
  const n = e?.name || '';
  if (n === 'PasswordException') return new PdfPasswordNeeded(false);
  if (n === 'InvalidPDFException') return new Error('This PDF is damaged or is not really a PDF file.');
  if (n === 'MissingPDFException') return new Error('The PDF file is empty or missing.');
  if (n === 'UnknownErrorException' || n === 'UnexpectedResponseException') return new Error('The PDF could not be read. It may be corrupted.');
  return new Error(e?.message ? `The PDF could not be opened: ${e.message}` : 'The PDF could not be opened.');
}

/** Resolve an outline destination to a 0-based page index. */
export async function destToPage(doc, dest) {
  try {
    let d = dest;
    if (typeof d === 'string') d = await doc.getDestination(d);
    if (!Array.isArray(d) || !d.length) return null;
    const ref = d[0];
    if (typeof ref === 'number') return ref;
    return await doc.getPageIndex(ref);
  } catch { return null; }
}

export async function pdfOutline(doc) {
  const out = [];
  let outline = null;
  try { outline = await doc.getOutline(); } catch {}
  async function walk(items, depth) {
    for (const it of items || []) {
      const page = await destToPage(doc, it.dest);
      out.push({ label: (it.title || '').trim() || 'Untitled', page, depth });
      if (it.items?.length && depth < 4) await walk(it.items, depth + 1);
    }
  }
  await walk(outline, 0);
  return out;
}

export async function renderThumb(doc, width = 360) {
  const page = await doc.getPage(1);
  const vp1 = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: width / vp1.width });
  const c = document.createElement('canvas');
  c.width = Math.round(vp.width);
  c.height = Math.round(vp.height);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: ctx, viewport: vp, canvas: c }).promise;
  page.cleanup();
  return new Promise((res) => c.toBlob((b) => res(b), 'image/jpeg', 0.82));
}

export async function pageText(doc, i) {
  const page = await doc.getPage(i + 1);
  const tc = await page.getTextContent();
  let s = '';
  for (const it of tc.items) { s += it.str; if (it.hasEOL) s += '\n'; else if (it.str && !/\s$/.test(it.str)) s += ''; }
  page.cleanup();
  return s.replace(/[ \t]+/g, ' ');
}

export function closePdf(doc) {
  try { (doc.loadingTask || doc._transport?.loadingTask)?.destroy(); } catch {}
}
