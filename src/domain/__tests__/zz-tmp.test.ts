// TODO: rename to src/components/__tests__/aisle-pill-contrast.test.ts (the session that wrote it
// couldn't move or delete files without approval).
import { describe, expect, it, jest } from '@jest/globals';

import { pillLook } from '@/components/appearance';
import { AisleColors, Palette, type ColorScheme } from '@/constants/theme';
import type { AisleHue } from '@/domain/aisle-color';
import { contrastRatio as ratio } from '@/domain/contrast';

// The web font variables; Jest can't parse CSS.
jest.mock('@/global.css', () => ({}));

const SCHEMES: ColorScheme[] = ['light', 'dark'];
const HUES = Object.keys(AisleColors.light) as AisleHue[];

describe('selected aisle pill contrast (item sheet, board 04)', () => {
  describe.each(SCHEMES)('%s scheme', (scheme) => {
    it.each(HUES)('keeps the %s pill label at 4.5:1 or more', (hue) => {
      const look = pillLook({ selected: true, hue }, Palette[scheme], AisleColors[scheme]);
      expect(ratio(look.text, look.fill)).toBeGreaterThanOrEqual(4.5);
    });

    it('keeps the dashed "+ New" label readable on the screen ground', () => {
      const look = pillLook({ dashed: true }, Palette[scheme], AisleColors[scheme]);
      expect(ratio(look.text, Palette[scheme].background)).toBeGreaterThanOrEqual(4.5);
    });
  });

  it('would fail with white text on the light blue, rose and grey dots, which is why it uses `strong`', () => {
    for (const hue of ['blue', 'rose', 'grey'] as const) {
      expect(ratio(Palette.light.onPrimary, AisleColors.light[hue].dot)).toBeLessThan(4.5);
    }
  });
});
