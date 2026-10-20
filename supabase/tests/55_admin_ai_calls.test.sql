-- Portal functions for failed and flagged AI calls (spec 4.12): admin_list_ai_calls,
-- admin_ai_call_flag_count, admin_ai_call (audited), admin_user_detail's ai_flags, and the
-- recipe_photos_select_admin storage policy.
begin;
create extension if not exists pgtap with schema extensions;
select plan(59);

-- Fixtures (as postgres) ------------------------------------------------------
-- boss is the admin. Alex is in household A (recipe RA), Sam in S (recipe RS). Gone is deleted
-- below, after their calls are written.
insert into auth.users (id, email, aud, role) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'boss@portal.test', 'authenticated', 'authenticated'),
  ('11111111-1111-1111-1111-111111111111', 'alex@portal.test', 'authenticated', 'authenticated'),
  ('22222222-2222-2222-2222-222222222222', 'sam@portal.test', 'authenticated', 'authenticated'),
  ('33333333-3333-3333-3333-333333333333', 'gone@portal.test', 'authenticated', 'authenticated');
insert into private.admins (user_id) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
insert into public.households (id, name) values
  ('d1000000-0000-0000-0000-000000000001', 'A'),
  ('d2000000-0000-0000-0000-000000000002', 'S');
insert into public.household_members (household_id, user_id, role, position) values
  ('d1000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'owner', 1),
  ('d2000000-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222', 'owner', 1);
insert into public.recipes (id, household_id, name) values
  ('a3000000-0000-7000-8000-000000000001', 'd1000000-0000-0000-0000-000000000001', 'Tacos'),
  ('b3000000-0000-7000-8000-000000000001', 'd2000000-0000-0000-0000-000000000002', 'Soup');
insert into storage.objects (bucket_id, name) values
  ('recipe-photos', 'd1000000-0000-0000-0000-000000000001/a3000000-0000-7000-8000-000000000001/e0000000-0000-7000-8000-000000000001.jpg'),
  ('recipe-photos', 'd2000000-0000-0000-0000-000000000002/b3000000-0000-7000-8000-000000000001/e0000000-0000-7000-8000-000000000002.jpg');

-- c01 failed (529) and recovered by c02; c03 failed, not recovered; c04 a safety block (failed
-- and flagged); c05 not food (flagged, ok); c06 a description and c07 its photo; c08 a refused
-- image (failed and flagged) after c09, both Gone's; c10 flagged 10 days ago, c11 40 days ago;
-- c12 a dev script's failure (no user); c13 Sam's photo.
insert into public.ai_calls (id, created_at, task, model, prompt_version, status, instructions, prompt, output,
                             response_text, finish_reason, duration_ms, error, http_status, error_body,
                             fallback_of, user_id, household_id, recipe_id) values
  ('c0000000-0000-0000-0000-000000000001', now() - interval '60 minutes', 'categorize', 'google:gemini-a', 'v1', 'api_error',
   'Sort these', 'eggs', null, null, null, 900, 'AI_APICallError: Overloaded', 529, '{"error":"overloaded"}',
   null, '11111111-1111-1111-1111-111111111111', null, null),
  ('c0000000-0000-0000-0000-000000000002', now() - interval '59 minutes', 'categorize', 'anthropic:claude-b', 'v1', 'ok',
   'Sort these', 'eggs', '{"items":[]}', '{"items":[]}', 'stop', 800, null, null, null,
   'c0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', null, null),
  ('c0000000-0000-0000-0000-000000000003', now() - interval '2 hours', 'importRecipe', 'google:gemini-a', 'v1', 'timeout',
   'Extract', 'page', null, null, null, 30000, 'TimeoutError: timed out', null, null,
   null, '22222222-2222-2222-2222-222222222222', null, null),
  ('c0000000-0000-0000-0000-000000000004', now() - interval '3 hours', 'importRecipe', 'google:gemini-a', 'v1', 'invalid_output',
   'Extract', 'bad page', null, '', 'content-filter', 400, 'No output', null, null,
   null, '22222222-2222-2222-2222-222222222222', null, null),
  ('c0000000-0000-0000-0000-000000000005', now() - interval '4 hours', 'recipePhotoDescription', 'mock', 'v1', 'ok',
   'Describe', 'Not food test', '{"isFood": false, "description": ""}', '{"isFood":false}', 'stop', 300, null, null, null,
   null, '11111111-1111-1111-1111-111111111111', 'd1000000-0000-0000-0000-000000000001', 'a3000000-0000-7000-8000-000000000001'),
  ('c0000000-0000-0000-0000-000000000006', now() - interval '5 hours', 'recipePhotoDescription', 'mock', 'v1', 'ok',
   'Describe', 'Tacos', '{"isFood": true, "description": "Tacos on a plate"}', null, 'stop', 300, null, null, null,
   null, '11111111-1111-1111-1111-111111111111', 'd1000000-0000-0000-0000-000000000001', 'a3000000-0000-7000-8000-000000000001'),
  ('c0000000-0000-0000-0000-000000000007', now() - interval '299 minutes', 'recipePhotoImage', 'openai:gpt-image-1-mini', 'v1', 'ok',
   '', 'Tacos on a plate',
   '{"quality": "low", "path": "d1000000-0000-0000-0000-000000000001/a3000000-0000-7000-8000-000000000001/e0000000-0000-7000-8000-000000000001.jpg"}',
   null, null, 20000, null, null, null,
   'c0000000-0000-0000-0000-000000000006', '11111111-1111-1111-1111-111111111111', 'd1000000-0000-0000-0000-000000000001', 'a3000000-0000-7000-8000-000000000001'),
  ('c0000000-0000-0000-0000-000000000008', now() - interval '6 hours', 'recipePhotoImage', 'openai:gpt-image-1-mini', 'v1', 'refused',
   '', 'Something harmful', null, null, null, 2000, 'ImageRefusedError: moderation_blocked', 400, '{"error":{"code":"moderation_blocked"}}',
   'c0000000-0000-0000-0000-000000000009', '33333333-3333-3333-3333-333333333333', null, null),
  ('c0000000-0000-0000-0000-000000000009', now() - interval '361 minutes', 'recipePhotoDescription', 'mock', 'v1', 'ok',
   'Describe', 'Harmful recipe', '{"isFood": true, "description": "Something harmful"}', null, 'stop', 300, null, null, null,
   null, '33333333-3333-3333-3333-333333333333', null, null),
  ('c0000000-0000-0000-0000-000000000010', now() - interval '10 days', 'categorize', 'google:gemini-a', 'v1', 'invalid_output',
   'Sort these', 'rude words', null, null, 'content-filter', 100, 'No output', null, null,
   null, '11111111-1111-1111-1111-111111111111', null, null),
  ('c0000000-0000-0000-0000-000000000011', now() - interval '40 days', 'recipePhotoDescription', 'mock', 'v1', 'ok',
   'Describe', 'Old test', '{"isFood": false, "description": ""}', null, 'stop', 300, null, null, null,
   null, '11111111-1111-1111-1111-111111111111', null, null),
  ('c0000000-0000-0000-0000-000000000012', now() - interval '7 hours', 'suggestRecipeTags', 'google:gemini-a', 'v1', 'error',
   'Tag', 'Soup', null, null, null, 10, 'Error: boom', null, null,
   null, null, null, null),
  ('c0000000-0000-0000-0000-000000000013', now() - interval '30 minutes', 'recipePhotoImage', 'mock', 'v1', 'ok',
   '', 'Soup in a bowl',
   '{"quality": "low", "path": "d2000000-0000-0000-0000-000000000002/b3000000-0000-7000-8000-000000000001/e0000000-0000-7000-8000-000000000002.jpg"}',
   null, null, 50, null, null, null,
   null, '22222222-2222-2222-2222-222222222222', 'd2000000-0000-0000-0000-000000000002', 'b3000000-0000-7000-8000-000000000001');

delete from auth.users where id = '33333333-3333-3333-3333-333333333333';

-- Privileges -------------------------------------------------------------------
select ok(
  not has_function_privilege('anon', 'public.admin_list_ai_calls(text, text, text, text, uuid, integer, integer)', 'execute')
  and not has_function_privilege('anon', 'public.admin_ai_call_flag_count(integer)', 'execute')
  and not has_function_privilege('anon', 'public.admin_ai_call(uuid)', 'execute'),
  'anon can''t execute the AI call functions');
select ok(
  not has_function_privilege('service_role', 'public.admin_list_ai_calls(text, text, text, text, uuid, integer, integer)', 'execute')
  and not has_function_privilege('service_role', 'public.admin_ai_call_flag_count(integer)', 'execute')
  and not has_function_privilege('service_role', 'public.admin_ai_call(uuid)', 'execute'),
  'service_role can''t execute the AI call functions');
select ok(
  has_function_privilege('authenticated', 'public.admin_list_ai_calls(text, text, text, text, uuid, integer, integer)', 'execute')
  and has_function_privilege('authenticated', 'public.admin_ai_call_flag_count(integer)', 'execute')
  and has_function_privilege('authenticated', 'public.admin_ai_call(uuid)', 'execute'),
  'authenticated can execute the AI call functions');
select ok(
  not has_function_privilege('authenticated', 'private.admin_ai_calls_matching(text, text, text, text, uuid)', 'execute'),
  'authenticated can''t execute the private matcher');
select is(
  (select array_agg(p.proname::text || ':' || p.provolatile::text order by p.proname)
   from pg_proc p where p.pronamespace = 'public'::regnamespace
     and p.proname in ('admin_list_ai_calls', 'admin_ai_call_flag_count', 'admin_ai_call')),
  array['admin_ai_call:v', 'admin_ai_call_flag_count:s', 'admin_list_ai_calls:s'],
  'the list and count are stable; admin_ai_call writes, so it isn''t');

-- A signed-in non-admin ----------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
select throws_ok($$ select public.admin_list_ai_calls() $$, '42501', 'not authorized',
  'admin_list_ai_calls refuses a non-admin');
select throws_ok($$ select public.admin_ai_call_flag_count() $$, '42501', 'not authorized',
  'admin_ai_call_flag_count refuses a non-admin');
select throws_ok($$ select public.admin_ai_call('c0000000-0000-0000-0000-000000000001') $$, '42501', 'not authorized',
  'admin_ai_call refuses a non-admin');
select results_eq(
  $$ select name from storage.objects where bucket_id = 'recipe-photos' $$,
  $$ values ('d1000000-0000-0000-0000-000000000001/a3000000-0000-7000-8000-000000000001/e0000000-0000-7000-8000-000000000001.jpg') $$,
  'a non-admin still sees only their household''s photos');
reset role;
select is((select count(*)::integer from admin.admin_actions where action = 'view_ai_call'), 0,
  'the refused read wrote no audit row');

-- The admin: lists -----------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","role":"authenticated"}', true);

select is(jsonb_path_query_array(public.admin_list_ai_calls('failed'), '$.calls[*].id'),
  '["c0000000-0000-0000-0000-000000000001", "c0000000-0000-0000-0000-000000000003",
    "c0000000-0000-0000-0000-000000000004", "c0000000-0000-0000-0000-000000000008",
    "c0000000-0000-0000-0000-000000000012", "c0000000-0000-0000-0000-000000000010"]'::jsonb,
  'failed lists every non-ok call, newest first');
select is(jsonb_path_query_array(public.admin_list_ai_calls(), '$.calls[*].id'),
  jsonb_path_query_array(public.admin_list_ai_calls('failed'), '$.calls[*].id'),
  'the kind defaults to failed');
select is(public.admin_list_ai_calls('failed') -> 'total_count', '6'::jsonb, 'failed total_count');
select is(jsonb_path_query_array(public.admin_list_ai_calls('flagged'), '$.calls[*].id'),
  '["c0000000-0000-0000-0000-000000000004", "c0000000-0000-0000-0000-000000000005",
    "c0000000-0000-0000-0000-000000000008", "c0000000-0000-0000-0000-000000000010",
    "c0000000-0000-0000-0000-000000000011"]'::jsonb,
  'flagged lists every flagged call, ok or not, newest first');
select is(jsonb_path_query_array(public.admin_list_ai_calls('flagged'), '$.calls[*].flag'),
  '["content_filter", "not_food", "refused", "content_filter", "not_food"]'::jsonb,
  'each flagged call has its flag');
select is(jsonb_path_query_array(public.admin_list_ai_calls('photos'), '$.calls[*].id'),
  '["c0000000-0000-0000-0000-000000000013", "c0000000-0000-0000-0000-000000000007"]'::jsonb,
  'photos lists the ok image calls, newest first, not the refused one or the descriptions');
select is(jsonb_path_query_array(public.admin_list_ai_calls('photos'), '$.calls[*].photo_path'),
  '["d2000000-0000-0000-0000-000000000002/b3000000-0000-7000-8000-000000000001/e0000000-0000-7000-8000-000000000002.jpg",
    "d1000000-0000-0000-0000-000000000001/a3000000-0000-7000-8000-000000000001/e0000000-0000-7000-8000-000000000001.jpg"]'::jsonb,
  'a photo row has its photo_path');
select throws_ok($$ select public.admin_list_ai_calls('everything') $$, '22023', 'invalid kind',
  'an unknown kind is refused');
select throws_ok($$ select public.admin_list_ai_calls(null) $$, '22023', 'invalid kind',
  'a null kind is refused');

-- One row in full.
select is(
  (select x from jsonb_array_elements(public.admin_list_ai_calls('failed') -> 'calls') x
   where x ->> 'id' = 'c0000000-0000-0000-0000-000000000001'),
  jsonb_build_object(
    'id', 'c0000000-0000-0000-0000-000000000001',
    'created_at', now() - interval '60 minutes',
    'task', 'categorize',
    'model', 'google:gemini-a',
    'prompt_version', 'v1',
    'status', 'api_error',
    'flag', null,
    'error', 'AI_APICallError: Overloaded',
    'http_status', 529,
    'finish_reason', null,
    'duration_ms', 900,
    'fallback_of', null,
    'recovered', true,
    'user_id', '11111111-1111-1111-1111-111111111111',
    'user_email', 'alex@portal.test',
    'household_id', null,
    'recipe_id', null,
    'photo_path', null),
  'a failed row has every field, recovered when its fallback ended ok');
select is(
  (select x -> 'recovered' from jsonb_array_elements(public.admin_list_ai_calls('failed') -> 'calls') x
   where x ->> 'id' = 'c0000000-0000-0000-0000-000000000003'),
  'false'::jsonb, 'a failed row with no fallback isn''t recovered');
select is(
  (select x -> 'recovered' from jsonb_array_elements(public.admin_list_ai_calls('flagged') -> 'calls') x
   where x ->> 'id' = 'c0000000-0000-0000-0000-000000000004'),
  'false'::jsonb, 'a safety block isn''t recovered');
select is(
  (select jsonb_build_object('user_id', x -> 'user_id', 'user_email', x -> 'user_email', 'flag', x -> 'flag', 'http_status', x -> 'http_status')
   from jsonb_array_elements(public.admin_list_ai_calls('failed') -> 'calls') x
   where x ->> 'id' = 'c0000000-0000-0000-0000-000000000008'),
  '{"user_id": null, "user_email": null, "flag": "refused", "http_status": 400}'::jsonb,
  'a deleted user''s row has a null user and email');
select is(
  (select x -> 'user_email' from jsonb_array_elements(public.admin_list_ai_calls('flagged') -> 'calls') x
   where x ->> 'id' = 'c0000000-0000-0000-0000-000000000004'),
  '"sam@portal.test"'::jsonb, 'a live user''s row has their email');
select is(
  (select jsonb_build_object('household_id', x -> 'household_id', 'recipe_id', x -> 'recipe_id', 'photo_path', x -> 'photo_path')
   from jsonb_array_elements(public.admin_list_ai_calls('flagged') -> 'calls') x
   where x ->> 'id' = 'c0000000-0000-0000-0000-000000000005'),
  '{"household_id": "d1000000-0000-0000-0000-000000000001", "recipe_id": "a3000000-0000-7000-8000-000000000001", "photo_path": null}'::jsonb,
  'a description row has its household and recipe, and no photo_path');

-- Filters.
select is(jsonb_path_query_array(public.admin_list_ai_calls('failed', p_task => 'importRecipe'), '$.calls[*].id'),
  '["c0000000-0000-0000-0000-000000000003", "c0000000-0000-0000-0000-000000000004"]'::jsonb,
  'p_task filters');
select is(public.admin_list_ai_calls('failed', p_task => 'importRecipe') -> 'total_count', '2'::jsonb,
  'total_count counts the filtered rows');
select is(jsonb_path_query_array(public.admin_list_ai_calls('failed', p_status => 'timeout'), '$.calls[*].id'),
  '["c0000000-0000-0000-0000-000000000003"]'::jsonb, 'p_status filters');
select is(jsonb_path_query_array(public.admin_list_ai_calls('flagged', p_flag => 'not_food'), '$.calls[*].id'),
  '["c0000000-0000-0000-0000-000000000005", "c0000000-0000-0000-0000-000000000011"]'::jsonb, 'p_flag filters');
select is(jsonb_path_query_array(public.admin_list_ai_calls('failed', p_flag => 'refused'), '$.calls[*].id'),
  '["c0000000-0000-0000-0000-000000000008"]'::jsonb, 'p_flag filters the failed list too');
select is(jsonb_path_query_array(public.admin_list_ai_calls('failed', p_user_id => '11111111-1111-1111-1111-111111111111'), '$.calls[*].id'),
  '["c0000000-0000-0000-0000-000000000001", "c0000000-0000-0000-0000-000000000010"]'::jsonb, 'p_user_id filters');
select is(jsonb_path_query_array(public.admin_list_ai_calls('flagged', p_task => 'categorize', p_user_id => '11111111-1111-1111-1111-111111111111'), '$.calls[*].id'),
  '["c0000000-0000-0000-0000-000000000010"]'::jsonb, 'filters combine');
select is(jsonb_path_query_array(public.admin_list_ai_calls('failed', p_task => '  '), '$.calls[*].id'),
  jsonb_path_query_array(public.admin_list_ai_calls('failed'), '$.calls[*].id'), 'a blank filter is no filter');
select is(public.admin_list_ai_calls('photos', p_task => 'categorize'),
  '{"calls": [], "total_count": 0}'::jsonb, 'no matches is an empty list and 0');

-- Paging.
select is(jsonb_path_query_array(public.admin_list_ai_calls('failed', p_limit => 2, p_offset => 2), '$.calls[*].id'),
  '["c0000000-0000-0000-0000-000000000004", "c0000000-0000-0000-0000-000000000008"]'::jsonb, 'p_limit and p_offset page');
select is(public.admin_list_ai_calls('failed', p_limit => 2, p_offset => 2) -> 'total_count', '6'::jsonb,
  'total_count is counted before paging');
select is(public.admin_list_ai_calls('failed', p_offset => 50),
  '{"calls": [], "total_count": 6}'::jsonb, 'past the end is an empty page with the total');

-- The flag count.
select is(public.admin_ai_call_flag_count(), 3, 'the flag count covers the last 7 days by default');
select is(public.admin_ai_call_flag_count(30), 4, 'a 30-day window takes in the 10-day-old flag');
select is(public.admin_ai_call_flag_count(60), 5, 'a 60-day window takes in the 40-day-old flag');
select is(public.admin_ai_call_flag_count(0), 0, 'a 0-day window counts nothing');

reset role;
select is((select count(*)::integer from admin.admin_actions), 0, 'the list and the count write no audit row');

-- admin_ai_call ------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","role":"authenticated"}', true);

select is(
  (select jsonb_build_object('instructions', r -> 'instructions', 'prompt', r -> 'prompt', 'response_text', r -> 'response_text',
                             'error', r -> 'error', 'http_status', r -> 'http_status', 'error_body', r -> 'error_body',
                             'user_email', r -> 'user_email', 'flag', r -> 'flag', 'primary', r -> 'primary')
   from public.admin_ai_call('c0000000-0000-0000-0000-000000000001') r),
  '{"instructions": "Sort these", "prompt": "eggs", "response_text": null, "error": "AI_APICallError: Overloaded",
    "http_status": 529, "error_body": "{\"error\":\"overloaded\"}", "user_email": "alex@portal.test", "flag": null, "primary": null}'::jsonb,
  'admin_ai_call returns the instructions, prompt, error and error body');
select is(public.admin_ai_call('c0000000-0000-0000-0000-000000000001') -> 'fallback',
  '{"id": "c0000000-0000-0000-0000-000000000002", "task": "categorize", "model": "anthropic:claude-b", "status": "ok", "error": null}'::jsonb,
  'admin_ai_call links the fallback that followed it');
select is(
  (select jsonb_build_object('response_text', r -> 'response_text', 'output', r -> 'output', 'primary', r -> 'primary', 'fallback', r -> 'fallback')
   from public.admin_ai_call('c0000000-0000-0000-0000-000000000002') r),
  '{"response_text": "{\"items\":[]}", "output": {"items": []},
    "primary": {"id": "c0000000-0000-0000-0000-000000000001", "task": "categorize", "model": "google:gemini-a", "status": "api_error", "error": "AI_APICallError: Overloaded"},
    "fallback": null}'::jsonb,
  'a fallback returns its response and links its primary');
select is(
  (select jsonb_build_object('photo_path', r -> 'photo_path', 'primary', r -> 'primary' -> 'id', 'instructions', r -> 'instructions')
   from public.admin_ai_call('c0000000-0000-0000-0000-000000000007') r),
  '{"photo_path": "d1000000-0000-0000-0000-000000000001/a3000000-0000-7000-8000-000000000001/e0000000-0000-7000-8000-000000000001.jpg",
    "primary": "c0000000-0000-0000-0000-000000000006", "instructions": ""}'::jsonb,
  'an image call returns its photo_path and links its description');
select is(public.admin_ai_call('c0000000-0000-0000-0000-000000000006') -> 'fallback' ->> 'id',
  'c0000000-0000-0000-0000-000000000007', 'a description links the image call that followed it');
select is(
  (select jsonb_build_object('flag', r -> 'flag', 'user_id', r -> 'user_id', 'user_email', r -> 'user_email', 'error_body', r -> 'error_body', 'status', r -> 'status')
   from public.admin_ai_call('c0000000-0000-0000-0000-000000000008') r),
  '{"flag": "refused", "user_id": null, "user_email": null, "error_body": "{\"error\":{\"code\":\"moderation_blocked\"}}", "status": "refused"}'::jsonb,
  'a refused image of a deleted user: its flag and body, no user');
select ok(
  (select r ?& array['id', 'created_at', 'task', 'model', 'prompt_version', 'status', 'instructions', 'prompt', 'output',
                     'response_text', 'finish_reason', 'input_tokens', 'output_tokens', 'cached_input_tokens',
                     'reasoning_tokens', 'duration_ms', 'error', 'fallback_of', 'user_id', 'household_id',
                     'http_status', 'error_body', 'recipe_id', 'flag', 'user_email', 'photo_path', 'fallback', 'primary']
   from public.admin_ai_call('c0000000-0000-0000-0000-000000000005') r),
  'admin_ai_call has every column plus flag, user_email, photo_path, fallback and primary');
select throws_ok($$ select public.admin_ai_call('99999999-9999-9999-9999-999999999999') $$, 'P0002', 'not found',
  'an unknown id raises not found');

reset role;
select is((select count(*)::integer from admin.admin_actions where action = 'view_ai_call'), 7,
  'each read wrote one audit row, the unknown id none');
select is(
  (select jsonb_build_object('target_user_id', a.target_user_id, 'details', a.details, 'note', a.note, 'performed_by', a.performed_by,
                             'target_household_id', a.target_household_id, 'target_plan_id', a.target_plan_id)
   from admin.admin_actions a
   where a.action = 'view_ai_call' and a.details ->> 'ai_call_id' = 'c0000000-0000-0000-0000-000000000005'),
  '{"target_user_id": "11111111-1111-1111-1111-111111111111",
    "details": {"ai_call_id": "c0000000-0000-0000-0000-000000000005", "task": "recipePhotoDescription", "flag": "not_food"},
    "note": null, "performed_by": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "target_household_id": null, "target_plan_id": null}'::jsonb,
  'the audit row has the call''s user, its id, task and flag, and the admin');
select is(
  (select jsonb_build_object('target_user_id', a.target_user_id, 'details', a.details)
   from admin.admin_actions a
   where a.action = 'view_ai_call' and a.details ->> 'ai_call_id' = 'c0000000-0000-0000-0000-000000000008'),
  '{"target_user_id": null, "details": {"ai_call_id": "c0000000-0000-0000-0000-000000000008", "task": "recipePhotoImage", "flag": "refused"}}'::jsonb,
  'a deleted user''s call is audited with no target user');

-- admin_user_detail's ai_flags ----------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","role":"authenticated"}', true);
select is(public.admin_user_detail('11111111-1111-1111-1111-111111111111') -> 'ai_flags',
  '{"not_food": 1, "content_filter": 1}'::jsonb,
  'ai_flags counts the user''s flags in the last 30 days, not the 40-day-old one');
select is(public.admin_user_detail('22222222-2222-2222-2222-222222222222') -> 'ai_flags',
  '{"content_filter": 1}'::jsonb, 'another user''s ai_flags are their own');
select is(public.admin_user_detail('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') -> 'ai_flags',
  '{}'::jsonb, 'a user with no flags has an empty ai_flags');
select is(public.admin_user_detail('11111111-1111-1111-1111-111111111111') ->> 'email', 'alex@portal.test',
  'admin_user_detail still returns the user');

-- Storage: an admin reads any recipe photo ----------------------------------------------
select results_eq(
  $$ select name from storage.objects where bucket_id = 'recipe-photos' order by name $$,
  $$ values ('d1000000-0000-0000-0000-000000000001/a3000000-0000-7000-8000-000000000001/e0000000-0000-7000-8000-000000000001.jpg'),
            ('d2000000-0000-0000-0000-000000000002/b3000000-0000-7000-8000-000000000001/e0000000-0000-7000-8000-000000000002.jpg') $$,
  'an admin can read every household''s recipe photos');
reset role;

-- The 200 cap, with 205 more failed calls.
insert into public.ai_calls (id, created_at, task, model, prompt_version, status, instructions, prompt, duration_ms)
select gen_random_uuid(), now() - interval '20 days' - n * interval '1 minute', 'bulk', 'mock', 'v1', 'error', 'i', 'p', 1
from generate_series(1, 205) n;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","role":"authenticated"}', true);
select is(
  (select jsonb_build_object('page', jsonb_array_length(r -> 'calls'), 'total', r -> 'total_count')
   from public.admin_list_ai_calls('failed', p_limit => 500) r),
  '{"page": 200, "total": 211}'::jsonb, 'p_limit is capped at 200');
reset role;

select * from finish();
rollback;
