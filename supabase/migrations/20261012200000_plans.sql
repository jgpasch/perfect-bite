-- Plans and features (spec 4.12, 5). A feature is a text key; a plan is a named set of features;
-- each user is on one plan: their `user_plans` row, else the default plan. Plans are per user
-- today; `has_feature` and `my_features` take a household so they can become per household by
-- changing only the resolution below.
--
-- No client access to the three tables (RLS on, no policies, privileges revoked). A user's plan
-- is changed in the Table Editor by adding, editing or deleting their `user_plans` row
-- (docs/admin.md); there's no admin function for it.

create table public.plans (
  id         text primary key,
  name       text not null,
  is_default boolean not null default false
);

-- At most one default plan. If none is, a user with no assignment has no features.
create unique index plans_one_default_idx on public.plans (is_default) where is_default;

create table public.plan_features (
  plan_id text references public.plans on delete cascade,
  feature text not null check (feature in ('categorize', 'recipe_import', 'recipe_import_photo')),
  primary key (plan_id, feature)
);

create table public.user_plans (
  user_id     uuid primary key references auth.users on delete cascade,
  plan_id     text not null references public.plans,
  assigned_at timestamptz not null default now()
);
create index user_plans_plan_id_idx on public.user_plans (plan_id);

alter table public.plans enable row level security;
alter table public.plan_features enable row level security;
alter table public.user_plans enable row level security;
revoke all on table public.plans, public.plan_features, public.user_plans from anon, authenticated;

-- Editing a row in the Table Editor counts as a new assignment.
create function private.set_assigned_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.assigned_at := now();
  return new;
end;
$$;

create trigger user_plans_set_assigned_at
  before update on public.user_plans
  for each row execute function private.set_assigned_at();

-- Seed. `recipe_import` categorizes in the same request, so a plan with it also has `categorize`.
insert into public.plans (id, name, is_default) values
  ('base', 'Base', false),
  ('standard', 'Standard', true),
  ('plus', 'Plus', false);
insert into public.plan_features (plan_id, feature) values
  ('standard', 'categorize'),
  ('plus', 'categorize'),
  ('plus', 'recipe_import'),
  ('plus', 'recipe_import_photo');

-- Whether a user's plan includes a feature: their assigned plan, else the default plan. In
-- `public` so Edge Functions can call it with `admin.rpc` (like `check_categorize_limit`);
-- execute is granted to service_role only.
create function public.has_feature(p_user_id uuid, p_feature text, p_household_id uuid default null)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  -- p_household_id is accepted and ignored: plans are per user. Per-household plans would
  -- resolve the plan from the household here (e.g. the best plan among its members, or a
  -- household_plans row) instead of from the user alone.
  select exists (
    select 1
    from public.plan_features f
    where f.feature = p_feature
      and f.plan_id = coalesce(
        (select up.plan_id from public.user_plans up where up.user_id = p_user_id),
        (select p.id from public.plans p where p.is_default)
      )
  );
$$;

revoke all on function public.has_feature(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.has_feature(uuid, text, uuid) to service_role;

-- The caller's features, sorted, by the same rule as `has_feature`. `security definer` because
-- the plan tables have no client policies: run as the caller it would read no rows.
create function public.my_features(p_household_id uuid default null)
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  -- p_household_id is ignored for now, as in has_feature.
  select array(
    select f.feature
    from public.plan_features f
    where f.plan_id = coalesce(
      (select up.plan_id from public.user_plans up where up.user_id = auth.uid()),
      (select p.id from public.plans p where p.is_default)
    )
    order by f.feature collate "C"
  );
$$;

revoke all on function public.my_features(uuid) from public, anon;
grant execute on function public.my_features(uuid) to authenticated;

-- Keep the app owner on plus when this reaches hosted, so they keep recipe import. Locally this
-- does nothing: supabase/seed.sql makes the dev user after migrations.
insert into public.user_plans (user_id, plan_id)
select id, 'plus' from auth.users where email = 'jgpasch@gmail.com'
on conflict (user_id) do update set plan_id = 'plus';
