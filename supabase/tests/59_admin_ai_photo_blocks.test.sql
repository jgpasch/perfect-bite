-- AI photo blocks in the portal (spec 4.12, 6.11): admin_user_detail's ai_photo_block and
-- ai_photo_refusals_30d, admin_list_users' ai_photos_blocked and p_blocked, admin_list_ai_calls'
-- user_ai_photos_blocked, and admin_unblock_ai_photos, after which the count starts over. now() is
-- fixed within the transaction, so the refusals before the unblock are an hour old.
begin;
create extension if not exists pgtap with schema extensions;
select plan(30);

-- Fixtures (as postgres) ------------------------------------------------------
-- boss is the admin. ann gets blocked, ben has one refusal, cy isn't an admin.
insert into auth.users (id, email, aud, role, created_at) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'boss@blocks.test', 'authenticated', 'authenticated', now() - interval '3 days'),
  ('11111111-1111-1111-1111-111111111111', 'ann@blocks.test', 'authenticated', 'authenticated', now() - interval '2 days'),
  ('22222222-2222-2222-2222-222222222222', 'ben@blocks.test', 'authenticated', 'authenticated', now() - interval '1 day'),
  ('33333333-3333-3333-3333-333333333333', 'cy@blocks.test', 'authenticated', 'authenticated', now());
insert into private.admins (user_id) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');

-- One statement each, as the function writes them, so the third is the one that blocks.
insert into public.ai_calls (id, created_at, task, model, prompt_version, status, instructions, prompt, duration_ms, user_id) values
  ('c1000000-0000-0000-0000-000000000001', now() - interval '3 hours', 'recipePhotoModeration', 'mock', 'v1', 'refused', '', 'p', 1, '11111111-1111-1111-1111-111111111111');
insert into public.ai_calls (id, created_at, task, model, prompt_version, status, instructions, prompt, duration_ms, user_id) values
  ('c1000000-0000-0000-0000-000000000002', now() - interval '2 hours', 'recipePhotoImage', 'mock', 'v1', 'refused', '', 'p', 1, '11111111-1111-1111-1111-111111111111');
insert into public.ai_calls (id, created_at, task, model, prompt_version, status, instructions, prompt, duration_ms, user_id) values
  ('c1000000-0000-0000-0000-000000000003', now() - interval '1 hour', 'recipePhotoModeration', 'mock', 'v1', 'refused', '', 'p', 1, '11111111-1111-1111-1111-111111111111'),
  ('c1000000-0000-0000-0000-000000000004', now() - interval '1 hour', 'recipePhotoImage', 'mock', 'v1', 'refused', '', 'p', 1, '22222222-2222-2222-2222-222222222222');

-- Privileges -------------------------------------------------------------------
select ok(
  not has_function_privilege('anon', 'public.admin_unblock_ai_photos(uuid, text)', 'execute')
  and not has_function_privilege('service_role', 'public.admin_unblock_ai_photos(uuid, text)', 'execute')
  and has_function_privilege('authenticated', 'public.admin_unblock_ai_photos(uuid, text)', 'execute'),
  'only authenticated can execute admin_unblock_ai_photos');

-- Not an admin -----------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}', true);
select throws_ok($$ select public.admin_unblock_ai_photos('11111111-1111-1111-1111-111111111111', 'me') $$,
  '42501', 'not authorized', 'a non-admin can''t unblock');
select throws_ok($$ select * from public.admin_list_users(null, 50, 0, true) $$,
  '42501', 'not authorized', 'a non-admin can''t list blocked users');
reset role;
select ok(exists (select 1 from private.ai_photo_blocks where user_id = '11111111-1111-1111-1111-111111111111'),
  'ann is still blocked');

-- Seeing the block -------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","role":"authenticated"}', true);

select is(
  public.admin_user_detail('11111111-1111-1111-1111-111111111111') -> 'ai_photo_block',
  jsonb_build_object('blocked_at', now(), 'refusals', 3, 'last_call_id', 'c1000000-0000-0000-0000-000000000003'),
  'the detail shows the block');
select is((public.admin_user_detail('11111111-1111-1111-1111-111111111111') ->> 'ai_photo_refusals_30d')::int, 3,
  'and the refusals in the window');
select is(public.admin_user_detail('22222222-2222-2222-2222-222222222222') -> 'ai_photo_block', 'null'::jsonb,
  'an unblocked user''s block is null');
select is((public.admin_user_detail('22222222-2222-2222-2222-222222222222') ->> 'ai_photo_refusals_30d')::int, 1,
  'with their one refusal');
select is((public.admin_user_detail('33333333-3333-3333-3333-333333333333') ->> 'ai_photo_refusals_30d')::int, 0,
  'none is 0');

select is(
  (select array_agg(email || ':' || ai_photos_blocked order by created_at desc) from public.admin_list_users('blocks.test')),
  array['cy@blocks.test:false', 'ben@blocks.test:false', 'ann@blocks.test:true', 'boss@blocks.test:false'],
  'the list says who''s blocked');
select is(
  (select array_agg(email) from public.admin_list_users('blocks.test', 50, 0, true)),
  array['ann@blocks.test'], 'the Blocked filter lists only blocked users');
select is((select distinct total_count::int from public.admin_list_users('blocks.test', 50, 0, true)), 1,
  'and counts only them');
select is(
  (select array_agg(email order by created_at desc) from public.admin_list_users('blocks.test', 50, 0, false)),
  array['cy@blocks.test', 'ben@blocks.test', 'boss@blocks.test'], 'false lists the others');
select is((select count(*)::int from public.admin_list_users('cy@', 50, 0, true)), 0,
  'the filter and the search both apply');

select is(
  (select jsonb_agg(jsonb_build_object('task', c ->> 'task', 'blocked', c -> 'user_ai_photos_blocked') order by c ->> 'created_at')
   from jsonb_array_elements(public.admin_list_ai_calls('flagged', null, null, 'refused', '11111111-1111-1111-1111-111111111111') -> 'calls') c),
  '[{"task": "recipePhotoModeration", "blocked": true}, {"task": "recipePhotoImage", "blocked": true},
    {"task": "recipePhotoModeration", "blocked": true}]'::jsonb,
  'the refusals link (this user, flag refused) lists both tasks, each marked blocked');
select is(
  public.admin_list_ai_calls('flagged', null, null, 'refused', '22222222-2222-2222-2222-222222222222') -> 'calls' -> 0 -> 'user_ai_photos_blocked',
  'false'::jsonb, 'an unblocked user''s call isn''t');

-- Unblocking -------------------------------------------------------------------
select throws_ok($$ select public.admin_unblock_ai_photos('11111111-1111-1111-1111-111111111111', '  ') $$,
  '22023', 'note required', 'unblocking needs a note');
select throws_ok($$ select public.admin_unblock_ai_photos('11111111-1111-1111-1111-111111111111', null) $$,
  '22023', 'note required', 'a null note too');
select throws_ok($$ select public.admin_unblock_ai_photos('22222222-2222-2222-2222-222222222222', 'why') $$,
  'P0002', 'not blocked', 'a user with no block can''t be unblocked');
select throws_ok($$ select public.admin_unblock_ai_photos('99999999-9999-9999-9999-999999999999', 'why') $$,
  'P0002', 'not blocked', 'nor an unknown user');

select is(
  public.admin_unblock_ai_photos('11111111-1111-1111-1111-111111111111', 'Asked by support, tested a horror menu'),
  jsonb_build_object('refusals', 3, 'blocked_at', now()),
  'unblocking returns the block''s details');
select is(public.admin_user_detail('11111111-1111-1111-1111-111111111111') -> 'ai_photo_block', 'null'::jsonb,
  'the block is gone');
select is((public.admin_user_detail('11111111-1111-1111-1111-111111111111') ->> 'ai_photo_refusals_30d')::int, 0,
  'and the count starts over');
select is((select ai_photos_blocked from public.admin_list_users('ann@')), false, 'the list says so');
reset role;

select is(
  (select jsonb_agg(jsonb_build_object('performed_by', a.performed_by, 'details', a.details, 'note', a.note))
   from admin.admin_actions a
   where a.action = 'unblock_ai_photos' and a.target_user_id = '11111111-1111-1111-1111-111111111111'),
  jsonb_build_array(jsonb_build_object(
    'performed_by', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    'details', jsonb_build_object('refusals', 3, 'blocked_at', now()),
    'note', 'Asked by support, tested a horror menu')),
  'one audit row, by the admin, with the note');
select is((select count(*)::int from admin.admin_actions where action = 'unblock_ai_photos'), 1,
  'the failed unblocks audited nothing');

-- After the unblock ------------------------------------------------------------
insert into public.ai_calls (id, task, model, prompt_version, status, instructions, prompt, duration_ms, user_id) values
  ('c2000000-0000-0000-0000-000000000001', 'recipePhotoModeration', 'mock', 'v1', 'refused', '', 'p', 1, '11111111-1111-1111-1111-111111111111'),
  ('c2000000-0000-0000-0000-000000000002', 'recipePhotoImage', 'mock', 'v1', 'refused', '', 'p', 1, '11111111-1111-1111-1111-111111111111');
select ok(not exists (select 1 from private.ai_photo_blocks where user_id = '11111111-1111-1111-1111-111111111111'),
  'two new refusals don''t block');
insert into public.ai_calls (id, task, model, prompt_version, status, instructions, prompt, duration_ms, user_id) values
  ('c2000000-0000-0000-0000-000000000003', 'recipePhotoModeration', 'mock', 'v1', 'refused', '', 'p', 1, '11111111-1111-1111-1111-111111111111');
select is(
  (select jsonb_build_object('refusals', b.refusals, 'last_call_id', b.last_call_id)
   from private.ai_photo_blocks b where b.user_id = '11111111-1111-1111-1111-111111111111'),
  '{"refusals": 3, "last_call_id": "c2000000-0000-0000-0000-000000000003"}'::jsonb,
  'a third does');
select is((select count(*)::int from admin.admin_actions
           where action = 'block_ai_photos' and target_user_id = '11111111-1111-1111-1111-111111111111'), 2,
  'with a second block audit row');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","role":"authenticated"}', true);
select is((public.admin_user_detail('11111111-1111-1111-1111-111111111111') ->> 'ai_photo_refusals_30d')::int, 3,
  'the detail counts only the refusals since the unblock');
reset role;

select * from finish();
rollback;
