-- queue_recipe_page_prefix_deletion (spec 6.12): share-import-worker queues a failed photo share's
-- copied pages, '<household_id>/<recipe_id>/' in recipe-pages, for photo-cleanup. Service role
-- only, prefixes only, and a page a recipe points at is still never claimed.
begin;
create extension if not exists pgtap with schema extensions;
select plan(14);

-- Fixtures (as postgres) ---------------------------------------------------------------------------
-- Home has the recipe Tacos with one page; the share's recipe 0d… was never created, and its copied
-- pages wait in recipe-pages.
insert into public.households (id, name) values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Home');
insert into public.recipes (id, household_id, name, source_pages) values
  ('a3000000-0000-4000-8000-000000000001', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Tacos',
   '["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/a3000000-0000-4000-8000-000000000001/e0000000-0000-4000-8000-000000000001.jpg"]');
insert into storage.objects (bucket_id, name) values
  ('recipe-pages', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/a3000000-0000-4000-8000-000000000001/e0000000-0000-4000-8000-000000000001.jpg'),
  ('recipe-pages', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/0d000000-0000-4000-8000-000000000001/e0000000-0000-4000-8000-000000000002.jpg'),
  ('recipe-pages', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/0d000000-0000-4000-8000-000000000001/e0000000-0000-4000-8000-000000000003.jpg');
delete from private.recipe_page_deletions;

-- Access -------------------------------------------------------------------------------------------
select ok(
  has_function_privilege('service_role', 'public.queue_recipe_page_prefix_deletion(text)', 'execute')
  and not has_function_privilege('authenticated', 'public.queue_recipe_page_prefix_deletion(text)', 'execute')
  and not has_function_privilege('anon', 'public.queue_recipe_page_prefix_deletion(text)', 'execute'),
  'queue_recipe_page_prefix_deletion: service role only');

-- Queueing -----------------------------------------------------------------------------------------
select lives_ok(
  $$ select public.queue_recipe_page_prefix_deletion('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/0d000000-0000-4000-8000-000000000001/') $$,
  'a household/recipe prefix is queued');
select results_eq(
  $$ select path, is_prefix, claimed_at from private.recipe_page_deletions $$,
  $$ values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/0d000000-0000-4000-8000-000000000001/', true, null::timestamptz) $$,
  'as a prefix, unclaimed');

select throws_ok($$ select public.queue_recipe_page_prefix_deletion(null) $$, '22023', 'invalid prefix', 'null is refused');
select throws_ok($$ select public.queue_recipe_page_prefix_deletion('') $$, '22023', 'invalid prefix', 'empty is refused');
select throws_ok(
  $$ select public.queue_recipe_page_prefix_deletion('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/') $$,
  '22023', 'invalid prefix', 'a whole household is refused');
select throws_ok(
  $$ select public.queue_recipe_page_prefix_deletion('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/0d000000-0000-4000-8000-000000000001') $$,
  '22023', 'invalid prefix', 'without the trailing slash is refused');
select throws_ok(
  $$ select public.queue_recipe_page_prefix_deletion('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/0d000000-0000-4000-8000-000000000001/e0000000-0000-4000-8000-000000000002.jpg') $$,
  '22023', 'invalid prefix', 'an object name is refused');
select throws_ok(
  $$ select public.queue_recipe_page_prefix_deletion('AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA/0d000000-0000-4000-8000-000000000001/') $$,
  '22023', 'invalid prefix', 'uppercase is refused');
select throws_ok(
  $$ select public.queue_recipe_page_prefix_deletion('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/../0d000000-0000-4000-8000-000000000001/') $$,
  '22023', 'invalid prefix', 'anything else in the path is refused');
select is((select count(*) from private.recipe_page_deletions), 1::bigint, 'nothing refused was queued');

-- Claiming -----------------------------------------------------------------------------------------
-- The share's two pages are claimed. Tacos' prefix, queued too (as for a recipe id the share took
-- after all), claims nothing: Tacos points at its page.
select lives_ok(
  $$ select public.queue_recipe_page_prefix_deletion('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/a3000000-0000-4000-8000-000000000001/') $$,
  'a live recipe''s prefix can be queued');
select results_eq(
  $$ select name from public.claim_recipe_page_deletions(10, '0 seconds') order by name $$,
  $$ values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/0d000000-0000-4000-8000-000000000001/e0000000-0000-4000-8000-000000000002.jpg'),
            ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/0d000000-0000-4000-8000-000000000001/e0000000-0000-4000-8000-000000000003.jpg') $$,
  'the share''s pages are claimed, never a page a recipe points at');
select is(
  (select count(*) from private.recipe_page_deletions where claimed_at is not null),
  2::bigint,
  'both prefixes are claimed');

select * from finish();
rollback;
