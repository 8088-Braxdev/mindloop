-- supabase/push.sql
-- Closed-app reminders (spec §5): the two tables the push sender needs.
-- Paste this whole file into Supabase → SQL Editor → Run. It is idempotent.
--
-- push_subscriptions  one row per device that allowed notifications.
--                     The browser writes its own row; RLS keeps it private.
-- push_log            one row per reminder actually sent to one device, so
--                     two runs of the scheduler can never send the same
--                     reminder twice. task_key starts with the device id, so a
--                     phone and a laptop each get their own reminder.
--                     Server-only: RLS on, no policies.

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid()
    references auth.users (id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  tz text not null default 'UTC',
  quiet_on boolean not null default false,
  quiet_from text not null default '22:00',
  quiet_to text not null default '07:00',
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create index if not exists push_subscriptions_user_id_idx
  on public.push_subscriptions (user_id);

alter table public.push_subscriptions enable row level security;

drop policy if exists "push_subscriptions_select_own" on public.push_subscriptions;
create policy "push_subscriptions_select_own" on public.push_subscriptions
  for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "push_subscriptions_insert_own" on public.push_subscriptions;
create policy "push_subscriptions_insert_own" on public.push_subscriptions
  for insert to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists "push_subscriptions_update_own" on public.push_subscriptions;
create policy "push_subscriptions_update_own" on public.push_subscriptions
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists "push_subscriptions_delete_own" on public.push_subscriptions;
create policy "push_subscriptions_delete_own" on public.push_subscriptions
  for delete to authenticated
  using (user_id = (select auth.uid()));

create table if not exists public.push_log (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  task_key text not null,
  fire_date date not null,
  created_at timestamptz not null default now(),
  unique (user_id, task_key, fire_date)
);

create index if not exists push_log_user_id_idx on public.push_log (user_id);

alter table public.push_log enable row level security;
-- No policies on purpose: only the service role (api/push-send.js) may touch it.

-- ---------------------------------------------------------------------------
-- Optional: prune the log after 90 days (keeps it small forever).
-- ---------------------------------------------------------------------------
create or replace function public.prune_push_log()
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.push_log where fire_date < current_date - 90;
$$;

revoke execute on function public.prune_push_log() from anon, authenticated;
grant execute on function public.prune_push_log() to service_role;
