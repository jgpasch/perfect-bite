-- The Edge Functions write ai_calls as service_role: the insert has to pass the flagged-calls
-- partial index (private.ai_call_flag) and the AI-photo block trigger, flagged or not.
begin;
create extension if not exists pgtap with schema extensions;
select plan(3);

set local role service_role;

select lives_ok(
  $$insert into public.ai_calls (id, task, model, prompt_version, status, instructions, prompt, duration_ms)
    values ('a6400000-0000-0000-0000-000000000001', 'categorize', 'mock', 'v1', 'ok', 'i', 'p', 1)$$,
  'service_role can insert an unflagged call');

select lives_ok(
  $$insert into public.ai_calls (id, task, model, prompt_version, status, instructions, prompt, duration_ms)
    values ('a6400000-0000-0000-0000-000000000002', 'recipePhotoImage', 'mock', 'v1', 'refused', '', 'p', 1)$$,
  'service_role can insert a flagged (refused) call');

reset role;

select ok(
  not has_function_privilege('authenticated', 'private.ai_call_flag(public.ai_calls)', 'execute')
    and not has_function_privilege('anon', 'private.ai_call_flag(public.ai_calls)', 'execute'),
  'anon and authenticated still can''t call private.ai_call_flag');

select * from finish();
rollback;
