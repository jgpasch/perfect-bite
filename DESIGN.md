# Design: direction B, "Pantry"

Friendly and tactile: soft white cards and tiles sit on a pale green ground, checks are round, and titles are set in a chunky grotesque. Every aisle has its own colour, so you can find your place in a long list at a glance.

The reference boards are in `docs/design/pantry/` (`lists.html` 01–04, `recipes.html` 05–08, `settings.html` 09–12). Treat their 390×844 phone frames as the reference. The boards' floating tab bar is a mock: the app keeps the native tab bar (`NativeTabs`) and native headers, tinted `primary`.

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
| `largeTitle` | display | 40 / 800 | Tab roots: "Your lists", "Recipes", "Settings". |
| `screenTitle` | display | 36 / 800 | Pushed screens: a list's or recipe's name, a household, "Aisle order". |
| `sheetTitle` | display | 30 / 800 | Sheet titles: the item's name in the item sheet. |
| `title` | display | 28 / 800 | Smaller titles, e.g. inside a card. |
| `tileCount` | display | 34 / 800 | The item-to-get count on a list tile. |
| `sectionTitle` | display | 17 / 700 | Card section headers: aisle or recipe name. |
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

Dark mode keeps the same hues on a dark green-grey ground (`#111915`, cards `#1B241F`) with lighter accents (`primary` `#7CC395` with dark `onPrimary`). The values are in `theme.ts`; the test checks that both schemes have the same tokens and pass contrast.

Checked text pairs (≥ 4.5:1, both schemes): `ink` and `inkSecondary` on `background`, `surface` and `surfaceMuted`; `onPrimary` on `primary`; `primary` on `surface` and `background`; `onPrimarySoft` on `primarySoft`; `danger` on `surface`, `background` and `dangerSoft`; `pending` on `pendingSoft`; `ink` on `pendingSoft`; `onToast` on `toast`; `ink` and `inkSecondary` on every aisle `soft`; `onPrimary` on every aisle `strong`. `inkTertiary` is checked at 3:1 (non-text).

## Aisle colours (`aisles.*`)

Each hue has a `dot` (section dots, the aisle-order dots, list tile accents), a `soft` tint (icon wells, a just-added row flash in that aisle, household header bands) and a `strong` shade for fills that carry `onPrimary` text (the selected aisle pill). In light mode most dots are under 4.5:1 with white text (blue 4.4, rose 4.4, grey 3.7, amber 2.9), so `strong` is a deeper shade there (green `#2E6B45`, blue `#2F6396`, rose `#A33D53`, amber `#8A5C0C`, grey `#55635A`); in dark mode it equals the dot, with dark `onPrimary` text.

| Hue | Light dot / soft | Aisles |
| --- | --- | --- |
| green | `#2E6B45` / `#DDEFE2` | produce, household, pet |
| blue | `#3E7BB8` / `#DFEAF6` | dairy-eggs, frozen, beverages, personal-care, baby |
| rose | `#C2556B` / `#F7E1E6` | meat-seafood, deli |
| amber | `#C98A1E` / `#F6EBD4` | bakery, pantry, canned-jarred, pasta-grains, baking, spices, condiments, snacks, breakfast |
| grey | `#7C877F` / `#EEF3EC` | other, and any slug the app doesn't know (custom aisles) |

The rule: pick the hue with `aisleColor(slug)` from `src/domain/aisle-color.ts`, then read `aisles[hue].dot` or `.soft`. Never colour an aisle by its position, so an aisle keeps its colour when the store order changes. A dot is decoration: the aisle's name is always shown next to it, so colour is never the only signal.

## Spacing, radius and sizes

- `spacing`: 4 pt base (`xxs` 2 … `xxxl` 48). Cards and tiles sit `lg` (16) in from the screen edge; titles sit 20 in (`lg` + `xs`).
- `rounded`: `card` 22, `tile` 22, `sheet` 28 (top corners), `row` 16 (aisle-order rows), `md` 12 (segmented track, icon wells), `full` for pills, round checks, round buttons and CTAs.
- `sizes.minTapTarget` 44. Rows inside cards are at least 50 pt tall (`sizes.cardRowMin`).
- Component sizes: `check` 24 (`checkBorder` 2), `dot` 10, `pill` 40, `segment` 34 (`segmentInset` 3), `cta` 54, `softButton` 48, `bar` 52 (add bar input, toast), `barButton` 40 (the + and Undo), `focusRing` 2, `tile` 132 (list tiles, a minimum), `iconWell` 36 (recipe icon tiles and round actions buttons in card headers), `sheetIcon` 52 (the item sheet's icon tile), `removeButton` 32 (round − on "Added" rows), `fieldLabel` 76 (the label column of Name / Amount / Note rows, a minimum). Radii `badge` 10 and `segment` 11.

## Components (`src/components/`)

`Card`, `CheckCircle`, `SectionHeader`, `IconTile` (a rounded well in an aisle hue's `soft` with the glyph in its `dot`; recipes pick the hue with `recipeHue(id)`), `Pill`, `SegmentedControl`, `PrimaryButton` / `SoftDangerButton` (`button.tsx`; `Button` is left for secondary and plain actions), `Badge`, `AddBar` and `Toast`. Which tokens each uses in each state lives in `appearance.ts`, which is tested for contrast in both schemes. Controls under 44 pt (pills, the + and Undo buttons, segments) get `hitSlop` up to 44.

## Component patterns

- **Card**: `surface`, radius `card`, 16 pt side margin, `overflow: hidden`. Rows inside are separated by a 1 pt `border` hairline (none above the first row). Cards stack with a 10–12 pt gap.
- **Row with round check**: check, then the name (`body`, flexible), then the amount (`amount`, `inkSecondary`). 12 pt gap, 16 pt side padding, min height 50. A second line (`footnote`, `inkSecondary`) goes under the name. Checked rows: filled check, name struck through in `inkSecondary` (the boards use `inkTertiary`, but that's 3.7:1, under the 4.5:1 text rule); the amount stays `inkSecondary`. The row an add just merged into takes its aisle's `soft` tint while the toast shows.
- **Autocomplete panel**: a `surface` card above the add bar; a `caption` "YOU USUALLY BUY" (or "SUGGESTIONS" when only the catalog matched), then 50 pt rows: aisle dot, the name with the typed part in `headline`, and the short aisle name (`shortAisleName`) on the right in `footnote`.
- **Round check**: 24 pt circle, 2 pt `controlBorder` ring when off; filled `primary` with an `onPrimary` tick when on. "Sorting…" items show a dashed `aisles.amber.dot` ring and a `pending` "Sorting…" label (`caption`) on a `pendingSoft` card. The whole row is the tap target.
- **Section header**: aisle `dot` (10 pt circle), the name in `sectionTitle`, then the count in `inkSecondary` (13 / 600) on the right. Padding 14 top, 6 bottom, 16 sides. Recipe sections use a 36 pt rounded icon well in place of the dot.
- **Pill**: 40 pt tall (38 in the boards), radius `full`, 14 pt side padding. Off: `surface` with `ink` text (600). On: filled (ink, or the aisle's `strong` shade for the aisle picker: `Pill hue=…`) with light text (700). "+ New" pills (`Pill dashed`) are 2 pt dashed `controlBorder` outlines with `inkSecondary` text. Colours come from `pillLook` in `appearance.ts`.
- **Segmented control**: `surfaceMuted` track, radius `md`, 3 pt inset; segments 34 pt tall with radius 11; the selected one is `surface` with `ink` 15 / 700, others transparent 15 / 600. Each segment is `accessibilityRole="tab"` with its selected state; keep a 44 pt hit area.
- **Primary CTA**: 54 pt tall, `primary`, radius `full`, `onPrimary` `headline` text, optional leading icon with an 8 pt gap. Full width inside 16 pt margins.
- **Soft destructive button**: `dangerSoft` fill, `danger` text (16 / 700), 48 pt tall, radius `full`. Small round remove buttons (32 pt glyph, 44 pt hit area) use the same pair.
- **Badge**: `caption` on a radius-10 tint, 4 × 8 padding. Positive: `onPrimarySoft` on `primarySoft` ("On Groceries", "Synced"). Owner: `pending` on `aisles.amber.soft`.
- **Bottom add bar**: on `background`, 12 pt top / 16 pt side padding, pinned above the keyboard. A 52 pt `surface` pill input (radius `full`, `body` text) with a 40 pt round `primary` + button inside on the right. A 2 pt `primary` ring while focused; a light shadow in light mode.
- **Toast**: a 52 pt `toast` pill floating 16 pt from the edges above the add bar, `onToast` 15 pt message, and a 40 pt `surface` Undo pill (`ink`, 700) on the right. Times out after `motion.undoTimeoutMs`.
- **Sheet**: `background` sheet with `sheet` top corners on a `scrim` backdrop. Header row: Cancel (plain `ink` text), a 36 × 5 `controlBorder` grabber, and a 40 pt `primary` Save pill. Then the title (`sheetTitle`) with a 52 pt `aisles[hue].soft` icon well (glyph from `aisleSymbol(slug)`), then cards of fields with `sectionLabel` labels above them. Native sheets keep the native header: the toolbar's Cancel and `done` Save, the system grabber, and an empty header title.
- **List tile**: two-column grid, 12 pt gap, 132 pt tall, `surface`, radius `tile`, 16 pt padding. A count in display 34 / 800 above the name (`callout`, 600). The default (Groceries) tile is `primary` with `onPrimary` text.
- **Nav row buttons** (inside native headers where the boards show them): 44 pt round `surface` buttons with `ink` glyphs; the primary action is `primary`.
