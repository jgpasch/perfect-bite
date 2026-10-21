import { describe, expect, it, jest } from '@jest/globals';

import {
  AisleColors,
  FONT_SETS,
  FontSetSpecs,
  MealHues,
  Palette,
  PhotoScrim,
  Rounded,
  Typography,
  typographyFor,
  type ColorScheme,
  type ColorToken,
  type FontSet,
} from '@/constants/theme';
import { contrastRatio, mix } from '@/domain/contrast';
import { hueHeaderBand } from '@/components/appearance';
import { RECIPE_GROUP_SECTIONS } from '@/features/recipes/recipe-sort';

// The web font variables; Jest can't parse CSS.
jest.mock('@/global.css', () => ({}));

const SCHEMES: ColorScheme[] = ['light', 'dark'];

// Text on its ground: WCAG AA for body text.
const TEXT_PAIRS: [ColorToken, ColorToken][] = [
  ['ink', 'background'],
  ['ink', 'surface'],
  ['ink', 'surfaceMuted'],
  // An item row that matches the add text (add mode).
  ['ink', 'primarySoft'],
  ['inkSecondary', 'background'],
  ['inkSecondary', 'surface'],
  ['inkSecondary', 'surfaceMuted'],
  ['onPrimary', 'primary'],
  ['primary', 'surface'],
  ['primary', 'background'],
  ['onPrimarySoft', 'primarySoft'],
  ['onPrimarySoft', 'newBadge'],
  ['danger', 'surface'],
  ['danger', 'background'],
  ['danger', 'dangerSoft'],
  ['pending', 'pendingSoft'],
  ['pending', 'surface'],
  ['ink', 'pendingSoft'],
  ['onToast', 'toast'],
  // The list screen's green header: its title and the "7 to get · As added" line.
  ['onHeader', 'header'],
  ['onHeaderSecondary', 'header'],
];

describe('Palette', () => {
  it('has the Pantry light values from the redesign', () => {
    expect(Palette.light).toEqual({
      background: '#EEF3EC',
      surface: '#FFFFFF',
      surfaceMuted: '#DCE4DA',
      border: '#EEF1EC',
      controlBorder: '#B9C4BC',
      ink: '#1D2A22',
      inkSecondary: '#55635A',
      inkTertiary: '#7C877F',
      primary: '#2E6B45',
      onPrimary: '#FFFFFF',
      primarySoft: '#DDEFE2',
      onPrimarySoft: '#1F5233',
      newBadge: '#C3E3CC',
      danger: '#A33D53',
      dangerSoft: '#F7E1E6',
      pending: '#8A5C0C',
      pendingSoft: '#FFF7E6',
      scrim: '#C9D3C7',
      toast: '#1D2A22',
      onToast: '#FFFFFF',
      header: '#1F4D33',
      onHeader: '#FFFFFF',
      gold: '#E9BC5A',
      onHeaderSecondary: '#B7D2BF',
    });
  });

  it('has the same tokens in both schemes', () => {
    expect(Object.keys(Palette.dark).sort()).toEqual(Object.keys(Palette.light).sort());
  });

  it('uses #RRGGBB everywhere', () => {
    for (const scheme of SCHEMES) {
      for (const value of Object.values(Palette[scheme])) expect(value).toMatch(/^#[0-9A-F]{6}$/);
    }
  });

  describe.each(SCHEMES)('%s scheme', (scheme) => {
    it.each(TEXT_PAIRS)('%s on %s is at least 4.5:1', (fg, bg) => {
      expect(contrastRatio(Palette[scheme][fg], Palette[scheme][bg])).toBeGreaterThanOrEqual(4.5);
    });

    it('keeps inkTertiary at 3:1 or better on surfaces (icons only)', () => {
      expect(contrastRatio(Palette[scheme].inkTertiary, Palette[scheme].surface)).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(Palette[scheme].inkTertiary, Palette[scheme].background)).toBeGreaterThanOrEqual(3);
    });

    it('makes ink stand out more than inkSecondary', () => {
      const ink = Palette[scheme].ink;
      expect(contrastRatio(ink, Palette[scheme].surface)).toBeGreaterThan(
        contrastRatio(Palette[scheme].inkSecondary, Palette[scheme].surface),
      );
    });
  });

  it('is a dark scheme in dark mode', () => {
    expect(contrastRatio(Palette.dark.background, '#000000')).toBeLessThan(1.5);
    expect(contrastRatio(Palette.light.background, '#FFFFFF')).toBeLessThan(1.2);
  });
});

describe('PhotoScrim', () => {
  const parts = /^rgba\((\d+), (\d+), (\d+), (0?\.\d+)\)$/.exec(PhotoScrim.fill);
  const hex = (n: string) => Number(n).toString(16).padStart(2, '0').toUpperCase();
  const [, r, g, b, a] = parts ?? [];
  const fill = `#${hex(r)}${hex(g)}${hex(b)}`;
  const alpha = Number(a);

  it('is the board A band, rgba(20, 28, 23, 0.66), with white text', () => {
    expect(PhotoScrim).toEqual({ fill: 'rgba(20, 28, 23, 0.66)', text: '#FFFFFF' });
    expect(fill).toBe('#141C17');
    expect(alpha).toBe(0.66);
  });

  it('keeps white text at 4.5:1 or better over any photo, a white one at worst', () => {
    // Composited on white is the band at its lightest.
    expect(contrastRatio(PhotoScrim.text, mix(fill, '#FFFFFF', alpha))).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(PhotoScrim.text, mix(fill, '#000000', alpha))).toBeGreaterThanOrEqual(4.5);
  });

  it.each(SCHEMES)('also holds over every tile colour in the %s scheme (a recipe with no photo)', (scheme) => {
    for (const hue of Object.values(AisleColors[scheme])) {
      expect(contrastRatio(PhotoScrim.text, mix(fill, hue.soft, alpha))).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('would fail with a lighter band, so the check means something', () => {
    expect(contrastRatio(PhotoScrim.text, mix(fill, '#FFFFFF', 0.4))).toBeLessThan(4.5);
  });
});

describe('AisleColors', () => {
  it('has the Pantry light values', () => {
    expect(AisleColors.light).toEqual({
      green: { dot: '#2E6B45', soft: '#DDEFE2', strong: '#2E6B45' },
      teal: { dot: '#2A8C84', soft: '#DCEFEC', strong: '#1F6E68' },
      blue: { dot: '#3E7BB8', soft: '#DFEAF6', strong: '#2F6396' },
      plum: { dot: '#8A5BB0', soft: '#ECE3F5', strong: '#6E4594' },
      rose: { dot: '#C2556B', soft: '#F7E1E6', strong: '#A33D53' },
      orange: { dot: '#D0703A', soft: '#FAE4D6', strong: '#A04A1C' },
      amber: { dot: '#C98A1E', soft: '#F6EBD4', strong: '#8A5C0C' },
      grey: { dot: '#7C877F', soft: '#EEF3EC', strong: '#55635A' },
    });
  });

  it('has light dots too pale for white text, which is why `strong` exists', () => {
    expect(contrastRatio(Palette.light.onPrimary, AisleColors.light.blue.dot)).toBeLessThan(4.5);
    expect(contrastRatio(Palette.light.onPrimary, AisleColors.light.amber.dot)).toBeLessThan(4.5);
  });

  it('has every hue in dark mode too', () => {
    expect(Object.keys(AisleColors.dark).sort()).toEqual(Object.keys(AisleColors.light).sort());
  });

  describe.each(SCHEMES)('%s scheme', (scheme) => {
    it.each(Object.keys(AisleColors.light) as (keyof typeof AisleColors.light)[])(
      'keeps ink readable on the %s soft tint',
      (hue) => {
        const { ink, inkSecondary } = Palette[scheme];
        expect(contrastRatio(ink, AisleColors[scheme][hue].soft)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(inkSecondary, AisleColors[scheme][hue].soft)).toBeGreaterThanOrEqual(4.5);
      },
    );

    it.each(Object.keys(AisleColors.light) as (keyof typeof AisleColors.light)[])(
      'keeps onPrimary readable on the %s strong fill',
      (hue) => {
        expect(contrastRatio(Palette[scheme].onPrimary, AisleColors[scheme][hue].strong)).toBeGreaterThanOrEqual(4.5);
      },
    );

    it.each(Object.keys(AisleColors.light) as (keyof typeof AisleColors.light)[])(
      'keeps the %s strong digit readable on its soft circle (a Method step number)',
      (hue) => {
        expect(contrastRatio(AisleColors[scheme][hue].strong, AisleColors[scheme][hue].soft)).toBeGreaterThanOrEqual(4.5);
      },
    );

    it.each(
      Object.entries(RECIPE_GROUP_SECTIONS).flatMap(([group, sections]) => sections.map((s) => [group, s.key, s.hue] as const)),
    )('keeps the Recipes tab’s %s grouping’s %s section header (%s) readable on its band', (_group, _key, hue) => {
      const band = hueHeaderBand(hue, scheme);
      expect(band.ground).toBe(AisleColors[scheme][hue].soft);
      expect(contrastRatio(band.text, band.ground)).toBeGreaterThanOrEqual(4.5);
    });

    it.each(Object.keys(MealHues) as (keyof typeof MealHues)[])(
      'keeps the meal plan’s %s header, letter chip and badge readable',
      (meal) => {
        const tokens = AisleColors[scheme][MealHues[meal]];
        const band = hueHeaderBand(MealHues[meal], scheme);
        expect(band.ground).toBe(tokens.soft);
        expect(contrastRatio(band.text, band.ground)).toBeGreaterThanOrEqual(4.5);
        // A plan badge: white text on the meal's strong hue.
        expect(contrastRatio(Palette[scheme].onPrimary, tokens.strong)).toBeGreaterThanOrEqual(4.5);
      },
    );

    it('keeps the Owner badge (pending on amber soft) readable', () => {
      expect(contrastRatio(Palette[scheme].pending, AisleColors[scheme].amber.soft)).toBeGreaterThanOrEqual(4.5);
    });
  });
});

describe('Typography', () => {
  it('uses the display face for titles and Figtree for the rest', () => {
    const display = ['hero', 'largeTitle', 'screenTitle', 'sheetTitle', 'title', 'initial', 'sectionTitle'];
    for (const [name, style] of Object.entries(Typography)) {
      expect(style.fontFamily).toBe(display.includes(name) ? 'Bricolage Grotesque' : 'Figtree');
    }
  });

  it('has the redesign sizes and weights', () => {
    expect(Typography.largeTitle).toMatchObject({ fontSize: 40, fontWeight: '800', letterSpacing: -1 });
    expect(Typography.screenTitle).toMatchObject({ fontSize: 36, fontWeight: '800', letterSpacing: -0.9 });
    expect(Typography.sheetTitle).toMatchObject({ fontSize: 30, fontWeight: '800', letterSpacing: -0.75 });
    expect(Typography.title).toMatchObject({ fontSize: 28, fontWeight: '800', letterSpacing: -0.7 });
    expect(Typography.sectionTitle).toMatchObject({ fontSize: 17, fontWeight: '700' });
    expect(Typography.body).toMatchObject({ fontSize: 17, fontWeight: '500' });
    expect(Typography.amount).toMatchObject({ fontSize: 15, fontWeight: '600' });
    expect(Typography.sectionLabel).toMatchObject({ fontSize: 13, fontWeight: '700' });
    expect(Typography.caption).toMatchObject({ fontSize: 12, fontWeight: '700' });
    expect(Typography.hero).toMatchObject({ fontSize: 48, fontWeight: '800', letterSpacing: -1.2 });
    expect(Typography.lead).toMatchObject({ fontSize: 18, fontWeight: '400' });
    expect(Typography.initial).toMatchObject({ fontSize: 20, fontWeight: '800' });
  });

  it('only uses embedded weights (display 500–800, body 400–700)', () => {
    for (const style of Object.values(Typography)) {
      const weight = Number(style.fontWeight);
      const [min, max] = style.fontFamily === 'Bricolage Grotesque' ? [500, 800] : [400, 700];
      expect(weight).toBeGreaterThanOrEqual(min);
      expect(weight).toBeLessThanOrEqual(max);
    }
  });

  it('gives every style a line height at least as tall as its size', () => {
    for (const style of Object.values(Typography)) expect(style.lineHeight).toBeGreaterThanOrEqual(style.fontSize);
  });
});

type FontPlugin = {
  ios: { fonts: string[] };
  android: { fonts: { fontFamily: string; fontDefinitions: { path: string; weight: number }[] }[] };
};
const fontPlugin = (require('../../../app.json').expo.plugins as unknown[]).find(
  (p): p is [string, FontPlugin] => Array.isArray(p) && p[0] === 'expo-font',
)![1];
// The weight in an @expo-google-fonts file name: ".../fraunces/600SemiBold/Fraunces_600SemiBold.ttf".
const IOS_FAMILY_DIRS: Record<string, string> = {
  'Bricolage Grotesque': 'bricolage-grotesque',
  Figtree: 'figtree',
  Fraunces: 'fraunces',
  'Young Serif': 'young-serif',
  'Instrument Sans': 'instrument-sans',
  'Plus Jakarta Sans': 'plus-jakarta-sans',
  Nunito: 'nunito',
  'Nunito Sans': 'nunito-sans',
};

/** The weights app.json embeds for a family, lowest first. */
function embeddedWeights(platform: 'ios' | 'android', family: string): number[] {
  if (platform === 'android') {
    const entry = fontPlugin.android.fonts.find((f) => f.fontFamily === family);
    return (entry?.fontDefinitions ?? []).map((d) => d.weight).sort((a, b) => a - b);
  }
  const dir = `/@expo-google-fonts/${IOS_FAMILY_DIRS[family]}/`;
  return fontPlugin.ios.fonts
    .filter((path) => path.includes(dir))
    .map((path) => Number(/\/(\d{3})[A-Za-z]+\//.exec(path)![1]))
    .sort((a, b) => a - b);
}

describe('typographyFor (the font trial)', () => {
  const DISPLAY = ['hero', 'largeTitle', 'screenTitle', 'sheetTitle', 'title', 'initial', 'sectionTitle'];
  const TITLES = ['hero', 'largeTitle', 'screenTitle', 'sheetTitle', 'title'] as const;
  // Each set's families, weights and tracking (em), and the weights app.json embeds for it.
  const SETS: Record<
    FontSet,
    { display: string; body: string; title: string; sectionTitle: string; tracking: number; displayWeights: number[]; bodyWeights: number[] }
  > = {
    bricolage: { display: 'Bricolage Grotesque', body: 'Figtree', title: '800', sectionTitle: '700', tracking: -0.025, displayWeights: [500, 600, 700, 800], bodyWeights: [400, 500, 600, 700] },
    fraunces: { display: 'Fraunces', body: 'Figtree', title: '700', sectionTitle: '600', tracking: -0.01, displayWeights: [600, 700], bodyWeights: [400, 500, 600, 700] },
    youngSerif: { display: 'Young Serif', body: 'Instrument Sans', title: '400', sectionTitle: '400', tracking: -0.01, displayWeights: [400], bodyWeights: [400, 500, 600, 700] },
    jakarta: { display: 'Plus Jakarta Sans', body: 'Plus Jakarta Sans', title: '800', sectionTitle: '700', tracking: -0.03, displayWeights: [400, 500, 600, 700, 800], bodyWeights: [400, 500, 600, 700, 800] },
    nunito: { display: 'Nunito', body: 'Nunito Sans', title: '900', sectionTitle: '800', tracking: -0.02, displayWeights: [800, 900], bodyWeights: [400, 500, 600, 700] },
  };

  it('has the five sets, bricolage first', () => {
    expect(FONT_SETS).toEqual(['bricolage', 'fraunces', 'youngSerif', 'jakarta', 'nunito']);
  });

  it('keeps Typography as the bricolage set', () => {
    expect(typographyFor('bricolage')).toBe(Typography);
  });

  for (const set of FONT_SETS) {
    describe(set, () => {
      const spec = SETS[set];
      const type = typographyFor(set);

      it('uses its display face for titles and its body face for the rest', () => {
        for (const [name, style] of Object.entries(type)) {
          expect([name, style.fontFamily]).toEqual([name, DISPLAY.includes(name) ? spec.display : spec.body]);
        }
      });

      it('sets titles, initial and section titles at its weights, the body styles as today', () => {
        for (const name of [...TITLES, 'initial'] as const) expect(type[name].fontWeight).toBe(spec.title);
        expect(type.sectionTitle.fontWeight).toBe(spec.sectionTitle);
        for (const name of Object.keys(type).filter((n) => !DISPLAY.includes(n)) as (keyof typeof type)[]) {
          expect(type[name].fontWeight).toBe(Typography[name].fontWeight);
        }
      });

      it('tracks titles by its em', () => {
        for (const name of TITLES) {
          expect(type[name].letterSpacing).toBeCloseTo(type[name].fontSize * spec.tracking, 2);
        }
        expect(type.initial).not.toHaveProperty('letterSpacing');
        expect(type.sectionTitle).not.toHaveProperty('letterSpacing');
      });

      it("keeps today's sizes and line heights", () => {
        for (const [name, style] of Object.entries(type)) {
          const today = Typography[name as keyof typeof Typography];
          expect([name, style.fontSize, style.lineHeight]).toEqual([name, today.fontSize, today.lineHeight]);
        }
      });

      it('embeds exactly the listed weights in app.json, on iOS and Android, and uses only those', () => {
        expect(embeddedWeights('android', spec.display)).toEqual(spec.displayWeights);
        expect(embeddedWeights('android', spec.body)).toEqual(spec.bodyWeights);
        expect(embeddedWeights('ios', spec.display)).toEqual(spec.displayWeights);
        expect(embeddedWeights('ios', spec.body)).toEqual(spec.bodyWeights);
        for (const style of Object.values(type)) {
          const embedded = style.fontFamily === spec.display ? spec.displayWeights : spec.bodyWeights;
          expect(embedded).toContain(Number(style.fontWeight));
        }
      });

      it('names the same families as FontSetSpecs', () => {
        expect(FontSetSpecs[set]).toMatchObject({ display: spec.display, body: spec.body });
      });
    });
  }

  it('gives the exact title tracking for the trial sets', () => {
    expect(typographyFor('fraunces').largeTitle.letterSpacing).toBe(-0.4);
    expect(typographyFor('nunito').hero.letterSpacing).toBe(-0.96);
    expect(typographyFor('jakarta').title.letterSpacing).toBe(-0.84);
    expect(typographyFor('youngSerif').screenTitle.letterSpacing).toBe(-0.36);
  });
});

describe('Rounded', () => {
  it('has the Pantry radii', () => {
    expect(Rounded).toMatchObject({ card: 22, sheet: 28, row: 16, full: 999 });
  });
});
