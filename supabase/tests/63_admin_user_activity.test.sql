-- Reading a user's activity (spec 4.12 User activity): admin_user_activity (the three sources, filters,
-- counts, paging, invited_email, the view_user_activity audit) and admin_user_detail's last_active_at.
begin;
create extension if not exists pgtap with schema extensions;
select plan(50);

-- Fixtures (as postgres, no user, so nothing is logged) ------------------------------------------
-- Boss is an admin. Uma is the user we read; Otto has only an AI call; Nell has nothing.
insert into auth.users (id, email, aud, role) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'boss@ua.test', 'authenticated', 'authenticated'),
  ('11111111-1111-1111-1111-111111111111', 'uma@ua.test', 'authenticated', 'authenticated'),
  ('22222222-2222-2222-2222-222222222222', 'otto@ua.test', 'authenticated', 'authenticated'),
  ('33333333-3333-3333-3333-333333333333', 'nell@ua.test', 'authenticated', 'authenticated');
insert into private.admins (user_id) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
insert into public.households (id, name) values
  ('d1000000-0000-0000-0000-000000000001', 'Home Now'),
  ('d2000000-0000-0000-0000-000000000002', 'Cabin');
insert into public.household_invites (id, household_id, token_hash, expires_at, invited_email) values
  ('c1000000-0000-0000-0000-000000000001', 'd1000000-0000-0000-0000-000000000001', 'hash-ua-1',
   now() + interval '7 days', 'guest@ua.test');
delete from private.user_activity;
delete from admin.admin_actions;
delete from public.ai_calls;

-- Uma's entries, newest first (label: time before now):
--   e1 -10m app item.checked (Home) · x2 -10m admin view_ai_call · a1 -15m ai importRecipe (Home)
--   e2 -20m app recipe.created (Home) · x1 -25m admin set_household_plan (Home)
--   e3 -30m app invite.created (Home, invite exists) · e4 -40m app invite.created (invite gone)
--   e5 -50m app settings.default_list (no household) · i1, i2, i3 -60m app ingredient.added (Cabin, one txid)
--   e6 -5d app plan.added (Home)
insert into private.user_activity (user_id, household_id, created_at, txid, area, action, entity_id, data) values
  ('11111111-1111-1111-1111-111111111111', 'd1000000-0000-0000-0000-000000000001', now() - interval '5 days', 6,
   'plan', 'plan.added', 'e6', '{"household":"Home","date":"2026-11-03","meal":"dinner","kind":"recipe"}'),
  ('11111111-1111-1111-1111-111111111111', 'd2000000-0000-0000-0000-000000000002', now() - interval '60 minutes', 5,
   'recipes', 'ingredient.added', 'i1', '{"household":"Cabin","recipe":"Lasagna","ingredient":"Flour"}'),
  ('11111111-1111-1111-1111-111111111111', 'd2000000-0000-0000-0000-000000000002', now() - interval '60 minutes', 5,
   'recipes', 'ingredient.added', 'i2', '{"household":"Cabin","recipe":"Lasagna","ingredient":"Milk"}'),
  ('11111111-1111-1111-1111-111111111111', 'd2000000-0000-0000-0000-000000000002', now() - interval '60 minutes', 5,
   'recipes', 'ingredient.added', 'i3', '{"household":"Cabin","recipe":"Lasagna","ingredient":"Eggs"}'),
  ('11111111-1111-1111-1111-111111111111', null, now() - interval '50 minutes', 4,
   'settings', 'settings.default_list', 'e5', '{"list":"Groceries"}'),
  ('11111111-1111-1111-1111-111111111111', 'd1000000-0000-0000-0000-000000000001', now() - interval '40 minutes', 3,
   'household', 'invite.created', 'c2000000-0000-0000-0000-000000000002',
   '{"household":"Home","invite_id":"c2000000-0000-0000-0000-000000000002"}'),
  ('11111111-1111-1111-1111-111111111111', 'd1000000-0000-0000-0000-000000000001', now() - interval '30 minutes', 2,
   'household', 'invite.created', 'c1000000-0000-0000-0000-000000000001',
   '{"household":"Home","invite_id":"c1000000-0000-0000-0000-000000000001"}'),
  ('11111111-1111-1111-1111-111111111111', 'd1000000-0000-0000-0000-000000000001', now() - interval '20 minutes', 1,
   'recipes', 'recipe.created', 'e2', '{"household":"Home","recipe":"Lasagna","source":"manual"}'),
  ('11111111-1111-1111-1111-111111111111', 'd1000000-0000-0000-0000-000000000001', now() - interval '10 minutes', 7,
   'lists', 'item.checked', 'e1', '{"household":"Home","list":"Groceries","item":"Cucumber"}');

insert into public.ai_calls (id, created_at, task, model, prompt_version, status, instructions, prompt,
                             duration_ms, user_id, household_id) values
  ('a1000000-0000-0000-0000-000000000001', now() - interval '15 minutes', 'importRecipe', 'mock:mock', 'v1', 'refused',
   'secret instructions', 'secret prompt', 10, '11111111-1111-1111-1111-111111111111', 'd1000000-0000-0000-0000-000000000001'),
  ('a2000000-0000-0000-0000-000000000002', now() - interval '3 minutes', 'categorize', 'mock:mock', 'v1', 'ok',
   'i', 'p', 10, '22222222-2222-2222-2222-222222222222', null);

insert into admin.admin_actions (id, action, target_user_id, target_household_id, details, note, performed_by, created_at) values
  ('b1000000-0000-0000-0000-000000000001', 'set_household_plan', '11111111-1111-1111-1111-111111111111',
   'd1000000-0000-0000-0000-000000000001', '{"from":"free","to":"founding"}', 'asked by email',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', now() - interval '25 minutes'),
  ('b2000000-0000-0000-0000-000000000002', 'view_ai_call', '11111111-1111-1111-1111-111111111111',
   null, '{"ai_call_id":"a1000000-0000-0000-0000-000000000001"}', null, 'postgres', now() - interval '10 minutes'),
  -- About a user who no longer exists.
  ('b3000000-0000-0000-0000-000000000003', 'delete_user', '99999999-9999-9999-9999-999999999999',
   null, '{}', 'gone', 'postgres', now() - interval '2 days');

-- Labels for entity ids, so a page reads as a list of labels.
create temporary table labels (entity_id text primary key, label text);
insert into labels values
  ('e1', 'e1'), ('e2', 'e2'), ('e5', 'e5'), ('e6', 'e6'), ('i1', 'i1'), ('i2', 'i2'), ('i3', 'i3'),
  ('c1000000-0000-0000-0000-000000000001', 'e3'), ('c2000000-0000-0000-0000-000000000002', 'e4'),
  ('a1000000-0000-0000-0000-000000000001', 'a1'),
  ('b1000000-0000-0000-0000-000000000001', 'x1'), ('b2000000-0000-0000-0000-000000000002', 'x2'),
  ('b3000000-0000-0000-0000-000000000003', 'x3');

-- Helpers ------------------------------------------------------------------------------------------
-- As Boss: clears earlier audit rows (so they don't show up as entries), then reads Uma's activity.
create function pg_temp.ua(
  p_areas text[] default null, p_actions text[] default null, p_household uuid default null,
  p_from timestamptz default null, p_to timestamptz default null, p_before timestamptz default null,
  p_limit integer default 100, p_user uuid default '11111111-1111-1111-1111-111111111111'
) returns jsonb language plpgsql as $$
begin
  delete from admin.admin_actions where action = 'view_user_activity';
  perform set_config('request.jwt.claims',
    '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","role":"authenticated"}', true);
  return public.admin_user_activity(p_user, p_areas, p_actions, p_household, p_from, p_to, p_before, p_limit);
end;
$$;
-- A page's entries as labels, in order.
create function pg_temp.labels(p jsonb) returns text[] language sql as $$
  select coalesce(array_agg(coalesce(l.label, e.v ->> 'entity_id') order by e.n), '{}')
  from jsonb_array_elements(p -> 'entries') with ordinality e (v, n)
  left join labels l on l.entity_id = e.v ->> 'entity_id'
$$;
-- One entry by label.
create function pg_temp.entry(p jsonb, p_label text) returns jsonb language sql as $$
  select e from jsonb_array_elements(p -> 'entries') e
  join labels l on l.entity_id = e ->> 'entity_id' and l.label = p_label
$$;

-- Privileges and refusals ------------------------------------------------------------------------
select ok(
  not has_function_privilege('anon', 'public.admin_user_activity(uuid, text[], text[], uuid, timestamptz, timestamptz, timestamptz, integer)', 'execute')
  and not has_function_privilege('service_role', 'public.admin_user_activity(uuid, text[], text[], uuid, timestamptz, timestamptz, timestamptz, integer)', 'execute'),
  'anon and service_role can''t execute admin_user_activity');
select ok(has_function_privilege('authenticated', 'public.admin_user_activity(uuid, text[], text[], uuid, timestamptz, timestamptz, timestamptz, integer)', 'execute'),
  'authenticated can execute it (require_admin decides)');
select ok(not has_function_privilege('authenticated', 'private.user_activity_rows(uuid, uuid, timestamptz, timestamptz)', 'execute'),
  'the rows function isn''t executable by clients');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
select throws_ok($$ select public.admin_user_activity('11111111-1111-1111-1111-111111111111') $$,
  '42501', 'not authorized', 'a non-admin is refused');
select throws_ok($$ select public.admin_user_detail('11111111-1111-1111-1111-111111111111') $$,
  '42501', 'not authorized', 'a non-admin is refused admin_user_detail');
set local role anon;
select throws_ok($$ select public.admin_user_activity('11111111-1111-1111-1111-111111111111') $$,
  '42501', null, 'anon is refused');
reset role;
select is((select count(*)::int from admin.admin_actions where action = 'view_user_activity'), 0,
  'a refused call writes no audit row');

-- As an admin through PostgREST's role ----------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","role":"authenticated"}', true);
select is(jsonb_array_length(public.admin_user_activity('11111111-1111-1111-1111-111111111111') -> 'entries'), 12,
  'an admin signed in as authenticated reads every entry');
reset role;

-- Merge and order ----------------------------------------------------------------------------------
create temporary table r (k text primary key, v jsonb);
insert into r values ('all', pg_temp.ua());
select is(pg_temp.labels((select v from r where k = 'all')),
  array['e1', 'x2', 'a1', 'e2', 'x1', 'e3', 'e4', 'e5', 'i3', 'i2', 'i1', 'e6'],
  'the three sources merge newest first; at one time app comes before admin, newer app entries first');
select is((select v -> 'next_before' from r where k = 'all'), 'null'::jsonb, 'next_before is null at the end');
select is((select count(*)::int from jsonb_array_elements((select v -> 'entries' from r where k = 'all')) e
           where e ->> 'source' = 'app'), 9, 'nine app entries');

-- The audit: one row for a first page ----------------------------------------------------------------
select is((select count(*)::int from admin.admin_actions where action = 'view_user_activity'), 1,
  'a first page writes one view_user_activity row');
select is(
  (select jsonb_build_object('target', target_user_id, 'household', target_household_id, 'note', note,
                             'by', performed_by, 'details', details)
   from admin.admin_actions where action = 'view_user_activity'),
  jsonb_build_object('target', '11111111-1111-1111-1111-111111111111', 'household', null, 'note', null,
                     'by', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
                     'details', '{"areas":null,"actions":null,"household_id":null,"from":null,"to":null}'::jsonb),
  'the audit row names the user and the admin, with the filters and no note');

-- Entry shapes -------------------------------------------------------------------------------------
select is(pg_temp.entry((select v from r where k = 'all'), 'e1'),
  jsonb_build_object('at', now() - interval '10 minutes', 'source', 'app', 'area', 'lists', 'action', 'item.checked',
    'entity_id', 'e1', 'household_id', 'd1000000-0000-0000-0000-000000000001', 'household', 'Home', 'txid', 7,
    'data', '{"household":"Home","list":"Groceries","item":"Cucumber"}'::jsonb),
  'an app entry: its row, with the household''s name as it was then');
select is(pg_temp.entry((select v from r where k = 'all'), 'e5') -> 'household', 'null'::jsonb,
  'a per-user entry has no household');
select is(pg_temp.entry((select v from r where k = 'all'), 'a1'),
  jsonb_build_object('at', now() - interval '15 minutes', 'source', 'ai', 'area', 'ai', 'action', 'ai.importRecipe',
    'entity_id', 'a1000000-0000-0000-0000-000000000001', 'household_id', 'd1000000-0000-0000-0000-000000000001',
    'household', 'Home Now', 'txid', null,
    'data', jsonb_build_object('id', 'a1000000-0000-0000-0000-000000000001', 'status', 'refused', 'flag', 'refused',
                               'recipe_id', null)),
  'an AI entry: ai.<task>, the household''s current name, { id, status, flag, recipe_id } and no prompt');
select is(pg_temp.entry((select v from r where k = 'all'), 'x1'),
  jsonb_build_object('at', now() - interval '25 minutes', 'source', 'admin', 'area', 'admin',
    'action', 'admin.set_household_plan', 'entity_id', 'b1000000-0000-0000-0000-000000000001',
    'household_id', 'd1000000-0000-0000-0000-000000000001', 'household', 'Home Now', 'txid', null,
    'data', jsonb_build_object('details', '{"from":"free","to":"founding"}'::jsonb, 'note', 'asked by email',
                               'performed_by_email', 'boss@ua.test')),
  'an admin entry: admin.<action>, { details, note, performed_by_email }');
select is(pg_temp.entry((select v from r where k = 'all'), 'x2') -> 'data' -> 'performed_by_email', 'null'::jsonb,
  'an admin row from the dashboard has no performer email');

-- invited_email ------------------------------------------------------------------------------------
select is(pg_temp.entry((select v from r where k = 'all'), 'e3') -> 'data',
  '{"household":"Home","invite_id":"c1000000-0000-0000-0000-000000000001","invited_email":"guest@ua.test"}'::jsonb,
  'an invite''s email shows while the invite exists');
select is(pg_temp.entry((select v from r where k = 'all'), 'e4') -> 'data' -> 'invited_email', 'null'::jsonb,
  'an invite that''s gone has a null email');
select ok(not exists (select 1 from private.user_activity where data::text like '%guest@ua.test%'),
  'the email isn''t copied into the log');
delete from public.household_invites where id = 'c1000000-0000-0000-0000-000000000001';
select is(pg_temp.entry(pg_temp.ua(), 'e3') -> 'data' -> 'invited_email', 'null'::jsonb,
  'once the invite is deleted its email no longer shows');
select is(pg_temp.entry(pg_temp.ua(), 'e1') -> 'data' -> 'invited_email', null,
  'other entries get no invited_email key');

-- Counts -------------------------------------------------------------------------------------------
select is((select v -> 'counts' from r where k = 'all'),
  '{"lists":1,"recipes":4,"plan":1,"aisles":0,"household":2,"settings":1,"devices":0,"ai":1,"admin":2}'::jsonb,
  'counts per area, every area, zeros included');
select is(pg_temp.ua(p_areas => array['recipes'], p_actions => array['recipe.created']) -> 'counts',
  '{"lists":1,"recipes":4,"plan":1,"aisles":0,"household":2,"settings":1,"devices":0,"ai":1,"admin":2}'::jsonb,
  'counts ignore p_areas and p_actions');
select is(pg_temp.ua(p_household => 'd2000000-0000-0000-0000-000000000002') -> 'counts',
  '{"lists":0,"recipes":3,"plan":0,"aisles":0,"household":0,"settings":0,"devices":0,"ai":0,"admin":0}'::jsonb,
  'counts follow the household');
select is(pg_temp.ua(p_from => now() - interval '35 minutes', p_to => now() - interval '12 minutes') -> 'counts',
  '{"lists":0,"recipes":1,"plan":0,"aisles":0,"household":1,"settings":0,"devices":0,"ai":1,"admin":1}'::jsonb,
  'counts follow the dates');
select is(pg_temp.ua(p_before => now() - interval '45 minutes') -> 'counts',
  '{"lists":1,"recipes":4,"plan":1,"aisles":0,"household":2,"settings":1,"devices":0,"ai":1,"admin":2}'::jsonb,
  'counts ignore p_before');

-- Filters ------------------------------------------------------------------------------------------
select is(pg_temp.labels(pg_temp.ua(p_areas => array['recipes'])), array['e2', 'i3', 'i2', 'i1'],
  'p_areas: one area');
select is(pg_temp.labels(pg_temp.ua(p_areas => array['ai', 'admin'])), array['x2', 'a1', 'x1'],
  'p_areas takes ai and admin');
select is(pg_temp.labels(pg_temp.ua(p_actions => array['invite.created'])), array['e3', 'e4'],
  'p_actions: an app action');
select is(pg_temp.labels(pg_temp.ua(p_actions => array['admin.set_household_plan', 'ai.importRecipe'])), array['a1', 'x1'],
  'p_actions: ai and admin actions by their full names');
select is(pg_temp.labels(pg_temp.ua(p_household => 'd1000000-0000-0000-0000-000000000001')),
  array['e1', 'a1', 'e2', 'x1', 'e3', 'e4', 'e6'],
  'p_household_id: entries of that household from all three sources');
select is(pg_temp.labels(pg_temp.ua(p_from => now() - interval '20 minutes', p_to => now() - interval '10 minutes')),
  array['a1', 'e2'], 'p_from is inclusive, p_to exclusive');
select is(pg_temp.labels(pg_temp.ua(p_areas => array['household'], p_household => 'd1000000-0000-0000-0000-000000000001',
                                    p_from => now() - interval '35 minutes')),
  array['e3'], 'the filters combine');
select is(pg_temp.labels(pg_temp.ua(p_areas => array['devices'])), '{}'::text[], 'an area with nothing is empty');

-- Paging -------------------------------------------------------------------------------------------
create temporary table pages (n integer primary key, v jsonb);
do $$
declare
  v_before timestamptz;
  v_page jsonb;
  v_n integer := 0;
begin
  loop
    v_n := v_n + 1;
    v_page := pg_temp.ua(p_before => v_before, p_limit => 2);
    insert into pages values (v_n, v_page);
    exit when v_page ->> 'next_before' is null or v_n > 20;
    v_before := (v_page ->> 'next_before')::timestamptz;
  end loop;
end;
$$;
select is((select array_agg(l order by p.n, l.o) from pages p, unnest(pg_temp.labels(p.v)) with ordinality l (l, o)),
  array['e1', 'x2', 'a1', 'e2', 'x1', 'e3', 'e4', 'e5', 'i3', 'i2', 'i1', 'e6'],
  'paging by 2 returns every entry once, in order');
select is((select array_agg(cardinality(pg_temp.labels(v)) order by n) from pages), array[2, 2, 2, 2, 3, 1],
  'a timestamp that fills a page comes back whole');
select is((select v -> 'next_before' from pages where n = 1), to_jsonb(now() - interval '10 minutes'),
  'next_before is the page''s oldest time');
select is(pg_temp.labels(pg_temp.ua(p_before => now() - interval '45 minutes', p_limit => 2)), array['e5'],
  'a page stops before a timestamp the limit would split');
select is(pg_temp.ua(p_before => now() - interval '45 minutes', p_limit => 2) -> 'next_before',
  to_jsonb(now() - interval '50 minutes'), 'and the next page starts at it');
select is(pg_temp.labels(pg_temp.ua(p_before => now() - interval '45 minutes', p_limit => 500)),
  array['e5', 'i3', 'i2', 'i1', 'e6'], 'the limit is capped, not refused');

-- Audit: later pages write nothing; a filtered first page writes one --------------------------------
select pg_temp.ua(p_before => now() - interval '12 minutes');
select is((select count(*)::int from admin.admin_actions where action = 'view_user_activity'), 0,
  'a later page writes no audit row');
select pg_temp.ua(p_areas => array['lists'], p_household => 'd1000000-0000-0000-0000-000000000001');
select is((select details from admin.admin_actions where action = 'view_user_activity'),
  '{"areas":["lists"],"actions":null,"household_id":"d1000000-0000-0000-0000-000000000001","from":null,"to":null}'::jsonb,
  'a filtered first page writes one row with its filters');

-- Unknown and deleted users ------------------------------------------------------------------------
select is(pg_temp.ua(p_user => '88888888-8888-8888-8888-888888888888') -> 'entries', '[]'::jsonb,
  'an unknown user returns no entries, not an error');
select is(pg_temp.labels(pg_temp.ua(p_user => '99999999-9999-9999-9999-999999999999')), array['x3'],
  'a deleted user''s admin rows are still listed');

-- last_active_at ----------------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","role":"authenticated"}', true);
select is((public.admin_user_detail('11111111-1111-1111-1111-111111111111') ->> 'last_active_at')::timestamptz,
  now() - interval '10 minutes', 'last_active_at is the newest app or AI entry (admin rows don''t count)');
select is((public.admin_user_detail('22222222-2222-2222-2222-222222222222') ->> 'last_active_at')::timestamptz,
  now() - interval '3 minutes', 'an AI call alone counts');
select is(public.admin_user_detail('33333333-3333-3333-3333-333333333333') -> 'last_active_at', 'null'::jsonb,
  'null with neither');
select ok(public.admin_user_detail('11111111-1111-1111-1111-111111111111') ?& array['user_id', 'email', 'display_name',
  'created_at', 'last_sign_in_at', 'households', 'ai_flags', 'ai_photo_block', 'ai_photo_refusals_30d'],
  'admin_user_detail keeps every field it had');

select * from finish();
rollback;
