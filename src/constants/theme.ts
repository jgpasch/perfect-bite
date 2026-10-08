/**
 * Design tokens. Structure copied from stash; colours are provisional until DESIGN.md exists.
 * Components read these through `useTheme()` and never hard-code hex values or font sizes.
 */

import '@/global.css';

import { Platform, type TextStyle } from 'react-native';

export const Fonts = Platform.select({
  ios: {
    /** iOS `UIFontDescriptorSystemDesignDefault` (SF Pro) */
    sans: 'system-ui',
    /** iOS `UIFontDescriptorSystemDesignSerif` (New York) */
    serif: 'ui-serif',
    /** iOS `UIFontDescriptorSystemDesignRounded` */
    rounded: 'ui-rounded',
    /** iOS `UIFontDescriptorSystemDesignMonospaced` */
    mono: 'ui-monospace',
  },
  default: {
    sans: 'normal',
    serif: 'serif',
    rounded: 'normal',
    mono: 'monospace',
  },
  web: {
    sans: 'var(--font-display)',
    serif: 'var(--font-serif)',
    rounded: 'var(--font-rounded)',
    mono: 'var(--font-mono)',
  },
});

export const Palette = {
  light: {
    background: '#FBF7F0',
    surface: '#FFFFFF',
    surfaceMuted: '#F2ECE2',
    border: '#E4DCCF',
    ink: '#1F1B16',
    inkSecondary: '#6B6258',
    primary: '#2F6B3F',
    onPrimary: '#FFFFFF',
    highlight: '#E9A23B',
    success: '#2F7D4F',
    warning: '#9A5B00',
    danger: '#B42318',
    info: '#2B6CB0',
  },
  dark: {
    background: '#14110E',
    surface: '#1E1A16',
    surfaceMuted: '#2A251F',
    border: '#3A332B',
    ink: '#F4EEE6',
    inkSecondary: '#A89D90',
    primary: '#8BCB9A',
    onPrimary: '#14110E',
    highlight: '#F2B451',
    success: '#6BC48F',
    warning: '#F2B451',
    danger: '#F97066',
    info: '#7FB2EA',
  },
} as const;

export type ColorScheme = keyof typeof Palette;
export type ColorToken = keyof typeof Palette.light;
export type ThemeColors = Record<ColorToken, string>;

type TypeStyle = Required<Pick<TextStyle, 'fontFamily' | 'fontSize' | 'fontWeight' | 'lineHeight'>>;

/** iOS Dynamic Type defaults (Large). Text scales with the user's setting; never disable it. */
export const Typography = {
  largeTitle: { fontFamily: Fonts.sans, fontSize: 34, fontWeight: '700', lineHeight: 41 },
  title: { fontFamily: Fonts.sans, fontSize: 22, fontWeight: '700', lineHeight: 28 },
  headline: { fontFamily: Fonts.sans, fontSize: 17, fontWeight: '600', lineHeight: 22 },
  body: { fontFamily: Fonts.sans, fontSize: 17, fontWeight: '400', lineHeight: 22 },
  callout: { fontFamily: Fonts.sans, fontSize: 16, fontWeight: '400', lineHeight: 21 },
  footnote: { fontFamily: Fonts.sans, fontSize: 13, fontWeight: '400', lineHeight: 18 },
  caption: { fontFamily: Fonts.sans, fontSize: 12, fontWeight: '500', lineHeight: 16 },
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
  /** inputs, list rows in groups */
  md: 12,
  /** cards */
  lg: 20,
  /** sheets, large buttons */
  xl: 28,
  /** pills, avatar, round icon buttons */
  full: 999,
} as const;

/** Fixed component sizes (tap targets, large buttons, list rows). */
export const Sizes = {
  minTapTarget: 44,
  largeButton: 64,
  rowMin: 48,
  icon: 17,
  iconSmall: 12,
} as const;

/** Motion: 200–300ms springs, no bounce loops (provisional). */
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

/** Soft shadow for floating controls (light mode only). Color comes from `primary`. */
export const Shadows = {
  floating: { shadowOffset: { width: 0, height: 4 }, shadowRadius: 6, shadowOpacity: Opacity.shadow },
} as const;
