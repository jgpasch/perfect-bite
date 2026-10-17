-- photo-search no longer depends on one provider (spec 4.5, 6.11): the Edge Function picks one with
-- PHOTO_SEARCH_PROVIDER (Pixabay by default, since new Pexels keys were paused), and the database
-- doesn't name any.
--
-- recipes.photo_credit: `provider` is now the service's name as the credit shows it ("Pixabay"),
-- 1–40 characters, instead of the literal 'pexels'. Otherwise the shape is unchanged.
alter table public.recipes drop constraint recipes_photo_credit_shape;
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
      else pg_catalog.char_length(photo_credit ->> 'provider') between 1 and 40
        and pg_catalog.char_length(photo_credit ->> 'author') between 1 and 200
        and pg_catalog.starts_with(photo_credit ->> 'authorUrl', 'https://')
        and pg_catalog.char_length(photo_credit ->> 'authorUrl') <= 2048
        and pg_catalog.starts_with(photo_credit ->> 'pageUrl', 'https://')
        and pg_catalog.char_length(photo_credit ->> 'pageUrl') <= 2048
    end
  );

-- The cache key now starts with the provider and language ('pixabay:es:pollo asado'), so an
-- answer cached under one provider is never served for another. Pixabay's image URLs expire 24
-- hours after the search, so an answer is used for 23 hours, leaving time to pick a photo from it.
-- Retention still drops rows over 24 hours old.
create or replace function public.get_photo_search_cache(p_query_key text, p_page integer)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select answer from private.photo_search_cache
  where query_key = p_query_key and page = p_page and fetched_at > now() - interval '23 hours'
$$;

-- Answers cached before the key changed (no provider, no `provider` in the answer) can't be hit
-- again; clear them rather than wait for retention.
delete from private.photo_search_cache;
