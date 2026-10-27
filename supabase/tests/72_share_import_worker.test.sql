-- share-import-worker's schedule (spec 6.12, 8): the cron job, when it calls the worker (a job due,
-- the Vault secrets there), and that clients can't call its functions.
begin;
create extension if not exists pgtap with schema extensions;
select plan(12);

select is((select schedule from cron.job where jobname = 'share-import-worker'), '* * * * *', 'the worker runs every minute');
select ok(
  (select command from cron.job where jobname = 'share-import-worker') like '%private.request_share_import_worker()%',
  'through private.request_share_import_worker');
select ok(
  not has_function_privilege('authenticated', 'private.request_share_import_worker()', 'execute')
  and not has_function_privilege('anon', 'private.request_share_import_worker()', 'execute')
  and not has_function_privilege('service_role', 'private.request_share_import_worker()', 'execute')
  and not has_function_privilege('authenticated', 'private.share_import_due()', 'execute'),
  'nobody but the owner can call them');

-- Fixtures: the secrets, a user, their household, and no share imports yet.
delete from vault.secrets where name in ('project_url', 'share_import_worker_key');
select vault.create_secret('http://host.docker.internal:55321/', 'project_url');
select vault.create_secret('sb_secret_test', 'share_import_worker_key');
insert into auth.users (id, email, aud, role)
values ('7a7a7a7a-0000-4000-8000-000000000001', 'worker@test.local', 'authenticated', 'authenticated');
insert into public.households (id, name) values ('7a7a7a7a-0000-4000-8000-0000000000ff', 'Worker');
delete from public.share_imports;

create function pg_temp.share(p_id text, p_status text, p_next timestamptz, p_lease timestamptz) returns void language sql as $$
  insert into public.share_imports (id, user_id, household_id, add_to_list, url, url_key, payload_hash, status,
                                    next_attempt_at, lease_token, lease_expires_at)
  values (p_id::uuid, '7a7a7a7a-0000-4000-8000-000000000001', '7a7a7a7a-0000-4000-8000-0000000000ff', false,
          'https://a.test/' || p_id, 'https://a.test/' || p_id, '\x01', p_status, p_next,
          case when p_lease is not null then gen_random_uuid() end, p_lease);
$$;
create function pg_temp.requests() returns int language sql as $$
  select count(*)::int from net.http_request_queue where url like '%/functions/v1/share-import-worker'
$$;

select is(private.request_share_import_worker(), false, 'with nothing queued it does nothing');

-- Not due: received later, a live lease, done and failed.
select pg_temp.share('7a7a7a7a-0000-4000-8000-0000000000a1', 'received', now() + interval '1 minute', null);
select pg_temp.share('7a7a7a7a-0000-4000-8000-0000000000a2', 'extracting', now(), now() + interval '1 minute');
select pg_temp.share('7a7a7a7a-0000-4000-8000-0000000000a3', 'done', now() - interval '1 hour', null);
select pg_temp.share('7a7a7a7a-0000-4000-8000-0000000000a4', 'failed', now() - interval '1 hour', null);
select is(private.request_share_import_worker(), false, 'nor with only jobs that aren''t due');
select is(pg_temp.requests(), 0, 'and makes no request');

select pg_temp.share('7a7a7a7a-0000-4000-8000-0000000000b1', 'received', now() - interval '1 second', null);
select is(private.request_share_import_worker(), true, 'a due received job calls the worker');
select is(pg_temp.requests(), 1, 'once, at the project''s functions URL');
select is(
  (select headers ->> 'apikey' from net.http_request_queue where url = 'http://host.docker.internal:55321/functions/v1/share-import-worker'),
  'sb_secret_test',
  'with the secret key as apikey');

delete from public.share_imports where id = '7a7a7a7a-0000-4000-8000-0000000000b1';
select pg_temp.share('7a7a7a7a-0000-4000-8000-0000000000b2', 'committing', now(), now() - interval '1 second');
select is(private.share_import_due(), true, 'an expired lease is due');
update public.share_imports set status = 'extracted', lease_token = null, lease_expires_at = null, next_attempt_at = now() - interval '1 second'
where id = '7a7a7a7a-0000-4000-8000-0000000000b2';
select is(private.share_import_due(), true, 'and so is a due extracted job');

delete from vault.secrets where name in ('project_url', 'share_import_worker_key');
select is(private.request_share_import_worker(), false, 'without the Vault secrets the job does nothing');

select * from finish();
rollback;
