-- A household's own recipe photos (spec 4.5, 5): a private Storage bucket, recipes.photo_path, and
-- server-side cleanup of objects no recipe points at any more.
--
-- Objects live at <household_id>/<recipe_id>/<uuid>.jpg in the private bucket recipe-photos (jpeg
-- only, 2 MB). Members of the household in the first folder can read, upload and delete there;
-- nobody else can, and nobody can update (a new photo is a new object).
--
-- recipes.photo_path is a synced column, field-level last-writer-wins like image_url. apply_mutations
-- needs no change (recipe_steps.sql): every recipes column that isn't a key or server-owned is
-- settable on insert and update.
--
-- Cleanup happens here, not on the device, so an offline or uninstalled device can't leave objects
-- behind. Storage refuses deletes from SQL (storage.protect_delete) and a row delete wouldn't remove
-- the file anyway, so triggers queue what to delete and the photo-cleanup Edge Function, called by
-- cron through pg_net, removes it through the Storage API:
--   - photo_path changed or cleared: the old object;
--   - a recipe row deleted (a purge, or its household's cascade): its object;
--   - a household deleted (by an owner, its last member leaving, or account deletion): its whole
--     prefix, which also catches uploads that never became a photo_path.
-- A queued object that a recipe points at again (Undo) is dropped from the queue, not deleted.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('recipe-photos', 'recipe-photos', false, 2097152, array['image/jpeg'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Storage policies -------------------------------------------------------------------------------
-- The first folder is the household. Compared as text, so a malformed name never throws.

create policy recipe_photos_select_member on storage.objects
  for select to authenticated
  using (
    bucket_id = 'recipe-photos'
    and (storage.foldername(name))[1] in (select h::text from private.my_household_ids() h)
  );

create policy recipe_photos_insert_member on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'recipe-photos'
    and name ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}\.jpg$'
    and (storage.foldername(name))[1] in (select h::text from private.my_household_ids() h)
  );

create policy recipe_photos_delete_member on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'recipe-photos'
    and (storage.foldername(name))[1] in (select h::text from private.my_household_ids() h)
  );

-- The column -------------------------------------------------------------------------------------

alter table public.recipes
  add column photo_path text;

-- <household_id>/<recipe_id>/<uuid>.jpg, lowercase as Postgres prints uuids, in the recipe's own
-- household.
alter table public.recipes
  add constraint recipes_photo_path_shape check (
    photo_path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$'
    and split_part(photo_path, '/', 1) = household_id::text
  );

-- The cleanup queue ------------------------------------------------------------------------------

create table private.recipe_photo_deletions (
  id bigint generated always as identity primary key,
  -- An object's name, or a household's prefix ('<household_id>/') when is_prefix.
  path text not null,
  is_prefix boolean not null default false,
  queued_at timestamptz not null default now()
);

revoke all on table private.recipe_photo_deletions from public, anon, authenticated;
alter table private.recipe_photo_deletions enable row level security;

create function private.queue_recipe_photo_deletion()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_table_name = 'households' then
    insert into private.recipe_photo_deletions (path, is_prefix) values (old.id::text || '/', true);
  elsif old.photo_path is not null
    and (tg_op = 'DELETE' or new.photo_path is distinct from old.photo_path) then
    insert into private.recipe_photo_deletions (path) values (old.photo_path);
  end if;
  return null;
end;
$$;

revoke all on function private.queue_recipe_photo_deletion() from public, anon, authenticated;

create trigger recipes_queue_photo_deletion_update
  after update of photo_path on public.recipes
  for each row execute function private.queue_recipe_photo_deletion();

create trigger recipes_queue_photo_deletion_delete
  after delete on public.recipes
  for each row execute function private.queue_recipe_photo_deletion();

create trigger households_queue_photo_deletion
  after delete on public.households
  for each row execute function private.queue_recipe_photo_deletion();

-- The sweep --------------------------------------------------------------------------------------

-- What photo-cleanup should delete now: queue entries at least p_min_age old (so an Undo a moment
-- later still finds its object), with the object names each stands for (a prefix: every object
-- under it). Entries with nothing to delete are dropped here: an object a recipe points at again,
-- or that is already gone, and a prefix with no objects left. The caller removes the names, then
-- calls complete_recipe_photo_deletions with the ids.
create function public.claim_recipe_photo_deletions(p_limit integer default 100, p_min_age interval default interval '1 hour')
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
      select d.id, d.path, d.is_prefix from private.recipe_photo_deletions d
      where d.queued_at <= now() - p_min_age
      order by d.id
      limit greatest(p_limit, 0)
    )
    select due.id, due.path from due where not due.is_prefix
    union all
    select due.id, o.name from due
      join storage.objects o on o.bucket_id = 'recipe-photos' and pg_catalog.starts_with(o.name, due.path)
      where due.is_prefix
    order by 1, 2;
end;
$$;

-- Done: drops the entries whose objects photo-cleanup removed.
create function public.complete_recipe_photo_deletions(p_ids bigint[])
returns void
language sql
security definer
set search_path = ''
as $$
  delete from private.recipe_photo_deletions where id = any (p_ids);
$$;

revoke all on function public.claim_recipe_photo_deletions(integer, interval) from public, anon, authenticated;
revoke all on function public.complete_recipe_photo_deletions(bigint[]) from public, anon, authenticated;
grant execute on function public.claim_recipe_photo_deletions(integer, interval) to service_role;
grant execute on function public.complete_recipe_photo_deletions(bigint[]) to service_role;

-- Calls photo-cleanup when there's anything queued, with the Vault secrets project_url (e.g.
-- https://<ref>.supabase.co) and photo_cleanup_key (a secret API key, sent as apikey). Without
-- them (a fresh local database) it does nothing and returns false.
create extension if not exists pg_net with schema extensions;

create function private.request_recipe_photo_cleanup()
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url');
  v_key text := (select decrypted_secret from vault.decrypted_secrets where name = 'photo_cleanup_key');
begin
  if v_url is null or v_key is null or not exists (select 1 from private.recipe_photo_deletions) then
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

-- Every 15 minutes.
select cron.schedule('recipe-photo-cleanup', '*/15 * * * *', $$select private.request_recipe_photo_cleanup()$$);
