-- Household data and user settings (spec 5). Mirrors the app's SQLite tables so the device's
-- data can be pushed up (dev push now, M5 sync later). Ids are client-generated UUIDv7, deletes
-- are soft (deleted_at), and field_clock is reserved for M5's field-level LWW (7.3).
--
-- Members read and write their households' rows directly for now. M5 moves writes behind
-- apply_mutations. created_at may come from the device (its creation time); updated_at is always
-- server-set.
--
-- Child rows carry household_id (denormalized for RLS). Composite foreign keys tie it to the
-- parent's household, so a row can't point at another household's list or recipe.

-- ---------------------------------------------------------------------------
-- Lists and recipes
-- ---------------------------------------------------------------------------

create table public.lists (
  id           uuid primary key,
  household_id uuid not null references public.households on delete cascade,
  name         text not null,
  emoji        text,
  position     double precision not null,
  archived_at  timestamptz,
  deleted_at   timestamptz,
  field_clock  jsonb not null default '{}',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (id, household_id)
);
create index lists_household_id_idx on public.lists (household_id);

create table public.recipes (
  id           uuid primary key,
  household_id uuid not null references public.households on delete cascade,
  name         text not null,
  notes        text,
  source_url   text,
  deleted_at   timestamptz,
  field_clock  jsonb not null default '{}',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (id, household_id)
);
create index recipes_household_id_idx on public.recipes (household_id);

-- ---------------------------------------------------------------------------
-- List items and their contributions (spec 4.4)
-- ---------------------------------------------------------------------------

create table public.list_items (
  id              uuid primary key,
  list_id         uuid not null,
  household_id    uuid not null references public.households on delete cascade,
  ingredient_name text not null references public.ingredients,
  display_name    text not null,                                -- what the user typed or said
  note            text,
  checked_at      timestamptz,
  checked_by      uuid references auth.users on delete set null,
  added_by        uuid references auth.users on delete set null,
  deleted_at      timestamptz,
  field_clock     jsonb not null default '{}',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (id, household_id),
  foreign key (list_id, household_id) references public.lists (id, household_id) on delete cascade
);
create index list_items_list_id_idx on public.list_items (list_id);
create index list_items_household_id_idx on public.list_items (household_id);
-- At most one live unchecked item per ingredient per list.
create unique index one_open_item_per_ingredient
  on public.list_items (list_id, ingredient_name)
  where deleted_at is null and checked_at is null;

-- One row per add; quantity lives here, not on the item.
create table public.list_item_contributions (
  id           uuid primary key,
  list_item_id uuid not null,
  household_id uuid not null references public.households on delete cascade,
  source       text not null default 'manual' check (source in ('manual', 'recipe', 'siri')),
  recipe_id    uuid,                                            -- set when source = 'recipe'
  quantity     numeric,                                         -- null = unspecified
  unit         text,
  added_by     uuid references auth.users on delete set null,
  deleted_at   timestamptz,
  field_clock  jsonb not null default '{}',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  foreign key (list_item_id, household_id) references public.list_items (id, household_id) on delete cascade,
  foreign key (recipe_id, household_id) references public.recipes (id, household_id)
);
create index list_item_contributions_list_item_id_idx on public.list_item_contributions (list_item_id);
create index list_item_contributions_household_id_idx on public.list_item_contributions (household_id);
create index list_item_contributions_recipe_id_idx on public.list_item_contributions (recipe_id);

-- ---------------------------------------------------------------------------
-- Recipe ingredients (spec 4.5)
-- ---------------------------------------------------------------------------

create table public.recipe_ingredients (
  id              uuid primary key,
  recipe_id       uuid not null,
  household_id    uuid not null references public.households on delete cascade,
  ingredient_name text not null references public.ingredients,
  display_name    text not null,
  quantity        numeric,
  unit            text,
  note            text,
  position        double precision not null,
  deleted_at      timestamptz,
  field_clock     jsonb not null default '{}',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  foreign key (recipe_id, household_id) references public.recipes (id, household_id) on delete cascade
);
create index recipe_ingredients_recipe_id_idx on public.recipe_ingredients (recipe_id);
create index recipe_ingredients_household_id_idx on public.recipe_ingredients (household_id);

-- ---------------------------------------------------------------------------
-- Household ingredient history for autocomplete (spec 4.2). Rows go away when an undo takes
-- use_count to 0, so this table allows deletes.
-- ---------------------------------------------------------------------------

create table public.ingredient_usage (
  household_id    uuid not null references public.households on delete cascade,
  ingredient_name text not null,                                -- ingredient key
  display_name    text not null,                                -- most recent text typed for it
  use_count       int not null default 0,
  last_used_at    timestamptz not null,
  hidden_at       timestamptz,                                  -- "Remove from suggestions"
  field_clock     jsonb not null default '{}',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  primary key (household_id, ingredient_name)
);

-- ---------------------------------------------------------------------------
-- Per-user settings
-- ---------------------------------------------------------------------------

create table public.user_settings (
  user_id         uuid primary key references auth.users on delete cascade,
  default_list_id uuid references public.lists on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Unknown ingredients on insert (spec 5): list items and recipe ingredients can name an
-- ingredient the catalog hasn't seen. Add it as pending (categorization picks it up, M6) and
-- record the household for household_count.
-- ---------------------------------------------------------------------------

create function private.ensure_ingredient()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.ingredients (normalized_name, display_name)
  values (new.ingredient_name, new.display_name)
  on conflict (normalized_name) do nothing;

  insert into public.ingredient_households (ingredient_name, household_id)
  values (new.ingredient_name, new.household_id)
  on conflict do nothing;
  if found then
    update public.ingredients
    set household_count = household_count + 1
    where normalized_name = new.ingredient_name;
  end if;

  return new;
end;
$$;

revoke all on function private.ensure_ingredient() from public, anon, authenticated;

create trigger list_items_ensure_ingredient
  before insert on public.list_items
  for each row execute function private.ensure_ingredient();

create trigger recipe_ingredients_ensure_ingredient
  before insert on public.recipe_ingredients
  for each row execute function private.ensure_ingredient();

-- ---------------------------------------------------------------------------
-- updated_at, RLS and grants
-- ---------------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array[
    'lists', 'recipes', 'list_items', 'list_item_contributions', 'recipe_ingredients',
    'ingredient_usage', 'user_settings'
  ] loop
    execute format(
      'create trigger %1$s_set_updated_at before insert or update on public.%1$I
         for each row execute function private.set_updated_at()', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
  end loop;

  -- Household tables: members read and write their households' rows.
  foreach t in array array[
    'lists', 'recipes', 'list_items', 'list_item_contributions', 'recipe_ingredients',
    'ingredient_usage'
  ] loop
    execute format('grant select, insert, update on public.%I to authenticated', t);
    execute format(
      'create policy %1$s_member on public.%1$I for all to authenticated
         using (household_id in (select private.my_household_ids()))
         with check (household_id in (select private.my_household_ids()))', t);
  end loop;
end;
$$;

-- Soft deletes everywhere else; ingredient_usage rows are removed for real.
grant delete on public.ingredient_usage to authenticated;

grant select, insert, update, delete on public.user_settings to authenticated;

create policy user_settings_own on public.user_settings
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
