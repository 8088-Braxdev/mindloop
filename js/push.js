// js/push.js
// Closed-app reminders (spec §5).
//
// The reminder card in js/reminders.js only works while MindLoop is open. This
// module gives the server something to send to when the app is closed: a Web
// Push subscription, stored per device in `push_subscriptions` (only the
// signed-in person's own rows are visible, RLS).
//
// Nothing is asked here. The permission prompt stays exactly where it was: the
// app asks once by itself when the first tour ends (js/notify.js), and this
// module only turns an already-granted permission into a subscription.
//
// The subscription carries the device's time zone and the person's quiet
// hours, so api/push-send.js can honour both without guessing.

import { supabase } from "./supabase.js";
import { getSession } from "./auth.js";

const TABLE = "push_subscriptions";
const KEY_URL = "api/push-key";

export function pushSupported() {
  return (
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    typeof Notification !== "undefined" &&
    Notification.permission === "granted"
  );
}

// VAPID keys travel as URL-safe base64; the browser wants raw bytes.
function urlBase64ToUint8Array(value) {
  const padded = (value + "=".repeat((4 - (value.length % 4)) % 4))
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const raw = atob(padded);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function localTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

async function readyRegistration() {
  if (!("serviceWorker" in navigator)) return null;
  try {
    return await navigator.serviceWorker.ready;
  } catch {
    return null;
  }
}

async function fetchPublicKey() {
  try {
    const response = await fetch(KEY_URL, {
      headers: { accept: "application/json" },
      cache: "no-store",
    });
    if (!response.ok) return "";
    const body = await response.json();
    return typeof body.publicKey === "string" ? body.publicKey : "";
  } catch {
    return "";
  }
}

// The subscription this device uses right now, if any (no server call).
export async function currentSubscription() {
  const registration = await readyRegistration();
  if (!registration?.pushManager) return null;
  try {
    return await registration.pushManager.getSubscription();
  } catch {
    return null;
  }
}

// Creates or refreshes this device's subscription. Safe to call on every app
// start: it reuses an existing subscription and only rewrites its row, which
// keeps the stored time zone and quiet hours current.
export async function enablePush({ quiet = null } = {}) {
  if (!pushSupported()) return false;

  const session = await getSession();
  if (!session) return false; // a subscription belongs to an account

  const registration = await readyRegistration();
  if (!registration?.pushManager) return false;

  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    const publicKey = await fetchPublicKey();
    if (!publicKey) return false; // push is not set up on the server yet
    try {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
    } catch (err) {
      console.warn("MindLoop: push subscription failed", err);
      return false;
    }
  }

  const json = subscription.toJSON?.() || {};
  const keys = json.keys || {};
  if (!json.endpoint || !keys.p256dh || !keys.auth) return false;

  const row = {
    user_id: session.user.id,
    endpoint: json.endpoint,
    p256dh: keys.p256dh,
    auth: keys.auth,
    tz: localTimeZone(),
  };
  if (quiet) {
    row.quiet_on = !!quiet.on;
    row.quiet_from = quiet.from || "22:00";
    row.quiet_to = quiet.to || "07:00";
  }

  const { error } = await supabase
    .from(TABLE)
    .upsert(row, { onConflict: "endpoint" });
  if (error) {
    console.warn("MindLoop: push subscription was not saved", error);
    return false;
  }
  return true;
}

// Quiet hours are a device setting; the server needs the copy for this device.
export async function syncQuietHours(quiet) {
  if (!quiet) return;
  const subscription = await currentSubscription();
  if (!subscription?.endpoint) return;
  const { error } = await supabase
    .from(TABLE)
    .update({
      quiet_on: !!quiet.on,
      quiet_from: quiet.from || "22:00",
      quiet_to: quiet.to || "07:00",
    })
    .eq("endpoint", subscription.endpoint);
  if (error) console.warn("MindLoop: quiet hours were not synced", error);
}

// Used when the person blocks notifications or clears this device's data.
export async function disablePush() {
  const subscription = await currentSubscription();
  if (!subscription) return true;
  const endpoint = subscription.endpoint;
  try {
    await subscription.unsubscribe();
  } catch {
    // The browser may already have dropped it.
  }
  const { error } = await supabase.from(TABLE).delete().eq("endpoint", endpoint);
  if (error) console.warn("MindLoop: push row was not removed", error);
  return true;
}
