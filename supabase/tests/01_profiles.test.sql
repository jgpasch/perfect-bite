-- Profiles: created at sign-up, readable and editable only by their owner (spec 5).
begin;
create extension if not exists pgtap with schema extensions;
select plan(9);

-- Fixtures (as postgres) ------------------------------------------------------
insert into auth.users (id, email, aud, role, raw_user_meta_data) values
  ('11111111-1111-1111-1111-111111111111', 'alex@test.local', 'authenticated', 'authenticated', '{"full_name":"Alex Rivera"}'),
  ('22222222-2222-2222-2222-222222222222', 'sam@test.local', 'authenticated', 'authenticated', '{}');

select is((select display_name from public.profiles where user_id = '11111111-1111-1111-1111-111111111111'),
  'Alex Rivera', 'sign-up creates a profile named from the Google profile');
select is((select display_name from public.profiles where user_id = '22222222-2222-2222-2222-222222222222'),
  'sam', 'without a profile name, the email local part is used');

-- Act as Alex -----------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);

select results_eq($$ select user_id from public.profiles $$,
  $$ values ('11111111-1111-1111-1111-111111111111'::uuid) $$, 'Alex sees only own profile');

update public.profiles set display_name = 'Al' where user_id = '11111111-1111-1111-1111-111111111111';
select is((select display_name from public.profiles), 'Al', 'Alex can rename self');

update public.profiles set display_name = 'hacked' where user_id = '22222222-2222-2222-2222-222222222222';
reset role;
select is((select display_name from public.profiles where user_id = '22222222-2222-2222-2222-222222222222'),
  'sam', 'Alex cannot rename Sam');
set local role authenticated;

select throws_ok($$ update public.profiles set user_id = '22222222-2222-2222-2222-222222222222' $$,
  '42501', null, 'user_id is not updatable');
select throws_ok($$ insert into public.profiles (user_id, display_name) values ('11111111-1111-1111-1111-111111111111', 'x') $$,
  '42501', null, 'clients cannot insert profiles');
select throws_ok($$ delete from public.profiles $$,
  '42501', null, 'clients cannot delete profiles');

-- Anonymous -------------------------------------------------------------------
set local role anon;
select throws_ok($$ select * from public.profiles $$, '42501', null, 'anon cannot read profiles');

select * from finish();
rollback;
