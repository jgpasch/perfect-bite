-- The household's meal plan (spec 4.16, 5, 7). One row per entry in a slot (a day and a meal):
-- a recipe of the household, Leftovers, Eating out or a free-text note. A slot holds one entry
-- for now; position orders several, so allowing more later needs no migration. Setting a slot
-- soft-deletes its live entries and inserts the new one, so two devices filling the same slot
-- offline both keep their rows, and the app shows the one created last.
--
-- Household data like recipes: members read the rows, and writes go through apply_mutations
-- (id-keyed, field-level LWW, 7.3). added_by is set by the server to the caller on insert, as
-- recipes.added_by. The composite foreign key keeps recipe_id in the entry's household;
-- apply_mutations checks it first, so a client gets 22023 rather than a foreign key error. A
-- deleted recipe is only soft-deleted, so its entries stay; the app hides them.
--
-- apply_mutations: otherwise unchanged from combine_languages.sql.

create table public.meal_plan_entries (
  id           uuid primary key,
  household_id uuid not null references public.households on delete cascade,
  plan_date    date not null,                                  -- the calendar day, no time zone
  meal         text not null check (meal in ('breakfast', 'lunch', 'dinner')),
  position     double precision not null default 0,            -- order within the slot
  kind         text not null check (kind in ('recipe', 'leftovers', 'eating-out', 'note')),
  recipe_id    uuid,                                           -- set exactly when kind = 'recipe'
  note         text,                                           -- set exactly when kind = 'note'
  added_by     uuid references auth.users on delete set null,  -- the server sets it on insert
  deleted_at   timestamptz,
  field_clock  jsonb not null default '{}',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  foreign key (recipe_id, household_id) references public.recipes (id, household_id),
  constraint meal_plan_entries_recipe_kind check ((kind = 'recipe') = (recipe_id is not null)),
  -- A note is kept as typed (4.15), trimmed, 1 to 60 characters.
  constraint meal_plan_entries_note_kind check (
    (kind = 'note') = (note is not null)
    and (note is null or (note = btrim(note) and char_length(note) between 1 and 60))
  )
);
create index meal_plan_entries_household_date_idx on public.meal_plan_entries (household_id, plan_date);
create index meal_plan_entries_recipe_id_idx on public.meal_plan_entries (recipe_id);
create index meal_plan_entries_added_by_idx on public.meal_plan_entries (added_by);

create trigger meal_plan_entries_set_updated_at
  before insert or update on public.meal_plan_entries
  for each row execute function private.set_updated_at();

alter table public.meal_plan_entries enable row level security;

revoke all on table public.meal_plan_entries from anon, authenticated;
grant select on public.meal_plan_entries to authenticated;

-- Clients only have select; writes go through apply_mutations, which makes the same check.
create policy meal_plan_entries_select_member on public.meal_plan_entries
  for select to authenticated
  using (household_id in (select private.my_household_ids()));

alter publication supabase_realtime add table public.meal_plan_entries;

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
    when 'household_staples' then
      v_key_cols := array['household_id', 'ingredient_name'];
      v_settable := array['deleted_at'];
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

  -- The server sets who added a recipe or plan entry, or marked a staple; a client's value is
  -- ignored, not refused.
  if v_table in ('recipes', 'meal_plan_entries') then
    v_fields := v_fields - 'added_by';
  elsif v_table = 'household_staples' then
    v_fields := v_fields - 'created_by';
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
  -- nothing can change it later.
  if v_table in ('recipes', 'meal_plan_entries') and v_old is null then
    v_new := v_new || jsonb_build_object('added_by', p_uid);
  elsif v_table = 'household_staples' and v_old is null then
    v_new := v_new || jsonb_build_object('created_by', p_uid);
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
