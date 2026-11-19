-- =====================================================================
-- Reads, rereads and progress (18 November 2026).
-- Paste this whole file into the Supabase SQL Editor and click "Run". Run it once.
-- It only adds new columns. Nothing existing is changed or removed, and running it twice is safe.
-- =====================================================================

-- Every time a title was finished, oldest first. Each entry is {"d":"2024-03-14"} (a full date),
-- {"y":2019} (only the year) or {} (no date). Empty for books saved before this update: a Read book
-- then counts as one read on its finished_at date, as before.
alter table public.books add column if not exists reads jsonb not null default '[]'::jsonb;

-- True while a Read title is being read again. It stays on the Read shelf and also shows in Currently Reading.
alter table public.books add column if not exists rereading boolean not null default false;

-- How far through the current read: a percent from 0 to 100,
-- what was typed with it (a page like '214', or a time like '52m'), and the day it was last updated.
alter table public.books add column if not exists progress numeric check (progress is null or (progress >= 0 and progress <= 100));
alter table public.books add column if not exists progress_mark text;
alter table public.books add column if not exists progress_on date;

-- The day the current read (or reread) started.
alter table public.books add column if not exists started_at date;

-- Ask the website's database connection to notice the new columns straight away.
notify pgrst, 'reload schema';
