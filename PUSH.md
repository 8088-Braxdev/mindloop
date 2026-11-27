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
`push_subscriptions`, the `authenticated` grants those policies need (a
missing grant is a `42501` on every save), and RLS-with-no-policies for
`push_log`. The file is idempotent: running it again on a working database
changes nothing, and running it on a half-made one finishes the job.

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

## 5. When nothing arrives

Account → Notifications states what is true on the device: allowed or not, and
whether the account really has this device's row. It never says "Notifications
are on" for a browser subscription alone, because a permission grants nothing
if the row is missing. When it does say they are on and nothing arrives, these
four checks (Supabase → SQL Editor) say which part is quiet.

### What the Account line means

The line names the actual state, and the database's own error code when a save
failed, because the states need different fixes:

| The line says | What is true | What fixes it |
| --- | --- | --- |
| "Notifications are on for this device, and your account has this device saved" | The row exists and reads back | Nothing here; the next checks below are about the sender or the device |
| "MindLoop has no closed-app subscription on this device yet" | The browser never created one (or a renewal never ran) | Tap **Try again**; if it repeats, the reason after the dash names the step that failed |
| "this device is not saved to your account — this browser's subscription is already stored for a different account (23505)" | The browser's endpoint is already a row for another account, so this account can never write it | Tap **Try again**: it replaces the subscription with a new endpoint and saves that. Deleting the other account's row is not needed |
| "the push tables in Supabase do not let this account write to them (42501)" or "do not exist in Supabase yet (42P01)" | PostgreSQL refused the write: the tables are missing, the `authenticated` role has no grant on `push_subscriptions`, or the row failed the insert policy's `user_id = auth.uid()` check | Re-run `supabase/push.sql` (it now adds the grants too), then tap **Try again**. If `42501` comes back, run the grants/policies query below: a missing `INSERT` grant or no insert policy is the cause |
| "the signed-in session has expired (PGRST301 / 401)" | The app's token was stale | Reload, sign in again, tap **Try again** |
| "MindLoop saved this device to your account just now, but the app cannot read that row back" | The write worked but the `select` returned nothing, usually a missing SELECT policy | Re-run `supabase/push.sql` (it recreates the four policies). Until then the line cannot confirm delivery, and reminders may still arrive |

A device can show this line while a reminder still arrives: an older saved row
keeps working until the push service reports its endpoint gone. That is why the
line says "cannot confirm" instead of "off" in that case.

**1. Is this device saved?**

```sql
select id, user_id, tz, quiet_on, created_at
from public.push_subscriptions order by created_at desc;
```

No row → run `supabase/push.sql`, then tap **Allow notifications** (or **Try
again**) on the device. One row per device is normal and expected.

If the save itself answered `42501`, this query shows which half is missing —
the role's grants or the four policies. `authenticated` needs `INSERT`,
`SELECT`, `UPDATE` and `DELETE` plus four policy rows (`INSERT`, `SELECT`,
`UPDATE`, `DELETE`):

```sql
select 'grant' as kind, grantee as who, privilege_type as what
from information_schema.role_table_grants
where table_schema = 'public' and table_name = 'push_subscriptions'
union all
select 'policy', policyname, cmd
from pg_policies
where schemaname = 'public' and tablename = 'push_subscriptions'
order by 1, 2, 3;
```

No `grant` rows for `authenticated`, or fewer than four `policy` rows → re-run
`supabase/push.sql` (it is safe to repeat) and tap **Try again**. Everything
present and the save still answers `42501` → the row's `user_id` does not match
the signed-in session: sign out, sign in again, then **Try again**.

**2. Did the server try to send?**

```sql
select task_key, fire_date, created_at
from public.push_log order by created_at desc limit 10;
```

`task_key` starts with the device id (`<subscription id>#<plan date>#<task
index>`), so two rows with different prefixes for the same task and day mean
both devices were served. This tells you which device is which, and whether it
was served today:

```sql
select s.id as device, s.tz, s.created_at,
       count(l.task_key) as reminders_logged
from public.push_subscriptions s
left join public.push_log l
  on l.task_key like s.id || '#%' and l.fire_date = current_date
group by s.id, s.tz, s.created_at
order by s.created_at;
```

`reminders_logged = 0` on a device that was due means the sender never sent to
it: it was inside that device's quiet hours, its plan had no unanswered
priority with a time, or the run that covered the moment did not happen. A row
means the push service accepted the message. No row for a task that was due → nothing was sent:
the priority has no start time, it already has an answer (started, done,
skipped, postponed), the device's quiet hours covered the moment, or the task
belongs to a plan day older than yesterday. A row means the push service
accepted the message; the device, its settings or its connection is what is
holding it — an offline device receives it on reconnect for up to 12 hours, and
a subscription the service reports as gone (404/410) is removed by the sender,
so the app shows **Try again** until it is allowed again.

**3. Is the 5-minute schedule running?**

```sql
select jobid, jobname, schedule, active from cron.job;
select status, start_time, return_message
from cron.job_run_details order by start_time desc limit 10;
select status_code, content from net._http_response order by id desc limit 5;
```

No `mindloop-push` job → re-run the `cron.schedule` SQL in section 3. `401` in
`content` → `PUSH_CRON_SECRET` and the Vault secret are not the same value.
`500` → a `VAPID_*` or `SUPABASE_*` variable is missing in Vercel. `200` with
`"sent": 0` → nothing was due at that moment; `"sent": 1` or more → the send
left the server.

**4. What does the plan say?**

```sql
select date, priorities from public.entries order by date desc limit 2;
```

The priority needs a `time`, and none of `doneAt`, `startedAt`, `skippedAt`,
`postponedAt`. Closed-app reminders are worked out from each device's own time
zone, so a task planned for "today" on the phone is still due when the sender
looks at the plan written last night.

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
- On Android, a battery-saving mode, "Sleeping apps", Data Saver or the
  browser's own background restriction can hold or drop notifications from a
  browser that is not open. MindLoop and the server cannot change that from the
  web: the browser app has to be left unrestricted, with notifications and
  background data allowed, in the phone's settings. When the account line says
  reminders are on and they still do not arrive on that phone, this is the
  first thing to check.
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
