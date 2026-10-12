-- Email invites (spec 4.7, 5). An invite can name the email it's for: it then shows as pending on
-- the household screen and in the invitee's app when they sign in with that address. The email
-- doesn't lock the link: whoever opens it first can still join with it. Invites can be revoked
-- (by any member) and declined (by the invitee). An invite is open while it isn't used, revoked or
-- declined; expiry is checked when it's read.

alter table public.household_invites
  add column invited_email text
    constraint household_invites_invited_email_check
    check (invited_email = lower(invited_email) and invited_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  add column revoked_at timestamptz,
  add column declined_at timestamptz;

-- One open invite per household and email; create_invite revokes the old one first.
create unique index household_invites_open_email_idx on public.household_invites (household_id, invited_email)
  where invited_email is not null and used_at is null and revoked_at is null and declined_at is null;
create index household_invites_invited_email_idx on public.household_invites (invited_email)
  where invited_email is not null and used_at is null and revoked_at is null and declined_at is null;

-- Adds p_uid to an invite's household, or says they're already in it. Shared by accept_invite and
-- accept_invite_by_id, which find the invite and check who may use it. Raises for an unknown,
-- used, revoked, declined or expired invite.
create function private.accept_household_invite(p_invite_id uuid, p_uid uuid)
returns table (
  household_id   uuid,
  household_name text,
  already_member boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_invite public.household_invites;
  v_name text;
begin
  -- Locked, so two people accepting the same invite at once can't both join.
  select * into v_invite from public.household_invites i where i.id = p_invite_id for update;
  if not found then
    raise exception 'invite not found' using errcode = 'P0002';
  end if;

  select h.name into v_name from public.households h where h.id = v_invite.household_id;

  if exists (
    select 1 from public.household_members hm
    where hm.household_id = v_invite.household_id and hm.user_id = p_uid
  ) then
    return query select v_invite.household_id, v_name, true;
    return;
  end if;
  if v_invite.used_at is not null or v_invite.revoked_at is not null or v_invite.declined_at is not null then
    raise exception 'invite already used' using errcode = '22023';
  end if;
  if v_invite.expires_at <= now() then
    raise exception 'invite expired' using errcode = '22023';
  end if;

  insert into public.household_members (household_id, user_id, role, position)
  select v_invite.household_id, p_uid, 'member', coalesce(max(hm.position), 0) + 1
  from public.household_members hm
  where hm.user_id = p_uid;

  update public.household_invites i set used_by = p_uid, used_at = now() where i.id = v_invite.id;

  return query select v_invite.household_id, v_name, false;
end;
$$;

-- The caller's open invite with this id, if it was sent to the caller's email; raises 'invite not
-- found' otherwise, the same as for an unknown id, so ids can't be probed.
create function private.my_invite(p_invite_id uuid)
returns public.household_invites
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := lower((select auth.email()));
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

-- Creates an invite to a household the caller belongs to and returns its token (the only time the
-- token exists in clear). With an email, the invite is for that address: it's stored trimmed and
-- lower-cased, an email that's already a member's raises, and any open invite to the same
-- household and email is revoked first (only the token's hash is stored, so "Send again" needs a
-- new invite). Raises for non-members, including a household not registered yet.
drop function public.create_invite(uuid);
create function public.create_invite(p_household_id uuid, p_email text default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_email text := lower(btrim(p_email));
  v_token text;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.household_members hm
    where hm.household_id = p_household_id and hm.user_id = v_uid
  ) then
    raise exception 'not a member of household %', p_household_id using errcode = '42501';
  end if;

  if v_email is not null then
    if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
      raise exception 'invalid email' using errcode = '22023';
    end if;
    if exists (
      select 1 from public.household_members hm
      join auth.users u on u.id = hm.user_id
      where hm.household_id = p_household_id and lower(u.email) = v_email
    ) then
      raise exception 'already a member' using errcode = '23505';
    end if;
    update public.household_invites i set revoked_at = now()
    where i.household_id = p_household_id and i.invited_email = v_email
      and i.used_at is null and i.revoked_at is null and i.declined_at is null;
  end if;

  -- 24 random bytes, URL-safe base64 without padding: 32 characters.
  v_token := translate(encode(extensions.gen_random_bytes(24), 'base64'), '+/', '-_');

  insert into public.household_invites (household_id, token_hash, created_by, expires_at, invited_email)
  values (p_household_id, private.invite_token_hash(v_token), v_uid, now() + interval '7 days', v_email);

  return v_token;
end;
$$;

-- What the join screen shows before accepting. Revoked and declined invites read as 'used'.
create or replace function public.preview_invite(p_token text)
returns table (
  household_id   uuid,
  household_name text,
  invited_by     text,
  status         text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_invite public.household_invites;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  select * into v_invite from public.household_invites i
  where i.token_hash = private.invite_token_hash(coalesce(p_token, ''));
  if not found then
    raise exception 'invite not found' using errcode = 'P0002';
  end if;

  return query
    select h.id, h.name, p.display_name,
      case
        when exists (
          select 1 from public.household_members hm
          where hm.household_id = h.id and hm.user_id = v_uid
        ) then 'member'
        when v_invite.used_at is not null or v_invite.revoked_at is not null
          or v_invite.declined_at is not null then 'used'
        when v_invite.expires_at <= now() then 'expired'
        else 'valid'
      end
    from public.households h
    left join public.profiles p on p.user_id = v_invite.created_by
    where h.id = v_invite.household_id;
end;
$$;

-- Accepts an invite by its link. Anyone with the link can use it, whatever email it was sent to.
create or replace function public.accept_invite(p_token text)
returns table (
  household_id   uuid,
  household_name text,
  already_member boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_invite_id uuid;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  select i.id into v_invite_id from public.household_invites i
  where i.token_hash = private.invite_token_hash(coalesce(p_token, ''));
  if not found then
    raise exception 'invite not found' using errcode = 'P0002';
  end if;
  return query select * from private.accept_household_invite(v_invite_id, v_uid);
end;
$$;

-- A household's open, unexpired invites, newest first, for its members. Link-only invites have a
-- null email.
create function public.list_household_invites(p_household_id uuid)
returns table (
  id            uuid,
  invited_email text,
  invited_by    text,
  created_at    timestamptz,
  expires_at    timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.household_members hm
    where hm.household_id = p_household_id and hm.user_id = v_uid
  ) then
    raise exception 'not a member of household %', p_household_id using errcode = '42501';
  end if;

  return query
    select i.id, i.invited_email, p.display_name, i.created_at, i.expires_at
    from public.household_invites i
    left join public.profiles p on p.user_id = i.created_by
    where i.household_id = p_household_id
      and i.used_at is null and i.revoked_at is null and i.declined_at is null
      and i.expires_at > now()
    order by i.created_at desc, i.id;
end;
$$;

-- Cancels an invite; any member of its household can. Its link stops working. Revoking an invite
-- that's already used, revoked or declined changes nothing.
create function public.revoke_invite(p_invite_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_household_id uuid;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  select i.household_id into v_household_id from public.household_invites i where i.id = p_invite_id;
  if not found then
    raise exception 'invite not found' using errcode = 'P0002';
  end if;
  if not exists (
    select 1 from public.household_members hm
    where hm.household_id = v_household_id and hm.user_id = v_uid
  ) then
    raise exception 'not a member of household %', v_household_id using errcode = '42501';
  end if;

  update public.household_invites i set revoked_at = now()
  where i.id = p_invite_id and i.used_at is null and i.revoked_at is null and i.declined_at is null;
end;
$$;

-- Open, unexpired invites sent to the caller's email, for households they aren't in yet, newest
-- first: what the Lists home shows as cards.
create function public.my_invites()
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
  v_email text := lower((select auth.email()));
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  return query
    select i.id, h.id, h.name, p.display_name,
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

-- Accepts an invite sent to the caller's email, from its card in the app. Same effect and result
-- as accept_invite.
create function public.accept_invite_by_id(p_invite_id uuid)
returns table (
  household_id   uuid,
  household_name text,
  already_member boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_invite public.household_invites := private.my_invite(p_invite_id);
begin
  return query select * from private.accept_household_invite(v_invite.id, (select auth.uid()));
end;
$$;

-- Declines an invite sent to the caller's email. Its link stops working. Raises for an invite
-- that's already used, revoked or declined.
create function public.decline_invite(p_invite_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_invite public.household_invites := private.my_invite(p_invite_id);
begin
  if v_invite.used_at is not null or v_invite.revoked_at is not null or v_invite.declined_at is not null then
    raise exception 'invite already used' using errcode = '22023';
  end if;
  update public.household_invites i set declined_at = now() where i.id = v_invite.id;
end;
$$;

revoke all on function private.accept_household_invite(uuid, uuid) from public, anon, authenticated;
revoke all on function private.my_invite(uuid) from public, anon, authenticated;
revoke all on function public.create_invite(uuid, text) from public, anon, service_role;
revoke all on function public.list_household_invites(uuid) from public, anon, service_role;
revoke all on function public.revoke_invite(uuid) from public, anon, service_role;
revoke all on function public.my_invites() from public, anon, service_role;
revoke all on function public.accept_invite_by_id(uuid) from public, anon, service_role;
revoke all on function public.decline_invite(uuid) from public, anon, service_role;
grant execute on function public.create_invite(uuid, text) to authenticated;
grant execute on function public.list_household_invites(uuid) to authenticated;
grant execute on function public.revoke_invite(uuid) to authenticated;
grant execute on function public.my_invites() to authenticated;
grant execute on function public.accept_invite_by_id(uuid) to authenticated;
grant execute on function public.decline_invite(uuid) to authenticated;
