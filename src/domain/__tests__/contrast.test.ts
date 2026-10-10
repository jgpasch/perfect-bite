import { describe, expect, it } from '@jest/globals';

import { contrastRatio, mix, relativeLuminance } from '@/domain/contrast';

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

describe('mix', () => {
  it('returns the top colour at full alpha and the bottom at none', () => {
    expect(mix('#FFFFFF', '#2E6B45', 1)).toBe('#FFFFFF');
    expect(mix('#FFFFFF', '#2E6B45', 0)).toBe('#2E6B45');
  });

  it('blends each channel and rounds', () => {
    expect(mix('#FFFFFF', '#000000', 0.5)).toBe('#808080');
    // 0.12 × 255 + 0.88 × (46, 107, 69) = (71.08, 124.76, 91.32)
    expect(mix('#FFFFFF', '#2E6B45', 0.12)).toBe('#477D5B');
  });

  it('clamps alpha and accepts lower case', () => {
    expect(mix('#ffffff', '#000000', 2)).toBe('#FFFFFF');
    expect(mix('#ffffff', '#000000', -1)).toBe('#000000');
  });

  it('throws on a colour that isn’t #RRGGBB', () => {
    expect(() => mix('#FFF', '#000000', 0.5)).toThrow('Expected #RRGGBB');
    expect(() => mix('#FFFFFF', 'black', 0.5)).toThrow('Expected #RRGGBB');
  });
});
