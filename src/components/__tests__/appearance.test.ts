import { describe, expect, it, jest } from '@jest/globals';

import {
  badgeColors,
  checkAppearance,
  checkState,
  itemNameColor,
  listTileColors,
  pillColors,
  sectionHeaderLabel,
  segmentColors,
  siriMarkColors,
  toastAnnouncement,
} from '@/components/appearance';
import { AisleColors, Opacity, Palette, Sizes, type ColorScheme } from '@/constants/theme';
import { contrastRatio, mix } from '@/domain/contrast';

// The web font variables; Jest can't parse CSS.
jest.mock('@/global.css', () => ({}));

const SCHEMES: ColorScheme[] = ['light', 'dark'];

describe('checkState', () => {
  it('is off when unchecked and not sorting', () => {
    expect(checkState(false)).toBe('off');
    expect(checkState(false, false)).toBe('off');
  });

  it('is on when checked', () => {
    expect(checkState(true)).toBe('on');
  });

  it('is pending while sorting', () => {
    expect(checkState(false, true)).toBe('pending');
  });

  it('lets checked win over sorting', () => {
    expect(checkState(true, true)).toBe('on');
  });
});

describe('checkAppearance', () => {
  const colors = Palette.light;
  const aisles = AisleColors.light;

  it('is an empty controlBorder ring when off', () => {
    expect(checkAppearance('off', colors, aisles)).toEqual({
      fill: 'transparent',
      border: '#B9C4BC',
      borderStyle: 'solid',
      tick: null,
    });
  });

  it('is filled primary with an onPrimary tick when on', () => {
    expect(checkAppearance('on', colors, aisles)).toEqual({
      fill: '#2E6B45',
      border: '#2E6B45',
      borderStyle: 'solid',
      tick: 'onPrimary',
    });
  });

  it('is a dashed amber ring with no tick while sorting', () => {
    expect(checkAppearance('pending', colors, aisles)).toEqual({
      fill: 'transparent',
      border: '#C98A1E',
      borderStyle: 'dashed',
      tick: null,
    });
  });

  it('follows the dark scheme', () => {
    expect(checkAppearance('on', Palette.dark, AisleColors.dark).fill).toBe(Palette.dark.primary);
    expect(checkAppearance('off', Palette.dark, AisleColors.dark).border).toBe(Palette.dark.controlBorder);
    expect(checkAppearance('pending', Palette.dark, AisleColors.dark).border).toBe(AisleColors.dark.amber.dot);
  });

  it.each(SCHEMES)('keeps the tick readable on the fill in %s mode', (scheme) => {
    const look = checkAppearance('on', Palette[scheme], AisleColors[scheme]);
    expect(contrastRatio(Palette[scheme][look.tick!], look.fill)).toBeGreaterThanOrEqual(3);
  });

  it.each(SCHEMES)('keeps every ring visible on a white card and on the Sorting card in %s mode', (scheme) => {
    const colors = Palette[scheme];
    const aisles = AisleColors[scheme];
    const off = checkAppearance('off', colors, aisles).border;
    const pending = checkAppearance('pending', colors, aisles).border;
    // Non-text UI parts: WCAG 1.4.11 asks for 3:1, but the off ring is a deliberate soft outline.
    expect(contrastRatio(off, colors.surface)).toBeGreaterThan(1.5);
    expect(contrastRatio(pending, colors.pendingSoft)).toBeGreaterThanOrEqual(2);
  });
});

describe('pillColors', () => {
  it('is surface with ink text when off', () => {
    expect(pillColors(false)).toEqual({ fill: 'surface', text: 'ink' });
  });

  it('is an ink fill with white text when on', () => {
    expect(pillColors(true)).toEqual({ fill: 'toast', text: 'onToast' });
    expect(Palette.light.toast).toBe(Palette.light.ink);
    expect(Palette.light.onToast).toBe('#FFFFFF');
  });

  it.each(SCHEMES)('uses the ink colour for the on fill in %s mode', (scheme) => {
    expect(Palette[scheme].toast).toBe(Palette[scheme].ink);
  });

  it.each(SCHEMES)('keeps both states at 4.5:1 or better in %s mode', (scheme) => {
    const colors = Palette[scheme];
    for (const selected of [false, true]) {
      const { fill, text } = pillColors(selected);
      expect(contrastRatio(colors[text], colors[fill])).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each(SCHEMES)('makes the on pill stand out from the background in %s mode', (scheme) => {
    const colors = Palette[scheme];
    expect(contrastRatio(colors[pillColors(true).fill], colors.background)).toBeGreaterThanOrEqual(3);
  });
});

describe('segmentColors', () => {
  it('is a surface chip with ink text when selected', () => {
    expect(segmentColors(true)).toEqual({ fill: 'surface', text: 'ink' });
  });

  it('has no fill and secondary text when not selected', () => {
    expect(segmentColors(false)).toEqual({ fill: null, text: 'inkSecondary' });
  });

  it.each(SCHEMES)('keeps both labels at 4.5:1 or better in %s mode', (scheme) => {
    const colors = Palette[scheme];
    const on = segmentColors(true);
    const off = segmentColors(false);
    expect(contrastRatio(colors[on.text], colors[on.fill!])).toBeGreaterThanOrEqual(4.5);
    // An unselected segment sits on the surfaceMuted track.
    expect(contrastRatio(colors[off.text], colors.surfaceMuted)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('badgeColors', () => {
  it('uses onPrimarySoft on primarySoft for positive badges', () => {
    expect(badgeColors('positive', Palette.light, AisleColors.light)).toEqual({ fill: '#DDEFE2', text: '#1F5233' });
  });

  it('uses pending on the amber soft tint for Owner', () => {
    expect(badgeColors('owner', Palette.light, AisleColors.light)).toEqual({ fill: '#F6EBD4', text: '#8A5C0C' });
  });

  it('follows the dark scheme', () => {
    expect(badgeColors('positive', Palette.dark, AisleColors.dark)).toEqual({
      fill: Palette.dark.primarySoft,
      text: Palette.dark.onPrimarySoft,
    });
    expect(badgeColors('owner', Palette.dark, AisleColors.dark)).toEqual({
      fill: AisleColors.dark.amber.soft,
      text: Palette.dark.pending,
    });
  });

  it.each(SCHEMES)('keeps both tones at 4.5:1 or better in %s mode', (scheme) => {
    for (const tone of ['positive', 'owner'] as const) {
      const { fill, text } = badgeColors(tone, Palette[scheme], AisleColors[scheme]);
      expect(contrastRatio(text, fill)).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('the other primitives’ text pairs', () => {
  it.each(SCHEMES)('are readable in %s mode', (scheme) => {
    const c = Palette[scheme];
    // PrimaryButton, SoftDangerButton, the toast's Undo pill, the add bar's placeholder.
    expect(contrastRatio(c.onPrimary, c.primary)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(c.danger, c.dangerSoft)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(c.ink, c.surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(c.inkSecondary, c.surface)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(SCHEMES)('sets the toast’s Undo pill apart from the toast in %s mode', (scheme) => {
    expect(contrastRatio(Palette[scheme].surface, Palette[scheme].toast)).toBeGreaterThanOrEqual(3);
  });
});

describe('listTileColors', () => {
  it('fills the Siri default list primary', () => {
    expect(listTileColors(true)).toEqual({ fill: 'primary', text: 'onPrimary', secondary: 'onPrimary' });
  });

  it('makes other lists surface cards', () => {
    expect(listTileColors(false)).toEqual({ fill: 'surface', text: 'ink', secondary: 'inkSecondary' });
  });

  it.each(SCHEMES)('keeps the tile text at 4.5:1 or better in %s mode', (scheme) => {
    for (const isDefault of [true, false]) {
      const { fill, text, secondary } = listTileColors(isDefault);
      expect(contrastRatio(Palette[scheme][text], Palette[scheme][fill])).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(Palette[scheme][secondary], Palette[scheme][fill])).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each(SCHEMES)('sets the tiles apart from the ground in %s mode', (scheme) => {
    // The Siri tile is a solid block; the white tiles read as cards on the pale ground.
    expect(contrastRatio(Palette[scheme].primary, Palette[scheme].background)).toBeGreaterThanOrEqual(3);
  });
});

describe('siriMarkColors', () => {
  it('is onPrimary on a faint onPrimary wash', () => {
    // 0.12 × 255 = 30.6 → 31 → 1f.
    expect(siriMarkColors(Palette.light, 0.12)).toEqual({ fill: '#FFFFFF1f', text: '#FFFFFF' });
    expect(siriMarkColors(Palette.dark, 0.12)).toEqual({ fill: '#0E1F141f', text: '#0E1F14' });
  });

  it.each(SCHEMES)('keeps "Siri" at 4.5:1 or better over the Siri tile in %s mode', (scheme) => {
    const c = Palette[scheme];
    const { text } = siriMarkColors(c, Opacity.tint);
    const shown = mix(c.onPrimary, c.primary, Opacity.tint);
    expect(contrastRatio(text, shown)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('itemNameColor', () => {
  it('is ink until the item is checked off, then inkSecondary', () => {
    expect(itemNameColor(false)).toBe('ink');
    expect(itemNameColor(true)).toBe('inkSecondary');
  });

  it.each(SCHEMES)('keeps checked items readable as text on a card in %s mode', (scheme) => {
    expect(contrastRatio(Palette[scheme][itemNameColor(true)], Palette[scheme].surface)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('sizes', () => {
  it('has the lists home and card header sizes', () => {
    expect(Sizes).toMatchObject({ tile: 132, iconWell: 36 });
    // The recipe actions button reaches 44 pt with hit slop.
    expect((Sizes.minTapTarget - Sizes.iconWell) / 2).toBe(4);
  });

  it('has the board sizes', () => {
    expect(Sizes).toMatchObject({
      check: 24,
      checkBorder: 2,
      dot: 10,
      pill: 40,
      segment: 34,
      cta: 54,
      softButton: 48,
      bar: 52,
      barButton: 40,
      cardRowMin: 50,
    });
  });

  it('keeps every smaller control reachable with a 44 pt hit area', () => {
    // Pills and the 40 pt buttons get hit slop up to 44 pt; it must not be negative.
    expect((Sizes.minTapTarget - Sizes.pill) / 2).toBe(2);
    expect((Sizes.minTapTarget - Sizes.barButton) / 2).toBe(2);
    expect(Sizes.cta).toBeGreaterThanOrEqual(Sizes.minTapTarget);
    expect(Sizes.softButton).toBeGreaterThanOrEqual(Sizes.minTapTarget);
  });

  it('centres the 40 pt buttons inside the 52 pt bar', () => {
    expect((Sizes.bar - Sizes.barButton) / 2).toBe(6);
  });
});

describe('sectionHeaderLabel', () => {
  it('reads the name alone without a count', () => {
    expect(sectionHeaderLabel('Produce')).toBe('Produce');
  });

  it('reads the count with a plural', () => {
    expect(sectionHeaderLabel('Produce', 3)).toBe('Produce, 3 items');
  });

  it('reads one item in the singular', () => {
    expect(sectionHeaderLabel('Meat & seafood', 1)).toBe('Meat & seafood, 1 item');
  });

  it('reads zero as plural, not as no count', () => {
    expect(sectionHeaderLabel('Dairy & eggs', 0)).toBe('Dairy & eggs, 0 items');
  });

  it('keeps an accessibility name like the Sorting one', () => {
    expect(sectionHeaderLabel('Sorting, finding a section for these items', 2)).toBe(
      'Sorting, finding a section for these items, 2 items',
    );
  });
});

describe('toastAnnouncement', () => {
  it('announces the message and its action', () => {
    expect(toastAnnouncement('Deleted milk', ['Undo'])).toBe('Deleted milk. Undo available.');
  });

  it('lists two actions', () => {
    expect(toastAnnouncement('Added to milk, now 1 gal + 1', ['Undo', 'Keep existing'])).toBe(
      'Added to milk, now 1 gal + 1. Undo, Keep existing available.',
    );
  });

  it('announces only the message without actions', () => {
    expect(toastAnnouncement('Saved', [])).toBe('Saved');
  });
});
