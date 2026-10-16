import { describe, expect, test } from '@jest/globals';

import { stepIngredientsBasis } from '../step-ingredients';

const STEPS = ['Brown the chicken.', 'Squeeze in the lime.'];
const IDS = ['i-chicken', 'i-lime', 'i-garlic'];

describe('stepIngredientsBasis', () => {
  test('is a 14-digit hex hash, the same every time', () => {
    const basis = stepIngredientsBasis(STEPS, IDS);
    expect(basis).toMatch(/^[0-9a-f]{14}$/);
    expect(stepIngredientsBasis([...STEPS], [...IDS])).toBe(basis);
  });

  test("doesn't depend on the ingredients' order", () => {
    expect(stepIngredientsBasis(STEPS, ['i-garlic', 'i-chicken', 'i-lime'])).toBe(stepIngredientsBasis(STEPS, IDS));
  });

  test('changes with a step edit', () => {
    const basis = stepIngredientsBasis(STEPS, IDS);
    expect(stepIngredientsBasis(['Brown the chicken well.', STEPS[1]], IDS)).not.toBe(basis);
    expect(stepIngredientsBasis([STEPS[1], STEPS[0]], IDS)).not.toBe(basis);
    expect(stepIngredientsBasis([...STEPS, 'Serve.'], IDS)).not.toBe(basis);
  });

  test('changes with an added or a deleted ingredient', () => {
    const basis = stepIngredientsBasis(STEPS, IDS);
    expect(stepIngredientsBasis(STEPS, [...IDS, 'i-salt'])).not.toBe(basis);
    expect(stepIngredientsBasis(STEPS, IDS.slice(0, 2))).not.toBe(basis);
  });

  test("doesn't confuse where one string ends and the next begins", () => {
    expect(stepIngredientsBasis(['ab', 'c'], [])).not.toBe(stepIngredientsBasis(['a', 'bc'], []));
    expect(stepIngredientsBasis(['a'], ['b'])).not.toBe(stepIngredientsBasis(['a', 'b'], []));
  });

  test('null steps hash like no steps', () => {
    expect(stepIngredientsBasis(null, IDS)).toBe(stepIngredientsBasis([], IDS));
    expect(stepIngredientsBasis(null, IDS)).not.toBe(stepIngredientsBasis(STEPS, IDS));
  });
});
