import { describe, expect, test } from '@jest/globals';

import { stepIngredientsBasis, type StepIngredients } from '@/shared';

import { stepMatch } from '../step-match';

const STEPS = ['Brown the chicken with the garlic.', 'Squeeze in the juice of 1 lime.', 'Serve.'];
const ing = (id: string, position: number, deletedAt: Date | null = null) => ({ id, name: id, position, deletedAt });
const CHICKEN = ing('chicken', 1);
const GARLIC = ing('garlic', 2);
const LIMES = ing('limes', 3);
const SALT = ing('salt', 4);
const INGREDIENTS = [CHICKEN, GARLIC, LIMES, SALT];
const ids = (list: { id: string }[]) => list.map((i) => i.id);

const match = (steps: StepIngredients['steps'], basis = stepIngredientsBasis(STEPS, ids(INGREDIENTS))): StepIngredients => ({
  v: 1,
  basis,
  steps,
});
const SAVED = match([
  [
    { id: 'garlic', quantity: null },
    { id: 'chicken', quantity: null },
  ],
  [{ id: 'limes', quantity: 1 }],
  [],
]);

describe('stepMatch', () => {
  test('a recipe never matched is none, with every live ingredient unplaced', () => {
    const result = stepMatch({ steps: STEPS, stepIngredients: null }, [...INGREDIENTS, ing('gone', 5, new Date())]);
    expect(result).toEqual({ state: 'none', steps: [[], [], []], unplaced: INGREDIENTS });
  });

  test('a match made from these steps and ingredients is fresh', () => {
    const result = stepMatch({ steps: STEPS, stepIngredients: SAVED }, INGREDIENTS);
    expect(result.state).toBe('fresh');
    expect(result.steps).toEqual([
      [
        { ingredient: CHICKEN, quantity: null },
        { ingredient: GARLIC, quantity: null },
      ],
      [{ ingredient: LIMES, quantity: 1 }],
      [],
    ]);
    expect(result.unplaced).toEqual([SALT]);
  });

  test("lists each step's ingredients in the recipe's order, not the match's or the input's", () => {
    const result = stepMatch({ steps: STEPS, stepIngredients: SAVED }, [SALT, LIMES, GARLIC, CHICKEN]);
    expect(result.state).toBe('fresh');
    expect(result.steps[0].map((u) => u.ingredient.id)).toEqual(['chicken', 'garlic']);
    expect(result.unplaced).toEqual([SALT]);
  });

  test('a deleted ingredient is dropped from its step and the match goes stale, still shown', () => {
    const deletedGarlic = ing('garlic', 2, new Date());
    const result = stepMatch({ steps: STEPS, stepIngredients: SAVED }, [CHICKEN, deletedGarlic, LIMES, SALT]);
    expect(result.state).toBe('stale');
    expect(result.steps).toEqual([[{ ingredient: CHICKEN, quantity: null }], [{ ingredient: LIMES, quantity: 1 }], []]);
    expect(result.unplaced).toEqual([SALT]);
  });

  test('an id the recipe no longer has at all is dropped', () => {
    const withUnknown = match([[{ id: 'purged', quantity: null }, { id: 'chicken', quantity: null }], [], []]);
    const result = stepMatch({ steps: STEPS, stepIngredients: withUnknown }, INGREDIENTS);
    expect(result.steps[0]).toEqual([{ ingredient: CHICKEN, quantity: null }]);
    expect(result.unplaced).toEqual([GARLIC, LIMES, SALT]);
  });

  test('an added ingredient is unplaced and makes the match stale', () => {
    const cilantro = ing('cilantro', 5);
    const result = stepMatch({ steps: STEPS, stepIngredients: SAVED }, [...INGREDIENTS, cilantro]);
    expect(result.state).toBe('stale');
    expect(result.unplaced).toEqual([SALT, cilantro]);
  });

  test('a step edit makes the match stale', () => {
    const edited = [STEPS[0], 'Squeeze in the juice of 2 limes.', STEPS[2]];
    const result = stepMatch({ steps: edited, stepIngredients: SAVED }, INGREDIENTS);
    expect(result.state).toBe('stale');
    expect(result.steps[1]).toEqual([{ ingredient: LIMES, quantity: 1 }]);
  });

  test('a stale match lines up with the current steps: an added step has none, a removed one is gone', () => {
    const added = stepMatch({ steps: [...STEPS, 'Garnish.'], stepIngredients: SAVED }, INGREDIENTS);
    expect(added.state).toBe('stale');
    expect(added.steps).toHaveLength(4);
    expect(added.steps[3]).toEqual([]);

    const removed = stepMatch({ steps: [STEPS[0]], stepIngredients: SAVED }, INGREDIENTS);
    expect(removed.steps).toEqual([
      [
        { ingredient: CHICKEN, quantity: null },
        { ingredient: GARLIC, quantity: null },
      ],
    ]);
    expect(removed.unplaced).toEqual([LIMES, SALT]);
  });

  test('a basis with the ids saved in another order is still fresh', () => {
    const reordered = match(SAVED.steps, stepIngredientsBasis(STEPS, ['salt', 'limes', 'garlic', 'chicken']));
    expect(stepMatch({ steps: STEPS, stepIngredients: reordered }, INGREDIENTS).state).toBe('fresh');
  });

  test('an ingredient used in two steps is placed in both, with each its own share', () => {
    const split = match([[{ id: 'limes', quantity: 2 }], [{ id: 'limes', quantity: 1 }], []]);
    const result = stepMatch({ steps: STEPS, stepIngredients: split }, INGREDIENTS);
    expect(result.steps.map((s) => s.map((u) => [u.ingredient.id, u.quantity]))).toEqual([[['limes', 2]], [['limes', 1]], []]);
    expect(result.unplaced).toEqual([CHICKEN, GARLIC, SALT]);
  });

  test('a repeated id in a step counts once, with its first share', () => {
    const repeated = match([[{ id: 'limes', quantity: 1 }, { id: 'limes', quantity: 2 }], [], []]);
    expect(stepMatch({ steps: STEPS, stepIngredients: repeated }, INGREDIENTS).steps[0]).toEqual([
      { ingredient: LIMES, quantity: 1 },
    ]);
  });

  test('a match on a recipe whose steps were cleared places nothing', () => {
    const result = stepMatch({ steps: null, stepIngredients: SAVED }, INGREDIENTS);
    expect(result).toEqual({ state: 'stale', steps: [], unplaced: INGREDIENTS });
  });
});
