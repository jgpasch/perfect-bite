-- import-recipe (spec 6.6): the extraction cache and the rate limits.
--
-- `recipe_imports` caches extractions of server-fetched pages by canonical URL and prompt version
-- for 30 days, so a popular recipe costs one LLM call. A `not_a_recipe` answer is cached too.
-- Privacy (spec 6.5): no user id. Service role only: no client grants, RLS on with no policies.
--
-- Rate limits, the same approach as categorize (20261009230000_categorize_limit.sql): per user,
-- 10 imports a minute and 50 a day; across everyone, a daily cap the Edge Function passes in
-- (RECIPE_IMPORT_DAILY_CAP). Days are UTC. Every import counts, cache hits included, because the
-- check runs before the cache is read.

create table public.recipe_imports (
  url_key text not null,                     -- canonicalRecipeUrl(url)
  prompt_version text not null,              -- EXTRACT_RECIPE_PROMPT_VERSION
  result jsonb not null,                     -- the cleaned ExtractedRecipe
  is_recipe boolean not null,
  created_at timestamptz not null default now(),
  primary key (url_key, prompt_version)
);
create index recipe_imports_created_at_idx on public.recipe_imports (created_at);

revoke all on table public.recipe_imports from anon, authenticated;
alter table public.recipe_imports enable row level security;

create table private.recipe_import_usage (
  user_id uuid not null references auth.users on delete cascade,
  day date not null,
  requests_this_minute integer not null default 0,
  minute_start timestamptz not null,          -- start of the fixed one-minute window
  imports integer not null default 0,         -- imports today
  primary key (user_id, day)
);

create table private.recipe_import_daily_total (
  day date primary key,
  imports integer not null default 0
);

revoke all on table private.recipe_import_usage, private.recipe_import_daily_total from public, anon, authenticated;
alter table private.recipe_import_usage enable row level security;
alter table private.recipe_import_daily_total enable row level security;

-- Returns 'ok', 'user_limit' or 'global_cap', counting one import. Counters change only on 'ok',
-- so a refused request uses no budget. Rows are locked (user row first, then the day's total) so
-- concurrent requests can't both slip under a limit.
create function public.check_recipe_import_limit(p_user_id uuid, p_daily_cap integer)
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
  v_total integer;
begin
  if p_user_id is null then
    raise exception 'p_user_id is required' using errcode = '22023';
  end if;
  if p_daily_cap is null or p_daily_cap < 0 then
    raise exception 'p_daily_cap must be >= 0' using errcode = '22023';
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

  insert into private.recipe_import_daily_total (day) values (v_day)
  on conflict (day) do nothing;

  select imports into v_total from private.recipe_import_daily_total
  where day = v_day
  for update;

  if v_total >= p_daily_cap then
    return 'global_cap';
  end if;

  update private.recipe_import_daily_total set imports = imports + 1 where day = v_day;
  update private.recipe_import_usage
  set requests_this_minute = v_requests + 1,
      minute_start = v_minute,
      imports = imports + 1
  where user_id = p_user_id and day = v_day;

  return 'ok';
end;
$$;

revoke all on function public.check_recipe_import_limit(uuid, integer) from public, anon, authenticated;
grant execute on function public.check_recipe_import_limit(uuid, integer) to service_role;

-- Retention, daily: cache rows older than 30 days (03:29 UTC) and old usage rows (03:31 UTC).
select cron.schedule(
  'recipe-imports-retention',
  '29 3 * * *',
  $$delete from public.recipe_imports where created_at < now() - interval '30 days'$$
);
select cron.schedule(
  'recipe-import-usage-retention',
  '31 3 * * *',
  $$delete from private.recipe_import_usage where day < (now() at time zone 'utc')::date - 1;
    delete from private.recipe_import_daily_total where day < (now() at time zone 'utc')::date - 30$$
);
