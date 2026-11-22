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
| Sender | `api/push-send.js` | Reads subscriptions, works out each device's local date and clock, and sends the reminder for priorities whose start time (or that priority's own "Remind me" lead) has arrived and that still have no answer. `push_log` guarantees one send per task per day. |
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

## Honest limits

- A reminder arrives within 10 minutes of the start time, not at the exact
  second: the scheduler runs every 5 minutes and the sender accepts a small
  window so a slow or missed run does not lose the reminder.
- A phone that is off, offline, or has the app's notifications blocked gets no
  push. The card is still there when the app opens.
- Quiet hours silence push as well, using the hours saved on that device.
- Closed-app reminders use each priority's start time and that priority's own
  "Remind me" choice (Account's setting is the default when the priority has
  none). The sender's window grows by that lead, so a 15-minute lead can arrive
  up to 15 minutes early and never later than 10 minutes after the start time.
