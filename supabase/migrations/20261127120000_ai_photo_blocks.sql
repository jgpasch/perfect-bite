-- Blocking a user's AI photos (spec 6.11, 5). Each refused AI photo prompt (a flagged moderation
-- check or a refused image call, both `refused` rows in ai_calls) is a content-policy strike, and
-- the image model's refusals count against our OpenAI account. A user with 3 of them in 30 days is
-- blocked: private.ai_photo_blocks gets a row, written by a trigger on ai_calls, with an
-- admin.admin_actions row (`block_ai_photos`, performed_by null: nobody did it by hand) so it shows
-- in the portal's activity. reserve_recipe_photo_ai answers `blocked` for them before anything
-- else, until an admin clears the block.
--
-- A `not_food` description isn't a strike: the description model refusing a recipe is it doing its
-- job, costs nothing and isn't seen by OpenAI.

-- The rule's numbers, named in the spec (6.11).
create function private.ai_photo_block_threshold()
returns integer
language sql
immutable
set search_path = ''
as $$ select 3 $$;

create function private.ai_photo_block_window()
returns interval
language sql
immutable
set search_path = ''
as $$ select interval '30 days' $$;

-- The automatic block's audit row has no admin.
alter table admin.admin_actions alter column performed_by drop not null;

create table private.ai_photo_blocks (
  user_id      uuid primary key references auth.users on delete cascade,
  blocked_at   timestamptz not null default now(),
  refusals     integer not null,
  last_call_id uuid references public.ai_calls on delete set null
);

revoke all on table private.ai_photo_blocks from public, anon, authenticated;
alter table private.ai_photo_blocks enable row level security;

-- The one place for what counts: the user's refused moderation checks and image calls since
-- p_since. Used by the trigger, the portal and the tests.
create function private.ai_photo_refusals(p_user_id uuid, p_since timestamptz)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::integer
  from public.ai_calls c
  where c.user_id = p_user_id
    and c.task in ('recipePhotoModeration', 'recipePhotoImage')
    and c.status = 'refused'
    and c.created_at >= p_since;
$$;

revoke all on function private.ai_photo_refusals(uuid, timestamptz) from public, anon, authenticated;

create function private.block_ai_photos_on_refusal()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_refusals integer;
begin
  if new.user_id is null
     or new.status <> 'refused'
     or new.task not in ('recipePhotoModeration', 'recipePhotoImage') then
    return null;
  end if;

  -- Two refusals at once both see the other's row.
  perform pg_advisory_xact_lock(hashtextextended('ai_photo_blocks:' || new.user_id::text, 0));

  if exists (select 1 from private.ai_photo_blocks b where b.user_id = new.user_id) then
    return null;
  end if;

  v_refusals := private.ai_photo_refusals(new.user_id, now() - private.ai_photo_block_window());
  if v_refusals < private.ai_photo_block_threshold() then
    return null;
  end if;

  insert into private.ai_photo_blocks (user_id, refusals, last_call_id)
  values (new.user_id, v_refusals, new.id);

  insert into admin.admin_actions (action, target_user_id, performed_by, details)
  values ('block_ai_photos', new.user_id, null, jsonb_build_object(
    'refusals', v_refusals,
    'window_days', extract(day from private.ai_photo_block_window())::integer
  ));

  return null;
end;
$$;

revoke all on function private.block_ai_photos_on_refusal() from public, anon, authenticated;

create trigger ai_calls_block_ai_photos
  after insert on public.ai_calls
  for each row execute function private.block_ai_photos_on_refusal();

-- generate-recipe-photo (spec 6.11): one row, status 'ok' with the recipe's household, or
-- 'blocked' (the user's AI photos are blocked, checked first, so no slot or budget is used),
-- 'not_found', 'already_generated' or 'monthly_limit' (the user has reserved their plan's monthly
-- number) with a null household, checked in that order; nothing is written unless 'ok'. The recipe
-- row is locked first, so two calls for the same recipe can't both reserve, and a per-user advisory
-- lock keeps two recipes' calls from both slipping under the monthly limit.
create or replace function public.reserve_recipe_photo_ai(p_user_id uuid, p_recipe_id uuid)
returns table (status text, household_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_household_id uuid;
  v_row private.recipe_photo_ai;
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
  v_limit := private.monthly_limit(p_user_id, 'recipe_photo_ai');
  if v_limit is not null and private.monthly_usage(p_user_id, 'recipe_photo_ai') >= v_limit then
    return query select 'monthly_limit'::text, null::uuid;
    return;
  end if;

  insert into private.recipe_photo_ai_usage as u (user_id, day, photos)
  values (p_user_id, (now() at time zone 'utc')::date, 1)
  on conflict (user_id, day) do update set photos = u.photos + 1;

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
