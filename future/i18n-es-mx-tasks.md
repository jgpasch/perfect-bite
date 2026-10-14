# Mexican Spanish

<!-- Status: ready. Written as Ralph tasks; move one section at a time into tasks.md, in order. Spanish UI is done. Spanish input and the prune list are in tasks.md. The rest of Catalog trim and Spanish twins waits for the reviewed prune list. Spec: 4.15 (and 4.2, 4.3.2, 4.4, 5, 6.2, 6.4, 6.6). -->

The app's screens stay in English for users until the **Switch on Spanish** section: until then the app's supported languages are English only, and the Spanish UI shows only in a development build (`EXPO_PUBLIC_FORCE_LANGUAGE=es`) or through Settings > Language. **Spanish input** is different: typing Spanish, and the same thing in either language being one item, works whatever the app's language, so it reaches users as soon as it lands.

Units are a US supermarket's whatever the language (spec 4.15); a metric choice is planned separately in `future/units-tasks.md`.

Before any task that touches `expo-localization` or app config, read the SDK 57 docs: https://docs.expo.dev/versions/v57.0.0/sdk/localization/ and https://docs.expo.dev/guides/localization/ (the plugin's `supportedLocales`, and the `locales` key with `ios.infoPlist.CFBundleAllowMixedLocalizations` for translated permission strings).

## Catalog trim and Spanish twins

The prune list task is in tasks.md; the rest waits until `docs/seed-prune.md` is reviewed. Goal: a smaller English seed the user has chosen, and a Mexican Spanish twin for every name in it, so a Spanish typist gets suggestions and matches without waiting for the categorizer.

- [ ] Apply the prune list. Only when `docs/seed-prune.md` says `Reviewed: yes`; otherwise stop and say so in progress.md. Remove every ticked name from `ingredients.ts` (and from `ingredients-es.ts` links that point at one, which then become unlinked with their own category and unit) and regenerate the seed SQL. A migration deletes the removed seed rows from the catalog only where no household has used them (`ingredient_households`); used ones stay as ordinary catalog rows (`categorized_by` unchanged). Check how the device catalog pull handles a deleted row and make phones drop it, with a test. Update the golden set and `ai:check-seed` if they name a removed one, and spec 6.2's "about 7,000". Delete `docs/seed-prune.md`. The user pushes the migration.
- [ ] Spanish twins for the seed (spec 4.15). Add a Mexican Spanish name for every English seed name that doesn't have one yet to `ingredients-es.ts`, using the shared word list: none for brands or names that are the same word in both. Link exact equivalents (`linked_by = 'seed'`); leave the rest unlinked with their own category and unit. Write `docs/i18n/seed-es-review.csv` (key, English, Spanish, linked, notes; UTF-8 BOM, like `es-review.csv`) with every new name, doubtful ones marked in notes, for the native speaker. Regenerate the seed SQL and the `-es` plural list (the collision test must pass). A migration upserts the Spanish rows and links; a seed link replaces a model-made link on the same name. The user pushes the migration.
- [ ] Translate the rest of the catalog. `yarn ai:translate-catalog`: for hosted catalog rows that are categorized grocery items with no twin (and no `same_as`, and not the target of one), send them in batches of up to 100 through the same `categorize.v3` translation and linking as live adds (reuse its server code, so the same checks apply; don't recategorize). A dry run that prints the counts and a sample unless `--apply`; `--limit N`; it stops at the global daily cap. Deno tests with the mock model. NEEDS A MANUAL CHECK: the user runs it against hosted, first dry, then with `--apply`.

## Switch on Spanish

Goal: Spanish-speaking phones get the app in Spanish. Only after the native speaker has reviewed `docs/i18n/es-review.csv` (and `docs/i18n/seed-es-review.csv` if the twins have been written) and the fixes are in.

- [ ] Switch on Spanish. `SUPPORTED_LANGUAGES = ['en', 'es']`; the `expo-localization` plugin's `supportedLocales.ios` (and `.android`) to `["en", "es"]`; `ios.infoPlist.CFBundleAllowMixedLocalizations: true` and a `locales.es` file with the Spanish permission prompts and display name (check which usage-description keys `app.json` and its plugins set today, and translate each). Remove the "until then" sentence from spec 4.15. NEEDS A MANUAL CHECK (needs a new development build): on a device with the phone in English, Settings > The Perfect Bite > Language > Español switches the app to Spanish and back; the in-app Settings > Language picker still wins over it and Same as phone follows it again; with the phone in Spanish (Mexico) the app opens in Spanish; add `2 tazas de harina`, `limones`, `leche` and check amounts, sorting and suggestions.

## After launch

Separate releases, in any order.

- [ ] Siri and the share extension in Spanish (spec 4.9). Read the current docs for App Intents phrase localization and how `@bacons/apple-targets` (or whatever `targets/` uses) bundles `.xcstrings`/`.strings` before starting. Spanish App Shortcut phrases ("Agrega ${item} a The Perfect Bite" and the variants the M0 spike chose), the intent's dialog and errors, and the share extension's UI strings in `targets/`. Spoken Spanish already parses (`siri-add` uses the shared parser). NEEDS A MANUAL CHECK on a real device with Siri set to Spanish (Mexico): say "Agrega dos litros de leche a The Perfect Bite" and check it lands on the default list as 2 l leche.
- [ ] Spanish recipe import (spec 6.6, 4.15). New extraction prompt version: keep the page's language for the name, ingredients and steps (never translate); ingredient lines go through the shared parser, so Spanish amounts work. Tag suggestion (6.7) is unchanged (slugs). Add two or three Spanish recipe pages (Mexican recipe sites, saved as fixtures) to the extraction tests and the eval. NEEDS A MANUAL CHECK: the user runs the extraction eval against the real model.
