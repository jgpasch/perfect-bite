import { describe, expect, it } from '@jest/globals';

import * as shared from '@/shared';
import {
  cleanImageUrl,
  cleanJsonLdText,
  cleanRecipeSteps,
  decodeHtmlEntities,
  findRecipe,
  jsonLdImageCandidates,
  parseIsoDuration,
} from '../recipe-jsonld';
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
      steps: [],
      imageUrl: null,
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

// Steps (count, first, last) and image from each fixture.
const FIXTURE_STEPS_AND_IMAGE: [string, string[], number, string, string, string][] = [
  [
    'bbc.co.uk/food (array of strings, ImageObject)',
    bbcfood,
    9,
    'Preheat the oven to 180C/160C Fan/Gas 4. Grease and line two 20cm/8in sandwich tins.',
    'Transfer the cake to a serving plate and ice the cake all over with the chocolate ganache, using a palette knife.',
    'https://ichef.bbci.co.uk/food/ic/food_16x9_1600/recipes/easy_chocolate_cake_31070_16x9.jpg',
  ],
  [
    'bbcgoodfood (HowToSteps, array of ImageObjects)',
    bbcgoodfood,
    5,
    'Put 100g plain flour, 2 large eggs, 300ml milk, 1 tbsp sunflower or vegetable oil and a pinch of salt into a bowl or large jug, then whisk to a smooth batter. This should be similar in consistency to single cream.',
    'Serve with lemon wedges and caster sugar, or your favourite filling. Once cold, you can layer the pancakes between baking parchment, then wrap in cling film and freeze for up to two months.',
    'https://images.immediate.co.uk/production/volatile/sites/30/2020/08/recipe-image-legacy-id-1273477_8-ad36e3b.jpg?resize=440,400',
  ],
  [
    'bonappetit (HowToSteps, array of strings)',
    bonappetit,
    4,
    'Place racks in upper and lower thirds of oven; preheat to 375°. Whisk 1½ cups plus 1 Tbsp. (200 g) all-purpose flour, 1¼ tsp. (4 g) Diamond Crystal or ¾ tsp. (4 g) Morton kosher salt, and ¾ tsp. (4 g) baking soda in a small bowl; set flour mixture aside.',
    expect.stringMatching(/^Using a 1½-oz\. scoop .* more easy cookie recipes →$/) as unknown as string,
    'https://assets.bonappetit.com/photos/5ca534485e96521ff23b382b/16:9/w_4800,h_2700,c_limit/chocolate-chip-cookie.jpg',
  ],
  [
    'delish (HowToSteps, array of ImageObjects)',
    delish,
    4,
    'In a large skillet over medium heat, heat oil. Sprinkle chicken all over with salt, pepper, and oregano. Cook, turning halfway through, until browned on both sides and an instant-read thermometer inserted into thickest part registers 165°, about 8 minutes per side. Transfer to a plate.',
    'Divide chicken among plates. Spoon sauce over. Serve with lemon wedges alongside.',
    'https://hips.hearstapps.com/hmg-prod/images/1d09a24f-5b76-49f4-9ad6-496acdc03933.jpg?crop=0.502xw:1.00xh;0.250xw,0&resize=1200:*',
  ],
  [
    'kingarthurbaking (array of strings, ImageObject)',
    kingarthur,
    7,
    'Weigh your flour; or measure it by gently spooning it into a cup, then sweeping off any excess.',
    'Remove the bread from the oven, and cool it on a rack before slicing. Store the bread in a plastic bag at room temperature for several days; freeze for longer storage.',
    'https://www.kingarthurbaking.com/sites/default/files/2026-02/Classic-Sandwich-Bread-12.jpg',
  ],
  [
    'recipetineats (HowToSections, array of strings)',
    recipetineats,
    10,
    'Season and flour the chicken, then brown in oil and butter. Remove. Sauté mushrooms and onion, add garlic briefly, then pour in brandy and wine to reduce. Stir in tomato paste for 1 minute, then stock, salt, and pepper. Return chicken, simmer covered 10 minutes then uncovered for 20 minutes until tender. Finish with cold butter and fresh tarragon.',
    'Serve - Bring the sauce to a gentle simmer again. Return the chicken to the sauce and sprinkle over the fresh tarragon. Take it to the table and serve out of the pan with creamy mashed potato.',
    'https://www.recipetineats.com/tachyon/2025/10/Chicken-Chasseur-JB_7.jpg',
  ],
  [
    'tasty (HowToSteps, string)',
    tasty,
    6,
    'Heat unsalted butter in a large skillet over medium high heat. Add garlic and cook, stirring frequently, until fragrant, about 1-2 minutes.',
    'Enjoy!',
    'https://img.buzzfeed.com/thumbnailer-prod-us-east-1/f69a7f4192b94d8395757b365ac6d866/GarlicParmPasta.jpg?resize=1200:*',
  ],
];

describe('findRecipe: real pages, steps and image', () => {
  it.each(FIXTURE_STEPS_AND_IMAGE)('%s', (_site, blocks, stepCount, first, last, imageUrl) => {
    const found = findRecipe(blocks, 'https://example.com/recipe/');
    expect(found?.steps).toHaveLength(stepCount);
    expect(found?.steps[0]).toBe(first);
    expect(found?.steps.at(-1)).toEqual(last);
    expect(found?.imageUrl).toBe(imageUrl);
  });
});

describe('findRecipe: steps', () => {
  const steps = (recipeInstructions: unknown) => findRecipe([block(recipe({ recipeInstructions }))])?.steps;

  it('splits a single string on line breaks', () => {
    expect(steps('Boil the noodles.\nFry the eggs.\r\nToss together.\rServe.')).toEqual([
      'Boil the noodles.',
      'Fry the eggs.',
      'Toss together.',
      'Serve.',
    ]);
  });

  it('splits a single HTML string on <br> and paragraph and list ends', () => {
    expect(steps('<ol><li>Boil.</li><li>Fry.</li></ol><p>Toss.</p><p>Serve.<br/>Eat.</p>')).toEqual([
      'Boil.',
      'Fry.',
      'Toss.',
      'Serve.',
      'Eat.',
    ]);
  });

  it('reads an array of strings', () => {
    expect(steps(['Boil.', 'Fry.'])).toEqual(['Boil.', 'Fry.']);
  });

  it('keeps each string of an array as one step', () => {
    expect(steps(['Boil the noodles.\nDrain.', 'Fry.<br>Season.'])).toEqual(['Boil the noodles. Drain.', 'Fry. Season.']);
  });

  it('reads HowToSteps by text, else name', () => {
    expect(
      steps([
        { '@type': 'HowToStep', text: 'Boil.', name: 'Ignored' },
        { '@type': 'HowToStep', name: 'Fry.' },
        { '@type': 'HowToStep', text: '  ', name: 'Toss.' },
        { '@type': 'HowToStep', text: 5 },
        { '@type': 'HowToStep' },
      ]),
    ).toEqual(['Boil.', 'Fry.', 'Toss.']);
  });

  it('flattens HowToSections in order and drops the section names', () => {
    expect(
      steps([
        {
          '@type': 'HowToSection',
          name: 'For the sauce',
          itemListElement: [
            { '@type': 'HowToStep', text: 'Whisk the sauce.' },
            { '@type': 'HowToStep', text: 'Set aside.' },
          ],
        },
        'Boil the noodles.',
        {
          '@type': 'HowToSection',
          name: 'To finish',
          itemListElement: { '@type': 'HowToStep', text: 'Toss with the sauce.' },
        },
      ]),
    ).toEqual(['Whisk the sauce.', 'Set aside.', 'Boil the noodles.', 'Toss with the sauce.']);
  });

  it('strips HTML tags and entities and collapses whitespace', () => {
    expect(steps(['<p>Add salt&nbsp;&amp;\t <b>pepper</b>&hellip;</p>'])).toEqual(['Add salt & pepper …']);
  });

  it('drops leading numbering', () => {
    expect(
      steps(['1. Boil.', '2) Fry.', 'Step 3: Toss.', 'STEP 4 - Plate.', 'step 5 Serve.', '6- Eat.', '7 : Rest.']),
    ).toEqual(['Boil.', 'Fry.', 'Toss.', 'Plate.', 'Serve.', 'Eat.', 'Rest.']);
  });

  it('keeps a leading quantity that is not numbering', () => {
    expect(steps(['2 eggs go in now.', '1.5 cups of stock.', '10-12 minutes more.'])).toEqual([
      '2 eggs go in now.',
      '1.5 cups of stock.',
      '10-12 minutes more.',
    ]);
  });

  it('drops empty steps, bare numbering and a step identical to the one before', () => {
    expect(steps(['Boil.', '', '  ', '<br>', 'Step 2', '3.', 'Boil.', '1. Fry.', 'Fry.', 'Boil.'])).toEqual([
      'Boil.',
      'Fry.',
      'Boil.',
    ]);
  });

  it('caps at 100 steps', () => {
    const many = Array.from({ length: 150 }, (_, i) => `Do thing ${i + 1}.`);
    const result = steps(many);
    expect(result).toHaveLength(100);
    expect(result?.at(-1)).toBe('Do thing 100.');
  });

  it('caps each step at 2000 characters without splitting an emoji', () => {
    expect(steps(['a'.repeat(2500)])).toEqual(['a'.repeat(2000)]);
    expect(steps(['a'.repeat(1999) + '🍳🍳'])).toEqual(['a'.repeat(1999) + '🍳']);
    expect(steps(['a'.repeat(1999) + ' b'])).toEqual(['a'.repeat(1999)]);
  });

  it('is empty when missing or unusable', () => {
    expect(steps(undefined)).toEqual([]);
    expect(steps(null)).toEqual([]);
    expect(steps(42)).toEqual([]);
    expect(steps('')).toEqual([]);
    expect(steps([])).toEqual([]);
    expect(steps({ '@type': 'HowToSection', name: 'Empty', itemListElement: [] })).toEqual([]);
  });
});

describe('findRecipe: image', () => {
  const PAGE = 'https://cook.example.com/recipes/pad-thai/';
  const image = (value: unknown, pageUrl: string | null = PAGE) =>
    findRecipe([block(recipe({ image: value }))], pageUrl)?.imageUrl;

  it('reads a string', () => {
    expect(image('https://cdn.example.com/pad-thai.jpg')).toBe('https://cdn.example.com/pad-thai.jpg');
  });

  it('reads an ImageObject by url, else contentUrl', () => {
    expect(image({ '@type': 'ImageObject', url: 'https://cdn.example.com/a.jpg', contentUrl: 'https://cdn.example.com/b.jpg' })).toBe(
      'https://cdn.example.com/a.jpg',
    );
    expect(image({ '@type': 'ImageObject', contentUrl: 'https://cdn.example.com/b.jpg' })).toBe(
      'https://cdn.example.com/b.jpg',
    );
    expect(image({ '@type': 'ImageObject', url: 'http://cdn.example.com/a.jpg', contentUrl: 'https://cdn.example.com/b.jpg' })).toBe(
      'https://cdn.example.com/b.jpg',
    );
  });

  it('reads the first usable entry of an array', () => {
    expect(image(['https://cdn.example.com/1.jpg', 'https://cdn.example.com/2.jpg'])).toBe('https://cdn.example.com/1.jpg');
    expect(image([null, 'http://cdn.example.com/1.jpg', { url: 7 }, { url: 'https://cdn.example.com/3.jpg' }])).toBe(
      'https://cdn.example.com/3.jpg',
    );
  });

  it('resolves a relative URL against the page URL', () => {
    expect(image('/images/pad-thai.jpg')).toBe('https://cook.example.com/images/pad-thai.jpg');
    expect(image('pad-thai.jpg')).toBe('https://cook.example.com/recipes/pad-thai/pad-thai.jpg');
    expect(image('//cdn.example.com/pad-thai.jpg')).toBe('https://cdn.example.com/pad-thai.jpg');
    expect(image({ url: '../hero.jpg' })).toBe('https://cook.example.com/recipes/hero.jpg');
  });

  it('drops a relative URL with no page URL', () => {
    expect(image('/images/pad-thai.jpg', null)).toBeNull();
    expect(image('https://cdn.example.com/pad-thai.jpg', null)).toBe('https://cdn.example.com/pad-thai.jpg');
    expect(findRecipe([block(recipe({ image: '/images/pad-thai.jpg' }))])?.imageUrl).toBeNull();
  });

  it('drops http:// and other schemes, including a relative URL on an http page', () => {
    expect(image('http://cdn.example.com/pad-thai.jpg')).toBeNull();
    expect(image('/images/pad-thai.jpg', 'http://cook.example.com/recipes/')).toBeNull();
    expect(image('data:image/png;base64,AAAA')).toBeNull();
    expect(image('javascript:alert(1)')).toBeNull();
  });

  it('is null when missing or unusable', () => {
    expect(image(undefined)).toBeNull();
    expect(image('')).toBeNull();
    expect(image(42)).toBeNull();
    expect(image([])).toBeNull();
    expect(image({ '@id': 'https://cook.example.com/#primaryimage' })).toBeNull();
  });

  // Yoast/WordPress: the Recipe's image is a reference to an ImageObject elsewhere in the @graph.
  const yoastGraph = (recipeFields: Record<string, unknown>, extra: unknown[] = []) =>
    block({
      '@context': 'https://schema.org',
      '@graph': [
        { '@type': 'ImageObject', '@id': `${PAGE}#primaryimage`, url: '/wp-content/uploads/pad-thai.jpg', width: 1200 },
        recipe(recipeFields),
        ...extra,
      ],
    });

  it('resolves an @id reference to an ImageObject in the same @graph', () => {
    expect(findRecipe([yoastGraph({ image: { '@id': `${PAGE}#primaryimage` } })], PAGE)?.imageUrl).toBe(
      'https://cook.example.com/wp-content/uploads/pad-thai.jpg',
    );
    // In an array, and with the ImageObject after the Recipe.
    const after = block({
      '@graph': [recipe({ image: [{ '@id': '#hero' }] }), { '@type': 'ImageObject', '@id': '#hero', contentUrl: 'https://cdn.example.com/hero.jpg' }],
    });
    expect(findRecipe([after], PAGE)?.imageUrl).toBe('https://cdn.example.com/hero.jpg');
  });

  it('resolves a reference to a node in another block', () => {
    const imageBlock = block({ '@type': 'ImageObject', '@id': '#hero', url: 'https://cdn.example.com/other-block.jpg' });
    expect(findRecipe([block(recipe({ image: { '@id': '#hero' } })), imageBlock], PAGE)?.imageUrl).toBe('https://cdn.example.com/other-block.jpg');
  });

  it('a reference to a node with no usable image, or to itself, is null, not a loop', () => {
    const graph = block({
      '@graph': [recipe({ '@id': '#recipe', image: { '@id': '#recipe' } }), { '@type': 'ImageObject', '@id': '#bad', url: 'http://cdn.example.com/a.jpg' }],
    });
    expect(findRecipe([graph], PAGE)?.imageUrl).toBeNull();
    expect(findRecipe([yoastGraph({ image: { '@id': '#bad' } }, [{ '@type': 'ImageObject', '@id': '#bad', url: 'http://x.example/a.jpg' }])], PAGE)?.imageUrl).toBeNull();
  });

  it('falls back to thumbnailUrl when image has nothing usable', () => {
    expect(findRecipe([block(recipe({ thumbnailUrl: 'https://cdn.example.com/thumb.jpg' }))], PAGE)?.imageUrl).toBe('https://cdn.example.com/thumb.jpg');
    expect(
      findRecipe([block(recipe({ image: 'http://cdn.example.com/a.jpg', thumbnailUrl: ['/thumb.jpg'] }))], PAGE)?.imageUrl,
    ).toBe('https://cook.example.com/thumb.jpg');
    // image wins over thumbnailUrl.
    expect(
      findRecipe([block(recipe({ image: 'https://cdn.example.com/a.jpg', thumbnailUrl: 'https://cdn.example.com/thumb.jpg' }))], PAGE)?.imageUrl,
    ).toBe('https://cdn.example.com/a.jpg');
  });
});

describe('jsonLdImageCandidates', () => {
  const PAGE = 'https://cook.example.com/recipes/pad-thai/';
  const graph = (...nodes: unknown[]) => block({ '@context': 'https://schema.org', '@graph': nodes });
  const primary = { '@type': 'ImageObject', '@id': `${PAGE}#primaryimage`, url: 'https://cdn.example.com/primary.png' };

  it('rung 1: the Recipe’s image, then its thumbnailUrl', () => {
    expect(
      jsonLdImageCandidates([block(recipe({ image: ['https://cdn.example.com/1.jpg', 'https://cdn.example.com/2.jpg'], thumbnailUrl: 'https://cdn.example.com/t.jpg' }))], PAGE),
    ).toEqual(['https://cdn.example.com/1.jpg', 'https://cdn.example.com/2.jpg', 'https://cdn.example.com/t.jpg']);
  });

  it('rung 2: a WebPage’s primaryImageOfPage and an Article’s image, @id references resolved', () => {
    // The Yoast @graph with no Recipe node.
    const yoast = graph(
      { '@type': 'Article', '@id': `${PAGE}#article`, image: { '@id': `${PAGE}#primaryimage` }, thumbnailUrl: 'https://cdn.example.com/primary.png' },
      { '@type': 'WebPage', '@id': PAGE, primaryImageOfPage: { '@id': `${PAGE}#primaryimage` } },
      primary,
      { '@type': 'Organization', '@id': `${PAGE}#org`, logo: { '@type': 'ImageObject', url: 'https://cdn.example.com/logo.png' } },
    );
    expect(jsonLdImageCandidates([yoast], PAGE)).toEqual(['https://cdn.example.com/primary.png']);
    // Types as IRIs or arrays, and the page's own subtypes.
    const typed = graph(
      { '@type': ['schema:BlogPosting'], image: 'https://cdn.example.com/post.jpg' },
      { '@type': 'https://schema.org/ItemPage', primaryImageOfPage: { url: 'https://cdn.example.com/page.jpg' } },
    );
    expect(jsonLdImageCandidates([typed], PAGE)).toEqual(['https://cdn.example.com/page.jpg', 'https://cdn.example.com/post.jpg']);
  });

  it('an earlier rung wins and repeats are dropped', () => {
    const blocks = [
      graph({ '@type': 'WebPage', primaryImageOfPage: { '@id': '#p' } }, { ...primary, '@id': '#p' }),
      block(recipe({ image: 'https://cdn.example.com/recipe.jpg', thumbnailUrl: 'https://cdn.example.com/primary.png' })),
    ];
    expect(jsonLdImageCandidates(blocks, PAGE)).toEqual(['https://cdn.example.com/recipe.jpg', 'https://cdn.example.com/primary.png']);
  });

  it('counts a Recipe without ingredients, which findRecipe skips', () => {
    expect(jsonLdImageCandidates([block({ '@type': 'Recipe', image: '/r.jpg' })], PAGE)).toEqual(['https://cook.example.com/r.jpg']);
  });

  it('skips malformed blocks and unusable URLs; nothing usable is []', () => {
    expect(jsonLdImageCandidates(['{', block(recipe({ image: 'https://cdn.example.com/ok.jpg' }))], PAGE)).toEqual(['https://cdn.example.com/ok.jpg']);
    expect(jsonLdImageCandidates([block(recipe({ image: 'http://cdn.example.com/a.jpg' })), graph({ '@type': 'WebPage', primaryImageOfPage: { '@id': '#missing' } })], PAGE)).toEqual([]);
    expect(jsonLdImageCandidates([], PAGE)).toEqual([]);
    // Without a page URL only absolute ones count.
    expect(jsonLdImageCandidates([block(recipe({ image: '/r.jpg', thumbnailUrl: 'https://cdn.example.com/t.jpg' }))])).toEqual(['https://cdn.example.com/t.jpg']);
  });
});

describe('cleanImageUrl', () => {
  const PAGE = 'https://cook.example.com/recipes/pad-thai/';

  it('keeps an https URL as is', () => {
    expect(cleanImageUrl('https://cdn.example.com/a.jpg?w=1200&h=800', PAGE)).toBe('https://cdn.example.com/a.jpg?w=1200&h=800');
  });

  it('trims and decodes entities', () => {
    expect(cleanImageUrl('  https://cdn.example.com/a.jpg?w=1&amp;h=2 ', PAGE)).toBe('https://cdn.example.com/a.jpg?w=1&h=2');
  });

  it('resolves relative URLs against the page URL', () => {
    expect(cleanImageUrl('/a.jpg', PAGE)).toBe('https://cook.example.com/a.jpg');
    expect(cleanImageUrl('a.jpg', PAGE)).toBe('https://cook.example.com/recipes/pad-thai/a.jpg');
  });

  it('keeps at most 2048 characters', () => {
    const base = 'https://cdn.example.com/';
    const fits = base + 'a'.repeat(2048 - base.length);
    expect(cleanImageUrl(fits, PAGE)).toBe(fits);
    expect(cleanImageUrl(fits + 'a', PAGE)).toBeNull();
  });

  it('is null for http, other schemes, garbage and non-strings', () => {
    expect(cleanImageUrl('http://cdn.example.com/a.jpg', PAGE)).toBeNull();
    expect(cleanImageUrl('ftp://cdn.example.com/a.jpg', PAGE)).toBeNull();
    expect(cleanImageUrl('https://', PAGE)).toBeNull();
    expect(cleanImageUrl('a.jpg', 'not a url')).toBeNull();
    expect(cleanImageUrl('a.jpg', null)).toBeNull();
    expect(cleanImageUrl('   ', PAGE)).toBeNull();
    expect(cleanImageUrl(null, PAGE)).toBeNull();
    expect(cleanImageUrl({ url: 'https://cdn.example.com/a.jpg' }, PAGE)).toBeNull();
  });
});

describe('cleanRecipeSteps (the model’s steps)', () => {
  it('keeps the wording, dropping numbering, HTML, blanks and a repeat of the step before', () => {
    expect(
      cleanRecipeSteps(['1. Preheat the oven to 200°C.', '  ', 'Step 2: Mix the  flour\nand <b>salt</b> well.', 'Mix the flour and salt well.', '2 eggs go in last.']),
    ).toEqual(['Preheat the oven to 200°C.', 'Mix the flour and salt well.', '2 eggs go in last.']);
  });

  it('caps at 100 steps of 2000 characters', () => {
    const many = Array.from({ length: 120 }, (_, i) => `Stir ${i}`);
    expect(cleanRecipeSteps(many)).toHaveLength(100);
    expect(cleanRecipeSteps(many).at(-1)).toBe('Stir 99');
    expect(Array.from(cleanRecipeSteps(['🍜'.repeat(2100)])[0])).toHaveLength(2000);
  });

  it('is empty for no steps', () => {
    expect(cleanRecipeSteps([])).toEqual([]);
    expect(cleanRecipeSteps(['', ' <br> '])).toEqual([]);
  });
});

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
    expect(shared.cleanImageUrl).toBe(cleanImageUrl);
    expect(shared.cleanRecipeSteps).toBe(cleanRecipeSteps);
    expect(shared.jsonLdImageCandidates).toBe(jsonLdImageCandidates);
  });
});
