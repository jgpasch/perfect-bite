# M0 Spike Results

The three spikes from spec §10 M0. Each records what was done, what's still open, and the decision (or the decision needed).

| # | Spike | Status |
|---|---|---|
| 1 | Siri recognizes "add to The Perfect Bite" | Code ready and builds; **needs the device test below** |
| 2 | Token refresh from the intent extension | **Decided 2026-10-22**: option C, a scoped device credential, built first for share import |
| 3 | Sync engine (PowerSync) vs custom | Desk evaluation; **decision needed before M1** |
| 4 | Gemini 3.8 Flash latency (not M0; spec 6.4) | Thinking set to `low`; **timings to run by hand** |
| 5 | Step ingredients: can a model match ingredients to steps? (cook mode, spec 4.5) | Eval run 2026-10-16; **go**, on the recipe model |

---

## 1. Siri phrase recognition (spec 4.9, Q12)

### What's built

- `targets/add-intent/`: App Intents extension (`@bacons/apple-targets`, `type: 'app-intent'`, the same layout stash proved). `displayName` is `The Perfect Bite`; stash found the phrase trains as the target name otherwise.
  - `AddToPerfectBiteIntent`: two turns. Asks "What do you want to add?", queues the text, replies "Added *text* to *list*." `openAppWhenRun = false`.
  - `ListEntity` + `ListQuery` (an `EntityStringQuery`) read `siri/lists.json` from the App Group.
  - Phrase variants (every App Shortcut phrase must contain the app name):
    - "Add to The Perfect Bite"
    - "Add something to The Perfect Bite"
    - "Add an item to The Perfect Bite"
    - "Add to my The Perfect Bite list" (iOS fills `\(.applicationName)`; this one may read oddly and is here to compare)
    - "Add to *Costco* in The Perfect Bite" (list as a parameter)
- `targets/_shared/SiriQueue.swift`: App Group writer (atomic `.tmp` then rename, UUIDv7, `completeUntilFirstUserAuthentication`, `logs/native.log`). Adapted from stash's `CaptureQueue`.
- `app.json`: `INAlternativeAppNames` = "Perfect Bite", to test whether Siri accepts the name without "The".
- App side: `src/features/siri/app-group.ts` reads the queue and writes the list snapshot; `src/shared/schemas/siri.ts` is the envelope contract (Zod), with JSON fixtures as Swift writes them.
- Dev screen: **Settings → Developer → Siri spike** writes test lists (Groceries as default, Costco) and shows queued adds and the native log.

The app and the extension build for the simulator with `yarn expo run:ios`.

### Device test checklist

Setup is the same as stash (the Personal Team was enough there, so the paid program isn't needed yet): plug in the iPhone with Developer Mode on, then `yarn expo run:ios --device`. The first time, `expo run:ios` may fail with "No profiles for 'com.jgp.perfectbite'"; build once with `xcodebuild -workspace ios/ThePerfectBite.xcworkspace -scheme ThePerfectBite -destination 'id=<UDID>' -allowProvisioningUpdates build` (or from Xcode).

Then open the app, sign in (dev code), go to **Settings → Developer → Siri spike**, tap **Write test lists**.

- [ ] "Hey Siri, add to The Perfect Bite" → "What do you want to add?" → "two avocados" → "Added two avocados to Groceries." without opening the app; the add appears on the Siri spike screen
- [ ] Try each phrase variant above; record which ones Siri matches reliably (5 tries each)
- [ ] "Hey Siri, add to Perfect Bite" (no "The"): does `INAlternativeAppNames` make it work?
- [ ] "Hey Siri, add to Costco in The Perfect Bite" → added to Costco. If Siri doesn't know the list names, note it (see open question below)
- [ ] Same, phone **locked** (after first unlock since boot)
- [ ] The shortcut appears in the Shortcuts app with no setup; it can be assigned to the Action Button
- [ ] Record: time from "Hey Siri" to the reply; dictation accuracy for food words ("gochujang", "haricots verts", "za'atar")

**Open question for this test:** App Shortcut phrases with an entity parameter (`\(\.$list)`) usually need the app to call `updateAppShortcutParameters()` after the list names change, so Siri learns them. Our shortcuts live in an extension, and the app is React Native. If the list phrase doesn't work, the options are a small native module that calls it, or dropping the list phrase and keeping "add to The Perfect Bite" plus the default list.

---

## 2. Token refresh from the extension (spec 4.9)

Goal: the intent uploads the add right away (to `siri-add`) so a household member at the store sees it without the speaker opening the app.

### The problem

Supabase rotates refresh tokens: each refresh returns a new refresh token and invalidates the old one (after a short reuse interval, 10 s by default). If the extension refreshes the session from a shared Keychain, the app's supabase-js still holds the old refresh token in memory. Its next refresh fails ("Invalid Refresh Token: Already Used") and **the user is signed out of the app**. Re-reading storage on every foreground narrows the window but doesn't remove it, and supabase-js doesn't support that cleanly.

### Options

| Option | How | Verdict |
|---|---|---|
| A. Share the session, extension refreshes | Session in the shared Keychain; extension refreshes when the access token is near expiry | Risk of signing the user out, as above. No. |
| B. Share the session, extension never refreshes | Extension uses the access token only if it has more than ~60 s left; otherwise it only queues | Safe, but access tokens last 1 hour, so most Siri adds (app not opened recently) won't upload until the app opens. Defeats the point. |
| C. **Scoped device token** (recommended) | At sign-in, the app calls a `register-siri-device` function that returns a random token, stored hashed in `siri_device_tokens (user_id, token_hash, created_at, last_used_at, revoked_at)`. The app saves it in the shared Keychain (`afterFirstUnlock`). The extension sends it to `siri-add`, which accepts nothing else and can only add items to lists the user can access. Sign-out and account deletion revoke it. | No rotation, works locked, never touches the app's session. Small extra surface, limited to adding items. |

**Recommendation: C.** It needs a spec update to 4.9 and the M8 milestone (new table, two small functions, revoke on sign-out). Nothing to build in M0. Until M8, Siri adds upload when the app next opens, as in stash.

### Outcome (2026-10-22)

**C, generalized and built first for share import** (spec 6.12, plan `docs/share-server-import-plan.md` §2). Instead of a Siri-only `siri_device_tokens`, one `device_credentials` table holds scoped credentials (`scopes`, `share.ingest` now, `siri.add` when `siri-add` is built), one live per (user, app installation):
- `register-device-credential` (signed-in session) issues a 32-byte random token valid 90 days and stores only its sha256; the app renews it on foreground with under 30 days left, and a replaced credential keeps working for 24 h so a queued upload still lands.
- The app keeps `{ token, userId, installationId, expiresAt }` in a dedicated shared Keychain access group with `expo-secure-store` and `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY` (not backed up, readable while locked); the share extension reads it for its background upload to `share-ingest`.
- Sign-out revokes it when online and always deletes the Keychain item (offline, it stays valid server-side until it expires, a known limit); account deletion cascades; a lost device is revoked by an admin in the portal (`admin_revoke_device_credentials`, audited), with no in-app device list.
- Only `share-ingest` (and later `siri-add`) accepts it, each checking its scope; it never becomes a Supabase session, so the app's refresh token rotation is untouched.

Siri's own upload (spec 4.9, `future/siri-tasks.md`) reuses this with the `siri.add` scope.

---

## 3. Sync engine: PowerSync vs custom (spec 7.0)

This is a **desk evaluation** from PowerSync's current docs, not a hands-on prototype.

### Why this has to be decided before M1

PowerSync owns the local database: it uses `op-sqlite` (not `expo-sqlite`), defines the client schema itself, and stores data in its own tables behind views. Drizzle works on top through `@powersync/drizzle-driver`, which is still **beta**. So the choice changes the local data layer that M1–M4 build on. Switching at M5 would mean redoing it.

### What PowerSync would handle for us

- **Download, including multiple households.** Sync Streams can filter by membership with a subquery (rows whose `household_id` is in the user's `household_members`). PowerSync makes one bucket per household. Joining a household starts syncing it; leaving removes its rows from the device. That replaces our per-household cursors, the Realtime subscriptions, and the purge-on-leave logic (spec 7.2, 4.7), which are among the riskiest custom parts.
- **The local upload queue.** Every local write is queued and handed to our `uploadData` function when online.
- **Supabase integration.** Uses Supabase Auth JWTs directly. Uploads still go through Supabase, so RLS stays the authority for writes.

### What we would still build

- **Conflict resolution.** PowerSync's default is last-write-wins per upload; custom logic lives in our backend. We would keep `apply_mutations` (field-level, HLC timestamps, delete wins, offline-duplicate merge) and call it from `uploadData`. PowerSync's queue records which columns changed, which fits field-level patches; we'd add the HLC per change.
- **Error handling in `uploadData`**: which Postgres errors are permanent (constraint, RLS) vs retryable. PowerSync's example connector already sorts these.

### Costs and risks

- **Another service.** PowerSync Service runs alongside Supabase: PowerSync Cloud, or self-hosted with Docker. For local dev, the PowerSync CLI scaffolds a Docker Compose stack next to `supabase start` (PowerSync recommends self-hosting for local dev). That's one more thing to run every session and to host in production (Cloud has paid tiers; self-hosting needs a server and bucket storage).
- **Different SQLite library** than stash (`op-sqlite` instead of `expo-sqlite`), so less of stash's DB code carries over. Needs a development build (already true because of Siri).
- **Drizzle driver is beta.**
- **Security patch level matters.** PowerSync Service 1.20.0 had a bug where some subquery filters in Sync Streams (`edition: 3`) were ignored when deciding what to sync (CVE-2026-30870, fixed in 1.20.1). Our membership filter is exactly that pattern, so pin 1.20.1 or later.
- Large membership counts hit bucket limits (default 1,000), which doesn't matter for households.

### Recommendation

PowerSync fits this app's hardest problem (multi-household download and purge) well, and the parts it doesn't do (field-level conflicts) plug into it cleanly. The price is an extra service and a different local database stack than stash.

Before committing either way, run the **hands-on spike** the spec calls for, now rather than at M5: self-hosted PowerSync + local Supabase, a two-table version of the schema (`household_members`, `list_items`), and an Expo dev build with `op-sqlite` + the Drizzle driver. Check acceptance criteria 8 (live check-off across two devices), 13 (offline then reconnect), and 19 (leaving a household removes its data). About a day of work.

**Decision needed:** run the hands-on PowerSync spike before M1 (recommended), or skip it and go custom as the spec's default.

Sources: [PowerSync React Native & Expo SDK](https://docs.powersync.com/client-sdks/reference/react-native-and-expo), [Supabase + PowerSync](https://docs.powersync.com/integration-guides/supabase-+-powersync), [Local development with Supabase](https://docs.powersync.com/integrations/supabase/local-development), [Drizzle driver](https://docs.powersync.com/client-sdks/orms/js/drizzle), [Sync Streams examples](https://docs.powersync.com/sync/streams/examples), [Bucket count limits](https://docs.powersync.com/sync/streams/bucket-count), [GHSA-q6wc-xx4m-92fj](https://advisories.gitlab.com/npm/@powersync/service-core/GHSA-q6wc-xx4m-92fj/).

---

## 4. Gemini 3.8 Flash latency (spec 6.4)

Gemini 3.8 Flash took 40–60 s per categorize call against the 20 s timeout, most likely because thinking was on: no thinking config was sent, so the model picked its own level. The categorize task now sends Google provider options from `tasks.ts`, `thinkingLevel: 'low'` (`CATEGORIZE_THINKING`). `low` is the lowest level `@ai-sdk/google` 4.0.88 sends for Gemini 3.7+ Flash (it maps "no reasoning" to `low` for these models, and to `minimal` only for older Flash models), so `minimal` and a zero budget (`off`) may be refused or ignored by 3.8 Flash. The runs below will tell.

`AI_THINKING_CATEGORIZE` (`off`, `minimal`, `low`, `medium`, `high` or `default`) overrides the setting without a code change. `default` sends no thinking config, as before. The CLI's `--thinking` sets it for one run.

### How to time it

These are real-model calls, so they cost tokens and are run by hand. From the repo root, with `AI_MODEL_CATEGORIZE=google:gemini-3.8-flash` and the key in `supabase/functions/.env`:

```bash
jq -r '.cases[].name' supabase/functions/categorize-ingredients/eval/golden.json > /tmp/names-100.txt
head -25 /tmp/names-100.txt > /tmp/names-25.txt
for t in off minimal low default; do
  yarn ai:categorize --quiet --repeat 10 --thinking $t "za'atar"
  yarn ai:categorize --quiet --repeat 10 --thinking $t - < /tmp/names-25.txt
  yarn ai:categorize --quiet --repeat 10 --thinking $t - < /tmp/names-100.txt
done
```

Each run starts from an empty store, so every run sends all the names. A run's latency is the time its LLM call took. Runs that hit the 20 s timeout are flagged, and their latency is a floor (20 s), not the real time. Note any errors: a refused thinking setting shows as an `api_error` call.

### Results

Not run yet (see manual-checks.md). p50 / p95 in ms, 10 runs each.

| Thinking | 1 name | 25 names | 100 names | Errors |
|---|---|---|---|---|
| `off` (budget 0) | | | | |
| `minimal` | | | | |
| `low` (set now) | | | | |
| `default` (as before) | | | | |

### Decision

Pending the table. Keep `google:gemini-3.8-flash` as `AI_MODEL_CATEGORIZE`, and set `CATEGORIZE_THINKING` to the lowest setting that runs without errors. If the 100-name p95 is still over 20 s, first lower the per-call batch cap (`MAX_NAMES_PER_CALL`, spec 6.3), then raise `timeoutMs` to just above the p95, and say which in spec 6.3/6.4. Leave `AI_MODEL_CATEGORIZE_FALLBACK` unset unless Flash errors (not just slow).

---

## 5. Step ingredients (cook mode, spec 4.5)

Before building step ingredients in cook mode, we checked that a model can say which ingredients each step uses. A wrong ingredient on a step is worse than a missing one, so the bar was precision ≥ 95% and recall ≥ 85% on (step, ingredient) pairs.

### What's built

- The `matchRecipeSteps` AI task (`_shared/ai/tasks.ts`), with the prompt in `prompts/match-recipe-steps.v1.ts` and its rules in `prompts/step-match-rules.ts`, so the import prompt can share them later. `cleanStepMatch` checks the answer: unknown ingredients and repeats are dropped, a share that isn't below the total becomes none, and steps that don't line up fail the call.
- `supabase/functions/match-recipe-steps/match.ts` (`matchRecipeSteps()`, no store; the Edge Function around it, `handler.ts`, came next, spec 6.8), `yarn ai:steps` to try one recipe, and `yarn ai:eval:steps`.
- The eval set, `match-recipe-steps/eval/recipes.json`: 16 recipes, 100 steps and 220 needed pairs, labelled by hand. 13 come from the import eval's JSON-LD pages, with their ingredients as the import model extracted them, frozen so the eval scores matching only. 3 are typed in: tacos that split the limes across two steps, a Mexican Spanish *sopa de fideo*, and overnight oats with a step that tries to instruct the model. Some ingredients are labelled optional, where either answer is fair: a prepared ingredient mentioned again ("add the chicken back"), or salt for "salted water".

### Results

Run 2026-10-16, one call per recipe, in turn.

| Model | Precision | Recall | Shares right | Placed nowhere | Latency p50 / p95 | Tokens p50 in / out |
|---|---|---|---|---|---|---|
| `google:gemini-3.8-flash` (thinking `low`, the recipe default) | 220/220 (100%) | 220/220 (100%) | 214/214 | 1 of 217 | 2.5 s / 8.0 s | 1,010 / 184 |
| `google:gemini-3.8-flash`, thinking `off` | 100% | 100% | 214/214 | 1 of 217 | 2.1 s / 12.3 s | 1,010 / 138 |
| `google:gemini-3.5-flash-lite` | 220/222 (99.1%) | 100% | 214/214 | 1 of 217 | 1.2 s / 2.0 s | 1,010 / 163 |

`google:gemini-3.8-flash-lite` and `google:gemini-3-flash-lite` aren't available to our key (the call fails). Flash-Lite's two misses were salt on the step that boils the chicken (tinga) and oil on the step that slices the steak (beef and broccoli). Every model kept the injection step empty, matched the Spanish recipe, and gave the split limes as 1 of 3 and 2 of 3.

A recipe costs about 1,000 input and 200 output tokens. Pass `--price-in` and `--price-out` (USD per million tokens) to `yarn ai:eval:steps` to print a cost.

### Decision

**Go.** Keep matching on the recipe model, so `AI_MODEL_STEPS` stays unset and follows `AI_MODEL_RECIPE` (`google:gemini-3.8-flash`, thinking `low`). Matching runs in the background after a recipe is saved, so Flash's occasional slow call doesn't matter, and the 20 s timeout covers its p95. Flash-Lite is the cheaper fallback if cost ever matters: set `AI_MODEL_STEPS=google:gemini-3.5-flash-lite`.

The set is small and its labels are lenient where a recipe is ambiguous, so 100% means the bar is met, not that matching is perfect. Add a recipe to `recipes.json` whenever cook mode shows a wrong match, and re-run the eval before changing the prompt or the model.

### Matching inside the import (extract-recipe v4)

Run 2026-10-16: `yarn ai:eval:recipe` on `google:gemini-3.8-flash` (thinking `low`), v3 on `main` against v4, same 20 pages, one run each.

| | v3 | v4 |
|---|---|---|
| Ingredient precision / recall | 236/244 (96.7%) / 232/239 (97.1%) | 238/246 (96.7%) / 231/239 (96.7%) |
| Unit / quantity | 236/236 / 236/236 | 236/238 / 236/238 |
| Tags precision / recall (all facets) | 66/74 (89.2%) / 42/44 (95.5%) | 70/78 (89.7%) / 43/44 (97.7%) |
| Name, is_recipe, injection | 17/18, 20/20, 2/2 | 17/18, 20/20, 2/2 |
| Tokens in / out (20 pages) | 45,412 / 14,004 | 58,791 / 22,885 |
| Latency (20 pages, in turn) | 110 s | 147 s |

Step match on the 13 pages the steps eval labels: precision 191/191 (100%), recall 191/192 (99.5%), shares 187/187, 2 of 191 ingredients placed nowhere, no failures. The miss is one ingredient on the stuffed-peppers page.

v4's ingredient and tag scores are within one item of v3's. Its two amount misses are the pad thai page's tamarind and palm sugar read as 5 tbsp instead of 75 ml, the same amount. Matching inside the import is as good as the standalone call (100% / 100% on the steps eval's own frozen ingredients), so **imports keep `step_ingredients`** and the app saves it as the recipe's match, with no `match-recipe-steps` call. The cost is about 30% more input tokens, 63% more output and about a third more latency per import.
