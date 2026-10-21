-- The monthly allowance per household (spec 4.12 Monthly limits, Checking; 5 AI usage counters).
-- A plan's monthly limits are shared by the household's members, so the two plan features' usage is
-- counted per household in private.household_ai_usage, and the monthly check reads it there. The
-- per-user usage tables stay, for the safety limits.
--
-- check_recipe_import_limit and check_recipe_photo_limit gain p_household_id, the household the
-- recipe is saved to (null, from an old client: the user's oldest household); both count the
-- household's `recipe_import`, so link and photo imports share one allowance. reserve_recipe_photo_ai
-- counts `recipe_photo_ai` against the recipe's household. Each checks, in order, the per-minute
-- and daily safety limits, then the month under a per-household advisory lock, before writing
-- anything; a request that passes is counted on the user's table and on the household's.
--
-- No backfill: the month's household counts start at zero.
--
-- The transition wrapper private.monthly_limit(user, feature, household) goes, and
-- private.monthly_usage now takes a household. admin_user_detail and admin_ai_usage read the user's
-- oldest household until the portal goes per household.

create table private.household_ai_usage (
  household_id uuid not null references public.households (id) on delete cascade,
  feature      text not null check (feature in ('recipe_import', 'recipe_photo_ai')),
  day          date not null,
  used         integer not null default 0 check (used >= 0),
  primary key (household_id, feature, day)
);

comment on table private.household_ai_usage is
  'A household''s use of each plan feature per UTC day, in plan_limits'' units (spec 4.12, 5). '
  'Written only by the check_*_limit functions and reserve_recipe_photo_ai; the monthly limit is '
  'checked against the month''s sum (private.monthly_usage). Kept 40 days.';

alter table private.household_ai_usage enable row level security;
revoke all on table private.household_ai_usage from public, anon, authenticated;

-- Retention: kept 40 days, like the per-user usage tables, so a month's sum is always complete.
select cron.schedule(
  'household-ai-usage-retention',
  '51 3 * * *',
  $$delete from private.household_ai_usage where day < (now() at time zone 'utc')::date - 40$$
);

-- ---------------------------------------------------------------------------
-- Helpers.
-- ---------------------------------------------------------------------------

-- The user's oldest household (households.created_at, then id), or null when they're in none.
-- Where an old client's request, which names no household, is counted.
create function private.oldest_household(p_user_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select h.id
  from public.household_members m
  join public.households h on h.id = m.household_id
  where m.user_id = p_user_id
  order by h.created_at, h.id
  limit 1;
$$;

-- A household's use of a plan feature this calendar month (UTC). Replaces the per-user version
-- (same argument types, new meaning), hence the drop.
drop function private.monthly_usage(uuid, text);
create function private.monthly_usage(p_household_id uuid, p_feature text)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(u.used), 0)::integer
  from private.household_ai_usage u
  where u.household_id = p_household_id
    and u.feature = p_feature
    and u.day >= date_trunc('month', now() at time zone 'utc')::date;
$$;

-- The monthly check for one request: 'ok' or 'monthly_limit'. A household the user isn't in (or
-- none) gets 'monthly_limit'. Takes the household's advisory lock for the feature, held to the end
-- of the transaction, so two members can't both slip under; the caller counts the request
-- (private.count_household_ai_usage) in the same transaction.
create function private.check_household_monthly_limit(p_user_id uuid, p_household_id uuid, p_feature text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limit integer;
begin
  if p_household_id is null or not exists (
    select 1 from public.household_members m
    where m.household_id = p_household_id and m.user_id = p_user_id
  ) then
    return 'monthly_limit';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('household_ai_usage:' || p_household_id::text || ':' || p_feature, 0));

  v_limit := private.monthly_limit(p_feature, p_household_id);
  if v_limit is not null and private.monthly_usage(p_household_id, p_feature) >= v_limit then
    return 'monthly_limit';
  end if;
  return 'ok';
end;
$$;

-- Counts one use of a plan feature on the household's day.
create function private.count_household_ai_usage(p_household_id uuid, p_feature text)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into private.household_ai_usage as u (household_id, feature, day, used)
  values (p_household_id, p_feature, (now() at time zone 'utc')::date, 1)
  on conflict (household_id, feature, day) do update set used = u.used + 1;
$$;

revoke all on function private.oldest_household(uuid) from public, anon, authenticated, service_role;
revoke all on function private.monthly_usage(uuid, text) from public, anon, authenticated, service_role;
revoke all on function private.check_household_monthly_limit(uuid, uuid, text) from public, anon, authenticated, service_role;
revoke all on function private.count_household_ai_usage(uuid, text) from public, anon, authenticated, service_role;

-- The per-user wrapper goes: everything reads private.monthly_limit(feature, household).
drop function private.monthly_limit(uuid, text, uuid);

-- ---------------------------------------------------------------------------
-- The checks.
-- ---------------------------------------------------------------------------

-- import-recipe (spec 6.6): per user, `recipe_import_link`'s imports a minute and `recipe_import`'s
-- link and photo imports a day, then the household's monthly `recipe_import` (p_household_id, or
-- the user's oldest household for an old client). Returns 'ok', 'user_limit', 'daily_limit' or
-- 'monthly_limit', counting one import on the user's table and the household's; nothing changes
-- unless 'ok'. A per-user lock, shared with photo import, keeps the two kinds from both slipping
-- under the shared safety limits.
drop function public.check_recipe_import_limit(uuid);
create function public.check_recipe_import_limit(p_user_id uuid, p_household_id uuid default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_day date := (now() at time zone 'utc')::date;
  v_minute timestamptz := date_trunc('minute', now());
  v_household_id uuid := coalesce(p_household_id, private.oldest_household(p_user_id));
  v_usage private.recipe_import_usage;
  v_requests integer;
  v_answer text;
begin
  if p_user_id is null then
    raise exception 'p_user_id is required' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('recipe_import_usage:' || p_user_id::text, 0));

  insert into private.recipe_import_usage (user_id, day, minute_start)
  values (p_user_id, v_day, v_minute)
  on conflict (user_id, day) do nothing;

  select * into v_usage from private.recipe_import_usage
  where user_id = p_user_id and day = v_day
  for update;

  v_requests := case when v_usage.minute_start = v_minute then v_usage.requests_this_minute else 0 end;
  v_answer := private.recipe_import_safety(p_user_id, 'recipe_import_link', v_requests, v_usage.imports);
  if v_answer <> 'ok' then
    return v_answer;
  end if;
  v_answer := private.check_household_monthly_limit(p_user_id, v_household_id, 'recipe_import');
  if v_answer <> 'ok' then
    return v_answer;
  end if;

  update private.recipe_import_usage
  set requests_this_minute = v_requests + 1,
      minute_start = v_minute,
      imports = imports + 1
  where user_id = p_user_id and day = v_day;
  perform private.count_household_ai_usage(v_household_id, 'recipe_import');

  return 'ok';
end;
$$;

-- import-recipe-photo (spec 6.10): per user, `recipe_import_photo`'s photo imports a minute and
-- `recipe_import`'s link and photo imports a day, then the household's monthly `recipe_import`,
-- shared with link imports. Otherwise as check_recipe_import_limit.
drop function public.check_recipe_photo_limit(uuid);
create function public.check_recipe_photo_limit(p_user_id uuid, p_household_id uuid default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_day date := (now() at time zone 'utc')::date;
  v_minute timestamptz := date_trunc('minute', now());
  v_household_id uuid := coalesce(p_household_id, private.oldest_household(p_user_id));
  v_usage private.recipe_photo_import_usage;
  v_imports integer;
  v_answer text;
begin
  if p_user_id is null then
    raise exception 'p_user_id is required' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('recipe_import_usage:' || p_user_id::text, 0));

  insert into private.recipe_photo_import_usage (user_id, day, minute_start)
  values (p_user_id, v_day, v_minute)
  on conflict (user_id, day) do nothing;

  select * into v_usage from private.recipe_photo_import_usage
  where user_id = p_user_id and day = v_day
  for update;

  v_imports := case when v_usage.minute_start = v_minute then v_usage.imports_this_minute else 0 end;
  v_answer := private.recipe_import_safety(p_user_id, 'recipe_import_photo', v_imports, v_usage.imports);
  if v_answer <> 'ok' then
    return v_answer;
  end if;
  v_answer := private.check_household_monthly_limit(p_user_id, v_household_id, 'recipe_import');
  if v_answer <> 'ok' then
    return v_answer;
  end if;

  update private.recipe_photo_import_usage
  set imports_this_minute = v_imports + 1,
      minute_start = v_minute,
      imports = imports + 1
  where user_id = p_user_id and day = v_day;
  perform private.count_household_ai_usage(v_household_id, 'recipe_import');

  return 'ok';
end;
$$;

revoke all on function public.check_recipe_import_limit(uuid, uuid) from public, anon, authenticated;
grant execute on function public.check_recipe_import_limit(uuid, uuid) to service_role;
revoke all on function public.check_recipe_photo_limit(uuid, uuid) from public, anon, authenticated;
grant execute on function public.check_recipe_photo_limit(uuid, uuid) to service_role;

-- generate-recipe-photo (spec 6.11): one row, status 'ok' with the recipe's household, or
-- 'blocked' (the user's AI photos are blocked, checked first, so no slot or budget is used),
-- 'not_found', 'already_generated', 'user_limit' or 'daily_limit' (`recipe_photo_ai`'s safety
-- limits) or 'monthly_limit' (the recipe's household has used its plan's AI photos this month)
-- with a null household, checked in that order; nothing is written unless 'ok', and then the
-- photo is counted on the user's table and the household's. The recipe row is locked first, so
-- two calls for the same recipe can't both reserve; a per-user advisory lock keeps two recipes'
-- calls from both slipping under the safety limits, and the household's lock under its month.
create or replace function public.reserve_recipe_photo_ai(p_user_id uuid, p_recipe_id uuid)
returns table (status text, household_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_day date := (now() at time zone 'utc')::date;
  v_minute timestamptz := date_trunc('minute', now());
  v_household_id uuid;
  v_row private.recipe_photo_ai;
  v_safety public.ai_safety_limits;
  v_usage private.recipe_photo_ai_usage;
  v_requests integer;
begin
  if p_user_id is null or p_recipe_id is null then
    raise exception 'p_user_id and p_recipe_id are required' using errcode = '22023';
  end if;

  if exists (select 1 from private.ai_photo_blocks b where b.user_id = p_user_id) then
    return query select 'blocked'::text, null::uuid;
    return;
  end if;

  select r.household_id into v_household_id
  from public.recipes r
  where r.id = p_recipe_id
    and r.deleted_at is null
    and exists (
      select 1 from public.household_members m
      where m.household_id = r.household_id and m.user_id = p_user_id
    )
  for update of r;

  if v_household_id is null then
    return query select 'not_found'::text, null::uuid;
    return;
  end if;

  select * into v_row from private.recipe_photo_ai a where a.recipe_id = p_recipe_id;
  if found and (v_row.status = 'done' or v_row.created_at > now() - interval '10 minutes') then
    return query select 'already_generated'::text, null::uuid;
    return;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('recipe_photo_ai_usage:' || p_user_id::text, 0));

  v_safety := private.safety_limit('recipe_photo_ai');
  select * into v_usage from private.recipe_photo_ai_usage u where u.user_id = p_user_id and u.day = v_day;
  v_requests := case when v_usage.minute_start = v_minute then v_usage.requests_this_minute else 0 end;
  if v_requests >= v_safety.per_minute then
    return query select 'user_limit'::text, null::uuid;
    return;
  end if;
  if coalesce(v_usage.photos, 0) >= v_safety.per_day then
    return query select 'daily_limit'::text, null::uuid;
    return;
  end if;

  if private.check_household_monthly_limit(p_user_id, v_household_id, 'recipe_photo_ai') <> 'ok' then
    return query select 'monthly_limit'::text, null::uuid;
    return;
  end if;

  insert into private.recipe_photo_ai_usage as u (user_id, day, photos, minute_start, requests_this_minute)
  values (p_user_id, v_day, 1, v_minute, 1)
  on conflict (user_id, day) do update
    set photos = u.photos + 1,
        minute_start = v_minute,
        requests_this_minute = v_requests + 1;
  perform private.count_household_ai_usage(v_household_id, 'recipe_photo_ai');

  insert into private.recipe_photo_ai as a (recipe_id, household_id, created_by, status)
  values (p_recipe_id, v_household_id, p_user_id, 'pending')
  on conflict (recipe_id) do update
    set household_id = excluded.household_id,
        created_by = excluded.created_by,
        description = null,
        path = null,
        status = 'pending',
        created_at = now();

  return query select 'ok'::text, v_household_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- The portal's two readers of the wrapper, as before, reading the user's oldest household (as
-- admin_user_detail's first month already did). Rewritten when the portal goes per household.
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
  v_household_id uuid;
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
  v_household_id := private.oldest_household(p_user_id);
  v_ends_at := private.first_month_ends_at(v_household_id);

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
        'used', private.monthly_usage(v_household_id, f.feature),
        'limit', private.monthly_limit(f.feature, v_household_id),
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

-- admin_ai_usage as before; each top user's limit is their oldest household's.
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
  v_default text := (select p.id from public.plans p where p.is_default);
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
        ),
        'top_users', coalesce((
          select jsonb_agg(jsonb_build_object(
            'user_id', t.user_id,
            'email', u.email,
            'plan_id', coalesce(up.plan_id, v_default),
            'used', t.used,
            'limit', private.monthly_limit(f.feature, private.oldest_household(t.user_id))
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
          left join public.user_plans up on up.user_id = t.user_id
        ), '[]')
      ) order by f.ord)
      from unnest(private.feature_keys()) with ordinality as f (feature, ord)
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
