// js/push.js
// Closed-app reminders (spec §5).
//
// The reminder card in js/reminders.js only works while MindLoop is open. This
// module gives the server something to send to when the app is closed: a Web
// Push subscription, stored per device in `push_subscriptions` (only the
// signed-in person's own rows are visible, RLS).
//
// Nothing is asked here. The permission prompt stays where it belongs: a real
// tap, either at the end of the tour or on the "Allow notifications" control
// in Account (js/notify.js), and this module only turns an already-granted
// permission into a subscription. Every failure names its reason, so the app
// can say what is actually true instead of promising a reminder it cannot
// deliver.
//
// The subscription carries the device's time zone and the person's quiet
// hours, so api/push-send.js can honour both without guessing.

import { supabase } from "./supabase.js";
import { getSession } from "./auth.js";

const TABLE = "push_subscriptions";
const KEY_URL = "api/push-key";

// Why the last attempt failed, if it did (js/notify.js shows this).
let lastFailure = null;

function failed(reason) {
  lastFailure = reason;
  return { ok: false, reason };
}

export function pushFailure() {
  return lastFailure;
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
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    return failed("unsupported");
  }
  if (typeof Notification === "undefined") return failed("unsupported");
  if (Notification.permission !== "granted") return failed("permission");

  const session = await getSession().catch(() => null);
  if (!session) return failed("signed-out"); // a subscription belongs to an account

  const registration = await readyRegistration();
  if (!registration?.pushManager) return failed("no-service-worker");

  let subscription = await registration.pushManager
    .getSubscription()
    .catch(() => null);
  if (!subscription) {
    const publicKey = await fetchPublicKey();
    if (!publicKey) return failed("no-server-key"); // not set up on the server yet
    try {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
    } catch (err) {
      console.warn("MindLoop: push subscription failed", err);
      return failed("subscribe");
    }
  }

  const json = subscription.toJSON?.() || {};
  const keys = json.keys || {};
  if (!json.endpoint || !keys.p256dh || !keys.auth) {
    return failed("incomplete");
  }

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
    return failed("save");
  }
  lastFailure = null;
  return { ok: true, endpoint: json.endpoint };
}

// Whether the subscription this device is using is actually saved to the
// account. A browser can hold a subscription that the server never received
// (a failed save, a missing table, a signed-out moment), and then the app must
// not claim closed-app reminders work. `saved: null` means the check itself
// failed, which is not the same as "missing".
export async function subscriptionSaved() {
  const subscription = await currentSubscription();
  if (!subscription?.endpoint) return { subscription: null, saved: false };
  const { data, error } = await supabase
    .from(TABLE)
    .select("id")
    .eq("endpoint", subscription.endpoint)
    .maybeSingle();
  if (error) {
    console.warn("MindLoop: this device's saved push row was not readable", error);
    return { subscription, saved: null };
  }
  return { subscription, saved: !!data };
}

// One test notification, sent by the server to this account's devices right
// now. It proves the parts the app cannot see by itself: the VAPID keys, the
// stored row and the push service. It does not prove the 5-minute scheduler
// runs, so a test that arrives while scheduled reminders do not points at the
// schedule, not at this device.
export async function testPush() {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") {
    return { ok: false, code: "permission" };
  }
  const session = await getSession().catch(() => null);
  if (!session) return { ok: false, code: "signin" };
  try {
    const response = await fetch("api/push-test", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${session.access_token}`,
      },
      body: "{}",
    });
    const body = await response.json().catch(() => ({}));
    return {
      ...body,
      http: response.status,
      ok: response.ok && body.status === "ok",
    };
  } catch (err) {
    console.warn("MindLoop: test notification request failed", err);
    return { ok: false, code: "network" };
  }
}

// Quiet hours are a device setting; the server needs the copy for this device.
export async function syncQuietHours(quiet) {
  if (!quiet) return;
  const subscription = await currentSubscription();
  if (!subscription?.endpoint) {
    // This device has not been linked yet (for example the first attempt was
    // made offline). Create the link now, with these hours, so the server has
    // them before the first closed-app reminder.
    await enablePush({ quiet });
    return;
  }
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
  if (!subscription) {
    lastFailure = null;
    return true;
  }
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
