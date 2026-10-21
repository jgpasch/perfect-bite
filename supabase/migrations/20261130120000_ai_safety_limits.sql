-- Safety limits in a table (spec 4.12 Safety limits, 5, 6.4–6.11). Per user, the same on every
-- plan: a per-minute limit that stops a client stuck in a loop and a daily one that stops a
-- scripted account. They were hard-coded numbers in each check function; now they're rows in
-- public.ai_safety_limits, read on every call, so an admin's change applies at once. Null is no
-- limit.
--
-- Each check answers, in order: 'user_limit' (per minute), 'daily_limit' (the user's UTC day on the
-- per-user usage tables; both import tables for `recipe_import`), then the monthly check, all
-- before anything is counted. Categorize, Suggest tags and step matching aren't plan features, so
-- they drop their monthly check. reserve_recipe_photo_ai keeps 'blocked' first, before any limit.
--
-- A null limit makes its comparison null, which `if` treats as false, so the check is skipped.
--
-- The portal reads and edits the table through admin_list_safety_limits and
-- admin_set_safety_limit (audited `set_safety_limit`).

create table public.ai_safety_limits (
  key        text primary key check (key in ('categorize', 'step_match', 'recipe_tags', 'recipe_import_link', 'recipe_import_photo', 'recipe_import', 'recipe_photo_ai')),
  per_minute integer check (per_minute >= 0),
  per_day    integer check (per_day >= 0)
);

comment on table public.ai_safety_limits is
  'Per-user safety limits for the AI features, the same on every plan (spec 4.12). per_minute '
  'counts requests a minute; per_day counts a UTC day in the feature''s units (categorize: names '
  'sent to the LLM; recipe_import: link and photo imports together; the rest: requests). A null '
  'is no limit. Read on every call, so a change applies at once.';

alter table public.ai_safety_limits enable row level security;
revoke all on table public.ai_safety_limits from public, anon, authenticated;

insert into public.ai_safety_limits (key, per_minute, per_day) values
  ('categorize', 60, 500),
  ('step_match', 30, 100),
  ('recipe_tags', 20, 50),
  ('recipe_import_link', 10, null),
  ('recipe_import_photo', 5, null),
  ('recipe_import', null, 100),
  ('recipe_photo_ai', null, 40);

-- The keys in the portal's order (the table's check).
create function private.safety_limit_keys()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array['categorize', 'step_match', 'recipe_tags', 'recipe_import_link', 'recipe_import_photo', 'recipe_import', 'recipe_photo_ai'];
$$;

-- A key's row; all null (no limits) for a key with no row.
create function private.safety_limit(p_key text)
returns public.ai_safety_limits
language sql
stable
security definer
set search_path = ''
as $$
  select * from public.ai_safety_limits s where s.key = p_key;
$$;

revoke all on function private.safety_limit_keys() from public, anon, authenticated, service_role;
revoke all on function private.safety_limit(text) from public, anon, authenticated, service_role;

-- AI photos gain a per-minute window, like the other usage tables.
alter table private.recipe_photo_ai_usage
  add column minute_start timestamptz,
  add column requests_this_minute integer not null default 0;

-- ---------------------------------------------------------------------------
-- The checks.
-- ---------------------------------------------------------------------------

-- categorize-ingredients (spec 6.4): per user, `categorize`'s requests a minute and LLM-bound names
-- a day (the day's names plus p_new_names; checked only when p_new_names > 0). No monthly limit. A
-- null p_user_id (the pg_cron sweep) has no limits. The user's row is locked so concurrent requests
-- can't both slip under. Returns 'ok', 'user_limit' or 'daily_limit'; counters change only on 'ok'.
create or replace function public.check_categorize_limit(p_user_id uuid, p_new_names integer)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_day date := (now() at time zone 'utc')::date;
  v_minute timestamptz := date_trunc('minute', now());
  v_limit public.ai_safety_limits;
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

  v_limit := private.safety_limit('categorize');
  v_requests := case when v_usage.minute_start = v_minute then v_usage.requests_this_minute else 0 end;
  if v_requests >= v_limit.per_minute then
    return 'user_limit';
  end if;
  if p_new_names > 0 and v_usage.new_names + p_new_names > v_limit.per_day then
    return 'daily_limit';
  end if;

  update private.categorize_usage
  set requests_this_minute = v_requests + 1,
      minute_start = v_minute,
      new_names = new_names + p_new_names
  where user_id = p_user_id and day = v_day;

  return 'ok';
end;
$$;

-- suggest-recipe-tags (spec 6.7): per user, `recipe_tags`' suggestions a minute and a day. No
-- monthly limit. Returns 'ok', 'user_limit' or 'daily_limit', counting one suggestion; counters
-- change only on 'ok'.
create or replace function public.check_recipe_tags_limit(p_user_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_day date := (now() at time zone 'utc')::date;
  v_minute timestamptz := date_trunc('minute', now());
  v_limit public.ai_safety_limits;
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

  v_limit := private.safety_limit('recipe_tags');
  v_requests := case when v_usage.minute_start = v_minute then v_usage.requests_this_minute else 0 end;
  if v_requests >= v_limit.per_minute then
    return 'user_limit';
  end if;
  if v_usage.suggestions >= v_limit.per_day then
    return 'daily_limit';
  end if;

  update private.recipe_tags_usage
  set requests_this_minute = v_requests + 1,
      minute_start = v_minute,
      suggestions = suggestions + 1
  where user_id = p_user_id and day = v_day;

  return 'ok';
end;
$$;

-- match-recipe-steps (spec 6.8): per user, `step_match`'s matches a minute and a day. No monthly
-- limit. Returns 'ok', 'user_limit' or 'daily_limit', counting one match; counters change only on
-- 'ok'.
create or replace function public.check_step_match_limit(p_user_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_day date := (now() at time zone 'utc')::date;
  v_minute timestamptz := date_trunc('minute', now());
  v_limit public.ai_safety_limits;
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

  v_limit := private.safety_limit('step_match');
  v_requests := case when v_usage.minute_start = v_minute then v_usage.requests_this_minute else 0 end;
  if v_requests >= v_limit.per_minute then
    return 'user_limit';
  end if;
  if v_usage.matches >= v_limit.per_day then
    return 'daily_limit';
  end if;

  update private.step_match_usage
  set requests_this_minute = v_requests + 1,
      minute_start = v_minute,
      matches = matches + 1
  where user_id = p_user_id and day = v_day;

  return 'ok';
end;
$$;

-- The safety answer for one import, link or photo: 'user_limit' when this kind's per-minute
-- limit is reached (p_key's row) or both kinds' together (`recipe_import`'s row), 'daily_limit'
-- likewise for the day, else 'ok'. p_minute and p_today are this kind's counts; the other kind's
-- are read from its table. The caller holds the user's import lock.
create function private.recipe_import_safety(p_user_id uuid, p_key text, p_minute integer, p_today integer)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_day date := (now() at time zone 'utc')::date;
  v_minute timestamptz := date_trunc('minute', now());
  v_own public.ai_safety_limits := private.safety_limit(p_key);
  v_all public.ai_safety_limits := private.safety_limit('recipe_import');
  v_other_minute integer;
  v_other_today integer;
begin
  if p_key = 'recipe_import_link' then
    select coalesce(sum(case when u.minute_start = v_minute then u.imports_this_minute else 0 end), 0),
           coalesce(sum(u.imports), 0)
    into v_other_minute, v_other_today
    from private.recipe_photo_import_usage u where u.user_id = p_user_id and u.day = v_day;
  else
    select coalesce(sum(case when u.minute_start = v_minute then u.requests_this_minute else 0 end), 0),
           coalesce(sum(u.imports), 0)
    into v_other_minute, v_other_today
    from private.recipe_import_usage u where u.user_id = p_user_id and u.day = v_day;
  end if;

  if p_minute >= v_own.per_minute or p_minute + v_other_minute >= v_all.per_minute then
    return 'user_limit';
  end if;
  if p_today >= v_own.per_day or p_today + v_other_today >= v_all.per_day then
    return 'daily_limit';
  end if;
  return 'ok';
end;
$$;

revoke all on function private.recipe_import_safety(uuid, text, integer, integer) from public, anon, authenticated, service_role;

-- import-recipe (spec 6.6): per user, `recipe_import_link`'s imports a minute, `recipe_import`'s
-- link and photo imports a day, then the plan's monthly limit. Returns 'ok', 'user_limit',
-- 'daily_limit' or 'monthly_limit', counting one import; counters change only on 'ok'. A per-user
-- lock, shared with photo import, keeps the two kinds from both slipping under the shared limits.
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
  v_safety text;
  v_limit integer;
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
  v_safety := private.recipe_import_safety(p_user_id, 'recipe_import_link', v_requests, v_usage.imports);
  if v_safety <> 'ok' then
    return v_safety;
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

-- import-recipe-photo (spec 6.10): per user, `recipe_import_photo`'s photo imports a minute,
-- `recipe_import`'s link and photo imports a day, then the plan's monthly limit. Returns 'ok',
-- 'user_limit', 'daily_limit' or 'monthly_limit', counting one import; counters change only on
-- 'ok'.
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
  v_safety text;
  v_limit integer;
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
  v_safety := private.recipe_import_safety(p_user_id, 'recipe_import_photo', v_imports, v_usage.imports);
  if v_safety <> 'ok' then
    return v_safety;
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
-- 'blocked' (the user's AI photos are blocked, checked first, so no slot or budget is used),
-- 'not_found', 'already_generated', 'user_limit' or 'daily_limit' (`recipe_photo_ai`'s safety
-- limits) or 'monthly_limit' (the user has reserved their plan's monthly number) with a null
-- household, checked in that order; nothing is written unless 'ok'. The recipe row is locked first,
-- so two calls for the same recipe can't both reserve, and a per-user advisory lock keeps two
-- recipes' calls from both slipping under the limits.
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
  v_limit integer;
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

  v_limit := private.monthly_limit(p_user_id, 'recipe_photo_ai');
  if v_limit is not null and private.monthly_usage(p_user_id, 'recipe_photo_ai') >= v_limit then
    return query select 'monthly_limit'::text, null::uuid;
    return;
  end if;

  insert into private.recipe_photo_ai_usage as u (user_id, day, photos, minute_start, requests_this_minute)
  values (p_user_id, v_day, 1, v_minute, 1)
  on conflict (user_id, day) do update
    set photos = u.photos + 1,
        minute_start = v_minute,
        requests_this_minute = v_requests + 1;

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
-- The portal (spec 4.12). Like the plan functions: `public`, `security definer`,
-- private.require_admin() first, executable by `authenticated` only.
-- ---------------------------------------------------------------------------

-- admin_list_safety_limits: every key in the fixed order with its per_minute and per_day (null for
-- none). Read-only, so no audit row.
create function public.admin_list_safety_limits()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_admin();

  return coalesce((
    select jsonb_agg(jsonb_build_object('key', s.key, 'per_minute', s.per_minute, 'per_day', s.per_day) order by k.ord)
    from unnest(private.safety_limit_keys()) with ordinality as k (key, ord)
    join public.ai_safety_limits s on s.key = k.key
  ), '[]');
end;
$$;

-- admin_set_safety_limit: sets a key's per_minute and per_day (null for no limit). Takes effect on
-- the next call. Raises `unknown key` (P0002), `note required` (22023) or, for a negative number,
-- the table's check (23514), changing nothing; otherwise writes one admin.admin_actions row
-- (`set_safety_limit`, details { before, after }, each { key, per_minute, per_day }), even when
-- nothing changes, and returns the details.
create function public.admin_set_safety_limit(p_key text, p_per_minute integer, p_per_day integer, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_before public.ai_safety_limits;
  v_after public.ai_safety_limits;
  v_details jsonb;
begin
  perform private.require_admin();

  select * into v_before from public.ai_safety_limits s where s.key = p_key for update;
  if not found then
    raise exception 'unknown key' using errcode = 'P0002';
  end if;
  perform private.require_note(p_note);

  update public.ai_safety_limits s
  set per_minute = p_per_minute, per_day = p_per_day
  where s.key = p_key
  returning * into v_after;

  v_details := jsonb_build_object('before', to_jsonb(v_before), 'after', to_jsonb(v_after));
  insert into admin.admin_actions (action, details, note, performed_by)
  values ('set_safety_limit', v_details, p_note, auth.uid()::text);
  return v_details;
end;
$$;

revoke all on function public.admin_list_safety_limits() from public, anon, service_role;
grant execute on function public.admin_list_safety_limits() to authenticated;
revoke all on function public.admin_set_safety_limit(text, integer, integer, text) from public, anon, service_role;
grant execute on function public.admin_set_safety_limit(text, integer, integer, text) to authenticated;
