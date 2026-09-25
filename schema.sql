-- Nordica Birth — one-time Supabase setup.
-- Run this whole file once in your Supabase project's SQL Editor
-- (left sidebar → SQL Editor → New query → paste this in → Run).
--
-- This creates:
--   - a `boards` table and a `cards` table for your data
--   - Row Level Security so only your own logged-in account can ever
--     read or write your rows, even though the app's API key is public
--   - a private file storage bucket ("blobs") for your uploaded images,
--     PDFs, and audio, locked down the same way

-- ---------- Tables ----------

create table if not exists boards (
  id uuid primary key,
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  view jsonb
);

create table if not exists cards (
  id uuid primary key,
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  board_id uuid not null references boards(id) on delete cascade,
  type text not null,
  x double precision not null,
  y double precision not null,
  w double precision not null,
  h double precision not null,
  z_index integer not null default 1,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists cards_board_id_idx on cards(board_id);

-- ---------- Row Level Security ----------
-- Every table starts open to nobody, then we grant access only to rows a
-- user owns. This is what actually keeps your data private — the app's
-- anon key alone grants no access without a matching logged-in session.

alter table boards enable row level security;
alter table cards enable row level security;

drop policy if exists "owner can manage boards" on boards;
create policy "owner can manage boards" on boards
  for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);

drop policy if exists "owner can manage cards" on cards;
create policy "owner can manage cards" on cards
  for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);

-- ---------- File storage ----------

insert into storage.buckets (id, name, public)
values ('blobs', 'blobs', false)
on conflict (id) do nothing;

drop policy if exists "owner can manage own files" on storage.objects;
create policy "owner can manage own files" on storage.objects
  for all
  using (bucket_id = 'blobs' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'blobs' and (storage.foldername(name))[1] = auth.uid()::text);

-- ---------- Sub-boards (added later; safe to run on an existing project) ----------
-- Lets a board live inside another one. If a parent board is ever removed, its
-- sub-boards are kept and simply become top-level boards.

alter table boards add column if not exists parent_id uuid references boards(id) on delete set null;
create index if not exists boards_parent_id_idx on boards(parent_id);
