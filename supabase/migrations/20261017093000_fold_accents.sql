-- Accent folding in the ingredient key (spec 4.15). normalizeIngredientName now folds accents
-- (`limón` → `limon`), so every key written before it that has one is merged into its folded key,
-- once, across every table that holds an ingredient key:
--
-- - ingredients (the catalog): the keys that fold together keep one row: a categorized one first,
--   then a seed one, then the one already under the folded key. household_count carries the
--   households the other rows add (ingredient_households is merged too).
-- - ingredient_usage, ingredient_unit_usage: counts summed, the latest last_used_at; usage keeps
--   the display name and field_clock of its latest use, and stays hidden only if every row was.
-- - household_category_overrides, household_staples: the newest row wins (its field's HLC, then
--   updated_at).
-- - list_items, recipe_ingredients: the key is rewritten; display names keep what was typed. Two
--   open items for one folded key on a list merge as apply_mutations does (7.3): the older one
--   stays, the other is soft-deleted with merged_into set and its contributions move over.
--
-- The app runs the same merge on its SQLite once (src/features/categories/fold-accents.ts).
-- private.fold_accents must match foldAccents in src/shared/ingredient-normalizer.ts.

create function private.fold_accents(p_text text)
returns text
language sql
immutable strict parallel safe
set search_path = ''
as $$
  select pg_catalog.normalize(
    pg_catalog.regexp_replace(pg_catalog.normalize(p_text, 'NFD'), '[̀-ͯ]', '', 'g'), 'NFC')
$$;

revoke all on function private.fold_accents(text) from public, anon, authenticated;

create function private.fold_ingredient_keys()
returns void
language plpgsql
set search_path = ''
as $$
begin
  -- The catalog row each folded key keeps, with the households the merged rows add.
  create temp table fold_winners on commit drop as
  with folded as (
    select distinct private.fold_accents(normalized_name) as new_key
    from public.ingredients
    where private.fold_accents(normalized_name) <> normalized_name
  ),
  members as (
    select f.new_key, i.*
    from folded f
    join public.ingredients i on private.fold_accents(i.normalized_name) = f.new_key
  )
  select distinct on (m.new_key)
    m.*,
    (select count(distinct h.household_id) from public.ingredient_households h
      join members o on o.normalized_name = h.ingredient_name and o.new_key = m.new_key)
    - (select count(*) from public.ingredient_households h where h.ingredient_name = m.normalized_name)
      as added_households
  from members m
  order by m.new_key, (m.status = 'categorized') desc, (m.categorized_by = 'seed') desc nulls last,
    (m.normalized_name = m.new_key) desc, m.created_at, m.normalized_name;

  insert into public.ingredients
    (normalized_name, display_name, default_category_id, status, is_grocery_item, categorized_by,
     default_unit, attempts, household_count, created_at)
  select new_key, display_name, default_category_id, status, is_grocery_item, categorized_by,
    default_unit, attempts, household_count + added_households, created_at
  from fold_winners
  on conflict (normalized_name) do update set
    display_name = excluded.display_name,
    default_category_id = excluded.default_category_id,
    status = excluded.status,
    is_grocery_item = excluded.is_grocery_item,
    categorized_by = excluded.categorized_by,
    default_unit = excluded.default_unit,
    attempts = excluded.attempts,
    household_count = excluded.household_count,
    created_at = excluded.created_at;

  insert into public.ingredient_households (ingredient_name, household_id)
  select private.fold_accents(ingredient_name), household_id
  from public.ingredient_households
  where private.fold_accents(ingredient_name) <> ingredient_name
  on conflict do nothing;

  -- List items: merge clashing open items, then rewrite every key.
  create temp table fold_item_merges on commit drop as
  with open_items as (
    select li.id, li.list_id, li.created_at, private.fold_accents(li.ingredient_name) as new_key,
      li.ingredient_name
    from public.list_items li
    where li.deleted_at is null and li.checked_at is null
  ),
  ranked as (
    select o.id, o.new_key, o.list_id,
      first_value(o.id) over (partition by o.list_id, o.new_key order by o.created_at, o.id) as keeper,
      bool_or(o.ingredient_name <> o.new_key) over (partition by o.list_id, o.new_key) as touched
    from open_items o
  )
  select id, keeper from ranked where touched and id <> keeper;

  update public.list_item_contributions c
  set list_item_id = m.keeper
  from fold_item_merges m
  where c.list_item_id = m.id;

  update public.list_items li
  set deleted_at = now(), merged_into = m.keeper
  from fold_item_merges m
  where li.id = m.id;

  update public.list_items
  set ingredient_name = private.fold_accents(ingredient_name)
  where private.fold_accents(ingredient_name) <> ingredient_name;

  update public.recipe_ingredients
  set ingredient_name = private.fold_accents(ingredient_name)
  where private.fold_accents(ingredient_name) <> ingredient_name;

  -- Usage: sums and the latest use.
  insert into public.ingredient_usage
    (household_id, ingredient_name, display_name, use_count, last_used_at, hidden_at, field_clock, created_at)
  select g.household_id, g.new_key, latest.display_name, g.use_count, g.last_used_at, g.hidden_at,
    latest.field_clock, g.created_at
  from (
    select household_id, private.fold_accents(ingredient_name) as new_key, sum(use_count)::int as use_count,
      max(last_used_at) as last_used_at, min(created_at) as created_at,
      case when bool_and(hidden_at is not null) then max(hidden_at) end as hidden_at
    from public.ingredient_usage
    group by household_id, private.fold_accents(ingredient_name)
    having bool_or(private.fold_accents(ingredient_name) <> ingredient_name)
  ) g
  cross join lateral (
    select u.display_name, u.field_clock
    from public.ingredient_usage u
    where u.household_id = g.household_id and private.fold_accents(u.ingredient_name) = g.new_key
    order by u.last_used_at desc, (u.ingredient_name = g.new_key) desc
    limit 1
  ) latest
  on conflict (household_id, ingredient_name) do update set
    display_name = excluded.display_name,
    use_count = excluded.use_count,
    last_used_at = excluded.last_used_at,
    hidden_at = excluded.hidden_at,
    field_clock = excluded.field_clock,
    created_at = excluded.created_at;

  delete from public.ingredient_usage where private.fold_accents(ingredient_name) <> ingredient_name;

  insert into public.ingredient_unit_usage (household_id, ingredient_name, unit_key, use_count, last_used_at, created_at)
  select household_id, private.fold_accents(ingredient_name), unit_key, sum(use_count)::int, max(last_used_at),
    min(created_at)
  from public.ingredient_unit_usage
  group by household_id, private.fold_accents(ingredient_name), unit_key
  having bool_or(private.fold_accents(ingredient_name) <> ingredient_name)
  on conflict (household_id, ingredient_name, unit_key) do update set
    use_count = excluded.use_count,
    last_used_at = excluded.last_used_at,
    created_at = excluded.created_at;

  delete from public.ingredient_unit_usage where private.fold_accents(ingredient_name) <> ingredient_name;

  -- Household overrides and staples: the newest row wins.
  insert into public.household_category_overrides (household_id, ingredient_name, category_id, field_clock, created_at)
  select distinct on (household_id, private.fold_accents(ingredient_name))
    household_id, private.fold_accents(ingredient_name), category_id, field_clock, created_at
  from public.household_category_overrides o
  where exists (
    select 1 from public.household_category_overrides x
    where x.household_id = o.household_id
      and private.fold_accents(x.ingredient_name) = private.fold_accents(o.ingredient_name)
      and private.fold_accents(x.ingredient_name) <> x.ingredient_name)
  order by household_id, private.fold_accents(ingredient_name),
    field_clock ->> 'category_id' collate "C" desc nulls last, updated_at desc, ingredient_name collate "C"
  on conflict (household_id, ingredient_name) do update set
    category_id = excluded.category_id,
    field_clock = excluded.field_clock,
    created_at = excluded.created_at;

  delete from public.household_category_overrides where private.fold_accents(ingredient_name) <> ingredient_name;

  insert into public.household_staples (household_id, ingredient_name, created_by, deleted_at, field_clock, created_at)
  select distinct on (household_id, private.fold_accents(ingredient_name))
    household_id, private.fold_accents(ingredient_name), created_by, deleted_at, field_clock, created_at
  from public.household_staples s
  where exists (
    select 1 from public.household_staples x
    where x.household_id = s.household_id
      and private.fold_accents(x.ingredient_name) = private.fold_accents(s.ingredient_name)
      and private.fold_accents(x.ingredient_name) <> x.ingredient_name)
  order by household_id, private.fold_accents(ingredient_name),
    field_clock ->> 'deleted_at' collate "C" desc nulls last, updated_at desc, ingredient_name collate "C"
  on conflict (household_id, ingredient_name) do update set
    created_by = excluded.created_by,
    deleted_at = excluded.deleted_at,
    field_clock = excluded.field_clock,
    created_at = excluded.created_at;

  delete from public.household_staples where private.fold_accents(ingredient_name) <> ingredient_name;

  -- Nothing references the accented keys now; their ingredient_households rows go with them.
  delete from public.ingredients where private.fold_accents(normalized_name) <> normalized_name;

  drop table fold_winners;
  drop table fold_item_merges;
end;
$$;

revoke all on function private.fold_ingredient_keys() from public, anon, authenticated;

select private.fold_ingredient_keys();
