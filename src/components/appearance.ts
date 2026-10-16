/**
 * Which colour tokens the Pantry primitives use in each state. Pure, so the pairs can be tested for
 * contrast in both schemes; the components only turn these into styles.
 */

import type { IconName } from '@/components/icon';
import { AisleColors as AisleTokens, Palette, Rounded, Spacing, type AisleColors, type ColorScheme, type ColorToken, type ThemeColors } from '@/constants/theme';
import { aisleColor, type AisleHue } from '@/domain/aisle-color';
import { contrastRatio, mix } from '@/domain/contrast';
import { i18n } from '@/i18n';
import type { CategorySlug } from '@/shared/seed/categories';

type Aisles = (typeof AisleColors)[keyof typeof AisleColors];

export type CheckState = 'off' | 'on' | 'pending';

export type CheckAppearance = {
  fill: string;
  border: string;
  borderStyle: 'solid' | 'dashed';
  /** The tick's colour token, or null for no tick. */
  tick: ColorToken | null;
};

/**
 * The round check: a `controlBorder` ring when off, filled `primary` with a tick when on, dashed amber while
 * sorting. `ring` replaces the off and sorting ring colour, e.g. an item row's aisle colour (`categoryColors`), and
 * `fill` the off and sorting inside, e.g. `surface` so the check stands out on a coloured row.
 */
export function checkAppearance(
  state: CheckState,
  colors: ThemeColors,
  aisles: Aisles,
  ring?: string,
  fill = 'transparent',
): CheckAppearance {
  switch (state) {
    case 'on':
      return { fill: colors.primary, border: colors.primary, borderStyle: 'solid', tick: 'onPrimary' };
    case 'pending':
      return { fill, border: ring ?? aisles.amber.dot, borderStyle: 'dashed', tick: null };
    default:
      return { fill, border: ring ?? colors.controlBorder, borderStyle: 'solid', tick: null };
  }
}

/**
 * How unchecked item rows on the list screen carry their aisle colour (Settings > Aisle colours > Item rows):
 * `bands` fills each row with its aisle's `soft`, 2 pt apart in the card; `white` keeps rows white in the card,
 * with hairlines between, the colour only in the check's ring and a grey amount.
 */
export type ItemRowStyle = 'bands' | 'white';

export type CategoryColors = {
  /** The round check's ring. */
  ring: string;
  /** The inside of the round check while it's off, so it stands out on the row. */
  checkFill: string;
  /** The row's ground: the aisle's `soft` (bands) or `surface` (white). Opaque, so it covers a swipe action. */
  tint: string;
  /** The amount at the end of the row: the aisle's `strong` (bands, a neutral where that's under 4.5:1) or `inkSecondary` (white). */
  text: string;
};

/**
 * An aisle's colours on an unchecked item row (and any other category UI), by its slug. Unknown slugs, custom
 * aisles and items still Sorting… (no slug) get the neutral grey.
 */
export function categoryColors(
  slug: string | null | undefined,
  scheme: ColorScheme,
  style: ItemRowStyle = 'bands',
): CategoryColors {
  const hue = AisleTokens[scheme][aisleColor(slug)];
  const { surface, inkSecondary } = Palette[scheme];
  // Dark grey's `strong` is under 4.5:1 on its own `soft`; the neutral amount falls back to an ink.
  const strongOnSoft = contrastRatio(hue.strong, hue.soft) >= 4.5;
  if (style === 'white') {
    return { ring: hue.dot, checkFill: surface, tint: surface, text: inkSecondary };
  }
  return { ring: hue.dot, checkFill: surface, tint: hue.soft, text: strongOnSoft ? hue.strong : inkSecondary };
}

/**
 * An aisle card's header when only the header carries the aisle colour (the "Header only" aisle colours
 * setting): the aisle's `soft` as a band, the name, count and chevron in its `strong`, or `ink` where that's
 * under 4.5:1. Unknown slugs, custom aisles and no slug get the neutral grey.
 */
export function aisleHeaderBand(slug: string | null | undefined, scheme: ColorScheme): { ground: string; text: string } {
  return hueHeaderBand(aisleColor(slug), scheme);
}

/** A section header band in a hue (an aisle's, or a By meal section's on the Recipes tab): as `aisleHeaderBand`. */
export function hueHeaderBand(hue: AisleHue, scheme: ColorScheme): { ground: string; text: string } {
  const tokens = AisleTokens[scheme][hue];
  const text = contrastRatio(tokens.strong, tokens.soft) >= 4.5 ? tokens.strong : Palette[scheme].ink;
  return { ground: tokens.soft, text };
}

/** The white wash behind controls on the green header. */
export const HEADER_WASH = 0.14;

/** The list screen's header (spec: forest green): white title, light green subtitle, a translucent white view button. */
export function listHeaderColors(colors: ThemeColors) {
  return {
    ground: colors.header,
    title: colors.onHeader,
    subtitle: colors.onHeaderSecondary,
    /** The view button under the title: a white wash pill over the green with a white label. */
    viewButton: {
      fill: mix(colors.onHeader, colors.header, HEADER_WASH),
      text: colors.onHeader,
    },
    /** "Alex is adding" under it (spec 4.1): the same white wash pill and white text. */
    presencePill: {
      fill: mix(colors.onHeader, colors.header, HEADER_WASH),
      text: colors.onHeader,
    },
  };
}

/** A check's state: checked wins over sorting, since a checked item is done whatever its aisle. */
export function checkState(checked: boolean, pending = false): CheckState {
  if (checked) return 'on';
  return pending ? 'pending' : 'off';
}

/** A pill: `surface` with `ink` text when off, an ink fill when on. `toast` is the ink fill with `onToast` text. */
export function pillColors(selected: boolean): { fill: ColorToken; text: ColorToken } {
  return selected ? { fill: 'toast', text: 'onToast' } : { fill: 'surface', text: 'ink' };
}

export type PillLook = { fill: string; text: string; border: string | null };

/**
 * A pill's colours. Off: `surface` with `ink`. On: the ink fill, or with a `hue` (the item sheet's
 * aisle picker) that aisle's `strong` fill, both with light text; `primary` (the Recipes tab's
 * active Filters pill) is `primary` with `onPrimary`. Dashed ("+ New"): no fill, a
 * `controlBorder` outline and `inkSecondary` text. Outline (the aisle picker's "Show all"): no fill,
 * a `primary` outline and `primary` text. Soft (the Method card's "Add steps"): `primarySoft` with
 * `onPrimarySoft` text.
 */
export function pillLook(
  {
    selected = false,
    hue,
    dashed = false,
    primary = false,
    outline = false,
    soft = false,
  }: { selected?: boolean; hue?: AisleHue; dashed?: boolean; primary?: boolean; outline?: boolean; soft?: boolean },
  colors: ThemeColors,
  aisles: Aisles,
): PillLook {
  if (dashed) return { fill: 'transparent', text: colors.inkSecondary, border: colors.controlBorder };
  if (outline) return { fill: 'transparent', text: colors.primary, border: colors.primary };
  if (soft) return { fill: colors.primarySoft, text: colors.onPrimarySoft, border: null };
  if (selected && primary) return { fill: colors.primary, text: colors.onPrimary, border: null };
  if (selected && hue) return { fill: aisles[hue].strong, text: colors.onPrimary, border: null };
  const look = pillColors(selected);
  return { fill: colors[look.fill], text: colors[look.text], border: null };
}

/** The glyph in an item's icon tile, by aisle slug. Unknown slugs (custom aisles), `other` and Sorting… get a bag. */
const AISLE_SYMBOLS: Record<CategorySlug, IconName> = {
  produce: 'carrot',
  bakery: 'basket',
  deli: 'fork.knife',
  'meat-seafood': 'fish',
  'dairy-eggs': 'waterbottle',
  frozen: 'snowflake',
  pantry: 'cabinet',
  'canned-jarred': 'cylinder',
  'pasta-grains': 'takeoutbag.and.cup.and.straw',
  baking: 'birthday.cake',
  spices: 'flame',
  condiments: 'drop',
  snacks: 'popcorn',
  beverages: 'cup.and.saucer',
  breakfast: 'sun.horizon',
  household: 'house',
  'personal-care': 'hands.sparkles',
  baby: 'stroller',
  pet: 'pawprint',
  other: 'bag',
};

export function aisleSymbol(slug: string | null | undefined): IconName {
  if (slug == null || !Object.hasOwn(AISLE_SYMBOLS, slug)) return 'bag';
  return AISLE_SYMBOLS[slug as CategorySlug];
}

/** A segment: the selected one is a `surface` chip; the rest sit on the track in `inkSecondary`. */
export function segmentColors(selected: boolean): { fill: ColorToken | null; text: ColorToken } {
  return selected ? { fill: 'surface', text: 'ink' } : { fill: null, text: 'inkSecondary' };
}

export type BadgeTone = 'positive' | 'owner' | 'pending' | 'danger';

/**
 * Badges: positive ("On Groceries", "Synced") on `primarySoft`; Owner in `pending` on the amber
 * soft tint; pending ("Syncing…", "Offline") on `pendingSoft`; danger ("Sync error") on `dangerSoft`.
 */
export function badgeColors(tone: BadgeTone, colors: ThemeColors, aisles: Aisles): { fill: string; text: string } {
  switch (tone) {
    case 'owner':
      return { fill: aisles.amber.soft, text: colors.pending };
    case 'pending':
      return { fill: colors.pendingSoft, text: colors.pending };
    case 'danger':
      return { fill: colors.dangerSoft, text: colors.danger };
    default:
      return { fill: colors.primarySoft, text: colors.onPrimarySoft };
  }
}

/**
 * A list's row in the Your lists sheet (spec 4.1, board G). The dot is the list's hue; a Default list
 * gets a hollow `controlBorder` ring, except the Siri default list, whose dot is `primary`. The current
 * list's row is tinted `primarySoft` with `onPrimarySoft` text.
 */
export function listRowLook(
  current: boolean,
  isDefault: boolean,
  hue: AisleHue | null,
  colors: ThemeColors,
  aisles: Aisles,
): { fill: string; text: ColorToken; secondary: ColorToken; dot: string | null; ring: string | null } {
  const dot = hue ? aisles[hue].dot : isDefault ? colors.primary : null;
  return {
    fill: current ? colors.primarySoft : colors.surface,
    text: current ? 'onPrimarySoft' : 'ink',
    secondary: current ? 'onPrimarySoft' : 'inkSecondary',
    dot,
    ring: dot ? null : colors.controlBorder,
  };
}

/**
 * The sign-in screen (board 09): `onHeader` text on the `header` green, the same dark green as the
 * launch screen behind it, "Perfect" in the cloche's `gold`, and an `onHeader` button with `header`
 * text, so it reads in both schemes.
 */
export function signInColors(colors: ThemeColors) {
  return {
    ground: colors.header,
    text: colors.onHeader,
    accent: colors.gold,
    button: colors.onHeader,
    buttonText: colors.header,
  };
}

/** A round avatar: the hue's `strong` shade with an `onPrimary` initial. */
export function avatarColors(hue: AisleHue, colors: ThemeColors, aisles: Aisles): { fill: string; text: string } {
  return { fill: aisles[hue].strong, text: colors.onPrimary };
}

/** The household screen's header band (board 11): the amber soft tint, `ink` name and a `pending` counts line. */
export function householdBandColors(colors: ThemeColors, aisles: Aisles): { fill: string; text: string; secondary: string } {
  return { fill: aisles.amber.soft, text: colors.ink, secondary: colors.pending };
}

/** How much `surface` the recipe band's tag pills lay over the band's soft tint. */
export const RECIPE_TAG_WASH = 0.55;

/**
 * A tag pill in the recipe band (spec 4.14): a translucent `surface` wash over the band's `soft`
 * tint, the facet in `inkSecondary` over the value in `ink`. The "+ Tags" pill is `Pill dashed`.
 */
export function recipeTagPillColors(hue: AisleHue, colors: ThemeColors, aisles: Aisles): { fill: string; facet: string; text: string } {
  return { fill: mix(colors.surface, aisles[hue].soft, RECIPE_TAG_WASH), facet: colors.inkSecondary, text: colors.ink };
}

/**
 * A row on the Aisle order screen (board 12): `surface` with the aisle's dot and an `inkTertiary`
 * grip. The row being dragged gets an outline in its aisle's `dot` colour and an `ink` grip.
 */
export function aisleRowLook(
  dragging: boolean,
  hue: AisleHue,
  colors: ThemeColors,
  aisles: Aisles,
): { fill: string; dot: string; outline: string | null; grip: ColorToken } {
  return {
    fill: colors.surface,
    dot: aisles[hue].dot,
    outline: dragging ? aisles[hue].dot : null,
    grip: dragging ? 'ink' : 'inkTertiary',
  };
}

/**
 * The tint of a filled native header button (`done` / `prominent` toolbar variants). iOS always draws
 * their label or glyph white, which is too light on the dark scheme's light `primary`, so dark mode
 * fills them `primarySoft` instead.
 */
export function prominentButtonTint(scheme: 'light' | 'dark', colors: ThemeColors): string {
  return scheme === 'dark' ? colors.primarySoft : colors.primary;
}

/** An item's name: `ink`, or `inkSecondary` once it's checked off (with a line through it). */
export function itemNameColor(checked: boolean): ColorToken {
  return checked ? 'inkSecondary' : 'ink';
}

/**
 * What VoiceOver reads for a section header: its name, then how many items it has ("Produce, 3 items").
 * `unit` counts something else: "Method, 3 steps".
 */
export function sectionHeaderLabel(
  name: string,
  count?: number,
  unit?: readonly [one: string, other: string],
): string {
  if (count === undefined) return name;
  if (!unit) return i18n.t('common.sectionCount', { name, count });
  return `${name}, ${count} ${count === 1 ? unit[0] : unit[1]}`;
}

/** What VoiceOver announces when a toast appears: the message, then which actions it offers. */
export function toastAnnouncement(message: string, actionLabels: string[]): string {
  if (actionLabels.length === 0) return message;
  return i18n.t('common.toastAnnouncement', { message, actions: actionLabels.join(', ') });
}

/**
 * The add bar's round button: always the + ("Add"), disabled and dimmed while the field is empty or
 * blank. It never turns into a hide-keyboard button; return on an empty field does that.
 */
export function addBarButton(value: string): { label: string; disabled: boolean } {
  return { label: i18n.t('addBar.button'), disabled: !value.trim() };
}

/**
 * A card's box: its ground, the `card` radius and a 16 pt inset from the screen edge, the same in every
 * mode. The list's add mode keeps it too, so focusing the add field moves only the title, never the cards.
 */
export function cardLook(
  background: ColorToken,
  colors: ThemeColors,
): { backgroundColor: string; borderRadius: number; marginHorizontal: number } {
  return { backgroundColor: colors[background], borderRadius: Rounded.card, marginHorizontal: Spacing.lg };
}
