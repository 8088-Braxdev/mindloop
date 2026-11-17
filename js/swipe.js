// Swiping between tabs should feel like a native app: the view follows the
// finger, a short quick flick is enough, and the change is quick and springy.
const LOCK_DISTANCE = 6; // px before we decide the gesture is horizontal
const EDGE_GUARD = 22; // px kept for the phone's own back gesture
const SWIPE_SHARE = 0.22; // share of the screen that counts as a swipe
const FLICK_SPEED = 0.4; // px per ms
const PROJECT_MS = 140; // how far a flick is projected forward
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

let startX = 0;
let startY = 0;
let lastX = 0;
let lastT = 0;
let speed = 0;
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

// A drag that was not far enough: go back with a soft spring, not a snap.
function springBack() {
  const el = panel;
  if (!el) return endDrag();
  busy = true;
  const cs = getComputedStyle(el);
  const from = { transform: cs.transform, opacity: cs.opacity };
  clear(el);
  const anim = el.animate([from, { transform: 'translateX(0)', opacity: 1 }], {
    duration: 220,
    easing: 'cubic-bezier(.22,1.2,.36,1)',
  });
  anim.onfinish = () => {
    busy = false;
    endDrag();
  };
}

// The old view nudges away and fades, then the new one settles in. Short and
// overlapping enough to read as one movement rather than two animations.
async function slideSwitch(step, next, fromX) {
  const el = panel;
  const w = window.innerWidth;
  busy = true;
  navigator.vibrate?.(6);

  const out = el.animate(
    [
      { transform: `translateX(${fromX}px)`, opacity: 1 },
      { transform: `translateX(${-step * w * 0.18}px)`, opacity: 0 },
    ],
    { duration: 110, easing: 'cubic-bezier(.4,0,.6,1)', fill: 'forwards' },
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
  incoming.style.willChange = 'transform, opacity';
  const anim = incoming.animate(
    [
      { transform: `translateX(${step * w * 0.12}px)`, opacity: 0 },
      { transform: 'translateX(0)', opacity: 1 },
    ],
    { duration: 190, easing: 'cubic-bezier(.2,.9,.25,1)' },
  );
  anim.onfinish = () => {
    clear(incoming);
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
      e.target.closest('input, textarea, select, .tabs, .tour-tooltip') ||
      inHorizontalScroller(e.target) ||
      t.clientX < EDGE_GUARD ||
      t.clientX > window.innerWidth - EDGE_GUARD;

    tracking = !blocked;
    dragging = false;
    speed = 0;
    if (tracking) {
      startX = lastX = t.clientX;
      startY = t.clientY;
      lastT = e.timeStamp;
    }
  },
  { passive: true },
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

    // Finger speed over the last movement, smoothed, for a natural flick.
    const dt = Math.max(e.timeStamp - lastT, 1);
    speed = speed * 0.6 + ((t.clientX - lastX) / dt) * 0.4;
    lastX = t.clientX;
    lastT = e.timeStamp;

    const idx = activeIndex();
    const atEdge = (dx > 0 && idx === 0) || (dx < 0 && idx === tabs().length - 1);
    const offset = atEdge ? dx * 0.22 : dx;
    const progress = Math.min(Math.abs(offset) / (window.innerWidth * 0.9), 1);
    panel.style.transform = `translateX(${offset}px)`;
    // Only a hint of depth: the view stays readable while it moves.
    panel.style.opacity = String(1 - progress * 0.12);
  },
  { passive: true },
);

document.addEventListener(
  'touchend',
  (e) => {
    if (!tracking) return;
    tracking = false;
    if (!dragging) return;

    const t = e.changedTouches[0];
    const dx = t.clientX - startX;
    const projected = dx + speed * PROJECT_MS;
    const step = projected < 0 ? 1 : -1;
    const next = tabs()[activeIndex() + step];
    const w = window.innerWidth;
    const far = Math.abs(dx) >= w * SWIPE_SHARE;
    const flick = Math.abs(dx) > 14 && Math.abs(speed) > FLICK_SPEED;
    const passed = Math.abs(projected) >= w * SWIPE_SHARE && (far || flick);

    if (!next || !passed) return springBack();

    if (reduceMotion.matches) {
      next.click();
      clear(panel);
      window.scrollTo(0, 0);
      return endDrag();
    }
    slideSwitch(step, next, dx);
  },
  { passive: true },
);

document.addEventListener(
  'touchcancel',
  () => {
    tracking = false;
    if (dragging) springBack();
  },
  { passive: true },
);
