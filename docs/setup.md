# Setup ledger

Every account, service, credential and one-time step behind this project, and where each is configured. It's the index: how-to steps stay in the linked docs, and this file says what exists and where to look. When you set something up by hand (a dashboard click, an `eas env:create`, a Vault secret), add a line here in the same commit.

Secret values never go in this file. Write down where they live.

Status: ✅ done · ⏳ partly done · ⬜ not started · ❓ unverified

## Accounts

| Service | What for | Identifier | Status | Details |
| --- | --- | --- | --- | --- |
| Apple Developer Program | Signing, TestFlight, APNs | Team `4537GH756L` (`app.json` `ios.appleTeamId`) | ✅ | [alpha-testing §1](alpha-testing.md#1-apple-developer-program) |
| App Store Connect | App record, TestFlight testers | `com.jgp.perfectbite` | ❓ | [alpha-testing §5–6](alpha-testing.md#5-first-build) |
| Expo / EAS | Builds, submit, updates, env vars, APNs key | Project `eb79b313-81d7-46ca-a28b-2666db613c67` (`app.json` `extra.eas.projectId`) | ✅ | [alpha-testing §4](alpha-testing.md#4-eas-setup), [release](release.md) |
| Supabase (hosted) | Postgres, Auth, Edge Functions, Vault, cron | Project ref `ardfjdorkkzymrqdihlw` | ✅ | [alpha-testing §2](alpha-testing.md#2-hosted-supabase), [admin](admin.md) |
| Google Cloud | Google sign-in (OAuth): app and admin portal share the Web client | Project ❓; client IDs in `.env.example` | ✅ (admin portal redirect URI ⬜) | [alpha-testing "Before this will work"](alpha-testing.md#must-have), [admin README](../admin/README.md#against-hosted-supabase) |
| Google AI (Gemini) | Categorize, recipe import, tags, photos | Key `GOOGLE_GENERATIVE_AI_API_KEY` | ✅ | [llm-calls](llm-calls.md) |
| Sentry | Crash and error reporting | Org ❓ / project ❓ | ⏳ token in EAS, SDK not installed | Below |

## Where secrets and config live

| What | Where | Committed? |
| --- | --- | --- |
| App env, local | `.env.local` (from `.env.example`) | No |
| App env, release builds | `.env.production` (public values only: Supabase URL, publishable key, Google client IDs) and EAS environment variables | `.env.production` yes |
| Admin portal env | `admin/.env.local` (from `admin/.env.example`): Supabase URL and publishable key only, the hosted values match `.env.production` | No |
| Edge Function secrets, local | `supabase/functions/.env` (from `.env.example`) | No |
| Edge Function secrets, hosted | `supabase/functions/.env.production.local`, applied with `supabase secrets set --env-file` | No |
| Google OAuth web client secret, local | `supabase/.env` | No |
| Google OAuth web client secret, hosted | Supabase dashboard → Auth → Providers → Google | — |
| Vault secrets (cron → functions) | `vault.secrets` in each database; `supabase db reset` wipes the local ones | — |
| APNs key | Held by EAS (`eas-cli credentials`) | — |
| Signing certificates, provisioning profiles | Held by EAS | — |
| Database password (hosted) | Password manager | — |

## EAS environment variables

| Name | Visibility | Environments | Why |
| --- | --- | --- | --- |
| `EXPO_PUBLIC_SUPABASE_URL` | ❓ | ❓ | Hosted Supabase for release builds |
| `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | ❓ | ❓ | 〃 |
| `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID` | ❓ | ❓ | Google sign-in |
| `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` | ❓ | ❓ | 〃 |
| `SENTRY_AUTH_TOKEN` | secret | production, preview | Source map upload during EAS builds (2026-10-18) |

Check against reality with `yarn dlx eas-cli env:list --environment production` (and `preview`, `development`).

## Hosted Supabase

| Thing | Set with | Check with | Status |
| --- | --- | --- | --- |
| Migrations | `supabase db push` | `supabase migration list` | ⏳ see [alpha-testing §2](alpha-testing.md#2-hosted-supabase) |
| Edge Functions | `supabase functions deploy` | `supabase functions list` | ⏳ |
| Function secrets: `GOOGLE_GENERATIVE_AI_API_KEY`, `AI_MODEL_*`, `EXPO_ACCESS_TOKEN` (optional) | `supabase secrets set` | `supabase secrets list` | ✅ (push token ❓) |
| Google auth provider | Dashboard → Auth → Providers | Dashboard | ✅ |
| Vault: `project_url`, `notifications_worker_key`, `photo_cleanup_key` | SQL editor, [push-setup §5](push-setup.md#5-vault-secrets) | `select name from vault.secrets` | ❓ |
| Auth site URL / redirect URLs (`perfectbite://`) | Dashboard → Auth → URL Configuration | Dashboard | ❓ |
| Admin portal sign-in: Web client first in the Google provider's Client IDs; `http://localhost:3000/auth/callback` in Redirect URLs; `https://ardfjdorkkzymrqdihlw.supabase.co/auth/v1/callback` in the Web client's authorized redirect URIs (Google Cloud) | Dashboards, [admin README](../admin/README.md#against-hosted-supabase) | Continue with Google at http://localhost:3000 | ⬜ |
| Admins (`private.admins`) | Table Editor or SQL editor, [admin.md](admin.md#add-or-remove-an-admin) | `select * from private.admins` | ⬜ |

## Push notifications

[push-setup.md](push-setup.md) has the steps. APNs key in EAS ❓, development build with `expo-notifications` ❓, `send-notifications` deployed ❓, Vault secrets ❓, test push sent ❓.

## Sentry

- 2026-10-18: `SENTRY_AUTH_TOKEN` added to EAS (secret; production and preview), so EAS builds can upload source maps.
- To do: install the SDK (`yarn expo install @sentry/react-native`, then follow the Expo guide for SDK 57), add its config plugin with the org and project slugs to `app.json`, wrap the root layout, and add the DSN (public, so it can go in `.env.production` or `app.json`). Upload source maps for `eas update` too, which the build-time token doesn't cover.
- Fill in the org and project above.

## Local machine

In the [README](../README.md#prerequisites-install-once): Xcode and CocoaPods, Node and Yarn 4 via `mise.toml`, OrbStack, the Supabase CLI, Deno for Edge Function tests. Local Supabase uses ports 553xx. Local Vault secrets: [AGENTS.md](../AGENTS.md#supabase).

## Log

One line per by-hand setup step, newest first. The tables above give the current state; this gives the order things happened in.

- 2026-10-18: `eas env:create SENTRY_AUTH_TOKEN` (secret; production, preview).
