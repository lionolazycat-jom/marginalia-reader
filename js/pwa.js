// Installable-app support: service worker (offline), install prompt, update notice.

import { toast } from './util.js';

let deferred = null;
let offlineReady = false;
const listeners = new Set();
const changed = () => { for (const fn of listeners) { try { fn(); } catch {} } };
export const onInstallChange = (fn) => listeners.add(fn);

const isStandalone = () => matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: fullscreen)').matches || navigator.standalone === true;
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
// Inside the Claude artifact viewer there is no service worker and no install.
const embedded = () => { try { return window.self !== window.top; } catch { return true; } };

export function installState() {
  return {
    installed: isStandalone(),
    canPrompt: !!deferred,
    ios: isIOS() && !isStandalone() && !embedded(),
    supported: 'serviceWorker' in navigator && !embedded(),
    offlineReady,
  };
}

export async function promptInstall() {
  if (!deferred) return false;
  deferred.prompt();
  const { outcome } = await deferred.userChoice.catch(() => ({ outcome: 'dismissed' }));
  deferred = null;
  changed();
  if (outcome === 'accepted') toast('Installing Marginalia…');
  return outcome === 'accepted';
}

export function initPwa() {
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; changed(); });
  window.addEventListener('appinstalled', () => { deferred = null; changed(); toast('Marginalia is installed. Open it from your home screen.'); });
  if (embedded() || !('serviceWorker' in navigator) || location.protocol === 'file:') return;
  navigator.serviceWorker.register('./sw.js').then((reg) => {
    const ready = () => { offlineReady = true; changed(); };
    if (reg.active) ready();
    navigator.serviceWorker.ready.then(ready);
    const watch = (w) => {
      if (!w) return;
      w.addEventListener('statechange', () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller) {
          // Away from a book, switch to the new version straight away; mid-book, ask.
          if (!document.body.classList.contains('is-reading')) { w.postMessage('skip-waiting'); return; }
          toast('A new version of Marginalia is ready.', { ms: 15000, action: { label: 'Update', run: () => { w.postMessage('skip-waiting'); } } });
        }
      });
    };
    watch(reg.installing);
    reg.addEventListener('updatefound', () => watch(reg.installing));
    // Look for updates when the app comes back to the foreground.
    document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update().catch(() => {}); });
  }).catch(() => {});
  let reloading = false;
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading || !hadController) return;
    reloading = true;
    if (!document.body.classList.contains('is-reading')) location.reload();
    else toast('Update installed. It takes effect next time you open the app.');
  });
}
