import { describe, expect, it, jest } from '@jest/globals';

import { AisleColors, Palette, Rounded, Typography, type ColorScheme, type ColorToken } from '@/constants/theme';
import { contrastRatio } from '@/domain/contrast';

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
  ['danger', 'surface'],
  ['danger', 'background'],
  ['danger', 'dangerSoft'],
  ['pending', 'pendingSoft'],
  ['ink', 'pendingSoft'],
  ['onToast', 'toast'],
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
      danger: '#A33D53',
      dangerSoft: '#F7E1E6',
      pending: '#8A5C0C',
      pendingSoft: '#FFF7E6',
      scrim: '#C9D3C7',
      toast: '#1D2A22',
      onToast: '#FFFFFF',
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

describe('AisleColors', () => {
  it('has the Pantry light values', () => {
    expect(AisleColors.light).toEqual({
      green: { dot: '#2E6B45', soft: '#DDEFE2', strong: '#2E6B45' },
      blue: { dot: '#3E7BB8', soft: '#DFEAF6', strong: '#2F6396' },
      rose: { dot: '#C2556B', soft: '#F7E1E6', strong: '#A33D53' },
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

    it('keeps the Owner badge (pending on amber soft) readable', () => {
      expect(contrastRatio(Palette[scheme].pending, AisleColors[scheme].amber.soft)).toBeGreaterThanOrEqual(4.5);
    });
  });
});

describe('Typography', () => {
  it('uses the display face for titles and Figtree for the rest', () => {
    const display = ['hero', 'largeTitle', 'screenTitle', 'sheetTitle', 'title', 'tileCount', 'initial', 'sectionTitle'];
    for (const [name, style] of Object.entries(Typography)) {
      expect(style.fontFamily).toBe(display.includes(name) ? 'Bricolage Grotesque' : 'Figtree');
    }
  });

  it('has the redesign sizes and weights', () => {
    expect(Typography.largeTitle).toMatchObject({ fontSize: 40, fontWeight: '800', letterSpacing: -1 });
    expect(Typography.screenTitle).toMatchObject({ fontSize: 36, fontWeight: '800', letterSpacing: -0.9 });
    expect(Typography.sheetTitle).toMatchObject({ fontSize: 30, fontWeight: '800', letterSpacing: -0.75 });
    expect(Typography.title).toMatchObject({ fontSize: 28, fontWeight: '800', letterSpacing: -0.7 });
    expect(Typography.tileCount).toMatchObject({ fontSize: 34, fontWeight: '800', letterSpacing: -0.85 });
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

describe('Rounded', () => {
  it('has the Pantry radii', () => {
    expect(Rounded).toMatchObject({ card: 22, tile: 22, sheet: 28, row: 16, full: 999 });
  });
});
