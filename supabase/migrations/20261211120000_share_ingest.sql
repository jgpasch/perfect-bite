-- share-ingest (spec 6.12, plan §7 and §8): what the Edge Function needs in the database.
--
--   * authenticate_device_credential: use_device_credential's check, answering the credential's id
--     too, which the per-credential limit and the job's `credential_id` need. use_device_credential
--     stays, as a wrapper.
--   * The `share_ingest` safety limit (4.12): 30 uploads a minute per device credential, no daily
--     limit, counted in private.share_ingest_usage by check_share_ingest_limit. It isn't AI: it only
--     bounds what a leaked credential can queue, which import metering then limits.
--   * ingest_share_import: records the operation, `insert … on conflict (id) do nothing`, after
--     checking the household and list; an existing id answers by owner and payload hash.
--
-- All three are for the service role only.

-- ---------------------------------------------------------------------------
-- authenticate_device_credential (service role, from verifyDeviceCredential): the user and id of
-- the valid credential with this sha256 (hex) and scope, setting its `last_used_at`; no row for an
-- unknown, revoked, expired or out-of-scope token.
-- ---------------------------------------------------------------------------

create function public.authenticate_device_credential(p_token_hash text, p_scope text)
returns table (user_id uuid, credential_id uuid)
language sql
security definer
set search_path = ''
as $$
  update public.device_credentials c
  set last_used_at = now()
  where c.token_hash = decode(p_token_hash, 'hex')
    and p_scope = any (c.scopes)
    and c.expires_at > now()
    and (c.revoked_at is null or c.revoked_at > now())
  returning c.user_id, c.id;
$$;

revoke all on function public.authenticate_device_credential(text, text) from public, anon, authenticated;
grant execute on function public.authenticate_device_credential(text, text) to service_role;

create or replace function public.use_device_credential(p_token_hash text, p_scope text)
returns uuid
language sql
security definer
set search_path = ''
as $$
  select a.user_id from public.authenticate_device_credential(p_token_hash, p_scope) a;
$$;

-- ---------------------------------------------------------------------------
-- The `share_ingest` safety limit.
-- ---------------------------------------------------------------------------

alter table public.ai_safety_limits drop constraint ai_safety_limits_key_check;
alter table public.ai_safety_limits add constraint ai_safety_limits_key_check
  check (key in ('categorize', 'step_match', 'recipe_tags', 'recipe_import_link', 'recipe_import_photo',
                 'recipe_import', 'recipe_photo_ai', 'share_ingest'));

insert into public.ai_safety_limits (key, per_minute, per_day) values ('share_ingest', 30, null);

create or replace function private.safety_limit_keys()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array['categorize', 'step_match', 'recipe_tags', 'recipe_import_link', 'recipe_import_photo', 'recipe_import', 'recipe_photo_ai', 'share_ingest'];
$$;

-- One row per device credential: its uploads in the current minute.
create table private.share_ingest_usage (
  credential_id        uuid primary key references public.device_credentials on delete cascade,
  minute_start         timestamptz not null,
  requests_this_minute integer not null default 0
);

alter table private.share_ingest_usage enable row level security;
revoke all on table private.share_ingest_usage from public, anon, authenticated;

-- check_share_ingest_limit (service role, share-ingest): 'user_limit' once the credential has made
-- `share_ingest`'s per-minute number of uploads this minute, else 'ok', counting one. The row is
-- locked so concurrent uploads can't both slip under; nothing is counted on 'user_limit'.
create function public.check_share_ingest_limit(p_credential_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_minute timestamptz := date_trunc('minute', now());
  v_limit public.ai_safety_limits := private.safety_limit('share_ingest');
  v_usage private.share_ingest_usage;
  v_requests integer;
begin
  if p_credential_id is null then
    raise exception 'p_credential_id is required' using errcode = '22023';
  end if;

  insert into private.share_ingest_usage (credential_id, minute_start)
  values (p_credential_id, v_minute)
  on conflict (credential_id) do nothing;

  select * into v_usage from private.share_ingest_usage u
  where u.credential_id = p_credential_id
  for update;

  v_requests := case when v_usage.minute_start = v_minute then v_usage.requests_this_minute else 0 end;
  if v_requests >= v_limit.per_minute then
    return 'user_limit';
  end if;

  update private.share_ingest_usage
  set requests_this_minute = v_requests + 1,
      minute_start = v_minute
  where credential_id = p_credential_id;

  return 'ok';
end;
$$;

revoke all on function public.check_share_ingest_limit(uuid) from public, anon, authenticated;
grant execute on function public.check_share_ingest_limit(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- ingest_share_import (service role, share-ingest): records a share import, or answers the one
-- already recorded under its id. One row: `outcome` and, when accepted, the job's `status`.
--
--   * The id is taken: 'accepted' with its status when it's the same user and payload hash (a
--     resubmit, or the background upload and the app's submit of one share), else 'conflict'.
--     Checked first, so a resubmit gets its answer even if the household or list has changed since.
--   * The household is p_household_id, else the list's, else (an envelope from an older extension
--     with neither) the household of the user's default list, else the user's first household.
--     'not_a_member' when the user isn't in it (or has none).
--   * 'invalid_list' when p_list_id isn't a list of that household. An archived or deleted list is
--     still accepted: the worker falls back to the default list (4.10).
--   * Otherwise inserted as `received`, `on conflict (id) do nothing`; losing that race to another
--     insert answers as for a taken id.
-- ---------------------------------------------------------------------------

create function public.ingest_share_import(
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
  v_household uuid := p_household_id;
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
    if v_job.user_id = p_user_id and v_job.payload_hash = v_hash then
      return query select 'accepted'::text, v_job.status;
    else
      return query select 'conflict'::text, null::text;
    end if;
    return;
  end if;

  if v_household is null and p_list_id is not null then
    select l.household_id into v_household from public.lists l where l.id = p_list_id;
    if v_household is null then
      return query select 'invalid_list'::text, null::text;
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
    return query select 'not_a_member'::text, null::text;
    return;
  end if;

  if p_list_id is not null and not exists (
    select 1 from public.lists l where l.id = p_list_id and l.household_id = v_household
  ) then
    return query select 'invalid_list'::text, null::text;
    return;
  end if;

  insert into public.share_imports (
    id, user_id, credential_id, household_id, list_id, add_to_list, url, url_key, title,
    payload_hash, page, client_created_at, app_version, source
  )
  values (
    p_id, p_user_id, p_credential_id, v_household, p_list_id, p_add_to_list, p_url, p_url_key, p_title,
    v_hash, p_page, p_client_created_at, p_app_version, p_source
  )
  on conflict (id) do nothing
  returning * into v_job;

  if v_job.id is null then
    select * into v_job from public.share_imports j where j.id = p_id;
    if v_job.user_id = p_user_id and v_job.payload_hash = v_hash then
      return query select 'accepted'::text, v_job.status;
    else
      return query select 'conflict'::text, null::text;
    end if;
    return;
  end if;

  return query select 'accepted'::text, v_job.status;
end;
$$;

revoke all on function public.ingest_share_import(uuid, uuid, uuid, uuid, uuid, boolean, text, text, text, text, jsonb, timestamptz, text, text)
  from public, anon, authenticated;
grant execute on function public.ingest_share_import(uuid, uuid, uuid, uuid, uuid, boolean, text, text, text, text, jsonb, timestamptz, text, text)
  to service_role;
