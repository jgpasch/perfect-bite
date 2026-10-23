This is an Expo/React Native mobile application. Prioritize mobile-first patterns, performance, and cross-platform compatibility.

The product and technical spec is [`docs/spec.md`](docs/spec.md); its build order is §10. Read the relevant sections before starting a milestone.

Parked and future work lives in [`future/`](future/README.md), one `<feature>-tasks.md` per feature. Ralph works only `tasks.md`.

## Supabase

Local ports are 553xx, not the CLI defaults (543xx), so this project and stash can run at the same time. Migrations live in `supabase/migrations/`, pgTAP tests in `supabase/tests/` (`supabase test db`). Serve Edge Functions with `supabase functions serve --env-file supabase/functions/.env`.

pg_cron calls the `send-notifications` worker (every minute) and `photo-cleanup` through pg_net, using Vault secrets. `supabase db reset` wipes them, so to run either locally, seed them again (SQL editor at http://127.0.0.1:55323, or psql on port 55322). The database runs in a container, so the URL is the host's functions port 55321:

```sql
select vault.create_secret('http://host.docker.internal:55321', 'project_url');
select vault.create_secret('<SECRET_KEY from `supabase status`>', 'notifications_worker_key');
select vault.create_secret('<SECRET_KEY from `supabase status`>', 'photo_cleanup_key');
```

Without them the cron jobs do nothing.

Turning push on for the hosted project (APNs key, development build, hosted Vault secrets, deploys, a test push) is by hand: see [`docs/push-setup.md`](docs/push-setup.md).

## Admin portal

The admin portal (spec 4.12) is a Next.js App Router app in `admin/`. Run it with `yarn admin` (or `yarn --cwd admin dev`). Its env is `admin/.env.local` (copy `admin/.env.example`): `SUPABASE_TARGET` (local or hosted) plus each project's URL and publishable key, never a secret or service-role key. It's its own Yarn project (own `package.json` and `yarn.lock`), not a workspace, so run its commands from the root as `yarn --cwd admin <command>` (`install`, `add`, `lint`, `tsc --noEmit`, `test`, `build`). It isn't Expo: the Expo rules below don't apply there; follow `admin/AGENTS.md` and the Next.js docs in `admin/node_modules/next/dist/docs/`. The root's TypeScript, ESLint, Jest and Metro ignore `admin/`. Running it against local and hosted Supabase: [`admin/README.md`](admin/README.md).

## Expo has changed — do not trust your training data

Expo ships breaking changes every SDK release. APIs you remember are likely renamed, moved, or removed. Before writing any code that touches an Expo, EAS, or React Native API:

1. Read the major version of the `expo` package in `package.json`.
2. Fetch the matching versioned docs: `https://docs.expo.dev/versions/v<major>.0.0/`
3. For anything else, fetch https://docs.expo.dev/llms.txt — an index of all Expo docs with corrections to common LLM misconceptions. Follow its links to the specific page you need; never answer from memory.

## Commands

This project uses **Yarn 4** (`yarn.lock`, `nodeLinker: node-modules`). Use `yarn` instead of `npm`/`npx`, and `yarn dlx` for one-off tools that aren't dependencies. Never commit a `package-lock.json`.

```bash
yarn expo install <package>  # ALWAYS use instead of yarn add — resolves SDK-compatible versions
yarn expo start              # start the dev server
yarn expo lint               # lint
yarn tsc --noEmit            # typecheck
yarn jest                    # tests
yarn dlx expo-doctor         # diagnose dependency and config issues
yarn expo install --fix      # fix incompatible package versions
```

Run lint and typecheck before declaring any task done.

## Navigation & Routing

- Use **Expo Router** for all navigation. Routes live in `src/app/` — every file there is a screen, `_layout.tsx` files define navigators. Keep non-route code (components, hooks, utils) outside `src/app/`.
- Import `Link`, `router`, and `useLocalSearchParams` from `expo-router`.
- Docs: https://docs.expo.dev/router/introduction.md

## Building with EAS

Use EAS to build, sign, and submit the app in the cloud (`eas build`, `eas submit`) and to ship over-the-air updates (`eas update`) — no local Xcode or Android Studio required. Run EAS CLI as `yarn dlx eas-cli <command>`; substitute that for bare `eas` in docs examples.
Docs: https://docs.expo.dev/eas/index.md

## Rules

- If `ios/` and `android/` directories do not exist, they are generated (Continuous Native Generation). Never create or edit them by hand — configure native behavior in `app.json` and config plugins.
- Expo Go only includes its bundled native modules. After adding a library with native code, the app needs a development build: `yarn expo run:ios|android` locally, or `eas build --profile development`.
- Prefer recommended Expo modules over third-party libraries, and check your available skills before adding dependencies. Docs: https://docs.expo.dev/versions/latest/index.md

## Design

Follow [`DESIGN.md`](DESIGN.md) for colours, typography, spacing and component patterns. Use its tokens; don't hard-code colours or font sizes.
