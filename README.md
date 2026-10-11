# The Perfect Bite

A shopping list that sorts itself by aisle, remembers which recipe each ingredient came from, and is shared by your household. Add items by typing or with "Hey Siri, add to The Perfect Bite".

See [`docs/spec.md`](docs/spec.md) for the full product and technical spec; the build order is §10.

## Stack

Expo (SDK 57) + Expo Router · SQLite on the phone (expo-sqlite + Drizzle) · Swift App Intents (Siri) · Supabase (Postgres, Auth, Realtime, Edge Functions) · Vercel AI SDK

## How the pieces fit

When you develop, everything runs on your Mac:

| Piece | What it is | Where |
| --- | --- | --- |
| **The app** | A development build of the iOS app | iOS Simulator (or your iPhone) |
| **Metro** | The dev server that sends the app its JavaScript and reloads it when you save | `yarn expo start`, port 8081 |
| **Phone database** | SQLite inside the app. Lists, items, recipes and categories live here | On the simulator/device |
| **Supabase** | The backend: Postgres, sign-in, Realtime, Edge Functions | Docker containers on your Mac, ports 553xx |

The app is **local-first**: it reads and writes its own SQLite database, so it works offline. Supabase currently handles sign-in, `profiles`, and the `households` and `household_members` tables behind the read-only Households screen. Syncing lists and recipes to Supabase arrives in milestone M5. Until then you won't see list data in Supabase Studio. That's expected.

### Supabase in a nutshell

[Supabase](https://supabase.com/docs) is a hosted Postgres database with extras: Auth (sign-in), Realtime (push changes to clients), Storage, and Edge Functions (TypeScript server code running on Deno).

The **Supabase CLI** runs the whole stack locally in Docker, so you can develop without a cloud project:

- `supabase start` starts the containers. The first run downloads images and takes a few minutes.
- `supabase stop` stops them. Your data is kept.
- `supabase status` prints the URLs and keys.
- **Migrations** (`supabase/migrations/*.sql`) are the source of truth for the database schema. You never edit tables by hand in production. Instead you write a migration, and `supabase db reset` rebuilds the local database from all migrations plus `supabase/seed.sql`.
- **Studio** is the web dashboard where you browse tables and run SQL: http://127.0.0.1:55323.

This project uses ports **553xx** instead of the CLI's 543xx defaults, so it can run alongside other Supabase projects (such as stash):

| Service | URL |
| --- | --- |
| API | http://127.0.0.1:55321 |
| Postgres | `postgresql://postgres:postgres@127.0.0.1:55322/postgres` |
| Studio (dashboard) | http://127.0.0.1:55323 |
| Mailpit (local email inbox) | http://127.0.0.1:55324 |

## Prerequisites (install once)

1. **Xcode** from the App Store. Open it once to accept the license and install the iOS Simulator. Then install CocoaPods: `brew install cocoapods`.
2. **Node** (LTS) and **Yarn 4**. Yarn is pinned in `mise.toml` and `packageManager`, so run `mise install` or `corepack enable`. Use `yarn`, never `npm`.
3. **Docker**: [OrbStack](https://orbstack.dev) (recommended on a Mac) or Docker Desktop. It must be running before `supabase start`.
4. **Supabase CLI**: `brew install supabase/tap/supabase`.

## First-time setup

```bash
# 1. Install JavaScript dependencies
yarn install

# 2. Start local Supabase (Docker must be running)
supabase start

# 3. Build the local database from the migrations and seed data
supabase db reset

# 4. Create the app's env file
cp .env.example .env.local
supabase status        # copy the PUBLISHABLE_KEY value...
# ...into EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY in .env.local

# 5. Create the Edge Function secrets file (not needed until there are functions)
cp supabase/functions/.env.example supabase/functions/.env

# 6. Build and install the app on the simulator (takes a while the first time)
yarn expo run:ios
```

Step 6 builds a **development build**: the native iOS app with Siri and sign-in support. Expo Go won't work. It also starts Metro for you.

## Every day

```bash
supabase start      # no-op if it's already running
yarn expo start     # Metro; press i to open the app on the simulator
```

The development build is already installed, so you don't need `expo run:ios` again. Re-run it only when native code, `app.json` or a native dependency changes. If the app shows a red screen saying it can't connect, Metro isn't running.

When you're done, press `Ctrl+C` to stop Metro and run `supabase stop`. Both are optional. Leaving them running is fine.

Once Edge Functions exist (M6+), run them in a third terminal:

```bash
supabase functions serve --env-file supabase/functions/.env
```

A `503` from `http://127.0.0.1:55321/functions/v1/<name>` means `functions serve` isn't running.

### Signing in

Dev sign-in uses your email and a 6-digit code. Local Supabase doesn't send real email. Open **Mailpit** at http://127.0.0.1:55324 to read the code. Any email address works.

## Looking at the data

**Supabase (server):** open Studio at http://127.0.0.1:55323, or use `psql`:

```bash
psql postgresql://postgres:postgres@127.0.0.1:55322/postgres
```

**The phone's SQLite database (where lists and recipes live today):**

```bash
sqlite3 "$(xcrun simctl get_app_container booted com.jgp.perfectbite data)/Documents/SQLite/perfect-bite.db"
```

Then `.tables`, or `select * from list_items;`.

**Adding a test household member:** invites don't exist until M7, so a household only has you. To see another member on Settings > Households > your household, sign in once as a second user (any other email, so they get a `profiles` row), then sign back in as yourself and run this in Studio's SQL editor or `psql`, with your email and theirs:

```sql
insert into public.household_members (household_id, user_id, role, position)
select hm.household_id,
       sam.id,
       'member',
       coalesce((select max(position) from public.household_members where user_id = sam.id), 0) + 1
from public.household_members hm
join auth.users me  on me.id = hm.user_id and me.email = 'you@example.com'
join auth.users sam on sam.email = 'sam@example.com';
```

This adds them to every household you're in. Leave the screen and come back to see them. Use `'owner'` instead of `'member'` to add a second owner. To remove them again: `delete from public.household_members where user_id = (select id from auth.users where email = 'sam@example.com') and role = 'member';`.

## Running on your iPhone

This installs the development build on your phone straight from your Mac. No TestFlight or App Store is involved. Signing uses the Apple team set in `app.json` (`appleTeamId`).

### One-time phone setup

1. Plug the iPhone into your Mac with a cable, unlock it, and tap **Trust** when it asks.
2. On the iPhone, turn on **Settings → Privacy & Security → Developer Mode**. It restarts, then asks you to confirm.
3. In Xcode, open **Settings → Accounts** and make sure you're signed in with the Apple ID on that team.

### Point the app at your Mac

The phone can't reach `127.0.0.1` on your Mac, because that address means the phone itself.

1. Find your Mac's Wi-Fi IP:

   ```bash
   ipconfig getifaddr en0          # e.g. 192.168.1.20
   ```

2. In `.env.local`, set:

   ```
   EXPO_PUBLIC_SUPABASE_URL=http://192.168.1.20:55321
   ```

3. Keep the phone on the same Wi-Fi as the Mac.

Change it back to `127.0.0.1` when you return to the simulator.

### Build and install

```bash
supabase start
yarn expo run:ios --device      # pick your iPhone from the list
```

This builds the app, installs it on the phone, starts Metro, and opens the app.

The first launch may say the developer isn't trusted. Fix it on the phone under **Settings → General → VPN & Device Management**: tap your Apple ID, then **Trust**.

After that, you don't need to rebuild. Start Metro with `yarn expo start` and open the app on your phone. It finds Metro over Wi-Fi, and the cable is optional.

If `expo run:ios` fails with "No profiles for 'com.jgp.perfectbite'", build once with Xcode to create the signing profiles. Get your phone's UDID from `xcrun xctrace list devices`, then run:

```bash
xcodebuild -workspace ios/ThePerfectBite.xcworkspace -scheme ThePerfectBite \
  -destination 'id=<UDID>' -allowProvisioningUpdates build
```

Then run `yarn expo run:ios --device` again.

Siri only works on a real device. The checks to do there are in `docs/spikes.md`.

### Sending it to other people (later)

To share the app with other people without a cable, use EAS (`yarn dlx eas-cli build --profile development` or a TestFlight build). That's set up in a later milestone.

## Changing the schema

There are two databases, so there are two kinds of migration.

**Supabase (Postgres):**

```bash
supabase migration new <name>   # creates supabase/migrations/<timestamp>_<name>.sql; write SQL in it
supabase db reset               # rebuild the local DB from all migrations + seed (wipes local data)
supabase test db                # run the pgTAP tests in supabase/tests/
```

**The phone (SQLite):** edit `src/db/schema.ts`, then generate a migration:

```bash
yarn drizzle-kit generate --name <name>   # writes src/db/migrations/
```

The app applies it on next launch.

## Checks

Run these before committing:

```bash
yarn expo lint
yarn tsc --noEmit
yarn jest
yarn dlx expo-doctor
```

`yarn jest` skips `supabase/`. The Edge Function tests run on Deno, from each function's folder (it has the `deno.json` import map). They use a mock model, so they need no API key:

```bash
cd supabase/functions/categorize-ingredients
deno test --allow-env --allow-read --allow-sys    # or: yarn dlx deno test ...
```

To try the categorize LLM call by hand, run the CLI from the repo root. It runs the function's own `categorize()`, with the same prompt and validation, against an in-memory store where every name starts unknown, so nothing is written to any database. It ignores the rate limits and the daily cap. It reads `supabase/functions/.env`, so set `AI_MODEL_CATEGORIZE` (and the provider key) there, or pass `--model`:

```bash
yarn ai:categorize "za'atar" "chicken thighs" "call mom"
cat names.txt | yarn ai:categorize -                  # one name per line
yarn ai:categorize --model mock milk                  # override AI_MODEL_CATEGORIZE for this run
yarn ai:categorize --raw milk                         # also the raw HTTP request/response bodies
yarn ai:categorize --quiet milk                       # just the table and totals
yarn ai:categorize --dry-run milk                     # print the instructions and prompt; no call, no cost
yarn ai:categorize --json milk                        # the raw { results } the app would get
yarn ai:categorize --thinking off milk                # Gemini thinking for this run (off|minimal|low|medium|high|default)
yarn ai:categorize --quiet --repeat 10 - < names.txt  # 10 runs, then p50/p95 latency (docs/spikes.md §4)
```

Every LLM call is printed in full as it finishes: model, prompt version, temperature, max output tokens, timeout, the instructions (system prompt), the prompt (user message), the model's response, any provider warnings or error, the finish reason, input tokens (and how many were cached), output tokens (and how many were reasoning), total tokens, and latency. A fallback attempt prints as a second call. `--raw` adds the exact JSON body sent to the provider (generation config and response schema included) and the provider's raw reply. Then it prints a table (name, category slug, `is_grocery_item`, status) and totals across calls. The limits match the function's: at most 100 names, and names over 64 characters fail. It exits 1 if any name `failed` and 2 on bad usage, so it works in a shell loop. The tests only ever run it with `--model mock`.

Run the golden-set eval whenever the categorize model or prompt changes (a new `AI_MODEL_CATEGORIZE`, or a new `prompts/categorize.vN.ts`), before deploying the change:

```bash
yarn ai:eval                                          # the model in supabase/functions/.env
yarn ai:eval --model anthropic:claude-haiku-5-5       # or try another model
```

It sends the ~100 hard names in `supabase/functions/categorize-ingredients/eval/golden.json` (ambiguous items, non-food, errands, and a few prompt-injection attempts) through the same `categorize()` and in-memory store as the CLI, in batches of 50 (one LLM call each). It prints the accuracy (category and `is_grocery_item` both right; `also` lists other aisles that count as right), how many injection names came back `other`/not a grocery item, how the rest of each injection batch did, and every miss. It uses the real model, so it costs tokens: it isn't part of CI or `deno test` (those test the eval's own logic with the mock). `--model mock` runs but its score means nothing. Compare the score with the last one recorded in `progress.md`, and add new misses you care about to `golden.json`.

### Adding an LLM task

See [docs/llm-calls.md](docs/llm-calls.md) for how the LLM calls fit together, every script flag, and the steps to add a new task.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| `supabase start` says Docker isn't running | Start OrbStack/Docker Desktop and try again. |
| `supabase start` says a port is in use | Another stack is on 553xx: `supabase stop --project-id <other>` or `docker ps` to find it. |
| App can't sign in / network errors | Check `supabase status`, and that `.env.local` has the right URL and key. Restart Metro after editing `.env.local` (`yarn expo start --clear`). |
| No sign-in email | It's in Mailpit (http://127.0.0.1:55324), not your real inbox. |
| Strange Metro errors after pulling | `yarn install`, then `yarn expo start --clear`. |
| Native build errors after pulling | `yarn expo run:ios` to rebuild. If still broken, `yarn expo prebuild --clean` and rebuild. Don't hand-edit `ios/`. |
| Want a fresh phone database | Delete the app from the simulator (long-press, then Remove App) and run `yarn expo run:ios`. |
