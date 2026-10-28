-- share-ingest takes photo shares (spec 6.12):
--   * private.share_import_household: the household and list checks ingest_share_import made,
--     now shared by both kinds. ingest_share_import also answers 'conflict' for an id that's a
--     photo share (the same operation is the same user, kind and payload hash).
--   * ingest_photo_share_import: records a photo share (`kind 'photo'`, `page_count`, and `images`
--     at '<user_id>/<id>/<n>.jpg', n from 1, in share-images). With p_check_only it answers as it
--     would without inserting ('new' where it would insert), so share-ingest knows about an
--     operation_conflict, a resubmit or a refused household before it uploads anything.
--
-- Both are for the service role only.

-- ---------------------------------------------------------------------------
-- private.share_import_household: the share's household, or why it can't have one. One row:
-- `outcome` null and the household, or 'not_a_member' / 'invalid_list' and null. The household is
-- p_household_id, else the list's, else the household of the user's default list, else the user's
-- first; a list must be in it (archived or deleted lists are accepted, 4.10).
-- ---------------------------------------------------------------------------

create function private.share_import_household(p_user_id uuid, p_household_id uuid, p_list_id uuid)
returns table (outcome text, household_id uuid)
language plpgsql
stable
set search_path = ''
as $$
declare
  v_household uuid := p_household_id;
begin
  if v_household is null and p_list_id is not null then
    select l.household_id into v_household from public.lists l where l.id = p_list_id;
    if v_household is null then
      return query select 'invalid_list'::text, null::uuid;
      return;
    end if;
  end if;
  if v_household is null then
    select l.household_id into v_household
    from public.user_settings us
    join public.lists l on l.id = us.default_list_id
    join public.household_members m on m.household_id = l.household_id and m.user_id = us.user_id
    where us.user_id = p_user_id;
  end if;
  if v_household is null then
    select m.household_id into v_household
    from public.household_members m
    where m.user_id = p_user_id
    order by m.joined_at, m.household_id
    limit 1;
  end if;

  if v_household is null or not exists (
    select 1 from public.household_members m where m.household_id = v_household and m.user_id = p_user_id
  ) then
    return query select 'not_a_member'::text, null::uuid;
    return;
  end if;

  if p_list_id is not null and not exists (
    select 1 from public.lists l where l.id = p_list_id and l.household_id = v_household
  ) then
    return query select 'invalid_list'::text, null::uuid;
    return;
  end if;

  return query select null::text, v_household;
end;
$$;

revoke all on function private.share_import_household(uuid, uuid, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- ingest_share_import: as in 20261211120001_share_ingest.sql, with the household checks moved to
-- private.share_import_household, and a photo share under the id a conflict.
-- ---------------------------------------------------------------------------

create or replace function public.ingest_share_import(
  p_id uuid,
  p_user_id uuid,
  p_credential_id uuid,
  p_household_id uuid,
  p_list_id uuid,
  p_add_to_list boolean,
  p_url text,
  p_url_key text,
  p_title text,
  p_payload_hash text,
  p_page jsonb,
  p_client_created_at timestamptz,
  p_app_version text,
  p_source text
)
returns table (outcome text, status text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_hash bytea;
  v_job public.share_imports;
  v_target record;
  v_kind constant text := 'link';
begin
  if p_id is null or p_user_id is null or p_add_to_list is null or p_url is null or p_url_key is null then
    raise exception 'p_id, p_user_id, p_add_to_list, p_url and p_url_key are required' using errcode = '22023';
  end if;
  if p_payload_hash is null or p_payload_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid payload hash' using errcode = '22023';
  end if;
  v_hash := decode(p_payload_hash, 'hex');

  select * into v_job from public.share_imports j where j.id = p_id;
  if found then
    if v_job.user_id = p_user_id and v_job.kind = v_kind and v_job.payload_hash = v_hash then
      return query select 'accepted'::text, v_job.status;
    else
      return query select 'conflict'::text, null::text;
    end if;
    return;
  end if;

  select * into v_target from private.share_import_household(p_user_id, p_household_id, p_list_id);
  if v_target.outcome is not null then
    return query select v_target.outcome, null::text;
    return;
  end if;

  insert into public.share_imports (
    id, user_id, credential_id, household_id, list_id, add_to_list, url, url_key, title,
    payload_hash, page, client_created_at, app_version, source
  )
  values (
    p_id, p_user_id, p_credential_id, v_target.household_id, p_list_id, p_add_to_list, p_url, p_url_key, p_title,
    v_hash, p_page, p_client_created_at, p_app_version, p_source
  )
  on conflict (id) do nothing
  returning * into v_job;

  if v_job.id is null then
    select * into v_job from public.share_imports j where j.id = p_id;
    if v_job.user_id = p_user_id and v_job.kind = v_kind and v_job.payload_hash = v_hash then
      return query select 'accepted'::text, v_job.status;
    else
      return query select 'conflict'::text, null::text;
    end if;
    return;
  end if;

  return query select 'accepted'::text, v_job.status;
end;
$$;

-- ---------------------------------------------------------------------------
-- ingest_photo_share_import (service role, share-ingest): records a photo share, or answers the
-- one already under its id, as ingest_share_import does for a link ('accepted' with the status,
-- 'conflict', 'not_a_member', 'invalid_list'). `images` is '<user_id>/<id>/<n>.jpg' for n = 1 to
-- p_page_count, where share-ingest has uploaded them. p_check_only answers without inserting:
-- 'new' (status null) when it would insert.
-- ---------------------------------------------------------------------------

create function public.ingest_photo_share_import(
  p_id uuid,
  p_user_id uuid,
  p_credential_id uuid,
  p_household_id uuid,
  p_list_id uuid,
  p_add_to_list boolean,
  p_payload_hash text,
  p_page_count integer,
  p_client_created_at timestamptz,
  p_app_version text,
  p_source text,
  p_check_only boolean
)
returns table (outcome text, status text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_hash bytea;
  v_job public.share_imports;
  v_target record;
  v_kind constant text := 'photo';
begin
  if p_id is null or p_user_id is null or p_add_to_list is null or p_check_only is null then
    raise exception 'p_id, p_user_id, p_add_to_list and p_check_only are required' using errcode = '22023';
  end if;
  if p_page_count is null or p_page_count not between 1 and 3 then
    raise exception 'p_page_count must be 1 to 3' using errcode = '22023';
  end if;
  if p_payload_hash is null or p_payload_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid payload hash' using errcode = '22023';
  end if;
  v_hash := decode(p_payload_hash, 'hex');

  select * into v_job from public.share_imports j where j.id = p_id;
  if found then
    if v_job.user_id = p_user_id and v_job.kind = v_kind and v_job.payload_hash = v_hash then
      return query select 'accepted'::text, v_job.status;
    else
      return query select 'conflict'::text, null::text;
    end if;
    return;
  end if;

  select * into v_target from private.share_import_household(p_user_id, p_household_id, p_list_id);
  if v_target.outcome is not null then
    return query select v_target.outcome, null::text;
    return;
  end if;

  if p_check_only then
    return query select 'new'::text, null::text;
    return;
  end if;

  insert into public.share_imports (
    id, user_id, credential_id, household_id, list_id, add_to_list, kind, page_count, images,
    payload_hash, client_created_at, app_version, source
  )
  values (
    p_id, p_user_id, p_credential_id, v_target.household_id, p_list_id, p_add_to_list, 'photo', p_page_count,
    array(select format('%s/%s/%s.jpg', p_user_id, p_id, n) from generate_series(1, p_page_count) n),
    v_hash, p_client_created_at, p_app_version, p_source
  )
  on conflict (id) do nothing
  returning * into v_job;

  if v_job.id is null then
    select * into v_job from public.share_imports j where j.id = p_id;
    if v_job.user_id = p_user_id and v_job.kind = v_kind and v_job.payload_hash = v_hash then
      return query select 'accepted'::text, v_job.status;
    else
      return query select 'conflict'::text, null::text;
    end if;
    return;
  end if;

  return query select 'accepted'::text, v_job.status;
end;
$$;

revoke all on function public.ingest_photo_share_import(uuid, uuid, uuid, uuid, uuid, boolean, text, integer, timestamptz, text, text, boolean)
  from public, anon, authenticated;
grant execute on function public.ingest_photo_share_import(uuid, uuid, uuid, uuid, uuid, boolean, text, integer, timestamptz, text, text, boolean)
  to service_role;
