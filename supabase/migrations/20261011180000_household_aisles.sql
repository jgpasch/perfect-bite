-- Household aisles (spec 4.3.2, 5, 7): an aisle choice for an ingredient, and a custom aisle,
-- belong to a household, so every member sees the same ones. Each person keeps their own aisle
-- order (user_category_order stays per user).
--
-- No existing aisle data is kept: per-user overrides and custom aisles are dropped, along with
-- the order rows that point at custom aisles.
--
-- Both tables are household data: members read them, and writes go through apply_mutations with
-- field-level LWW (7.3), like lists.

-- ---------------------------------------------------------------------------
-- Custom aisles belong to a household
-- ---------------------------------------------------------------------------

-- Drops the order rows (and old overrides) that point at them, by cascade.
delete from public.categories where owner_user_id is not null;

drop policy categories_select on public.categories;
drop policy categories_insert_own on public.categories;
drop policy categories_update_own on public.categories;
drop policy categories_delete_own on public.categories;

alter table public.categories
  drop column owner_user_id,
  add column household_id uuid references public.households on delete cascade,
  add column field_clock jsonb not null default '{}',
  add constraint categories_system_or_custom check (
    (slug is not null and household_id is null) or (slug is null and household_id is not null)
  );
create index categories_household_id_idx on public.categories (household_id);

revoke all on table public.categories from anon, authenticated;
grant select on public.categories to authenticated;

-- System categories (household_id null) are readable by everyone.
create policy categories_select on public.categories
  for select to authenticated
  using (household_id is null or household_id in (select private.my_household_ids()));

-- Custom ones belong to their household's members. Clients only have select; writes go through
-- apply_mutations, which makes the same check.
create policy categories_member on public.categories
  for all to authenticated
  using (household_id in (select private.my_household_ids()))
  with check (household_id in (select private.my_household_ids()));

-- ---------------------------------------------------------------------------
-- Household overrides (spec 4.3.2). category_id null means "the default": Reset to default
-- writes null rather than deleting the row, so a later change still wins under LWW.
-- ---------------------------------------------------------------------------

alter publication supabase_realtime drop table public.user_category_overrides;
drop table public.user_category_overrides;

create table public.household_category_overrides (
  household_id    uuid not null references public.households on delete cascade,
  ingredient_name text not null references public.ingredients,
  category_id     uuid references public.categories on delete cascade,  -- null = the default
  field_clock     jsonb not null default '{}',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  primary key (household_id, ingredient_name)
);
create index household_category_overrides_category_id_idx
  on public.household_category_overrides (category_id);

create trigger household_category_overrides_set_updated_at
  before insert or update on public.household_category_overrides
  for each row execute function private.set_updated_at();

alter table public.household_category_overrides enable row level security;

revoke all on table public.household_category_overrides from anon, authenticated;
grant select on public.household_category_overrides to authenticated;

create policy household_category_overrides_member on public.household_category_overrides
  for all to authenticated
  using (household_id in (select private.my_household_ids()))
  with check (household_id in (select private.my_household_ids()));

alter publication supabase_realtime add table public.household_category_overrides;

-- ---------------------------------------------------------------------------
-- apply_mutations: categories (insert and rename) and household_category_overrides
-- (category_id). Otherwise unchanged from apply_mutations.sql.
-- ---------------------------------------------------------------------------

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
    when 'lists', 'recipes', 'list_items', 'list_item_contributions', 'recipe_ingredients' then
      v_key_cols := array['id'];
    when 'categories' then
      v_key_cols := array['id'];
      v_settable := array['household_id', 'name', 'created_at'];
    when 'household_category_overrides' then
      v_key_cols := array['household_id', 'ingredient_name'];
      v_settable := array['category_id'];
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

  -- A second open item for the same ingredient is merged into the first (7.3).
  if v_table = 'list_items' and v_new ->> 'deleted_at' is null and v_new ->> 'checked_at' is null then
    select li.id into v_target
    from public.list_items li
    where li.list_id = (v_new ->> 'list_id')::uuid
      and li.ingredient_name = v_new ->> 'ingredient_name'
      and li.deleted_at is null and li.checked_at is null
      and li.id <> (v_new ->> 'id')::uuid;
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
