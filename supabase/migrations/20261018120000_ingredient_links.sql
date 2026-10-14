-- Linked ingredients (spec 4.15, 5). Each catalog row gains its language and, for a non-English
-- name, the English ingredient it means:
--
-- - lang: 'en' | 'es'; null when not known (names the categorizer met before it reported one).
-- - same_as: the English ingredient this name is (`leche` → `milk`), only where the two are the
--   same thing on a shopping list. One level only: a target has no same_as of its own, and a name
--   never points at itself.
-- - linked_by: who made the link: 'seed', a model id, or 'admin'; null exactly when same_as is.
--
-- The seed migration (scripts/gen-seed-sql.ts) fills these for the English and Spanish seeds. The
-- app mirrors the three columns in its SQLite catalog (src/db/schema.ts) and pull copies them.

alter table public.ingredients
  add column lang      text check (lang in ('en', 'es')),
  add column same_as   text references public.ingredients (normalized_name),
  add column linked_by text,
  add constraint ingredients_same_as_not_self check (same_as <> normalized_name),
  add constraint ingredients_linked_by_with_link check ((same_as is null) = (linked_by is null));

-- Finds the names that point at a row (is it a target?) without a scan.
create index ingredients_same_as_idx on public.ingredients (same_as) where same_as is not null;

-- One level only: a link's target can't have a link itself, and a row that is a target can't gain
-- one. Link writes are rare (the seed, the categorizer, an admin), so they take one lock between
-- them: two links made at once can't build a chain that neither saw.
create function private.check_ingredient_link()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.same_as is null then
    return new;
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('public.ingredients.same_as'));
  if exists (select 1 from public.ingredients where normalized_name = new.same_as and same_as is not null) then
    raise exception 'ingredient % can''t link to %, which links to another ingredient', new.normalized_name, new.same_as
      using errcode = 'check_violation';
  end if;
  if exists (select 1 from public.ingredients where same_as = new.normalized_name) then
    raise exception 'ingredient % can''t link to %: other ingredients link to it', new.normalized_name, new.same_as
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

revoke all on function private.check_ingredient_link() from public, anon, authenticated;

create trigger ingredients_check_link
  before insert or update of same_as on public.ingredients
  for each row execute function private.check_ingredient_link();
