// api/push-send.js
// Vercel serverless function: sends the closed-app reminder for priorities
// whose start time has just arrived (spec §5).
//
// Called by a scheduler every 5 minutes (see PUSH.md: Supabase pg_cron, because
// Vercel's free plan only allows daily crons). It is safe to call at any time
// and safe to call twice: push_log's unique key means one reminder per task per
// local day, even if two runs overlap.
//
// What it never does: guess. A reminder is only sent for a priority the person
// wrote, with a start time, that still has no answer, on the day it is planned
// for, outside the quiet hours of that device.

import { createClient } from "@supabase/supabase-js";
import webpush from "web-push";
import { addDays, getCardPlan } from "../js/logic.js";

const WINDOW_MIN = 10; // due = start time reached within the last 10 minutes
const MAX_SUBSCRIPTIONS = 500; // one run stays a small, quick job

const fail = (res, status, code, message) =>
  res.status(status).json({ status: "error", code, message });

const clockMinutes = (value) => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value || "");
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
};

// The device's own clock: the date and minute-of-day where the person lives.
function localNow(tz) {
  const zone = typeof tz === "string" && tz ? tz : "UTC";
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(new Date());
    const at = Object.fromEntries(parts.map((p) => [p.type, p.value]));
    const hour = Number(at.hour) % 24; // some engines print 24 for midnight
    return {
      dateKey: `${at.year}-${at.month}-${at.day}`,
      minutes: hour * 60 + Number(at.minute),
    };
  } catch {
    // An unknown time zone must not stop every other person's reminder.
    const now = new Date();
    return {
      dateKey: now.toISOString().slice(0, 10),
      minutes: now.getUTCHours() * 60 + now.getUTCMinutes(),
    };
  }
}

// Quiet hours may cross midnight; they stay silent on the device's clock.
function inQuietHours(subscription, minutes) {
  if (!subscription.quiet_on) return false;
  const from = clockMinutes(subscription.quiet_from);
  const to = clockMinutes(subscription.quiet_to);
  if (from === null || to === null) return false;
  return from <= to
    ? minutes >= from && minutes < to
    : minutes >= from || minutes < to;
}

function reminderPayload(item, planDate) {
  return {
    title: "Muda wa kuanza umefika",
    body: `"${item.text}" — ${item.time}. Dakika 5 tu za kuanza zinatosheleza.`,
    tag: `mindloop-start-${planDate}-${item.index}`,
    url: "./",
  };
}

function authorized(req) {
  const secret = process.env.PUSH_CRON_SECRET;
  if (!secret) return true; // nothing configured: no shared secret to check
  const header = req.headers.authorization || "";
  const alt = req.headers["x-mindloop-cron"] || "";
  return header === `Bearer ${secret}` || alt === secret;
}

export default async function handler(req, res) {
  if (!["GET", "POST"].includes(req.method)) {
    return fail(res, 405, "method", "Use GET or POST.");
  }
  if (!authorized(req)) return fail(res, 401, "signin", "Not allowed.");

  const missing = [
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "VAPID_PUBLIC_KEY",
    "VAPID_PRIVATE_KEY",
  ].filter((key) => !process.env[key]);
  if (missing.length) {
    console.error("MindLoop push: missing env vars:", missing.join(", "));
    return fail(res, 500, "setup", "Closed-app reminders are not set up yet.");
  }

  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || "mailto:support@braxcode.com",
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY,
  );

  const admin = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  const { data: subscriptions, error: listError } = await admin
    .from("push_subscriptions")
    .select("id,user_id,endpoint,p256dh,auth,tz,quiet_on,quiet_from,quiet_to")
    .limit(MAX_SUBSCRIPTIONS);
  if (listError) {
    console.error("MindLoop push: could not read subscriptions", listError);
    return fail(res, 500, "server", "Could not read subscriptions.");
  }

  const result = {
    subscriptions: subscriptions.length,
    sent: 0,
    quiet: 0,
    answered: 0,
    removed: 0,
    failed: 0,
  };

  for (const subscription of subscriptions) {
    const now = localNow(subscription.tz);
    if (inQuietHours(subscription, now.minutes)) {
      result.quiet += 1;
      continue;
    }

    // The plan for today was written last night; today's entry is a fallback
    // for anyone who writes during the day.
    const dates = [addDays(now.dateKey, -1), now.dateKey];
    const { data: rows, error: entryError } = await admin
      .from("entries")
      .select("date,priorities")
      .eq("user_id", subscription.user_id)
      .in("date", dates);
    if (entryError) {
      console.error("MindLoop push: could not read entries", entryError);
      result.failed += 1;
      continue;
    }

    const { planDate, items } = getCardPlan(rows || [], now.dateKey, false);

    for (const item of items) {
      if (!item.time) continue;
      if (item.doneAt || item.startedAt || item.skippedAt || item.postponedAt) {
        result.answered += 1;
        continue;
      }
      const start = clockMinutes(item.time);
      if (start === null) continue;
      const late = now.minutes - start;
      if (late < 0 || late >= WINDOW_MIN) continue;

      // One reminder per task per day: the insert is the lock.
      const { error: logError } = await admin.from("push_log").insert({
        user_id: subscription.user_id,
        task_key: `${planDate}#${item.index}`,
        fire_date: now.dateKey,
      });
      if (logError) continue; // already sent (23505), or the log is unavailable

      try {
        await webpush.sendNotification(
          {
            endpoint: subscription.endpoint,
            keys: { p256dh: subscription.p256dh, auth: subscription.auth },
          },
          JSON.stringify(reminderPayload(item, planDate)),
          { TTL: 900 },
        );
        result.sent += 1;
      } catch (err) {
        const status = err?.statusCode;
        if (status === 404 || status === 410) {
          // The browser threw this subscription away.
          await admin
            .from("push_subscriptions")
            .delete()
            .eq("id", subscription.id);
          result.removed += 1;
        } else {
          console.error("MindLoop push: send failed", status, err?.body || err);
          result.failed += 1;
        }
      }
    }
  }

  return res.status(200).json({ status: "ok", ...result });
}
