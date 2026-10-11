-- Household invites (spec 4.7, 5). Any member can invite; an invite is a link with a random
-- token, single use, valid for 7 days. Only the token's SHA-256 is stored, so the table can't be
-- used to join. No direct access: `create_invite`, `preview_invite` and `accept_invite` only.

create table public.household_invites (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households on delete cascade,
  token_hash   text not null unique,
  created_by   uuid references auth.users on delete set null,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  used_by      uuid references auth.users on delete set null,
  used_at      timestamptz
);
create index household_invites_household_id_idx on public.household_invites (household_id);

alter table public.household_invites enable row level security;
revoke all on table public.household_invites from anon, authenticated;

create function private.invite_token_hash(p_token text)
returns text
language sql
immutable
set search_path = ''
as $$
  select encode(extensions.digest(p_token, 'sha256'), 'hex');
$$;

-- Creates an invite to a household the caller belongs to and returns its token (the only time
-- the token exists in clear). Raises for non-members, including a household not registered yet.
create function public.create_invite(p_household_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
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

  -- 24 random bytes, URL-safe base64 without padding: 32 characters.
  v_token := translate(encode(extensions.gen_random_bytes(24), 'base64'), '+/', '-_');

  insert into public.household_invites (household_id, token_hash, created_by, expires_at)
  values (p_household_id, private.invite_token_hash(v_token), v_uid, now() + interval '7 days');

  return v_token;
end;
$$;

-- What the join screen shows before accepting: the household's name, who invited, and the
-- invite's status for the caller: 'valid', 'member' (already in it), 'used' or 'expired'.
-- An unknown token raises, the same as in accept_invite.
create function public.preview_invite(p_token text)
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
        when v_invite.used_at is not null then 'used'
        when v_invite.expires_at <= now() then 'expired'
        else 'valid'
      end
    from public.households h
    left join public.profiles p on p.user_id = v_invite.created_by
    where h.id = v_invite.household_id;
end;
$$;

-- Accepts an invite: adds the caller as a member, last in their household order, and uses the
-- invite up. A caller who is already a member gets `already_member` and the invite stays unused.
-- Raises for an unknown, used or expired invite.
create function public.accept_invite(p_token text)
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
  v_invite public.household_invites;
  v_name text;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  -- Locked, so two people accepting the same link at once can't both join.
  select * into v_invite from public.household_invites i
  where i.token_hash = private.invite_token_hash(coalesce(p_token, ''))
  for update;
  if not found then
    raise exception 'invite not found' using errcode = 'P0002';
  end if;

  select h.name into v_name from public.households h where h.id = v_invite.household_id;

  if exists (
    select 1 from public.household_members hm
    where hm.household_id = v_invite.household_id and hm.user_id = v_uid
  ) then
    return query select v_invite.household_id, v_name, true;
    return;
  end if;
  if v_invite.used_at is not null then
    raise exception 'invite already used' using errcode = '22023';
  end if;
  if v_invite.expires_at <= now() then
    raise exception 'invite expired' using errcode = '22023';
  end if;

  insert into public.household_members (household_id, user_id, role, position)
  select v_invite.household_id, v_uid, 'member', coalesce(max(hm.position), 0) + 1
  from public.household_members hm
  where hm.user_id = v_uid;

  update public.household_invites i set used_by = v_uid, used_at = now() where i.id = v_invite.id;

  return query select v_invite.household_id, v_name, false;
end;
$$;

revoke all on function private.invite_token_hash(text) from public, anon, authenticated;
revoke all on function public.create_invite(uuid) from public, anon, service_role;
revoke all on function public.preview_invite(text) from public, anon, service_role;
revoke all on function public.accept_invite(text) from public, anon, service_role;
grant execute on function public.create_invite(uuid) to authenticated;
grant execute on function public.preview_invite(text) to authenticated;
grant execute on function public.accept_invite(text) to authenticated;
