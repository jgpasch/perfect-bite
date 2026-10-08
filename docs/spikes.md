# M0 Spike Results

The three spikes from spec §10 M0. Each records what was done, what's still open, and the decision (or the decision needed).

| # | Spike | Status |
|---|---|---|
| 1 | Siri recognizes "add to The Perfect Bite" | Code ready and builds; **needs the device test below** |
| 2 | Token refresh from the intent extension | Desk analysis; **recommendation needs sign-off** |
| 3 | Sync engine (PowerSync) vs custom | Desk evaluation; **decision needed before M1** |

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
