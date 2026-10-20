-- The AI photo's image call goes into ai_calls (spec 6.4, 6.11): generate-recipe-photo logs one
-- `recipePhotoImage` row per image call, linked to its description row by `fallback_of`. A
-- content-policy refusal is a new status, `refused`. Both AI photo rows (description and image)
-- record the recipe; every other task leaves `recipe_id` null. Deleting the recipe nulls it and
-- keeps the row.

alter table public.ai_calls drop constraint ai_calls_status_check;
alter table public.ai_calls
  add constraint ai_calls_status_check
  check (status in ('ok', 'api_error', 'invalid_output', 'timeout', 'refused', 'error'));

alter table public.ai_calls
  add column recipe_id uuid references public.recipes on delete set null;

-- Counts and token sums over a set of ai_calls rows (p_task, and p_model when given, since
-- p_since): total, a count per status (every status, zeros included), fallbacks (rows with
-- fallback_of set, except image rows, whose fallback_of is the link to their description, not a
-- fallback) and the four token sums (missing counts read as 0).
create or replace function private.ai_call_stats(p_task text, p_model text, p_since timestamptz)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'total', count(*),
    'statuses', jsonb_build_object(
      'ok', count(*) filter (where c.status = 'ok'),
      'api_error', count(*) filter (where c.status = 'api_error'),
      'invalid_output', count(*) filter (where c.status = 'invalid_output'),
      'timeout', count(*) filter (where c.status = 'timeout'),
      'refused', count(*) filter (where c.status = 'refused'),
      'error', count(*) filter (where c.status = 'error')
    ),
    'fallbacks', count(*) filter (where c.fallback_of is not null and c.task <> 'recipePhotoImage'),
    'input_tokens', coalesce(sum(c.input_tokens), 0),
    'output_tokens', coalesce(sum(c.output_tokens), 0),
    'cached_input_tokens', coalesce(sum(c.cached_input_tokens), 0),
    'reasoning_tokens', coalesce(sum(c.reasoning_tokens), 0)
  )
  from public.ai_calls c
  where c.task = p_task
    and (p_model is null or c.model = p_model)
    and c.created_at >= p_since;
$$;

revoke all on function private.ai_call_stats(text, text, timestamptz) from public, anon, authenticated, service_role;
