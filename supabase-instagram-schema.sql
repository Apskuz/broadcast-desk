-- Instagram analytics tables. Run this once in Supabase, the same way as
-- supabase-schema.sql: Project -> SQL Editor -> New query -> paste -> Run.
--
-- SECURITY NOTE, because it differs from hub_state on purpose:
-- hub_state is wide open to the public "anon" key (see supabase-schema.sql).
-- That is fine for a duty board, but an Instagram access token is a credential
-- -- anyone holding it can read the account's private analytics for 60 days.
-- The anon key is visible in the deployed JS bundle, so these tables deny anon
-- access entirely and are reached only by the /api functions using the
-- SUPABASE_SERVICE_ROLE_KEY, which is server-side only and bypasses RLS.

-- One row per connected Instagram account. Holds the credential, so: no anon.
create table if not exists ig_accounts (
  ig_user_id     text primary key,
  username       text,
  account_type   text,
  access_token   text not null,
  token_expires  timestamptz,
  connected_by   text,
  connected_at   timestamptz not null default now(),
  last_synced_at timestamptz,
  last_sync_error text
);

alter table ig_accounts enable row level security;
-- Deliberately no policies: with RLS on and no policy, the anon key can read
-- nothing here. The service role key ignores RLS and is what /api uses.

-- The posts themselves. Slow-changing fields: caption, permalink, thumbnail.
create table if not exists ig_media (
  id            text primary key,
  ig_user_id    text not null references ig_accounts(ig_user_id) on delete cascade,
  media_type    text,            -- IMAGE | VIDEO | CAROUSEL_ALBUM
  media_product_type text,       -- FEED | REELS | STORY
  caption       text,
  permalink     text,
  thumbnail_url text,
  media_url     text,
  posted_at     timestamptz,
  first_seen_at timestamptz not null default now()
);

create index if not exists ig_media_user_posted on ig_media (ig_user_id, posted_at desc);

-- The time series. Meta only ever returns a post's CURRENT totals, never its
-- history, so one row per post per sync is the only way to get growth curves.
-- Everything in here is data we captured ourselves; it is unrecoverable if
-- dropped, because Meta cannot tell us what a post looked like last Tuesday.
create table if not exists ig_media_snapshots (
  id                bigint generated always as identity primary key,
  media_id          text not null references ig_media(id) on delete cascade,
  captured_at       timestamptz not null default now(),
  views             bigint,
  reach             bigint,
  likes             bigint,
  comments          bigint,
  saved             bigint,
  shares            bigint,
  total_interactions bigint,
  follows           bigint,
  profile_visits    bigint,
  avg_watch_time_ms bigint,     -- reels only
  total_watch_time_ms bigint    -- reels only
);

-- One snapshot per post per day is plenty; this makes re-runs idempotent.
create unique index if not exists ig_media_snapshot_daily
  on ig_media_snapshots (media_id, (captured_at::date));

create index if not exists ig_media_snapshots_lookup
  on ig_media_snapshots (media_id, captured_at desc);

-- Account-wide daily numbers. Meta keeps 90 days, so the first sync can
-- backfill a real starting history here (unlike the per-post table above).
create table if not exists ig_account_snapshots (
  id                 bigint generated always as identity primary key,
  ig_user_id         text not null references ig_accounts(ig_user_id) on delete cascade,
  day                date not null,
  followers          bigint,
  reach              bigint,
  views              bigint,
  profile_views      bigint,
  accounts_engaged   bigint,
  total_interactions bigint,
  website_clicks     bigint,
  captured_at        timestamptz not null default now(),
  unique (ig_user_id, day)
);

create index if not exists ig_account_snapshots_lookup
  on ig_account_snapshots (ig_user_id, day desc);

-- Audience demographics: a current-state picture, not a series, and Meta needs
-- 100+ followers before it will return any of it.
create table if not exists ig_demographics (
  id          bigint generated always as identity primary key,
  ig_user_id  text not null references ig_accounts(ig_user_id) on delete cascade,
  breakdown   text not null,   -- age | gender | city | country
  label       text not null,   -- "25-34", "F", "Helsinki", "FI"
  value       bigint not null,
  captured_at timestamptz not null default now(),
  unique (ig_user_id, breakdown, label)
);

-- The analytics themselves are just this team's own post stats, not secrets,
-- and the app reads them straight from the browser to draw the charts. Reads
-- are open; writes stay server-side so nobody can poison the history.
alter table ig_media enable row level security;
alter table ig_media_snapshots enable row level security;
alter table ig_account_snapshots enable row level security;
alter table ig_demographics enable row level security;

create policy "anon can read ig_media" on ig_media for select using (true);
create policy "anon can read ig_media_snapshots" on ig_media_snapshots for select using (true);
create policy "anon can read ig_account_snapshots" on ig_account_snapshots for select using (true);
create policy "anon can read ig_demographics" on ig_demographics for select using (true);

-- A convenience view: each post with its most recent numbers attached, so the
-- "all posts" table is one query instead of one-per-post.
create or replace view ig_media_latest as
select distinct on (m.id)
  m.id, m.ig_user_id, m.media_type, m.media_product_type, m.caption,
  m.permalink, m.thumbnail_url, m.media_url, m.posted_at,
  s.captured_at, s.views, s.reach, s.likes, s.comments, s.saved, s.shares,
  s.total_interactions, s.follows, s.profile_visits,
  s.avg_watch_time_ms, s.total_watch_time_ms
from ig_media m
left join ig_media_snapshots s on s.media_id = m.id
order by m.id, s.captured_at desc;
