# Server-completed share import: implementation plan

A recipe shared from Safari is imported entirely on the server (extracted, saved, and its ingredients added to the list), so it reaches every household device through normal sync without anyone opening the app. The list rules live once, in shared TypeScript that runs in the app and in Deno. Tasks are in `tasks.md` (section "Share import on the server"). Decided 2026-10-22; once spec.md is updated (task 1), the spec wins where they differ.

## 0. What the code already does (this changes some assumptions)

1. **Shared TypeScript already reaches Deno.** Edge Functions import `src/shared/` through an `@shared/` import map (`supabase/functions/*/deno.json`). Ingredient normalization, the quantity parser, display names, `familyKey`, `canonicalRecipeUrl` and the Zod schemas (including `ShareEnvelopeSchema`) are already shared. The remaining pure rules sit in `src/domain/`. Most have no device dependencies; `quantity-display.ts` imports i18n.
2. **List amounts are append-only rows, not an absolute quantity.**
   - An item (`list_items`) has many `list_item_contributions` (quantity, unit, source, recipe id). A Combine *inserts a contribution*.
   - Editing an amount either updates the item's single contribution or soft-deletes several and inserts one.
   - So per-field LWW doesn't lose concurrent additions: an import's contribution is a new row that no edit touches.
   - **The real hazards are stale decisions.** "Combine into item X" when X has since been checked or deleted hides the add. "Reopen X" (which soft-deletes X's contributions) when X has since been reopened and added to deletes amounts the planner never saw.
3. **`private.apply_mutation(mutation, uid)` (latest in `20261023120000_meal_plan.sql`) already carries the sync rules.** It handles:
   - the household membership check;
   - per-field HLC LWW with `field_clock`;
   - soft deletes as fields (delete wins);
   - counter deltas applied once per row+HLC (`private.applied_counters`);
   - `added_by`/`created_by` set from `uid`;
   - merging a second open item for the same ingredient, or its language family (spec 4.15), into the first, re-pointing contributions.
   It is the right primitive for server writes. The public `apply_mutations` wraps each mutation in a subtransaction that swallows errors, so it's the wrong wrapper for an all-or-nothing commit.
4. **Pull has no change log.** It uses per-household, per-table cursors on server `updated_at` (set by a trigger to `now()`, the transaction start), and each table's first page reaches 5 s behind its cursor (`src/sync/pull.ts`). Tombstones are `deleted_at`. Any row written through the normal tables, with normal `field_clock`s, syncs to every household device. **Constraint:** a commit transaction must be short (well under the 5 s overlap), or its rows can land behind a cursor that has already moved past them. No fetching or LLM work inside it.
5. **There's an existing open-item race.** No unique index or lock enforces "one open item per ingredient per list". Two concurrent transactions inserting open items for the same key each miss the other, and both stay open. This exists today between devices; a server writer makes it more likely.
6. **Categories and step matching are already server-side.**
   - `import-recipe` calls the categorizer inline, which upserts the global `ingredients` catalog including language twins. It returns each ingredient's status and category, plus a step match (`stepIngredients`).
   - The device's `ensureLocalIngredient` and `applyResults` only warm its local catalog copy, which syncs from the server anyway.
   - `ensureStepMatch` is a lazy fallback that runs when a recipe screen opens.
   - **Verdict:** categorization and the import's own step match are part of import completion (already done by extraction). Fallback step matching, categorize catch-up and photos stay after the fact.
7. **Activity logging needs a signed-in user; push events don't.** The user-activity triggers log nothing when `auth.uid()` is null (service role). The `household_events` triggers (push notifications) fire on every contribution insert regardless of who wrote it.
8. **Metering reserves before the work.** `check_recipe_import_limit` takes a per-user advisory lock and checks the per-minute, daily and monthly limits. If allowed, it **counts the import before any work**. Cache hits are counted, and nothing is refunded on failure.
9. **Privacy and SSRF are partly done.** Client-captured pages are never written to the URL cache (`import-recipe/handler.ts`). `fetch-page.ts` checks every redirect hop's resolved addresses against private, loopback and link-local ranges (max 5 redirects, 1 MB body).
10. **Recipe identity.** The recipe id is `uuidv5(importId)`, and an import reuses a live household recipe with the same canonical URL (`findRecipe`). Failed imports (`failed_imports`) are **device-local** SQLite only. The destination fallback (`resolveImportTarget`): a dead or archived list goes to the default list; a household the user left goes to the default list's household; no lists means nowhere.
11. **Entitlements.** Both targets have only the App Group (`app.json` `ios.entitlements`, `targets/share-recipe/expo-target.config.js`, and the EAS `appExtensions` entitlements under `extra.eas`). There's no Keychain access group yet.

## 1. Shared domain package

**Location:** `src/shared/domain/`, under the existing `@shared/` map. No new package tooling.

**Rules:**
- Pure TypeScript; no Drizzle, SQLite, fetch, Supabase, i18n or Expo.
- The only dependencies are other `src/shared` modules.
- An ESLint `no-restricted-imports` rule on the folder enforces this.

**Move (no behavior change):**
- `src/domain/duplicate-detector.ts` (`detectDuplicate`, `planBulkAdd`), already pure.
- `src/domain/usual-unit.ts` (`usualUnit`, `withDefaultUnit`, `unitKey`).
- `src/domain/position.ts` (`positionBetween`, for recipe-ingredient positions).
- The arithmetic half of `src/domain/quantity-math.ts` (`combineAmounts`). Formatting (`summarizeAmounts`, `formatAmount`) stays in the app because it needs i18n. The planner doesn't need display text; the toast's `totalAmountText` is computed by the device adapter.
- The pure import-save helpers now in `src/features/recipes/import.ts`:
  - `nameOf` and `servingsOf`;
  - `importedStepIngredients` (rewritten to take the new ingredient ids instead of querying);
  - the "recipe line with no amount of a counted thing is one" rule (now inside `applyAdd`);
  - the "reuse a live recipe with the same canonical URL" lookup, as a pure function over candidate recipes.

**New, pure:**

```ts
type ListSnapshot = {
  list: { id: string; householdId: string };
  combineLanguages: boolean;
  /** Live items whose own or family key matches any name in the batch. */
  items: { id: string; ingredientName: string; familyKey: string; checkedAt: string | null;
           liveContributionIds: string[] }[];
};
type UnitKnowledge = Record<string /*ingredientName*/, Unit | null | undefined>; // knownUsualUnit
type IdSource = (purpose: string, index: number) => string; // deterministic on the server

planListAdds(snapshot, adds: ParsedAdd[], meta, unitKnowledge, ids) => {
  writes: Write[];               // neutral: { table, id | key, fields, counters? }
  preconditions: Precondition[]; // see section 5
  results: AddOutcome[];         // kind per add, item id, contribution id (for undo/toast)
}

planRecipeImport({ extracted, target, existingRecipe, listSnapshot | null,
                   unitKnowledge, ids, at, userId }) => { writes, preconditions, summary }
```

**Two adapters, so the rules exist once:**
- **Device:** `addItemsBulk`, `addItem` and `save()` build the snapshot from SQLite, call the planner and execute `writes` through `insertRow`/`updateRows`/`upsertRow`, which create the outbox mutations as today. In-app imports, Siri and manual adds all use it.
- **Server:** the Deno worker builds the snapshot with the service-role client and sends `writes` and `preconditions` to the commit RPC (section 5).

**Parity tests:**
- `src/shared/__tests__/fixtures/plan/*.json` holds representative cases:
  - new item, combine, reopen, same-ingredient-twice-in-batch;
  - a family twin with and without combine-languages;
  - the counted-one rule;
  - a recipe-only import;
  - reusing an existing recipe by URL or by import id;
  - a step-match alignment mismatch.
- Run under Jest (`yarn jest`) and Deno (`deno test` in `supabase/functions/_shared/`).
- Write the device's current outputs as golden files before the move, so the refactor is proven not to change behavior.

## 2. Device credential

**Table `public.device_credentials`** (no client grants; service role and RPCs only):

```sql
id uuid pk, user_id uuid not null references auth.users on delete cascade,
installation_id uuid not null,            -- random, created once per app install, kept in the Keychain
token_hash bytea not null unique,         -- sha256 of the 32-byte random token
scopes text[] not null default '{share.ingest}',   -- later 'siri.add'
created_at, last_used_at, expires_at timestamptz not null,   -- 90 days
revoked_at timestamptz, revoked_reason text
-- one live credential per (user_id, installation_id): partial unique index where revoked_at is null
```

**Issuing and storage:**
- `register-device-credential` Edge Function, authenticated with the normal session (`withSupabase({ auth: 'user' })`). It revokes any live credential for this user and installation, creates a new one and returns `{ token, expiresAt }` once.
- The token is shown only in that response and stored only as a hash.
- The app stores `{ token, userId, installationId, expiresAt }` with `expo-secure-store`, using a dedicated shared access group (for example `$(AppIdentifierPrefix)com.jgp.perfectbite.shared`) and `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`. Verify both options in the SDK's expo-secure-store docs before building.
- `ThisDeviceOnly` keeps it out of backups and device migration. "After first unlock" lets a retried background upload run while the phone is locked.
- **Entitlements:** add `keychain-access-groups` to the app (`ios.entitlements`), to `targets/share-recipe/expo-target.config.js`, and to the EAS `appExtensions` entitlements so provisioning includes it. Check the built `.entitlements` of both targets.

**Renewal and revocation:**
- **Renewal:** on foreground, if under 30 days remain, register again. The old credential stays valid for a 24 h grace period, so an upload queued with it still lands.
- **Revocation:**
  - **Sign-out (online):** call a `revoke_my_device_credential(installation_id)` RPC, then delete the Keychain item.
  - **Sign-out (offline):** delete the Keychain item. The server credential then stays valid until it expires, a known limit to state in the spec. On the next sign-in for that install, registering revokes it.
  - **Account deletion:** the foreign-key cascade removes it.
  - **Account switch:** sign-out, then a new registration under the new user, with the same installation id.
  - **Lost device:** admin portal only for now. `admin_revoke_device_credentials(user_id)` is audited like the other admin RPCs and shown as a button on the user's page in the portal. There's no in-app control.
- **Scope:** the credential is accepted only by `share-ingest` (and later `siri-add`), each checking its scope. It never becomes a Supabase session.

## 3. Share extension

**On Save (`ShareModel.save`):**
1. Build the envelope with two new fields: `userId` (from the list snapshot, which the app now stamps with the signed-in user) and `v: 2`.
2. Write it atomically to `share/pending/<id>.json` (as today).
3. Read the credential from the shared Keychain. If it's missing, expired, or its `userId` differs from the envelope's, skip the upload; the app submits later.
4. Write the request body to `share/upload/<id>.json` and start a `URLSessionUploadTask` from that file on a background session.
   - **Session:** identifier `com.jgp.perfectbite.share.upload`, with `sharedContainerIdentifier = group.com.jgp.perfectbite`.
   - **Headers:** `Authorization: Bearer <token>`, `Idempotency-Key: <envelope id>`.
   - **Endpoint:** a fixed HTTPS URL built into the extension's Info.plist from config.
5. Record `share/upload-state/<id>.json`: `{ startedAt, attempts }`.
6. Show "Saved. We'll prepare it in the background." Close after about a second.

**Completion handling:**
- When a background session finishes after the extension has exited, iOS wakes the **containing app** and calls `application(_:handleEventsForBackgroundURLSession:completionHandler:)` with the session identifier.
- The app needs an Expo AppDelegate subscriber in a small local Expo module (Swift, in the repo's `modules/`; never hand-edit `ios/`). It recreates the session with that identifier, takes the delegate events and calls the completion handler.
- Delegate outcomes: on a 2xx it deletes `upload/<id>` and marks `upload-state/<id>` accepted. On anything else it leaves both for the app's reconciliation.
- **No response is trusted as final; reconciliation is the source of truth** (section 7). The local envelope is deleted only once the server reports the operation exists.

**Not promised:**
- Timing.
- Behavior offline.
- Behavior after a force-quit before the upload finishes. Uploads started by an extension generally survive the user force-quitting the *app*, but this has to be confirmed on a real device.
- The local envelope covers every gap.

## 4. Jobs: schema and state machine

**`public.share_imports`** (one row per operation; the id is the envelope id):

```sql
id uuid pk,                        -- operation id (envelope id)
user_id uuid not null,             -- from the credential or session, never from the payload
credential_id uuid null,           -- which device credential uploaded it (null: session)
household_id uuid not null, list_id uuid null, add_to_list boolean not null,
url text not null, url_key text not null,
payload_hash bytea not null,       -- sha256 of the canonical (url, household, list, addToList, page)
page jsonb null,                   -- the Safari capture; purged at done or permanent failure, or after 24 h
status text not null,              -- received | extracting | extracted | committing | done | failed
attempts int not null default 0, next_attempt_at timestamptz not null default now(),
lease_token uuid null, lease_expires_at timestamptz null,
error_code text null, error_kind text null,       -- transient | permanent | waiting (limits)
resets_at timestamptz null,                       -- for waiting on daily or monthly limits
metered_at timestamptz null,                      -- the import was charged
extraction jsonb null,                            -- RecipeImportResponse; purged 7 days after done
-- receipt (compact, kept for good):
recipe_id uuid null, applied_list_id uuid null, items_added int null, items_combined int null,
committed_at timestamptz null,
client_created_at timestamptz, app_version text, source text, created_at, updated_at
```

**RLS and access:**
- Select is allowed only where `user_id = auth.uid()`, through a view `my_share_imports` that leaves out `page` and `extraction`. That's what the sharer's devices use for the imports card.
- All writes go through service-role RPCs.

**State transitions:**

```
received ──claim──▶ extracting ──ok──▶ extracted ──claim──▶ committing ──commit──▶ done
    ▲                   │                   ▲                   │
    │  transient /      │ permanent         │  conflict ×3 or   │ permanent (no destination,
    │  waiting          ▼                   │  transient        ▼  not a member, not entitled)
    └────────────── (backoff) ──── failed ◀─┴───────────────── failed
failed ──user Try again (same id)──▶ received   (attempts reset; never re-charged if metered_at)
```

**RPCs (service role only, each short):**
- **`claim_share_import(p_kinds text[])`** picks the oldest due job in `received`/`extracted` (or with an expired lease) using `for update skip locked`. It sets `status` to `extracting` or `committing`, a fresh `lease_token`, `lease_expires_at = now() + 2 min`, and `attempts + 1`, then returns the row.
- **`reserve_share_import(id, lease)`:**
  - If `metered_at` is set, it returns `ok`.
  - Otherwise it runs the `check_recipe_import_limit` logic in the same transaction; on `ok` it sets `metered_at`.
  - Retries never charge twice.
  - Cache hits are charged, as today.
  - A permanent failure after metering is not refunded, as today (product decision 6).
- **`save_share_extraction(id, lease, extraction)`** is fenced: it updates only while `lease_token` matches and the lease hasn't expired, then moves to `extracted`.
- **`release_share_import(id, lease, kind, code, next_attempt_at, resets_at)`** records a transient, waiting or permanent outcome.
  - **Backoff:** 30 s, 2 min, 10 min, 1 h, 6 h, with jitter.
  - **Limit:** permanent after 8 attempts.
  - **Limits:** `rate_limited` (per minute) waits until the next minute without counting as an attempt. `daily_limit` and `limit_reached` are permanent failures that keep `resets_at` for the message; the user's Try again resubmits after the reset.
- **`commit_share_import(...)`** is in section 5.

**Errors:**

| Kind | Errors |
|---|---|
| Transient | network, 5xx, `unavailable`, model errors, `fetch_failed` (while the page capture is absent and the device can't help; see section 7), commit conflict, lease lost |
| Permanent | `not_a_recipe`, `invalid_url`, `not_entitled`, `daily_limit`, `limit_reached`, no destination, user no longer a member |
| Waiting | `rate_limited` (per minute) |

**Workers:**
- A `share-import-worker` Edge Function loops `claim` until there's nothing due or about 50 s have passed. Each job runs its phase:
  - **extracting:** reserve, then extract (no database transaction open), then `save_share_extraction`;
  - **committing:** build the snapshot, plan, then `commit_share_import`.
- **Triggers:** `pg_cron` every minute through `pg_net` with a Vault secret, the same pattern as `send-notifications`. On acceptance, `share-ingest` also starts the worker with `EdgeRuntime.waitUntil` to save a minute. **Cron is the recovery mechanism; `waitUntil` only speeds things up.**
- **Extraction:** reuses `import-recipe`'s `importRecipe` flow, refactored into `extractForImport(request, deps)`, minus the plan check and limit (done by `reserve`). The captured page is used exactly as the in-app path uses it and is never cached by URL.
- **Retention:** a daily cron nulls `page` (done/failed, or older than 24 h) and `extraction` (done for 7 days). It deletes rows older than a year, keeping the receipt columns until then.

## 5. Atomic server commit (the correctness core)

**Planning (Deno, outside any transaction):**
1. **Resolve the destination** with the same rules as `resolveImportTarget`: is the user still a member, is the list live, unarchived and in the household, otherwise the user's `default_list_id`, and recipe-only behaves as today. **Decision 3** covers what happens when the list is gone.
2. **Read the snapshot** through the service role:
   - the list row and its `updated_at`;
   - `households.combine_languages`;
   - live `list_items` on the list whose `ingredient_name` or family key is in the batch, with `checked_at` and live contribution ids;
   - the catalog `same_as` and `default_unit`, and `ingredient_unit_usage`, for those names;
   - an existing live recipe with id `uuidv5(op id)` or the same canonical URL in the household.
3. **Plan:** `planRecipeImport` returns `writes` and `preconditions`. Ids come from `uuidv5(op id + ':' + purpose + ':' + index)`, so a recompute after a conflict produces the same ids. That's harmless, but nothing relies on it for idempotency.

**Commit RPC `commit_share_import(p_id, p_lease, p_target jsonb, p_writes jsonb, p_preconditions jsonb)`**, `security definer`, service role only, one transaction:
1. `select … from share_imports where id = p_id for update`.
   - If `committed_at` is set, **return the stored receipt** (idempotent; lost responses and retries end here).
   - If `status <> 'committing'`, the lease token differs, or the lease has expired, raise `lease_lost`. Stale workers can't commit.
2. **Recheck authorization and destination:** the user is still in `household_id`; the target list (if any) is live, unarchived and in that household; the recipe-only household still exists. A failure raises `destination_changed`, which leads to a re-resolve and replan; it's permanent if nothing is valid.
3. **Lock:** take `pg_advisory_xact_lock(hashtextextended('list:' || list_id, 0))`. `apply_mutation` takes the same lock when it writes an open `list_items` row (a small change in a new migration). This serializes "is there an open item for this key" decisions for that list across server commits *and* device pushes, closing the existing double-open race (section 0 item 5).
4. **Check preconditions** (rows read `for update`):
   - `combine(item)`: the item is live and unchecked.
   - `reopen(item, checkedAt, contributionIds)`: the item is live, `checked_at` equals the planned value, and its set of live contribution ids equals the planned set.
   - `new(listId, key)`: no live item on the list with this own or family key (open *or* checked). With the lock held this is exact.
   - `recipeAbsent(id)` / `recipeReuse(id)`: the planned recipe still is or isn't there and live.
   - Any failure raises `plan_conflict`. The transaction rolls back, and the worker rereads, replans and recommits up to 3 times, then releases as transient.
5. **Apply:** call `private.apply_mutation(w, user_id)` for each write *without* a subtransaction, so any rejection aborts everything. **HLCs are assigned in the RPC:** device id `srv`, wall time is the larger of `clock_timestamp()` in ms and (the largest `field_clock` wall among the rows being updated, plus 1), and the counter is the write index. Server updates such as reopen's `checked_at = null` and soft-deleting contributions then win LWW over clocks that are ahead because of device skew, as a device's HLC would after observing them.
6. **Activity:** `set_config('app.actor_uid', user_id, true)`, with `private.log_user_activity` changed to `coalesce(auth.uid(), nullif(current_setting('app.actor_uid', true), '')::uuid)`. The import is then logged as the sharer's, with an `activity_action` of `recipe.imported_from_share`. The push triggers fire on the contribution inserts as they would for a device.
7. **Receipt:** write `recipe_id`, `applied_list_id`, `items_added`, `items_combined`, `committed_at`, `status = 'done'`, clear the lease and `page`, then return the receipt.

**Guarantees:**
- **Never done before committed:** `done` is written in the same transaction as the changes.
- **Retries are safe:** any retry after a timeout returns the stored receipt and never adds ingredients again. Contributions are new rows, so the receipt, not the ids, is what makes the import exactly-once.
- **Concurrent device edits:** the list lock plus `for update` row locks serialize with device pushes on the same items. A device change committed earlier invalidates a precondition, which leads to a replan. One committed later goes through ordinary LWW against server clocks, exactly as if another phone had made the import.
- **Short transaction:** a single round of reads and writes for one recipe (tens of rows), well inside the pull overlap.

## 6. Sync integration

- **No change to the pull protocol.** Server writes go through `apply_mutation` into the normal tables with normal `field_clock`, `updated_at` and soft deletes, scoped by `household_id`. Every household device pulls them like any other remote change, and Realtime (per-household channels) is the cue to pull.
- **One protocol change:** the per-list advisory lock in `apply_mutation` for open-item writes. It's backwards compatible and fixes the existing race.
- **The `ingredients` catalog:** written by the categorizer during extraction; devices pull it with its own cursor.
- **Usage counters:** written as counter deltas with the server HLC. `applied_counters` dedupes them, and the receipt prevents any second commit anyway.
- **No client claim, save or complete phase.** The device's only roles are submitting operations and showing their state.

## 7. Fallback, Try again and rollout

**App-side reconciliation** runs on launch, foreground, reconnect and sign-in, replacing today's local drain:
1. Read `share/pending/*.json`, keeping envelopes whose `userId` matches the signed-in user (version-1 envelopes without `userId`: see rollout).
2. Call `share_import_status(ids[])` (RPC, own rows only). For ids the server has, delete the local envelope and upload files. Submit ids it doesn't have to `share-ingest` **with the user's normal session** (the endpoint accepts a session or a device credential), using the same id and idempotency key.
3. **The old local extract-and-save path is removed for shares.** A delayed background upload and a foreground submit are the same operation id, so whichever arrives second gets the existing state back.
4. **Imports card:** reads `my_share_imports` (pending, waiting with `resets_at`, failed with a reason).
5. **Try again:** calls `retry_share_import(id)`, which moves the job from `failed` back to `received` with the same id, never re-charging if `metered_at` is set.
6. **Failed share imports move to server state,** visible on all of the sharer's devices (decision 8). `failed_imports` stays for in-app link and photo imports.

**`share-ingest` (POST):**
- **Auth:** a device credential (scope `share.ingest`, not revoked or expired, `last_used_at` updated) or a user session. The user always comes from authentication. If the envelope's `userId` is present and differs, the request is refused with 403 `account_mismatch`.
- **Validation:** `ShareEnvelopeSchema` (shared), plus an aggregate body limit of 2.5 MB (10 × 200 KB of JSON-LD + 50 KB of text + overhead), otherwise 413. The URL must be http(s); the household must be one the user belongs to; the list must be in it.
- **Insert:** `insert … on conflict (id) do nothing`, then:
  - a new or identical existing operation (same `user_id` and `payload_hash`) returns 202 with `{ id, status }`;
  - the same id with a different owner or payload returns 409 `operation_conflict`.
- **Then:** `waitUntil` starts the worker.

**Rollout:**
1. **Server first:** credentials, jobs, worker, commit, ingest, the activity actor and the list lock. Nothing calls them yet.
2. **App version N:** shared planner (no behavior change, golden tests), credential registration, reconciliation instead of the local drain, the AppDelegate subscriber, and the extension's background upload and new wording.
3. **Envelopes written before N** (no `userId`, `v` missing): submitted under the current session once, the same assumption today's drain makes.
4. **Older app versions** keep their local path. They never upload, and N never extracts shares locally, so an envelope is handled by exactly one path. The ingest endpoint and the old `import-recipe` coexist. The receipt's `recipe_id = uuidv5(op id)` matches what an old client would have created, so even a mixed case reuses the recipe. Mixed list adds are possible only if one install ran both versions on one envelope, which an app update makes impossible.
5. **Kill switch:** an `ai_settings`/feature flag makes `share-ingest` answer 503. Envelopes stay queued locally and are submitted later; nothing is lost.
6. **In-app "Import from link"** stays on the device path for now (the user is watching), but it runs on the shared planner.

## 8. Privacy and limits

- **Raw Safari captures:**
  - stored only in `share_imports.page`, readable by the service role alone;
  - nulled at completion or permanent failure, and after 24 h at most;
  - never written to the URL cache;
  - not logged (log sizes and counts only, as the extension does today).
- **Extraction results:** nulled 7 days after done.
- **Fetching:** server fetching uses the existing `fetch-page` guards. Photo fetching (`recipe-photos`) has to be checked for the same guard before shares can trigger it unattended.
- **Body limits:** enforced at ingest, with the per-field caps the extension already applies.
- **Rate limiting:** credential-authenticated ingest has its own per-credential rate limit (for example 30 a minute) in the safety-limits table, separate from import metering, so a leaked token can at most queue jobs that metering then limits.

## 9. Tests

| Area | Cases | Where |
|---|---|---|
| Idempotency | Same id twice returns 202 with the same state; lost acknowledgment (submit, drop the response, resubmit); same id with a different payload or user returns 409 | Deno function tests |
| Worker crashes | Crash after `reserve` (no double charge on retry), after extraction is saved (resumes at commit), after `commit` before the response (retry returns the receipt) | pgTAP for RPC fencing; Deno for the loop |
| Two workers | Both claim (only one gets it, `skip locked`); expired lease, the old worker's `save_share_extraction`/`commit` refused | pgTAP |
| Precondition conflicts | Item checked between plan and commit, which replans to reopen; item reopened and added to, which replans to combine, keeping the new contribution; open item created by a device push meanwhile (lock: exactly one open item); concurrent amount edit on the same item | pgTAP plus a Deno integration test against local Supabase |
| Independent imports | Two imports into one list with overlapping ingredients | pgTAP plus Deno integration |
| Destination | List deleted or archived (fallback per decision 3); membership removed (permanent, nothing written); household deleted; credential revoked or expired (401); account switch with old envelopes (not submitted under the new user) | pgTAP, Deno, Jest |
| Sync | A completed import pulled by another household device (Jest pull test with server-shaped rows and `srv` HLCs); activity rows written as the sharer; household push event queued | Jest, pgTAP |
| Planner parity | All fixtures | Jest and Deno |
| Rollout | Version-1 envelopes; reconcile deletes local files only after the server confirms | Jest |
| Real device (manual) | Dismiss the extension right away; airplane mode then reconnect; locked phone; force-quit the app before sharing and right after; second household device receives the recipe without the sharer opening the app | Manual |

## 10. Product decisions

**Decided by the product owner:**
- **The chosen list deleted or archived before processing:** fall back to the default list, as today. With no lists at all, save the recipe only into the household and say so ("Saved Lemon pasta. Its list was gone, so nothing was added.").
- **Import limits in the background: fail, don't wait.**
  - `daily_limit` and `limit_reached` are **permanent** failures, shown with the reason ("You've reached today's limit…"). The user taps Try again after the reset; nothing retries on its own.
  - The per-minute `rate_limited` is a short throttle and stays transient, retrying after the next minute.
- **The sharer gets a "recipe ready" push** when their share import completes (for example "Lemon pasta is ready", opening the recipe). It's a new push kind sent to the sharer's own devices.
  - A failed share import also pushes to the sharer ("Couldn't import that recipe", with the reason), opening the Recipes tab's failed imports.
  - Its own switch in Settings > Notifications, **Recipe imports**, on by default, covering both pushes (a `recipe_imports` column in `notification_settings`).
- **Share failures show on all of the sharer's devices** (server state), not to other household members.
  - The existing household push ("Alex added Tacos (8 items) to Groceries", spec 4.13) needs no change; it now goes out when the server commits.
- **Lost devices: admin portal only for now.** No in-app device list or "Sign out of other devices". Cancelling credentials is an audited admin RPC, `admin_revoke_device_credentials(user_id)`.

**Defaults, unless the product owner says otherwise:**
- **Concurrent amount edit vs import:** additive. The import's amount lands on top of an edit made at the same moment, which is what two phones do today.
- **An item checked off just before the import commits:** replan, so it reopens with the recipe's amount (spec 4.4), rather than adding to a checked item.
- **The sharer removed from the household before processing:** a permanent failure with nothing written.
- **Charging:** once per operation, cache hits charged, no refund on `not_a_recipe` or a failed fetch, as in-app imports today.
- **Wording:** "Saved. We'll prepare it in the background."
- **In-app link import:** stays on the device path for now, using the shared planner.

## 11. Ordered tasks

1. **Spec updates.** Spec 4.9 and 4.10 (share flow, wording, failures), 5 (new tables), 6.x (`share-ingest`, worker, credential functions), 7.2 and 7.3 (server writer, list lock, `srv` HLC), and the `docs/spikes.md` §2 outcome.
2. **Shared planner.** Golden fixtures from today's device behavior first. Move the pure rules to `src/shared/domain/`, add `planListAdds` and `planRecipeImport`, and switch `addItem`, `addItemsBulk` and import `save()` to the device adapter. Run the fixtures in Jest and Deno; the lint boundary rule applies.
3. **Server: list lock and activity actor.** Migration: the advisory lock in `apply_mutation` for open `list_items` writes; `app.actor_uid` in `log_user_activity`. pgTAP for the double-open race and the actor.
4. **Server: device credentials.** Migration, `register-device-credential`, revoke RPCs (own, plus the audited admin one), expiry and grace, and the admin portal's revoke button on the user page. pgTAP and function tests.
5. **Server: share import jobs.** Table, view, RLS, the claim, reserve, save, release and retry RPCs with fencing, retention cron. pgTAP.
6. **`share-ingest` function.** Dual auth, validation, limits, idempotency and 409, `waitUntil` kick, per-credential rate limit. Tests.
7. **Worker: extraction.** Refactor `import-recipe` into `extractForImport`, the worker loop, the cron schedule (Vault secret, documented in AGENTS.md alongside the others), error classes and backoff. Tests.
8. **Worker: commit.** Snapshot reader, plan, the `commit_share_import` RPC (all of section 5), the replan loop. pgTAP and an integration test, including the concurrency cases.
9. **"Recipe ready" push.** A new push kind for the sharer's own devices, queued by the commit (through `household_events` or a sibling queue) and sent by `send-notifications`. Tapping it opens the recipe. A permanent failure sends "Couldn't import that recipe" with the reason, opening the failed imports. The **Recipe imports** switch in Settings > Notifications (on by default) turns both off.
10. **App: credential.** Register, renew and revoke; `expo-secure-store` shared access group; entitlements in `app.json`, the share target config and the EAS `appExtensions`; the user id stamped on the list snapshot; sign-out and account-switch handling.
11. **App: reconciliation.** Replace the share drain with status, submit and delete; the imports card from `my_share_imports`; Try again as `retry_share_import`; version-1 envelopes.
12. **Extension and native completion.** Swift background upload (file-backed, identifier, shared container, idempotency key, upload state); envelope `userId`/`v: 2` (Zod schema, Swift `Codable`, contract test); new wording; the local Expo module with the AppDelegate subscriber for background session events.
13. **Real-device test pass** (section 9, last row), then turn the kill switch on.

Tasks 4 and 10 are the same credential work the "Siri straight to the server" idea needs.
