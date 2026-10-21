-- Portal function for AI usage (spec 4.12): admin_ai_usage, and private.daily_usage behind
-- private.monthly_usage.
begin;
create extension if not exists pgtap with schema extensions;
select plan(26);

-- Fixtures (as postgres) ------------------------------------------------------
-- Founding is the default here, as on hosted (supabase/seed.sql makes unlimited the default locally).
update public.plans set is_default = false where is_default;
update public.plans set is_default = true where id = 'founding';

-- a and b are 100 days old; b is on free, a on the default (founding). Limits come from their
-- households' plans: a's household is on founding, b's on free, both 100 days old (no first-month
-- doubling).
insert into auth.users (id, email, aud, role, created_at) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'boss@usage.test', 'authenticated', 'authenticated', now() - interval '100 days'),
  ('11111111-1111-1111-1111-111111111111', 'a@usage.test', 'authenticated', 'authenticated', now() - interval '100 days'),
  ('22222222-2222-2222-2222-222222222222', 'b@usage.test', 'authenticated', 'authenticated', now() - interval '100 days'),
  ('33333333-3333-3333-3333-333333333333', 'idle@usage.test', 'authenticated', 'authenticated', now() - interval '100 days');
insert into private.admins (user_id) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
insert into public.user_plans (user_id, plan_id) values ('22222222-2222-2222-2222-222222222222', 'free');
insert into public.households (id, name, created_at) values
  ('d1000000-0000-0000-0000-000000000001', 'A''s', now() - interval '100 days'),
  ('d2000000-0000-0000-0000-000000000002', 'B''s', now() - interval '100 days');
insert into public.household_members (household_id, user_id, role, position) values
  ('d1000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'owner', 1),
  ('d2000000-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222', 'owner', 1);
insert into public.household_plans (household_id, plan_id) values
  ('d1000000-0000-0000-0000-000000000001', 'founding'),
  ('d2000000-0000-0000-0000-000000000002', 'free');

-- 12 more users with one import each this month, to see top_users stop at 10.
insert into auth.users (id, email, aud, role, created_at)
select ('cccccccc-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid, 'bulk' || n || '@usage.test',
       'authenticated', 'authenticated', now() - interval '100 days'
from generate_series(1, 12) n;

-- recipe_import: a 7 today, b 3 today and 2 on the month's first day, bulk 1 each today, and a
-- 1000 just before the month (in the daily series when the month is young, never in `used`).
-- The idle user has a row with 0 imports (a refused request), which isn't a user.
insert into private.recipe_import_usage (user_id, day, minute_start, imports) values
  ('11111111-1111-1111-1111-111111111111', (now() at time zone 'utc')::date, now(), 7),
  ('22222222-2222-2222-2222-222222222222', (now() at time zone 'utc')::date, now(), 3),
  ('11111111-1111-1111-1111-111111111111', date_trunc('month', now() at time zone 'utc')::date - 1, now(), 1000),
  ('33333333-3333-3333-3333-333333333333', (now() at time zone 'utc')::date, now(), 0);
insert into private.recipe_import_usage (user_id, day, minute_start, imports) values
  ('22222222-2222-2222-2222-222222222222', date_trunc('month', now() at time zone 'utc')::date, now(), 2)
on conflict (user_id, day) do update set imports = private.recipe_import_usage.imports + 2;
insert into private.recipe_import_usage (user_id, day, minute_start, imports)
select ('cccccccc-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid, (now() at time zone 'utc')::date, now(), 1
from generate_series(1, 12) n;
-- An import 41 days ago is outside the daily series.
insert into private.recipe_import_usage (user_id, day, minute_start, imports) values
  ('22222222-2222-2222-2222-222222222222', (now() at time zone 'utc')::date - 41, now(), 50);

-- categorize counts names: a sent 30 names in 2 requests today, b 5 in 1. (Categorize is no longer
-- a plan feature, so admin_ai_usage leaves it out, but monthly_usage still counts it.)
insert into private.categorize_usage (user_id, day, minute_start, requests_this_minute, new_names) values
  ('11111111-1111-1111-1111-111111111111', (now() at time zone 'utc')::date, now(), 2, 30),
  ('22222222-2222-2222-2222-222222222222', (now() at time zone 'utc')::date, now(), 1, 5);

-- ai_calls: categorize on two models with a fallback, one import, and an old row that's skipped.
insert into public.ai_calls (id, created_at, task, model, prompt_version, status, instructions, prompt,
                             input_tokens, output_tokens, cached_input_tokens, reasoning_tokens, duration_ms, fallback_of) values
  ('a0000000-0000-0000-0000-000000000001', now() - interval '1 day', 'categorize', 'openai:gpt-x', 'v1', 'ok', 'secret instructions', 'secret prompt', 100, 20, 50, 5, 10, null),
  ('a0000000-0000-0000-0000-000000000002', now() - interval '2 days', 'categorize', 'openai:gpt-x', 'v1', 'timeout', 'i', 'p', null, null, null, null, 10, null),
  ('a0000000-0000-0000-0000-000000000003', now() - interval '2 days', 'categorize', 'anthropic:claude-y', 'v1', 'ok', 'i', 'p', 200, 40, null, null, 10, 'a0000000-0000-0000-0000-000000000002'),
  ('a0000000-0000-0000-0000-000000000004', now() - interval '3 days', 'categorize', 'openai:gpt-x', 'v1', 'invalid_output', 'i', 'p', 80, 10, 0, 0, 10, null),
  ('a0000000-0000-0000-0000-000000000005', now() - interval '1 hour', 'import_recipe', 'openai:gpt-x', 'v1', 'api_error', 'i', 'p', 7, 0, 0, 0, 10, null),
  ('a0000000-0000-0000-0000-000000000006', now() - interval '31 days', 'categorize', 'openai:gpt-x', 'v1', 'ok', 'i', 'p', 9999, 9999, 9999, 9999, 10, null),
  ('a0000000-0000-0000-0000-000000000007', now() - interval '31 days', 'old_task', 'openai:gpt-x', 'v1', 'ok', 'i', 'p', 1, 1, 1, 1, 10, null);

-- Privileges -------------------------------------------------------------------
select ok(
  not has_function_privilege('anon', 'public.admin_ai_usage()', 'execute')
  and not has_function_privilege('service_role', 'public.admin_ai_usage()', 'execute')
  and has_function_privilege('authenticated', 'public.admin_ai_usage()', 'execute'),
  'only authenticated can execute admin_ai_usage');
select ok(
  not has_function_privilege('authenticated', 'private.daily_usage(text, date)', 'execute')
  and not has_function_privilege('service_role', 'private.daily_usage(text, date)', 'execute')
  and not has_function_privilege('authenticated', 'private.ai_call_stats(text, text, timestamptz)', 'execute')
  and not has_function_privilege('service_role', 'private.ai_call_stats(text, text, timestamptz)', 'execute'),
  'no client role can execute the helpers');

-- monthly_usage, now through daily_usage (as postgres) ---------------------------------
select is(private.monthly_usage('11111111-1111-1111-1111-111111111111', 'recipe_import'), 7,
  'monthly_usage counts only this month');
select is(private.monthly_usage('22222222-2222-2222-2222-222222222222', 'recipe_import'), 5,
  'monthly_usage sums the month''s days');
select is(private.monthly_usage('11111111-1111-1111-1111-111111111111', 'categorize'), 30,
  'monthly_usage counts names for categorize');
select is(private.monthly_usage('11111111-1111-1111-1111-111111111111', 'recipe_tags'), 0,
  'monthly_usage is 0 with no rows');

-- A signed-in non-admin, and anon ------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
select throws_ok($$ select public.admin_ai_usage() $$, '42501', 'not authorized', 'admin_ai_usage refuses a non-admin');
reset role;
set local role anon;
select throws_ok($$ select public.admin_ai_usage() $$, '42501', null, 'anon can''t call admin_ai_usage');
reset role;

-- As the admin ---------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","role":"authenticated"}', true);
create temp table r as select public.admin_ai_usage() as d;
reset role;

create temp view f as
  select e ->> 'feature' as feature, e from r, jsonb_array_elements(d -> 'features') e;

select is(
  (select array_agg(e ->> 'feature' order by o) from r, jsonb_array_elements(d -> 'features') with ordinality as x (e, o)),
  array['recipe_import', 'recipe_photo_ai'],
  'features are the two in order');
select is((select d ->> 'month_start' from r), date_trunc('month', now() at time zone 'utc')::date::text,
  'month_start is the first of this UTC month');

-- recipe_import
select is((select (e ->> 'used')::int from f where feature = 'recipe_import'), 7 + 5 + 12,
  'used is this month across everyone');
select is((select (e ->> 'users')::int from f where feature = 'recipe_import'), 14,
  'users counts who used it, not a row of 0');
select is((select jsonb_array_length(e -> 'daily') from f where feature = 'recipe_import'), 40,
  'the daily series has 40 entries');
select is(
  (select array[(e -> 'daily' -> 0 ->> 'day')::date, (e -> 'daily' -> 39 ->> 'day')::date] from f where feature = 'recipe_import'),
  array[(now() at time zone 'utc')::date - 39, (now() at time zone 'utc')::date],
  'the series runs oldest first, ending today');
select is((select (e -> 'daily' -> 39 ->> 'used')::int from f where feature = 'recipe_import'), 7 + 3 + 12 + (
    case when date_trunc('month', now() at time zone 'utc')::date = (now() at time zone 'utc')::date then 2 else 0 end),
  'today sums everyone''s rows');
select is(
  (select (x ->> 'used')::int from f, jsonb_array_elements(e -> 'daily') x
   where feature = 'recipe_import' and (x ->> 'day')::date = date_trunc('month', now() at time zone 'utc')::date - 1),
  1000, 'a day last month is in the series');
select ok(
  (select bool_and((x ->> 'used')::int = 0) from f, jsonb_array_elements(e -> 'daily') x
   where feature = 'recipe_import'
     and (x ->> 'day')::date not in ((now() at time zone 'utc')::date,
                                     date_trunc('month', now() at time zone 'utc')::date,
                                     date_trunc('month', now() at time zone 'utc')::date - 1)),
  'days with no rows are 0 (and the import 41 days ago is left out)');
select is((select jsonb_array_length(e -> 'top_users') from f where feature = 'recipe_import'), 10,
  'top_users stops at 10');
select is(
  (select e -> 'top_users' -> 0 from f where feature = 'recipe_import'),
  '{"user_id": "11111111-1111-1111-1111-111111111111", "email": "a@usage.test", "plan_id": "founding", "used": 7, "limit": 50}'::jsonb,
  'the heaviest user first, with email, default plan, this month''s use and their household''s limit');
select is(
  (select e -> 'top_users' -> 1 from f where feature = 'recipe_import'),
  '{"user_id": "22222222-2222-2222-2222-222222222222", "email": "b@usage.test", "plan_id": "free", "used": 5, "limit": 0}'::jsonb,
  'an assigned plan shows, with limit 0 when none of their households'' plans has the feature');
select is(
  (select e -> 'top_users' -> 2 ->> 'user_id' from f where feature = 'recipe_import'),
  'cccccccc-0000-0000-0000-000000000001', 'ties are ordered by user id');

-- an unused feature is all zeros
select is(
  (select jsonb_build_object('used', e -> 'used', 'users', e -> 'users', 'top_users', e -> 'top_users',
          'nonzero', (select count(*) from jsonb_array_elements(e -> 'daily') x where (x ->> 'used')::int <> 0),
          'days', jsonb_array_length(e -> 'daily'))
   from f where feature = 'recipe_photo_ai'),
  '{"used": 0, "users": 0, "top_users": [], "nonzero": 0, "days": 40}'::jsonb,
  'an unused feature has zeros, 40 empty days and no top users');

-- calls
select is((select array_agg(c ->> 'task') from r, jsonb_array_elements(d -> 'calls') c),
  array['categorize', 'import_recipe'], 'calls has one entry per task in the last 30 days, by name');
select is(
  (select c - 'models' - 'task' from r, jsonb_array_elements(d -> 'calls') c where c ->> 'task' = 'categorize'),
  '{"total": 4, "statuses": {"ok": 2, "api_error": 0, "invalid_output": 1, "timeout": 1, "refused": 0, "error": 0},
    "fallbacks": 1, "input_tokens": 380, "output_tokens": 70, "cached_input_tokens": 50, "reasoning_tokens": 5}'::jsonb,
  'a task counts statuses and fallbacks and sums tokens, skipping rows over 30 days old');
select is(
  (select jsonb_agg(jsonb_build_object('model', m ->> 'model', 'total', m -> 'total', 'fallbacks', m -> 'fallbacks',
                                       'input_tokens', m -> 'input_tokens', 'ok', m -> 'statuses' -> 'ok'))
   from r, jsonb_array_elements(d -> 'calls') c, jsonb_array_elements(c -> 'models') m where c ->> 'task' = 'categorize'),
  '[{"model": "anthropic:claude-y", "total": 1, "fallbacks": 1, "input_tokens": 200, "ok": 1},
    {"model": "openai:gpt-x", "total": 3, "fallbacks": 0, "input_tokens": 180, "ok": 1}]'::jsonb,
  'the same per model, by name');
select ok(
  (select d::text !~ '(secret|instructions"|prompt"|response_text|"output")' from r),
  'no instructions, prompts or outputs in the answer');

select * from finish();
rollback;
