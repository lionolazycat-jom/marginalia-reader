// Highlighter drag: while the pen is on, a one-finger drag over text selects it straight away,
// so the swipe that normally turns the page can't be confused with highlighting.
function caretAt(x, y) {
  if (document.caretPositionFromPoint) {
    const p = document.caretPositionFromPoint(x, y);
    return p ? { node: p.offsetNode, offset: p.offset } : null;
  }
  const r = document.caretRangeFromPoint?.(x, y);
  return r ? { node: r.startContainer, offset: r.startOffset } : null;
}

export function bindPenDrag(el, active) {
  let start = null, dragging = false, sx = 0, sy = 0;
  el.addEventListener('touchstart', (e) => {
    start = null; dragging = false;
    if (e.touches.length !== 1 || !active()) return;
    const t = e.touches[0];
    sx = t.clientX; sy = t.clientY;
    const c = caretAt(sx, sy);
    if (c && c.node && c.node.nodeType === 3 && el.contains(c.node)) start = c;
  }, { passive: true });
  el.addEventListener('touchmove', (e) => {
    if (!start || e.touches.length !== 1 || !active()) return;
    const t = e.touches[0];
    if (!dragging && Math.hypot(t.clientX - sx, t.clientY - sy) < 8) return;
    const c = caretAt(t.clientX, t.clientY);
    if (!c || !c.node || !el.contains(c.node)) { if (dragging) e.preventDefault(); return; }
    dragging = true;
    e.preventDefault();
    try { getSelection().setBaseAndExtent(start.node, start.offset, c.node, c.offset); } catch { /* ignore */ }
  }, { passive: false });
  const end = () => { start = null; dragging = false; };
  el.addEventListener('touchend', end, { passive: true });
  el.addEventListener('touchcancel', end, { passive: true });
}
