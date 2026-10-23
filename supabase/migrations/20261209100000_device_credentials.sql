-- Device credentials (spec 6.12, plan §2): a scoped token the share extension uploads with, never a
-- Supabase session. The token is 32 random bytes made by `register-device-credential`; only its
-- sha256 is stored. A credential is valid while `expires_at` and any `revoked_at` are in the future:
-- a replaced one keeps a 24 h grace (both set to the same future instant), sign-out and admin
-- revocations set `revoked_at` to now.
--
-- No client grants: register_device_credential and use_device_credential are for the service role
-- (the Edge Functions), revoke_my_device_credential for the signed-in user, and
-- admin_revoke_device_credentials for admins. Deleting the user deletes them.

create table public.device_credentials (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users on delete cascade,
  installation_id uuid not null,
  token_hash      bytea not null unique,
  scopes          text[] not null default '{share.ingest}',
  created_at      timestamptz not null default now(),
  last_used_at    timestamptz,
  expires_at      timestamptz not null default now() + interval '90 days',
  revoked_at      timestamptz,
  revoked_reason  text check (revoked_reason in ('replaced', 'sign_out', 'admin'))
);

-- One live credential per (user_id, installation_id).
create unique index device_credentials_live_idx
  on public.device_credentials (user_id, installation_id)
  where revoked_at is null;

alter table public.device_credentials enable row level security;
revoke all on table public.device_credentials from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- register_device_credential (service role, from register-device-credential): replaces the user's
-- live credential for the installation, which keeps working for a 24 h grace (`expires_at` becomes
-- least(expires_at, now() + 24 h), `revoked_at` that same instant, `revoked_reason` `replaced`), and
-- stores a new one by its sha256 (hex), valid 90 days. Returns the new credential's `expires_at`.
-- ---------------------------------------------------------------------------

create function public.register_device_credential(p_user_id uuid, p_installation_id uuid, p_token_hash text)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_expires_at timestamptz;
begin
  if p_user_id is null or p_installation_id is null or p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid credential' using errcode = '22023';
  end if;

  -- Two registrations for one installation at once: the second waits, then replaces the first's.
  perform pg_advisory_xact_lock(hashtextextended('device_credentials:' || p_user_id::text || ':' || p_installation_id::text, 0));

  update public.device_credentials c
  set expires_at = least(c.expires_at, now() + interval '24 hours'),
      revoked_at = least(c.expires_at, now() + interval '24 hours'),
      revoked_reason = 'replaced'
  where c.user_id = p_user_id
    and c.installation_id = p_installation_id
    and c.revoked_at is null;

  insert into public.device_credentials (user_id, installation_id, token_hash, expires_at)
  values (p_user_id, p_installation_id, decode(p_token_hash, 'hex'), now() + interval '90 days')
  returning expires_at into v_expires_at;

  return v_expires_at;
end;
$$;

revoke all on function public.register_device_credential(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.register_device_credential(uuid, uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- use_device_credential (service role, from verifyDeviceCredential): the user id of the valid
-- credential with this sha256 (hex) and scope, setting its `last_used_at`; null for an unknown,
-- revoked, expired or out-of-scope token.
-- ---------------------------------------------------------------------------

create function public.use_device_credential(p_token_hash text, p_scope text)
returns uuid
language sql
security definer
set search_path = ''
as $$
  update public.device_credentials c
  set last_used_at = now()
  where c.token_hash = decode(p_token_hash, 'hex')
    and p_scope = any (c.scopes)
    and c.expires_at > now()
    and (c.revoked_at is null or c.revoked_at > now())
  returning c.user_id;
$$;

revoke all on function public.use_device_credential(text, text) from public, anon, authenticated;
grant execute on function public.use_device_credential(text, text) to service_role;

-- ---------------------------------------------------------------------------
-- revoke_my_device_credential (signed-in user, at sign-out): revokes the caller's valid credentials
-- for the installation now (`revoked_reason` `sign_out`), one in its grace too. A no-op for none.
-- ---------------------------------------------------------------------------

create function public.revoke_my_device_credential(p_installation_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.device_credentials c
  set revoked_at = now(), revoked_reason = 'sign_out'
  where c.user_id = auth.uid()
    and c.installation_id = p_installation_id
    and c.expires_at > now()
    and (c.revoked_at is null or c.revoked_at > now());
$$;

revoke all on function public.revoke_my_device_credential(uuid) from public, anon, service_role;
grant execute on function public.revoke_my_device_credential(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- admin_revoke_device_credentials (spec 4.12, a lost device): revokes every valid credential of the
-- user now (`revoked_reason` `admin`), one in its grace too, and writes one
-- `revoke_device_credentials` audit row with the note and details { revoked } (how many), which it
-- returns, also when there were none. Raises `note required` (22023), changing nothing.
-- ---------------------------------------------------------------------------

create function public.admin_revoke_device_credentials(p_user_id uuid, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_revoked integer;
  v_details jsonb;
begin
  perform private.require_admin();
  perform private.require_note(p_note);

  update public.device_credentials c
  set revoked_at = now(), revoked_reason = 'admin'
  where c.user_id = p_user_id
    and c.expires_at > now()
    and (c.revoked_at is null or c.revoked_at > now());
  get diagnostics v_revoked = row_count;

  v_details := jsonb_build_object('revoked', v_revoked);
  insert into admin.admin_actions (action, target_user_id, details, note, performed_by)
  values ('revoke_device_credentials', p_user_id, v_details, p_note, auth.uid()::text);

  return v_details;
end;
$$;

revoke all on function public.admin_revoke_device_credentials(uuid, text) from public, anon, service_role;
grant execute on function public.admin_revoke_device_credentials(uuid, text) to authenticated;
