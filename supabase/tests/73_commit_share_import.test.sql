-- Share import commit (spec 6.12 Commit, plan §5, §9): commit_share_import applies a planned share
-- import in one transaction, checked against its preconditions and destination, with server HLCs,
-- and writes the receipt. The plans here are written by hand in the planner's shape
-- (src/shared/domain/list-plan.ts); "between plan and commit" is a device push (as Sam, through
-- apply_mutations) between the two. pgTAP runs in one session, so concurrency is these orderings.
begin;
create extension if not exists pgtap with schema extensions;
select plan(56);

-- Fixtures (as postgres, no user) ------------------------------------------------------------------
insert into auth.users (id, email, aud, role) values
  ('11111111-1111-1111-1111-111111111111', 'alex@test.local', 'authenticated', 'authenticated'),
  ('22222222-2222-2222-2222-222222222222', 'sam@test.local', 'authenticated', 'authenticated'),
  ('33333333-3333-3333-3333-333333333333', 'lee@test.local', 'authenticated', 'authenticated');
insert into public.households (id, name) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Home'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Elsewhere');
insert into public.household_members (household_id, user_id, role, position) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'owner', 1),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '22222222-2222-2222-2222-222222222222', 'member', 1),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '33333333-3333-3333-3333-333333333333', 'member', 1),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '22222222-2222-2222-2222-222222222222', 'owner', 1);
insert into public.lists (id, household_id, name, position, archived_at) values
  ('a1000000-0000-7000-8000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Groceries', 1, null),
  ('a1000000-0000-7000-8000-000000000002', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Old', 2, now());
insert into public.ingredients (normalized_name, display_name) values
  ('test garlic', 'garlic'), ('test lime', 'lime'), ('test basil', 'basil'), ('test onion', 'onion'),
  ('test leek', 'leek')
on conflict do nothing;
-- Items as devices left them: lime open, onion checked, leek open (2 of them).
insert into public.list_items (id, list_id, household_id, ingredient_name, display_name, checked_at, checked_by, field_clock) values
  ('a2000000-0000-7000-8000-000000000001', 'a1000000-0000-7000-8000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'test lime', 'lime', null, null, '{"checked_at": "1770000000000-0000-sam1"}'),
  ('a2000000-0000-7000-8000-000000000002', 'a1000000-0000-7000-8000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'test onion', 'onion', '2026-10-20T10:00:00.123Z', '22222222-2222-2222-2222-222222222222', '{"checked_at": "1770000000000-0000-sam1"}'),
  ('a2000000-0000-7000-8000-000000000003', 'a1000000-0000-7000-8000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'test leek', 'leek', null, null, '{}');
insert into public.list_item_contributions (id, list_item_id, household_id, source, quantity, unit, created_at, field_clock) values
  ('a4000000-0000-7000-8000-000000000001', 'a2000000-0000-7000-8000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'manual', 1, null, '2026-10-20T09:00:00Z', '{}'),
  ('a4000000-0000-7000-8000-000000000002', 'a2000000-0000-7000-8000-000000000002', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'manual', 3, null, '2026-10-20T09:00:00Z', '{}'),
  ('a4000000-0000-7000-8000-000000000003', 'a2000000-0000-7000-8000-000000000003', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'manual', 2, null, '2026-10-20T09:00:00Z', '{"quantity": "1770000000000-0000-sam1"}');
delete from private.user_activity;
delete from pgmq.q_household_events;

-- A share import in `committing` under p_lease, as claim_share_import leaves it.
create function pg_temp.job(p_id uuid, p_lease uuid, p_user uuid default '11111111-1111-1111-1111-111111111111') returns void language sql as $$
  insert into public.share_imports (id, user_id, household_id, list_id, add_to_list, url, url_key, payload_hash,
    page, status, attempts, lease_token, lease_expires_at)
  values (p_id, p_user, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'a1000000-0000-7000-8000-000000000001', true,
    'https://example.com/r', 'https://example.com/r', '\x00', '{"title": "Captured"}', 'committing', 2,
    p_lease, now() + interval '2 minutes');
$$;

-- What Sam's phone pushes.
create function pg_temp.as_sam(p_mutations text) returns jsonb language plpgsql as $$
declare v jsonb;
begin
  perform set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);
  set local role authenticated;
  v := public.apply_mutations(p_mutations::jsonb);
  reset role;
  perform set_config('request.jwt.claims', '', true);
  return v;
end $$;

create function pg_temp.live_amounts(p_item uuid) returns text language sql as $$
  select coalesce(string_agg(c.id::text || '=' || coalesce(c.quantity::text, 'null'), ',' order by c.id), '')
  from public.list_item_contributions c where c.list_item_id = p_item and c.deleted_at is null
$$;

-- Privileges -------------------------------------------------------------------------------------
select ok(has_function_privilege('service_role', 'public.commit_share_import(uuid, uuid, jsonb, jsonb, jsonb)', 'execute'),
  'the worker (service role) can commit');
select ok(not has_function_privilege('authenticated', 'public.commit_share_import(uuid, uuid, jsonb, jsonb, jsonb)', 'execute')
  and not has_function_privilege('anon', 'public.commit_share_import(uuid, uuid, jsonb, jsonb, jsonb)', 'execute'),
  'clients can''t');

-- A new recipe onto the list: a new item --------------------------------------------------------
select pg_temp.job('f0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000001');

set local role service_role;
select is(
  public.commit_share_import('f0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000001',
    $$ { "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "list_id": "a1000000-0000-7000-8000-000000000001",
         "list_gone": false, "recipe_id": "c0000000-0000-4000-8000-000000000001", "items_added": 1, "items_combined": 0 } $$,
    $$ [
      { "op": "insert", "table": "recipes", "id": "c0000000-0000-4000-8000-000000000001",
        "fields": { "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "name": "Garlic pasta", "source_url": "https://example.com/r",
                    "total_minutes": null, "steps": null, "servings": 4, "image_url": null } },
      { "op": "insert", "table": "recipe_ingredients", "id": "c1000000-0000-4000-8000-000000000001",
        "fields": { "recipe_id": "c0000000-0000-4000-8000-000000000001", "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
                    "ingredient_name": "test garlic", "display_name": "garlic", "quantity": 2, "unit": "clove", "note": null, "position": 1 } },
      { "op": "upsert", "table": "ingredient_usage", "key": { "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "ingredient_name": "test garlic" },
        "fields": { "display_name": "garlic", "last_used_at": "2026-10-23T10:00:00.000Z", "hidden_at": null }, "counters": { "use_count": 1 } },
      { "op": "insert", "table": "list_items", "id": "a2000000-0000-7000-8000-000000000011",
        "fields": { "list_id": "a1000000-0000-7000-8000-000000000001", "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
                    "ingredient_name": "test garlic", "display_name": "garlic", "added_by": "11111111-1111-1111-1111-111111111111", "created_at": "2026-10-23T10:00:00.000Z" } },
      { "op": "insert", "table": "list_item_contributions", "id": "a4000000-0000-7000-8000-000000000011",
        "fields": { "list_item_id": "a2000000-0000-7000-8000-000000000011", "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
                    "source": "recipe", "recipe_id": "c0000000-0000-4000-8000-000000000001", "quantity": 2, "unit": "clove",
                    "added_by": "11111111-1111-1111-1111-111111111111", "created_at": "2026-10-23T10:00:00.000Z" } }
    ] $$,
    $$ [ { "kind": "recipeAbsent", "recipeId": "c0000000-0000-4000-8000-000000000001" },
         { "kind": "new", "listId": "a1000000-0000-7000-8000-000000000001", "key": "test garlic" } ] $$) - 'committed_at',
  '{"recipe_id": "c0000000-0000-4000-8000-000000000001", "applied_list_id": "a1000000-0000-7000-8000-000000000001",
    "list_gone": false, "items_added": 1, "items_combined": 0}'::jsonb,
  'a commit returns its receipt');
reset role;

select results_eq(
  $$ select status, lease_token, lease_expires_at, page, recipe_id, applied_list_id, items_added, items_combined, committed_at is not null
     from public.share_imports where id = 'f0000000-0000-4000-8000-000000000001' $$,
  $$ values ('done', null::uuid, null::timestamptz, null::jsonb, 'c0000000-0000-4000-8000-000000000001'::uuid,
             'a1000000-0000-7000-8000-000000000001'::uuid, 1, 0, true) $$,
  'the job is done in the same transaction, its lease and page cleared and its receipt kept');
select results_eq(
  $$ select name, added_by, servings from public.recipes where id = 'c0000000-0000-4000-8000-000000000001' $$,
  $$ values ('Garlic pasta', '11111111-1111-1111-1111-111111111111'::uuid, 4) $$,
  'the recipe is saved to the household, added by the sharer');
select is((select count(*)::int from public.recipe_ingredients where recipe_id = 'c0000000-0000-4000-8000-000000000001'), 1,
  'with its ingredient');
select results_eq(
  $$ select checked_at, added_by, deleted_at from public.list_items where id = 'a2000000-0000-7000-8000-000000000011' $$,
  $$ values (null::timestamptz, '11111111-1111-1111-1111-111111111111'::uuid, null::timestamptz) $$,
  'the item is open on the list, added by the sharer');
select is(pg_temp.live_amounts('a2000000-0000-7000-8000-000000000011'), 'a4000000-0000-7000-8000-000000000011=2',
  'with the recipe''s amount');
select is((select use_count from public.ingredient_usage where household_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' and ingredient_name = 'test garlic'),
  1, 'the use is counted');
select ok((select field_clock ->> 'ingredient_name' from public.list_items where id = 'a2000000-0000-7000-8000-000000000011')
  ~ '^[0-9]{13}-0003-srv$', 'its HLC is the server''s: device srv, the counter its write index');
select ok((select left(field_clock ->> 'name', 13)::bigint from public.recipes where id = 'c0000000-0000-4000-8000-000000000001')
  >= floor(extract(epoch from now()) * 1000)::bigint, 'with the wall time at least the commit''s');

-- Activity and push -------------------------------------------------------------------------------
select results_eq(
  $$ select user_id, household_id, area, action, entity_id, data from private.user_activity $$,
  $$ values ('11111111-1111-1111-1111-111111111111'::uuid, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid, 'recipes',
             'recipe.imported_from_share', 'c0000000-0000-4000-8000-000000000001',
             '{"household": "Home", "recipe": "Garlic pasta", "recipe_id": "c0000000-0000-4000-8000-000000000001",
               "list": "Groceries", "items_added": 1, "items_combined": 0}'::jsonb) $$,
  'one activity entry, as the sharer, for the whole commit');
select is(current_setting('app.actor_uid', true), '', 'the actor is cleared after the commit');
select is(current_setting('app.activity_action', true), '', 'and so is the suppression');
select results_eq(
  $$ select message ->> 'kind', message ->> 'actor', message ->> 'contribution_id', message ->> 'recipe_id', message ->> 'source'
     from pgmq.q_household_events $$,
  $$ values ('items_added', '11111111-1111-1111-1111-111111111111', 'a4000000-0000-7000-8000-000000000011',
             'c0000000-0000-4000-8000-000000000001', 'recipe') $$,
  'the household''s "added" push is queued, from the sharer');

-- A retry after the commit ------------------------------------------------------------------------
select is(
  public.commit_share_import('f0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000009',
    $$ { "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "list_id": "a1000000-0000-7000-8000-000000000001",
         "list_gone": false, "recipe_id": "c0000000-0000-4000-8000-000000000001", "items_added": 1, "items_combined": 1 } $$,
    $$ [ { "op": "insert", "table": "list_item_contributions", "id": "a4000000-0000-7000-8000-000000000012",
           "fields": { "list_item_id": "a2000000-0000-7000-8000-000000000011", "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
                       "source": "recipe", "quantity": 2, "unit": "clove" } },
         { "op": "upsert", "table": "ingredient_usage", "key": { "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "ingredient_name": "test garlic" },
           "fields": {}, "counters": { "use_count": 1 } } ] $$,
    '[]'),
  (select private.share_import_receipt(s) from public.share_imports s where s.id = 'f0000000-0000-4000-8000-000000000001'),
  'a retry after the commit returns the stored receipt, whatever its lease');
select is(pg_temp.live_amounts('a2000000-0000-7000-8000-000000000011'), 'a4000000-0000-7000-8000-000000000011=2',
  'and adds nothing to the list');
select is((select use_count from public.ingredient_usage where household_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' and ingredient_name = 'test garlic'),
  1, 'nor counts again');
select is((select count(*)::int from private.user_activity), 1, 'nor logs again');

-- The lease ---------------------------------------------------------------------------------------
select pg_temp.job('f0000000-0000-4000-8000-000000000002', 'e0000000-0000-4000-8000-000000000002');
select throws_ok(
  $$ select public.commit_share_import('f0000000-0000-4000-8000-000000000002', 'e0000000-0000-4000-8000-000000000009',
       '{"household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "list_id": null, "recipe_id": "c0000000-0000-4000-8000-000000000002", "items_added": 0, "items_combined": 0}', '[]', '[]') $$,
  '55000', 'lease_lost', 'another lease can''t commit');
update public.share_imports set lease_expires_at = now() - interval '1 second' where id = 'f0000000-0000-4000-8000-000000000002';
select throws_ok(
  $$ select public.commit_share_import('f0000000-0000-4000-8000-000000000002', 'e0000000-0000-4000-8000-000000000002',
       '{"household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "list_id": null, "recipe_id": "c0000000-0000-4000-8000-000000000002", "items_added": 0, "items_combined": 0}', '[]', '[]') $$,
  '55000', 'lease_lost', 'nor an expired one');
update public.share_imports set lease_expires_at = now() + interval '2 minutes', status = 'extracted' where id = 'f0000000-0000-4000-8000-000000000002';
select throws_ok(
  $$ select public.commit_share_import('f0000000-0000-4000-8000-000000000002', 'e0000000-0000-4000-8000-000000000002',
       '{"household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "list_id": null, "recipe_id": "c0000000-0000-4000-8000-000000000002", "items_added": 0, "items_combined": 0}', '[]', '[]') $$,
  '55000', 'lease_lost', 'nor a job that isn''t committing');
update public.share_imports set status = 'committing' where id = 'f0000000-0000-4000-8000-000000000002';
select throws_ok(
  $$ select public.commit_share_import('f0000000-0000-4000-8000-000000000002', 'e0000000-0000-4000-8000-000000000002',
       '{"household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}', '[]', '[]') $$,
  '22023', 'invalid commit', 'a target without its receipt fields is refused');

-- Recipe-only with the list gone ------------------------------------------------------------------
select is(
  public.commit_share_import('f0000000-0000-4000-8000-000000000002', 'e0000000-0000-4000-8000-000000000002',
    $$ { "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "list_id": null, "list_gone": true,
         "recipe_id": "c0000000-0000-4000-8000-000000000002", "items_added": 0, "items_combined": 0 } $$,
    $$ [ { "op": "insert", "table": "recipes", "id": "c0000000-0000-4000-8000-000000000002",
           "fields": { "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "name": "Lemon pasta" } } ] $$,
    $$ [ { "kind": "recipeAbsent", "recipeId": "c0000000-0000-4000-8000-000000000002" } ] $$) - 'committed_at',
  '{"recipe_id": "c0000000-0000-4000-8000-000000000002", "applied_list_id": null, "list_gone": true, "items_added": 0, "items_combined": 0}'::jsonb,
  'a recipe-only commit with the list gone says so in its receipt');
select is((select data from private.user_activity where entity_id = 'c0000000-0000-4000-8000-000000000002'),
  '{"household": "Home", "recipe": "Lemon pasta", "recipe_id": "c0000000-0000-4000-8000-000000000002", "list": null, "items_added": 0, "items_combined": 0}'::jsonb,
  'and its activity entry has no list');

-- Destination changed -----------------------------------------------------------------------------
select pg_temp.job('f0000000-0000-4000-8000-000000000003', 'e0000000-0000-4000-8000-000000000003');
select throws_ok(
  $$ select public.commit_share_import('f0000000-0000-4000-8000-000000000003', 'e0000000-0000-4000-8000-000000000003',
       '{"household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "list_id": "a1000000-0000-7000-8000-000000000002", "recipe_id": "c0000000-0000-4000-8000-000000000003", "items_added": 0, "items_combined": 0}', '[]', '[]') $$,
  '40001', 'destination_changed', 'an archived list is a changed destination');
select throws_ok(
  $$ select public.commit_share_import('f0000000-0000-4000-8000-000000000003', 'e0000000-0000-4000-8000-000000000003',
       '{"household_id": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", "list_id": "a1000000-0000-7000-8000-000000000001", "recipe_id": "c0000000-0000-4000-8000-000000000003", "items_added": 0, "items_combined": 0}', '[]', '[]') $$,
  '40001', 'destination_changed', 'so is a household the sharer isn''t in, or a list outside it');

-- A removed member writes nothing.
select pg_temp.job('f0000000-0000-4000-8000-000000000004', 'e0000000-0000-4000-8000-000000000004', '33333333-3333-3333-3333-333333333333');
delete from public.household_members where user_id = '33333333-3333-3333-3333-333333333333';
select throws_ok(
  $$ select public.commit_share_import('f0000000-0000-4000-8000-000000000004', 'e0000000-0000-4000-8000-000000000004',
       '{"household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "list_id": null, "recipe_id": "c0000000-0000-4000-8000-000000000004", "items_added": 0, "items_combined": 0}',
       '[{"op": "insert", "table": "recipes", "id": "c0000000-0000-4000-8000-000000000004", "fields": {"household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "name": "Soup"}}]',
       '[{"kind": "recipeAbsent", "recipeId": "c0000000-0000-4000-8000-000000000004"}]') $$,
  '40001', 'destination_changed', 'a sharer removed from the household can''t commit');
select ok(not exists (select 1 from public.recipes where id = 'c0000000-0000-4000-8000-000000000004')
  and (select status from public.share_imports where id = 'f0000000-0000-4000-8000-000000000004') = 'committing',
  'and nothing is written');

-- Any rejected write rolls the whole commit back.
select throws_ok(
  $$ select public.commit_share_import('f0000000-0000-4000-8000-000000000003', 'e0000000-0000-4000-8000-000000000003',
       '{"household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "list_id": null, "recipe_id": "c0000000-0000-4000-8000-000000000003", "items_added": 0, "items_combined": 0}',
       '[{"op": "insert", "table": "recipes", "id": "c0000000-0000-4000-8000-000000000003", "fields": {"household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "name": "Stew"}},
         {"op": "insert", "table": "recipes", "id": "c0000000-0000-4000-8000-000000000033", "fields": {"household_id": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", "name": "Theirs"}}]',
       '[]') $$,
  '42501', null, 'a write apply_mutation rejects fails the commit');
select ok(not exists (select 1 from public.recipes where id in ('c0000000-0000-4000-8000-000000000003', 'c0000000-0000-4000-8000-000000000033'))
  and (select status from public.share_imports where id = 'f0000000-0000-4000-8000-000000000003') = 'committing',
  'with nothing written, not even the writes before it');
select throws_ok(
  $$ select public.commit_share_import('f0000000-0000-4000-8000-000000000003', 'e0000000-0000-4000-8000-000000000003',
       '{"household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "list_id": null, "recipe_id": "c0000000-0000-4000-8000-000000000003", "items_added": 0, "items_combined": 0}',
       '[{"op": "insert", "table": "lists", "id": "a1000000-0000-7000-8000-000000000099", "fields": {"household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "name": "X", "position": 9}}]',
       '[]') $$,
  '22023', 'share imports don''t write lists', 'a commit writes only what a share import plans');

-- Recipe preconditions.
select throws_ok(
  $$ select public.commit_share_import('f0000000-0000-4000-8000-000000000003', 'e0000000-0000-4000-8000-000000000003',
       '{"household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "list_id": null, "recipe_id": "c0000000-0000-4000-8000-000000000001", "items_added": 0, "items_combined": 0}',
       '[]', '[{"kind": "recipeAbsent", "recipeId": "c0000000-0000-4000-8000-000000000001"}]') $$,
  '40001', 'plan_conflict', 'a recipe planned as new that exists by then is a conflict');
update public.recipes set deleted_at = now() where id = 'c0000000-0000-4000-8000-000000000002';
select throws_ok(
  $$ select public.commit_share_import('f0000000-0000-4000-8000-000000000003', 'e0000000-0000-4000-8000-000000000003',
       '{"household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "list_id": null, "recipe_id": "c0000000-0000-4000-8000-000000000002", "items_added": 0, "items_combined": 0}',
       '[]', '[{"kind": "recipeReuse", "recipeId": "c0000000-0000-4000-8000-000000000002"}]') $$,
  '40001', 'plan_conflict', 'so is a reused recipe deleted by then');
select throws_ok(
  $$ select public.commit_share_import('f0000000-0000-4000-8000-000000000003', 'e0000000-0000-4000-8000-000000000003',
       '{"household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "list_id": null, "recipe_id": "c0000000-0000-4000-8000-000000000002", "items_added": 0, "items_combined": 0}',
       '[]', '[{"kind": "recipeAbsent", "recipeId": "c0000000-0000-4000-8000-000000000002"}]') $$,
  '40001', 'plan_conflict', 'and a deleted recipe still takes its id');

-- An item checked between plan and commit: the replan reopens it ----------------------------------
select pg_temp.job('f0000000-0000-4000-8000-000000000005', 'e0000000-0000-4000-8000-000000000005');
-- Planned: Combine into the open lime. Then Sam checks it off, with a clock running far ahead.
select is(pg_temp.as_sam($$ [ { "table": "list_items", "id": "a2000000-0000-7000-8000-000000000001", "hlc": "2900000000000-0000-sam1",
    "fields": { "checked_at": "2026-10-23T09:59:00.000Z", "checked_by": "22222222-2222-2222-2222-222222222222" } } ] $$),
  '[{"status": "applied"}]'::jsonb, 'Sam checks off the lime');
select throws_ok(
  $$ select public.commit_share_import('f0000000-0000-4000-8000-000000000005', 'e0000000-0000-4000-8000-000000000005',
       '{"household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "list_id": "a1000000-0000-7000-8000-000000000001", "recipe_id": "c0000000-0000-4000-8000-000000000001", "items_added": 1, "items_combined": 1}',
       '[{"op": "insert", "table": "list_item_contributions", "id": "a4000000-0000-7000-8000-000000000051", "fields": {"list_item_id": "a2000000-0000-7000-8000-000000000001", "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "source": "recipe", "quantity": 2, "unit": null}}]',
       '[{"kind": "recipeReuse", "recipeId": "c0000000-0000-4000-8000-000000000001"}, {"kind": "combine", "itemId": "a2000000-0000-7000-8000-000000000001"}]') $$,
  '40001', 'plan_conflict', 'the import planned to Combine into an item checked since: a conflict');
select is(pg_temp.live_amounts('a2000000-0000-7000-8000-000000000001'), 'a4000000-0000-7000-8000-000000000001=1',
  'that adds nothing to the checked item');
-- Replanned from a fresh snapshot: reopen with the recipe's amount (spec 4.4).
select is(
  public.commit_share_import('f0000000-0000-4000-8000-000000000005', 'e0000000-0000-4000-8000-000000000005',
    '{"household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "list_id": "a1000000-0000-7000-8000-000000000001", "recipe_id": "c0000000-0000-4000-8000-000000000001", "items_added": 1, "items_combined": 0}',
    '[{"op": "update", "table": "list_item_contributions", "id": "a4000000-0000-7000-8000-000000000001", "fields": {"deleted_at": "2026-10-23T10:00:00.000Z"}},
      {"op": "update", "table": "list_items", "id": "a2000000-0000-7000-8000-000000000001", "fields": {"checked_at": null, "checked_by": null}},
      {"op": "insert", "table": "list_item_contributions", "id": "a4000000-0000-7000-8000-000000000051", "fields": {"list_item_id": "a2000000-0000-7000-8000-000000000001", "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "source": "recipe", "quantity": 2, "unit": null}}]',
    '[{"kind": "recipeReuse", "recipeId": "c0000000-0000-4000-8000-000000000001"},
      {"kind": "reopen", "itemId": "a2000000-0000-7000-8000-000000000001", "checkedAt": "2026-10-23T09:59:00.000Z", "contributionIds": ["a4000000-0000-7000-8000-000000000001"]}]') ->> 'items_added',
  '1', 'the replan reopens it');
select is((select checked_at from public.list_items where id = 'a2000000-0000-7000-8000-000000000001'), null,
  'the item is open again, the server''s clock past the device''s');
select ok((select field_clock ->> 'checked_at' from public.list_items where id = 'a2000000-0000-7000-8000-000000000001')
  = '2900000000001-0001-srv', 'its HLC is one past the largest it touched, with the write''s index');
select is(pg_temp.live_amounts('a2000000-0000-7000-8000-000000000001'), 'a4000000-0000-7000-8000-000000000051=2',
  'with only the recipe''s amount');

-- An item reopened and added to meanwhile keeps the new amount ------------------------------------
select pg_temp.job('f0000000-0000-4000-8000-000000000006', 'e0000000-0000-4000-8000-000000000006');
-- Planned: reopen the checked onion (3). Then Sam reopens it with 5 of their own.
select is(pg_temp.as_sam($$ [
    { "table": "list_item_contributions", "id": "a4000000-0000-7000-8000-000000000002", "hlc": "1770000000100-0000-sam1", "fields": { "deleted_at": "2026-10-23T09:59:00Z" } },
    { "table": "list_items", "id": "a2000000-0000-7000-8000-000000000002", "hlc": "1770000000100-0001-sam1", "fields": { "checked_at": null, "checked_by": null } },
    { "table": "list_item_contributions", "id": "a4000000-0000-7000-8000-000000000061", "hlc": "1770000000100-0002-sam1",
      "fields": { "list_item_id": "a2000000-0000-7000-8000-000000000002", "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "source": "manual", "quantity": 5 } } ] $$),
  '[{"status": "applied"}, {"status": "applied"}, {"status": "applied"}]'::jsonb, 'Sam reopens the onion and adds 5');
select throws_ok(
  $$ select public.commit_share_import('f0000000-0000-4000-8000-000000000006', 'e0000000-0000-4000-8000-000000000006',
       '{"household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "list_id": "a1000000-0000-7000-8000-000000000001", "recipe_id": "c0000000-0000-4000-8000-000000000001", "items_added": 1, "items_combined": 0}',
       '[{"op": "update", "table": "list_item_contributions", "id": "a4000000-0000-7000-8000-000000000002", "fields": {"deleted_at": "2026-10-23T10:00:00.000Z"}},
         {"op": "update", "table": "list_items", "id": "a2000000-0000-7000-8000-000000000002", "fields": {"checked_at": null, "checked_by": null}},
         {"op": "insert", "table": "list_item_contributions", "id": "a4000000-0000-7000-8000-000000000062", "fields": {"list_item_id": "a2000000-0000-7000-8000-000000000002", "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "source": "recipe", "quantity": 1}}]',
       '[{"kind": "reopen", "itemId": "a2000000-0000-7000-8000-000000000002", "checkedAt": "2026-10-20T10:00:00.123Z", "contributionIds": ["a4000000-0000-7000-8000-000000000002"]}]') $$,
  '40001', 'plan_conflict', 'reopening an item reopened since is a conflict');
select lives_ok(
  $$ select public.commit_share_import('f0000000-0000-4000-8000-000000000006', 'e0000000-0000-4000-8000-000000000006',
       '{"household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "list_id": "a1000000-0000-7000-8000-000000000001", "recipe_id": "c0000000-0000-4000-8000-000000000001", "items_added": 1, "items_combined": 1}',
       '[{"op": "insert", "table": "list_item_contributions", "id": "a4000000-0000-7000-8000-000000000062", "fields": {"list_item_id": "a2000000-0000-7000-8000-000000000002", "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "source": "recipe", "quantity": 1}}]',
       '[{"kind": "combine", "itemId": "a2000000-0000-7000-8000-000000000002"}]') $$,
  'the replan Combines into it');
select is(pg_temp.live_amounts('a2000000-0000-7000-8000-000000000002'),
  'a4000000-0000-7000-8000-000000000061=5,a4000000-0000-7000-8000-000000000062=1',
  'keeping Sam''s new amount, the import''s on top');

-- A device amount edit at the same moment: both survive -------------------------------------------
select pg_temp.job('f0000000-0000-4000-8000-000000000007', 'e0000000-0000-4000-8000-000000000007');
-- Planned: Combine 1 into the leek (2). Sam changes the 2 to 4 before the commit.
select is(pg_temp.as_sam($$ [ { "table": "list_item_contributions", "id": "a4000000-0000-7000-8000-000000000003", "hlc": "1770000000200-0000-sam1",
    "fields": { "quantity": 4 } } ] $$), '[{"status": "applied"}]'::jsonb, 'Sam edits the leek''s amount');
select lives_ok(
  $$ select public.commit_share_import('f0000000-0000-4000-8000-000000000007', 'e0000000-0000-4000-8000-000000000007',
       '{"household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "list_id": "a1000000-0000-7000-8000-000000000001", "recipe_id": "c0000000-0000-4000-8000-000000000001", "items_added": 1, "items_combined": 1}',
       '[{"op": "insert", "table": "list_item_contributions", "id": "a4000000-0000-7000-8000-000000000071", "fields": {"list_item_id": "a2000000-0000-7000-8000-000000000003", "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "source": "recipe", "quantity": 1}}]',
       '[{"kind": "combine", "itemId": "a2000000-0000-7000-8000-000000000003"}]') $$,
  'the import still Combines (the item is open)');
-- And one made after the commit, from a device that hadn't seen it.
select is(pg_temp.as_sam($$ [ { "table": "list_item_contributions", "id": "a4000000-0000-7000-8000-000000000003", "hlc": "1770000000300-0000-sam1",
    "fields": { "quantity": 6 } } ] $$), '[{"status": "applied"}]'::jsonb, 'Sam edits it again after the commit');
select is(pg_temp.live_amounts('a2000000-0000-7000-8000-000000000003'),
  'a4000000-0000-7000-8000-000000000003=6,a4000000-0000-7000-8000-000000000071=1',
  'the edit and the import both survive, the import''s amount on top');

-- Two imports into one list with a shared ingredient ----------------------------------------------
select pg_temp.job('f0000000-0000-4000-8000-000000000008', 'e0000000-0000-4000-8000-000000000008');
select pg_temp.job('f0000000-0000-4000-8000-000000000009', 'e0000000-0000-4000-8000-000000000009');
-- Both planned from the same snapshot: basil is new.
select lives_ok(
  $$ select public.commit_share_import('f0000000-0000-4000-8000-000000000008', 'e0000000-0000-4000-8000-000000000008',
       '{"household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "list_id": "a1000000-0000-7000-8000-000000000001", "recipe_id": "c0000000-0000-4000-8000-000000000001", "items_added": 1, "items_combined": 0}',
       '[{"op": "insert", "table": "list_items", "id": "a2000000-0000-7000-8000-000000000081", "fields": {"list_id": "a1000000-0000-7000-8000-000000000001", "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "ingredient_name": "test basil", "display_name": "basil"}},
         {"op": "insert", "table": "list_item_contributions", "id": "a4000000-0000-7000-8000-000000000081", "fields": {"list_item_id": "a2000000-0000-7000-8000-000000000081", "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "source": "recipe", "quantity": 1, "unit": "bunch"}}]',
       '[{"kind": "new", "listId": "a1000000-0000-7000-8000-000000000001", "key": "test basil"}]') $$,
  'the first import adds basil');
select throws_ok(
  $$ select public.commit_share_import('f0000000-0000-4000-8000-000000000009', 'e0000000-0000-4000-8000-000000000009',
       '{"household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "list_id": "a1000000-0000-7000-8000-000000000001", "recipe_id": "c0000000-0000-4000-8000-000000000001", "items_added": 1, "items_combined": 0}',
       '[{"op": "insert", "table": "list_items", "id": "a2000000-0000-7000-8000-000000000091", "fields": {"list_id": "a1000000-0000-7000-8000-000000000001", "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "ingredient_name": "test basil", "display_name": "basil"}},
         {"op": "insert", "table": "list_item_contributions", "id": "a4000000-0000-7000-8000-000000000091", "fields": {"list_item_id": "a2000000-0000-7000-8000-000000000091", "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "source": "recipe", "quantity": 2, "unit": "bunch"}}]',
       '[{"kind": "new", "listId": "a1000000-0000-7000-8000-000000000001", "key": "test basil"}]') $$,
  '40001', 'plan_conflict', 'the second, planned as new too, conflicts');
select lives_ok(
  $$ select public.commit_share_import('f0000000-0000-4000-8000-000000000009', 'e0000000-0000-4000-8000-000000000009',
       '{"household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "list_id": "a1000000-0000-7000-8000-000000000001", "recipe_id": "c0000000-0000-4000-8000-000000000001", "items_added": 1, "items_combined": 1}',
       '[{"op": "insert", "table": "list_item_contributions", "id": "a4000000-0000-7000-8000-000000000091", "fields": {"list_item_id": "a2000000-0000-7000-8000-000000000081", "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "source": "recipe", "quantity": 2, "unit": "bunch"}}]',
       '[{"kind": "combine", "itemId": "a2000000-0000-7000-8000-000000000081"}]') $$,
  'and its replan Combines into the first''s item');
select is(
  (select count(*)::int from public.list_items where list_id = 'a1000000-0000-7000-8000-000000000001' and ingredient_name = 'test basil' and deleted_at is null),
  1, 'one basil on the list');
select is(pg_temp.live_amounts('a2000000-0000-7000-8000-000000000081'),
  'a4000000-0000-7000-8000-000000000081=1,a4000000-0000-7000-8000-000000000091=2', 'with both imports'' amounts');
-- A checked item with the key counts too (the planner reopens it, never adds a second).
update public.list_items set checked_at = now() where id = 'a2000000-0000-7000-8000-000000000081';
select throws_ok(
  $$ select public.commit_share_import('f0000000-0000-4000-8000-000000000003', 'e0000000-0000-4000-8000-000000000003',
       '{"household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "list_id": "a1000000-0000-7000-8000-000000000001", "recipe_id": "c0000000-0000-4000-8000-000000000001", "items_added": 0, "items_combined": 0}',
       '[]', '[{"kind": "new", "listId": "a1000000-0000-7000-8000-000000000001", "key": "test basil"}]') $$,
  '40001', 'plan_conflict', 'new conflicts with a checked item of the key as well');

select * from finish();
rollback;
