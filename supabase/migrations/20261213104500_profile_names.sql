-- First and last name on profiles (spec 5, 4.7, 4.13). display_name stays until the app and the
-- admin portal have moved off it.

-- ---------------------------------------------------------------------------
-- Name helpers
-- ---------------------------------------------------------------------------

-- A name part as stored: trimmed, runs of whitespace made one space, cut to 50 characters; null
-- when nothing is left. The cut keeps a long Google name or email from failing sign-up on the checks.
create function private.clean_name(p_name text)
returns text
language sql
immutable
set search_path = ''
as $$
  select nullif(pg_catalog.btrim(pg_catalog.left(
    pg_catalog.btrim(pg_catalog.regexp_replace(coalesce(p_name, ''), '[[:space:]]+', ' ', 'g')), 50)), '');
$$;

-- "Alex Rivera Diaz" -> ('Alex', 'Rivera Diaz'); "Alex" -> ('Alex', null); blank -> (null, null).
create function private.split_name(p_name text, out first_name text, out last_name text)
language sql
immutable
set search_path = ''
as $$
  select private.clean_name(pg_catalog.split_part(n, ' ', 1)),
         private.clean_name(pg_catalog.substr(n, pg_catalog.length(pg_catalog.split_part(n, ' ', 1)) + 1))
  from (select pg_catalog.btrim(pg_catalog.regexp_replace(coalesce(p_name, ''), '[[:space:]]+', ' ', 'g')) as n) s;
$$;

-- The full name: the first name, plus " " and the last name when there is one.
create function private.full_name(p_first_name text, p_last_name text)
returns text
language sql
immutable
set search_path = ''
as $$
  select p_first_name || coalesce(' ' || p_last_name, '');
$$;

revoke all on function private.clean_name(text) from public, anon, authenticated;
revoke all on function private.split_name(text) from public, anon, authenticated;
revoke all on function private.full_name(text, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Columns, backfilled from display_name: the first word, then the rest.
-- ---------------------------------------------------------------------------

alter table public.profiles
  add column first_name text,
  add column last_name  text;

update public.profiles p
set first_name = coalesce((private.split_name(p.display_name)).first_name, 'Someone'),
    last_name  = (private.split_name(p.display_name)).last_name;

alter table public.profiles
  alter column first_name set not null,
  add constraint profiles_first_name_check check (
    char_length(first_name) between 1 and 50 and first_name !~ '^[[:space:]]|[[:space:]]$'),
  add constraint profiles_last_name_check check (
    char_length(last_name) between 1 and 50 and last_name !~ '^[[:space:]]|[[:space:]]$');

grant update (first_name, last_name) on public.profiles to authenticated;

-- ---------------------------------------------------------------------------
-- Sign-up: given_name / family_name when there's a given name, else full_name, then name, split
-- on the first space, else the email's local part, else "Someone". display_name is filled as before.
-- ---------------------------------------------------------------------------

create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_meta jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  v_first text := private.clean_name(v_meta ->> 'given_name');
  v_last text;
begin
  if v_first is not null then
    v_last := private.clean_name(v_meta ->> 'family_name');
  else
    select s.first_name, s.last_name into v_first, v_last from private.split_name(v_meta ->> 'full_name') s;
    if v_first is null then
      select s.first_name, s.last_name into v_first, v_last from private.split_name(v_meta ->> 'name') s;
    end if;
    if v_first is null then
      v_first := private.clean_name(pg_catalog.split_part(coalesce(new.email, ''), '@', 1));
    end if;
  end if;

  insert into public.profiles (user_id, display_name, first_name, last_name, avatar_url)
  values (
    new.id,
    coalesce(
      nullif(trim(v_meta ->> 'full_name'), ''),
      nullif(trim(v_meta ->> 'name'), ''),
      split_part(coalesce(new.email, ''), '@', 1),
      'Someone'
    ),
    coalesce(v_first, 'Someone'),
    v_last,
    v_meta ->> 'avatar_url'
  );
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Pushes: the actor's short name, as the app builds it (4.7): the first name, plus the last name's
-- initial and "." only when another current member of the list's household has the same first name
-- (case-insensitive) and the actor has a last name. Null when the profile is gone.
-- Otherwise as in 20261105120000_send_notifications.sql.
-- ---------------------------------------------------------------------------

create or replace function public.notification_group(p_kind text, p_list_id uuid, p_actor uuid, p_ids uuid[])
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_list_name text;
  v_household_id uuid;
  v_first_name text;
  v_last_name text;
  v_actor_name text;
  v_items jsonb;
  v_last_sent_at timestamptz;
begin
  if p_kind is null or p_kind not in ('items_added', 'shopping') then
    raise exception 'invalid kind' using errcode = '22023';
  end if;

  select l.name into v_list_name from public.lists l where l.id = p_list_id and l.deleted_at is null;
  select l.household_id into v_household_id from public.lists l where l.id = p_list_id;

  select p.first_name, p.last_name into v_first_name, v_last_name
  from public.profiles p where p.user_id = p_actor;
  v_actor_name := v_first_name;
  if v_last_name is not null and exists (
    select 1
    from public.household_members hm
    join public.profiles op on op.user_id = hm.user_id
    where hm.household_id = v_household_id
      and hm.user_id <> p_actor
      and lower(op.first_name) = lower(v_first_name)
  ) then
    v_actor_name := v_first_name || ' ' || upper(left(v_last_name, 1)) || '.';
  end if;

  if p_kind = 'items_added' then
    select coalesce(jsonb_agg(jsonb_build_object(
             'id', i.id, 'name', i.display_name, 'recipe_id', c.recipe_id, 'recipe_name', r.name)
             order by c.created_at, c.id), '[]'::jsonb)
    into v_items
    from public.list_item_contributions c
    join public.list_items i on i.id = c.list_item_id
    left join public.recipes r on r.id = c.recipe_id
    where c.id = any(p_ids)
      and c.deleted_at is null
      and i.deleted_at is null
      and i.list_id = p_list_id;
  else
    select coalesce(jsonb_agg(jsonb_build_object(
             'id', i.id, 'name', i.display_name, 'recipe_id', null, 'recipe_name', null)
             order by i.checked_at, i.id), '[]'::jsonb)
    into v_items
    from public.list_items i
    where i.id = any(p_ids)
      and i.deleted_at is null
      and i.checked_at is not null
      and i.checked_by = p_actor
      and i.list_id = p_list_id;
  end if;

  select max(s.sent_at) into v_last_sent_at
  from private.push_sent s
  where s.actor = p_actor and s.list_id = p_list_id and s.kind = p_kind;

  return jsonb_build_object(
    'list_name', v_list_name,
    'actor_name', v_actor_name,
    'items', v_items,
    'last_sent_at', v_last_sent_at);
end;
$$;

-- ---------------------------------------------------------------------------
-- Invites: the inviter's full name, under the same column names. Otherwise as in
-- 20261011200000_email_invites.sql. accept_invite / accept_invite_by_id don't return the inviter.
-- ---------------------------------------------------------------------------

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
    select h.id, h.name, private.full_name(p.first_name, p.last_name),
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

create or replace function public.list_household_invites(p_household_id uuid)
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
    select i.id, i.invited_email, private.full_name(p.first_name, p.last_name), i.created_at, i.expires_at
    from public.household_invites i
    left join public.profiles p on p.user_id = i.created_by
    where i.household_id = p_household_id
      and i.used_at is null and i.revoked_at is null and i.declined_at is null
      and i.expires_at > now()
    order by i.created_at desc, i.id;
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
  v_email text := lower((select auth.email()));
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
