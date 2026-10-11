-- Default unit per catalog ingredient (spec 4.2, 6.2): how it's usually bought, as a `unit_key`
-- (a supported unit, or 'count'). The app uses it as the usual unit until a household has its own
-- history. Set by the seed and by categorize-ingredients; null when unknown.

alter table public.ingredients add column default_unit text;
