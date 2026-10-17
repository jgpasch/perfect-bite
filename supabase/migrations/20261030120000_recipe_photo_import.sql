-- import-recipe-photo (spec 6.10): the rate limits for importing a recipe from photos, the same
-- approach as import-recipe's (20261011040000_recipe_import.sql) with lower numbers, since a call
-- reads up to three images: per user, 5 imports a minute and 30 a day; across everyone, a daily cap
-- the Edge Function passes in (RECIPE_PHOTO_DAILY_CAP, default 300). Days are UTC. Nothing is
-- cached and no image is stored, so no other tables.

create table private.recipe_photo_import_usage (
  user_id uuid not null references auth.users on delete cascade,
  day date not null,
  imports_this_minute integer not null default 0,
  minute_start timestamptz not null,          -- start of the fixed one-minute window
  imports integer not null default 0,         -- imports today
  primary key (user_id, day)
);

create table private.recipe_photo_import_daily_total (
  day date primary key,
  imports integer not null default 0
);

revoke all on table private.recipe_photo_import_usage, private.recipe_photo_import_daily_total from public, anon, authenticated;
alter table private.recipe_photo_import_usage enable row level security;
alter table private.recipe_photo_import_daily_total enable row level security;

-- Returns 'ok', 'user_limit' or 'global_cap', counting one import. Counters change only on 'ok', so
-- a refused import uses no budget. Rows are locked (user row first, then the day's total) so
-- concurrent requests can't both slip under a limit.
create function public.check_recipe_photo_limit(p_user_id uuid, p_daily_cap integer)
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
  v_total integer;
begin
  if p_user_id is null then
    raise exception 'p_user_id is required' using errcode = '22023';
  end if;
  if p_daily_cap is null or p_daily_cap < 0 then
    raise exception 'p_daily_cap must be >= 0' using errcode = '22023';
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

  insert into private.recipe_photo_import_daily_total (day) values (v_day)
  on conflict (day) do nothing;

  select imports into v_total from private.recipe_photo_import_daily_total
  where day = v_day
  for update;

  if v_total >= p_daily_cap then
    return 'global_cap';
  end if;

  update private.recipe_photo_import_daily_total set imports = imports + 1 where day = v_day;
  update private.recipe_photo_import_usage
  set imports_this_minute = v_imports + 1,
      minute_start = v_minute,
      imports = imports + 1
  where user_id = p_user_id and day = v_day;

  return 'ok';
end;
$$;

revoke all on function public.check_recipe_photo_limit(uuid, integer) from public, anon, authenticated;
grant execute on function public.check_recipe_photo_limit(uuid, integer) to service_role;

-- Retention, daily at 03:47 UTC: old usage rows.
select cron.schedule(
  'recipe-photo-import-usage-retention',
  '47 3 * * *',
  $$delete from private.recipe_photo_import_usage where day < (now() at time zone 'utc')::date - 1;
    delete from private.recipe_photo_import_daily_total where day < (now() at time zone 'utc')::date - 30$$
);
