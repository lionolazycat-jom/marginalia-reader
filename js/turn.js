// Page-turn effects. The page being left is copied (snapshot), the live page is switched
// underneath, and the copy is then peeled, faded or slid away. Only transform, opacity and
// clip-path are animated, so it stays smooth on phones.

export const TURN_STYLES = [['curl', 'Curl'], ['slide', 'Slide'], ['fade', 'Fade'], ['none', 'None']];
export const TAP_ZONES = { edges: [0.28, 0.72], thirds: [0.33, 0.67], halves: [0.5, 0.5] };
export const tapZones = (key) => TAP_ZONES[key] || TAP_ZONES.thirds;

export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

function opaqueBg(el) {
  for (let n = el; n; n = n.parentElement) {
    const c = getComputedStyle(n).backgroundColor;
    if (c && c !== 'transparent' && !/,\s*0\)$/.test(c)) return c;
  }
  return '#fff';
}

let active = null;
/** Finish any turn in progress straight away. */
export function clearTurn() { if (active) { active(); active = null; } }

/** Copy `src` into a layer on top of `host`. Call right before changing the live page. */
export function snapshot(src, host) {
  clearTurn();
  const layer = document.createElement('div');
  layer.className = 'turn-layer';
  layer.setAttribute('aria-hidden', 'true');
  layer.inert = true;
  const copy = src.cloneNode(true);
  copy.removeAttribute('id');
  copy.querySelectorAll('[id]').forEach((n) => n.removeAttribute('id'));
  copy.classList.add('turn-copy');
  copy.style.background = opaqueBg(host);
  const from = src.querySelectorAll('canvas'), to = copy.querySelectorAll('canvas');
  from.forEach((c, i) => { try { to[i]?.getContext('2d').drawImage(c, 0, 0); } catch { /* ignore */ } });
  const clip = document.createElement('div');
  clip.className = 'turn-clip';
  clip.append(copy);
  layer.append(clip);
  host.append(layer);
  return layer;
}

/** Animate the snapshot away in direction `dir` ('next' | 'prev'). */
export function playTurn(host, layer, dir, style, live) {
  const W = host.clientWidth || 360;
  const next = dir === 'next';
  const clip = layer.firstElementChild;
  const anims = [];
  const opts = (d, easing = 'cubic-bezier(.3,.55,.25,1)') => ({ duration: d, easing, fill: 'forwards' });
  if (style === 'fade') {
    anims.push(layer.animate([{ opacity: 1 }, { opacity: 0 }], opts(240, 'ease-out')));
  } else if (style === 'slide') {
    const s = next ? 1 : -1;
    anims.push(layer.animate([{ transform: 'translateX(0)' }, { transform: `translateX(${-s * 100}%)` }], opts(320)));
    if (live) anims.push(live.animate([{ transform: `translateX(${s * 100}%)` }, { transform: 'translateX(0)' }], opts(320)));
  } else {
    const fold = document.createElement('div');
    fold.className = 'turn-fold' + (next ? '' : ' prev');
    layer.append(fold);
    const clipA = next ? 'inset(0px 0px 0px 0px)' : 'inset(0px 0px 0px 0px)';
    const clipB = next ? `inset(0px ${W}px 0px 0px)` : `inset(0px 0px 0px ${W}px)`;
    anims.push(clip.animate([{ clipPath: clipA }, { clipPath: clipB }], opts(380)));
    anims.push(fold.animate(next
      ? [{ transform: `translateX(${W}px)` }, { transform: 'translateX(0px)' }]
      : [{ transform: 'translateX(-48px)' }, { transform: `translateX(${W - 48}px)` }], opts(380)));
    anims.push(fold.animate([{ opacity: 1 }, { opacity: 1, offset: 0.85 }, { opacity: 0 }], { duration: 380, easing: 'linear', fill: 'forwards' }));
  }
  const finish = () => { anims.forEach((a) => { try { a.cancel(); } catch { /* ignore */ } }); layer.remove(); if (active === finish) active = null; };
  active = finish;
  Promise.all(anims.map((a) => a.finished)).then(finish, () => {});
}
