-- apply_mutations from two devices at once (composite_key_row_lock.sql, list_lock_activity_actor.sql).
-- Each device is its own session over dblink, so device A can hold its transaction open while
-- device B's push runs into it. Sessions only see committed rows, so the fixtures are committed
-- (with fresh ids, so they can't meet another run's) and removed at the end.
begin;
create extension if not exists pgtap with schema extensions;
create extension if not exists dblink with schema extensions;
select plan(14);

select gen_random_uuid() as uid, gen_random_uuid() as hh, gen_random_uuid() as list,
  gen_random_uuid() as item_a, gen_random_uuid() as item_b \gset
-- By the address this session came in on, where dblink has to log in with a password.
select format('host=%s port=%s dbname=postgres user=postgres password=postgres',
  host(inet_server_addr()), inet_server_port()) as conn \gset

-- Fixtures (committed) ------------------------------------------------------------
select extensions.dblink_connect('setup', :'conn');
select extensions.dblink_exec('setup', format($f$
  insert into auth.users (id, email, aud, role) values (%1$L, %1$L || '@race.test.local', 'authenticated', 'authenticated');
  insert into public.households (id, name) values (%2$L, 'Racing household');
  insert into public.household_members (household_id, user_id, role, position) values (%2$L, %1$L, 'owner', 1);
  insert into public.lists (id, household_id, name, position) values (%3$L, %2$L, 'Groceries', 1);
$f$, :'uid', :'hh', :'list'));

-- Two devices of the same member, each its own session.
create function pg_temp.device(p_conn text, p_connstr text, p_uid uuid) returns void language plpgsql as $$
begin
  perform extensions.dblink_connect(p_conn, p_connstr);
  perform extensions.dblink_exec(p_conn, format(
    'set request.jwt.claims = %L',
    jsonb_build_object('sub', p_uid, 'role', 'authenticated')::text));
  perform extensions.dblink_exec(p_conn, 'set role authenticated');
end $$;
select pg_temp.device('a', :'conn', :'uid');
select pg_temp.device('b', :'conn', :'uid');

-- A push that runs to the end.
create function pg_temp.push(p_conn text, p_mutations text) returns jsonb language sql as $$
  select r.res::jsonb from extensions.dblink(p_conn,
    format('select public.apply_mutations(%L::jsonb)::text', p_mutations)) as r(res text)
$$;
-- A push that's sent and may wait, and its result once it's done.
create function pg_temp.send(p_conn text, p_mutations text) returns int language sql as $$
  select extensions.dblink_send_query(p_conn,
    format('select public.apply_mutations(%L::jsonb)::text', p_mutations))
$$;
create function pg_temp.result(p_conn text) returns jsonb language plpgsql as $$
declare
  v_res text;
begin
  select r.res into v_res from extensions.dblink_get_result(p_conn) as r(res text);
  perform * from extensions.dblink_get_result(p_conn) as r(res text);
  return v_res::jsonb;
end $$;

-- Racing inserts of one ingredient_usage row -----------------------------------------
select extensions.dblink_exec('a', 'begin');
select is(
  pg_temp.push('a', format($m$ [{ "table": "ingredient_usage", "key": { "household_id": %s, "ingredient_name": "banana" },
    "hlc": "1760000000000-0000-deva", "fields": { "display_name": "Banana", "last_used_at": "2026-10-26T10:00:00Z" },
    "counters": { "use_count": 1 } }] $m$, to_jsonb(:'hh'::text))),
  '[{"status": "applied"}]'::jsonb, 'device A inserts the usage row, and hasn''t committed yet');
select pg_temp.send('b', format($m$ [{ "table": "ingredient_usage", "key": { "household_id": %s, "ingredient_name": "banana" },
  "hlc": "1760000000001-0000-devb", "fields": { "display_name": "Bananas", "last_used_at": "2026-10-26T10:00:01Z" },
  "counters": { "use_count": 2 } }] $m$, to_jsonb(:'hh'::text)));
select pg_sleep(0.3);
select is(extensions.dblink_is_busy('b'), 1, 'device B''s insert of the same row waits for device A');
select extensions.dblink_exec('a', 'commit');
select is(pg_temp.result('b'), '[{"status": "applied"}]'::jsonb,
  'once A commits, B''s insert is applied on top of A''s row, not rejected');
select results_eq(
  format($q$ select display_name, use_count, field_clock ->> 'display_name' from public.ingredient_usage where household_id = %L $q$, :'hh'),
  $$ values ('Bananas', 3, '1760000000001-0000-devb') $$,
  'both devices'' counts are added, and the later display_name wins');

-- The same row spelled with an upper-case uuid --------------------------------------
select extensions.dblink_exec('a', 'begin');
select is(
  pg_temp.push('a', format($m$ [{ "table": "ingredient_unit_usage", "key": { "household_id": %s, "ingredient_name": "banana", "unit_key": "count" },
    "hlc": "1760000000010-0000-deva", "fields": { "last_used_at": "2026-10-26T10:00:00Z" }, "counters": { "use_count": 1 } }] $m$,
    to_jsonb(:'hh'::text))),
  '[{"status": "applied"}]'::jsonb, 'device A inserts the unit usage row, and hasn''t committed yet');
select pg_temp.send('b', format($m$ [{ "table": "ingredient_unit_usage", "key": { "household_id": %s, "ingredient_name": "banana", "unit_key": "count" },
  "hlc": "1760000000011-0000-devb", "fields": { "last_used_at": "2026-10-26T11:00:00Z" }, "counters": { "use_count": 4 } }] $m$,
  to_jsonb(upper(:'hh'::text))));
select pg_sleep(0.3);
select is(extensions.dblink_is_busy('b'), 1, 'B waits for A when it spells the household id in upper case');
select extensions.dblink_exec('a', 'commit');
select is(pg_temp.result('b'), '[{"status": "applied"}]'::jsonb, 'and is applied once A commits');
select results_eq(
  format($q$ select use_count, last_used_at from public.ingredient_unit_usage where household_id = %L $q$, :'hh'),
  $$ values (5, '2026-10-26T11:00:00Z'::timestamptz) $$,
  'both counts are added, and the later last_used_at is kept');

-- The first writer rolls back -------------------------------------------------------
select extensions.dblink_exec('a', 'begin');
select pg_temp.push('a', format($m$ [{ "table": "ingredient_usage", "key": { "household_id": %s, "ingredient_name": "apple" },
  "hlc": "1760000000020-0000-deva", "fields": { "display_name": "Apple", "last_used_at": "2026-10-26T10:00:00Z" },
  "counters": { "use_count": 1 } }] $m$, to_jsonb(:'hh'::text)));
select pg_temp.send('b', format($m$ [{ "table": "ingredient_usage", "key": { "household_id": %s, "ingredient_name": "apple" },
  "hlc": "1760000000021-0000-devb", "fields": { "display_name": "Apples", "last_used_at": "2026-10-26T10:00:01Z" },
  "counters": { "use_count": 2 } }] $m$, to_jsonb(:'hh'::text)));
select pg_sleep(0.3);
select extensions.dblink_exec('a', 'rollback');
select is(pg_temp.result('b'), '[{"status": "applied"}]'::jsonb, 'when A rolls back, B inserts the row itself');
select results_eq(
  format($q$ select display_name, use_count from public.ingredient_usage where household_id = %L and ingredient_name = 'apple' $q$, :'hh'),
  $$ values ('Apples', 2) $$,
  'with only B''s count');

-- Racing items for one ingredient on one list ---------------------------------------
select extensions.dblink_exec('a', 'begin');
select is(
  pg_temp.push('a', format($m$ [{ "table": "list_items", "id": %s, "hlc": "1760000000030-0000-deva",
    "fields": { "list_id": %s, "household_id": %s, "ingredient_name": "milk", "display_name": "Milk" } }] $m$,
    to_jsonb(:'item_a'::text), to_jsonb(:'list'::text), to_jsonb(:'hh'::text))),
  '[{"status": "applied"}]'::jsonb, 'device A adds milk to the list, and hasn''t committed yet');
select pg_temp.send('b', format($m$ [{ "table": "list_items", "id": %s, "hlc": "1760000000031-0000-devb",
  "fields": { "list_id": %s, "household_id": %s, "ingredient_name": "milk", "display_name": "milk" } }] $m$,
  to_jsonb(:'item_b'::text), to_jsonb(:'list'::text), to_jsonb(:'hh'::text)));
select pg_sleep(0.3);
select is(extensions.dblink_is_busy('b'), 1, 'device B''s milk on the same list waits for device A');
select extensions.dblink_exec('a', 'commit');
select is(pg_temp.result('b'), jsonb_build_array(jsonb_build_object('status', 'merged', 'merged_into', :'item_a'::uuid)),
  'once A commits, B''s milk is merged into A''s');
select results_eq(
  format($q$ select id, deleted_at is null, merged_into from public.list_items where list_id = %L order by id = %L desc $q$,
    :'list', :'item_a'),
  format($q$ values (%L::uuid, true, null::uuid), (%L::uuid, false, %L::uuid) $q$, :'item_a', :'item_b', :'item_a'),
  'one milk stays open on the list');

-- Cleanup ---------------------------------------------------------------------------
select extensions.dblink_disconnect('a');
select extensions.dblink_disconnect('b');
select extensions.dblink_exec('setup', format($f$
  delete from private.applied_counters where row_key like '%%' || %1$L || '%%' or row_key like '%%' || upper(%1$L) || '%%';
  delete from public.households where id = %1$L;
  delete from auth.users where id = %2$L;
$f$, :'hh', :'uid'));
select extensions.dblink_disconnect('setup');

select * from finish();
rollback;
