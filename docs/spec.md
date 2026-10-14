# Shopping List App: Product & Technical Spec (v0.2)

Working title: **The Perfect Bite**. A better "Out of Milk": a shopping list that auto-organizes ingredients by aisle category, ties ingredients to recipes, lets a household share everything, and takes adds from Siri.

This document is written to be handed to Claude Code as the build brief. Section 10 is the build order; section 12 lists open questions. Anything marked **[Default]** is a decision made in this spec to keep moving that the product owner can overturn. Anything marked **[SPIKE]** must be proven in M0 before the design depending on it is built.

### Changes from v0.1
- **Stack**: Expo + TypeScript instead of native Swift/SwiftUI, matching the stash project (`../stash`). Native Swift only for the Siri App Intent. Reuse stash's patterns and code where they fit (section 8.4).
- **Auth**: Google only. During development, use stash's dev sign-in stub (email + one-time code through local Supabase). Sign in with Apple is dropped.
- **Siri**: new requirement 12, "Hey Siri, add to The Perfect Bite" (section 4.9).
- **Notifications**: moved from non-goals to Later, with a design sketch so v1 doesn't block them (section 11).
- **Ingredients keyed by normalized name** instead of a client-provisional UUID, so offline adds need no id rewriting (sections 5, 6).
- **Sync**: field-level last-write-wins using client timestamps, replacing row-level LWW by server `updated_at` (section 7).
- **Households**: a user can belong to several households. The household owns all lists and recipes; users only have access through membership. Joining or leaving never moves data (section 4.7, Q1-Q3, Q6).
- **Local dev**: same setup as stash, spelled out in section 8.3.
- **Duplicates**: in-app adds, single and recipe alike, auto-Combine with an undo toast instead of a blocking prompt (section 4.4, Q10).
- **Schema fixes**: added `is_grocery_item`, household counting, `updated_at` columns; defined owner transfer; added a quantity display rule.

---

## 1. Goals and non-goals

### Goals (v1)
1. Fast capture: typing an ingredient and hitting return should be the whole interaction. Saying it to Siri should work too.
2. Lists organize themselves: items land in the right category section without the user doing anything.
3. Recipes are first-class: an ingredient on a list can remember which recipe(s) it came from.
4. Households share everything in real time, and the app works in a store with bad signal.

### Platforms
- **iOS** is the v1 target (needed for Siri), built with Expo.
- **Web** via react-native-web is Later. Keep it possible: no iOS-only APIs outside `targets/` and clearly isolated modules.
- **Android** is not a target, but nothing should rule it out.

### Non-goals (v1)
- iPad-optimized layouts, Apple Watch, Android.
- Prices, budgets, store/aisle maps, barcode scanning.
- Meal planning, pantry tracking. (Recipe import from URLs was a non-goal; it is now requirement 14, section 4.10.)
- Notifications (Later, section 11.1).
- Sign in with Apple, email/password accounts.

---

## 2. Requirements traceability

The user's numbered requirements, mapped to spec sections. (There is no requirement 3; see Q8.)

| # | Requirement | Spec section |
|---|---|---|
| 1 | Add ingredients to a shopping list | 4.2 |
| 2 | Associate ingredients with a recipe, starting from the recipe or from selected ingredients | 4.5 |
| 4 | Automatic categorization into sections | 4.3, 6 |
| 5 | First time any ingredient is seen (by any user), categorize it with an LLM | 6 |
| 5.1 | Batch those LLM requests | 6.3 |
| 6 | Household recategorization, affects everyone in that household | 4.3.2, 5 |
| 7 | Users can add other users to their account and share all data | 4.7, 5 |
| 7.1 | Data ownership for shared accounts (deferred) | 12 |
| 8 | Duplicate adds: combine quantity or remove duplicate (auto-combine with undo, per Q10) | 4.4 |
| 9 | Per-user category order | 4.3.3 |
| 10 | Multiple lists | 4.1 |
| 11 | View a list flat or grouped by recipe | 4.6 |
| 12 | "Hey Siri, add to The Perfect Bite" sends an ingredient to a list | 4.9 |
| 13 | Notifications: in app now (recipe import), push someday | 4.11, 11.1 |
| 14 | Import a recipe from a link (share sheet or in-app) onto a list | 4.10, 6.6 |
| 15 | Recipes are tagged by meal, cuisine, protein, diet, method and time, and the Recipes tab can be searched and filtered by them | 4.14, 5 |

---

## 3. Glossary

- **Household**: the "account" from requirement 7, and the **owner of all shared data**. A group of users who share all of its lists and recipes. A user can belong to several households and always belongs to at least one; a solo user is a household of one. Users never own lists or recipes directly.
- **Personal household**: the household created for a user at sign-up. Nothing special about it except that it exists from day one; it can be renamed, shared, or left like any other.
- **Ingredient**: a global, canonical catalog entry (e.g. `milk`), shared across *all* users of the app, identified by its **normalized name**. Holds the default category.
- **List item**: an ingredient on a specific list, with a quantity and checked state.
- **Contribution**: one reason a list item is on the list (added by hand, by Siri, or from recipe X), with its own quantity. A list item has one or more contributions; its displayed quantity is their sum.
- **Category**: a store section (Produce, Dairy, ...). A fixed system set, plus optional custom categories, each belonging to one household.
- **Override**: a household's choice of category for an ingredient, replacing the global default for everyone in that household.
- **Default list**: the list Siri adds to when the user doesn't name one. Per user.

---

## 4. Product behavior

### 4.1 Lists (req 10)
- A household can have any number of lists. Each list belongs to exactly one household and has a name, an optional emoji, a colour, and a sort position.
- **List colour**: one of the aisle hues (green, blue, rose, amber, grey; DESIGN.md), or **Default** (stored as null). Like the name, it belongs to the list and syncs, so every member of the household sees the same colour, and any member can change it (the same rules as renaming). It is never per user or per device. A value the app doesn't know (a hue added by a newer version) shows as Default. Set it in the list's **Edit list** sheet (⋯ menu, **Edit list…**): a row of swatches, Default, Green, Blue, Rose, Amber, Grey, with the current one ringed. It shows as the list's dot in the Your lists sheet (below): the hue's dot; a Default list's dot is `primary` for the Siri default list and an empty ring otherwise. Archived lists keep their colour (faded like the rest of the row). Colour is decoration: VoiceOver reads the row the same whatever its colour.
- **The List tab is the list** (mockups E, G, H: https://claude.ai/artifact/M587vDvPQqF4KYAZEigusC). The first tab ("List", SF symbol `checklist`) shows the **current list** as its root screen: the list header, the rows and the add bar, with the tab bar showing. There is no Lists home and no Back. The current list is the list last shown on this device (`lastOpenedListId`, a device setting), falling back to the user's default list, then the first list; archived and deleted lists don't count. If the current list is deleted or archived (here or on another device), the tab moves to the next one by the same rule. With no lists at all the tab shows "No lists yet." with a **New list** button (and, while invites are waiting or lists are archived, a button that opens the Your lists sheet).
- **Switching lists**: the list's name in the header is a button with a small chevron after it, on one row with ⋯ (VoiceOver: "Groceries, switch list", hint "Shows your other lists"); it opens the **Your lists sheet**. While an invite is waiting (4.7) the chevron carries a dot, and the label adds ", 1 invite waiting".
- **Your lists sheet** (a native form sheet): "Your lists", with **Edit** and **New list** in its toolbar (New list asks which household in a native menu when there is more than one). Waiting invites come first (4.7), then all lists the user can see. With more than one household, lists are grouped per household under its name (VoiceOver: a header): the primary (oldest) household first, then the rest by name; a household with no lists still shows, with "No lists". With one household there is no household UI at all. The grouping follows joining or leaving a household live. Each row shows the list's colour dot, its name (with a mic mark on the Siri default list), the to-get count ("Done" when nothing is left), and a checkmark on the current list, whose row is tinted. Tapping a row makes it the current list and closes the sheet. Long-press: Rename, Make default for Siri, Archive, Delete (with confirm). Edit reorders by drag, within a household. At the bottom, "Archived lists (N)", when there are any, unfolds faded rows of the archived lists; tapping one offers Unarchive or Delete.
- **Opening a list from elsewhere** (a recipe's "Add to a list", a recipe import, moving an item to another list, the import notification, a `/list/<id>` link) makes that list current and switches to the List tab; nothing is pushed on top.
- The list's ⋯ menu has three items: **Select items** (4.5), **Share list** (plain text via the system share sheet), then, after a divider, **Edit list…**. Edit list is a sheet with Cancel and Done: the list's **Name**, its **Colour** (above), a **Default list for Siri** switch (on for the current default; turning it on for another list moves the default there), and a red **Delete list** in its own group, which asks first. Done saves the name, colour and Siri choice; Cancel drops them. **Uncheck all** and **Clear** are on the Checked section's header (4.6). Clearing, from either place, deletes every checked item at once with no confirmation; instead the list shows "Cleared 3 items" with **Undo** for 5 seconds, which brings exactly those items back, still checked, with their amounts. An item whose deletion changed in the meantime (deleted again on another device) stays deleted. Uncheck all works the same way: no confirmation, and "Unchecked 6 items" with **Undo** for 5 seconds, which checks exactly those items again with their original check time and checker. An item that merged into an open item of the same ingredient when it was unchecked is split back out (its amounts back on it, checked again; the open item keeps only what it had). An item changed in the meantime (checked, unchecked, edited or deleted, here or on another device) is left as it is. Nothing to uncheck shows no toast.
- Each user has a **default list** [Default: the first list, "Groceries"], changeable in Settings and in a list's Edit list sheet ("Default list for Siri"). If the default list is deleted or archived, the first remaining list becomes the default.
- **Launch**: a signed-in launch opens the List tab on the current list (above). Returning from the background keeps whatever screen was open, and the add field is not focused on launch (the keyboard would cover the list).
- **Keep screen on** (shopping with a cart): while a list is on screen, the app is in the foreground and the list has at least one unchecked item, the screen doesn't auto-lock (`expo-keep-awake`, one tag per list screen so two mounted screens can't release each other's lock). "On screen" is the List tab or a sheet over it (this list's own sheets, such as edit item and Edit list, and the Your lists sheet), since you're still shopping. When the last item is checked off or the list is empty, on another tab, a pushed screen or another sheet (e.g. Import from link), in the background, or with the setting off, it's released and the system's normal auto-lock applies; coming back to the foreground takes it again. The setting is Settings > Shopping > **Keep screen on**, a switch with the detail "While a list has items to get" (VoiceOver: "Keep screen on", hint "Stops the screen locking while a list has items to get"), default **on**. It's a device setting (`list.keepScreenOn`), not synced, since a phone in the store and an iPad on the counter want different things, and turning it off takes effect at once on an open list.
- **Checking off plays a light haptic**: checking an item, by tapping its check or swiping its row right, plays a selection tick (`Haptics.selectionAsync()`, a tick you can feel without looking, lighter than an impact), and Check all on a section (its header's swipe right or the recipe menu) plays the same tick once, however many items it checks. Unchecking plays nothing (it's a correction, not progress), nor do taps in Select mode (they select, not check). There's no in-app setting: iOS already silences it when System Haptics is off.

### 4.2 Adding items (req 1)
- A persistent add field sits at the bottom of the list screen. Typing shows autocomplete from (a) the household's recently used ingredients, then (b) the global ingredient catalog (filtered per 6.5).
- **Household history** (`ingredient_usage`, 5): one row per household and ingredient key with a use count, the last time it was used, and the most recent text typed for it. Adding an ingredient to a list counts one use (Combine included; undoing the add takes it back), and so does adding one to a recipe; adding that recipe to a list counts again. Editing doesn't count. History outlives list items and recipes: deleting an item doesn't forget that the household buys it. Existing data is backfilled once on upgrade.
- **Ranking**: history matches when the name or key starts with the typed text or has a word that does (`thi` matches `chicken thighs`). Matches are ordered by frecency, `use_count * 0.5^(days since last use / 30)`; at equal score a whole-name prefix match beats a word match, then shorter name, then alphabetical.
- **History first**: if history has 2 or more matches, only history is shown (up to the suggestion limit), so `chi` suggests the chicken thighs this household buys, not catalog chicken salad. With fewer, catalog items fill the remaining slots, deduped by key. As the user keeps typing, history drops out on its own (`chickp`), so the catalog still finds chickpeas.
- **Remove from suggestions**: long-pressing a history suggestion offers "Remove from suggestions", which hides that row (`hidden_at`). Using the ingredient again unhides it. Catalog suggestions don't have this action.
- **Add mode and the chip row**: on a list, focusing the add field enters add mode: the large title and view button collapse into the header, which shows the list's name over "8 to get · As added" (tapping it hides the keyboard); the add field stays above the keyboard with one horizontal, scrollable row of chips directly above it; the list fills the space between, its cards keeping the same inset and rounded corners as outside add mode. Hiding the keyboard leaves add mode (text in the field stays). Scrolling or checking off rows keeps the keyboard up. The chip row shows only while there's something to offer: with text, while something matches; with the field empty (whitespace counts as empty), the household's usual items (below). Matching nothing, or nothing usual, hides the row. The row grows upward into the list's space, so the field never moves. Autocorrect, spell check and autofill are off on the add field, so iOS's QuickType bar never shows above the keys; the chips are the only suggestions. While typing, the chips are autocomplete: recipe matches (below), then household history, then the catalog, with the typed part in green. Tapping a chip adds it exactly as typing its text and pressing Return would (Combine, highlight, toast, usage counted), clears the field and keeps the keyboard up, so several can be tapped in a row. Long-press on a history chip offers "Remove from suggestions". VoiceOver reads each chip as a button "Add <name>". While typing, each unchecked item whose ingredient name is the typed name or contains it as whole words (amount left out, normalized as an add, so plurals line up: `cumin` marks Cumin and Ground cumin, `pea` marks Peas, but `cum` marks nothing and `rice` doesn't mark Licorice) is tinted, with the matched word(s) in green and "already on list" in place of its amount; 4.4's duplicate handling still applies on add. In By aisle and By recipe, an add scrolls its section into view.
- **Usual items** (on a list only): while the add field is focused and empty, the chip row (VoiceOver label "Usual items"; "Suggestions" while typing) shows up to 12 of the household's usual items instead of autocomplete: `ingredient_usage` rows that aren't hidden and have `use_count >= 2` (a one-off isn't usual), leaving out any ingredient with an unchecked item on this list (a checked one stays, since adding it again reopens it as 4.4 says). They're ordered by the same frecency as autocomplete, `use_count * 0.5^(days since last use / 30)`, then the most recently used, then by name, so something bought every week stays at the front and something the household stopped buying drifts back on its own. Each is the plain item chip (no green, since nothing is typed), read as a button "Add <name>". Tapping one adds its name exactly as typing it and pressing Return would (no amount: Combine, highlight, toast with Undo, usage counted), keeps the keyboard up, and the chip leaves the row because the item is now on the list; it comes back when that item leaves the list (Undo, a delete, a sync). Long press offers "Remove from suggestions" as on history chips. No recipe chips in this row. Nothing usual (a new household, or everything already on the list) means no row. The recipe screen's add field shows nothing when empty.
- **Recipes in the add bar** (on a list only): autocomplete also matches the household's recipes by name, with the same prefix/word rule as history on the whole typed text (so `2 ta` matches no recipe), leaving out recipes with no ingredients. Up to 2 recipe chips lead the chip row, most recently used first (the later of the recipe's last change and its last add to a list), then prefix before word match, shorter name, alphabetical. They never take an item suggestion's slot. A recipe chip shows a fork-and-knife glyph and its name (the typed part in green) inside a green outline; VoiceOver reads it as a button "Add recipe Tacos, 8 items". Tapping it adds the whole recipe at 1× exactly as 4.4 bulk add does (every ingredient except the household's staples, 4.5 Always have; Combine; one "Added *Tacos* · 6 items" toast counting only what was added) with **Undo** and **Adjust**. When staples were left out the toast adds a second line, "Skipped salt, pepper" (more than three: "Skipped salt, pepper and 2 more"); when every ingredient is a staple nothing is added and the toast reads "You always have everything in *Tacos*" with only **Adjust**. Adjust opens the recipe's add sheet (4.5) on this list; adding from there replaces that add (it is undone, then the adjusted add is made), and Cancel leaves the first add as it is. Return always adds the typed text as a plain item, even when it exactly matches a recipe's name, so typing never surprises you.
- Return adds the item and keeps the keyboard up for the next one.
- **Where a new item appears** (4.6): in As added, at the top of the list (scrolled into view); in By aisle, at the bottom of its aisle's section, or in the Sorting… card at the top while its category is pending (4.3.1); in By recipe, in Other items. A Combine leaves the existing row where it is in every mode.
- Light quantity parsing on input: a leading number and optional unit are pulled out. `2 lbs chicken thighs` becomes quantity `2`, unit `lb`, name `chicken thighs`. `milk` has no quantity. Number words (`two avocados`) are parsed too, since Siri dictation produces them. The item row has an edit sheet for name, quantity, unit, note, and category.
- **The edit sheet**, top to bottom: the item's aisle icon, name and total, with a round **check** beside the name; for a checked item, the name struck through and "Checked <when> by you" under them (`checked_by`; other members' names aren't on the device yet, so their checks read "by someone else", and a check with no one recorded leaves the "by" off; *when* reads like the Added rows: "5 min ago", "yesterday", "Tuesday", "Mar 4"). The check (VoiceOver: "Got it", a checkbox) is the same write as the row's check, so sync behaves the same, and like the stepper it saves right away without saving the sheet's other edits; the sheet stays open either way (unchecking closes it if the item folds into the same ingredient already open on the list). Then the Name / Amount / Note card, the **Added** card (shown with more than one amount, or when one came from a recipe: 4.4), the aisle pills (4.3.2; the list household's aisles, the first six in the user's aisle order, always including the current aisle, then **Show all**, which shows the rest and "+ New", which creates the aisle in the list's household). An aisle choice is the household's: when it differs from the catalog default, a `footnote` in `inkSecondary` under the pills reads "Changes it for everyone in <household>." ("…in your household." with no name), with a plain **Reset to default** button under it that selects the default aisle; VoiceOver reads the footnote after the pills. Then an **Always have** switch row (4.5; VoiceOver: a switch "Always have", hint "Left off when you add a recipe") with the `footnote` "Left off when you add a recipe. Changes it for everyone in <household>." ("…in your household." with no name) under it; switching it saves at once, not on Save. Then **Move to another list…** (4.4; left out when the household has no other open list) and Delete item. Save saves the edits; Cancel or swiping the sheet away drops them (amount changes made with the stepper, unit menu or a delete control are already saved).
- Supported units [Default]: count (none), `g`, `kg`, `oz`, `lb`, `ml`, `l`, `tsp`, `tbsp`, `cup`, `fl oz`, `pt`, `qt`, `gal`, `can`, `jar`, `bag`, `box`, `bunch`, `clove`, `pinch`, `dozen`. Unknown unit words stay part of the name.
- **Usual unit** (`ingredient_unit_usage`, 5): household history also counts the units each ingredient is bought in. Every add or recipe ingredient that has a quantity counts one use of its unit (count when it has none); undoing the add takes it back, and an add with no quantity counts no unit. The usual unit is the most-used one; ties go to the most recently used, then alphabetical. Until the household has bought an ingredient with an amount, its **default unit** stands in: how it's usually bought in a US supermarket (`ingredients.default_unit`: `gal` for milk, `dozen` for eggs, `lb` for chicken thighs, `count` for lemons), set by the seed (6.2) and by the categorizer (6.4). Household history always wins over it. An add with no amount counts as one of the usual unit when totals are computed (4.4). Existing data is backfilled once on upgrade.
- **Changing an amount**: the edit sheet's Amount row has a number field and a unit button side by side, with a − / + stepper beside them. The stepper and unit button save immediately, and the number field follows the new total. A typed number (decimal keypad; `1.5`, `1,5` and `1/2` all read as numbers) saves when the field loses focus or on Save, in the unit the button shows, and isn't rounded to the step; an empty field clears the amount, and text that isn't a positive number shows an error and saves nothing. An item with no amount shows an empty field and its usual unit (count when none is known) on the button. Step sizes: 1 for count, `can`, `jar`, `bag`, `box`, `bunch`, `clove`, `pinch`, `dozen`, `oz`, `fl oz`, `pt`, `qt`, `gal`; 0.5 for `lb`, `kg`, `l`, `tsp`, `tbsp`; 0.25 for `cup`; 100 for `g`, `ml`. Results are rounded to the step, and − stops at one step (it's disabled there). An item with no amount steps from one of its usual unit, so + on `milk` usually bought by the gallon gives `2 gal`. The unit button opens a native menu of the units above grouped as Count / Weight (`g`, `kg`, `oz`, `lb`) / Volume (`ml`, `l`, `tsp`, `tbsp`, `cup`, `fl oz`, `pt`, `qt`, `gal`) / Packages (`can`, `jar`, `bag`, `box`, `bunch`, `clove`, `pinch`, `dozen`), with the current unit ticked and the ingredient's usual unit (above; Count when a plain count is usual) listed first, on its own, marked "Usual". Picking one keeps the number and changes only the unit (`2 lb` becomes `2 kg`, not converted). Either change replaces the item's amounts with the single new amount; recipe links with no quantity stay so By recipe view keeps them. When the total isn't a single amount (`2 cans + 400 g`), the stepper and unit button are disabled and the amount is edited as text.
- Name normalization (produces the ingredient key): lowercase, trim, collapse whitespace, strip punctuation, simple English singularization (`tomatoes` to `tomato`, `berries` to `berry`, with an exception list such as `hummus`, `asparagus`, `molasses`, `grits`). Spanish adds accent folding and Spanish plurals (4.15). The user's original text is kept as the item's display name. The add field doesn't auto-capitalize. **Display name**: wherever an item or ingredient name is shown for reading (list rows in every view mode, the edit sheet's title, recipe ingredient rows, suggestion rows and chips, toasts, VoiceOver labels, Share as text), it's shown in sentence case by `displayItemName` in `src/shared/`: the first character is uppercased when it's a lowercase letter and the rest is left as stored (`chicken thighs` reads `Chicken thighs`; `2% milk` stays). A first word that already has a capital in it is left alone (`iPhone charger`). Display only: the stored name never changes, and whatever writes back (the edit sheet's Name field, the text a suggestion puts in the add field, the recipe's Edit ingredient prompt) keeps the stored text. The normalizer lives in `src/shared/` and is used unchanged by the app and the Edge Functions, so client and server always agree on the key.
- Tap an item's round check to check it off (its hit area is at least 44 pt). Tap anywhere else on the row (name, second line, amount) to open the item's edit sheet; tapping the name never checks it off. Long-press the row to enter Select mode (4.5) with that item selected (in As added, long-press and move drags the row instead, 4.6); in Select mode a tap anywhere on the row selects it instead. VoiceOver reads the check as a "Check off <name>" checkbox and the rest of the row as a button that "Opens details", with Edit, Delete, Check off / Uncheck and Select actions on it. Checked items move to a collapsed "Checked" section at the bottom of the list (they are not deleted). Swipe right to check an item off (or, in Checked, to uncheck it), as a tap on its check does. Swipe left to delete; undo toast for 5 seconds. Neither swipe works in Select mode.

### 4.3 Categories (req 4, 6, 9)

#### 4.3.1 Automatic categorization
- Every ingredient has a global default category, set by the LLM the first time anyone in the app adds it (section 6).
- If the ingredient is already known, the item drops into its section instantly, offline included (the catalog is cached on device).
- If it is new, it appears immediately in its own "Sorting..." state at the top of the list and moves into its section when categorization returns. If categorization fails, it goes to **Other** and is retried in the background.
- Without the plan's `categorize` (4.12, a base user), a new name never shows "Sorting...": it goes into **Other** at once with the default unit `count`, and isn't sent. The device still records it locally as `pending`, so it's sent once the plan has `categorize`; a household override or unit history works as for any name. The same goes for a list item synced from a household-mate whose name this device doesn't know.

#### 4.3.2 Recategorizing (req 6)
- From the item's edit sheet (tap the item's name), "Move to category..." opens a category picker (with "New category...").
- This writes a **household override** for that ingredient (`household_category_overrides`, keyed by household and ingredient), in the household of the list the item is on. It applies on every list of that household, for *every member*, on every device. Other households, and the global default, are unchanged.
- Someone in two households has a separate set of overrides in each; a list or recipe uses its own household's.
- "New category..." creates a **custom aisle in that household**: every member has it (each places it in their own order, 4.3.3). A name the household already has (a system aisle or one of its custom ones, in any case) picks that one instead.
- When the chosen aisle differs from the catalog default, the item sheet shows a footnote under the aisle pills, "Changes it for everyone in <household>." ("Changes it for everyone in your household." with no name), and a plain **Reset to default** button (VoiceOver hint "Uses the usual aisle for everyone") that selects the default aisle.
- "Reset to default" resets it for the whole household. It writes the override with a null category rather than deleting the row, so it syncs like any other change.
- When two members change the same ingredient, the later change wins (field-level LWW through `apply_mutations`, 7.3).
- Overrides are never fed back into the global catalog (Q4).
- **Client side**: `src/features/categories/categories.ts` (`setCategoryOverride` / `clearCategoryOverride` by household, `createCategory(userId, householdId, name)`, `categoriesQuery(userId, households)`: system aisles plus those households' custom ones, with the user's positions). The list items query joins overrides on the list's household; the item sheet, recipe screen and add bar's aisle dots use the list's or recipe's household.

#### 4.3.3 Category order (req 9)
- Each user has their own category order, used in every list's grouped-by-category view. Default order follows a typical store walk (section 6.2 order).
- The user reorders sections by drag on the Aisle order screen, opened from Settings ("Store aisle order") or, in By aisle, from "Reorder aisles…" in the list's ⋯ menu.
- Stored per user and synced to all of that user's devices [Default]. Not shared with household members.
- Custom categories belong to a household (4.3.2); a new one goes at the end of its creator's order, and at the end for other members until they move it. The "Aisle order" screen shows the system aisles plus the custom aisles of every household the user is in; when the user is in more than one household, each custom aisle shows its household's name as a second line (`footnote`, `inkSecondary`; VoiceOver reads "Costco, Test home, 3 of 20") so two "Costco" aisles can be told apart. With one household there's no second line.

### 4.4 Duplicate handling (req 8)
A duplicate is an add whose normalized ingredient matches an **unchecked** item already on the same list.

- **Single add in the app**: no prompt, so the add field never blocks the next item (goal 1). The new quantity is added to the existing item as a new contribution (**Combine**), the existing row briefly highlights, and a toast appears for 5 seconds: "Added to *milk* (now 2 gal). **Undo**". The amount is the item's new total (4.4 quantity math, so `milk` added to `1 gal milk` reads `2 gal` when milk is usually bought by the gallon, and `1 gal + 1` when no unit is known yet) and is left off when there is none.
  - **Undo**: removes the add, leaving the item as it was. There is no "Keep existing" choice, for single adds or recipe adds.
  - Undo is also available later from the item's edit sheet, which lists its contributions ("Added": the amount, then who and when, e.g. "You, Tuesday", or the recipe's name for a recipe's add) with a delete control on each when there is more than one. A row from a recipe that still exists shows a chevron and opens that recipe when tapped (the sheet saves its edits and closes first); a deleted recipe's row reads "A recipe" and doesn't open.
- **Move to another list…** (edit sheet): picks another open list in the same household (a native action sheet of their names, in the user's order) and moves the item there with all its contributions (recipe ones keep their recipe). The sheet saves its edits first, closes, and opens the destination list. An unchecked item meets that list exactly as a single add would: an open match gets its contributions (**Combine**, and the moved item goes), a checked match is unchecked with its amounts replaced, otherwise the item itself moves (keeping its note). A checked item moves as it is. A move isn't a use, so household history (4.2) is unchanged. The destination list shows a toast for 5 seconds with **Undo**: a Combine reads as a single add does ("Added to *milk*, now 2 gal") and tints the row it joined; otherwise "Moved *milk* from Groceries". Undo puts the item back on its list with its contributions and returns the item it joined to its earlier amounts (checked again, if the move reopened it); if the same ingredient has since been opened on the first list, the amounts go onto that item.
- **Adds with no UI always Combine silently**: Siri adds (4.9), adds that arrive by sync from a household member, and offline-conflict resolution (7.3). The toast only shows on the device doing an in-app add.
- **Quantity math**: if both quantities share a unit, or convertible units within the same dimension (mass with mass, volume with volume, metric and US customary both allowed), sum them.
  - **Display rule** [Default]: show the sum in the unit of the larger contribution, rounded to a friendly value (nearest 1/4 for cup/tsp/tbsp, 0.1 for lb/kg/l, whole numbers for g/ml/count). If rounding would hide a contribution (e.g. `1 cup + 1 tsp` rounds to `1 cup`), show both instead: `1 cup + 1 tsp`.
  - **Adds with no amount count as one** of the ingredient's usual unit (4.2), or a unitless one when no usual unit is known, and sum like any other contribution. So `milk` + `milk` reads `2`, and `1 gal` + `milk` reads `2 gal` when milk is usually bought by the gallon (`1 gal + 1` with no history). Stored quantities stay null; the rule applies only when totals are computed. A lone add with no amount still shows no amount. A recipe link with no quantity (a recipe ingredient with no amount, or an item linked by "Add to recipe") records the recipe, not an amount, and doesn't count.
  - If units are incompatible (`2 cans` + `400 g`), the row shows them joined (`2 cans + 400 g`). No error.
- **If the matching item is checked**: no prompt. The item is unchecked and its contributions are replaced with the new one (you bought it before; you need it again).
- **Bulk add** (adding a recipe to a list): no clash step. Each chosen ingredient behaves exactly like a single add: an open match Combines (as a recipe contribution, so the item also groups under the recipe), a checked match is unchecked with its amounts replaced, and the same ingredient twice in the recipe folds into one item. The list then shows one toast for 5 seconds: "Added *Tacos* · 8 items" (the number of ingredients added) with **Undo**, which removes every contribution that add made in one step: new items go, Combined items return to their earlier amounts, and reopened items are checked again with their old amounts. Uses counted by the add (4.2) are taken back too. No row highlights; the items appear wherever the current view puts them (4.6).

### 4.5 Recipes (req 2)
- Recipes belong to the household. A recipe has a name, optional notes, optional source URL (set by recipe import, 4.10), and a list of recipe ingredients (ingredient, quantity, unit, note).
- **The recipe link**: on the recipe screen, a link that opens (`http`/`https`, host with a dot) shows as a button, host without `www.` then path, truncated in the middle; tapping it opens Safari (not an in-app browser, so sign-ins and paywall access carry over). A pencil ("Edit link") turns it into the text field; ending editing saves (trimmed, `https://` added when there's no scheme; an empty field removes the link). Long press: **Open**, **Copy link**, **Edit link**, **Remove link** (no confirm), also VoiceOver custom actions. Text that isn't a link is kept as typed and shown as plain text that starts editing on tap. No link: the empty field, "Add a link to the recipe". A recipe with a link that opens also has **Visit recipe on web** in its Recipes tab card's long-press menu (before Rename and Delete) and in its By recipe header's menu (4.6), opening Safari the same way.
- **Start from the recipe**: Recipes tab, "New recipe", name it, add ingredients with the same add field, parser and chip row (4.2) as lists, minus recipe chips.
- **Start from ingredients**: on any list, long-press an item (light haptic; VoiceOver: the row's "Select" action) and lift without moving to enter Select mode with it already selected (in As added, moving before lifting drags the row instead, 4.6), or choose "Select items" from the list's menu; tap the others, then **Add to recipe**. That opens a sheet titled "Add N items to…": a **New recipe** row at the top with an inline name field (Return creates the recipe, in the list's household, from the selection), then the household's recipes, each with its tinted icon tile and ingredient count, most recently used first (the later of the recipe's last change and the last time it was added to a list). Only recipes in the list's household are offered. Picking one appends the items to it (skipping ingredients it already has). Either way the selected list items also get that recipe added as a contribution, so they immediately group under it; the sheet closes, Select mode ends, the list switches to By recipe and a toast says "Added 3 items to Tacos" with **View recipe**. Swiping the sheet away or Cancel keeps the selection.
- The Recipes tab groups recipes by household the same way the Your lists sheet groups lists (4.1).
- **Copy to household...**: a member of several households can copy a recipe into another of their households (a new, independent recipe owned by that household). This is how a recipe gets from one household to another; nothing is ever shared across households.
- **Add a recipe to a list**: from the recipe screen, "Add to list...", from **Add to a list** at the top of the recipe's Recipes tab card long-press menu (the same sheet; left out when the recipe has no ingredients, as the recipe screen's button is disabled then; the menu reads Add to a list, Visit recipe on web, Rename, Delete), or by picking the recipe in a list's add bar (4.2), which adds it at 1× with all ingredients but the household's staples (Always have, below) and offers **Adjust** to open this sheet instead. Only lists in the recipe's household are offered (the "Copy to household..." action is shown as the way to reach others). Pick the list, then a checklist of the recipe's ingredients (all but the household's staples selected by default, so the user can uncheck what they already have). Optional servings multiplier (0.5x, 1x, 2x, 3x) scales quantities. "Add N to Groceries" adds them straight away, with duplicates handled per 4.4 bulk add (Combine, no question), and opens the list with the "Added Tacos · 8 items" toast and **Undo**.
- **Always have** (household staples, `household_staples`): each household keeps a short list of ingredients it always has (water, salt, pepper, olive oil), matched by ingredient key. Only recipe adds leave them out: this sheet starts with them unticked, each with an "Always have" tag in `inkSecondary` after its name (ticking one adds it this time and doesn't change the staple; the sheet never marks or unmarks one), and the add bar's 1× add (4.2) and its **Adjust** start from the same ticks. Typing a name, a chip, Siri and Move to another list always add. Staples are household data like aisle choices (4.3.2): any member marks or unmarks one, from the item edit sheet (4.2) or Settings, and it syncs to everyone in the household.
- Editing a recipe does not retroactively change list items already added from it.
- Deleting a recipe keeps its list items; their contributions become "no recipe".

### 4.6 List view modes (req 11)
A small button under each list's title reads the current view ("As added ⌄") and opens a native menu: **As added** (clock) | **By aisle** (cart) | **By recipe** (fork and knife), the current one ticked. VoiceOver: a button labelled "View: <view>" with the hint "Changes how the list is grouped". The last choice per list is remembered on the device (`list.<id>.viewMode`, stored as `newest`, `category` or `recipe`); a list with no saved choice opens in As added, and choices saved before As added existed are kept.

- **As added** (default): one card with no section header, latest add at the top. An item's place is the earliest `created_at` among its current contributions, so a Combine onto an open item keeps it where it is (it highlights there), while re-adding a checked item, whose contributions 4.4 replaces, moves it to the top like a new add. The adds in one recipe add share a timestamp and keep the recipe's ingredient order as a block (ties go by contribution id, which is UUIDv7 and so counts up in add order, then by item id). An item with no contributions goes by its own `created_at`. Each row shows its aisle as the small aisle dot beside the name (VoiceOver reads the aisle's name), or the dashed amber check and "Sorting…" while its category is pending, so the item stays in place when it's sorted. Check, tap-to-open, swipe-to-delete, the add highlight and the undo toast work as in By aisle. After an add that puts an item at the top, the list scrolls to the top if it isn't on screen.
  - **Your own order**: in As added (not in Select mode, add mode or the Checked section), long-press a row (light haptic) and move without lifting to drag it: the row lifts (a little bigger, with a shadow, as on the Aisle order screen), the others make room, and the list scrolls near its top and bottom edges. Dropping saves the order (light impact); dropping in the same place saves nothing. Long-press and lift without moving still enters Select mode (4.5); a tap or swipe is unchanged. VoiceOver: each row also has **Move up** and **Move down** actions (left out at the ends), which save the same way and announce the new place ("Milk, 3 of 8"). The order is a device setting (`list.<id>.manualOrder`), not synced or shared: a list of item ids, each with the `created_at` its place was based on (the one As added sorts by), so it survives switching views, leaving the list and quitting the app. New items, and items whose place changed since (a checked item re-added, 4.4), go above the ordered ones, newest first, so an add still lands at the top; a Combine keeps the item where the user put it. A checked item keeps its place for when it's unchecked. Each drop saves every row on screen (plus the checked items' places) and forgets items that are gone. While the list has a saved order, the view menu has **Reset order** (`arrow.uturn.backward`) in its own group, which goes back to plain As added with no confirm and shows "Order reset" with **Undo** for 5 seconds. The view button still reads "As added". Signing out or deleting the account clears it with the rest of the device's user data (4.8).
- **By aisle** (the grouped-by-category view of 4.3.3): sections in the user's category order (4.3.3), using the user's overrides. Empty sections are hidden. Within a section, items sort by when they were added [Default] (manual drag within a section is a later enhancement).
- **By recipe**: one section per recipe that has a contribution on this list, ordered by most recently added. A final **Other items** section holds items with only manual or Siri contributions. Inside each section (Other items too), items needing a category ("Sorting…", with the dashed amber check) come first, then items follow the user's aisle order (4.3.3, the same section order By aisle uses, with the user's overrides; an unknown aisle counts as Other), then by when the item was added. Each row shows its aisle's small dot beside the name, as in As added, so the order reads.
  - An item with contributions from several recipes appears under *each* of those recipes, showing that recipe's contribution quantity, with a small "also in: Tacos" hint. Checking it in any section checks the single underlying item everywhere.
  - Long-pressing a recipe header (light haptic) opens its menu: "Check all", "Visit recipe on web" (only when the recipe has a link that opens, 4.5), "Remove recipe from list" (destructive; removes that recipe's contributions; items left with no contributions are deleted). VoiceOver offers the same as actions on the header. Other items has no menu.
- **Swiping a section header** (By aisle and By recipe): a full swipe right checks every item in the section (Check all; the check-off tick, 4.1; swiping left to remove plays a light impact), and on a recipe header a full swipe left removes the recipe from the list. Aisle headers and Other items don't swipe left: deleting a whole aisle in one gesture is too easy to do by mistake. Both work on folded sections. Check all and Remove recipe, from a swipe or the menu, show a toast for 5 seconds with **Undo**: "Checked 6 items" (Undo unchecks exactly those, leaving any checked or unchecked since) or "Removed *Tacos* from the list" (Undo brings back its amounts and the items it deleted). VoiceOver offers Check all as an action on an aisle header. The Checked header and the Sorting… card don't swipe, and headers don't swipe in Select mode.
- **Collapsing sections** (By aisle and By recipe): tapping a section's header folds its rows away, leaving its card with just the header and a chevron (`chevron.down` open, `chevron.right` folded); tapping again opens it. The whole header is the target (≥ 44 pt). A folded recipe header shows its item count, so you can see what's hidden. VoiceOver: the header is a button with an expanded state, labelled with the section's name and item count. The Sorting… card has no header and never folds, and As added has no sections. Folded sections are remembered on the device per list and per view mode (`list.<id>.collapsed.<category|recipe>`, keyed `c-<categoryId>` / `r-<recipeId|other>`); keys for sections that aren't showing are ignored, so a section that comes back is still folded. An add or Combine that lands in a folded section opens it, so its highlight shows. Check all, Remove recipe and Select mode work the same on folded sections (Check all checks the hidden rows too). The view button's menu has **Collapse all** and **Expand all**, in their own group, in these two modes. Opening a section fades its rows in, with no animation under Reduce Motion.
- Checked items behave the same in all three modes (a "Checked" section at the bottom). It's folded while there's something to get, and opens by itself once nothing is: when the last item is checked (after its row's linger, 4.1) or when a list with nothing to get opens. It folds again by itself when something is to get again (an add, an uncheck, a sync). A tap on its header is the user's choice and wins: a fold by hand lasts until the list next becomes all done or stops being, and an open by hand stays open. Settings > Shopping > **Always show checked items** (a switch with the detail "Otherwise they show once everything's checked"; VoiceOver hint "Keeps the Checked section open on your lists"), default **off**, keeps it open while shopping too; a tap still folds it. It's a device setting (`list.alwaysShowChecked`), not synced, read when the list comes into focus. While nothing is to get and something is checked, the header line reads "All done" in place of "N to get" (and "All done · As added" in add mode). Its "Checked · N" header folds and unfolds the section (VoiceOver: a button with an expanded state) and has two text buttons at its trailing end (44 pt hit area): **Uncheck all**, which shows "Unchecked N items" with Undo (4.1), and **Clear** (VoiceOver: "Clear 3 checked items"), which clears the checked items with Undo (4.1). Long-pressing the header (light haptic) opens a menu with **Clear N checked items** (destructive) and **Uncheck all**. The section, and so the button and menu, shows only while something is checked. Select mode (4.5) works from any mode; making or adding to a recipe from it switches to By recipe.

### 4.7 Households and sharing (req 7, 7.1)

**Principle: the household owns the data.** Every list and recipe belongs to one household. Users get access by being members, and lose it by leaving. No action ever moves data between households or hands it to a user; the only way data crosses households is an explicit copy (recipes, 4.5).

**Membership**
- Sign-up creates the user's **personal household** ("Personal", renameable) with a starter list.
- A user can belong to any number of households (Q6). They must always belong to at least one.
- Settings > Households lists the user's households. Each household screen shows its name, members, and actions: Invite, Leave, and (owners only) Rename, Remove member, Make owner, Delete household.
- The user can reorder their households (this sets section order on the Lists and Recipes tabs). Per user.
- **Always have** (4.5): the household screen has an **Always have** row with the count ("None" when empty), for every member. It opens a screen titled "Always have" listing the household's staples by display name in sentence case, live (another member's change shows without leaving). An "Add an ingredient" field at the top marks a name as a staple, read as the add bar reads it (amount ignored; one already there changes nothing), with the add bar's history and catalog chips. Swipe left, or **Edit** and a row's delete button, removes one with no confirm and a "Removed *Salt*" toast with **Undo**. Empty: "Nothing yet. Ingredients you always have are left off when you add a recipe." VoiceOver reads each row as text with a Delete action.

**Roles** (Q1)
- `owner` or `member`. A household can have several owners and always has at least one.
- Everyone has equal edit rights over the household's lists and recipes (create, edit, check, delete).
- Owners additionally manage the household: rename it (`rename_household`: trimmed, not blank, at most 50 characters; other members' devices get the new name through the usual pull or realtime update), remove members, make another member an owner, and delete the household. An owner can also step another owner, or themselves, back to member while another owner remains.
- Server side: `set_member_role(household_id, user_id, role)` (owners only, `not an owner` otherwise; the target must be a member, `not a member`; `role` is `owner` or `member`, `invalid role` otherwise). Demoting the household's last owner, themselves included, raises `last owner`. Setting the role someone already has does nothing. It locks the household row first, as the leaving rules do, so two owners demoting each other at once can't leave none.
- Any member can invite (Q16).

**Invites**
- "Invite someone" on the household screen opens the invite sheet, which generates an invite link for that household (Universal Link, single use, expires in 7 days). *For now* the link uses the app scheme (`perfectbite://invite/<token>`); Universal Links need a hosted domain (follow-up). Only the token's SHA-256 is stored on the server.
- Opening the link (signed in) shows "Join *John's household*? You'll share its lists and recipes. Your other households aren't affected." Accepting adds the user as a member. Nothing of theirs moves (Q3).
- Already a member: the link says so and opens the household (the invite stays unused).
- A used, expired or unknown link says so ("Ask for a new one"). Opening a link signed out goes to sign-in; the link isn't kept for after sign-in. For an email invite that doesn't matter: signing in with that email shows the invite in the Your lists sheet (below). Keeping a link-only invite's link through sign-in is a follow-up.
- **The invite sheet** (designs S2, S3). Step 1: "Invite to <household>", "They'll share its lists and recipes. Their other households aren't affected.", an email field (email keyboard and autofill) with "Use the email they sign in with (their Google account).", and Next, enabled only for a valid email. Next creates the invite for that email (with progress on the button); a failure ("<email> is already in <household>.", offline) shows under the field. "Don't know their email? Share a link instead" creates a link-only invite and opens the share sheet. Step 2: "Let <name> know" (the first word of the email's local part, e.g. "Sam" for sam.lee@…), the email with "Invite expires in 7 days", then Messages (body filled in), Mail (To, subject and body filled in), Copy link ("Link copied" toast) and More… (the share sheet); Messages and Mail are hidden when the device can't send them. A note says they can skip this: signing in with that email shows the invite in the app. Done closes the sheet. Back returns to step 1 with the email kept; Next again re-invites, which revokes the earlier link.
- **Pending invites** (design S4). Under Members, the household screen has an "Invited" section listing the household's open, unexpired invites, loaded from the server with the members and again whenever the screen regains focus (e.g. after the invite sheet closes). It's hidden when there are none or they can't be fetched (offline). Each row shows the email (or "Invite link" for a link-only invite) over "Sent by <name> · expires <date>" ("Oct 18"; with the year when it isn't this year) and a Pending badge. Tapping a row opens an action sheet: **Send again** (email invites only) re-creates the invite, which revokes the old link, and opens the invite sheet on step 2 for that email; **Cancel invite** (destructive) revokes it and removes the row; Cancel. A failure shows in an alert and keeps the row. Every member sees and can act on every invite.
- **Invites waiting in the app** (mockup H). After sign-in, on each return to the foreground and on reconnect (skipped while offline), the app fetches the invites sent to the user's email (`my_invites`). They're kept in memory only, not in SQLite, and cleared on sign-out; a failed fetch keeps the invites already shown. While any are waiting, the list switcher's chevron has a dot (4.1), and the Your lists sheet shows them first, under an "Invite" label, one compact row each: the inviter's initial in a round avatar, "<inviter> invited you" over "to <household> · N members", a round Decline (✕, VoiceOver "Decline invite to <household>") and a Join pill. **Join** accepts it (`accept_invite_by_id`), pulls (as the join screen does) and removes the row, so the household's lists appear in the same sheet. **Decline** asks first in an alert ("Decline the invite to <household>?" / "<inviter> can send a new one."), then declines it and removes the row. The busy button shows a spinner. A failure shows in a toast and keeps the row, except for an invite that can't be used any more: one revoked, used or declined meanwhile (or gone) removes the row with "This invite was cancelled.", and an expired one with the expired message. VoiceOver reads the row as "<inviter> invited you to <household>", then the two buttons.
- **Email invites** (server side, invite sheet, pending list and in-app invites done). An invite can name the email it's for (stored trimmed and lower-cased; null for a link-only invite). Inviting the email of someone already in the household fails ("already a member"); inviting an email with no account works the same as any other, so the inviter never learns whether an address has an account. Inviting the same email to the same household again revokes the earlier invite and makes a new link ("Send again"; only the token's hash is stored, so the old link can't be re-shown). The email decides who sees the invite in the app, but doesn't lock the link: whoever opens it first can join with it. The app checks an email with the server's pattern before sending it, and says "<email> is already in <household>." for a member's email. A Mail invite has the subject "Join <household> on The Perfect Bite" and a body naming who invited them, what joining means, the link, and "Sign in with <email> and the invite will be waiting."; Messages and More… send the same short message as a link-only invite.
- An invite is **open** until it's used, revoked or declined; expiry is checked when it's read. Any member can see the household's open, unexpired invites (email or link-only, who sent it, when, when it expires) and revoke any of them. Someone signed in with an invite's email sees it in the app (household, inviter, member count) unless they're already in that household, and can join or decline it there without the link. Revoked and declined links read as used.
- On accept, the new membership syncs the household in (7.2) and the app opens the List tab.

**Leaving and removal** (Q2)
- Leaving removes access; the data stays with the household. The user keeps no copy.
- The last owner leaving promotes the member who joined earliest to owner.
- The last member leaving deletes the household and its data, after a confirm that says so.
- If the user is leaving their only household, a new empty personal household is created for them, so they always have one.
- Server side: `leave_household(household_id)` (any member; `not a member` otherwise) and `remove_member(household_id, user_id)` (owners only, `not an owner` otherwise; not on yourself, who must leave instead) both clear the leaver's default list if it's in that household, run the leaving rules (`private.remove_member_from_household`, 4.12) and, if it was the leaver's only household, make them a new one with `private.create_personal_household`: "Personal", with them as owner, a "Groceries" list at position 1 as their default list (the same as the device's `ensureStarterData`). Both return `{ outcome: 'left' | 'promoted' | 'deleted', new_household_id }` (null when no household was made).
- **In the app** (household screen). **Leave household** is a `danger` row at the bottom, for every member. It confirms first, worded for the case: "Leave <household>? You'll lose access to its lists and recipes. They stay with the household." (a plain member or one of several owners); the same plus "<earliest-joined member> will become the owner." (the last owner with other members); "Leave and delete <household>? You're the only member, so its N lists and M recipes will be deleted." (the last member); plus "You'll get a new empty household." when it's the user's only household. On confirm: `leave_household`, then a pull, then back to Settings. The app never makes the new household itself: the server does, and one pull brings it down and purges the old one (the old one is purged only after the households still listed are in, so the device never has none and the offline starter step never makes a second). **Remove member** (owners, on another member's row): an action sheet ("Remove from <household>", Cancel), then "Remove <name>? They'll lose access to <household>'s lists and recipes.", `remove_member`, and the members reload. Offline, both say "You're offline" and change nothing; a failure shows in an alert and changes nothing. VoiceOver: the rows are buttons with hints.
- **Make owner and Remove as owner** (owners, in the app). Another member's row offers **Make owner** above Remove from <household> (**Remove as owner** for another owner); the owner's own row offers **Step down as owner** when another owner exists (otherwise it does nothing). A non-owner's rows do nothing. Make owner confirms "Make <name> an owner?" / "Owners can rename the household, remove members and delete it."; Remove as owner "Remove <name> as owner?" / "They'll stay a member."; Step down "Step down as owner?" / "You'll stay a member. Only owners can rename, remove members or delete the household." On confirm, `set_member_role`, then the members reload (the Owner/Member badges change); stepping down hides the owner-only controls at once. Offline: "You're offline"; `last owner` (a race) says "<household> needs at least one owner."; any failure shows in an alert and changes nothing. VoiceOver: the row's hint says what tapping offers ("Make owner or remove.", "Remove as owner or remove.", "Step down as owner."). Other members' devices see the new role when they next load the household screen.
- When access is lost (leave or removal), each of the user's devices removes that household's data from local storage on its next sync, and any queued outbox mutations for it are dropped.
- **Delete household** (owners only): deletes it for every member, after a confirm naming how many members and lists are affected. Members left with no household get a new personal household.
- **In the app** (household screen, owners only): a `danger` row **Delete household** above Leave household. It confirms first: "Delete <household>?" / "Its N lists and M recipes will be deleted for all K members. This can't be undone." ("Its N lists and M recipes will be deleted. This can't be undone." when the user is the only member), plus "You'll get a new empty household." when it's the user's only household; Cancel and a destructive **Delete**. The counts come from the device's data and the loaded members. On confirm: `delete_household`, then a pull (which purges it and brings down any new personal household, as for Leave), then back to Settings with a toast "Deleted <household>". Offline: "You're offline"; a failure shows in an alert and changes nothing. Other members' devices purge it on their next sync, as after removal; a List tab showing one of its lists falls back to the default list, then the first (4.1), as when a list is deleted elsewhere. VoiceOver: the row is a button with a hint.
- Server side: `delete_household(household_id)` (owners only, `not an owner` otherwise) locks the household row, clears every member's Siri default list if it's in the household, deletes the household (its lists, items, recipes, overrides, custom aisles, invites and memberships cascade), and gives each member left with no household a new one with `private.create_personal_household`. It returns `{ new_household_id }` for the caller (null when they still have another). The cascaded membership deletes reach every member's devices through Realtime and pull, which purge the household as after removal (7.2). Like leaving, it writes no `admin.admin_actions` row.

**Per-user settings stay per user**, across all households: category order, household order, and the Siri default list (which can be in any household). Category overrides and custom categories are no longer per user: they belong to a household and every member shares them (4.3.2). The order stays the user's own, including where each household's custom aisles go.

All changes sync live to all members' devices.

### 4.8 Accounts
- **Google sign-in only**, through Supabase Auth, the same way as stash (native Google Sign-In SDK, then `signInWithIdToken`).
- **During development**: dev builds (`__DEV__`) also show stash's dev sign-in stub (email + 6-digit code; local Supabase delivers the code to Inbucket). Release builds show Google only. The OAuth clients are in their own Google Cloud project (Q13). Nothing else in the app may depend on which sign-in method is used.
- A first-run user gets a personal household (4.7) with a starter list named "Groceries", which is their default list.
- Account deletion (App Store requirement): leaves each of the user's households by the leaving rules (4.7, `private.remove_member_from_household`: owner promotion; households where they were the last member are deleted with their data), then deletes the user with their profile, aisle order and settings. Category overrides and custom aisles are household data (4.3.2) and stay with the household, like its lists and recipes. Items, check-offs and invites they made in shared households stay, with the reference to them cleared. Users delete their own account with `delete_account()` (no argument: it acts only on `auth.uid()`; raises `not signed in` without one; returns `{ households: [{ id, outcome }] }`, and an empty array on a retry once the account is gone). It writes one `admin.admin_actions` row (`action` `delete_account`, the user id, and per household its id and outcome, with `promoted_user_id` for `promoted`) with no email, display name or household name: the user asked to be forgotten. `admin.delete_user` (4.12) stays for support requests. Both run the same core, `private.delete_user_core`.
- **Sign out** (Settings, `src/features/auth/sign-out.ts`) pushes the outbox (best effort, up to 3 seconds), signs out of Supabase and Google, then wipes the device as Delete account does (`wipeLocalData`, below), so the next account to sign in starts from its own households, not the last user's. If Supabase refuses the sign-out, nothing local changes. As a backstop, before an account becomes ready the app checks which user the device's data was last synced for (the pull state's `userId`) and wipes it first if that's someone else. Changes still unpushed after 3 seconds (e.g. offline) are lost.
- **Delete account** is in Settings, under Sign out (`src/features/auth/delete-account.ts`). It needs a connection: offline it says "You're offline" / "Connect to the internet to delete your account." and does nothing else. Online it fetches each household's member count (`get_household_members`) and confirms "Delete your account?": the account, aisle order and settings go; each household where the user is the only member is named with its list and recipe counts as deleted; the shared ones are named on one line as staying with their other members (if any member count can't be fetched, only the first sentence). A second "Are you sure?" follows, so one mis-tap can't do it. Then, behind a full-screen "Deleting your account…" overlay that can't be dismissed, it pushes the outbox (best effort, up to 3 seconds, so shared households get the user's last changes), calls `delete_account`, wipes the device, signs out of Supabase locally (the server session is gone; its error is ignored) and of Google, and lands on sign-in with the toast "Your account was deleted.". A failure says "Couldn't delete your account" / "Nothing was deleted. Try again later." and changes nothing on the device.
- After deleting, the device keeps nothing of the user's (`wipeLocalData`, `src/features/auth/local-wipe.ts`): every user and household row in SQLite goes in one transaction (households, lists, items, contributions, recipes and their ingredients, custom aisles, overrides, usage, user settings and aisle order, failed imports, the outbox, sync cursors and the HLC clock), then the App Group list snapshot (as on sign-out, 4.9), the Siri and share queues, the plans store and its cached answer (4.12), the in-memory invites (4.7) and notifications (4.11). Kept: the global catalog (system aisles, categorized ingredients; names still pending are the user's and go) and device-only preferences that hold no user data (aisle colours, item rows, keep screen on, the import sheet's switch) with the catalog and one-time backfill markers. Every table in `src/db/schema.ts` must have a wipe step; a test fails otherwise.
- Note: App Store Guideline 4.8 expects a privacy-focused login (e.g. Sign in with Apple) alongside Google for a *public* release. Fine to ignore for personal/TestFlight use; revisit only if this goes to the public App Store.

### 4.9 Siri (req 12)

**Platform constraint** (learned in stash): App Shortcut phrases can only contain `AppEnum`/`AppEntity` parameters, not free-form text. "Hey Siri, add milk to The Perfect Bite" in one breath is not expected to work. The interaction is two turns.

**Interaction**
1. User: "Hey Siri, **add to The Perfect Bite**."
2. Siri: "What do you want to add?"
3. User: "Two avocados."
4. Siri: "Added two avocados to Groceries." The app does not open.

**Naming a list**: lists are exposed as an `AppEntity`, so a phrase can include one: "Hey Siri, add to **Costco** in The Perfect Bite." Without one, the item goes to the user's default list (4.1).

**Behavior**
- The spoken text goes through the same parser and normalizer as a typed add (4.2). One utterance is one item in v1 (multi-item splitting is Later, 11.3).
- Duplicates always Combine, with no prompt (4.4). Siri's reply doesn't mention it.
- Works offline and while the phone is locked (after first unlock since boot), using stash's App Group queue design.
- Unknown ingredients show "Sorting..." on every device until categorized, as with any add.
- If the user isn't signed in, the item waits in the queue and is added after sign-in.
- Also available, for free, through the Shortcuts app and the Action Button.

**Implementation**
- A Swift `AppIntent` named `AddToPerfectBiteIntent` in an App Intents extension under `targets/`, added with `@bacons/apple-targets` (as stash's `targets/save-intent`).
  - `@Parameter(title: "Item", requestValueDialog: "What do you want to add?") var text: String`
  - `@Parameter(title: "List") var list: ListEntity?`
  - `openAppWhenRun = false`
- `ListEntity` values come from a **list snapshot** (`siri/lists.json`: id, name, household id and household name per list across all the user's households; `households`, every household the user belongs to as `{ id, name }`, oldest first, including any with no live lists, so the share sheet can save to one; plus the default list id and `lastOpenedListId`, the list screen last opened on this device or null; Siri ignores the household fields) that the app writes to the App Group container on launch and whenever lists, memberships or the default list change, and deletes on sign-out. Archived lists are left out. Settings > Siri adds to picks the default list. If two lists share a name, both are shown to Siri as "*Groceries* in *Smith home*" to disambiguate. The app also rewrites the snapshot whenever a list screen opens, so `lastOpenedListId` stays current; the share extension (4.10) reads the same file for its list picker.
- The App Group container holds, besides `siri/lists.json` and the Siri queue (`siri/pending/`), the **share queue** `share/pending/<uuidv7>.json` (4.10). A share envelope is `{ id: uuidv7, url, listId | null, householdId?: uuid | null, addToList?: boolean, page?: { title?, jsonLd?: string[], text? }, createdAt, appVersion, source: "share" }`, with the same caps as the import request's `page` (6.6). Like the Siri envelope it has one Zod schema in `src/shared/` (`schemas/share.ts`), a matching Swift `Codable` in `targets/_shared/`, and a contract test; files are written atomically (`.tmp`, then rename).
- `perform()`:
  1. Writes an envelope to the App Group queue: `{ id: uuidv7, text, list_id | null, created_at, source: "siri" }`.
  2. Makes a **best-effort upload** (timeout ~3 s) to the `siri-add` Edge Function, using the session stored in the shared Keychain access group. This matters more than in stash: a household member at the store should see the item without the speaker opening the app. **[SPIKE: token refresh from the extension without breaking the app's refresh token rotation]**
  3. Replies with the dialog. If the upload failed, the reply is the same; the item is uploaded later.
- `siri-add` Edge Function: parses and normalizes with the shared code, resolves the list, applies auto-Combine, inserts the list item and contribution with ids derived from the envelope id (so a repeat upload is a no-op), and categorizes unknown names inline by calling the shared `categorize()` from `categorize-ingredients` (same limits and LLM boundaries, 6.4). No other process categorizes them later.
- The app drains the queue on launch, foreground and sign-in (as stash does; signed out, adds wait), one drain at a time, oldest first. Each envelope is parsed like a typed add and goes to its list, or the default list if that list is gone or archived, as a Siri contribution that Combines silently (4.4), dated when it was spoken. The item and contribution ids are UUIDv5s of the envelope id (`siriAddIds`), so an envelope applied twice (a crash before its file is deleted, or already applied by `siri-add`) is a no-op. Applied files are deleted; unreadable ones, and text with nothing to add, are logged and deleted. New names go to categorization in one batch, and a list screen that's showing gets one toast, "Siri added 2 items".
- Envelope format: one Zod schema in `src/shared/` and a matching Swift `Codable`, with a contract test (as stash).
- **App name**: the App Shortcut phrase must include the app's display name, so the bundle display name must be exactly what users say. Stash had to use phrases like "Add to my Stash"; test early whether "add to The Perfect Bite" is recognized reliably, and register a few variants ("Add to Perfect Bite", "Add something to The Perfect Bite"). **[SPIKE]**

### 4.10 Recipe import (req 14)

On a recipe page, the user picks a list and taps **Add**. The recipe is saved to the household (its name, source URL and every ingredient), and all its ingredients go onto that list, grouped under the recipe in By recipe view (4.6). The user never types an ingredient. Extraction happens on the server (6.6).

**From the share sheet**
1. In Safari (or any app that shares a link): Share → **The Perfect Bite**. The extension accepts one web URL, one web page, or text containing a URL (apps like Instagram and Messages share a URL inside text; the first `http(s)` URL is used). It doesn't take images.
2. The sheet shows the page title (or the host when there's none) with the host on a second line; a **Save to** household picker (hidden with one household), defaulting to the household of the list the list picker would pick (below); a row **Also add ingredients to a list** with a switch; and Cancel. Off, there's no list picker and the button reads **Save recipe**. On, a picker of that household's lists shows (same default rule within the household) and the button reads **Save & add to <list>**. A household with no lists disables the switch, with "This household has no lists" under it. Changing household resets the list to that household's default. The switch starts off the first time and then remembers its last state on the device (`share/prefs.json` in the App Group); the household isn't remembered. With no households in the snapshot yet it says "Open The Perfect Bite once to set up" instead. The rules live in `src/features/recipes/save-choice.ts` (tested) and are mirrored in Swift (`ShareChoice.swift`).
3. Saving writes a share envelope to the App Group queue (4.9: `householdId`, `addToList`, and `listId` only when on) and shows "Added. It'll be on your list when you open The Perfect Bite." (switch on) or "Saved. It'll be in your recipes when you open The Perfect Bite." (off) for about a second, then closes. The extension makes no network call (auth from extensions is the unsolved Siri token problem, `docs/spikes.md` §2) and runs no React Native. In Safari, the extension also captures the page's title, its `application/ld+json` blocks and its readable text, so pages behind a sign-in or paywall import from what the user sees; other apps only give the URL.
4. The app **drains the share queue** on launch, foreground and reconnect, next to the Siri queue: one drain at a time, oldest first, each envelope imported as below with the envelope id as the import id, so an envelope imported twice (a crash before its file is deleted) creates one recipe. An imported file is deleted; an unreadable one is logged and deleted.

**From inside the app**
- The sheet offers the share sheet's choices: a **Save to** household picker (pills; hidden with one household), then **Also add ingredients to a list** with a switch that shows that household's list picker when on; the button reads **Save recipe** or **Save & add to <list>**, and a household with no lists disables the switch with "This household has no lists". Changing household resets the list to that household's default. With the switch off it imports recipe-only (as a recipe-only share).
- **Import from link** on the Recipes tab: the household follows the share sheet's rule (the household of the last opened list, then of the default list, then the first), and the switch starts off and remembers its last state on the device (device setting `importAddToList`, separate from the extension's). Opened with a list (`list` param; the list's menu no longer offers it, but the sheet still takes one): that list's household, the switch on with that list chosen (the user can still turn it off or change list; that isn't remembered). The rules are `initialSaveChoice` in `src/features/recipes/save-choice.ts`.
- Saved with the switch off, the sheet closes and the toast "Saved *Chicken tikka masala*" (or "… is already in your recipes") with **Undo** (only when created) and **View recipe** shows on the Recipes tab, or on the list when the sheet was opened from a list's menu.
- A small sheet has a URL field and a **Paste** button. The clipboard is read only when Paste is tapped, so iOS shows no paste prompt when the sheet opens. While it works the sheet shows "Reading recipe…", with "You can close this. We'll let you know when it's ready." under it, then closes on success. Closing the sheet while it reads doesn't stop the import: its result arrives as an in-app notification (4.11, below).
- **Device fallback.** Many recipe sites answer a server fetch with a bot check (Cloudflare's "Just a moment...", "Security Verification", Vercel Security Checkpoint, AllRecipes' JS-only "Simple Page"). When the server answers `fetch_failed` for a pasted link, the app loads the link in a hidden WebView, waits up to 20 s for the real page (a challenge page often reloads into it), captures the page's title, JSON-LD blocks and readable text with the same caps as the share extension, and imports again with that page (6.6). Nothing shows on screen. Only `fetch_failed` falls back, never "not a recipe", a rate limit or an invalid URL.

**Which list.** The picker defaults to the list last opened on this device (`lastOpenedListId`, 4.1), then the user's default list (4.1), then the first list; archived and deleted lists don't count. If a queued share's list is gone or archived by the time it drains, it goes to the default list.

**Recipe only.** A share can save the recipe without adding anything to a list: its envelope has `addToList: false`, `listId: null` and the `householdId` to save it to. An envelope without `addToList` (queued by an older extension) adds to a list as above. The drain imports it into that household with the same import id and the same reuse by canonical URL, and adds no list items; if the household is gone (left or deleted) by then, it goes to the household of the default list. Undo deletes the recipe only if this import created it. In the imports card a waiting recipe-only share reads "host · to *household*".

**Which recipe.** A recipe's `source_url` is stored in canonical form: lowercase host, no `www.`, no fragment, no tracking parameters (`utm_*`, `fbclid`, `gclid`, `ref`, `mc_*`), no trailing slash. If the list's household already has a recipe with the same canonical `source_url`, the import reuses it: no duplicate recipe is created, and the existing recipe is left as it is. Otherwise a new recipe is created in that household with the page's recipe name, the source URL, notes "Serves N" when the page says, and its ingredients in page order (name, quantity, unit, note, as 4.5).

**What goes on the list.** Every ingredient, at 1×, with no checklist step, as the recipe's contributions, exactly like 4.4 bulk add with Combine-silently duplicate handling: an open match Combines, a checked match is unchecked with its amounts replaced, and the same ingredient twice folds into one item. Household usage counts as a recipe add (4.2). Categories for new names come back with the import, so nothing shows "Sorting…" unless categorizing them failed (then 6.3's catch-up retries them as usual).

**The toast.** On the list screen: "Added *Chicken tikka masala* · 12 items" for 5 seconds with **Undo** and **View recipe**. Undo removes every contribution the import added to the list (as bulk-add Undo does) and deletes the recipe if this import created it; a reused recipe stays. View recipe opens the recipe. When one drain imports several shares, a single toast says "Added 3 recipes". If the drain finishes while the Recipes tab is showing, the toast shows there instead, above the tab bar: "Added *Chicken tikka masala* · 12 items on Groceries" with **Undo** and **Open list**, and the recipe's card is outlined in `primary` while it shows. A recipe-only share shows no list toast; on the Recipes tab it says "Saved *Chicken tikka masala*" (or "*Chicken tikka masala* is already in your recipes" when it was reused) with **Undo** (only when the import created the recipe) and **View recipe**, the card outlined as above. Elsewhere there's no toast; the recipe is on the list and on the Recipes tab.

**Not a recipe, or the import fails**
- In the app, failures show inline in the sheet in plain words, and the sheet stays open: "That page doesn't look like a recipe" (anything that isn't a single recipe: an article, a page listing many recipes), "Couldn't reach that site" (the page couldn't be fetched or isn't HTML, on the server or the device), "This site blocked the import. Open it in Safari and tap Share → The Perfect Bite." (the device fallback never got past the bot check), "Try again in a minute" (rate limit or the service unavailable), "That doesn't look like a link" (an invalid URL) [Default], "You're offline" [Default], and "Recipe import isn't included in your plan." (the function answered `not_entitled`, 4.12). Nothing is written.
- For a share: "not a recipe" and "not in the plan" are recorded as a **failed import** at once (no retries) and the file deleted. The extension can't know the plan, so shares still queue on any plan and fail with that reason when they drain; the imports card shows the same words. Offline, signed-out, rate-limited and other temporary failures keep the file for the next drain; after 5 attempts (counted per envelope in device settings) it is recorded as a failed import and deleted. Offline or rate-limited, the drain stops there, so the shares after it wait without counting an attempt.
- **Failed imports** are kept on the device only (`failed_imports`: url, title, reason, when, and where it was going: the household, and the list when there was one; not synced).

**The imports card.** While anything is importing, waiting in the share queue or failed, the Recipes tab shows one card at the top. Its heading says what matters most: failed imports first ("Couldn't import 1 recipe", with "1 more waiting" or "Importing 1 of 2…" under it), then an import running ("Importing 1 of 2…" over the recipe and its list), then shares waiting ("2 recipes waiting" over why: "You're offline. They'll import when you're back.", "The import service is busy. They'll import next time you open the app.", or "Something went wrong. They'll import next time you open the app."). Tapping it expands a row per share, in two labelled groups when there are both: **Couldn't import**, each with its title (or host), the reason, **Try again** (imports it where it was going: recipe-only into its household, or onto the same list, falling back as the drain does when that's gone; rows recorded before targets were kept go to the default list; success removes the row, another failure keeps it with the new reason) and **Dismiss**; and **Waiting**, each with its title (or host) over "host · to *list* · tried twice" and **Remove** (deletes the share and its try count; the one importing shows a spinner instead and can't be removed). The Recipes tab's icon has a badge counting waiting shares and failed imports, hidden while a drain is running. The queue's state comes from the drain (`share-queue-status.ts`), read again from the App Group at each step; it is never stored.

**When the sheet was closed while reading.** The import carries on, and its result is posted as a `recipeImport` notification (4.11) in place of the sheet's toast or inline error. Nothing waits on the list for later.
- Success: the recipe's icon tile (`recipeHue`, fork and knife), title "Recipe added", body "Added *Chicken tikka masala* · 12 items to Groceries". Tapping it opens that list with the usual import toast (Undo, View recipe); if that list is already showing, the toast shows there.
- Recipe-only success: the same tile, title "Recipe saved", body "Saved *Chicken tikka masala* to *Smith home*". Tapping it opens the recipe.
- Failure: a rose warning tile, title "Couldn't import recipe", body the sheet's plain-words reason (above). Tapping it reopens the sheet with the same household, switch state, list and link. The device fallback still runs first.
- The share-queue drain keeps its list toast and posts no notification.

**Offline.** A share always succeeds in the extension, online or not: the envelope waits in the App Group until the app is open, signed in and online, then imports. A signed-out app keeps it until after sign-in. The in-app sheet needs a connection; offline it says so and queues nothing.

### 4.11 In-app notifications (req 13)

A banner that drops in at the top of the screen, over whatever is showing (sheets too), to say that something the user started has finished while they were doing something else. This is the base each feature adds its own notifications to. Push notifications are separate and Later (11.1).

- **Kinds.** A feature posts a notification with a `kind`, one per use case, so per-kind settings (11.1) can switch them off later without touching the features. v1 has one kind: `recipeImport` (4.10).
- **The banner.** A `surface` card 8 pt below the top safe area and 16 pt from the sides, with radius `card` and the floating shadow in light mode. It holds an icon tile, a title (`headline`) and up to two lines of body (`footnote`, `inkSecondary`), with an optional part of the body in bold. Tapping the banner runs its action and dismisses it. Swiping it up dismisses it. It times out after 6 seconds (`motion.notificationTimeoutMs`). It slides down on arrival and up on leaving, and only fades under Reduce Motion. A success or warning haptic plays when it appears. VoiceOver announces "title. body", and the banner is a button whose hint says what tapping does.
- **One at a time.** Notifications queue in the order they're posted, and the next one drops in when the one showing goes. Posting with the id of a notification that is already queued or showing replaces it in place, and a replaced banner that's showing restarts its timer.
- **Only while the app is in the foreground.** The timer starts when the banner shows. A notification posted while the app is in the background waits until the app comes back. A banner showing when the app goes to the background stays up and restarts its timer when the app returns.
- **Not kept.** Notifications live in memory only. There's no inbox, and nothing survives the app quitting or signing out (sign-out clears the queue).

### 4.12 Admin and plans

**The dashboard is the admin tool.** There's no custom admin portal. The app is run from the Supabase dashboard: Authentication → Users, the Table Editor, the SQL Editor, and the Edge Function logs. How to do common jobs there is in [`docs/admin.md`](admin.md).

- The dashboard runs as `postgres` and doesn't know the app's rules. So a change that has rules goes through a tested SQL function in the `admin` schema, run as a saved SQL snippet, never by editing or deleting rows by hand. A change with no rules beyond the table's own constraints is made in the Table Editor.
- `admin` isn't one of the API's exposed schemas (`supabase/config.toml`), and its schema usage and every function's execute are revoked from `public`, `anon`, `authenticated` and `service_role`, so only the dashboard can call them.
- Each admin function writes one `admin.admin_actions` row (5) in the same transaction. `performed_by` is always `postgres` from the dashboard, so each function takes a `p_note`, and the snippets always fill it in: it's the only record of who asked and why.

**`admin.delete_user(p_user_id, p_note)`**: account deletion (4.8) for a support request; users delete their own with `delete_account()` (4.8). Both run `private.delete_user_core(p_user_id)`, which does the steps below except the audit row and returns the households array.
- Raises `user not found` for an unknown id, changing nothing.
- For each of the user's households (in their household order) it runs the leaving rules, `private.remove_member_from_household` (4.7): the last member leaving deletes the household and its data (`deleted`); the last owner leaving promotes the member who joined earliest (`promoted`); otherwise the user just leaves (`left`). The helper doesn't create a personal household; that's for callers whose user goes on using the app (`leave_household`, `remove_member`).
- Then it deletes the `auth.users` row, which cascades their memberships, profile, aisle order and settings. Rows they made in households that remain (items added or checked, contributions, recipes, invites) stay, with `added_by`, `checked_by`, `created_by` and `used_by` set to null.
- Its audit row has `action` `delete_user`, the user's id, the note, and `details`: the email, the display name and, per household, its id, name and outcome (with `promoted_user_id` for `promoted`). It returns the same `details`.

**Plans and features.** A feature is a text key; a plan is a named set of features (`plans`, `plan_features`, `user_plans`, 5).
- v1 features: `categorize` (the LLM categorizes new ingredient names, 6.1), `recipe_import` (4.10; it categorizes in the same request, so a plan with it also has `categorize`, and the pgTAP suite checks every plan for that), `recipe_import_photo` (future photo import; nothing checks it yet) and `recipe_tags` (the AI suggests tags for a recipe on demand, 4.14, 6.7).
- Seeded plans: **base** (no features), **standard** (`categorize`; the default) and **plus** (`categorize`, `recipe_import`, `recipe_import_photo`, `recipe_tags`; imports there are already AI-tagged, so plus is where tag suggestions belong). At most one plan is the default (a partial unique index); if none is, a user with no assignment has no features. New plans are made by hand in SQL; there's no `create_plan`.
- **Per user.** A user's plan is their `user_plans` row, else the default plan. Members of one household can be on different plans, and each gets their own.
- Changing a plan has no rules beyond the table's constraints, so there's no admin function: add, edit or delete the user's `user_plans` row in the Table Editor (the foreign key only allows real plans; no row means the default; a `before update` trigger sets `assigned_at`). The plans migration puts the owner's account (jgpasch@gmail.com) on plus, so it keeps recipe import on hosted.
- **Resolution.** `has_feature(user, feature, household)` (for Edge Functions, `service_role` only) and `my_features(household)` (for the app, the caller's features, sorted) are the only places a plan is resolved. Both take the household the action is in, when it's known, and ignore it today. To make plans per household later (so one paying member can't share their plan by inviting anyone), change only that resolution, e.g. to a household's plan or the best plan among its members.
- **In the app.** A store in `src/features/plans/` holds the user's features: `features.ts` (`useFeature(feature)` for screens, `hasFeature(feature)` for other code) and `load.ts`, which calls `my_features()` after sign-in and on each foreground and reconnect while signed in and online, keeps the last answer in device settings (with the user's id) so an offline launch has it, and clears both on sign-out. Until the first answer it assumes the default plan (standard), so nothing hides or stops by mistake. A function's `not_entitled` answer drops that feature from the store at once and reloads it. Without `categorize` the app sends nothing to `categorize-ingredients` (4.3.1, 6.3); when the store gains it (a plan change), the catch-up runs right away so names left pending are sent. Without `recipe_import` the app hides recipe import's entry points: **Add recipe from link…** in a list's menu and both **Import from link** buttons on the Recipes tab (the empty state's and the toolbar's). An import answered `not_entitled` fails with "Recipe import isn't included in your plan." (4.10). Without `recipe_tags` the app hides both **Suggest tags** entry points (the button in the Tags sheet and the dashed pill on an untagged recipe, 4.14); a suggestion answered `not_entitled` fails with "Tag suggestions aren't included in your plan."
- Edge Functions enforce entitlements; the app only hides or skips what isn't enabled. Each function checks its feature first, before the rate limit or any database, fetch or LLM work, through `requireFeature(admin, userId, feature, householdId?)` (`supabase/functions/_shared/entitlements.ts`, which calls `has_feature` and throws `NotEntitledError`), and answers **403** with the usual error body, `{ error: 'not_entitled', message }`: `categorize-ingredients` checks `categorize` (6.1), `import-recipe` checks `recipe_import` (6.6) and `suggest-recipe-tags` checks `recipe_tags` (6.7). An import's inline categorizing isn't checked again, since `recipe_import` implies `categorize`. No request carries a household, so none passes one yet.
- Local dev: `supabase/seed.sql` puts the dev user on plus, so manual testing against local Supabase has every feature. The `yarn ai:*` scripts (CLI and evals) run the handlers against in-memory stores with no database, and those stores grant every feature.

### 4.14 Recipe tags and filtering

Recipes are tagged so the Recipes tab stays usable at 50+ recipes (req 15). (4.13 is kept for push notifications.)

- **The tags.** A fixed list, never free-form, in `src/shared/recipe-tags.ts`, used by the app, the `import-recipe` Edge Function and the Zod schemas. Each value has a slug (stored) and a label (shown). The facets in display order, with how many a recipe may have:
  - Meal, up to 2: breakfast, lunch, dinner, side, dessert, snack, drink.
  - Cuisine, up to 2: american, mexican, latin-american, caribbean, italian, french, spanish, greek, mediterranean, middle-eastern, indian, chinese, japanese, korean, thai, vietnamese, african.
  - Protein, up to 3: chicken, turkey, beef, pork, lamb, fish, shellfish, eggs, tofu-tempeh ("Tofu & tempeh"), beans-lentils ("Beans & lentils").
  - Diet, up to 2: vegetarian, vegan. No gluten-free, dairy-free or nut-free: a wrong guess could hurt someone with an allergy.
  - Method, up to 2: pressure-cooker (label "Instant Pot"), slow-cooker, sheet-pan, one-pot, grill, air-fryer, no-cook.
- **Time** isn't a tag. `timeBucket(total_minutes)` gives Under 30 min (under 30), Under 1 hour (30 to 60) or Over 1 hour (over 60); a recipe with no time has no bucket.
- **Regions.** Each cuisine maps to a region (american, latin, european, middle-eastern, asian, african) in the same file, for the Later "by category" view (11.5). Nothing uses it yet.
- **Values the app doesn't know.** `RecipeTagsSchema` keeps the five facets (a missing one becomes empty), drops any other key and keeps every slug. `knownTags()` drops slugs the app doesn't know, for display only; saves write the stored value. So a value added later doesn't break older apps, and they don't erase it.
- **Data** (5): `tags` (null = never tagged), `tags_edited` (set by the first edit by a person; hides "Tagged when you imported it"), `total_minutes` (1 to 2880) and `added_by` (set by the server to whoever inserted the recipe; recipes from before this have none). The first three are field-level last-writer-wins like the other recipe fields, the whole `tags` value as one field (7.1, 7.3).
- **Where tags come from.** An import saves the tags and time the extraction returned. An import that reuses an existing recipe (same canonical URL, 4.10) leaves it untouched, so the AI never overwrites tags a person edited. Recipes made by hand (New recipe, from list items) start untagged. Copy to household keeps tags and time. Existing recipes stay untagged until a member tags them.
- **Suggesting tags** (`recipe_tags`, 4.12): on a recipe that's already saved, a person can ask the AI to tag it (the same tagging as an import, 6.7). It only *suggests*: the suggestion fills the Tags sheet's pills, the person checks them and taps Save, so nothing is written without someone seeing it and the AI never overwrites tags behind anyone's back. Tags only, never the time (a hand-made recipe has no steps to work it out from). It runs on the recipe's name, notes and live ingredients as the device has them, since the recipe may not have synced yet; the server reads no recipe rows. A recipe with no ingredients can't ask.
- **On the recipe screen** (mockup D): under the link, a wrapping row of tag pills, each its facet (`caption`) over its value (`amount`) on a translucent wash in the band, in facet order, then the time bucket, then a dashed **+ Tags** (VoiceOver: "Meal: Dinner", …, "Edit tags"). Without any (untagged, or an import that found none), only a dashed **Add tags**; a new recipe opens that way, with no extra step. While `tags_edited` is false and the recipe has tags, "Tagged when you imported it" (`footnote`) sits under the row. Any pill opens the **Tags** sheet: Cancel and Save in the toolbar, one group of toggle pills per facet (a facet at its maximum disables its other values and says "Pick up to 2"), then an optional, clearable **Total time** in hours and minutes (up to 48 hours). Save writes `tags` (the stored value, so slugs this app doesn't know are kept), `total_minutes` and `tags_edited: true` in one update; Cancel writes nothing.
- **Suggest tags in the app** (only with `recipe_tags`; both entry points hide without it). The Tags sheet has a full-width secondary **Suggest tags** button (SF Symbol `sparkles`) above the first facet. Tapping it shows **Suggesting…** with a spinner, disabled, while the rest of the sheet stays usable; Cancel during the call drops the answer. A suggestion replaces the sheet's picks for the five facets (keeping slugs this app doesn't know), never the time, and a `footnote` (`inkSecondary`) under the button says "Suggested by AI. Check them, then Save."; when nothing clearly fit, "No tags clearly fit this recipe." and the picks stay. The suggested pills are ordinary selected pills, and Save works as above (`tags_edited: true`), so a suggested recipe never shows "Tagged when you imported it". An error shows its message (from `suggest-tags.ts`) as that line in `danger`, never an alert, and the button reads **Suggest tags** again; after a suggestion it reads **Suggest again**. With no ingredients the button is disabled with "Add some ingredients first, so there's something to go on." under it. On the recipe screen, an untagged recipe with ingredients also gets a dashed **Suggest tags** pill (`sparkles`) after **Add tags**; it opens the sheet with `suggest=1`, which starts the suggestion as the sheet opens. VoiceOver: the button is "Suggest tags" (hint "Picks tags for this recipe with AI. Nothing is saved until you tap Save."), "Suggesting tags" while it runs, then announces "Tags suggested", the no-fit line or the error; the pill is "Suggest tags" (hint "Opens the tags, with AI suggestions.").
- **Search** (Recipes tab): the native header search bar, "Search N recipes" (shown once there's a recipe). It matches recipe names and their live ingredients' display names, ignoring case and accents, on local SQLite, so it works offline. A recipe that matches only through an ingredient shows "Has *chicken thighs*" (`footnote`, the ingredient in 700) in place of "N ingredients", and VoiceOver reads "has chicken thighs" in place of the count. Households group as before; one with no matches is hidden. No results: "No recipes match" (`callout`, `inkSecondary`). The imports card stays at the top. The search text isn't saved.
- **Filters** (Recipes tab, mockup C): a **Filters** pill under the search field (`Filters`, or `Filters · 2` filled `primary` while some are on; VoiceOver "Filters, 2 active") opens the **Filters** sheet: a group of toggle pills per facet, then Time (the three buckets), showing only values some recipe in the user's households has (a facet with none is left out; a value already picked stays so it can be turned off), **Clear** in the toolbar, and a full-width **Show N recipes** CTA that counts live, with the search. Picks apply at once, so closing the sheet any way keeps them; the CTA closes it. Matching: OR within a facet, AND across facets, AND with the search. There's no maximum when filtering. Active values show as chips after the pill ("Dinner ✕", VoiceOver "Remove Dinner filter"); tapping one removes it. A recipe is untagged when it has no known tag and no time. While filters are on, the end of the results says "N recipes without tags aren't shown" (`footnote`, counting the ones the search found); tapping it replaces the filters with only untagged recipes, shown by an "Untagged ✕" chip (picking a value in the sheet leaves Untagged). No results with filters on: "No recipes match" and a **Clear filters** button. Filters are kept in memory for the app session: they survive tab switches, not a relaunch.

### 4.15 Languages (Mexican Spanish)

The app speaks English and Mexican Spanish (`es-MX`). Building it is planned in `future/i18n-es-mx-tasks.md`. Spanish stays switched off until the UI, the add field and the Spanish catalog all work (the last step below); until then it shows only in development builds.

- **Which language.** The app follows the phone: the first of the phone's preferred languages (`expo-localization` `getLocales()`) that the app supports, else English. Any Spanish (`es-MX`, `es-US`, `es-ES`) gets Mexican Spanish. There's no picker in the app: declaring the languages (`expo-localization` plugin `supportedLocales.ios`) makes iOS show **Settings > The Perfect Bite > Language**, which changes the app's language on its own, and keeps the app, Siri, the share extension and the system's permission prompts in one language. A development build can force a language with `EXPO_PUBLIC_FORCE_LANGUAGE` (`en` or `es`), even before Spanish is switched on.
- **Tone.** Mexican Spanish, addressing the user as *tú*, in the style of Mexican consumer apps. Units and food words are Mexican (*jitomate*, *aguacate*, *frijol*, *crema*). A native speaker reviews every string before Spanish is switched on.
- **Strings.** Every string the app shows or speaks (labels, buttons, toasts, empty states, VoiceOver labels and hints, Share as text) comes from `src/i18n/`: `en.ts` is the source, and `es.ts` must have exactly the same keys (typecheck fails otherwise). Plurals use the language's plural rules ("1 artículo", "3 artículos"); dates, times and numbers use `Intl` with the app's language. This spec quotes the English; the Spanish is its translation, not a separate design. Tests run in English.
- **What isn't translated.** Anything a person typed or imported stays as written: item and ingredient names, recipe names, steps and notes, custom aisles, household and list names. A recipe imported from a Spanish page stays in Spanish (6.6).
- **Fixed vocabularies are translated by slug.** System aisles (6.2), recipe tags (4.14) and units are stored as slugs or unit keys, so they're shown in the app's language with no data change. "New category…" treats a name matching a system aisle in either language as that aisle (`Lácteos` picks Dairy & Eggs). Units: `cup` *taza*, `tbsp` *cda*, `tsp` *cdta*, `can` *lata*, `jar` *frasco*, `bag` *bolsa*, `box` *caja*, `bunch` *manojo*, `clove` *diente*, `pinch` *pizca*, `dozen` *docena*, each with its plural; metric and US abbreviations (`g`, `kg`, `ml`, `l`, `oz`, `lb`, `fl oz`, `pt`, `qt`, `gal`) stay as they are.
- **Typing in Spanish** (4.2). One normalizer serves both languages, so phones set to different languages in one household always compute the same key for the same text:
  - **Accents are folded** for the key: `limón` and `limon`, `jalapeño` and `jalapeno` are one ingredient. The display name keeps what was typed. Existing keys with accents are merged into their folded keys once, by a migration.
  - **Spanish plurals.** `-s` plurals already work (`aguacates`, `tortillas`, `chiles`). Plurals in `-es` after a consonant (`limones`, `frijoles`, `nueces`, `panes`) can't be told from English by rule (`scones`, `slices`), so they come from a list built from the Spanish catalog's names; a test fails if one collides with an English plural.
  - **Amounts.** The quantity parser (4.2) reads Spanish numbers (`un`, `una`, `uno` to `veinte`, `medio`/`media` = ½), unit words (`taza(s)`, `cucharada(s)`/`cda`, `cucharadita(s)`/`cdta`, `gramo(s)`/`gr`, `kilo(s)`/`kilogramo(s)`, `litro(s)`, `mililitro(s)`, `libra(s)`, `onza(s)`, `galón`/`galones`, `lata(s)`, `frasco(s)`, `bolsa(s)`, `caja(s)`, `manojo(s)`, `diente(s)`, `pizca(s)`, `docena(s)`) and `pieza(s)`/`pza(s)` as a plain count, and drops a `de` right after the unit: `2 tazas de harina` is 2 cup `harina`, `media docena de huevos` ½ dozen `huevos`, `3 piezas de aguacate` 3 `aguacate`. Like the English words, these are accepted whatever the app's language, since the parser is shared with Siri and the Edge Functions.
- **Spanish catalog.** A Mexican starter catalog (`src/shared/seed/ingredients-es.ts`, the shape of 6.2's) seeds the global catalog with names as Mexicans type them. Each Spanish name is its own ingredient (own key, own `default_unit`: how it's sold in a Mexican supermarket, so `leche` is `l` and `pechuga de pollo` is `kg`) and is tagged `lang = 'es'` (English seed names `'en'`; names users add, `null`). Autocomplete's catalog part (4.2) puts names in the app's language first.
- **Linked ingredients** (`ingredients.same_as`, 5). A Spanish name can point at the English ingredient it means (`leche` → `milk`; `papa` and `patata` → `potato`). Links are one level only (a linked ingredient's target has no link of its own) and only where the two are truly the same thing on a shopping list: none for `tomate` (a tomatillo in Mexico; `jitomate` → `tomato`), `crema`, `chile` or `queso fresco`, which stay unlinked. A wrong link is worse than none, since 4.4 combines duplicates without asking. In this first stage, links come only from the seed (reviewed by a person). An ingredient's **family key** is `same_as` if it has one, else its own key. Stage 1 uses links only where a mistake is harmless:
  - The seed gives a linked Spanish name its target's category.
  - Household aisle overrides (4.3.2) are written and read under the family key, so moving `milk` to another aisle moves `leche` with it, and the other way round.
  - Everything else (duplicates and Combine, the "already on list" tint, usage history, the usual unit, recipe matching) still compares the ingredient's own key: `leche` and `milk` on one list are two items.
- **Stage 2 (later, 11.4).** Once the links are trusted: first the "already on list" tint follows the family key (typing `leche` tints Milk), then duplicates Combine across a family (4.4), then the categorizer may propose links for new names (6.4), held for review before they count.
- **AI.** The categorizer (6.4) accepts English and Spanish names; for a Spanish name the unit is how it's sold in Mexico. Recipe extraction (6.6) keeps the page's language. Push notifications (11.1), when built, use the recipient's language, which the server will need to store.

---

## 5. Data model

Postgres (Supabase). Row ids are UUIDv7 generated on the client so rows can be created offline. All tables have `created_at` and `updated_at` (server-set). Household-scoped tables also have `deleted_at` for soft delete (needed for sync) and `field_clock jsonb` for conflict resolution (7.3).

**Ingredient key**: ingredients are identified by `normalized_name` (text primary key). The client can always compute it, offline included, so list items reference an ingredient without waiting for the server. No provisional ids, no rewriting.

```sql
-- System categories (global, shared across all users) and households' custom ones
create table categories (
  id            uuid primary key,
  slug          text unique,          -- e.g. 'produce'; null for custom
  name          text not null,
  household_id  uuid references households on delete cascade, -- null = system category
  default_rank  int,                   -- default store-walk order for system categories
  field_clock   jsonb not null default '{}',  -- custom ones sync as household data (7.3)
  check ((slug is not null and household_id is null) or (slug is null and household_id is not null))
);

create table ingredients (
  normalized_name     text primary key,
  display_name        text not null,
  default_category_id uuid references categories,     -- null while pending
  status              text not null default 'pending', -- pending | categorized | failed
  is_grocery_item     boolean,                          -- null until categorized
  categorized_by      text,                             -- e.g. model id, 'seed', 'admin'
  default_unit        text,                             -- usual unit until a household has history (4.2): a unit or 'count'; null = unknown
  lang                text,                             -- 'en' | 'es' for seeded names (4.15); null for names users added
  same_as             text references ingredients,      -- the ingredient this name means in another language (4.15); one level only
  attempts            int not null default 0,
  household_count     int not null default 0,           -- see 6.5
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- Which households have used an ingredient. Service role only; used to maintain household_count.
create table ingredient_households (
  ingredient_name text references ingredients on delete cascade,
  household_id    uuid references households on delete cascade,
  primary key (ingredient_name, household_id)
);

-- Households (req 7)
create table households (
  id         uuid primary key,
  name       text not null,
  created_by uuid references auth.users on delete set null -- informational only; roles live in household_members
);

-- A user can be in many households (Q6). Every household has at least one owner,
-- and every user at least one membership; both are enforced by the household functions.
create table household_members (
  household_id uuid references households on delete cascade,
  user_id      uuid references auth.users on delete cascade,
  role         text not null default 'member', -- owner | member
  joined_at    timestamptz not null default now(), -- used for owner promotion
  position     double precision not null,          -- this user's household order (per user)
  primary key (household_id, user_id)
);
create index on household_members (user_id);

create table household_invites (
  id           uuid primary key,
  household_id uuid references households on delete cascade,
  token_hash   text not null unique,
  created_by   uuid references auth.users,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  used_by      uuid references auth.users,
  used_at      timestamptz,
  invited_email text check (invited_email = lower(invited_email) and invited_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'), -- null = link-only
  revoked_at   timestamptz,
  declined_at  timestamptz
);
-- One open (not used, revoked or declined) invite per household and email.
create unique index on household_invites (household_id, invited_email)
  where invited_email is not null and used_at is null and revoked_at is null and declined_at is null;

-- Household data
create table lists (
  id           uuid primary key,
  household_id uuid not null references households,
  name         text not null,
  emoji        text,
  color        text check (color in ('green', 'blue', 'rose', 'amber', 'grey')),  -- null = Default (4.1)
  position     double precision not null,
  archived_at  timestamptz,
  deleted_at   timestamptz,
  field_clock  jsonb not null default '{}'
);

create table recipes (
  id           uuid primary key,
  household_id uuid not null references households,
  name         text not null,
  notes        text,
  source_url   text,
  tags          jsonb,                           -- 4.14; null = never tagged
  tags_edited   boolean not null default false,  -- a person has edited the tags
  total_minutes int check (total_minutes between 1 and 2880),
  added_by      uuid references auth.users on delete set null,  -- the server sets it on insert
  deleted_at   timestamptz,
  field_clock  jsonb not null default '{}'
);
-- recipes_tags_shape: tags may only have the keys meal, cuisine, protein, diet and method, each an
-- array of strings. The values aren't checked, so adding one needs no migration.

create table list_items (
  id              uuid primary key,
  list_id         uuid not null references lists,
  household_id    uuid not null references households,  -- denormalized for RLS
  ingredient_name text not null references ingredients,
  display_name    text not null,                         -- what the user typed or said
  note            text,
  checked_at      timestamptz,
  checked_by      uuid references auth.users,
  added_by        uuid references auth.users,
  deleted_at      timestamptz,
  merged_into     uuid references list_items,            -- set by apply_mutations when merged (7.3)
  field_clock     jsonb not null default '{}'
);
-- at most one live unchecked item per ingredient per list
create unique index one_open_item_per_ingredient
  on list_items (list_id, ingredient_name)
  where deleted_at is null and checked_at is null;

create table list_item_contributions (
  id           uuid primary key,
  list_item_id uuid not null references list_items,
  household_id uuid not null references households,
  source       text not null default 'manual', -- manual | recipe | siri
  recipe_id    uuid references recipes,        -- set when source = 'recipe'
  quantity     numeric,                        -- null = unspecified
  unit         text,
  added_by     uuid references auth.users,
  deleted_at   timestamptz,
  field_clock  jsonb not null default '{}'
);

create table recipe_ingredients (
  id              uuid primary key,
  recipe_id       uuid not null references recipes,
  household_id    uuid not null references households,
  ingredient_name text not null references ingredients,
  display_name    text not null,
  quantity        numeric,
  unit            text,
  note            text,
  position        double precision not null,
  deleted_at      timestamptz,
  field_clock     jsonb not null default '{}'
);

-- Household ingredient history for autocomplete (4.2). Synced in M5 like other household data,
-- except use_count, which merges as a counter (each device's increments and decrements add up)
-- rather than last-writer-wins. display_name, last_used_at and hidden_at are last-writer-wins.
create table ingredient_usage (
  household_id    uuid not null references households,
  ingredient_name text not null,                         -- ingredient key
  display_name    text not null,                         -- most recent text typed for it
  use_count       int not null default 0,
  last_used_at    timestamptz not null,
  hidden_at       timestamptz,                           -- "Remove from suggestions"; cleared by the next use
  field_clock     jsonb not null default '{}',
  primary key (household_id, ingredient_name)
);

-- Units each ingredient is bought in, for its usual unit (4.2). Household data synced in M5, kept out
-- of ingredient_usage so it merges with plain counters: use_count merges as a counter (like
-- ingredient_usage.use_count) and last_used_at as the max of both sides. No other merge logic.
create table ingredient_unit_usage (
  household_id    uuid not null references households,
  ingredient_name text not null,                         -- ingredient key
  unit_key        text not null,                         -- a supported unit, or 'count' for a quantity with no unit
  use_count       int not null default 0,
  last_used_at    timestamptz not null,
  field_clock     jsonb not null default '{}',           -- unused (no LWW fields); kept for uniformity
  primary key (household_id, ingredient_name, unit_key)
);

-- A household's aisle for an ingredient (req 6, 4.3.2). Household data: every member sees it.
-- category_id is the only field written (LWW through apply_mutations); null means "the default",
-- which is how Reset to default is written, so a later change can still win.
create table household_category_overrides (
  household_id    uuid not null references households on delete cascade,
  ingredient_name text not null references ingredients,
  category_id     uuid references categories on delete cascade, -- a system category or one of this household's
  field_clock     jsonb not null default '{}',
  primary key (household_id, ingredient_name)
);

-- Per-user aisle order (req 9). Never shared with the household.
create table user_category_order (
  user_id     uuid references auth.users on delete cascade,
  category_id uuid references categories,
  position    double precision not null,
  primary key (user_id, category_id)
);

-- Display info for showing members ("Alex added...", Households screen). auth.users isn't readable by clients.
-- Readable by the user and by anyone who shares a household with them; filled from the Google profile.
create table profiles (
  user_id      uuid primary key references auth.users on delete cascade,
  display_name text not null,
  avatar_url   text
);

create table user_settings (
  user_id         uuid primary key references auth.users on delete cascade,
  default_list_id uuid references lists
);

-- Audit log of admin functions and delete_account (4.8, 4.12), one row per call. In the `admin` schema; no foreign keys,
-- so a row outlives the user or household it describes.
create table admin.admin_actions (
  id                  uuid primary key default gen_random_uuid(),
  action              text not null,                         -- e.g. 'delete_user', 'delete_account'
  target_user_id      uuid,
  target_household_id uuid,
  details             jsonb not null default '{}',
  note                text,                                  -- who asked and why
  performed_by        text not null default session_user,    -- always 'postgres' from the dashboard
  created_at          timestamptz not null default now()
);

-- Plans (4.12). A user's plan is their user_plans row, else the default plan.
create table plans (
  id         text primary key,                 -- 'base', 'standard', 'plus'
  name       text not null,
  is_default boolean not null default false     -- at most one (partial unique index)
);

create table plan_features (
  plan_id text references plans on delete cascade,
  feature text not null check (feature in ('categorize', 'recipe_import', 'recipe_import_photo', 'recipe_tags')),
  primary key (plan_id, feature)
);

create table user_plans (
  user_id     uuid primary key references auth.users on delete cascade,
  plan_id     text not null references plans,
  assigned_at timestamptz not null default now()  -- reset by a before update trigger
);
```

Note the `create table` order above is for readability; the real migration must create referenced tables first.

**AI usage counters** (service role only, in the `private` schema; RLS on, privileges revoked from `public`, `anon` and `authenticated`). Each AI function has a per-user table keyed by (`user_id`, UTC `day`), holding the requests in the current fixed one-minute window (`requests_this_minute`, `minute_start`) and the day's count, and a global per-day total. Only its `check_*_limit` function (`security definer`, `service_role` only) writes them, and pg_cron prunes old rows daily.
- `categorize_usage` / `categorize_daily_total`: LLM-bound names (6.4).
- `recipe_import_usage` / `recipe_import_daily_total`: imports (6.6).
- `recipe_tags_usage` / `recipe_tags_daily_total`: tag suggestions (`suggestions`, 6.7), checked by `check_recipe_tags_limit(user_id, daily_cap)`.

**Unknown ingredients on insert**: clients can't write `ingredients` (RLS). A `before insert` trigger on `list_items` and `recipe_ingredients` (a `security definer` function) inserts a `pending` ingredient row if the name is missing (`on conflict do nothing`) and records the household in `ingredient_households`. So a list item can always be pushed, even before categorization has run.

**Ingredient history and Siri**: `ingredient_usage` and `ingredient_unit_usage` are written by the app in the same local transaction as the add. Siri adds go through the `siri-add` Edge Function (4.9), so they aren't counted until M5 sync, when the server records the use and it syncs down like any other household row.

**Effective category** for an ingredient in a household (the household of the list or recipe it's on) = that household's `household_category_overrides.category_id` if the row exists and it isn't null, else `ingredients.default_category_id`, else "Sorting..." (pending) or Other (failed). Someone in two households has a separate set of overrides and custom aisles in each.

**Row-level security**
- `ingredients`, system `categories` (`household_id is null`): readable by any authenticated user; writable only by the service role and the insert trigger above.
- `ingredient_households`: no client access.
- Custom `categories` and `household_category_overrides`: household data, readable by members of their household only (`household_id in (select my_household_ids())`); written through `apply_mutations` (custom categories: insert with `household_id`, `name` and `created_at`, then `name`; overrides: `category_id` only, which must be a system category or a custom one of the same household).
- `user_category_order`, `user_settings`: read/write only where `user_id = auth.uid()`.
- Household tables: read/write where `household_id` is one of the caller's households: `household_id in (select my_household_ids())`, where `my_household_ids()` is a `stable security definer` function returning the caller's memberships (wrapped in `select` so Postgres evaluates it once per query).
- `households`, `household_members`: members can read the households they belong to and those households' member lists (names and roles; needed for the Households screen). Changes go through `security definer` functions (`create_household`, `rename_household`, `create_invite`, `accept_invite`, `leave_household`, `remove_member`, `set_member_role`, `delete_household`, `reorder_households`; executable by `authenticated` only, not `anon`), which enforce the rules in 4.7 (at least one owner, at least one household per user, owner-only actions). No direct writes.
- `household_invites`: no direct access; `security definer` functions only, all for `authenticated`: `create_invite(household, email?)` (members; with an email, raises `already a member` for a member's email and revokes the open invite to the same email first), `preview_invite` (the join screen's household name, inviter and status: valid, member, used or expired; revoked and declined read as used), `accept_invite` (by link, whoever has it), `list_household_invites` (members; open, unexpired invites), `revoke_invite` (any member of the invite's household), `my_invites` (open, unexpired invites to the caller's `auth.email()`, case-insensitive, for households they aren't in), and `accept_invite_by_id` / `decline_invite` (only for an invite to the caller's email; anyone else gets `invite not found`, the same as an unknown id).
- `copy_recipe(recipe_id, target_household_id)`: `security definer`; checks the caller is a member of both households.
- `delete_account()` (4.8): `security definer`, `search_path = ''`, executable by `authenticated` only (revoked from `public`, `anon` and `service_role`); acts only on `auth.uid()`. It runs `private.delete_user_core`, which, like the leaving rules, is callable only by `postgres` and the `security definer` functions that use it, and writes its `admin.admin_actions` row itself, so the caller never touches the `admin` schema.
- The `admin` schema (`admin_actions`, `delete_user`, 4.12): `postgres` (the dashboard) only. Not exposed by the API; usage on the schema, every privilege on `admin_actions` and execute on its functions are revoked from `public`, `anon`, `authenticated` and `service_role` (each function revokes its own execute: a per-schema default privilege can't take away Postgres's global PUBLIC execute). The leaving rules, `private.remove_member_from_household(household_id, user_id)`, return `left`, `promoted` or `deleted` and are callable only by `postgres` and the `security definer` functions that use them.
- `plans`, `plan_features`, `user_plans` (4.12): no client access (RLS on, no policies, privileges revoked from `anon` and `authenticated`); edited from the dashboard. `has_feature(user_id, feature, household_id default null)` is `stable security definer` in `public` so Edge Functions can call it with the service role (like `check_categorize_limit`); execute is revoked from `public`, `anon` and `authenticated`. `my_features(household_id default null)` returns the caller's features, sorted, for `authenticated`; it's `security definer` with `search_path = ''`, since run as the caller it couldn't read the plan tables.
- Writes to household data go through `apply_mutations` (7.3), which enforces the same household check.

---

## 6. Ingredient categorization and recipe extraction (req 4, 5, 5.1, 14)

### 6.1 Flow
1. Client adds an item. It normalizes the name and looks in its local ingredient cache.
2. **Hit**: use the cached category. Done.
3. **Miss**: the client creates the list item with `ingredient_name` set (it already has the key), shows "Sorting...", and keeps a local `pending` ingredient row. Without the plan's `categorize` (4.12) it shows the item in **Other** instead, gives the row the default unit `count`, and stops here: nothing is sent until the plan has `categorize`.
4. Right after the add, the client sends that add's new names in one request (6.3) to the `categorize-ingredients` Edge Function. A `not_entitled` answer counts as no `categorize`: the names stay pending and the app refreshes its features (4.12).
5. The function first checks that the caller's plan has `categorize` (4.12), answering 403 `not_entitled` without reading or writing anything otherwise. Then, per name: if the ingredient exists and is categorized, return it. Otherwise upsert a `pending` row (`on conflict do nothing`) and collect it into one LLM call. Concurrent requests for the same new name are safe: both upsert the same key; whichever finishes the LLM call first writes the result, and the other's write is skipped if the row is already `categorized`.
6. The response returns `normalized_name -> { status, category_id, is_grocery_item, default_unit }` for every name. The client updates its cache and moves the items into their sections. Other devices get the update through the catalog pull and Realtime on `ingredients` (7.2, 7.4); any device also learns it by sending its own `pending` names.
7. **Retries**: there is no server sweep. The client retries its local `pending` and `failed` names at launch, foreground and reconnect (the catch-up, 6.3). A server row left `pending` (the client went away, a provider error, the kill switch) is harmless: the next add of that name, by anyone, sends it to the LLM again.

"First time we see any ingredient, regardless of which user logged it" is enforced by step 5: the LLM is only called for names with no categorized row in the global table.

### 6.2 System categories [Default]
In default store-walk order:
Produce, Bakery, Deli, Meat & Seafood, Dairy & Eggs, Frozen, Pantry & Dry Goods, Canned & Jarred, Pasta & Grains, Baking, Spices & Seasonings, Condiments & Sauces, Snacks, Beverages, Breakfast & Cereal, Household & Cleaning, Personal Care, Baby, Pet, Other.

Seed the `ingredients` table with about 7,000 common grocery items pre-categorized (`categorized_by = 'seed'`, `is_grocery_item = true`, `household_count` high enough to pass the 6.5 filter) so most early adds never hit the LLM. Every seed item also has a default unit (4.2); `src/shared/seed/ingredients.ts` groups each category's names by it. The list is hand-curated, then checked against the categorizer: `yarn ai:check-seed` runs every seed name through the categorize prompt, saves the answers to `eval/results/seed-check.json` (in the repo, so paid LLM output survives a database reset), and lists every aisle or unit that differs; the seed follows the model's answer except where it calls a real item non-grocery. The golden-set names (6.4) are kept out of the seed so the eval keeps testing names the model hasn't seen. The same seed ships in the app bundle for offline use. The SQL copy is generated, never hand-edited: `yarn db:seed-sql` (`scripts/gen-seed-sql.ts`) writes a new migration that upserts the categories and seed ingredients, overwriting only rows the seed owns or that aren't categorized yet. The app reloads its local copy whenever a hash of the bundled seed changes.

### 6.3 Batching (req 5.1)
- **Client** (`src/features/categories/categorization.ts`): no queue and no timers. Each add sends its new names in one request right away: one name for a single add, all of them for a recipe or bulk add. Launch, foreground and reconnect run a **catch-up** (`catch-up.ts`) that sends up to 100 leftover local `pending` and `failed` names in one request, one catch-up at a time. The local `pending` rows are the queue: they live in SQLite, so names added offline go out with the catch-up on reconnect. A failed request changes nothing locally; its names wait for the next catch-up. Names on items pulled from household-mates get a local `pending` row too (the pull's `ensureMissingIngredients`), so a device with `categorize` sends a base member's new names. Without `categorize` (4.12) neither adds nor the catch-up send anything; gaining it runs the catch-up at once.
- **Server**: one request makes at most one LLM call, covering only the unknown names (max 100 names per request, so one call). Already-known names are answered from the database without any LLM call. So requirement 5.1 and acceptance 6 hold: a 12-ingredient recipe with 8 unknown names is one request and one call.
- [Later] Cross-user server-side coalescing (a short queue window across requests) is possible but adds latency; not in v1.

### 6.4 LLM call
- Use the Vercel AI SDK in the Edge Function, with stash's provider registry pattern (provider keys in Supabase secrets; a provider is registered only if its key is present; model chosen by env var).
- Default model [Default]: `google:gemini-3.8-flash` (cheap, fast; categorization is easy), env `AI_MODEL_CATEGORIZE`. Switching provider is config only.
- Thinking: categorizing needs little reasoning, so the task sends the lowest Gemini thinking level the model accepts (`thinkingLevel: 'low'`, set per task in `tasks.ts`; env `AI_THINKING_CATEGORIZE` overrides it). With the model's own default, 3.8 Flash took 40–60 s per call. Timings: `docs/spikes.md` §4.
- Structured output (`generateObject` with a Zod schema) so the response is guaranteed parseable:
  - Input: the list of category slugs with names, and the list of normalized ingredient names.
  - Output: `[{ "name": string, "category": <one of the slugs>, "is_grocery_item": boolean, "unit": "count" | <a supported unit> }]`. `unit` is stored as the ingredient's `default_unit` (4.2).
- Prompt guidance: categorize as a typical US supermarket would shelve it; ambiguous items go where most shoppers would look first; non-food household goods go to the household/personal care categories; anything that is not something you buy at a store (e.g. "call mom") gets `is_grocery_item: false` and category `other`. The unit is how a US shopper usually buys the item: `count` for single pieces or packages with no better unit, otherwise the unit it's sold or weighed in (`gal` milk, `dozen` eggs, `lb` fresh meat, `bunch` herbs, `can`/`jar`/`bag`/`box` for packaged goods); non-groceries get `count`. Names may be English or Spanish (4.15); a Spanish name gets the unit it's sold in at a Mexican supermarket (usually metric, `count` for *piezas*).
- Validation: any missing name, unknown slug or unknown unit is marked `failed` and gets category Other. Failed rows retry (max 3 attempts), then stay Other.
- A small golden set (~100 names with expected categories and accepted units, including 5 prompt-injection names) runs as an eval when the model or prompt changes: `yarn ai:eval`. `yarn ai:categorize <names>` runs one call by hand (`--model`, `--thinking`, `--repeat N` for p50/p95 latency). Both use the real model and are run by hand only.

**LLM boundaries.** These hold for every categorize call; recipe extraction follows the same principles with its own caps (6.6).
- **Input.** User text is data, never instructions. Names are normalized with the shared normalizer, and names empty afterwards are dropped. A name over 64 characters (after normalizing) is answered `failed` (Other) without reaching the LLM. A request has at most 100 names and a body of at most 16 KB (413 otherwise).
- **Prompt.** The system prompt (instructions) holds the rules, the category list and the units. The names go in the user prompt only, as a JSON array, after a line saying they are untrusted item names to classify and that any instructions inside them are to be ignored. Prompts live in versioned files (`_shared/ai/prompts/categorize.v2.ts`, exporting `CATEGORIZE_PROMPT_VERSION`).
- **Output.** The model can only choose a category slug and a unit (both Zod enums) and a boolean per name. No free text from the model is stored or returned to a client. An answer whose `name` isn't one of the names sent is ignored, the first answer for a name counts, and the output is cut to the number of names sent.
- **Call limits.** `temperature: 0`, `maxOutputTokens` scaled to the batch (50 per name plus 200, capped at 5,500), a 20 s timeout, `maxRetries: 1`, no tools. There's no fallback model unless `AI_MODEL_CATEGORIZE_FALLBACK` is set.
- **Failures.** Bad output (a missing name, an unknown slug or unit) marks those names `failed` with `attempts + 1`; output that fails the schema fails every name in the call. A provider error or timeout isn't the names' fault: they are answered `pending` without counting an attempt, and the next add or catch-up retries them. The rate limits bound those retries.
- **Cost.** Per user: 60 requests a minute and 500 LLM-bound names a day (429 beyond either). Globally: `CATEGORIZE_DAILY_NAME_CAP` (default 20,000) LLM-bound names a day across all users. Once it's reached, the function refuses a request that needs the LLM with a 503 and `Retry-After` (an hour), writing nothing, so the client's names stay `pending`; requests answered entirely from the database still succeed. `AI_MODEL_CATEGORIZE=off` is a kill switch: no model call, and LLM-bound names are answered `pending` (a 200). `mock` never touches the network.
- **Privacy (6.5).** `ai_calls` logs each call's prompt, output, tokens and timing but no user id; only the service role can read it, and rows expire after 30 days. Logs never include the JWT or headers. Categorize, recipe extraction (6.6) and tag suggestion (6.7) are the only AI tasks; nothing else in the app calls a model.
- **Secrets and tests.** Provider keys live only in `supabase/functions/.env` (gitignored) and Supabase secrets, never in the app bundle or `EXPO_PUBLIC_*`. `deno test` and `yarn jest` always use the mock or `MockLanguageModelV4`. Real-model runs (`yarn ai:categorize`, `yarn ai:eval`, `yarn ai:check-seed`) are manual only.

**Changed in implementation.** The rate-limit counters live in Postgres: `private.categorize_usage` (per user and UTC day: requests in the current fixed one-minute window, and LLM-bound names today) and `private.categorize_daily_total` (the global count per day). `public.check_categorize_limit` (service role only) checks and updates them once per request, before anything is written, locking the rows so concurrent requests can't both slip under a limit; a refused request uses no budget. pg_cron only prunes old usage and `ai_calls` rows; nothing calls the function on a schedule.

### 6.5 Privacy
Ingredient names typed or spoken by any user become part of the global catalog and are sent to the LLM. The catalog stores only the normalized name, never who typed it; `ingredient_households` (service role only) records which households used it, solely to maintain `household_count`. Autocomplete from the global catalog only suggests ingredients with `is_grocery_item = true` and `household_count >= N` [Default N=3], so one person's odd entry doesn't leak into everyone's suggestions.

### 6.6 Recipe extraction
The `import-recipe` Edge Function turns a link into a recipe for 4.10. It takes a JWT-authenticated `POST` of `RecipeImportRequest`: `url`, plus an optional `page: { title?, jsonLd?: string[] (each ≤ 200 KB, ≤ 10), text?: string ≤ 50 KB, imageUrl?: string }` (`imageUrl` is the page's `og:image`, else `twitter:image`, as written; the server cleans it with `cleanImageUrl` against the request URL, and one that isn't a string or is over 2048 characters is left out rather than failing the request) when Safari already captured the page, or when the app captured it on the device after a `fetch_failed` for a pasted link (4.10's device fallback). The request, the LLM output and the response share Zod schemas in `src/shared/schemas/recipe-import.ts`, used by the app and the function, along with `canonicalRecipeUrl` (4.10's canonical form).

**Flow**
1. Check that the caller's plan has `recipe_import` (4.12; `403 not_entitled` otherwise, before anything else in this list). Validate the request and canonicalize the URL (`400 invalid_url` for a bad or non-`http(s)` URL).
2. Check the per-user rate limits and the global cap (below), before anything is written.
3. On a cache hit in `recipe_imports` (canonical URL + prompt version, under 30 days old), skip to step 6.
4. Use the request's `page` if present; otherwise fetch the page on the server (`fetchPage`, `_shared/fetch-page.ts`, with the fetching rules below), which returns the final URL, title, JSON-LD blocks, the image (`<meta property="og:image">`, else `name="twitter:image"`, resolved against the final URL and cleaned with `cleanImageUrl`) and readable text (the page without `script`, `style`, `nav`, `header`, `footer`, `aside` and comments, whitespace collapsed, preferring the article or recipe-card element when there is one).
5. **JSON-LD first**: most recipe sites embed a schema.org `Recipe`. `findRecipe` (`src/shared/recipe-jsonld.ts`, pure) reads its name, ingredient lines, servings and time (`totalTime`, else `prepTime` + `cookTime`, as ISO 8601 durations such as `PT1H20M`, in minutes; anything else, or outside 1 to 2880, is none) from a top-level object, an array or `@graph`, with `@type` as a string or an array, `recipeIngredient` (or legacy `ingredients`), and `recipeYield` as a number, string or array; it decodes HTML entities and strips tags, and one malformed block doesn't spoil the others. **Page text is the fallback** when no block holds a recipe. Either way, one `extract-recipe` LLM call turns it into a name, servings, structured ingredients, tags and a time (4.14). JSON-LD's name, servings and time win over the model's when the page has them. **Steps**: with a JSON-LD recipe they are JSON-LD's `recipeInstructions` (read by `findRecipe`); the model gets none and returns `[]`. Without one, the model reads them from the page text. **Photo**: never read by the model; JSON-LD's `image`, else the page's og:image. Both are cached with the extraction.
6. Send the ingredient names to the shared `categorize()` (6.1, 6.4) in the same request: known names come from the database, unknown ones make at most one more LLM call, under categorize's own boundaries and limits. So the client gets categories back and nothing shows "Sorting…".
7. Respond with `RecipeImportResponse`: `{ name, sourceUrl (canonical), servings, ingredients: [{ ingredientName (normalized key), displayName, quantity, unit, note, categoryId | null, status }], tags, totalMinutes | null, steps: string[], imageUrl | null }`. The app saves `tags` and `totalMinutes` only on a recipe the import creates, never on a reused one (4.14); a response without them (an older server) leaves the recipe untagged. Likewise a response without `steps` or `imageUrl` reads as `[]` and null.

Errors: `invalid_url` (400; also a URL that resolves or redirects to a private address), `not_entitled` (403: the caller's plan has no `recipe_import`), `fetch_failed` (502: the page couldn't be fetched, timed out, was too big or isn't HTML), `not_a_recipe` (422), `rate_limited` (429), `unavailable` (503 with `Retry-After`: the global cap, the `off` kill switch, or a provider error, timeout or invalid output). If categorize's own limits refuse the names, the import still succeeds with them `pending`.

**LLM boundaries** for `extract-recipe`. Same principles as categorize (6.4).
- **Input.** Page content is untrusted data, never instructions. It goes in the user prompt after a line saying so. The instructions hold only the rules, the unit list and the output contract. Caps: at most 80 ingredient lines of 300 characters each; page text at most 30,000 characters after stripping. Anything longer is truncated, never rejected.
- **Prompt.** Versioned (`_shared/ai/prompts/extract-recipe.v3.ts`, exporting `EXTRACT_RECIPE_PROMPT_VERSION`; v2 added tags and time, v3 the method steps, and the version is in the cache key, so older results without them aren't served; v2's file stays, with its byte-for-byte test). v3 asks for `steps`: `[]` when given ingredient lines; from page text, each step in order in the page's own words (not rewritten, shortened, summarized or merged), without step numbers, and without anything that isn't a step (tips, notes, substitutions, storage, nutrition, serving suggestions). It lists every facet's slugs and labels (4.14) and asks for only values that clearly apply (an empty facet is better than a guess: a wrong tag hides a recipe), a diet only when every ingredient fits it, Meal as the dish is usually eaten, Method only when the recipe needs that equipment, and `total_minutes` from the page or null. It also asks for `is_recipe: false` for anything that isn't a single recipe; one entry per ingredient line, dropping sub-recipe headings ("For the sauce:"); the shopping name, not the prep, in `name` ("2 cloves garlic, minced" → `garlic`, 2 `clove`, note `minced`); "1 (15 oz) can chickpeas" → 1 `can`, note `15 oz`; the higher number of a range; no quantity for "to taste" and "for serving", which go in `note`; only supported units, otherwise `null`.
- **Output.** A Zod schema (`ExtractedRecipe`): `{ is_recipe: boolean, name: string ≤ 120, servings: number | null, ingredients: [{ name ≤ 64, quantity: number | null, unit: <supported unit enum> | null, note ≤ 120 }] ≤ 80, tags: { meal, cuisine, protein, diet, method }, total_minutes: 1..2880 | null, steps: string[] ≤ 100, each 1..2000, image_url: https ≤ 2048 | null }`. The model's steps go through `cleanRecipeSteps` (as JSON-LD's do: no HTML, leading numbering, blanks or repeats of the step before; capped), and a not-a-recipe answer keeps none. Each facet is an array of that facet's slugs, cut to its maximum; a facet with a slug the list doesn't have (or that isn't an array) becomes `[]` and the import still succeeds. A time that isn't a whole number from 1 to 2880 once rounded is null. Names are normalized with the shared normalizer, and any that are empty afterwards (or over 64 characters) are dropped. A unit the app doesn't support (4.2) comes back as `null`, with the original wording kept in `note`. Nothing else from the model is stored or shown.
- **Call limits.** `temperature: 0`, no tools, `maxRetries: 1`, a timeout sized to the measured model, `maxOutputTokens` scaled to the line count. Model `AI_MODEL_RECIPE` [Default: `google:gemini-3.8-flash`, with categorize's thinking setting unless extraction quality needs more], optional `AI_MODEL_RECIPE_FALLBACK`.
- **Cost.** Per user: 10 imports a minute and 50 a day (429 beyond either), counted in Postgres as categorize's limits are. Globally: `RECIPE_IMPORT_DAILY_CAP` (default 2,000) imports a day. `AI_MODEL_RECIPE=off` is a kill switch (503). `mock` never touches the network; it runs the shared quantity parser over the lines, returns empty tags, no time and no steps (so an import gets the JSON-LD time and steps or none).
- **Fetching.** `http`/`https` only. DNS is resolved and private, loopback, link-local and metadata addresses (IPv4 and IPv6) are refused, re-checked on every redirect (at most 5). A 10 s timeout and `text/html` only. The body is cut at 1 MB, not refused: reading stops there (whatever `Content-Length` says) and what arrived is parsed, since on a big recipe page it's the comments after the recipe that run long. A character cut in half at the end is dropped, and only JSON-LD blocks that close before the cut are kept. The readable text also leaves out comment sections (`#comments`, `#respond`, `.comments`, `.comment-list`, `.commentlist`, `.wprm-comments`).
- **Privacy.** `ai_calls` stores the prompt and output but no user id (6.5). `recipe_imports` stores the URL, the extraction and timestamps, with no user id.

**Cache.** `recipe_imports` (`url_key` text, `prompt_version`, `result jsonb`, `is_recipe`, `created_at`; primary key (`url_key`, `prompt_version`); RLS on with no policies, so service role only). Successful server-fetched extractions are cached by canonical URL and prompt version for 30 days, so a popular recipe costs one call; a `not_a_recipe` answer is cached too, so a repeat costs nothing. Results built from client-supplied page content (a Safari share or a device capture) are never cached, so one user can't poison the cache for others, and provider errors and timeouts are never cached. A daily pg_cron job deletes rows older than 30 days.

**Tools.** `yarn ai:recipe <url | --file page.html>` runs the handler against an in-memory store and prints the name, servings and an ingredient table. `yarn ai:eval:recipe` runs about 20 saved pages (JSON-LD and text-only from different sites, non-recipe pages, and pages with injection text in an ingredient line) and prints per-page precision and recall on ingredient keys, unit and quantity accuracy, per-facet tag precision and recall against each page's expected tags (precision matters most: a wrong tag hides a recipe), and every miss. Both use the real model and are run by hand only; `deno test` runs the eval harness with the mock.

### 6.7 Tag suggestion
The `suggest-recipe-tags` Edge Function suggests tags for a recipe that's already saved (4.14). It takes a JWT-authenticated `POST` of `SuggestRecipeTagsRequest` (`src/shared/schemas/suggest-recipe-tags.ts`, shared with the app): `{ name, notes: string | null, ingredients: [{ name, quantity: number | null, unit: <supported unit> | null, note }] }`, the recipe as the device has it (ingredient display names; deleted ingredients left out).

**Flow**
1. Validate the request (`400 invalid_request`: not JSON, no name or a blank one, ingredients not a list, a quantity that isn't a number, an unsupported unit; a body over 256 KB is `413`).
2. Check that the caller's plan has `recipe_tags` (4.12; `403 not_entitled`, before any limit or model work).
3. `AI_MODEL_TAGS=off` (or, while it's unset, `AI_MODEL_RECIPE=off`) answers `503 unavailable`, before the limits, so it uses no budget.
4. Check the per-user limits and the global cap (below).
5. One `suggest-recipe-tags` LLM call. Respond `200 { tags, promptVersion }`, `tags` being the five facets (all empty when nothing clearly fit). Nothing is cached: the input is client-supplied and the call is cheap.

Errors: `invalid_request` (400), `not_entitled` (403), `rate_limited` (429), `unavailable` (503 with `Retry-After`: an hour for the global cap or the kill switch, 30 s for a provider error, timeout or invalid output). Neither model set is a `500 not_configured`.

**LLM boundaries** for `suggest-recipe-tags`. Same principles as categorize (6.4) and extraction (6.6).
- **Input.** The recipe is untrusted user text, never instructions. Text is trimmed and cut, never refused: the name to 120 characters, notes to 4,000, each ingredient's name to 64 and note to 120, and the list to its first 80 ingredients (ones with an empty name dropped). A name is required.
- **Prompt.** Versioned (`_shared/ai/prompts/suggest-recipe-tags.v1.ts`, exporting `SUGGEST_RECIPE_TAGS_PROMPT_VERSION`). The instructions hold the tagging rules and every facet's values, shared with extract-recipe in `_shared/ai/prompts/recipe-tag-rules.ts` so both tag the same way (only values that clearly apply, since a wrong tag hides a recipe; a diet only when every ingredient fits it; Meal as the dish is usually eaten; Method only when the recipe needs that equipment). Moving the rules there left extract-recipe v2's rendered prompt byte for byte the same (a Deno test pins it), so its cache stayed valid; a change to the shared rules needs a new version of both prompts. The recipe goes in the user prompt only, as JSON (name, notes, one `2 lb chicken thighs, skinless` line per ingredient), after a line saying it's untrusted data.
- **Output.** Each facet an array of strings, then the same validation as an import's tags (`ExtractedRecipeTagsSchema`): a facet with a slug the list doesn't have becomes `[]` and the call still succeeds; one over its maximum is cut; repeats are dropped. Output that doesn't fit the shape at all is `unavailable`. Nothing else from the model is returned or stored but `ai_calls`.
- **Call limits.** `temperature: 0`, no tools, `maxRetries: 1`, a 15 s timeout, `maxOutputTokens` 400. Model `AI_MODEL_TAGS`, defaulting to `AI_MODEL_RECIPE`'s model when unset (and then also to `AI_MODEL_RECIPE_FALLBACK`); optional `AI_MODEL_TAGS_FALLBACK`. Thinking: the recipe setting, `AI_THINKING_TAGS` overrides it.
- **Cost.** Per user: 20 suggestions a minute and 100 a day (429 beyond either), counted in Postgres by `check_recipe_tags_limit` like the import limits; a refused request uses no budget. Globally: `RECIPE_TAGS_DAILY_CAP` (default 2,000) a day. `mock` never touches the network: it tags from keywords in the name and ingredient lines ("chicken" → protein chicken, "tofu" → tofu-tempeh, "cake" → meal dessert) and never a diet.
- **Privacy.** `ai_calls` stores the prompt and output but no user id (6.5). No recipe row is read or written.

**Tools.** `yarn ai:tags "<name>" --ingredient "2 chicken thighs" …` (`--notes`, `--model`, `--raw`, `--quiet`, `--dry-run`, `--json`) runs the handler against an in-memory store and prints the suggested tags. It uses the real model unless `--model mock`, and is run by hand only.

---

## 7. Sync

This is the hardest part of the project. Stash only syncs append-only captures plus a server-owned read cache; this app needs two-way offline editing by several people. Build it on stash's outbox and drain code, extended as below.

### 7.0 Spike first
**[SPIKE]** Before building M5, spend a day on an off-the-shelf sync engine for Supabase + SQLite (e.g. PowerSync) against acceptance criteria 8 and 13. If it handles field-level conflicts, RLS, and Expo cleanly, use it and skip 7.2-7.3's custom engine. Record the decision in `docs/spikes.md`. The rest of this section is the custom design [Default].

### 7.1 Local-first
- The UI reads and writes only local SQLite (expo-sqlite + Drizzle, as stash). Live queries drive the UI.
- Every mutation is a **field-level patch**: `{ table, id, fields: { name: value, ... }, hlc }`, appended to the local **outbox** in the same transaction as the local write.
- `hlc` is a hybrid logical clock timestamp (wall clock + counter + device id), so ordering reflects when the edit was made, not when it reached the server. The client keeps its clock monotonic and adopts any larger HLC it sees from the server.
  - Wire format: `'<wall clock ms, 13 digits>-<counter, 4 hex digits>-<device id>'` (device id: letters, digits, `_` or `-`, up to 64), e.g. `1760000000000-0000-3f9a…`. Fixed widths make plain text comparison order it by time, then counter, then device.
- The usage tables and `household_category_overrides` have composite keys, so their mutations name the row with `key` (`{ household_id, ingredient_name[, unit_key] }`) instead of `id`; the usage tables and send `use_count` changes as `counters: { use_count: <delta> }`, which add up across devices instead of last-writer-wins. `ingredient_unit_usage.last_used_at` merges as the later of both sides.
- `fields` may not include the row key, `updated_at`, `field_clock` or `merged_into` (server-owned). `household_id` and `created_at` take effect on insert only; a row can't move to another household.
- `recipes.added_by` is the server's: `apply_mutations` sets it to the caller on insert (with no field clock) and ignores a client value on insert and update, so the app never sends it. `tags`, `tags_edited` and `total_minutes` are last-writer-wins like the other recipe fields, the whole `tags` value as one field (4.14). `jsonb` values such as `tags` go over the wire as JSON, and pull compares them by content, not key order, since Postgres reorders `jsonb` keys.
- **Client side** (`src/sync/`): `hlc.ts` is the pure clock; `clock.ts` keeps the device id and last HLC in device settings, written in the same transaction as each write, so the clock stays monotonic across launches. Every write to household data (households, lists, items, contributions, recipes, recipe ingredients, usage, custom categories, category overrides) and to the per-user tables (category order, settings) goes through `mutate.ts` (`insertRow`, `updateRows`, `upsertRow`, `deleteRows`), which writes the row, its local `field_clock` (each field's HLC from its last write) and one outbox mutation per row in one transaction. An insert sends every column but the key, counters, server-owned ones and ones the server doesn't take from clients (a custom category's `slug` and `default_rank`, an override's `created_at`); an update sends exactly the fields it set. The local `outbox` table keeps each mutation in wire shape plus its `household_id` (null for per-user rows), so a lost membership can drop its mutations (7.2).
  - Custom categories (`categories` with a `household_id`: insert with `household_id` and `name`, then renames) and `household_category_overrides` (`category_id` only; Reset to default sends `category_id: null` rather than deleting) are household data and go through `apply_mutations` with field-level LWW, like lists.
  - Per-user tables aren't in `apply_mutations`; their mutations use the same shape (`key: { user_id, ... }`), and the order table, which hard-deletes, sends `delete: true` instead of a `deleted_at` field. `households` isn't in `apply_mutations` either (it changes through the household functions, 4.7). Push (`src/sync/push.ts`) sends these one at a time in their place in the queue: per-user rows as direct writes (upsert by key, or delete; RLS keeps them to the user's own rows, so last push wins rather than HLC), and a new household through `create_household`. Other household changes aren't synced yet and are recorded as rejected.
  - Moving to household aisles (local migration `0011_household_aisles`) kept no aisle data: per-user overrides, custom aisles, the order rows that pointed at them, and their queued outbox mutations (the new server would reject them forever) were dropped on the device, as on the server.
  - A usage row whose `use_count` reaches 0 is deleted locally only; the decrement goes out as a counter delta, so the server keeps the row at 0, and a row at 0 or below reads as absent.
  - Not synced up: the catalog (`ingredients`, system categories) and device settings. The recipes list's "recently changed" sort bumps the local `updated_at` only.

### 7.2 Push and pull
- **Push**: the outbox worker sends batches to the `apply_mutations` Postgres function in order, retrying with stash's backoff schedule. Mutations are idempotent (keyed by row id + field + hlc; counters by row + hlc). Each mutation is applied on its own and gets one result, in order: `applied`, `unchanged` (nothing newer, e.g. a re-send), `merged` (with `merged_into`, 7.3), or `rejected` with a SQLSTATE `code` and `message` (`42501` not a member, `22023` malformed, or a constraint error). A rejected mutation never blocks the rest of the batch. Clients have no direct insert/update/delete on household tables.
- **Pull**: Supabase Realtime on the tables of every household the user belongs to, the user's own preference tables, the user's `household_members` rows, and `ingredients` (for categorization results) while in the foreground. On launch, foreground, or reconnect, pull every row with `updated_at > cursor` (soft-deleted rows included).
- **Cursors are per household**, not global. A household the user just joined has rows older than any existing cursor, so joining starts that household's cursor at zero (a full pull for that household only).
  - **Client side** (`src/sync/pull.ts`): the households pulled are the user's `household_members` rows on the server. Within a household each table keeps its own cursor (the server `updated_at` text of the newest row applied); a household's custom categories and overrides are household tables (categories first, then overrides, before its lists), filtered by `household_id`. The user's preference tables (category order, settings) and the catalog (system categories, `household_id is null`, then `ingredients`) have their own cursors. Tables are read parents first, oldest change first, in pages; rows sharing a page's last `updated_at` are fetched together, and each table's first page reaches 5 s behind its cursor in case an earlier transaction committed late (re-applying a row is a no-op). A row SQLite refuses (its parent arrived after its table was read) stops that table with the cursor before it, so the next pull retries it.
  - Rows apply with the 7.3 rule against the local `field_clock`: a remote field wins unless the local clock for it is newer (a local edit the server hasn't seen). Fields the server keeps no clock for (per-user tables, `households`) win unless an unpushed outbox mutation sets them, and a row with an unpushed local delete isn't brought back. `use_count` is the server's total plus this device's unpushed deltas (0 or less removes the local row), and `ingredient_unit_usage.last_used_at` is the later of both sides. Local `updated_at` becomes the later of local and server. Pull writes never go to the outbox. Every pulled HLC is observed, so later local writes beat it.
  - A remote open item that clashes with a different local open item for the same ingredient on the same list Combines silently (4.4): the local item is soft-deleted and its contributions move to the remote one, as `apply_mutations` will do when the local one is pushed.
  - Catalog rows only update ingredients the device already has (7.4), and a non-final server status never replaces a categorized one. Pulled names the device doesn't know are added as pending, for categorization (6.3).
  - Not covered by pull: per-user rows deleted on another device (the server hard-deletes them, so there's nothing to pull; Realtime delete events cover them, below), and a `user_settings.default_list_id` pointing at a list this device doesn't have, which keeps the local value.
  - **Realtime** (`src/sync/realtime.ts`, migration `realtime.sql` adds the tables to the `supabase_realtime` publication): while signed in, in the foreground and online, the app keeps one channel per household (every household table filtered to it), one for the user's own rows (`household_members`, category order, settings, filtered to the user) and one for `ingredients`. A household's custom categories and overrides are on its channel, filtered by `household_id`, so one member's aisle change reaches the others. An event doesn't write to SQLite: it schedules a cursor pull of just what it touched (that household, the user's tables, or the catalog), so remote changes take the pull path above, and the screens' live queries show them like local writes (a remote check moves the row to Checked with the same animation). Events within 300 ms share one pull. Every channel also pulls its scope once it's subscribed, which covers changes made while it was joining or rejoining. A `household_members` event for the user does a full pull, which reads memberships again; channels are opened and closed to match. Deletes can't be filtered, so delete events for other users' rows arrive and are ignored. The user's own deleted order rows are applied from the event's key (the default replica identity sends the primary key), unless this device has an unpushed change to that row. Background or offline closes every channel; foreground reopens them and a reconnect opens new ones.
- **Membership changes** drive the rest: a new membership subscribes and pulls that household; a lost membership (left, removed, household deleted) unsubscribes, deletes that household's rows from SQLite, and drops its pending outbox mutations (4.7). The server rejects mutations for households the user no longer belongs to; the client treats that rejection as "drop", not "retry".
  - **Client side** (`src/sync/purge.ts`, called by the full pull): the pull keeps the household list the server last gave it. After pulling the households still listed, any household in the previous list and not in this one is purged in one transaction: its rows in every household table (its overrides and custom aisles included, with the user's order rows for those aisles and their queued order mutations), all its outbox mutations (rejected ones too), its pull cursors (so joining again pulls it in full), the per-list view-mode and last-opened-list device settings that point into it, and a Siri default list in it (set to null locally, as the server's `on delete set null` does). Pull writes, so nothing goes to the outbox. A household the server has never listed (e.g. one created on this device and not pushed yet) is never purged, and an empty list (everyone has at least one household) is treated as a bad answer: nothing is purged. Realtime closes that household's channel when the pull reports the new list, and a new membership opens one and is pulled in full (above).

### 7.3 Conflicts
- **Field-level last-write-wins by HLC**: `apply_mutations` writes a field only if the incoming HLC is newer than `field_clock[field]`, then updates `field_clock`. So A checking an item while B edits its note keeps both changes.
- **Delete wins** over concurrent edits to the same row (a `deleted_at` set at any HLC is not undone by a field edit; an explicit undo is a new mutation that clears it).
- **Same ingredient added twice offline**: the unique index rejects the second open item. `apply_mutations` handles this inside the function: it re-points the incoming item's contributions to the existing open item and marks the incoming item as merged (an automatic Combine): soft-deleted, with `list_items.merged_into` set to the open item. Contributions that arrive later for a merged item follow `merged_into`, and an edit that would reopen a merged item merges it again. The client sees the merge on its next pull and drops its local row. This never fails the batch.
- Contributions are append-only in practice (each add creates a new row), so they rarely conflict.

### 7.4 Ingredient catalog on device
The device caches the seed set plus every ingredient it has seen, and fetches unknown names on demand. Category updates arrive via Realtime or pull.

### 7.5 Sync status
Settings > "Sync status" (as stash): pending outbox count, last successful sync, last error, and a "Sync now" button.
- **Client side**: `src/sync/status.ts` `syncStatus(inputs)` is the one rule, from the outbox counts (pending and rejected), the push and pull states (`lastSuccessAt`, `lastError`) and what's running (`src/sync/activity.ts`, reported by push and pull, with the OS's connectivity). In order: signed out → "Not syncing"; offline → "Offline"; a push or pull running → "Syncing…"; a standing push or pull error → "Sync error" (push's error shown first, as "Sending: …"; pull's as "Receiving: …"); pending mutations → "Syncing…"; nothing ever got through → "Not synced yet"; else "Synced". Last successful sync is the later of the last push and pull that got through. Rejected mutations are counted on the screen ("Not accepted") but don't block "Synced", since they never go. The account card's badge and the Settings row show the same label. Sync now pushes (ignoring the backoff), then does a full pull; it's disabled while offline or while either is running.

---

## 8. Architecture

### 8.1 Stack [Default]
| Layer | Choice | Why |
|---|---|---|
| App | Expo (same SDK as stash, 57) + Expo Router, TypeScript | Web-developer friendly; same stack as stash |
| Local store | expo-sqlite + Drizzle | Offline-first; same as stash |
| Native | Swift App Intents extension via `@bacons/apple-targets` | Only for Siri; proven in stash |
| Backend | Supabase (Postgres, Auth, Realtime, Edge Functions, pg_cron) | Global catalog, sharing, and the LLM proxy need a server |
| Auth | Google via Supabase Auth; dev email-code stub until OAuth IDs exist | Same as stash |
| LLM | Vercel AI SDK in an Edge Function, Anthropic Haiku by default | Key stays server-side; provider is config |
| Shared code | Zod schemas, normalizer, quantity parser in `src/shared/`, imported by app and Edge Functions | One implementation of the ingredient key |

### 8.2 App structure
Follows stash's layout (Expo Router routes in `src/app/`, app logic in sibling folders).

```
src/
  app/              routes: (tabs)/lists, (tabs)/recipes, (tabs)/settings, list/[id], recipe/[id],
                    join/[token], sign-in, settings/households, settings/households/[id], settings/sync-status
  features/
    lists/          ListScreen (the List tab), YourListsSheet, AddItemBar, ItemRow, ItemEditSheet,
                    DuplicatePromptSheet, BulkDuplicateSheet, ViewModePicker
    recipes/        RecipesList, RecipeDetail, AddRecipeToListSheet, MakeRecipeFromSelectionSheet,
                    import (importRecipe, the share-queue drain, failed imports; 4.10)
    categories/     CategoryPicker, ReorderSections
    households/     HouseholdsScreen, HouseholdDetail, InviteSheet, JoinHousehold, CopyRecipeSheet
    siri/           app-group-queue (drain), list-snapshot (writes lists.json)
    notifications/  in-app banners (4.11): the queue, NotificationHost, per-kind content builders live
                    with their feature (e.g. recipes/import-notifications)
    auth/
  domain/           pure TS, no React/IO: duplicate-detector, quantity-math, category-resolver
  shared/           used by app AND Edge Functions: zod schemas, ingredient-normalizer,
                    quantity-parser, siri and share envelope schemas, recipe-import schemas,
                    recipe-jsonld
  db/               Drizzle schema mirroring section 5, migrations, live queries
  sync/             outbox, hlc, drain, push (apply_mutations), pull, realtime
  lib/              supabase client, google sign-in, secure store
targets/
  add-intent/       AddToPerfectBiteIntent.swift, ListEntity, App Group queue writer
  share-recipe/     share extension (4.10): SwiftUI sheet, Preprocess.js, share queue writer
supabase/
  migrations/       schema, RLS, triggers, apply_mutations, household functions, seed categories,
                    seed ingredients, categorize, recipe-import and recipe-tags rate limits, ai_calls,
                    recipe_imports
  functions/        categorize-ingredients/, siri-add/, import-recipe/, suggest-recipe-tags/, delete-account/,
                    _shared/ (incl. fetch-page)
  tests/            RLS and apply_mutations tests
```

Business logic in `domain/` and `shared/` must be pure TypeScript with no React, network, or SQLite dependencies, so it is unit-testable and runs in Deno.

### 8.3 Local development
Identical to stash. Copy its README sections, `mise.toml`, `.yarnrc.yml`, `.env.example`, `supabase/functions/.env.example`, `supabase/config.toml` (new `project_id`, ports moved to 553xx so stash and this project can run side by side), and `AGENTS.md`, then adapt.

**Prerequisites**: Node, Yarn 4 (pinned in `mise.toml` and `packageManager`), Docker, the Supabase CLI, Xcode with CocoaPods.

**One-time setup**
```bash
yarn install
supabase start            # local Postgres, Auth, Realtime, Studio (http://127.0.0.1:55323)
supabase db reset         # apply migrations + seed.sql
cp .env.example .env.local                                   # publishable key from `supabase status`
cp supabase/functions/.env.example supabase/functions/.env   # ANTHROPIC_API_KEY etc.
```

**Each session** (separate terminals)
```bash
supabase start                                               # no-op if running
supabase functions serve --env-file supabase/functions/.env  # Edge Functions, hot reload
yarn expo start                                              # Metro
```
As in stash, don't rely on the edge runtime that `supabase start` launches; use `functions serve`. A `503` from `http://127.0.0.1:55321/functions/v1/<name>` means it isn't running.

**Dev sign-in**: email + 6-digit code; local Supabase delivers the code to the local mail viewer (`http://127.0.0.1:55324`). No Google setup needed until M9.

**Development build**: Siri (the intent extension) needs a development build, not Expo Go: `yarn expo run:ios` (simulator) or `yarn expo run:ios --device`. On a physical device, set `EXPO_PUBLIC_SUPABASE_URL` to the Mac's LAN IP. Device signing steps: copy stash's checklist from its `docs/spikes.md` (including the one-time `xcodebuild ... -allowProvisioningUpdates` build).

**Database changes**: `supabase migration new <name>`, write SQL, `supabase db reset`. Tests in `supabase/tests/` (pgTAP) run with `supabase test db`.

**Local categorization**: `categorize-ingredients` runs locally against Gemini 3.8 Flash (`google:gemini-3.8-flash`) using `GOOGLE_GENERATIVE_AI_API_KEY` in `supabase/functions/.env`. Set `AI_MODEL_CATEGORIZE=mock` to use a deterministic fake (keyword rules) with no key and no cost; tests always use the mock.

**Seed data** (`supabase/seed.sql`), so sharing can be tested on day one:
- System categories and the ~7,000 seed ingredients, with their default units.
- Dev users `alex@example.com` and `sam@example.com` (sign in with the dev code flow).
- Each has a personal household; both are members of a shared "Test home" household (Alex owner) with a "Groceries" list, a "Costco" list, and a "Tacos" recipe. Alex's personal household has one list, so the multi-household UI shows up immediately.
- Run the simulator signed in as one user and a device (or a second simulator) as the other.

**Checks** (before declaring any task done, as in stash's `AGENTS.md`): `yarn expo lint`, `yarn tsc --noEmit`, `yarn jest`, `supabase test db`, `yarn dlx expo-doctor`.

### 8.4 Reuse from stash (copy, don't share)
The two apps are independent; there are no shared packages. Copy what's useful from `../stash` into this repo and adapt it freely:
- `src/sync/` outbox, drain, backoff, upload (extend with HLC and field patches).
- `targets/save-intent/` and `src/features/capture/app-group-queue.ts` (Siri intent and queue drain).
- `src/features/auth/` dev sign-in stub and account deletion.
- Edge Function `_shared/` (AI SDK provider registry, auth helpers), Supabase test setup, `AGENTS.md`, lint/tsconfig/jest config.
- `DESIGN.md` structure (tokens), with this app's own visual design.

---

## 9. Testing and acceptance criteria

Unit tests (Jest) required for: ingredient normalizer, quantity parser (including number words), quantity math and display rule, duplicate detector, category resolver, the categorize-on-add client (one request per add; catch-up on launch, foreground and reconnect), HLC. Edge Function tests with a mocked LLM. SQL tests for RLS (one household can't read another's data; one household can't read another's overrides or custom aisles) and for `apply_mutations` (field-level LWW, delete wins, offline duplicate merge). A Swift/Zod contract test for the Siri envelope.

Acceptance criteria:
1. **Add**: typing `2 lbs chicken thighs` and return creates one item with quantity 2, unit lb, under Meat & Seafood (seed data), with the keyboard still up.
2. **Recipe from recipe**: creating "Tacos" with 5 ingredients and adding it to a list with one ingredient unchecked adds 4 items, all showing under Tacos in By recipe view.
3. **Recipe from selection**: selecting 3 list items and Add to recipe → New recipe creates a recipe with those 3 ingredients, and those items now group under it.
4. **Auto-categorize**: adding an ingredient that exists in the catalog categorizes instantly offline.
5. **First-seen LLM**: adding a never-seen ingredient shows "Sorting..." then moves to a section; the `ingredients` row exists with `categorized_by` set; a second user adding it later triggers no LLM call (verify via function logs).
6. **Batching**: adding a 12-ingredient recipe with 8 unknown ingredients makes exactly one function request and one LLM call.
7. **Override**: user A moves "tahini" to Pantry; user B in the same household sees it in Pantry on every list and device; a user in another household still sees the default.
8. **Shared household**: A invites B's email to "Test home" and sends nothing; when B opens the app (signed in with that email) the list switcher shows an invite dot and the Your lists sheet has A's invite, A's household screen lists B's email under Invited, and after B taps Join the invite goes, A's Invited section is empty on its next load, and B sees its lists in a new section of the sheet next to B's personal household; an item checked by A appears checked on B's device within a few seconds while both are online.
9. **Duplicates**: adding `milk` to a list that has `1 gal milk` shows no prompt, yields one row whose total counts the new add as one, and shows the toast with the keyboard still up; with no unit history for milk the toast reads "Added to milk (now 1 gal + 1)", and when milk is usually bought by the gallon it reads "Added to milk (now 2 gal)", with a single Undo, which restores the original row. Adding a recipe with 3 ingredients already open on the list asks nothing: all 3 Combine, one toast "Added Tacos · N items" appears, and its Undo restores the list exactly.
10. **Category order**: user A drags Dairy above Produce; A's lists show Dairy first on all of A's devices; B's order is unchanged.
11. **Multiple lists**: create, rename, reorder and delete lists from the Your lists sheet; picking one switches the List tab to it, deleting the current list moves the tab to the next; items are independent per list.
12. **View modes**: switching to By recipe shows recipe sections plus Other items; an item from two recipes appears under both, and checking it in one checks it in both.
13. **Offline**: in airplane mode, add/check/delete items and reorder categories; on reconnect everything syncs with no duplicates.
14. **Concurrent offline edits**: A (offline) checks "eggs" while B (online) edits its note; after A reconnects, the item is checked and has B's note.
15. **Offline duplicate merge**: A and B both add `milk` to the same list while offline; after both reconnect, there is one row with both contributions.
16. **Siri**: with the phone locked, "Hey Siri, add to The Perfect Bite" then "two avocados" replies within ~3 s; the item appears on B's device in the default list under Produce without A opening the app (when A is online).
17. **Siri, named list and offline**: "add to Costco in The Perfect Bite" adds to Costco; in airplane mode the add is kept and appears after reconnect and app launch, exactly once.
18. **Multiple households**: a user in two households sees both sections on Lists and Recipes; a user in one household sees no household UI.
19. **Household owns data**: B leaves "Test home"; within one sync, its lists disappear from B's devices and B's queued edits for it are dropped; A still has all of it. B's personal household is untouched.
20. **Last member**: the last member leaving a household deletes it (after confirm); a user leaving their only household gets a new empty personal household.
21. **Copy recipe**: copying "Tacos" to another household creates an independent recipe there; editing one doesn't change the other.
22. **Isolation**: SQL tests prove a user can't read or write any row of a household they aren't in, including right after leaving or removal, and can't perform owner-only actions as a member.

---

## 10. Build order (milestones for Claude Code)

Each milestone should end with a working app and passing tests.

1. **M0 Skeleton + spikes**: Expo app (default template, stash's config copied per 8.4), tabs for Lists / Recipes / Settings, SQLite + Drizzle, Supabase project with migrations folder, CI running lint, typecheck, and tests. Dev sign-in stub. Spikes: Siri phrase recognition for "The Perfect Bite" (4.9), token refresh from the intent extension (4.9), sync engine evaluation (7.0). Record results in `docs/spikes.md`.
2. **M1 Local lists**: lists and items fully local. Add bar with quantity parser and normalizer, check off, delete with undo, multiple lists.
3. **M2 Categories local**: seed categories and seed ingredients bundled in the app, By category view, per-user overrides and category order stored locally.
4. **M3 Duplicates**: duplicate detector, quantity math, contributions model, single and bulk prompts.
5. **M4 Recipes**: recipe CRUD, add recipe to list, make recipe from selection, By recipe view.
6. **M5 Backend and sync**: Supabase schema + RLS + triggers, `apply_mutations`, outbox with HLC, push/pull, Realtime, sync status screen. (Or the chosen sync engine, per 7.0.)
   - *Landed early* for the read-only Households screen: `households`, `household_members` (with RLS, `private.my_household_ids()` and household-mates' profiles readable), `create_household` and `get_household_members`. The household is created locally through the outbox (`ensureStarterData`), and the push sends it with `create_household` like other household data (7.1); the launch-time `registerHouseholds` that did this before sync is gone.
   - *Also landed early*, so the data can be browsed in Studio: the rest of the section 5 schema (catalog with seed, per-user preferences, household data, `user_settings`), with RLS and the unknown-ingredient trigger (`household_invites` came later, with invites; see M7). M5 moved household writes behind `apply_mutations`, and sync replaced the dev-only "Push local data to Supabase" snapshot, which is gone.
7. **M6 Categorization**: `categorize-ingredients` Edge Function with the AI SDK, categorize-on-add client with catch-up, "Sorting..." state, retries, golden-set eval.
   - *Landed*: the function (6.1, 6.4) with its LLM boundaries, rate limits, global daily cap and `off` kill switch; `ai_calls`; Gemini 3.8 Flash with thinking `low` (`docs/spikes.md` §4); the categorize-on-add client and catch-up (6.3); "Sorting..."; failed names retried up to 3 attempts; default units (prompt categorize.v2); the ~7,000-name seed, checked with `yarn ai:check-seed`; the golden-set eval, 99/100 on categorize.v2.
8. **M7 Households**: multiple memberships, household sections in Lists/Recipes, Households settings, invites via Universal Links, join/leave/remove/roles/delete, per-household sync cursors and local purge on lost access, copy recipe. (The schema and RLS for multiple households land in M5; M7 is the UI and flows.)
   - *Landed early*: a read-only Households settings screen (Settings > Households lists local households; tapping one shows its name and members with Owner/Member and "You", fetched online via `get_household_members`). It uses `households`, `household_members`, `create_household` and `get_household_members`, pulled forward from M5/M7 (see M5). Rename, leave, remove and roles are still M7. *Also landed early (with M5)*: invites: `household_invites` with `create_invite` / `preview_invite` / `accept_invite`, an "Invite someone" button on the household screen and the join screen (`src/app/invite/[token].tsx`), using the app scheme until Universal Links have a domain. *Email invites* (designs S1–S4, R2b): invites can name an email; the two-step invite sheet, the Invited section on the household screen and invite cards on the Lists home, since moved to the Your lists sheet by M11 (`my_invites`, `accept_invite_by_id`, `decline_invite`).
9. **M8 Siri**: intent extension, `ListEntity` from the list snapshot, App Group queue + drain, `siri-add` Edge Function (categorizes unknown names inline by calling the shared `categorize()`), default list setting, onboarding tip ("Try: Hey Siri, add to The Perfect Bite").
10. **M9 Polish**: empty states, haptics, accessibility (Dynamic Type, VoiceOver labels), account deletion, Google sign-in replacing the stub (done; the stub stays in dev builds), TestFlight.
11. **M10 Recipe import** (4.10, 6.6), after M6's categorizer works, since extraction is a bigger LLM call. **Done**: everything below has landed; the end-to-end device pass and the extension's first build are manual checks still to run.
    - *Spec*: this section, 4.10 and 6.6.
    - *Server*: shared schemas and `canonicalRecipeUrl`; the JSON-LD recipe reader with real-site fixtures; safe page fetch and readable text; the `extract-recipe` AI task and prompt, with a recipe mock; the `import-recipe` Edge Function with rate limits, global cap and the `recipe_imports` cache; `yarn ai:recipe` and the recipe eval (`yarn ai:eval:recipe`).
    - *App, before the extension*: the client import (`importRecipe`: recipe reuse by URL, bulk add with Combine, undo, typed errors); the "Add recipe from link…" / "Import from link" sheet and toast.
    - *Share extension*: share envelope and `lastOpenedListId` snapshot schemas with the Swift contract test; the `targets/share-recipe/` extension; draining the share queue in the app; failed imports on the Recipes tab.
    - *End-to-end pass on a device*: Safari with and without JSON-LD, Chrome, a URL in text, a paywalled page, a non-recipe page, offline, signed out, and the same recipe twice.
12. **M11 List tab** (4.1, 4.7; mockups E, G, H): the Lists home goes. The List tab shows the current list as its root, the header's name opens the Your lists sheet (switching, invites, create, reorder, archived lists), and opening a list from elsewhere switches the tab to it.

---

## 11. Later

### 11.1 Notifications (req 13)
Not in v1, apart from in-app banners (4.11), whose `kind`s these settings would extend. Sketch, so v1 doesn't block it:
- **Delivery**: Expo Push (`expo-notifications`), which handles APNs. A `push_tokens (user_id, token, platform, updated_at)` table.
- **Pipeline**: a trigger on `list_items` (inserts, and `checked_at` changes) writes to a `household_events` queue (pgmq, as stash uses Queues). A worker Edge Function, run by pg_cron, groups events per household and recipient over a short window and sends one push per group, never to the person who made the change.
- **Candidate notifications**: "Alex added 6 items to Groceries"; "Alex is shopping" (first few checks on a list within a few minutes); later, a location reminder near a saved store (local, on device).
- **Settings**: per-user toggles per notification type, and quiet hours.
- **v1 prep (already in this spec)**: `added_by` on list items and contributions, `checked_by` on list items. Nothing else needed now.

### 11.2 Web app
Turn on react-native-web for planning on a laptop (lists, recipes, households). Siri, the App Group queue, and native Google sign-in stay iOS-only; web uses Supabase's Google OAuth redirect. Offline on web is Later still.

### 11.3 Multi-item Siri adds
"Milk, eggs, and a bag of limes" becomes three items. Splitting on "and" naively breaks items like "mac and cheese", so `siri-add` would ask the LLM to split and parse when the text contains a list separator. Offline, the text stays one item until the server can split it.

### 11.4 Other
- Copy or move a list to another household.
- Per-store category orders (Q5).
- Manual drag ordering within a section.
- Sign in with Apple, if this ever goes to the public App Store (4.8).
- Linked ingredients, stage 2 (4.15): the "already on list" tint, then Combine, across a family; categorizer-proposed links held for review.
- More languages beyond English and Mexican Spanish (4.15).

---

## 12. Open questions

| # | Question | Default used in this spec |
|---|---|---|
| Q1 | ~~(req 7.1) Who controls shared data?~~ | **Decided**: the household owns it. All members edit equally; owners (one or more) manage membership and can delete the household (4.7). |
| Q2 | ~~(req 7.1) When someone leaves, do they keep a copy?~~ | **Decided**: no; data stays with the household. Leaving your only household gives you a new empty personal one. |
| Q3 | ~~(req 7.1) What happens to a joiner's existing data?~~ | **Decided**: nothing; it stays in their own household(s). Joining only adds access. |
| Q4 | ~~Should many users recategorizing the same ingredient eventually change the global default?~~ | **Decided**: no. Overrides stay per household (shared by its members, not by the rest of the app). |
| Q5 | Should category order be per user (all devices) or per device (e.g. different stores)? | Per user, synced. Per-store orders are a natural later feature. |
| Q6 | ~~Can a user belong to more than one household?~~ | **Decided**: yes, any number (4.7). |
| Q7 | Should custom categories be shareable with the household? | No, per user. |
| Q8 | ~~Requirement 3 is missing from the original list.~~ | **Decided**: there was no requirement 3; nothing was dropped. |
| Q9 | Should checked items auto-clear after some time? | No, manual "Clear checked". |
| Q10 | ~~Prompt on in-app duplicate adds, or auto-Combine with an undo toast?~~ | **Decided**: auto-Combine with an undo toast, for single adds and recipe adds alike. A recipe add has no "already on the list" step; one toast with **Undo** takes back the whole add (4.4). |
| Q11 | Is the Siri default list per user or per household? | Per user. |
| Q12 | ~~Final app name.~~ | **Decided**: "The Perfect Bite" as the display name; the M0 spike confirms Siri recognizes it and picks the phrase variants. |
| Q13 | Google Cloud project for OAuth client IDs: reuse stash's or a new one? | Closed: a new project, same setup as stash. |
| Q14 | ~~Copy stash code or share packages?~~ | **Decided**: copy when useful; no shared packages. The apps evolve independently. |
| Q15 | Repo name and bundle id. | `perfect-bite`, `com.jgp.perfectbite`. The display name stays "The Perfect Bite". |
| Q16 | Can any member invite people, or only owners? | Any member. |
