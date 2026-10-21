-- The AI photo's moderation check goes into ai_calls (spec 6.4, 6.11): generate-recipe-photo
-- moderates the image prompt before the image call and logs one `recipePhotoModeration` row per
-- check (`ok` with output { flagged, categories }, `refused` when flagged, or the failure status),
-- linked to its description row by `fallback_of`, as the image row is. `task` is free text, and a
-- flagged check is `refused`, so it's flagged `refused` by private.ai_call_flag and kept 180 days
-- with its description, like a refused image.
--
-- Like an image row's, a moderation row's fallback_of is the link to its description, not a
-- fallback: it isn't counted in `fallbacks` (private.ai_call_stats) and doesn't make the
-- description `recovered` (admin_list_ai_calls).

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
    'fallbacks', count(*) filter (where c.fallback_of is not null and c.task not in ('recipePhotoImage', 'recipePhotoModeration')),
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

create or replace function public.admin_list_ai_calls(
  p_kind text default 'failed',
  p_task text default null,
  p_status text default null,
  p_flag text default null,
  p_user_id uuid default null,
  p_limit integer default 50,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_task text := nullif(btrim(p_task), '');
  v_status text := nullif(btrim(p_status), '');
  v_flag text := nullif(btrim(p_flag), '');
  v_total bigint;
  v_calls jsonb;
begin
  perform private.require_admin();

  if p_kind is null or p_kind not in ('failed', 'flagged', 'photos') then
    raise exception 'invalid kind' using errcode = '22023';
  end if;

  select count(*) into v_total
  from private.admin_ai_calls_matching(p_kind, v_task, v_status, v_flag, p_user_id);

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', c.id,
    'created_at', c.created_at,
    'task', c.task,
    'model', c.model,
    'prompt_version', c.prompt_version,
    'status', c.status,
    'flag', private.ai_call_flag(c),
    'error', c.error,
    'http_status', c.http_status,
    'finish_reason', c.finish_reason,
    'duration_ms', c.duration_ms,
    'fallback_of', c.fallback_of,
    'recovered', exists (
      select 1 from public.ai_calls f
      where f.fallback_of = c.id and f.status = 'ok' and f.task not in ('recipePhotoImage', 'recipePhotoModeration')
    ),
    'user_id', c.user_id,
    'user_email', (select u.email from auth.users u where u.id = c.user_id),
    'household_id', c.household_id,
    'recipe_id', c.recipe_id,
    'photo_path', case when c.task = 'recipePhotoImage' then c.output ->> 'path' end
  ) order by c.created_at desc, c.id), '[]') into v_calls
  from (
    select m.id
    from private.admin_ai_calls_matching(p_kind, v_task, v_status, v_flag, p_user_id) m
    order by m.created_at desc, m.id
    limit least(greatest(coalesce(p_limit, 50), 0), 200)
    offset greatest(coalesce(p_offset, 0), 0)
  ) p
  join public.ai_calls c on c.id = p.id;

  return jsonb_build_object('calls', v_calls, 'total_count', v_total);
end;
$$;

revoke all on function public.admin_list_ai_calls(text, text, text, text, uuid, integer, integer) from public, anon, service_role;
grant execute on function public.admin_list_ai_calls(text, text, text, text, uuid, integer, integer) to authenticated;
