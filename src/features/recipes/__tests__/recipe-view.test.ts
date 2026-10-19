import { describe, expect, test } from '@jest/globals';

import {
  addCtaLabel,
  addedRecipeToListToast,
  addedRecipeWithStaplesToast,
  addedToRecipeToast,
  addToRecipeTitle,
  groupRecipesByHousehold,
  ingredientCountLabel,
  onListByRecipe,
  orderByLastUse,
  recipeCardLabel,
  recipeMetaLine,
  recipeMetaParts,
  recipeRowLabel,
  recipeSavedMarks,
  recipeSuggestionDetail,
  recipeTimeLabel,
  recipeSuggestionLabel,
  forServingsLabel,
  parseServings,
  scaledAmount,
  servesLabel,
  SERVINGS_ERROR,
  servingsLabel,
  choiceHeadings,
  methodBlocks,
  stepHeadingsInText,
  stepLabel,
  stepsFromText,
  stepsToText,
  withPick,
} from '../recipe-view';
import type { RecipeStepEntry } from '@/shared/recipe-steps';
import { emptyRecipeTags } from '@/shared/recipe-tags';

describe('servings', () => {
  test('the band and stepper labels', () => {
    expect(servesLabel(4)).toBe('Serves 4');
    expect(servesLabel(1)).toBe('Serves 1');
    expect(forServingsLabel(6)).toBe('For 6');
  });

  test('parseServings takes a whole number 1–100, trimmed', () => {
    expect(parseServings('4')).toEqual({ servings: 4 });
    expect(parseServings(' 12 ')).toEqual({ servings: 12 });
    expect(parseServings('1')).toEqual({ servings: 1 });
    expect(parseServings('100')).toEqual({ servings: 100 });
    expect(parseServings('007')).toEqual({ servings: 7 });
  });

  test('parseServings: empty clears', () => {
    expect(parseServings('')).toEqual({ servings: null });
    expect(parseServings('   ')).toEqual({ servings: null });
  });

  test('parseServings: anything else is an error', () => {
    for (const text of ['0', '101', '-2', '2.5', 'four', '4 people', '1e2']) {
      expect(parseServings(text)).toEqual({ error: SERVINGS_ERROR });
    }
    expect(SERVINGS_ERROR).toBe('Servings must be a whole number from 1 to 100');
  });

  test('scaledAmount is quantity × chosen ÷ base, formatted as Add to list does', () => {
    // 1 × 6 ÷ 4: fractions for counts and volumes, decimals for weights.
    expect(scaledAmount({ quantity: 1, unit: null }, 6, 4)).toBe('1½');
    expect(scaledAmount({ quantity: 1, unit: 'can' }, 6, 4)).toBe('1½ can');
    expect(scaledAmount({ quantity: 1, unit: 'tsp' }, 6, 4)).toBe('1½ tsp');
    expect(scaledAmount({ quantity: 2, unit: 'lb' }, 6, 4)).toBe('3 lb');
    expect(scaledAmount({ quantity: 1, unit: 'lb' }, 6, 4)).toBe('1.5 lb');
    expect(scaledAmount({ quantity: 1, unit: 'cup' }, 2, 4)).toBe('½ cup');
    // 33.33 g rounds to a kitchen measure.
    expect(scaledAmount({ quantity: 100, unit: 'g' }, 1, 3)).toBe('35 g');
    expect(scaledAmount({ quantity: 12, unit: null }, 4, 4)).toBe('12');
  });

  test('scaledAmount rounds to kitchen measures, changing the unit when it reads better', () => {
    expect(scaledAmount({ quantity: 3, unit: 'cup' }, 1, 7)).toBe('½ cup');
    expect(scaledAmount({ quantity: 1, unit: 'cup' }, 1, 8)).toBe('2 tbsp');
    expect(scaledAmount({ quantity: 2, unit: 'tbsp' }, 1, 4)).toBe('1½ tsp');
    expect(scaledAmount({ quantity: 2, unit: 'tbsp' }, 8, 4)).toBe('¼ cup');
    expect(scaledAmount({ quantity: 3, unit: null }, 1, 4)).toBe('1');
  });

  test('scaledAmount at the base servings is as written, not rounded', () => {
    expect(scaledAmount({ quantity: 0.42, unit: 'cup' }, 4, 4)).toBe('0.42 cup');
    expect(scaledAmount({ quantity: 33, unit: 'g' }, 3, 3)).toBe('33 g');
    expect(scaledAmount({ quantity: 6, unit: 'tbsp' }, 2, 2)).toBe('6 tbsp');
    expect(scaledAmount({ quantity: 0.1, unit: 'tsp' }, 1, 1)).toBe('0.1 tsp');
  });

  test('scaledAmount: no quantity is empty', () => {
    expect(scaledAmount({ quantity: null, unit: null }, 6, 4)).toBe('');
    expect(scaledAmount({ quantity: null, unit: 'cup' }, 6, 4)).toBe('');
  });

  describe('a whole recipe for 4', () => {
    const recipe = [
      { quantity: 1, unit: 'lb' },
      { quantity: 2, unit: 'cup' },
      { quantity: 3, unit: 'tbsp' },
      { quantity: 1, unit: 'tsp' },
      { quantity: 0.5, unit: 'tsp' },
      { quantity: 2, unit: null },
      { quantity: 1, unit: null },
      { quantity: 400, unit: 'g' },
      { quantity: 250, unit: 'ml' },
      { quantity: 1, unit: 'can' },
      { quantity: null, unit: null },
    ] as const;
    const scaled = (chosen: number) => recipe.map((a) => scaledAmount(a, chosen, 4));

    test('for 6', () => {
      expect(scaled(6)).toEqual(['1.5 lb', '3 cup', '4½ tbsp', '1½ tsp', '¾ tsp', '3', '1½', '600 g', '375 ml', '1½ can', '']);
    });

    test('for 1', () => {
      expect(scaled(1)).toEqual(['0.25 lb', '½ cup', '2¼ tsp', '¼ tsp', '⅛ tsp', '½', '½', '100 g', '65 ml', '¼ can', '']);
    });
  });
});

describe('steps', () => {
  test('one step per line, trimmed, empty lines dropped', () => {
    expect(stepsFromText('  Blend the paste. \n\n\nToss the chicken.\n   \nGrill it.  ')).toEqual([
      'Blend the paste.',
      'Toss the chicken.',
      'Grill it.',
    ]);
  });

  test('splits on any line break', () => {
    expect(stepsFromText('One\r\nTwo\rThree\nFour')).toEqual(['One', 'Two', 'Three', 'Four']);
  });

  test('a single line is one step; inner spaces are kept', () => {
    expect(stepsFromText('Rest 5 minutes,  then slice')).toEqual(['Rest 5 minutes,  then slice']);
  });

  test('nothing, or only blank lines, is null', () => {
    expect(stepsFromText('')).toBeNull();
    expect(stepsFromText('  \n\n \t \n')).toBeNull();
  });

  test('the sheet text is the steps one per line, and round-trips', () => {
    expect(stepsToText(['A', 'B', 'C'])).toBe('A\nB\nC');
    expect(stepsToText(null)).toBe('');
    expect(stepsToText(undefined)).toBe('');
    expect(stepsToText([])).toBe('');
    expect(stepsFromText(stepsToText(['A', 'B']))).toEqual(['A', 'B']);
  });
});

describe('steps with section headings (spec 4.5 "Step sections")', () => {
  const CHICKEN: RecipeStepEntry[] = [
    { section: 'Marinate the chicken' },
    'Whisk.',
    'Marinate.',
    { section: 'Grill', choice: true },
    'Grill it.',
    { section: 'Bake', choice: true },
    'Bake it.',
  ];

  test('a "#" line is a heading: the #s and the spaces after them dropped, trimmed', () => {
    expect(stepsFromText('# Grill\nGrill it.\n##Bake\nBake it.\n  ###   Broil it   \nBroil.')).toEqual([
      { section: 'Grill' },
      'Grill it.',
      { section: 'Bake' },
      'Bake it.',
      { section: 'Broil it' },
      'Broil.',
    ]);
  });

  test('an empty heading is dropped; a "#" inside a line is part of the step', () => {
    expect(stepsFromText('#\n  ##   \nUse a #10 can.\n# \nStir.')).toEqual(['Use a #10 can.', 'Stir.']);
  });

  test('headings in `choices` are written as choices, matched by their text', () => {
    expect(stepsFromText('# Grill\nGrill it.\n# Bake\nBake it.\n# Serve\nServe.', new Set(['Grill', 'Bake', 'bake', 'Gone']))).toEqual([
      { section: 'Grill', choice: true },
      'Grill it.',
      { section: 'Bake', choice: true },
      'Bake it.',
      { section: 'Serve' },
      'Serve.',
    ]);
  });

  test('headings without a step are null, as no steps', () => {
    expect(stepsFromText('# Grill\n# Bake')).toBeNull();
    expect(stepsFromText('# Grill\n\n# Bake', new Set(['Grill']))).toBeNull();
  });

  test('a heading is cut to 80 characters, and headings past the 20th are dropped', () => {
    const long = 'x'.repeat(100);
    expect(stepsFromText(`# ${long}\nStep.`)).toEqual([{ section: 'x'.repeat(80) }, 'Step.']);
    const many = Array.from({ length: 22 }, (_, i) => `# S${i + 1}\nStep ${i + 1}.`).join('\n');
    const entries = stepsFromText(many)!;
    expect(entries.filter((e) => typeof e !== 'string')).toHaveLength(20);
    // S21 and S22 go; their steps stay, in S20.
    expect(entries.slice(-4)).toEqual([{ section: 'S20' }, 'Step 20.', 'Step 21.', 'Step 22.']);
    expect(entries.filter((e) => typeof e === 'string')).toHaveLength(22);
  });

  test('the sheet text writes headings as "# <name>" lines', () => {
    expect(stepsToText(CHICKEN)).toBe('# Marinate the chicken\nWhisk.\nMarinate.\n# Grill\nGrill it.\n# Bake\nBake it.');
  });

  test('text → entries → text round-trips, choices and all', () => {
    const text = stepsToText(CHICKEN);
    expect(stepsFromText(text, choiceHeadings(CHICKEN))).toEqual(CHICKEN);
    expect(stepsToText(stepsFromText(text))).toBe(text);
  });

  test('choiceHeadings names the headings marked choice', () => {
    expect([...choiceHeadings(CHICKEN)]).toEqual(['Grill', 'Bake']);
    expect(choiceHeadings(['A', { section: 'B' }]).size).toBe(0);
    expect(choiceHeadings(null).size).toBe(0);
  });

  test('stepHeadingsInText lists the headings as Save writes them, steps or not', () => {
    expect(stepHeadingsInText('# Grill\n#\n## Bake  \nBake it.\n# Grill')).toEqual(['Grill', 'Bake', 'Grill']);
    expect(stepHeadingsInText('Just a step.')).toEqual([]);
    expect(stepHeadingsInText('')).toEqual([]);
  });
});

describe('methodBlocks and withPick (the Method card)', () => {
  const ENTRIES: RecipeStepEntry[] = [
    { section: 'Marinate' },
    'M1',
    'M2',
    { section: 'Grill', choice: true },
    'G1',
    'G2',
    { section: 'Bake', choice: true },
    'B1',
    { section: 'Serve' },
    'S1',
  ];

  test('titles, the group and the first option’s steps, numbered along the path', () => {
    expect(methodBlocks(ENTRIES)).toEqual([
      { kind: 'title', title: 'Marinate' },
      { kind: 'step', index: 0, number: 1, lead: true },
      { kind: 'step', index: 1, number: 2, lead: false },
      { kind: 'group', group: 0, first: false, options: ['Grill', 'Bake'], picked: 0 },
      { kind: 'step', index: 2, number: 3, lead: true },
      { kind: 'step', index: 3, number: 4, lead: false },
      { kind: 'title', title: 'Serve' },
      { kind: 'step', index: 5, number: 5, lead: true },
    ]);
  });

  test('a pick shows that option and renumbers what follows; an out-of-range pick shows the first', () => {
    expect(methodBlocks(ENTRIES, [1]).filter((b) => b.kind === 'step')).toEqual([
      { kind: 'step', index: 0, number: 1, lead: true },
      { kind: 'step', index: 1, number: 2, lead: false },
      { kind: 'step', index: 4, number: 3, lead: true },
      { kind: 'step', index: 5, number: 4, lead: true },
    ]);
    expect(methodBlocks(ENTRIES, [7])).toEqual(methodBlocks(ENTRIES));
    expect(methodBlocks(ENTRIES, [-1])).toEqual(methodBlocks(ENTRIES));
  });

  test('without headings, only steps, no lead', () => {
    expect(methodBlocks(['A', 'B'])).toEqual([
      { kind: 'step', index: 0, number: 1, lead: false },
      { kind: 'step', index: 1, number: 2, lead: false },
    ]);
    expect(methodBlocks(null)).toEqual([]);
  });

  test('withPick sets one group, filling earlier ones with the first', () => {
    expect(withPick([], 0, 2)).toEqual([2]);
    expect(withPick([], 2, 1)).toEqual([0, 0, 1]);
    expect(withPick([1, 3], 0, 0)).toEqual([0, 3]);
  });
});

describe('step labels', () => {
  test('VoiceOver reads "Step 2 of 7, …"', () => {
    expect(stepLabel(1, 7, 'Toss the chicken.')).toBe('Step 2 of 7, Toss the chicken.');
    expect(stepLabel(0, 1, 'Eat.')).toBe('Step 1 of 1, Eat.');
  });
});

describe('orderByLastUse', () => {
  const r = (id: string, name: string, updatedAt: string) => ({ id, name, updatedAt: new Date(updatedAt) });
  const use = (recipeId: string, at: string) => ({ recipeId, at: new Date(at) });

  test('orders by last change when no recipe has been added to a list', () => {
    const out = orderByLastUse([r('a', 'Tacos', '2026-10-01'), r('b', 'Chili', '2026-10-03'), r('c', 'Dal', '2026-10-02')], []);
    expect(out.map((x) => x.id)).toEqual(['b', 'c', 'a']);
  });

  test('a later add to a list counts as a use, and the latest add wins', () => {
    const out = orderByLastUse(
      [r('a', 'Tacos', '2026-10-01'), r('b', 'Chili', '2026-10-03'), r('c', 'Dal', '2026-10-02')],
      [use('a', '2026-09-01'), use('a', '2026-10-05'), use('c', '2026-10-04')],
    );
    expect(out.map((x) => x.id)).toEqual(['a', 'c', 'b']);
  });

  test('an add older than the last change does not move a recipe back', () => {
    const out = orderByLastUse(
      [r('a', 'Tacos', '2026-10-05'), r('b', 'Chili', '2026-10-03')],
      [use('a', '2026-09-01'), use('b', '2026-10-04')],
    );
    expect(out.map((x) => x.id)).toEqual(['a', 'b']);
  });

  test('ties go by name, then id; uses of other recipes are ignored', () => {
    const out = orderByLastUse(
      [r('z', 'Tacos', '2026-10-01'), r('y', 'Chili', '2026-10-01'), r('x', 'Tacos', '2026-10-01')],
      [use('gone', '2026-12-01')],
    );
    expect(out.map((x) => x.id)).toEqual(['y', 'x', 'z']);
  });

  test('empty input, and the input is not mutated', () => {
    expect(orderByLastUse([], [])).toEqual([]);
    const input = [r('a', 'Tacos', '2026-10-01'), r('b', 'Chili', '2026-10-02')];
    expect(orderByLastUse(input, []).map((x) => x.id)).toEqual(['b', 'a']);
    expect(input.map((x) => x.id)).toEqual(['a', 'b']);
  });
});

test('addToRecipeTitle', () => {
  expect(addToRecipeTitle(1)).toBe('Add 1 item to…');
  expect(addToRecipeTitle(3)).toBe('Add 3 items to…');
});

test('addedToRecipeToast', () => {
  expect(addedToRecipeToast(3, 'Tacos')).toEqual({ message: 'Added 3 items to Tacos', emphasis: 'Tacos' });
  expect(addedToRecipeToast(1, 'Weeknight dal')).toEqual({ message: 'Added 1 item to Weeknight dal', emphasis: 'Weeknight dal' });
});

describe('groupRecipesByHousehold', () => {
  const r = (id: string, householdId: string, householdName: string) => ({ id, householdId, householdName });

  test('keeps households in order of their first recipe and recipes in order', () => {
    const groups = groupRecipesByHousehold([
      r('tacos', 'home', 'Our place'),
      r('chili', 'lake', 'Lake house'),
      r('dal', 'home', 'Our place'),
    ]);
    expect(groups.map((g) => [g.householdId, g.name, g.recipes.map((x) => x.id)])).toEqual([
      ['home', 'Our place', ['tacos', 'dal']],
      ['lake', 'Lake house', ['chili']],
    ]);
  });

  test('is empty with no recipes', () => {
    expect(groupRecipesByHousehold([])).toEqual([]);
  });

  test('groups by id, not name: two households can share a name', () => {
    const groups = groupRecipesByHousehold([r('a', 'h1', 'Home'), r('b', 'h2', 'Home')]);
    expect(groups.map((g) => g.householdId)).toEqual(['h1', 'h2']);
  });
});

describe('onListByRecipe', () => {
  const at = (ms: number) => new Date(ms);

  test('picks the most recently added list per recipe, whatever the row order', () => {
    const map = onListByRecipe([
      { recipeId: 'tacos', listName: 'Costco', addedAt: at(30) },
      { recipeId: 'tacos', listName: 'Groceries', addedAt: at(10) },
      { recipeId: 'dal', listName: 'Groceries', addedAt: at(20) },
    ]);
    expect([...map].sort()).toEqual([
      ['dal', 'Groceries'],
      ['tacos', 'Costco'],
    ]);
  });

  test('keeps the first row on a tie', () => {
    const map = onListByRecipe([
      { recipeId: 'tacos', listName: 'Groceries', addedAt: at(5) },
      { recipeId: 'tacos', listName: 'Costco', addedAt: at(5) },
    ]);
    expect(map.get('tacos')).toBe('Groceries');
  });

  test('is empty with no rows', () => {
    expect(onListByRecipe([]).size).toBe(0);
  });
});

describe('labels', () => {
  test('ingredient counts are pluralised', () => {
    expect(ingredientCountLabel(0)).toBe('0 ingredients');
    expect(ingredientCountLabel(1)).toBe('1 ingredient');
    expect(ingredientCountLabel(9)).toBe('9 ingredients');
  });

  test('a recipe card reads its name, count and list', () => {
    expect(recipeCardLabel('Chicken tacos', 9, 'Groceries')).toBe('Chicken tacos, 9 ingredients, on Groceries');
    expect(recipeCardLabel('Dal', 1, null)).toBe('Dal, 1 ingredient');
    expect(recipeCardLabel('Dal', 1)).toBe('Dal, 1 ingredient');
    expect(recipeCardLabel('Dal', 1, '')).toBe('Dal, 1 ingredient');
  });

  test('a card matched only through an ingredient reads it in place of the count', () => {
    expect(recipeCardLabel('Tacos', 9, 'Groceries', 'chicken thighs')).toBe('Tacos, has chicken thighs, on Groceries');
    expect(recipeCardLabel('Tacos', 9, null, 'chicken thighs')).toBe('Tacos, has chicken thighs');
    expect(recipeCardLabel('Tacos', 9, null, null)).toBe('Tacos, 9 ingredients');
  });

  test('a row’s time: minutes, whole hours, or both; none for no time, zero or nonsense', () => {
    expect(recipeTimeLabel(35)).toBe('35 min');
    expect(recipeTimeLabel(1)).toBe('1 min');
    expect(recipeTimeLabel(59)).toBe('59 min');
    expect(recipeTimeLabel(60)).toBe('1 hr');
    expect(recipeTimeLabel(120)).toBe('2 hr');
    expect(recipeTimeLabel(80)).toBe('1 hr 20 min');
    expect(recipeTimeLabel(125)).toBe('2 hr 5 min');
    expect(recipeTimeLabel(null)).toBeNull();
    expect(recipeTimeLabel(undefined)).toBeNull();
    expect(recipeTimeLabel(0)).toBeNull();
    expect(recipeTimeLabel(-5)).toBeNull();
    expect(recipeTimeLabel(Number.NaN)).toBeNull();
  });

  test('a row’s meta line: the first meal (facet order) and the time, either alone, or nothing', () => {
    const tags = (meal: string[], cuisine: string[] = []) => ({ ...emptyRecipeTags(), meal, cuisine });
    expect(recipeMetaLine({ tags: tags(['dinner']), totalMinutes: 35 })).toBe('Dinner · 35 min');
    // Stored order doesn't matter: Breakfast comes before Dinner in the Meal facet.
    expect(recipeMetaLine({ tags: tags(['dinner', 'breakfast']), totalMinutes: 35 })).toBe('Breakfast · 35 min');
    expect(recipeMetaLine({ tags: tags(['side']), totalMinutes: null })).toBe('Side');
    expect(recipeMetaLine({ tags: tags([], ['mexican']), totalMinutes: 90 })).toBe('1 hr 30 min');
    expect(recipeMetaLine({ tags: null, totalMinutes: 20 })).toBe('20 min');
    expect(recipeMetaLine({ tags: null, totalMinutes: null })).toBeNull();
    expect(recipeMetaLine({ tags: tags([], ['mexican']), totalMinutes: null })).toBeNull();
    // An unknown meal slug isn't shown; the next known one is.
    expect(recipeMetaLine({ tags: tags(['brunch']), totalMinutes: null })).toBeNull();
    expect(recipeMetaLine({ tags: tags(['brunch', 'snack']), totalMinutes: 10 })).toBe('Snack · 10 min');
    expect(recipeMetaParts({ tags: tags(['dessert']), totalMinutes: 60 })).toEqual(['Dessert', '1 hr']);
  });

  test('a row reads its name, meal, time and list; no ingredient count', () => {
    const tacos = { name: 'Chicken tacos', tags: { ...emptyRecipeTags(), meal: ['dinner'] }, totalMinutes: 35 };
    expect(recipeRowLabel(tacos, 'Groceries')).toBe('Chicken tacos, Dinner, 35 min, on Groceries');
    expect(recipeRowLabel(tacos)).toBe('Chicken tacos, Dinner, 35 min');
    expect(recipeRowLabel({ ...tacos, totalMinutes: null }, null)).toBe('Chicken tacos, Dinner');
    expect(recipeRowLabel({ name: 'Dal', tags: null, totalMinutes: null }, '')).toBe('Dal');
    // Matched only through an ingredient: that in place of the meta.
    expect(recipeRowLabel(tacos, 'Groceries', 'chicken thighs')).toBe('Chicken tacos, has chicken thighs, on Groceries');
    expect(recipeRowLabel(tacos, null, null)).toBe('Chicken tacos, Dinner, 35 min');
  });

  test('a row reads Favorite and Want to try after the name, in facet order, only when set (spec 4.5)', () => {
    const tacos = (saved: string[]) => ({ name: 'Tacos', tags: { ...emptyRecipeTags(), saved, meal: ['dinner'] }, totalMinutes: 35 });
    expect(recipeRowLabel(tacos(['favorite']), 'Groceries')).toBe('Tacos, Favorite, Dinner, 35 min, on Groceries');
    expect(recipeRowLabel(tacos(['want-to-try']), 'Groceries')).toBe('Tacos, Want to try, Dinner, 35 min, on Groceries');
    // Stored order doesn't matter.
    expect(recipeRowLabel(tacos(['want-to-try', 'favorite']))).toBe('Tacos, Favorite, Want to try, Dinner, 35 min');
    expect(recipeRowLabel(tacos([]), 'Groceries')).toBe('Tacos, Dinner, 35 min, on Groceries');
    // An unknown saved slug reads as nothing.
    expect(recipeRowLabel(tacos(['cooked-it']))).toBe('Tacos, Dinner, 35 min');
    // Before an ingredient-only search match, and with only a mark.
    expect(recipeRowLabel(tacos(['favorite']), null, 'limes')).toBe('Tacos, Favorite, has limes');
    expect(recipeRowLabel({ name: 'Dal', tags: { ...emptyRecipeTags(), saved: ['favorite'] }, totalMinutes: null })).toBe(
      'Dal, Favorite',
    );
  });

  test("a recipe's Saved marks: Favorite and Want to try each on their own; none when untagged", () => {
    const marks = (saved: string[]) => recipeSavedMarks({ ...emptyRecipeTags(), saved });
    expect(marks([])).toEqual({ favorite: false, wantToTry: false });
    expect(marks(['favorite'])).toEqual({ favorite: true, wantToTry: false });
    expect(marks(['want-to-try'])).toEqual({ favorite: false, wantToTry: true });
    expect(marks(['want-to-try', 'favorite'])).toEqual({ favorite: true, wantToTry: true });
    expect(marks(['cooked-it'])).toEqual({ favorite: false, wantToTry: false });
    expect(recipeSavedMarks(null)).toEqual({ favorite: false, wantToTry: false });
    // A value stored before Saved existed has no `saved` key.
    const { saved: _saved, ...older } = emptyRecipeTags();
    expect(recipeSavedMarks(older as never)).toEqual({ favorite: false, wantToTry: false });
  });

  test('servings use ½ for a half and × after the number', () => {
    expect([0.5, 1, 2, 3].map(servingsLabel)).toEqual(['½×', '1×', '2×', '3×']);
  });

  test('the add CTA counts what is ticked', () => {
    expect(addCtaLabel(8, 'Groceries')).toBe('Add 8 to Groceries');
    expect(addCtaLabel(1, 'Costco')).toBe('Add 1 to Costco');
    expect(addCtaLabel(0, 'Groceries')).toBe('Nothing selected');
  });

  test('the toast after adding a recipe names it and counts its items', () => {
    expect(addedRecipeToListToast('Tacos', 8)).toEqual({ message: 'Added Tacos · 8 items', emphasis: 'Tacos' });
    expect(addedRecipeToListToast('Toast', 1)).toEqual({ message: 'Added Toast · 1 item', emphasis: 'Toast' });
    expect(addedRecipeToListToast('Tacos', 0)).toEqual({ message: 'Added Tacos · 0 items', emphasis: 'Tacos' });
  });

  test('the add bar toast names skipped staples on a second line, up to three, then two and a count', () => {
    expect(addedRecipeWithStaplesToast('Tacos', 6, [])).toEqual({ message: 'Added Tacos · 6 items', emphasis: 'Tacos' });
    expect(addedRecipeWithStaplesToast('Tacos', 1, ['salt'])).toEqual({
      message: 'Added Tacos · 1 item\nSkipped salt',
      emphasis: 'Tacos',
    });
    expect(addedRecipeWithStaplesToast('Tacos', 6, ['salt', 'pepper']).message).toBe('Added Tacos · 6 items\nSkipped salt, pepper');
    expect(addedRecipeWithStaplesToast('Tacos', 6, ['salt', 'pepper', 'water']).message).toBe(
      'Added Tacos · 6 items\nSkipped salt, pepper, water',
    );
    expect(addedRecipeWithStaplesToast('Tacos', 6, ['salt', 'pepper', 'water', 'olive oil']).message).toBe(
      'Added Tacos · 6 items\nSkipped salt, pepper and 2 more',
    );
  });

  test('the add bar toast when every ingredient is a staple', () => {
    expect(addedRecipeWithStaplesToast('Tacos', 0, ['salt', 'pepper'])).toEqual({
      message: 'You always have everything in Tacos',
      emphasis: 'Tacos',
    });
    // A recipe with no ingredients at all isn't "everything a staple".
    expect(addedRecipeWithStaplesToast('Tacos', 0, []).message).toBe('Added Tacos · 0 items');
  });

  test("an add bar recipe row says it's a recipe and counts its items", () => {
    expect(recipeSuggestionDetail(8)).toBe('Recipe · 8 items');
    expect(recipeSuggestionDetail(1)).toBe('Recipe · 1 item');
    expect(recipeSuggestionDetail(0)).toBe('Recipe · 0 items');
    expect(recipeSuggestionLabel('Tacos', 8)).toBe('Add recipe Tacos, 8 items');
    expect(recipeSuggestionLabel('Toast', 1)).toBe('Add recipe Toast, 1 item');
  });
});
