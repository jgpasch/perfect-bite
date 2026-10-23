-- Share import jobs (spec 5 and 6.12, plan §4): the table and view's access, the worker's state
-- machine (claim, reserve, save, release), Try again, status, and retention.
--
-- `skip locked` needs two real sessions, so that part runs first through dblink with two
-- connections of its own, on rows it commits and deletes again (by their own ids); everything
-- after it runs in this test's transaction and is rolled back.
begin;
create extension if not exists pgtap with schema extensions;
create extension if not exists dblink with schema extensions;
select plan(75);

-- Two claimers -------------------------------------------------------------------------------------
-- Over the server's own network address, where the password is checked (dblink refuses a
-- connection that didn't use one, as loopback's trust doesn't).
create function pg_temp.conninfo() returns text language sql as $$
  select format('dbname=%s user=postgres password=postgres host=%s port=%s',
                current_database(), host(inet_server_addr()), current_setting('port'))
$$;
select dblink_connect('share_a', pg_temp.conninfo());
select dblink_connect('share_b', pg_temp.conninfo());
select dblink_exec('share_a', $$
  delete from auth.users where id = '5ca1ab1e-0000-4000-8000-000000000001';
  insert into auth.users (id, email, aud, role)
  values ('5ca1ab1e-0000-4000-8000-000000000001', 'claimers@test.local', 'authenticated', 'authenticated');
  insert into public.share_imports (id, user_id, household_id, add_to_list, url, url_key, payload_hash, created_at, next_attempt_at)
  values
    ('5ca1ab1e-0000-4000-8000-0000000000a1', '5ca1ab1e-0000-4000-8000-000000000001', '5ca1ab1e-0000-4000-8000-0000000000ff',
     false, 'https://a.test/1', 'a.test/1', '\x01', '2000-01-01', '2000-01-01'),
    ('5ca1ab1e-0000-4000-8000-0000000000a2', '5ca1ab1e-0000-4000-8000-000000000001', '5ca1ab1e-0000-4000-8000-0000000000ff',
     false, 'https://a.test/2', 'a.test/2', '\x02', '2000-01-02', '2000-01-02');
$$);

select dblink_exec('share_a', 'begin');
select is(
  (select id from dblink('share_a', 'select id from public.claim_share_import(null)') as t(id uuid)),
  '5ca1ab1e-0000-4000-8000-0000000000a1'::uuid,
  'the first claimer gets the oldest due job and holds it');
select is(
  (select id from dblink('share_b', 'select id from public.claim_share_import(null)') as t(id uuid)),
  '5ca1ab1e-0000-4000-8000-0000000000a2'::uuid,
  'a second claimer at the same time skips the locked job and gets the next');
select is(
  (select count(*)::int from dblink('share_b', 'select id from public.claim_share_import(null)') as t(id uuid)),
  0,
  'and then finds nothing: the first job is locked, the second leased');
select dblink_exec('share_a', 'rollback');
select is(
  (select id from dblink('share_b', 'select id from public.claim_share_import(null)') as t(id uuid)),
  '5ca1ab1e-0000-4000-8000-0000000000a1'::uuid,
  'once the first claimer rolls back, its job is due again');
select dblink_exec('share_b', $$ delete from auth.users where id = '5ca1ab1e-0000-4000-8000-000000000001' $$);
select dblink_disconnect('share_a');
select dblink_disconnect('share_b');
select is((select count(*)::int from public.share_imports where id::text like '5ca1ab1e-%'), 0,
  'the claimers'' rows are gone with their user');

-- Fixtures (as postgres) ---------------------------------------------------------------------------
-- Alex shares into Home (unlimited); Sam is another user.
insert into auth.users (id, email, aud, role) values
  ('11111111-1111-1111-1111-111111111111', 'alex@test.local', 'authenticated', 'authenticated'),
  ('22222222-2222-2222-2222-222222222222', 'sam@test.local', 'authenticated', 'authenticated');
insert into public.households (id, name) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Home');
insert into public.household_members (household_id, user_id, role, position) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'owner', 1);
insert into public.household_plans (household_id, plan_id) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'unlimited');
delete from private.recipe_import_usage where user_id = '11111111-1111-1111-1111-111111111111';

insert into public.share_imports (id, user_id, household_id, list_id, add_to_list, url, url_key, title, payload_hash, page, created_at) values
  ('a0000000-0000-4000-8000-000000000001', '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   null, false, 'https://a.test/pasta', 'a.test/pasta', 'Pasta', '\x01', '{"title": "Pasta", "text": "boil"}', now() - interval '10 minutes'),
  ('a0000000-0000-4000-8000-000000000002', '22222222-2222-2222-2222-222222222222', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   null, false, 'https://a.test/soup', 'a.test/soup', 'Soup', '\x02', '{"title": "Soup"}', now() - interval '5 minutes');

create function pg_temp.as_user(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
$$;
create function pg_temp.job(p_id uuid) returns public.share_imports language sql as $$
  select * from public.share_imports where id = p_id
$$;
create function pg_temp.imports_today(p_user uuid) returns int language sql as $$
  select coalesce(sum(imports), 0)::int from private.recipe_import_usage
  where user_id = p_user and day = (now() at time zone 'utc')::date
$$;
create function pg_temp.household_imports(p_household uuid) returns int language sql as $$
  select private.monthly_usage(p_household, 'recipe_import')
$$;
grant execute on function pg_temp.as_user(uuid) to authenticated, anon;

-- Access -------------------------------------------------------------------------------------------
select is(
  array(select column_name::text from information_schema.columns
        where table_schema = 'public' and table_name = 'my_share_imports' and column_name in ('page', 'extraction', 'payload_hash', 'user_id', 'lease_token')),
  array[]::text[],
  'my_share_imports leaves out page, extraction, the hash, the owner and the lease');

set local role authenticated;
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select throws_ok($$ select * from public.share_imports $$, '42501', null, 'a user can''t read the table');
select throws_ok(
  $$ insert into public.share_imports (id, user_id, household_id, add_to_list, url, url_key, payload_hash)
     values (gen_random_uuid(), '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', false, 'https://x', 'x', '\x00') $$,
  '42501', null, 'or write it');
select throws_ok($$ update public.my_share_imports set title = 'x' $$, '42501', null, 'or write through the view');
select is(array(select id from public.my_share_imports), array['a0000000-0000-4000-8000-000000000001'::uuid],
  'the view shows the sharer only their own rows');
select is((select title || ' ' || status from public.my_share_imports), 'Pasta received', 'with their title and status');
select throws_ok($$ select * from public.claim_share_import(null) $$, '42501', null, 'a user can''t claim');
select throws_ok($$ select public.reserve_share_import('a0000000-0000-4000-8000-000000000001', gen_random_uuid()) $$, '42501', null,
  'or reserve');
select throws_ok($$ select public.save_share_extraction('a0000000-0000-4000-8000-000000000001', gen_random_uuid(), '{}') $$, '42501', null,
  'or save');
select throws_ok($$ select public.release_share_import('a0000000-0000-4000-8000-000000000001', gen_random_uuid(), 'permanent', 'x') $$, '42501', null,
  'or release');
select is(
  array(select s.id || ':' || s.status from public.share_import_status(array[
    'a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-0000000000ff']::uuid[]) s),
  array['a0000000-0000-4000-8000-000000000001:received'],
  'share_import_status answers for the caller''s own ids, leaving out others'' and unknown ones');
select throws_ok($$ select public.retry_share_import('a0000000-0000-4000-8000-000000000002') $$, 'P0002', 'not found',
  'Try again on another user''s import is not found');
select throws_ok($$ select public.retry_share_import('a0000000-0000-4000-8000-0000000000ff') $$, 'P0002', 'not found',
  'and on an unknown id');
select is(public.retry_share_import('a0000000-0000-4000-8000-000000000001'), 'received',
  'Try again on an import that hasn''t failed leaves it as it is');
reset role;

set local role anon;
select throws_ok($$ select * from public.my_share_imports $$, '42501', null, 'anon can''t read the view');
select throws_ok($$ select * from public.share_import_status(array[]::uuid[]) $$, '42501', null, 'or ask for status');
reset role;

-- Claim --------------------------------------------------------------------------------------------
select is((select count(*)::int from public.claim_share_import(array['committing'])), 0,
  'nothing to commit while every job is received');
select throws_ok($$ select * from public.claim_share_import(array['done']) $$, '22023', 'invalid kinds', 'claim refuses an unknown kind');

create temp table claim1 as select * from public.claim_share_import(null);
select is((select id from claim1), 'a0000000-0000-4000-8000-000000000001'::uuid, 'claim takes the oldest due job');
select is(
  (select array[status, attempts::text, (lease_expires_at = now() + interval '2 minutes')::text, (lease_token is not null)::text] from claim1),
  array['extracting', '1', 'true', 'true'],
  'and moves it to extracting with a new two-minute lease and one attempt');
select is((select page from claim1), '{"title": "Pasta", "text": "boil"}'::jsonb, 'returning the row, page included');

-- Reserve ------------------------------------------------------------------------------------------
select is(public.reserve_share_import('a0000000-0000-4000-8000-000000000001', (select lease_token from claim1)), 'ok',
  'reserve charges the import');
create temp table metered as select metered_at from public.share_imports where id = 'a0000000-0000-4000-8000-000000000001';
select is((select metered_at from metered), now(), 'and sets metered_at');
select is(array[pg_temp.imports_today('11111111-1111-1111-1111-111111111111'), pg_temp.household_imports('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')],
  array[1, 1], 'counted once for the sharer and once for the household');
select is(public.reserve_share_import('a0000000-0000-4000-8000-000000000001', (select lease_token from claim1)), 'ok',
  'reserving again is ok');
select is(array[pg_temp.imports_today('11111111-1111-1111-1111-111111111111'), pg_temp.household_imports('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')],
  array[1, 1], 'and charges nothing more');
select throws_ok($$ select public.reserve_share_import('a0000000-0000-4000-8000-000000000001', gen_random_uuid()) $$, '55000', 'lease_lost',
  'reserve under another lease is lease_lost');

-- Save ---------------------------------------------------------------------------------------------
select throws_ok($$ select public.save_share_extraction('a0000000-0000-4000-8000-000000000001', gen_random_uuid(), '{"recipe": {}}') $$,
  '55000', 'lease_lost', 'save under another lease is refused');
update public.share_imports set lease_expires_at = now() - interval '1 second' where id = 'a0000000-0000-4000-8000-000000000001';
select throws_ok(
  format($$ select public.save_share_extraction('a0000000-0000-4000-8000-000000000001', %L, '{"recipe": {}}') $$, (select lease_token from claim1)),
  '55000', 'lease_lost', 'save under an expired lease is refused');
select is(
  (select array[status, coalesce(extraction::text, 'null')] from pg_temp.job('a0000000-0000-4000-8000-000000000001')),
  array['extracting', 'null'], 'and changes nothing');

create temp table claim2 as select * from public.claim_share_import(array['extracting']);
select is(
  (select array[id::text, status, attempts::text, (lease_token <> (select lease_token from claim1))::text] from claim2),
  array['a0000000-0000-4000-8000-000000000001', 'extracting', '2', 'true'],
  'a job whose lease expired is claimed again, with a new lease and another attempt');
select throws_ok(
  format($$ select public.save_share_extraction('a0000000-0000-4000-8000-000000000001', %L, '{"recipe": {}}') $$, (select lease_token from claim1)),
  '55000', 'lease_lost', 'the old lease can''t save over the new claimer');
select lives_ok(
  format($$ select public.save_share_extraction('a0000000-0000-4000-8000-000000000001', %L, '{"recipe": {"title": "Pasta"}}') $$, (select lease_token from claim2)),
  'the new lease saves');
select is(
  (select array[status, extraction::text, coalesce(lease_token::text, 'null'), (next_attempt_at = now())::text]
   from pg_temp.job('a0000000-0000-4000-8000-000000000001')),
  array['extracted', '{"recipe": {"title": "Pasta"}}', 'null', 'true'],
  'save moves the job to extracted, due now, with the extraction and no lease');
select throws_ok(
  format($$ select public.save_share_extraction('a0000000-0000-4000-8000-000000000001', %L, '{"recipe": {}}') $$, (select lease_token from claim2)),
  '55000', 'lease_lost', 'a second save once extracted is refused');

-- Permanent failure (Sam's job) ---------------------------------------------------------------------
create temp table claim3 as select * from public.claim_share_import(array['extracting']);
select is((select id from claim3), 'a0000000-0000-4000-8000-000000000002'::uuid, 'claiming extraction skips the extracted job');
select is(
  public.release_share_import('a0000000-0000-4000-8000-000000000002', (select lease_token from claim3), 'permanent', 'not_a_recipe'),
  'failed', 'a permanent failure fails the job');
select is(
  (select array[status, error_kind, error_code, coalesce(page::text, 'null'), coalesce(lease_token::text, 'null'), coalesce(resets_at::text, 'null')]
   from pg_temp.job('a0000000-0000-4000-8000-000000000002')),
  array['failed', 'permanent', 'not_a_recipe', 'null', 'null', 'null'],
  'with its code, the page nulled and the lease cleared');
select throws_ok(
  format($$ select public.release_share_import('a0000000-0000-4000-8000-000000000002', %L, 'permanent', 'not_a_recipe') $$, (select lease_token from claim3)),
  '55000', 'lease_lost', 'releasing a job that is no longer leased is lease_lost');

-- Transient and waiting ----------------------------------------------------------------------------
create temp table claim4 as select * from public.claim_share_import(array['committing']);
select is(
  (select array[id::text, status, attempts::text] from claim4),
  array['a0000000-0000-4000-8000-000000000001', 'committing', '3'],
  'an extracted job is claimed for committing');
select is(
  public.release_share_import('a0000000-0000-4000-8000-000000000001', (select lease_token from claim4), 'transient', 'plan_conflict'),
  'extracted', 'a transient failure goes back to the state it was claimed from');
select ok(
  (select status = 'extracted' and error_kind = 'transient' and error_code = 'plan_conflict' and lease_token is null
          and next_attempt_at between now() + interval '10 minutes' and now() + interval '12 minutes'
   from pg_temp.job('a0000000-0000-4000-8000-000000000001')),
  'due after the third attempt''s backoff, 10 minutes plus jitter, with its code');
select is((select count(*)::int from public.claim_share_import(null)), 0, 'and not claimed before then');
select is(
  (select extraction::text from pg_temp.job('a0000000-0000-4000-8000-000000000001')), '{"recipe": {"title": "Pasta"}}',
  'the extraction is kept for the next commit');

update public.share_imports set next_attempt_at = now() - interval '1 second' where id = 'a0000000-0000-4000-8000-000000000001';
create temp table claim5 as select * from public.claim_share_import(array['committing']);
select is((select attempts from claim5), 4, 'due again, it''s claimed with a fourth attempt');
select throws_ok(
  format($$ select public.release_share_import('a0000000-0000-4000-8000-000000000001', %L, 'waiting', 'daily_limit') $$, (select lease_token from claim5)),
  '22023', 'only rate_limited waits', 'only rate_limited waits');
select throws_ok(
  format($$ select public.release_share_import('a0000000-0000-4000-8000-000000000001', %L, 'later', 'x') $$, (select lease_token from claim5)),
  '22023', 'invalid kind', 'an unknown kind is refused');
select is(
  public.release_share_import('a0000000-0000-4000-8000-000000000001', (select lease_token from claim5), 'waiting', 'rate_limited'),
  'extracted', 'rate_limited waits in the state it was claimed from');
select is(
  (select array[attempts::text, error_kind, error_code, (next_attempt_at = date_trunc('minute', now()) + interval '1 minute')::text]
   from pg_temp.job('a0000000-0000-4000-8000-000000000001')),
  array['3', 'waiting', 'rate_limited', 'true'],
  'due at the next minute, without counting the attempt');

select ok(
  (select bool_and(b) from (values
    (private.share_import_backoff(1) between interval '30 seconds' and interval '36 seconds'),
    (private.share_import_backoff(2) between interval '2 minutes' and interval '144 seconds'),
    (private.share_import_backoff(3) between interval '10 minutes' and interval '12 minutes'),
    (private.share_import_backoff(4) between interval '1 hour' and interval '72 minutes'),
    (private.share_import_backoff(5) between interval '6 hours' and interval '432 minutes'),
    (private.share_import_backoff(7) between interval '6 hours' and interval '432 minutes')) v(b)),
  'the backoff is 30 s, 2 min, 10 min, 1 h, then 6 h, each with up to 20 % jitter');

-- The eighth transient failure fails the job.
update public.share_imports set attempts = 7, next_attempt_at = now() - interval '1 second' where id = 'a0000000-0000-4000-8000-000000000001';
create temp table claim6 as select * from public.claim_share_import(null);
select is((select attempts from claim6), 8, 'the eighth attempt is claimed');
select is(
  public.release_share_import('a0000000-0000-4000-8000-000000000001', (select lease_token from claim6), 'transient', 'unavailable'),
  'failed', 'and its transient failure fails the job');
select is(
  (select array[status, error_kind, error_code, coalesce(page::text, 'null')] from pg_temp.job('a0000000-0000-4000-8000-000000000001')),
  array['failed', 'transient', 'unavailable', 'null'],
  'with the last code and the page nulled');

-- Try again ----------------------------------------------------------------------------------------
set local role authenticated;
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select is(public.retry_share_import('a0000000-0000-4000-8000-000000000001'), 'received', 'Try again moves the failed import back to received');
select is(
  (select array[id::text, status, attempts::text, coalesce(error_code, 'null')] from public.my_share_imports),
  array['a0000000-0000-4000-8000-000000000001', 'received', '0', 'null'],
  'with the same id, attempts reset and the error cleared');
reset role;
select is((select metered_at from pg_temp.job('a0000000-0000-4000-8000-000000000001')), (select metered_at from metered),
  'still metered');
create temp table claim7 as select * from public.claim_share_import(null);
select is((select id from claim7), 'a0000000-0000-4000-8000-000000000001'::uuid, 'and due at once');
select is(public.reserve_share_import('a0000000-0000-4000-8000-000000000001', (select lease_token from claim7)), 'ok',
  'reserving after Try again is ok');
select is(array[pg_temp.imports_today('11111111-1111-1111-1111-111111111111'), pg_temp.household_imports('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')],
  array[1, 1], 'without charging again');

-- A limit: refused, not charged, then failed with when it resets --------------------------------
update public.ai_safety_limits set per_day = 1 where key = 'recipe_import';
insert into public.share_imports (id, user_id, household_id, add_to_list, url, url_key, payload_hash, page) values
  ('a0000000-0000-4000-8000-000000000003', '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   false, 'https://a.test/stew', 'a.test/stew', '\x03', '{"title": "Stew"}');
create temp table claim8 as select * from public.claim_share_import(array['extracting']);
select is((select id from claim8), 'a0000000-0000-4000-8000-000000000003'::uuid, 'a new share is claimed');
select is(public.reserve_share_import('a0000000-0000-4000-8000-000000000003', (select lease_token from claim8)), 'daily_limit',
  'reserve over the daily limit answers daily_limit');
select is(
  (select coalesce(metered_at::text, 'null') from pg_temp.job('a0000000-0000-4000-8000-000000000003')) || ' ' ||
    pg_temp.imports_today('11111111-1111-1111-1111-111111111111'),
  'null 1', 'and charges nothing');
select is(
  public.release_share_import('a0000000-0000-4000-8000-000000000003', (select lease_token from claim8), 'permanent', 'daily_limit',
    null, date_trunc('day', now()) + interval '1 day'),
  'failed', 'daily_limit fails the job rather than waiting');
select is(
  (select array[error_code, (resets_at = date_trunc('day', now()) + interval '1 day')::text] from pg_temp.job('a0000000-0000-4000-8000-000000000003')),
  array['daily_limit', 'true'], 'keeping when the limit resets');

-- A lost lease that has used its attempts fails instead of being claimed again.
update public.share_imports set status = 'extracting', attempts = 8, lease_token = gen_random_uuid(),
  lease_expires_at = now() - interval '1 second', page = '{"title": "Stew"}'
where id = 'a0000000-0000-4000-8000-000000000003';
select is((select count(*)::int from public.claim_share_import(array['extracting'])), 0,
  'an expired lease after eight attempts isn''t claimed again');
select is(
  (select array[status, error_kind, error_code, coalesce(page::text, 'null'), coalesce(lease_token::text, 'null')]
   from pg_temp.job('a0000000-0000-4000-8000-000000000003')),
  array['failed', 'transient', 'lease_lost', 'null', 'null'],
  'it fails with lease_lost');

-- Retention ----------------------------------------------------------------------------------------
delete from public.share_imports;
insert into public.share_imports (id, user_id, household_id, add_to_list, url, url_key, payload_hash, status, page, extraction, recipe_id, committed_at, created_at) values
  ('b0000000-0000-4000-8000-000000000001', '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', false, 'u', 'u', '\x00',
   'done', '{"p": 1}', '{"e": 1}', 'c0000000-0000-4000-8000-000000000001', now() - interval '8 days', now() - interval '8 days'),
  ('b0000000-0000-4000-8000-000000000002', '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', false, 'u', 'u', '\x00',
   'done', '{"p": 1}', '{"e": 1}', 'c0000000-0000-4000-8000-000000000002', now() - interval '6 days', now() - interval '6 days'),
  ('b0000000-0000-4000-8000-000000000003', '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', false, 'u', 'u', '\x00',
   'failed', '{"p": 1}', null, null, null, now() - interval '1 hour'),
  ('b0000000-0000-4000-8000-000000000004', '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', false, 'u', 'u', '\x00',
   'received', '{"p": 1}', null, null, null, now() - interval '25 hours'),
  ('b0000000-0000-4000-8000-000000000005', '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', false, 'u', 'u', '\x00',
   'received', '{"p": 1}', null, null, null, now() - interval '23 hours'),
  ('b0000000-0000-4000-8000-000000000006', '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', false, 'u', 'u', '\x00',
   'extracted', '{"p": 1}', '{"e": 1}', null, null, now() - interval '2 hours'),
  ('b0000000-0000-4000-8000-000000000007', '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', false, 'u', 'u', '\x00',
   'done', null, null, 'c0000000-0000-4000-8000-000000000007', now() - interval '366 days', now() - interval '366 days'),
  ('b0000000-0000-4000-8000-000000000008', '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', false, 'u', 'u', '\x00',
   'done', null, null, 'c0000000-0000-4000-8000-000000000008', now() - interval '364 days', now() - interval '364 days');
select private.share_imports_retention();

select is(
  array(select right(id::text, 1) || ':' || (page is not null)::text || ':' || (extraction is not null)::text
        from public.share_imports order by id),
  array['1:false:false', '2:false:true', '3:false:false', '4:false:false', '5:true:false', '6:true:true', '8:false:false'],
  'retention nulls pages on done, failed and day-old rows, extractions a week after done, and deletes year-old rows');
select is(
  (select array[recipe_id::text, status] from public.share_imports where id = 'b0000000-0000-4000-8000-000000000001'),
  array['c0000000-0000-4000-8000-000000000001', 'done'], 'keeping the receipt');
select is(
  (select schedule || ' ' || command from cron.job where jobname = 'share-imports-retention'),
  '53 3 * * * select private.share_imports_retention()', 'retention runs daily');

-- Deleting the user deletes their imports.
delete from auth.users where id = '11111111-1111-1111-1111-111111111111';
select is((select count(*)::int from public.share_imports), 0, 'deleting the sharer deletes their share imports');

select * from finish();
rollback;
