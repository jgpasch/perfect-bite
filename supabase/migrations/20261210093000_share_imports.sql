-- Share import jobs (spec 5 and 6.12, plan §4): one `share_imports` row per shared recipe, keyed by
-- the envelope id, moving through
--   received ─claim─▶ extracting ─save─▶ extracted ─claim─▶ committing ─commit─▶ done
-- with failures going back (transient, waiting) or to `failed` (permanent, or 8 attempts).
--
-- No client access to the table. The sharer reads their own rows, without `page` or `extraction`,
-- through the view `my_share_imports`, and asks share_import_status / retry_share_import. Every
-- other write is a service-role function (share-ingest inserts; the worker claims, reserves, saves,
-- releases and, in a later migration, commits), each one short transaction.
--
-- A daily job, `share-imports-retention`, purges pages and extractions and deletes old rows.

create table public.share_imports (
  id                uuid primary key,
  user_id           uuid not null references auth.users on delete cascade,
  credential_id     uuid references public.device_credentials on delete set null,
  household_id      uuid not null,
  list_id           uuid,
  add_to_list       boolean not null,
  url               text not null,
  url_key           text not null,
  title             text,
  payload_hash      bytea not null,
  page              jsonb,
  status            text not null default 'received'
                    check (status in ('received', 'extracting', 'extracted', 'committing', 'done', 'failed')),
  attempts          integer not null default 0 check (attempts >= 0),
  next_attempt_at   timestamptz not null default now(),
  lease_token       uuid,
  lease_expires_at  timestamptz,
  error_code        text,
  error_kind        text check (error_kind in ('transient', 'permanent', 'waiting')),
  resets_at         timestamptz,
  metered_at        timestamptz,
  extraction        jsonb,
  -- the receipt, compact and kept with the row:
  recipe_id         uuid,
  applied_list_id   uuid,
  list_gone         boolean not null default false,
  items_added       integer,
  items_combined    integer,
  committed_at      timestamptz,
  client_created_at timestamptz,
  app_version       text,
  source            text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- Due work (claim), leased work (claim of an expired lease), the sharer's rows, retention.
create index share_imports_due_idx on public.share_imports (created_at)
  where status in ('received', 'extracted');
create index share_imports_leased_idx on public.share_imports (lease_expires_at)
  where status in ('extracting', 'committing');
create index share_imports_user_idx on public.share_imports (user_id, created_at);
create index share_imports_created_idx on public.share_imports (created_at);

create trigger share_imports_updated_at before update on public.share_imports
  for each row execute function private.set_updated_at();

alter table public.share_imports enable row level security;
revoke all on table public.share_imports from public, anon, authenticated;

-- The sharer's own share imports, without page or extraction. Not security_invoker: it reads the
-- table as its owner and filters to auth.uid(), so it's the client's only way in.
create view public.my_share_imports as
  select id, household_id, list_id, add_to_list, url, title, status, attempts, next_attempt_at,
         error_code, error_kind, resets_at, recipe_id, applied_list_id, list_gone, items_added,
         items_combined, committed_at, client_created_at, created_at, updated_at
  from public.share_imports
  where user_id = auth.uid();

revoke all on table public.my_share_imports from public, anon, authenticated, service_role;
grant select on table public.my_share_imports to authenticated;

-- ---------------------------------------------------------------------------
-- private.share_import_backoff: how long a transient failure waits after the job's nth attempt:
-- 30 s, 2 min, 10 min, 1 h, then 6 h, each plus up to 20 % jitter.
-- ---------------------------------------------------------------------------

create function private.share_import_backoff(p_attempts integer)
returns interval
language sql
volatile
set search_path = ''
as $$
  select (case
            when p_attempts <= 1 then interval '30 seconds'
            when p_attempts = 2 then interval '2 minutes'
            when p_attempts = 3 then interval '10 minutes'
            when p_attempts = 4 then interval '1 hour'
            else interval '6 hours'
          end) * (1 + random() * 0.2);
$$;

revoke all on function private.share_import_backoff(integer) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- claim_share_import (service role, the worker): the oldest due job of the given kinds
-- (`extracting`: a due `received` row; `committing`: a due `extracted` row; either: one in that
-- state whose lease expired), `for update skip locked`, moved to the kind with a new
-- `lease_token`, `lease_expires_at = now() + 2 min` and `attempts + 1`. Returns that row, or none
-- when nothing is due. p_kinds null means both.
--
-- An expired lease is a lost lease, a transient failure: one that has already used its 8 attempts
-- (a worker that keeps dying on it) is failed with `lease_lost` instead, and the next is tried.
-- ---------------------------------------------------------------------------

create function public.claim_share_import(p_kinds text[] default null)
returns setof public.share_imports
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_kinds text[] := coalesce(p_kinds, array['extracting', 'committing']);
  v_job public.share_imports;
begin
  if not v_kinds <@ array['extracting', 'committing'] then
    raise exception 'invalid kinds' using errcode = '22023';
  end if;

  loop
    select * into v_job
    from public.share_imports s
    where (s.status = 'received' and 'extracting' = any (v_kinds) and s.next_attempt_at <= now())
       or (s.status = 'extracted' and 'committing' = any (v_kinds) and s.next_attempt_at <= now())
       or (s.status = any (v_kinds) and s.lease_expires_at < now())
    order by s.created_at, s.id
    limit 1
    for update skip locked;

    if not found then
      return;
    end if;

    if v_job.status in ('extracting', 'committing') and v_job.attempts >= 8 then
      update public.share_imports
      set status = 'failed', error_kind = 'transient', error_code = 'lease_lost', resets_at = null,
          page = null, lease_token = null, lease_expires_at = null
      where id = v_job.id;
      continue;
    end if;

    return query
      update public.share_imports
      set status = case v_job.status when 'received' then 'extracting'
                                     when 'extracted' then 'committing'
                                     else v_job.status end,
          lease_token = gen_random_uuid(),
          lease_expires_at = now() + interval '2 minutes',
          attempts = attempts + 1
      where id = v_job.id
      returning *;
    return;
  end loop;
end;
$$;

revoke all on function public.claim_share_import(text[]) from public, anon, authenticated;
grant execute on function public.claim_share_import(text[]) to service_role;

-- ---------------------------------------------------------------------------
-- private.leased_share_import: the job, locked, when it's in p_status (or either leased state)
-- under this lease; raises `lease_lost` (55000) otherwise. p_unexpired also requires the lease
-- not to have expired.
-- ---------------------------------------------------------------------------

create function private.leased_share_import(p_id uuid, p_lease uuid, p_statuses text[], p_unexpired boolean)
returns public.share_imports
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.share_imports;
begin
  select * into v_job from public.share_imports s where s.id = p_id for update;
  if not found
     or v_job.lease_token is distinct from p_lease
     or p_lease is null
     or not (v_job.status = any (p_statuses))
     or (p_unexpired and v_job.lease_expires_at <= now()) then
    raise exception 'lease_lost' using errcode = '55000';
  end if;
  return v_job;
end;
$$;

revoke all on function private.leased_share_import(uuid, uuid, text[], boolean) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- reserve_share_import (service role, before extracting): charges the import once per operation.
-- 'ok' at once when `metered_at` is set; otherwise check_recipe_import_limit for the sharer and the
-- share's household in this transaction ('ok', 'user_limit', 'daily_limit' or 'monthly_limit'),
-- setting `metered_at` on 'ok'. Under the job's lease (`lease_lost` otherwise).
-- ---------------------------------------------------------------------------

create function public.reserve_share_import(p_id uuid, p_lease uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.share_imports := private.leased_share_import(p_id, p_lease, array['extracting'], true);
  v_answer text;
begin
  if v_job.metered_at is not null then
    return 'ok';
  end if;

  v_answer := public.check_recipe_import_limit(v_job.user_id, v_job.household_id);
  if v_answer = 'ok' then
    update public.share_imports set metered_at = now() where id = p_id;
  end if;
  return v_answer;
end;
$$;

revoke all on function public.reserve_share_import(uuid, uuid) from public, anon, authenticated;
grant execute on function public.reserve_share_import(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- save_share_extraction (service role, after extracting): stores the RecipeImportResponse and
-- moves the job to `extracted`, due now, lease cleared. Only under a matching, unexpired lease
-- (`lease_lost` otherwise, changing nothing), so a worker that outlived its lease can't overwrite
-- the one that took over.
-- ---------------------------------------------------------------------------

create function public.save_share_extraction(p_id uuid, p_lease uuid, p_extraction jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_extraction is null or jsonb_typeof(p_extraction) <> 'object' then
    raise exception 'invalid extraction' using errcode = '22023';
  end if;

  perform private.leased_share_import(p_id, p_lease, array['extracting'], true);

  update public.share_imports
  set status = 'extracted', extraction = p_extraction, next_attempt_at = now(),
      lease_token = null, lease_expires_at = null,
      error_code = null, error_kind = null, resets_at = null
  where id = p_id;
end;
$$;

revoke all on function public.save_share_extraction(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.save_share_extraction(uuid, uuid, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- release_share_import (service role): records a phase's failure under the job's lease (a matching
-- token, expired or not; `lease_lost` otherwise) and clears the lease. Returns the new status.
--   transient: back to the state it was claimed from (`received` or `extracted`), due at
--     p_next_attempt_at or after the backoff for its attempts (private.share_import_backoff);
--     `failed` once it has used 8 attempts.
--   waiting (`rate_limited` only): back to that state, due at p_next_attempt_at or the next
--     minute, without counting the attempt.
--   permanent: `failed` with the code and p_resets_at (for `daily_limit` and `limit_reached`).
-- `failed` nulls `page`.
-- ---------------------------------------------------------------------------

create function public.release_share_import(
  p_id uuid,
  p_lease uuid,
  p_kind text,
  p_code text,
  p_next_attempt_at timestamptz default null,
  p_resets_at timestamptz default null
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.share_imports;
  v_back text;
  v_status text;
begin
  if p_kind is null or p_kind not in ('transient', 'waiting', 'permanent') then
    raise exception 'invalid kind' using errcode = '22023';
  end if;
  if p_code is null or btrim(p_code) = '' then
    raise exception 'code required' using errcode = '22023';
  end if;
  if p_kind = 'waiting' and p_code <> 'rate_limited' then
    raise exception 'only rate_limited waits' using errcode = '22023';
  end if;

  v_job := private.leased_share_import(p_id, p_lease, array['extracting', 'committing'], false);
  v_back := case v_job.status when 'extracting' then 'received' else 'extracted' end;

  if p_kind = 'permanent' or (p_kind = 'transient' and v_job.attempts >= 8) then
    v_status := 'failed';
    update public.share_imports
    set status = 'failed', error_kind = p_kind, error_code = p_code,
        resets_at = case when p_kind = 'permanent' then p_resets_at end,
        page = null, lease_token = null, lease_expires_at = null
    where id = p_id;
  elsif p_kind = 'transient' then
    v_status := v_back;
    update public.share_imports
    set status = v_back, error_kind = 'transient', error_code = p_code, resets_at = null,
        next_attempt_at = coalesce(p_next_attempt_at, now() + private.share_import_backoff(v_job.attempts)),
        lease_token = null, lease_expires_at = null
    where id = p_id;
  else
    v_status := v_back;
    update public.share_imports
    set status = v_back, error_kind = 'waiting', error_code = p_code, resets_at = null,
        next_attempt_at = coalesce(p_next_attempt_at, date_trunc('minute', now()) + interval '1 minute'),
        attempts = greatest(attempts - 1, 0),
        lease_token = null, lease_expires_at = null
    where id = p_id;
  end if;

  return v_status;
end;
$$;

revoke all on function public.release_share_import(uuid, uuid, text, text, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.release_share_import(uuid, uuid, text, text, timestamptz, timestamptz) to service_role;

-- ---------------------------------------------------------------------------
-- retry_share_import (signed-in user, Try again): moves the caller's own `failed` share import back
-- to `received` with the same id, `attempts` 0 and the error cleared, due now. `metered_at` stays,
-- so an import already charged isn't charged again. Another status is left as it is. Returns the
-- status; `not found` (P0002) for another user's or an unknown id.
-- ---------------------------------------------------------------------------

create function public.retry_share_import(p_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
begin
  select s.status into v_status
  from public.share_imports s
  where s.id = p_id and s.user_id = auth.uid()
  for update;
  if not found then
    raise exception 'not found' using errcode = 'P0002';
  end if;

  if v_status = 'failed' then
    update public.share_imports
    set status = 'received', attempts = 0, next_attempt_at = now(),
        error_code = null, error_kind = null, resets_at = null,
        lease_token = null, lease_expires_at = null
    where id = p_id;
    v_status := 'received';
  end if;
  return v_status;
end;
$$;

revoke all on function public.retry_share_import(uuid) from public, anon, service_role;
grant execute on function public.retry_share_import(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- share_import_status (signed-in user, reconciling): `(id, status)` for the caller's own share
-- imports among p_ids. Other users' and unknown ids are left out, so they read as "not on the
-- server".
-- ---------------------------------------------------------------------------

create function public.share_import_status(p_ids uuid[])
returns table (id uuid, status text)
language sql
stable
security definer
set search_path = ''
as $$
  select s.id, s.status
  from public.share_imports s
  where s.id = any (p_ids) and s.user_id = auth.uid();
$$;

revoke all on function public.share_import_status(uuid[]) from public, anon, service_role;
grant execute on function public.share_import_status(uuid[]) to authenticated;

-- ---------------------------------------------------------------------------
-- Retention (daily, `share-imports-retention`): nulls `page` on `done` and `failed` rows and on any
-- row older than 24 hours, nulls `extraction` 7 days after `done`, and deletes rows older than a
-- year. The receipt stays with the row until then.
-- ---------------------------------------------------------------------------

create function private.share_imports_retention()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.share_imports
  set page = null
  where page is not null
    and (status in ('done', 'failed') or created_at < now() - interval '24 hours');

  update public.share_imports
  set extraction = null
  where extraction is not null
    and status = 'done'
    and coalesce(committed_at, updated_at) < now() - interval '7 days';

  delete from public.share_imports where created_at < now() - interval '1 year';
end;
$$;

revoke all on function private.share_imports_retention() from public, anon, authenticated, service_role;

select cron.schedule('share-imports-retention', '53 3 * * *', $$select private.share_imports_retention()$$);
