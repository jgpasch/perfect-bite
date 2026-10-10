/**
 * Which colour tokens the Pantry primitives use in each state. Pure, so the pairs can be tested for
 * contrast in both schemes; the components only turn these into styles.
 */

import type { IconName } from '@/components/icon';
import { withAlpha, type AisleColors, type ColorToken, type ThemeColors } from '@/constants/theme';
import type { AisleHue } from '@/domain/aisle-color';
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

/** The round check: a `controlBorder` ring when off, filled `primary` with a tick when on, dashed amber while sorting. */
export function checkAppearance(state: CheckState, colors: ThemeColors, aisles: Aisles): CheckAppearance {
  switch (state) {
    case 'on':
      return { fill: colors.primary, border: colors.primary, borderStyle: 'solid', tick: 'onPrimary' };
    case 'pending':
      return { fill: 'transparent', border: aisles.amber.dot, borderStyle: 'dashed', tick: null };
    default:
      return { fill: 'transparent', border: colors.controlBorder, borderStyle: 'solid', tick: null };
  }
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

/**
 * How a selected segment is filled: a `surface` chip (the list's view switch), or `primary` /
 * the ink fill with light text (the recipe sheet's Combine / Keep choice).
 */
export type SegmentTone = 'chip' | 'primary' | 'ink';

/** A segment: the selected one is filled by its tone; the rest sit on the track in `inkSecondary`. */
export function segmentColors(selected: boolean, tone: SegmentTone = 'chip'): { fill: ColorToken | null; text: ColorToken } {
  if (!selected) return { fill: null, text: 'inkSecondary' };
  if (tone === 'primary') return { fill: 'primary', text: 'onPrimary' };
  if (tone === 'ink') return { fill: 'toast', text: 'onToast' };
  return { fill: 'surface', text: 'ink' };
}

export type BadgeTone = 'positive' | 'owner';

/** Badges: positive ("On Groceries", "Synced") on `primarySoft`; Owner in `pending` on the amber soft tint. */
export function badgeColors(tone: BadgeTone, colors: ThemeColors, aisles: Aisles): { fill: string; text: string } {
  return tone === 'owner'
    ? { fill: aisles.amber.soft, text: colors.pending }
    : { fill: colors.primarySoft, text: colors.onPrimarySoft };
}

/** A list tile: the Siri default list is filled `primary`; the rest are `surface` cards. */
export function listTileColors(isDefault: boolean): { fill: ColorToken; text: ColorToken; secondary: ColorToken } {
  return isDefault
    ? { fill: 'primary', text: 'onPrimary', secondary: 'onPrimary' }
    : { fill: 'surface', text: 'ink', secondary: 'inkSecondary' };
}

/** The small "Siri" mark on the default list's tile: `onPrimary` on a faint `onPrimary` wash over the tile. */
export function siriMarkColors(colors: ThemeColors, tint: number): { fill: string; text: string } {
  return { fill: withAlpha(colors.onPrimary, tint), text: colors.onPrimary };
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
