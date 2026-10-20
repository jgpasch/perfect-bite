-- Failed AI calls keep the provider's answer (spec 5, 6.4): the HTTP status and the response body
-- (cut to 4000 characters) of a failed attempt that got an HTTP answer. Both are null on `ok` rows
-- and on failures with no HTTP answer (invalid output, a timeout, a network error).

alter table public.ai_calls
  add column http_status integer,
  add column error_body text;
