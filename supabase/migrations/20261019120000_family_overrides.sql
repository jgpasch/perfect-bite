-- Shared aisle across a family (spec 4.15, 4.3.2). Household aisle overrides are now written and
-- read under the ingredient's family key (its same_as, else its own key; `familyKey` in
-- src/shared/ingredient-normalizer.ts), so moving `milk` moves `leche` and the other way round.
--
-- An override already on a linked key (`leche` → `milk`) moves to its family key, once. When a
-- household has one on more than one name of a family (`leche` and `milk`), the newest wins (its
-- category's HLC, then updated_at), as in the fold-accents merge. Unlinked names (`tomate`) keep
-- their own. The moved rows get a new updated_at, so devices pull them; the old rows are deleted,
-- and a device's leftover copy is never read again, since the app reads the family key.

create function private.move_overrides_to_family_keys()
returns void
language plpgsql
set search_path = ''
as $$
begin
  insert into public.household_category_overrides (household_id, ingredient_name, category_id, field_clock, created_at)
  select distinct on (o.household_id, coalesce(i.same_as, o.ingredient_name))
    o.household_id, coalesce(i.same_as, o.ingredient_name), o.category_id, o.field_clock, o.created_at
  from public.household_category_overrides o
  join public.ingredients i on i.normalized_name = o.ingredient_name
  where exists (
    select 1 from public.household_category_overrides x
    join public.ingredients xi on xi.normalized_name = x.ingredient_name
    where x.household_id = o.household_id
      and xi.same_as = coalesce(i.same_as, o.ingredient_name))
  order by o.household_id, coalesce(i.same_as, o.ingredient_name),
    o.field_clock ->> 'category_id' collate "C" desc nulls last, o.updated_at desc, o.ingredient_name collate "C"
  on conflict (household_id, ingredient_name) do update set
    category_id = excluded.category_id,
    field_clock = excluded.field_clock,
    created_at = excluded.created_at;

  delete from public.household_category_overrides o
  using public.ingredients i
  where i.normalized_name = o.ingredient_name and i.same_as is not null;
end;
$$;

revoke all on function private.move_overrides_to_family_keys() from public, anon, authenticated;

select private.move_overrides_to_family_keys();
