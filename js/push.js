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

// Why the last attempt failed, if it did (js/notify.js shows this). The
// database's own code is kept too: it is the only fact that tells "the tables
// are not set up" apart from "this endpoint already belongs to another
// account", and the two need different words.
let lastFailure = null;

function failed(reason, code = "") {
  lastFailure = { reason, code: String(code || "") };
  return { ok: false, reason, code: lastFailure.code };
}

// PostgREST answers with a string code ("42501", "42P01", "23505",
// "PGRST301"); a bare status is the fallback when only that arrived.
function errorCode(error) {
  return String(error?.code || error?.status || "");
}

export function pushFailure() {
  return lastFailure;
}

// An upsert is INSERT ... ON CONFLICT DO UPDATE, and Postgres applies the
// update half to the row that already holds this endpoint. When that row
// belongs to another account the person cannot see it, so the update fails and
// Postgres answers "new row violates row-level security policy (USING
// expression)" — code 42501, the same code a missing grant gives. The words
// are the only thing that tells the two apart, and they need opposite fixes:
// this one needs a new endpoint, a missing grant needs SQL.
function belongsToAnotherAccount(error) {
  const text = `${error?.message || ""} ${error?.details || ""}`;
  return /using expression/i.test(text);
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
//
// `fresh` replaces the subscription instead of reusing it. Only one situation
// calls for that: the endpoint is already stored for a different account
// (23505), so this account can never save it — a new endpoint is the only thing
// that can be saved. Account asks for it from a real tap (js/notify.js), never
// on its own, because replacing a working subscription is a real change.
export async function enablePush({ quiet = null, fresh = false } = {}) {
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
  if (fresh && subscription) {
    const stale = subscription.endpoint;
    try {
      await subscription.unsubscribe();
    } catch {
      // The browser may already have dropped it.
    }
    // Its row is the one this account could not write; drop it so the sender
    // does not keep a dead endpoint (RLS deletes only the person's own rows).
    const { error: dropError } = await supabase
      .from(TABLE)
      .delete()
      .eq("endpoint", stale);
    if (dropError) {
      console.warn("MindLoop: old push row was not removed", dropError);
    }
    subscription = null;
  }
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
    // This browser's endpoint is already a row for a different account, so no
    // attempt at this endpoint can ever be saved for this one. A new endpoint
    // is the only thing that can be stored; replacing it is safe here because
    // the existing one delivers nothing to this account. Done once, never in a
    // loop: the retry runs with `fresh`, so a second failure is reported.
    if (!fresh && belongsToAnotherAccount(error)) {
      return enablePush({ quiet, fresh: true });
    }
    return failed("save", errorCode(error));
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
  // `saved: false` here means the row could not be found, not that the browser
  // has nothing: Account words the two differently.
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
