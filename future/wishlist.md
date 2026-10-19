# Wishlist

<!-- One line per idea we want someday but haven't written tasks for. When one gets tasks, move it into its own <feature>-tasks.md and delete the line here. -->

- **Category order per store**: a different aisle order for each store you shop at, instead of one order per user (spec 11.4, Q5).
- **Reorder households**: drag to set household order per user (spec 4.7); the server already has `household_members.position`, the device sorts by `created_at`. Only matters with 3+ households.
- **Import from Out of Milk, AnyList or Reminders**: bring a CSV export or a pasted list in as one bulk add, and seed household history so usual items work from day one.
- **Home screen quick actions**: long-press the app icon for "Add to <default list>", "Import recipe from clipboard" and "Open <last list>".
- **Recipe from a photo**: on-device text recognition of a recipe card or cookbook page, then the existing no-JSON-LD import path (4.10).
- **Unit conversion on recipes**: a metric ↔ US toggle on the recipe screen, display only, next to servings scaling.
- **DMCA agent and takedown contact**: register a designated agent with the US Copyright Office (about $6) and publish a takedown contact, for safe harbor over imported recipes stored on our servers. The user does this; not a code task.
- **Keep imported recipes private**: never publish an imported recipe outside its household (web pages, public share links). A rule for `web-app-tasks.md` and `copy-to-household-tasks.md`, where the copyright risk jumps.
- **Don't share cached steps across users**: the `recipe_imports` cache (spec 6.6) serves one user's copied steps to others; keep caching ingredients, tags and time, and reuse steps only from the same user's import (or accept it, since the cache lasts 30 days).
- **Meal plan: copy last week**: a **Copy last week** button and a "Nothing planned yet" empty week (board 3 I of the meal plan mockups, spec 4.16).
- **Meal plan: several entries per slot**: a main and a side. The data and slot queries already allow it; raise `MAX_ENTRIES_PER_SLOT` and design the cell (spec 4.16).
- **Household activity, later**: a "Show new items" view grouped by person, "Alex and Sam added 7" on Your lists rows, and counting items checked off by others. Never mocked up in detail; the "since you looked" card (spec 4.1) is the starting point.
- **End the design trials**: pick a font set and a plan grid style from the Design trials section in Settings, make them the only ones (update `theme.ts`, DESIGN.md and spec 4.16), remove the settings, the unused fonts from `app.json` and their `@expo-google-fonts/*` packages, and the losing grid styles.
- **Get the setup ledger up to date**: fill in the ❓ rows in [`docs/setup.md`](../docs/setup.md) (EAS env vars, hosted Vault secrets, APNs, auth redirect URLs, Google Cloud project, Sentry org and project) and tick off what `docs/alpha-testing.md` has done but not marked. The user does this; not a code task.
