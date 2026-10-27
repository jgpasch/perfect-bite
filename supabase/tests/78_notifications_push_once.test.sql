-- Notifications never push twice (spec 4.13, 8.5): a sent group is archived and recorded in one
-- call, and the cron job only wakes the worker for events a run can read, or for receipts.
begin;
create extension if not exists pgtap with schema extensions;
select plan(12);

-- archive_sent_household_events -------------------------------------------------
select ok(
  not has_function_privilege('anon', 'public.archive_sent_household_events(bigint[], uuid, uuid, uuid, text)', 'execute')
  and not has_function_privilege('authenticated', 'public.archive_sent_household_events(bigint[], uuid, uuid, uuid, text)', 'execute'),
  'clients cannot archive sent events');
select ok(
  has_function_privilege('service_role', 'public.archive_sent_household_events(bigint[], uuid, uuid, uuid, text)', 'execute'),
  'the worker (service_role) can');

delete from pgmq.q_household_events;
delete from private.push_sent;
select pgmq.send('household_events', '{"n": 1}');
select pgmq.send('household_events', '{"n": 2}');
create temp table first_id on commit drop as select array_agg(msg_id) as ids from pgmq.q_household_events where message ->> 'n' = '1';
grant select on first_id to service_role;
set local role service_role;
select public.archive_sent_household_events(
  (select ids from first_id),
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111',
  'a1000000-0000-7000-8000-000000000001', 'shopping');
reset role;
select results_eq(
  $$ select message ->> 'n' from pgmq.a_household_events where message ? 'n' $$, $$ values ('1') $$,
  'the sent group''s events are archived');
select results_eq(
  $$ select message ->> 'n' from pgmq.q_household_events $$, $$ values ('2') $$,
  'and only those');
select results_eq(
  $$ select household_id, actor, list_id, kind from private.push_sent $$,
  $$ values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid, '11111111-1111-1111-1111-111111111111'::uuid,
            'a1000000-0000-7000-8000-000000000001'::uuid, 'shopping') $$,
  'and the group is recorded as sent in the same call');

-- A failure records nothing and archives nothing: one transaction.
select throws_ok(
  $$ select public.archive_sent_household_events(
       (select array_agg(msg_id) from pgmq.q_household_events),
       gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'party') $$,
  '23514', null, 'a bad kind fails the call');
select is((select count(*)::int from pgmq.q_household_events), 1, 'and the events stay queued');
select is((select count(*)::int from private.push_sent), 1, 'with nothing recorded');

-- request_send_notifications ----------------------------------------------------
delete from vault.secrets where name in ('project_url', 'notifications_worker_key');
select vault.create_secret('http://host.docker.internal:55321', 'project_url');
select vault.create_secret('test-key', 'notifications_worker_key');
delete from private.push_receipts;

-- The queued event is hidden, as a running worker's read leaves it.
select pgmq.set_vt('household_events', (select msg_id from pgmq.q_household_events), 300);
select is(private.request_send_notifications(), false, 'a hidden event alone doesn''t wake the worker');

select pgmq.set_vt('household_events', (select msg_id from pgmq.q_household_events), 0);
select is(private.request_send_notifications(), true, 'a visible event does');

select pgmq.set_vt('household_events', (select msg_id from pgmq.q_household_events), 300);
insert into private.push_receipts (ticket_id, token) values ('t-1', 'ExponentPushToken[alex]');
select is(private.request_send_notifications(), true, 'a receipt to check does, with only hidden events');

delete from private.push_receipts;
delete from pgmq.q_household_events;
select is(private.request_send_notifications(), false, 'an empty queue and no receipts don''t');

select * from finish();
rollback;
