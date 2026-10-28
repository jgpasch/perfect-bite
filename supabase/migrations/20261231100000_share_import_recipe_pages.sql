-- Photo shares' pages in recipe-pages (spec 6.12): before committing a photo share,
-- share-import-worker copies its images to recipe-pages/<household_id>/<recipe_id>/ for the new
-- recipe's source_pages. When the commit then ends permanently failed, no recipe points at them, so
-- the worker queues that prefix with queue_recipe_page_prefix_deletion. photo-cleanup drains it with
-- the rest of private.recipe_page_deletions (20261107120000_recipe_pages.sql); its claim leaves out
-- any page a recipe does point at, so queueing a prefix never deletes a live recipe's pages.

create function public.queue_recipe_page_prefix_deletion(p_prefix text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_prefix is null or p_prefix !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/$' then
    raise exception 'invalid prefix' using errcode = '22023';
  end if;
  insert into private.recipe_page_deletions (path, is_prefix) values (p_prefix, true);
end;
$$;

revoke all on function public.queue_recipe_page_prefix_deletion(text) from public, anon, authenticated;
grant execute on function public.queue_recipe_page_prefix_deletion(text) to service_role;
