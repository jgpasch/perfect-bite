This is an Expo/React Native mobile application. Prioritize mobile-first patterns, performance, and cross-platform compatibility.

The product and technical spec is [`docs/spec.md`](docs/spec.md); its build order is §10. Read the relevant sections before starting a milestone.

## Supabase

Local ports are 553xx, not the CLI defaults (543xx), so this project and stash can run at the same time. Migrations live in `supabase/migrations/`, pgTAP tests in `supabase/tests/` (`supabase test db`). Serve Edge Functions with `supabase functions serve --env-file supabase/functions/.env`.

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
