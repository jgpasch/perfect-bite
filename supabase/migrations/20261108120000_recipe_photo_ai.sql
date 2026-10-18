-- AI photos (spec 4.5, 4.12, 5, 6.11): the `recipe_photo_ai` feature, on plus only, and
-- private.recipe_photo_ai, which records that a recipe has had its one AI photo.
--
-- generate-recipe-photo reserves a slot (reserve_recipe_photo_ai), makes the photo, uploads it to
-- recipe-photos and completes the slot (complete_recipe_photo_ai), or releases it on a failure
-- (release_recipe_photo_ai) so a failed generation doesn't use the recipe's one photo. A done row
-- stays when the photo is later removed or replaced: a recipe gets one AI photo, ever. The table
-- isn't synced; nobody but the service role can touch it or call the functions.
--
-- complete_recipe_photo_ai queues the new object in private.recipe_photo_deletions, so a photo the
-- app never sets as photo_path (killed mid-way) is removed by the existing cleanup, while one it
-- does set is dropped from the queue by claim_recipe_photo_deletions (entries are only claimed an
-- hour after they're queued).
--
-- The global cap counts reservations made today (UTC), in private.recipe_photo_ai_daily_total, as
-- the other AI functions' caps do. A released slot isn't given back, since its model calls were
-- still made; a call refused for the cap uses no budget.

alter table public.plan_features drop constraint plan_features_feature_check;
alter table public.plan_features add constraint plan_features_feature_check
  check (feature in ('categorize', 'recipe_import', 'recipe_import_photo', 'recipe_tags', 'step_ingredients', 'recipe_photo_ai'));

insert into public.plan_features (plan_id, feature) values ('plus', 'recipe_photo_ai')
on conflict do nothing;

create table private.recipe_photo_ai (
  recipe_id    uuid primary key references public.recipes on delete cascade,
  household_id uuid not null,
  created_by   uuid references auth.users on delete set null,
  description  text,
  path         text,
  status       text not null check (status in ('pending', 'done')),
  created_at   timestamptz not null default now()
);

create table private.recipe_photo_ai_daily_total (
  day    date primary key,
  photos integer not null default 0
);

revoke all on table private.recipe_photo_ai, private.recipe_photo_ai_daily_total from public, anon, authenticated;
alter table private.recipe_photo_ai enable row level security;
alter table private.recipe_photo_ai_daily_total enable row level security;

-- One row: status 'ok' with the recipe's household, or 'not_found', 'already_generated' or
-- 'global_cap' with a null household. The recipe row is locked first, so two calls for the same
-- recipe can't both reserve, then the day's total, so concurrent calls can't slip past the cap.
create function public.reserve_recipe_photo_ai(p_user_id uuid, p_recipe_id uuid, p_daily_cap integer)
returns table (status text, household_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_day date := (now() at time zone 'utc')::date;
  v_household_id uuid;
  v_row private.recipe_photo_ai;
  v_total integer;
begin
  if p_user_id is null or p_recipe_id is null then
    raise exception 'p_user_id and p_recipe_id are required' using errcode = '22023';
  end if;
  if p_daily_cap is null or p_daily_cap < 0 then
    raise exception 'p_daily_cap must be >= 0' using errcode = '22023';
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

  insert into private.recipe_photo_ai_daily_total (day) values (v_day)
  on conflict (day) do nothing;

  select t.photos into v_total from private.recipe_photo_ai_daily_total t
  where t.day = v_day
  for update;

  if v_total >= p_daily_cap then
    return query select 'global_cap'::text, null::uuid;
    return;
  end if;

  update private.recipe_photo_ai_daily_total t set photos = t.photos + 1 where t.day = v_day;

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

-- Marks the recipe's slot done with what was made, and queues the object for cleanup in case the
-- app never sets it as photo_path. The path is queued even when the slot is gone (the recipe was
-- deleted while its photo was made), so the object never lingers. Returns whether a pending slot
-- was completed.
create function public.complete_recipe_photo_ai(p_recipe_id uuid, p_description text, p_path text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_found boolean;
begin
  if p_recipe_id is null or p_path is null then
    raise exception 'p_recipe_id and p_path are required' using errcode = '22023';
  end if;

  update private.recipe_photo_ai
  set status = 'done', description = p_description, path = p_path
  where recipe_id = p_recipe_id and status = 'pending';
  v_found := found;

  insert into private.recipe_photo_deletions (path) values (p_path);

  return v_found;
end;
$$;

-- Gives the recipe its slot back after a failed generation. A done slot is never released.
create function public.release_recipe_photo_ai(p_recipe_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  delete from private.recipe_photo_ai where recipe_id = p_recipe_id and status = 'pending';
$$;

revoke all on function public.reserve_recipe_photo_ai(uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.complete_recipe_photo_ai(uuid, text, text) from public, anon, authenticated;
revoke all on function public.release_recipe_photo_ai(uuid) from public, anon, authenticated;
grant execute on function public.reserve_recipe_photo_ai(uuid, uuid, integer) to service_role;
grant execute on function public.complete_recipe_photo_ai(uuid, text, text) to service_role;
grant execute on function public.release_recipe_photo_ai(uuid) to service_role;

-- Retention, daily at 03:47 UTC: old daily totals.
select cron.schedule(
  'recipe-photo-ai-total-retention',
  '47 3 * * *',
  $$delete from private.recipe_photo_ai_daily_total where day < (now() at time zone 'utc')::date - 30$$
);
