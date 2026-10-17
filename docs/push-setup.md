# Push notifications setup

The by-hand steps to turn on push (spec 4.13, 8.5) for the hosted project. Run them yourself, in this order; nothing here is run by Ralph or CI. Local setup is in `AGENTS.md` (Supabase section).

Push needs a development or production build on a real iPhone. It doesn't work in Expo Go or on a simulator (the app doesn't register a token there).

## 1. APNs key

Expo Push talks to APNs with a key that EAS keeps for the project. One key covers development and production builds.

```bash
yarn dlx eas-cli credentials
```

Choose **iOS** → **production** → **Push Notifications: Manage your Apple Push Notifications Key** → **Set up Push Notifications for your project**, and let EAS create the key (or pick an existing one). The bundle id is `com.jgp.perfectbite`.

## 2. A new development build

`expo-notifications` is a native module, so builds made before it was added can't get a token.

```bash
yarn dlx eas-cli build --profile development --platform ios
```

or, with the iPhone plugged in, `yarn expo run:ios --device`. A production build (`docs/release.md` §5) is needed before TestFlight users get pushes.

## 3. Database

```bash
supabase db push --dry-run   # expect 20261103120000_push_notifications, 20261104120000_household_events, 20261105120000_send_notifications
supabase db push
```

This adds `pgmq`, `pg_net`, the `household_events` queue and its triggers, `push_tokens`, `notification_settings`, the worker's tables and the `send-notifications` and `push-sent-retention` cron jobs.

## 4. Edge Function

```bash
supabase functions deploy send-notifications
```

`supabase/config.toml` sets `verify_jwt = false` for it; it checks the secret API key itself and answers 401 to anyone else.

Optional: if you turn on Expo's enhanced security for push notifications (on expo.dev, beside the account's access tokens), create an access token there and set it:

```bash
supabase secrets set EXPO_ACCESS_TOKEN=<token>
```

Unset, the worker sends without an `Authorization` header.

## 5. Vault secrets

The cron job reads two Vault secrets and does nothing without them. In the hosted SQL editor (Dashboard → SQL Editor), first see what's there; `project_url` may already exist for `photo-cleanup`:

```sql
select name, created_at from vault.secrets order by name;
```

Then create what's missing. `notifications_worker_key` is a secret API key (Project Settings → API Keys → Secret keys; one just for this worker makes it easy to rotate):

```sql
select vault.create_secret('https://<project-ref>.supabase.co', 'project_url');
select vault.create_secret('<secret API key, sb_secret_…>', 'notifications_worker_key');
```

To change one later:

```sql
select vault.update_secret(
  (select id from vault.secrets where name = 'notifications_worker_key'),
  '<new secret API key>'
);
```

Check the job runs (it only calls the function when there are events queued or receipts to check):

```sql
select jobname, schedule, active from cron.job where jobname in ('send-notifications', 'push-sent-retention');
select status, return_message, start_time from cron.job_run_details
  where jobid = (select jobid from cron.job where jobname = 'send-notifications')
  order by start_time desc limit 5;
```

## 6. Send a test push

1. On the iPhone, in the new build, sign in and turn notifications on (Settings → Notifications → **Turn on notifications**).
2. Find its token in the hosted SQL editor:

   ```sql
   select t.token, t.platform, t.updated_at, p.display_name
   from push_tokens t
   left join profiles p on p.user_id = t.user_id
   order by t.updated_at desc;
   ```

3. Open Expo's push tool, https://expo.dev/notifications, paste the `ExponentPushToken[…]` as the recipient, give it a title and body, and for data use a list on that device, so tapping it opens the list:

   ```json
   { "url": "/list/<list id>", "kind": "items_added" }
   ```

   Or from a terminal (add `-H "Authorization: Bearer <EXPO_ACCESS_TOKEN>"` if enhanced push security is on):

   ```bash
   curl -H 'Content-Type: application/json' https://exp.host/--/api/v2/push/send -d '{
     "to": "ExponentPushToken[…]",
     "title": "Groceries",
     "body": "Alex added milk, eggs and 4 more",
     "sound": "default",
     "data": { "url": "/list/<list id>", "kind": "items_added" }
   }'
   ```

With the app closed it shows as a banner; with the app open it shows as an in-app notification instead. Then do the end-to-end checks in `manual-checks.md` with a second household member.
