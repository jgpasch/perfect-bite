-- Reading a user's activity (spec 4.12 User activity): admin_user_activity merges the user's
-- private.user_activity entries, their ai_calls and the admin.admin_actions rows about them, newest
-- first and keyset paged, with per-area counts for the filter chips. Opening it (a first page) is
-- audited (`view_user_activity`). admin_user_detail gains `last_active_at`.

-- Every entry of one user, unfiltered but for the household and the dates (p_from inclusive, p_to
-- exclusive): what counts and the pages are both read from. `ord` orders entries sharing a timestamp.
create function private.user_activity_rows(
  p_user_id uuid,
  p_household_id uuid,
  p_from timestamptz,
  p_to timestamptz
)
returns table (
  at timestamptz,
  source text,
  area text,
  action text,
  entity_id text,
  household_id uuid,
  household text,
  txid bigint,
  data jsonb,
  ord bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  select a.created_at, 'app', a.area, a.action, a.entity_id, a.household_id,
         coalesce(a.data ->> 'household', h.name), a.txid, a.data, a.id
  from private.user_activity a
  left join public.households h on h.id = a.household_id
  where a.user_id = p_user_id
    and (p_household_id is null or a.household_id = p_household_id)
    and (p_from is null or a.created_at >= p_from)
    and (p_to is null or a.created_at < p_to)
  union all
  select c.created_at, 'ai', 'ai', 'ai.' || c.task, c.id::text, c.household_id, h.name, null,
         jsonb_build_object('id', c.id, 'status', c.status, 'flag', private.ai_call_flag(c),
                            'recipe_id', c.recipe_id),
         0
  from public.ai_calls c
  left join public.households h on h.id = c.household_id
  where c.user_id = p_user_id
    and (p_household_id is null or c.household_id = p_household_id)
    and (p_from is null or c.created_at >= p_from)
    and (p_to is null or c.created_at < p_to)
  union all
  select x.created_at, 'admin', 'admin', 'admin.' || x.action, x.id::text, x.target_household_id, h.name,
         null,
         jsonb_build_object('details', x.details, 'note', x.note,
                            'performed_by_email', (select u.email from auth.users u where u.id::text = x.performed_by)),
         0
  from admin.admin_actions x
  left join public.households h on h.id = x.target_household_id
  where x.target_user_id = p_user_id
    and (p_household_id is null or x.target_household_id = p_household_id)
    and (p_from is null or x.created_at >= p_from)
    and (p_to is null or x.created_at < p_to);
$$;

revoke all on function private.user_activity_rows(uuid, uuid, timestamptz, timestamptz)
  from public, anon, authenticated, service_role;

-- admin_user_activity: { entries, next_before, counts }. Entries newest first (ties: app, ai, admin,
-- then the newest app entry first), each { at, source, area, action, entity_id, household_id,
-- household, txid, data }, filtered by every argument given; p_before pages (entries strictly older).
-- A page never splits one timestamp (one transaction's entries share it): when the limit falls inside
-- a timestamp, the page stops before it, unless that timestamp is the whole page, which then comes back
-- whole even past the limit. `next_before` is the page's oldest timestamp, or null at the end.
-- An invite.created entry gets `invited_email` while the invite exists. `counts` is per area over the
-- user, household and dates, ignoring p_areas, p_actions and p_before. A first page (no p_before)
-- writes one admin.admin_actions row (`view_user_activity`, the filters as details), so it isn't
-- `stable`. An unknown user has no entries.
create function public.admin_user_activity(
  p_user_id uuid,
  p_areas text[] default null,
  p_actions text[] default null,
  p_household_id uuid default null,
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_before timestamptz default null,
  p_limit integer default 100
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 200);
  v_result jsonb;
begin
  perform private.require_admin();

  with f as materialized (
    select r.*, row_number() over (
      order by r.at desc, case r.source when 'app' then 0 when 'ai' then 1 else 2 end, r.ord desc) as rn
    from private.user_activity_rows(p_user_id, p_household_id, p_from, p_to) r
    where (p_areas is null or r.area = any (p_areas))
      and (p_actions is null or r.action = any (p_actions))
      and (p_before is null or r.at < p_before)
  ),
  edge as (
    select (select f.at from f where f.rn = v_limit) as last,      -- the limit-th entry's time
           (select f.at from f where f.rn = v_limit + 1) as after  -- the next one's; null: this is the end
  ),
  page as (
    -- The page is every entry at or after `floor` (null: all of them). When the limit falls inside
    -- a timestamp the page stops before it, unless it's the whole page.
    select case
      when e.after is null then null
      when e.after < e.last then e.last
      else coalesce((select min(f.at) from f where f.rn <= v_limit and f.at > e.last), e.last)
    end as floor
    from edge e
  )
  select jsonb_build_object(
    'entries', coalesce((
      select jsonb_agg(jsonb_build_object(
        'at', f.at,
        'source', f.source,
        'area', f.area,
        'action', f.action,
        'entity_id', f.entity_id,
        'household_id', f.household_id,
        'household', f.household,
        'txid', f.txid,
        'data', case when f.action = 'invite.created' then f.data || jsonb_build_object('invited_email', (
          select i.invited_email from public.household_invites i where i.id::text = f.data ->> 'invite_id'
        )) else f.data end
      ) order by f.rn)
      from f, page pg
      where pg.floor is null or f.at >= pg.floor
    ), '[]'),
    'next_before', (select pg.floor from page pg),
    'counts', (
      select jsonb_object_agg(k.area, coalesce(c.n, 0))
      from unnest(array['lists', 'recipes', 'plan', 'aisles', 'household', 'settings', 'devices', 'ai', 'admin']) k (area)
      left join (
        select r.area, count(*) as n
        from private.user_activity_rows(p_user_id, p_household_id, p_from, p_to) r
        group by r.area
      ) c on c.area = k.area
    )
  ) into v_result;

  if p_before is null then
    insert into admin.admin_actions (action, target_user_id, details, performed_by)
    values ('view_user_activity', p_user_id,
            jsonb_build_object('areas', to_jsonb(p_areas), 'actions', to_jsonb(p_actions),
                               'household_id', p_household_id, 'from', p_from, 'to', p_to),
            auth.uid()::text);
  end if;

  return v_result;
end;
$$;

revoke all on function public.admin_user_activity(uuid, text[], text[], uuid, timestamptz, timestamptz, timestamptz, integer)
  from public, anon, service_role;
grant execute on function public.admin_user_activity(uuid, text[], text[], uuid, timestamptz, timestamptz, timestamptz, integer)
  to authenticated;

-- admin_user_detail, as before, plus `last_active_at`: the user's newest user_activity entry or AI
-- call, null with neither.
create or replace function public.admin_user_detail(p_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user auth.users;
  v_display_name text;
begin
  perform private.require_admin();

  select * into v_user from auth.users u where u.id = p_user_id;
  if not found then
    raise exception 'user not found' using errcode = 'P0002';
  end if;
  select p.display_name into v_display_name from public.profiles p where p.user_id = p_user_id;

  return jsonb_build_object(
    'user_id', v_user.id,
    'email', v_user.email,
    'display_name', v_display_name,
    'created_at', v_user.created_at,
    'last_sign_in_at', v_user.last_sign_in_at,
    'last_active_at', greatest(
      (select max(a.created_at) from private.user_activity a where a.user_id = p_user_id),
      (select max(c.created_at) from public.ai_calls c where c.user_id = p_user_id)
    ),
    'households', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', h.id,
        'name', h.name,
        'role', hm.role,
        'member_count', (select count(*) from public.household_members m where m.household_id = h.id),
        'plan_id', hp.plan_id,
        'plan_name', p.name
      ) order by hm.position, h.id)
      from public.household_members hm
      join public.households h on h.id = hm.household_id
      left join public.household_plans hp on hp.household_id = h.id
      left join public.plans p on p.id = hp.plan_id
      where hm.user_id = p_user_id
    ), '[]'),
    'ai_flags', coalesce((
      select jsonb_object_agg(f.flag, f.n)
      from (
        select private.ai_call_flag(c) as flag, count(*) as n
        from public.ai_calls c
        where c.user_id = p_user_id
          and c.created_at >= now() - interval '30 days'
          and private.ai_call_flag(c) is not null
        group by 1
      ) f
    ), '{}'),
    'ai_photo_block', (
      select jsonb_build_object('blocked_at', b.blocked_at, 'refusals', b.refusals, 'last_call_id', b.last_call_id)
      from private.ai_photo_blocks b
      where b.user_id = p_user_id
    ),
    'ai_photo_refusals_30d', private.ai_photo_refusals(p_user_id, now() - private.ai_photo_block_window())
  );
end;
$$;
