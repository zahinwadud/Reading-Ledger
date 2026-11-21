-- =====================================================================
-- The reader (21 November 2026).
-- Paste this whole file into the Supabase SQL Editor and click "Run". Run it once.
-- It only adds new tables. Nothing existing is changed, and running it twice is safe.
--
--   readers            who may open book files: you (always, through is_owner()) plus the people
--                      listed here (your sister and your wife). Add them after their accounts exist.
--   book_files         which books have a file in Backblaze B2, and where. Only readers can see it,
--                      so visitors to the site never learn which books have a file.
--   reading_positions  where each reader stopped in each book. Everyone sees only their own.
-- =====================================================================

-- 1. Readers ------------------------------------------------------------
create table if not exists public.readers (
  user_id   uuid primary key references auth.users (id) on delete cascade,
  name      text not null,
  added_at  timestamptz not null default now()
);
alter table public.readers enable row level security;

drop policy if exists "Readers see themselves" on public.readers;
drop policy if exists "Owner manages readers"  on public.readers;
create policy "Readers see themselves" on public.readers for select using (user_id = auth.uid() or public.is_owner());
create policy "Owner manages readers"  on public.readers for all using (public.is_owner()) with check (public.is_owner());

-- Is the signed-in person allowed to read? (You, or someone in the list above.)
create or replace function public.is_reader()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_owner() or exists (select 1 from public.readers where user_id = auth.uid())
$$;

-- 2. Book files ---------------------------------------------------------
create table if not exists public.book_files (
  book_id      uuid primary key references public.books (id) on delete cascade,
  path         text not null,                 -- name in the bucket, e.g. books/<book id>.epub
  file_id      text not null,                 -- Backblaze's id for this upload (needed to delete it)
  kind         text not null check (kind in ('epub', 'pdf', 'cbz')),
  size         bigint not null check (size > 0),
  name         text,                          -- the original file name, for your information only
  uploaded_at  timestamptz not null default now()
);
alter table public.book_files enable row level security;

drop policy if exists "Readers see book files"   on public.book_files;
drop policy if exists "Owner adds book files"    on public.book_files;
drop policy if exists "Owner changes book files" on public.book_files;
drop policy if exists "Owner removes book files" on public.book_files;
create policy "Readers see book files"   on public.book_files for select using (public.is_reader());
create policy "Owner adds book files"    on public.book_files for insert with check (public.is_owner());
create policy "Owner changes book files" on public.book_files for update using (public.is_owner()) with check (public.is_owner());
create policy "Owner removes book files" on public.book_files for delete using (public.is_owner());

-- 3. Reading positions --------------------------------------------------
create table if not exists public.reading_positions (
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  book_id     uuid not null references public.books (id) on delete cascade,
  location    text,                           -- the exact spot (an EPUB "CFI", or a PDF page number)
  fraction    numeric check (fraction is null or (fraction >= 0 and fraction <= 1)),
  updated_at  timestamptz not null default now(),
  primary key (user_id, book_id)
);
alter table public.reading_positions enable row level security;

drop policy if exists "Readers keep their own place" on public.reading_positions;
create policy "Readers keep their own place" on public.reading_positions for all
  using (user_id = auth.uid() and public.is_reader())
  with check (user_id = auth.uid() and public.is_reader());

-- Ask the website's database connection to notice the new tables straight away.
notify pgrst, 'reload schema';
