-- One-off (manual-checks.md, "Household plans"): the state before 20261129120000_household_plans,
-- to check its backfill on hosted-like data. Delete this file once the check is done.
--   supabase db reset --version 20261128120000
--   psql postgresql://postgres:postgres@127.0.0.1:55322/postgres -v ON_ERROR_STOP=1 -f .migration-check-before.sql
--   supabase migration up --local
--   psql postgresql://postgres:postgres@127.0.0.1:55322/postgres -c "select h.name, hp.plan_id from public.households h left join public.household_plans hp on hp.household_id = h.id order by h.name"
-- Expect: "A owner plus, B member unlimited" founding; "C basic" free; "D none" free; "E unassigned"
-- founding; "F basic + G plus owners" founding; the dev user's "Peacher Paschal Fam" unlimited.
-- And: plans are founding (default), free, unlimited, beta; beta has recipe_import with limit 7 and
-- nothing else; user_plans has no plus, none or basic. Then `supabase db reset` again.
begin;
insert into auth.users (id, email, aud, role) values
  ('a0000000-0000-0000-0000-00000000000a', 'a@check.local', 'authenticated', 'authenticated'),
  ('a0000000-0000-0000-0000-00000000000b', 'b@check.local', 'authenticated', 'authenticated'),
  ('a0000000-0000-0000-0000-00000000000c', 'c@check.local', 'authenticated', 'authenticated'),
  ('a0000000-0000-0000-0000-00000000000d', 'd@check.local', 'authenticated', 'authenticated'),
  ('a0000000-0000-0000-0000-00000000000e', 'e@check.local', 'authenticated', 'authenticated'),
  ('a0000000-0000-0000-0000-00000000000f', 'f@check.local', 'authenticated', 'authenticated'),
  ('a0000000-0000-0000-0000-000000000010', 'g@check.local', 'authenticated', 'authenticated');
insert into public.households (id, name) values
  ('b0000000-0000-0000-0000-0000000000a0', 'A owner plus, B member unlimited'),
  ('b0000000-0000-0000-0000-0000000000c0', 'C basic'),
  ('b0000000-0000-0000-0000-0000000000d0', 'D none'),
  ('b0000000-0000-0000-0000-0000000000e0', 'E unassigned'),
  ('b0000000-0000-0000-0000-0000000000f0', 'F basic + G plus owners');
insert into public.household_members (household_id, user_id, role, position) values
  ('b0000000-0000-0000-0000-0000000000a0', 'a0000000-0000-0000-0000-00000000000a', 'owner', 1),
  ('b0000000-0000-0000-0000-0000000000a0', 'a0000000-0000-0000-0000-00000000000b', 'member', 1),
  ('b0000000-0000-0000-0000-0000000000c0', 'a0000000-0000-0000-0000-00000000000c', 'owner', 1),
  ('b0000000-0000-0000-0000-0000000000d0', 'a0000000-0000-0000-0000-00000000000d', 'owner', 1),
  ('b0000000-0000-0000-0000-0000000000e0', 'a0000000-0000-0000-0000-00000000000e', 'owner', 1),
  ('b0000000-0000-0000-0000-0000000000f0', 'a0000000-0000-0000-0000-00000000000f', 'owner', 1),
  ('b0000000-0000-0000-0000-0000000000f0', 'a0000000-0000-0000-0000-000000000010', 'owner', 1);
insert into public.user_plans (user_id, plan_id) values
  ('a0000000-0000-0000-0000-00000000000a', 'plus'),
  ('a0000000-0000-0000-0000-00000000000b', 'unlimited'),
  ('a0000000-0000-0000-0000-00000000000c', 'basic'),
  ('a0000000-0000-0000-0000-00000000000d', 'none'),
  ('a0000000-0000-0000-0000-00000000000f', 'basic'),
  ('a0000000-0000-0000-0000-000000000010', 'plus'),
  ('019a4c10-0000-7000-8000-0000000de701', 'plus');
-- An admin-made plan with photo import only (and categorize, for the old import rule).
insert into public.plans (id, name) values ('beta', 'Beta');
insert into public.plan_features values ('beta', 'categorize'), ('beta', 'recipe_import_photo');
insert into public.plan_limits values ('beta', 'recipe_import_photo', 7), ('beta', 'categorize', 99);
-- The seed made unlimited the default; hosted has plus.
update public.plans set is_default = false where is_default;
update public.plans set is_default = true where id = 'plus';
commit;
