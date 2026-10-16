-- Reviewing the model's translations (spec 4.15, 5). `yarn ai:translations` exports the links a
-- model made, for a person to check, and `--mark-reviewed` stamps the rows of a reviewed export so
-- the next export leaves them out. Null until a person has reviewed the name. Service role only in
-- practice: clients can read the catalog but never write it.

alter table public.ingredients
  add column reviewed_at timestamptz;
