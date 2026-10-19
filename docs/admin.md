# Running the app from the Supabase dashboard

There's no admin portal. The app is run from the Supabase dashboard: Authentication → Users, the Table Editor, the SQL Editor and the logs (spec 4.12).

## The one rule

**Never delete users or household rows by hand** (in Authentication → Users, the Table Editor, or with a plain `delete`). The dashboard runs as `postgres` and doesn't know the app's rules: deleting a user there skips owner promotion and leaves their personal household behind with nobody in it, and deleting a `household_members` row can leave a household with no owner. Use the snippets below, which go through tested functions in the `admin` schema and write an audit row to `admin.admin_actions`.

Changes with no rules beyond the table's own constraints (a user's plan, a plan's monthly limits) can be made in the Table Editor.

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

`public.ai_calls` has one row per model attempt, kept for 30 days, with no user id (spec 6.5). In the Table Editor, or:

```sql
select created_at, task, model, status, duration_ms, input_tokens, output_tokens, error
from public.ai_calls
order by created_at desc
limit 50;
```

Add `instructions, prompt, response_text, output` to see exactly what was sent and returned.

### Change a user's plan

A user's plan decides which AI features they get (spec 4.12):

- **none**: no AI features.
- **basic**: categorizing new ingredients and matching ingredients to steps for cook mode.
- **plus** (the default): also recipe import from a link and from photos, AI tag suggestions and AI recipe photos; every feature today.
- **unlimited**: every feature, with no monthly limits. It's the plan for family.

A user with no `user_plans` row is on the default plan. Each plan also sets how much of each feature a user may use a month (below).

1. Find their id in Authentication → Users.
2. Table Editor → `user_plans`. To put them on a plan, insert a row with their `user_id` and a `plan_id` (`none`, `basic`, `plus` or `unlimited`), or edit `plan_id` on their existing row. `assigned_at` updates itself.
3. To put them back on the default plan, delete their row.

The foreign key only accepts real plans, so a typo is rejected. Nothing caches the plan on the server: `has_feature` reads it on each call.

### Change a plan's monthly limits

Each AI feature has a monthly limit per plan, per user, in `public.plan_limits` (spec 4.12): the calendar month in UTC, resetting on the 1st. `categorize` counts names sent to the AI; the others count calls. Seeded:

| plan | categorize | step_ingredients | recipe_import | recipe_import_photo | recipe_tags | recipe_photo_ai |
|---|---|---|---|---|---|---|
| plus | 250 | 100 | 40 | 20 | 50 | 15 |
| basic | 250 | 100 | | | | |
| unlimited | null | null | null | null | null | null |

- Table Editor → `plan_limits`: edit `monthly_limit` to change a limit. It takes effect on the next call.
- A null `monthly_limit` means no monthly limit, and so does **deleting a row**: deleting a row lifts the limit for that plan and feature.
- An account younger than 30 days gets twice its plan's limits.
- The per-minute limits (which catch a client stuck in a loop) and one AI photo per recipe apply on every plan, unlimited too, and aren't in the table.
- Past a limit, the app says "You've used this month's … They reset on Nov 1." Usage is counted even with no limit:

```sql
select u.email, f.feature, private.monthly_usage(u.id, f.feature) as used,
  private.monthly_limit(u.id, f.feature) as monthly_limit
from auth.users u
cross join (values ('categorize'), ('step_ingredients'), ('recipe_import'), ('recipe_import_photo'),
                   ('recipe_tags'), ('recipe_photo_ai')) f(feature)
where u.email = '<email>';
```

### Add a plan

There's no `create_plan`. In the SQL Editor, insert the `plans` row, then its `plan_features` rows (a plan with `recipe_import` must also have `categorize`) and its `plan_limits` rows. A feature with no `plan_limits` row has no monthly limit, so add one for each feature you want limited.

### Which plan is each user on

```sql
select u.email,
  coalesce(up.plan_id, d.id) as plan,
  case when up.plan_id is null then 'defaulted' else 'assigned' end as how,
  up.assigned_at
from auth.users u
left join public.user_plans up on up.user_id = u.id
left join public.plans d on d.is_default
order by u.email;
```

**Right after pushing the plans migration to hosted**, run this and confirm the owner's account (jgpasch@gmail.com) shows `plus`, `assigned`. If it doesn't, run "Put me on plus" below.

### Add or remove an admin

Admins are the users who may use the admin portal (`admin/`). In the Table Editor, open the `private` schema → `admins`. To add one, insert a row with their user id (find it under Authentication → Users, or with "Find a user" above); `added_at` fills itself in. To remove one, delete their row. Either takes effect on their next call: the portal checks on every action, so there's nothing to sign out. Deleting a user removes their row too.

### See what admins have done

```sql
select created_at, action, target_user_id, note, details
from admin.admin_actions
order by created_at desc;
```

`performed_by` is always `postgres` from the dashboard, so the `note` is the only record of who asked and why. From the admin portal it's the admin's user id, and the note is still required.

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

### Put me on plus

```sql
insert into public.user_plans (user_id, plan_id)
select id, 'plus' from auth.users where email = 'jgpasch@gmail.com'
on conflict (user_id) do update set plan_id = 'plus';
```

Change the email to put someone else on plus. It does nothing if no account has that email.
