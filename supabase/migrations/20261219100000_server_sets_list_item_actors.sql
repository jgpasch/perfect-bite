-- Who added and checked a list item is the server's to say (architecture review). apply_mutations took
-- list_items.added_by, list_items.checked_by and list_item_contributions.added_by from the client,
-- and the household_events triggers (queue_items_added, queue_shopping) push them as the actor, so a
-- member could send "<another member> is shopping" or name any user in the household's pushes.
--
-- Now, like recipes.added_by, a client's value for them is ignored, not refused:
-- - added_by (an item or a contribution) is the caller, on insert. No clock: nothing changes it later.
-- - checked_by follows checked_at: the caller when checked_at goes from null to set (an insert that's
--   already checked included), null when it goes back to null, unchanged when one check time replaces
--   another. Whenever checked_at changes it takes checked_at's clock, so a pull gives the device the
--   server's checker in place of the one it wrote.
--
-- apply_mutation: otherwise unchanged from recipe_collections.sql.

create or replace function private.apply_mutation(p_mutation jsonb, p_uid uuid)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_table    text := p_mutation ->> 'table';
  v_hlc      text collate "C" := p_mutation ->> 'hlc';
  v_fields   jsonb := coalesce(p_mutation -> 'fields', '{}');
  v_counters jsonb := coalesce(p_mutation -> 'counters', '{}');
  v_key_cols text[];
  v_counter_cols text[] := '{}';
  v_max_cols text[] := '{}';
  v_settable text[];  -- null = every column that isn't a key, counter or server-owned
  v_columns  text[];
  v_key      jsonb;
  v_where    text;
  v_old      jsonb;
  v_new      jsonb;
  v_clock    jsonb;
  v_changed  text[] := '{}';
  v_field    text;
  v_value    jsonb;
  v_household uuid;
  v_target   uuid;
  v_status   text := 'applied';
  v_locked_list uuid;
begin
  case v_table
    when 'lists', 'recipes', 'list_items', 'list_item_contributions', 'recipe_ingredients',
      'meal_plan_entries' then
      v_key_cols := array['id'];
    when 'categories' then
      v_key_cols := array['id'];
      v_settable := array['household_id', 'name', 'created_at'];
    when 'household_category_overrides' then
      v_key_cols := array['household_id', 'ingredient_name'];
      v_settable := array['category_id'];
    when 'household_category_order' then
      v_key_cols := array['household_id'];
      v_settable := array['category_ids'];
    when 'household_staples' then
      v_key_cols := array['household_id', 'ingredient_name'];
      v_settable := array['deleted_at'];
    when 'recipe_favorites' then
      v_key_cols := array['recipe_id', 'user_id'];
      v_settable := array['household_id', 'deleted_at'];
    when 'recipe_collections' then
      v_key_cols := array['id'];
      v_settable := array['household_id', 'name', 'deleted_at', 'created_at'];
    when 'recipe_collection_recipes' then
      v_key_cols := array['collection_id', 'recipe_id'];
      v_settable := array['household_id', 'added_at', 'deleted_at'];
    when 'ingredient_usage' then
      v_key_cols := array['household_id', 'ingredient_name'];
      v_counter_cols := array['use_count'];
    when 'ingredient_unit_usage' then
      v_key_cols := array['household_id', 'ingredient_name', 'unit_key'];
      v_counter_cols := array['use_count'];
      v_max_cols := array['last_used_at'];
    else
      raise exception 'unknown table %', coalesce(v_table, '(none)') using errcode = '22023';
  end case;

  if v_hlc is null or v_hlc !~ '^[0-9]{13}-[0-9a-f]{4}-[0-9A-Za-z_-]{1,64}$' then
    raise exception 'invalid hlc %', coalesce(v_hlc, '(none)') using errcode = '22023';
  end if;
  if jsonb_typeof(v_fields) <> 'object' or jsonb_typeof(v_counters) <> 'object' then
    raise exception 'fields and counters must be objects' using errcode = '22023';
  end if;

  -- The server sets who added a recipe, plan entry, list item or amount, checked an item, marked a
  -- staple, made a collection or saved an aisle order; a client's value is ignored, not refused.
  if v_table in ('recipes', 'meal_plan_entries', 'list_item_contributions') then
    v_fields := v_fields - 'added_by';
  elsif v_table = 'list_items' then
    v_fields := v_fields - 'added_by' - 'checked_by';
  elsif v_table in ('household_staples', 'recipe_collections') then
    v_fields := v_fields - 'created_by';
  elsif v_table = 'household_category_order' then
    v_fields := v_fields - 'updated_by';
  end if;

  v_key := case when v_key_cols = array['id']
    then jsonb_build_object('id', p_mutation -> 'id')
    else coalesce(p_mutation -> 'key', '{}') end;
  if jsonb_typeof(v_key) <> 'object' or exists (
    select 1 from unnest(v_key_cols) c where jsonb_typeof(v_key -> c) is distinct from 'string'
  ) or exists (select 1 from jsonb_object_keys(v_key) k where k <> all (v_key_cols)) then
    raise exception 'mutation must name its row by %', array_to_string(v_key_cols, ', ')
      using errcode = '22023';
  end if;

  select array_agg(a.attname::text) into v_columns
  from pg_catalog.pg_attribute a
  where a.attrelid = format('public.%I', v_table)::regclass and a.attnum > 0 and not a.attisdropped;

  -- Fields a client may set. household_id, created_at and added_at only take effect on insert.
  for v_field in select jsonb_object_keys(v_fields) loop
    if v_field <> all (v_columns)
      or v_field = any (v_key_cols || v_counter_cols || array['updated_at', 'field_clock', 'merged_into'])
      or v_field <> all (coalesce(v_settable, v_columns))
    then
      raise exception 'field % can''t be set on %', v_field, v_table using errcode = '22023';
    end if;
  end loop;
  for v_field in select jsonb_object_keys(v_counters) loop
    if v_field <> all (v_counter_cols) or jsonb_typeof(v_counters -> v_field) <> 'number' then
      raise exception 'counter % can''t be set on %', v_field, v_table using errcode = '22023';
    end if;
  end loop;

  -- One writer at a time per list decides whether an item is open beside another (below), across
  -- device pushes and server commits. Taken before the row's own lock, so writers lock a list and
  -- then its items, never the other way round.
  if v_table = 'list_items' then
    v_locked_list := coalesce(
      (select li.list_id from public.list_items li where li.id = (v_key ->> 'id')::uuid),
      (v_fields ->> 'list_id')::uuid);
    if v_locked_list is not null then
      perform pg_advisory_xact_lock(hashtextextended('list:' || v_locked_list::text, 0));
    end if;
  end if;

  select string_agg(format('r.%1$I = (pg_catalog.jsonb_populate_record(null::public.%2$I, $1)).%1$I', c, v_table), ' and ')
  into v_where
  from unnest(v_key_cols) c;

  execute format('select pg_catalog.to_jsonb(r) from public.%I r where %s for update', v_table, v_where)
  into v_old using v_key;

  -- System categories belong to no household and never change through here.
  if v_table = 'categories' and v_old is not null and v_old ->> 'household_id' is null then
    raise exception 'system categories can''t be changed' using errcode = '42501';
  end if;

  -- The household check: the existing row's household, or the new row's.
  v_household := coalesce(v_old ->> 'household_id', v_key ->> 'household_id', v_fields ->> 'household_id')::uuid;
  if v_household is null then
    raise exception 'household_id is required' using errcode = '22023';
  end if;

  -- A favorite is the caller's own, in the recipe's household (4.14).
  if v_table = 'recipe_favorites' and (
    (v_key ->> 'user_id')::uuid is distinct from p_uid
    or (v_fields ? 'household_id' and (v_fields ->> 'household_id')::uuid is distinct from v_household)
    or not exists (
      select 1 from public.recipes r
      where r.id = (v_key ->> 'recipe_id')::uuid and r.household_id = v_household
    )
  ) then
    raise exception 'not your favorite' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.household_members hm where hm.household_id = v_household and hm.user_id = p_uid
  ) then
    raise exception 'not a member of household %', v_household using errcode = '42501';
  end if;
  if v_old is not null and v_fields ? 'household_id'
    and (v_fields ->> 'household_id')::uuid is distinct from v_household then
    raise exception 'a row can''t move to another household' using errcode = '22023';
  end if;

  -- A recipe is filed in a collection of its own household, and the row is that household's.
  if v_table = 'recipe_collection_recipes' and (
    not exists (
      select 1 from public.recipe_collections c
      where c.id = (v_key ->> 'collection_id')::uuid and c.household_id = v_household
    )
    or not exists (
      select 1 from public.recipes r
      where r.id = (v_key ->> 'recipe_id')::uuid and r.household_id = v_household
    )
  ) then
    raise exception 'recipe and collection must be in household %', v_household using errcode = '22023';
  end if;

  -- An override points at a system category or one of its own household's custom ones.
  if v_table = 'household_category_overrides' and v_fields ->> 'category_id' is not null
    and not exists (
      select 1 from public.categories c
      where c.id = (v_fields ->> 'category_id')::uuid
        and (c.household_id is null or c.household_id = v_household)
    )
  then
    raise exception 'category % isn''t available in household %', v_fields ->> 'category_id', v_household
      using errcode = '22023';
  end if;

  -- A new aisle order needs its order (the table's trigger checks what's in it).
  if v_table = 'household_category_order' and v_old is null and not (v_fields ? 'category_ids') then
    raise exception 'invalid aisle order' using errcode = '22023';
  end if;

  -- A plan entry's recipe is one of its own household's.
  if v_table = 'meal_plan_entries' and v_fields ->> 'recipe_id' is not null
    and not exists (
      select 1 from public.recipes r
      where r.id = (v_fields ->> 'recipe_id')::uuid and r.household_id = v_household
    )
  then
    raise exception 'recipe % isn''t in household %', v_fields ->> 'recipe_id', v_household
      using errcode = '22023';
  end if;

  v_new := coalesce(v_old, v_key);
  v_clock := coalesce(v_old -> 'field_clock', '{}');

  for v_field, v_value in select * from jsonb_each(v_fields) loop
    if v_old is null then
      v_new := v_new || jsonb_build_object(v_field, v_value);
      v_clock := v_clock || jsonb_build_object(v_field, v_hlc);
      v_changed := v_changed || v_field;
    elsif v_field in ('household_id', 'created_at', 'added_at') then
      continue;
    elsif v_field = any (v_max_cols) then
      if (v_value #>> '{}')::timestamptz >(v_old ->> v_field)::timestamptz then
        v_new := v_new || jsonb_build_object(v_field, v_value);
        v_changed := v_changed || v_field;
      end if;
    elsif v_clock ->> v_field is null or v_hlc > (v_clock ->> v_field) collate "C" then
      v_new := v_new || jsonb_build_object(v_field, v_value);
      v_clock := v_clock || jsonb_build_object(v_field, v_hlc);
      v_changed := v_changed || v_field;
    end if;
  end loop;

  -- A new recipe, plan entry, list item or amount was added, or a new staple marked or collection
  -- made, by the caller. No clock: nothing can change it later. An aisle order was last saved by
  -- whoever's order won.
  if v_table in ('recipes', 'meal_plan_entries', 'list_items', 'list_item_contributions') and v_old is null then
    v_new := v_new || jsonb_build_object('added_by', p_uid);
  elsif v_table in ('household_staples', 'recipe_collections') and v_old is null then
    v_new := v_new || jsonb_build_object('created_by', p_uid);
  elsif v_table = 'household_category_order' and 'category_ids' = any (v_changed) then
    v_new := v_new || jsonb_build_object('updated_by', p_uid);
    v_changed := v_changed || 'updated_by'::text;
  end if;

  -- An item checked by this write was checked by the caller; an unchecked one by no one. A later
  -- check time over an earlier one keeps its checker. Either way checked_by takes checked_at's clock.
  if v_table = 'list_items' and 'checked_at' = any (v_changed) then
    if v_new ->> 'checked_at' is null then
      v_new := v_new || jsonb_build_object('checked_by', null);
    elsif v_old ->> 'checked_at' is null then
      v_new := v_new || jsonb_build_object('checked_by', p_uid);
    end if;
    v_clock := v_clock || jsonb_build_object('checked_by', v_hlc);
    v_changed := v_changed || 'checked_by'::text;
  end if;

  if v_counters <> '{}' then
    insert into private.applied_counters (table_name, row_key, hlc)
    values (v_table, v_key::text, v_hlc)
    on conflict do nothing;
    if found then
      for v_field, v_value in select * from jsonb_each(v_counters) loop
        v_new := v_new || jsonb_build_object(
          v_field, coalesce((v_new ->> v_field)::int, 0) + (v_value #>> '{}')::int);
        v_changed := v_changed || v_field;
      end loop;
    end if;
  end if;

  -- Contributions follow their item if it was merged.
  if v_table = 'list_item_contributions' and v_new ? 'list_item_id' then
    v_new := v_new || jsonb_build_object(
      'list_item_id', private.resolve_merged_item((v_new ->> 'list_item_id')::uuid));
  end if;

  -- A second open item for the same ingredient is merged into the first (7.3). An item that opens
  -- beside an open one of its family (4.15) is merged into that one, the oldest if there are more,
  -- when the list's household combines languages.
  if v_table = 'list_items' and v_new ->> 'deleted_at' is null and v_new ->> 'checked_at' is null then
    -- The list it ends on, if this write moves it, is locked too.
    if (v_new ->> 'list_id')::uuid is distinct from v_locked_list and v_new ->> 'list_id' is not null then
      perform pg_advisory_xact_lock(hashtextextended('list:' || (v_new ->> 'list_id'), 0));
    end if;
    select li.id into v_target
    from public.list_items li
    where li.list_id = (v_new ->> 'list_id')::uuid
      and li.ingredient_name = v_new ->> 'ingredient_name'
      and li.deleted_at is null and li.checked_at is null
      and li.id <> (v_new ->> 'id')::uuid;
    if v_target is null
      and (v_old is null or v_old ->> 'deleted_at' is not null or v_old ->> 'checked_at' is not null)
      and exists (
        select 1 from public.lists l join public.households h on h.id = l.household_id
        where l.id = (v_new ->> 'list_id')::uuid and h.combine_languages
      )
    then
      select li.id into v_target
      from public.list_items li
      left join public.ingredients i on i.normalized_name = li.ingredient_name
      where li.list_id = (v_new ->> 'list_id')::uuid
        and li.deleted_at is null and li.checked_at is null
        and li.id <> (v_new ->> 'id')::uuid
        and coalesce(i.same_as, li.ingredient_name) = coalesce(
          (select n.same_as from public.ingredients n where n.normalized_name = v_new ->> 'ingredient_name'),
          v_new ->> 'ingredient_name')
      order by li.created_at, li.id
      limit 1;
    end if;
    if v_target is not null then
      v_new := v_new || jsonb_build_object('deleted_at', now(), 'merged_into', v_target);
      v_clock := v_clock || jsonb_build_object('deleted_at', v_hlc);
      v_changed := v_changed || array['deleted_at', 'merged_into'];
      v_status := 'merged';
    end if;
  end if;

  if v_old is null then
    v_new := v_new || jsonb_build_object('field_clock', v_clock);
    select array_agg(k) into v_columns from jsonb_object_keys(v_new) k;
    execute format(
      'insert into public.%1$I (%2$s) select %2$s from pg_catalog.jsonb_populate_record(null::public.%1$I, $1)',
      v_table, (select string_agg(format('%I', c), ', ') from unnest(v_columns) c))
    using v_new;
  elsif cardinality(v_changed) > 0 then
    v_new := v_new || jsonb_build_object('field_clock', v_clock);
    v_columns := array['household_id', 'field_clock'] || v_changed;
    execute format(
      'update public.%1$I r set (%2$s) = (select %2$s from pg_catalog.jsonb_populate_record(null::public.%1$I, $1)) where %3$s',
      v_table, (select string_agg(distinct format('%I', c), ', ') from unnest(v_columns) c), v_where)
    using v_new;
  else
    return jsonb_build_object('status', 'unchanged');
  end if;

  if v_status = 'merged' then
    update public.list_item_contributions
    set list_item_id = v_target
    where list_item_id = (v_new ->> 'id')::uuid;
    return jsonb_build_object('status', 'merged', 'merged_into', v_target);
  end if;
  return jsonb_build_object('status', v_status);
end;
$$;

revoke all on function private.apply_mutation(jsonb, uuid) from public, anon, authenticated;
