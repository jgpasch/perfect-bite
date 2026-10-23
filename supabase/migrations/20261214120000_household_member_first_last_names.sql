-- Members' first and last names (spec 4.7, 5): get_household_members returns first_name and
-- last_name instead of display_name, so the app builds short and full names itself. Its return type
-- changes, so it's dropped and created again.

drop function public.get_household_members(uuid);

-- A household's members with their profiles, owners first, then by first name, last name (none
-- first, as "Bea" sorts before "Bea Adams"), user id.
-- Raises for non-members rather than returning nothing, so a stale id is an error.
create function public.get_household_members(p_household_id uuid)
returns table (
  user_id    uuid,
  first_name text,
  last_name  text,
  avatar_url text,
  role       text,
  joined_at  timestamptz
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
    select hm.user_id, p.first_name, p.last_name, p.avatar_url, hm.role, hm.joined_at
    from public.household_members hm
    join public.profiles p on p.user_id = hm.user_id
    where hm.household_id = p_household_id
    order by hm.role = 'owner' desc, p.first_name, p.last_name nulls first, hm.user_id;
end;
$$;

revoke all on function public.get_household_members(uuid) from public, anon, service_role;
grant execute on function public.get_household_members(uuid) to authenticated;
