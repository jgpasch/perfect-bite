-- ai_calls: service role only, records who made each call, retention job is scheduled.
begin;
create extension if not exists pgtap with schema extensions;
select plan(20);

insert into auth.users (id, email, aud, role) values
  ('11111111-1111-1111-1111-111111111111', 'alex@test.local', 'authenticated', 'authenticated'),
  ('22222222-2222-2222-2222-222222222222', 'sam@test.local', 'authenticated', 'authenticated');
insert into public.households (id, name) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Alex''s household'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Sam''s household');

insert into public.ai_calls (id, task, model, prompt_version, status, instructions, prompt, duration_ms) values
  ('a1111111-0000-0000-0000-0000000000a1', 'categorize', 'mock', 'categorize.v1', 'ok', 'sys', '["milk"]', 5);
insert into public.ai_calls (id, task, model, prompt_version, status, instructions, prompt, duration_ms, user_id, household_id) values
  ('a1111111-0000-0000-0000-0000000000a2', 'recipePhotoDescription', 'mock', 'v1', 'ok', 'sys', 'tacos', 5,
   '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  ('a1111111-0000-0000-0000-0000000000a3', 'categorize', 'mock', 'categorize.v1', 'ok', 'sys', '["eggs"]', 5,
   '22222222-2222-2222-2222-222222222222', null),
  ('a1111111-0000-0000-0000-0000000000a4', 'recipePhotoDescription', 'mock', 'v1', 'ok', 'sys', 'stew', 5,
   '22222222-2222-2222-2222-222222222222', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');

select ok(exists (select 1 from cron.job where jobname = 'ai-calls-retention'), 'retention job is scheduled');
select col_type_is('public', 'ai_calls', 'user_id', 'uuid', 'ai_calls has a user_id');
select col_is_null('public', 'ai_calls', 'user_id', 'user_id is nullable (scripts and evals have no caller)');
select col_type_is('public', 'ai_calls', 'household_id', 'uuid', 'ai_calls has a household_id');
select col_is_null('public', 'ai_calls', 'household_id', 'household_id is nullable');
select has_index('public', 'ai_calls', 'ai_calls_user_id_created_at_idx', array['user_id', 'created_at'], 'index on (user_id, created_at)');
select hasnt_column('public', 'ai_calls', 'capture_ids', 'ai_calls has no capture_ids');
select is((select user_id is null and household_id is null from public.ai_calls where id = 'a1111111-0000-0000-0000-0000000000a1'),
  true, 'a call with no caller has nulls');
select throws_ok($$ insert into public.ai_calls (id, task, model, prompt_version, status, instructions, prompt, duration_ms, user_id)
                   values (gen_random_uuid(), 't', 'm', 'v', 'ok', 'i', 'p', 1, '99999999-9999-9999-9999-999999999999') $$,
  '23503', null, 'user_id must be a real user');

-- Deleting the account nulls user_id and keeps the row (and its household).
delete from auth.users where id = '11111111-1111-1111-1111-111111111111';
select is((select user_id from public.ai_calls where id = 'a1111111-0000-0000-0000-0000000000a2'), null::uuid,
  'deleting the user nulls user_id');
select is((select household_id from public.ai_calls where id = 'a1111111-0000-0000-0000-0000000000a2'),
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid, 'the row keeps its household');
select is((select prompt from public.ai_calls where id = 'a1111111-0000-0000-0000-0000000000a2'), 'tacos',
  'the row itself is kept');

-- Deleting a household nulls household_id and keeps the user.
delete from public.households where id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
select is((select array[user_id::text, coalesce(household_id::text, 'null')] from public.ai_calls where id = 'a1111111-0000-0000-0000-0000000000a4'),
  array['22222222-2222-2222-2222-222222222222', 'null'], 'deleting the household nulls household_id and keeps the user');
select is((select count(*)::int from public.ai_calls where id::text like 'a1111111-%'), 4, 'no row was deleted');
select is((select relrowsecurity from pg_class where oid = 'public.ai_calls'::regclass), true, 'RLS is enabled');
select is((select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'ai_calls'), 0, 'no client policies');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
select throws_ok($$ select * from public.ai_calls $$, '42501', null, 'authenticated cannot read ai_calls');
select throws_ok($$ insert into public.ai_calls (id, task, model, prompt_version, status, instructions, prompt, duration_ms)
                   values (gen_random_uuid(), 't', 'm', 'v', 'ok', 'i', 'p', 1) $$,
  '42501', null, 'authenticated cannot write ai_calls');

set local role anon;
select throws_ok($$ select * from public.ai_calls $$, '42501', null, 'anon cannot read ai_calls');

reset role;
select throws_ok($$ insert into public.ai_calls (id, task, model, prompt_version, status, instructions, prompt, duration_ms)
                   values (gen_random_uuid(), 't', 'm', 'v', 'bogus', 'i', 'p', 1) $$,
  '23514', null, 'status is constrained');

select * from finish();
rollback;
