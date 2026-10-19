# Admin portal

<!-- Status: ideas. Spec: 4.12, 5. -->

The portal's tasks are in `tasks.md` (section "Admin portal"). What's left here is for after it.

## Later

- Delete a user from the portal, through `admin.delete_user`.
- Move every user on one plan to another in one go.
- A one-off bonus for one user this month ("10 more imports") without moving them to another plan: a per-user, per-month addition that `private.monthly_limit` adds on.
- Estimated worst-case cost per user per month for each plan. The AI calls section's token sums get most of the way: add a price per model and divide by calls per feature.
- Usage history beyond 40 days: a monthly rollup per feature with no user id, kept long-term.
