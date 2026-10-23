# Admin portal

The Perfect Bite's back office (spec 4.12): a Next.js App Router app, run on your laptop against local or hosted Supabase. It holds only the project URL and publishable key. Every action is a `public.admin_*` database function that checks `private.require_admin()` first, so only accounts in `private.admins` can do anything (see [`docs/admin.md`](../docs/admin.md)).

It's its own Yarn project (own `package.json` and `yarn.lock`), not a workspace of the app, and it isn't Expo. From the repo root, run everything in it as `yarn --cwd admin <command>`:

```bash
yarn --cwd admin install
yarn admin                     # dev server at http://localhost:3000 (same as yarn --cwd admin dev)
yarn --cwd admin lint
yarn --cwd admin tsc --noEmit
yarn --cwd admin test          # Vitest
yarn --cwd admin build
```

## Switching between local and hosted

`admin/.env.local` holds both projects' URL and publishable key, and `SUPABASE_TARGET` picks one:

```bash
SUPABASE_TARGET=local     # or hosted
SUPABASE_LOCAL_URL=http://127.0.0.1:55321
SUPABASE_LOCAL_PUBLISHABLE_KEY=...
SUPABASE_HOSTED_URL=https://<project-ref>.supabase.co
SUPABASE_HOSTED_PUBLISHABLE_KEY=...
```

Change it and restart `yarn admin`, or override it for one run without editing the file: `SUPABASE_TARGET=hosted yarn admin` (the shell wins over `.env.local`). `next.config.ts` turns the chosen pair into `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (`lib/supabase/env.ts`). With `SUPABASE_TARGET` unset, those two are read from `.env.local` directly, as before.

## Against local Supabase

1. `supabase start` (and `supabase db reset` for a fresh database; the dev user is an admin).
2. `cp admin/.env.example admin/.env.local` (once). `SUPABASE_TARGET` is already `local` and the URL `http://127.0.0.1:55321`; set `SUPABASE_LOCAL_PUBLISHABLE_KEY` to the publishable key from `supabase status`.
3. Optionally fill it with demo users, usage and audit rows: `psql postgresql://postgres:postgres@127.0.0.1:55322/postgres -f supabase/seed-admin-demo.sql` (or paste the file into the local SQL editor at http://127.0.0.1:55323). Run it again after each `supabase db reset`; never against hosted. Its header says how to remove it.
4. `yarn admin`, and at http://localhost:3000 sign in with the dev user's email (jgpasch@gmail.com) and the 6-digit code from the local mail viewer (http://127.0.0.1:55324). The code form shows only when the URL is local. **Continue with Google** works locally only if the local Google provider has a Web client and `http://localhost:3000/auth/callback` is in `supabase/config.toml`'s `additional_redirect_urls`.

## Against hosted Supabase

1. In `admin/.env.local`, set `SUPABASE_HOSTED_URL` to `https://<project-ref>.supabase.co`, `SUPABASE_HOSTED_PUBLISHABLE_KEY` to the publishable key (dashboard → Project Settings → API Keys), and `SUPABASE_TARGET=hosted`. Never the secret or service-role key.
2. Your account must be in `private.admins` (docs/admin.md, "Add or remove an admin"). Anyone else who signs in sees only "Not authorized".
3. Once, for **Continue with Google**: reuse the app's existing Web OAuth client (`EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` in `.env.production`); don't create another. Native sign-in uses no redirect, so the client likely has none yet.
   - Google Cloud Console → APIs & Services → Credentials → that Web client: under Authorized redirect URIs, add `https://<project-ref>.supabase.co/auth/v1/callback`. Google can take a few minutes to apply it; a `redirect_uri_mismatch` right after usually means wait and retry.
   - Supabase → Authentication → Providers → Google: Client IDs must list the Web client **first**, then the iOS one (comma-separated), since the redirect flow uses the first. Client Secret is the Web client's secret (already set if the app's sign-in works).
   - Supabase → Authentication → URL Configuration → Redirect URLs: add `http://localhost:3000/auth/callback`.
4. `yarn admin`, and sign in at http://localhost:3000.

Next.js inlines `NEXT_PUBLIC_*` values when the dev server starts or the app is built, so restart `yarn admin` after changing `.env.local` or `SUPABASE_TARGET`.
