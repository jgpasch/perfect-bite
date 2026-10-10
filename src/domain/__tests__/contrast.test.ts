import { describe, expect, it } from '@jest/globals';

import { contrastRatio, relativeLuminance } from '@/domain/contrast';

describe('relativeLuminance', () => {
  it('is 0 for black and 1 for white', () => {
    expect(relativeLuminance('#000000')).toBe(0);
    expect(relativeLuminance('#FFFFFF')).toBe(1);
  });

  it('accepts lower case', () => {
    expect(relativeLuminance('#ffffff')).toBe(1);
  });

  it('weights green most and blue least', () => {
    expect(relativeLuminance('#00FF00')).toBeCloseTo(0.7152, 4);
    expect(relativeLuminance('#FF0000')).toBeCloseTo(0.2126, 4);
    expect(relativeLuminance('#0000FF')).toBeCloseTo(0.0722, 4);
  });

  it.each(['#FFF', 'FFFFFF', '#FFFFFF80', '#GGGGGG', 'red', ''])('throws on %p', (hex) => {
    expect(() => relativeLuminance(hex)).toThrow('Expected #RRGGBB');
  });
});

describe('contrastRatio', () => {
  it('is 21 for black on white and 1 for a colour on itself', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBe(21);
    expect(contrastRatio('#2E6B45', '#2E6B45')).toBe(1);
  });

  it('is symmetric', () => {
    expect(contrastRatio('#FFFFFF', '#55635A')).toBe(contrastRatio('#55635A', '#FFFFFF'));
  });

  it('matches known WCAG values', () => {
    // #777777 on white is the classic just-under-AA grey.
    expect(contrastRatio('#777777', '#FFFFFF')).toBeCloseTo(4.48, 2);
    expect(contrastRatio('#767676', '#FFFFFF')).toBeCloseTo(4.54, 2);
  });
});
