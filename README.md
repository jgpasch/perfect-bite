# The Perfect Bite

A shopping list that sorts itself by aisle, remembers which recipe each ingredient came from, and is shared by your household. Add items by typing or with "Hey Siri, add to The Perfect Bite".

See [`docs/spec.md`](docs/spec.md) for the full product and technical spec.

## Stack

Expo (SDK 57) + Expo Router · Swift App Intents (Siri) · Supabase (Postgres, Auth, Realtime, Edge Functions) · Vercel AI SDK

## Local development

Prerequisites: Node, Yarn 4 (pinned in `mise.toml` and `packageManager`; `mise install` or `corepack enable` provides it), Docker, the [Supabase CLI](https://supabase.com/docs/guides/local-development/cli/getting-started), and Xcode with CocoaPods.

Local Supabase uses ports **553xx** (API on 55321, Studio on 55323, mail on 55324) instead of the CLI's 543xx defaults, so it can run alongside stash.

### One-time setup

```bash
yarn install

# Local Supabase: Postgres, Auth, Realtime, Studio (http://127.0.0.1:55323)
supabase start
supabase db reset                          # apply migrations and seed.sql

# App env: fill in the publishable key from `supabase status`
cp .env.example .env.local

# Edge Function secrets: add an AI provider key (or use AI_MODEL_CATEGORIZE=mock)
cp supabase/functions/.env.example supabase/functions/.env
```

### Each session

Run these in separate terminals:

```bash
supabase start                                               # no-op if already running
supabase functions serve --env-file supabase/functions/.env  # Edge Functions, hot-reloads
yarn expo start                                              # Metro dev server
```

Don't rely on the edge runtime that `supabase start` launches; it isn't always running. `functions serve` is the reliable way to serve the functions with your secrets loaded. A `503` from `http://127.0.0.1:55321/functions/v1/<name>` means `functions serve` isn't running.

Dev sign-in is email + 6-digit code; local Supabase delivers the code to the mail viewer at http://127.0.0.1:55324.

### Development build

Siri and Google sign-in need a development build rather than Expo Go. Build again whenever native code or `app.json` changes:

```bash
yarn expo run:ios           # simulator
yarn expo run:ios --device  # physical iPhone
```

On a physical device, set `EXPO_PUBLIC_SUPABASE_URL` in `.env.local` to your Mac's LAN IP, not `127.0.0.1`. The first time, `expo run:ios` may fail with "No profiles for 'com.jgp.perfectbite'"; build once with `xcodebuild -workspace ios/ThePerfectBite.xcworkspace -scheme ThePerfectBite -destination 'id=<UDID>' -allowProvisioningUpdates build` (or from Xcode) to create the profiles.

### Database changes

```bash
supabase migration new <name>   # write SQL in supabase/migrations/
supabase db reset               # rebuild the local DB from migrations and seed
supabase test db                # pgTAP tests in supabase/tests/
```

## Checks

```bash
yarn expo lint
yarn tsc --noEmit
yarn jest
yarn dlx expo-doctor
```
