begin;
create extension if not exists pgtap with schema extensions;
select plan(1);
select diag((select string_agg(name || ':' || coalesce(installed_version,'-'), ', ') from pg_available_extensions where name in ('dblink','pg_cron','pgcrypto')));
select diag((select string_agg(jobname || ' ' || schedule, ' | ') from cron.job));
select diag(current_setting('port') || ' ' || current_user);
select ok(true);
select * from finish();
rollback;
