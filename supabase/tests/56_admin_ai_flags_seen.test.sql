-- The sidebar's flag badge clears once seen (spec 4.12): admin_mark_ai_flags_seen and
-- admin_ai_call_flag_count counting only calls after the caller's ai_flags_seen_at.
begin;
create extension if not exists pgtap with schema extensions;
select plan(13);

-- Fixtures (as postgres) ------------------------------------------------------
-- boss and chief are admins; alex isn't. f1 (3 hours ago) and f2 (1 hour ago) are flagged (not
-- food), f3 is flagged 10 days ago, and ok1 is an unflagged call.
insert into auth.users (id, email, aud, role) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'boss@portal.test', 'authenticated', 'authenticated'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'chief@portal.test', 'authenticated', 'authenticated'),
  ('11111111-1111-1111-1111-111111111111', 'alex@portal.test', 'authenticated', 'authenticated');
insert into private.admins (user_id) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
insert into public.ai_calls (id, created_at, task, model, prompt_version, status, instructions, prompt, output,
                             finish_reason, duration_ms, user_id) values
  ('c0000000-0000-0000-0000-000000000001', now() - interval '3 hours', 'recipePhotoDescription', 'mock', 'v1', 'ok',
   'Describe', 'Not food', '{"isFood": false, "description": ""}', 'stop', 300, '11111111-1111-1111-1111-111111111111'),
  ('c0000000-0000-0000-0000-000000000002', now() - interval '1 hour', 'recipePhotoDescription', 'mock', 'v1', 'ok',
   'Describe', 'Not food', '{"isFood": false, "description": ""}', 'stop', 300, '11111111-1111-1111-1111-111111111111'),
  ('c0000000-0000-0000-0000-000000000003', now() - interval '10 days', 'recipePhotoDescription', 'mock', 'v1', 'ok',
   'Describe', 'Not food', '{"isFood": false, "description": ""}', 'stop', 300, '11111111-1111-1111-1111-111111111111'),
  ('c0000000-0000-0000-0000-000000000004', now() - interval '2 hours', 'recipePhotoDescription', 'mock', 'v1', 'ok',
   'Describe', 'Tacos', '{"isFood": true, "description": "Tacos"}', 'stop', 300, '11111111-1111-1111-1111-111111111111');

-- Privileges -------------------------------------------------------------------
select ok(
  not has_function_privilege('anon', 'public.admin_mark_ai_flags_seen()', 'execute')
  and not has_function_privilege('service_role', 'public.admin_mark_ai_flags_seen()', 'execute'),
  'anon and service_role can''t execute admin_mark_ai_flags_seen');
select ok(has_function_privilege('authenticated', 'public.admin_mark_ai_flags_seen()', 'execute'),
  'authenticated can execute admin_mark_ai_flags_seen');

-- A signed-in non-admin ----------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
select throws_ok($$ select public.admin_mark_ai_flags_seen() $$, '42501', 'not authorized',
  'admin_mark_ai_flags_seen refuses a non-admin');
reset role;

-- The admins ---------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","role":"authenticated"}', true);
select is(public.admin_ai_call_flag_count(), 2, 'never having looked, the badge counts the last 7 days');
select is(public.admin_mark_ai_flags_seen(), true, 'marking seen says the badge had something to clear');
select is(public.admin_ai_call_flag_count(), 0, 'once seen, the badge is empty');
select is(public.admin_ai_call_flag_count(30), 0, 'a longer window counts nothing seen either');
select is(public.admin_mark_ai_flags_seen(), false, 'marking seen again has nothing to clear');

select set_config('request.jwt.claims', '{"sub":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb","role":"authenticated"}', true);
select is(public.admin_ai_call_flag_count(), 2, 'one admin looking doesn''t clear another''s badge');
reset role;

select ok((select ai_flags_seen_at = now() from private.admins where user_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  'ai_flags_seen_at is set to now');

-- Calls flagged after the last look count again. now() is fixed in a transaction, so move the
-- look back instead.
update private.admins set ai_flags_seen_at = now() - interval '2 hours'
where user_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
update private.admins set ai_flags_seen_at = now() - interval '30 minutes'
where user_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","role":"authenticated"}', true);
select is(public.admin_ai_call_flag_count(), 1, 'only the call flagged after the last look counts');
select is(public.admin_mark_ai_flags_seen(), true, 'so marking seen has something to clear');

select set_config('request.jwt.claims', '{"sub":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb","role":"authenticated"}', true);
select is(public.admin_mark_ai_flags_seen(), false, 'nothing flagged since the last look: nothing to clear');
reset role;

select * from finish();
rollback;
