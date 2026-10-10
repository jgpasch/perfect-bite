-- Writes to household data go through apply_mutations (spec 7.1-7.3). Clients keep read access
-- (RLS by household) but lose direct insert/update/delete on household tables.
--
-- A mutation is a field-level patch:
--
--   { "table": "list_items", "id": "<uuid>", "hlc": "<hlc>", "fields": { "note": "ripe", ... } }
--
-- The usage tables have composite keys, so they name the row with "key" instead of "id"
-- ({ "household_id", "ingredient_name" [, "unit_key"] }) and may carry "counters"
-- ({ "use_count": 1 }), deltas that add up across devices rather than last-writer-wins.
--
-- An hlc is '<wall clock ms, 13 digits>-<counter, 4 hex digits>-<device id>', so plain text
-- comparison (collation "C") orders it by time, then counter, then device.
--
-- Rules (7.3):
-- - Each field is written only if the mutation's hlc is newer than field_clock[field]; the
--   field's clock then becomes that hlc. Re-sending a mutation is therefore a no-op.
-- - Delete wins: deleted_at is a field like any other, so an edit to other fields never clears
--   it. An undo is a newer mutation that sets deleted_at to null.
-- - Counters are applied once per row + hlc (recorded in private.applied_counters).
-- - ingredient_unit_usage.last_used_at merges as the later of both sides.
-- - A list item that would be a second open item for its ingredient on a list is merged into
--   the open one: its contributions move there, and it is soft-deleted with merged_into set.
-- - updated_at is always server-set; created_at is taken from the device on insert only.
--
-- Each mutation runs in its own subtransaction and gets one result, in order:
--   { "status": "applied" | "unchanged" | "merged", "merged_into"?: uuid }
--   { "status": "rejected", "code": "<sqlstate>", "message": "..." }
-- so one bad mutation (e.g. for a household the caller has left, 42501) never blocks the rest.

-- ---------------------------------------------------------------------------
-- Schema additions
-- ---------------------------------------------------------------------------

-- Set when apply_mutations merges this item into another open item for the same ingredient.
alter table public.list_items
  add column merged_into uuid references public.list_items on delete set null;

-- The units each ingredient is bought in (spec 4.2, 5). use_count is a counter and last_used_at
-- the later of both sides; field_clock is kept for uniformity with the other synced tables.
create table public.ingredient_unit_usage (
  household_id    uuid not null references public.households on delete cascade,
  ingredient_name text not null,                                -- ingredient key
  unit_key        text not null,                                -- a supported unit, or 'count'
  use_count       int not null default 0,
  last_used_at    timestamptz not null,
  field_clock     jsonb not null default '{}',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  primary key (household_id, ingredient_name, unit_key)
);

create trigger ingredient_unit_usage_set_updated_at
  before insert or update on public.ingredient_unit_usage
  for each row execute function private.set_updated_at();

alter table public.ingredient_unit_usage enable row level security;

-- Counter deltas already applied, so a re-sent mutation doesn't count twice.
create table private.applied_counters (
  table_name text not null,
  row_key    text not null,
  hlc        text collate "C" not null,
  applied_at timestamptz not null default now(),
  primary key (table_name, row_key, hlc)
);

-- ---------------------------------------------------------------------------
-- Clients read household tables; writes go through apply_mutations.
-- ---------------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array[
    'lists', 'recipes', 'list_items', 'list_item_contributions', 'recipe_ingredients',
    'ingredient_usage'
  ] loop
    execute format('drop policy %1$s_member on public.%1$I', t);
  end loop;

  foreach t in array array[
    'lists', 'recipes', 'list_items', 'list_item_contributions', 'recipe_ingredients',
    'ingredient_usage', 'ingredient_unit_usage'
  ] loop
    execute format('revoke all on table public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format(
      'create policy %1$s_select_member on public.%1$I for select to authenticated
         using (household_id in (select private.my_household_ids()))', t);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- apply_mutations
-- ---------------------------------------------------------------------------

-- The open item an item was merged into, following merges of merges.
create function private.resolve_merged_item(p_id uuid)
returns uuid
language plpgsql
stable
set search_path = ''
as $$
declare
  v_id uuid := p_id;
  v_next uuid;
begin
  for i in 1..16 loop
    select li.merged_into into v_next from public.list_items li where li.id = v_id;
    exit when v_next is null;
    v_id := v_next;
  end loop;
  return v_id;
end;
$$;

-- Applies one mutation. Raises on anything it rejects; apply_mutations turns that into a result.
create function private.apply_mutation(p_mutation jsonb, p_uid uuid)
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

revoke all on function private.resolve_merged_item(uuid) from public, anon, authenticated;
revoke all on function private.apply_mutation(jsonb, uuid) from public, anon, authenticated;

-- Applies a batch of mutations in order and returns one result per mutation (see top).
create function public.apply_mutations(mutations jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_mutation jsonb;
  v_results jsonb := '[]';
  v_code text;
  v_message text;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if jsonb_typeof(mutations) is distinct from 'array' then
    raise exception 'mutations must be an array' using errcode = '22023';
  end if;

  for v_mutation in select m from jsonb_array_elements(mutations) m loop
    begin
      if jsonb_typeof(v_mutation) <> 'object' then
        raise exception 'a mutation must be an object' using errcode = '22023';
      end if;
      v_results := v_results || jsonb_build_array(private.apply_mutation(v_mutation, v_uid));
    exception when others then
      get stacked diagnostics v_code = returned_sqlstate, v_message = message_text;
      v_results := v_results || jsonb_build_array(
        jsonb_build_object('status', 'rejected', 'code', v_code, 'message', v_message));
    end;
  end loop;

  return v_results;
end;
$$;

revoke all on function public.apply_mutations(jsonb) from public, anon, service_role;
grant execute on function public.apply_mutations(jsonb) to authenticated;
