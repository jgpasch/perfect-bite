-- Flagged AI calls (spec 4.12, 6.11): private.ai_call_flag, its partial index, and the
-- ai-calls-retention job keeping flagged calls and their linked calls 180 days.
begin;
create extension if not exists pgtap with schema extensions;
select plan(20);

-- One row per flag case, and rows that aren't flagged.
insert into public.ai_calls (id, task, model, prompt_version, status, instructions, prompt, output, finish_reason, duration_ms) values
  ('f0000000-0000-0000-0000-000000000001', 'recipePhotoDescription', 'mock', 'v1', 'ok', 'i', 'p',
   '{"isFood": false, "description": ""}', 'stop', 1),
  ('f0000000-0000-0000-0000-000000000002', 'recipePhotoImage', 'openai:gpt-image-1-mini', 'v1', 'refused', '', 'p',
   null, null, 1),
  ('f0000000-0000-0000-0000-000000000003', 'importRecipe', 'google:gemini', 'v1', 'invalid_output', 'i', 'p',
   null, 'content-filter', 1),
  ('f0000000-0000-0000-0000-000000000004', 'recipePhotoDescription', 'mock', 'v1', 'ok', 'i', 'p',
   '{"isFood": true, "description": "A bowl of soup"}', 'stop', 1),
  ('f0000000-0000-0000-0000-000000000005', 'categorize', 'anthropic:a', 'v1', 'api_error', 'i', 'p',
   null, null, 1),
  ('f0000000-0000-0000-0000-000000000006', 'categorize', 'mock', 'v1', 'ok', 'i', 'p',
   '{"isFood": false}', 'stop', 1);

select is((select private.ai_call_flag(c) from public.ai_calls c where id = 'f0000000-0000-0000-0000-000000000001'),
  'not_food', 'a description answering isFood false is not_food');
select is((select private.ai_call_flag(c) from public.ai_calls c where id = 'f0000000-0000-0000-0000-000000000002'),
  'refused', 'a refused row is refused');
select is((select private.ai_call_flag(c) from public.ai_calls c where id = 'f0000000-0000-0000-0000-000000000003'),
  'content_filter', 'a content-filter finish is content_filter, whatever the task and status');
select is((select private.ai_call_flag(c) from public.ai_calls c where id = 'f0000000-0000-0000-0000-000000000004'),
  null, 'a description answering isFood true is not flagged');
select is((select private.ai_call_flag(c) from public.ai_calls c where id = 'f0000000-0000-0000-0000-000000000005'),
  null, 'an ordinary failure is not flagged');
select is((select private.ai_call_flag(c) from public.ai_calls c where id = 'f0000000-0000-0000-0000-000000000006'),
  null, 'isFood false on another task is not flagged');
select is((select provolatile from pg_proc where oid = 'private.ai_call_flag(public.ai_calls)'::regprocedure),
  'i', 'ai_call_flag is immutable');
select has_index('public', 'ai_calls', 'ai_calls_flagged_idx', 'flagged rows have a partial index');
select is((select pg_get_indexdef(indexrelid) ~ 'WHERE .*private\.ai_call_flag\(.*IS NOT NULL'
           from pg_index where indexrelid = 'public.ai_calls_flagged_idx'::regclass),
  true, 'the index covers only flagged rows');

set local role authenticated;
select throws_ok($$ select private.ai_call_flag(null::public.ai_calls) $$, '42501', null,
  'authenticated cannot call ai_call_flag');
reset role;

-- Retention. Ages: 31 days (past 30, within 180) and 181 days (past both).
delete from public.ai_calls;
insert into public.ai_calls (id, created_at, task, model, prompt_version, status, instructions, prompt, output, duration_ms, fallback_of) values
  -- Unflagged, 31 days: deleted.
  ('e0000000-0000-0000-0000-000000000001', now() - interval '31 days', 'categorize', 'mock', 'v1', 'ok', 'i', 'p', '{}', 1, null),
  -- Unflagged, 29 days: kept.
  ('e0000000-0000-0000-0000-000000000002', now() - interval '29 days', 'categorize', 'mock', 'v1', 'ok', 'i', 'p', '{}', 1, null),
  -- An AI photo: the description (unflagged), then the refused image linked to it, both 31 days.
  ('e0000000-0000-0000-0000-000000000003', now() - interval '31 days', 'recipePhotoDescription', 'mock', 'v1', 'ok', 'i', 'Tacos',
   '{"isFood": true, "description": "Tacos"}', 1, null),
  ('e0000000-0000-0000-0000-000000000004', now() - interval '31 days', 'recipePhotoImage', 'openai:m', 'v1', 'refused', '', 'Tacos',
   null, 1, 'e0000000-0000-0000-0000-000000000003'),
  -- The other way round: a not_food primary attempt and an unflagged attempt that followed it, 31 days.
  ('e0000000-0000-0000-0000-000000000005', now() - interval '31 days', 'recipePhotoDescription', 'mock', 'v1', 'ok', 'i', 'Bad',
   '{"isFood": false, "description": ""}', 1, null),
  ('e0000000-0000-0000-0000-000000000006', now() - interval '31 days', 'recipePhotoImage', 'mock', 'v1', 'ok', '', 'Bad',
   '{}', 1, 'e0000000-0000-0000-0000-000000000005'),
  -- The same pair as the first, at 181 days: both deleted.
  ('e0000000-0000-0000-0000-000000000007', now() - interval '181 days', 'recipePhotoDescription', 'mock', 'v1', 'ok', 'i', 'Old',
   '{"isFood": true, "description": "Old"}', 1, null),
  ('e0000000-0000-0000-0000-000000000008', now() - interval '181 days', 'recipePhotoImage', 'openai:m', 'v1', 'refused', '', 'Old',
   null, 1, 'e0000000-0000-0000-0000-000000000007'),
  -- A flagged row at 179 days: kept.
  ('e0000000-0000-0000-0000-000000000009', now() - interval '179 days', 'importRecipe', 'google:g', 'v1', 'invalid_output', 'i', 'p',
   null, 1, null);
update public.ai_calls set finish_reason = 'content-filter' where id = 'e0000000-0000-0000-0000-000000000009';

do $$ begin execute (select command from cron.job where jobname = 'ai-calls-retention'); end $$;

select is((select schedule from cron.job where jobname = 'ai-calls-retention'), '17 3 * * *',
  'the job keeps its daily schedule');
select is((select count(*)::int from cron.job where jobname = 'ai-calls-retention'), 1, 'there is still one retention job');
select ok(not exists (select 1 from public.ai_calls where id = 'e0000000-0000-0000-0000-000000000001'),
  'a 31-day-old unflagged row is deleted');
select ok(exists (select 1 from public.ai_calls where id = 'e0000000-0000-0000-0000-000000000002'),
  'a 29-day-old row is kept');
select ok(exists (select 1 from public.ai_calls where id = 'e0000000-0000-0000-0000-000000000004'),
  'a 31-day-old flagged row is kept');
select ok(exists (select 1 from public.ai_calls where id = 'e0000000-0000-0000-0000-000000000003'),
  'and the row it links to (its description) is kept');
select ok(exists (select 1 from public.ai_calls where id = 'e0000000-0000-0000-0000-000000000005'),
  'a 31-day-old flagged primary attempt is kept');
select ok(exists (select 1 from public.ai_calls where id = 'e0000000-0000-0000-0000-000000000006'),
  'and the row linking to it is kept');
select ok(not exists (select 1 from public.ai_calls where id in ('e0000000-0000-0000-0000-000000000007', 'e0000000-0000-0000-0000-000000000008')),
  'a flagged row and its linked row are both deleted at 181 days');
select ok(exists (select 1 from public.ai_calls where id = 'e0000000-0000-0000-0000-000000000009'),
  'a 179-day-old flagged row is kept');

select * from finish();
rollback;
