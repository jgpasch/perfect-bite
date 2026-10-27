-- Share imports and photo cleanup tidy-ups (architecture review).
--
-- share_imports.household_id and list_id get the foreign keys they were missing: a deleted
-- household takes its share imports with it, and a deleted list leaves list_id null (the worker
-- then falls back to the sharer's default or first list, as for an archived one). Rows already
-- pointing at a household that's gone are deleted first, and list ids pointing at a list that's
-- gone are cleared.
--
-- The three photo-cleanup claims (recipe photos, item photos, recipe pages) now lease what they
-- return: each claimed entry gets claimed_at = now(), and an entry claimed less than 10 minutes ago
-- isn't claimed again, so a run that overlaps a slower one doesn't remove the same objects. A run
-- that dies without completing leaves its entries to be claimed again once the lease is up.

-- Share imports -----------------------------------------------------------------------------------

delete from public.share_imports s
where not exists (select 1 from public.households h where h.id = s.household_id);

update public.share_imports s
set list_id = null
where s.list_id is not null
  and not exists (select 1 from public.lists l where l.id = s.list_id);

alter table public.share_imports
  add constraint share_imports_household_id_fkey
    foreign key (household_id) references public.households (id) on delete cascade,
  add constraint share_imports_list_id_fkey
    foreign key (list_id) references public.lists (id) on delete set null;

-- Deleting a household or a list looks its share imports up by these.
create index share_imports_household_id_idx on public.share_imports (household_id);
create index share_imports_list_id_idx on public.share_imports (list_id) where list_id is not null;

-- Cleanup leases ----------------------------------------------------------------------------------

alter table private.recipe_photo_deletions add column claimed_at timestamptz;
alter table private.item_photo_deletions add column claimed_at timestamptz;
alter table private.recipe_page_deletions add column claimed_at timestamptz;

-- As before (20261029120000_recipe_photo_storage.sql), but only entries not claimed within the
-- lease, and those it returns are marked claimed. `skip locked` keeps two runs at the same moment
-- apart too.
create or replace function public.claim_recipe_photo_deletions(p_limit integer default 100, p_min_age interval default interval '1 hour')
returns table (queue_id bigint, name text)
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from private.recipe_photo_deletions d
  where not d.is_prefix
    and (
      exists (select 1 from public.recipes r where r.photo_path = d.path)
      or not exists (select 1 from storage.objects o where o.bucket_id = 'recipe-photos' and o.name = d.path)
    );

  delete from private.recipe_photo_deletions d
  where d.is_prefix
    and not exists (
      select 1 from storage.objects o
      where o.bucket_id = 'recipe-photos' and pg_catalog.starts_with(o.name, d.path)
    );

  return query
    with due as (
      select d.id from private.recipe_photo_deletions d
      where d.queued_at <= now() - p_min_age
        and (d.claimed_at is null or d.claimed_at <= now() - interval '10 minutes')
      order by d.id
      limit greatest(p_limit, 0)
      for update skip locked
    ),
    claimed as (
      update private.recipe_photo_deletions d set claimed_at = now()
      from due where d.id = due.id
      returning d.id, d.path, d.is_prefix
    )
    select claimed.id, claimed.path from claimed where not claimed.is_prefix
    union all
    select claimed.id, o.name from claimed
      join storage.objects o on o.bucket_id = 'recipe-photos' and pg_catalog.starts_with(o.name, claimed.path)
      where claimed.is_prefix
    order by 1, 2;
end;
$$;

-- As claim_recipe_photo_deletions, over item-photos (20261106120000_item_photos.sql).
create or replace function public.claim_item_photo_deletions(p_limit integer default 100, p_min_age interval default interval '1 hour')
returns table (queue_id bigint, name text)
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from private.item_photo_deletions d
  where not d.is_prefix
    and (
      exists (select 1 from public.list_items li where li.photo_path = d.path)
      or not exists (select 1 from storage.objects o where o.bucket_id = 'item-photos' and o.name = d.path)
    );

  delete from private.item_photo_deletions d
  where d.is_prefix
    and not exists (
      select 1 from storage.objects o
      where o.bucket_id = 'item-photos' and pg_catalog.starts_with(o.name, d.path)
    );

  return query
    with due as (
      select d.id from private.item_photo_deletions d
      where d.queued_at <= now() - p_min_age
        and (d.claimed_at is null or d.claimed_at <= now() - interval '10 minutes')
      order by d.id
      limit greatest(p_limit, 0)
      for update skip locked
    ),
    claimed as (
      update private.item_photo_deletions d set claimed_at = now()
      from due where d.id = due.id
      returning d.id, d.path, d.is_prefix
    )
    select claimed.id, claimed.path from claimed where not claimed.is_prefix
    union all
    select claimed.id, o.name from claimed
      join storage.objects o on o.bucket_id = 'item-photos' and pg_catalog.starts_with(o.name, claimed.path)
      where claimed.is_prefix
    order by 1, 2;
end;
$$;

-- As claim_recipe_photo_deletions, over recipe-pages (20261107120000_recipe_pages.sql). A page a
-- recipe points at again is never claimed: its own entry is dropped, and a prefix leaves it out.
create or replace function public.claim_recipe_page_deletions(p_limit integer default 100, p_min_age interval default interval '1 hour')
returns table (queue_id bigint, name text)
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from private.recipe_page_deletions d
  where not d.is_prefix
    and (
      exists (select 1 from public.recipes r where r.source_pages ? d.path)
      or not exists (select 1 from storage.objects o where o.bucket_id = 'recipe-pages' and o.name = d.path)
    );

  delete from private.recipe_page_deletions d
  where d.is_prefix
    and not exists (
      select 1 from storage.objects o
      where o.bucket_id = 'recipe-pages' and pg_catalog.starts_with(o.name, d.path)
    );

  return query
    with due as (
      select d.id from private.recipe_page_deletions d
      where d.queued_at <= now() - p_min_age
        and (d.claimed_at is null or d.claimed_at <= now() - interval '10 minutes')
      order by d.id
      limit greatest(p_limit, 0)
      for update skip locked
    ),
    claimed as (
      update private.recipe_page_deletions d set claimed_at = now()
      from due where d.id = due.id
      returning d.id, d.path, d.is_prefix
    )
    select claimed.id, claimed.path from claimed where not claimed.is_prefix
    union all
    select claimed.id, o.name from claimed
      join storage.objects o on o.bucket_id = 'recipe-pages' and pg_catalog.starts_with(o.name, claimed.path)
      where claimed.is_prefix
        and not exists (select 1 from public.recipes r where r.source_pages ? o.name)
    order by 1, 2;
end;
$$;
