-- The sidebar's flag badge clears once seen (spec 4.12): each admin's ai_flags_seen_at is when they
-- last opened the Flagged tab, and admin_ai_call_flag_count counts only flagged calls made after it.
-- Per admin, so one admin looking doesn't clear another's badge. Not audited: it reads no user's data.

alter table private.admins add column ai_flags_seen_at timestamptz;

-- ---------------------------------------------------------------------------
-- admin_ai_call_flag_count, as before, but only calls made after the caller's ai_flags_seen_at
-- (all of the window when they've never looked).
-- ---------------------------------------------------------------------------

create or replace function public.admin_ai_call_flag_count(p_days integer default 7)
returns integer
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_seen_at timestamptz;
begin
  perform private.require_admin();

  select a.ai_flags_seen_at into v_seen_at from private.admins a where a.user_id = auth.uid();

  return (
    select count(*)::integer
    from public.ai_calls c
    where private.ai_call_flag(c) is not null
      and c.created_at >= now() - coalesce(p_days, 7) * interval '1 day'
      and (v_seen_at is null or c.created_at > v_seen_at)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- admin_mark_ai_flags_seen: sets the caller's ai_flags_seen_at to now. Returns whether the badge
-- (the 7-day count) had anything to clear, so the portal re-renders it only when it changes.
-- ---------------------------------------------------------------------------

create function public.admin_mark_ai_flags_seen()
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_seen_at timestamptz;
  v_now timestamptz := now();
begin
  perform private.require_admin();

  select a.ai_flags_seen_at into v_seen_at from private.admins a where a.user_id = auth.uid();
  update private.admins set ai_flags_seen_at = v_now where user_id = auth.uid();

  return exists (
    select 1 from public.ai_calls c
    where private.ai_call_flag(c) is not null
      and c.created_at >= v_now - interval '7 days'
      and (v_seen_at is null or c.created_at > v_seen_at)
  );
end;
$$;

revoke all on function public.admin_mark_ai_flags_seen() from public, anon, service_role;
grant execute on function public.admin_mark_ai_flags_seen() to authenticated;
