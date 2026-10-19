-- The global daily caps are gone (spec 6.1, 6.6–6.11). Each AI function had a cap across all users
-- that its Edge Function passed in (CATEGORIZE_DAILY_NAME_CAP and the others), counted in a
-- private.*_daily_total table; the per-user limits catch abuse on their own, and a cap shared by
-- everyone let one busy day shut the feature off for all. The per-user limits stay exactly as they
-- were. A 503 `unavailable` now comes only from a kill switch or a provider error.
--
-- Each limit function is dropped and recreated without p_daily_cap and without the 'global_cap'
-- answer, with the same grants (service_role only). The daily totals are dropped, and each
-- retention job is rescheduled without them; recipe-photo-ai-total-retention pruned nothing else,
-- so it goes.

select cron.unschedule('recipe-photo-ai-total-retention');

drop function public.check_categorize_limit(uuid, integer, integer);
drop function public.check_recipe_import_limit(uuid, integer);
drop function public.check_recipe_tags_limit(uuid, integer);
drop function public.check_step_match_limit(uuid, integer);
drop function public.check_recipe_photos_limit(uuid, integer);
drop function public.check_recipe_photo_limit(uuid, integer);
drop function public.reserve_recipe_photo_ai(uuid, uuid, integer);

drop table private.categorize_daily_total;
drop table private.recipe_import_daily_total;
drop table private.recipe_tags_daily_total;
drop table private.step_match_daily_total;
drop table private.recipe_photos_daily_total;
drop table private.recipe_photo_import_daily_total;
drop table private.recipe_photo_ai_daily_total;

-- categorize-ingredients (spec 6.4): per user, 60 requests a minute and 500 new (LLM-bound) names
-- a day. Returns 'ok' or 'user_limit'; counters change only on 'ok', so a refused request uses no
-- budget. The daily name limit applies only when p_new_names > 0. A null p_user_id (the pg_cron
-- sweep) has no limits. The user's row is locked so concurrent requests can't both slip under.
create function public.check_categorize_limit(p_user_id uuid, p_new_names integer)
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
  if p_new_names > 0 and v_usage.new_names + p_new_names > 500 then
    return 'user_limit';
  end if;

  update private.categorize_usage
  set requests_this_minute = v_requests + 1,
      minute_start = v_minute,
      new_names = new_names + p_new_names
  where user_id = p_user_id and day = v_day;

  return 'ok';
end;
$$;

-- import-recipe (spec 6.6): per user, 10 imports a minute and 50 a day. Returns 'ok' or
-- 'user_limit', counting one import; counters change only on 'ok'.
create function public.check_recipe_import_limit(p_user_id uuid)
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
  if v_requests >= 10 or v_usage.imports >= 50 then
    return 'user_limit';
  end if;

  update private.recipe_import_usage
  set requests_this_minute = v_requests + 1,
      minute_start = v_minute,
      imports = imports + 1
  where user_id = p_user_id and day = v_day;

  return 'ok';
end;
$$;

-- suggest-recipe-tags (spec 6.7): per user, 20 suggestions a minute and 100 a day. Returns 'ok' or
-- 'user_limit', counting one suggestion; counters change only on 'ok'.
create function public.check_recipe_tags_limit(p_user_id uuid)
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
  if v_requests >= 20 or v_usage.suggestions >= 100 then
    return 'user_limit';
  end if;

  update private.recipe_tags_usage
  set requests_this_minute = v_requests + 1,
      minute_start = v_minute,
      suggestions = suggestions + 1
  where user_id = p_user_id and day = v_day;

  return 'ok';
end;
$$;

-- match-recipe-steps (spec 6.8): per user, 30 matches a minute and 300 a day. Returns 'ok' or
-- 'user_limit', counting one match; counters change only on 'ok'.
create function public.check_step_match_limit(p_user_id uuid)
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
  if v_requests >= 30 or v_usage.matches >= 300 then
    return 'user_limit';
  end if;

  update private.step_match_usage
  set requests_this_minute = v_requests + 1,
      minute_start = v_minute,
      matches = matches + 1
  where user_id = p_user_id and day = v_day;

  return 'ok';
end;
$$;

-- recipe-photos (spec 6.9): per user, 10 requests a minute and 50 a day. Returns 'ok' or
-- 'user_limit', counting one request; counters change only on 'ok'.
create function public.check_recipe_photos_limit(p_user_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_day date := (now() at time zone 'utc')::date;
  v_minute timestamptz := date_trunc('minute', now());
  v_usage private.recipe_photos_usage;
  v_requests integer;
begin
  if p_user_id is null then
    raise exception 'p_user_id is required' using errcode = '22023';
  end if;

  insert into private.recipe_photos_usage (user_id, day, minute_start)
  values (p_user_id, v_day, v_minute)
  on conflict (user_id, day) do nothing;

  select * into v_usage from private.recipe_photos_usage
  where user_id = p_user_id and day = v_day
  for update;

  v_requests := case when v_usage.minute_start = v_minute then v_usage.requests_this_minute else 0 end;
  if v_requests >= 10 or v_usage.requests >= 50 then
    return 'user_limit';
  end if;

  update private.recipe_photos_usage
  set requests_this_minute = v_requests + 1,
      minute_start = v_minute,
      requests = requests + 1
  where user_id = p_user_id and day = v_day;

  return 'ok';
end;
$$;

-- import-recipe-photo (spec 6.10): per user, 5 photo imports a minute and 30 a day. Returns 'ok'
-- or 'user_limit', counting one import; counters change only on 'ok'.
create function public.check_recipe_photo_limit(p_user_id uuid)
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
  if v_imports >= 5 or v_usage.imports >= 30 then
    return 'user_limit';
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
-- 'not_found' or 'already_generated' with a null household. The recipe row is locked first, so two
-- calls for the same recipe can't both reserve.
create function public.reserve_recipe_photo_ai(p_user_id uuid, p_recipe_id uuid)
returns table (status text, household_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_household_id uuid;
  v_row private.recipe_photo_ai;
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

revoke all on function public.check_categorize_limit(uuid, integer) from public, anon, authenticated;
revoke all on function public.check_recipe_import_limit(uuid) from public, anon, authenticated;
revoke all on function public.check_recipe_tags_limit(uuid) from public, anon, authenticated;
revoke all on function public.check_step_match_limit(uuid) from public, anon, authenticated;
revoke all on function public.check_recipe_photos_limit(uuid) from public, anon, authenticated;
revoke all on function public.check_recipe_photo_limit(uuid) from public, anon, authenticated;
revoke all on function public.reserve_recipe_photo_ai(uuid, uuid) from public, anon, authenticated;
grant execute on function public.check_categorize_limit(uuid, integer) to service_role;
grant execute on function public.check_recipe_import_limit(uuid) to service_role;
grant execute on function public.check_recipe_tags_limit(uuid) to service_role;
grant execute on function public.check_step_match_limit(uuid) to service_role;
grant execute on function public.check_recipe_photos_limit(uuid) to service_role;
grant execute on function public.check_recipe_photo_limit(uuid) to service_role;
grant execute on function public.reserve_recipe_photo_ai(uuid, uuid) to service_role;

-- The retention jobs, same names and times, now pruning only the usage tables (cron.schedule with
-- an existing name replaces that job).
select cron.schedule(
  'categorize-usage-retention',
  '23 3 * * *',
  $$delete from private.categorize_usage where day < (now() at time zone 'utc')::date - 1$$
);
select cron.schedule(
  'recipe-import-usage-retention',
  '31 3 * * *',
  $$delete from private.recipe_import_usage where day < (now() at time zone 'utc')::date - 1$$
);
select cron.schedule(
  'recipe-tags-usage-retention',
  '33 3 * * *',
  $$delete from private.recipe_tags_usage where day < (now() at time zone 'utc')::date - 1$$
);
select cron.schedule(
  'step-match-usage-retention',
  '37 3 * * *',
  $$delete from private.step_match_usage where day < (now() at time zone 'utc')::date - 1$$
);
select cron.schedule(
  'recipe-photos-usage-retention',
  '41 3 * * *',
  $$delete from private.recipe_photos_usage where day < (now() at time zone 'utc')::date - 1$$
);
select cron.schedule(
  'recipe-photo-import-usage-retention',
  '47 3 * * *',
  $$delete from private.recipe_photo_import_usage where day < (now() at time zone 'utc')::date - 1$$
);
