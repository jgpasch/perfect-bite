-- Household events for push notifications (spec 4.13, 8). Each add (a list_item_contributions
-- insert) and each check (list_items.checked_at going from null to set) queues an event on the
-- pgmq queue `household_events`. The send-notifications worker reads the queue, groups the
-- events and sends the pushes.
--
-- Adds come from contributions, not list_items inserts: a Combine adds a contribution to an
-- existing open item and inserts no item. A merge inside apply_mutations (7.3) re-points the
-- merged item's contributions with an update, so it never queues a second event.
--
-- The triggers fire for every write path (apply_mutations, a future siri-add, …) and never fail
-- the write: a failed send only raises a warning.

create extension if not exists pgmq;

select pgmq.create('household_events');

-- Supabase requires RLS on queue tables. No policies: only postgres/service_role (the worker)
-- touch the queue.
alter table pgmq.q_household_events enable row level security;
alter table pgmq.a_household_events enable row level security;

-- security definer so the writing role needs no pgmq privileges.
create function private.queue_items_added()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.added_by is null or new.deleted_at is not null then
    return null;
  end if;
  begin
    perform pgmq.send('household_events', jsonb_build_object(
      'kind', 'items_added',
      'household_id', new.household_id,
      'list_id', (select li.list_id from public.list_items li where li.id = new.list_item_id),
      'actor', new.added_by,
      'contribution_id', new.id,
      'list_item_id', new.list_item_id,
      'recipe_id', new.recipe_id,
      'source', new.source,
      'at', new.created_at));
  exception when others then
    raise warning 'household_events: couldn''t queue items_added for contribution %: %', new.id, sqlerrm;
  end;
  return null;
end;
$$;

revoke all on function private.queue_items_added() from public, anon, authenticated;

create trigger list_item_contributions_queue_items_added
  after insert on public.list_item_contributions
  for each row execute function private.queue_items_added();

create function private.queue_shopping()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.checked_at is not null or new.checked_at is null or new.checked_by is null then
    return null;
  end if;
  begin
    perform pgmq.send('household_events', jsonb_build_object(
      'kind', 'shopping',
      'household_id', new.household_id,
      'list_id', new.list_id,
      'actor', new.checked_by,
      'list_item_id', new.id,
      'at', new.checked_at));
  exception when others then
    raise warning 'household_events: couldn''t queue shopping for item %: %', new.id, sqlerrm;
  end;
  return null;
end;
$$;

revoke all on function private.queue_shopping() from public, anon, authenticated;

create trigger list_items_queue_shopping
  after update of checked_at on public.list_items
  for each row execute function private.queue_shopping();
