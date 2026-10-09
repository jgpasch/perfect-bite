-- Rate limits for categorize-ingredients (spec 6.4): per user, 60 requests a minute and 500 new
-- (LLM-bound) names a day; across everyone, a daily cap on new names that the Edge Function
-- passes in (CATEGORIZE_DAILY_NAME_CAP). Days are UTC.
--
-- The tables live in `private` (not exposed through the API). The check function lives in
-- `public` because only `public` is exposed to PostgREST, so the Edge Function can call it with
-- `supabaseAdmin.rpc`; execute is granted to service_role only.

create table private.categorize_usage (
  user_id uuid not null references auth.users on delete cascade,
  day date not null,
  requests_this_minute integer not null default 0,
  minute_start timestamptz not null,          -- start of the fixed one-minute window
  new_names integer not null default 0,       -- names sent to the LLM today
  primary key (user_id, day)
);

create table private.categorize_daily_total (
  day date primary key,
  new_names integer not null default 0
);

revoke all on table private.categorize_usage, private.categorize_daily_total from public, anon, authenticated;
alter table private.categorize_usage enable row level security;
alter table private.categorize_daily_total enable row level security;

-- Returns 'ok', 'user_limit' or 'global_cap'. Counters change only on 'ok', so a refused request
-- uses no budget. Every request counts toward the per-minute limit; the daily name limits apply
-- only when p_new_names > 0, so a request answered entirely from the database always passes the
-- global cap. A null p_user_id (the pg_cron sweep) skips the per-user checks. Rows are locked
-- (user row first, then the day's total) so concurrent requests can't both slip under a limit.
create function public.check_categorize_limit(p_user_id uuid, p_new_names integer, p_daily_cap integer)
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
  v_total integer;
begin
  if p_new_names is null or p_new_names < 0 then
    raise exception 'p_new_names must be >= 0' using errcode = '22023';
  end if;
  if p_daily_cap is null or p_daily_cap < 0 then
    raise exception 'p_daily_cap must be >= 0' using errcode = '22023';
  end if;

  if p_user_id is not null then
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
  end if;

  if p_new_names > 0 then
    insert into private.categorize_daily_total (day) values (v_day)
    on conflict (day) do nothing;

    select new_names into v_total from private.categorize_daily_total
    where day = v_day
    for update;

    if v_total + p_new_names > p_daily_cap then
      return 'global_cap';
    end if;

    update private.categorize_daily_total set new_names = new_names + p_new_names where day = v_day;
  end if;

  if p_user_id is not null then
    update private.categorize_usage
    set requests_this_minute = v_requests + 1,
        minute_start = v_minute,
        new_names = new_names + p_new_names
    where user_id = p_user_id and day = v_day;
  end if;

  return 'ok';
end;
$$;

revoke all on function public.check_categorize_limit(uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.check_categorize_limit(uuid, integer, integer) to service_role;

-- Retention: only today's rows matter; drop older ones daily at 03:23 UTC.
select cron.schedule(
  'categorize-usage-retention',
  '23 3 * * *',
  $$delete from private.categorize_usage where day < (now() at time zone 'utc')::date - 1;
    delete from private.categorize_daily_total where day < (now() at time zone 'utc')::date - 30$$
);
