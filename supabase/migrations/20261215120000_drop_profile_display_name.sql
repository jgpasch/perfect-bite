-- profiles.display_name goes (spec 5, 4.12): everything that read it now reads the full name,
-- private.full_name(first_name, last_name), under the same key or column name (display_name), so
-- the admin portal is unchanged. Admin searches match the first name, the last name or the full
-- name. Each function is otherwise as in the migration named above it.

-- ---------------------------------------------------------------------------
-- Sign-up (20261213104500_profile_names.sql), without display_name.
-- ---------------------------------------------------------------------------

create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_meta jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  v_first text := private.clean_name(v_meta ->> 'given_name');
  v_last text;
begin
  if v_first is not null then
    v_last := private.clean_name(v_meta ->> 'family_name');
  else
    select s.first_name, s.last_name into v_first, v_last from private.split_name(v_meta ->> 'full_name') s;
    if v_first is null then
      select s.first_name, s.last_name into v_first, v_last from private.split_name(v_meta ->> 'name') s;
    end if;
    if v_first is null then
      v_first := private.clean_name(pg_catalog.split_part(coalesce(new.email, ''), '@', 1));
    end if;
  end if;

  insert into public.profiles (user_id, first_name, last_name, avatar_url)
  values (new.id, coalesce(v_first, 'Someone'), v_last, v_meta ->> 'avatar_url');
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- admin.delete_user (20261014120000_delete_account.sql): the audit row's display_name is the
-- full name.
-- ---------------------------------------------------------------------------

create or replace function admin.delete_user(p_user_id uuid, p_note text default null)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_email text;
  v_display_name text;
  v_details jsonb;
begin
  select u.email into v_email from auth.users u where u.id = p_user_id;
  if not found then
    raise exception 'user not found' using errcode = 'P0002';
  end if;
  select private.full_name(p.first_name, p.last_name) into v_display_name
  from public.profiles p where p.user_id = p_user_id;

  v_details := jsonb_build_object(
    'email', v_email,
    'display_name', v_display_name,
    'households', private.delete_user_core(p_user_id));
  insert into admin.admin_actions (action, target_user_id, details, note)
  values ('delete_user', p_user_id, v_details, p_note);

  return v_details;
end;
$$;

revoke all on function admin.delete_user(uuid, text) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Activity entries snapshot the member's full name (20261204120000_user_activity.sql).
-- ---------------------------------------------------------------------------

create or replace function public.remove_member(p_household_id uuid, p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_result jsonb;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.household_members hm
    where hm.household_id = p_household_id and hm.user_id = v_uid and hm.role = 'owner'
  ) then
    raise exception 'not an owner' using errcode = '42501';
  end if;

  if p_user_id = v_uid then
    raise exception 'cannot remove yourself; use leave_household' using errcode = '22023';
  end if;

  perform private.set_activity_action('member.removed', p_household_id, p_user_id::text, jsonb_build_object(
    'household', (select h.name from public.households h where h.id = p_household_id),
    'member', (select private.full_name(p.first_name, p.last_name) from public.profiles p where p.user_id = p_user_id),
    'member_id', p_user_id,
    'role', (select hm.role from public.household_members hm
             where hm.household_id = p_household_id and hm.user_id = p_user_id)));

  -- Raises 'not a member' if p_user_id isn't in it.
  v_result := private.leave_and_rehome(p_household_id, p_user_id);

  perform private.clear_activity_action();
  return v_result;
end;
$$;

create or replace function public.set_member_role(p_household_id uuid, p_user_id uuid, p_role text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_current text;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  -- Serialize role changes and leaving, so two owners demoting each other can't leave none.
  perform 1 from public.households h where h.id = p_household_id for update;

  if not exists (
    select 1 from public.household_members hm
    where hm.household_id = p_household_id and hm.user_id = v_uid and hm.role = 'owner'
  ) then
    raise exception 'not an owner' using errcode = '42501';
  end if;

  if p_role is null or p_role not in ('owner', 'member') then
    raise exception 'invalid role' using errcode = '22023';
  end if;

  select hm.role into v_current from public.household_members hm
  where hm.household_id = p_household_id and hm.user_id = p_user_id;
  if not found then
    raise exception 'not a member' using errcode = '42501';
  end if;

  if v_current = p_role then
    return;
  end if;

  if p_role = 'member' and not exists (
    select 1 from public.household_members hm
    where hm.household_id = p_household_id and hm.role = 'owner' and hm.user_id <> p_user_id
  ) then
    raise exception 'last owner' using errcode = 'P0001';
  end if;

  perform private.set_activity_action('member.role_changed', p_household_id, p_user_id::text, jsonb_build_object(
    'household', (select h.name from public.households h where h.id = p_household_id),
    'member', (select private.full_name(p.first_name, p.last_name) from public.profiles p where p.user_id = p_user_id),
    'member_id', p_user_id,
    'role', p_role));

  update public.household_members hm set role = p_role
  where hm.household_id = p_household_id and hm.user_id = p_user_id;

  perform private.clear_activity_action();
end;
$$;

-- ---------------------------------------------------------------------------
-- admin_list_households (20261202120000_admin_households.sql): a member's name matches on the
-- full name.
-- ---------------------------------------------------------------------------

create or replace function public.admin_list_households(
  p_search text default null,
  p_limit integer default 50,
  p_offset integer default 0
)
returns table (
  household_id uuid,
  name text,
  created_at timestamptz,
  member_count integer,
  plan_id text,
  plan_name text,
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
begin
  perform private.require_admin();

  if v_search ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    v_id := v_search::uuid;
  end if;

  return query
  select h.id, h.name, h.created_at,
         (select count(*) from public.household_members m where m.household_id = h.id)::integer,
         hp.plan_id, p.name,
         count(*) over ()
  from public.households h
  left join public.household_plans hp on hp.household_id = h.id
  left join public.plans p on p.id = hp.plan_id
  where v_search is null
     or (v_id is not null and h.id = v_id)
     or (v_id is null and (
           strpos(lower(h.name), lower(v_search)) > 0
           or exists (
             select 1
             from public.household_members m
             join auth.users u on u.id = m.user_id
             left join public.profiles pr on pr.user_id = m.user_id
             where m.household_id = h.id
               and (strpos(lower(u.email), lower(v_search)) > 0
                    or strpos(lower(private.full_name(pr.first_name, pr.last_name)), lower(v_search)) > 0))))
  order by h.created_at desc, h.id
  limit least(greatest(coalesce(p_limit, 50), 0), 200)
  offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

-- ---------------------------------------------------------------------------
-- admin_household_detail (20261202120000_admin_households.sql): each member's display_name is
-- the full name.
-- ---------------------------------------------------------------------------

create or replace function public.admin_household_detail(p_household_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_household public.households;
  v_ends_at timestamptz;
  v_resets_at timestamptz := (date_trunc('month', now() at time zone 'utc') + interval '1 month') at time zone 'utc';
begin
  perform private.require_admin();

  select * into v_household from public.households h where h.id = p_household_id;
  if not found then
    raise exception 'household not found' using errcode = 'P0002';
  end if;
  v_ends_at := private.first_month_ends_at(p_household_id);

  return jsonb_build_object(
    'household_id', v_household.id,
    'name', v_household.name,
    'created_at', v_household.created_at,
    'first_month', jsonb_build_object(
      'doubled', coalesce(now() < v_ends_at, false),
      'ends_at', v_ends_at
    ),
    'members', coalesce((
      select jsonb_agg(jsonb_build_object(
        'user_id', m.user_id,
        'email', u.email,
        'display_name', private.full_name(pr.first_name, pr.last_name),
        'role', m.role,
        'joined_at', m.joined_at
      ) order by m.joined_at, m.user_id)
      from public.household_members m
      join auth.users u on u.id = m.user_id
      left join public.profiles pr on pr.user_id = m.user_id
      where m.household_id = p_household_id
    ), '[]'),
    'plan', (
      select jsonb_build_object('id', p.id, 'name', p.name, 'assigned_at', hp.assigned_at)
      from public.household_plans hp
      join public.plans p on p.id = hp.plan_id
      where hp.household_id = p_household_id
    ),
    'usage', (
      select jsonb_agg(jsonb_build_object(
        'feature', f.feature,
        'in_plan', private.household_has_feature(p_household_id, f.feature),
        'used', private.monthly_usage(p_household_id, f.feature),
        'limit', private.monthly_limit(f.feature, p_household_id),
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
      where a.action = 'set_household_plan' and a.target_household_id = p_household_id
    ), '[]')
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- admin_list_users (20261202120000_admin_households.sql): display_name is the full name, and
-- the search matches it.
-- ---------------------------------------------------------------------------

create or replace function public.admin_list_users(
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
begin
  perform private.require_admin();

  if v_search ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    v_id := v_search::uuid;
  end if;

  return query
  select u.id, u.email::text, private.full_name(pr.first_name, pr.last_name), u.created_at, u.last_sign_in_at,
         b.user_id is not null,
         count(*) over ()
  from auth.users u
  left join public.profiles pr on pr.user_id = u.id
  left join private.ai_photo_blocks b on b.user_id = u.id
  where (v_search is null
         or (v_id is not null and u.id = v_id)
         or (v_id is null and (strpos(lower(u.email), lower(v_search)) > 0
                               or strpos(lower(private.full_name(pr.first_name, pr.last_name)), lower(v_search)) > 0)))
    and (p_blocked is null or (b.user_id is not null) = p_blocked)
  order by u.created_at desc nulls last, u.id
  limit least(greatest(coalesce(p_limit, 50), 0), 200)
  offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

-- ---------------------------------------------------------------------------
-- admin_user_detail (20261205120000_admin_user_activity.sql): display_name is the full name.
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
begin
  perform private.require_admin();

  select * into v_user from auth.users u where u.id = p_user_id;
  if not found then
    raise exception 'user not found' using errcode = 'P0002';
  end if;
  select private.full_name(p.first_name, p.last_name) into v_display_name
  from public.profiles p where p.user_id = p_user_id;

  return jsonb_build_object(
    'user_id', v_user.id,
    'email', v_user.email,
    'display_name', v_display_name,
    'created_at', v_user.created_at,
    'last_sign_in_at', v_user.last_sign_in_at,
    'last_active_at', greatest(
      (select max(a.created_at) from private.user_activity a where a.user_id = p_user_id),
      (select max(c.created_at) from public.ai_calls c where c.user_id = p_user_id)
    ),
    'households', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', h.id,
        'name', h.name,
        'role', hm.role,
        'member_count', (select count(*) from public.household_members m where m.household_id = h.id),
        'plan_id', hp.plan_id,
        'plan_name', p.name
      ) order by hm.position, h.id)
      from public.household_members hm
      join public.households h on h.id = hm.household_id
      left join public.household_plans hp on hp.household_id = h.id
      left join public.plans p on p.id = hp.plan_id
      where hm.user_id = p_user_id
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
-- The column. Its update grant goes with it; first_name, last_name and avatar_url stay updatable.
-- ---------------------------------------------------------------------------

revoke update (display_name) on public.profiles from authenticated;
alter table public.profiles drop column display_name;
