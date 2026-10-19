# Release

Backend first, app last. Details in [`alpha-testing.md`](alpha-testing.md#shipping-a-change).

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

JS-only change:

```bash
yarn dlx eas-cli update --channel production
```

## Don't

- Run `supabase db reset --linked`. It wipes the hosted database.
- Edit a migration that's been pushed. Write a new one.
