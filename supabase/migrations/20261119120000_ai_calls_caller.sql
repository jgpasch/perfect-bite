-- ai_calls records who made each call (spec 5, 6.4, 6.5): the signed-in user and, when the
-- request has one, the household. Both are null for calls with no caller (the `yarn ai:*` scripts
-- and evals). Deleting the account or the household nulls them and keeps the row; nothing else
-- keeps a copy of who made it. The table stays service role only, and rows still expire after 30
-- days.

alter table public.ai_calls
  add column user_id uuid references auth.users on delete set null,
  add column household_id uuid references public.households on delete set null;

-- A user's calls, newest first (the portal reads them per user).
create index ai_calls_user_id_created_at_idx on public.ai_calls (user_id, created_at desc);
