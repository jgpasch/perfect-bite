-- Demo data for the admin portal, local only (spec 4.12). Never run it against hosted.
--
-- Ten fake users (demo-1@example.com … demo-10@example.com), each owning one household made when
-- they joined, with an explicit household_plans row on every plan (some on the default plan at the
-- time of the run), one household under 30 days old (doubled limits); usage of both plan features
-- over the last 40 days, on the user and on their household, with demo-1's household at founding's
-- monthly limits and demo-2's over them; a few ai_calls rows per task with mixed statuses, tokens
-- and fallbacks; and a few admin.admin_actions rows (on the old plan ids, as audit rows from before
-- the household plans migration are).
-- seed.sql doesn't run it, so `supabase db reset` leaves it out and the pgTAP counts and the app's
-- dev data don't change.
--
-- Run it after `supabase db reset` (and again after every reset), from the repo root:
--
--   psql postgresql://postgres:postgres@127.0.0.1:55322/postgres -f supabase/seed-admin-demo.sql
--
-- or paste it into the local SQL editor (http://127.0.0.1:55323). It's idempotent: every row has a
-- fixed id (all start de300000-), and a second run inserts nothing. Dates are relative to the run,
-- so to move them to today, remove it and run it again.
--
-- Remove it (deleting the households cascades to their plans, members and usage; deleting the
-- users to their profiles and usage):
--
--   delete from public.households where id::text like 'de300000-%';
--   delete from auth.users where id::text like 'de300000-%';
--   delete from public.ai_calls where id::text like 'de300000-%';
--   delete from admin.admin_actions where id::text like 'de300000-%';

begin;

-- level: how much of each feature in their plan they use. light, medium and heavy are spread over
-- the days; at and over also reach founding's monthly limit (exactly, and by a quarter more) this month.
create temp table demo_users (
  n integer,
  id uuid,
  full_name text,
  joined interval,
  plan_id text,           -- null: the default plan, as a household made now gets
  level text
) on commit drop;

insert into demo_users values
  (1,  'de300000-0000-4000-8000-000000000001', 'Maya Chen',    interval '152 days', 'founding',  'at'),
  (2,  'de300000-0000-4000-8000-000000000002', 'Theo Okafor',  interval '121 days', null,        'over'),
  (3,  'de300000-0000-4000-8000-000000000003', 'Priya Raman',  interval '98 days',  'unlimited', 'heavy'),
  (4,  'de300000-0000-4000-8000-000000000004', 'Sam Delgado',  interval '90 days',  'free',      'medium'),
  (5,  'de300000-0000-4000-8000-000000000005', 'Lena Fischer', interval '76 days',  'free',      'light'),
  (6,  'de300000-0000-4000-8000-000000000006', 'Kofi Mensah',  interval '63 days',  null,        'light'),
  (7,  'de300000-0000-4000-8000-000000000007', 'Ana Souza',    interval '47 days',  'founding',  'medium'),
  (8,  'de300000-0000-4000-8000-000000000008', 'Jonas Berg',   interval '38 days',  'free',      'light'),
  (9,  'de300000-0000-4000-8000-000000000009', 'Hana Sato',    interval '12 days',  null,        'medium'),
  (10, 'de300000-0000-4000-8000-000000000010', 'Omar Haddad',  interval '160 days', 'founding',  'light');

-- Users. The profile (display name from full_name) comes from the on_auth_user_created trigger.
-- No password or identity: they're for looking at, not signing in as.
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at, last_sign_in_at,
  confirmation_token, recovery_token, email_change, email_change_token_new
)
select
  '00000000-0000-0000-0000-000000000000', u.id, 'authenticated', 'authenticated',
  'demo-' || u.n || '@example.com', '', now() - u.joined,
  '{"provider": "google", "providers": ["google"]}', jsonb_build_object('full_name', u.full_name),
  now() - u.joined, now() - u.joined, now() - (u.n % 5) * interval '1 day' - u.n * interval '1 hour',
  '', '', '', ''
from demo_users u
on conflict do nothing;

-- One household each, owned by the user and made when they joined, with its plan row (a plan
-- belongs to a household; every household has a row).
insert into public.households (id, name, created_at)
select ('de300000-0000-4000-8003-' || lpad(u.n::text, 12, '0'))::uuid,
  split_part(u.full_name, ' ', 1) || '''s household', now() - u.joined
from demo_users u
on conflict do nothing;

insert into public.household_members (household_id, user_id, role, position)
select ('de300000-0000-4000-8003-' || lpad(u.n::text, 12, '0'))::uuid, u.id, 'owner', 1
from demo_users u
on conflict do nothing;

insert into public.household_plans (household_id, plan_id, assigned_at)
select ('de300000-0000-4000-8003-' || lpad(u.n::text, 12, '0'))::uuid,
  coalesce(u.plan_id, (select p.id from public.plans p where p.is_default)), now() - u.joined
from demo_users u
where coalesce(u.plan_id, (select p.id from public.plans p where p.is_default)) is not null
on conflict do nothing;

-- Usage per user, feature in their household's plan and UTC day, in the limits' units
-- (categorize: names; the rest: calls), from deterministic hashes so every run gives the same
-- numbers. Plans only have recipe_import and recipe_photo_ai now, so the other keys' scales go
-- unused.
create temp table demo_usage on commit drop as
select u.id as user_id, f.feature, d.day, v.used
from demo_users u
join public.plan_features f
  on f.plan_id = coalesce(u.plan_id, (select p.id from public.plans p where p.is_default))
cross join lateral generate_series(0, 39) g (days_ago)
cross join lateral (select (now() at time zone 'utc')::date - g.days_ago as day) d
cross join lateral (select abs(hashtext(u.id::text || f.feature || g.days_ago)) as h) r
cross join lateral (
  select ceil(
    (case f.feature
      when 'categorize' then 8
      when 'step_ingredients' then 3
      when 'recipe_import' then 1.3
      when 'recipe_import_photo' then 0.7
      when 'recipe_tags' then 1.7
      when 'recipe_photo_ai' then 0.5
    end)
    * (case u.level when 'light' then 0.3 when 'medium' then 0.7 when 'heavy' then 1.5 else 0.4 end)
    * (r.h % 100) / 50.0
  )::integer as used
) v
where d.day >= ((now() - u.joined) at time zone 'utc')::date
  and (case u.level when 'light' then r.h % 4 = 0 else r.h % 3 <> 0 end)
  and not (u.level in ('at', 'over') and g.days_ago = 0)
  and v.used > 0;

-- at and over: today tops this month up to founding's limit (at) or a quarter over it (over).
insert into demo_usage (user_id, feature, day, used)
select u.id, l.feature, (now() at time zone 'utc')::date,
  greatest(
    ceil(l.monthly_limit * (case u.level when 'at' then 1 else 1.25 end))::integer
      - coalesce((
        select sum(m.used) from demo_usage m
        where m.user_id = u.id and m.feature = l.feature
          and m.day >= date_trunc('month', now() at time zone 'utc')::date
      ), 0),
    0
  )
from demo_users u
join public.plan_limits l on l.plan_id = 'founding' and l.monthly_limit is not null
where u.level in ('at', 'over');

insert into private.categorize_usage (user_id, day, minute_start, new_names)
select user_id, day, day::timestamptz, used from demo_usage where feature = 'categorize'
on conflict do nothing;

insert into private.recipe_import_usage (user_id, day, minute_start, imports)
select user_id, day, day::timestamptz, used from demo_usage where feature = 'recipe_import'
on conflict do nothing;

insert into private.recipe_photo_import_usage (user_id, day, minute_start, imports)
select user_id, day, day::timestamptz, used from demo_usage where feature = 'recipe_import_photo'
on conflict do nothing;

insert into private.recipe_tags_usage (user_id, day, minute_start, suggestions)
select user_id, day, day::timestamptz, used from demo_usage where feature = 'recipe_tags'
on conflict do nothing;

insert into private.step_match_usage (user_id, day, minute_start, matches)
select user_id, day, day::timestamptz, used from demo_usage where feature = 'step_ingredients'
on conflict do nothing;

insert into private.recipe_photo_ai_usage (user_id, day, photos)
select user_id, day, used from demo_usage where feature = 'recipe_photo_ai'
on conflict do nothing;

-- The same use of the two plan features on the user's household, where the monthly limit is
-- checked (each household has one member, so its usage is its owner's).
insert into private.household_ai_usage (household_id, feature, day, used)
select ('de300000-0000-4000-8003-' || lpad(u.n::text, 12, '0'))::uuid, m.feature, m.day, m.used
from demo_usage m
join demo_users u on u.id = m.user_id
where m.feature in ('recipe_import', 'recipe_photo_ai')
on conflict do nothing;

-- Model calls: eight per task over the last 30 days (the table's retention), mostly ok, one each
-- of api_error, invalid_output and timeout, and an error on every other task; then a fallback call
-- for each api_error. Placeholder text in the required text columns.
insert into public.ai_calls (
  id, created_at, task, model, prompt_version, status, instructions, prompt, output, finish_reason,
  input_tokens, output_tokens, cached_input_tokens, reasoning_tokens, duration_ms, error
)
select
  ('de300000-0000-4000-8001-' || lpad((t.i * 100 + k)::text, 12, '0'))::uuid,
  now() - ((t.i * 5 + k * 3) % 29) * interval '1 day' - k * interval '1 hour',
  t.task,
  'google:gemini-3.8-flash',
  'demo',
  s.status,
  'Demo call (seed-admin-demo.sql).',
  'Demo prompt.',
  case when s.status = 'ok' then '{}'::jsonb end,
  case when s.status in ('ok', 'invalid_output') then 'stop' end,
  case when s.status in ('ok', 'invalid_output') then 600 + t.i * 150 + k * 37 end,
  case when s.status in ('ok', 'invalid_output') then 80 + t.i * 20 + k * 11 end,
  case when s.status = 'ok' and k % 2 = 0 then 256 end,
  case when s.status = 'ok' and t.task in ('extractRecipe', 'extractRecipePhoto') then 120 + k * 9 end,
  400 + t.i * 300 + k * 45,
  case when s.status not in ('ok') then 'Demo ' || s.status || '.' end
from (values
  (1, 'categorize'), (2, 'extractRecipe'), (3, 'extractRecipePhoto'),
  (4, 'suggestRecipeTags'), (5, 'matchRecipeSteps'), (6, 'recipePhotoDescription')
) t (i, task)
cross join generate_series(1, 8) k
cross join lateral (
  select case k
    when 5 then 'api_error'
    when 7 then 'invalid_output'
    when 8 then case when t.i % 2 = 0 then 'error' else 'timeout' end
    else 'ok'
  end as status
) s
on conflict do nothing;

insert into public.ai_calls (
  id, created_at, task, model, prompt_version, status, instructions, prompt, output, finish_reason,
  input_tokens, output_tokens, cached_input_tokens, reasoning_tokens, duration_ms, fallback_of
)
select
  ('de300000-0000-4000-8001-' || lpad((c.i * 100 + 9)::text, 12, '0'))::uuid,
  c.created_at + interval '2 seconds', c.task, 'anthropic:claude-haiku-5-5', 'demo', 'ok',
  c.instructions, c.prompt, '{}'::jsonb, 'stop', 700 + c.i * 150, 90 + c.i * 20, null, null,
  900 + c.i * 200, c.id
from (
  select a.*, (substr(a.id::text, 25)::integer / 100) as i
  from public.ai_calls a
  where a.id::text like 'de300000-0000-4000-8001-%' and a.status = 'api_error'
) c
on conflict do nothing;

-- Audit rows: plan changes from the portal (performed by the dev user from seed.sql, whose email
-- shows when that user exists), a rename, and a delete_user from the dashboard (postgres) whose
-- user is gone. They keep the plan ids of their day (plus, basic, none), as real rows from before
-- the household plans migration do (admin_actions.target_plan_id has no foreign key).
insert into admin.admin_actions (
  id, action, target_user_id, target_plan_id, details, note, performed_by, created_at
) values
  ('de300000-0000-4000-8002-000000000001', 'set_user_plan', 'de300000-0000-4000-8000-000000000010',
   'plus', '{"from": null, "to": "plus"}', 'Demo: alpha tester, asked for photo import.',
   '019a4c10-0000-7000-8000-0000000de701', now() - interval '150 days'),
  ('de300000-0000-4000-8002-000000000002', 'set_user_plan', 'de300000-0000-4000-8000-000000000003',
   'unlimited', '{"from": "plus", "to": "unlimited"}', 'Demo: hit the import limit testing a cookbook.',
   '019a4c10-0000-7000-8000-0000000de701', now() - interval '60 days'),
  ('de300000-0000-4000-8002-000000000003', 'set_user_plan', 'de300000-0000-4000-8000-000000000005',
   'none', '{"from": "basic", "to": "none"}', 'Demo: asked to turn the AI features off.',
   '019a4c10-0000-7000-8000-0000000de701', now() - interval '20 days'),
  ('de300000-0000-4000-8002-000000000004', 'rename_plan', null, 'basic',
   '{"before": {"id": "basic", "name": "Standard"}, "after": {"id": "basic", "name": "Basic"}, "users": 2}',
   'Demo: match the pricing page.', '019a4c10-0000-7000-8000-0000000de701', now() - interval '9 days'),
  ('de300000-0000-4000-8002-000000000005', 'delete_user', 'de300000-0000-4000-8000-000000000099',
   null, '{"email": "demo-99@example.com", "display_name": "Gone Demo", "households": []}',
   'Demo: deletion request by email.', 'postgres', now() - interval '3 days')
on conflict do nothing;

commit;
