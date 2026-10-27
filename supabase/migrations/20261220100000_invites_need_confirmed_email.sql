-- Email invites match only a confirmed email. my_invites and private.my_invite (which
-- accept_invite_by_id and decline_invite go through) matched on auth.email(), so anyone who
-- password-signed-up with someone else's address, unconfirmed, could see, accept or decline that
-- person's invites. Both now take the caller's email from auth.users, and only once
-- email_confirmed_at is set. auth.users.email only changes when a new address is confirmed, so a
-- pending email change can't claim the new address's invites either. OTP and Google sign-ins set
-- email_confirmed_at, so their users are unaffected.

-- The caller's email, trimmed and lower-cased, or null when it isn't confirmed (or there's no
-- caller).
create function private.my_confirmed_email()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select lower(trim(u.email)) from auth.users u
  where u.id = (select auth.uid()) and u.email_confirmed_at is not null;
$$;

revoke all on function private.my_confirmed_email() from public, anon, authenticated, service_role;

-- The caller's open invite with this id, if it was sent to the caller's confirmed email; raises
-- 'invite not found' otherwise, the same as for an unknown id, so ids can't be probed.
create or replace function private.my_invite(p_invite_id uuid)
returns public.household_invites
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := private.my_confirmed_email();
  v_invite public.household_invites;
begin
  if (select auth.uid()) is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  select * into v_invite from public.household_invites i
  where i.id = p_invite_id and i.invited_email = v_email
  for update;
  if not found then
    raise exception 'invite not found' using errcode = 'P0002';
  end if;
  return v_invite;
end;
$$;

create or replace function public.my_invites()
returns table (
  id             uuid,
  household_id   uuid,
  household_name text,
  invited_by     text,
  member_count   int
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_email text := private.my_confirmed_email();
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  return query
    select i.id, h.id, h.name, private.full_name(p.first_name, p.last_name),
      (select count(*)::int from public.household_members hm where hm.household_id = h.id)
    from public.household_invites i
    join public.households h on h.id = i.household_id
    left join public.profiles p on p.user_id = i.created_by
    where i.invited_email = v_email
      and i.used_at is null and i.revoked_at is null and i.declined_at is null
      and i.expires_at > now()
      and not exists (
        select 1 from public.household_members hm
        where hm.household_id = i.household_id and hm.user_id = v_uid
      )
    order by i.created_at desc, i.id;
end;
$$;
