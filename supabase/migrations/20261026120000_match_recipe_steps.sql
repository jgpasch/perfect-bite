-- match-recipe-steps (spec 4.5, 4.12, 6.8): the `step_ingredients` feature, on standard and plus,
-- and the rate limits, the same approach as suggest-recipe-tags (20261013200000_suggest_recipe_tags.sql):
-- per user, 30 matches a minute and 300 a day; across everyone, a daily cap the Edge Function
-- passes in (STEP_MATCH_DAILY_CAP). Days are UTC. Nothing is cached, so there's no table for results.

alter table public.plan_features drop constraint plan_features_feature_check;
alter table public.plan_features add constraint plan_features_feature_check
  check (feature in ('categorize', 'recipe_import', 'recipe_import_photo', 'recipe_tags', 'step_ingredients'));

-- Base doesn't get it.
insert into public.plan_features (plan_id, feature) values ('standard', 'step_ingredients'), ('plus', 'step_ingredients')
on conflict do nothing;

create table private.step_match_usage (
  user_id uuid not null references auth.users on delete cascade,
  day date not null,
  requests_this_minute integer not null default 0,
  minute_start timestamptz not null,          -- start of the fixed one-minute window
  matches integer not null default 0,         -- matches today
  primary key (user_id, day)
);

create table private.step_match_daily_total (
  day date primary key,
  matches integer not null default 0
);

revoke all on table private.step_match_usage, private.step_match_daily_total from public, anon, authenticated;
alter table private.step_match_usage enable row level security;
alter table private.step_match_daily_total enable row level security;

-- Returns 'ok', 'user_limit' or 'global_cap', counting one match. Counters change only on 'ok', so
-- a refused request uses no budget. Rows are locked (user row first, then the day's total) so
-- concurrent requests can't both slip under a limit.
create function public.check_step_match_limit(p_user_id uuid, p_daily_cap integer)
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
  v_total integer;
begin
  if p_user_id is null then
    raise exception 'p_user_id is required' using errcode = '22023';
  end if;
  if p_daily_cap is null or p_daily_cap < 0 then
    raise exception 'p_daily_cap must be >= 0' using errcode = '22023';
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

  insert into private.step_match_daily_total (day) values (v_day)
  on conflict (day) do nothing;

  select matches into v_total from private.step_match_daily_total
  where day = v_day
  for update;

  if v_total >= p_daily_cap then
    return 'global_cap';
  end if;

  update private.step_match_daily_total set matches = matches + 1 where day = v_day;
  update private.step_match_usage
  set requests_this_minute = v_requests + 1,
      minute_start = v_minute,
      matches = matches + 1
  where user_id = p_user_id and day = v_day;

  return 'ok';
end;
$$;

revoke all on function public.check_step_match_limit(uuid, integer) from public, anon, authenticated;
grant execute on function public.check_step_match_limit(uuid, integer) to service_role;

-- Retention, daily at 03:37 UTC: old usage rows.
select cron.schedule(
  'step-match-usage-retention',
  '37 3 * * *',
  $$delete from private.step_match_usage where day < (now() at time zone 'utc')::date - 1;
    delete from private.step_match_daily_total where day < (now() at time zone 'utc')::date - 30$$
);
