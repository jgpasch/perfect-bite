# Future tasks

<!-- Planned work, not worked by Ralph. Move a section into tasks.md (in order) to start it. Same format: "- [ ] description", one per iteration. -->

## Recipe import: later (not tasks yet)

- Let the extension call `import-recipe` itself, using the scoped device token from `docs/spikes.md` §2 option C (built for Siri in M8). The sheet could then show the recipe name and ingredients before you tap Add, and household members would see it without the sharer opening the app (needs M5 sync, or the function writing household rows directly the way `siri-add` will).
- A servings multiplier and per-ingredient checkboxes in the share sheet ("I already have salt"), like Add to list (4.5).
- Recipes from screenshots or photos (a vision model) and from video pages (TikTok/Reels captions).
- Skip pantry staples (water, salt, pepper) when adding to the list, perhaps as a per-household "always have" list.

## Later (from the wishlist, not tasks yet)

- **Siri straight to the server.** Let the intent extension upload with the scoped device token (`docs/spikes.md` §2 option C) to a `siri-add` Edge Function, so a Siri add reaches the household without the phone's app opening. Needs M5 sync. Spec 4.9 already describes `siri-add`.
- **Recipe import from a photo or screenshot.** Take a picture or share a screenshot; a vision model reads the recipe name and ingredients. Reuses the recipe-import pipeline (schemas, `ExtractedRecipe`, categorize-in-the-same-request, failed imports); the new parts are an image input to the share extension (activation rule for images, downscale and cap before upload) and an in-app "From photo…" using the camera/photo picker, plus an `extract-recipe-image` AI task with its own caps, rate limits and kill switch. Images are never stored after extraction.
- **Send a recipe URL from a laptop or other device.** Chosen approach: the same share extension, running on Apple Silicon Macs. Spike first: confirm an iPhone-only app and its share extension install and appear in macOS Safari's share sheet ("Designed for iPhone"; or set `supportsTablet: true` for "Designed for iPad", which also means checking every screen at iPad sizes), whether the App Group queue and the extension work there, and how TestFlight distributes it to a Mac. Installing on a Mac stays optional. Alternatives if the spike fails: a household email-in address, a small signed-in web page to paste links into, or a browser extension/bookmarklet.
- **Copy to household** (spec 4.5, 5 `copy_recipe`). Not built yet. When it is, the copy must carry over `tags`, `tags_edited` and `total_minutes` (spec 4.14), with a test that a copy keeps them.
- **Admin portal (only if someone besides me needs admin).** A web client on the same backend, calling the same `admin` SQL functions (from the Admin and plans tasks). Admin-only via an `app_admins` table and `is_admin()`; privileged actions through Edge Functions or admin-gated RLS, never a service-role key in the browser. Can run locally against the hosted project (allow `localhost` in Auth redirects, the Google web OAuth client and Edge Function CORS); host it only if it's needed away from the laptop.
