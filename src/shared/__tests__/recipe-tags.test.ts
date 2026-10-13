import { describe, expect, test } from '@jest/globals';

import {
  CUISINE_REGIONS,
  emptyRecipeTags,
  knownTags,
  RECIPE_TAG_FACET_KEYS,
  RECIPE_TAG_FACETS,
  RecipeTagsSchema,
  recipeTagLabel,
  timeBucket,
  type TimeBucket,
} from '../recipe-tags';

describe('the facets', () => {
  test('are in display order with their maximums', () => {
    expect(RECIPE_TAG_FACETS.map((f) => [f.key, f.label, f.max])).toEqual([
      ['meal', 'Meal', 2],
      ['cuisine', 'Cuisine', 2],
      ['protein', 'Protein', 3],
      ['diet', 'Diet', 2],
      ['method', 'Method', 2],
    ]);
    expect(RECIPE_TAG_FACET_KEYS).toEqual(['meal', 'cuisine', 'protein', 'diet', 'method']);
  });

  test('list their values in order', () => {
    const slugs = Object.fromEntries(RECIPE_TAG_FACETS.map((f) => [f.key, f.values.map((v) => v.slug)]));
    expect(slugs).toEqual({
      meal: ['breakfast', 'lunch', 'dinner', 'side', 'dessert', 'snack', 'drink'],
      cuisine: [
        'american',
        'mexican',
        'latin-american',
        'caribbean',
        'italian',
        'french',
        'spanish',
        'greek',
        'mediterranean',
        'middle-eastern',
        'indian',
        'chinese',
        'japanese',
        'korean',
        'thai',
        'vietnamese',
        'african',
      ],
      protein: ['chicken', 'turkey', 'beef', 'pork', 'lamb', 'fish', 'shellfish', 'eggs', 'tofu-tempeh', 'beans-lentils'],
      diet: ['vegetarian', 'vegan'],
      method: ['pressure-cooker', 'slow-cooker', 'sheet-pan', 'one-pot', 'grill', 'air-fryer', 'no-cook'],
    });
  });

  test('have unique slugs within each facet', () => {
    for (const facet of RECIPE_TAG_FACETS) {
      const slugs = facet.values.map((v) => v.slug);
      expect(new Set(slugs).size).toBe(slugs.length);
    }
  });

  test('labels', () => {
    expect(recipeTagLabel('method', 'pressure-cooker')).toBe('Instant Pot');
    expect(recipeTagLabel('protein', 'tofu-tempeh')).toBe('Tofu & tempeh');
    expect(recipeTagLabel('cuisine', 'middle-eastern')).toBe('Middle Eastern');
    expect(recipeTagLabel('meal', 'brunch')).toBeNull();
    // A slug from another facet isn't this facet's.
    expect(recipeTagLabel('meal', 'chicken')).toBeNull();
  });

  test('every cuisine has a region', () => {
    const cuisines = RECIPE_TAG_FACETS.find((f) => f.key === 'cuisine')!.values.map((v) => v.slug);
    expect(Object.keys(CUISINE_REGIONS).sort()).toEqual([...cuisines].sort());
    expect(CUISINE_REGIONS.thai).toBe('asian');
    expect(CUISINE_REGIONS.mexican).toBe('latin');
    expect(CUISINE_REGIONS.italian).toBe('european');
  });
});

describe('RecipeTagsSchema', () => {
  test('keeps known facets and values', () => {
    const tags = { meal: ['dinner'], cuisine: ['thai'], protein: ['chicken', 'eggs'], diet: [], method: ['one-pot'] };
    expect(RecipeTagsSchema.parse(tags)).toEqual(tags);
  });

  test('keeps unknown slugs (they are only dropped for display)', () => {
    expect(RecipeTagsSchema.parse({ meal: ['brunch', 'dinner'], method: ['smoker'] })).toEqual({
      meal: ['brunch', 'dinner'],
      cuisine: [],
      protein: [],
      diet: [],
      method: ['smoker'],
    });
  });

  test('fills missing facets with []', () => {
    expect(RecipeTagsSchema.parse({})).toEqual(emptyRecipeTags());
    expect(RecipeTagsSchema.parse({ diet: ['vegan'] })).toEqual({ ...emptyRecipeTags(), diet: ['vegan'] });
  });

  test('drops unknown facets', () => {
    expect(RecipeTagsSchema.parse({ meal: ['lunch'], course: ['main'] })).toEqual({ ...emptyRecipeTags(), meal: ['lunch'] });
  });

  test('refuses the wrong shape', () => {
    expect(RecipeTagsSchema.safeParse(null).success).toBe(false);
    expect(RecipeTagsSchema.safeParse(['dinner']).success).toBe(false);
    expect(RecipeTagsSchema.safeParse({ meal: 'dinner' }).success).toBe(false);
    expect(RecipeTagsSchema.safeParse({ meal: ['dinner', 3] }).success).toBe(false);
  });
});

describe('knownTags', () => {
  test('drops unknown slugs and orders each facet by its values', () => {
    expect(
      knownTags({ meal: ['dinner', 'brunch', 'lunch'], cuisine: ['klingon'], protein: ['pork', 'chicken'], diet: [], method: [] }),
    ).toEqual({ meal: ['lunch', 'dinner'], cuisine: [], protein: ['chicken', 'pork'], diet: [], method: [] });
  });

  test('ignores a slug filed under the wrong facet', () => {
    expect(knownTags({ ...emptyRecipeTags(), meal: ['chicken'] })).toEqual(emptyRecipeTags());
  });

  test('null stays null (never tagged)', () => {
    expect(knownTags(null)).toBeNull();
  });

  test("doesn't change the stored value", () => {
    const stored = { ...emptyRecipeTags(), meal: ['brunch', 'dinner'] };
    knownTags(stored);
    expect(stored.meal).toEqual(['brunch', 'dinner']);
  });

  test('a facet missing from older stored tags shows as empty', () => {
    expect(knownTags({ meal: ['snack'] } as never)).toEqual({ ...emptyRecipeTags(), meal: ['snack'] });
  });
});

describe('timeBucket', () => {
  test.each<[number, TimeBucket]>([
    [1, 'under-30'],
    [29, 'under-30'],
    [30, 'under-60'],
    [60, 'under-60'],
    [61, 'over-60'],
    [2880, 'over-60'],
  ])('%i minutes is %s', (minutes, bucket) => {
    expect(timeBucket(minutes)).toBe(bucket);
  });

  test('no time has no bucket', () => {
    expect(timeBucket(null)).toBeNull();
    expect(timeBucket(undefined)).toBeNull();
    expect(timeBucket(Number.NaN)).toBeNull();
  });
});
