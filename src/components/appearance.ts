/**
 * Which colour tokens the Pantry primitives use in each state. Pure, so the pairs can be tested for
 * contrast in both schemes; the components only turn these into styles.
 */

import type { AisleColors, ColorToken, ThemeColors } from '@/constants/theme';

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

/** A segment: the selected one is a `surface` chip with `ink` text; the rest sit on the track. */
export function segmentColors(selected: boolean): { fill: ColorToken | null; text: ColorToken } {
  return selected ? { fill: 'surface', text: 'ink' } : { fill: null, text: 'inkSecondary' };
}

export type BadgeTone = 'positive' | 'owner';

/** Badges: positive ("On Groceries", "Synced") on `primarySoft`; Owner in `pending` on the amber soft tint. */
export function badgeColors(tone: BadgeTone, colors: ThemeColors, aisles: Aisles): { fill: string; text: string } {
  return tone === 'owner'
    ? { fill: aisles.amber.soft, text: colors.pending }
    : { fill: colors.primarySoft, text: colors.onPrimarySoft };
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
