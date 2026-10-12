-- Leaving a household and removing a member (spec 4.7, 5). Both run the shared leaving rules,
-- private.remove_member_from_household (20261012120000_admin.sql), and give a user left with no
-- household a new personal household, so everyone always has one.

-- ---------------------------------------------------------------------------
-- A personal household made on the server, the same as the one the app makes at sign-up
-- (ensureStarterData in src/features/lists/lists.ts): "Personal" with the user as owner, after
-- their other households, a "Groceries" list, and that list as their default. Returns its id.
-- ---------------------------------------------------------------------------

create function private.create_personal_household(p_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_household_id uuid := gen_random_uuid();
  v_list_id uuid := gen_random_uuid();
begin
  insert into public.households (id, name, created_by)
  values (v_household_id, 'Personal', p_user_id);

  insert into public.household_members (household_id, user_id, role, position)
  select v_household_id, p_user_id, 'owner', coalesce(max(hm.position), 0) + 1
  from public.household_members hm
  where hm.user_id = p_user_id;

  insert into public.lists (id, household_id, name, position)
  values (v_list_id, v_household_id, 'Groceries', 1);

  insert into public.user_settings (user_id, default_list_id)
  values (p_user_id, v_list_id)
  on conflict (user_id) do update set default_list_id = excluded.default_list_id;

  return v_household_id;
end;
$$;

revoke all on function private.create_personal_household(uuid)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Takes p_user_id out of p_household_id: clears their default list if it's in that household,
-- runs the leaving rules, and makes them a personal household if that was their only one.
-- Returns { outcome: 'left' | 'promoted' | 'deleted', new_household_id: uuid or null }.
-- Shared by leave_household and remove_member, which check who may do it.
-- ---------------------------------------------------------------------------

create function private.leave_and_rehome(p_household_id uuid, p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_outcome text;
  v_new_household_id uuid;
begin
  update public.user_settings us set default_list_id = null
  where us.user_id = p_user_id
    and us.default_list_id in (select l.id from public.lists l where l.household_id = p_household_id);

  v_outcome := private.remove_member_from_household(p_household_id, p_user_id);

  if not exists (select 1 from public.household_members hm where hm.user_id = p_user_id) then
    v_new_household_id := private.create_personal_household(p_user_id);
  end if;

  return jsonb_build_object('outcome', v_outcome, 'new_household_id', v_new_household_id);
end;
$$;

revoke all on function private.leave_and_rehome(uuid, uuid)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- The caller leaves a household. Any member can.
-- ---------------------------------------------------------------------------

create function public.leave_household(p_household_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  -- Raises 'not a member' (and rolls everything back) if the caller isn't in it.
  return private.leave_and_rehome(p_household_id, v_uid);
end;
$$;

revoke all on function public.leave_household(uuid) from public, anon, service_role;
grant execute on function public.leave_household(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- An owner removes another member. Owners can't remove themselves here; they leave.
-- ---------------------------------------------------------------------------

create function public.remove_member(p_household_id uuid, p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
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

  -- Raises 'not a member' if p_user_id isn't in it.
  return private.leave_and_rehome(p_household_id, p_user_id);
end;
$$;

revoke all on function public.remove_member(uuid, uuid) from public, anon, service_role;
grant execute on function public.remove_member(uuid, uuid) to authenticated;
