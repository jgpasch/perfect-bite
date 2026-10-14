import { describe, expect, it } from '@jest/globals';

import * as shared from '@/shared';
import {
  canonicalRecipeUrl,
  ExtractedRecipeSchema,
  MAX_JSON_LD_BLOCK_BYTES,
  MAX_PAGE_TEXT_BYTES,
  RECIPE_IMPORT_ERROR_CODES,
  RecipeImportErrorCodeSchema,
  RecipeImportErrorSchema,
  RecipeImportRequestSchema,
  RecipeImportResponseSchema,
} from '../schemas/recipe-import';

describe('canonicalRecipeUrl', () => {
  it('lowercases the host and drops www.', () => {
    expect(canonicalRecipeUrl('https://WWW.Example.COM/Recipes/Pad-Thai')).toBe(
      'https://example.com/Recipes/Pad-Thai',
    );
  });

  it('keeps a www inside the host', () => {
    expect(canonicalRecipeUrl('https://cooking.www.example.com/a')).toBe('https://cooking.www.example.com/a');
  });

  it('drops the fragment', () => {
    expect(canonicalRecipeUrl('https://example.com/pad-thai#recipe-card')).toBe('https://example.com/pad-thai');
  });

  it('drops utm_* parameters', () => {
    expect(
      canonicalRecipeUrl('https://example.com/a?utm_source=pin&utm_medium=social&UTM_Campaign=x'),
    ).toBe('https://example.com/a');
  });

  it('drops fbclid, gclid, ref and mc_* parameters', () => {
    expect(canonicalRecipeUrl('https://example.com/a?fbclid=1&gclid=2&ref=home&mc_cid=3&mc_eid=4')).toBe(
      'https://example.com/a',
    );
  });

  it('keeps other parameters in order', () => {
    expect(canonicalRecipeUrl('https://example.com/recipe?id=42&utm_source=x&print=1&referrer=y')).toBe(
      'https://example.com/recipe?id=42&print=1&referrer=y',
    );
  });

  it('drops a trailing slash, before or without a query', () => {
    expect(canonicalRecipeUrl('https://example.com/pad-thai/')).toBe('https://example.com/pad-thai');
    expect(canonicalRecipeUrl('https://example.com/pad-thai//?id=1')).toBe('https://example.com/pad-thai?id=1');
    expect(canonicalRecipeUrl('https://example.com/')).toBe('https://example.com');
    expect(canonicalRecipeUrl('https://example.com')).toBe('https://example.com');
  });

  it('keeps http and a non-default port, drops a default port', () => {
    expect(canonicalRecipeUrl('http://example.com:8080/a')).toBe('http://example.com:8080/a');
    expect(canonicalRecipeUrl('https://example.com:443/a')).toBe('https://example.com/a');
  });

  it('trims surrounding whitespace', () => {
    expect(canonicalRecipeUrl('  https://example.com/a \n')).toBe('https://example.com/a');
  });

  it('gives variants of the same page the same key', () => {
    const variants = [
      'https://www.seriouseats.com/pad-thai-recipe/',
      'https://seriouseats.com/pad-thai-recipe',
      'https://SeriousEats.com/pad-thai-recipe#comments',
      'https://www.seriouseats.com/pad-thai-recipe?utm_source=newsletter&fbclid=abc',
      'https://www.seriouseats.com/pad-thai-recipe/?ref=homepage#step-3',
    ];
    expect(new Set(variants.map(canonicalRecipeUrl))).toEqual(new Set(['https://seriouseats.com/pad-thai-recipe']));
  });

  it('keeps different pages apart', () => {
    expect(canonicalRecipeUrl('https://example.com/a?id=1')).not.toBe(canonicalRecipeUrl('https://example.com/a?id=2'));
    expect(canonicalRecipeUrl('https://example.com/A')).not.toBe(canonicalRecipeUrl('https://example.com/a'));
  });

  it('rejects non-http schemes', () => {
    for (const url of [
      'ftp://example.com/a',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/html,<p>hi</p>',
      'mailto:a@example.com',
    ]) {
      expect(canonicalRecipeUrl(url)).toBeNull();
    }
  });

  it('rejects strings that are not URLs', () => {
    expect(canonicalRecipeUrl('')).toBeNull();
    expect(canonicalRecipeUrl('example.com/pad-thai')).toBeNull();
    expect(canonicalRecipeUrl('not a url')).toBeNull();
  });
});

describe('RecipeImportRequestSchema', () => {
  const url = 'https://example.com/pad-thai';

  it('accepts a bare URL', () => {
    expect(RecipeImportRequestSchema.parse({ url })).toEqual({ url });
  });

  it('accepts a captured page', () => {
    const req = { url, page: { title: 'Pad Thai', jsonLd: ['{"@type":"Recipe"}'], text: 'Pad Thai…' } };
    expect(RecipeImportRequestSchema.parse(req)).toEqual(req);
  });

  it('rejects a missing, non-http or malformed URL', () => {
    expect(RecipeImportRequestSchema.safeParse({}).success).toBe(false);
    expect(RecipeImportRequestSchema.safeParse({ url: 'ftp://example.com/a' }).success).toBe(false);
    expect(RecipeImportRequestSchema.safeParse({ url: 'pad thai' }).success).toBe(false);
  });

  it('caps JSON-LD at 10 blocks', () => {
    const blocks = (n: number) => Array.from({ length: n }, () => '{}');
    expect(RecipeImportRequestSchema.safeParse({ url, page: { jsonLd: blocks(10) } }).success).toBe(true);
    expect(RecipeImportRequestSchema.safeParse({ url, page: { jsonLd: blocks(11) } }).success).toBe(false);
  });

  it('caps each JSON-LD block at 200 KB', () => {
    expect(MAX_JSON_LD_BLOCK_BYTES).toBe(204_800);
    const ok = 'a'.repeat(MAX_JSON_LD_BLOCK_BYTES);
    expect(RecipeImportRequestSchema.safeParse({ url, page: { jsonLd: ['{}', ok] } }).success).toBe(true);
    expect(RecipeImportRequestSchema.safeParse({ url, page: { jsonLd: ['{}', `${ok}a`] } }).success).toBe(false);
  });

  it('caps page text at 50 KB', () => {
    expect(MAX_PAGE_TEXT_BYTES).toBe(51_200);
    const ok = 'a'.repeat(MAX_PAGE_TEXT_BYTES);
    expect(RecipeImportRequestSchema.safeParse({ url, page: { text: ok } }).success).toBe(true);
    expect(RecipeImportRequestSchema.safeParse({ url, page: { text: `${ok}a` } }).success).toBe(false);
  });

  it('counts the caps in UTF-8 bytes, not characters', () => {
    // "é" is 2 bytes: half the cap in characters is exactly the cap in bytes.
    const half = 'é'.repeat(MAX_PAGE_TEXT_BYTES / 2);
    expect(RecipeImportRequestSchema.safeParse({ url, page: { text: half } }).success).toBe(true);
    expect(RecipeImportRequestSchema.safeParse({ url, page: { text: `${half}é` } }).success).toBe(false);
  });

  it('takes the page’s image URL as given (the server cleans it)', () => {
    const page = { title: 'Pad Thai', imageUrl: '/images/pad-thai.jpg' };
    expect(RecipeImportRequestSchema.parse({ url, page })).toEqual({ url, page });
  });

  it('leaves out an image URL that isn’t a string or is over 2048 characters, without failing the request', () => {
    for (const imageUrl of [42, null, { url: 'https://example.com/a.jpg' }, `https://example.com/${'a'.repeat(2048)}`]) {
      const parsed = RecipeImportRequestSchema.safeParse({ url, page: { title: 'Pad Thai', imageUrl } });
      expect(parsed.success).toBe(true);
      expect(parsed.data?.page).toEqual({ title: 'Pad Thai' });
    }
  });
});

describe('ExtractedRecipeSchema', () => {
  const ingredient = { name: 'garlic', quantity: 2, unit: 'clove', note: 'minced' };
  const tags = { meal: ['dinner'], cuisine: ['thai'], protein: ['shellfish', 'eggs'], diet: [], method: ['one-pot'] };
  const recipe = {
    is_recipe: true,
    name: 'Pad Thai',
    servings: 4,
    ingredients: [ingredient],
    tags,
    total_minutes: 30,
    steps: ['Soak the noodles.', 'Fry the garlic.'],
    image_url: 'https://example.com/pad-thai.jpg',
  };

  it('accepts a recipe', () => {
    expect(ExtractedRecipeSchema.parse(recipe)).toEqual(recipe);
  });

  it('steps: at most 100, each 1 to 2000 characters counted in code points', () => {
    const steps = (s: unknown) => ExtractedRecipeSchema.safeParse({ ...recipe, steps: s }).success;
    expect(steps([])).toBe(true);
    expect(steps(Array.from({ length: 100 }, (_, i) => `Step ${i}`))).toBe(true);
    expect(steps(Array.from({ length: 101 }, (_, i) => `Step ${i}`))).toBe(false);
    expect(steps(['a'.repeat(2000)])).toBe(true);
    expect(steps(['a'.repeat(2001)])).toBe(false);
    // 2000 emoji are 4000 UTF-16 units but 2000 characters, as Postgres counts them.
    expect(steps(['🍜'.repeat(2000)])).toBe(true);
    expect(steps(['🍜'.repeat(2001)])).toBe(false);
    expect(steps([''])).toBe(false);
    expect(steps('Soak the noodles.')).toBe(false);
  });

  it('image_url: https only, at most 2048 characters, or null', () => {
    const image = (u: unknown) => ExtractedRecipeSchema.safeParse({ ...recipe, image_url: u }).success;
    const at = (n: number) => `https://example.com/${'a'.repeat(n - 'https://example.com/'.length)}`;
    expect([null, at(2048), 'https://x.example/a.png'].map(image)).toEqual([true, true, true]);
    expect([at(2049), 'http://example.com/a.jpg', '/a.jpg', ''].map(image)).toEqual([false, false, false, false]);
  });

  it('a cached v2 result (no steps or photo) fails, so it is a miss', () => {
    const { steps: _s, image_url: _i, ...v2 } = recipe;
    expect(ExtractedRecipeSchema.safeParse(v2).success).toBe(false);
  });

  it('accepts a non-recipe answer and null quantity, unit, servings and time', () => {
    const answer = {
      is_recipe: false,
      name: '',
      servings: null,
      ingredients: [{ name: 'salt', quantity: null, unit: null, note: 'to taste' }],
      tags: { meal: [], cuisine: [], protein: [], diet: [], method: [] },
      total_minutes: null,
      steps: [],
      image_url: null,
    };
    expect(ExtractedRecipeSchema.parse(answer)).toEqual(answer);
  });

  it('accepts every supported unit and rejects anything else', () => {
    for (const unit of shared.UNITS) {
      expect(ExtractedRecipeSchema.safeParse({ ...recipe, ingredients: [{ ...ingredient, unit }] }).success).toBe(true);
    }
    for (const unit of ['count', 'stick', 'Cup', '']) {
      expect(ExtractedRecipeSchema.safeParse({ ...recipe, ingredients: [{ ...ingredient, unit }] }).success).toBe(
        false,
      );
    }
  });

  it('caps the name at 120 characters', () => {
    expect(ExtractedRecipeSchema.safeParse({ ...recipe, name: 'a'.repeat(120) }).success).toBe(true);
    expect(ExtractedRecipeSchema.safeParse({ ...recipe, name: 'a'.repeat(121) }).success).toBe(false);
  });

  it('caps ingredients at 80', () => {
    const list = (n: number) => Array.from({ length: n }, () => ingredient);
    expect(ExtractedRecipeSchema.safeParse({ ...recipe, ingredients: list(80) }).success).toBe(true);
    expect(ExtractedRecipeSchema.safeParse({ ...recipe, ingredients: list(81) }).success).toBe(false);
  });

  it('caps an ingredient name at 64 and a note at 120 characters', () => {
    const parse = (i: object) => ExtractedRecipeSchema.safeParse({ ...recipe, ingredients: [{ ...ingredient, ...i }] });
    expect(parse({ name: 'a'.repeat(64) }).success).toBe(true);
    expect(parse({ name: 'a'.repeat(65) }).success).toBe(false);
    expect(parse({ note: 'a'.repeat(120) }).success).toBe(true);
    expect(parse({ note: 'a'.repeat(121) }).success).toBe(false);
  });

  it('rejects missing fields', () => {
    expect(ExtractedRecipeSchema.safeParse({ ...recipe, is_recipe: undefined }).success).toBe(false);
    expect(ExtractedRecipeSchema.safeParse({ ...recipe, ingredients: [{ name: 'garlic' }] }).success).toBe(false);
    expect(ExtractedRecipeSchema.safeParse({ ...recipe, total_minutes: undefined }).success).toBe(false);
  });

  describe('tags', () => {
    const parseTags = (t: unknown) => ExtractedRecipeSchema.parse({ ...recipe, tags: t }).tags;
    const empty = { meal: [], cuisine: [], protein: [], diet: [], method: [] };

    it('a slug the list doesn’t have empties only its facet', () => {
      expect(parseTags({ ...tags, cuisine: ['thai', 'fusion'] })).toEqual({ ...tags, cuisine: [] });
      // A real slug in the wrong facet is unknown there.
      expect(parseTags({ ...tags, meal: ['dinner', 'chicken'] })).toEqual({ ...tags, meal: [] });
    });

    it('a facet that isn’t an array of strings, or is missing, is empty', () => {
      expect(parseTags({ ...tags, protein: 'shellfish' })).toEqual({ ...tags, protein: [] });
      expect(parseTags({ ...tags, protein: [1, 2] })).toEqual({ ...tags, protein: [] });
      expect(parseTags({ ...tags, protein: null })).toEqual({ ...tags, protein: [] });
      expect(parseTags({ meal: ['lunch'] })).toEqual({ ...empty, meal: ['lunch'] });
    });

    it('a facet over its maximum is cut to its first values', () => {
      expect(parseTags({ ...tags, meal: ['lunch', 'dinner', 'side'] }).meal).toEqual(['lunch', 'dinner']);
      expect(parseTags({ ...tags, protein: ['chicken', 'beef', 'pork', 'fish'] }).protein).toEqual([
        'chicken',
        'beef',
        'pork',
      ]);
      expect(parseTags({ ...tags, protein: ['chicken', 'beef', 'pork'] }).protein).toEqual(['chicken', 'beef', 'pork']);
    });

    it('drops repeats before the cap', () => {
      expect(parseTags({ ...tags, meal: ['dinner', 'dinner', 'lunch'] }).meal).toEqual(['dinner', 'lunch']);
    });

    it('drops other keys, and anything but an object is every facet empty', () => {
      expect(parseTags({ ...tags, allergens: ['nuts'] })).toEqual(tags);
      expect(parseTags(null)).toEqual(empty);
      expect(parseTags(['dinner'])).toEqual(empty);
      expect(parseTags(undefined)).toEqual(empty);
    });
  });

  it('total_minutes is whole minutes from 1 to 2880, or null', () => {
    const minutes = (m: unknown) => ExtractedRecipeSchema.safeParse({ ...recipe, total_minutes: m }).success;
    expect([1, 2880, null].map(minutes)).toEqual([true, true, true]);
    expect([0, 2881, 12.5, -5, '30'].map(minutes)).toEqual([false, false, false, false, false]);
  });
});

describe('RecipeImportResponseSchema', () => {
  const ingredient = {
    ingredientName: 'garlic',
    displayName: 'Garlic',
    quantity: 2,
    unit: 'clove',
    note: 'minced',
    categoryId: '019a4c10-0000-7000-8000-00000000ca01',
    status: 'categorized',
  };
  const tags = { meal: ['dinner'], cuisine: ['thai'], protein: [], diet: [], method: [] };
  const response = {
    name: 'Pad Thai',
    sourceUrl: 'https://example.com/pad-thai',
    servings: 4,
    ingredients: [ingredient],
    tags,
    totalMinutes: 30,
    steps: ['Soak the noodles.', 'Fry the garlic.'],
    imageUrl: 'https://example.com/pad-thai.jpg',
  };

  it('carries tags (unknown slugs kept, as stored) and the time', () => {
    const newer = { ...tags, cuisine: ['thai', 'peruvian'] };
    expect(RecipeImportResponseSchema.parse({ ...response, tags: newer })).toMatchObject({ tags: newer, totalMinutes: 30 });
  });

  it('carries the steps and the photo', () => {
    expect(RecipeImportResponseSchema.parse(response)).toMatchObject({
      steps: ['Soak the noodles.', 'Fry the garlic.'],
      imageUrl: 'https://example.com/pad-thai.jpg',
    });
    expect(RecipeImportResponseSchema.parse({ ...response, steps: [], imageUrl: null })).toMatchObject({ steps: [], imageUrl: null });
  });

  it('missing or unreadable steps and photo are [] and null (an older server), and the rest still parses', () => {
    const { steps: _s, imageUrl: _i, ...older } = response;
    expect(RecipeImportResponseSchema.parse(older)).toEqual({ ...older, steps: [], imageUrl: null });
    expect(RecipeImportResponseSchema.parse({ ...response, steps: 'Soak.', imageUrl: 42 })).toEqual({
      ...response,
      steps: [],
      imageUrl: null,
    });
    expect(RecipeImportResponseSchema.parse({ ...response, steps: ['Soak.', 3] }).steps).toEqual([]);
  });

  it('missing or unreadable tags and time are null (an older server), and the rest still parses', () => {
    const { tags: _t, totalMinutes: _m, steps: _s, imageUrl: _i, ...older } = response;
    expect(RecipeImportResponseSchema.parse(older)).toEqual({ ...older, tags: null, totalMinutes: null, steps: [], imageUrl: null });
    expect(RecipeImportResponseSchema.parse({ ...response, tags: 'dinner', totalMinutes: 0 })).toEqual({
      ...response,
      tags: null,
      totalMinutes: null,
    });
    expect(RecipeImportResponseSchema.parse({ ...response, totalMinutes: 2881 }).totalMinutes).toBeNull();
    expect(RecipeImportResponseSchema.parse({ ...response, tags: { meal: ['lunch'] } }).tags).toEqual({
      meal: ['lunch'],
      cuisine: [],
      protein: [],
      diet: [],
      method: [],
    });
  });

  it('accepts a response, including a pending ingredient with no category', () => {
    expect(RecipeImportResponseSchema.parse(response)).toEqual(response);
    const pending = { ...ingredient, ingredientName: 'tamarind paste', categoryId: null, status: 'pending' };
    expect(RecipeImportResponseSchema.parse({ ...response, ingredients: [pending] }).ingredients[0]).toEqual(pending);
  });

  it('rejects an unknown status, an unsupported unit and an empty key', () => {
    const parse = (i: object) => RecipeImportResponseSchema.safeParse({ ...response, ingredients: [{ ...ingredient, ...i }] });
    expect(parse({ status: 'sorting' }).success).toBe(false);
    expect(parse({ unit: 'stick' }).success).toBe(false);
    expect(parse({ ingredientName: '' }).success).toBe(false);
  });
});

describe('error codes', () => {
  it('are exactly the five from spec 6.6 plus not_entitled from 4.12', () => {
    expect(RECIPE_IMPORT_ERROR_CODES).toEqual([
      'invalid_url',
      'fetch_failed',
      'not_a_recipe',
      'rate_limited',
      'unavailable',
      'not_entitled',
    ]);
  });

  it('parse a not_entitled error body', () => {
    const body = { error: 'not_entitled', message: "Recipe import isn't included in your plan" };
    expect(RecipeImportErrorSchema.parse(body)).toEqual(body);
    expect(RecipeImportErrorCodeSchema.safeParse('not_entitled').success).toBe(true);
    expect(RecipeImportErrorCodeSchema.safeParse('forbidden').success).toBe(false);
  });

  it('parse in an error body and reject anything else', () => {
    expect(RecipeImportErrorSchema.parse({ error: 'not_a_recipe', message: 'No recipe here' })).toEqual({
      error: 'not_a_recipe',
      message: 'No recipe here',
    });
    expect(RecipeImportErrorCodeSchema.safeParse('timeout').success).toBe(false);
  });
});

describe('@/shared', () => {
  it('exports the recipe import schemas', () => {
    expect(shared.canonicalRecipeUrl).toBe(canonicalRecipeUrl);
    expect(shared.RecipeImportRequestSchema).toBe(RecipeImportRequestSchema);
    expect(shared.ExtractedRecipeSchema).toBe(ExtractedRecipeSchema);
    expect(shared.RecipeImportResponseSchema).toBe(RecipeImportResponseSchema);
    expect(shared.RECIPE_IMPORT_ERROR_CODES).toBe(RECIPE_IMPORT_ERROR_CODES);
  });
});
