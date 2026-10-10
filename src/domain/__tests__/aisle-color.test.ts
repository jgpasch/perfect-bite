import { describe, expect, it } from '@jest/globals';

import { aisleColor, type AisleHue } from '@/domain/aisle-color';
import { SYSTEM_CATEGORIES, type CategorySlug } from '@/shared/seed/categories';

describe('aisleColor', () => {
  it('gives every seed category a hue', () => {
    for (const { slug } of SYSTEM_CATEGORIES) {
      expect(['green', 'blue', 'rose', 'amber', 'grey']).toContain(aisleColor(slug));
    }
  });

  it('only gives grey to other among the seed categories', () => {
    const grey = SYSTEM_CATEGORIES.filter(({ slug }) => aisleColor(slug) === 'grey').map((c) => c.slug);
    expect(grey).toEqual(['other']);
  });

  it.each([
    ['produce', 'green'],
    ['meat-seafood', 'rose'],
    ['deli', 'rose'],
    ['dairy-eggs', 'blue'],
    ['frozen', 'blue'],
    ['beverages', 'blue'],
    ['bakery', 'amber'],
    ['pantry', 'amber'],
    ['canned-jarred', 'amber'],
    ['pasta-grains', 'amber'],
    ['baking', 'amber'],
    ['spices', 'amber'],
    ['condiments', 'amber'],
    ['snacks', 'amber'],
    ['breakfast', 'amber'],
    ['household', 'green'],
    ['personal-care', 'blue'],
    ['baby', 'blue'],
    ['pet', 'green'],
    ['other', 'grey'],
  ] satisfies [CategorySlug, AisleHue][])('maps %s to %s', (slug, hue) => {
    expect(aisleColor(slug)).toBe(hue);
  });

  it.each(['my-custom-aisle', '', 'Produce', ' produce', 'constructor', 'toString', '__proto__'])(
    'falls back to grey for unknown slug %p',
    (slug) => {
      expect(aisleColor(slug)).toBe('grey');
    },
  );

  it('falls back to grey for null and undefined', () => {
    expect(aisleColor(null)).toBe('grey');
    expect(aisleColor(undefined)).toBe('grey');
  });
});
