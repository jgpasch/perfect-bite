-- The Edge Functions write ai_calls as service_role, and the partial index ai_calls_flagged_idx
-- (20261122120000_ai_calls_flags) calls private.ai_call_flag on every insert. That migration
-- revoked the function from public, so since then every insert failed with "permission denied for
-- function ai_call_flag" and no AI call was logged. service_role gets it back; anon and
-- authenticated still don't (the table is service role only anyway).
grant execute on function private.ai_call_flag(public.ai_calls) to service_role;
