-- share-import-worker's schedule (spec 6.12, 8): pg_cron calls the Edge Function every minute
-- through pg_net, with the Vault secrets project_url and share_import_worker_key (a secret API key,
-- sent as apikey), only when a share import is due. Without the secrets it does nothing. Every
-- claim is leased, so this job is what recovers crashed or slow runs; share-ingest's waitUntil
-- start only saves up to a minute.

create extension if not exists pg_net with schema extensions;

-- ---------------------------------------------------------------------------
-- private.share_import_due: whether claim_share_import would find a job: a `received` or
-- `extracted` row whose `next_attempt_at` has passed, or a leased one whose lease expired.
-- ---------------------------------------------------------------------------

create function private.share_import_due()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.share_imports s
    where (s.status in ('received', 'extracted') and s.next_attempt_at <= now())
       or (s.status in ('extracting', 'committing') and s.lease_expires_at < now())
  );
$$;

revoke all on function private.share_import_due() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- private.request_share_import_worker: calls share-import-worker when a job is due and the Vault
-- secrets are there; returns whether it did.
-- ---------------------------------------------------------------------------

create function private.request_share_import_worker()
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url');
  v_key text := (select decrypted_secret from vault.decrypted_secrets where name = 'share_import_worker_key');
begin
  if v_url is null or v_key is null or not private.share_import_due() then
    return false;
  end if;
  perform net.http_post(
    url := pg_catalog.rtrim(v_url, '/') || '/functions/v1/share-import-worker',
    headers := jsonb_build_object('Content-Type', 'application/json', 'apikey', v_key),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  );
  return true;
end;
$$;

revoke all on function private.request_share_import_worker() from public, anon, authenticated, service_role;

-- Every minute.
select cron.schedule('share-import-worker', '* * * * *', $$select private.request_share_import_worker()$$);
