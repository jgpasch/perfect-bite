-- Portal functions for failed and flagged AI calls (spec 4.12): listing them, the sidebar's
-- flag count, and reading one call in full. Like the other portal functions each is `public` and
-- `security definer`, starts with private.require_admin() and is executable by `authenticated`
-- only. The list and the count are read-only, so no audit row; reading one call shows a user's
-- own text, so it writes one admin.admin_actions row (`view_ai_call`).
--
-- Also: admin_user_detail gains `ai_flags`, and admins may read recipe-photos objects, so the
-- portal can sign URLs for the AI photos (not audited).

-- ---------------------------------------------------------------------------
-- admin_list_ai_calls: newest first, p_limit (at most 200) from p_offset. p_kind is `failed`
-- (status isn't `ok`), `flagged` (private.ai_call_flag isn't null) or `photos` (`ok`
-- recipePhotoImage rows); anything else raises `invalid kind` (22023). p_task, p_status, p_flag
-- and p_user_id filter. Returns { calls: [...], total_count }, total_count being the matches
-- before paging. `recovered` is true when an attempt whose fallback_of is this row ended `ok`;
-- an image row's fallback_of links its description and isn't a fallback (6.4), so it doesn't
-- count. `photo_path` is output->>'path', on image rows only.
-- ---------------------------------------------------------------------------

-- The rows matching the list's kind and filters, unordered. Only admin_list_ai_calls calls it,
-- once to count and once to page, with p_kind already checked.
create function private.admin_ai_calls_matching(
  p_kind text, p_task text, p_status text, p_flag text, p_user_id uuid
)
returns setof public.ai_calls
language sql
stable
set search_path = ''
as $$
  select c.*
  from public.ai_calls c
  where case p_kind
          when 'failed' then c.status <> 'ok'
          when 'flagged' then private.ai_call_flag(c) is not null
          when 'photos' then c.status = 'ok' and c.task = 'recipePhotoImage'
        end
    and (p_task is null or c.task = p_task)
    and (p_status is null or c.status = p_status)
    and (p_flag is null or private.ai_call_flag(c) = p_flag)
    and (p_user_id is null or c.user_id = p_user_id);
$$;

revoke all on function private.admin_ai_calls_matching(text, text, text, text, uuid) from public, anon, authenticated, service_role;

create function public.admin_list_ai_calls(
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
      where f.fallback_of = c.id and f.status = 'ok' and f.task <> 'recipePhotoImage'
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

-- ---------------------------------------------------------------------------
-- admin_ai_call_flag_count: flagged calls in the last p_days days (7 when null), for the
-- sidebar's badge.
-- ---------------------------------------------------------------------------

create function public.admin_ai_call_flag_count(p_days integer default 7)
returns integer
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_admin();

  return (
    select count(*)::integer
    from public.ai_calls c
    where private.ai_call_flag(c) is not null
      and c.created_at >= now() - coalesce(p_days, 7) * interval '1 day'
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- admin_ai_call: one call, any status, with every column, its flag, the user's email (while they
-- exist), photo_path (image rows), `fallback` (the attempt that followed it: the row whose
-- fallback_of is this one, newest if several) and `primary` (the row its fallback_of points at),
-- each { id, task, model, status, error } or null. Raises `not found` (P0002) for an unknown id.
-- Writes one admin.admin_actions row (`view_ai_call`, the call's user, { ai_call_id, task, flag },
-- no note, performed_by the admin's id), so it isn't `stable`.
-- ---------------------------------------------------------------------------

create function public.admin_ai_call(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_call public.ai_calls;
  v_flag text;
begin
  perform private.require_admin();

  select * into v_call from public.ai_calls c where c.id = p_id;
  if not found then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  v_flag := private.ai_call_flag(v_call);

  insert into admin.admin_actions (action, target_user_id, details, performed_by)
  values ('view_ai_call', v_call.user_id,
          jsonb_build_object('ai_call_id', v_call.id, 'task', v_call.task, 'flag', v_flag),
          auth.uid()::text);

  return to_jsonb(v_call) || jsonb_build_object(
    'flag', v_flag,
    'user_email', (select u.email from auth.users u where u.id = v_call.user_id),
    'photo_path', case when v_call.task = 'recipePhotoImage' then v_call.output ->> 'path' end,
    'fallback', (
      select jsonb_build_object('id', f.id, 'task', f.task, 'model', f.model, 'status', f.status, 'error', f.error)
      from public.ai_calls f
      where f.fallback_of = v_call.id
      order by f.created_at desc, f.id
      limit 1
    ),
    'primary', (
      select jsonb_build_object('id', p.id, 'task', p.task, 'model', p.model, 'status', p.status, 'error', p.error)
      from public.ai_calls p
      where p.id = v_call.fallback_of
    )
  );
end;
$$;

revoke all on function public.admin_list_ai_calls(text, text, text, text, uuid, integer, integer) from public, anon, service_role;
revoke all on function public.admin_ai_call_flag_count(integer) from public, anon, service_role;
revoke all on function public.admin_ai_call(uuid) from public, anon, service_role;
grant execute on function public.admin_list_ai_calls(text, text, text, text, uuid, integer, integer) to authenticated;
grant execute on function public.admin_ai_call_flag_count(integer) to authenticated;
grant execute on function public.admin_ai_call(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- admin_user_detail, as before, plus `ai_flags`: the user's flagged calls in the last 30 days,
-- a count per flag ({ "not_food": 2, "refused": 1 }; {} when none).
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
    ), '{}')
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Storage: an admin may read any recipe-photos object, so the portal can sign URLs for the AI
-- photos. Reads aren't audited. Members' own policies are unchanged.
-- ---------------------------------------------------------------------------

create policy recipe_photos_select_admin on storage.objects
  for select to authenticated
  using (bucket_id = 'recipe-photos' and public.is_admin());
