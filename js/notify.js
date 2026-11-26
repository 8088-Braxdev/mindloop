// js/notify.js
// Notification permission, asked honestly.
//
// Two things this module refuses to do: claim a reminder will reach the phone
// when it cannot, and hide the ask behind one moment that may never happen.
// The app still asks by itself after the tour (and on the next real tap for
// anyone who finished the tour earlier), and Account has a plain
// "Allow notifications" / "Try again" control that always works. A browser
// only shows the prompt from a real tap, so every ask is attached to one.
//
// Nothing is sent from here: the permission lets the device show a local
// reminder while the app is open, and (through js/push.js) lets the server
// reach it while the app is closed.

import { cachedUserId } from "./auth.js";

const ASK_COUNT_KEY = "mindloop:notify-asks";
const QUIET_KEY = "mindloop:quiet-hours";
const AUTO_ASK_LIMIT = 2; // never nag: two automatic asks, then Account

// The permission has no event of its own, so every path that can change what
// this device may do announces it. Account repaints on this instead of showing
// the answer from before the prompt appeared.
const CHANGE_EVENT = "mindloop:notify-change";

function announce() {
  try {
    document.dispatchEvent(new CustomEvent(CHANGE_EVENT));
  } catch {
    // Older browsers: Account still refreshes when it becomes visible again.
  }
}

export function onNotificationChange(handler) {
  document.addEventListener(CHANGE_EVENT, handler);
  return () => document.removeEventListener(CHANGE_EVENT, handler);
}

export function notificationState() {
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.permission; // "default" | "granted" | "denied"
}

export function isInstalled() {
  try {
    return (
      window.matchMedia("(display-mode: standalone)").matches ||
      window.matchMedia("(display-mode: fullscreen)").matches ||
      window.navigator.standalone === true
    );
  } catch {
    return false;
  }
}

function isIos() {
  const ua = navigator.userAgent || "";
  return (
    /iPad|iPhone|iPod/.test(ua) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

function autoAsksUsed() {
  try {
    return Number(localStorage.getItem(ASK_COUNT_KEY)) || 0;
  } catch {
    return AUTO_ASK_LIMIT; // no storage: never nag
  }
}

function recordAsk() {
  try {
    localStorage.setItem(ASK_COUNT_KEY, String(autoAsksUsed() + 1));
  } catch {
    // Per-device convenience only.
  }
}

// The copy of the quiet hours the person set on this device. push.js stores it
// with the subscription, so the server can stay silent too.
function readQuiet() {
  const uid = cachedUserId();
  if (!uid) return null;
  try {
    const parsed = JSON.parse(
      localStorage.getItem(`${QUIET_KEY}:${uid}`) || "null",
    );
    if (!parsed || typeof parsed !== "object") return null;
    return {
      on: !!parsed.on,
      from: parsed.from || "22:00",
      to: parsed.to || "07:00",
    };
  } catch {
    return null;
  }
}

let attempt = null;
let lastResult = { ok: null, reason: null };

// Creates or refreshes this device's closed-app subscription. One attempt at a
// time; every caller sees the same result instead of racing three upserts.
export function syncPush() {
  if (attempt) return attempt;
  attempt = import("./push.js")
    .then((push) => push.enablePush({ quiet: readQuiet() }))
    .then((result) => {
      lastResult = result;
      if (!result?.ok) {
        console.warn(
          "MindLoop: closed-app reminders unavailable —",
          result?.reason || "unknown",
        );
      }
      return result;
    })
    .catch((err) => {
      lastResult = { ok: false, reason: "error" };
      console.warn("MindLoop: closed-app reminders unavailable", err);
      return lastResult;
    })
    .finally(() => {
      attempt = null;
      announce();
    });
  return attempt;
}

export function syncPushIfGranted() {
  if (notificationState() === "granted") syncPush();
}

// What is actually true on this device right now, for the Account line and
// for anything that has to be honest about closed-app reminders.
// permission: "default" | "granted" | "denied" | "unsupported"
// saved:      true when the account really has this device's row; false when it
//             does not; null when the check could not run
// push:       "on" when this device has a live subscription that the account
//             has saved, otherwise "off"
// reason:     why it is off, when push.js knows
export async function notificationReport() {
  const permission = notificationState();
  const report = {
    permission,
    supported: permission !== "unsupported",
    installed: isInstalled(),
    iosTab: isIos() && !isInstalled(),
    subscribed: false,
    saved: null,
    push: "off",
    reason: null,
  };
  if (permission !== "granted") return report;

  if (attempt) await attempt.catch(() => {});

  let subscription = null;
  let saved = null;
  try {
    const push = await import("./push.js");
    const check = await push.subscriptionSaved();
    subscription = check.subscription;
    saved = check.saved;
  } catch {
    // Treated as "no subscription" below.
  }
  report.subscribed = !!subscription;
  report.saved = saved;
  if (subscription && saved !== false) {
    // A row that is confirmed saved is what "on" means; an unreadable check is
    // not evidence of a problem, so it keeps the previous answer.
    report.push = "on";
  } else if (subscription) {
    report.reason = "not-saved";
  } else if (lastResult.ok === false) {
    report.reason = lastResult.reason;
  }
  return report;
}

// The Account control. Asking always comes from a real tap. If the permission
// is already granted, this doubles as "try closed-app reminders again".
export async function requestNotifications() {
  if (notificationState() === "default") {
    try {
      const state = await Notification.requestPermission();
      recordAsk();
      if (state === "granted") await syncPush();
    } catch (err) {
      console.warn("MindLoop: notification permission failed", err);
    }
  } else if (notificationState() === "granted") {
    await syncPush();
  }
  announce();
  return notificationReport();
}

// Call from a click/tap handler. The app asks at most twice by itself; after
// that the Account control is the place to change the decision, so nobody is
// nagged. A dismissed prompt still counts, because it was shown.
export async function askNotificationPermission() {
  if (notificationState() !== "default" || autoAsksUsed() >= AUTO_ASK_LIMIT) {
    return notificationState();
  }
  recordAsk();
  try {
    const state = await Notification.requestPermission();
    if (state === "granted") await syncPush();
    return state;
  } catch (err) {
    // No prompt appeared at all (not a gesture, blocked context, older iOS).
    // The Account control can still try later.
    console.warn("MindLoop: notification permission failed", err);
    return "default";
  } finally {
    // The prompt may have been answered while Account was already open.
    announce();
  }
}

// Anyone who finished the tour before this existed is asked on their next real
// tap, once (or twice, per the limit above). Taps inside the tour are ignored,
// because the tour's ending asks directly.
export function askOnFirstTap() {
  if (notificationState() !== "default" || autoAsksUsed() >= AUTO_ASK_LIMIT) {
    return;
  }
  const handler = () => {
    const tour = document.getElementById("tour-tooltip");
    if (tour && !tour.hidden) {
      document.addEventListener("pointerdown", handler, {
        once: true,
        passive: true,
      });
      return;
    }
    askNotificationPermission();
  };
  document.addEventListener("pointerdown", handler, {
    once: true,
    passive: true,
  });
}

// Back online after a failed attempt (a common case: the app was opened
// offline, so the subscription could not be saved): try once more, quietly.
window.addEventListener("online", () => {
  if (notificationState() === "granted") syncPush();
});

// The browser can renew a subscription on its own while the app is closed
// (sw.js). When it says so, save the new endpoint.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data?.type === "mindloop:push-renewed") syncPush();
  });
}
