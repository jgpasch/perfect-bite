-- Per-list lock and activity actor (share import on the server, plan §5 steps 3 and 6, §6).
--
-- The lock: pgTAP runs in one session, so two concurrent transactions are simulated by asserting
-- the lock is taken. Every list_items write through apply_mutation holds the transaction-level
-- advisory lock hashtextextended('list:' || list_id, 0) (seen in pg_locks for this backend), which
-- a second transaction writing to that list waits on until the first commits; then, as the
-- sequential case here shows, the second item for the same key is merged and one stays open.
--
-- The actor: private.log_user_activity logs as auth.uid(), else app.actor_uid, else not at all.
begin;
create extension if not exists pgtap with schema extensions;
select plan(15);

-- Fixtures (as postgres, no user, so nothing is logged) ------------------------------------------
insert into auth.users (id, email, aud, role) values
  ('11111111-1111-1111-1111-111111111111', 'alex@test.local', 'authenticated', 'authenticated'),
  ('22222222-2222-2222-2222-222222222222', 'sam@test.local', 'authenticated', 'authenticated');
insert into public.households (id, name) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Home');
insert into public.household_members (household_id, user_id, role, position) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'owner', 1),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '22222222-2222-2222-2222-222222222222', 'member', 1);
insert into public.lists (id, household_id, name, position) values
  ('a1000000-0000-7000-8000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'One', 1),
  ('a1000000-0000-7000-8000-000000000002', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Two', 2),
  ('a1000000-0000-7000-8000-000000000003', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Three', 3),
  ('a1000000-0000-7000-8000-000000000004', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Four', 4),
  ('a1000000-0000-7000-8000-000000000005', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Five', 5);
insert into public.ingredients (normalized_name, display_name) values
  ('test lime', 'lime'), ('test onion', 'onion'), ('test basil', 'basil')
on conflict do nothing;
insert into public.list_items (id, list_id, household_id, ingredient_name, display_name) values
  ('a2000000-0000-7000-8000-000000000031', 'a1000000-0000-7000-8000-000000000003', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'test onion', 'onion'),
  ('a2000000-0000-7000-8000-000000000041', 'a1000000-0000-7000-8000-000000000004', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'test basil', 'basil');
delete from private.user_activity;

-- Whether this backend holds the list's lock.
create function pg_temp.list_locked(p_list uuid) returns boolean language sql as $$
  select exists (
    select 1 from pg_catalog.pg_locks l
    where l.locktype = 'advisory' and l.pid = pg_catalog.pg_backend_pid() and l.granted
      and l.objsubid = 1
      and ((l.classid::bigint << 32) | l.objid::bigint) = hashtextextended('list:' || p_list::text, 0)
  )
$$;

-- The lock -----------------------------------------------------------------------------------------
select ok(not pg_temp.list_locked('a1000000-0000-7000-8000-000000000001'), 'no lock before any write');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);

select is(
  public.apply_mutations($$ [
    { "table": "list_items", "id": "a2000000-0000-7000-8000-000000000011", "hlc": "1770000000001-0000-alex",
      "fields": { "list_id": "a1000000-0000-7000-8000-000000000001", "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "ingredient_name": "test lime", "display_name": "lime" } }
  ] $$),
  '[{"status": "applied"}]'::jsonb,
  'a new open item is applied');
reset role;
select ok(pg_temp.list_locked('a1000000-0000-7000-8000-000000000001'),
  'a new item holds its list''s lock until the transaction ends');
select ok(not pg_temp.list_locked('a1000000-0000-7000-8000-000000000002'), 'and no other list''s');

-- The second writer of the same key (here after the first, as it would be once the lock is
-- released) sees the first item and merges into it.
set local role authenticated;
select is(
  public.apply_mutations($$ [
    { "table": "list_items", "id": "a2000000-0000-7000-8000-000000000012", "hlc": "1770000000002-0000-sam1",
      "fields": { "list_id": "a1000000-0000-7000-8000-000000000001", "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "ingredient_name": "test lime", "display_name": "lime" } }
  ] $$),
  '[{"status": "merged", "merged_into": "a2000000-0000-7000-8000-000000000011"}]'::jsonb,
  'a second open item for the same key is merged into the first');
reset role;
select is(
  (select count(*)::int from public.list_items
   where list_id = 'a1000000-0000-7000-8000-000000000001' and ingredient_name = 'test lime'
     and deleted_at is null and checked_at is null),
  1, 'one open item for the key');

-- Other tables don't take it.
set local role authenticated;
select is(
  public.apply_mutations($$ [
    { "table": "lists", "id": "a1000000-0000-7000-8000-000000000002", "hlc": "1770000000003-0000-alex",
      "fields": { "name": "Two renamed" } }
  ] $$),
  '[{"status": "applied"}]'::jsonb,
  'a list rename is applied');
reset role;
select ok(not pg_temp.list_locked('a1000000-0000-7000-8000-000000000002'), 'a write to lists takes no list lock');

-- An update naming only the item takes its list's lock, from the row.
set local role authenticated;
select is(
  public.apply_mutations($$ [
    { "table": "list_items", "id": "a2000000-0000-7000-8000-000000000031", "hlc": "1770000000004-0000-alex",
      "fields": { "checked_at": "2026-10-22T12:00:00Z" } }
  ] $$),
  '[{"status": "applied"}]'::jsonb,
  'checking an item is applied');
reset role;
select ok(pg_temp.list_locked('a1000000-0000-7000-8000-000000000003'), 'an update locks the item''s list');

-- An open item moved to another list locks that one too.
set local role authenticated;
select is(
  public.apply_mutations($$ [
    { "table": "list_items", "id": "a2000000-0000-7000-8000-000000000041", "hlc": "1770000000005-0000-alex",
      "fields": { "list_id": "a1000000-0000-7000-8000-000000000005" } }
  ] $$),
  '[{"status": "applied"}]'::jsonb,
  'moving an open item is applied');
reset role;
select ok(pg_temp.list_locked('a1000000-0000-7000-8000-000000000004')
  and pg_temp.list_locked('a1000000-0000-7000-8000-000000000005'),
  'moving an open item locks the list it leaves and the one it lands on');

-- The actor ----------------------------------------------------------------------------------------
-- As postgres with no JWT, writing as the commit RPC does: private.apply_mutation for a user.
select set_config('request.jwt.claims', '', true);
delete from private.user_activity;

select private.apply_mutation($$
  { "table": "list_items", "id": "a2000000-0000-7000-8000-000000000051", "hlc": "1770000000006-0000-srv",
    "fields": { "list_id": "a1000000-0000-7000-8000-000000000002", "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "ingredient_name": "test onion", "display_name": "onion" } }
$$, '22222222-2222-2222-2222-222222222222');
select set_config('app.actor_uid', '', true);
select private.apply_mutation($$
  { "table": "list_items", "id": "a2000000-0000-7000-8000-000000000052", "hlc": "1770000000007-0000-srv",
    "fields": { "list_id": "a1000000-0000-7000-8000-000000000002", "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "ingredient_name": "test basil", "display_name": "basil" } }
$$, '22222222-2222-2222-2222-222222222222');
select is((select count(*)::int from private.user_activity), 0,
  'with no JWT and no app.actor_uid (unset or empty), nothing is logged');

select set_config('app.actor_uid', '22222222-2222-2222-2222-222222222222', true);
select private.apply_mutation($$
  { "table": "list_items", "id": "a2000000-0000-7000-8000-000000000053", "hlc": "1770000000008-0000-srv",
    "fields": { "list_id": "a1000000-0000-7000-8000-000000000002", "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "ingredient_name": "test lime", "display_name": "lime" } }
$$, '22222222-2222-2222-2222-222222222222');
select results_eq(
  $$ select user_id, action, entity_id, data ->> 'list' from private.user_activity $$,
  $$ values ('22222222-2222-2222-2222-222222222222'::uuid, 'item.added', 'a2000000-0000-7000-8000-000000000053', 'Two renamed') $$,
  'with app.actor_uid and no JWT, the write is logged for that user');

-- A signed-in user's own writes stay theirs.
delete from private.user_activity;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
select public.apply_mutations($$ [
  { "table": "lists", "id": "a1000000-0000-7000-8000-000000000005", "hlc": "1770000000009-0000-alex",
    "fields": { "name": "Five renamed" } }
] $$);
reset role;
select results_eq(
  $$ select user_id, action from private.user_activity $$,
  $$ values ('11111111-1111-1111-1111-111111111111'::uuid, 'list.renamed') $$,
  'with both, auth.uid() is the actor');

select * from finish();
rollback;
