-- Renaming a household (spec 4.7, 5). Owners only. The households_set_updated_at trigger bumps
-- updated_at, so pulls and realtime carry the new name to the other members' devices.

create function public.rename_household(p_household_id uuid, p_name text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_name text := trim(p_name);
  v_role text;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  select hm.role into v_role
  from public.household_members hm
  where hm.household_id = p_household_id and hm.user_id = v_uid;

  if v_role is null then
    raise exception 'not a member' using errcode = '42501';
  end if;
  if v_role <> 'owner' then
    raise exception 'not an owner' using errcode = '42501';
  end if;

  if v_name is null or v_name = '' then
    raise exception 'household name cannot be blank' using errcode = '22023';
  end if;
  if char_length(v_name) > 50 then
    raise exception 'household name is too long' using errcode = '22023';
  end if;

  -- The same name is a no-op, so it doesn't bump updated_at or send a realtime change.
  update public.households h set name = v_name
  where h.id = p_household_id and h.name is distinct from v_name;
end;
$$;

revoke all on function public.rename_household(uuid, text) from public, anon, service_role;
grant execute on function public.rename_household(uuid, text) to authenticated;
