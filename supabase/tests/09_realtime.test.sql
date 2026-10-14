-- Realtime publication (spec 7.2): every table the app listens to is published, and nothing else.
begin;
create extension if not exists pgtap with schema extensions;
select plan(3);

select set_eq(
  $$ select tablename::text from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' $$,
  array[
    'households', 'household_members', 'lists', 'recipes', 'list_items', 'recipe_ingredients',
    'list_item_contributions', 'ingredient_usage', 'ingredient_unit_usage', 'categories',
    'user_category_order', 'household_category_overrides', 'user_settings', 'ingredients',
    'household_staples'
  ],
  'the synced tables, memberships and the catalog are published to Realtime'
);

select is_empty(
  $$ select tablename from pg_publication_tables where pubname = 'supabase_realtime' and schemaname <> 'public' $$,
  'no private tables are published'
);

-- Delete events carry the primary key, which is all the app reads from them.
select is_empty(
  $$ select c.relname from pg_class c
     join pg_publication_tables p on p.schemaname = 'public' and p.tablename = c.relname and p.pubname = 'supabase_realtime'
     where c.relnamespace = 'public'::regnamespace and c.relreplident <> 'd' $$,
  'published tables keep the default replica identity (primary key)'
);

select * from finish();
rollback;
