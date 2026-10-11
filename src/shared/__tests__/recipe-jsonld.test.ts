import { describe, expect, it } from '@jest/globals';

import * as shared from '@/shared';
import { cleanJsonLdText, findRecipe } from '../recipe-jsonld';

const recipe = (fields: Record<string, unknown> = {}) => ({
  '@context': 'https://schema.org',
  '@type': 'Recipe',
  name: 'Pad Thai',
  recipeIngredient: ['200 g rice noodles', '2 eggs'],
  recipeYield: '2 servings',
  ...fields,
});

const block = (value: unknown) => JSON.stringify(value);

describe('findRecipe: block shapes', () => {
  it('reads a top-level Recipe object', () => {
    expect(findRecipe([block(recipe())])).toEqual({
      name: 'Pad Thai',
      ingredientLines: ['200 g rice noodles', '2 eggs'],
      servings: 2,
    });
  });

  it('reads a Recipe from a top-level array', () => {
    const value = [{ '@type': 'Organization', name: 'Site' }, recipe({ name: 'Ramen' })];
    expect(findRecipe([block(value)])?.name).toBe('Ramen');
  });

  it('reads a Recipe from @graph', () => {
    const value = {
      '@context': 'https://schema.org',
      '@graph': [
        { '@type': 'WebSite', name: 'Site' },
        { '@type': 'BreadcrumbList', itemListElement: [] },
        recipe({ name: 'Curry' }),
      ],
    };
    expect(findRecipe([block(value)])?.name).toBe('Curry');
  });

  it('reads @graph inside a top-level array', () => {
    expect(findRecipe([block([{ '@graph': [recipe({ name: 'Stew' })] }])])?.name).toBe('Stew');
  });

  it('accepts @type as an array', () => {
    expect(findRecipe([block(recipe({ '@type': ['Recipe', 'NewsArticle'] }))])?.name).toBe('Pad Thai');
    expect(findRecipe([block(recipe({ '@type': ['NewsArticle', 'Recipe'] }))])?.name).toBe('Pad Thai');
  });

  it('accepts prefixed and full-URL types', () => {
    expect(findRecipe([block(recipe({ '@type': 'schema:Recipe' }))])?.name).toBe('Pad Thai');
    expect(findRecipe([block(recipe({ '@type': 'http://schema.org/Recipe' }))])?.name).toBe('Pad Thai');
  });

  it('ignores nodes that are not Recipes', () => {
    expect(findRecipe([block(recipe({ '@type': 'NewsArticle' }))])).toBeNull();
    expect(findRecipe([block(recipe({ '@type': 'RecipeCollection' }))])).toBeNull();
    expect(findRecipe([block(recipe({ '@type': undefined }))])).toBeNull();
    expect(findRecipe([block(recipe({ '@type': [1, null] }))])).toBeNull();
  });

  it('returns the first Recipe across blocks', () => {
    const blocks = [block({ '@type': 'WebPage' }), block(recipe({ name: 'First' })), block(recipe({ name: 'Second' }))];
    expect(findRecipe(blocks)?.name).toBe('First');
  });

  it('skips a Recipe with no ingredient lines for a later one', () => {
    const blocks = [block(recipe({ name: 'Empty', recipeIngredient: [] })), block(recipe({ name: 'Full' }))];
    expect(findRecipe(blocks)?.name).toBe('Full');
  });

  it('returns null for no blocks, scalars and empty structures', () => {
    expect(findRecipe([])).toBeNull();
    expect(findRecipe(['null', '42', '"Recipe"', '[]', '{}', '{"@graph": null}'])).toBeNull();
  });
});

describe('findRecipe: malformed JSON', () => {
  it('skips a malformed block without failing the others', () => {
    const blocks = ['{"@type": "Recipe", "name": ', '', 'not json', block(recipe({ name: 'Good' }))];
    expect(findRecipe(blocks)?.name).toBe('Good');
  });

  it('returns null when every block is malformed', () => {
    expect(findRecipe(['{', '<script>', '{"a":}'])).toBeNull();
  });
});

describe('findRecipe: ingredients', () => {
  it('falls back to the legacy ingredients property', () => {
    const value = recipe({ recipeIngredient: undefined, ingredients: ['1 cup flour', '1 egg'] });
    expect(findRecipe([block(value)])?.ingredientLines).toEqual(['1 cup flour', '1 egg']);
  });

  it('prefers recipeIngredient over ingredients', () => {
    const value = recipe({ recipeIngredient: ['new'], ingredients: ['old'] });
    expect(findRecipe([block(value)])?.ingredientLines).toEqual(['new']);
  });

  it('accepts a single string', () => {
    expect(findRecipe([block(recipe({ recipeIngredient: '1 lemon' }))])?.ingredientLines).toEqual(['1 lemon']);
  });

  it('drops non-string and blank lines', () => {
    const value = recipe({ recipeIngredient: ['1 lemon', 3, null, { text: 'x' }, '   ', '<br>', 'salt'] });
    expect(findRecipe([block(value)])?.ingredientLines).toEqual(['1 lemon', 'salt']);
  });

  it('decodes entities and strips tags in lines', () => {
    const value = recipe({
      recipeIngredient: ['1 &frac12; cups <b>all-purpose</b> flour', 'salt &amp; pepper', 'Cook&#39;s choice&#x2122;'],
    });
    expect(findRecipe([block(value)])?.ingredientLines).toEqual([
      '1 ½ cups all-purpose flour',
      'salt & pepper',
      'Cook\'s choice™',
    ]);
  });
});

describe('findRecipe: name', () => {
  it('cleans the name', () => {
    expect(findRecipe([block(recipe({ name: '  Mom&rsquo;s <em>Best</em>\n Lasagna ' }))])?.name).toBe(
      'Mom’s Best Lasagna',
    );
  });

  it('is null when missing, blank or not a string', () => {
    expect(findRecipe([block(recipe({ name: undefined }))])?.name).toBeNull();
    expect(findRecipe([block(recipe({ name: ' <p></p> ' }))])?.name).toBeNull();
    expect(findRecipe([block(recipe({ name: 7 }))])?.name).toBeNull();
  });
});

describe('findRecipe: servings', () => {
  const servings = (recipeYield: unknown) => findRecipe([block(recipe({ recipeYield }))])?.servings;

  it('reads a number', () => {
    expect(servings(6)).toBe(6);
    expect(servings(2.6)).toBe(3);
  });

  it('reads the first number in a string', () => {
    expect(servings('4')).toBe(4);
    expect(servings('4 servings')).toBe(4);
    expect(servings('Makes 12 cookies')).toBe(12);
    expect(servings('4-6')).toBe(4);
    expect(servings('Serves 8 to 10')).toBe(8);
  });

  it('reads the first usable entry in an array', () => {
    expect(servings(['4', '4 servings'])).toBe(4);
    expect(servings(['one loaf', '12 slices'])).toBe(12);
    expect(servings([null, 0, 8])).toBe(8);
  });

  it('is null when missing, zero, negative or unreadable', () => {
    expect(servings(undefined)).toBeNull();
    expect(servings(0)).toBeNull();
    expect(servings(-2)).toBeNull();
    expect(servings(0.3)).toBeNull();
    expect(servings('a few')).toBeNull();
    expect(servings('')).toBeNull();
    expect(servings([])).toBeNull();
    expect(servings({ value: 4 })).toBeNull();
  });
});

describe('cleanJsonLdText', () => {
  it('collapses whitespace including non-breaking spaces', () => {
    expect(cleanJsonLdText('  a&nbsp;\n\t b  ')).toBe('a b');
  });

  it('leaves unknown and out-of-range entities alone', () => {
    expect(cleanJsonLdText('&bogus; &#0; &#x110000;')).toBe('&bogus; &#0; &#x110000;');
  });

  it('decodes &amp; only once', () => {
    expect(cleanJsonLdText('&amp;lt;')).toBe('&lt;');
  });
});

describe('exports', () => {
  it('exports findRecipe from @/shared', () => {
    expect(shared.findRecipe).toBe(findRecipe);
  });
});
