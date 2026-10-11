import { describe, expect, it } from '@jest/globals';

import { normalizeIngredientName } from '../ingredient-normalizer';
import { UNIT_KEYS } from '../quantity-parser';
import { OTHER_CATEGORY_ID, SYSTEM_CATEGORIES } from '../seed/categories';
import { SEED_INGREDIENTS, seedEntries } from '../seed/ingredients';

describe('seed data', () => {
  it('has unique category ids and slugs, with Other last', () => {
    expect(new Set(SYSTEM_CATEGORIES.map((c) => c.id)).size).toBe(SYSTEM_CATEGORIES.length);
    expect(new Set(SYSTEM_CATEGORIES.map((c) => c.slug)).size).toBe(SYSTEM_CATEGORIES.length);
    expect(SYSTEM_CATEGORIES.at(-1)!.id).toBe(OTHER_CATEGORY_ID);
  });

  it('has about 500 ingredients, each with a distinct key', () => {
    const owners = new Map<string, string[]>();
    for (const { name, category } of seedEntries()) {
      const key = normalizeIngredientName(name);
      expect(key).not.toBe('');
      owners.set(key, [...(owners.get(key) ?? []), `${category}:${name}`]);
    }
    const clashes = [...owners.values()].filter((o) => o.length > 1);
    expect(clashes).toEqual([]);
    expect(owners.size).toBeGreaterThanOrEqual(500);
  });

  it('gives every name a supported default unit, with no empty groups', () => {
    const unitKeys = new Set<string>(UNIT_KEYS);
    for (const byUnit of Object.values(SEED_INGREDIENTS)) {
      for (const [unit, names] of Object.entries(byUnit)) {
        expect(unitKeys.has(unit)).toBe(true);
        expect(names.length).toBeGreaterThan(0);
      }
    }
  });

  it('lists every category but Other', () => {
    const seeded = new Set(seedEntries().map((e) => e.category));
    expect([...seeded].sort()).toEqual(SYSTEM_CATEGORIES.map((c) => c.slug).filter((s) => s !== 'other').sort());
  });
});
