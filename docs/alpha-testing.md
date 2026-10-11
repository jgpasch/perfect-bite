# Alpha testing on our phones

How to get The Perfect Bite onto two iPhones (mine and my wife's) through TestFlight. This pulls forward the TestFlight part of M9 (spec §10). Work through the sections in order: the app needs a hosted backend before a build is any use away from the Mac.

## Before this will work

Work the app itself still needs. Sections 1–7 are setup steps; this is the build work they depend on.

### Must have

- [ ] **Host the backend on Supabase.** Today everything runs on local Supabase on the Mac, which neither phone can reach away from home. Steps in section 2.
- [ ] **Google sign-in (Q13).** Replaces the dev sign-in stub (spec §4.8, M9). Until it lands, the email-code stopgap in section 3 works for two people.
  - [ ] New Google Cloud project (Q13's default: same setup as stash).
  - [ ] OAuth consent screen in Testing mode, with both our Gmail addresses as test users. That's enough for an alpha, with no Google verification.
  - [ ] OAuth client IDs: one iOS client (bundle ID `com.jgp.perfectbite`) and one Web client, which Supabase uses to verify the token.
  - [ ] Enable the Google provider on the hosted Supabase project with the Web client ID and secret.
  - [ ] Native Google sign-in in the app (check the SDK 57 Expo docs for the current recommended approach), exchanging the ID token with `supabase.auth.signInWithIdToken`. Keep the email-code stub for dev builds only.
  - [ ] Update spec §4.8 and close Q13.
- [ ] **Share extension compiles.** `targets/share-recipe` has never been built (`manual-checks.md`). An EAS build fails if any target fails, so do one local device build first and fix the Swift.
- [ ] **One full pass on a real device against the hosted backend:** sign in, add items and see them categorized, import a recipe, invite the other person to the household and see sync between the two phones.

### Should have

- [ ] **Siri on a device** (the open `[m]` task in `tasks.md`). Siri adds already land when the app next opens; the device checklist hasn't been run yet.
- [ ] **`expo-updates`**, so small fixes reach both phones without a new build (section 4).

### Not needed for the alpha

- Sign in with Apple (only for a public App Store release, spec §4.8 note).
- Universal Links for invites: `perfectbite://` links work between our two phones.
- The `siri-add` upload from the extension (spec §4.9): without it, a Siri add shows up for the other person once the speaker opens the app.
- Account deletion, privacy policy and App Store screenshots: needed for App Review, which internal TestFlight skips.

## 1. Apple Developer Program

- [ ] Enroll at developer.apple.com ($99/yr). Individuals are often approved the same day, but it can take a day or two.
- [ ] Check that `ios.appleTeamId` in `app.json` (`4537GH756L`) is the paid team's ID, not a free Personal Team. Fix it if not.
- [ ] Start sections 2 and 3 while enrollment is pending. They don't depend on Apple.

## 2. Hosted Supabase

Today the app only talks to local Supabase on the Mac.

- [ ] Create a Supabase project (free tier). Free projects pause after about a week with no activity, but daily use keeps them awake.
- [ ] `supabase link --project-ref <ref>`, then `supabase db push`. The catalog (categories and seed ingredients) is in the migrations, so it comes along. `seed.sql` (the dev user) stays local only.
- [ ] `supabase functions deploy categorize-ingredients` and `supabase functions deploy import-recipe`. Add `siri-add` once M8 lands.
- [ ] `supabase secrets set` for the keys in `supabase/functions/.env.example`: `GOOGLE_GENERATIVE_AI_API_KEY`, `AI_MODEL_CATEGORIZE`, `AI_MODEL_RECIPE`, and any daily caps.
- [ ] Smoke-test the hosted project from the simulator with `.env.local` pointed at it: sign in, add items (they get categorized), import a recipe link.

## 3. Sign-in stopgap (until Google sign-in)

Skip this section if Google sign-in (above) is done first. Otherwise the dev sign-in (email + 6-digit code, `signInWithOtp`) can work on hosted Supabase for two people, with two fixes:

- [ ] The email must contain the code, not a link. Push `supabase/templates/otp.html` with `supabase config push`, or paste it into Auth → Email Templates → Magic Link.
- [ ] Supabase's built-in email only sends to members of the Supabase org and is heavily rate limited. Either invite my wife's email to the org, or set up custom SMTP (for example Resend's free tier) under Auth → SMTP.
- [ ] Set the hosted Auth site URL and redirect URLs to the app scheme (`perfectbite://`).

## 4. EAS setup

- [ ] `yarn dlx eas-cli login` and `yarn dlx eas-cli init` (adds the EAS project ID to the app config).
- [ ] `yarn dlx eas-cli build:configure` to create `eas.json` with a `production` profile.
- [ ] Add EAS environment variables for production: `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` from the hosted project.
- [ ] Add `ITSAppUsesNonExemptEncryption: false` to `ios.infoPlist`, so App Store Connect stops asking about export compliance on every build.
- [ ] `yarn expo install expo-updates` and configure it, so JS-only changes can ship with `eas update` instead of a new build.
- [ ] Commit `eas.json` and the config changes. `ios/` is gitignored, so EAS generates it from `app.json` (CNG).

## 5. First build

- [ ] The share extension compiles locally ("Before this will work").
- [ ] `yarn dlx eas-cli build -p ios --profile production`. Let EAS create the distribution certificate and the provisioning profiles for the app and each extension target (`targets/add-intent`, `targets/share-recipe`), and register the App Group `group.com.jgp.perfectbite`.
- [ ] `yarn dlx eas-cli submit -p ios`. It can create the App Store Connect app record for `com.jgp.perfectbite`. Apple processes the build in about 10–30 minutes.

## 6. Testers

- [ ] In App Store Connect → Users and Access, invite my wife's Apple ID as a user with a limited role (for example Customer Support).
- [ ] In the app's TestFlight tab, create an internal group with both of us and add the build. Internal testers skip Beta App Review.
- [ ] Each of us installs the TestFlight app, accepts the invite, and installs The Perfect Bite.
- [ ] I sign in, then send her a household invite from Settings → Households. She opens it and joins, so we share lists and recipes.

## 7. Day-to-day

- JS-only changes: `yarn dlx eas-cli update --channel production`. Both phones pick it up on the next launch or two.
- Native changes (new native module, extension code, `app.json`): `yarn dlx eas-cli build -p ios --profile production --auto-submit`, then the build appears in TestFlight once processed.
- Bump `version` or let EAS auto-increment the build number (`autoIncrement` in `eas.json`), or App Store Connect rejects the upload.
- TestFlight builds expire after 90 days. Ship a new build before then.
- Feedback: taking a screenshot while using a TestFlight build offers to send it as feedback, which shows up in App Store Connect.
