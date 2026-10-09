-- ai_calls: service role only, no user id, retention job is scheduled.
begin;
create extension if not exists pgtap with schema extensions;
select plan(9);

insert into public.ai_calls (id, task, model, prompt_version, status, instructions, prompt, duration_ms) values
  ('a1111111-0000-0000-0000-0000000000a1', 'categorize', 'mock', 'categorize.v1', 'ok', 'sys', '["milk"]', 5);

select ok(exists (select 1 from cron.job where jobname = 'ai-calls-retention'), 'retention job is scheduled');
select hasnt_column('public', 'ai_calls', 'user_id', 'ai_calls has no user_id');
select hasnt_column('public', 'ai_calls', 'capture_ids', 'ai_calls has no capture_ids');
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
