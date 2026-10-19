-- Admins (spec 4.12, 5): private.admins, public.is_admin(), private.require_admin(), and
-- admin.admin_actions.target_plan_id.
begin;
create extension if not exists pgtap with schema extensions;
select plan(17);

-- Fixtures (as postgres) ------------------------------------------------------
insert into auth.users (id, email, aud, role) values
  ('11111111-1111-1111-1111-111111111111', 'admin@test.local', 'authenticated', 'authenticated'),
  ('22222222-2222-2222-2222-222222222222', 'user@test.local', 'authenticated', 'authenticated');
insert into private.admins (user_id) values ('11111111-1111-1111-1111-111111111111');

-- The table ----------------------------------------------------------------------
select col_is_pk('private', 'admins', 'user_id', 'the key is user_id');
select ok((select relrowsecurity from pg_class where oid = 'private.admins'::regclass), 'RLS is on');
select is((select count(*)::int from private.admins where user_id = '22222222-2222-2222-2222-222222222222'), 0,
  'an ordinary user has no row');
select ok(
  not has_table_privilege('authenticated', 'private.admins', 'select')
  and not has_table_privilege('authenticated', 'private.admins', 'insert')
  and not has_table_privilege('anon', 'private.admins', 'select')
  and not has_table_privilege('service_role', 'private.admins', 'select')
  and not has_table_privilege('service_role', 'private.admins', 'insert'),
  'no client role has privileges on private.admins');
select ok((select added_at is not null from private.admins where user_id = '11111111-1111-1111-1111-111111111111'),
  'added_at defaults to now');

-- is_admin -------------------------------------------------------------------------
select ok(not has_function_privilege('anon', 'public.is_admin()', 'execute'), 'anon can''t execute is_admin');
select ok(has_function_privilege('authenticated', 'public.is_admin()', 'execute'), 'authenticated can execute is_admin');
select ok(
  not has_function_privilege('authenticated', 'private.require_admin()', 'execute')
  and not has_function_privilege('anon', 'private.require_admin()', 'execute')
  and not has_function_privilege('service_role', 'private.require_admin()', 'execute'),
  'no client role can execute require_admin');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
select is(public.is_admin(), true, 'is_admin is true for an admin');
select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);
select is(public.is_admin(), false, 'is_admin is false for another user');
select throws_ok($$ select * from private.admins $$, '42501', null, 'authenticated can''t read private.admins');
select set_config('request.jwt.claims', '', true);
select is(public.is_admin(), false, 'is_admin is false with no user');
reset role;

set local role anon;
select throws_ok($$ select public.is_admin() $$, '42501', null, 'anon can''t call is_admin');
reset role;

-- require_admin (as the owner, the way a security definer portal function calls it) ---------------
select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);
select throws_ok($$ select private.require_admin() $$, '42501', 'not authorized',
  'require_admin raises not authorized for a non-admin');
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
select lives_ok($$ select private.require_admin() $$, 'require_admin passes for an admin');
select set_config('request.jwt.claims', '', true);

-- admin_actions.target_plan_id ------------------------------------------------------
select col_is_null('admin', 'admin_actions', 'target_plan_id', 'admin_actions has a nullable target_plan_id');

-- Deleting the user removes their row --------------------------------------------------
delete from auth.users where id = '11111111-1111-1111-1111-111111111111';
select is((select count(*)::int from private.admins where user_id = '11111111-1111-1111-1111-111111111111'), 0, 'deleting the user removes their admins row');

select * from finish();
rollback;
