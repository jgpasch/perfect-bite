-- photo-search (spec 4.5, 6.11): the rate limits and the answer cache for stock photo search.
--
-- Rate limits, the same approach as recipe-photos (20261028120000_recipe_photos.sql): per user,
-- 20 searches a minute and 100 a day; across everyone, a daily cap the Edge Function passes in
-- (PHOTO_SEARCH_DAILY_CAP). Days are UTC. A search answered from the cache counts against the
-- user's limits but not the global cap, which is there for Pexels' own quota.
--
-- `photo_search_cache` keeps Pexels' answer (already mapped to PhotoSearchResponse) for a query
-- key (lowercased, whitespace collapsed) and page for 24 hours. Privacy (spec 6.5): no user id.
-- Service role only, through the functions below: the tables are in `private`.

create table private.photo_search_usage (
  user_id uuid not null references auth.users on delete cascade,
  day date not null,
  requests_this_minute integer not null default 0,
  minute_start timestamptz not null,          -- start of the fixed one-minute window
  requests integer not null default 0,        -- searches today
  primary key (user_id, day)
);

create table private.photo_search_daily_total (
  day date primary key,
  requests integer not null default 0          -- searches today that reached Pexels
);

create table private.photo_search_cache (
  query_key text not null,                     -- photoSearchKey(query)
  page integer not null check (page between 1 and 10),
  answer jsonb not null,                       -- the PhotoSearchResponse
  fetched_at timestamptz not null default now(),
  primary key (query_key, page)
);
create index photo_search_cache_fetched_at_idx on private.photo_search_cache (fetched_at);

revoke all on table private.photo_search_usage, private.photo_search_daily_total, private.photo_search_cache
  from public, anon, authenticated;
alter table private.photo_search_usage enable row level security;
alter table private.photo_search_daily_total enable row level security;
alter table private.photo_search_cache enable row level security;

-- Returns 'ok', 'user_limit' or 'global_cap', counting one search. With p_cached (the answer
-- comes from the cache) the global cap is neither checked nor counted. Counters change only on
-- 'ok', so a refused search uses no budget. Rows are locked (user row first, then the day's
-- total) so concurrent searches can't both slip under a limit.
create function public.check_photo_search_limit(p_user_id uuid, p_daily_cap integer, p_cached boolean default false)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_day date := (now() at time zone 'utc')::date;
  v_minute timestamptz := date_trunc('minute', now());
  v_usage private.photo_search_usage;
  v_requests integer;
  v_total integer;
begin
  if p_user_id is null then
    raise exception 'p_user_id is required' using errcode = '22023';
  end if;
  if p_daily_cap is null or p_daily_cap < 0 then
    raise exception 'p_daily_cap must be >= 0' using errcode = '22023';
  end if;
  if p_cached is null then
    raise exception 'p_cached is required' using errcode = '22023';
  end if;

  insert into private.photo_search_usage (user_id, day, minute_start)
  values (p_user_id, v_day, v_minute)
  on conflict (user_id, day) do nothing;

  select * into v_usage from private.photo_search_usage
  where user_id = p_user_id and day = v_day
  for update;

  v_requests := case when v_usage.minute_start = v_minute then v_usage.requests_this_minute else 0 end;
  if v_requests >= 20 or v_usage.requests >= 100 then
    return 'user_limit';
  end if;

  if not p_cached then
    insert into private.photo_search_daily_total (day) values (v_day)
    on conflict (day) do nothing;

    select requests into v_total from private.photo_search_daily_total
    where day = v_day
    for update;

    if v_total >= p_daily_cap then
      return 'global_cap';
    end if;

    update private.photo_search_daily_total set requests = requests + 1 where day = v_day;
  end if;

  update private.photo_search_usage
  set requests_this_minute = v_requests + 1,
      minute_start = v_minute,
      requests = requests + 1
  where user_id = p_user_id and day = v_day;

  return 'ok';
end;
$$;

-- The cached answer for a key and page, or null when there's none from the last 24 hours.
create function public.get_photo_search_cache(p_query_key text, p_page integer)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select answer from private.photo_search_cache
  where query_key = p_query_key and page = p_page and fetched_at > now() - interval '24 hours'
$$;

-- Saves (or replaces) the answer for a key and page, fetched now.
create function public.save_photo_search_cache(p_query_key text, p_page integer, p_answer jsonb)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into private.photo_search_cache (query_key, page, answer, fetched_at)
  values (p_query_key, p_page, p_answer, now())
  on conflict (query_key, page) do update set answer = excluded.answer, fetched_at = excluded.fetched_at
$$;

revoke all on function public.check_photo_search_limit(uuid, integer, boolean) from public, anon, authenticated;
revoke all on function public.get_photo_search_cache(text, integer) from public, anon, authenticated;
revoke all on function public.save_photo_search_cache(text, integer, jsonb) from public, anon, authenticated;
grant execute on function public.check_photo_search_limit(uuid, integer, boolean) to service_role;
grant execute on function public.get_photo_search_cache(text, integer) to service_role;
grant execute on function public.save_photo_search_cache(text, integer, jsonb) to service_role;

-- Retention, daily at 03:47 UTC: old usage rows and cache rows over 24 hours old.
select cron.schedule(
  'photo-search-retention',
  '47 3 * * *',
  $$delete from private.photo_search_usage where day < (now() at time zone 'utc')::date - 1;
    delete from private.photo_search_daily_total where day < (now() at time zone 'utc')::date - 30;
    delete from private.photo_search_cache where fetched_at < now() - interval '24 hours'$$
);
