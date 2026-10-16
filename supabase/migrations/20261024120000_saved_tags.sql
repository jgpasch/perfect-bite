-- The Saved tag facet: Favorite and Want to try (spec 4.14, 5). recipes.tags may now hold a sixth
-- key, `saved`, an array of strings like the other facets. A person sets it, never the AI. Existing
-- values without it are unchanged (the app reads a missing facet as empty).

alter table public.recipes
  drop constraint recipes_tags_shape,
  add constraint recipes_tags_shape check (
    tags is null or (
      jsonb_typeof(tags) = 'object'
      and tags - array['saved', 'meal', 'cuisine', 'protein', 'diet', 'method'] = '{}'::jsonb
      and not jsonb_path_exists(tags, 'strict $.* ? (@.type() != "array")')
      and not jsonb_path_exists(tags, 'strict $.*[*] ? (@.type() != "string")')
    )
  );
