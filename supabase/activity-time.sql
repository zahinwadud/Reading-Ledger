-- =====================================================================
-- "Recently updated" with the exact time (21 November 2026).
-- Paste this whole file into the Supabase SQL Editor and click "Run". Running it twice is safe.
--
-- progress_on only keeps the day, so books updated on the same day could not be put in order.
-- progress_at keeps the exact time of the latest activity (progress changed, a read or reread started).
-- =====================================================================
alter table public.books add column if not exists progress_at timestamptz;

-- Books already being read start from the day they have (midday, so the date stays the same in Dhaka).
update public.books
   set progress_at = (coalesce(progress_on, started_at)::timestamp + interval '6 hours') at time zone 'UTC'
 where progress_at is null and coalesce(progress_on, started_at) is not null;

notify pgrst, 'reload schema';
