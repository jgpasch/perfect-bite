-- Section headings in recipes.steps (spec 4.5 "Step sections", 5). An entry is now a step string
-- (1–2000 characters) or a heading { "section": <1–80 characters> }, optionally with "choice": true
-- and no other keys. At most 20 headings, at least one step, 1–100 entries in all. Every existing
-- row (strings only) stays valid. The constraint calls the function, so replacing it is enough.
create or replace function private.recipe_steps_ok(p_steps jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select pg_catalog.jsonb_typeof(p_steps) = 'array'
    and pg_catalog.jsonb_array_length(p_steps) between 1 and 100
    and not exists (
      select 1 from pg_catalog.jsonb_array_elements(p_steps) s
      -- A CASE, so jsonb_object_keys only ever sees an object; anything unknown (null) is refused.
      where not coalesce(case pg_catalog.jsonb_typeof(s)
        when 'string' then pg_catalog.char_length(s #>> '{}') between 1 and 2000
        when 'object' then pg_catalog.jsonb_typeof(s -> 'section') = 'string'
          and pg_catalog.char_length(s ->> 'section') between 1 and 80
          and (not (s ? 'choice') or s -> 'choice' = 'true'::jsonb)
          and not exists (
            select 1 from pg_catalog.jsonb_object_keys(s) k where k not in ('section', 'choice')
          )
      end, false)
    )
    and exists (
      select 1 from pg_catalog.jsonb_array_elements(p_steps) s where pg_catalog.jsonb_typeof(s) = 'string'
    )
    and (
      select pg_catalog.count(*) from pg_catalog.jsonb_array_elements(p_steps) s
      where pg_catalog.jsonb_typeof(s) = 'object'
    ) <= 20
$$;

-- create or replace keeps the grants; restated so the file reads on its own.
revoke all on function private.recipe_steps_ok(jsonb) from public, anon;
grant execute on function private.recipe_steps_ok(jsonb) to authenticated;
