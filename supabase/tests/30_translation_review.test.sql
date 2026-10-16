-- Reviewing the model's translations (spec 4.15, 5): ingredients.reviewed_at, null until a person
-- reviews the name (yarn ai:translations --mark-reviewed). Clients read it with the catalog and
-- can't write it.
begin;
create extension if not exists pgtap with schema extensions;
select plan(5);

select has_column('public', 'ingredients', 'reviewed_at', 'ingredients has reviewed_at');
select col_type_is('public', 'ingredients', 'reviewed_at', 'timestamp with time zone', 'reviewed_at is a timestamptz');
select col_is_null('public', 'ingredients', 'reviewed_at', 'reviewed_at is nullable');
select is((select count(*)::int from public.ingredients where reviewed_at is not null), 0, 'no name starts reviewed, seed included');
select ok(not has_table_privilege('authenticated', 'public.ingredients', 'UPDATE'), 'clients can''t mark a name reviewed');

select * from finish();
rollback;
