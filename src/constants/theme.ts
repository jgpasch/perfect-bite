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
    /** The list screen's forest-green header, behind the status bar. */
    header: '#1F4D33',
    onHeader: '#FFFFFF',
    /** The cloche's gold, for "Perfect" in the sign-in title on the header green. */
    gold: '#E9BC5A',
    /** "7 to get · As added" on the header. */
    onHeaderSecondary: '#B7D2BF',
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
    header: '#163A26',
    onHeader: '#FFFFFF',
    gold: '#E9BC5A',
    onHeaderSecondary: '#A9C8B3',
  },
} as const;

export type ColorScheme = keyof typeof Palette;
export type ColorToken = keyof typeof Palette.light;
export type ThemeColors = Record<ColorToken, string>;

/**
 * Aisle colours (see `aisleColor` in src/domain): `dot` for section dots, `soft` for tints, and
 * `strong` for fills that carry `onPrimary` text (the selected aisle pill), since most light dots
 * are too pale for white text.
 */
export const AisleColors = {
  light: {
    green: { dot: '#2E6B45', soft: '#DDEFE2', strong: '#2E6B45' },
    teal: { dot: '#2A8C84', soft: '#DCEFEC', strong: '#1F6E68' },
    blue: { dot: '#3E7BB8', soft: '#DFEAF6', strong: '#2F6396' },
    plum: { dot: '#8A5BB0', soft: '#ECE3F5', strong: '#6E4594' },
    rose: { dot: '#C2556B', soft: '#F7E1E6', strong: '#A33D53' },
    orange: { dot: '#D0703A', soft: '#FAE4D6', strong: '#A04A1C' },
    amber: { dot: '#C98A1E', soft: '#F6EBD4', strong: '#8A5C0C' },
    grey: { dot: '#7C877F', soft: '#EEF3EC', strong: '#55635A' },
  },
  dark: {
    green: { dot: '#6FBF8A', soft: '#1E3A28', strong: '#6FBF8A' },
    teal: { dot: '#5FC4B8', soft: '#163633', strong: '#5FC4B8' },
    blue: { dot: '#7AAEE0', soft: '#1B2D3F', strong: '#7AAEE0' },
    plum: { dot: '#B996E0', soft: '#2E2240', strong: '#B996E0' },
    rose: { dot: '#E58A9C', soft: '#3B1E26', strong: '#E58A9C' },
    orange: { dot: '#EE9762', soft: '#3A2416', strong: '#EE9762' },
    amber: { dot: '#E3AE4E', soft: '#33290F', strong: '#E3AE4E' },
    grey: { dot: '#8E9A91', soft: '#26302A', strong: '#8E9A91' },
  },
} as const satisfies Record<ColorScheme, Record<AisleHue, { dot: string; soft: string; strong: string }>>;

/**
 * The meal plan's fixed hue per meal (spec 4.16): column headers, letter chips and plan badges use the hue's
 * `soft` and `strong` from `AisleColors`.
 */
export const MealHues = {
  breakfast: 'amber',
  lunch: 'teal',
  dinner: 'plum',
} as const satisfies Record<'breakfast' | 'lunch' | 'dinner', AisleHue>;

type TypeStyle = Required<Pick<TextStyle, 'fontFamily' | 'fontSize' | 'fontWeight' | 'lineHeight'>> &
  Pick<TextStyle, 'letterSpacing'>;

/**
 * The font trial's sets (DESIGN.md Fonts), picked per device in Settings > Design trials > Fonts.
 * `bricolage` is today's and the default.
 */
export const FONT_SETS = ['bricolage', 'fraunces', 'youngSerif', 'jakarta', 'nunito'] as const;
export type FontSet = (typeof FONT_SETS)[number];

type FontSetSpec = {
  /** The family names the `expo-font` config plugin registers them under in app.json. */
  display: string;
  body: string;
  /** The weight of the titles (`hero` to `title`, and `initial`), and of `sectionTitle`. */
  titleWeight: TextStyle['fontWeight'] & string;
  sectionTitleWeight: TextStyle['fontWeight'] & string;
  /** The titles' tracking, in em. */
  tracking: number;
};

export const FontSetSpecs = {
  bricolage: { display: 'Bricolage Grotesque', body: 'Figtree', titleWeight: '800', sectionTitleWeight: '700', tracking: -0.025 },
  fraunces: { display: 'Fraunces', body: 'Figtree', titleWeight: '700', sectionTitleWeight: '600', tracking: -0.01 },
  youngSerif: { display: 'Young Serif', body: 'Instrument Sans', titleWeight: '400', sectionTitleWeight: '400', tracking: -0.01 },
  jakarta: { display: 'Plus Jakarta Sans', body: 'Plus Jakarta Sans', titleWeight: '800', sectionTitleWeight: '700', tracking: -0.03 },
  nunito: { display: 'Nunito', body: 'Nunito Sans', titleWeight: '900', sectionTitleWeight: '800', tracking: -0.02 },
} as const satisfies Record<FontSet, FontSetSpec>;

/** Today's set keeps the web's CSS variables (global.css); the trial's other sets name the family. */
function familiesFor(set: FontSet): { display: string; body: string } {
  if (set === 'bricolage') return Fonts;
  return { display: FontSetSpecs[set].display, body: FontSetSpecs[set].body };
}

function buildTypography(set: FontSet) {
  const { titleWeight: w, sectionTitleWeight, tracking } = FontSetSpecs[set];
  const { display, body } = familiesFor(set);
  /** Display titles track tight (by the set's `tracking`). */
  const tight = (size: number) => Math.round(size * tracking * 100) / 100;
  /** Sizes are at the default Dynamic Type setting (Large). Text scales with the user's setting; never disable it. */
  return {
    /** The app's name on the sign-in screen. */
    hero: { fontFamily: display, fontSize: 48, fontWeight: w, lineHeight: 50, letterSpacing: tight(48) },
    /** Tab roots: "Recipes", "Settings". */
    largeTitle: { fontFamily: display, fontSize: 40, fontWeight: w, lineHeight: 44, letterSpacing: tight(40) },
    /** Pushed screens: a list's name, "Aisle order". */
    screenTitle: { fontFamily: display, fontSize: 36, fontWeight: w, lineHeight: 40, letterSpacing: tight(36) },
    /** Sheet titles: the item's name. */
    sheetTitle: { fontFamily: display, fontSize: 30, fontWeight: w, lineHeight: 34, letterSpacing: tight(30) },
    title: { fontFamily: display, fontSize: 28, fontWeight: w, lineHeight: 32, letterSpacing: tight(28) },
    /** The letter in a round avatar (account card, household members). */
    initial: { fontFamily: display, fontSize: 20, fontWeight: w, lineHeight: 24 },
    /** Card section headers: aisle or recipe name. */
    sectionTitle: { fontFamily: display, fontSize: 17, fontWeight: sectionTitleWeight, lineHeight: 22 },
    /** Buttons and emphasised rows. */
    headline: { fontFamily: body, fontSize: 17, fontWeight: '700', lineHeight: 22 },
    /** The sign-in tagline. */
    lead: { fontFamily: body, fontSize: 18, fontWeight: '400', lineHeight: 25 },
    body: { fontFamily: body, fontSize: 17, fontWeight: '500', lineHeight: 22 },
    /** An unchecked item's name on the list screen. */
    itemName: { fontFamily: body, fontSize: 17, fontWeight: '600', lineHeight: 22 },
    /** A step's text and an ingredient's name on the cook screen, big enough to read from the counter. */
    cookStep: { fontFamily: body, fontSize: 20, fontWeight: '500', lineHeight: 28 },
    /** The current step's text on the cook screen: `cookStep` at 600. */
    cookStepCurrent: { fontFamily: body, fontSize: 20, fontWeight: '600', lineHeight: 28 },
    callout: { fontFamily: body, fontSize: 16, fontWeight: '500', lineHeight: 21 },
    /** Quantities and values at the end of a row. */
    amount: { fontFamily: body, fontSize: 15, fontWeight: '600', lineHeight: 20 },
    /** A recipe's notes in its header band. */
    subhead: { fontFamily: body, fontSize: 15, fontWeight: '400', lineHeight: 20 },
    /** Labels above a card ("Members", "Added") and household names above tiles. */
    sectionLabel: { fontFamily: body, fontSize: 13, fontWeight: '700', lineHeight: 18 },
    footnote: { fontFamily: body, fontSize: 13, fontWeight: '400', lineHeight: 18 },
    /** Badges and small all-caps labels. */
    caption: { fontFamily: body, fontSize: 12, fontWeight: '700', lineHeight: 16 },
  } satisfies Record<string, TypeStyle>;
}

export type TypographyTokens = ReturnType<typeof buildTypography>;
export type TypographyVariant = keyof TypographyTokens;

const typographyBySet = Object.fromEntries(FONT_SETS.map((set) => [set, buildTypography(set)])) as Record<
  FontSet,
  TypographyTokens
>;

/** The type scale in a font set: the same sizes and line heights in every set, its own families, weights and tracking. */
export function typographyFor(set: FontSet): TypographyTokens {
  return typographyBySet[set];
}

/** Today's type scale (the `bricolage` set). Screens read the device's set through `useTheme().typography`. */
export const Typography = typographyFor('bricolage');

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
  /** the list screen's view button pill (its hit area is still 44) */
  viewButton: 32,
  /** the round − and + in a `Stepper`, and the track's inset around them */
  stepperButton: 34,
  stepperInset: 3,
  /** the larger `Stepper` buttons on Add to list's servings card */
  stepperButtonLarge: 40,
  /** primary CTA */
  cta: 54,
  /** soft destructive button */
  softButton: 48,
  /** the floating tab bar's pill and the round + beside it */
  tabBar: 62,
  /** a stacked `SurfaceButton`'s width (the recipe dock's Cook and Plan) */
  stackedButton: 64,
  /** add bar input and the toast */
  bar: 52,
  /** the recipe Ingredients card's Add ingredient row, a minimum */
  addRow: 52,
  /** the round + inside the add bar, and the toast's Undo pill */
  barButton: 40,
  /** focus ring around the add bar */
  focusRing: 2,
  /** a recipe chip's outline in the add bar's suggestion row */
  chipBorder: 1,
  /** the dot on that chevron while an invite is waiting, and its ring in the header colour */
  inviteDot: 10,
  inviteDotRing: 2,
  /** a list's colour dot in the Your lists sheet */
  listDot: 12,
  /** a colour swatch in the Edit list sheet; the chosen one is ringed (`focusRing`) a ring's width out */
  swatch: 32,
  /** a recipe's tinted icon tile in a section header, and round actions buttons in a card header */
  iconWell: 36,
  /** the item's icon tile beside its name at the top of the item sheet */
  sheetIcon: 52,
  /** the item sheet's dashed Add photo tile (its height, a minimum, for Dynamic Type) */
  itemPhotoTile: 64,
  /** the round … button on an item's photo; give it `hitSlop` up to 44 */
  itemPhotoMore: 32,
  /** a recipe's photo (or tinted icon tile) at the start of its row in the Recipes tab */
  recipeTile: 48,
  /** a tile's width on a Recipes tab shelf (This week, Recently added, Favorites) */
  shelfTile: 140,
  /** a page's thumbnail (its width; 3:4) in the import sheet for a photo import */
  importPageThumb: 72,
  /** small round remove buttons (the item sheet's "Added" rows); give them `hitSlop` up to 44 */
  removeButton: 32,
  /** who made each add on the item sheet's "Added" rows: a member's initial, or a recipe's or Siri's tile */
  addedAvatar: 24,
  /** the overlapping avatars in the "Added by" row under the item's name, ringed in `background` */
  addedByAvatar: 22,
  addedByAvatarRing: 2,
  addedByAvatarOverlap: 6,
  /** the label column of a field row inside a card (Name / Amount / Note); a minimum, for Dynamic Type */
  fieldLabel: 76,
  /** the tinted icon tile at the start of a settings row */
  settingsIcon: 32,
  /** the account card's avatar */
  accountAvatar: 52,
  /** household member avatars (overlapping) and the ring that separates them */
  avatar: 48,
  avatarRing: 3,
  /** the avatar in the list header's "Alex is adding" pill (spec 4.1) */
  presenceAvatar: 24,
  /** the pulsing dots after "Alex is adding" */
  presenceDot: 4,
  /** the cloche on the sign-in screen, at its largest (its glow spreads past this) */
  signInHero: 270,
  /** a row on the Aisle order screen (a minimum, for Dynamic Type), and its drag grip */
  aisleRow: 52,
  grip: 20,
  /** the numbered circle before each step in a recipe's Method card */
  stepNumber: 26,
  /** the numbered circle before each step on the cook screen, which fills with a check when ticked */
  cookStepCheck: 30,
  /** the check on an ingredient row under a step on the cook screen */
  cookIngredientCheck: 22,
  /** the `primary` border around the cook screen's current step card */
  cookCurrentBorder: 2,
  /** The week grid (spec 4.16): the day column, a cell's height and its recipe tile (minimums, for Dynamic Type) */
  planDayColumn: 52,
  planCell: 64,
  planTile: 24,
  /** a recipe or note cell in the grid's photo style, the photo filling it (a minimum, for Dynamic Type) */
  planPhotoCell: 84,
  /** a cell in the grid's expand style, its photo a 4:3 strip across the top (a minimum, for Dynamic Type) */
  planExpandCell: 104,
  /** the photo on an open day's row in the expand style (4:3, so 57 pt tall); its rows are at least `planCell` */
  planOpenPhoto: 76,
  /** a grid column's width once the grid scrolls sideways at large text sizes */
  planScrollColumn: 160,
  /** a meal's letter chip in the agenda */
  mealChip: 24,
  /** an empty slot's dashed outline */
  dashedBorder: 1.5,
} as const;

/** Motion: 200–300ms springs, no bounce loops. */
export const Motion = {
  duration: 250,
  spring: { damping: 20, stiffness: 220, mass: 1 },
  /** Opening and folding a card's section: a near-critical spring, so the height settles without a visible gap. */
  fold: { duration: 300, dampingRatio: 0.9 },
  /** A row's NEW badge (spec 4.1) stays this long after the row is first in sight, then fades out over `duration`. */
  newBadgeMs: 10_000,
  /** The list header's "Alex is adding" pill fading in and out (spec 4.1). */
  presenceFadeMs: 200,
  /** One pulse of its dots (each dot dims and brightens again over this long, a third apart). */
  presencePulseMs: 900,
  /** Undo toasts (spec 4.2, 4.4). */
  undoTimeoutMs: 5000,
  /** In-app notification banners (spec 4.11). */
  notificationTimeoutMs: 6000,
} as const;

/** A photo's shape in the plan grid's expand style: the cells' strips and the open day's rows (spec 4.16). */
export const PLAN_PHOTO_ASPECT = 4 / 3;

/** Opacity tokens: tints (12%), shadows (25%), pressed and disabled states. */
export const Opacity = {
  tint: 0.12,
  shadow: 0.25,
  pressed: 0.85,
  disabled: 0.4,
  /** The `scrim` behind a sheet the app draws itself (the one-time push prompt), so the screen shows through. */
  scrim: 0.6,
} as const;

/**
 * The band under a recipe's name on its photo (the plan grid's photo style, spec 4.16). It's the same in
 * both schemes, as it sits on a photo rather than on the screen, and so is its white text.
 */
export const PhotoScrim = {
  fill: 'rgba(20, 28, 23, 0.66)',
  text: '#FFFFFF',
} as const;

/**
 * The full-screen photo viewer (an item's photo, spec 4.4; a recipe's original pages, 4.5): black behind
 * the photo in both schemes. The pages screen's top bar and dots draw on it in white.
 */
export const PhotoViewer = {
  background: '#000000',
  text: '#FFFFFF',
  /** The page count under the title. */
  textSecondary: 'rgba(255, 255, 255, 0.72)',
  /** The round ✕ and … buttons. */
  button: 'rgba(255, 255, 255, 0.16)',
  dot: '#FFFFFF',
  dotInactive: 'rgba(255, 255, 255, 0.35)',
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
  /** A row being dragged on the Aisle order screen. */
  lifted: { shadowOffset: { width: 0, height: 14 }, shadowRadius: 30, shadowOpacity: 0.22 },
} as const;
