-- Fewer server round trips (architecture review, Supabase perf):
--  * `fail_ingredients`: categorize's failed names in one statement, instead of a read and one
--    update per name (PostgREST can't express `attempts + 1`).
--  * `share_import_reuse_candidates`: the share-import worker's reuse candidates, the household's
--    recipes whose source URL can match the import's canonical URL (by an indexed lookup key),
--    instead of every live recipe with a source URL.
--  * `get_households_members`: the members of several households in one call, for the app's
--    names cache after a full pull, instead of one `get_household_members` per household.

-- categorize: failed names ------------------------------------------------------------------------

-- Sets `status = 'failed'`, `attempts + 1` and category Other on the named rows that aren't
-- categorized (a concurrent request's answer wins). A name listed twice counts once; a name with no
-- row is ignored.
create function public.fail_ingredients(p_names text[])
returns void
language sql
security definer
set search_path = ''
as $$
  update public.ingredients
  set status = 'failed',
      default_category_id = '019a4c10-0000-7000-8000-00000000ca20',  -- OTHER_CATEGORY_ID
      attempts = attempts + 1
  where normalized_name = any(p_names)
    and status <> 'categorized';
$$;

revoke all on function public.fail_ingredients(text[]) from public, anon, authenticated;
grant execute on function public.fail_ingredients(text[]) to service_role;

-- share import: reuse candidates ------------------------------------------------------------------

-- A source URL's lookup key: its host (lower case, one leading `www.` dropped) and path (trailing
-- slashes dropped), which is what `canonicalRecipeUrl` (src/shared/schemas/recipe-import.ts) makes of
-- them for a plain URL. Null when the URL isn't plain enough to be sure: not http(s), user info, a
-- character the URL parser would encode or map (non-ASCII, `%`, `\`, spaces), an IP-looking host,
-- empty labels, or `.`/`..` segments. A null key is always a candidate, so a URL the device or the
-- worker would canonicalize to the import's is never missed; the worker still compares canonical
-- URLs (`findReusableRecipe`).
create function private.recipe_url_lookup_key(p_url text)
returns text
language plpgsql
immutable
parallel safe
set search_path = ''
as $$
declare
  v_parts text[];
  v_host  text;
  v_last  text;
  v_path  text;
begin
  v_parts := regexp_match(
    p_url,
    '^https?://([a-z0-9.-]+)(?::[0-9]*)?(/[a-z0-9._~!$&''()*+,;=:@/-]*)?(?:[?#]|$)',
    'i');
  if v_parts is null then
    return null;
  end if;
  v_host := lower(v_parts[1]);
  -- The URL parser rewrites a host whose last label is a number as an IPv4 address.
  v_last := substring(v_host from '([^.]*)\.?$');
  if v_host ~ '^\.|\.\.' or v_last ~ '^[0-9]+$' or v_last ~ '^0x[0-9a-f]*$' then
    return null;
  end if;
  v_path := coalesce(v_parts[2], '');
  if v_path ~ '(^|/)\.{1,2}(/|$)' then
    return null;
  end if;
  return regexp_replace(v_host, '^www\.', '') || regexp_replace(v_path, '/+$', '');
end;
$$;

create index recipes_household_url_key_idx
  on public.recipes (household_id, private.recipe_url_lookup_key(source_url))
  where deleted_at is null and source_url is not null;

-- The live recipe with `p_import_recipe_id` (an earlier run of the same import), and the household's
-- live recipes with a source URL whose lookup key is `p_url_key` or null (`private.recipe_url_lookup_key`).
-- A null `p_url_key` (a photo import) gives only the first.
create function public.share_import_reuse_candidates(p_household_id uuid, p_import_recipe_id uuid, p_url_key text)
returns table (id uuid, name text, household_id uuid, source_url text, deleted_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select r.id, r.name, r.household_id, r.source_url, r.deleted_at
  from public.recipes r
  where r.id = p_import_recipe_id and r.deleted_at is null
  union all
  select r.id, r.name, r.household_id, r.source_url, r.deleted_at
  from public.recipes r
  where p_url_key is not null
    and r.household_id = p_household_id
    and r.deleted_at is null
    and r.source_url is not null
    and (private.recipe_url_lookup_key(r.source_url) = p_url_key
         or private.recipe_url_lookup_key(r.source_url) is null);
$$;

revoke all on function public.share_import_reuse_candidates(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.share_import_reuse_candidates(uuid, uuid, text) to service_role;

-- app: members of several households --------------------------------------------------------------

-- `get_household_members` for each of `p_household_ids` the caller is a member of, with the
-- household's id, by household, then in that function's order. A household the caller isn't in
-- (left, removed, a stale id) has no rows, rather than failing the others.
create function public.get_households_members(p_household_ids uuid[])
returns table (
  household_id uuid,
  user_id      uuid,
  first_name   text,
  last_name    text,
  avatar_url   text,
  role         text,
  joined_at    timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select hm.household_id, hm.user_id, p.first_name, p.last_name, p.avatar_url, hm.role, hm.joined_at
  from public.household_members hm
  join public.profiles p on p.user_id = hm.user_id
  where hm.household_id = any(p_household_ids)
    and exists (
      select 1 from public.household_members me
      where me.household_id = hm.household_id and me.user_id = (select auth.uid())
    )
  order by hm.household_id, hm.role = 'owner' desc, p.first_name, p.last_name nulls first, hm.user_id;
$$;

revoke all on function public.get_households_members(uuid[]) from public, anon, service_role;
grant execute on function public.get_households_members(uuid[]) to authenticated;
