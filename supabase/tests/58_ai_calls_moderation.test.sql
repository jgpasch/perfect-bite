-- The AI photo's moderation rows in ai_calls (spec 6.4, 6.11, 4.12): `recipePhotoModeration` is
-- accepted, a flagged check (`refused`) is flagged, and like an image row its fallback_of is the
-- link to its description, so it's no fallback in ai_call_stats and doesn't make a row recovered.
begin;
create extension if not exists pgtap with schema extensions;
select plan(11);

insert into auth.users (id, email, aud, role) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'boss@portal.test', 'authenticated', 'authenticated'),
  ('11111111-1111-1111-1111-111111111111', 'alex@portal.test', 'authenticated', 'authenticated');
insert into private.admins (user_id) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');

-- d01 a description and m01 its flagged moderation; d02 a description, m02 its clean moderation
-- and i02 its photo; d03 a failed description followed only by an ok moderation row (no real
-- fallback), d04 a failed description recovered by a real fallback f04.
insert into public.ai_calls (id, created_at, task, model, prompt_version, status, instructions, prompt, output,
                             duration_ms, error, fallback_of, user_id) values
  ('d0000000-0000-0000-0000-000000000001', now() - interval '50 minutes', 'recipePhotoDescription', 'mock', 'v1', 'ok',
   'sys', 'Bloody steak', '{"isFood": true, "description": "A steak."}', 5, null, null, '11111111-1111-1111-1111-111111111111'),
  ('d0000000-0000-0000-0000-000000000002', now() - interval '40 minutes', 'recipePhotoDescription', 'mock', 'v1', 'ok',
   'sys', 'Soup', '{"isFood": true, "description": "A soup."}', 5, null, null, '11111111-1111-1111-1111-111111111111'),
  ('d0000000-0000-0000-0000-000000000003', now() - interval '30 minutes', 'recipePhotoDescription', 'google:a', 'v1', 'api_error',
   'sys', 'Stew', null, 5, 'AI_APICallError', null, null),
  ('d0000000-0000-0000-0000-000000000004', now() - interval '20 minutes', 'recipePhotoDescription', 'google:a', 'v1', 'timeout',
   'sys', 'Pie', null, 5, 'timeout', null, null);
insert into public.ai_calls (id, created_at, task, model, prompt_version, status, instructions, prompt, output,
                             duration_ms, error, fallback_of, user_id) values
  ('e0000000-0000-0000-0000-000000000001', now() - interval '49 minutes', 'recipePhotoModeration', 'openai:omni-moderation-latest',
   'recipe-photo-image.v1', 'refused', '', 'The dish: A steak.', '{"flagged": true, "categories": ["violence"]}', 80,
   'Flagged: violence', 'd0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111'),
  ('e0000000-0000-0000-0000-000000000002', now() - interval '39 minutes', 'recipePhotoModeration', 'openai:omni-moderation-latest',
   'recipe-photo-image.v1', 'ok', '', 'The dish: A soup.', '{"flagged": false, "categories": []}', 80,
   null, 'd0000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111'),
  ('e0000000-0000-0000-0000-000000000003', now() - interval '29 minutes', 'recipePhotoModeration', 'openai:omni-moderation-latest',
   'recipe-photo-image.v1', 'ok', '', 'The dish: A stew.', '{"flagged": false, "categories": []}', 80,
   null, 'd0000000-0000-0000-0000-000000000003', null),
  ('f0000000-0000-0000-0000-000000000002', now() - interval '38 minutes', 'recipePhotoImage', 'openai:gpt-image-1-mini',
   'recipe-photo-image.v1', 'ok', '', 'The dish: A soup.', '{"quality": "medium", "path": "x/y/z.jpg"}', 9000,
   null, 'd0000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111'),
  ('f0000000-0000-0000-0000-000000000004', now() - interval '19 minutes', 'recipePhotoDescription', 'anthropic:b', 'v1', 'ok',
   'sys', 'Pie', '{"isFood": true, "description": "A pie."}', 5, null, 'd0000000-0000-0000-0000-000000000004', null);

-- As postgres ---------------------------------------------------------------------------------
select is(private.ai_call_flag(c), 'refused', 'a flagged moderation row is flagged refused')
  from public.ai_calls c where c.id = 'e0000000-0000-0000-0000-000000000001';
select is(private.ai_call_flag(c), null, 'a clean moderation row isn''t flagged')
  from public.ai_calls c where c.id = 'e0000000-0000-0000-0000-000000000002';
select is(
  private.ai_call_stats('recipePhotoModeration', null, now() - interval '1 day'),
  '{"total": 3, "statuses": {"ok": 2, "api_error": 0, "invalid_output": 0, "timeout": 0, "refused": 1, "error": 0},
    "fallbacks": 0, "input_tokens": 0, "output_tokens": 0, "cached_input_tokens": 0, "reasoning_tokens": 0}'::jsonb,
  'ai_call_stats counts moderation rows, and their link to the description isn''t a fallback');
select is((private.ai_call_stats('recipePhotoDescription', null, now() - interval '1 day') ->> 'fallbacks')::int, 1,
  'a real description fallback is still counted');

-- As the admin --------------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","role":"authenticated"}', true);

select is(
  (select jsonb_agg(x ->> 'id') from jsonb_array_elements(public.admin_list_ai_calls('flagged', p_task => 'recipePhotoModeration') -> 'calls') x),
  '["e0000000-0000-0000-0000-000000000001"]'::jsonb, 'the flagged list filters to the flagged moderation row');
select is(
  (select x - 'created_at' - 'duration_ms' - 'user_email' - 'household_id' - 'recipe_id' - 'http_status' - 'finish_reason'
   from jsonb_array_elements(public.admin_list_ai_calls('flagged') -> 'calls') x
   where x ->> 'id' = 'e0000000-0000-0000-0000-000000000001'),
  '{"id": "e0000000-0000-0000-0000-000000000001", "task": "recipePhotoModeration", "model": "openai:omni-moderation-latest",
    "prompt_version": "recipe-photo-image.v1", "status": "refused", "flag": "refused", "error": "Flagged: violence",
    "fallback_of": "d0000000-0000-0000-0000-000000000001", "recovered": false,
    "user_id": "11111111-1111-1111-1111-111111111111", "photo_path": null}'::jsonb,
  'a flagged moderation row in the list, linked to its description, with no photo');
select is(
  (select x -> 'recovered' from jsonb_array_elements(public.admin_list_ai_calls('failed') -> 'calls') x
   where x ->> 'id' = 'd0000000-0000-0000-0000-000000000003'),
  'false'::jsonb, 'an ok moderation row linking to a failed description doesn''t make it recovered');
select is(
  (select x -> 'recovered' from jsonb_array_elements(public.admin_list_ai_calls('failed') -> 'calls') x
   where x ->> 'id' = 'd0000000-0000-0000-0000-000000000004'),
  'true'::jsonb, 'a real fallback still does');
select is(
  (select jsonb_agg(x ->> 'id') from jsonb_array_elements(public.admin_list_ai_calls('photos') -> 'calls') x),
  '["f0000000-0000-0000-0000-000000000002"]'::jsonb, 'AI photos lists the image rows only, never a moderation row');
select is(
  (select x - 'models' from jsonb_array_elements(public.admin_ai_usage() -> 'calls') x where x ->> 'task' = 'recipePhotoModeration'),
  '{"task": "recipePhotoModeration", "total": 3,
    "statuses": {"ok": 2, "api_error": 0, "invalid_output": 0, "timeout": 0, "refused": 1, "error": 0},
    "fallbacks": 0, "input_tokens": 0, "output_tokens": 0, "cached_input_tokens": 0, "reasoning_tokens": 0}'::jsonb,
  'admin_ai_usage lists the moderation task');
select is(
  public.admin_ai_call('d0000000-0000-0000-0000-000000000001') -> 'fallback',
  '{"id": "e0000000-0000-0000-0000-000000000001", "task": "recipePhotoModeration", "model": "openai:omni-moderation-latest",
    "status": "refused", "error": "Flagged: violence"}'::jsonb,
  'a description stopped by moderation links to its moderation row');

select * from finish();
rollback;
