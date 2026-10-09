import { describe, expect, it } from '@jest/globals';

import { normalizeIngredientName } from '../ingredient-normalizer';
import { OTHER_CATEGORY_ID, SYSTEM_CATEGORIES } from '../seed/categories';
import { SEED_INGREDIENTS } from '../seed/ingredients';

describe('seed data', () => {
  it('has unique category ids and slugs, with Other last', () => {
    expect(new Set(SYSTEM_CATEGORIES.map((c) => c.id)).size).toBe(SYSTEM_CATEGORIES.length);
    expect(new Set(SYSTEM_CATEGORIES.map((c) => c.slug)).size).toBe(SYSTEM_CATEGORIES.length);
    expect(SYSTEM_CATEGORIES.at(-1)!.id).toBe(OTHER_CATEGORY_ID);
  });

  it('has about 500 ingredients, each with a distinct key', () => {
    const owners = new Map<string, string[]>();
    for (const [slug, names] of Object.entries(SEED_INGREDIENTS)) {
      for (const name of names) {
        const key = normalizeIngredientName(name);
        expect(key).not.toBe('');
        owners.set(key, [...(owners.get(key) ?? []), `${slug}:${name}`]);
      }
    }
    const clashes = [...owners.values()].filter((o) => o.length > 1);
    expect(clashes).toEqual([]);
    expect(owners.size).toBeGreaterThanOrEqual(500);
  });
});
