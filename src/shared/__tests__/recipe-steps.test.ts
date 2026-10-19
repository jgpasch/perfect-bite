import { describe, expect, test } from '@jest/globals';

import * as shared from '../index';
import { cleanRecipeSteps } from '../recipe-jsonld';
import { choiceGroups, isStepHeading, recipeSections, stepPath, stepTexts, type RecipeStepEntry } from '../recipe-steps';

// The familystylefood.com chicken-thigh-marinade shape: a section the others build on, then four ways to cook it.
const MARINADE: RecipeStepEntry[] = [
  { section: 'Marinate the chicken' },
  'Whisk the marinade.',
  'Coat the thighs and chill.',
  { section: 'Grilling', choice: true },
  'Heat the grill.',
  'Grill 6 minutes a side.',
  { section: 'Baking', choice: true },
  'Bake at 220°C for 25 minutes.',
  { section: 'Pan-Frying', choice: true },
  'Fry skin side down.',
  'Turn and finish.',
  { section: 'Broiling', choice: true },
  'Broil 5 minutes a side.',
  { section: 'Serve' },
  'Rest and slice.',
];

describe('stepTexts', () => {
  test('keeps the step strings in order and drops the headings', () => {
    expect(stepTexts(['Mix.', { section: 'Bake' }, 'Bake.', { section: 'Fry', choice: true }, 'Fry.'])).toEqual(['Mix.', 'Bake.', 'Fry.']);
  });

  test('without headings, the steps as they are', () => {
    expect(stepTexts(['Mix.', 'Bake.'])).toEqual(['Mix.', 'Bake.']);
  });

  test('null, undefined and [] are no steps', () => {
    expect(stepTexts(null)).toEqual([]);
    expect(stepTexts(undefined)).toEqual([]);
    expect(stepTexts([])).toEqual([]);
    expect(stepTexts([{ section: 'Only a heading' }])).toEqual([]);
  });
});

describe('isStepHeading', () => {
  test('a heading object, not a step string', () => {
    expect(isStepHeading({ section: 'Grill' })).toBe(true);
    expect(isStepHeading({ section: 'Grill', choice: true })).toBe(true);
    expect(isStepHeading('Grill')).toBe(false);
  });
});

describe('recipeSections', () => {
  test('no headings: one untitled section of every step', () => {
    expect(recipeSections(['Mix.', 'Bake.', 'Serve.'])).toEqual([{ title: null, choice: false, steps: [0, 1, 2] }]);
  });

  test('no steps: no sections', () => {
    expect(recipeSections(null)).toEqual([]);
    expect(recipeSections([])).toEqual([]);
  });

  test('steps before the first heading are an untitled section', () => {
    expect(recipeSections(['Preheat.', { section: 'Sauce' }, 'Simmer.', 'Season.', { section: 'Pasta' }, 'Boil.'])).toEqual([
      { title: null, choice: false, steps: [0] },
      { title: 'Sauce', choice: false, steps: [1, 2] },
      { title: 'Pasta', choice: false, steps: [3] },
    ]);
  });

  test('a group of 4 between shared sections', () => {
    expect(recipeSections(MARINADE)).toEqual([
      { title: 'Marinate the chicken', choice: false, steps: [0, 1] },
      { title: 'Grilling', choice: true, steps: [2, 3] },
      { title: 'Baking', choice: true, steps: [4] },
      { title: 'Pan-Frying', choice: true, steps: [5, 6] },
      { title: 'Broiling', choice: true, steps: [7] },
      { title: 'Serve', choice: false, steps: [8] },
    ]);
  });

  test('a lone choice section reads as an ordinary one', () => {
    expect(recipeSections([{ section: 'Prep' }, 'Chop.', { section: 'Grill', choice: true }, 'Grill.', { section: 'Serve' }, 'Plate.'])).toEqual([
      { title: 'Prep', choice: false, steps: [0] },
      { title: 'Grill', choice: false, steps: [1] },
      { title: 'Serve', choice: false, steps: [2] },
    ]);
  });

  test('a heading straight after another is a section with no steps', () => {
    expect(recipeSections([{ section: 'A' }, { section: 'B' }, 'Step.'])).toEqual([
      { title: 'A', choice: false, steps: [] },
      { title: 'B', choice: false, steps: [0] },
    ]);
  });
});

describe('choiceGroups', () => {
  test('consecutive choice sections are one group', () => {
    expect(choiceGroups(recipeSections(MARINADE))).toEqual([[1, 2, 3, 4]]);
  });

  test('two separate groups, split by a shared section', () => {
    const entries: RecipeStepEntry[] = [
      { section: 'Rice', choice: true },
      'Steam.',
      { section: 'Noodles', choice: true },
      'Boil.',
      { section: 'Sauce' },
      'Stir.',
      { section: 'Tofu', choice: true },
      'Press.',
      { section: 'Chicken', choice: true },
      'Sear.',
      { section: 'Beef', choice: true },
      'Grill.',
    ];
    expect(choiceGroups(recipeSections(entries))).toEqual([
      [0, 1],
      [3, 4, 5],
    ]);
  });

  test('no groups without choices, or with a lone one', () => {
    expect(choiceGroups(recipeSections(['Mix.']))).toEqual([]);
    expect(choiceGroups(recipeSections([{ section: 'Grill', choice: true }, 'Grill.']))).toEqual([]);
  });
});

describe('stepPath', () => {
  test('no headings: every step', () => {
    expect(stepPath(['Mix.', 'Bake.', 'Serve.'])).toEqual([0, 1, 2]);
    expect(stepPath(null)).toEqual([]);
  });

  test('a leading untitled section is always shown', () => {
    expect(stepPath(['Preheat.', { section: 'Bake', choice: true }, 'Bake.', { section: 'Fry', choice: true }, 'Fry.'])).toEqual([0, 1]);
  });

  test('a group of 4 between shared sections: the shared steps and the picked option', () => {
    expect(stepPath(MARINADE)).toEqual([0, 1, 2, 3, 8]);
    expect(stepPath(MARINADE, [0])).toEqual([0, 1, 2, 3, 8]);
    expect(stepPath(MARINADE, [1])).toEqual([0, 1, 4, 8]);
    expect(stepPath(MARINADE, [2])).toEqual([0, 1, 5, 6, 8]);
    expect(stepPath(MARINADE, [3])).toEqual([0, 1, 7, 8]);
  });

  test('a missing or out-of-range pick shows the first option', () => {
    expect(stepPath(MARINADE, [])).toEqual([0, 1, 2, 3, 8]);
    expect(stepPath(MARINADE, [null])).toEqual([0, 1, 2, 3, 8]);
    expect(stepPath(MARINADE, [4])).toEqual([0, 1, 2, 3, 8]);
    expect(stepPath(MARINADE, [-1])).toEqual([0, 1, 2, 3, 8]);
    expect(stepPath(MARINADE, [1.5])).toEqual([0, 1, 2, 3, 8]);
  });

  test('a lone choice is always shown', () => {
    expect(stepPath([{ section: 'Prep' }, 'Chop.', { section: 'Grill', choice: true }, 'Grill.'], [5])).toEqual([0, 1]);
  });

  test('two separate groups each take their own pick', () => {
    const entries: RecipeStepEntry[] = [
      { section: 'Rice', choice: true },
      'Steam.',
      { section: 'Noodles', choice: true },
      'Boil.',
      { section: 'Sauce' },
      'Stir.',
      { section: 'Tofu', choice: true },
      'Press.',
      { section: 'Chicken', choice: true },
      'Sear.',
      'Rest.',
    ];
    expect(stepPath(entries)).toEqual([0, 2, 3]);
    expect(stepPath(entries, [1, 1])).toEqual([1, 2, 4, 5]);
    expect(stepPath(entries, [undefined, 1])).toEqual([0, 2, 4, 5]);
  });
});

describe('cleanRecipeSteps with headings', () => {
  test('headings are cleaned like steps and keep choice only when true', () => {
    expect(
      cleanRecipeSteps([
        { section: ' 1. <b>Marinate</b> the  chicken ' },
        'Mix.',
        { section: 'Grill &amp; serve', choice: true },
        'Grill.',
        { section: 'Bake', choice: false as unknown as true },
        'Bake.',
      ]),
    ).toEqual([{ section: 'Marinate the chicken' }, 'Mix.', { section: 'Grill & serve', choice: true }, 'Grill.', { section: 'Bake' }, 'Bake.']);
  });

  test('a heading is capped at 80 characters (code points)', () => {
    const [heading] = cleanRecipeSteps([{ section: '🍗'.repeat(90) }, 'Grill.']);
    expect(Array.from((heading as { section: string }).section)).toHaveLength(80);
  });

  test('drops empty headings', () => {
    expect(cleanRecipeSteps([{ section: '  ' }, 'Mix.', { section: '<br>' }, 'Bake.'])).toEqual(['Mix.', 'Bake.']);
  });

  test('drops a trailing heading, and one whose steps all cleaned away', () => {
    expect(cleanRecipeSteps(['Mix.', { section: 'Serve' }])).toEqual(['Mix.']);
    expect(cleanRecipeSteps(['Mix.', { section: 'Serve' }, ' ', '<p></p>'])).toEqual(['Mix.']);
  });

  test('drops a heading when another follows straight after, keeping the second', () => {
    expect(cleanRecipeSteps([{ section: 'A' }, { section: 'B', choice: true }, { section: '' }, { section: 'C' }, 'Step.'])).toEqual([
      { section: 'C' },
      'Step.',
    ]);
  });

  test('headings only are no steps', () => {
    expect(cleanRecipeSteps([{ section: 'A' }, { section: 'B' }])).toEqual([]);
  });

  test('a repeated step is dropped only straight after itself, not across a heading', () => {
    expect(cleanRecipeSteps(['Stir.', 'Stir.', { section: 'Again' }, 'Stir.'])).toEqual(['Stir.', { section: 'Again' }, 'Stir.']);
  });

  test('the 100 cap counts every entry, and a heading cut off from its steps goes', () => {
    const entries: RecipeStepEntry[] = [];
    for (let i = 0; i < 50; i++) entries.push({ section: `S${i}` }, `Stir ${i}`);
    // At most 20 headings are kept: the rest of the steps join the 20th section.
    const cleaned = cleanRecipeSteps(entries);
    expect(cleaned.filter(isStepHeading)).toHaveLength(20);
    expect(stepTexts(cleaned)).toHaveLength(50);
    expect(cleaned).toHaveLength(70);

    const steps = Array.from({ length: 99 }, (_, i) => `Stir ${i}`);
    expect(cleanRecipeSteps([...steps, { section: 'Late' }, 'Late step.'])).toEqual(steps);
    const capped = cleanRecipeSteps([{ section: 'First' }, ...steps, 'Stir 99', 'Stir 100']);
    expect(capped).toHaveLength(100);
    expect(capped[0]).toEqual({ section: 'First' });
    expect(capped.at(-1)).toBe('Stir 98');
  });

  test('step strings in, step strings out', () => {
    expect(cleanRecipeSteps(['1. Mix.', ' Bake. '])).toEqual(['Mix.', 'Bake.']);
  });
});

test('exported from the shared index', () => {
  expect(shared.stepTexts).toBe(stepTexts);
  expect(shared.recipeSections).toBe(recipeSections);
  expect(shared.stepPath).toBe(stepPath);
});
