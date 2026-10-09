-- Registering a household and reading its members (spec 4.7, 5). Households are created on
-- the device (local-first), so the client picks the id and this function registers it.

-- Creates the household with the caller as its owner. Idempotent for its members, so a
-- device can retry after a lost response. An id that exists and isn't the caller's raises,
-- so nobody can join a household by guessing its id.
create function public.create_household(p_id uuid, p_name text)
returns void
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
  if p_id is null then
    raise exception 'household id is required' using errcode = '22023';
  end if;
  if p_name is null or trim(p_name) = '' then
    raise exception 'household name cannot be blank' using errcode = '22023';
  end if;

  insert into public.households (id, name, created_by)
  values (p_id, p_name, v_uid)
  on conflict (id) do nothing;

  if not found then
    if exists (
      select 1 from public.household_members hm
      where hm.household_id = p_id and hm.user_id = v_uid
    ) then
      return;
    end if;
    raise exception 'household % already exists', p_id using errcode = '42501';
  end if;

  insert into public.household_members (household_id, user_id, role, position)
  select p_id, v_uid, 'owner', coalesce(max(hm.position), 0) + 1
  from public.household_members hm
  where hm.user_id = v_uid;
end;
$$;

revoke all on function public.create_household(uuid, text) from public, anon, service_role;
grant execute on function public.create_household(uuid, text) to authenticated;

-- A household's members with their profiles, owners first, then by display name.
-- Raises for non-members rather than returning nothing, so a stale id is an error.
create function public.get_household_members(p_household_id uuid)
returns table (
  user_id      uuid,
  display_name text,
  avatar_url   text,
  role         text,
  joined_at    timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.household_members hm
    where hm.household_id = p_household_id and hm.user_id = (select auth.uid())
  ) then
    raise exception 'not a member of household %', p_household_id using errcode = '42501';
  end if;

  return query
    select hm.user_id, p.display_name, p.avatar_url, hm.role, hm.joined_at
    from public.household_members hm
    join public.profiles p on p.user_id = hm.user_id
    where hm.household_id = p_household_id
    order by hm.role = 'owner' desc, p.display_name, hm.user_id;
end;
$$;

revoke all on function public.get_household_members(uuid) from public, anon, service_role;
grant execute on function public.get_household_members(uuid) to authenticated;
