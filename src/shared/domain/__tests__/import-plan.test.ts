// Runs under Jest and Deno (`supabase/functions/_shared/shared-domain.test.ts`).
import { describe, expect, it } from '@jest/globals';

import type { RecipeImportResponse } from '../../schemas/recipe-import.ts';
import { stepIngredientsBasis } from '../../step-ingredients.ts';
import { planRecipeImport, type RecipeImportPlanInput } from '../import-plan.ts';
import type { IdSource, ListSnapshot } from '../list-plan.ts';

const AT = new Date('2026-03-02T12:00:00.000Z');
const ISO = AT.toISOString();

type Ingredient = RecipeImportResponse['ingredients'][number];
const ingredient = (ingredientName: string, quantity: number | null, unit: Ingredient['unit'], note = ''): Ingredient => ({
  ingredientName,
  displayName: ingredientName,
  quantity,
  unit,
  note,
  categoryId: null,
  status: 'categorized',
});

const TIKKA: RecipeImportResponse = {
  name: '  Chicken   tikka ',
  sourceUrl: 'https://example.com/tikka',
  servings: 4,
  ingredients: [ingredient('chicken thighs', 2, 'lb', 'boneless'), ingredient('garlic', 4, 'clove', ' minced '), ingredient('salt', null, null, '  ')],
  tags: { meal: ['dinner'], cuisine: [], protein: ['chicken'], diet: [], method: [] },
  totalMinutes: 50,
  steps: ['Marinate.', 'Cook.'],
  stepIngredients: [[{ index: 0, quantity: null }], [{ index: 1, quantity: 2 }, { index: 2, quantity: null }]],
  imageUrl: 'https://example.com/tikka.jpg',
};

function idSource() {
  const asked: string[] = [];
  const ids: IdSource = (purpose, index) => {
    const id = `${purpose}-${index}`;
    asked.push(id);
    return id;
  };
  return { ids, asked };
}

const emptyList: ListSnapshot = {
  list: { id: 'list-1', householdId: 'hh-1' },
  combineLanguages: false,
  families: {},
  items: [],
};

function input(over: Partial<RecipeImportPlanInput> = {}): RecipeImportPlanInput {
  return {
    extracted: TIKKA,
    target: { householdId: 'hh-1', listId: 'list-1' },
    existingRecipe: null,
    listSnapshot: emptyList,
    unitKnowledge: {},
    ids: idSource().ids,
    at: AT,
    userId: 'user-1',
    ...over,
  };
}

describe('planRecipeImport', () => {
  it('creates the recipe, its ingredients in order and its step match, then adds every ingredient', () => {
    const { ids, asked } = idSource();
    const plan = planRecipeImport(input({ ids }));
    expect(asked).toEqual([
      'recipe-0',
      'recipeIngredient-0',
      'recipeIngredient-1',
      'recipeIngredient-2',
      'contribution-0',
      'item-0',
      'contribution-1',
      'item-1',
      'contribution-2',
      'item-2',
    ]);
    expect(plan.writes[0]).toEqual({
      op: 'insert',
      table: 'recipes',
      id: 'recipe-0',
      fields: {
        household_id: 'hh-1',
        name: 'Chicken tikka',
        source_url: 'https://example.com/tikka',
        tags: { saved: [], meal: ['dinner'], cuisine: [], protein: ['chicken'], diet: [], method: [] },
        total_minutes: 50,
        steps: ['Marinate.', 'Cook.'],
        servings: 4,
        image_url: 'https://example.com/tikka.jpg',
      },
    });
    expect(plan.writes.slice(1, 4)).toEqual([
      {
        op: 'insert',
        table: 'recipe_ingredients',
        id: 'recipeIngredient-0',
        fields: {
          recipe_id: 'recipe-0',
          household_id: 'hh-1',
          ingredient_name: 'chicken thighs',
          display_name: 'chicken thighs',
          quantity: 2,
          unit: 'lb',
          note: 'boneless',
          position: 1,
        },
      },
      expect.objectContaining({ id: 'recipeIngredient-1', fields: expect.objectContaining({ note: 'minced', position: 2 }) }),
      expect.objectContaining({ id: 'recipeIngredient-2', fields: expect.objectContaining({ note: null, position: 3 }) }),
    ]);
    expect(plan.writes[4]).toEqual({
      op: 'update',
      table: 'recipes',
      id: 'recipe-0',
      fields: {
        step_ingredients: {
          v: 1,
          basis: stepIngredientsBasis(TIKKA.steps, ['recipeIngredient-0', 'recipeIngredient-1', 'recipeIngredient-2']),
          steps: [
            [{ id: 'recipeIngredient-0', quantity: null }],
            [
              { id: 'recipeIngredient-1', quantity: 2 },
              { id: 'recipeIngredient-2', quantity: null },
            ],
          ],
        },
      },
    });
    // The recipe's own ingredients count no use: the list adds count each once.
    expect(plan.writes.filter((w) => w.table === 'ingredient_usage').map((w) => w.key?.ingredient_name)).toEqual([
      'chicken thighs',
      'garlic',
      'salt',
    ]);
    const contributions = plan.writes.filter((w) => w.table === 'list_item_contributions');
    expect(contributions.map((w) => [w.fields.source, w.fields.recipe_id, w.fields.created_at])).toEqual([
      ['recipe', 'recipe-0', ISO],
      ['recipe', 'recipe-0', ISO],
      ['recipe', 'recipe-0', ISO],
    ]);
    expect(plan.preconditions).toEqual([
      { kind: 'recipeAbsent', recipeId: 'recipe-0' },
      { kind: 'new', listId: 'list-1', key: 'chicken thighs' },
      { kind: 'new', listId: 'list-1', key: 'garlic' },
      { kind: 'new', listId: 'list-1', key: 'salt' },
    ]);
    expect(plan.summary).toEqual({
      recipeId: 'recipe-0',
      recipeName: 'Chicken tikka',
      created: true,
      listId: 'list-1',
      results: [
        { itemId: 'item-0', contributionId: 'contribution-0', kind: 'new' },
        { itemId: 'item-1', contributionId: 'contribution-1', kind: 'new' },
        { itemId: 'item-2', contributionId: 'contribution-2', kind: 'new' },
      ],
      added: 3,
      combined: 0,
    });
  });

  it('reuses a recipe: no recipe writes, its own name, and the adds point at it', () => {
    const { ids, asked } = idSource();
    const chicken = {
      id: 'open-chicken',
      ingredientName: 'chicken thighs',
      displayName: 'chicken thighs',
      familyKey: 'chicken thighs',
      checkedAt: null,
      checkedBy: null,
      liveContributions: [],
    };
    const plan = planRecipeImport(
      input({ ids, existingRecipe: { id: 'saved-recipe', name: 'Our tikka' }, listSnapshot: { ...emptyList, items: [chicken] } }),
    );
    expect(asked).not.toContain('recipe-0');
    expect(plan.writes.some((w) => w.table === 'recipes' || w.table === 'recipe_ingredients')).toBe(false);
    expect(plan.preconditions[0]).toEqual({ kind: 'recipeReuse', recipeId: 'saved-recipe' });
    expect(plan.preconditions[1]).toEqual({ kind: 'combine', itemId: 'open-chicken' });
    expect(new Set(plan.writes.filter((w) => w.table === 'list_item_contributions').map((w) => w.fields.recipe_id))).toEqual(
      new Set(['saved-recipe']),
    );
    expect(plan.summary).toMatchObject({ recipeId: 'saved-recipe', recipeName: 'Our tikka', created: false, added: 3, combined: 1 });
  });

  it('saves a recipe-only import with no list writes and no uses counted', () => {
    const plan = planRecipeImport(input({ target: { householdId: 'hh-1', listId: null }, listSnapshot: null }));
    expect(plan.writes.map((w) => w.table)).toEqual(['recipes', 'recipe_ingredients', 'recipe_ingredients', 'recipe_ingredients', 'recipes']);
    expect(plan.preconditions).toEqual([{ kind: 'recipeAbsent', recipeId: 'recipe-0' }]);
    expect(plan.summary).toMatchObject({ listId: null, results: [], added: 0, combined: 0, created: true });
  });

  it('needs a snapshot to add onto a list', () => {
    expect(() => planRecipeImport(input({ listSnapshot: null }))).toThrow('needs its snapshot');
  });

  it("writes no step match that doesn't line up", () => {
    const plan = planRecipeImport(input({ extracted: { ...TIKKA, stepIngredients: TIKKA.stepIngredients!.slice(0, 1) } }));
    expect(plan.writes.filter((w) => w.table === 'recipes').map((w) => w.op)).toEqual(['insert']);
  });

  it('keeps null tags and empty steps as null, and names a nameless recipe by its host', () => {
    const plan = planRecipeImport(
      input({ extracted: { ...TIKKA, name: '  ', tags: null, steps: [{ section: 'Sauce' }], servings: 2.5 } }),
    );
    expect(plan.writes[0].fields).toMatchObject({ name: 'example.com', tags: null, steps: null, servings: null });
    expect(plan.summary.recipeName).toBe('example.com');
  });
});
