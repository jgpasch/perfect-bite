\set ON_ERROR_STOP 1
\ir seed-admin-demo.tmp
create table public.tmp_c1 as select
  (select count(*) from auth.users where id::text like 'de300000-%') u,
  (select count(*) from public.user_plans where user_id::text like 'de300000-%') up,
  (select count(*) from private.categorize_usage where user_id::text like 'de300000-%')
   + (select count(*) from private.recipe_import_usage where user_id::text like 'de300000-%')
   + (select count(*) from private.recipe_photo_import_usage where user_id::text like 'de300000-%')
   + (select count(*) from private.recipe_tags_usage where user_id::text like 'de300000-%')
   + (select count(*) from private.step_match_usage where user_id::text like 'de300000-%')
   + (select count(*) from private.recipe_photo_ai_usage where user_id::text like 'de300000-%') usage,
  (select sum(imports) from private.recipe_import_usage where user_id::text like 'de300000-%') imports,
  (select count(*) from public.ai_calls where id::text like 'de300000-%') calls,
  (select count(*) from admin.admin_actions where id::text like 'de300000-%') acts;
\ir seed-admin-demo.tmp
begin;
create extension if not exists pgtap with schema extensions;
select plan(17);
select is((select u from public.tmp_c1), 10::bigint, 'ten users');
select is((select count(*) from public.profiles where user_id::text like 'de300000-%'), 10::bigint, 'ten profiles');
select is((select display_name from public.profiles where user_id = 'de300000-0000-4000-8000-000000000001'), 'Maya Chen', 'display name');
select is((select up from public.tmp_c1), 7::bigint, 'seven assigned');
select is((select calls from public.tmp_c1), 54::bigint, '48 calls and 6 fallbacks');
select is((select acts from public.tmp_c1), 5::bigint, 'five actions');
select is((select count(*) from auth.users where id::text like 'de300000-%'), (select u from public.tmp_c1), 'second run: users');
select is((select count(*) from public.ai_calls where id::text like 'de300000-%'), (select calls from public.tmp_c1), 'second run: calls');
select is((select count(*) from admin.admin_actions where id::text like 'de300000-%'), (select acts from public.tmp_c1), 'second run: actions');
select is((select sum(imports) from private.recipe_import_usage where user_id::text like 'de300000-%'), (select imports from public.tmp_c1), 'second run: imports');
select is(
  (select count(*) from unnest(private.feature_keys()) f
   where exists (select 1 from private.daily_usage(f, (now() at time zone 'utc')::date - 39) d where d.user_id::text like 'de300000-%')),
  2::bigint, 'both features have usage');
select is(
  (select bool_and(private.monthly_usage('de300000-0000-4000-8000-000000000001', l.feature) = l.monthly_limit) from public.plan_limits l where l.plan_id = 'founding'),
  true, 'demo-1 exactly at founding limits');
select is(
  (select bool_and(private.monthly_usage('de300000-0000-4000-8000-000000000002', l.feature) > l.monthly_limit) from public.plan_limits l where l.plan_id = 'founding'),
  true, 'demo-2 over founding limits');
select is((select count(distinct plan_id) from public.user_plans where user_id::text like 'de300000-%'), (select count(*) from public.plans), 'every plan used');
select diag((select usage from public.tmp_c1)::text || ' usage rows');
select diag((select string_agg(f || '=' || private.monthly_usage('de300000-0000-4000-8000-000000000003', f), ' ') from unnest(private.feature_keys()) f));
select set_config('request.jwt.claims', '{"sub": "019a4c10-0000-7000-8000-0000000de701"}', true);
select ok((public.admin_ai_usage() -> 'features') is not null, 'admin_ai_usage runs');
select ok((select total_count from public.admin_list_users('demo-') limit 1) = 10, 'admin_list_users finds them');
select ok((public.admin_list_actions() ->> 'total_count')::integer >= 5, 'admin_list_actions');
select * from finish();
commit;
-- The removal from the header.
delete from auth.users where id::text like 'de300000-%';
delete from public.ai_calls where id::text like 'de300000-%';
delete from admin.admin_actions where id::text like 'de300000-%';
select count(*) as left_users from auth.users where id::text like 'de300000-%';
select count(*) as left_usage from private.categorize_usage where user_id::text like 'de300000-%';
drop table public.tmp_c1;
