-- Blocking a user's AI photos (spec 6.11, 5): three refused moderation checks or image calls in 30
-- days block the user, once, with an audit row; nothing else counts; a blocked user's
-- reserve_recipe_photo_ai answers `blocked` and takes nothing. now() is fixed within the
-- transaction, so ages are set by hand.
begin;
create extension if not exists pgtap with schema extensions;
select plan(24);

-- Alex gets blocked, Sam's rows never count, Kim is blocked through the image task.
insert into auth.users (id, email, aud, role) values
  ('11111111-1111-1111-1111-111111111111', 'alex@test.local', 'authenticated', 'authenticated'),
  ('22222222-2222-2222-2222-222222222222', 'sam@test.local', 'authenticated', 'authenticated'),
  ('33333333-3333-3333-3333-333333333333', 'kim@test.local', 'authenticated', 'authenticated');
insert into public.households (id, name) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Alex''s household'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Sam''s household');
insert into public.household_members (household_id, user_id, role, position) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'owner', 1),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '22222222-2222-2222-2222-222222222222', 'owner', 1);
insert into public.recipes (id, household_id, name) values
  ('a5000000-0000-7000-8000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Tacos'),
  ('a5000000-0000-7000-8000-000000000002', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Soup');

-- Access ----------------------------------------------------------------------
select ok(
  not has_table_privilege('authenticated', 'private.ai_photo_blocks', 'select')
  and not has_table_privilege('authenticated', 'private.ai_photo_blocks', 'insert')
  and not has_table_privilege('authenticated', 'private.ai_photo_blocks', 'delete')
  and not has_table_privilege('anon', 'private.ai_photo_blocks', 'select'),
  'clients have no privileges on the blocks');
select ok(
  not has_function_privilege('authenticated', 'private.ai_photo_refusals(uuid, timestamptz)', 'execute')
  and not has_function_privilege('anon', 'private.ai_photo_refusals(uuid, timestamptz)', 'execute'),
  'clients can''t count refusals');
select is(private.ai_photo_block_threshold(), 3, 'the threshold is 3');
select is(private.ai_photo_block_window(), interval '30 days', 'the window is 30 days');

-- Two refusals don't block ----------------------------------------------------
insert into public.ai_calls (id, task, model, prompt_version, status, instructions, prompt, duration_ms, user_id) values
  ('c1000000-0000-0000-0000-000000000001', 'recipePhotoModeration', 'mock', 'v1', 'refused', '', 'p', 1,
   '11111111-1111-1111-1111-111111111111'),
  ('c1000000-0000-0000-0000-000000000002', 'recipePhotoImage', 'mock', 'v1', 'refused', '', 'p', 1,
   '11111111-1111-1111-1111-111111111111');

select is(private.ai_photo_refusals('11111111-1111-1111-1111-111111111111', now() - interval '30 days'), 2,
  'both tasks'' refusals count');
select is((select count(*)::int from private.ai_photo_blocks), 0, 'two refusals don''t block');

-- The third blocks, once ------------------------------------------------------
insert into public.ai_calls (id, task, model, prompt_version, status, instructions, prompt, duration_ms, user_id) values
  ('c1000000-0000-0000-0000-000000000003', 'recipePhotoModeration', 'mock', 'v1', 'refused', '', 'p', 1,
   '11111111-1111-1111-1111-111111111111');

select is(
  (select jsonb_build_object('refusals', b.refusals, 'last_call_id', b.last_call_id, 'blocked_at', b.blocked_at = now())
   from private.ai_photo_blocks b where b.user_id = '11111111-1111-1111-1111-111111111111'),
  '{"refusals": 3, "last_call_id": "c1000000-0000-0000-0000-000000000003", "blocked_at": true}'::jsonb,
  'the third refusal blocks, naming it');
select is(
  (select jsonb_agg(jsonb_build_object('performed_by', a.performed_by, 'details', a.details, 'note', a.note))
   from admin.admin_actions a
   where a.action = 'block_ai_photos' and a.target_user_id = '11111111-1111-1111-1111-111111111111'),
  '[{"performed_by": null, "details": {"refusals": 3, "window_days": 30}, "note": null}]'::jsonb,
  'one audit row, by nobody, with the count and window');

insert into public.ai_calls (id, task, model, prompt_version, status, instructions, prompt, duration_ms, user_id) values
  ('c1000000-0000-0000-0000-000000000004', 'recipePhotoImage', 'mock', 'v1', 'refused', '', 'p', 1,
   '11111111-1111-1111-1111-111111111111');

select is(
  (select jsonb_build_object('rows', count(*), 'refusals', min(b.refusals), 'last_call_id', min(b.last_call_id::text))
   from private.ai_photo_blocks b),
  '{"rows": 1, "refusals": 3, "last_call_id": "c1000000-0000-0000-0000-000000000003"}'::jsonb,
  'a fourth refusal leaves the block as it was');
select is((select count(*)::int from admin.admin_actions where action = 'block_ai_photos'), 1,
  'and audits nothing more');

-- What doesn't count ----------------------------------------------------------
insert into public.ai_calls (id, created_at, task, model, prompt_version, status, instructions, prompt, output, duration_ms, user_id) values
  -- not_food descriptions
  ('c2000000-0000-0000-0000-000000000001', now(), 'recipePhotoDescription', 'mock', 'v1', 'ok', '', 'p',
   '{"isFood": false, "description": ""}', 1, '22222222-2222-2222-2222-222222222222'),
  ('c2000000-0000-0000-0000-000000000002', now(), 'recipePhotoDescription', 'mock', 'v1', 'ok', '', 'p',
   '{"isFood": false, "description": ""}', 1, '22222222-2222-2222-2222-222222222222'),
  ('c2000000-0000-0000-0000-000000000003', now(), 'recipePhotoDescription', 'mock', 'v1', 'ok', '', 'p',
   '{"isFood": false, "description": ""}', 1, '22222222-2222-2222-2222-222222222222'),
  -- other statuses of the two tasks
  ('c2000000-0000-0000-0000-000000000004', now(), 'recipePhotoModeration', 'mock', 'v1', 'api_error', '', 'p', null, 1,
   '22222222-2222-2222-2222-222222222222'),
  ('c2000000-0000-0000-0000-000000000005', now(), 'recipePhotoImage', 'mock', 'v1', 'error', '', 'p', null, 1,
   '22222222-2222-2222-2222-222222222222'),
  ('c2000000-0000-0000-0000-000000000006', now(), 'recipePhotoImage', 'mock', 'v1', 'ok', '', 'p', null, 1,
   '22222222-2222-2222-2222-222222222222'),
  -- refused rows of other tasks
  ('c2000000-0000-0000-0000-000000000007', now(), 'recipePhotoDescription', 'mock', 'v1', 'refused', '', 'p', null, 1,
   '22222222-2222-2222-2222-222222222222'),
  ('c2000000-0000-0000-0000-000000000008', now(), 'categorize', 'mock', 'v1', 'refused', '', 'p', null, 1,
   '22222222-2222-2222-2222-222222222222'),
  -- refusals older than 30 days
  ('c2000000-0000-0000-0000-000000000009', now() - interval '31 days', 'recipePhotoModeration', 'mock', 'v1', 'refused', '', 'p', null, 1,
   '22222222-2222-2222-2222-222222222222'),
  ('c2000000-0000-0000-0000-00000000000a', now() - interval '30 days 1 second', 'recipePhotoImage', 'mock', 'v1', 'refused', '', 'p', null, 1,
   '22222222-2222-2222-2222-222222222222');
insert into public.ai_calls (id, task, model, prompt_version, status, instructions, prompt, duration_ms, user_id) values
  ('c2000000-0000-0000-0000-00000000000b', 'recipePhotoImage', 'mock', 'v1', 'refused', '', 'p', 1,
   '22222222-2222-2222-2222-222222222222'),
  ('c2000000-0000-0000-0000-00000000000c', 'recipePhotoModeration', 'mock', 'v1', 'refused', '', 'p', 1,
   '22222222-2222-2222-2222-222222222222');

select is(private.ai_photo_refusals('22222222-2222-2222-2222-222222222222', now() - interval '30 days'), 2,
  'only the two recent refusals of the two tasks count');
select is(private.ai_photo_refusals('22222222-2222-2222-2222-222222222222', now() - interval '40 days'), 4,
  'the old ones count from an earlier date');
select ok(not exists (select 1 from private.ai_photo_blocks where user_id = '22222222-2222-2222-2222-222222222222'),
  'not_food descriptions, other statuses, other tasks and old refusals don''t block');

-- A call with no caller -------------------------------------------------------
insert into public.ai_calls (id, task, model, prompt_version, status, instructions, prompt, duration_ms, user_id) values
  ('c3000000-0000-0000-0000-000000000001', 'recipePhotoModeration', 'mock', 'v1', 'refused', '', 'p', 1, null),
  ('c3000000-0000-0000-0000-000000000002', 'recipePhotoModeration', 'mock', 'v1', 'refused', '', 'p', 1, null),
  ('c3000000-0000-0000-0000-000000000003', 'recipePhotoImage', 'mock', 'v1', 'refused', '', 'p', 1, null);

select is((select count(*)::int from private.ai_photo_blocks), 1, 'refusals with no user block nobody');
select is((select count(*)::int from admin.admin_actions where action = 'block_ai_photos'), 1, 'and audit nothing');

-- Kim, three image refusals in one statement ----------------------------------
insert into public.ai_calls (id, task, model, prompt_version, status, instructions, prompt, duration_ms, user_id) values
  ('c4000000-0000-0000-0000-000000000001', 'recipePhotoImage', 'mock', 'v1', 'refused', '', 'p', 1, '33333333-3333-3333-3333-333333333333'),
  ('c4000000-0000-0000-0000-000000000002', 'recipePhotoImage', 'mock', 'v1', 'refused', '', 'p', 1, '33333333-3333-3333-3333-333333333333'),
  ('c4000000-0000-0000-0000-000000000003', 'recipePhotoImage', 'mock', 'v1', 'refused', '', 'p', 1, '33333333-3333-3333-3333-333333333333');
select is((select refusals from private.ai_photo_blocks where user_id = '33333333-3333-3333-3333-333333333333'), 3,
  'image refusals alone block too');

-- Reserving while blocked -----------------------------------------------------
select is(
  (select jsonb_build_object('status', r.status, 'household_id', r.household_id)
   from public.reserve_recipe_photo_ai('11111111-1111-1111-1111-111111111111', 'a5000000-0000-7000-8000-000000000001') r),
  '{"status": "blocked", "household_id": null}'::jsonb,
  'a blocked user''s reservation answers blocked');
select ok(not exists (select 1 from private.recipe_photo_ai where recipe_id = 'a5000000-0000-7000-8000-000000000001'),
  'no slot is taken');
select ok(not exists (select 1 from private.recipe_photo_ai_usage where user_id = '11111111-1111-1111-1111-111111111111'),
  'no usage is counted');
select is(
  (select r.status from public.reserve_recipe_photo_ai('11111111-1111-1111-1111-111111111111', 'a5000000-0000-7000-8000-0000000000ff') r),
  'blocked', 'blocked is answered before anything else (even for no such recipe)');
select is(
  (select r.status from public.reserve_recipe_photo_ai('22222222-2222-2222-2222-222222222222', 'a5000000-0000-7000-8000-000000000002') r),
  'ok', 'a user who isn''t blocked still reserves');

-- Deleting the user -----------------------------------------------------------
delete from auth.users where id = '11111111-1111-1111-1111-111111111111';
select ok(not exists (select 1 from private.ai_photo_blocks where user_id = '11111111-1111-1111-1111-111111111111'),
  'deleting the user deletes the block');
select is((select count(*)::int from admin.admin_actions where action = 'block_ai_photos'
           and target_user_id = '11111111-1111-1111-1111-111111111111'), 1,
  'the audit row stays');

-- Deleting the last call nulls the link ---------------------------------------
delete from public.ai_calls where user_id = '33333333-3333-3333-3333-333333333333';
select is((select last_call_id from private.ai_photo_blocks where user_id = '33333333-3333-3333-3333-333333333333'), null,
  'deleting the call keeps the block without it');

select * from finish();
rollback;
