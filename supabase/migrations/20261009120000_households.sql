-- Households and their members (spec 4.7, 5). Read-only slice for the Households screen:
-- members can read their households and member lists; all changes go through security
-- definer functions (create_household and, in M7, the rest). household_invites comes with M7.

create table public.households (
  id         uuid primary key,
  name       text not null,
  created_by uuid references auth.users on delete set null, -- informational only; roles live in household_members
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger households_set_updated_at
  before update on public.households
  for each row execute function private.set_updated_at();

-- A user can be in many households (Q6). "At least one owner" and "at least one household
-- per user" are enforced by the household functions.
create table public.household_members (
  household_id uuid references public.households on delete cascade,
  user_id      uuid references auth.users on delete cascade,
  role         text not null default 'member' check (role in ('owner', 'member')),
  joined_at    timestamptz not null default now(), -- used for owner promotion
  position     double precision not null,          -- this user's household order (per user)
  primary key (household_id, user_id)
);
create index household_members_user_id_idx on public.household_members (user_id);

-- The caller's household ids. Security definer so policies on household_members can use it
-- without recursing into their own RLS. Wrap calls in `select` so Postgres evaluates it once.
create function private.my_household_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select household_id from public.household_members where user_id = (select auth.uid());
$$;

-- Policies run as the caller, so authenticated needs to reach this one function.
-- `private` isn't exposed through the API, so usage on the schema exposes nothing else.
grant usage on schema private to authenticated;
revoke all on function private.my_household_ids() from public, anon;
grant execute on function private.my_household_ids() to authenticated;

alter table public.households enable row level security;
alter table public.household_members enable row level security;

revoke all on table public.households from anon, authenticated;
revoke all on table public.household_members from anon, authenticated;
grant select on public.households to authenticated;
grant select on public.household_members to authenticated;

create policy households_select_member on public.households
  for select to authenticated
  using (id in (select private.my_household_ids()));

create policy household_members_select_member on public.household_members
  for select to authenticated
  using (household_id in (select private.my_household_ids()));

-- Profiles: also readable by people who share a household with the user (names on the
-- Households screen, "Alex added...").
drop policy profiles_select_own on public.profiles;

create policy profiles_select_own_or_household on public.profiles
  for select to authenticated
  using (
    user_id = (select auth.uid())
    or user_id in (
      select hm.user_id from public.household_members hm
      where hm.household_id in (select private.my_household_ids())
    )
  );
