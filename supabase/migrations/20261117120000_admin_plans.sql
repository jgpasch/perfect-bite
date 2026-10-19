-- Portal functions for plans (spec 4.12, 5): listing plans and editing what each includes, its
-- monthly limits, its name and which one is the default; creating and deleting plans. Like the user
-- functions, each is `public` and `security definer`, starts with private.require_admin(), is
-- executable by `authenticated` only, raises and changes nothing on any error, and writes one
-- admin.admin_actions row with the admin's id in performed_by, the plan in target_plan_id and a
-- required note.
--
-- The rule that a plan with recipe import also has categorize (both imports categorize in the same
-- request, unchecked) was a pgTAP check over the seeded plans. It's now a constraint trigger on
-- plan_features, so it holds for the portal, the Table Editor and SQL alike. Deferred, so a plan
-- can gain both in one transaction in either order.

create function private.check_import_needs_categorize()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_plan_id text;
begin
  -- Check the plan as it is now (at commit, or at `set constraints ... immediate`), not the row:
  -- a later statement in the transaction may have fixed it.
  foreach v_plan_id in array array[
    case when tg_op <> 'INSERT' then old.plan_id end,
    case when tg_op <> 'DELETE' then new.plan_id end
  ] loop
    if v_plan_id is not null
       and exists (select 1 from public.plan_features f
                   where f.plan_id = v_plan_id and f.feature in ('recipe_import', 'recipe_import_photo'))
       and not exists (select 1 from public.plan_features f
                       where f.plan_id = v_plan_id and f.feature = 'categorize') then
      raise exception 'recipe import needs categorize' using errcode = '23514',
        detail = format('Plan %s has recipe import but not categorize.', v_plan_id);
    end if;
  end loop;
  return null;
end;
$$;

revoke all on function private.check_import_needs_categorize() from public, anon, authenticated, service_role;

create constraint trigger plan_features_import_needs_categorize
  after insert or update or delete on public.plan_features
  deferrable initially deferred
  for each row execute function private.check_import_needs_categorize();

-- ---------------------------------------------------------------------------
-- Helpers (no client access).
-- ---------------------------------------------------------------------------

-- How many users a plan applies to: those assigned it, plus, for the default plan, everyone with
-- no user_plans row.
create function private.plan_user_count(p_plan_id text)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select (select count(*) from public.user_plans up where up.plan_id = p_plan_id)::integer
    + case when exists (select 1 from public.plans p where p.id = p_plan_id and p.is_default)
        then (select count(*) from auth.users u
              where not exists (select 1 from public.user_plans up where up.user_id = u.id))::integer
        else 0 end;
$$;

revoke all on function private.plan_user_count(text) from public, anon, authenticated, service_role;

-- A plan as the portal shows it, or null for an unknown id: id, name, is_default, users, and
-- features in the fixed order (private.feature_keys), each with its monthly_limit (null for none).
create function private.plan_snapshot(p_plan_id text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', p.id,
    'name', p.name,
    'is_default', p.is_default,
    'users', private.plan_user_count(p.id),
    'features', coalesce((
      select jsonb_agg(jsonb_build_object('feature', k.feature, 'monthly_limit', l.monthly_limit) order by k.ord)
      from unnest(private.feature_keys()) with ordinality as k (feature, ord)
      join public.plan_features f on f.plan_id = p.id and f.feature = k.feature
      left join public.plan_limits l on l.plan_id = p.id and l.feature = k.feature
    ), '[]')
  )
  from public.plans p
  where p.id = p_plan_id;
$$;

revoke all on function private.plan_snapshot(text) from public, anon, authenticated, service_role;

-- Raises `note required` (22023) for a null or blank note.
create function private.require_note(p_note text)
returns void
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_note is null or btrim(p_note) = '' then
    raise exception 'note required' using errcode = '22023';
  end if;
end;
$$;

revoke all on function private.require_note(text) from public, anon, authenticated, service_role;

-- Locks the plan's row, raising `plan not found` (P0002) for an unknown id.
create function private.lock_plan(p_plan_id text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform 1 from public.plans p where p.id = p_plan_id for update;
  if not found then
    raise exception 'plan not found' using errcode = 'P0002';
  end if;
end;
$$;

revoke all on function private.lock_plan(text) from public, anon, authenticated, service_role;

-- Writes a plan change's audit row and returns its details: { before, after, users }, before and
-- after being plan_snapshot (null for a plan that didn't or no longer exists) and users the number
-- of users the plan applies to (before a delete, after anything else), merged with p_extra. Checks
-- the import rule first, so a function that broke it raises here, before it returns, rather than
-- at commit.
create function private.log_plan_action(p_action text, p_plan_id text, p_before jsonb, p_note text, p_extra jsonb default '{}')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_after jsonb;
  v_details jsonb;
begin
  set constraints public.plan_features_import_needs_categorize immediate;
  set constraints public.plan_features_import_needs_categorize deferred;

  v_after := private.plan_snapshot(p_plan_id);
  v_details := jsonb_build_object(
    'before', p_before,
    'after', v_after,
    'users', coalesce((v_after ->> 'users')::integer, (p_before ->> 'users')::integer, 0)
  ) || p_extra;
  insert into admin.admin_actions (action, target_plan_id, details, note, performed_by)
  values (p_action, p_plan_id, v_details, p_note, auth.uid()::text);
  return v_details;
end;
$$;

revoke all on function private.log_plan_action(text, text, jsonb, text, jsonb) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- admin_list_plans: every plan as private.plan_snapshot gives it, by id.
-- ---------------------------------------------------------------------------

create function public.admin_list_plans()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_admin();
  return coalesce(
    (select jsonb_agg(private.plan_snapshot(p.id) order by p.id collate "C") from public.plans p),
    '[]');
end;
$$;

-- ---------------------------------------------------------------------------
-- admin_create_plan: a new plan, not the default, with p_copy_from's plan_features and plan_limits
-- when given (else no features). The id is lowercase letters, digits and underscores, starting
-- with a letter, 2 to 31 long, and unused. Raises `invalid plan id` or `name required` (22023),
-- `plan exists` (23505), `plan not found` (P0002, the source) or `note required` (22023). p_note
-- has a default only because it follows p_copy_from; it's still required.
-- ---------------------------------------------------------------------------

create function public.admin_create_plan(p_id text, p_name text, p_copy_from text default null, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_admin();

  if p_id is null or p_id !~ '^[a-z][a-z0-9_]{1,30}$' then
    raise exception 'invalid plan id' using errcode = '22023';
  end if;
  if p_name is null or btrim(p_name) = '' then
    raise exception 'name required' using errcode = '22023';
  end if;
  if exists (select 1 from public.plans p where p.id = p_id) then
    raise exception 'plan exists' using errcode = '23505';
  end if;
  if p_copy_from is not null then
    perform private.lock_plan(p_copy_from);
  end if;
  perform private.require_note(p_note);

  insert into public.plans (id, name, is_default) values (p_id, btrim(p_name), false);
  insert into public.plan_features (plan_id, feature)
  select p_id, f.feature from public.plan_features f where f.plan_id = p_copy_from;
  insert into public.plan_limits (plan_id, feature, monthly_limit)
  select p_id, l.feature, l.monthly_limit from public.plan_limits l where l.plan_id = p_copy_from;

  return private.log_plan_action('create_plan', p_id, null, p_note);
end;
$$;

-- ---------------------------------------------------------------------------
-- admin_rename_plan: changes a plan's name (not its id). Raises `plan not found` (P0002),
-- `name required` or `note required` (22023).
-- ---------------------------------------------------------------------------

create function public.admin_rename_plan(p_id text, p_name text, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_before jsonb;
begin
  perform private.require_admin();

  perform private.lock_plan(p_id);
  if p_name is null or btrim(p_name) = '' then
    raise exception 'name required' using errcode = '22023';
  end if;
  perform private.require_note(p_note);

  v_before := private.plan_snapshot(p_id);
  update public.plans p set name = btrim(p_name) where p.id = p_id;

  return private.log_plan_action('rename_plan', p_id, v_before, p_note);
end;
$$;

-- ---------------------------------------------------------------------------
-- admin_set_default_plan: makes p_id the default plan, so every user with no user_plans row moves
-- to it. Clears the old default first, for the partial unique index. details also has
-- previous_default (the old default's id, or null). Raises `plan not found` (P0002) or `note
-- required` (22023).
-- ---------------------------------------------------------------------------

create function public.admin_set_default_plan(p_id text, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_before jsonb;
  v_previous text;
begin
  perform private.require_admin();

  perform private.lock_plan(p_id);
  perform private.require_note(p_note);

  -- Lock every plan row, so two changes of default can't interleave.
  perform 1 from public.plans p for update;
  select p.id into v_previous from public.plans p where p.is_default;
  v_before := private.plan_snapshot(p_id);

  update public.plans p set is_default = false where p.is_default and p.id <> p_id;
  update public.plans p set is_default = true where p.id = p_id;

  return private.log_plan_action('set_default_plan', p_id, v_before, p_note,
    jsonb_build_object('previous_default', v_previous));
end;
$$;

-- ---------------------------------------------------------------------------
-- admin_set_plan_feature: p_enabled adds the feature to the plan with an explicit plan_limits row
-- holding p_monthly_limit (null for no limit; replaces the row if the plan already has the
-- feature); not p_enabled removes both. Raises `plan not found` (P0002), `note required` (22023),
-- `recipe import needs categorize` (23514, the trigger: add categorize before an import, remove it
-- after them), or the tables' checks (23514) for an unknown feature or a negative limit.
-- ---------------------------------------------------------------------------

create function public.admin_set_plan_feature(
  p_plan_id text,
  p_feature text,
  p_enabled boolean,
  p_monthly_limit integer default null,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_before jsonb;
begin
  perform private.require_admin();

  perform private.lock_plan(p_plan_id);
  if p_enabled is null then
    raise exception 'enabled required' using errcode = '22023';
  end if;
  perform private.require_note(p_note);

  v_before := private.plan_snapshot(p_plan_id);

  if p_enabled then
    insert into public.plan_features (plan_id, feature) values (p_plan_id, p_feature)
    on conflict (plan_id, feature) do nothing;
    insert into public.plan_limits as l (plan_id, feature, monthly_limit) values (p_plan_id, p_feature, p_monthly_limit)
    on conflict (plan_id, feature) do update set monthly_limit = excluded.monthly_limit;
  else
    delete from public.plan_limits l where l.plan_id = p_plan_id and l.feature = p_feature;
    delete from public.plan_features f where f.plan_id = p_plan_id and f.feature = p_feature;
  end if;

  return private.log_plan_action('set_plan_feature', p_plan_id, v_before, p_note);
end;
$$;

-- ---------------------------------------------------------------------------
-- admin_set_plan_limit: sets the monthly limit of a feature the plan has (null for no limit),
-- upserting its plan_limits row. Takes effect on the next call. Raises `plan not found` or
-- `feature not in plan` (P0002), `note required` (22023) or, for a negative limit, the table's
-- check (23514).
-- ---------------------------------------------------------------------------

create function public.admin_set_plan_limit(p_plan_id text, p_feature text, p_monthly_limit integer, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_before jsonb;
begin
  perform private.require_admin();

  perform private.lock_plan(p_plan_id);
  if not exists (select 1 from public.plan_features f where f.plan_id = p_plan_id and f.feature = p_feature) then
    raise exception 'feature not in plan' using errcode = 'P0002';
  end if;
  perform private.require_note(p_note);

  v_before := private.plan_snapshot(p_plan_id);
  insert into public.plan_limits as l (plan_id, feature, monthly_limit) values (p_plan_id, p_feature, p_monthly_limit)
  on conflict (plan_id, feature) do update set monthly_limit = excluded.monthly_limit;

  return private.log_plan_action('set_plan_limit', p_plan_id, v_before, p_note);
end;
$$;

-- ---------------------------------------------------------------------------
-- admin_delete_plan: deletes a plan no user is on, with its plan_features and plan_limits
-- (cascade). Refuses the default plan (`default plan`) and a plan with user_plans rows (`plan in
-- use`), both 23503; raises `plan not found` (P0002) or `note required` (22023). Its audit row
-- keeps the plan's last state in details.before.
-- ---------------------------------------------------------------------------

create function public.admin_delete_plan(p_id text, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_before jsonb;
begin
  perform private.require_admin();

  perform private.lock_plan(p_id);
  if exists (select 1 from public.plans p where p.id = p_id and p.is_default) then
    raise exception 'default plan' using errcode = '23503';
  end if;
  if exists (select 1 from public.user_plans up where up.plan_id = p_id) then
    raise exception 'plan in use' using errcode = '23503';
  end if;
  perform private.require_note(p_note);

  v_before := private.plan_snapshot(p_id);
  delete from public.plans p where p.id = p_id;

  return private.log_plan_action('delete_plan', p_id, v_before, p_note);
end;
$$;

revoke all on function public.admin_list_plans() from public, anon, service_role;
revoke all on function public.admin_create_plan(text, text, text, text) from public, anon, service_role;
revoke all on function public.admin_rename_plan(text, text, text) from public, anon, service_role;
revoke all on function public.admin_set_default_plan(text, text) from public, anon, service_role;
revoke all on function public.admin_set_plan_feature(text, text, boolean, integer, text) from public, anon, service_role;
revoke all on function public.admin_set_plan_limit(text, text, integer, text) from public, anon, service_role;
revoke all on function public.admin_delete_plan(text, text) from public, anon, service_role;
grant execute on function public.admin_list_plans() to authenticated;
grant execute on function public.admin_create_plan(text, text, text, text) to authenticated;
grant execute on function public.admin_rename_plan(text, text, text) to authenticated;
grant execute on function public.admin_set_default_plan(text, text) to authenticated;
grant execute on function public.admin_set_plan_feature(text, text, boolean, integer, text) to authenticated;
grant execute on function public.admin_set_plan_limit(text, text, integer, text) to authenticated;
grant execute on function public.admin_delete_plan(text, text) to authenticated;
