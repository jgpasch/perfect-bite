-- photo-search rate limits and cache (spec 6.11): per user 20 a minute and 100 a day, the global
-- daily cap, a cache hit counting against the user but not the global cap, a refused search using
-- no budget, the 23-hour cache, the retention job, and only service_role can call the functions.
-- now() is fixed within the transaction, so every call lands in the same minute; the window reset
-- is simulated by moving minute_start back, and the cache's age by moving fetched_at back.
begin;
create extension if not exists pgtap with schema extensions;
select plan(34);

insert into auth.users (id, email, aud, role) values
  ('11111111-1111-1111-1111-111111111111', 'alex@test.local', 'authenticated', 'authenticated'),
  ('22222222-2222-2222-2222-222222222222', 'sam@test.local', 'authenticated', 'authenticated'),
  ('33333333-3333-3333-3333-333333333333', 'kim@test.local', 'authenticated', 'authenticated');

-- Per-minute limit ------------------------------------------------------------------
create temp table results (n int, result text);
insert into results
  select n, public.check_photo_search_limit('11111111-1111-1111-1111-111111111111', 3000)
  from generate_series(1, 20) n;
select is((select count(*)::int from results where result = 'ok'), 20, '20 searches in a minute pass');
select is(public.check_photo_search_limit('11111111-1111-1111-1111-111111111111', 3000), 'user_limit',
  'the 21st search in a minute is refused');
select results_eq(
  $$ select requests_this_minute, requests from private.photo_search_usage where user_id = '11111111-1111-1111-1111-111111111111' $$,
  $$ values (20, 20) $$, 'a refused search does not count');
select is(public.check_photo_search_limit('11111111-1111-1111-1111-111111111111', 3000, true), 'user_limit',
  'a cache hit is refused by the minute limit too');
select is(public.check_photo_search_limit('22222222-2222-2222-2222-222222222222', 3000), 'ok',
  'another user is not affected by the first user''s minute limit');

update private.photo_search_usage set minute_start = minute_start - interval '1 minute'
  where user_id = '11111111-1111-1111-1111-111111111111';
select is(public.check_photo_search_limit('11111111-1111-1111-1111-111111111111', 3000), 'ok', 'the minute window resets');
select results_eq(
  $$ select requests_this_minute, minute_start, requests from private.photo_search_usage
     where user_id = '11111111-1111-1111-1111-111111111111' $$,
  $$ values (1, date_trunc('minute', now()), 21) $$,
  'a new window starts at 1; the day keeps counting');

-- Per-user daily limit ----------------------------------------------------------------
-- 21 so far (all fresh); run 79 more, a new minute window every 19, to reach exactly 100. Every
-- other one is a cache hit, which counts the same against the user.
do $$
declare i int;
begin
  for i in 1..79 loop
    if i % 19 = 0 then
      update private.photo_search_usage set minute_start = minute_start - interval '1 minute'
        where user_id = '11111111-1111-1111-1111-111111111111';
    end if;
    if public.check_photo_search_limit('11111111-1111-1111-1111-111111111111', 3000, i % 2 = 0) <> 'ok' then
      raise exception 'search % was refused', i;
    end if;
  end loop;
end $$;
select is((select requests from private.photo_search_usage where user_id = '11111111-1111-1111-1111-111111111111'), 100,
  '100 searches a day pass, cache hits included');
update private.photo_search_usage set minute_start = minute_start - interval '1 minute'
  where user_id = '11111111-1111-1111-1111-111111111111';
select is(public.check_photo_search_limit('11111111-1111-1111-1111-111111111111', 3000), 'user_limit',
  'the 101st search in a day is refused, even in a fresh minute');
select is(public.check_photo_search_limit('11111111-1111-1111-1111-111111111111', 3000, true), 'user_limit',
  'and so is a 101st that would be a cache hit');

-- Global cap ------------------------------------------------------------------------------
-- The total counts only searches that reach Pexels: 21 + 40 fresh of the 79 for user 1, plus 1 for user 2.
select is((select requests from private.photo_search_daily_total), 62,
  'the global total counts every user''s fresh searches and no cache hits');
select is(public.check_photo_search_limit('33333333-3333-3333-3333-333333333333', 62), 'global_cap', 'the global cap refuses once reached');
select results_eq(
  $$ select requests_this_minute, requests from private.photo_search_usage where user_id = '33333333-3333-3333-3333-333333333333' $$,
  $$ values (0, 0) $$, 'a search refused by the global cap uses none of the user''s budget');
select is((select requests from private.photo_search_daily_total), 62, 'nor the global budget');
select is(public.check_photo_search_limit('33333333-3333-3333-3333-333333333333', 62, true), 'ok',
  'a cache hit passes when the global cap is reached');
select is((select requests from private.photo_search_daily_total), 62, 'and does not count against it');
select results_eq(
  $$ select requests_this_minute, requests from private.photo_search_usage where user_id = '33333333-3333-3333-3333-333333333333' $$,
  $$ values (1, 1) $$, 'but counts against the user');
select is(public.check_photo_search_limit('33333333-3333-3333-3333-333333333333', 63), 'ok', 'one under the cap passes');
select is(public.check_photo_search_limit('22222222-2222-2222-2222-222222222222', 0), 'global_cap', 'a cap of 0 refuses a fresh search');
select is(public.check_photo_search_limit('22222222-2222-2222-2222-222222222222', 0, true), 'ok', 'but not a cache hit');

-- The page-photos limit is separate ----------------------------------------------------------
select is(public.check_recipe_photos_limit('11111111-1111-1111-1111-111111111111', 2000), 'ok',
  'a user out of photo searches can still read page photos');

-- Cache -------------------------------------------------------------------------------------
select is(public.get_photo_search_cache('lemon cake', 1), null, 'nothing cached yet');
do $$ begin perform public.save_photo_search_cache('lemon cake', 1, '{"photos":[],"hasMore":true}'::jsonb); end $$;
select is(public.get_photo_search_cache('lemon cake', 1), '{"photos":[],"hasMore":true}'::jsonb, 'a saved answer comes back');
select is(public.get_photo_search_cache('lemon cake', 2), null, 'only for its own page');
do $$ begin perform public.save_photo_search_cache('lemon cake', 1, '{"photos":[],"hasMore":false}'::jsonb); end $$;
select is(public.get_photo_search_cache('lemon cake', 1), '{"photos":[],"hasMore":false}'::jsonb, 'saving again replaces it');
select is((select count(*)::int from private.photo_search_cache), 1, 'one row per key and page');
update private.photo_search_cache set fetched_at = now() - interval '22 hours 50 minutes' where query_key = 'lemon cake';
select is(public.get_photo_search_cache('lemon cake', 1), '{"photos":[],"hasMore":false}'::jsonb, 'an answer under 23 hours old is used');
update private.photo_search_cache set fetched_at = now() - interval '23 hours 10 minutes' where query_key = 'lemon cake';
select is(public.get_photo_search_cache('lemon cake', 1), null, 'an answer over 23 hours old is not used (its image URLs are about to expire)');

-- Retention -----------------------------------------------------------------------------
update private.photo_search_cache set fetched_at = now() - interval '25 hours' where query_key = 'lemon cake';
do $$ begin perform public.save_photo_search_cache('roast chicken', 1, '{"photos":[],"hasMore":false}'::jsonb); end $$;
insert into private.photo_search_usage (user_id, day, minute_start)
  values ('22222222-2222-2222-2222-222222222222', (now() at time zone 'utc')::date - 2, now() - interval '2 days');
select ok(exists (select 1 from cron.job where jobname = 'photo-search-retention'), 'the retention job is scheduled');
do $$ begin execute (select command from cron.job where jobname = 'photo-search-retention'); end $$;
select is((select count(*)::int from private.photo_search_usage where day < (now() at time zone 'utc')::date), 0,
  'the retention job deletes old usage rows');
select results_eq($$ select query_key from private.photo_search_cache $$, $$ values ('roast chicken') $$,
  'and cache rows over 24 hours old, keeping fresh ones');

-- Bad arguments and access ----------------------------------------------------------
select throws_ok($$ select public.check_photo_search_limit(null, 10) $$, '22023', null, 'a null user is rejected');

select ok(
  not has_function_privilege('authenticated', 'public.check_photo_search_limit(uuid, integer, boolean)', 'execute')
  and not has_function_privilege('anon', 'public.check_photo_search_limit(uuid, integer, boolean)', 'execute')
  and not has_function_privilege('authenticated', 'public.get_photo_search_cache(text, integer)', 'execute')
  and not has_function_privilege('anon', 'public.save_photo_search_cache(text, integer, jsonb)', 'execute')
  and not has_function_privilege('authenticated', 'public.save_photo_search_cache(text, integer, jsonb)', 'execute')
  and has_function_privilege('service_role', 'public.check_photo_search_limit(uuid, integer, boolean)', 'execute')
  and has_function_privilege('service_role', 'public.get_photo_search_cache(text, integer)', 'execute')
  and has_function_privilege('service_role', 'public.save_photo_search_cache(text, integer, jsonb)', 'execute'),
  'only service_role can call the limit and cache functions');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
select throws_ok($$ select * from private.photo_search_cache $$, '42501', null, 'authenticated cannot read the cache');

select * from finish();
rollback;
