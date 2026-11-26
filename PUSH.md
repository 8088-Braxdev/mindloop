# Closed-app reminders (spec §5)

MindLoop can already show a reminder while it is open (`js/reminders.js`). This
document is everything needed to also deliver the reminder when the app is
**closed**, and to keep the honest promise: one reminder per priority, at its
start time, never a follow-up.

How the parts fit:

| Part | File | Job |
| --- | --- | --- |
| Browser | `js/push.js` | Turns an already-granted notification permission into a Web Push subscription, and keeps that device's time zone and quiet hours on the server. No new permission prompt: the app still asks once, when the first tour ends. |
| Key | `api/push-key.js` | Returns `VAPID_PUBLIC_KEY` to the browser. The private key never leaves Vercel. |
| Sender | `api/push-send.js` | Reads subscriptions, works out each device's local date and clock, and sends the reminder for priorities whose start time (or that priority's own "Remind me" lead) has arrived and that still have no answer. `push_log` guarantees one send per task per day **on each device**. |
| Worker | `sw.js` | `push` handler shows the notification; tapping it opens the app. |
| Database | `supabase/push.sql` | `push_subscriptions` (private per person, RLS) and `push_log` (server only). |
| Scheduler | Supabase `pg_cron` | Vercel's free plan only allows daily crons, so the 5-minute ping comes from Supabase instead. |

## 1. Database

Open Supabase → SQL Editor and run the whole of `supabase/push.sql`.
It creates both tables, the four `entries`-style policies for
`push_subscriptions`, and RLS-with-no-policies for `push_log`.

## 2. VAPID keys

Generate one pair, once, on your own machine:

```bash
npx web-push generate-vapid-keys
```

You get a public and a private key. Add them to **Vercel → Project → Settings →
Environment Variables** (Production and Preview), never to the repository:

```
VAPID_PUBLIC_KEY   = <public key>
VAPID_PRIVATE_KEY  = <private key>
VAPID_SUBJECT      = mailto:you@your-domain
PUSH_CRON_SECRET   = <a long random string you invent>
```

`VAPID_SUBJECT` is the contact address push services complain to; a `mailto:`
or a URL is fine.

## 3. Scheduler

The sender must be called every 5 minutes. On Supabase's free plan, `pg_cron`
plus `pg_net` does that; store the shared secret in Vault so it is not readable
in plain text:

```sql
-- once: keep the cron secret in Vault (use the SAME value as PUSH_CRON_SECRET)
select vault.create_secret('paste-your-push-cron-secret-here', 'mindloop_push_cron');

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'mindloop-push',
  '*/5 * * * *',
  $$
  select net.http_post(
    url     := 'https://mindloop.braxcode.com/api/push-send',
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-mindloop-cron', (select decrypted_secret
                          from vault.decrypted_secrets
                          where name = 'mindloop_push_cron')
    ),
    body    := '{}'::jsonb
  );
  $$
);
```

Check it later with `select * from cron.job_run_details order by start_time desc limit 20;`.
Remove it with `select cron.unschedule('mindloop-push');`.

If you ever move to a paid Vercel plan, you can drop `pg_cron` and use
`vercel.json` instead:

```json
{ "crons": [{ "path": "/api/push-send", "schedule": "*/5 * * * *" }] }
```

with `CRON_SECRET` set to the same value as `PUSH_CRON_SECRET`.

## 4. Deploy and test

1. `npm install` (adds `web-push`), deploy to Vercel.
2. On a phone: open MindLoop, sign in, finish (or skip) the tour, and **allow**
   notifications. That tap creates the subscription.
3. Check the row: `select user_id, tz, quiet_on, created_at from public.push_subscriptions;`
4. Add a priority with a start time ~10 minutes from now — last night's plan
   for today is used first, and a priority typed in during the day counts too —
   then close the app and wait. One notification should arrive within the
   10-minute window and no second one afterwards.
5. Check the send: `select * from public.push_log order by created_at desc limit 5;`

## 5. When nothing arrives: the one-tap check

Account → Reminders has **Send a test notification**. It asks
`api/push-test.js` to send right now to this account's saved devices, using the
same keys and server as a real reminder, and it names the stage that fails:

| What it says | What is actually broken |
| --- | --- |
| The server is not set up… and names a missing variable | A `VAPID_*` or `SUPABASE_*` variable is missing in Vercel. Add it, then redeploy. |
| The server has no saved device for this account | `supabase/push.sql` has not been run, RLS rejected the save, or the save failed. Check `select * from public.push_subscriptions;` and run the SQL file. |
| The push service refused the send (401/403) | `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` are not a pair, or the subject is not a `mailto:`/URL. Generate one pair with `npx web-push generate-vapid-keys` and use both halves. |
| …gone (410), so it was removed | The browser dropped the subscription. Tap **Try again** above to save a new one. |
| The server sent the test… but nothing appeared | The keys, the row and the send path all work, so the phone or browser is holding it back: on iPhone it must be the Home Screen app, and iOS chooses when to show a notification (leave MindLoop first). Check the phone's notification settings and Focus. |

The test is sent **directly**, not by the 5-minute schedule. So:

- test arrives, reminders at a priority's start time do not → the schedule is
the part that is not running. Check `select * from cron.job_run_details order by start_time desc limit 20;` and re-run the `cron.schedule` SQL in section 3.
- test fails → the problem is before the schedule; fix the row above first.

One more difference, and it used to be a trap: the test does not write
`push_log`, so it reaches every device, while a reminder writes there to avoid
sending twice. That key was once per task and day only, so with a phone and a
laptop the first device in the list took the row and every other device was
skipped — the phone stayed silent while the test rang it. `push_log.task_key`
now starts with the device id (`<subscription id>#<plan date>#<task index>`), so
each device gets its own single reminder. Rows written before this fix keep the
old shape and simply never match again, which is harmless.

This is also why Account no longer says "Notifications are on" for a browser
subscription alone: it now asks the account whether this device's row exists
(RLS lets a person read their own), so a silently failed save shows as
"not saved" instead of a promise.

## Honest limits

- A reminder arrives within 10 minutes of the start time, not at the exact
  second: the scheduler runs every 5 minutes and the sender accepts a small
  window so a slow or missed run does not lose the reminder.
- A device that is offline or asleep is not skipped: the reminder is sent with a
  12-hour retention (`TTL`), so the push service keeps it and delivers it when
  the connection returns. A reminder older than that is dropped by the push
  service; the card in the app still shows the unanswered priority.
- A phone that is off, or has the app's notifications blocked, gets no push. The
  card is still there when the app opens.
- The notification words are English, like the rest of the app: "Time to start"
  (or "Heads-up: starting soon" with a lead), the task's own words, and its
  start time. A finish-time heads-up reads "Your finish time has arrived".
- Quiet hours silence push as well, using the hours saved on that device.
- One reminder per priority per day on **each** device that allowed
  notifications, so a phone and a laptop both ring once. `push_log` holds one
  row per device, so the same reminder is never sent twice to the same one.
- Closed-app reminders use each priority's start time and that priority's own
  "Remind me" choice (Account's setting is the default when the priority has
  none). The sender's window grows by that lead, so a 15-minute lead can arrive
  up to 15 minutes early and never later than 10 minutes after the start time.
