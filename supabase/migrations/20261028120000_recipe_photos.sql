-- recipe-photos (spec 4.5, 6.9): the rate limits for reading a recipe page's photos, the same
-- approach and numbers as import-recipe's (20261011040000_recipe_import.sql): per user, 10
-- requests a minute and 50 a day; across everyone, a daily cap the Edge Function passes in
-- (RECIPE_PHOTOS_DAILY_CAP). Days are UTC. No plan feature and nothing cached, so no other tables.

create table private.recipe_photos_usage (
  user_id uuid not null references auth.users on delete cascade,
  day date not null,
  requests_this_minute integer not null default 0,
  minute_start timestamptz not null,          -- start of the fixed one-minute window
  requests integer not null default 0,        -- requests today
  primary key (user_id, day)
);

create table private.recipe_photos_daily_total (
  day date primary key,
  requests integer not null default 0
);

revoke all on table private.recipe_photos_usage, private.recipe_photos_daily_total from public, anon, authenticated;
alter table private.recipe_photos_usage enable row level security;
alter table private.recipe_photos_daily_total enable row level security;

-- Returns 'ok', 'user_limit' or 'global_cap', counting one request. Counters change only on 'ok', so
-- a refused request uses no budget. Rows are locked (user row first, then the day's total) so
-- concurrent requests can't both slip under a limit.
create function public.check_recipe_photos_limit(p_user_id uuid, p_daily_cap integer)
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
  v_total integer;
begin
  if p_user_id is null then
    raise exception 'p_user_id is required' using errcode = '22023';
  end if;
  if p_daily_cap is null or p_daily_cap < 0 then
    raise exception 'p_daily_cap must be >= 0' using errcode = '22023';
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

  insert into private.recipe_photos_daily_total (day) values (v_day)
  on conflict (day) do nothing;

  select requests into v_total from private.recipe_photos_daily_total
  where day = v_day
  for update;

  if v_total >= p_daily_cap then
    return 'global_cap';
  end if;

  update private.recipe_photos_daily_total set requests = requests + 1 where day = v_day;
  update private.recipe_photos_usage
  set requests_this_minute = v_requests + 1,
      minute_start = v_minute,
      requests = requests + 1
  where user_id = p_user_id and day = v_day;

  return 'ok';
end;
$$;

revoke all on function public.check_recipe_photos_limit(uuid, integer) from public, anon, authenticated;
grant execute on function public.check_recipe_photos_limit(uuid, integer) to service_role;

-- Retention, daily at 03:41 UTC: old usage rows.
select cron.schedule(
  'recipe-photos-usage-retention',
  '41 3 * * *',
  $$delete from private.recipe_photos_usage where day < (now() at time zone 'utc')::date - 1;
    delete from private.recipe_photos_daily_total where day < (now() at time zone 'utc')::date - 30$$
);
