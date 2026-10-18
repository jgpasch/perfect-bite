-- Stock photo search is gone (spec 4.5, 6.11): Generate with AI replaced it, and the photo-search
-- Edge Function is deleted. This drops its rate limits, its answer cache, their functions and the
-- daily retention job (20261101120000_photo_search.sql).
--
-- recipes.photo_credit goes too (20261031120000_recipe_photo_credit.sql): only stock photos had a
-- credit, and AI photos need none. apply_mutations sets any recipes column, so with the column gone
-- it refuses a mutation that still names photo_credit; app builds from before this change write it
-- with every photo change, so ship the app first.

select cron.unschedule('photo-search-retention');

drop function public.check_photo_search_limit(uuid, integer, boolean);
drop function public.get_photo_search_cache(text, integer);
drop function public.save_photo_search_cache(text, integer, jsonb);

drop table private.photo_search_usage;
drop table private.photo_search_daily_total;
drop table private.photo_search_cache;

alter table public.recipes drop constraint recipes_photo_credit_shape;
alter table public.recipes drop column photo_credit;
