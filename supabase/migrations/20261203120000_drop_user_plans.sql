-- Per-user plans are gone (spec 4.12). Plans belong to households (`household_plans`), and every
-- client names the household it acts in, so the transition pieces go:
--   - `user_plans` (with its `user_plans_set_assigned_at` trigger; private.set_assigned_at stays for
--     household_plans), `admin_set_user_plan` (unused by the portal) and `my_features` (old builds'
--     answer in the old keys; the app reads my_household_features).
--   - private.initial_household_plan, which read user_plans for the migration that moved plans to
--     households, and private.oldest_household, where an old client's import was counted.
--   - `has_feature` with a null household is false (it took the best of the user's households).
--   - check_recipe_import_limit and check_recipe_photo_limit require a household (`household
--     required`, 22023), before anything is read or written.
--
-- Old app builds' imports, which send no household, now fail (400 from the functions' schemas).

drop function public.my_features(uuid);
drop function public.admin_set_user_plan(uuid, text, text);
drop function private.initial_household_plan(uuid);
drop table public.user_plans;

-- Whether the user may use a feature in a household: false for a null household or one they're
-- not a member of, then whether its plan has the feature.
create or replace function public.has_feature(p_user_id uuid, p_feature text, p_household_id uuid default null)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_household_id is not null and exists (
    select 1
    from public.household_members m
    where m.user_id = p_user_id
      and m.household_id = p_household_id
      and private.household_has_feature(m.household_id, p_feature)
  );
$$;

-- import-recipe (spec 6.6): as before (20261201120000_household_ai_usage.sql), but the household the
-- recipe is saved to is required.
create or replace function public.check_recipe_import_limit(p_user_id uuid, p_household_id uuid default null)
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
  v_answer text;
begin
  if p_user_id is null then
    raise exception 'p_user_id is required' using errcode = '22023';
  end if;
  if p_household_id is null then
    raise exception 'household required' using errcode = '22023';
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
  v_answer := private.check_household_monthly_limit(p_user_id, p_household_id, 'recipe_import');
  if v_answer <> 'ok' then
    return v_answer;
  end if;

  update private.recipe_import_usage
  set requests_this_minute = v_requests + 1,
      minute_start = v_minute,
      imports = imports + 1
  where user_id = p_user_id and day = v_day;
  perform private.count_household_ai_usage(p_household_id, 'recipe_import');

  return 'ok';
end;
$$;

-- import-recipe-photo (spec 6.10): as before, but the household is required.
create or replace function public.check_recipe_photo_limit(p_user_id uuid, p_household_id uuid default null)
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
  v_answer text;
begin
  if p_user_id is null then
    raise exception 'p_user_id is required' using errcode = '22023';
  end if;
  if p_household_id is null then
    raise exception 'household required' using errcode = '22023';
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
  v_answer := private.check_household_monthly_limit(p_user_id, p_household_id, 'recipe_import');
  if v_answer <> 'ok' then
    return v_answer;
  end if;

  update private.recipe_photo_import_usage
  set imports_this_minute = v_imports + 1,
      minute_start = v_minute,
      imports = imports + 1
  where user_id = p_user_id and day = v_day;
  perform private.count_household_ai_usage(p_household_id, 'recipe_import');

  return 'ok';
end;
$$;

-- Nothing reads it now: every import names its household.
drop function private.oldest_household(uuid);
