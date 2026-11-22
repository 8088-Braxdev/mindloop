// js/feedback.js
// A one-time feedback card, the way a store app asks: stars, an optional note,
// and then never again. The rating is kept on this device; it only reaches us
// if the person taps Send, which opens WhatsApp with the message ready.
//
// It is asked after the person has actually used MindLoop (two reviews), never
// during the tour, and never a second time for the same account.

import { getEntriesLocal } from "./storage.js";
import { cachedUserId } from "./auth.js";

const KEY = "mindloop:feedback";
const DEVICE_KEY = "mindloop:feedback-device";
const WHATSAPP = "255618811359";
const ASK_AFTER_REVIEWS = 2;
const FIRST_DELAY_MS = 6000;
const RETRY_MS = 20000;
const MAX_TRIES = 12;

function storeKey() {
  const uid = cachedUserId();
  return uid ? `${KEY}:${uid}` : null;
}

function alreadyAsked() {
  // Once per device, and once per account: a second account on the same phone
  // is not asked again, the way a store app asks once per install.
  try {
    if (localStorage.getItem(DEVICE_KEY)) return true;
  } catch {
    return true;
  }
  const key = storeKey();
  if (!key) return false; // no account yet: ask once there is one
  try {
    return !!localStorage.getItem(key);
  } catch {
    return true;
  }
}

function markAsked(reason) {
  try {
    localStorage.setItem(DEVICE_KEY, "1");
  } catch {
    // A convenience flag; asking again later is not harmful.
  }
  const key = storeKey();
  if (!key) return;
  try {
    localStorage.setItem(key, JSON.stringify({ at: Date.now(), reason }));
  } catch {
    // A convenience flag; asking again later is not harmful.
  }
}

function reviewedDays() {
  return getEntriesLocal().filter(
    (entry) =>
      (entry.wins || "").trim() ||
      (entry.priorities || []).some((p) => (p?.text || "").trim()),
  ).length;
}

function build() {
  const overlay = document.createElement("div");
  overlay.className = "feedback-overlay";
  overlay.hidden = true;
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-labelledby", "feedback-title");

  // Where the keyboard was before the card appeared, so it can go back there.
  const previousFocus =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;

  const card = document.createElement("div");
  card.className = "card feedback-card";

  const title = document.createElement("h2");
  title.id = "feedback-title";
  title.textContent = "Is MindLoop helping you?";

  const hint = document.createElement("p");
  hint.className = "hint";
  hint.textContent =
    "Your honest answer helps us make it better. It is asked once.";

  const stars = document.createElement("div");
  stars.className = "feedback-stars";
  stars.setAttribute("role", "group");
  stars.setAttribute("aria-label", "Your rating");

  const buttons = [];
  for (let value = 1; value <= 5; value++) {
    const star = document.createElement("button");
    star.type = "button";
    star.className = "feedback-star";
    star.textContent = "★";
    star.setAttribute("aria-label", `${value} out of 5`);
    star.setAttribute("aria-pressed", "false");
    star.addEventListener("click", () => paint(value));
    stars.append(star);
    buttons.push(star);
  }

  const comment = document.createElement("textarea");
  comment.rows = 3;
  comment.maxLength = 300;
  comment.placeholder = "What should we improve? (optional)";
  comment.setAttribute("aria-label", "What should we improve");

  const actions = document.createElement("div");
  actions.className = "feedback-actions";

  const send = document.createElement("button");
  send.type = "button";
  send.className = "primary";
  send.textContent = "Send feedback";
  send.disabled = true;

  const later = document.createElement("button");
  later.type = "button";
  later.className = "plan-btn";
  later.textContent = "Not now";

  let rating = 0;

  function paint(value) {
    rating = value;
    buttons.forEach((b, i) => {
      const on = i < value;
      b.classList.toggle("is-on", on);
      b.setAttribute("aria-pressed", String(on));
    });
    send.disabled = rating === 0;
  }

  function close(reason) {
    markAsked(reason);
    overlay.hidden = true;
    overlay.remove();
    document.removeEventListener("keydown", onKey);
    if (previousFocus && document.contains(previousFocus)) {
      previousFocus.focus({ preventScroll: true });
    }
  }

  // Escape closes; Tab stays inside the card while it is open.
  function onKey(event) {
    if (event.key === "Escape") {
      close("dismissed");
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...card.querySelectorAll("button, textarea, a[href]")].filter(
      (el) => !el.disabled && el.offsetParent !== null,
    );
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!card.contains(document.activeElement)) {
      event.preventDefault();
      first.focus();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  send.addEventListener("click", () => {
    const note = comment.value.trim();
    const text = `MindLoop feedback: ${rating}/5${note ? `\n${note}` : ""}`;
    window.open(
      `https://wa.me/${WHATSAPP}?text=${encodeURIComponent(text)}`,
      "_blank",
      "noopener",
    );
    close("sent");
  });

  later.addEventListener("click", () => close("dismissed"));

  actions.append(send, later);
  card.append(title, hint, stars, comment, actions);
  overlay.append(card);
  document.addEventListener("keydown", onKey);
  return overlay;
}

function overlayOpen() {
  // Never interrupt the tour or another sheet: the rating is a quiet question.
  return !!document.querySelector(".sheet-overlay, .feedback-overlay");
}

export function maybeAskForFeedback() {
  if (alreadyAsked()) return true;
  const app = document.getElementById("app");
  if (!app || app.hidden) return false;
  if (reviewedDays() < ASK_AFTER_REVIEWS) return false;
  const tour = document.getElementById("tour-tooltip");
  if (tour && !tour.hidden) return false;
  if (overlayOpen()) return false;
  openFeedback();
  return true;
}

export function openFeedback() {
  if (alreadyAsked() || overlayOpen()) return;
  const overlay = build();
  document.body.append(overlay);
  overlay.hidden = false;
  // Asked is asked: the mark lands the moment the card appears, so closing the
  // tab, a dead battery or a reload cannot bring it back a second time.
  markAsked("shown");
  requestAnimationFrame(() => {
    const first = overlay.querySelector(".feedback-star");
    first?.focus({ preventScroll: true });
  });
}

let tries = 0;
let timer = null;

function schedule() {
  if (alreadyAsked()) return;
  if (maybeAskForFeedback()) return;
  tries += 1;
  if (tries >= MAX_TRIES) return;
  timer = setTimeout(schedule, RETRY_MS);
}

setTimeout(schedule, FIRST_DELAY_MS);
window.addEventListener("beforeunload", () => clearTimeout(timer));
