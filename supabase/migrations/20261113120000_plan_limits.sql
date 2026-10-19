-- Monthly limits per plan (spec 4.12, 5, 6.1, 6.6–6.11). Each AI feature's per-user limit was a
-- hard-coded daily number, the same on every plan. It's now a monthly number (the calendar month in
-- UTC, resetting on the 1st) set per plan in public.plan_limits, resolved by private.monthly_limit.
-- The usage tables still count per user and UTC day; the check functions sum the month through
-- private.monthly_usage. The per-minute limits stay hard-coded on every plan: they catch a client
-- stuck in a loop. check_recipe_photos_limit (page photos: no LLM, no feature) keeps its 50 a day.
--
-- Each check answers 'ok', 'user_limit' (the per-minute limit) or 'monthly_limit', before anything
-- is counted, so a refused request uses no budget. Usage is counted even with no limit, so the
-- numbers stay visible. The usage tables are now kept 40 days, so a month's sum is always complete.
--
-- AI photos get a monthly limit too, counted at the reservation in private.recipe_photo_ai_usage.

create table public.plan_limits (
  plan_id       text references public.plans on delete cascade,
  feature       text check (feature in ('categorize', 'recipe_import', 'recipe_import_photo', 'recipe_tags', 'step_ingredients', 'recipe_photo_ai')),
  monthly_limit integer check (monthly_limit >= 0),
  primary key (plan_id, feature)
);

comment on table public.plan_limits is
  'How much of each feature a plan allows per calendar month (UTC). A null monthly_limit means no '
  'monthly limit, and so does a plan with the feature but no row for it: deleting a row lifts the '
  'limit. Units: categorize counts names sent to the LLM; the rest count calls. Accounts younger '
  'than 30 days get twice these (private.monthly_limit).';

alter table public.plan_limits enable row level security;
revoke all on table public.plan_limits from public, anon, authenticated;

-- Seed. Unlimited gets an explicit null row per feature so the Table Editor shows it; none has no
-- features, so no rows.
insert into public.plan_limits (plan_id, feature, monthly_limit) values
  ('plus', 'categorize', 250),
  ('plus', 'step_ingredients', 100),
  ('plus', 'recipe_import', 40),
  ('plus', 'recipe_import_photo', 20),
  ('plus', 'recipe_tags', 50),
  ('plus', 'recipe_photo_ai', 15),
  ('basic', 'categorize', 250),
  ('basic', 'step_ingredients', 100),
  ('unlimited', 'categorize', null),
  ('unlimited', 'step_ingredients', null),
  ('unlimited', 'recipe_import', null),
  ('unlimited', 'recipe_import_photo', null),
  ('unlimited', 'recipe_tags', null),
  ('unlimited', 'recipe_photo_ai', null);

-- AI photos reserved, per user and UTC day, like the other usage tables. A released slot isn't
-- given back, since its model calls were made.
create table private.recipe_photo_ai_usage (
  user_id uuid not null references auth.users on delete cascade,
  day date not null,
  photos integer not null default 0,         -- reservations that day
  primary key (user_id, day)
);
alter table private.recipe_photo_ai_usage enable row level security;
revoke all on table private.recipe_photo_ai_usage from public, anon, authenticated;

-- The user's monthly limit for a feature, or null for none. The plan is resolved as has_feature
-- does (their user_plans row, else the default plan), ignoring the household like has_feature, so
-- both can go per household together.
create function private.monthly_limit(p_user_id uuid, p_feature text, p_household_id uuid default null)
returns integer
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  -- First month: an account younger than this gets c_first_month_factor times its plan's limits,
  -- so importing a collection on day one doesn't hit the wall.
  c_first_month constant interval := interval '30 days';
  c_first_month_factor constant integer := 2;
  v_limit integer;
  v_created_at timestamptz;
begin
  select l.monthly_limit into v_limit
  from public.plan_limits l
  where l.feature = p_feature
    and l.plan_id = coalesce(
      (select up.plan_id from public.user_plans up where up.user_id = p_user_id),
      (select p.id from public.plans p where p.is_default)
    );
  if v_limit is null then
    return null;
  end if;

  select u.created_at into v_created_at from auth.users u where u.id = p_user_id;
  if v_created_at > now() - c_first_month then
    return v_limit * c_first_month_factor;
  end if;
  return v_limit;
end;
$$;

-- What the user has used of a feature this calendar month (UTC), in plan_limits' units: categorize
-- sums LLM-bound names, the rest count calls.
create function private.monthly_usage(p_user_id uuid, p_feature text)
returns integer
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_month date := date_trunc('month', now() at time zone 'utc')::date;
begin
  return coalesce(case p_feature
    when 'categorize' then
      (select sum(new_names) from private.categorize_usage where user_id = p_user_id and day >= v_month)
    when 'recipe_import' then
      (select sum(imports) from private.recipe_import_usage where user_id = p_user_id and day >= v_month)
    when 'recipe_import_photo' then
      (select sum(imports) from private.recipe_photo_import_usage where user_id = p_user_id and day >= v_month)
    when 'recipe_tags' then
      (select sum(suggestions) from private.recipe_tags_usage where user_id = p_user_id and day >= v_month)
    when 'step_ingredients' then
      (select sum(matches) from private.step_match_usage where user_id = p_user_id and day >= v_month)
    when 'recipe_photo_ai' then
      (select sum(photos) from private.recipe_photo_ai_usage where user_id = p_user_id and day >= v_month)
  end, 0)::integer;
end;
$$;

revoke all on function private.monthly_limit(uuid, text, uuid) from public, anon, authenticated;
revoke all on function private.monthly_usage(uuid, text) from public, anon, authenticated;

-- categorize-ingredients (spec 6.4): per user, 60 requests a minute, and the month's LLM-bound
-- names (plus p_new_names) within the plan's monthly limit; the monthly check applies only when
-- p_new_names > 0. A null p_user_id (the pg_cron sweep) has no limits. The user's row is locked so
-- concurrent requests can't both slip under.
create or replace function public.check_categorize_limit(p_user_id uuid, p_new_names integer)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_day date := (now() at time zone 'utc')::date;
  v_minute timestamptz := date_trunc('minute', now());
  v_usage private.categorize_usage;
  v_requests integer;
  v_limit integer;
begin
  if p_new_names is null or p_new_names < 0 then
    raise exception 'p_new_names must be >= 0' using errcode = '22023';
  end if;

  if p_user_id is null then
    return 'ok';
  end if;

  insert into private.categorize_usage (user_id, day, minute_start)
  values (p_user_id, v_day, v_minute)
  on conflict (user_id, day) do nothing;

  select * into v_usage from private.categorize_usage
  where user_id = p_user_id and day = v_day
  for update;

  v_requests := case when v_usage.minute_start = v_minute then v_usage.requests_this_minute else 0 end;
  if v_requests >= 60 then
    return 'user_limit';
  end if;
  if p_new_names > 0 then
    v_limit := private.monthly_limit(p_user_id, 'categorize');
    if v_limit is not null and private.monthly_usage(p_user_id, 'categorize') + p_new_names > v_limit then
      return 'monthly_limit';
    end if;
  end if;

  update private.categorize_usage
  set requests_this_minute = v_requests + 1,
      minute_start = v_minute,
      new_names = new_names + p_new_names
  where user_id = p_user_id and day = v_day;

  return 'ok';
end;
$$;

-- import-recipe (spec 6.6): per user, 10 imports a minute and the plan's monthly limit. Returns
-- 'ok', 'user_limit' or 'monthly_limit', counting one import; counters change only on 'ok'.
create or replace function public.check_recipe_import_limit(p_user_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_day date := (now() at time zone 'utc')::date;
  v_minute timestamptz := date_trunc('minute', now());
  v_usage private.recipe_import_usage;
  v_requests integer;
  v_limit integer;
begin
  if p_user_id is null then
    raise exception 'p_user_id is required' using errcode = '22023';
  end if;

  insert into private.recipe_import_usage (user_id, day, minute_start)
  values (p_user_id, v_day, v_minute)
  on conflict (user_id, day) do nothing;

  select * into v_usage from private.recipe_import_usage
  where user_id = p_user_id and day = v_day
  for update;

  v_requests := case when v_usage.minute_start = v_minute then v_usage.requests_this_minute else 0 end;
  if v_requests >= 10 then
    return 'user_limit';
  end if;
  v_limit := private.monthly_limit(p_user_id, 'recipe_import');
  if v_limit is not null and private.monthly_usage(p_user_id, 'recipe_import') >= v_limit then
    return 'monthly_limit';
  end if;

  update private.recipe_import_usage
  set requests_this_minute = v_requests + 1,
      minute_start = v_minute,
      imports = imports + 1
  where user_id = p_user_id and day = v_day;

  return 'ok';
end;
$$;

-- suggest-recipe-tags (spec 6.7): per user, 20 suggestions a minute and the plan's monthly limit.
-- Returns 'ok', 'user_limit' or 'monthly_limit', counting one suggestion; counters change only on
-- 'ok'.
create or replace function public.check_recipe_tags_limit(p_user_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_day date := (now() at time zone 'utc')::date;
  v_minute timestamptz := date_trunc('minute', now());
  v_usage private.recipe_tags_usage;
  v_requests integer;
  v_limit integer;
begin
  if p_user_id is null then
    raise exception 'p_user_id is required' using errcode = '22023';
  end if;

  insert into private.recipe_tags_usage (user_id, day, minute_start)
  values (p_user_id, v_day, v_minute)
  on conflict (user_id, day) do nothing;

  select * into v_usage from private.recipe_tags_usage
  where user_id = p_user_id and day = v_day
  for update;

  v_requests := case when v_usage.minute_start = v_minute then v_usage.requests_this_minute else 0 end;
  if v_requests >= 20 then
    return 'user_limit';
  end if;
  v_limit := private.monthly_limit(p_user_id, 'recipe_tags');
  if v_limit is not null and private.monthly_usage(p_user_id, 'recipe_tags') >= v_limit then
    return 'monthly_limit';
  end if;

  update private.recipe_tags_usage
  set requests_this_minute = v_requests + 1,
      minute_start = v_minute,
      suggestions = suggestions + 1
  where user_id = p_user_id and day = v_day;

  return 'ok';
end;
$$;

-- match-recipe-steps (spec 6.8): per user, 30 matches a minute and the plan's monthly limit for
-- step_ingredients. Returns 'ok', 'user_limit' or 'monthly_limit', counting one match; counters
-- change only on 'ok'.
create or replace function public.check_step_match_limit(p_user_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_day date := (now() at time zone 'utc')::date;
  v_minute timestamptz := date_trunc('minute', now());
  v_usage private.step_match_usage;
  v_requests integer;
  v_limit integer;
begin
  if p_user_id is null then
    raise exception 'p_user_id is required' using errcode = '22023';
  end if;

  insert into private.step_match_usage (user_id, day, minute_start)
  values (p_user_id, v_day, v_minute)
  on conflict (user_id, day) do nothing;

  select * into v_usage from private.step_match_usage
  where user_id = p_user_id and day = v_day
  for update;

  v_requests := case when v_usage.minute_start = v_minute then v_usage.requests_this_minute else 0 end;
  if v_requests >= 30 then
    return 'user_limit';
  end if;
  v_limit := private.monthly_limit(p_user_id, 'step_ingredients');
  if v_limit is not null and private.monthly_usage(p_user_id, 'step_ingredients') >= v_limit then
    return 'monthly_limit';
  end if;

  update private.step_match_usage
  set requests_this_minute = v_requests + 1,
      minute_start = v_minute,
      matches = matches + 1
  where user_id = p_user_id and day = v_day;

  return 'ok';
end;
$$;

-- import-recipe-photo (spec 6.10): per user, 5 photo imports a minute and the plan's monthly
-- limit. Returns 'ok', 'user_limit' or 'monthly_limit', counting one import; counters change only
-- on 'ok'.
create or replace function public.check_recipe_photo_limit(p_user_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_day date := (now() at time zone 'utc')::date;
  v_minute timestamptz := date_trunc('minute', now());
  v_usage private.recipe_photo_import_usage;
  v_imports integer;
  v_limit integer;
begin
  if p_user_id is null then
    raise exception 'p_user_id is required' using errcode = '22023';
  end if;

  insert into private.recipe_photo_import_usage (user_id, day, minute_start)
  values (p_user_id, v_day, v_minute)
  on conflict (user_id, day) do nothing;

  select * into v_usage from private.recipe_photo_import_usage
  where user_id = p_user_id and day = v_day
  for update;

  v_imports := case when v_usage.minute_start = v_minute then v_usage.imports_this_minute else 0 end;
  if v_imports >= 5 then
    return 'user_limit';
  end if;
  v_limit := private.monthly_limit(p_user_id, 'recipe_import_photo');
  if v_limit is not null and private.monthly_usage(p_user_id, 'recipe_import_photo') >= v_limit then
    return 'monthly_limit';
  end if;

  update private.recipe_photo_import_usage
  set imports_this_minute = v_imports + 1,
      minute_start = v_minute,
      imports = imports + 1
  where user_id = p_user_id and day = v_day;

  return 'ok';
end;
$$;

-- generate-recipe-photo (spec 6.11): one row, status 'ok' with the recipe's household, or
-- 'not_found', 'already_generated' or 'monthly_limit' (the user has reserved their plan's monthly
-- number) with a null household, checked in that order; nothing is written unless 'ok'. The recipe
-- row is locked first, so two calls for the same recipe can't both reserve, and a per-user advisory
-- lock keeps two recipes' calls from both slipping under the monthly limit.
create or replace function public.reserve_recipe_photo_ai(p_user_id uuid, p_recipe_id uuid)
returns table (status text, household_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_household_id uuid;
  v_row private.recipe_photo_ai;
  v_limit integer;
begin
  if p_user_id is null or p_recipe_id is null then
    raise exception 'p_user_id and p_recipe_id are required' using errcode = '22023';
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
  v_limit := private.monthly_limit(p_user_id, 'recipe_photo_ai');
  if v_limit is not null and private.monthly_usage(p_user_id, 'recipe_photo_ai') >= v_limit then
    return query select 'monthly_limit'::text, null::uuid;
    return;
  end if;

  insert into private.recipe_photo_ai_usage as u (user_id, day, photos)
  values (p_user_id, (now() at time zone 'utc')::date, 1)
  on conflict (user_id, day) do update set photos = u.photos + 1;

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

-- Retention: the usage tables are kept 40 days, so the current month's sum is always complete
-- (same job names and times; cron.schedule with an existing name replaces that job). The AI photo
-- usage is pruned at 03:49 UTC.
select cron.schedule(
  'categorize-usage-retention',
  '23 3 * * *',
  $$delete from private.categorize_usage where day < (now() at time zone 'utc')::date - 40$$
);
select cron.schedule(
  'recipe-import-usage-retention',
  '31 3 * * *',
  $$delete from private.recipe_import_usage where day < (now() at time zone 'utc')::date - 40$$
);
select cron.schedule(
  'recipe-tags-usage-retention',
  '33 3 * * *',
  $$delete from private.recipe_tags_usage where day < (now() at time zone 'utc')::date - 40$$
);
select cron.schedule(
  'step-match-usage-retention',
  '37 3 * * *',
  $$delete from private.step_match_usage where day < (now() at time zone 'utc')::date - 40$$
);
select cron.schedule(
  'recipe-photos-usage-retention',
  '41 3 * * *',
  $$delete from private.recipe_photos_usage where day < (now() at time zone 'utc')::date - 40$$
);
select cron.schedule(
  'recipe-photo-import-usage-retention',
  '47 3 * * *',
  $$delete from private.recipe_photo_import_usage where day < (now() at time zone 'utc')::date - 40$$
);
select cron.schedule(
  'recipe-photo-ai-usage-retention',
  '49 3 * * *',
  $$delete from private.recipe_photo_ai_usage where day < (now() at time zone 'utc')::date - 40$$
);
