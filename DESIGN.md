# Design: direction B, "Pantry"

Friendly and tactile: soft white cards and tiles sit on a pale green ground, checks are round, and titles are set in a chunky grotesque. Every aisle has its own colour, so you can find your place in a long list at a glance.

The reference boards are in `docs/design/pantry/` (`lists.html` 01–04, `recipes.html` 05–08, where 08's "already on the list" step is retired: recipe adds Combine like single adds, spec 4.4, `settings.html` 09–12). Treat their 390×844 phone frames as the reference. The boards' floating tab bar is a mock: the app keeps the native tab bar (`NativeTabs`) and native headers, tinted `primary`.

## Rules

- Every colour, size, radius and font comes from `useTheme()` (`src/hooks/use-theme.ts`), which reads `src/constants/theme.ts`. No hex values or font sizes in components.
- Keep Dynamic Type on: never set `allowFontScaling={false}` or fix a text container's height.
- Touch targets are at least 44 pt (`sizes.minTapTarget`). Make a smaller glyph's hit area bigger rather than the glyph.
- Text contrast is at least 4.5:1 in both schemes. `src/constants/__tests__/theme.test.ts` checks the pairs below; add a pair there when you put text on a new ground.
- Light and dark follow the system setting. Shadows are light mode only.

## Fonts

Both are embedded at build time by the `expo-font` config plugin in `app.json` (no runtime loading, so no flash). Use them through `typography`, never by name.

| Family | Weights embedded | Use |
| --- | --- | --- |
| Bricolage Grotesque | 500–800 | Display: large titles, screen and sheet titles, card section titles, big tile counts. 800 with tight tracking (−0.025 em) for titles. |
| Figtree | 400–700 | Everything else. |

## Typography (`typography.*`)

Sizes are at the default Dynamic Type setting.

| Token | Face | Size / weight | Use |
| --- | --- | --- | --- |
| `hero` | display | 48 / 800 | "The Perfect Bite" on the sign-in screen. |
| `largeTitle` | display | 40 / 800 | Tab roots: "Your lists", "Recipes", "Settings". |
| `screenTitle` | display | 36 / 800 | Pushed screens: a list's or recipe's name, a household, "Aisle order". |
| `sheetTitle` | display | 30 / 800 | Sheet titles: the item's name in the item sheet. |
| `title` | display | 28 / 800 | Smaller titles, e.g. inside a card. |
| `tileCount` | display | 34 / 800 | The item-to-get count on a list tile. |
| `initial` | display | 20 / 800 | The letter in a round avatar. |
| `sectionTitle` | display | 17 / 700 | Card section headers: aisle or recipe name. |
| `lead` | Figtree | 18 / 400 | The sign-in tagline. |
| `headline` | Figtree | 17 / 700 | Buttons, CTAs, emphasised rows. |
| `body` | Figtree | 17 / 500 | Item names, row labels, inputs. |
| `callout` | Figtree | 16 / 500 | Tile names, secondary buttons. |
| `amount` | Figtree | 15 / 600 | Quantities and values at the end of a row ("2 lb", "Groceries"), "12 to get". |
| `sectionLabel` | Figtree | 13 / 700 | Labels above a card ("Members", "Added", "Aisle") and household names above tiles. |
| `footnote` | Figtree | 13 / 400 | Help text under a control, "Also in Weeknight dal", version. |
| `caption` | Figtree | 12 / 700 | Badges, small all-caps labels ("YOU USUALLY BUY"). |

## Colour (`colors.*`)

| Token | Light | Use |
| --- | --- | --- |
| `background` | `#EEF3EC` | Screen ground, bottom add bar ground. |
| `surface` | `#FFFFFF` | Cards, tiles, inputs, unselected pills, round icon buttons in the nav row. |
| `surfaceMuted` | `#DCE4DA` | Segmented control track. |
| `border` | `#EEF1EC` | 1 pt hairlines between rows inside a card. |
| `controlBorder` | `#B9C4BC` | Unchecked round checks, dashed "new" outlines, the sheet grabber. Not for text. |
| `ink` | `#1D2A22` | Primary text and glyphs. |
| `inkSecondary` | `#55635A` | Amounts, counts, labels, help text. |
| `inkTertiary` | `#7C877F` | Icons and decorative glyphs only (drag grips, chevrons). Too light for text. |
| `primary` | `#2E6B45` | CTAs, the + buttons, checked checks, the Groceries tile, selected tab tint, focus ring. |
| `onPrimary` | `#FFFFFF` | Text and glyphs on `primary`. |
| `primarySoft` / `onPrimarySoft` | `#DDEFE2` / `#1F5233` | Positive badges ("On Groceries", "Synced") and soft icon wells. |
| `danger` / `dangerSoft` | `#A33D53` / `#F7E1E6` | Destructive text, and the soft destructive button / remove buttons. |
| `pending` / `pendingSoft` | `#8A5C0C` / `#FFF7E6` | "Sorting…" items waiting for an aisle: the card tint and the label. Also the row flash after an add merges into an item. |
| `scrim` | `#C9D3C7` | Behind a sheet. |
| `toast` / `onToast` | `#1D2A22` / `#FFFFFF` | Undo toast pill and its text. |
| `header` / `onHeader` / `onHeaderSecondary` | `#1F4D33` / `#FFFFFF` / `#B7D2BF` | The list screen's forest-green header (behind the status bar): title, and the "7 to get · Newest" line. Dark: `#163A26`. |

Dark mode keeps the same hues on a dark green-grey ground (`#111915`, cards `#1B241F`) with lighter accents (`primary` `#7CC395` with dark `onPrimary`). The values are in `theme.ts`; the test checks that both schemes have the same tokens and pass contrast.

Checked text pairs (≥ 4.5:1, both schemes): `ink` and `inkSecondary` on `background`, `surface` and `surfaceMuted`; `ink` on `primarySoft`; `onPrimary` on `primary`; `primary` on `surface` and `background`; `onPrimarySoft` on `primarySoft`; `danger` on `surface`, `background` and `dangerSoft`; `pending` on `pendingSoft`; `ink` on `pendingSoft`; `onToast` on `toast`; `onHeader` and `onHeaderSecondary` on `header`; `ink` and `inkSecondary` on every aisle `soft`; `onPrimary` on every aisle `strong`. `inkTertiary` is checked at 3:1 (non-text).

## Aisle colours (`aisles.*`)

Each hue has a `dot` (section dots, the aisle-order dots, list tile accents), a `soft` tint (icon wells, a just-added row flash in that aisle, household header bands) and a `strong` shade for fills that carry `onPrimary` text (the selected aisle pill). In light mode most dots are under 4.5:1 with white text (blue 4.4, rose 4.4, grey 3.7, amber 2.9), so `strong` is a deeper shade there (green `#2E6B45`, blue `#2F6396`, rose `#A33D53`, amber `#8A5C0C`, grey `#55635A`); in dark mode it equals the dot, with dark `onPrimary` text.

| Hue | Light dot / soft | Aisles |
| --- | --- | --- |
| green | `#2E6B45` / `#DDEFE2` | produce, household, pet |
| blue | `#3E7BB8` / `#DFEAF6` | dairy-eggs, frozen, beverages, personal-care, baby |
| rose | `#C2556B` / `#F7E1E6` | meat-seafood, deli |
| amber | `#C98A1E` / `#F6EBD4` | bakery, pantry, canned-jarred, pasta-grains, baking, spices, condiments, snacks, breakfast |
| grey | `#7C877F` / `#EEF3EC` | other, and any slug the app doesn't know (custom aisles) |

Item rows use `categoryColors(slug, scheme)` (`appearance.ts`), which returns `{ ring, tint, text }`: the `dot` as the check's ring, the `dot` at 10% (light) or 16% (dark) over `surface` as the row's tint, and the `strong` shade for the amount (`inkSecondary` where even that is under 4.5:1, i.e. dark grey). Sorting… and unknown slugs get grey. Use it for any new per-item category UI.

The rule: pick the hue with `aisleColor(slug)` from `src/domain/aisle-color.ts`, then read `aisles[hue].dot` or `.soft`. Never colour an aisle by its position, so an aisle keeps its colour when the store order changes. A dot is decoration: the aisle's name is always shown next to it, so colour is never the only signal.

## Spacing, radius and sizes

- `spacing`: 4 pt base (`xxs` 2 … `xxxl` 48). Cards and tiles sit `lg` (16) in from the screen edge; titles sit 20 in (`lg` + `xs`).
- `rounded`: `card` 22, `tile` 22, `sheet` 28 (top corners), `row` 16 (aisle-order rows), `md` 12 (segmented track, icon wells), `full` for pills, round checks, round buttons and CTAs.
- `sizes.minTapTarget` 44. Rows inside cards are at least 50 pt tall (`sizes.cardRowMin`).
- Component sizes: `check` 24 (`checkBorder` 2), `dot` 10, `pill` 40, `segment` 34 (`segmentInset` 3), `cta` 54, `softButton` 48, `bar` 52 (add bar input, toast), `barButton` 40 (the + and Undo), `focusRing` 2, `tile` 132 (list tiles, a minimum), `iconWell` 36 (recipe icon tiles and round actions buttons in card headers), `sheetIcon` 52 (the item sheet's icon tile), `recipeTile` 56 (a recipe's icon tile on its card in the Recipes tab), `removeButton` 32 (round − on "Added" rows), `fieldLabel` 76 (the label column of Name / Amount / Note rows, a minimum), `settingsIcon` 32 (the icon tile at the start of a settings row), `accountAvatar` 52, `avatar` 48 with a 3 pt `avatarRing` (household members), `signInShape` 92, `aisleRow` 52 (a minimum) and `grip` 20 (Aisle order rows). Radii `badge` 10 and `segment` 11.
- `shadows.lifted`: the row being dragged on the Aisle order screen (14 pt down, 30 pt blur, 22%, `ink`).

## Components (`src/components/`)

`Card`, `CheckCircle`, `SectionHeader`, `IconTile` (a rounded well in an aisle hue's `soft` with the glyph in its `dot`; recipes pick the hue with `recipeHue(id)`), `Pill`, `SegmentedControl`, `PrimaryButton` / `SoftDangerButton` / `SurfaceButton` (`button.tsx`; `Button` is left for secondary and plain actions, with an optional text `color`), `SettingsSection` / `SettingsRow` (`settings-group.tsx`), `Badge`, `AddBar` and `Toast`. Which tokens each uses in each state lives in `appearance.ts`, which is tested for contrast in both schemes. Controls under 44 pt (pills, the + and Undo buttons, segments) get `hitSlop` up to 44.

## Component patterns

- **Card**: `surface`, radius `card`, 16 pt side margin, `overflow: hidden`. Rows inside are separated by a 1 pt `border` hairline (none above the first row). Cards stack with a 10–12 pt gap.
- **Row with round check**: check, then the name (`body`, flexible), then the amount (`amount`). 12 pt gap, 16 pt side padding, min height 50. A second line (`footnote`, `inkSecondary`) goes under the name. On the list screen, unchecked rows are tinted by aisle (`categoryColors`): the tint as the row's ground, the ring in the aisle colour and the amount in its `text`; rows are 2 pt apart in the card's `surface` instead of a hairline, and there's no aisle dot by the name. Checked rows are untinted: filled check, name struck through in `inkSecondary` (the boards use `inkTertiary`, but that's 3.7:1, under the 4.5:1 text rule), the amount in `inkSecondary`, hairlines between. The row an add just merged into takes its aisle's `soft` tint while the toast shows.
- **Autocomplete panel** (recipe screen): a `surface` card above the add bar; a `caption` "YOU USUALLY BUY" (or "SUGGESTIONS" when only the catalog matched), then 50 pt rows: aisle dot, the name with the typed part in `headline`, and the short aisle name (`shortAisleName`) on the right in `footnote`.
- **Suggestion chips** (list screen, `SuggestionChips`): one horizontal row of 40 pt `surface` chips (radius `full`, `amount` text, 8 pt apart) docked 8 pt above the add bar, scrolling edge to edge. The typed part is `primary` 700. Recipe chips lead, with a `primary` `fork.knife` glyph and a 1 pt `primary` outline (`sizes.chipBorder`). Recently used while the field is empty, autocomplete while typing; no chips, no row.
- **List header** (list screen): the native header and the title band below it are `header` green with light status bar content; the name in `screenTitle` `onHeader`, "7 to get" in `onHeaderSecondary`, and the segmented control in `listHeaderColors().segments` (a 14% white wash track, a white selected segment with `header`-green text, white labels). Header buttons are tinted `onHeader`. The list's ground sits on it as a sheet with `card`-radius top corners overlapping the green.
- **List add mode**: while the add field is focused, the title and segmented control collapse (250 ms shrink, lift and fade; fade only under Reduce Motion) and the native header's title becomes the list's name in `headline` `onHeader` over "8 to get · Newest" in `footnote` `onHeaderSecondary`. Cards go edge to edge with square corners (`Card flush`); the first one takes the sheet's rounded top corners. A row matching the typed text takes `primarySoft`, with the typed part and "already on list" (in place of the amount, `amount`) in `onPrimarySoft`.
- **Round check**: 24 pt circle, 2 pt `controlBorder` ring when off (or a given `ring`, e.g. the item's aisle colour); filled `primary` with an `onPrimary` tick when on. "Sorting…" items show a dashed ring (`aisles.amber.dot`, or grey on the tinted list rows) and a `pending` "Sorting…" label; on the list screen their rows take the neutral grey tint. The whole row is the tap target.
- **Section header**: aisle `dot` (10 pt circle), the name in `sectionTitle`, then the count in `inkSecondary` (13 / 600) on the right. Padding 14 top, 6 bottom, 16 sides. Recipe sections use a 36 pt rounded icon well in place of the dot.
- **Pill**: 40 pt tall (38 in the boards), radius `full`, 14 pt side padding. Off: `surface` with `ink` text (600). On: filled (ink, or the aisle's `strong` shade for the aisle picker: `Pill hue=…`) with light text (700). "+ New" pills (`Pill dashed`) are 2 pt dashed `controlBorder` outlines with `inkSecondary` text. Colours come from `pillLook` in `appearance.ts`.
- **Segmented control**: `surfaceMuted` track, radius `md`, 3 pt inset; segments 34 pt tall with radius 11; the selected one is `surface` with `ink` 15 / 700, others transparent 15 / 600. Each segment is `accessibilityRole="tab"` with its selected state; keep a 44 pt hit area.
- **Recipe card** (Recipes tab, board 05): a `surface` card, radius `card`, 14 pt padding and gap, under its household's name (`sectionLabel`). A 56 pt `IconTile` in `recipeHue(id)`, the name in `headline` with "N ingredients" (`footnote`, `inkSecondary`) under it, and an "On <list>" `Badge` on the right while the recipe has an open item on a list. Cards stack with a 10 pt gap.
- **Recipe header band** (board 06): the recipe's `aisles[hue].soft` behind the native header and the band below it: the name in `screenTitle`, the source link in the hue's `strong` (`amount`, with a link glyph) and the notes in `ink` (`callout`), both edited in place. Then a full-width "Add to a list" CTA, an Ingredients card whose rows show the aisle dot, name and amount, and the add bar.
- **Untick rows** (add to a list, board 07): a round check, the name and the scaled amount. Unticked rows put the name in `inkSecondary` (the board's `inkTertiary` is under 4.5:1).
- **Primary CTA**: 54 pt tall, `primary`, radius `full`, `onPrimary` `headline` text, optional leading icon with an 8 pt gap. Full width inside 16 pt margins.
- **Soft destructive button**: `dangerSoft` fill, `danger` text (16 / 700), 48 pt tall, radius `full`. Small round remove buttons (32 pt glyph, 44 pt hit area) use the same pair.
- **Badge**: `caption` on a radius-10 tint, 4 × 8 padding. Positive: `onPrimarySoft` on `primarySoft` ("On Groceries", "Synced"). Owner: `pending` on `aisles.amber.soft`. Pending ("Syncing…", "Offline", "Not synced yet"): `pending` on `pendingSoft`. Danger ("Sync error"): `danger` on `dangerSoft`. The account card's badge shows the sync status (spec 7.5).
- **Bottom add bar**: on `background`, 12 pt top / 16 pt side padding, pinned above the keyboard. A 52 pt `surface` pill input (radius `full`, `body` text) with a 40 pt round `primary` + button inside on the right. A 2 pt `primary` ring while focused; a light shadow in light mode.
- **Toast**: a 52 pt `toast` pill floating 16 pt from the edges above the add bar, `onToast` 15 pt message, and a 40 pt `surface` Undo pill (`ink`, 700) on the right. Times out after `motion.undoTimeoutMs`.
- **Sheet**: `background` sheet with `sheet` top corners on a `scrim` backdrop. Header row: Cancel (plain `ink` text), a 36 × 5 `controlBorder` grabber, and a 40 pt `primary` Save pill. Then the title (`sheetTitle`) with a 52 pt `aisles[hue].soft` icon well (glyph from `aisleSymbol(slug)`), then cards of fields with `sectionLabel` labels above them. Native sheets keep the native header: the toolbar's Cancel and `done` Save, the system grabber, and an empty header title.
- **List tile**: two-column grid, 12 pt gap, 132 pt tall, `surface`, radius `tile`, 16 pt padding. A count in display 34 / 800 above the name (`callout`, 600). The default (Groceries) tile is `primary` with `onPrimary` text.
- **Sign-in** (board 09): the whole screen is `primary` with `onPrimary` text (`hero` name, `lead` tagline). A 3 × 2 grid of 92 pt shapes (radius `card`, or half the shape for the round ones) in aisle colours and the theme's greens, decorative. At the bottom the input, a 54 pt `surface` pill button (`SurfaceButton`, `ink` text), plain links in `onPrimary`, and a `footnote` note. Colours come from `signInColors`.
- **Settings card** (board 10): `sectionLabel` labels in `inkSecondary` (16 top, 8 bottom, 32 in) over `Card`s of `SettingsRow`s: an optional 32 pt `IconTile`, the label (`body`), a value (`amount`, `inkSecondary`) and a chevron when the row opens something. The account card has a 52 pt round avatar (`avatarColors`: the hue's `strong` with an `onPrimary` initial in `initial`). Sign out is a plain `danger` button beside the version (`footnote`).
- **Household band** (board 11): the native header and the band below it on `aisles.amber.soft`; the name in `screenTitle`, "N lists · N recipes" in `amount` `pending`, then 48 pt member avatars overlapping by 10 pt, each ringed 3 pt in the band colour. Colours come from `householdBandColors`. The Owner badge is `Badge tone="owner"`.
- **Aisle order rows** (board 12): 52 pt `surface` rows, radius `row`, 8 pt apart, with the aisle `dot`, the name (`body` 600) and a `line.3.horizontal` grip in `inkTertiary`. Touch and hold to drag: the row lifts (`shadows.lifted`, 1.03 scale, a 2 pt outline in its aisle `dot`, `headline` name, `ink` grip) over a 2 pt dashed `controlBorder` slot where it will land. Colours come from `aisleRowLook`. VoiceOver gets Move up / Move down actions.
- **Filled native header buttons** (`done` / `prominent` toolbar variants: Done, Save, the Recipes +): iOS draws their label white, so tint them with `prominentButtonTint` (`primary`, or `primarySoft` in dark mode, where `primary` is too light for white).
- **Nav row buttons** (inside native headers where the boards show them): 44 pt round `surface` buttons with `ink` glyphs; the primary action is `primary`.
