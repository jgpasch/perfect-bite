-- Share import commit (spec 6.12 Commit, 7.2, 7.3; plan §5, §6): commit_share_import applies a
-- share's planned writes, the recipe and its ingredients onto the list, in one transaction, and
-- marks the job done in the same transaction, so a share is never done before it's committed.
--
-- The worker resolves the destination, reads a snapshot and plans with the shared planner outside
-- any transaction (share-import-worker/commit.ts), then calls this with the plan:
--   p_target         { household_id, list_id (null: recipe-only), list_gone, recipe_id,
--                      items_added, items_combined }
--   p_writes         the planner's writes ({ op, table, id | key, fields, counters? }), in order
--   p_preconditions  the planner's preconditions ({ kind: combine | reopen | new | recipeAbsent |
--                    recipeReuse, ... })
-- It:
--   1. locks the job row: an existing `committed_at` returns the stored receipt (a retry or a lost
--      answer adds nothing); another status, lease token or an expired lease raises `lease_lost`
--      (55000);
--   2. rechecks that the sharer is in the target household and the list (if any) is live,
--      unarchived and in it, else `destination_changed` (40001);
--   3. takes the per-list advisory lock apply_mutation takes for open items;
--   4. checks every precondition, reading rows `for update`, else `plan_conflict` (40001);
--   5. applies every write through private.apply_mutation(write, user_id) with no subtransaction,
--      so any rejection rolls everything back, as the sharer (`app.actor_uid`). HLCs are assigned
--      here: device `srv`, the wall time the larger of clock_timestamp() in ms and the largest
--      field_clock wall among the touched rows plus 1 (so a reopen's `checked_at = null` beats a
--      device clock running ahead), the counter the write's index;
--   6. logs one `recipe.imported_from_share` activity entry for the sharer (the row triggers are
--      suppressed for the commit's writes, spec 4.12) and writes the receipt: `status = 'done'`,
--      lease and `page` cleared. Returns the receipt.
-- The contributions' inserts queue the household's "added" push (household_events) as a device's do.

-- ---------------------------------------------------------------------------
-- private.share_import_receipt: the receipt a done job returns.
-- ---------------------------------------------------------------------------

create function private.share_import_receipt(p_job public.share_imports)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'recipe_id', p_job.recipe_id,
    'applied_list_id', p_job.applied_list_id,
    'list_gone', p_job.list_gone,
    'items_added', p_job.items_added,
    'items_combined', p_job.items_combined,
    'committed_at', p_job.committed_at);
$$;

revoke all on function private.share_import_receipt(public.share_imports) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- private.share_import_precondition: whether one planned precondition still holds, locking the
-- rows it read. p_list is the target list (null: recipe-only), p_combine whether its household
-- combines languages (4.15). An unknown kind is 22023.
-- ---------------------------------------------------------------------------

create function private.share_import_precondition(p_pre jsonb, p_household uuid, p_list uuid, p_combine boolean)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_item uuid;
  v_found boolean;
  v_checked_at timestamptz;
  v_live uuid[];
  v_planned uuid[];
begin
  case p_pre ->> 'kind'
    when 'combine' then
      v_item := (p_pre ->> 'itemId')::uuid;
      perform 1 from public.list_items li
      where li.id = v_item and li.list_id = p_list and li.deleted_at is null and li.checked_at is null
      for update;
      return found;

    when 'reopen' then
      v_item := (p_pre ->> 'itemId')::uuid;
      select li.checked_at into v_checked_at
      from public.list_items li
      where li.id = v_item and li.list_id = p_list and li.deleted_at is null
      for update;
      v_found := found;
      -- The worker read checked_at through JSON, in ms.
      if not v_found or v_checked_at is null
        or date_trunc('milliseconds', v_checked_at) <> (p_pre ->> 'checkedAt')::timestamptz then
        return false;
      end if;
      select coalesce(array_agg(c.id order by c.id), '{}') into v_live
      from (
        select c.id from public.list_item_contributions c
        where c.list_item_id = v_item and c.deleted_at is null
        for update
      ) c;
      select coalesce(array_agg(x::uuid order by x::uuid), '{}') into v_planned
      from jsonb_array_elements_text(coalesce(p_pre -> 'contributionIds', '[]')) x;
      return v_live = v_planned;

    when 'new' then
      if (p_pre ->> 'listId')::uuid is distinct from p_list then
        return false;
      end if;
      -- No live item, open or checked, with this key: its own name, or with the household
      -- combining languages, its family's.
      return not exists (
        select 1 from public.list_items li
        left join public.ingredients i on i.normalized_name = li.ingredient_name
        where li.list_id = p_list and li.deleted_at is null
          and (li.ingredient_name = p_pre ->> 'key'
               or (p_combine and coalesce(i.same_as, li.ingredient_name) = p_pre ->> 'key'))
      );

    when 'recipeAbsent' then
      -- Any row with the id, even a deleted one, which a write would only patch.
      return not exists (select 1 from public.recipes r where r.id = (p_pre ->> 'recipeId')::uuid);

    when 'recipeReuse' then
      perform 1 from public.recipes r
      where r.id = (p_pre ->> 'recipeId')::uuid and r.household_id = p_household and r.deleted_at is null
      for update;
      return found;

    else
      raise exception 'unknown precondition %', coalesce(p_pre ->> 'kind', '(none)') using errcode = '22023';
  end case;
end;
$$;

revoke all on function private.share_import_precondition(jsonb, uuid, uuid, boolean) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- commit_share_import (service role, the worker's committing phase): see the header.
-- ---------------------------------------------------------------------------

create function public.commit_share_import(
  p_id uuid,
  p_lease uuid,
  p_target jsonb,
  p_writes jsonb,
  p_preconditions jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.share_imports;
  v_household uuid;
  v_list uuid;
  v_recipe uuid;
  v_added integer;
  v_combined integer;
  v_combine boolean;
  v_pre jsonb;
  v_write jsonb;
  v_table text;
  v_key jsonb;
  v_where text;
  v_clock jsonb;
  v_max_wall bigint := 0;
  v_wall bigint;
  v_index integer := 0;
begin
  select * into v_job from public.share_imports s where s.id = p_id for update;
  if found and v_job.committed_at is not null then
    return private.share_import_receipt(v_job);
  end if;
  v_job := private.leased_share_import(p_id, p_lease, array['committing'], true);

  if jsonb_typeof(p_target) is distinct from 'object'
    or jsonb_typeof(p_writes) is distinct from 'array'
    or jsonb_typeof(p_preconditions) is distinct from 'array'
    or jsonb_typeof(p_target -> 'household_id') is distinct from 'string'
    or jsonb_typeof(p_target -> 'recipe_id') is distinct from 'string'
    or jsonb_typeof(p_target -> 'items_added') is distinct from 'number'
    or jsonb_typeof(p_target -> 'items_combined') is distinct from 'number'
  then
    raise exception 'invalid commit' using errcode = '22023';
  end if;
  v_household := (p_target ->> 'household_id')::uuid;
  v_list := (p_target ->> 'list_id')::uuid;
  v_recipe := (p_target ->> 'recipe_id')::uuid;
  v_added := (p_target ->> 'items_added')::integer;
  v_combined := (p_target ->> 'items_combined')::integer;
  if v_added < 0 or v_combined < 0 or v_combined > v_added then
    raise exception 'invalid commit' using errcode = '22023';
  end if;

  -- 2. The destination, as planned, still holds.
  if not exists (
    select 1 from public.household_members hm where hm.household_id = v_household and hm.user_id = v_job.user_id
  ) or (v_list is not null and not exists (
    select 1 from public.lists l
    where l.id = v_list and l.household_id = v_household and l.deleted_at is null and l.archived_at is null
  )) then
    raise exception 'destination_changed' using errcode = '40001';
  end if;

  -- 3. One writer at a time decides what's open on the list (7.3).
  if v_list is not null then
    perform pg_advisory_xact_lock(hashtextextended('list:' || v_list::text, 0));
  end if;

  -- 4. What the plan assumed.
  select h.combine_languages into v_combine from public.households h where h.id = v_household;
  for v_pre in select * from jsonb_array_elements(p_preconditions) loop
    if not private.share_import_precondition(v_pre, v_household, v_list, coalesce(v_combine, false)) then
      raise exception 'plan_conflict' using errcode = '40001', detail = v_pre::text;
    end if;
  end loop;

  -- 5. The server's HLC wall: after now and after every clock on the rows it touches.
  for v_write in select * from jsonb_array_elements(p_writes) loop
    v_table := v_write ->> 'table';
    if v_table is null or v_table not in ('list_items', 'list_item_contributions', 'ingredient_usage',
      'ingredient_unit_usage', 'recipes', 'recipe_ingredients') then
      raise exception 'share imports don''t write %', coalesce(v_table, '(none)') using errcode = '22023';
    end if;
    v_key := case when v_write ? 'id' then jsonb_build_object('id', v_write -> 'id') else v_write -> 'key' end;
    if jsonb_typeof(v_key) is distinct from 'object' then
      raise exception 'a write must name its row' using errcode = '22023';
    end if;
    select string_agg(format('r.%1$I = (pg_catalog.jsonb_populate_record(null::public.%2$I, $1)).%1$I', k, v_table), ' and ')
    into v_where
    from jsonb_object_keys(v_key) k;
    v_clock := null;
    execute format('select r.field_clock from public.%I r where %s', v_table, v_where) into v_clock using v_key;
    select greatest(v_max_wall, coalesce(max(left(c.value, 13)::bigint), 0)) into v_max_wall
    from jsonb_each_text(coalesce(v_clock, '{}')) c
    where c.value ~ '^[0-9]{13}-';
  end loop;
  v_wall := greatest(floor(extract(epoch from clock_timestamp()) * 1000)::bigint, v_max_wall + 1);

  perform set_config('app.actor_uid', v_job.user_id::text, true);
  -- One entry for the whole commit (below), not one per row.
  perform private.suppress_activity();
  for v_write in select * from jsonb_array_elements(p_writes) loop
    perform private.apply_mutation(
      (v_write - 'op') || jsonb_build_object('hlc',
        lpad(v_wall::text, 13, '0') || '-' || lpad(to_hex(v_index), 4, '0') || '-srv'),
      v_job.user_id);
    v_index := v_index + 1;
  end loop;
  perform private.clear_activity_action();

  -- 6. The activity entry and the receipt.
  insert into private.user_activity (user_id, household_id, area, action, entity_id, data)
  select v_job.user_id, v_household, 'recipes', 'recipe.imported_from_share', v_recipe::text,
    jsonb_build_object('household', h.name, 'recipe', r.name, 'recipe_id', v_recipe, 'list', l.name,
      'items_added', v_added, 'items_combined', v_combined)
  from public.households h
  left join public.recipes r on r.id = v_recipe
  left join public.lists l on l.id = v_list
  where h.id = v_household;
  perform set_config('app.actor_uid', '', true);

  update public.share_imports
  set status = 'done', recipe_id = v_recipe, applied_list_id = v_list,
      list_gone = coalesce((p_target ->> 'list_gone')::boolean, false),
      items_added = v_added, items_combined = v_combined, committed_at = now(),
      lease_token = null, lease_expires_at = null, page = null,
      error_code = null, error_kind = null, resets_at = null
  where id = p_id
  returning * into v_job;

  return private.share_import_receipt(v_job);
end;
$$;

revoke all on function public.commit_share_import(uuid, uuid, jsonb, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.commit_share_import(uuid, uuid, jsonb, jsonb, jsonb) to service_role;
