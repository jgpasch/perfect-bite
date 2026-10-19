-- Plans become none, basic, plus and unlimited, with plus the default (spec 4.12, 5). Plan ids are
-- text primary keys and `user_plans.plan_id` references them without `on update cascade`, so the
-- old plans aren't renamed in place: the new ones are inserted, assigned users move across, and
-- base and standard are deleted (their `plan_features` cascade). Plus keeps its id, name and
-- features. Runs on hosted, where real users have rows.

insert into public.plans (id, name, is_default) values
  ('none', 'None', false),
  ('basic', 'Basic', false),
  ('unlimited', 'Unlimited', false);
insert into public.plan_features (plan_id, feature) values
  ('basic', 'categorize'),
  ('basic', 'step_ingredients'),
  ('unlimited', 'categorize'),
  ('unlimited', 'recipe_import'),
  ('unlimited', 'recipe_import_photo'),
  ('unlimited', 'recipe_photo_ai'),
  ('unlimited', 'recipe_tags'),
  ('unlimited', 'step_ingredients');

-- Editing plan_id stamps assigned_at (the user_plans trigger); these are still new assignments.
update public.user_plans set plan_id = 'none' where plan_id = 'base';
update public.user_plans set plan_id = 'basic' where plan_id = 'standard';

-- The app owner goes on unlimited, as the plans migration put them on plus. Locally this does
-- nothing: supabase/seed.sql makes the dev user after migrations.
insert into public.user_plans (user_id, plan_id)
select id, 'unlimited' from auth.users where email = 'jgpasch@gmail.com'
on conflict (user_id) do update set plan_id = 'unlimited';

-- The partial unique index allows one default, so clear standard's before setting plus's.
update public.plans set is_default = false where id = 'standard';
update public.plans set is_default = true where id = 'plus';

delete from public.plans where id in ('base', 'standard');
