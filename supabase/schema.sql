-- =====================================================================
-- Bookshelf database setup. Paste this whole file into the Supabase
-- SQL Editor and click "Run".
--
-- BEFORE YOU RUN IT: find the placeholder text inside the is_owner() function below (it is in
-- quote marks) and replace it with your own user's "User UID" from
-- Supabase > Authentication > Users. There is only one place to change.
-- =====================================================================

create extension if not exists pg_trgm;

-- ---------------------------------------------------------------------
-- 1. The owner check. Only the user whose UID is written here may
--    add, edit or delete books and cover images.
-- ---------------------------------------------------------------------
create or replace function public.is_owner()
returns boolean
language sql
stable
as $$
  select auth.uid()::text = '659c1e6c-c8da-4235-a076-19106f5ba9aa'
$$;

-- ---------------------------------------------------------------------
-- 2. Books table
-- ---------------------------------------------------------------------
create table if not exists public.books (
  id           uuid primary key default gen_random_uuid(),
  title        text not null check (length(trim(title)) > 0),
  author       text not null check (length(trim(author)) > 0),
  pub_year     int  check (pub_year between 1000 and 2999),
  pages        int  check (pages > 0),            -- used by books
  duration     text,                              -- used by audiobooks, e.g. '5h 20m'
  language     text not null check (language  in ('English', 'Bengali')),
  format       text not null check (format    in ('Book', 'Audiobook')),
  status       text not null check (status    in ('want', 'reading', 'read')),
  ownership    text not null check (ownership in ('owned', 'buy')),
  youtube_url  text,                              -- audiobooks only
  description  text,
  genres       text[] not null default '{}',      -- e.g. {Novel,Classic}; shown on the book page only
  copies       text[] not null default '{}',      -- which copies I have: {hardcopy}, {ebook} or both; book page only
  finished_at  date,                              -- when I finished it (read books); orders the home carousel
  isbn         text,                              -- filled by the Goodreads import
  cover_url    text,                              -- cover link found by the import (Open Library); an uploaded cover wins
  cover_path   text,                              -- file name inside the "covers" bucket
  created_at   timestamptz not null default now(),
  constraint youtube_only_for_audiobooks
    check (youtube_url is null or format = 'Audiobook')
);

-- Already ran an earlier version of this file? This adds the new column and does nothing otherwise.
alter table public.books add column if not exists genres text[] not null default '{}';
alter table public.books add column if not exists copies text[] not null default '{}';
alter table public.books add column if not exists finished_at date;
alter table public.books add column if not exists isbn text;
alter table public.books add column if not exists cover_url text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'books_copies_valid') then
    alter table public.books add constraint books_copies_valid check (copies <@ array['hardcopy', 'ebook']::text[]);
  end if;
end $$;

-- Search helpers (lower-case + trigram indexes)
create index if not exists books_title_trgm  on public.books using gin (lower(title)  gin_trgm_ops);
create index if not exists books_author_trgm on public.books using gin (lower(author) gin_trgm_ops);
create index if not exists books_status_idx  on public.books (status, format);

-- ---------------------------------------------------------------------
-- 3. Row-level security: everyone can read, only the owner can write
-- ---------------------------------------------------------------------
alter table public.books enable row level security;

drop policy if exists "Anyone can read books"   on public.books;
drop policy if exists "Owner can insert books"  on public.books;
drop policy if exists "Owner can update books"  on public.books;
drop policy if exists "Owner can delete books"  on public.books;

create policy "Anyone can read books"  on public.books for select using (true);
create policy "Owner can insert books" on public.books for insert with check (public.is_owner());
create policy "Owner can update books" on public.books for update using (public.is_owner()) with check (public.is_owner());
create policy "Owner can delete books" on public.books for delete using (public.is_owner());

grant select on public.books to anon, authenticated;
grant insert, update, delete on public.books to authenticated;

-- ---------------------------------------------------------------------
-- 4. Storage bucket for cover images (public read, owner-only write)
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('covers', 'covers', true, 2097152, array['image/jpeg', 'image/webp', 'image/png'])
on conflict (id) do update
  set public = true,
      file_size_limit = 2097152,
      allowed_mime_types = array['image/jpeg', 'image/webp', 'image/png'];

drop policy if exists "Anyone can view covers"   on storage.objects;
drop policy if exists "Owner can upload covers"  on storage.objects;
drop policy if exists "Owner can update covers"  on storage.objects;
drop policy if exists "Owner can delete covers"  on storage.objects;

create policy "Anyone can view covers"  on storage.objects for select using (bucket_id = 'covers');
create policy "Owner can upload covers" on storage.objects for insert with check (bucket_id = 'covers' and public.is_owner());
create policy "Owner can update covers" on storage.objects for update using (bucket_id = 'covers' and public.is_owner());
create policy "Owner can delete covers" on storage.objects for delete using (bucket_id = 'covers' and public.is_owner());
