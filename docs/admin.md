# Running the app from the Supabase dashboard

The app is run from the Supabase dashboard (Authentication → Users, the Table Editor, the SQL Editor and the logs) and from the admin portal in `admin/` (spec 4.12; how to run it is in [`admin/README.md`](../admin/README.md)).

## The one rule

**Never delete users or household rows by hand** (in Authentication → Users, the Table Editor, or with a plain `delete`). The dashboard runs as `postgres` and doesn't know the app's rules: deleting a user there skips owner promotion and leaves their personal household behind with nobody in it, and deleting a `household_members` row can leave a household with no owner. Use the snippets below, which go through tested functions in the `admin` schema and write an audit row to `admin.admin_actions`.

Changes with no rules beyond the table's own constraints (a user's plan, a plan's monthly limits, the safety limits) can be made in the Table Editor.

## Common jobs

### Find a user

Authentication → Users, and search by email. Or in the SQL Editor:

```sql
select u.id, u.email, p.display_name, u.created_at, u.last_sign_in_at
from auth.users u
left join public.profiles p on p.user_id = u.id
where u.email ilike '%sam%';
```

### See a user's households

```sql
select h.id, h.name, hm.role, hm.joined_at
from public.household_members hm
join public.households h on h.id = hm.household_id
where hm.user_id = '<user id>'
order by hm.position;
```

### See a household's members and lists

```sql
select p.display_name, u.email, hm.role, hm.joined_at
from public.household_members hm
join auth.users u on u.id = hm.user_id
left join public.profiles p on p.user_id = hm.user_id
where hm.household_id = '<household id>'
order by hm.joined_at;

select l.name, l.archived_at, l.deleted_at,
  (select count(*) from public.list_items i
   where i.list_id = l.id and i.deleted_at is null and i.checked_at is null) as open_items
from public.lists l
where l.household_id = '<household id>'
order by l.position;
```

Rows with `deleted_at` set are soft-deleted (kept for sync) and don't show in the app.

### Read Edge Function logs

Edge Functions → pick the function (`categorize-ingredients`, `import-recipe`, `suggest-recipe-tags`) → Logs for its console output, or Invocations for each request's status and duration.

### Read the AI calls

`public.ai_calls` has one row per model attempt, kept for 30 days, with the `user_id` who made it and, for AI photos, the `household_id` (both null for the `yarn ai:*` scripts and evals; spec 5, 6.5). In the Table Editor, or:

```sql
select created_at, task, model, status, duration_ms, input_tokens, output_tokens, error
from public.ai_calls
order by created_at desc
limit 50;
```

Add `instructions, prompt, response_text, output` to see exactly what was sent and returned.

### Change a user's plan

A household's plan decides which of the two plan features its members get (spec 4.12): `recipe_import` (from a link and from photos) and `recipe_photo_ai`. Categorizing, tag suggestions and step matching are for everyone on every plan.

- **free**: neither.
- **founding** (the default): both, 50 imports and 20 AI photos a month.
- **unlimited**: both, with no monthly limits. It's the plan for family.

Every household has a `household_plans` row, written when it's made with the plan that's the default at that moment; changing the default moves no one. A household with no row has no features. Until the portal goes per household, change a household's plan in the Table Editor: `household_plans`, edit `plan_id` on its row (`assigned_at` updates itself). The portal's plan form below still writes `user_plans`, which no longer decides anything (old app builds read `my_features`, which answers from the user's households).

Use the admin portal: find the user (by email, name or user id), pick the plan or the default, and write a note. It calls `admin_set_user_plan`, which writes one `admin.admin_actions` row (`set_user_plan`, `{ from, to }`, the note, and your user id in `performed_by`), so the change shows in the user's plan history.

The Table Editor still works, but nothing records who changed what or why:

1. Find their id in Authentication → Users.
2. Table Editor → `user_plans`. To put them on a plan, insert a row with their `user_id` and a `plan_id` (`free`, `founding` or `unlimited`), or edit `plan_id` on their existing row. `assigned_at` updates itself.
3. To put them back on the default plan, delete their row.

The foreign key only accepts real plans, so a typo is rejected. Nothing caches the plan on the server: `has_feature` reads it on each call.

### Change a plan's monthly limits

Each plan feature has a monthly limit per plan in `public.plan_limits` (spec 4.12): the calendar month in UTC, resetting on the 1st. Both count calls; link and photo imports share `recipe_import`'s. Seeded:

| plan | recipe_import | recipe_photo_ai |
|---|---|---|
| founding | 50 | 20 |
| unlimited | null | null |

- Use the admin portal: pick the plan and the feature, set the limit (or none) and write a note. It calls `admin_set_plan_limit`, which writes one `admin.admin_actions` row (`set_plan_limit`, the plan before and after, the note and your user id). It takes effect on the next call.
- The Table Editor still works, unaudited: `plan_limits`, edit `monthly_limit`.
- A null `monthly_limit` means no monthly limit, and so does **deleting a row**: deleting a row lifts the limit for that plan and feature.
- A household younger than 30 days (`households.created_at`) gets twice its plan's limits.
- The safety limits (below) and one AI photo per recipe apply on every plan, unlimited too, and aren't in this table.
- Past a limit, the app says "You've used this month's … They reset on Nov 1." Usage is counted even with no limit:

```sql
select u.email, f.feature, private.monthly_usage(u.id, f.feature) as used,
  private.monthly_limit(u.id, f.feature) as monthly_limit
from auth.users u
cross join (values ('categorize'), ('step_ingredients'), ('recipe_import'), ('recipe_import_photo'),
                   ('recipe_tags'), ('recipe_photo_ai')) f(feature)
where u.email = '<email>';
```

### Change the safety limits

The safety limits are per user and the same on every plan, unlimited too (spec 4.12 Safety limits): a per-minute limit that stops a client stuck in a loop and a daily one (the user's UTC day) that stops a scripted account. They're rows in `public.ai_safety_limits`, one per key, read on every call, so a change applies at once. A null is no limit. Seeded:

| key | in the portal | per minute (requests) | per day |
|---|---|---|---|
| `categorize` | Categorize | 60 | 500 names sent to the AI |
| `step_match` | Step matching | 30 | 100 matches |
| `recipe_tags` | Tag suggestions | 20 | 50 suggestions |
| `recipe_import_link` | Link import | 10 | none |
| `recipe_import_photo` | Photo import | 5 | none |
| `recipe_import` | Recipe imports | none | 100 imports, link and photo together |
| `recipe_photo_ai` | AI photos | none | 40 photos |

Past a per-minute limit the app says "Try again in a minute"; past a daily one, "You've reached today's limit. Try again tomorrow." Background work (categorize, step matching) stays silent.

- Use the admin portal: the **Safety limits** card on the Plans page lists each key with its two numbers (blank for none) and their units. **Edit** opens a form with both numbers (leave one blank for no limit) and a required note. It calls `admin_set_safety_limit`, which writes one `admin.admin_actions` row (`set_safety_limit`, the key's `{ key, per_minute, per_day }` before and after, the note and your user id); Activity shows it as "Set safety limit". An unknown key fails with `unknown key`, a negative number with the table's check.
- The Table Editor or SQL Editor still works, unaudited: `public.ai_safety_limits`, edit `per_minute` or `per_day` (null for no limit). The keys are fixed by the table's check; a new one is a migration.

```sql
select key, per_minute, per_day from public.ai_safety_limits order by key;

update public.ai_safety_limits set per_day = 200 where key = 'recipe_import';
```

### Add, edit or delete a plan

Use the admin portal (spec 4.12). Each change needs a note and writes one `admin.admin_actions` row with the plan in `target_plan_id`, the plan before and after in `details`, and your user id:

- **Create** a plan with an id (lowercase letters, digits and `_`, starting with a letter) and a name, empty or as a copy of another plan's features and limits. A copy is never the default.
- **Rename** it (the id never changes).
- **Turn features on or off**, with a monthly limit (or none) when turning one on. Turning a feature off removes its limit too.
- **Make it the default**: every user with no `user_plans` row moves to it at once.
- **Delete** it, once no user is assigned to it. The default plan can't be deleted; make another plan the default first.

The feature keys themselves are fixed in code; a new feature is a migration.

**A plan with `recipe_import` or `recipe_import_photo` must also have `categorize`** (both imports categorize in the same request). A constraint trigger on `plan_features` enforces it everywhere, the portal, the Table Editor and the SQL Editor alike: a change that leaves a plan with an import and no `categorize` fails with `recipe import needs categorize`. So turn `categorize` on before an import, and off after them. The trigger is checked at the end of the transaction, so in the SQL Editor both can be added in one go in either order.

The Table Editor (`plans`, `plan_features`, `plan_limits`) still works, but isn't audited. A feature with no `plan_limits` row has no monthly limit.

### Launching paid plans

Plans are moving from users to households (spec 4.12; `tasks.md` tracks it): once that lands, every household has an explicit plan in `household_plans`, written when it's made, and the default plan only decides what **new** households start on. Until paid plans launch, the default is **founding** (it replaces plus), so every household made before then is a founding household: it stays on founding, free, for good.

When paid plans launch:

1. Create the paid plan in the portal with its own id and name (never reuse `founding`), turn on its features and set its monthly limits.
2. Make it the default. Only households made from then on start on it; no existing household moves, so founders keep founding.
3. **Never add a feature to founding again.** A new feature goes into a new plan, so founders get exactly what founding had at launch. Changing founding's monthly limits is still fine and applies to every founder.

To move a founding household to a paid plan (they asked to), change that household's plan in the portal with a note. A household's plan can be changed but never cleared: a household with no row has no features.

### Which plan is each household on

```sql
select h.name, h.id, hp.plan_id, hp.assigned_at,
  (select string_agg(u.email, ', ' order by u.email)
   from public.household_members m join auth.users u on u.id = m.user_id
   where m.household_id = h.id) as members
from public.households h
left join public.household_plans hp on hp.household_id = h.id
order by h.created_at;
```

A null `plan_id` is a household with no row, so no features; there shouldn't be any.

**Right after pushing the household plans migration to hosted**, run this and confirm every household the owner (jgpasch@gmail.com) is in shows `unlimited`, and no household shows a null plan. If one doesn't, run "Put a household on a plan" below.

### AI photo blocks

A user whose AI photo prompts are refused 3 times in 30 days loses AI photos until an admin unblocks them (spec 6.11). A refusal is an `ai_calls` row of theirs with task `recipePhotoModeration` (our moderation check flagged the prompt) or `recipePhotoImage` (the image model refused it) and status `refused`; a "not food" description doesn't count. Each refused image counts against our OpenAI account, which is why the rule exists. On the third, a trigger on `ai_calls` writes a `private.ai_photo_blocks` row and a `block_ai_photos` audit row with no admin (Activity shows it as "Blocked AI photos", by Automatic). From then on every Generate with AI they try answers "AI photos are turned off for your account." and nothing is sent to a model.

In the portal, a blocked user has a red "AI photos blocked" badge in the Users list (the filter next to the search shows only them), on their page and on their refused rows on the AI calls page. Their page's **AI photos** card says since when and after how many refusals, links to the refused prompts (the Flagged tab, filtered by them and Refused) so you can read what they asked for, and has **Unblock**. A user who isn't blocked shows how many refused prompts they have in the last 30 days, once they have one.

**Unblocking** needs a note (who asked and why). It calls `admin_unblock_ai_photos`, which deletes the block and writes one `unblock_ai_photos` audit row (the note, your user id, and the block's `{ refusals, blocked_at }`). They can generate again right away; the app shows Generate with AI again the next time it reloads its features (a relaunch or coming back to the foreground). Unblocking starts the count over: only refusals after it count, so it takes three new ones to block them again, not one.

Who's blocked now:

```sql
select u.email, b.blocked_at, b.refusals, b.last_call_id,
  private.ai_photo_refusals(u.id, now() - private.ai_photo_block_window()) as counted_refusals
from private.ai_photo_blocks b
join auth.users u on u.id = b.user_id
order by b.blocked_at desc;
```

Unblock in the portal rather than deleting the row by hand: a deleted row writes no audit row, so the old refusals still count and the user's next refusal blocks them again.

### Testing AI photo blocks

Two ways to get refusals without asking a real model for a bad image.

**Fake refusals in the local database.** `yarn dev:ai-refusals <email> [count]` inserts `count` (default 3) refused `recipePhotoImage` rows for that user (model `mock`, their oldest household, `error` "Fake refusal (dev:ai-refusals)"), one at a time, so they go through the real trigger: the third blocks them as a real refusal would. It prints their refusal count and whether they're blocked. `yarn dev:ai-refusals <email> --clear` deletes their fake rows, their block and the block's `block_ai_photos` audit row. It needs `psql`, connects to `postgresql://postgres:postgres@127.0.0.1:55322/postgres` (or `DATABASE_URL`) and refuses any host but `127.0.0.1` or `localhost`, so it can't touch hosted. `--clear` leaves other rows alone: an `unblock_ai_photos` audit row from the portal, and refused rows the mock model made (below), stay.

**A refusal from the mock model.** With `AI_IMAGE_MODEL=mock` and `AI_MODEL_PHOTO_DESCRIPTION=mock` in `supabase/functions/.env`, Generate with AI on a recipe whose title contains `refuse-me` (any case, e.g. "refuse-me pasta") is refused: the mock moderation check flags the prompt (a `refused` `recipePhotoModeration` row, error "Flagged: mock") and the app shows "Couldn't make a photo for this recipe". The mock description never repeats the title, so with the mock image model the function adds the word to the image prompt itself; the mock image model refuses a prompt with the word too (`Refused: moderation_blocked (mock)`). A real image model never sees the word. Each recipe has one try, so make a new one per refusal; the third blocks the account.

**On hosted**, run these in the SQL editor. Set the email on the first line. Three fake refusals, which block the user:

```sql
do $$
declare
  v_email text := 'someone@example.com';
  v_user uuid;
  v_household uuid;
begin
  select id into v_user from auth.users where lower(email) = lower(v_email);
  if v_user is null then raise exception 'No user with the email %', v_email; end if;
  select m.household_id into v_household
  from public.household_members m join public.households h on h.id = m.household_id
  where m.user_id = v_user order by h.created_at, h.id limit 1;
  for i in 1..3 loop
    insert into public.ai_calls (id, task, model, prompt_version, status, instructions, prompt, duration_ms, error, user_id, household_id)
    values (gen_random_uuid(), 'recipePhotoImage', 'mock', 'recipe-photo-image.v1', 'refused', '',
      'Fake refused prompt (dev:ai-refusals)', 0, 'Fake refusal (dev:ai-refusals)', v_user, v_household);
  end loop;
end $$;
```

And clearing them, the block and its audit row:

```sql
do $$
declare
  v_email text := 'someone@example.com';
  v_user uuid;
begin
  select id into v_user from auth.users where lower(email) = lower(v_email);
  if v_user is null then raise exception 'No user with the email %', v_email; end if;
  delete from admin.admin_actions a using private.ai_photo_blocks b
  where b.user_id = v_user and a.target_user_id = v_user
    and a.action = 'block_ai_photos' and a.created_at >= b.blocked_at;
  delete from private.ai_photo_blocks where user_id = v_user;
  delete from public.ai_calls where user_id = v_user and error = 'Fake refusal (dev:ai-refusals)';
end $$;
```

### Add or remove an admin

Admins are the users who may use the admin portal (`admin/`). In the Table Editor, open the `private` schema → `admins`. To add one, insert a row with their user id (find it under Authentication → Users, or with "Find a user" above); `added_at` fills itself in. To remove one, delete their row. Either takes effect on their next call: the portal checks on every action, so there's nothing to sign out. Deleting a user removes their row too.

### See what admins have done

```sql
select created_at, action, target_user_id, note, details
from admin.admin_actions
order by created_at desc;
```

`performed_by` is always `postgres` from the dashboard, so the `note` is the only record of who asked and why. From the admin portal it's the admin's user id, and the note is still required.

### Demo data for the portal (local only)

`supabase/seed-admin-demo.sql` fills a local database with something for the portal to show: ten fake users (`demo-1@example.com` … `demo-10@example.com`) on every plan, with 40 days of usage of every feature (demo-1 at founding's monthly limits, demo-2 over them), a few `ai_calls` rows per task and a few audit rows. `seed.sql` doesn't run it, so run it by hand after each `supabase db reset`:

```bash
psql postgresql://postgres:postgres@127.0.0.1:55322/postgres -f supabase/seed-admin-demo.sql
```

or paste it into the local SQL editor (http://127.0.0.1:55323). Running it again inserts nothing. The file's header has the three `delete`s that remove it. Never run it against hosted.

## Snippets

Save these in the SQL Editor. Always fill in the note.

### Delete a user

Users can delete their own account in the app (Settings → Delete account), which runs `public.delete_account()` and records an `admin.admin_actions` row with `action = 'delete_account'` and no email or name. Use `admin.delete_user` only for a support request, e.g. someone who can no longer sign in.

Leaves each of the user's households by the app's rules: a household where they're the only member is deleted with all its lists and recipes; where they're the last owner, the member who joined earliest becomes the owner; otherwise they just leave and the household keeps its data. Then it deletes the account, with their profile, settings and aisle order. Items, check-offs and invites they made in shared households stay, with no name on them. It returns what happened to each household and records it in `admin.admin_actions`.

```sql
select admin.delete_user(
  p_user_id => '<user id>',
  p_note    => '<who asked, when, and why, e.g. "Deletion request from sam@example.com, email 2026-10-12">'
);
```

An unknown id raises `user not found` and changes nothing.

### Put a household on a plan

Every household the account is in goes on unlimited:

```sql
insert into public.household_plans (household_id, plan_id)
select m.household_id, 'unlimited'
from public.household_members m join auth.users u on u.id = m.user_id
where u.email = 'jgpasch@gmail.com'
on conflict (household_id) do update set plan_id = excluded.plan_id;
```

Change the email and the plan id for someone else. It does nothing if no account has that email.
