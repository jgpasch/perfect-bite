/**
 * Design tokens for direction B, "Pantry". DESIGN.md documents every token and when to use it.
 * Components read these through `useTheme()` and never hard-code hex values or font sizes.
 */

import '@/global.css';

import { Platform, type TextStyle } from 'react-native';

import type { AisleHue } from '@/domain/aisle-color';

/**
 * Bricolage Grotesque (display, 500–800) and Figtree (body, 400–700) are embedded at build time by
 * the `expo-font` config plugin in app.json, under these family names. `fontWeight` picks the file.
 */
export const Fonts = Platform.select({
  web: {
    display: 'var(--font-display)',
    body: 'var(--font-body)',
  },
  default: {
    display: 'Bricolage Grotesque',
    body: 'Figtree',
  },
});

export const Palette = {
  light: {
    /** Screen ground: pale green. */
    background: '#EEF3EC',
    /** Cards, tiles, inputs, unselected pills. */
    surface: '#FFFFFF',
    /** Segmented control track, tile placeholders. */
    surfaceMuted: '#DCE4DA',
    /** Hairlines between rows inside a card. */
    border: '#EEF1EC',
    /** Unchecked round checks, dashed "new" outlines, sheet grabber. */
    controlBorder: '#B9C4BC',
    ink: '#1D2A22',
    inkSecondary: '#55635A',
    /** Icons and decorative glyphs only; too light for text. */
    inkTertiary: '#7C877F',
    primary: '#2E6B45',
    onPrimary: '#FFFFFF',
    primarySoft: '#DDEFE2',
    onPrimarySoft: '#1F5233',
    danger: '#A33D53',
    dangerSoft: '#F7E1E6',
    /** "Sorting…": items waiting for an aisle. */
    pending: '#8A5C0C',
    pendingSoft: '#FFF7E6',
    /** Behind a sheet. */
    scrim: '#C9D3C7',
    toast: '#1D2A22',
    onToast: '#FFFFFF',
  },
  dark: {
    background: '#111915',
    surface: '#1B241F',
    surfaceMuted: '#28332C',
    border: '#26302A',
    controlBorder: '#56635A',
    ink: '#E7EEE8',
    inkSecondary: '#A6B3AA',
    inkTertiary: '#7E8B82',
    primary: '#7CC395',
    onPrimary: '#0E1F14',
    primarySoft: '#1E3A28',
    onPrimarySoft: '#B7E4C5',
    danger: '#F08B9F',
    dangerSoft: '#3B1E26',
    pending: '#E8B65A',
    pendingSoft: '#33290F',
    scrim: '#050806',
    toast: '#E7EEE8',
    onToast: '#111915',
  },
} as const;

export type ColorScheme = keyof typeof Palette;
export type ColorToken = keyof typeof Palette.light;
export type ThemeColors = Record<ColorToken, string>;

/** Aisle colours (see `aisleColor` in src/domain): `dot` for section dots and selected chips, `soft` for tints. */
export const AisleColors = {
  light: {
    green: { dot: '#2E6B45', soft: '#DDEFE2' },
    blue: { dot: '#3E7BB8', soft: '#DFEAF6' },
    rose: { dot: '#C2556B', soft: '#F7E1E6' },
    amber: { dot: '#C98A1E', soft: '#F6EBD4' },
    grey: { dot: '#7C877F', soft: '#EEF3EC' },
  },
  dark: {
    green: { dot: '#6FBF8A', soft: '#1E3A28' },
    blue: { dot: '#7AAEE0', soft: '#1B2D3F' },
    rose: { dot: '#E58A9C', soft: '#3B1E26' },
    amber: { dot: '#E3AE4E', soft: '#33290F' },
    grey: { dot: '#8E9A91', soft: '#26302A' },
  },
} as const satisfies Record<ColorScheme, Record<AisleHue, { dot: string; soft: string }>>;

type TypeStyle = Required<Pick<TextStyle, 'fontFamily' | 'fontSize' | 'fontWeight' | 'lineHeight'>> &
  Pick<TextStyle, 'letterSpacing'>;

/** Display titles track tight (-0.025em). */
const tight = (size: number) => Math.round(size * -0.025 * 100) / 100;

/** Sizes are at the default Dynamic Type setting (Large). Text scales with the user's setting; never disable it. */
export const Typography = {
  /** Tab roots: "Your lists", "Settings". */
  largeTitle: { fontFamily: Fonts.display, fontSize: 40, fontWeight: '800', lineHeight: 44, letterSpacing: tight(40) },
  /** Pushed screens: a list's name, "Aisle order". */
  screenTitle: { fontFamily: Fonts.display, fontSize: 36, fontWeight: '800', lineHeight: 40, letterSpacing: tight(36) },
  /** Sheet titles: the item's name. */
  sheetTitle: { fontFamily: Fonts.display, fontSize: 30, fontWeight: '800', lineHeight: 34, letterSpacing: tight(30) },
  title: { fontFamily: Fonts.display, fontSize: 28, fontWeight: '800', lineHeight: 32, letterSpacing: tight(28) },
  /** The item-to-get count on a list tile. */
  tileCount: { fontFamily: Fonts.display, fontSize: 34, fontWeight: '800', lineHeight: 36, letterSpacing: tight(34) },
  /** Card section headers: aisle or recipe name. */
  sectionTitle: { fontFamily: Fonts.display, fontSize: 17, fontWeight: '700', lineHeight: 22 },
  /** Buttons and emphasised rows. */
  headline: { fontFamily: Fonts.body, fontSize: 17, fontWeight: '700', lineHeight: 22 },
  body: { fontFamily: Fonts.body, fontSize: 17, fontWeight: '500', lineHeight: 22 },
  callout: { fontFamily: Fonts.body, fontSize: 16, fontWeight: '500', lineHeight: 21 },
  /** Quantities and values at the end of a row. */
  amount: { fontFamily: Fonts.body, fontSize: 15, fontWeight: '600', lineHeight: 20 },
  /** Labels above a card ("Members", "Added") and household names above tiles. */
  sectionLabel: { fontFamily: Fonts.body, fontSize: 13, fontWeight: '700', lineHeight: 18 },
  footnote: { fontFamily: Fonts.body, fontSize: 13, fontWeight: '400', lineHeight: 18 },
  /** Badges and small all-caps labels. */
  caption: { fontFamily: Fonts.body, fontSize: 12, fontWeight: '700', lineHeight: 16 },
} as const satisfies Record<string, TypeStyle>;

export type TypographyVariant = keyof typeof Typography;

/** 4pt base unit. `lg` (16) is the default screen gutter. */
export const Spacing = {
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  xxxl: 48,
} as const;

export const Rounded = {
  /** chips, small buttons */
  sm: 8,
  /** inputs, segmented control track */
  md: 12,
  /** rows in the aisle-order list */
  row: 16,
  /** badges */
  badge: 10,
  /** the selected segment inside a segmented control's `md` track */
  segment: 11,
  /** cards */
  card: 22,
  /** list tiles */
  tile: 22,
  /** sheets */
  sheet: 28,
  /** pills, round checks, round icon buttons, primary CTAs */
  full: 999,
} as const;

/** Fixed component sizes (tap targets, large buttons, list rows). */
export const Sizes = {
  minTapTarget: 44,
  rowMin: 48,
  icon: 17,
  /** list item checkboxes */
  iconLarge: 22,
  iconSmall: 12,
  /** Pantry rows inside a card */
  cardRowMin: 50,
  /** round check */
  check: 24,
  checkBorder: 2,
  /** aisle dot in section headers and suggestions */
  dot: 10,
  /** pills (aisle chips, choices) */
  pill: 40,
  /** segmented control: segment height and the track's inset */
  segment: 34,
  segmentInset: 3,
  /** primary CTA */
  cta: 54,
  /** soft destructive button */
  softButton: 48,
  /** add bar input and the toast */
  bar: 52,
  /** the round + inside the add bar, and the toast's Undo pill */
  barButton: 40,
  /** focus ring around the add bar */
  focusRing: 2,
  /** list tiles on the lists home (a minimum, so Dynamic Type can grow them) */
  tile: 132,
  /** a recipe's tinted icon tile in a section header, and round actions buttons in a card header */
  iconWell: 36,
} as const;

/** Motion: 200–300ms springs, no bounce loops. */
export const Motion = {
  duration: 250,
  spring: { damping: 20, stiffness: 220, mass: 1 },
  /** Undo toasts (spec 4.2, 4.4). */
  undoTimeoutMs: 5000,
} as const;

/** Opacity tokens: tints (12%), shadows (25%), pressed and disabled states. */
export const Opacity = {
  tint: 0.12,
  shadow: 0.25,
  pressed: 0.85,
  disabled: 0.4,
} as const;

/** Mix a hex color token with an alpha, for tints (e.g. status chip 12% background). */
export function withAlpha(hex: string, alpha: number): string {
  const a = Math.round(Math.max(0, Math.min(1, alpha)) * 255)
    .toString(16)
    .padStart(2, '0');
  return `${hex}${a}`;
}

/** Soft shadow for floating controls (light mode only). Color comes from `ink`. */
export const Shadows = {
  floating: { shadowOffset: { width: 0, height: 4 }, shadowRadius: 6, shadowOpacity: Opacity.shadow },
  /** The add bar's input. */
  soft: { shadowOffset: { width: 0, height: 4 }, shadowRadius: 14, shadowOpacity: 0.08 },
} as const;
