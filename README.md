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
