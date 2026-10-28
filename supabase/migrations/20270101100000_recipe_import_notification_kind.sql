-- Recipe-import pushes for photo shares (spec 4.13, 4.10). recipe_import_notification also returns
-- the job's kind ('link' or 'photo'), so send-notifications can word a failed photo share's
-- not_a_recipe as "That photo doesn't look like a recipe". Otherwise as in
-- 20261216100000_recipe_import_pushes.sql; create or replace keeps its grants (service role only).

create or replace function public.recipe_import_notification(p_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'status', s.status,
    'kind', s.kind,
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
