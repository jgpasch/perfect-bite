-- Admin (spec 4.12, 5): the app is run from the Supabase dashboard, which connects as `postgres`
-- and doesn't know the app's rules. A change that has rules (deleting a user) goes through a
-- function in the `admin` schema, run as a SQL snippet (docs/admin.md). `admin` isn't exposed by
-- the API (supabase/config.toml) and nobody but `postgres` can use it. Each admin function writes
-- one `admin.admin_actions` row in the same transaction.
--
-- Also the shared leaving rules (spec 4.7), used by `admin.delete_user` and by
-- `leave_household` / `remove_member`.

create schema admin;
revoke all on schema admin from public, anon, authenticated, service_role;

-- New functions are executable by PUBLIC by default. A per-schema default can only add to the
-- global default, not take away from it, so every admin function also revokes execute itself.
alter default privileges for role postgres in schema admin
  revoke execute on functions from public, anon, authenticated, service_role;

-- No foreign keys, so a row outlives the user or household it describes.
create table admin.admin_actions (
  id                  uuid primary key default gen_random_uuid(),
  action              text not null,               -- e.g. 'delete_user'
  target_user_id      uuid,
  target_household_id uuid,
  details             jsonb not null default '{}',
  note                text,                        -- why; performed_by is always postgres from the dashboard
  performed_by        text not null default session_user,
  created_at          timestamptz not null default now()
);
create index admin_actions_created_at_idx on admin.admin_actions (created_at desc);

revoke all on table admin.admin_actions from public, anon, authenticated, service_role;
alter table admin.admin_actions enable row level security;

-- ---------------------------------------------------------------------------
-- Leaving rules (spec 4.7) for one membership. Removes p_user_id from p_household_id and
-- returns what happened to the household:
--   'deleted'  they were the last member: the household and all its data are deleted
--   'promoted' they were the last owner: the member who joined earliest becomes an owner
--   'left'     otherwise
-- Doesn't create a personal household for someone left with none; callers decide.
-- ---------------------------------------------------------------------------

create function private.remove_member_from_household(p_household_id uuid, p_user_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text;
begin
  -- Serialize changes to this household's membership, so two leaving at once can't both
  -- think the other is still there.
  perform 1 from public.households h where h.id = p_household_id for update;

  delete from public.household_members hm
  where hm.household_id = p_household_id and hm.user_id = p_user_id
  returning hm.role into v_role;

  if not found then
    raise exception 'not a member' using errcode = '42501';
  end if;

  if not exists (select 1 from public.household_members hm where hm.household_id = p_household_id) then
    delete from public.households h where h.id = p_household_id;
    return 'deleted';
  end if;

  if v_role = 'owner' and not exists (
    select 1 from public.household_members hm
    where hm.household_id = p_household_id and hm.role = 'owner'
  ) then
    update public.household_members hm set role = 'owner'
    where hm.household_id = p_household_id
      and hm.user_id = (
        select e.user_id from public.household_members e
        where e.household_id = p_household_id
        order by e.joined_at, e.user_id
        limit 1
      );
    return 'promoted';
  end if;

  return 'left';
end;
$$;

revoke all on function private.remove_member_from_household(uuid, uuid)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- admin.delete_user (spec 4.8, 4.12): leaves each of the user's households by the rules above,
-- then deletes the auth user, which cascades their memberships, profile, aisle order and
-- settings. Rows they added, checked or created elsewhere keep existing with that reference
-- set to null. Writes one audit row with the email, display name and each household's outcome.
-- ---------------------------------------------------------------------------

create function admin.delete_user(p_user_id uuid, p_note text default null)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_email text;
  v_display_name text;
  v_household record;
  v_outcome text;
  v_entry jsonb;
  v_households jsonb := '[]';
  v_details jsonb;
begin
  select u.email into v_email from auth.users u where u.id = p_user_id;
  if not found then
    raise exception 'user not found' using errcode = 'P0002';
  end if;
  select p.display_name into v_display_name from public.profiles p where p.user_id = p_user_id;

  for v_household in
    select h.id, h.name
    from public.household_members hm
    join public.households h on h.id = hm.household_id
    where hm.user_id = p_user_id
    order by hm.position, h.id
  loop
    v_outcome := private.remove_member_from_household(v_household.id, p_user_id);
    v_entry := jsonb_build_object('id', v_household.id, 'name', v_household.name, 'outcome', v_outcome);
    if v_outcome = 'promoted' then
      v_entry := v_entry || jsonb_build_object('promoted_user_id', (
        select hm.user_id from public.household_members hm
        where hm.household_id = v_household.id and hm.role = 'owner'
      ));
    end if;
    v_households := v_households || jsonb_build_array(v_entry);
  end loop;

  delete from auth.users u where u.id = p_user_id;

  v_details := jsonb_build_object('email', v_email, 'display_name', v_display_name, 'households', v_households);
  insert into admin.admin_actions (action, target_user_id, details, note)
  values ('delete_user', p_user_id, v_details, p_note);

  return v_details;
end;
$$;

revoke all on function admin.delete_user(uuid, text) from public, anon, authenticated, service_role;
