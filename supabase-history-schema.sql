-- Board history. Run this once in Supabase, the same way as supabase-schema.sql:
-- Project -> SQL Editor -> New query -> paste -> Run.
--
-- WHY THIS IS A SEPARATE TABLE, and not a column on hub_state:
-- hub_state is read and written on every single edit anyone makes, and the
-- whole row goes over the wire each time. Keeping fifty old copies of the board
-- inside it would multiply the cost of every keystroke by fifty. Snapshots are
-- written rarely and read almost never, so they belong somewhere else.

create table if not exists hub_history (
  id bigint generated always as identity primary key,
  snapshot jsonb not null,
  taken_at timestamptz not null default now(),
  taken_by text,
  note text
);

-- History is read newest-first and nothing else, so that's the index.
create index if not exists hub_history_taken_at_idx on hub_history (taken_at desc);

alter table hub_history enable row level security;

create policy "anon can read hub_history"
  on hub_history for select
  using (true);

create policy "anon can insert hub_history"
  on hub_history for insert
  with check (true);

-- Delete is allowed so the app can keep the newest sixty and let the rest go;
-- without it the table would grow forever. This does mean history is not
-- tamper-proof: anyone who can reach the board can also clear its history.
-- That is the same level of trust the rest of this app already runs on — the
-- anon key is in the bundle — and protecting against a teammate is not what
-- this is for. It is for the far more likely case of someone clearing a board
-- and wanting yesterday back.
create policy "anon can delete hub_history"
  on hub_history for delete
  using (true);

-- Deliberately no update policy: a snapshot is a record of what the board was.
-- Nothing should be able to rewrite one after the fact.
