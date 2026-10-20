-- Flagged AI calls (spec 4.12, 6.11): one function decides what's flagged, so the portal, its
-- index and retention all agree. A photo description that answers `isFood: false` is an `ok`
-- call, so it's flagged on purpose (`not_food`); a refused image call is `refused`; a safety
-- block (finish reason `content-filter`, any task, 6.4) is `content_filter`. Everything else is
-- null.
--
-- Retention: a row still goes after 30 days, unless it, the row it links to (`fallback_of`) or a
-- row linking to it is flagged; those go after 180 days, so a refused image keeps the
-- description holding the recipe the user wrote, and the other way round. Deleting the account
-- still nulls `user_id`: no copy of who made a call is kept.

create or replace function private.ai_call_flag(c public.ai_calls)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when c.task = 'recipePhotoDescription' and c.output ->> 'isFood' = 'false' then 'not_food'
    when c.status = 'refused' then 'refused'
    when c.finish_reason = 'content-filter' then 'content_filter'
  end
$$;

revoke all on function private.ai_call_flag(public.ai_calls) from public, anon, authenticated;

create index ai_calls_flagged_idx on public.ai_calls (created_at desc)
  where private.ai_call_flag(ai_calls) is not null;

-- Finds the attempt that followed a row (retention here, `recovered` and `fallback` in the portal).
create index ai_calls_fallback_of_idx on public.ai_calls (fallback_of) where fallback_of is not null;

-- Same name, so pg_cron replaces the job's command and keeps its schedule (03:17 UTC daily).
select cron.schedule(
  'ai-calls-retention',
  '17 3 * * *',
  $$delete from public.ai_calls c
    where c.created_at < now() - interval '30 days'
      and (
        c.created_at < now() - interval '180 days'
        or not (
          private.ai_call_flag(c) is not null
          or exists (select 1 from public.ai_calls n
                     where n.fallback_of = c.id and private.ai_call_flag(n) is not null)
          or exists (select 1 from public.ai_calls p
                     where p.id = c.fallback_of and private.ai_call_flag(p) is not null)
        )
      )$$
);
