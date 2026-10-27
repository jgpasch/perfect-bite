-- Share import limits (spec 6.12):
--
--   * retry_share_import counts Try again in a new `retries` column and refuses (`retry_refused`,
--     55000, changing nothing) a job that already had 3, or one that failed permanently after it was
--     charged (`metered_at` set: a page that isn't a recipe stays one), since a retry of a charged
--     job isn't charged again. A permanent failure before the charge (a limit, not entitled) can
--     still be tried again: that retry is charged like a new import.
--   * check_share_ingest_user_limit: the `share_ingest` per-minute limit per user, for uploads with
--     a session (a device credential has its own, check_share_ingest_limit).
--   * register_device_credential keeps at most 5 live credentials per user, revoking the oldest
--     (`revoked_reason` `limit`), so made-up installation ids can't multiply the ingest allowance.

-- ---------------------------------------------------------------------------
-- retry_share_import
-- ---------------------------------------------------------------------------

alter table public.share_imports add column retries integer not null default 0 check (retries >= 0);

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

-- ---------------------------------------------------------------------------
-- check_share_ingest_user_limit (service role, share-ingest with a session)
-- ---------------------------------------------------------------------------

-- One row per user: their session uploads in the current minute.
create table private.share_ingest_user_usage (
  user_id              uuid primary key references auth.users on delete cascade,
  minute_start         timestamptz not null,
  requests_this_minute integer not null default 0
);

alter table private.share_ingest_user_usage enable row level security;
revoke all on table private.share_ingest_user_usage from public, anon, authenticated;

-- 'user_limit' once the user has made `share_ingest`'s per-minute number of session uploads this
-- minute, else 'ok', counting one; as check_share_ingest_limit does for a credential.
create function public.check_share_ingest_user_limit(p_user_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_minute timestamptz := date_trunc('minute', now());
  v_limit public.ai_safety_limits := private.safety_limit('share_ingest');
  v_usage private.share_ingest_user_usage;
  v_requests integer;
begin
  if p_user_id is null then
    raise exception 'p_user_id is required' using errcode = '22023';
  end if;

  insert into private.share_ingest_user_usage (user_id, minute_start)
  values (p_user_id, v_minute)
  on conflict (user_id) do nothing;

  select * into v_usage from private.share_ingest_user_usage u
  where u.user_id = p_user_id
  for update;

  v_requests := case when v_usage.minute_start = v_minute then v_usage.requests_this_minute else 0 end;
  if v_requests >= v_limit.per_minute then
    return 'user_limit';
  end if;

  update private.share_ingest_user_usage
  set requests_this_minute = v_requests + 1,
      minute_start = v_minute
  where user_id = p_user_id;

  return 'ok';
end;
$$;

revoke all on function public.check_share_ingest_user_limit(uuid) from public, anon, authenticated;
grant execute on function public.check_share_ingest_user_limit(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- register_device_credential: at most 5 live credentials per user
-- ---------------------------------------------------------------------------

alter table public.device_credentials drop constraint device_credentials_revoked_reason_check;
alter table public.device_credentials add constraint device_credentials_revoked_reason_check
  check (revoked_reason in ('replaced', 'sign_out', 'admin', 'limit'));

-- As before (the installation's live credential is replaced with a 24 h grace, the new one valid 90
-- days), then the user's live credentials (not revoked, not expired) beyond the newest 5 are
-- revoked now, `revoked_reason` `limit`. The lock is per user, so registrations for two
-- installations at once can't both slip under the cap.
create or replace function public.register_device_credential(p_user_id uuid, p_installation_id uuid, p_token_hash text)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_expires_at timestamptz;
begin
  if p_user_id is null or p_installation_id is null or p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid credential' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('device_credentials:' || p_user_id::text, 0));

  update public.device_credentials c
  set expires_at = least(c.expires_at, now() + interval '24 hours'),
      revoked_at = least(c.expires_at, now() + interval '24 hours'),
      revoked_reason = 'replaced'
  where c.user_id = p_user_id
    and c.installation_id = p_installation_id
    and c.revoked_at is null;

  insert into public.device_credentials (user_id, installation_id, token_hash, expires_at)
  values (p_user_id, p_installation_id, decode(p_token_hash, 'hex'), now() + interval '90 days')
  returning id, expires_at into v_id, v_expires_at;

  update public.device_credentials c
  set revoked_at = now(), revoked_reason = 'limit'
  where c.id in (
    select l.id
    from public.device_credentials l
    where l.user_id = p_user_id
      and l.id <> v_id
      and l.revoked_at is null
      and l.expires_at > now()
    order by l.created_at desc, l.id desc
    offset 4
  );

  return v_expires_at;
end;
$$;
