const MIN_DISTANCE = 70;
const EDGE_GUARD = 24;

let startX = 0;
let startY = 0;
let tracking = false;

function inHorizontalScroller(el) {
  for (let n = el; n && n !== document.body; n = n.parentElement) {
    if (n.scrollWidth > n.clientWidth + 1) {
      const ox = getComputedStyle(n).overflowX;
      if (ox === 'auto' || ox === 'scroll') return true;
    }
  }
  return false;
}

function goRelative(step) {
  const list = [...document.querySelectorAll('.tabs .tab')];
  const i = list.findIndex((t) => t.classList.contains('is-active'));
  const next = list[i + step];
  if (!next) return;
  next.click();
  window.scrollTo(0, 0);
}

document.addEventListener(
  'touchstart',
  (e) => {
    const app = document.getElementById('app');
    const tour = document.getElementById('tour-tooltip');
    const t = e.touches[0];
    const blocked =
      !app || app.hidden ||
      (tour && !tour.hidden) ||
      e.touches.length !== 1 ||
      e.target.closest('input, textarea, select') ||
      inHorizontalScroller(e.target) ||
      t.clientX < EDGE_GUARD ||
      t.clientX > window.innerWidth - EDGE_GUARD;

    tracking = !blocked;
    if (tracking) {
      startX = t.clientX;
      startY = t.clientY;
    }
  },
  { passive: true }
);

document.addEventListener(
  'touchend',
  (e) => {
    if (!tracking) return;
    tracking = false;
    const t = e.changedTouches[0];
    const dx = t.clientX - startX;
    const dy = t.clientY - startY;
    if (Math.abs(dx) < MIN_DISTANCE || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    goRelative(dx < 0 ? 1 : -1);
  },
  { passive: true }
);
