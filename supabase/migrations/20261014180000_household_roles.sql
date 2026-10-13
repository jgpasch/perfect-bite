-- Owner actions on the household screen (spec 4.7, 5): changing a member's role and deleting a
-- household. Like leaving and removal, both lock the household row first, so concurrent calls on
-- the same household run one after the other.

-- ---------------------------------------------------------------------------
-- An owner makes a member an owner, or steps an owner (themselves included) back to member.
-- The household always keeps at least one owner. Setting the role someone already has is a no-op.
-- ---------------------------------------------------------------------------

create function public.set_member_role(p_household_id uuid, p_user_id uuid, p_role text)
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

  update public.household_members hm set role = p_role
  where hm.household_id = p_household_id and hm.user_id = p_user_id;
end;
$$;

revoke all on function public.set_member_role(uuid, uuid, text) from public, anon, service_role;
grant execute on function public.set_member_role(uuid, uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- An owner deletes a household for every member. Its lists, items, recipes, overrides, custom
-- aisles and invites cascade with it, and so do the memberships, whose delete events tell each
-- member's devices to pull and purge it (7.2). Members' default lists in it are cleared, and a
-- member left with no household gets a new personal one. Returns { new_household_id } for the
-- caller (null when they still have another household).
-- ---------------------------------------------------------------------------

create function public.delete_household(p_household_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_members uuid[];
  v_member uuid;
  v_new_household_id uuid;
  v_caller_household_id uuid;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  perform 1 from public.households h where h.id = p_household_id for update;

  if not exists (
    select 1 from public.household_members hm
    where hm.household_id = p_household_id and hm.user_id = v_uid and hm.role = 'owner'
  ) then
    raise exception 'not an owner' using errcode = '42501';
  end if;

  select array_agg(hm.user_id order by hm.joined_at, hm.user_id) into v_members
  from public.household_members hm
  where hm.household_id = p_household_id;

  update public.user_settings us set default_list_id = null
  where us.user_id = any (v_members)
    and us.default_list_id in (select l.id from public.lists l where l.household_id = p_household_id);

  delete from public.households h where h.id = p_household_id;

  foreach v_member in array v_members loop
    if not exists (select 1 from public.household_members hm where hm.user_id = v_member) then
      v_new_household_id := private.create_personal_household(v_member);
      if v_member = v_uid then
        v_caller_household_id := v_new_household_id;
      end if;
    end if;
  end loop;

  return jsonb_build_object('new_household_id', v_caller_household_id);
end;
$$;

revoke all on function public.delete_household(uuid) from public, anon, service_role;
grant execute on function public.delete_household(uuid) to authenticated;
