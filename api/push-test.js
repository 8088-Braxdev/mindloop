// api/push-test.js
// Vercel serverless function: sends one test notification to the signed-in
// person's own devices and says exactly which stage of closed-app delivery
// works (spec §5, "the app says what is actually true").
//
// Why this exists: a browser can hold a push subscription that the server
// never saved, and the VAPID keys, the push tables and the 5-minute scheduler
// can each be missing without the app noticing. The Account card only knows
// what the device can see. This endpoint is the other half: it looks the
// person's rows up with the service role and asks the push service to deliver.
//
// It does NOT prove the scheduler works: a direct send bypasses pg_cron. If the
// test arrives but reminders at a priority's start time never do, the schedule
// is the part that is not running (see PUSH.md).

import { createClient } from "@supabase/supabase-js";
import webpush from "web-push";

const MAX_DEVICES = 5; // plenty for one person; the check stays quick
const SETUP_KEYS = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "VAPID_PUBLIC_KEY",
  "VAPID_PRIVATE_KEY",
];

const fail = (res, status, code, message, extra = {}) =>
  res.status(status).json({ status: "error", code, message, ...extra });

const testPayload = {
  title: "Mtihani wa MindLoop",
  body: "Ukipata hii, simu hii inaweza kupokea kumbusho wakati app imefungwa. Ilitumwa sasa hivi.",
  tag: "mindloop-test",
  url: "./",
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return fail(res, 405, "method", "Use POST.");
  }

  const access = (req.headers.authorization || "")
    .replace(/^Bearer\s+/i, "")
    .trim();
  if (!access) {
    return fail(res, 401, "signin", "Sign in on this device first.");
  }

  const missing = SETUP_KEYS.filter((key) => !process.env[key]);
  if (missing.length) {
    // Names only: the values are secrets and never leave the server.
    console.error("MindLoop push test: missing env vars:", missing.join(", "));
    return fail(res, 500, "setup", "Closed-app reminders are not set up so far.", {
      missing,
    });
  }

  const admin = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  // The token comes from the app's own Supabase session, so nobody can ask
  // MindLoop to notify someone else's phone.
  const { data: authData, error: authError } = await admin.auth.getUser(access);
  const user = authData?.user;
  if (authError || !user) {
    return fail(res, 401, "signin", "This session has expired.");
  }

  const { data: subscriptions, error: listError } = await admin
    .from("push_subscriptions")
    .select("id,endpoint,p256dh,auth")
    .eq("user_id", user.id)
    .limit(MAX_DEVICES);
  if (listError) {
    console.error("MindLoop push test: could not read subscriptions", listError);
    return fail(res, 500, "server", "Could not read this account's devices.");
  }
  if (!subscriptions.length) {
    return fail(
      res,
      409,
      "no-subscription",
      "This account has no saved device, so there is nothing to send to.",
    );
  }

  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || "mailto:support@braxcode.com",
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY,
  );

  let sent = 0;
  let removed = 0;
  const failures = [];
  for (const subscription of subscriptions) {
    try {
      await webpush.sendNotification(
        {
          endpoint: subscription.endpoint,
          keys: { p256dh: subscription.p256dh, auth: subscription.auth },
        },
        JSON.stringify(testPayload),
        { TTL: 600 },
      );
      sent += 1;
    } catch (err) {
      const status = err?.statusCode;
      if (status === 404 || status === 410) {
        // The browser threw the subscription away; drop the dead row so the
        // next save starts clean.
        await admin
          .from("push_subscriptions")
          .delete()
          .eq("id", subscription.id);
        removed += 1;
        failures.push({ status: "gone" });
      } else {
        // The push service's own words, short: they name an expired key pair
        // or a malformed subscription, which is what we need to see.
        const detail = String(err?.body || err?.message || "").slice(0, 200);
        console.error("MindLoop push test: send failed", status, detail);
        failures.push({ status: status || 0, detail });
      }
    }
  }

  return res.status(200).json({
    status: "ok",
    devices: subscriptions.length,
    sent,
    removed,
    failures,
  });
}
