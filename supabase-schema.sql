-- Run this once in Supabase: Project → SQL Editor → New query → paste → Run.

create table if not exists hub_state (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

-- Seed the single shared row the whole team reads and writes.
insert into hub_state (id, data)
values ('main', '{"adminCode":"","profiles":[],"tasks":[],"calendarEvents":[],"notes":[],"content":[],"ideas":[],"resources":[]}'::jsonb)
on conflict (id) do nothing;

-- Row Level Security: this app has no per-user Supabase auth (login is handled
-- inside the app with team-lead-issued codes), so we open read/write to anyone
-- holding the public "anon" key. That key is meant to be public-ish, but do
-- treat this table as team-trusted data, not sensitive data — anyone with the
-- URL and anon key (visible in your deployed site's JS bundle) can read or
-- write it. Fine for an internal duty board; not fine for anything sensitive.
alter table hub_state enable row level security;

create policy "anon can read hub_state"
  on hub_state for select
  using (true);

create policy "anon can update hub_state"
  on hub_state for update
  using (true)
  with check (true);

create policy "anon can insert hub_state"
  on hub_state for insert
  with check (true);

-- Turn on Realtime for this table so every phone gets pushed live updates:
-- Supabase dashboard → Database → Replication → toggle "hub_state" on.

-- Stores each device's push subscription so /api/send-push.js knows where to
-- deliver notifications. One row per browser/device that has enabled
-- notifications (a person using two devices gets two rows).
create table if not exists push_subscriptions (
  id bigint generated always as identity primary key,
  profile_name text not null,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);

alter table push_subscriptions enable row level security;

create policy "anon can read push_subscriptions"
  on push_subscriptions for select
  using (true);

create policy "anon can insert push_subscriptions"
  on push_subscriptions for insert
  with check (true);

create policy "anon can update push_subscriptions"
  on push_subscriptions for update
  using (true)
  with check (true);

create policy "anon can delete push_subscriptions"
  on push_subscriptions for delete
  using (true);
