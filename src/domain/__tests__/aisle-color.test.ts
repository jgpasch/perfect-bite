import { describe, expect, it } from '@jest/globals';

import { AISLE_HUES, aisleColor, listHue, recipeHue, shortAisleName, type AisleHue } from '@/domain/aisle-color';
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

describe('listHue', () => {
  it('knows the five aisle hues, in picker order', () => {
    expect(AISLE_HUES).toEqual(['green', 'blue', 'rose', 'amber', 'grey']);
  });

  it.each(['green', 'blue', 'rose', 'amber', 'grey'] as const)('reads %s as itself', (hue) => {
    expect(listHue(hue)).toBe(hue);
  });

  it('reads null and undefined as Default', () => {
    expect(listHue(null)).toBeNull();
    expect(listHue(undefined)).toBeNull();
  });

  it.each(['purple', '', 'Green', ' green', 'toString', '__proto__'])(
    'reads anything else as Default, e.g. a hue from a newer app version: %p',
    (color) => {
      expect(listHue(color)).toBeNull();
    },
  );
});

describe('recipeHue', () => {
  it('hashes the id over the four aisle hues', () => {
    // Single characters hash to their char code: a 97, b 98, c 99, d 100; mod 4 picks the hue.
    expect(recipeHue('a')).toBe('blue');
    expect(recipeHue('b')).toBe('rose');
    expect(recipeHue('c')).toBe('amber');
    expect(recipeHue('d')).toBe('green');
    // 97 × 31 + 98 = 3105, 3105 mod 4 = 1.
    expect(recipeHue('ab')).toBe('blue');
  });

  it('is green for an empty id', () => {
    expect(recipeHue('')).toBe('green');
  });

  it('is stable for the same id', () => {
    const id = '019a4c10-0000-7000-8000-0000000000aa';
    expect(recipeHue(id)).toBe(recipeHue(id));
  });

  it('never picks grey, and spreads ids over every hue', () => {
    const seen = new Set<AisleHue>();
    for (let i = 0; i < 200; i++) seen.add(recipeHue(`019a4c10-0000-7000-8000-${String(i).padStart(12, '0')}`));
    expect([...seen].sort()).toEqual(['amber', 'blue', 'green', 'rose']);
  });

  it('copes with long ids that overflow 32 bits', () => {
    expect(['green', 'blue', 'rose', 'amber']).toContain(recipeHue('x'.repeat(500)));
  });
});

describe('shortAisleName', () => {
  it.each([
    ['Meat & Seafood', 'Meat'],
    ['Dairy & Eggs', 'Dairy'],
    ['Pantry & Dry Goods', 'Pantry'],
    ['Canned & Jarred', 'Canned'],
    ['Produce', 'Produce'],
    ['Personal Care', 'Personal Care'],
    ['Fruit and veg', 'Fruit'],
    ['Oils, vinegars', 'Oils'],
    ['  Frozen  ', 'Frozen'],
  ])('%s → %s', (name, short) => {
    expect(shortAisleName(name)).toBe(short);
  });

  it('keeps the whole name when nothing comes before the separator', () => {
    expect(shortAisleName('& more')).toBe('& more');
  });

  it("doesn't split inside a word", () => {
    expect(shortAisleName('Candy')).toBe('Candy');
    expect(shortAisleName('Sandwiches')).toBe('Sandwiches');
  });
});
