-- Who to credit for a recipe's own photo when it came from a stock photo service (spec 4.5, 5).
-- Nullable (null = no credit: a library or camera photo, or no own photo) and field-level
-- last-writer-wins like photo_path. The app always writes it together with photo_path, so the two
-- share a clock and win or lose together.
--
-- apply_mutations needs no change (recipe_steps.sql): every recipes column that isn't a key or
-- server-owned is settable on insert and update.

alter table public.recipes
  add column photo_credit jsonb;

-- photo_credit: exactly { "provider": "pexels", "author": <1–200 characters>, "authorUrl":
-- <https://, at most 2048 characters>, "pageUrl": <the same> }, and only with a photo_path. The
-- tests are cases, not ands, because the jsonb functions throw on the wrong type and an and
-- needn't short-circuit.
alter table public.recipes
  add constraint recipes_photo_credit_shape check (
    photo_credit is null or case
      when photo_path is null then false
      when pg_catalog.jsonb_typeof(photo_credit) <> 'object' then false
      when not (photo_credit ?& array['provider', 'author', 'authorUrl', 'pageUrl'])
        or photo_credit - array['provider', 'author', 'authorUrl', 'pageUrl'] <> '{}'::jsonb
        then false
      when pg_catalog.jsonb_typeof(photo_credit -> 'provider') <> 'string'
        or pg_catalog.jsonb_typeof(photo_credit -> 'author') <> 'string'
        or pg_catalog.jsonb_typeof(photo_credit -> 'authorUrl') <> 'string'
        or pg_catalog.jsonb_typeof(photo_credit -> 'pageUrl') <> 'string'
        then false
      else photo_credit ->> 'provider' = 'pexels'
        and pg_catalog.char_length(photo_credit ->> 'author') between 1 and 200
        and pg_catalog.starts_with(photo_credit ->> 'authorUrl', 'https://')
        and pg_catalog.char_length(photo_credit ->> 'authorUrl') <= 2048
        and pg_catalog.starts_with(photo_credit ->> 'pageUrl', 'https://')
        and pg_catalog.char_length(photo_credit ->> 'pageUrl') <= 2048
    end
  );
