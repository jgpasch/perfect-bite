-- List presence (spec 4.1, 7.2): only members of a list's household can join its private Realtime
-- topic `list:<listId>` or track presence on it. Realtime authorizes a join by reading a presence
-- message as the caller (select policy) and a track by inserting one as the caller (insert policy),
-- with `realtime.topic` set to the channel's topic; these tests do the same.
begin;
create extension if not exists pgtap with schema extensions;
select plan(12);

-- Fixtures (as postgres) ------------------------------------------------------
-- Alex and Jo share household A, which has one list. Sam owns household S, with a list of its own.
insert into auth.users (id, email, aud, role) values
  ('11111111-1111-1111-1111-111111111111', 'alex@test.local', 'authenticated', 'authenticated'),
  ('22222222-2222-2222-2222-222222222222', 'sam@test.local', 'authenticated', 'authenticated'),
  ('33333333-3333-3333-3333-333333333333', 'jo@test.local', 'authenticated', 'authenticated');

insert into public.households (id, name) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Alex''s household'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Sam''s household');
insert into public.household_members (household_id, user_id, role, position) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'owner', 1),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '33333333-3333-3333-3333-333333333333', 'member', 2),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '22222222-2222-2222-2222-222222222222', 'owner', 1);
insert into public.lists (id, household_id, name, position) values
  ('a1000000-0000-7000-8000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Groceries', 1),
  ('b1000000-0000-7000-8000-000000000001', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Sam''s list', 1);

-- realtime.messages is partitioned by day, and the Realtime server makes the partitions. Make
-- today's if it isn't there (e.g. a fresh database), so the inserts below have somewhere to go.
do $$
begin
  execute format(
    'create table realtime.messages_pgtap partition of realtime.messages for values from (%L) to (%L)',
    date_trunc('day', now() at time zone 'utc'),
    date_trunc('day', now() at time zone 'utc') + interval '1 day');
exception when others then
  null; -- today's partition already exists
end;
$$;

-- What Realtime reads for a join: a presence message on each topic, written as the server.
insert into realtime.messages (id, topic, extension, private) values
  ('c0000000-0000-4000-8000-000000000001', 'list:a1000000-0000-7000-8000-000000000001', 'presence', true),
  ('c0000000-0000-4000-8000-000000000002', 'list:a1000000-0000-7000-8000-000000000001', 'broadcast', true),
  ('c0000000-0000-4000-8000-000000000003', 'list:b1000000-0000-7000-8000-000000000001', 'presence', true);

-- The helper -------------------------------------------------------------------
select has_function('private', 'can_use_list_topic', array['text'], 'private.can_use_list_topic(text) exists');

-- As Alex (a member of household A) --------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
select set_config('realtime.topic', 'list:a1000000-0000-7000-8000-000000000001', true);

select is(
  (select count(*)::int from realtime.messages where id = 'c0000000-0000-4000-8000-000000000001'),
  1, 'a member can join their list''s topic (reads its presence)');
select is(
  (select count(*)::int from realtime.messages where id = 'c0000000-0000-4000-8000-000000000002'),
  0, 'a member can''t read broadcast on it: the topic is for presence only');
select lives_ok(
  $$ insert into realtime.messages (topic, extension, private) values ('list:a1000000-0000-7000-8000-000000000001', 'presence', true) $$,
  'a member can track presence on their list''s topic');
select throws_ok(
  $$ insert into realtime.messages (topic, extension, private) values ('list:a1000000-0000-7000-8000-000000000001', 'broadcast', true) $$,
  '42501', null, 'a member can''t broadcast on it');

-- Another household's list, with the topic set to it.
select set_config('realtime.topic', 'list:b1000000-0000-7000-8000-000000000001', true);
select is(
  (select count(*)::int from realtime.messages where id = 'c0000000-0000-4000-8000-000000000003'),
  0, 'a member of another household can''t join that list''s topic');

-- A topic that isn't a list.
select set_config('realtime.topic', 'list:not-a-uuid', true);
select throws_ok(
  $$ insert into realtime.messages (topic, extension, private) values ('list:not-a-uuid', 'presence', true) $$,
  '42501', null, 'a topic that names no list can''t be tracked on');

-- As Sam (not a member of household A) ------------------------------------------
select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);
select set_config('realtime.topic', 'list:a1000000-0000-7000-8000-000000000001', true);

select is(
  (select count(*)::int from realtime.messages where id = 'c0000000-0000-4000-8000-000000000001'),
  0, 'a non-member can''t join the list''s topic');
select throws_ok(
  $$ insert into realtime.messages (topic, extension, private) values ('list:a1000000-0000-7000-8000-000000000001', 'presence', true) $$,
  '42501', null, 'a non-member can''t track presence on the list''s topic');

select set_config('realtime.topic', 'list:b1000000-0000-7000-8000-000000000001', true);
select is(
  (select count(*)::int from realtime.messages where id = 'c0000000-0000-4000-8000-000000000003'),
  1, 'Sam can join their own list''s topic');

-- Jo (Alex's household) after leaving it ---------------------------------------------
reset role;
delete from public.household_members
  where household_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' and user_id = '33333333-3333-3333-3333-333333333333';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}', true);
select set_config('realtime.topic', 'list:a1000000-0000-7000-8000-000000000001', true);
select is(
  (select count(*)::int from realtime.messages where id = 'c0000000-0000-4000-8000-000000000001'),
  0, 'someone who left the household can''t join the list''s topic any more');

-- Signed out --------------------------------------------------------------------------
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select throws_ok(
  $$ insert into realtime.messages (topic, extension, private) values ('list:a1000000-0000-7000-8000-000000000001', 'presence', true) $$,
  '42501', null, 'anon can''t track presence');

select * from finish();
rollback;
