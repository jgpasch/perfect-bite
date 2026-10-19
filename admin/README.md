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

## Against local Supabase

1. `supabase start` (and `supabase db reset` for a fresh database; the dev user is an admin).
2. `cp admin/.env.example admin/.env.local`. The URL is already `http://127.0.0.1:55321`; set `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` to the publishable key from `supabase status`.
3. Optionally fill it with demo users, usage and audit rows: `psql postgresql://postgres:postgres@127.0.0.1:55322/postgres -f supabase/seed-admin-demo.sql` (or paste the file into the local SQL editor at http://127.0.0.1:55323). Run it again after each `supabase db reset`; never against hosted. Its header says how to remove it.
4. `yarn admin`.

## Against hosted Supabase

1. In `admin/.env.local`, set `NEXT_PUBLIC_SUPABASE_URL` to `https://<project-ref>.supabase.co` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` to the publishable key (dashboard → Project Settings → API Keys). Never the secret or service-role key.
2. Your account must be in `private.admins` (docs/admin.md, "Add or remove an admin").
3. `yarn admin`, and sign in at http://localhost:3000.

Next.js inlines `NEXT_PUBLIC_*` values when the dev server starts or the app is built, so restart `yarn admin` after changing `.env.local`.
