-- Recipe method steps, servings and photo (spec 5). All three are nullable and field-level
-- last-writer-wins like total_minutes (the whole steps array is one field). apply_mutations needs
-- no change: every recipes column that isn't a key or server-owned is settable on insert and update.
-- Existing recipes keep null.

alter table public.recipes
  add column steps     jsonb,
  add column servings  int,
  add column image_url text;

-- steps: null = none, else an array of 1–100 strings of 1–2000 characters each. A check can't
-- hold a subquery, so the per-step lengths are checked here.
create function private.recipe_steps_ok(p_steps jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select pg_catalog.jsonb_typeof(p_steps) = 'array'
    and pg_catalog.jsonb_array_length(p_steps) between 1 and 100
    and not exists (
      select 1 from pg_catalog.jsonb_array_elements(p_steps) s
      where pg_catalog.jsonb_typeof(s) <> 'string'
        or pg_catalog.char_length(s #>> '{}') not between 1 and 2000
    )
$$;

-- The check runs as the caller, as policies do.
revoke all on function private.recipe_steps_ok(jsonb) from public, anon;
grant execute on function private.recipe_steps_ok(jsonb) to authenticated;

alter table public.recipes
  add constraint recipes_steps_shape check (steps is null or private.recipe_steps_ok(steps)),
  add constraint recipes_servings_range check (servings between 1 and 100),
  add constraint recipes_image_url_shape check (
    image_url like 'https://%' and char_length(image_url) <= 2048
  );
