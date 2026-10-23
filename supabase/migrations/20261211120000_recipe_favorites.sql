-- Favorites per person (spec 4.14 Favorites, 5, 7.1, 4.12 User activity). Each member keeps their own
-- favorites and sees the other members': one recipe_favorites row per recipe and user.
--
-- Household data like household_staples: members of the row's household read every member's rows,
-- and writes go through apply_mutations with field-level LWW (7.3), deleted_at its one field.
-- Unfavoriting sets deleted_at and favoriting again clears it, both newer changes to the same field.
-- Only the caller's own row can be written, in the recipe's household: anything else is refused with
-- 'not your favorite'. A deleted recipe's favorites are kept, so they come back if it's restored.
--
-- No data migration: a `favorite` slug stored in recipes.tags before this stays there, unknown to
-- the app.
--
-- private.remove_member_from_household now also deletes the leaver's favorites in that household.
-- apply_mutations and private.log_user_activity: otherwise unchanged from list_lock_activity_actor.sql;
-- remove_member_from_household otherwise unchanged from household_aisle_order.sql.

create table public.recipe_favorites (
  recipe_id    uuid not null references public.recipes on delete cascade,
  user_id      uuid not null references auth.users on delete cascade,
  household_id uuid not null references public.households on delete cascade,
  deleted_at   timestamptz,                                   -- unfavorited
  field_clock  jsonb not null default '{}',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (recipe_id, user_id)
);
create index recipe_favorites_user_id_idx on public.recipe_favorites (user_id);
create index recipe_favorites_household_id_idx on public.recipe_favorites (household_id);

create trigger recipe_favorites_set_updated_at
  before insert or update on public.recipe_favorites
  for each row execute function private.set_updated_at();

alter table public.recipe_favorites enable row level security;

revoke all on table public.recipe_favorites from anon, authenticated;
grant select on public.recipe_favorites to authenticated;

-- Clients only have select; writes go through apply_mutations, which makes the same check and more.
create policy recipe_favorites_member on public.recipe_favorites
  for all to authenticated
  using (household_id in (select private.my_household_ids()))
  with check (household_id in (select private.my_household_ids()));

alter publication supabase_realtime add table public.recipe_favorites;

-- Activity ---------------------------------------------------------------------------------------

-- Inserted live or restored: favorited; deleted_at set: unfavorited. A hard delete (leaving, the
-- recipe deleted for good) logs nothing.
create function private.activity_recipe_favorites(p_old public.recipe_favorites, p_new public.recipe_favorites)
returns setof private.activity_entry
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_action text;
begin
  if p_new is null then
    return;
  elsif p_old is null then
    v_action := case when p_new.deleted_at is null then 'recipe.favorited' end;
  elsif p_old.deleted_at is not null and p_new.deleted_at is null then
    v_action := 'recipe.favorited';
  elsif p_old.deleted_at is null and p_new.deleted_at is not null then
    v_action := 'recipe.unfavorited';
  end if;
  if v_action is not null then
    return next private.activity_row('recipes', v_action, p_new.recipe_id::text, p_new.household_id,
      jsonb_build_object('recipe', (select r.name from public.recipes r where r.id = p_new.recipe_id)));
  end if;
end;
$$;

revoke all on function private.activity_recipe_favorites(public.recipe_favorites, public.recipe_favorites)
  from public, anon, authenticated;

create trigger recipe_favorites_log_user_activity
  after insert or update or delete on public.recipe_favorites
  for each row execute function private.log_user_activity();

create or replace function private.log_user_activity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := coalesce((select auth.uid()), nullif(current_setting('app.actor_uid', true), '')::uuid);
  v_pending jsonb;
  v_entries private.activity_entry[];
begin
  if v_uid is null then
    return null;
  end if;
  begin
    if tg_op = 'UPDATE' and cardinality(private.activity_changed(to_jsonb(old), to_jsonb(new))) = 0 then
      return null;
    end if;

    v_pending := nullif(current_setting('app.activity_action', true), '')::jsonb;
    if v_pending is not null then
      if not (v_pending ? 'logged') then
        insert into private.user_activity (user_id, household_id, area, action, entity_id, data)
        values (v_uid, (v_pending ->> 'household_id')::uuid, 'household', v_pending ->> 'action',
          v_pending ->> 'entity_id', v_pending -> 'data');
        perform private.suppress_activity();
      end if;
      return null;
    end if;

    -- One branch per table: each statement is planned for this trigger's table only.
    case tg_table_name
      when 'lists' then
        select array_agg(e) into v_entries from private.activity_lists(old, new) e;
      when 'list_items' then
        select array_agg(e) into v_entries from private.activity_list_items(old, new) e;
      when 'list_item_contributions' then
        select array_agg(e) into v_entries from private.activity_list_item_contributions(old, new) e;
        -- The item's own item.added, from its insert in this transaction, is covered by this one.
        if tg_op = 'INSERT' then
          delete from private.user_activity a
          where a.user_id = v_uid and a.created_at = now() and a.txid = txid_current()
            and a.action = 'item.added' and a.entity_id = new.list_item_id::text;
        end if;
      when 'recipes' then
        select array_agg(e) into v_entries from private.activity_recipes(old, new) e;
      when 'recipe_ingredients' then
        select array_agg(e) into v_entries from private.activity_recipe_ingredients(old, new) e;
      when 'recipe_favorites' then
        select array_agg(e) into v_entries from private.activity_recipe_favorites(old, new) e;
      when 'meal_plan_entries' then
        select array_agg(e) into v_entries from private.activity_meal_plan_entries(old, new) e;
      when 'categories' then
        select array_agg(e) into v_entries from private.activity_categories(old, new) e;
      when 'household_category_overrides' then
        select array_agg(e) into v_entries from private.activity_household_category_overrides(old, new) e;
      when 'household_category_order' then
        select array_agg(e) into v_entries from private.activity_household_category_order(old, new) e;
      when 'household_staples' then
        select array_agg(e) into v_entries from private.activity_household_staples(old, new) e;
      when 'user_settings' then
        select array_agg(e) into v_entries from private.activity_user_settings(old, new) e;
      when 'user_household_category_order' then
        select array_agg(e) into v_entries from private.activity_user_household_category_order(old, new) e;
      when 'notification_settings' then
        select array_agg(e) into v_entries from private.activity_notification_settings(old, new) e;
      when 'push_tokens' then
        select array_agg(e) into v_entries from private.activity_push_tokens(old, new) e;
      else
        return null;
    end case;

    insert into private.user_activity (user_id, household_id, area, action, entity_id, data)
    select v_uid, e.household_id, e.area, e.action, e.entity_id,
      coalesce((select jsonb_build_object('household', h.name) from public.households h where h.id = e.household_id), '{}')
        || e.data
    from unnest(v_entries) e;
  exception when others then
    raise warning 'user_activity: couldn''t log % on %: %', tg_op, tg_table_name, sqlerrm;
  end;
  return null;
end;
$$;

-- Leaving deletes the leaver's favorites in the household ------------------------------------------

create or replace function private.remove_member_from_household(p_household_id uuid, p_user_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text;
begin
  -- Serialize changes to this household's membership, so two leaving at once can't both
  -- think the other is still there.
  perform 1 from public.households h where h.id = p_household_id for update;

  delete from public.household_members hm
  where hm.household_id = p_household_id and hm.user_id = p_user_id
  returning hm.role into v_role;

  if not found then
    raise exception 'not a member' using errcode = '42501';
  end if;

  -- Their own aisle order for this household (4.3.3).
  delete from public.user_household_category_order o
  where o.household_id = p_household_id and o.user_id = p_user_id;

  -- Their favorites in this household (4.14).
  delete from public.recipe_favorites f
  where f.household_id = p_household_id and f.user_id = p_user_id;

  if not exists (select 1 from public.household_members hm where hm.household_id = p_household_id) then
    delete from public.households h where h.id = p_household_id;
    return 'deleted';
  end if;

  if v_role = 'owner' and not exists (
    select 1 from public.household_members hm
    where hm.household_id = p_household_id and hm.role = 'owner'
  ) then
    update public.household_members hm set role = 'owner'
    where hm.household_id = p_household_id
      and hm.user_id = (
        select e.user_id from public.household_members e
        where e.household_id = p_household_id
        order by e.joined_at, e.user_id
        limit 1
      );
    return 'promoted';
  end if;

  return 'left';
end;
$$;

revoke all on function private.remove_member_from_household(uuid, uuid)
  from public, anon, authenticated, service_role;

-- apply_mutations: recipe_favorites ---------------------------------------------------------------

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

  -- The server sets who added a recipe or plan entry, marked a staple or saved an aisle order; a
  -- client's value is ignored, not refused.
  if v_table in ('recipes', 'meal_plan_entries') then
    v_fields := v_fields - 'added_by';
  elsif v_table = 'household_staples' then
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

  -- Fields a client may set. household_id and created_at only take effect on insert.
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
    elsif v_field in ('household_id', 'created_at') then
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

  -- A new recipe or plan entry was added, or a new staple marked, by the caller. No clock:
  -- nothing can change it later. An aisle order was last saved by whoever's order won.
  if v_table in ('recipes', 'meal_plan_entries') and v_old is null then
    v_new := v_new || jsonb_build_object('added_by', p_uid);
  elsif v_table = 'household_staples' and v_old is null then
    v_new := v_new || jsonb_build_object('created_by', p_uid);
  elsif v_table = 'household_category_order' and 'category_ids' = any (v_changed) then
    v_new := v_new || jsonb_build_object('updated_by', p_uid);
    v_changed := v_changed || 'updated_by'::text;
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
