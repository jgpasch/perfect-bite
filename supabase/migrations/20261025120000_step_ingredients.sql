-- Which ingredients each method step uses (spec 4.5, 5). Nullable (null = never matched) and
-- field-level last-writer-wins like steps and tags: the whole value is one field.
--
-- apply_mutations needs no change, as for steps (recipe_steps.sql): every recipes column that
-- isn't a key or server-owned is settable on insert and update, so step_ingredients is too.
--
-- The ids aren't checked against recipe_ingredients: a deleted ingredient stays in the match and
-- the app drops it.

alter table public.recipes
  add column step_ingredients jsonb;

-- step_ingredients: { "v": <positive integer>, "basis": <1–64 characters>, "steps": [...] }, with
-- 1–100 steps, each an array of at most 80 uses { "id": <1–64 characters>, "quantity": null or
-- a positive number }. A check can't hold a subquery, so the nested shape is checked here. The
-- tests are cases, not ands, because the jsonb functions throw on the wrong type and an and
-- needn't short-circuit.
create function private.recipe_step_ingredients_ok(p_value jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case
    when pg_catalog.jsonb_typeof(p_value) <> 'object'
      or pg_catalog.jsonb_typeof(p_value -> 'v') is distinct from 'number'
      or pg_catalog.jsonb_typeof(p_value -> 'basis') is distinct from 'string'
      or pg_catalog.jsonb_typeof(p_value -> 'steps') is distinct from 'array'
      then false
    when (p_value ->> 'v') !~ '^[1-9][0-9]{0,5}$'
      or pg_catalog.char_length(p_value ->> 'basis') not between 1 and 64
      or pg_catalog.jsonb_array_length(p_value -> 'steps') not between 1 and 100
      then false
    when exists (
      select 1 from pg_catalog.jsonb_array_elements(p_value -> 'steps') s
      where case when pg_catalog.jsonb_typeof(s) <> 'array' then true
        else pg_catalog.jsonb_array_length(s) > 80 end
    )
      then false
    else not exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_value -> 'steps') s,
        pg_catalog.jsonb_array_elements(s) u
      where case
        when pg_catalog.jsonb_typeof(u) <> 'object'
          or pg_catalog.jsonb_typeof(u -> 'id') is distinct from 'string'
          then true
        when pg_catalog.char_length(u ->> 'id') not between 1 and 64 then true
        when pg_catalog.jsonb_typeof(u -> 'quantity') = 'null' then false
        when pg_catalog.jsonb_typeof(u -> 'quantity') = 'number' then (u ->> 'quantity')::numeric <= 0
        else true
      end
    )
  end
$$;

-- The check runs as the caller, as policies do.
revoke all on function private.recipe_step_ingredients_ok(jsonb) from public, anon;
grant execute on function private.recipe_step_ingredients_ok(jsonb) to authenticated;

alter table public.recipes
  add constraint recipes_step_ingredients_shape check (
    step_ingredients is null or private.recipe_step_ingredients_ok(step_ingredients)
  );
