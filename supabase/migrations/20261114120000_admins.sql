-- Admins (spec 4.12, 5): who may use the admin portal (admin/). A table, not a role in the JWT, so
-- removing an admin takes effect on their next call. Admins are added and removed in the Table
-- Editor (docs/admin.md). Each portal function is a `public.admin_*` function (security definer)
-- whose first step is private.require_admin(); the login screen is only UX.
--
-- The portal writes admin.admin_actions like the dashboard snippets do, with performed_by set to
-- the admin's user id (the column's default, session_user, is `authenticator` for an API call).

create table private.admins (
  user_id  uuid primary key references auth.users on delete cascade,
  added_at timestamptz not null default now()
);

alter table private.admins enable row level security;
revoke all on table private.admins from public, anon, authenticated, service_role;

-- Whether the caller is an admin. False with no user. The portal calls it to decide what to show.
create function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from private.admins a where a.user_id = auth.uid());
$$;

revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

-- The first step of every portal function: raises `not authorized` (42501) unless the caller is an
-- admin. The portal functions are security definer, so only they need to execute it.
create function private.require_admin()
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
end;
$$;

revoke all on function private.require_admin() from public, anon, authenticated, service_role;

-- Which plan a portal change moved; text with no foreign key, so a deleted plan keeps its history.
alter table admin.admin_actions add column target_plan_id text;

-- Make the app owner an admin when this reaches hosted. Locally this does nothing:
-- supabase/seed.sql makes the dev user after migrations, and makes them an admin itself.
insert into private.admins (user_id)
select id from auth.users where email = 'jgpasch@gmail.com'
on conflict (user_id) do nothing;
