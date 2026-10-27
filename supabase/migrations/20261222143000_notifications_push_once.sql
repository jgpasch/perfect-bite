-- Notifications never push twice (spec 4.13, 8.5).
--
-- archive_sent_household_events archives a sent group's events and records it in push_sent in one
-- transaction, so the shopping 2-hour window can't be lost while the events are archived (or the
-- other way round). request_send_notifications wakes the worker only for events a run can read
-- (not ones hidden by a running worker's read), or for receipts.

create function public.archive_sent_household_events(
  p_msg_ids bigint[], p_household_id uuid, p_actor uuid, p_list_id uuid, p_kind text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(cardinality(p_msg_ids), 0) > 0 then
    perform pgmq.archive('household_events', p_msg_ids);
  end if;
  insert into private.push_sent (household_id, actor, list_id, kind)
  values (p_household_id, p_actor, p_list_id, p_kind);
end;
$$;

revoke all on function public.archive_sent_household_events(bigint[], uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.archive_sent_household_events(bigint[], uuid, uuid, uuid, text) to service_role;

create or replace function private.request_send_notifications()
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
     or not (exists (select 1 from pgmq.q_household_events q where q.vt <= pg_catalog.clock_timestamp())
             or exists (select 1 from private.push_receipts)) then
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
