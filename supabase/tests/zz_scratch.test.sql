begin;
select plan(1);
select diag(string_agg(c.relname||'.'||a.attname||' -> '||confrelid::regclass::text||' del='||confdeltype::text, E'\n')) from pg_constraint k join pg_class c on c.oid=k.conrelid join pg_namespace n on n.oid=c.relnamespace join pg_attribute a on a.attrelid=k.conrelid and a.attnum = any(k.conkey) where k.contype='f' and n.nspname='public' and k.confdeltype in ('n','d');
select diag(string_agg(table_name, ', ' order by table_name)) from information_schema.columns where table_schema='public' and column_name='updated_at';
select pass('x');
select * from finish();
rollback;
