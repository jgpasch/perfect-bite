-- Push notifications (spec 4.13, 5): each signed-in device's Expo push token, and each user's
-- notification settings. Both are per user, read and written online, and never go through the
-- outbox or sync. The worker that sends pushes (send-notifications, spec 8) asks
-- private.push_recipients who should hear about an event.

-- ---------------------------------------------------------------------------
-- Push tokens: one row per device. No direct access for clients: the app registers and
-- unregisters its token through the two functions below.
-- ---------------------------------------------------------------------------

create table public.push_tokens (
  token      text primary key,                                   -- ExponentPushToken[…]
  user_id    uuid not null references auth.users on delete cascade,
  platform   text not null check (platform in ('ios', 'android')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index push_tokens_user_id_idx on public.push_tokens (user_id);

create trigger push_tokens_set_updated_at
  before update on public.push_tokens
  for each row execute function private.set_updated_at();

alter table public.push_tokens enable row level security;
revoke all on table public.push_tokens from anon, authenticated;

-- Registers the caller's device. A token already held by someone else moves to the caller: the
-- device changed hands on sign-in. Re-registering the same token bumps updated_at, which the
-- worker can use to spot stale tokens.
create function public.register_push_token(p_token text, p_platform text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if p_token is null or length(p_token) > 200
     or p_token !~ '^(Exponent|Expo)PushToken\[[A-Za-z0-9_-]+\]$' then
    raise exception 'invalid token' using errcode = '22023';
  end if;
  if p_platform is null or p_platform not in ('ios', 'android') then
    raise exception 'invalid platform' using errcode = '22023';
  end if;

  insert into public.push_tokens (token, user_id, platform)
  values (p_token, v_user_id, p_platform)
  on conflict (token) do update
    set user_id = excluded.user_id, platform = excluded.platform;
end;
$$;

-- Deletes the caller's row for the token (on sign-out). Someone else's token, or an unknown
-- one, is left alone without an error.
create function public.unregister_push_token(p_token text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;

  delete from public.push_tokens t where t.token = p_token and t.user_id = v_user_id;
end;
$$;

revoke all on function public.register_push_token(text, text) from public, anon, service_role;
revoke all on function public.unregister_push_token(text) from public, anon, service_role;
grant execute on function public.register_push_token(text, text) to authenticated;
grant execute on function public.unregister_push_token(text) to authenticated;

-- ---------------------------------------------------------------------------
-- Notification settings: one row per user, written directly by the app (upsert). A missing
-- row means the defaults: both kinds on, no quiet hours, UTC.
-- ---------------------------------------------------------------------------

create table public.notification_settings (
  user_id           uuid primary key references auth.users on delete cascade,
  items_added       boolean not null default true,
  shopping          boolean not null default true,
  quiet_hours_start time,                                         -- both null = off
  quiet_hours_end   time,                                         -- earlier than the start = wraps past midnight
  time_zone         text not null default 'UTC',                  -- IANA name; quiet hours are judged in it
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  check ((quiet_hours_start is null) = (quiet_hours_end is null)),
  check (quiet_hours_start is distinct from quiet_hours_end or quiet_hours_start is null)
);

create trigger notification_settings_set_updated_at
  before update on public.notification_settings
  for each row execute function private.set_updated_at();

-- time_zone must be a name Postgres knows, so `at time zone` never fails in the worker.
create function private.check_notification_time_zone()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not exists (select 1 from pg_catalog.pg_timezone_names z where z.name = new.time_zone) then
    raise exception 'invalid time zone' using errcode = '22023';
  end if;
  return new;
end;
$$;

revoke all on function private.check_notification_time_zone() from public, anon, authenticated;

create trigger notification_settings_check_time_zone
  before insert or update of time_zone on public.notification_settings
  for each row execute function private.check_notification_time_zone();

alter table public.notification_settings enable row level security;
revoke all on table public.notification_settings from anon, authenticated;
grant select, insert, update on public.notification_settings to authenticated;

create policy notification_settings_select_own on public.notification_settings
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy notification_settings_insert_own on public.notification_settings
  for insert to authenticated
  with check (user_id = (select auth.uid()));

create policy notification_settings_update_own on public.notification_settings
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- Who hears about an event (for the worker): the household's current members other than the
-- actor, one row per push token, among those who have the event's kind turned on and aren't in
-- their quiet hours at p_at, judged in their own time zone. Members with no token get no rows.
-- Kinds: 'items_added', 'shopping'.
-- ---------------------------------------------------------------------------

create function private.push_recipients(p_household_id uuid, p_actor uuid, p_kind text, p_at timestamptz)
returns table (user_id uuid, token text, platform text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_kind is null or p_kind not in ('items_added', 'shopping') then
    raise exception 'invalid kind' using errcode = '22023';
  end if;

  return query
  select m.user_id, t.token, t.platform
  from public.household_members m
  join public.push_tokens t on t.user_id = m.user_id
  left join public.notification_settings s on s.user_id = m.user_id
  cross join lateral (
    select (p_at at time zone coalesce(s.time_zone, 'UTC'))::time as local_time
  ) l
  where m.household_id = p_household_id
    and m.user_id is distinct from p_actor
    and case p_kind
          when 'items_added' then coalesce(s.items_added, true)
          when 'shopping' then coalesce(s.shopping, true)
        end
    and not coalesce(
      case
        when s.quiet_hours_start < s.quiet_hours_end
          then l.local_time >= s.quiet_hours_start and l.local_time < s.quiet_hours_end
        else l.local_time >= s.quiet_hours_start or l.local_time < s.quiet_hours_end
      end,
      false)
  order by m.user_id, t.token;
end;
$$;

revoke all on function private.push_recipients(uuid, uuid, text, timestamptz)
  from public, anon, authenticated;
grant usage on schema private to service_role;
grant execute on function private.push_recipients(uuid, uuid, text, timestamptz) to service_role;
