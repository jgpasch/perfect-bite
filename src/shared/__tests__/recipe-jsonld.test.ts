import { describe, expect, it } from '@jest/globals';

import * as shared from '@/shared';
import { cleanJsonLdText, decodeHtmlEntities, findRecipe, parseIsoDuration } from '../recipe-jsonld';
import bbcfood from './fixtures/recipe-jsonld/bbcfood.json';
import bbcgoodfood from './fixtures/recipe-jsonld/bbcgoodfood.json';
import bonappetit from './fixtures/recipe-jsonld/bonappetit.json';
import delish from './fixtures/recipe-jsonld/delish.json';
import kingarthur from './fixtures/recipe-jsonld/kingarthur.json';
import recipetineats from './fixtures/recipe-jsonld/recipetineats.json';
import tasty from './fixtures/recipe-jsonld/tasty.json';

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
      totalMinutes: null,
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

describe('parseIsoDuration', () => {
  it('reads minutes, hours, days and seconds', () => {
    expect(parseIsoDuration('PT45M')).toBe(45);
    expect(parseIsoDuration('PT1H')).toBe(60);
    expect(parseIsoDuration('PT1H20M')).toBe(80);
    expect(parseIsoDuration('P0DT2H30M')).toBe(150);
    expect(parseIsoDuration('P1D')).toBe(1440);
    expect(parseIsoDuration('PT90S')).toBe(2);
    expect(parseIsoDuration('PT1.5H')).toBe(90);
    expect(parseIsoDuration(' pt60m ')).toBe(60);
  });

  it('is null for no time at all', () => {
    expect(parseIsoDuration('PT0S')).toBeNull();
    expect(parseIsoDuration('PT0M')).toBeNull();
    expect(parseIsoDuration('PT20S')).toBeNull();
  });

  it('is null for garbage, other units and non-strings', () => {
    expect(parseIsoDuration('40 minutes')).toBeNull();
    expect(parseIsoDuration('P')).toBeNull();
    expect(parseIsoDuration('PT')).toBeNull();
    expect(parseIsoDuration('')).toBeNull();
    expect(parseIsoDuration('PT-5M')).toBeNull();
    expect(parseIsoDuration('PT1H20')).toBeNull();
    expect(parseIsoDuration('P1Y')).toBeNull();
    expect(parseIsoDuration('P1M')).toBeNull();
    expect(parseIsoDuration('P1W')).toBeNull();
    expect(parseIsoDuration('45M')).toBeNull();
    expect(parseIsoDuration(45)).toBeNull();
    expect(parseIsoDuration(null)).toBeNull();
    expect(parseIsoDuration(undefined)).toBeNull();
    expect(parseIsoDuration({ value: 'PT45M' })).toBeNull();
  });
});

describe('findRecipe: total time', () => {
  const minutes = (fields: Record<string, unknown>) => findRecipe([block(recipe(fields))])?.totalMinutes;

  it('reads totalTime', () => {
    expect(minutes({ totalTime: 'PT1H20M' })).toBe(80);
  });

  it('prefers totalTime over prepTime + cookTime', () => {
    expect(minutes({ totalTime: 'PT2H', prepTime: 'PT10M', cookTime: 'PT20M' })).toBe(120);
  });

  it('adds prepTime and cookTime when there is no usable totalTime', () => {
    expect(minutes({ prepTime: 'PT15M', cookTime: 'PT45M' })).toBe(60);
    expect(minutes({ totalTime: 'about an hour', prepTime: 'PT15M', cookTime: 'PT1H' })).toBe(75);
    expect(minutes({ totalTime: 'PT0S', prepTime: 'PT10M', cookTime: 'PT0S' })).toBe(10);
  });

  it('uses prepTime or cookTime alone', () => {
    expect(minutes({ prepTime: 'PT10M' })).toBe(10);
    expect(minutes({ cookTime: 'PT25M', prepTime: 'soon' })).toBe(25);
  });

  it('is null with no usable time', () => {
    expect(minutes({})).toBeNull();
    expect(minutes({ totalTime: '40 minutes', cookTime: '20 minutes' })).toBeNull();
    expect(minutes({ totalTime: 'PT0S' })).toBeNull();
  });

  it('is null outside 1 to 2880 minutes', () => {
    expect(minutes({ totalTime: 'P2D' })).toBe(2880);
    expect(minutes({ totalTime: 'P2DT1M' })).toBeNull();
    expect(minutes({ prepTime: 'P1D', cookTime: 'P1DT1M' })).toBeNull();
  });
});

// Every application/ld+json block from each page, as served on 2026-10-10.
const FIXTURES: [string, string[], string, number, string, string, number, number | null][] = [
  ['bbc.co.uk/food (@graph, HTML in strings)', bbcfood, 'Easy chocolate cake', 12, '225g/8oz plain flour', '200ml/7fl oz double cream', 12, 90],
  ['bbcgoodfood (Recipe in 2nd block)', bbcgoodfood, 'Easy pancakes', 6, '100g plain flour', 'caster sugar to serve (optional)', 12, 30],
  [
    'bonappetit (top-level Recipe)',
    bonappetit,
    'BA’s Best Chocolate Chip Cookies',
    10,
    '1½ cups plus 1 Tbsp. (200 g) all-purpose flour (spooning into measuring cups, then leveling)',
    '6 oz. (170 g) bittersweet chocolate (60%–70% cacao), coarsely chopped, or semisweet chocolate chips',
    16,
    // "40 minutes" isn't ISO 8601.
    null,
  ],
  ['delish (top-level array)', delish, 'Creamy Tuscan Chicken', 12, '1 tbsp. extra-virgin olive oil', 'Lemon wedges, for serving', 4, 45],
  [
    'kingarthurbaking (@graph)',
    kingarthur,
    'Classic Sandwich Bread',
    7,
    '3 cups (360g) King Arthur Unbleached All-Purpose Flour',
    '2 teaspoons instant yeast',
    16,
    162,
  ],
  [
    'recipetineats (Yoast @graph, entities)',
    recipetineats,
    "JB's Chicken Chasseur",
    19,
    '4 chicken thighs, bone-in, skin on ((~250g/8oz each) (Note 1))',
    'Creamy mashed potato ((or rice or small pasta))',
    4,
    60,
  ],
  [
    'tasty (Recipe, VideoObject, array blocks)',
    tasty,
    'One-Pot Garlic Parmesan Pasta Recipe by Tasty',
    9,
    '2 tablespoons unsalted butter',
    '2 tablespoons fresh parsley, chopped',
    4,
    32,
  ],
];

describe('findRecipe: real pages', () => {
  it.each(FIXTURES)('%s', (_site, blocks, name, lineCount, first, last, servings, totalMinutes) => {
    const found = findRecipe(blocks);
    expect(found?.name).toBe(name);
    expect(found?.ingredientLines).toHaveLength(lineCount);
    expect(found?.ingredientLines[0]).toBe(first);
    expect(found?.ingredientLines.at(-1)).toBe(last);
    expect(found?.servings).toBe(servings);
    expect(found?.totalMinutes).toBe(totalMinutes);
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

describe('decodeHtmlEntities', () => {
  it('decodes named, decimal and hex entities without touching tags or whitespace', () => {
    expect(decodeHtmlEntities('<b>Fish &AMP; chips</b>  &#8211;&#x2014;&frac12;')).toBe('<b>Fish & chips</b>  –—½');
  });

  it('leaves unknown and out-of-range entities alone, and decodes once', () => {
    expect(decodeHtmlEntities('&copy; &#0; &#x110000; &amp;gt;')).toBe('&copy; &#0; &#x110000; &gt;');
  });
});

describe('exports', () => {
  it('exports findRecipe and decodeHtmlEntities from @/shared', () => {
    expect(shared.findRecipe).toBe(findRecipe);
    expect(shared.decodeHtmlEntities).toBe(decodeHtmlEntities);
    expect(shared.parseIsoDuration).toBe(parseIsoDuration);
  });
});
