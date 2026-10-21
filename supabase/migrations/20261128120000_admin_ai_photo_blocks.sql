-- Seeing and clearing AI photo blocks in the portal (spec 4.12 Users, Flagged AI calls; 6.11).
-- admin_user_detail gains the block and the user's refusals in the window; admin_list_users gains
-- `ai_photos_blocked` and a Blocked filter; admin_list_ai_calls tells a row's user is blocked; and
-- admin_unblock_ai_photos clears a block with a note, audited as `unblock_ai_photos`.
--
-- Unblocking starts the count over: private.ai_photo_refusals only counts refusals since the
-- user's latest `unblock_ai_photos` (when that's later than p_since), so the refusals that blocked
-- them don't block them again on the next one.

-- ---------------------------------------------------------------------------
-- private.ai_photo_refusals, as before, from p_since or the latest unblock, whichever is later.
-- ---------------------------------------------------------------------------

create or replace function private.ai_photo_refusals(p_user_id uuid, p_since timestamptz)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::integer
  from public.ai_calls c
  where c.user_id = p_user_id
    and c.task in ('recipePhotoModeration', 'recipePhotoImage')
    and c.status = 'refused'
    and c.created_at >= greatest(p_since, (
      select max(a.created_at) from admin.admin_actions a
      where a.action = 'unblock_ai_photos' and a.target_user_id = p_user_id
    ));
$$;

revoke all on function private.ai_photo_refusals(uuid, timestamptz) from public, anon, authenticated;

-- Finds a user's latest unblock (above) and their audit rows.
create index admin_actions_target_user_idx on admin.admin_actions (target_user_id, action, created_at desc);

-- ---------------------------------------------------------------------------
-- admin_list_users, as before, plus `ai_photos_blocked` and p_blocked: null lists everyone, true
-- only blocked users, false only the others.
-- ---------------------------------------------------------------------------

drop function public.admin_list_users(text, integer, integer);

create function public.admin_list_users(
  p_search text default null,
  p_limit integer default 50,
  p_offset integer default 0,
  p_blocked boolean default null
)
returns table (
  user_id uuid,
  email text,
  display_name text,
  created_at timestamptz,
  last_sign_in_at timestamptz,
  plan_id text,
  plan_assigned boolean,
  assigned_at timestamptz,
  ai_photos_blocked boolean,
  total_count bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_search text := nullif(btrim(p_search), '');
  v_id uuid;
  v_default text := (select p.id from public.plans p where p.is_default);
begin
  perform private.require_admin();

  if v_search ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    v_id := v_search::uuid;
  end if;

  return query
  select u.id, u.email::text, pr.display_name, u.created_at, u.last_sign_in_at,
         coalesce(up.plan_id, v_default), up.user_id is not null, up.assigned_at,
         b.user_id is not null,
         count(*) over ()
  from auth.users u
  left join public.profiles pr on pr.user_id = u.id
  left join public.user_plans up on up.user_id = u.id
  left join private.ai_photo_blocks b on b.user_id = u.id
  where (v_search is null
         or (v_id is not null and u.id = v_id)
         or (v_id is null and (strpos(lower(u.email), lower(v_search)) > 0
                               or strpos(lower(pr.display_name), lower(v_search)) > 0)))
    and (p_blocked is null or (b.user_id is not null) = p_blocked)
  order by u.created_at desc nulls last, u.id
  limit least(greatest(coalesce(p_limit, 50), 0), 200)
  offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

revoke all on function public.admin_list_users(text, integer, integer, boolean) from public, anon, service_role;
grant execute on function public.admin_list_users(text, integer, integer, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- admin_user_detail, as before, plus `ai_photo_block` (null, or { blocked_at, refusals,
-- last_call_id }) and `ai_photo_refusals_30d` (private.ai_photo_refusals over the block window).
-- ---------------------------------------------------------------------------

create or replace function public.admin_user_detail(p_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user auth.users;
  v_display_name text;
  v_up public.user_plans;
  v_plan public.plans;
  v_ends_at timestamptz;
  v_resets_at timestamptz := (date_trunc('month', now() at time zone 'utc') + interval '1 month') at time zone 'utc';
begin
  perform private.require_admin();

  select * into v_user from auth.users u where u.id = p_user_id;
  if not found then
    raise exception 'user not found' using errcode = 'P0002';
  end if;
  select p.display_name into v_display_name from public.profiles p where p.user_id = p_user_id;
  select * into v_up from public.user_plans up where up.user_id = p_user_id;
  select * into v_plan from public.plans p
  where p.id = coalesce(v_up.plan_id, (select d.id from public.plans d where d.is_default));
  v_ends_at := private.first_month_ends_at(p_user_id);

  return jsonb_build_object(
    'user_id', v_user.id,
    'email', v_user.email,
    'display_name', v_display_name,
    'created_at', v_user.created_at,
    'last_sign_in_at', v_user.last_sign_in_at,
    'plan_id', v_plan.id,
    'plan_assigned', v_up.user_id is not null,
    'assigned_at', v_up.assigned_at,
    'plan', jsonb_build_object(
      'id', v_plan.id,
      'name', v_plan.name,
      'assigned', v_up.user_id is not null,
      'assigned_at', v_up.assigned_at
    ),
    'first_month', jsonb_build_object(
      'doubled', coalesce(now() < v_ends_at, false),
      'ends_at', v_ends_at
    ),
    'households', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', h.id,
        'name', h.name,
        'role', hm.role,
        'member_count', (select count(*) from public.household_members m where m.household_id = h.id)
      ) order by hm.position, h.id)
      from public.household_members hm
      join public.households h on h.id = hm.household_id
      where hm.user_id = p_user_id
    ), '[]'),
    'usage', (
      select jsonb_agg(jsonb_build_object(
        'feature', f.feature,
        'in_plan', public.has_feature(p_user_id, f.feature),
        'used', private.monthly_usage(p_user_id, f.feature),
        'limit', private.monthly_limit(p_user_id, f.feature),
        'resets_at', v_resets_at
      ) order by f.ord)
      from unnest(private.feature_keys()) with ordinality as f (feature, ord)
    ),
    'plan_history', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', a.id,
        'created_at', a.created_at,
        'details', a.details,
        'note', a.note,
        'performed_by', a.performed_by,
        'performed_by_email', (
          select pu.email from auth.users pu
          where a.performed_by ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            and pu.id = a.performed_by::uuid
        )
      ) order by a.created_at desc, a.id)
      from admin.admin_actions a
      where a.action = 'set_user_plan' and a.target_user_id = p_user_id
    ), '[]'),
    'ai_flags', coalesce((
      select jsonb_object_agg(f.flag, f.n)
      from (
        select private.ai_call_flag(c) as flag, count(*) as n
        from public.ai_calls c
        where c.user_id = p_user_id
          and c.created_at >= now() - interval '30 days'
          and private.ai_call_flag(c) is not null
        group by 1
      ) f
    ), '{}'),
    'ai_photo_block', (
      select jsonb_build_object('blocked_at', b.blocked_at, 'refusals', b.refusals, 'last_call_id', b.last_call_id)
      from private.ai_photo_blocks b
      where b.user_id = p_user_id
    ),
    'ai_photo_refusals_30d', private.ai_photo_refusals(p_user_id, now() - private.ai_photo_block_window())
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- admin_unblock_ai_photos: deletes the user's block and writes an `unblock_ai_photos` audit row
-- with the note and details { refusals, blocked_at } (the block's), which it returns. Raises
-- `note required` (22023) or `not blocked` (P0002), changing nothing. From then on only refusals
-- after it count (private.ai_photo_refusals).
-- ---------------------------------------------------------------------------

create function public.admin_unblock_ai_photos(p_user_id uuid, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_block private.ai_photo_blocks;
  v_details jsonb;
begin
  perform private.require_admin();
  perform private.require_note(p_note);

  -- The trigger's lock, so a refusal being written now counts before or after, not both.
  perform pg_advisory_xact_lock(hashtextextended('ai_photo_blocks:' || p_user_id::text, 0));

  delete from private.ai_photo_blocks b where b.user_id = p_user_id returning * into v_block;
  if not found then
    raise exception 'not blocked' using errcode = 'P0002';
  end if;

  v_details := jsonb_build_object('refusals', v_block.refusals, 'blocked_at', v_block.blocked_at);
  insert into admin.admin_actions (action, target_user_id, details, note, performed_by)
  values ('unblock_ai_photos', p_user_id, v_details, p_note, auth.uid()::text);

  return v_details;
end;
$$;

revoke all on function public.admin_unblock_ai_photos(uuid, text) from public, anon, service_role;
grant execute on function public.admin_unblock_ai_photos(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- admin_list_ai_calls, as before, plus `user_ai_photos_blocked`: the call's user is blocked now.
-- ---------------------------------------------------------------------------

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
    'user_ai_photos_blocked', exists (select 1 from private.ai_photo_blocks b where b.user_id = c.user_id),
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
