-- "Alex is adding" (spec 4.1, 7.2): while a list is on screen the app joins a private Realtime
-- channel for it, topic `list:<listId>`, and tracks presence there (`{ user_id, adding }`). Realtime
-- authorizes a private channel with the caller's RLS policies on `realtime.messages`: a select
-- policy lets them join and receive presence, an insert policy lets them track it. Both are
-- limited to presence on a list topic in one of the caller's households, so someone outside the
-- household can't join, see who's there or show up in it. Nothing else (broadcast, other topics)
-- is allowed. The sync channels are public `postgres_changes` channels and aren't affected.

-- Whether `p_topic` is `list:<id>` for a list in one of the caller's households. Compared as text,
-- so a topic that isn't a uuid just doesn't match. Security definer, as `my_household_ids`, so the
-- policies don't depend on the caller's RLS on `lists`.
create function private.can_use_list_topic(p_topic text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_topic like 'list:%' and exists (
    select 1
    from public.lists l
    join public.household_members m on m.household_id = l.household_id
    where l.id::text = substr(p_topic, 6)
      and m.user_id = (select auth.uid())
  );
$$;

revoke all on function private.can_use_list_topic(text) from public, anon;
grant execute on function private.can_use_list_topic(text) to authenticated;

create policy list_presence_read on realtime.messages
  for select to authenticated
  using (
    realtime.messages.extension = 'presence'
    and (select private.can_use_list_topic(realtime.topic()))
  );

create policy list_presence_track on realtime.messages
  for insert to authenticated
  with check (
    realtime.messages.extension = 'presence'
    and (select private.can_use_list_topic(realtime.topic()))
  );
