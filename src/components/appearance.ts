/**
 * Which colour tokens the Pantry primitives use in each state. Pure, so the pairs can be tested for
 * contrast in both schemes; the components only turn these into styles.
 */

import type { IconName } from '@/components/icon';
import { AisleColors as AisleTokens, Palette, withAlpha, type AisleColors, type ColorScheme, type ColorToken, type ThemeColors } from '@/constants/theme';
import { aisleColor, type AisleHue } from '@/domain/aisle-color';
import { contrastRatio, mix } from '@/domain/contrast';
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
 * sorting. `ring` replaces the off and sorting ring colour, e.g. an item row's aisle colour (`categoryColors`).
 */
export function checkAppearance(state: CheckState, colors: ThemeColors, aisles: Aisles, ring?: string): CheckAppearance {
  switch (state) {
    case 'on':
      return { fill: colors.primary, border: colors.primary, borderStyle: 'solid', tick: 'onPrimary' };
    case 'pending':
      return { fill: 'transparent', border: ring ?? aisles.amber.dot, borderStyle: 'dashed', tick: null };
    default:
      return { fill: 'transparent', border: ring ?? colors.controlBorder, borderStyle: 'solid', tick: null };
  }
}

/** How much of the aisle colour an unchecked row's tint takes: faint in light mode, a little more on dark. */
export const CATEGORY_TINT: Record<ColorScheme, number> = { light: 0.1, dark: 0.16 };

export type CategoryColors = {
  /** The round check's ring. */
  ring: string;
  /** The row's ground: the aisle colour faintly over `surface`. Opaque, so it covers a swipe action. */
  tint: string;
  /** The amount at the end of the row: the aisle colour, deepened (`strong`) where the dot is too pale for text. */
  text: string;
};

/**
 * An aisle's colours on an unchecked item row (and any other category UI), by its slug. Unknown slugs, custom
 * aisles and items still Sorting… (no slug) get the neutral grey.
 */
export function categoryColors(slug: string | null | undefined, scheme: ColorScheme): CategoryColors {
  const hue = AisleTokens[scheme][aisleColor(slug)];
  const tint = mix(hue.dot, Palette[scheme].surface, CATEGORY_TINT[scheme]);
  // Dark grey's dot is under 4.5:1 on its own tint; the neutral amount falls back to `inkSecondary`.
  const text = contrastRatio(hue.strong, tint) >= 4.5 ? hue.strong : Palette[scheme].inkSecondary;
  return { ring: hue.dot, tint, text };
}

/** The white wash behind controls on the green header. */
export const HEADER_WASH = 0.14;

/** The list screen's header (spec: forest green): white title, light green subtitle, a translucent white track. */
export function listHeaderColors(colors: ThemeColors) {
  return {
    ground: colors.header,
    title: colors.onHeader,
    subtitle: colors.onHeaderSecondary,
    /** The segmented control: a white wash over the green, with a white selected segment in the header's green. */
    segments: {
      track: mix(colors.onHeader, colors.header, HEADER_WASH),
      text: colors.onHeader,
      selected: colors.onHeader,
      selectedText: colors.header,
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
 * aisle picker) that aisle's `strong` fill, both with light text. Dashed ("+ New"): no fill, a
 * `controlBorder` outline and `inkSecondary` text.
 */
export function pillLook(
  { selected = false, hue, dashed = false }: { selected?: boolean; hue?: AisleHue; dashed?: boolean },
  colors: ThemeColors,
  aisles: Aisles,
): PillLook {
  if (dashed) return { fill: 'transparent', text: colors.inkSecondary, border: colors.controlBorder };
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

export type ListTileLook = {
  fill: string;
  text: ColorToken;
  secondary: ColorToken;
  /** The text colour the Siri mark is built from (`siriMarkColors`). */
  mark: ColorToken;
};

/**
 * A list tile (spec 4.1): a coloured list fills with its hue's `soft` tint, with `ink` text. A Default
 * one is a `surface` card, except the Siri default list, which is filled `primary`.
 */
export function listTileColors(isDefault: boolean, hue: AisleHue | null, colors: ThemeColors, aisles: Aisles): ListTileLook {
  if (hue) return { fill: aisles[hue].soft, text: 'ink', secondary: 'inkSecondary', mark: 'ink' };
  return isDefault
    ? { fill: colors.primary, text: 'onPrimary', secondary: 'onPrimary', mark: 'onPrimary' }
    : { fill: colors.surface, text: 'ink', secondary: 'inkSecondary', mark: 'ink' };
}

/** The small "Siri" mark on the default list's tile: `text` (the tile's `mark`) on a faint wash of itself. */
export function siriMarkColors(colors: ThemeColors, tint: number, text: ColorToken = 'onPrimary'): { fill: string; text: string } {
  return { fill: withAlpha(colors[text], tint), text: colors[text] };
}

/**
 * The sign-in screen (board 09): `onPrimary` text on a `primary` ground, and a `surface` button with
 * `ink` text. The six decorative shapes take aisle tints and the theme's own greens.
 */
export function signInColors(colors: ThemeColors, aisles: Aisles) {
  return {
    ground: colors.primary,
    text: colors.onPrimary,
    button: colors.surface,
    buttonText: colors.ink,
    shapes: [aisles.blue.dot, aisles.amber.dot, aisles.rose.dot, colors.background, colors.onPrimarySoft, aisles.blue.soft],
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

/** What VoiceOver reads for a section header: its name, then how many items it has ("Produce, 3 items"). */
export function sectionHeaderLabel(name: string, count?: number): string {
  if (count === undefined) return name;
  return `${name}, ${count} ${count === 1 ? 'item' : 'items'}`;
}

/** What VoiceOver announces when a toast appears: the message, then which actions it offers. */
export function toastAnnouncement(message: string, actionLabels: string[]): string {
  if (actionLabels.length === 0) return message;
  return `${message}. ${actionLabels.join(', ')} available.`;
}

/**
 * The add bar's round button: always the + ("Add"), disabled and dimmed while the field is empty or
 * blank. It never turns into a hide-keyboard button; return on an empty field does that.
 */
export function addBarButton(value: string): { label: 'Add'; disabled: boolean } {
  return { label: 'Add', disabled: !value.trim() };
}
