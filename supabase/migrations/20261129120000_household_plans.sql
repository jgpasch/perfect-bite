-- Plans per household (spec 4.12, 4.7, 5). A household's plan is its `household_plans` row and
-- nothing else: every household gets one here, and a new household gets the default plan's at
-- creation. "Default" only means the plan new households start on; changing it moves no one. A
-- household with no row has no features.
--
-- Two feature keys are left, the AI features that cost real money: `recipe_import` (link and photo
-- import alike; `recipe_import_photo` folds into it) and `recipe_photo_ai`. Categorize, Suggest tags
-- and step matching are for everyone, so `categorize`, `recipe_tags` and `step_ingredients` stop
-- being features, and the rule that an import needs categorize goes with them.
--
-- Plans are renamed so the names say what they are: plus becomes `founding` (the default), none
-- becomes `free`, basic is deleted (its households go to free); unlimited stays. The ids change
-- (text primary keys with no `on update cascade`), so the new plans are inserted, users move across
-- and the old plans are deleted, before any `household_plans` row is written, so no row ever names
-- an old id. Old audit rows keep the old ids as written (admin_actions.target_plan_id has no
-- foreign key).
--
-- Transition: `user_plans` is kept (on the new ids) until per-user plans are dropped, and so is
-- `my_features`, which answers old builds in the old keys. `has_feature` with a null household (an
-- old client) takes the best of the user's households. `private.monthly_limit(user, feature,
-- household)` stays as a wrapper for the check_*_limit functions until usage is counted per
-- household.

-- ---------------------------------------------------------------------------
-- The import rule goes: imports no longer need categorize, which everyone has.
-- ---------------------------------------------------------------------------

drop trigger plan_features_import_needs_categorize on public.plan_features;
drop function private.check_import_needs_categorize();

-- As before, without the import rule's `set constraints`.
create or replace function private.log_plan_action(p_action text, p_plan_id text, p_before jsonb, p_note text, p_extra jsonb default '{}')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_after jsonb;
  v_details jsonb;
begin
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

-- ---------------------------------------------------------------------------
-- Feature keys: recipe_import and recipe_photo_ai.
-- ---------------------------------------------------------------------------

-- A plan with photo import keeps (or gains) recipe_import, with photo import's limit when it had
-- no recipe_import limit of its own.
insert into public.plan_features (plan_id, feature)
select f.plan_id, 'recipe_import' from public.plan_features f where f.feature = 'recipe_import_photo'
on conflict (plan_id, feature) do nothing;
insert into public.plan_limits (plan_id, feature, monthly_limit)
select l.plan_id, 'recipe_import', l.monthly_limit from public.plan_limits l where l.feature = 'recipe_import_photo'
on conflict (plan_id, feature) do nothing;

delete from public.plan_limits where feature in ('categorize', 'step_ingredients', 'recipe_tags', 'recipe_import_photo');
delete from public.plan_features where feature in ('categorize', 'step_ingredients', 'recipe_tags', 'recipe_import_photo');

alter table public.plan_features drop constraint plan_features_feature_check;
alter table public.plan_features add constraint plan_features_feature_check
  check (feature in ('recipe_import', 'recipe_photo_ai'));
alter table public.plan_limits drop constraint plan_limits_feature_check;
alter table public.plan_limits add constraint plan_limits_feature_check
  check (feature in ('recipe_import', 'recipe_photo_ai'));

comment on table public.plan_limits is
  'How much of each feature a plan allows per calendar month (UTC). A null monthly_limit means no '
  'monthly limit, and so does a plan with the feature but no row for it: deleting a row lifts the '
  'limit. Both features count calls (recipe_import counts link and photo imports). A household '
  'in its first 30 days gets twice these (private.monthly_limit).';

-- The two keys in their fixed order (plan_limits' check), for the portal's lists.
create or replace function private.feature_keys()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array['recipe_import', 'recipe_photo_ai'];
$$;

-- ---------------------------------------------------------------------------
-- Plans: founding (the default) and free replace plus, none and basic.
-- ---------------------------------------------------------------------------

insert into public.plans (id, name, is_default) values
  ('founding', 'Founding', false),
  ('free', 'Free', false);
insert into public.plan_features (plan_id, feature) values
  ('founding', 'recipe_import'),
  ('founding', 'recipe_photo_ai');
insert into public.plan_limits (plan_id, feature, monthly_limit) values
  ('founding', 'recipe_import', 50),
  ('founding', 'recipe_photo_ai', 20);

-- Unlimited has both with no monthly limit (explicit null rows, so the Table Editor shows them).
insert into public.plan_features (plan_id, feature) values
  ('unlimited', 'recipe_import'),
  ('unlimited', 'recipe_photo_ai')
on conflict (plan_id, feature) do nothing;
insert into public.plan_limits as l (plan_id, feature, monthly_limit) values
  ('unlimited', 'recipe_import', null),
  ('unlimited', 'recipe_photo_ai', null)
on conflict (plan_id, feature) do update set monthly_limit = null;

-- Kept until per-user plans are dropped. Editing plan_id stamps assigned_at (the trigger).
update public.user_plans set plan_id = 'founding' where plan_id = 'plus';
update public.user_plans set plan_id = 'free' where plan_id in ('none', 'basic');

-- The partial unique index allows one default, so clear the old one first.
update public.plans set is_default = false where is_default;
update public.plans set is_default = true where id = 'founding';

delete from public.plans where id in ('plus', 'none', 'basic');

-- ---------------------------------------------------------------------------
-- household_plans: every household's plan.
-- ---------------------------------------------------------------------------

create table public.household_plans (
  household_id uuid primary key references public.households on delete cascade,
  plan_id      text not null references public.plans,
  assigned_at  timestamptz not null default now()
);
create index household_plans_plan_id_idx on public.household_plans (plan_id);

alter table public.household_plans enable row level security;
revoke all on table public.household_plans from anon, authenticated;

-- Editing a row in the Table Editor counts as a new assignment.
create trigger household_plans_set_assigned_at
  before update on public.household_plans
  for each row execute function private.set_assigned_at();

-- The plan an existing household starts on: an owner's user_plans plan (when two owners' plans
-- meet, the plan with more features wins, ties by plan id), else the default; null when neither.
-- Members' plans don't count. A function only so pgTAP can check the rule; it goes when
-- user_plans is dropped.
create function private.initial_household_plan(p_household_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select up.plan_id
     from public.household_members m
     join public.user_plans up on up.user_id = m.user_id
     where m.household_id = p_household_id and m.role = 'owner'
     order by (select count(*) from public.plan_features f where f.plan_id = up.plan_id) desc,
              up.plan_id collate "C"
     limit 1),
    (select p.id from public.plans p where p.is_default));
$$;

revoke all on function private.initial_household_plan(uuid) from public, anon, authenticated, service_role;

insert into public.household_plans (household_id, plan_id)
select h.id, private.initial_household_plan(h.id)
from public.households h
where private.initial_household_plan(h.id) is not null;

-- The app owner's households are on unlimited. Locally this does nothing: supabase/seed.sql makes
-- the dev user after migrations (and makes unlimited the default instead).
insert into public.household_plans (household_id, plan_id)
select distinct m.household_id, 'unlimited'
from public.household_members m
join auth.users u on u.id = m.user_id
where u.email = 'jgpasch@gmail.com'
on conflict (household_id) do update set plan_id = 'unlimited';

-- ---------------------------------------------------------------------------
-- Creating a household writes its row with the default plan (none when no plan is the default).
-- ---------------------------------------------------------------------------

-- As before, plus: a caller already in a household is refused (`already in a household`, P0001),
-- so nobody makes extra households to multiply allowances; and the new household gets the default
-- plan's row. A retry for a household the caller is already in still returns quietly.
create or replace function public.create_household(p_id uuid, p_name text)
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

  -- Serializes one user's calls, so two can't both pass the membership check.
  perform pg_advisory_xact_lock(hashtextextended('create_household:' || v_uid::text, 0));

  if exists (
    select 1 from public.household_members hm
    where hm.household_id = p_id and hm.user_id = v_uid
  ) then
    return;
  end if;
  if exists (select 1 from public.household_members hm where hm.user_id = v_uid) then
    raise exception 'already in a household' using errcode = 'P0001';
  end if;

  insert into public.households (id, name, created_by)
  values (p_id, p_name, v_uid)
  on conflict (id) do nothing;

  if not found then
    raise exception 'household % already exists', p_id using errcode = '42501';
  end if;

  insert into public.household_members (household_id, user_id, role, position)
  select p_id, v_uid, 'owner', coalesce(max(hm.position), 0) + 1
  from public.household_members hm
  where hm.user_id = v_uid;

  insert into public.household_plans (household_id, plan_id)
  select p_id, p.id from public.plans p where p.is_default;
end;
$$;

-- As before, plus the default plan's row.
create or replace function private.create_personal_household(p_user_id uuid)
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

  insert into public.household_plans (household_id, plan_id)
  select v_household_id, p.id from public.plans p where p.is_default;

  insert into public.lists (id, household_id, name, position)
  values (v_list_id, v_household_id, 'Groceries', 1);

  insert into public.user_settings (user_id, default_list_id)
  values (p_user_id, v_list_id)
  on conflict (user_id) do update set default_list_id = excluded.default_list_id;

  return v_household_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Resolution.
-- ---------------------------------------------------------------------------

-- Whether a household's plan includes a feature. No row, no features.
create function private.household_has_feature(p_household_id uuid, p_feature text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.household_plans hp
    join public.plan_features f on f.plan_id = hp.plan_id
    where hp.household_id = p_household_id and f.feature = p_feature
  );
$$;

revoke all on function private.household_has_feature(uuid, text) from public, anon, authenticated, service_role;

-- Whether the user may use a feature in a household: false unless they're a member of it, then
-- whether its plan has the feature. A null household (an old client that doesn't send one) takes
-- the best of the user's households: true when any of them has it.
create or replace function public.has_feature(p_user_id uuid, p_feature text, p_household_id uuid default null)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.household_members m
    where m.user_id = p_user_id
      and (p_household_id is null or m.household_id = p_household_id)
      and private.household_has_feature(m.household_id, p_feature)
  );
$$;

-- When a household's first month ends (households.created_at plus 30 days), or null for an
-- unknown household. Until then private.monthly_limit doubles its limits. The one place the 30
-- days live. Replaces the per-user version (same signature, new meaning), hence the drop.
drop function private.first_month_ends_at(uuid);
create function private.first_month_ends_at(p_household_id uuid)
returns timestamptz
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  c_first_month constant interval := interval '30 days';
begin
  return (select h.created_at + c_first_month from public.households h where h.id = p_household_id);
end;
$$;

revoke all on function private.first_month_ends_at(uuid) from public, anon, authenticated, service_role;

-- A household's monthly limit for a feature, or null for none: its plan's plan_limits row, doubled
-- in the household's first month. A plan with the feature and no row has no limit; a household
-- whose plan lacks the feature (or with no row) gets 0.
create function private.monthly_limit(p_feature text, p_household_id uuid)
returns integer
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  -- First month: a household younger than private.first_month_ends_at gets c_first_month_factor
  -- times its plan's limits, so importing a collection on day one doesn't hit the wall.
  c_first_month_factor constant integer := 2;
  v_limit integer;
begin
  if not private.household_has_feature(p_household_id, p_feature) then
    return 0;
  end if;

  select l.monthly_limit into v_limit
  from public.household_plans hp
  join public.plan_limits l on l.plan_id = hp.plan_id and l.feature = p_feature
  where hp.household_id = p_household_id;
  if v_limit is null then
    return null;
  end if;

  if now() < private.first_month_ends_at(p_household_id) then
    return v_limit * c_first_month_factor;
  end if;
  return v_limit;
end;
$$;

revoke all on function private.monthly_limit(text, uuid) from public, anon, authenticated, service_role;

-- Transition wrapper for the check_*_limit functions (until usage is counted per household): the
-- user's limit for a feature, resolving the household as has_feature does. A household they're
-- not in gets 0; a null household the best of theirs that have the feature (null if any has no
-- limit, else the highest; 0 if none has it). `recipe_import_photo` reads `recipe_import`'s limit
-- (they share it). Features that are no longer plan features (categorize, recipe_tags,
-- step_ingredients) have no monthly limit: null.
create or replace function private.monthly_limit(p_user_id uuid, p_feature text, p_household_id uuid default null)
returns integer
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_feature text := case when p_feature = 'recipe_import_photo' then 'recipe_import' else p_feature end;
  v_has_unlimited boolean;
  v_best integer;
begin
  if not (v_feature = any (private.feature_keys())) then
    return null;
  end if;

  if p_household_id is not null then
    if not exists (select 1 from public.household_members m
                   where m.user_id = p_user_id and m.household_id = p_household_id) then
      return 0;
    end if;
    return private.monthly_limit(v_feature, p_household_id);
  end if;

  select bool_or(l.lim is null), max(l.lim) into v_has_unlimited, v_best
  from (
    select private.monthly_limit(v_feature, m.household_id) as lim
    from public.household_members m
    where m.user_id = p_user_id and private.household_has_feature(m.household_id, v_feature)
  ) l;
  if v_has_unlimited then
    return null;
  end if;
  return coalesce(v_best, 0);
end;
$$;

-- The caller's features per household: { households: { <household id>: [features] } } for every
-- household they're in, features sorted ("C" collation), [] for a household whose plan has none.
-- `security definer` because the plan tables have no client policies.
create function public.my_household_features()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('households', coalesce(jsonb_object_agg(m.household_id, array(
    select f.feature
    from public.household_plans hp
    join public.plan_features f on f.plan_id = hp.plan_id
    where hp.household_id = m.household_id
    order by f.feature collate "C"
  )), '{}'))
  from public.household_members m
  where m.user_id = auth.uid();
$$;

revoke all on function public.my_household_features() from public, anon, service_role;
grant execute on function public.my_household_features() to authenticated;

-- Old builds' answer, in the old keys (p_household_id ignored): categorize, recipe_tags and
-- step_ingredients always (everyone has them now); recipe_import and recipe_import_photo when any
-- of the user's households has recipe_import; recipe_photo_ai likewise. Sorted ("C" collation).
create or replace function public.my_features(p_household_id uuid default null)
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select array(
    select k.feature
    from (
      select 'categorize' as feature
      union all select 'recipe_tags'
      union all select 'step_ingredients'
      union all select 'recipe_import' where public.has_feature(auth.uid(), 'recipe_import')
      union all select 'recipe_import_photo' where public.has_feature(auth.uid(), 'recipe_import')
      union all select 'recipe_photo_ai' where public.has_feature(auth.uid(), 'recipe_photo_ai')
    ) k
    order by k.feature collate "C"
  );
$$;

-- ---------------------------------------------------------------------------
-- admin_user_detail, as before, with the first month read from the user's oldest household (the
-- per-user first month is gone). Rewritten when the portal goes per household.
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
  v_up public.user_plans;
  v_plan public.plans;
  v_ends_at timestamptz;
  v_resets_at timestamptz := (date_trunc('month', now() at time zone 'utc') + interval '1 month') at time zone 'utc';
begin
  perform private.require_admin();

  select * into v_user from auth.users u where u.id = p_user_id;
  if not found then
    raise exception 'user not found' using errcode = 'P0002';
  end if;
  select p.display_name into v_display_name from public.profiles p where p.user_id = p_user_id;
  select * into v_up from public.user_plans up where up.user_id = p_user_id;
  select * into v_plan from public.plans p
  where p.id = coalesce(v_up.plan_id, (select d.id from public.plans d where d.is_default));
  v_ends_at := private.first_month_ends_at((
    select h.id from public.household_members m
    join public.households h on h.id = m.household_id
    where m.user_id = p_user_id
    order by h.created_at, h.id
    limit 1));

  return jsonb_build_object(
    'user_id', v_user.id,
    'email', v_user.email,
    'display_name', v_display_name,
    'created_at', v_user.created_at,
    'last_sign_in_at', v_user.last_sign_in_at,
    'plan_id', v_plan.id,
    'plan_assigned', v_up.user_id is not null,
    'assigned_at', v_up.assigned_at,
    'plan', jsonb_build_object(
      'id', v_plan.id,
      'name', v_plan.name,
      'assigned', v_up.user_id is not null,
      'assigned_at', v_up.assigned_at
    ),
    'first_month', jsonb_build_object(
      'doubled', coalesce(now() < v_ends_at, false),
      'ends_at', v_ends_at
    ),
    'households', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', h.id,
        'name', h.name,
        'role', hm.role,
        'member_count', (select count(*) from public.household_members m where m.household_id = h.id)
      ) order by hm.position, h.id)
      from public.household_members hm
      join public.households h on h.id = hm.household_id
      where hm.user_id = p_user_id
    ), '[]'),
    'usage', (
      select jsonb_agg(jsonb_build_object(
        'feature', f.feature,
        'in_plan', public.has_feature(p_user_id, f.feature),
        'used', private.monthly_usage(p_user_id, f.feature),
        'limit', private.monthly_limit(p_user_id, f.feature),
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
      where a.action = 'set_user_plan' and a.target_user_id = p_user_id
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
