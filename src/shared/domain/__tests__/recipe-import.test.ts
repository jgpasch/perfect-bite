// Runs under Jest and Deno (`supabase/functions/_shared/shared-domain.test.ts`).
import { describe, expect, it } from '@jest/globals';

import { stepIngredientsBasis } from '../../step-ingredients.ts';
import {
  findReusableRecipe,
  importedStepIngredients,
  nameOf,
  servingsOf,
  type ReuseCandidate,
} from '../recipe-import.ts';

describe('servingsOf', () => {
  it('keeps a whole number from 1 to 100', () => {
    expect(servingsOf(1)).toBe(1);
    expect(servingsOf(4)).toBe(4);
    expect(servingsOf(100)).toBe(100);
  });

  it('is null for none, a fraction or out of range', () => {
    expect(servingsOf(null)).toBeNull();
    expect(servingsOf(2.5)).toBeNull();
    expect(servingsOf(0)).toBeNull();
    expect(servingsOf(101)).toBeNull();
    expect(servingsOf(-3)).toBeNull();
  });
});

describe('nameOf', () => {
  it('collapses and trims whitespace', () => {
    expect(nameOf({ name: '  Chicken \n  tikka  ', sourceUrl: null })).toBe('Chicken tikka');
  });

  it("is the site's host when the page gave no name", () => {
    expect(nameOf({ name: '   ', sourceUrl: 'https://www.example.com/tikka?x=1' })).toBe('www.example.com');
  });

  it('is "Recipe" with no name and no link, or a link that does not parse', () => {
    expect(nameOf({ name: '', sourceUrl: null })).toBe('Recipe');
    expect(nameOf({ name: '', sourceUrl: 'not a url' })).toBe('Recipe');
  });
});

describe('importedStepIngredients', () => {
  const steps = ['Chop.', { section: 'Sauce' }, 'Simmer.'];
  const ingredients = [{}, {}, {}] as Parameters<typeof importedStepIngredients>[0]['ingredients'];
  const match = [[{ index: 0, quantity: null }], [{ index: 1, quantity: 2 }, { index: 2, quantity: null }]];
  const ids = ['i-a', 'i-b', 'i-c'];

  it('maps the match onto the new ingredient ids, one entry per step string', () => {
    expect(importedStepIngredients({ steps, ingredients, stepIngredients: match }, ids)).toEqual({
      v: 1,
      basis: stepIngredientsBasis(steps, ids),
      steps: [[{ id: 'i-a', quantity: null }], [{ id: 'i-b', quantity: 2 }, { id: 'i-c', quantity: null }]],
    });
  });

  it('is null with no match or no steps', () => {
    expect(importedStepIngredients({ steps, ingredients, stepIngredients: null }, ids)).toBeNull();
    expect(importedStepIngredients({ steps: [], ingredients, stepIngredients: [] }, ids)).toBeNull();
    // Only headings: no step to match.
    expect(importedStepIngredients({ steps: [{ section: 'Sauce' }], ingredients, stepIngredients: [] }, ids)).toBeNull();
  });

  it("is null when the match doesn't line up", () => {
    // Fewer entries than steps.
    expect(importedStepIngredients({ steps, ingredients, stepIngredients: match.slice(0, 1) }, ids)).toBeNull();
    // Ids that aren't the response's ingredients.
    expect(importedStepIngredients({ steps, ingredients, stepIngredients: match }, ids.slice(0, 2))).toBeNull();
    // An index past the ingredients.
    const past = [[{ index: 3, quantity: null }], []];
    expect(importedStepIngredients({ steps, ingredients, stepIngredients: past }, ids)).toBeNull();
  });
});

describe('findReusableRecipe', () => {
  const recipe = (id: string, over: Partial<ReuseCandidate> = {}): ReuseCandidate => ({
    id,
    name: `Recipe ${id}`,
    householdId: 'h1',
    sourceUrl: null,
    deletedAt: null,
    ...over,
  });
  const tikka = 'https://example.com/tikka';

  it("prefers the import's own recipe, even in another household or with another link", () => {
    const candidates = [
      recipe('url', { sourceUrl: 'https://www.example.com/tikka/?utm_source=pin' }),
      recipe('own', { householdId: 'h2', sourceUrl: 'https://example.org/x' }),
    ];
    expect(findReusableRecipe(candidates, { householdId: 'h1', sourceUrl: tikka, importRecipeId: 'own' })).toEqual({
      id: 'own',
      name: 'Recipe own',
    });
  });

  it('falls back to the first live recipe in the household with the same canonical link', () => {
    const candidates = [
      recipe('deleted', { sourceUrl: tikka, deletedAt: '2026-01-01T00:00:00.000Z' }),
      recipe('other-household', { householdId: 'h2', sourceUrl: tikka }),
      recipe('other-link', { sourceUrl: 'https://example.com/korma' }),
      recipe('first', { sourceUrl: 'https://www.example.com/tikka/#top' }),
      recipe('second', { sourceUrl: tikka }),
    ];
    expect(findReusableRecipe(candidates, { householdId: 'h1', sourceUrl: tikka, importRecipeId: 'gone' })).toEqual({
      id: 'first',
      name: 'Recipe first',
    });
  });

  it("skips the import's own recipe once deleted", () => {
    const candidates = [recipe('own', { deletedAt: new Date(0), sourceUrl: tikka })];
    expect(findReusableRecipe(candidates, { householdId: 'h1', sourceUrl: tikka, importRecipeId: 'own' })).toBeUndefined();
  });

  it('finds nothing by link for an import with no URL (a photo import)', () => {
    const candidates = [recipe('a', { sourceUrl: tikka }), recipe('b')];
    expect(findReusableRecipe(candidates, { householdId: 'h1', sourceUrl: null })).toBeUndefined();
    expect(findReusableRecipe(candidates, { householdId: 'h1', sourceUrl: null, importRecipeId: 'b' })).toEqual({
      id: 'b',
      name: 'Recipe b',
    });
  });

  it('finds nothing among no candidates', () => {
    expect(findReusableRecipe([], { householdId: 'h1', sourceUrl: tikka, importRecipeId: 'x' })).toBeUndefined();
  });
});
