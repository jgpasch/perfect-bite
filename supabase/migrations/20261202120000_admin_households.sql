-- The portal by household (spec 4.12 Changing a household's plan, Editing plans, AI usage). Plans
-- belong to households, so the portal finds households, reads one and changes its plan; users no
-- longer have a plan of their own in it.
--
-- New: admin_set_household_plan (a plan is required: a household's plan can be changed, never
-- cleared), admin_list_households and admin_household_detail. Each starts with
-- private.require_admin(), like the other portal functions.
--
-- Changed:
--   - A plan's count is its household_plans rows (`households`, in admin_list_plans and in every
--     plan edit's details, replacing `users`). Every household has a row, so the default counts no
--     one extra, and admin_set_default_plan moves no household (it never wrote one; its details
--     now say only how many households are on the plan, not how many it covered).
--   - admin_delete_plan's `plan in use` checks household_plans.
--   - admin_list_users drops its plan columns; admin_user_detail lists the user's households with
--     each one's plan in place of the user's plan, first month, usage and plan history. Both keep
--     the AI photo block fields.
--   - admin_ai_usage: the two plan features with top_households, then categorize, step matching
--     and tags with top_users (no limit). private.daily_usage's keys follow: recipe_import counts
--     link and photo imports together, and step_match and recipe_tags name the safety limits' keys.
--
-- admin_set_user_plan stays, unused by the portal, until per-user plans are dropped. The import
-- rule's `set constraints` already left private.log_plan_action (20261129120000_household_plans.sql),
-- so admin_set_plan_feature needs no change.

-- The household page's plan history reads by household.
create index admin_actions_target_household_idx on admin.admin_actions (target_household_id, action, created_at desc);

-- ---------------------------------------------------------------------------
-- Plans count households.
-- ---------------------------------------------------------------------------

drop function private.plan_user_count(text);

-- How many households are on a plan: its household_plans rows.
create function private.plan_household_count(p_plan_id text)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::integer from public.household_plans hp where hp.plan_id = p_plan_id;
$$;

revoke all on function private.plan_household_count(text) from public, anon, authenticated, service_role;

-- A plan as the portal shows it, or null for an unknown id: id, name, is_default, households, and
-- features in the fixed order (private.feature_keys), each with its monthly_limit (null for none).
create or replace function private.plan_snapshot(p_plan_id text)
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
    'households', private.plan_household_count(p.id),
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

-- Writes a plan change's audit row and returns its details: { before, after, households }, before
-- and after being plan_snapshot (null for a plan that didn't or no longer exists) and households
-- the number on the plan (before a delete, after anything else), merged with p_extra.
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
    'households', coalesce((v_after ->> 'households')::integer, (p_before ->> 'households')::integer, 0)
  ) || p_extra;
  insert into admin.admin_actions (action, target_plan_id, details, note, performed_by)
  values (p_action, p_plan_id, v_details, p_note, auth.uid()::text);
  return v_details;
end;
$$;

-- admin_delete_plan, as before, with `plan in use` meaning a household is on it.
create or replace function public.admin_delete_plan(p_id text, p_note text)
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
  if exists (select 1 from public.household_plans hp where hp.plan_id = p_id) then
    raise exception 'plan in use' using errcode = '23503';
  end if;
  perform private.require_note(p_note);

  v_before := private.plan_snapshot(p_id);
  delete from public.plans p where p.id = p_id;

  return private.log_plan_action('delete_plan', p_id, v_before, p_note);
end;
$$;

-- ---------------------------------------------------------------------------
-- admin_set_household_plan: upserts the household's household_plans row. A plan is required.
-- Raises `household not found` or `plan not found` (P0002), `plan required` or `note required`
-- (22023), changing nothing. Writes one audit row, even when the plan doesn't change, and returns
-- its details: { from, to }, plan ids (from is null for a household that had no row).
-- ---------------------------------------------------------------------------

create function public.admin_set_household_plan(p_household_id uuid, p_plan_id text, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_from text;
  v_details jsonb;
begin
  perform private.require_admin();

  perform 1 from public.households h where h.id = p_household_id for update;
  if not found then
    raise exception 'household not found' using errcode = 'P0002';
  end if;
  if p_plan_id is null then
    raise exception 'plan required' using errcode = '22023';
  end if;
  if not exists (select 1 from public.plans p where p.id = p_plan_id) then
    raise exception 'plan not found' using errcode = 'P0002';
  end if;
  perform private.require_note(p_note);

  select hp.plan_id into v_from from public.household_plans hp where hp.household_id = p_household_id for update;

  insert into public.household_plans as hp (household_id, plan_id) values (p_household_id, p_plan_id)
  on conflict (household_id) do update set plan_id = excluded.plan_id;

  v_details := jsonb_build_object('from', v_from, 'to', p_plan_id);
  insert into admin.admin_actions (action, target_household_id, target_plan_id, details, note, performed_by)
  values ('set_household_plan', p_household_id, p_plan_id, v_details, p_note, auth.uid()::text);

  return v_details;
end;
$$;

-- ---------------------------------------------------------------------------
-- admin_list_households: households whose name or a member's email or display name contains the
-- search (case-insensitively, trimmed), or the household with that id when the search is a uuid;
-- everyone for none. Newest first, at most 200 a page; total_count is the matches before paging.
-- ---------------------------------------------------------------------------

create function public.admin_list_households(
  p_search text default null,
  p_limit integer default 50,
  p_offset integer default 0
)
returns table (
  household_id uuid,
  name text,
  created_at timestamptz,
  member_count integer,
  plan_id text,
  plan_name text,
  total_count bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_search text := nullif(btrim(p_search), '');
  v_id uuid;
begin
  perform private.require_admin();

  if v_search ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    v_id := v_search::uuid;
  end if;

  return query
  select h.id, h.name, h.created_at,
         (select count(*) from public.household_members m where m.household_id = h.id)::integer,
         hp.plan_id, p.name,
         count(*) over ()
  from public.households h
  left join public.household_plans hp on hp.household_id = h.id
  left join public.plans p on p.id = hp.plan_id
  where v_search is null
     or (v_id is not null and h.id = v_id)
     or (v_id is null and (
           strpos(lower(h.name), lower(v_search)) > 0
           or exists (
             select 1
             from public.household_members m
             join auth.users u on u.id = m.user_id
             left join public.profiles pr on pr.user_id = m.user_id
             where m.household_id = h.id
               and (strpos(lower(u.email), lower(v_search)) > 0
                    or strpos(lower(pr.display_name), lower(v_search)) > 0))))
  order by h.created_at desc, h.id
  limit least(greatest(coalesce(p_limit, 50), 0), 200)
  offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

-- ---------------------------------------------------------------------------
-- admin_household_detail: one household: its name and age, the first month, its members (role,
-- email, name; earliest joined first), its plan (null with no row), this month's usage of each plan
-- feature against its limit, and its set_household_plan history, newest first, with the admin's
-- email. Raises `household not found` (P0002).
-- ---------------------------------------------------------------------------

create function public.admin_household_detail(p_household_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_household public.households;
  v_ends_at timestamptz;
  v_resets_at timestamptz := (date_trunc('month', now() at time zone 'utc') + interval '1 month') at time zone 'utc';
begin
  perform private.require_admin();

  select * into v_household from public.households h where h.id = p_household_id;
  if not found then
    raise exception 'household not found' using errcode = 'P0002';
  end if;
  v_ends_at := private.first_month_ends_at(p_household_id);

  return jsonb_build_object(
    'household_id', v_household.id,
    'name', v_household.name,
    'created_at', v_household.created_at,
    'first_month', jsonb_build_object(
      'doubled', coalesce(now() < v_ends_at, false),
      'ends_at', v_ends_at
    ),
    'members', coalesce((
      select jsonb_agg(jsonb_build_object(
        'user_id', m.user_id,
        'email', u.email,
        'display_name', pr.display_name,
        'role', m.role,
        'joined_at', m.joined_at
      ) order by m.joined_at, m.user_id)
      from public.household_members m
      join auth.users u on u.id = m.user_id
      left join public.profiles pr on pr.user_id = m.user_id
      where m.household_id = p_household_id
    ), '[]'),
    'plan', (
      select jsonb_build_object('id', p.id, 'name', p.name, 'assigned_at', hp.assigned_at)
      from public.household_plans hp
      join public.plans p on p.id = hp.plan_id
      where hp.household_id = p_household_id
    ),
    'usage', (
      select jsonb_agg(jsonb_build_object(
        'feature', f.feature,
        'in_plan', private.household_has_feature(p_household_id, f.feature),
        'used', private.monthly_usage(p_household_id, f.feature),
        'limit', private.monthly_limit(f.feature, p_household_id),
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
      where a.action = 'set_household_plan' and a.target_household_id = p_household_id
    ), '[]')
  );
end;
$$;

revoke all on function public.admin_set_household_plan(uuid, text, text) from public, anon, service_role;
revoke all on function public.admin_list_households(text, integer, integer) from public, anon, service_role;
revoke all on function public.admin_household_detail(uuid) from public, anon, service_role;
grant execute on function public.admin_set_household_plan(uuid, text, text) to authenticated;
grant execute on function public.admin_list_households(text, integer, integer) to authenticated;
grant execute on function public.admin_household_detail(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Users have no plan of their own in the portal.
-- ---------------------------------------------------------------------------

-- admin_list_users, as before, without the plan columns.
drop function public.admin_list_users(text, integer, integer, boolean);

create function public.admin_list_users(
  p_search text default null,
  p_limit integer default 50,
  p_offset integer default 0,
  p_blocked boolean default null
)
returns table (
  user_id uuid,
  email text,
  display_name text,
  created_at timestamptz,
  last_sign_in_at timestamptz,
  ai_photos_blocked boolean,
  total_count bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_search text := nullif(btrim(p_search), '');
  v_id uuid;
begin
  perform private.require_admin();

  if v_search ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    v_id := v_search::uuid;
  end if;

  return query
  select u.id, u.email::text, pr.display_name, u.created_at, u.last_sign_in_at,
         b.user_id is not null,
         count(*) over ()
  from auth.users u
  left join public.profiles pr on pr.user_id = u.id
  left join private.ai_photo_blocks b on b.user_id = u.id
  where (v_search is null
         or (v_id is not null and u.id = v_id)
         or (v_id is null and (strpos(lower(u.email), lower(v_search)) > 0
                               or strpos(lower(pr.display_name), lower(v_search)) > 0)))
    and (p_blocked is null or (b.user_id is not null) = p_blocked)
  order by u.created_at desc nulls last, u.id
  limit least(greatest(coalesce(p_limit, 50), 0), 200)
  offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

revoke all on function public.admin_list_users(text, integer, integer, boolean) from public, anon, service_role;
grant execute on function public.admin_list_users(text, integer, integer, boolean) to authenticated;

-- admin_user_detail: who the user is, their households (in their order, each with role, member
-- count and plan id and name, null with no row), their flagged AI calls and their AI photo block.
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
begin
  perform private.require_admin();

  select * into v_user from auth.users u where u.id = p_user_id;
  if not found then
    raise exception 'user not found' using errcode = 'P0002';
  end if;
  select p.display_name into v_display_name from public.profiles p where p.user_id = p_user_id;

  return jsonb_build_object(
    'user_id', v_user.id,
    'email', v_user.email,
    'display_name', v_display_name,
    'created_at', v_user.created_at,
    'last_sign_in_at', v_user.last_sign_in_at,
    'households', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', h.id,
        'name', h.name,
        'role', hm.role,
        'member_count', (select count(*) from public.household_members m where m.household_id = h.id),
        'plan_id', hp.plan_id,
        'plan_name', p.name
      ) order by hm.position, h.id)
      from public.household_members hm
      join public.households h on h.id = hm.household_id
      left join public.household_plans hp on hp.household_id = h.id
      left join public.plans p on p.id = hp.plan_id
      where hm.user_id = p_user_id
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

-- ---------------------------------------------------------------------------
-- AI usage.
-- ---------------------------------------------------------------------------

-- The AI features admin_ai_usage reports, in its order: the two plan features (private.feature_keys),
-- then the ones every plan has, named by their safety limits' keys.
create function private.ai_usage_keys()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select private.feature_keys() || array['categorize', 'step_match', 'recipe_tags'];
$$;

revoke all on function private.ai_usage_keys() from public, anon, authenticated, service_role;

-- Each user's use of an AI feature per UTC day since p_since, in the units the limits use: names
-- for categorize, link and photo imports together for recipe_import (two rows for a user who did
-- both on a day), requests for the rest.
create or replace function private.daily_usage(p_feature text, p_since date)
returns table (user_id uuid, day date, used integer)
language sql
stable
security definer
set search_path = ''
as $$
  select u.user_id, u.day, u.new_names from private.categorize_usage u
  where p_feature = 'categorize' and u.day >= p_since
  union all
  select u.user_id, u.day, u.imports from private.recipe_import_usage u
  where p_feature = 'recipe_import' and u.day >= p_since
  union all
  select u.user_id, u.day, u.imports from private.recipe_photo_import_usage u
  where p_feature = 'recipe_import' and u.day >= p_since
  union all
  select u.user_id, u.day, u.suggestions from private.recipe_tags_usage u
  where p_feature = 'recipe_tags' and u.day >= p_since
  union all
  select u.user_id, u.day, u.matches from private.step_match_usage u
  where p_feature = 'step_match' and u.day >= p_since
  union all
  select u.user_id, u.day, u.photos from private.recipe_photo_ai_usage u
  where p_feature = 'recipe_photo_ai' and u.day >= p_since;
$$;

-- admin_ai_usage: per AI feature (private.ai_usage_keys), this month's used and users and the last
-- 40 days; the two plan features with top_households (name, plan, used, the household's limit),
-- the rest with top_users (email, used; no limit). And the last 30 days of ai_calls, as before.
create or replace function public.admin_ai_usage()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  c_days constant integer := 40;
  v_today date := (now() at time zone 'utc')::date;
  v_month date := date_trunc('month', now() at time zone 'utc')::date;
  v_calls_since timestamptz := now() - interval '30 days';
begin
  perform private.require_admin();

  return jsonb_build_object(
    'month_start', v_month,
    'features', (
      select jsonb_agg(jsonb_build_object(
        'feature', f.feature,
        'used', (select coalesce(sum(d.used), 0) from private.daily_usage(f.feature, v_month) d),
        'users', (select count(distinct d.user_id) from private.daily_usage(f.feature, v_month) d where d.used > 0),
        'daily', (
          select jsonb_agg(jsonb_build_object('day', s.day, 'used', coalesce(t.used, 0)) order by s.day)
          from (select (v_today - n)::date as day from generate_series(c_days - 1, 0, -1) n) s
          left join (
            select d.day, sum(d.used) as used
            from private.daily_usage(f.feature, v_today - (c_days - 1)) d
            group by d.day
          ) t on t.day = s.day
        )
      ) || case
        when f.feature = any (private.feature_keys()) then jsonb_build_object('top_households', coalesce((
          select jsonb_agg(jsonb_build_object(
            'household_id', t.household_id,
            'name', h.name,
            'plan_id', hp.plan_id,
            'used', t.used,
            'limit', private.monthly_limit(f.feature, t.household_id)
          ) order by t.used desc, t.household_id)
          from (
            select u.household_id, sum(u.used) as used
            from private.household_ai_usage u
            where u.feature = f.feature and u.day >= v_month
            group by u.household_id
            having sum(u.used) > 0
            order by sum(u.used) desc, u.household_id
            limit 10
          ) t
          join public.households h on h.id = t.household_id
          left join public.household_plans hp on hp.household_id = t.household_id
        ), '[]'))
        else jsonb_build_object('top_users', coalesce((
          select jsonb_agg(jsonb_build_object(
            'user_id', t.user_id,
            'email', u.email,
            'used', t.used
          ) order by t.used desc, t.user_id)
          from (
            select d.user_id, sum(d.used) as used
            from private.daily_usage(f.feature, v_month) d
            group by d.user_id
            having sum(d.used) > 0
            order by sum(d.used) desc, d.user_id
            limit 10
          ) t
          join auth.users u on u.id = t.user_id
        ), '[]'))
      end order by f.ord)
      from unnest(private.ai_usage_keys()) with ordinality as f (feature, ord)
    ),
    'calls_since', v_calls_since,
    'calls', coalesce((
      select jsonb_agg(
        jsonb_build_object('task', k.task)
          || private.ai_call_stats(k.task, null, v_calls_since)
          || jsonb_build_object('models', (
            select jsonb_agg(jsonb_build_object('model', m.model)
                             || private.ai_call_stats(k.task, m.model, v_calls_since) order by m.model)
            from (select distinct c.model from public.ai_calls c
                  where c.task = k.task and c.created_at >= v_calls_since) m
          ))
        order by k.task)
      from (select distinct c.task from public.ai_calls c where c.created_at >= v_calls_since) k
    ), '[]')
  );
end;
$$;
