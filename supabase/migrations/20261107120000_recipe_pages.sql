-- A recipe's original pages (spec 4.10, 5): recipes.source_pages, the private Storage bucket
-- recipe-pages, and server-side cleanup of pages no recipe points at any more.
--
-- It works like a recipe's own photo (20261029120000_recipe_photo_storage.sql) and an item's photo
-- (20261106120000_item_photos.sql). Objects live at <household_id>/<recipe_id>/<uuid>.jpg in
-- recipe-pages (jpeg only, 2 MB). Members of the household in the first folder can read, upload and
-- delete there; nobody else can, and nobody can update (a new page is a new object).
--
-- recipes.source_pages is a synced column, field-level last-writer-wins like photo_path (the whole
-- array is one field). apply_mutations needs no change (recipe_steps.sql): every recipes column that
-- isn't a key or server-owned is settable on insert and update.
--
-- Cleanup: a sibling of private.recipe_photo_deletions, so each queue knows its bucket. The triggers
-- queue
--   - source_pages changed or cleared: each old path no longer in the array;
--   - a recipe row deleted (a purge, or its household's cascade): its '<household_id>/<recipe_id>/'
--     prefix, which also catches uploads that never made it into source_pages;
--   - a household deleted: its whole '<household_id>/' prefix in recipe-pages.
-- photo-cleanup drains this queue with the others; a queued page a recipe points at again (Undo) is
-- dropped.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('recipe-pages', 'recipe-pages', false, 2097152, array['image/jpeg'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Storage policies -------------------------------------------------------------------------------
-- The first folder is the household. Compared as text, so a malformed name never throws.

create policy recipe_pages_select_member on storage.objects
  for select to authenticated
  using (
    bucket_id = 'recipe-pages'
    and (storage.foldername(name))[1] in (select h::text from private.my_household_ids() h)
  );

create policy recipe_pages_insert_member on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'recipe-pages'
    and name ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}\.jpg$'
    and (storage.foldername(name))[1] in (select h::text from private.my_household_ids() h)
  );

create policy recipe_pages_delete_member on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'recipe-pages'
    and (storage.foldername(name))[1] in (select h::text from private.my_household_ids() h)
  );

-- The column -------------------------------------------------------------------------------------

alter table public.recipes
  add column source_pages jsonb;

-- source_pages: null = none, else an array of 1–3 distinct paths in page order, each
-- '<household_id>/<recipe_id>/<uuid>.jpg', lowercase as Postgres prints uuids, in the recipe's own
-- household and under its own id. A check can't hold a subquery, so the elements are checked here.
create function private.recipe_source_pages_ok(p_pages jsonb, p_household_id uuid, p_recipe_id uuid)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select pg_catalog.jsonb_typeof(p_pages) = 'array'
    and pg_catalog.jsonb_array_length(p_pages) between 1 and 3
    and not exists (
      select 1 from pg_catalog.jsonb_array_elements(p_pages) p
      where pg_catalog.jsonb_typeof(p) <> 'string'
        or (p #>> '{}') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$'
        or pg_catalog.split_part(p #>> '{}', '/', 1) <> p_household_id::text
        or pg_catalog.split_part(p #>> '{}', '/', 2) <> p_recipe_id::text
    )
    and (select count(distinct p) from pg_catalog.jsonb_array_elements(p_pages) p)
      = pg_catalog.jsonb_array_length(p_pages)
$$;

-- The check runs as the caller, as policies do.
revoke all on function private.recipe_source_pages_ok(jsonb, uuid, uuid) from public, anon;
grant execute on function private.recipe_source_pages_ok(jsonb, uuid, uuid) to authenticated;

alter table public.recipes
  add constraint recipes_source_pages_shape check (
    source_pages is null or private.recipe_source_pages_ok(source_pages, household_id, id)
  );

-- The cleanup queue ------------------------------------------------------------------------------

create table private.recipe_page_deletions (
  id bigint generated always as identity primary key,
  -- An object's name, or a prefix ('<household_id>/' or '<household_id>/<recipe_id>/') when is_prefix.
  path text not null,
  is_prefix boolean not null default false,
  queued_at timestamptz not null default now()
);

revoke all on table private.recipe_page_deletions from public, anon, authenticated;
alter table private.recipe_page_deletions enable row level security;

create function private.queue_recipe_page_deletion()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_table_name = 'households' then
    insert into private.recipe_page_deletions (path, is_prefix) values (old.id::text || '/', true);
  elsif tg_op = 'DELETE' then
    insert into private.recipe_page_deletions (path, is_prefix)
    values (old.household_id::text || '/' || old.id::text || '/', true);
  elsif old.source_pages is not null then
    insert into private.recipe_page_deletions (path)
    select p.path
    from pg_catalog.jsonb_array_elements_text(old.source_pages) with ordinality as p (path, n)
    where new.source_pages is null or not (new.source_pages ? p.path)
    order by p.n;
  end if;
  return null;
end;
$$;

revoke all on function private.queue_recipe_page_deletion() from public, anon, authenticated;

create trigger recipes_queue_page_deletion_update
  after update of source_pages on public.recipes
  for each row execute function private.queue_recipe_page_deletion();

create trigger recipes_queue_page_deletion_delete
  after delete on public.recipes
  for each row execute function private.queue_recipe_page_deletion();

create trigger households_queue_recipe_page_deletion
  after delete on public.households
  for each row execute function private.queue_recipe_page_deletion();

-- The sweep --------------------------------------------------------------------------------------
-- As claim_recipe_photo_deletions and complete_recipe_photo_deletions, over recipe-pages. A page a
-- recipe points at again is never claimed: its own entry is dropped, and a prefix leaves it out.

create function public.claim_recipe_page_deletions(p_limit integer default 100, p_min_age interval default interval '1 hour')
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
      select d.id, d.path, d.is_prefix from private.recipe_page_deletions d
      where d.queued_at <= now() - p_min_age
      order by d.id
      limit greatest(p_limit, 0)
    )
    select due.id, due.path from due where not due.is_prefix
    union all
    select due.id, o.name from due
      join storage.objects o on o.bucket_id = 'recipe-pages' and pg_catalog.starts_with(o.name, due.path)
      where due.is_prefix
        and not exists (select 1 from public.recipes r where r.source_pages ? o.name)
    order by 1, 2;
end;
$$;

create function public.complete_recipe_page_deletions(p_ids bigint[])
returns void
language sql
security definer
set search_path = ''
as $$
  delete from private.recipe_page_deletions where id = any (p_ids);
$$;

revoke all on function public.claim_recipe_page_deletions(integer, interval) from public, anon, authenticated;
revoke all on function public.complete_recipe_page_deletions(bigint[]) from public, anon, authenticated;
grant execute on function public.claim_recipe_page_deletions(integer, interval) to service_role;
grant execute on function public.complete_recipe_page_deletions(bigint[]) to service_role;

-- The same cron job calls photo-cleanup when any of the three queues has anything in it.
create or replace function private.request_recipe_photo_cleanup()
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url');
  v_key text := (select decrypted_secret from vault.decrypted_secrets where name = 'photo_cleanup_key');
begin
  if v_url is null or v_key is null or not (
    exists (select 1 from private.recipe_photo_deletions)
    or exists (select 1 from private.item_photo_deletions)
    or exists (select 1 from private.recipe_page_deletions)
  ) then
    return false;
  end if;
  perform net.http_post(
    url := pg_catalog.rtrim(v_url, '/') || '/functions/v1/photo-cleanup',
    headers := jsonb_build_object('Content-Type', 'application/json', 'apikey', v_key),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  return true;
end;
$$;

revoke all on function private.request_recipe_photo_cleanup() from public, anon, authenticated;
