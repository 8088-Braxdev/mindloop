// js/notify.js
// Notification permission, asked the way large apps do it: MindLoop asks once
// by itself, when the first tour ends, instead of keeping a
// "Turn on notifications" button in Account.
//
// A browser only shows the prompt when it comes from a real tap, so the ask is
// always attached to one: the tour's last button. Nothing is sent from here —
// the permission only lets the device show a local reminder while the app is
// open.

const ASKED_KEY = "mindloop:notify-asked";

export function notificationState() {
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.permission; // "default" | "granted" | "denied"
}

function hasAsked() {
  try {
    return localStorage.getItem(ASKED_KEY) === "1";
  } catch {
    return true; // no storage: never nag
  }
}

function markAsked() {
  try {
    localStorage.setItem(ASKED_KEY, "1");
  } catch {
    // Per-device convenience only.
  }
}

// Once the permission is granted, this device also asks for a Web Push
// subscription, so reminders can reach the phone while MindLoop is closed
// (spec §5). Every failure is silent: the in-app reminder card still works.
export function syncPush() {
  import("./push.js")
    .then((push) => push.enablePush())
    .catch((err) =>
      console.warn("MindLoop: closed-app reminders unavailable", err),
    );
}

export function syncPushIfGranted() {
  if (notificationState() === "granted") syncPush();
}

// Call from a click/tap handler. Asking once is the whole point: if the prompt
// was dismissed, the person is not asked again.
export function askNotificationPermission() {
  if (notificationState() !== "default" || hasAsked()) return;
  markAsked();
  try {
    const result = Notification.requestPermission();
    if (result && typeof result.then === "function") {
      result
        .then((state) => {
          if (state === "granted") syncPush();
        })
        .catch(() => {});
    }
  } catch (err) {
    console.warn("MindLoop: notification permission failed", err);
  }
}

// Anyone who finished the tour before this existed is asked on their next real
// tap, once. Taps inside the tour are ignored, because the tour's ending asks
// directly.
export function askOnFirstTap() {
  if (notificationState() !== "default" || hasAsked()) return;
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
