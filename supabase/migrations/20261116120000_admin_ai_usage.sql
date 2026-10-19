-- Portal function for AI usage (spec 4.12): how much of each feature people use this month, day by
-- day and by whom, and the last 30 days of model calls from public.ai_calls. Like the user
-- functions: `public`, `security definer`, private.require_admin() first, executable by
-- `authenticated` only. Read-only, so no audit row. Counts and sums only: never a call's
-- instructions, prompt, output or response text.

-- Each user's usage of a feature per UTC day from p_since on, from the usage tables, in the units
-- the monthly limits use (categorize counts names sent to the LLM; the rest count calls). The one
-- place a feature maps to its table and column.
create function private.daily_usage(p_feature text, p_since date)
returns table (user_id uuid, day date, used integer)
language sql
stable
security definer
set search_path = ''
as $$
  select u.user_id, u.day, u.new_names from private.categorize_usage u
  where p_feature = 'categorize' and u.day >= p_since
  union all
  select u.user_id, u.day, u.imports from private.recipe_import_usage u
  where p_feature = 'recipe_import' and u.day >= p_since
  union all
  select u.user_id, u.day, u.imports from private.recipe_photo_import_usage u
  where p_feature = 'recipe_import_photo' and u.day >= p_since
  union all
  select u.user_id, u.day, u.suggestions from private.recipe_tags_usage u
  where p_feature = 'recipe_tags' and u.day >= p_since
  union all
  select u.user_id, u.day, u.matches from private.step_match_usage u
  where p_feature = 'step_ingredients' and u.day >= p_since
  union all
  select u.user_id, u.day, u.photos from private.recipe_photo_ai_usage u
  where p_feature = 'recipe_photo_ai' and u.day >= p_since;
$$;

revoke all on function private.daily_usage(text, date) from public, anon, authenticated, service_role;

-- As before, now read through daily_usage so the portal's totals and the limit checks agree.
create or replace function private.monthly_usage(p_user_id uuid, p_feature text)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(d.used), 0)::integer
  from private.daily_usage(p_feature, date_trunc('month', now() at time zone 'utc')::date) d
  where d.user_id = p_user_id;
$$;

-- Counts and token sums over a set of ai_calls rows (p_task, and p_model when given, since
-- p_since): total, a count per status (every status, zeros included), fallbacks (rows with
-- fallback_of set) and the four token sums (missing counts read as 0).
create function private.ai_call_stats(p_task text, p_model text, p_since timestamptz)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'total', count(*),
    'statuses', jsonb_build_object(
      'ok', count(*) filter (where c.status = 'ok'),
      'api_error', count(*) filter (where c.status = 'api_error'),
      'invalid_output', count(*) filter (where c.status = 'invalid_output'),
      'timeout', count(*) filter (where c.status = 'timeout'),
      'error', count(*) filter (where c.status = 'error')
    ),
    'fallbacks', count(*) filter (where c.fallback_of is not null),
    'input_tokens', coalesce(sum(c.input_tokens), 0),
    'output_tokens', coalesce(sum(c.output_tokens), 0),
    'cached_input_tokens', coalesce(sum(c.cached_input_tokens), 0),
    'reasoning_tokens', coalesce(sum(c.reasoning_tokens), 0)
  )
  from public.ai_calls c
  where c.task = p_task
    and (p_model is null or c.model = p_model)
    and c.created_at >= p_since;
$$;

revoke all on function private.ai_call_stats(text, text, timestamptz) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- admin_ai_usage: { month_start, features, calls_since, calls }.
-- features: one entry per feature in the fixed order, with this calendar month's (UTC) `used`
-- across everyone, `users` (how many used any), `daily` (each UTC day of the last 40, oldest
-- first, zeros included) and `top_users` (the 10 heaviest this month, with email, plan id, used
-- and their limit as private.monthly_limit gives it).
-- calls: one entry per ai_calls.task as stored, over the last 30 days (the table's retention),
-- with private.ai_call_stats for the task and per model.
-- ---------------------------------------------------------------------------

create function public.admin_ai_usage()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  c_days constant integer := 40;
  v_today date := (now() at time zone 'utc')::date;
  v_month date := date_trunc('month', now() at time zone 'utc')::date;
  v_calls_since timestamptz := now() - interval '30 days';
  v_default text := (select p.id from public.plans p where p.is_default);
begin
  perform private.require_admin();

  return jsonb_build_object(
    'month_start', v_month,
    'features', (
      select jsonb_agg(jsonb_build_object(
        'feature', f.feature,
        'used', (select coalesce(sum(d.used), 0) from private.daily_usage(f.feature, v_month) d),
        'users', (select count(distinct d.user_id) from private.daily_usage(f.feature, v_month) d where d.used > 0),
        'daily', (
          select jsonb_agg(jsonb_build_object('day', s.day, 'used', coalesce(t.used, 0)) order by s.day)
          from (select (v_today - n)::date as day from generate_series(c_days - 1, 0, -1) n) s
          left join (
            select d.day, sum(d.used) as used
            from private.daily_usage(f.feature, v_today - (c_days - 1)) d
            group by d.day
          ) t on t.day = s.day
        ),
        'top_users', coalesce((
          select jsonb_agg(jsonb_build_object(
            'user_id', t.user_id,
            'email', u.email,
            'plan_id', coalesce(up.plan_id, v_default),
            'used', t.used,
            'limit', private.monthly_limit(t.user_id, f.feature)
          ) order by t.used desc, t.user_id)
          from (
            select d.user_id, sum(d.used) as used
            from private.daily_usage(f.feature, v_month) d
            group by d.user_id
            having sum(d.used) > 0
            order by sum(d.used) desc, d.user_id
            limit 10
          ) t
          join auth.users u on u.id = t.user_id
          left join public.user_plans up on up.user_id = t.user_id
        ), '[]')
      ) order by f.ord)
      from unnest(private.feature_keys()) with ordinality as f (feature, ord)
    ),
    'calls_since', v_calls_since,
    'calls', coalesce((
      select jsonb_agg(
        jsonb_build_object('task', k.task)
          || private.ai_call_stats(k.task, null, v_calls_since)
          || jsonb_build_object('models', (
            select jsonb_agg(jsonb_build_object('model', m.model)
                             || private.ai_call_stats(k.task, m.model, v_calls_since) order by m.model)
            from (select distinct c.model from public.ai_calls c
                  where c.task = k.task and c.created_at >= v_calls_since) m
          ))
        order by k.task)
      from (select distinct c.task from public.ai_calls c where c.created_at >= v_calls_since) k
    ), '[]')
  );
end;
$$;

revoke all on function public.admin_ai_usage() from public, anon, service_role;
grant execute on function public.admin_ai_usage() to authenticated;
