-- Self-service account deletion (spec 4.8, 5). The deleting rules that admin.delete_user used
-- (20261012120000_admin.sql) move into private.delete_user_core, shared by admin.delete_user (for
-- support requests, from the dashboard) and public.delete_account (the app's Settings).

-- ---------------------------------------------------------------------------
-- Leaves each of p_user_id's households by the leaving rules (in their household order), then
-- deletes the auth user, which cascades their memberships, profile, aisle order and settings.
-- Returns the households array: [{ id, name, outcome, promoted_user_id? }]. Callers check the
-- user exists and write the audit row.
-- ---------------------------------------------------------------------------

create function private.delete_user_core(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_household record;
  v_outcome text;
  v_entry jsonb;
  v_households jsonb := '[]';
begin
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

  return v_households;
end;
$$;

revoke all on function private.delete_user_core(uuid)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- admin.delete_user (spec 4.12): same signature, error and audit row as before; the work is
-- now in the core.
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
  select p.display_name into v_display_name from public.profiles p where p.user_id = p_user_id;

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
-- The caller deletes their own account (spec 4.8). No argument: it only ever acts on
-- auth.uid(). The audit row keeps the user id and each household's outcome but no email,
-- display name or household name: the user asked to be forgotten.
-- Returns { households: [{ id, outcome }] }.
-- ---------------------------------------------------------------------------

create function public.delete_account()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_households jsonb;
  v_audit jsonb;
  v_result jsonb;
begin
  if v_user_id is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;

  -- Already deleted (a retry after a lost response): nothing to do, nothing to audit.
  if not exists (select 1 from auth.users u where u.id = v_user_id) then
    return jsonb_build_object('households', '[]'::jsonb);
  end if;

  v_households := private.delete_user_core(v_user_id);

  select
    coalesce(jsonb_agg(e - 'name' order by o), '[]'),
    coalesce(jsonb_agg(jsonb_build_object('id', e -> 'id', 'outcome', e -> 'outcome') order by o), '[]')
  into v_audit, v_result
  from jsonb_array_elements(v_households) with ordinality as t(e, o);

  insert into admin.admin_actions (action, target_user_id, details)
  values ('delete_account', v_user_id, jsonb_build_object('households', v_audit));

  return jsonb_build_object('households', v_result);
end;
$$;

revoke all on function public.delete_account() from public, anon, service_role;
grant execute on function public.delete_account() to authenticated;
