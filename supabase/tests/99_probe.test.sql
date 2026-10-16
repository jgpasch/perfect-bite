-- DELETE THIS FILE. A throwaway probe from the "Alex is adding" session (it read the local
-- realtime.messages schema), which that session wasn't allowed to remove. It tests nothing.
begin;
create extension if not exists pgtap with schema extensions;
select plan(1);
select pass('leftover probe: delete supabase/tests/99_probe.test.sql');
select * from finish();
rollback;
