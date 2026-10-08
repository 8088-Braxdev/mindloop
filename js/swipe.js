const MIN_DISTANCE = 70;
const EDGE_GUARD = 24;
const LOCK_DISTANCE = 10;
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

let startX = 0;
let startY = 0;
let startT = 0;
let tracking = false;
let dragging = false;
let busy = false;
let panel = null;

const tabs = () => [...document.querySelectorAll('.tabs .tab')];
const activeIndex = () => tabs().findIndex((t) => t.classList.contains('is-active'));
const visibleView = () => document.querySelector('main .view:not([hidden])');

function clear(el) {
  if (!el) return;
  el.style.transform = '';
  el.style.opacity = '';
  el.style.willChange = '';
}

function endDrag() {
  dragging = false;
  panel = null;
  document.body.style.overflowX = '';
}

function inHorizontalScroller(el) {
  for (let n = el; n && n !== document.body; n = n.parentElement) {
    if (n.scrollWidth > n.clientWidth + 1) {
      const ox = getComputedStyle(n).overflowX;
      if (ox === 'auto' || ox === 'scroll') return true;
    }
  }
  return false;
}

function springBack() {
  const el = panel;
  if (!el) return endDrag();
  busy = true;
  const cs = getComputedStyle(el);
  const from = { transform: cs.transform, opacity: cs.opacity };
  clear(el);
  const anim = el.animate([from, { transform: 'translateX(0)', opacity: 1 }], {
    duration: 180,
    easing: 'cubic-bezier(.2,.8,.2,1)',
  });
  anim.onfinish = () => {
    busy = false;
    endDrag();
  };
}

async function slideSwitch(step, next) {
  const el = panel;
  const w = window.innerWidth;
  busy = true;
  const cs = getComputedStyle(el);
  const out = el.animate(
    [
      { transform: cs.transform, opacity: cs.opacity },
      { transform: `translateX(${-step * w}px)`, opacity: 0 },
    ],
    { duration: 140, easing: 'ease-in', fill: 'forwards' }
  );
  await out.finished;

  next.click();
  clear(el);
  out.cancel();
  window.scrollTo(0, 0);

  const incoming = visibleView();
  if (!incoming) {
    busy = false;
    return endDrag();
  }
  const anim = incoming.animate(
    [
      { transform: `translateX(${step * w}px)`, opacity: 0 },
      { transform: 'translateX(0)', opacity: 1 },
    ],
    { duration: 210, easing: 'cubic-bezier(.2,.8,.2,1)' }
  );
  anim.onfinish = () => {
    busy = false;
    endDrag();
  };
}

document.addEventListener(
  'touchstart',
  (e) => {
    const app = document.getElementById('app');
    const tour = document.getElementById('tour-tooltip');
    const t = e.touches[0];
    const blocked =
      busy ||
      !app || app.hidden ||
      (tour && !tour.hidden) ||
      e.touches.length !== 1 ||
      e.target.closest('input, textarea, select') ||
      inHorizontalScroller(e.target) ||
      t.clientX < EDGE_GUARD ||
      t.clientX > window.innerWidth - EDGE_GUARD;

    tracking = !blocked;
    dragging = false;
    if (tracking) {
      startX = t.clientX;
      startY = t.clientY;
      startT = e.timeStamp;
    }
  },
  { passive: true }
);

document.addEventListener(
  'touchmove',
  (e) => {
    if (!tracking) return;
    const t = e.touches[0];
    const dx = t.clientX - startX;
    const dy = t.clientY - startY;

    if (!dragging) {
      if (Math.abs(dx) < LOCK_DISTANCE && Math.abs(dy) < LOCK_DISTANCE) return;
      if (Math.abs(dy) > Math.abs(dx)) {
        tracking = false;
        return;
      }
      panel = visibleView();
      if (!panel) {
        tracking = false;
        return;
      }
      dragging = true;
      panel.style.willChange = 'transform';
      document.body.style.overflowX = 'hidden';
    }

    const idx = activeIndex();
    const atEdge = (dx > 0 && idx === 0) || (dx < 0 && idx === tabs().length - 1);
    const offset = atEdge ? dx * 0.25 : dx;
    panel.style.transform = `translateX(${offset}px)`;
    panel.style.opacity = String(1 - Math.min(Math.abs(offset) / (window.innerWidth * 1.5), 0.35));
  },
  { passive: true }
);

document.addEventListener(
  'touchend',
  (e) => {
    if (!tracking) return;
    tracking = false;
    if (!dragging) return;

    const t = e.changedTouches[0];
    const dx = t.clientX - startX;
    const dt = Math.max(e.timeStamp - startT, 1);
    const step = dx < 0 ? 1 : -1;
    const next = tabs()[activeIndex() + step];
    const fast = Math.abs(dx) > 30 && Math.abs(dx) / dt > 0.5;
    const passed = Math.abs(dx) >= MIN_DISTANCE || fast;

    if (!next || !passed) return springBack();

    if (reduceMotion.matches) {
      next.click();
      clear(panel);
      window.scrollTo(0, 0);
      return endDrag();
    }
    slideSwitch(step, next);
  },
  { passive: true }
);

document.addEventListener(
  'touchcancel',
  () => {
    tracking = false;
    if (dragging) springBack();
  },
  { passive: true }
);
