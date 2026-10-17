-- The send-notifications worker (spec 4.13, 8.5): what it needs from the database, and the cron
-- job that runs it every minute.
--
-- pgmq and private aren't exposed through the Data API, so the worker reaches the queue, the
-- recipients and its own tables through the public functions below, which only service_role can
-- execute (like claim_recipe_photo_deletions).
--
-- Running it locally: pg_net calls the function from inside the database container, so the Vault
-- secrets point at the host's functions URL on port 55321 (served by `supabase functions serve`).
-- After `supabase db reset`, in the SQL editor (http://127.0.0.1:55323) or psql:
--   select vault.create_secret('http://host.docker.internal:55321', 'project_url');
--   select vault.create_secret('<SECRET_KEY from `supabase status`>', 'notifications_worker_key');
-- Hosted: project_url is https://<ref>.supabase.co and notifications_worker_key a secret API key
-- (Project Settings → API Keys), which the function checks as apikey. Without the secrets the job
-- does nothing.

-- ---------------------------------------------------------------------------
-- The queue
-- ---------------------------------------------------------------------------

-- Reads up to p_qty events and hides them for p_vt seconds, so an overlapping run can't take them.
create function public.read_household_events(p_qty integer, p_vt integer)
returns table (msg_id bigint, message jsonb)
language sql
security definer
set search_path = ''
as $$
  select r.msg_id, r.message from pgmq.read('household_events', p_vt, p_qty) r;
$$;

-- Events that were sent, or dropped as stale or empty.
create function public.archive_household_events(p_msg_ids bigint[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(cardinality(p_msg_ids), 0) > 0 then
    perform pgmq.archive('household_events', p_msg_ids);
  end if;
end;
$$;

-- Events of groups that aren't ready yet: visible again for the next run, so a group's events are
-- read together rather than alternating between runs.
create function public.release_household_events(p_msg_ids bigint[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id bigint;
begin
  foreach v_id in array coalesce(p_msg_ids, '{}') loop
    perform pgmq.set_vt('household_events', v_id, 0);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- What's been sent: the shopping 2-hour window, and a log. Rows older than 7 days are deleted
-- daily.
-- ---------------------------------------------------------------------------

create table private.push_sent (
  id           bigint generated always as identity primary key,
  household_id uuid not null,
  actor        uuid not null,
  list_id      uuid not null,
  kind         text not null check (kind in ('items_added', 'shopping')),
  sent_at      timestamptz not null default now()
);
create index push_sent_actor_list_idx on private.push_sent (actor, list_id, kind, sent_at);
create index push_sent_sent_at_idx on private.push_sent (sent_at);

create function public.record_push_sent(p_household_id uuid, p_actor uuid, p_list_id uuid, p_kind text)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into private.push_sent (household_id, actor, list_id, kind)
  values (p_household_id, p_actor, p_list_id, p_kind);
$$;

-- ---------------------------------------------------------------------------
-- A group re-read at send time: the list's name, the actor's first name, the rows still live, and
-- when this (actor, list, kind) last got a push.
--   items_added, p_ids = contribution ids: those not undone, on items not deleted, still on the list.
--   shopping, p_ids = list_item ids: those still checked by the actor and not deleted.
-- list_name is null when the list is deleted; actor_name when the profile is gone or blank.
-- ---------------------------------------------------------------------------

create function public.notification_group(p_kind text, p_list_id uuid, p_actor uuid, p_ids uuid[])
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_list_name text;
  v_actor_name text;
  v_items jsonb;
  v_last_sent_at timestamptz;
begin
  if p_kind is null or p_kind not in ('items_added', 'shopping') then
    raise exception 'invalid kind' using errcode = '22023';
  end if;

  select l.name into v_list_name from public.lists l where l.id = p_list_id and l.deleted_at is null;
  select (pg_catalog.regexp_match(p.display_name, '[^[:space:]]+'))[1] into v_actor_name
  from public.profiles p where p.user_id = p_actor;

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

-- private.push_recipients (20261103120000_push_notifications.sql), callable over the Data API.
create function public.notification_recipients(p_household_id uuid, p_actor uuid, p_kind text, p_at timestamptz)
returns table (user_id uuid, token text, platform text)
language sql
stable
security definer
set search_path = ''
as $$
  select r.user_id, r.token, r.platform from private.push_recipients(p_household_id, p_actor, p_kind, p_at) r;
$$;

-- Tokens Expo says are no longer registered (DeviceNotRegistered).
create function public.delete_push_tokens(p_tokens text[])
returns void
language sql
security definer
set search_path = ''
as $$
  delete from public.push_tokens t where t.token = any(p_tokens);
$$;

-- ---------------------------------------------------------------------------
-- Push receipts: each ok ticket's id and token, checked once at least 15 minutes old. Unchecked
-- ones are dropped after 24 hours (Expo keeps receipts about that long).
-- ---------------------------------------------------------------------------

create table private.push_receipts (
  ticket_id  text primary key,
  token      text not null,
  created_at timestamptz not null default now()
);
create index push_receipts_created_at_idx on private.push_receipts (created_at);

-- p_receipts: [{ "ticket_id": "…", "token": "ExponentPushToken[…]" }, …]
create function public.save_push_receipts(p_receipts jsonb)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into private.push_receipts (ticket_id, token)
  select r.ticket_id, r.token
  from jsonb_to_recordset(coalesce(p_receipts, '[]'::jsonb)) as r(ticket_id text, token text)
  where r.ticket_id is not null and r.token is not null
  on conflict (ticket_id) do nothing;
$$;

-- Drops receipts older than 24 hours, then returns up to p_limit at least p_min_age old, oldest
-- first.
create function public.due_push_receipts(p_min_age interval, p_limit integer)
returns table (ticket_id text, token text)
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from private.push_receipts r where r.created_at < now() - interval '24 hours';
  return query
  select r.ticket_id, r.token
  from private.push_receipts r
  where r.created_at <= now() - p_min_age
  order by r.created_at, r.ticket_id
  limit p_limit;
end;
$$;

create function public.delete_push_receipts(p_ticket_ids text[])
returns void
language sql
security definer
set search_path = ''
as $$
  delete from private.push_receipts r where r.ticket_id = any(p_ticket_ids);
$$;

alter table private.push_sent enable row level security;
alter table private.push_receipts enable row level security;

revoke all on function public.read_household_events(integer, integer) from public, anon, authenticated;
revoke all on function public.archive_household_events(bigint[]) from public, anon, authenticated;
revoke all on function public.release_household_events(bigint[]) from public, anon, authenticated;
revoke all on function public.record_push_sent(uuid, uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.notification_group(text, uuid, uuid, uuid[]) from public, anon, authenticated;
revoke all on function public.notification_recipients(uuid, uuid, text, timestamptz) from public, anon, authenticated;
revoke all on function public.delete_push_tokens(text[]) from public, anon, authenticated;
revoke all on function public.save_push_receipts(jsonb) from public, anon, authenticated;
revoke all on function public.due_push_receipts(interval, integer) from public, anon, authenticated;
revoke all on function public.delete_push_receipts(text[]) from public, anon, authenticated;
grant execute on function public.read_household_events(integer, integer) to service_role;
grant execute on function public.archive_household_events(bigint[]) to service_role;
grant execute on function public.release_household_events(bigint[]) to service_role;
grant execute on function public.record_push_sent(uuid, uuid, uuid, text) to service_role;
grant execute on function public.notification_group(text, uuid, uuid, uuid[]) to service_role;
grant execute on function public.notification_recipients(uuid, uuid, text, timestamptz) to service_role;
grant execute on function public.delete_push_tokens(text[]) to service_role;
grant execute on function public.save_push_receipts(jsonb) to service_role;
grant execute on function public.due_push_receipts(interval, integer) to service_role;
grant execute on function public.delete_push_receipts(text[]) to service_role;

-- ---------------------------------------------------------------------------
-- Schedule
-- ---------------------------------------------------------------------------

-- Calls send-notifications when there's anything queued or a receipt to check, with the Vault
-- secrets project_url and notifications_worker_key (sent as apikey). Without them it does nothing
-- and returns false.
create extension if not exists pg_net with schema extensions;

create function private.request_send_notifications()
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url');
  v_key text := (select decrypted_secret from vault.decrypted_secrets where name = 'notifications_worker_key');
begin
  if v_url is null or v_key is null
     or not (exists (select 1 from pgmq.q_household_events) or exists (select 1 from private.push_receipts)) then
    return false;
  end if;
  perform net.http_post(
    url := pg_catalog.rtrim(v_url, '/') || '/functions/v1/send-notifications',
    headers := jsonb_build_object('Content-Type', 'application/json', 'apikey', v_key),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  );
  return true;
end;
$$;

revoke all on function private.request_send_notifications() from public, anon, authenticated;

-- Every minute.
select cron.schedule('send-notifications', '* * * * *', $$select private.request_send_notifications()$$);

-- Daily at 03:47 UTC: the send log past the shopping window's use.
select cron.schedule(
  'push-sent-retention',
  '47 3 * * *',
  $$delete from private.push_sent where sent_at < now() - interval '7 days'$$
);
