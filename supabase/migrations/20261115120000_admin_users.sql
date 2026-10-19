-- Portal functions for users (spec 4.12): finding a user, reading their plan, usage and plan
-- history, and changing their plan. Each is `public` and `security definer`, starts with
-- private.require_admin() and is executable by `authenticated` only (the check is the function's
-- first step, not the grant). Changing a plan writes one admin.admin_actions row with the admin's
-- id in performed_by and a required note.

-- The six feature keys in their fixed order (plan_limits' check), for the portal's lists.
create function private.feature_keys()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array['categorize', 'recipe_import', 'recipe_import_photo', 'recipe_tags', 'step_ingredients', 'recipe_photo_ai'];
$$;

revoke all on function private.feature_keys() from public, anon, authenticated, service_role;

-- When the user's first month ends (auth.users.created_at plus 30 days), or null for an unknown
-- user. Until then private.monthly_limit doubles their limits. The one place the 30 days live.
create function private.first_month_ends_at(p_user_id uuid)
returns timestamptz
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  c_first_month constant interval := interval '30 days';
begin
  return (select u.created_at + c_first_month from auth.users u where u.id = p_user_id);
end;
$$;

revoke all on function private.first_month_ends_at(uuid) from public, anon, authenticated, service_role;

-- As before, with the 30 days read from first_month_ends_at.
create or replace function private.monthly_limit(p_user_id uuid, p_feature text, p_household_id uuid default null)
returns integer
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  -- First month: an account younger than private.first_month_ends_at gets c_first_month_factor
  -- times its plan's limits, so importing a collection on day one doesn't hit the wall.
  c_first_month_factor constant integer := 2;
  v_limit integer;
begin
  select l.monthly_limit into v_limit
  from public.plan_limits l
  where l.feature = p_feature
    and l.plan_id = coalesce(
      (select up.plan_id from public.user_plans up where up.user_id = p_user_id),
      (select p.id from public.plans p where p.is_default)
    );
  if v_limit is null then
    return null;
  end if;

  if now() < private.first_month_ends_at(p_user_id) then
    return v_limit * c_first_month_factor;
  end if;
  return v_limit;
end;
$$;

-- ---------------------------------------------------------------------------
-- admin_list_users: users matching p_search (email or display name, case-insensitively, or the
-- user id exactly when p_search is a uuid), newest first, p_limit (at most 200) from p_offset.
-- total_count is the number of matches before paging. A user with no user_plans row shows the
-- default plan with plan_assigned false and a null assigned_at.
-- ---------------------------------------------------------------------------

create function public.admin_list_users(p_search text default null, p_limit integer default 50, p_offset integer default 0)
returns table (
  user_id uuid,
  email text,
  display_name text,
  created_at timestamptz,
  last_sign_in_at timestamptz,
  plan_id text,
  plan_assigned boolean,
  assigned_at timestamptz,
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
         count(*) over ()
  from auth.users u
  left join public.profiles pr on pr.user_id = u.id
  left join public.user_plans up on up.user_id = u.id
  where v_search is null
     or (v_id is not null and u.id = v_id)
     or (v_id is null and (strpos(lower(u.email), lower(v_search)) > 0
                           or strpos(lower(pr.display_name), lower(v_search)) > 0))
  order by u.created_at desc nulls last, u.id
  limit least(greatest(coalesce(p_limit, 50), 0), 200)
  offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

-- ---------------------------------------------------------------------------
-- admin_user_detail: one user's fields, plan, first month, households, this month's usage per
-- feature and plan history. Raises `user not found` (P0002) for an unknown id.
-- ---------------------------------------------------------------------------

create function public.admin_user_detail(p_user_id uuid)
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
    ), '[]')
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- admin_set_user_plan: puts the user on p_plan_id (upserting their user_plans row), or back on
-- the default plan when it's null (deleting the row). Raises `user not found`, `plan not found`
-- (P0002) or `note required` (22023), changing nothing. Writes one audit row, even when the plan
-- doesn't change, and returns its details: { from, to }, plan ids or null for the default.
-- ---------------------------------------------------------------------------

create function public.admin_set_user_plan(p_user_id uuid, p_plan_id text, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_from text;
  v_details jsonb;
begin
  perform private.require_admin();

  if not exists (select 1 from auth.users u where u.id = p_user_id) then
    raise exception 'user not found' using errcode = 'P0002';
  end if;
  if p_plan_id is not null and not exists (select 1 from public.plans p where p.id = p_plan_id) then
    raise exception 'plan not found' using errcode = 'P0002';
  end if;
  if p_note is null or btrim(p_note) = '' then
    raise exception 'note required' using errcode = '22023';
  end if;

  select up.plan_id into v_from from public.user_plans up where up.user_id = p_user_id for update;

  if p_plan_id is null then
    delete from public.user_plans up where up.user_id = p_user_id;
  else
    insert into public.user_plans as up (user_id, plan_id) values (p_user_id, p_plan_id)
    on conflict (user_id) do update set plan_id = excluded.plan_id;
  end if;

  v_details := jsonb_build_object('from', v_from, 'to', p_plan_id);
  insert into admin.admin_actions (action, target_user_id, target_plan_id, details, note, performed_by)
  values ('set_user_plan', p_user_id, p_plan_id, v_details, p_note, auth.uid()::text);

  return v_details;
end;
$$;

revoke all on function public.admin_list_users(text, integer, integer) from public, anon, service_role;
revoke all on function public.admin_user_detail(uuid) from public, anon, service_role;
revoke all on function public.admin_set_user_plan(uuid, text, text) from public, anon, service_role;
grant execute on function public.admin_list_users(text, integer, integer) to authenticated;
grant execute on function public.admin_user_detail(uuid) to authenticated;
grant execute on function public.admin_set_user_plan(uuid, text, text) to authenticated;
