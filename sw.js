// Marginalia service worker: the whole app is cached on install, so it opens and reads offline.
const VERSION = "8ac8732ed5";
const APP_CACHE = `marginalia-app-${VERSION}`;
const FONT_CACHE = 'marginalia-fonts-v1';
const PRECACHE = [
 "./",
 "./css/app.css",
 "./icons/apple-touch-icon.png",
 "./icons/favicon-64.png",
 "./icons/icon-192.png",
 "./icons/icon-512.png",
 "./icons/maskable-512.png",
 "./index.html",
 "./js/ambient.js",
 "./js/app.js",
 "./js/db.js",
 "./js/exporter.js",
 "./js/flow.js",
 "./js/formats.js",
 "./js/freebooks.js",
 "./js/pdfcore.js",
 "./js/pdfreflow.js",
 "./js/pdfview.js",
 "./js/pen.js",
 "./js/pwa.js",
 "./js/reader.js",
 "./js/settings.js",
 "./js/store.js",
 "./js/turn.js",
 "./js/util.js",
 "./js/voices.js",
 "./js/welcome.js",
 "./js/zip.js",
 "./lib/marked.min.js",
 "./lib/pdfjs/pdf.min.js",
 "./lib/pdfjs/pdf.worker.min.js",
 "./lib/pdfjs/standard_fonts/FoxitDingbats.pfb",
 "./lib/pdfjs/standard_fonts/FoxitFixed.pfb",
 "./lib/pdfjs/standard_fonts/FoxitFixedBold.pfb",
 "./lib/pdfjs/standard_fonts/FoxitFixedBoldItalic.pfb",
 "./lib/pdfjs/standard_fonts/FoxitFixedItalic.pfb",
 "./lib/pdfjs/standard_fonts/FoxitSerif.pfb",
 "./lib/pdfjs/standard_fonts/FoxitSerifBold.pfb",
 "./lib/pdfjs/standard_fonts/FoxitSerifBoldItalic.pfb",
 "./lib/pdfjs/standard_fonts/FoxitSerifItalic.pfb",
 "./lib/pdfjs/standard_fonts/FoxitSymbol.pfb",
 "./lib/pdfjs/standard_fonts/LiberationSans-Bold.ttf",
 "./lib/pdfjs/standard_fonts/LiberationSans-BoldItalic.ttf",
 "./lib/pdfjs/standard_fonts/LiberationSans-Italic.ttf",
 "./lib/pdfjs/standard_fonts/LiberationSans-Regular.ttf",
 "./lib/pdfjs/wasm/jbig2.wasm",
 "./lib/pdfjs/wasm/jbig2_nowasm_fallback.js",
 "./lib/pdfjs/wasm/openjpeg.wasm",
 "./lib/pdfjs/wasm/openjpeg_nowasm_fallback.js",
 "./lib/pdfjs/wasm/qcms_bg.wasm",
 "./lib/pdfjs/wasm/quickjs-eval.wasm",
 "./manifest.webmanifest"
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(APP_CACHE).then((c) => c.addAll(PRECACHE.map((f) => new Request(f, { cache: 'reload' })))));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('marginalia-app-') && k !== APP_CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('message', (e) => { if (e.data === 'skip-waiting') self.skipWaiting(); });

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(staleWhileRevalidate(req, FONT_CACHE));
    return;
  }
  if ((url.hostname === 'www.gutenberg.org' || url.hostname === 'aleph.gutenberg.org') && /\.cover\.(small|medium)\.jpg$/.test(url.pathname)) {
    e.respondWith(staleWhileRevalidate(req, 'marginalia-covers-v1'));
    return;
  }
  if (url.origin !== self.location.origin) return;
  if (req.mode === 'navigate') {
    e.respondWith(caches.match('./index.html', { cacheName: APP_CACHE }).then((r) => r || fetch(req)));
    return;
  }
  e.respondWith(caches.match(req, { ignoreSearch: true }).then((r) => r || fetch(req).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(APP_CACHE).then((c) => c.put(req, copy)); }
    return res;
  })));
});

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  const net = fetch(req).then((res) => { if (res.ok || res.type === 'opaque') cache.put(req, res.clone()); return res; }).catch(() => hit);
  return hit || net;
}
