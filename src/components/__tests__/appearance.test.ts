import { describe, expect, it, jest } from '@jest/globals';

import {
  addBarButton,
  aisleRowLook,
  cardLook,
  aisleHeaderBand,
  aisleSymbol,
  avatarColors,
  badgeColors,
  categoryColors,
  listHeaderColors,
  householdBandColors,
  signInColors,
  checkAppearance,
  checkState,
  itemNameColor,
  listRowLook,
  pillColors,
  pillLook,
  prominentButtonTint,
  RECIPE_TAG_WASH,
  recipeTagPillColors,
  sectionHeaderLabel,
  segmentColors,
  toastAnnouncement,
} from '@/components/appearance';
import { AisleColors, Palette, Sizes, Spacing, type ColorScheme } from '@/constants/theme';
import { contrastRatio, mix } from '@/domain/contrast';
import { SYSTEM_CATEGORIES } from '@/shared/seed/categories';

// The web font variables; Jest can't parse CSS.
jest.mock('@/global.css', () => ({}));

const SCHEMES: ColorScheme[] = ['light', 'dark'];

describe('cardLook', () => {
  it('is a white card with the 22 pt radius, 16 pt in from the edge, in light mode', () => {
    expect(cardLook('surface', Palette.light)).toEqual({ backgroundColor: '#FFFFFF', borderRadius: 22, marginHorizontal: 16 });
  });

  it('uses the dark surface in dark mode, with the same shape', () => {
    expect(cardLook('surface', Palette.dark)).toEqual({ backgroundColor: '#1B241F', borderRadius: 22, marginHorizontal: 16 });
  });

  it('takes another ground without changing its shape (the Sorting… card)', () => {
    expect(cardLook('pendingSoft', Palette.light)).toEqual({ backgroundColor: '#FFF7E6', borderRadius: 22, marginHorizontal: 16 });
  });

  it.each(SCHEMES)('never goes edge to edge or square in %s mode', (scheme) => {
    const look = cardLook('surface', Palette[scheme]);
    expect(look.borderRadius).toBeGreaterThan(0);
    expect(look.marginHorizontal).toBe(Spacing.lg);
  });
});

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

describe('pillLook', () => {
  const colors = Palette.light;
  const aisles = AisleColors.light;

  it('matches pillColors without a hue', () => {
    expect(pillLook({}, colors, aisles)).toEqual({ fill: '#FFFFFF', text: '#1D2A22', border: null });
    expect(pillLook({ selected: true }, colors, aisles)).toEqual({ fill: '#1D2A22', text: '#FFFFFF', border: null });
  });

  it('fills a selected aisle pill with its strong shade and onPrimary text', () => {
    expect(pillLook({ selected: true, hue: 'blue' }, colors, aisles)).toEqual({
      fill: '#2F6396',
      text: '#FFFFFF',
      border: null,
    });
    expect(pillLook({ selected: true, hue: 'amber' }, Palette.dark, AisleColors.dark)).toEqual({
      fill: AisleColors.dark.amber.dot,
      text: Palette.dark.onPrimary,
      border: null,
    });
  });

  it('leaves an unselected aisle pill white', () => {
    expect(pillLook({ selected: false, hue: 'rose' }, colors, aisles)).toEqual({
      fill: '#FFFFFF',
      text: '#1D2A22',
      border: null,
    });
  });

  it('draws a dashed pill as a controlBorder outline with secondary text, even if selected', () => {
    const dashed = { fill: 'transparent', text: '#55635A', border: '#B9C4BC' };
    expect(pillLook({ dashed: true }, colors, aisles)).toEqual(dashed);
    expect(pillLook({ dashed: true, selected: true, hue: 'green' }, colors, aisles)).toEqual(dashed);
  });
});

describe('aisleSymbol', () => {
  it.each(SYSTEM_CATEGORIES.map((c) => c.slug))('has a glyph for %s', (slug) => {
    expect(aisleSymbol(slug)).toEqual(expect.any(String));
  });

  it('maps known aisles to their glyphs', () => {
    expect(aisleSymbol('produce')).toBe('carrot');
    expect(aisleSymbol('dairy-eggs')).toBe('waterbottle');
    expect(aisleSymbol('frozen')).toBe('snowflake');
    expect(aisleSymbol('other')).toBe('bag');
  });

  it('falls back to a bag for custom, missing and prototype-named slugs', () => {
    expect(aisleSymbol('my-corner-shop')).toBe('bag');
    expect(aisleSymbol(null)).toBe('bag');
    expect(aisleSymbol(undefined)).toBe('bag');
    expect(aisleSymbol('')).toBe('bag');
    expect(aisleSymbol('toString')).toBe('bag');
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

describe('recipe header band (board 06)', () => {
  const HUES = ['green', 'blue', 'rose', 'amber'] as const;

  it.each(SCHEMES)('keeps the title, link and placeholders at 4.5:1 or better on every recipe tint in %s mode', (scheme) => {
    const colors = Palette[scheme];
    for (const hue of HUES) {
      const tint = AisleColors[scheme][hue];
      expect(contrastRatio(colors.ink, tint.soft)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(tint.strong, tint.soft)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(colors.inkSecondary, tint.soft)).toBeGreaterThanOrEqual(4.5);
    }
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

  it('uses pending on pendingSoft and danger on dangerSoft for sync states', () => {
    expect(badgeColors('pending', Palette.light, AisleColors.light)).toEqual({ fill: '#FFF7E6', text: '#8A5C0C' });
    expect(badgeColors('danger', Palette.light, AisleColors.light)).toEqual({ fill: '#F7E1E6', text: '#A33D53' });
    expect(badgeColors('pending', Palette.dark, AisleColors.dark)).toEqual({ fill: Palette.dark.pendingSoft, text: Palette.dark.pending });
    expect(badgeColors('danger', Palette.dark, AisleColors.dark)).toEqual({ fill: Palette.dark.dangerSoft, text: Palette.dark.danger });
  });

  it.each(SCHEMES)('keeps every tone at 4.5:1 or better in %s mode', (scheme) => {
    for (const tone of ['positive', 'owner', 'pending', 'danger'] as const) {
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

describe('listRowLook', () => {
  const HUES = ['green', 'blue', 'rose', 'amber', 'grey'] as const;

  it('is a surface row with ink text when not current', () => {
    expect(listRowLook(false, false, 'blue', Palette.light, AisleColors.light)).toEqual({
      fill: '#FFFFFF',
      text: 'ink',
      secondary: 'inkSecondary',
      dot: AisleColors.light.blue.dot,
      ring: null,
    });
  });

  it('tints the current row primarySoft with onPrimarySoft text', () => {
    expect(listRowLook(true, false, 'rose', Palette.light, AisleColors.light)).toEqual({
      fill: '#DDEFE2',
      text: 'onPrimarySoft',
      secondary: 'onPrimarySoft',
      dot: AisleColors.light.rose.dot,
      ring: null,
    });
    expect(listRowLook(true, false, null, Palette.dark, AisleColors.dark).fill).toBe(Palette.dark.primarySoft);
  });

  it('gives the Siri default list a primary dot while its colour is Default', () => {
    expect(listRowLook(false, true, null, Palette.light, AisleColors.light)).toMatchObject({ dot: Palette.light.primary, ring: null });
    expect(listRowLook(true, true, null, Palette.dark, AisleColors.dark)).toMatchObject({ dot: Palette.dark.primary, ring: null });
  });

  it('lets a coloured Siri list keep its hue dot', () => {
    expect(listRowLook(false, true, 'amber', Palette.light, AisleColors.light)).toMatchObject({
      dot: AisleColors.light.amber.dot,
      ring: null,
    });
  });

  it('draws a hollow controlBorder ring for a Default list that is not the Siri list', () => {
    expect(listRowLook(false, false, null, Palette.light, AisleColors.light)).toMatchObject({ dot: null, ring: '#B9C4BC' });
    expect(listRowLook(true, false, null, Palette.dark, AisleColors.dark)).toMatchObject({
      dot: null,
      ring: Palette.dark.controlBorder,
    });
  });

  it.each(SCHEMES)('keeps the row text at 4.5:1 or better, current or not, in %s mode', (scheme) => {
    const c = Palette[scheme];
    for (const current of [true, false]) {
      for (const hue of [null, ...HUES]) {
        const { fill, text, secondary } = listRowLook(current, false, hue, c, AisleColors[scheme]);
        expect(contrastRatio(c[text], fill)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(c[secondary], fill)).toBeGreaterThanOrEqual(4.5);
      }
    }
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
  it('has the card header and Your lists sheet sizes', () => {
    expect(Sizes).toMatchObject({ iconWell: 36, inviteDot: 10, inviteDotRing: 2, listDot: 12 });
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

  it('grows the 24 pt check to 44 pt with hit slop that stays inside the item row', () => {
    const slop = (Sizes.minTapTarget - Sizes.check) / 2;
    expect(slop).toBe(10);
    // The row has lg padding before the check and an md gap after it, so the slop never reaches the
    // row's edge or the name beside it, and a 50 pt row has room for it above and below.
    expect(slop).toBeLessThanOrEqual(Spacing.lg);
    expect(slop).toBeLessThan(Spacing.md);
    expect(Sizes.check + 2 * slop).toBeLessThanOrEqual(Sizes.cardRowMin);
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

describe('addBarButton', () => {
  it('is a disabled Add on an empty field, never a hide-keyboard button', () => {
    expect(addBarButton('')).toEqual({ label: 'Add', disabled: true });
  });

  it('stays disabled on a blank field', () => {
    expect(addBarButton('   ')).toEqual({ label: 'Add', disabled: true });
    expect(addBarButton('\n\t')).toEqual({ label: 'Add', disabled: true });
  });

  it('is an enabled Add once the field has text', () => {
    expect(addBarButton('milk')).toEqual({ label: 'Add', disabled: false });
    expect(addBarButton(' 2 eggs ')).toEqual({ label: 'Add', disabled: false });
    expect(addBarButton('x')).toEqual({ label: 'Add', disabled: false });
  });
});

describe('signInColors', () => {
  it('uses the board 09 colours in light mode', () => {
    expect(signInColors(Palette.light, AisleColors.light)).toEqual({
      ground: '#2E6B45',
      text: '#FFFFFF',
      button: '#FFFFFF',
      buttonText: '#1D2A22',
      shapes: ['#3E7BB8', '#C98A1E', '#C2556B', '#EEF3EC', '#1F5233', '#DFEAF6'],
    });
  });

  it.each(SCHEMES)('keeps the text and the button readable in %s mode', (scheme) => {
    const look = signInColors(Palette[scheme], AisleColors[scheme]);
    expect(contrastRatio(look.text, look.ground)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(look.buttonText, look.button)).toBeGreaterThanOrEqual(4.5);
    // The button and the "Use a different email" link sit on the ground.
    expect(contrastRatio(look.button, look.ground)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(Palette[scheme].onPrimary, look.ground)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(SCHEMES)('has six shapes in %s mode', (scheme) => {
    expect(signInColors(Palette[scheme], AisleColors[scheme]).shapes).toHaveLength(6);
  });
});

describe('avatarColors', () => {
  it("is the hue's strong shade with an onPrimary initial", () => {
    expect(avatarColors('amber', Palette.light, AisleColors.light)).toEqual({ fill: '#8A5C0C', text: '#FFFFFF' });
    expect(avatarColors('blue', Palette.dark, AisleColors.dark)).toEqual({ fill: '#7AAEE0', text: '#0E1F14' });
  });

  it.each(SCHEMES)('keeps the initial readable on every hue in %s mode', (scheme) => {
    for (const hue of Object.keys(AisleColors[scheme]) as (keyof (typeof AisleColors)['light'])[]) {
      const look = avatarColors(hue, Palette[scheme], AisleColors[scheme]);
      expect(contrastRatio(look.text, look.fill)).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('householdBandColors', () => {
  it('is the amber band from board 11 in light mode', () => {
    expect(householdBandColors(Palette.light, AisleColors.light)).toEqual({
      fill: '#F6EBD4',
      text: '#1D2A22',
      secondary: '#8A5C0C',
    });
  });

  it.each(SCHEMES)('keeps the name and the counts readable in %s mode', (scheme) => {
    const look = householdBandColors(Palette[scheme], AisleColors[scheme]);
    expect(contrastRatio(look.text, look.fill)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(look.secondary, look.fill)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('aisleRowLook', () => {
  it('is a plain white row with its aisle dot and a tertiary grip at rest', () => {
    expect(aisleRowLook(false, 'rose', Palette.light, AisleColors.light)).toEqual({
      fill: '#FFFFFF',
      dot: '#C2556B',
      outline: null,
      grip: 'inkTertiary',
    });
  });

  it('outlines the dragged row in its aisle colour with an ink grip', () => {
    expect(aisleRowLook(true, 'rose', Palette.light, AisleColors.light)).toEqual({
      fill: '#FFFFFF',
      dot: '#C2556B',
      outline: '#C2556B',
      grip: 'ink',
    });
    expect(aisleRowLook(true, 'grey', Palette.dark, AisleColors.dark).outline).toBe('#8E9A91');
  });

  it.each(SCHEMES)('keeps the name readable and the dragged outline visible in %s mode', (scheme) => {
    const colors = Palette[scheme];
    for (const hue of Object.keys(AisleColors[scheme]) as (keyof (typeof AisleColors)['light'])[]) {
      const look = aisleRowLook(true, hue, colors, AisleColors[scheme]);
      expect(contrastRatio(colors.ink, look.fill)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(look.outline!, look.fill)).toBeGreaterThanOrEqual(1.5);
    }
  });
});

describe('prominentButtonTint', () => {
  it('is primary in light mode and primarySoft in dark mode', () => {
    expect(prominentButtonTint('light', Palette.light)).toBe('#2E6B45');
    expect(prominentButtonTint('dark', Palette.dark)).toBe('#1E3A28');
  });

  it.each(SCHEMES)("keeps iOS's white label readable on it in %s mode", (scheme) => {
    expect(contrastRatio('#FFFFFF', prominentButtonTint(scheme, Palette[scheme]))).toBeGreaterThanOrEqual(4.5);
  });

  it('would fail with primary in dark mode, which is why dark swaps it', () => {
    expect(contrastRatio('#FFFFFF', Palette.dark.primary)).toBeLessThan(4.5);
  });
});

describe('settings screen text', () => {
  it.each(SCHEMES)('keeps Sign out, the version and section labels readable on the background in %s mode', (scheme) => {
    const colors = Palette[scheme];
    expect(contrastRatio(colors.danger, colors.background)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(colors.inkSecondary, colors.background)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(colors.inkSecondary, colors.surface)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('aisleHeaderBand', () => {
  const SLUGS = [...SYSTEM_CATEGORIES.map((c) => c.slug), 'my-corner-shop', null];

  it("is the aisle's soft band with its strong text", () => {
    expect(aisleHeaderBand('produce', 'light')).toEqual({ ground: AisleColors.light.green.soft, text: AisleColors.light.green.strong });
    expect(aisleHeaderBand('my-corner-shop', 'dark').ground).toBe(AisleColors.dark.grey.soft);
  });

  it.each(SCHEMES)('keeps the text at 4.5:1 or better in the %s scheme', (scheme) => {
    for (const slug of SLUGS) {
      const { ground, text } = aisleHeaderBand(slug, scheme);
      expect(contrastRatio(text, ground)).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('categoryColors', () => {
  const SLUGS = [...SYSTEM_CATEGORIES.map((c) => c.slug), 'my-corner-shop', null];

  it('tints rows close to the light-mode targets', () => {
    // Targets from the restyle brief; the tint is the aisle dot at 10% over white.
    expect(categoryColors('produce', 'light')).toEqual({ ring: '#2E6B45', tint: '#EAF0EC', text: '#2E6B45' });
    expect(categoryColors('dairy-eggs', 'light').tint).toBe('#ECF2F8');
    expect(categoryColors('meat-seafood', 'light').tint).toBe('#F9EEF0');
    expect(categoryColors('bakery', 'light').tint).toBe('#FAF3E9');
  });

  it('is neutral grey for Sorting… (no slug) and custom aisles', () => {
    expect(categoryColors(undefined, 'light')).toEqual(categoryColors('other', 'light'));
    expect(categoryColors('my-corner-shop', 'dark')).toEqual(categoryColors('other', 'dark'));
    expect(categoryColors(null, 'light').ring).toBe(AisleColors.light.grey.dot);
    expect(categoryColors(null, 'dark').text).toBe(Palette.dark.inkSecondary);
  });

  it('uses the full aisle colour for the ring', () => {
    expect(categoryColors('dairy-eggs', 'light').ring).toBe(AisleColors.light.blue.dot);
    expect(categoryColors('dairy-eggs', 'dark').ring).toBe(AisleColors.dark.blue.dot);
  });

  describe.each(SCHEMES)('%s scheme', (scheme) => {
    const colors = Palette[scheme];

    it.each(SLUGS)('keeps every text on the %s tint at 4.5:1 or better', (slug) => {
      const { tint, text } = categoryColors(slug, scheme);
      for (const fg of [colors.ink, colors.inkSecondary, colors.pending, text]) {
        expect(contrastRatio(fg, tint)).toBeGreaterThanOrEqual(4.5);
      }
    });

    it('keeps tints faint: closer to the card than to the aisle colour', () => {
      for (const slug of SLUGS) {
        const { tint, ring } = categoryColors(slug, scheme);
        expect(contrastRatio(tint, colors.surface)).toBeLessThan(contrastRatio(tint, ring));
        expect(contrastRatio(tint, colors.surface)).toBeLessThan(scheme === 'light' ? 1.2 : 1.45);
      }
    });

    it('keeps dark tints dark, never pastel', () => {
      for (const slug of SLUGS) {
        const { tint } = categoryColors(slug, scheme);
        if (scheme === 'dark') expect(contrastRatio(tint, '#000000')).toBeLessThan(2);
      }
    });
  });
});

describe('listHeaderColors', () => {
  it('is forest green with a white title in light mode', () => {
    const header = listHeaderColors(Palette.light);
    expect(header).toMatchObject({ ground: '#1F4D33', title: '#FFFFFF', subtitle: '#B7D2BF' });
  });

  it('is a deeper green in dark mode', () => {
    expect(contrastRatio(Palette.dark.header, '#000000')).toBeLessThan(contrastRatio(Palette.light.header, '#000000'));
  });

  it.each(SCHEMES)('keeps the title, subtitle and view button readable in %s mode', (scheme) => {
    const header = listHeaderColors(Palette[scheme]);
    expect(contrastRatio(header.title, header.ground)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(header.subtitle, header.ground)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(header.viewButton.text, header.viewButton.fill)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(SCHEMES)('washes the view button white over the green in %s mode', (scheme) => {
    const colors = Palette[scheme];
    expect(listHeaderColors(colors).viewButton.fill).toBe(mix(colors.onHeader, colors.header, 0.14));
  });
});

describe('checkAppearance with an aisle ring', () => {
  it('replaces the off and sorting ring, but not the checked fill', () => {
    const ring = AisleColors.light.rose.dot;
    expect(checkAppearance('off', Palette.light, AisleColors.light, ring).border).toBe(ring);
    expect(checkAppearance('pending', Palette.light, AisleColors.light, ring)).toMatchObject({ border: ring, borderStyle: 'dashed' });
    expect(checkAppearance('on', Palette.light, AisleColors.light, ring).border).toBe(Palette.light.primary);
  });
});

describe('recipeTagPillColors', () => {
  it('washes surface over the band tint, facet in inkSecondary and value in ink', () => {
    expect(recipeTagPillColors('rose', Palette.light, AisleColors.light)).toEqual({
      fill: mix(Palette.light.surface, AisleColors.light.rose.soft, RECIPE_TAG_WASH),
      facet: Palette.light.inkSecondary,
      text: Palette.light.ink,
    });
  });

  it.each(SCHEMES)('keeps both lines readable on every hue in %s mode', (scheme) => {
    for (const hue of Object.keys(AisleColors[scheme]) as (keyof (typeof AisleColors)['light'])[]) {
      const look = recipeTagPillColors(hue, Palette[scheme], AisleColors[scheme]);
      expect(contrastRatio(look.text, look.fill)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(look.facet, look.fill)).toBeGreaterThanOrEqual(4.5);
    }
  });
});
