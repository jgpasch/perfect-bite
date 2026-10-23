# Release

Backend first, app last. Details in [`alpha-testing.md`](alpha-testing.md#shipping-a-change).

| Command | Does |
|---|---|
| `yarn deploy` | Steps 1–5, app built on EAS |
| `yarn deploy:local` | Steps 1–5, app built on this Mac |
| `yarn deploy:backend` | Steps 1–4 only |
| `yarn deploy:ios:local` | Step 5 only: build on this Mac, then submit |
| `yarn build:ios:local` | Build on this Mac into `build/ios.ipa` |
| `yarn submit:ios:local [path]` | Upload `build/ios.ipa` (or `path`) to TestFlight |

## 1. Check what hosted will get

```bash
supabase migration list
supabase db push --dry-run
```

## 2. Database

```bash
supabase db push
```

## 3. Secrets (only if keys, models or caps changed)

```bash
supabase secrets set --env-file supabase/functions/.env.production.local
supabase secrets list
```

## 4. Edge Functions

```bash
supabase functions deploy
supabase functions list
```

## 5. App

Native change (new native module, extension code, `app.json`):

```bash
yarn dlx eas-cli build -p ios --profile production --auto-submit
```

EAS Build uploads source maps to Sentry when the `SENTRY_AUTH_TOKEN` secret is set (once: `yarn dlx eas-cli env:create --name SENTRY_AUTH_TOKEN --value <token> --visibility secret --environment production --environment preview`).

### Building locally

To build on this Mac instead of EAS's servers (no build credits, no queue):

```bash
yarn build:ios:local    # eas build --local into build/ios.ipa
yarn submit:ios:local   # eas submit of build/ios.ipa; pass a path for another .ipa
```

`yarn deploy:ios:local` runs both; `yarn deploy:local` runs the whole release with this build in place of the EAS one.

- Needs Xcode, CocoaPods and fastlane (`brew install fastlane cocoapods`). Signing still comes from the EAS account, so stay logged in to `eas-cli`.
- `--auto-submit` doesn't work with `--local`; submit is its own step.
- Local builds don't get EAS secrets, so the Sentry upload fails with "Auth token is required" unless the token is on this Mac. Put it in `~/.sentryclirc` (outside the repo):

  ```
  [auth]
  token=<token>
  ```

  Or run the build with `SENTRY_DISABLE_AUTO_UPLOAD=true` to skip source maps.

JS-only change:

```bash
yarn dlx eas-cli update --channel production
```

## Don't

- Run `supabase db reset --linked`. It wipes the hosted database.
- Edit a migration that's been pushed. Write a new one.
