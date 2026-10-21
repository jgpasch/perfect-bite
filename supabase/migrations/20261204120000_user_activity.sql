-- User activity (spec 4.12 User activity, 5, 6.5). Every change a signed-in user's write makes is
-- logged in private.user_activity, so an admin can follow what a user did. Logging is by table
-- triggers, so every write path is covered (apply_mutations, the household functions, direct
-- writes to the per-user settings tables, the push token functions) and a path added later can't
-- be missed: one shared trigger, private.log_user_activity(), calls the table's own
-- private.activity_<table>(old, new), which returns the catalog's entries for the change.
--
-- Nothing is logged when auth.uid() is null (pg_cron, Edge Functions on the service role, the
-- dashboard), nor for an update whose only changed columns are updated_at, field_clock or
-- created_at. Like the household_events triggers, logging never fails the write: an error raises a
-- warning.
--
-- The household functions log one entry per call: each sets a transaction-local
-- app.activity_action with its action and data, and while it's set the trigger logs that entry on
-- the first write and nothing for the rest (the rows the function writes, and their cascades).

create table private.user_activity (
  id           bigint generated always as identity primary key,
  user_id      uuid not null,
  household_id uuid,
  created_at   timestamptz not null default now(),
  txid         bigint not null default txid_current(),
  area         text not null,
  action       text not null,
  entity_id    text,
  data         jsonb not null default '{}'
);

create index user_activity_user_created_idx on private.user_activity (user_id, created_at desc);
create index user_activity_user_area_created_idx on private.user_activity (user_id, area, created_at desc);
create index user_activity_created_idx on private.user_activity (created_at);
-- For deleting a user: their mentions in other users' member entries are scrubbed.
create index user_activity_member_idx on private.user_activity ((data ->> 'member_id'))
  where action in ('member.removed', 'member.role_changed');

revoke all on table private.user_activity from public, anon, authenticated;
alter table private.user_activity enable row level security;

-- What a table's function returns: one catalog entry. household_id is the row's household (null
-- for per-user rows); the trigger adds the household's name to data.
create type private.activity_entry as (
  area         text,
  action       text,
  entity_id    text,
  household_id uuid,
  data         jsonb
);

create function private.activity_row(p_area text, p_action text, p_entity_id text, p_household_id uuid, p_data jsonb)
returns private.activity_entry
language sql
immutable
set search_path = ''
as $$ select row(p_area, p_action, p_entity_id, p_household_id, p_data)::private.activity_entry $$;

revoke all on function private.activity_row(text, text, text, uuid, jsonb) from public, anon, authenticated;

-- The columns an update changed, leaving out the ones that don't count (updated_at, field_clock,
-- created_at), sorted.
create function private.activity_changed(p_old jsonb, p_new jsonb)
returns text[]
language sql
immutable
set search_path = ''
as $$
  select coalesce(array_agg(n.key order by n.key collate "C"), '{}')
  from jsonb_each(p_new) n
  where n.key not in ('updated_at', 'field_clock', 'created_at')
    and n.value is distinct from p_old -> n.key
$$;

revoke all on function private.activity_changed(jsonb, jsonb) from public, anon, authenticated;

-- A recipe's source for recipe.created: the link's host without www., else photo or manual.
create function private.activity_recipe_source(p_recipe public.recipes)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_recipe.source_url is not null then coalesce(
      regexp_replace(lower(substring(p_recipe.source_url from '^[A-Za-z][A-Za-z0-9+.-]*://(?:[^@/?#]*@)?([^/:?#]+)')), '^www\.', ''),
      'link')
    when p_recipe.source_pages is not null then 'photo'
    else 'manual'
  end
$$;

revoke all on function private.activity_recipe_source(public.recipes) from public, anon, authenticated;

-- The tables' functions ----------------------------------------------------------------------------
-- Each takes the row before and after (old null for an insert, new null for a delete) and returns
-- its entries; an update can make several (a rename and an emoji change in one mutation). Names
-- are read from the row or its parent by primary key, as they are now (the snapshot). Hard deletes
-- of rows already soft-deleted log nothing more.

create function private.activity_lists(p_old public.lists, p_new public.lists)
returns setof private.activity_entry
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.lists := coalesce(p_new, p_old);
  v_data jsonb := jsonb_build_object('list', r.name);
  v_changed text[];
  v_fields text[];
begin
  if p_old is null then
    return next private.activity_row('lists', 'list.created', r.id::text, r.household_id, v_data);
    return;
  end if;
  if p_new is null then
    if p_old.deleted_at is null then
      return next private.activity_row('lists', 'list.deleted', r.id::text, r.household_id, v_data);
    end if;
    return;
  end if;

  if p_old.deleted_at is null and p_new.deleted_at is not null then
    return next private.activity_row('lists', 'list.deleted', r.id::text, r.household_id, v_data);
  elsif p_old.deleted_at is not null and p_new.deleted_at is null then
    return next private.activity_row('lists', 'list.restored', r.id::text, r.household_id, v_data);
  end if;
  if p_old.archived_at is null and p_new.archived_at is not null then
    return next private.activity_row('lists', 'list.archived', r.id::text, r.household_id, v_data);
  elsif p_old.archived_at is not null and p_new.archived_at is null then
    return next private.activity_row('lists', 'list.unarchived', r.id::text, r.household_id, v_data);
  end if;
  if p_new.name is distinct from p_old.name then
    return next private.activity_row('lists', 'list.renamed', r.id::text, r.household_id,
      v_data || jsonb_build_object('from', p_old.name));
  end if;
  v_fields := array_remove(array[
    case when p_new.color is distinct from p_old.color then 'color' end,
    case when p_new.emoji is distinct from p_old.emoji then 'emoji' end], null);
  if cardinality(v_fields) > 0 then
    return next private.activity_row('lists', 'list.edited', r.id::text, r.household_id,
      v_data || jsonb_build_object('fields', to_jsonb(v_fields)));
  end if;
  v_changed := private.activity_changed(to_jsonb(p_old), to_jsonb(p_new));
  if v_changed = array['position'] then
    return next private.activity_row('lists', 'list.reordered', r.id::text, r.household_id, v_data);
  end if;
end;
$$;

-- An item inserted on its own logs item.added from the item; when its first contribution comes in
-- the same transaction, the trigger drops that entry for the contribution's (which has the source
-- and quantity).
create function private.activity_list_items(p_old public.list_items, p_new public.list_items)
returns setof private.activity_entry
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.list_items := coalesce(p_new, p_old);
  v_list text := (select l.name from public.lists l where l.id = r.list_id);
  v_data jsonb := jsonb_build_object('list', v_list, 'item', r.display_name);
  v_merged jsonb;
begin
  if r.merged_into is not null and (p_old is null or p_old.merged_into is null) and not (p_new is null) then
    v_merged := v_data || jsonb_build_object('into',
      (select li.display_name from public.list_items li where li.id = r.merged_into));
  end if;

  if p_old is null then
    if v_merged is not null then
      return next private.activity_row('lists', 'item.merged', r.id::text, r.household_id, v_merged);
    else
      return next private.activity_row('lists', 'item.added', r.id::text, r.household_id,
        v_data || jsonb_build_object('list_id', r.list_id, 'item_id', r.id));
    end if;
    return;
  end if;
  if p_new is null then
    if p_old.deleted_at is null then
      return next private.activity_row('lists', 'item.deleted', r.id::text, r.household_id, v_data);
    end if;
    return;
  end if;

  if v_merged is not null then
    return next private.activity_row('lists', 'item.merged', r.id::text, r.household_id, v_merged);
  elsif p_old.deleted_at is null and p_new.deleted_at is not null then
    return next private.activity_row('lists', 'item.deleted', r.id::text, r.household_id, v_data);
  elsif p_old.deleted_at is not null and p_new.deleted_at is null then
    return next private.activity_row('lists', 'item.restored', r.id::text, r.household_id, v_data);
  end if;
  if p_old.checked_at is null and p_new.checked_at is not null then
    return next private.activity_row('lists', 'item.checked', r.id::text, r.household_id, v_data);
  elsif p_old.checked_at is not null and p_new.checked_at is null then
    return next private.activity_row('lists', 'item.unchecked', r.id::text, r.household_id, v_data);
  end if;
  if p_new.list_id is distinct from p_old.list_id then
    return next private.activity_row('lists', 'item.moved', r.id::text, r.household_id, jsonb_build_object(
      'item', r.display_name,
      'from', (select l.name from public.lists l where l.id = p_old.list_id),
      'to', v_list));
  end if;
  if p_new.display_name is distinct from p_old.display_name then
    return next private.activity_row('lists', 'item.renamed', r.id::text, r.household_id,
      jsonb_build_object('item', r.display_name, 'from', p_old.display_name));
  end if;
  if p_new.note is distinct from p_old.note then
    return next private.activity_row('lists', 'item.edited', r.id::text, r.household_id,
      v_data || jsonb_build_object('fields', jsonb_build_array('note')));
  end if;
  if p_new.photo_path is not null and p_new.photo_path is distinct from p_old.photo_path then
    return next private.activity_row('lists', 'item.photo_added', r.id::text, r.household_id, v_data);
  elsif p_new.photo_path is null and p_old.photo_path is not null then
    return next private.activity_row('lists', 'item.photo_removed', r.id::text, r.household_id, v_data);
  end if;
end;
$$;

create function private.activity_list_item_contributions(p_old public.list_item_contributions, p_new public.list_item_contributions)
returns setof private.activity_entry
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.list_item_contributions := coalesce(p_new, p_old);
  v_item public.list_items;
  v_data jsonb;
  v_fields text[];
begin
  -- A hard delete (the item's cascade) and a merge re-pointing it at another item log nothing.
  if p_new is null then
    return;
  end if;

  select * into v_item from public.list_items li where li.id = r.list_item_id;
  v_data := jsonb_build_object(
    'list', (select l.name from public.lists l where l.id = v_item.list_id),
    'item', v_item.display_name);

  if p_old is null then
    v_data := v_data || jsonb_build_object(
      'list_id', v_item.list_id, 'item_id', r.list_item_id,
      'source', r.source, 'quantity', r.quantity, 'unit', r.unit);
    if r.source = 'recipe' then
      v_data := v_data || jsonb_build_object(
        'recipe', (select rc.name from public.recipes rc where rc.id = r.recipe_id),
        'recipe_id', r.recipe_id);
    end if;
    return next private.activity_row('lists', 'item.added', r.id::text, r.household_id, v_data);
    return;
  end if;

  if p_old.deleted_at is null and p_new.deleted_at is not null then
    return next private.activity_row('lists', 'item.add_undone', r.id::text, r.household_id, v_data);
  end if;
  v_fields := array_remove(array[
    case when p_new.quantity is distinct from p_old.quantity then 'quantity' end,
    case when p_new.unit is distinct from p_old.unit then 'unit' end], null);
  if cardinality(v_fields) > 0 then
    return next private.activity_row('lists', 'item.edited', r.id::text, r.household_id,
      v_data || jsonb_build_object('fields', to_jsonb(v_fields)));
  end if;
end;
$$;

create function private.activity_recipes(p_old public.recipes, p_new public.recipes)
returns setof private.activity_entry
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.recipes := coalesce(p_new, p_old);
  v_data jsonb := jsonb_build_object('recipe', r.name);
  v_fields text[];
begin
  if p_old is null then
    return next private.activity_row('recipes', 'recipe.created', r.id::text, r.household_id,
      v_data || jsonb_build_object('source', private.activity_recipe_source(r)));
    return;
  end if;
  if p_new is null then
    if p_old.deleted_at is null then
      return next private.activity_row('recipes', 'recipe.deleted', r.id::text, r.household_id, v_data);
    end if;
    return;
  end if;

  if p_old.deleted_at is null and p_new.deleted_at is not null then
    return next private.activity_row('recipes', 'recipe.deleted', r.id::text, r.household_id, v_data);
  elsif p_old.deleted_at is not null and p_new.deleted_at is null then
    return next private.activity_row('recipes', 'recipe.restored', r.id::text, r.household_id, v_data);
  end if;
  if p_new.name is distinct from p_old.name then
    return next private.activity_row('recipes', 'recipe.renamed', r.id::text, r.household_id,
      v_data || jsonb_build_object('from', p_old.name));
  end if;
  if p_new.tags is distinct from p_old.tags then
    return next private.activity_row('recipes', 'recipe.tagged', r.id::text, r.household_id, v_data);
  end if;
  if p_new.photo_path is not null and p_new.photo_path is distinct from p_old.photo_path then
    return next private.activity_row('recipes', 'recipe.photo_added', r.id::text, r.household_id, v_data);
  elsif p_new.photo_path is null and p_old.photo_path is not null then
    return next private.activity_row('recipes', 'recipe.photo_removed', r.id::text, r.household_id, v_data);
  end if;
  -- Every other field, by name only (never the text: notes and steps are the user's).
  v_fields := array(
    select f from unnest(private.activity_changed(to_jsonb(p_old), to_jsonb(p_new))) f
    where f not in ('id', 'household_id', 'added_by', 'deleted_at', 'name', 'tags', 'tags_edited', 'photo_path'));
  if cardinality(v_fields) > 0 then
    return next private.activity_row('recipes', 'recipe.edited', r.id::text, r.household_id,
      v_data || jsonb_build_object('fields', to_jsonb(v_fields)));
  end if;
end;
$$;

create function private.activity_recipe_ingredients(p_old public.recipe_ingredients, p_new public.recipe_ingredients)
returns setof private.activity_entry
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.recipe_ingredients := coalesce(p_new, p_old);
  v_data jsonb := jsonb_build_object(
    'recipe', (select rc.name from public.recipes rc where rc.id = r.recipe_id),
    'recipe_id', r.recipe_id,
    'ingredient', r.display_name);
  v_fields text[];
begin
  if p_old is null then
    return next private.activity_row('recipes', 'ingredient.added', r.id::text, r.household_id, v_data);
    return;
  end if;
  if p_new is null then
    if p_old.deleted_at is null then
      return next private.activity_row('recipes', 'ingredient.removed', r.id::text, r.household_id, v_data);
    end if;
    return;
  end if;

  if p_old.deleted_at is null and p_new.deleted_at is not null then
    return next private.activity_row('recipes', 'ingredient.removed', r.id::text, r.household_id, v_data);
    return;
  elsif p_old.deleted_at is not null and p_new.deleted_at is null then
    return next private.activity_row('recipes', 'ingredient.added', r.id::text, r.household_id, v_data);
    return;
  end if;
  v_fields := array(
    select f from unnest(private.activity_changed(to_jsonb(p_old), to_jsonb(p_new))) f
    where f not in ('id', 'recipe_id', 'household_id', 'deleted_at'));
  if v_fields = array['position'] then
    return next private.activity_row('recipes', 'ingredient.reordered', r.id::text, r.household_id, v_data);
  elsif cardinality(v_fields) > 0 then
    return next private.activity_row('recipes', 'ingredient.edited', r.id::text, r.household_id,
      v_data || jsonb_build_object('fields', to_jsonb(v_fields)));
  end if;
end;
$$;

create function private.activity_meal_plan_entries(p_old public.meal_plan_entries, p_new public.meal_plan_entries)
returns setof private.activity_entry
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.meal_plan_entries := coalesce(p_new, p_old);
  v_recipe text := (select rc.name from public.recipes rc where rc.id = r.recipe_id);
  -- A note's text isn't kept.
  v_data jsonb := jsonb_build_object('date', r.plan_date, 'meal', r.meal, 'kind', r.kind)
    || case when r.kind = 'recipe' then jsonb_build_object('recipe', v_recipe, 'recipe_id', r.recipe_id) else '{}' end;
begin
  if p_old is null then
    return next private.activity_row('plan', 'plan.added', r.id::text, r.household_id, v_data);
    return;
  end if;
  if p_new is null then
    if p_old.deleted_at is null then
      return next private.activity_row('plan', 'plan.removed', r.id::text, r.household_id, v_data);
    end if;
    return;
  end if;

  if p_old.deleted_at is null and p_new.deleted_at is not null then
    return next private.activity_row('plan', 'plan.removed', r.id::text, r.household_id, v_data);
  elsif p_old.deleted_at is not null and p_new.deleted_at is null then
    return next private.activity_row('plan', 'plan.restored', r.id::text, r.household_id, v_data);
  end if;
  if p_new.plan_date is distinct from p_old.plan_date or p_new.meal is distinct from p_old.meal then
    return next private.activity_row('plan', 'plan.moved', r.id::text, r.household_id, jsonb_build_object(
      'from', jsonb_build_object('date', p_old.plan_date, 'meal', p_old.meal),
      'to', jsonb_build_object('date', p_new.plan_date, 'meal', p_new.meal),
      'recipe', v_recipe));
  elsif private.activity_changed(to_jsonb(p_old), to_jsonb(p_new)) = array['position'] then
    return next private.activity_row('plan', 'plan.reordered', r.id::text, r.household_id,
      jsonb_build_object('date', r.plan_date, 'meal', r.meal, 'recipe', v_recipe));
  end if;
end;
$$;

-- Custom aisles only: system categories have no household.
create function private.activity_categories(p_old public.categories, p_new public.categories)
returns setof private.activity_entry
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.categories := coalesce(p_new, p_old);
begin
  if r.household_id is null then
    return;
  end if;
  if p_old is null then
    return next private.activity_row('aisles', 'aisle.created', r.id::text, r.household_id,
      jsonb_build_object('aisle', r.name));
  elsif p_new is null then
    return next private.activity_row('aisles', 'aisle.deleted', r.id::text, r.household_id,
      jsonb_build_object('aisle', r.name));
  elsif p_new.name is distinct from p_old.name then
    return next private.activity_row('aisles', 'aisle.renamed', r.id::text, r.household_id,
      jsonb_build_object('aisle', p_new.name, 'from', p_old.name));
  end if;
end;
$$;

-- A null category is Reset to default, as is a delete, unless the delete is the cascade of its
-- custom aisle being deleted (the aisle's own entry covers it).
create function private.activity_household_category_overrides(p_old public.household_category_overrides, p_new public.household_category_overrides)
returns setof private.activity_entry
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.household_category_overrides := coalesce(p_new, p_old);
begin
  if p_new is null then
    if p_old.category_id is not null
      and not exists (select 1 from public.categories c where c.id = p_old.category_id)
    then
      return;
    end if;
  elsif not (p_old is null) and p_new.category_id is not distinct from p_old.category_id then
    return;
  end if;
  return next private.activity_row('aisles', 'aisle.assigned', r.ingredient_name, r.household_id,
    jsonb_build_object(
      'ingredient', r.ingredient_name,
      'aisle', (select c.name from public.categories c where c.id = p_new.category_id)));
end;
$$;

create function private.activity_household_staples(p_old public.household_staples, p_new public.household_staples)
returns setof private.activity_entry
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.household_staples := coalesce(p_new, p_old);
  v_action text;
begin
  if p_new is null then
    v_action := case when p_old.deleted_at is null then 'staple.removed' end;
  elsif p_old is null then
    v_action := case when p_new.deleted_at is null then 'staple.added' end;
  elsif p_old.deleted_at is not null and p_new.deleted_at is null then
    v_action := 'staple.added';
  elsif p_old.deleted_at is null and p_new.deleted_at is not null then
    v_action := 'staple.removed';
  end if;
  if v_action is not null then
    return next private.activity_row('aisles', v_action, r.ingredient_name, r.household_id,
      jsonb_build_object('ingredient', r.ingredient_name));
  end if;
end;
$$;

create function private.activity_user_settings(p_old public.user_settings, p_new public.user_settings)
returns setof private.activity_entry
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not (p_new is null) and p_new.default_list_id is distinct from p_old.default_list_id then
    return next private.activity_row('settings', 'settings.default_list', null, null, jsonb_build_object(
      'list', (select l.name from public.lists l where l.id = p_new.default_list_id)));
  end if;
end;
$$;

-- Once per transaction however many aisles moved: the first write sets app.activity_aisle_order.
create function private.activity_user_category_order(p_old public.user_category_order, p_new public.user_category_order)
returns setof private.activity_entry
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(current_setting('app.activity_aisle_order', true), '') = '' then
    perform set_config('app.activity_aisle_order', 'logged', true);
    return next private.activity_row('settings', 'settings.aisle_order', null, null, '{}');
  end if;
end;
$$;

create function private.activity_notification_settings(p_old public.notification_settings, p_new public.notification_settings)
returns setof private.activity_entry
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_fields text[];
begin
  if p_new is null then
    return;
  end if;
  v_fields := array(
    select f from unnest(private.activity_changed(coalesce(to_jsonb(p_old), '{}'), to_jsonb(p_new))) f
    where f <> 'user_id');
  if cardinality(v_fields) > 0 then
    return next private.activity_row('settings', 'settings.notifications', null, null,
      jsonb_build_object('fields', to_jsonb(v_fields)));
  end if;
end;
$$;

-- The token is never logged, only its platform. A token moving to the caller (another account
-- signed out on the phone) is registering it.
create function private.activity_push_tokens(p_old public.push_tokens, p_new public.push_tokens)
returns setof private.activity_entry
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_new is null then
    return next private.activity_row('devices', 'device.unregistered', null, null,
      jsonb_build_object('platform', p_old.platform));
  elsif p_old is null or p_new.user_id is distinct from p_old.user_id or p_new.platform is distinct from p_old.platform then
    return next private.activity_row('devices', 'device.registered', null, null,
      jsonb_build_object('platform', p_new.platform));
  end if;
end;
$$;

-- households, household_members and household_invites have no function: they're written only by the
-- household functions (and sign-up), whose one entry comes from app.activity_action.

do $$
declare
  t text;
begin
  foreach t in array array['lists', 'list_items', 'list_item_contributions', 'recipes', 'recipe_ingredients',
    'meal_plan_entries', 'categories', 'household_category_overrides', 'household_staples', 'user_settings',
    'user_category_order', 'notification_settings', 'push_tokens']
  loop
    execute format('revoke all on function private.activity_%1$s(public.%1$I, public.%1$I) from public, anon, authenticated', t);
  end loop;
end $$;

-- The household functions' one entry --------------------------------------------------------------

create function private.set_activity_action(p_action text, p_household_id uuid, p_entity_id text, p_data jsonb)
returns void
language sql
set search_path = ''
as $$
  select set_config('app.activity_action', jsonb_build_object(
    'action', p_action, 'household_id', p_household_id, 'entity_id', p_entity_id, 'data', p_data)::text, true);
$$;

-- Already logged: the rest of the function's writes log nothing. Also used to log nothing at all.
create function private.suppress_activity()
returns void
language sql
set search_path = ''
as $$ select set_config('app.activity_action', '{"logged": true}', true); $$;

create function private.clear_activity_action()
returns void
language sql
set search_path = ''
as $$ select set_config('app.activity_action', '', true); $$;

revoke all on function private.set_activity_action(text, uuid, text, jsonb) from public, anon, authenticated;
revoke all on function private.suppress_activity() from public, anon, authenticated;
revoke all on function private.clear_activity_action() from public, anon, authenticated;

-- The trigger --------------------------------------------------------------------------------------

create function private.log_user_activity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
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
      when 'meal_plan_entries' then
        select array_agg(e) into v_entries from private.activity_meal_plan_entries(old, new) e;
      when 'categories' then
        select array_agg(e) into v_entries from private.activity_categories(old, new) e;
      when 'household_category_overrides' then
        select array_agg(e) into v_entries from private.activity_household_category_overrides(old, new) e;
      when 'household_staples' then
        select array_agg(e) into v_entries from private.activity_household_staples(old, new) e;
      when 'user_settings' then
        select array_agg(e) into v_entries from private.activity_user_settings(old, new) e;
      when 'user_category_order' then
        select array_agg(e) into v_entries from private.activity_user_category_order(old, new) e;
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

revoke all on function private.log_user_activity() from public, anon, authenticated;

do $$
declare
  t text;
begin
  foreach t in array array['lists', 'list_items', 'list_item_contributions', 'recipes', 'recipe_ingredients',
    'meal_plan_entries', 'categories', 'household_category_overrides', 'household_staples', 'user_settings',
    'user_category_order', 'notification_settings', 'households', 'household_members', 'household_invites',
    'push_tokens']
  loop
    execute format(
      'create trigger %1$s_log_user_activity after insert or update or delete on public.%1$I '
      'for each row execute function private.log_user_activity()', t);
  end loop;
end $$;

-- The household functions, each now setting its action first and clearing it at the end ----------

create or replace function public.create_household(p_id uuid, p_name text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if p_id is null then
    raise exception 'household id is required' using errcode = '22023';
  end if;
  if p_name is null or trim(p_name) = '' then
    raise exception 'household name cannot be blank' using errcode = '22023';
  end if;

  -- Serializes one user's calls, so two can't both pass the membership check.
  perform pg_advisory_xact_lock(hashtextextended('create_household:' || v_uid::text, 0));

  if exists (
    select 1 from public.household_members hm
    where hm.household_id = p_id and hm.user_id = v_uid
  ) then
    return;
  end if;
  if exists (select 1 from public.household_members hm where hm.user_id = v_uid) then
    raise exception 'already in a household' using errcode = 'P0001';
  end if;

  perform private.set_activity_action('household.created', p_id, p_id::text, jsonb_build_object('household', p_name));

  insert into public.households (id, name, created_by)
  values (p_id, p_name, v_uid)
  on conflict (id) do nothing;

  if not found then
    raise exception 'household % already exists', p_id using errcode = '42501';
  end if;

  insert into public.household_members (household_id, user_id, role, position)
  select p_id, v_uid, 'owner', coalesce(max(hm.position), 0) + 1
  from public.household_members hm
  where hm.user_id = v_uid;

  insert into public.household_plans (household_id, plan_id)
  select p_id, p.id from public.plans p where p.is_default;

  perform private.clear_activity_action();
end;
$$;

create or replace function public.delete_household(p_household_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_members uuid[];
  v_member uuid;
  v_new_household_id uuid;
  v_caller_household_id uuid;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  perform 1 from public.households h where h.id = p_household_id for update;

  if not exists (
    select 1 from public.household_members hm
    where hm.household_id = p_household_id and hm.user_id = v_uid and hm.role = 'owner'
  ) then
    raise exception 'not an owner' using errcode = '42501';
  end if;

  perform private.set_activity_action('household.deleted', p_household_id, p_household_id::text,
    jsonb_build_object('household', (select h.name from public.households h where h.id = p_household_id)));

  select array_agg(hm.user_id order by hm.joined_at, hm.user_id) into v_members
  from public.household_members hm
  where hm.household_id = p_household_id;

  update public.user_settings us set default_list_id = null
  where us.user_id = any (v_members)
    and us.default_list_id in (select l.id from public.lists l where l.household_id = p_household_id);

  delete from public.households h where h.id = p_household_id;

  foreach v_member in array v_members loop
    if not exists (select 1 from public.household_members hm where hm.user_id = v_member) then
      v_new_household_id := private.create_personal_household(v_member);
      if v_member = v_uid then
        v_caller_household_id := v_new_household_id;
      end if;
    end if;
  end loop;

  perform private.clear_activity_action();
  return jsonb_build_object('new_household_id', v_caller_household_id);
end;
$$;

create or replace function public.leave_household(p_household_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_result jsonb;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  perform private.set_activity_action('household.left', p_household_id, p_household_id::text,
    jsonb_build_object('household', (select h.name from public.households h where h.id = p_household_id)));

  -- Raises 'not a member' (and rolls everything back) if the caller isn't in it.
  v_result := private.leave_and_rehome(p_household_id, v_uid);

  perform private.clear_activity_action();
  return v_result;
end;
$$;

create or replace function public.remove_member(p_household_id uuid, p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_result jsonb;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.household_members hm
    where hm.household_id = p_household_id and hm.user_id = v_uid and hm.role = 'owner'
  ) then
    raise exception 'not an owner' using errcode = '42501';
  end if;

  if p_user_id = v_uid then
    raise exception 'cannot remove yourself; use leave_household' using errcode = '22023';
  end if;

  perform private.set_activity_action('member.removed', p_household_id, p_user_id::text, jsonb_build_object(
    'household', (select h.name from public.households h where h.id = p_household_id),
    'member', (select p.display_name from public.profiles p where p.user_id = p_user_id),
    'member_id', p_user_id,
    'role', (select hm.role from public.household_members hm
             where hm.household_id = p_household_id and hm.user_id = p_user_id)));

  -- Raises 'not a member' if p_user_id isn't in it.
  v_result := private.leave_and_rehome(p_household_id, p_user_id);

  perform private.clear_activity_action();
  return v_result;
end;
$$;

create or replace function public.rename_household(p_household_id uuid, p_name text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_name text := trim(p_name);
  v_role text;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  select hm.role into v_role
  from public.household_members hm
  where hm.household_id = p_household_id and hm.user_id = v_uid;

  if v_role is null then
    raise exception 'not a member' using errcode = '42501';
  end if;
  if v_role <> 'owner' then
    raise exception 'not an owner' using errcode = '42501';
  end if;

  if v_name is null or v_name = '' then
    raise exception 'household name cannot be blank' using errcode = '22023';
  end if;
  if char_length(v_name) > 50 then
    raise exception 'household name is too long' using errcode = '22023';
  end if;

  perform private.set_activity_action('household.renamed', p_household_id, p_household_id::text,
    jsonb_build_object('household', v_name,
      'from', (select h.name from public.households h where h.id = p_household_id)));

  -- The same name is a no-op, so it doesn't bump updated_at or send a realtime change.
  update public.households h set name = v_name
  where h.id = p_household_id and h.name is distinct from v_name;

  perform private.clear_activity_action();
end;
$$;

create or replace function public.set_combine_languages(p_household_id uuid, p_on boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.household_members hm where hm.household_id = p_household_id and hm.user_id = v_uid
  ) then
    raise exception 'not a member' using errcode = '42501';
  end if;
  if p_on is null then
    raise exception 'combine_languages must be true or false' using errcode = '22023';
  end if;

  perform private.set_activity_action('household.combine_languages', p_household_id, p_household_id::text,
    jsonb_build_object('household', (select h.name from public.households h where h.id = p_household_id), 'on', p_on));

  -- The same value is a no-op, so it doesn't bump updated_at or send a realtime change.
  update public.households h set combine_languages = p_on
  where h.id = p_household_id and h.combine_languages is distinct from p_on;

  perform private.clear_activity_action();
end;
$$;

-- The entry never holds the invited email: it's read from the invite while that exists (4.12).
create or replace function public.create_invite(p_household_id uuid, p_email text default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_email text := lower(btrim(p_email));
  v_token text;
  v_invite_id uuid := gen_random_uuid();
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.household_members hm
    where hm.household_id = p_household_id and hm.user_id = v_uid
  ) then
    raise exception 'not a member of household %', p_household_id using errcode = '42501';
  end if;

  perform private.set_activity_action('invite.created', p_household_id, v_invite_id::text, jsonb_build_object(
    'household', (select h.name from public.households h where h.id = p_household_id),
    'invite_id', v_invite_id));

  if v_email is not null then
    if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
      raise exception 'invalid email' using errcode = '22023';
    end if;
    if exists (
      select 1 from public.household_members hm
      join auth.users u on u.id = hm.user_id
      where hm.household_id = p_household_id and lower(u.email) = v_email
    ) then
      raise exception 'already a member' using errcode = '23505';
    end if;
    update public.household_invites i set revoked_at = now()
    where i.household_id = p_household_id and i.invited_email = v_email
      and i.used_at is null and i.revoked_at is null and i.declined_at is null;
  end if;

  -- 24 random bytes, URL-safe base64 without padding: 32 characters.
  v_token := translate(encode(extensions.gen_random_bytes(24), 'base64'), '+/', '-_');

  insert into public.household_invites (id, household_id, token_hash, created_by, expires_at, invited_email)
  values (v_invite_id, p_household_id, private.invite_token_hash(v_token), v_uid, now() + interval '7 days', v_email);

  perform private.clear_activity_action();
  return v_token;
end;
$$;

create or replace function public.revoke_invite(p_invite_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_household_id uuid;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  select i.household_id into v_household_id from public.household_invites i where i.id = p_invite_id;
  if not found then
    raise exception 'invite not found' using errcode = 'P0002';
  end if;
  if not exists (
    select 1 from public.household_members hm
    where hm.household_id = v_household_id and hm.user_id = v_uid
  ) then
    raise exception 'not a member of household %', v_household_id using errcode = '42501';
  end if;

  perform private.set_activity_action('invite.revoked', v_household_id, p_invite_id::text, jsonb_build_object(
    'household', (select h.name from public.households h where h.id = v_household_id),
    'invite_id', p_invite_id));

  update public.household_invites i set revoked_at = now()
  where i.id = p_invite_id and i.used_at is null and i.revoked_at is null and i.declined_at is null;

  perform private.clear_activity_action();
end;
$$;

create or replace function public.decline_invite(p_invite_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_invite public.household_invites := private.my_invite(p_invite_id);
begin
  if v_invite.used_at is not null or v_invite.revoked_at is not null or v_invite.declined_at is not null then
    raise exception 'invite already used' using errcode = '22023';
  end if;

  perform private.set_activity_action('invite.declined', v_invite.household_id, v_invite.id::text, jsonb_build_object(
    'household', (select h.name from public.households h where h.id = v_invite.household_id),
    'invite_id', v_invite.id));

  update public.household_invites i set declined_at = now() where i.id = v_invite.id;

  perform private.clear_activity_action();
end;
$$;

-- Both accept_invite and accept_invite_by_id come through here.
create or replace function private.accept_household_invite(p_invite_id uuid, p_uid uuid)
returns table (household_id uuid, household_name text, already_member boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_invite public.household_invites;
  v_name text;
begin
  -- Locked, so two people accepting the same invite at once can't both join.
  select * into v_invite from public.household_invites i where i.id = p_invite_id for update;
  if not found then
    raise exception 'invite not found' using errcode = 'P0002';
  end if;

  select h.name into v_name from public.households h where h.id = v_invite.household_id;

  if exists (
    select 1 from public.household_members hm
    where hm.household_id = v_invite.household_id and hm.user_id = p_uid
  ) then
    return query select v_invite.household_id, v_name, true;
    return;
  end if;
  if v_invite.used_at is not null or v_invite.revoked_at is not null or v_invite.declined_at is not null then
    raise exception 'invite already used' using errcode = '22023';
  end if;
  if v_invite.expires_at <= now() then
    raise exception 'invite expired' using errcode = '22023';
  end if;

  perform private.set_activity_action('invite.accepted', v_invite.household_id, v_invite.id::text,
    jsonb_build_object('household', v_name, 'invite_id', v_invite.id));

  insert into public.household_members (household_id, user_id, role, position)
  select v_invite.household_id, p_uid, 'member', coalesce(max(hm.position), 0) + 1
  from public.household_members hm
  where hm.user_id = p_uid;

  update public.household_invites i set used_by = p_uid, used_at = now() where i.id = v_invite.id;

  perform private.clear_activity_action();
  return query select v_invite.household_id, v_name, false;
end;
$$;

create or replace function public.set_member_role(p_household_id uuid, p_user_id uuid, p_role text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_current text;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  -- Serialize role changes and leaving, so two owners demoting each other can't leave none.
  perform 1 from public.households h where h.id = p_household_id for update;

  if not exists (
    select 1 from public.household_members hm
    where hm.household_id = p_household_id and hm.user_id = v_uid and hm.role = 'owner'
  ) then
    raise exception 'not an owner' using errcode = '42501';
  end if;

  if p_role is null or p_role not in ('owner', 'member') then
    raise exception 'invalid role' using errcode = '22023';
  end if;

  select hm.role into v_current from public.household_members hm
  where hm.household_id = p_household_id and hm.user_id = p_user_id;
  if not found then
    raise exception 'not a member' using errcode = '42501';
  end if;

  if v_current = p_role then
    return;
  end if;

  if p_role = 'member' and not exists (
    select 1 from public.household_members hm
    where hm.household_id = p_household_id and hm.role = 'owner' and hm.user_id <> p_user_id
  ) then
    raise exception 'last owner' using errcode = 'P0001';
  end if;

  perform private.set_activity_action('member.role_changed', p_household_id, p_user_id::text, jsonb_build_object(
    'household', (select h.name from public.households h where h.id = p_household_id),
    'member', (select p.display_name from public.profiles p where p.user_id = p_user_id),
    'member_id', p_user_id,
    'role', p_role));

  update public.household_members hm set role = p_role
  where hm.household_id = p_household_id and hm.user_id = p_user_id;

  perform private.clear_activity_action();
end;
$$;

-- Deleting a user (delete_account, admin.delete_user) ---------------------------------------------
-- Its own writes log nothing, then the user's entries are deleted and they're scrubbed from other
-- users' member entries (4.8): the portal then says "a member".
create or replace function private.delete_user_core(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_household record;
  v_outcome text;
  v_entry jsonb;
  v_households jsonb := '[]';
begin
  perform private.suppress_activity();

  for v_household in
    select h.id, h.name
    from public.household_members hm
    join public.households h on h.id = hm.household_id
    where hm.user_id = p_user_id
    order by hm.position, h.id
  loop
    v_outcome := private.remove_member_from_household(v_household.id, p_user_id);
    v_entry := jsonb_build_object('id', v_household.id, 'name', v_household.name, 'outcome', v_outcome);
    if v_outcome = 'promoted' then
      v_entry := v_entry || jsonb_build_object('promoted_user_id', (
        select hm.user_id from public.household_members hm
        where hm.household_id = v_household.id and hm.role = 'owner'
      ));
    end if;
    v_households := v_households || jsonb_build_array(v_entry);
  end loop;

  delete from auth.users u where u.id = p_user_id;

  delete from private.user_activity a where a.user_id = p_user_id;
  update private.user_activity a set data = a.data - 'member' - 'member_id'
  where a.action in ('member.removed', 'member.role_changed') and a.data ->> 'member_id' = p_user_id::text;

  perform private.clear_activity_action();
  return v_households;
end;
$$;

-- Retention: 90 days, daily at 03:47 UTC.
select cron.schedule(
  'user-activity-retention',
  '47 3 * * *',
  $$delete from private.user_activity where created_at < now() - interval '90 days'$$
);
