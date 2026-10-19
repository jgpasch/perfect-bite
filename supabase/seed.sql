-- Seed data (docs/spec.md §8.3). Filled in during M0/M2.

-- Dev user, so `supabase db reset` doesn't sign you out for good. The email and password must match
-- DEV_PASSWORD_EMAIL / DEV_PASSWORD in src/features/auth/account.ts. The profile comes from the
-- on_auth_user_created trigger. GoTrue can't read null token columns, so they're set to ''.
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change, email_change_token_new
) values (
  '00000000-0000-0000-0000-000000000000', '019a4c10-0000-7000-8000-0000000de701', 'authenticated',
  'authenticated', 'jgpasch@gmail.com', extensions.crypt('perfect-bite-dev', extensions.gen_salt('bf')),
  now(), '{"provider": "email", "providers": ["email"]}', '{}', now(), now(), '', '', '', ''
);

insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
values (
  '019a4c10-0000-7000-8000-0000000de701', '019a4c10-0000-7000-8000-0000000de701',
  '{"sub": "019a4c10-0000-7000-8000-0000000de701", "email": "jgpasch@gmail.com", "email_verified": true}',
  'email', now(), now(), now()
);

-- The dev user's household, which they own, with a "Groceries" list as their default (the shape
-- ensureStarterData in src/features/lists/lists.ts gives a new user). The household goes through
-- create_household as the dev user, the way the app's push sends it. On sign-in the app pulls it
-- instead of making a starter household.
select set_config('request.jwt.claims', '{"sub": "019a4c10-0000-7000-8000-0000000de701"}', false);
select public.create_household('019a4c10-0000-7000-8000-00000000a001', 'Peacher Paschal Fam');
select set_config('request.jwt.claims', '', false);

insert into public.lists (id, household_id, name, position)
values ('019a4c10-0000-7000-8000-00000000a002', '019a4c10-0000-7000-8000-00000000a001', 'Groceries', 1);

insert into public.user_settings (user_id, default_list_id)
values ('019a4c10-0000-7000-8000-0000000de701', '019a4c10-0000-7000-8000-00000000a002');

-- The dev user is on unlimited (spec 4.12), so manual testing against local Supabase has every
-- feature. The migrations' own owner-on-a-plan inserts run before this file makes the user, so
-- they're no-ops locally.
insert into public.user_plans (user_id, plan_id)
values ('019a4c10-0000-7000-8000-0000000de701', 'unlimited');

-- The dev user is an admin (spec 4.12), so the admin portal works against local Supabase. As above,
-- the migration's owner insert runs before this file makes the user.
insert into private.admins (user_id)
values ('019a4c10-0000-7000-8000-0000000de701');
