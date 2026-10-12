# Running the app from the Supabase dashboard

There's no admin portal. The app is run from the Supabase dashboard: Authentication → Users, the Table Editor, the SQL Editor and the logs (spec 4.12).

## The one rule

**Never delete users or household rows by hand** (in Authentication → Users, the Table Editor, or with a plain `delete`). The dashboard runs as `postgres` and doesn't know the app's rules: deleting a user there skips owner promotion and leaves their personal household behind with nobody in it, and deleting a `household_members` row can leave a household with no owner. Use the snippets below, which go through tested functions in the `admin` schema and write an audit row to `admin.admin_actions`.

Changes with no rules beyond the table's own constraints (e.g. a user's plan, once plans exist) can be made in the Table Editor.

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

Edge Functions → pick the function (`categorize-ingredients`, `import-recipe`) → Logs for its console output, or Invocations for each request's status and duration.

### Read the AI calls

`public.ai_calls` has one row per model attempt, kept for 30 days, with no user id (spec 6.5). In the Table Editor, or:

```sql
select created_at, task, model, status, duration_ms, input_tokens, output_tokens, error
from public.ai_calls
order by created_at desc
limit 50;
```

Add `instructions, prompt, response_text, output` to see exactly what was sent and returned.

### See what admins have done

```sql
select created_at, action, target_user_id, note, details
from admin.admin_actions
order by created_at desc;
```

`performed_by` is always `postgres` from the dashboard, so the `note` is the only record of who asked and why.

## Snippets

Save these in the SQL Editor. Always fill in the note.

### Delete a user

Leaves each of the user's households by the app's rules: a household where they're the only member is deleted with all its lists and recipes; where they're the last owner, the member who joined earliest becomes the owner; otherwise they just leave and the household keeps its data. Then it deletes the account, with their profile, settings and aisle order. Items, check-offs and invites they made in shared households stay, with no name on them. It returns what happened to each household and records it in `admin.admin_actions`.

```sql
select admin.delete_user(
  p_user_id => '<user id>',
  p_note    => '<who asked, when, and why, e.g. "Deletion request from sam@example.com, email 2026-10-12">'
);
```

An unknown id raises `user not found` and changes nothing.
