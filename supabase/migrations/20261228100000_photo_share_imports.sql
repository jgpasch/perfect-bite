-- Photo shares (spec 5, 6.12): a share import is either a link or 1 to 3 photographed pages.
--
--   * share_imports gains `kind` ('link' default, or 'photo'); `url` and `url_key` become nullable,
--     with a check that a link has both and a photo neither. A photo has `page_count` (1 to 3) and
--     `images`, its share-images object paths in page order, nulled once they're deleted (the
--     lifecycle is a later migration). `dismissed_at` is set by dismiss_share_import (also later).
--   * The private Storage bucket share-images (jpeg only, 2 MB; also in supabase/config.toml), objects
--     at <user_id>/<share_import_id>/<n>.jpg. No client policies: only the service role (share-ingest
--     uploads, the worker reads and copies) touches it.
--   * my_share_imports adds `kind`, `page_count` and `pages_kept` (`images is not null`) and leaves
--     out dismissed rows. share_import_status still reports them, so reconcile sees the operation
--     is on the server and never submits it again.
--   * reserve_share_import charges a photo share with check_recipe_photo_limit (per-minute
--     `recipe_import_photo`, the shared daily and monthly allowances), a link as before.
--   * retry_share_import refuses (`retry_refused`, detail 'pages') a photo share whose images are
--     gone: there's nothing left to read.

alter table public.share_imports
  add column kind text not null default 'link' check (kind in ('link', 'photo')),
  add column page_count integer check (page_count between 1 and 3),
  add column images text[],
  add column dismissed_at timestamptz,
  alter column url drop not null,
  alter column url_key drop not null;

alter table public.share_imports add constraint share_imports_kind_fields_check check (
  case kind
    when 'link' then url is not null and url_key is not null and page_count is null and images is null
    when 'photo' then url is null and url_key is null and page_count is not null
                      and (images is null or cardinality(images) = page_count)
  end
);

-- share-images ------------------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('share-images', 'share-images', false, 2097152, array['image/jpeg'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- my_share_imports --------------------------------------------------------------------------------
-- As before (20261210093000_share_imports.sql), plus kind, page_count and pages_kept, and without
-- dismissed rows. Dropped and made again, since columns are added in the middle.

drop view public.my_share_imports;
create view public.my_share_imports as
  select id, household_id, list_id, add_to_list, kind, url, title, page_count, images is not null as pages_kept,
         status, attempts, next_attempt_at, error_code, error_kind, resets_at, recipe_id, applied_list_id,
         list_gone, items_added, items_combined, committed_at, client_created_at, created_at, updated_at
  from public.share_imports
  where user_id = auth.uid() and dismissed_at is null;

revoke all on table public.my_share_imports from public, anon, authenticated, service_role;
grant select on table public.my_share_imports to authenticated;

-- reserve_share_import ----------------------------------------------------------------------------
-- As before, but a photo share is charged as a photo import.

create or replace function public.reserve_share_import(p_id uuid, p_lease uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.share_imports := private.leased_share_import(p_id, p_lease, array['extracting'], true);
  v_answer text;
begin
  if v_job.metered_at is not null then
    return 'ok';
  end if;

  if v_job.kind = 'photo' then
    v_answer := public.check_recipe_photo_limit(v_job.user_id, v_job.household_id);
  else
    v_answer := public.check_recipe_import_limit(v_job.user_id, v_job.household_id);
  end if;
  if v_answer = 'ok' then
    update public.share_imports set metered_at = now() where id = p_id;
  end if;
  return v_answer;
end;
$$;

-- retry_share_import ------------------------------------------------------------------------------
-- As before (20261221100000_share_import_limits.sql), plus: a photo share whose images are gone is
-- refused.

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
