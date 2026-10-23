-- "Recipe ready" and "Couldn't import" pushes (spec 4.13, plan §10): when one of a user's share
-- imports finishes, a push goes to that user's own devices, sent at once rather than grouped.
--
-- The queue is household_events itself (not a sibling queue), with kind `recipe_import`, so the
-- send-notifications worker, its cron check and its archive stay one. A trigger on share_imports
-- queues an event whenever a job's status becomes `done` (commit_share_import) or `failed`
-- (release_share_import, or claim_share_import failing a job with `lease_lost`), in the same
-- transaction, so a rolled-back commit queues nothing. The message carries only ids and the
-- status; the worker re-reads the job when it sends (public.recipe_import_notification) and drops
-- the event if the job has moved on (a Try again).

alter table public.notification_settings
  add column recipe_imports boolean not null default true;

-- ---------------------------------------------------------------------------
-- The queue entry
-- ---------------------------------------------------------------------------

create function private.queue_recipe_import()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status not in ('done', 'failed') or old.status is not distinct from new.status then
    return null;
  end if;
  begin
    perform pgmq.send('household_events', jsonb_build_object(
      'kind', 'recipe_import',
      'share_import_id', new.id,
      'user_id', new.user_id,
      'household_id', new.household_id,
      'status', new.status,
      'at', now()));
  exception when others then
    raise warning 'household_events: couldn''t queue recipe_import for share import %: %', new.id, sqlerrm;
  end;
  return null;
end;
$$;

revoke all on function private.queue_recipe_import() from public, anon, authenticated;

create trigger share_imports_queue_recipe_import
  after update of status on public.share_imports
  for each row execute function private.queue_recipe_import();

-- ---------------------------------------------------------------------------
-- The job re-read at send time: its status and what the push says. Null when the job is gone.
--   recipe_name   the recipe's name (null when it's gone)
--   list_name     the list it was added to (null for recipe-only or a deleted list)
--   household_name
-- ---------------------------------------------------------------------------

create function public.recipe_import_notification(p_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'status', s.status,
    'user_id', s.user_id,
    'recipe_id', s.recipe_id,
    'recipe_name', r.name,
    'applied_list_id', s.applied_list_id,
    'list_name', l.name,
    'household_name', h.name,
    'list_gone', s.list_gone,
    'error_code', s.error_code,
    'resets_at', s.resets_at)
  from public.share_imports s
  left join public.recipes r on r.id = s.recipe_id
  left join public.lists l on l.id = s.applied_list_id and l.deleted_at is null
  left join public.households h on h.id = s.household_id
  where s.id = p_id;
$$;

-- ---------------------------------------------------------------------------
-- Who hears about a recipe import: the user themselves, one row per push token, when they have
-- `recipe_imports` on and aren't in their quiet hours at p_at (judged in their own time zone, as
-- private.push_recipients does). No household check: a sharer who left still hears why it failed.
-- ---------------------------------------------------------------------------

create function public.recipe_import_recipients(p_user_id uuid, p_at timestamptz)
returns table (user_id uuid, token text, platform text)
language sql
stable
security definer
set search_path = ''
as $$
  select t.user_id, t.token, t.platform
  from public.push_tokens t
  left join public.notification_settings s on s.user_id = t.user_id
  cross join lateral (
    select (p_at at time zone coalesce(s.time_zone, 'UTC'))::time as local_time
  ) l
  where t.user_id = p_user_id
    and coalesce(s.recipe_imports, true)
    and not coalesce(
      case
        when s.quiet_hours_start < s.quiet_hours_end
          then l.local_time >= s.quiet_hours_start and l.local_time < s.quiet_hours_end
        else l.local_time >= s.quiet_hours_start or l.local_time < s.quiet_hours_end
      end,
      false)
  order by t.token;
$$;

revoke all on function public.recipe_import_notification(uuid) from public, anon, authenticated;
revoke all on function public.recipe_import_recipients(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.recipe_import_notification(uuid) to service_role;
grant execute on function public.recipe_import_recipients(uuid, timestamptz) to service_role;
