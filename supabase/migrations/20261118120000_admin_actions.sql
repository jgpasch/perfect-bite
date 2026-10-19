-- Portal function for activity (spec 4.12): the audit log, admin.admin_actions, newest first.
-- Like the other portal functions it's `public` and `security definer`, starts with
-- private.require_admin() and is executable by `authenticated` only.

-- ---------------------------------------------------------------------------
-- admin_list_actions: every admin.admin_actions row (the portal's, the dashboard snippets'
-- delete_user, the app's delete_account), or only p_action's when it's given, newest first,
-- p_limit (at most 200) from p_offset. Returns { actions: [...], total_count }, total_count being
-- the matches before paging. target_user_email is the target's email while they still exist;
-- performed_by_email is the admin's email when performed_by is a user id that still exists, so
-- null for the dashboard's `postgres` and the app's rows.
-- ---------------------------------------------------------------------------

create function public.admin_list_actions(p_action text default null, p_limit integer default 50, p_offset integer default 0)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_action text := nullif(btrim(p_action), '');
  v_total bigint;
  v_actions jsonb;
begin
  perform private.require_admin();

  select count(*) into v_total
  from admin.admin_actions a
  where v_action is null or a.action = v_action;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', p.id,
    'action', p.action,
    'target_user_id', p.target_user_id,
    'target_user_email', (select tu.email from auth.users tu where tu.id = p.target_user_id),
    'target_household_id', p.target_household_id,
    'target_plan_id', p.target_plan_id,
    'details', p.details,
    'note', p.note,
    'performed_by', p.performed_by,
    'performed_by_email', (
      select pu.email from auth.users pu
      where pu.id = case when p.performed_by ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                         then p.performed_by::uuid end
    ),
    'created_at', p.created_at
  ) order by p.created_at desc, p.id), '[]')
  into v_actions
  from (
    select a.*
    from admin.admin_actions a
    where v_action is null or a.action = v_action
    order by a.created_at desc, a.id
    limit least(greatest(coalesce(p_limit, 50), 0), 200)
    offset greatest(coalesce(p_offset, 0), 0)
  ) p;

  return jsonb_build_object('actions', v_actions, 'total_count', v_total);
end;
$$;

revoke all on function public.admin_list_actions(text, integer, integer) from public, anon, service_role;
grant execute on function public.admin_list_actions(text, integer, integer) to authenticated;
