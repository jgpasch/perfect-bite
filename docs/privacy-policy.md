<!--
DRAFT, not published. Written from docs/spec.md (5, 6.4, 6.5, 4.8, 4.12, 4.13) and docs/alpha-testing.md as of
2026-10-21. Keep it in step with the spec's privacy statements; publish it before the first external TestFlight
build, and have a lawyer read it first.

Open items before publishing (search for "TODO"):
- The developer's legal name, a contact email, the effective date.
- Supabase's hosting region (not stated anywhere in the repo).
- Confirm the commitments in "What we don't do".
- The activity log section describes the tasks.md work "A user's activity log in the portal". Remove it if that
  hasn't shipped when this is published.
- Age: the policy says the app isn't for children under 13; confirm that's the intent.
- The Photos and Camera permission strings in app.json only mention recipes; item photos use them too.
-->

# Privacy Policy

**The Perfect Bite**
Effective: TODO date
Contact: TODO email

The Perfect Bite is a grocery list, recipe and meal plan app you share with your household. This policy explains what we collect, why, who else sees it, how long we keep it and how to delete it. "We" means TODO developer's legal name.

## The short version

- You sign in with Google. We keep your email, name and profile picture.
- Your lists, recipes, meal plan and photos are stored on our servers so they sync between your devices and your household. Members of a household see that household's data.
- Some features send your content to AI providers (Google, and OpenAI for AI photos). We log those requests, with your account, for 30 days.
- We keep a log of the changes you make, with your account, for 90 days, to help with support and to spot misuse.
- We don't show ads, sell your data or track you across other apps and websites.
- You can delete your account in the app at any time.

## What we collect

### Your account

When you sign in with Google, we receive and keep your **email address**, your **name** and your **profile picture**. Your name and picture are shown to the other members of your households. We also record when you created your account and when you last signed in.

### What you put in the app

We store, on our servers:

- **Lists and items**: list names, items, quantities, notes, who added an item and who checked it off.
- **Recipes**: names, ingredients, steps, notes, tags, the web address a recipe came from, and the pages you scanned to import one.
- **Your meal plan**: which recipes are planned for which day and meal, and short notes.
- **Photos** you add to recipes and items, and AI photos you ask the app to make.
- **Households**: their names, who's a member and their role, and invitations, including the email address of someone you invite.
- **Settings**: your default list, your aisle order, the household's aisle choices and staples, and your notification settings (including quiet hours and your time zone).

All of this belongs to a household, and every member of that household can see it. Photos and scanned pages are stored privately and only household members can open them (and our admins, for AI photos; see below).

### Ingredient names

When you add an ingredient, its normalized name (for example "cucumber") joins a shared ingredient catalog used by everyone, so the app can sort it into an aisle. The catalog never records who added a name. We count how many households have used each name, and the app only suggests a name to other people once at least 3 households have used it, so one person's unusual entry isn't shown to others.

### Notifications

If you turn on notifications, we store your device's push token and platform (iOS or Android). A notification contains the list name, the first name of the person who added items, and up to two item names.

### Activity log

We record the changes you make that reach our servers: for example, adding or checking off an item, creating or editing a recipe, planning a meal, or joining a household. Each entry records what was done, when, in which household, and the names of the things involved (such as the item, list or recipe name), even if they were later deleted. It never records the text of notes, recipe steps or descriptions, or the email address of someone you invite. We don't record what you look at, search for or tap on.

### Error reports

When the app or our servers hit an error, we send an error report to Sentry. It identifies you only by an internal account id, never your email, and doesn't include your lists or recipes.

### On your device

The app keeps a copy of your household's data on your phone so it works offline, along with your sign-in session and device-only settings. If you use the Safari extension to save a recipe, it reads that page's address, title, text and main image so the recipe can be imported. If you use Siri to add items, what you said is kept on your phone until the app adds it to your list.

## AI features

These features send your content to an AI provider to do their job:

| Feature | What's sent |
| --- | --- |
| Sorting items into aisles | Ingredient names |
| Importing a recipe from a link | The page's text and recipe data |
| Importing a recipe from photos | The photos of the recipe |
| Suggesting tags | The recipe's name, notes and ingredients |
| Matching ingredients to steps | The recipe's steps and ingredients |
| Making an AI photo | First the recipe's name, ingredients and cuisine, to write a short description; then only that description, to draw the photo |

Today these go to **Google** (Gemini). AI photos are drawn by **OpenAI**. We may switch to **Anthropic** (Claude) for some features. These providers process the content to answer the request under their terms for API customers.

We keep a log of each AI request, including what was sent and what came back, with your account and household, so we can fix problems and prevent misuse. Images you photograph are never stored in that log, only a fingerprint of them. Logs are deleted after **30 days**. A request flagged by a safety check (for example, a photo request that isn't food, or one the provider refused) is kept for **180 days**, along with the requests linked to it.

When you import from a link, our server fetches that web page. We keep a cache of what was extracted from a page for 30 days, with no record of who asked.

## Who can see your data

- **Your household**: everything in the household, plus your name and profile picture.
- **Our admins**: the people who run The Perfect Bite can see your account details, your households and plan, how much of each AI feature you've used, your activity log, and your AI request logs, and can view AI photos. Viewing someone's AI request log or activity log is itself recorded. Admins can also reach the database directly to fix problems.
- **Service providers** who process data for us:
    - **Supabase**: hosts our database, sign-in, file storage and servers (TODO region).
    - **Google** (sign-in, and AI as above), **OpenAI** and **Anthropic** (AI as above).
    - **Expo** and **Apple**: deliver push notifications.
    - **Sentry**: error reports.

We don't share your data with anyone else, except if the law requires it.

## What we don't do

TODO confirm each:

- We don't show ads.
- We don't sell or rent your personal data.
- We don't use analytics or tracking tools, and we don't track you across other companies' apps or websites.
- We don't use your content to train AI models.

## How long we keep it

| Data | Kept |
| --- | --- |
| Your account, lists, recipes, plan and photos | Until you delete them, leave the household, or delete your account |
| AI request logs | 30 days (180 days if flagged) |
| Activity log | 90 days |
| Recipe link cache | 30 days |
| AI usage counters | 40 days |
| Notification delivery records | Up to 7 days |
| Photos you remove | Deleted from storage within about 15 minutes |

## Deleting your data

You can delete your account in the app (Settings). When you do:

- Your account, name, picture, settings and notification devices are deleted.
- You leave every household. A household you were the only member of is deleted, with all its lists, recipes, plan and photos.
- In households you shared, the items, recipes and other things you added stay for the other members, no longer linked to you.
- Your activity log is deleted, and other members' entries no longer name you.
- Your AI request logs are no longer linked to you, and are deleted on the usual schedule.
- The data on your phone is wiped.

A household owner can also delete a whole household, which deletes everything in it.

## Your rights

Depending on where you live, you may have the right to see, correct, export or delete your personal data, or object to how we use it. You can delete your data in the app as described above. For anything else, email TODO email and we'll answer within 30 days.

## Children

The Perfect Bite isn't meant for children under 13, and we don't knowingly collect their data. If you think a child has given us data, contact us and we'll delete it.

## Changes

If we change this policy, we'll update the date at the top and, for significant changes, tell you in the app.
