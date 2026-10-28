-- Shared images: lifecycle and Dismiss (spec 5, 6.12, Q17).
--
--   * private.share_image_deletions, a sibling of private.recipe_page_deletions
--     (20261107120000_recipe_pages.sql) for the share-images bucket, swept by photo-cleanup through
--     claim_share_image_deletions / complete_share_image_deletions with the same 10-minute lease
--     (20261225093000_share_import_fks_cleanup_lease.sql), and counted by
--     request_recipe_photo_cleanup.
--   * A photo job's images go once nothing can read them again: a trigger nulls `images` when the job
--     becomes done, fails with not_a_recipe after metered_at (Try again refuses it), or is dismissed;
--     another queues the job's '<user_id>/<id>/' prefix whenever `images` turns null, or the row is
--     deleted with them (the user's or household's cascade included).
--   * share-imports-retention nulls (and so queues) the images of a failed job whose last failure is
--     more than 7 days old, and of any job older than 8 days. There's no failed_at: a failed row's
--     updated_at is its last failure, give or take the night's own `page` purge.
--   * dismiss_share_import(p_id) (the sharer, a failed row only) sets dismissed_at, and
--     retry_share_import refuses a dismissed row (`retry_refused`, detail 'dismissed').

-- The queue ---------------------------------------------------------------------------------------

create table private.share_image_deletions (
  id bigint generated always as identity primary key,
  -- An object's name, or a prefix ('<user_id>/<share_import_id>/') when is_prefix.
  path text not null,
  is_prefix boolean not null default false,
  queued_at timestamptz not null default now(),
  claimed_at timestamptz
);

revoke all on table private.share_image_deletions from public, anon, authenticated;
alter table private.share_image_deletions enable row level security;

-- Nulling images ----------------------------------------------------------------------------------

create function private.release_share_images()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.images is not null and (
    new.status = 'done'
    or (new.status = 'failed' and new.error_code = 'not_a_recipe' and new.metered_at is not null)
    or new.dismissed_at is not null
  ) then
    new.images := null;
  end if;
  return new;
end;
$$;

revoke all on function private.release_share_images() from public, anon, authenticated;

create trigger share_imports_release_images
  before update on public.share_imports
  for each row execute function private.release_share_images();

-- Queueing them -----------------------------------------------------------------------------------

create function private.queue_share_image_deletion()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into private.share_image_deletions (path, is_prefix)
  values (old.user_id::text || '/' || old.id::text || '/', true);
  return null;
end;
$$;

revoke all on function private.queue_share_image_deletion() from public, anon, authenticated;

-- Not `update of images`: that wouldn't see release_share_images' change, only a SET list's.
create trigger share_imports_queue_image_deletion_update
  after update on public.share_imports
  for each row when (old.images is not null and new.images is null)
  execute function private.queue_share_image_deletion();

create trigger share_imports_queue_image_deletion_delete
  after delete on public.share_imports
  for each row when (old.images is not null)
  execute function private.queue_share_image_deletion();

-- The sweep ---------------------------------------------------------------------------------------
-- As claim_recipe_photo_deletions (20261225093000_share_import_fks_cleanup_lease.sql), over
-- share-images.

create function public.claim_share_image_deletions(p_limit integer default 100, p_min_age interval default interval '1 hour')
returns table (queue_id bigint, name text)
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from private.share_image_deletions d
  where not d.is_prefix
    and not exists (select 1 from storage.objects o where o.bucket_id = 'share-images' and o.name = d.path);

  delete from private.share_image_deletions d
  where d.is_prefix
    and not exists (
      select 1 from storage.objects o
      where o.bucket_id = 'share-images' and pg_catalog.starts_with(o.name, d.path)
    );

  return query
    with due as (
      select d.id from private.share_image_deletions d
      where d.queued_at <= now() - p_min_age
        and (d.claimed_at is null or d.claimed_at <= now() - interval '10 minutes')
      order by d.id
      limit greatest(p_limit, 0)
      for update skip locked
    ),
    claimed as (
      update private.share_image_deletions d set claimed_at = now()
      from due where d.id = due.id
      returning d.id, d.path, d.is_prefix
    )
    select claimed.id, claimed.path from claimed where not claimed.is_prefix
    union all
    select claimed.id, o.name from claimed
      join storage.objects o on o.bucket_id = 'share-images' and pg_catalog.starts_with(o.name, claimed.path)
      where claimed.is_prefix
    order by 1, 2;
end;
$$;

create function public.complete_share_image_deletions(p_ids bigint[])
returns void
language sql
security definer
set search_path = ''
as $$
  delete from private.share_image_deletions where id = any (p_ids);
$$;

revoke all on function public.claim_share_image_deletions(integer, interval) from public, anon, authenticated;
revoke all on function public.complete_share_image_deletions(bigint[]) from public, anon, authenticated;
grant execute on function public.claim_share_image_deletions(integer, interval) to service_role;
grant execute on function public.complete_share_image_deletions(bigint[]) to service_role;

-- As before (20261107120000_recipe_pages.sql), when any of the four queues has anything in it.
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
    or exists (select 1 from private.share_image_deletions)
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

-- Retention ---------------------------------------------------------------------------------------
-- As before (20261210093000_share_imports.sql), plus the images of a failed job whose last failure
-- is more than 7 days old and of any job older than 8 days (nulled, so the trigger queues them).

create or replace function private.share_imports_retention()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.share_imports
  set images = null
  where images is not null
    and ((status = 'failed' and updated_at < now() - interval '7 days')
         or created_at < now() - interval '8 days');

  update public.share_imports
  set page = null
  where page is not null
    and (status in ('done', 'failed') or created_at < now() - interval '24 hours');

  update public.share_imports
  set extraction = null
  where extraction is not null
    and status = 'done'
    and coalesce(committed_at, updated_at) < now() - interval '7 days';

  delete from public.share_imports where created_at < now() - interval '1 year';
end;
$$;

revoke all on function private.share_imports_retention() from public, anon, authenticated, service_role;

-- dismiss_share_import ----------------------------------------------------------------------------
-- The sharer's Dismiss (4.10): hides a failed share from my_share_imports on every device, and its
-- images go (the trigger above). `not found` (P0002) for another user's or an unknown id; a row
-- that isn't failed is refused (55000), changing nothing. Dismissing again is harmless.

create function public.dismiss_share_import(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.share_imports;
begin
  select * into v_job
  from public.share_imports s
  where s.id = p_id and s.user_id = auth.uid()
  for update;
  if not found then
    raise exception 'not found' using errcode = 'P0002';
  end if;

  if v_job.status <> 'failed' then
    raise exception 'dismiss_refused' using errcode = '55000', detail = v_job.status;
  end if;

  if v_job.dismissed_at is null then
    update public.share_imports set dismissed_at = now() where id = p_id;
  end if;
end;
$$;

revoke all on function public.dismiss_share_import(uuid) from public, anon, service_role;
grant execute on function public.dismiss_share_import(uuid) to authenticated;

-- retry_share_import ------------------------------------------------------------------------------
-- As before (20261228100000_photo_share_imports.sql), plus: a dismissed share is refused.

create or replace function public.retry_share_import(p_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.share_imports;
begin
  select * into v_job
  from public.share_imports s
  where s.id = p_id and s.user_id = auth.uid()
  for update;
  if not found then
    raise exception 'not found' using errcode = 'P0002';
  end if;

  if v_job.status <> 'failed' then
    return v_job.status;
  end if;

  if v_job.dismissed_at is not null then
    raise exception 'retry_refused' using errcode = '55000', detail = 'dismissed';
  end if;
  if v_job.error_kind = 'permanent' and v_job.metered_at is not null then
    raise exception 'retry_refused' using errcode = '55000', detail = 'permanent';
  end if;
  if v_job.kind = 'photo' and v_job.images is null then
    raise exception 'retry_refused' using errcode = '55000', detail = 'pages';
  end if;
  if v_job.retries >= 3 then
    raise exception 'retry_refused' using errcode = '55000', detail = 'retries';
  end if;

  update public.share_imports
  set status = 'received', attempts = 0, retries = retries + 1, next_attempt_at = now(),
      error_code = null, error_kind = null, resets_at = null,
      lease_token = null, lease_expires_at = null
  where id = p_id;
  return 'received';
end;
$$;
